// S3 第 3 阶段：停下没交结果自动催一次；跑着多久没动静就提醒。
// 全部用临时合成台账和假宿主；观察档只记录不投递。

import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { createRouter, NUDGE_TEXT } from '../lib/router.js'
import { buildView } from '../lib/viewmodel.js'
import {
  getTask,
  patchAssignment,
  readRouterLog,
  updateRouter,
} from '../lib/ledger.js'

function routerFor(hw, overrides = {}) {
  return createRouter({
    file: hw.file,
    engine: hw.engine,
    debounceMs: 10,
    tickMs: 60 * 60_000,
    wait: async () => {},
    ...overrides,
  })
}

const deliverEffects = hw => hw.listEffects().filter(effect => effect.kind === 'deliver')

function liveAssignment(hw, taskId) {
  const task = getTask(taskId, { file: hw.file })
  return (task.assignments ?? []).filter(item => item.state !== 'ended').pop()
}

// 把一张已经开始的卡改成「这一轮停了、没交报告」。
function makeSilent(hw, taskId) {
  const assignment = liveAssignment(hw, taskId)
  patchAssignment(taskId, assignment.id, {
    state: 'idle',
    lastEventAt: Date.now(),
    lastTurn: { turn: 1, endKind: 'completed', detail: '', at: Date.now() },
    lastReport: null,
  }, { file: hw.file })
  return assignment
}

// 观察档：记录「本来会催」，不投递、不写 nudgedAt。
{
  const hw = makeHarness()
  updateRouter({ mode: 'observe', maxRunning: 2 }, { file: hw.file })
  const card = hw.task({ title: 'S3 合成：静默观察' })
  await hw.startConfirmed(card.id)
  const assignment = makeSilent(hw, card.id)
  const router = routerFor(hw)
  const before = deliverEffects(hw).length
  const run = await router.runOnce()
  assert.deepEqual(run.wouldNudge, [card.id])
  assert.equal(deliverEffects(hw).length, before, '观察档不投递')
  assert.equal(liveAssignment(hw, card.id).nudgedAt, undefined)
  const would = readRouterLog(hw.file).filter(row => row.would === 'nudge')
  assert.equal(would.length, 1)
  assert.equal(would[0].taskId, card.id)
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === card.id).stage, 'silent')
  router.stop()
  hw.cleanup()
}

// 自动档：催一次；再静默也不催，原因改成「催过一次，还是没交结果」。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2 }, { file: hw.file })
  const card = hw.task({ title: 'S3 合成：静默催一次' })
  await hw.startConfirmed(card.id)
  hw.state.autoConfirm = false // 让催促保持「已交给宿主、等确认」的状态
  const assignment = makeSilent(hw, card.id)
  const router = routerFor(hw)

  const before = deliverEffects(hw).length
  const first = await router.runOnce()
  assert.deepEqual(first.nudges, [card.id])
  const afterFirst = deliverEffects(hw)
  assert.equal(afterFirst.length, before + 1)
  const effect = afterFirst[afterFirst.length - 1]
  assert.equal(effect.text, NUDGE_TEXT)
  assert.equal(effect.text, '你上一轮停下了但没交报告。请用 sa_report 说明现在的情况。')
  assert.ok(Number.isFinite(liveAssignment(hw, card.id).nudgedAt))

  const second = await router.runOnce()
  assert.deepEqual(second.nudges, [], '每条派工只催一次')
  assert.equal(deliverEffects(hw).length, before + 1)
  const cardRow = buildView({ file: hw.file }).cards.find(row => row.id === card.id)
  assert.equal(cardRow.stage, 'silent')
  assert.equal(cardRow.reason, '催过一次，还是没交结果')
  assert.ok(assignment.id)
  router.stop()
  hw.cleanup()
}

// 催促投递后宿主确认了：卡回到在跑，不会连催。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2 }, { file: hw.file })
  const card = hw.task({ title: 'S3 合成：催了会醒' })
  await hw.startConfirmed(card.id)
  makeSilent(hw, card.id)
  const router = routerFor(hw)
  const first = await router.runOnce()
  assert.deepEqual(first.nudges, [card.id])
  await hw.engine.whenIdle()
  const row = buildView({ file: hw.file }).cards.find(item => item.id === card.id)
  assert.equal(row.stage, 'working', '被催之后宿主确认，卡回到在跑')
  const second = await router.runOnce()
  assert.deepEqual(second.nudges, [])
  router.stop()
  hw.cleanup()
}

// 没动静：running 超过 20 分钟 → stuck，带会话去处；新事件后回到 working。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2 }, { file: hw.file })
  const card = hw.task({ title: 'S3 合成：在跑但没动静' })
  const run = await hw.startConfirmed(card.id)
  const assignment = liveAssignment(hw, card.id)
  patchAssignment(card.id, assignment.id, {
    state: 'running',
    lastEventAt: Date.now() - 21 * 60_000,
  }, { file: hw.file })

  const view = buildView({ file: hw.file })
  const row = view.cards.find(item => item.id === card.id)
  assert.equal(row.stage, 'stuck')
  assert.match(row.reason, /20 分钟没有动静/)
  assert.match(row.reason, /可能停在审批或卡住了/)
  assert.ok(row.reason.includes(`…${run.sessionId.slice(-4)}`), `要带会话去处：${row.reason}`)

  hw.engine.onEvent({
    type: 'turn/start',
    data: { agent: { id: run.sessionId }, turn: 2 },
  })
  const awake = buildView({ file: hw.file }).cards.find(item => item.id === card.id)
  assert.equal(awake.stage, 'working', '有新事件就回到在跑')
  hw.cleanup()
}

// 没动静的门槛可调；off 档不做这个判断（和 S2 一致）。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, stuckMinutes: 5 }, { file: hw.file })
  const card = hw.task({ title: 'S3 合成：五分钟门槛' })
  await hw.startConfirmed(card.id)
  const assignment = liveAssignment(hw, card.id)
  patchAssignment(card.id, assignment.id, {
    state: 'running',
    lastEventAt: Date.now() - 6 * 60_000,
  }, { file: hw.file })
  let row = buildView({ file: hw.file }).cards.find(item => item.id === card.id)
  assert.equal(row.stage, 'stuck')
  assert.match(row.reason, /5 分钟没有动静/)
  assert.equal(buildView({ file: hw.file }).router.stuckMinutes, 5)

  updateRouter({ mode: 'off' }, { file: hw.file })
  row = buildView({ file: hw.file }).cards.find(item => item.id === card.id)
  assert.equal(row.stage, 'working', 'off 档保持 S2 行为')
  hw.cleanup()
}

// off 档不催；沉默卡在 off 档的说明和 S2 一样。
{
  const hw = makeHarness()
  updateRouter({ mode: 'off' }, { file: hw.file })
  const card = hw.task({ title: 'S3 合成：off 不催' })
  await hw.startConfirmed(card.id)
  makeSilent(hw, card.id)
  const router = routerFor(hw)
  const before = deliverEffects(hw).length
  await router.runOnce()
  assert.equal(deliverEffects(hw).length, before)
  const row = buildView({ file: hw.file }).cards.find(item => item.id === card.id)
  assert.equal(row.stage, 'silent')
  assert.equal(row.reason, '它结束了上一轮，没交结果')
  router.stop()
  hw.cleanup()
}

console.log('s3-followup: ok')
