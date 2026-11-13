// S7 B: external MCP queue checklist/check/report, gates and rejection queue.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's7-b-'))
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = path.join(dir, 'ledger.json')
const {
  beginDispatch, checkItem, createTask, getTask, readLedger, rejectTask, reportExecution,
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
  assert.ok(applied.every(row => row.duplicate === false), '第一次消费必须明确不是重放')
  assert.equal(applied.find(row => row.action === 'checklist').items, 1, '第一次回执带清单数量')
  assert.ok(applied.find(row => row.action === 'check').itemId, '第一次回执带勾选 item ID')
  assert.equal(applied.find(row => row.action === 'report').status, 'in_review', '第一次回执带当时的卡状态')
  const handed = getTask(replayTask.id, { file })
  assert.equal(handed.mcpRequests['r-lost-1'].receipt.items, 1, '回执和清单写入同一次落盘')
  assert.equal(handed.mcpRequests['r-lost-2'].receipt.itemId, handed.checklist[0].id)
  assert.equal(handed.mcpRequests['r-lost-3'].receipt.status, 'in_review')
  const executions = handed.executions.length
  const revision = readLedger(file).revision
  fs.rmSync(path.join(qdir2, 'results.jsonl'), { force: true })
  const replay = consumeQueue()
  assert.equal(replay.length, 3)
  assert.ok(replay.every(row => row.duplicate === true))
  assert.equal(replay.find(row => row.action === 'report').status, 'in_review', '重放回到原回执状态')
  assert.equal(getTask(replayTask.id, { file }).executions.length, executions, '重放不得追加执行记录')
  assert.equal(readLedger(file).revision, revision, '重放不得再写台账')
}

