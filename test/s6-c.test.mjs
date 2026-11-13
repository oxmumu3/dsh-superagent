// S6 C prep: external pending restored + idempotent, [Vent], friction and
// vent actions. Synthetic ledger only.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-c-'))
const file = path.join(dir, 'ledger.json')
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = file

const {
  addVent, beginDispatch, beginSuccessorDelivery, checkItem, createTask, getTask, listPending, listVents,
  reportExecution, setChecklist,
} = await import('../lib/ledger.js')
const { applyRequest, consumeQueue } = await import('../lib/queue.js')
const { buildView } = await import('../lib/viewmodel.js')
const { handleAction } = await import('../lib/route.js')
const { makeHarness } = await import('./support/harness.mjs')

// 1. 外部队列普通 pending 恢复；同一请求 id 重放不产生第二行。
{
  const first = applyRequest({
    id: 'req-normal-1',
    action: 'pending',
    payload: { text: '记一下：买牛奶', title: '买牛奶', workspacePath: dir },
  })
  assert.equal(first.ok, true, String(first.error ?? ''))
  assert.ok(first.pendingId)
  assert.equal(listPending().pending.length, 1)
  assert.equal(listPending().pending[0].text, '记一下：买牛奶')

  const replay = applyRequest({
    id: 'req-normal-1',
    action: 'pending',
    payload: { text: '记一下：买牛奶', title: '买牛奶' },
  })
  assert.equal(replay.ok, true)
  assert.equal(replay.duplicate, true)
  assert.equal(replay.pendingId, first.pendingId)
  assert.equal(listPending().pending.length, 1, '重放不能多一行')

  const empty = applyRequest({ id: 'req-empty', action: 'pending', payload: { text: '  ' } })
  assert.equal(empty.ok, false)
  assert.match(String(empty.error), /需要 text/)
}

// 2. 队列消费端：同一条请求跑两遍，第二遍没有可做的。
{
  const requests = path.join(dir, 'taskboard-queue', 'requests.jsonl')
  fs.mkdirSync(path.dirname(requests), { recursive: true })
  fs.writeFileSync(requests, JSON.stringify({
    id: 'req-consume-1', action: 'pending', payload: { text: '队列里的待确认' },
  }) + '\n')
  const first = consumeQueue()
  assert.equal(first.length, 1)
  const second = consumeQueue()
  assert.equal(second.length, 0, 'results.jsonl 已记成功，不重复消费')
  assert.equal(listPending().pending.filter(row => row.text === '队列里的待确认').length, 1)
}

// 3. [Vent] 开头进吐槽箱，不进待确认；前缀在句中不算；空吐槽拒绝。
{
  const result = applyRequest({
    id: 'req-vent-1',
    action: 'pending',
    payload: { text: '[Vent] 工具老超时，sk-abcdef123456', workspacePath: dir },
  })
  assert.equal(result.ok, true, String(result.error ?? ''))
  assert.ok(result.ventId)
  assert.equal(listPending().pending.some(row => row.text.includes('[Vent]')), false)
  const vent = listVents().vents.find(row => row.id === result.ventId)
  assert.ok(vent)
  assert.match(vent.text, /工具老超时/)
  assert.doesNotMatch(vent.text, /sk-/)
  assert.match(vent.text, /\*\*\*/)

  const replay = applyRequest({
    id: 'req-vent-1',
    action: 'pending',
    payload: { text: '[Vent] 工具老超时，sk-abcdef123456' },
  })
  assert.equal(replay.duplicate, true)
  assert.equal(replay.ventId, result.ventId)
  assert.equal(listVents().vents.length, 1, '同请求不重复吐槽')

  const middle = applyRequest({
    id: 'req-middle', action: 'pending', payload: { text: '聊聊 [Vent] 机制' },
  })
  assert.equal(middle.ok, true)
  assert.ok(middle.pendingId)
  assert.equal(listVents().vents.length, 1)

  const empty = applyRequest({ id: 'req-vent-empty', action: 'pending', payload: { text: '[Vent]   ' } })
  assert.equal(empty.ok, false)
  assert.match(String(empty.error), /吐槽不能是空的/)
}

