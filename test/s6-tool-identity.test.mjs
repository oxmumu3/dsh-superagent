// S6 final: tool entry must not advance a card without a trustworthy execution
// identity. Low-level reportExecution keeps its compatibility default.
import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { registerTools } from '../lib/tools.js'
import { beginDispatch, beginSuccessorDelivery, checkItem, createTask, getTask, readLedger, writeLedger } from '../lib/ledger.js'

const hw = makeHarness()
process.env.DSH_SUPERAGENT_LEDGER = hw.file
const defs = new Map()
registerTools({ register(def) { defs.set(def.name, def); return () => defs.delete(def.name) } }, { engine: hw.engine })
const run = (name, args, exec = {}) => defs.get(name).execute(args, exec)

// 1. 无清单 -> sa_checklist -> sa_get 拿 itemId -> sa_check -> ready。
{
  const card = hw.task({ title: '正常工具流' })
  hw.setTaskId(card.id)
  const started = await hw.startConfirmed(card.id)
  const sessionId = started.sessionId
  await assert.rejects(() => run('sa_report', { id: card.id, summary: '先交', outcome: 'ready', checks: ['x'] }, { sessionId }), /没有验收清单/)
  await run('sa_checklist', { id: card.id, items: ['页面能打开', '列表能看到'] }, { sessionId })
  const got = await run('sa_get', { id: card.id })
  const ids = [...got.matchAll(/id: (k-[a-z0-9-]+)/g)].map(match => match[1])
  assert.equal(ids.length, 2, 'sa_get 必须暴露两个稳定 itemId')
  await assert.rejects(() => run('sa_check', { id: card.id, itemId: ids[0], note: '他卡会话' }, { sessionId: 'session-other' }), /只有这张卡当前的执行会话/)
  await assert.rejects(() => run('sa_check', { id: card.id, itemId: ids[0], note: '没有身份' }), /拿不到当前执行会话身份/)
  await run('sa_check', { id: card.id, itemId: ids[0], note: '打开成功' }, { sessionId })
  await run('sa_check', { id: card.id, itemId: ids[1], note: '列表已核' }, { sessionId })
  await assert.rejects(() => run('sa_report', { id: card.id, summary: '缺 checks', outcome: 'ready' }, { sessionId }), /checks/)
  await run('sa_report', { id: card.id, summary: '做完', outcome: 'ready', checks: ['node test'] }, { sessionId })
  assert.equal(getTask(card.id, { file: hw.file }).status, 'in_review')
}

// 2. 没有 execution identity：工具只记历史，不推进卡。
{
  const card = hw.task({ title: '无身份报告', checklist: ['一项'] })
  hw.setTaskId(card.id)
  await hw.startConfirmed(card.id)
  checkItem(card.id, getTask(card.id, { file: hw.file }).checklist[0].id, { file: hw.file, note: '已验' })
  const line = await run('sa_report', { id: card.id, summary: '没有身份', outcome: 'ready', checks: ['x'] })
  const row = getTask(card.id, { file: hw.file })
  assert.equal(row.status, 'in_progress', '无身份不能把卡推进待验收')
  assert.equal(row.executions.at(-1).outcome, 'ready', '历史仍记录')
  assert.equal(row.assignments.at(-1).lastReport, null)
  assert.match(line, /没有执行会话身份/)
}

// 3. 旧派工迟到报告：工具带旧 session 也只留历史；当前会话才能推进。
{
  const card = createTask({ title: '旧派工迟到', workspacePath: hw.dir, checklist: ['一项'] }, { file: hw.file })
  const first = beginDispatch(card.id, { sessionId: 'session-old', messageId: 'msg-old', text: 'x', cwd: hw.dir }, { file: hw.file })
  const promoted = beginSuccessorDelivery(card.id, first.assignment.id, {
    sessionId: 'session-new', messageId: 'msg-new', text: '接班', cwd: hw.dir,
  }, { file: hw.file })
  checkItem(card.id, getTask(card.id, { file: hw.file }).checklist[0].id, { file: hw.file, note: '已验' })
  await run('sa_report', { id: card.id, summary: '旧会话迟到', outcome: 'ready', checks: ['x'] }, { sessionId: 'session-old' })
  let row = getTask(card.id, { file: hw.file })
  assert.equal(row.status, 'in_progress')
  assert.equal(row.executions.at(-1).sessionId, 'session-old')
  await run('sa_report', { id: card.id, summary: '当前会话', outcome: 'ready', checks: ['x'] }, { sessionId: promoted.assignment.sessionId })
  row = getTask(card.id, { file: hw.file })
  assert.equal(row.status, 'in_review')
}

// 4. 低层兼容默认仍在：直接 reportExecution 不带 session 仍可推进（显式内部调用）。
{
  const card = createTask({ title: '低层兼容', workspacePath: hw.dir, checklist: ['x'] }, { file: hw.file })
  const item = getTask(card.id, { file: hw.file }).checklist[0]
  checkItem(card.id, item.id, { file: hw.file, note: 'x' })
  const { reportExecution } = await import('../lib/ledger.js')
  reportExecution(card.id, { outcome: 'ready', summary: '低层', checks: ['x'] }, { file: hw.file })
  assert.equal(getTask(card.id, { file: hw.file }).status, 'in_review')
  assert.ok(readLedger(hw.file).revision > 0)
  assert.ok(writeLedger)
}

hw.cleanup()
console.log('s6-tool-identity: ok')
