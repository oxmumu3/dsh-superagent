// S7 B: external MCP queue checklist/check/report, gates and rejection queue.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's7-b-'))
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = path.join(dir, 'ledger.json')
const {
  beginDispatch, createTask, getTask, readLedger, rejectTask, reportExecution,
} = await import('../lib/ledger.js')
const { applyRequest, consumeQueue } = await import('../lib/queue.js')
const { stageOf, buildCardDetail } = await import('../lib/viewmodel.js')

const file = process.env.DSH_SUPERAGENT_LEDGER
const clean = () => fs.rmSync(dir, { recursive: true, force: true })
const req = (id, action, payload) => applyRequest({ id, action, payload })
const externalReport = (id, taskId, extra = {}) => req(id, 'report', {
  id: taskId, summary: '外部做完', outcome: 'ready', checks: ['node test'], ...extra,
})

// 1. checklist: empty task success, existing/0/9 reject.
const c1 = createTask({ title: '外部清单', workspacePath: dir }, { file })
assert.equal(req('r-c1', 'checklist', { id: c1.id, items: ['一', '二'] }).ok, true)
assert.match(req('r-c2', 'checklist', { id: c1.id, items: ['三'] }).error, /已经有验收清单/)
const c2 = createTask({ title: '外部空清单', workspacePath: dir }, { file })
assert.match(req('r-c3', 'checklist', { id: c2.id, items: [] }).error, /至少 1 条/)
assert.match(req('r-c4', 'checklist', { id: c2.id, items: Array.from({ length: 9 }, (_, i) => `项${i}`) }).error, /最多 8 条/)

// 2. ready gate: unchecked, missing note, missing checks; card unchanged each time.
const g = createTask({ title: '外部门槛', workspacePath: dir }, { file })
req('r-g1', 'checklist', { id: g.id, items: ['第一项', '第二项'] })
const before = () => JSON.stringify(getTask(g.id, { file }))
let snap = before()
let bad = externalReport('r-g2', g.id)
assert.equal(bad.ok, false); assert.match(bad.error, /第 1、2 项没勾/); assert.equal(before(), snap)
const items = getTask(g.id, { file }).checklist
req('r-g3', 'check', { id: g.id, itemId: items[0].id })
snap = before()
bad = externalReport('r-g4', g.id)
assert.equal(bad.ok, false); assert.match(bad.error, /没写怎么验的|第 2 项没勾/); assert.equal(before(), snap)

// 3. complete and hand in; report by mcp; detail labels it.
req('r-g5', 'check', { id: g.id, itemId: items[0].id, note: '已核对' })
req('r-g6', 'check', { id: g.id, index: 1, note: '已核对', evidence: ['proof.txt'] })
const ready = externalReport('r-g7', g.id)
assert.equal(ready.ok, true, ready.error)
const handed = getTask(g.id, { file })
assert.equal(handed.status, 'in_review')
assert.equal(handed.executions.at(-1).by, 'mcp')
assert.equal(buildCardDetail(handed, { effects: [] }).executions.at(-1).by, 'mcp')

// 4. active dispatch rejects all three; card unchanged.
const active = createTask({ title: '有人在跑', workspacePath: dir, checklist: ['其一'] }, { file })
const run = beginDispatch(active.id, { sessionId: 'session-active', messageId: 'm-active', text: '做', cwd: dir }, { file })
const activeBefore = JSON.stringify(getTask(active.id, { file }))
for (const [id, action, payload] of [
  ['r-a1', 'checklist', { id: active.id, items: ['外部补'] }],
  ['r-a2', 'check', { id: active.id, index: 0, note: '外部勾' }],
  ['r-a3', 'report', { id: active.id, summary: '外部交', outcome: 'ready', checks: ['x'] }],
]) {
  const result = req(id, action, payload)
  assert.equal(result.ok, false)
  assert.match(result.error, /有执行会话在做/)
}
assert.equal(JSON.stringify(getTask(active.id, { file })), activeBefore)

// 5. external move in_review/done still refused.
for (const status of ['in_review', 'done']) {
  const r = req(`r-m-${status}`, 'move', { id: g.id, status })
  assert.equal(r.ok, false)
}

// 6. reject external card -> draft queue, manual, reason comment.
const rejected = rejectTask(g.id, '还差标题', { file })
assert.equal(rejected.task.status, 'todo')
assert.equal(rejected.task.queue, null)
assert.ok(rejected.task.comments.some(comment => comment.body === '还差标题'))
assert.equal(stageOf(rejected.task, { effects: [] }).stage, 'queued')

// 7. same request id replays once through consumeQueue.
const qdir = path.join(dir, 'taskboard-queue')
fs.mkdirSync(qdir, { recursive: true })
const qtask = createTask({ title: '重放', workspacePath: dir }, { file })
const request = { id: 'r-replay', action: 'checklist', payload: { id: qtask.id, items: ['一次'] } }
fs.writeFileSync(path.join(qdir, 'requests.jsonl'), JSON.stringify(request) + '\n')
const first = consumeQueue()
assert.equal(first.length, 1); assert.equal(first[0].ok, true)
const second = consumeQueue()
assert.equal(second.length, 0, '同一 request id 不再执行')
assert.equal(getTask(qtask.id, { file }).checklist.length, 1)
assert.ok(readLedger(file).tasks.find(t => t.id === qtask.id))
assert.ok(run.assignment.id)

// 7.5 外部不能用 dropped 绕过 ready 门禁；原生 dropped 语义不改。
{
  const dropped = createTask({ title: '外部 dropped 旁路', workspacePath: dir }, { file })
  assert.throws(() => reportExecution(dropped.id, {
    summary: '偷偷 dropped', outcome: 'dropped',
  }, { file, external: true, by: 'mcp', requestId: 'r-dropped' }), /dropped/)
  const after = getTask(dropped.id, { file })
  assert.equal(after.status, 'todo')
  assert.equal(after.executions.length, 0)
  assert.equal(after.mcpRequests, undefined)
}

// 8. result file lost after ledger write: replay must not append a second execution.
{
  const replayTask = createTask({ title: '结果丢失重放', workspacePath: dir }, { file })
  const qdir2 = path.join(dir, 'taskboard-queue')
  fs.rmSync(path.join(qdir2, 'requests.jsonl'), { force: true })
  fs.rmSync(path.join(qdir2, 'results.jsonl'), { force: true })
  const rows = [
    { id: 'r-lost-1', action: 'checklist', payload: { id: replayTask.id, items: ['唯一一项'] } },
    { id: 'r-lost-2', action: 'check', payload: { id: replayTask.id, index: 0, note: '已验' } },
    { id: 'r-lost-3', action: 'report', payload: { id: replayTask.id, summary: '交', outcome: 'ready', checks: ['x'] } },
  ]
  fs.writeFileSync(path.join(qdir2, 'requests.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const applied = consumeQueue()
  assert.equal(applied.length, 3)
  const handed = getTask(replayTask.id, { file })
  const executions = handed.executions.length
  const revision = readLedger(file).revision
  fs.rmSync(path.join(qdir2, 'results.jsonl'), { force: true })
  const replay = consumeQueue()
  assert.equal(replay.length, 3)
  assert.ok(replay.every(row => row.duplicate === true))
  assert.equal(getTask(replayTask.id, { file }).executions.length, executions, '重放不得追加执行记录')
  assert.equal(readLedger(file).revision, revision, '重放不得再写台账')
}

clean()
console.log('s7-b: ok')