// 9. 清空结果 + 用户打回后再重放原报告：回原 in_review 回执，当前卡不动。
{
  const queueDir = path.join(dir, 'taskboard-queue')
  fs.rmSync(path.join(queueDir, 'requests.jsonl'), { force: true })
  fs.rmSync(path.join(queueDir, 'results.jsonl'), { force: true })
  const rejectedTask = createTask({ title: '打回后重放原报告', workspacePath: dir }, { file })
  const rows = [
    { id: 'r-rej-1', action: 'checklist', payload: { id: rejectedTask.id, items: ['唯一一项'] } },
    { id: 'r-rej-2', action: 'check', payload: { id: rejectedTask.id, index: 0, note: '已验' } },
    { id: 'r-rej-3', action: 'report', payload: { id: rejectedTask.id, summary: '交', outcome: 'ready', checks: ['x'] } },
  ]
  fs.writeFileSync(path.join(queueDir, 'requests.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const first = consumeQueue()
  assert.equal(first.length, 3)
  assert.ok(first.every(row => row.duplicate === false), '首次交活不是重放')
  assert.equal(getTask(rejectedTask.id, { file }).status, 'in_review')

  const rejected = rejectTask(rejectedTask.id, '用户打回', { file }).task
  assert.equal(rejected.status, 'todo')
  const before = JSON.stringify(getTask(rejectedTask.id, { file }))
  const revision = readLedger(file).revision

  fs.rmSync(path.join(queueDir, 'results.jsonl'), { force: true })
  fs.writeFileSync(path.join(queueDir, 'requests.jsonl'), JSON.stringify(rows[2]) + '\n')
  const replay = consumeQueue()
  assert.equal(replay.length, 1)
  assert.equal(replay[0].duplicate, true)
  assert.equal(replay[0].status, 'in_review', '重放只读原回执，不拿当前 todo 冒充')
  assert.equal(JSON.stringify(getTask(rejectedTask.id, { file })), before, '当前卡必须保持打回后的原样')
  assert.equal(readLedger(file).revision, revision, '重放不得写台账')
}

// 10. 外部清单/勾选/报告成功后各占一个版本；同一个 ifVersion 的后到者被拒。
{
  const queueDir = path.join(dir, 'taskboard-queue')
  fs.rmSync(path.join(queueDir, 'requests.jsonl'), { force: true })
  fs.rmSync(path.join(queueDir, 'results.jsonl'), { force: true })
  const versioned = createTask({ title: '同 ifVersion 并发', workspacePath: dir }, { file })
  const v1 = versioned.version
  const listed = req('r-v-1', 'checklist', { id: versioned.id, items: ['一', '二'], ifVersion: v1 })
  assert.equal(listed.ok, true, listed.error)
  assert.equal(listed.duplicate, false)
  const afterList = getTask(versioned.id, { file })
  assert.equal(afterList.version, v1 + 1, '外部写清单成功也要占一个版本')
  const lateList = req('r-v-1b', 'checklist', { id: versioned.id, items: ['另一套'], ifVersion: v1 })
  assert.equal(lateList.ok, false, '同一个 ifVersion 的后写清单不能覆盖')
  assert.match(lateList.error, /version conflict/)
  assert.deepEqual(getTask(versioned.id, { file }).checklist.map(item => item.text), ['一', '二'])

  const [item0, item1] = afterList.checklist
  const checked = req('r-v-2', 'check', {
    id: versioned.id, itemId: item0.id, note: '已验一', ifVersion: afterList.version,
  })
  assert.equal(checked.ok, true, checked.error)
  assert.equal(checked.itemId, item0.id)
  const afterCheck = getTask(versioned.id, { file })
  assert.equal(afterCheck.version, afterList.version + 1, '外部勾选成功也要占一个版本')

  const lateCheck = req('r-v-3', 'check', {
    id: versioned.id, itemId: item1.id, note: '已验二', ifVersion: afterList.version,
  })
  assert.equal(lateCheck.ok, false, '同一个 ifVersion 的后写不能覆盖')
  assert.match(lateCheck.error, /version conflict/)
  assert.equal(getTask(versioned.id, { file }).checklist[1].checked, false, '后写失败不得改到第二项')

  // 原生勾选仍按原策略只改内容、不动版本；只有外部路径占版本。
  const nativeVersion = getTask(versioned.id, { file }).version
  checkItem(versioned.id, item1.id, { file, note: '原生勾' })
  assert.equal(getTask(versioned.id, { file }).version, nativeVersion, '原生工具的状态版本策略不变')

  const beforeReport = getTask(versioned.id, { file }).version
  const progress = req('r-v-4', 'report', {
    id: versioned.id, summary: '进行中', outcome: 'progress', ifVersion: beforeReport,
  })
  assert.equal(progress.ok, true, progress.error)
  assert.equal(getTask(versioned.id, { file }).version, beforeReport + 1, '外部报告成功也要占一个版本')
  const lateReport = req('r-v-5', 'report', {
    id: versioned.id, summary: '迟到的进度', outcome: 'progress', ifVersion: beforeReport,
  })
  assert.equal(lateReport.ok, false)
  assert.match(lateReport.error, /version conflict/)

  // 原生报告仍按原策略：progress 不改状态就不占版本。只限外部路径。
  const nativeTask = createTask({ title: '原生报告不占版本', workspacePath: dir }, { file })
  const nativeReportVersion = nativeTask.version
  reportExecution(nativeTask.id, { outcome: 'progress', summary: '原生进行中' }, { file })
  assert.equal(getTask(nativeTask.id, { file }).version, nativeReportVersion, '原生工具的状态版本策略不变')
}

// 11. 同一 consume 批里重复的 request id 只写一次回执、只产出一条结果。
{
  const queueDir = path.join(dir, 'taskboard-queue')
  fs.rmSync(path.join(queueDir, 'requests.jsonl'), { force: true })
  fs.rmSync(path.join(queueDir, 'results.jsonl'), { force: true })
  const duplicateTask = createTask({ title: '同批重复 id', workspacePath: dir }, { file })
  const row = {
    id: 'r-dup-batch',
    action: 'checklist',
    payload: { id: duplicateTask.id, items: ['一'] },
  }
  fs.writeFileSync(path.join(queueDir, 'requests.jsonl'), [row, row].map(item => JSON.stringify(item)).join('\n') + '\n')
  const applied = consumeQueue()
  assert.equal(applied.length, 1, '同批同一个 id 只执行一次')
  assert.equal(applied[0].duplicate, false)
  assert.equal(applied[0].items, 1)
  const resultRows = fs.readFileSync(path.join(queueDir, 'results.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(resultRows.filter(item => item.id === row.id).length, 1, '结果文件只写一条')
  assert.equal(getTask(duplicateTask.id, { file }).mcpRequests[row.id].receipt.items, 1)
}

clean()
console.log('s7-b: ok')