// 4. friction 写进 vents，带卡号和目录；过长截断、秘密脱敏；不影响报告结论。
{
  const card = createTask({ title: '摩擦卡', workspacePath: dir }, { file })
  const run = beginDispatch(card.id, {
    sessionId: 'session-s6c-friction', messageId: 'msg-s6c-friction', text: 'x', cwd: dir,
  }, { file })
  setChecklist(card.id, ['做完'], { file, sessionId: run.assignment.sessionId })
  const item = getTask(card.id, { file }).checklist[0]
  checkItem(card.id, item.id, { file, note: '已验' })
  const friction = `工具很慢 sk-${'a'.repeat(10)} ` + 'x'.repeat(260)
  reportExecution(card.id, {
    outcome: 'ready', summary: '做完', checks: ['node test'], friction,
  }, { file, sessionId: run.assignment.sessionId })

  const row = getTask(card.id, { file })
  assert.equal(row.status, 'in_review')
  assert.ok(String(row.executions.at(-1).friction ?? '').length <= 200)
  const vents = listVents().vents
  const saved = vents.at(-1)
  assert.equal(saved.taskId, card.id)
  assert.equal(saved.workspacePath, dir)
  assert.equal(saved.by, 'executor')
  assert.ok(saved.text.length <= 200)
  assert.doesNotMatch(saved.text, /sk-/)
}

// 4b. 旧派工的报告只留执行历史，不能把 friction 注入吐槽箱。
{
  const card = createTask({ title: '旧派工摩擦', workspacePath: dir }, { file })
  const first = beginDispatch(card.id, { sessionId: 'session-friction-old', messageId: 'msg-friction-old', text: 'x', cwd: dir }, { file })
  beginSuccessorDelivery(card.id, first.assignment.id, {
    sessionId: 'session-friction-new', messageId: 'msg-friction-new', text: '接班', cwd: dir,
  }, { file })
  const before = listVents({ file }).vents.length
  reportExecution(card.id, {
    outcome: 'progress', summary: '旧会话', friction: '旧会话的摩擦不该进箱',
  }, { file, sessionId: 'session-friction-old' })
  assert.equal(listVents({ file }).vents.length, before)
  assert.equal(getTask(card.id, { file }).executions.at(-1).friction, '旧会话的摩擦不该进箱')
}

// 5. 吐槽不改变任何一组数量和标题数字。
{
  const before = buildView({ file }).counts
  addVent({ text: '视图不该数它', workspacePath: dir, by: 'mcp' })
  addVent({ text: '再来一条', workspacePath: dir, by: 'mcp' })
  const after = buildView({ file })
  assert.deepEqual(after.counts, before)
  assert.ok(after.vents.count >= 2)
  assert.ok(after.vents.items.length <= 50)
  const first = after.vents.items[0]
  const second = after.vents.items[1]
  assert.ok((first.at ?? 0) >= (second.at ?? 0), '吐槽按最近在前')
}

// 6. 满 200 条丢最早；视图最多 50 条。
{
  const capFile = path.join(dir, 'cap.json')
  for (let index = 0; index < 201; index += 1) {
    addVent({ text: `v${index}` }, { file: capFile })
  }
  const rows = listVents({ file: capFile }).vents
  assert.equal(rows.length, 200)
  assert.equal(rows[0].text, 'v1')
  assert.equal(rows.at(-1).text, 'v200')
  assert.equal(buildView({ file: capFile }).vents.items.length, 50)
}

// 7. vent_card 用吐槽文字建手动卡，不带 queue.auto，吐槽删除；重复点击只有一张。
//    vent_dismiss 只带 text，必须在缺卡 id 检查之前处理。
{
  const hw = makeHarness()
  const vent = addVent({
    text: '把这条记成一件事', workspacePath: hw.dir, by: 'mcp',
  }, { file: hw.file })
  const created = await handleAction(hw.engine, { action: 'vent_card', text: vent.id })
  assert.equal(created.task.title, '把这条记成一件事')
  assert.equal(created.task.workspacePath, hw.dir)
  assert.equal(created.task.queue, null, '吐槽转卡不能自动排队')
  assert.equal(created.task.sourceVentId, vent.id)
  assert.equal(getTask(created.task.id, { file: hw.file }).id, created.task.id)
  assert.equal(listVents({ file: hw.file }).vents.length, 0, '转卡后吐槽删除')

  const again = await handleAction(hw.engine, { action: 'vent_card', text: vent.id })
  assert.equal(again.duplicate, true)
  assert.equal(again.task.id, created.task.id, '重复点击只生成一张')
  assert.equal(buildView({ file: hw.file }).cards.filter(card => card.id === created.task.id).length, 1)

  const dismissed = addVent({ text: '知道就行了', workspacePath: hw.dir }, { file: hw.file })
  const removed = await handleAction(hw.engine, { action: 'vent_dismiss', text: dismissed.id })
  assert.equal(removed.removed.id, dismissed.id)
  const repeated = await handleAction(hw.engine, { action: 'vent_dismiss', text: dismissed.id })
  assert.equal(repeated.removed, null)
  await assert.rejects(
    () => handleAction(hw.engine, { action: 'vent_dismiss', text: '' }),
    /需要吐槽 id/,
  )
  hw.cleanup()
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('s6-c: ok')
