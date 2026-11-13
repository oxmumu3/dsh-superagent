// S3 第 1 阶段：排队、空位、自动开工、观察档、并发保护。
// 全部用临时合成台账和假宿主，不开真实会话、不碰真实模型。

import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { makeHarness } from './support/harness.mjs'
import { ensureEvidence } from './support/evidence-fixture.mjs'
import { createRouter } from '../lib/router.js'
import {
  claimRouterTasks,
  getTask,
  listTasks,
  readRouter,
  readRouterLog,
  reportExecution,
  updateRouter,
} from '../lib/ledger.js'
import { registerRoutes } from '../lib/route.js'

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

function autoCard(hw, title, extra = {}) {
  return hw.task({ title, queue: { auto: true, by: 'user' }, ...extra })
}

const creates = hw => hw.calls.filter(call => call.type === 'create').length

async function finishAsReady(hw, taskId) {
  const task = getTask(taskId, { file: hw.file })
  const assignment = (task.assignments ?? []).filter(item => item.state !== 'ended').pop()
  assert.ok(assignment, '要有当前派工才能交报告')
  ensureEvidence(taskId, hw.file, { sessionId: assignment.sessionId })
  reportExecution(taskId, { outcome: 'ready', summary: '合成完成', checks: ['node test'] }, {
    file: hw.file,
    sessionId: assignment.sessionId,
  })
  await hw.engine.acceptTask(taskId)
}

function routesFor(engine) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name !== 'connection') return null
      return {
        fetch: {
          register(definition) {
            routes.set(definition.path, definition)
            return () => routes.delete(definition.path)
          },
        },
      }
    },
  }
  const dispose = registerRoutes(ctx, { engine })
  async function post(body) {
    const route = routes.get('/api/superagent/action')
    const response = await route.fetch(new Request('http://localhost/api/superagent/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { dispose, post }
}

// 上限 2、一张手动在跑、三张自动排队：一轮只开 1 张；那张跑完再开 1 张。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 2 }, { file: hw.file })
  const manual = hw.task({ title: 'S3 合成：手动在跑' })
  await hw.startConfirmed(manual.id)
  const first = autoCard(hw, 'S3 合成：自动一', { queue: { auto: true, by: 'user', at: 1_000 } })
  const second = autoCard(hw, 'S3 合成：自动二', { queue: { auto: true, by: 'user', at: 2_000 } })
  autoCard(hw, 'S3 合成：自动三', { queue: { auto: true, by: 'user', at: 3_000 } })
  const router = routerFor(hw)

  const before = creates(hw)
  const round1 = await router.runOnce()
  assert.deepEqual(round1.plan.startNow, [first.id], '空位只有 1 个，只能开 1 张')
  assert.equal(creates(hw) - before, 1)

  await finishAsReady(hw, first.id)
  const round2 = await router.runOnce()
  assert.deepEqual(round2.plan.startNow, [second.id], '少了一张在跑，再开一张')
  assert.equal(creates(hw) - before, 2)
  const running = hw.buildView().groups.running.map(card => card.id)
  assert.deepEqual(running.sort(), [manual.id, second.id].sort())
  router.stop()
  hw.cleanup()
}

// 上限 1 与 5 分别正确；手动开始不受上限限制。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 1 }, { file: hw.file })
  autoCard(hw, 'S3 合成：上限一 1', { queue: { auto: true, at: 1 } })
  autoCard(hw, 'S3 合成：上限一 2', { queue: { auto: true, at: 2 } })
  const router = routerFor(hw)
  const before = creates(hw)
  await router.runOnce()
  await router.runOnce()
  assert.equal(creates(hw) - before, 1, '上限 1 只开一张')
  router.stop()
  hw.cleanup()
}

{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 5 }, { file: hw.file })
  for (let index = 0; index < 5; index += 1) {
    autoCard(hw, `S3 合成：上限五 ${index}`, { queue: { auto: true, at: index + 1 } })
  }
  const router = routerFor(hw)
  const before = creates(hw)
  const round = await router.runOnce()
  assert.equal(round.started.length, 5)
  assert.equal(creates(hw) - before, 5)
  router.stop()
  hw.cleanup()
}

{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 1 }, { file: hw.file })
  const one = hw.task({ title: 'S3 合成：手动 1' })
  const two = hw.task({ title: 'S3 合成：手动 2' })
  await hw.startConfirmed(one.id)
  await hw.startConfirmed(two.id)
  autoCard(hw, 'S3 合成：自动等空位', { queue: { auto: true, at: 1 } })
  const router = routerFor(hw)
  const before = creates(hw)
  const round = await router.runOnce()
  assert.equal(round.started.length, 0, '手动开始的两张已经超过上限')
  assert.equal(creates(hw) - before, 0)
  router.stop()
  hw.cleanup()
}

// 没目录、需要点头、以后再说、老卡四种都不开工，原因正确。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 2 }, { file: hw.file })
  const noWorkspace = hw.task({
    title: 'S3 合成：没目录',
    workspacePath: null,
    queue: { auto: true, at: 1 },
  })
  const nod = hw.task({
    title: 'S3 合成：要花钱',
    queue: { auto: true, at: 2 },
    needsNod: { kinds: ['spend'], matched: ['付款'] },
  })
  const later = hw.task({ title: 'S3 合成：以后再说', status: 'backlog', queue: { auto: true, at: 3 } })
  const oldCard = hw.task({ title: 'S3 合成：老卡' })
  const good = autoCard(hw, 'S3 合成：正常自动', { queue: { auto: true, at: 4 } })
  const router = routerFor(hw)
  const before = creates(hw)
  const round = await router.runOnce()
  assert.deepEqual(round.plan.startNow, [good.id])
  assert.equal(creates(hw) - before, 1)
  const reasons = Object.fromEntries(round.plan.skipped.map(row => [row.taskId, row.reason]))
  assert.equal(reasons[noWorkspace.id], '还没定在哪做，定了就会自动开始')
  assert.ok(!(later.id in reasons), '以后再说不在排队候选里')
  assert.ok(!(oldCard.id in reasons), '老卡不是自动候选，也不在跳过原因里')

  const view = hw.buildView()
  const byId = id => view.cards.find(card => card.id === id)
  assert.equal(byId(noWorkspace.id).reason, '还没定在哪做，定了就会自动开始')
  assert.equal(byId(noWorkspace.id).auto, true)
  assert.equal(byId(noWorkspace.id).position, null)
  assert.equal(byId(oldCard.id).reason, '要你点开始')
  assert.equal(byId(oldCard.id).auto, false)
  assert.equal(byId(later.id).reason, '以后再说')
  // 需要点头的卡在第 2 阶段会进「等你」，不再算排队候选。
  assert.equal(byId(nod.id).stage, 'nod')
  assert.equal(byId(nod.id).group, 'waiting')
  assert.match(byId(nod.id).reason, /要花钱，等你点头/)
  // 排队组先列自动的，再列老卡。
  const queuedIds = view.groups.queued.map(card => card.id)
  assert.ok(queuedIds.indexOf(noWorkspace.id) < queuedIds.indexOf(oldCard.id))
  assert.equal(view.counts.queued, queuedIds.length)
  router.stop()
  hw.cleanup()
}

// 非自动档：没目录的卡不许承诺「会自动开始」，观察和关档都说清楚不会自己开工。
{
  for (const mode of ['observe', 'off']) {
    const hw = makeHarness()
    updateRouter({ mode, maxRunning: 2 }, { file: hw.file })
    const card = hw.task({
      title: `S3 合成：${mode} 没目录`,
      workspacePath: null,
      queue: { auto: true, at: 1 },
    })
    const row = hw.buildView().cards.find(item => item.id === card.id)
    assert.equal(row.reason, '还没定在哪做，定了也不会自己开工', `${mode} 档不能承诺自动开始`)
    assert.ok(!JSON.stringify(hw.buildView()).includes('会自动开始'), `${mode} 档不出现「会自动开始」`)
    hw.cleanup()
  }
}

// 位置与原因：上限 1，三张自动，先开 1 张，余下排第 1、第 2。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 1 }, { file: hw.file })
  const cards = [0, 1, 2].map(index => autoCard(hw, `S3 合成：排队 ${index}`, {
    queue: { auto: true, at: index + 1 },
  }))
  const router = routerFor(hw)
  await router.runOnce()
  const view = hw.buildView()
  const queued = view.groups.queued
  assert.deepEqual(queued.map(card => card.position), [1, 2])
  assert.equal(queued[0].reason, '排在第 1 个，有空位就开始')
  assert.equal(queued[1].reason, '排在第 2 个，有空位就开始')
  assert.deepEqual(queued.map(card => card.id), [cards[1].id, cards[2].id], '先开最早的，剩下的按顺序')
  router.stop()
  hw.cleanup()
}

// 观察档：算得出、不开工，router.log 里的「本来会开始」条数等于空位数。
{
  const hw = makeHarness()
  updateRouter({ mode: 'observe', sameDir: 'allow', maxRunning: 2 }, { file: hw.file })
  const one = autoCard(hw, 'S3 合成：观察一', { queue: { auto: true, at: 1 } })
  const two = autoCard(hw, 'S3 合成：观察二', { queue: { auto: true, at: 2 } })
  autoCard(hw, 'S3 合成：观察三', { queue: { auto: true, at: 3 } })
  const router = routerFor(hw)
  const before = creates(hw)
  const round = await router.runOnce()
  assert.equal(round.mode, 'observe')
  assert.equal(creates(hw) - before, 0, '观察档开工调用为 0')
  const would = readRouterLog(hw.file).filter(row => row.would === 'start')
  assert.equal(would.length, 2, '空位 2 个，就记 2 条')
  assert.deepEqual(would.map(row => row.taskId), [one.id, two.id])
  const view = hw.buildView()
  for (const id of [one.id, two.id]) {
    const card = view.cards.find(row => row.id === id)
    assert.match(card.reason, /^观察中：本来会在 \d\d:\d\d 开始$/)
    assert.equal(card.stage, 'queued')
  }
  assert.equal(view.router.mode, 'observe')
  assert.equal(view.router.maxRunning, 2)
  assert.equal(view.router.free, 2)
  router.stop()
  hw.cleanup()
}

// 并发：两次调度同时触发，同一张卡只开工一次；条件写失败的那一轮什么都不做。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 2 }, { file: hw.file })
  autoCard(hw, 'S3 合成：并发一', { queue: { auto: true, at: 1 } })
  autoCard(hw, 'S3 合成：并发二', { queue: { auto: true, at: 2 } })
  const router = routerFor(hw)
  const before = creates(hw)
  const [a, b] = await Promise.all([router.runOnce(), router.runOnce()])
  const busy = [a, b].filter(result => result.skipped === 'busy')
  assert.equal(busy.length, 1, '同一时刻只跑一次调度')
  assert.equal(creates(hw) - before, 2, '两张卡各开一次')

  const { revision } = listTasks({ includeArchived: true }, { file: hw.file })
  const stale = claimRouterTasks(['t-stale-card'], 0, { file: hw.file })
  assert.equal(stale.ok, false, '版本对不上时条件写失败')
  assert.ok(stale.revision >= revision)
  router.stop()
  hw.cleanup()
}

// 触发：turn/end 与 30 秒兜底定时器都能把调度叫起来。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 1 }, { file: hw.file })
  autoCard(hw, 'S3 合成：turn/end 触发', { queue: { auto: true, at: 1 } })
  const router = routerFor(hw, { debounceMs: 5 })
  const before = creates(hw)
  router.notify('turn/end')
  await delay(120)
  assert.equal(creates(hw) - before, 1, 'turn/end 之后去抖调度')
  router.stop()
  hw.cleanup()
}

{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 1 }, { file: hw.file })
  autoCard(hw, 'S3 合成：兜底定时器', { queue: { auto: true, at: 1 } })
  const router = routerFor(hw, { tickMs: 40, debounceMs: 60_000 })
  const before = creates(hw)
  router.start()
  await delay(150)
  router.stop()
  assert.equal(creates(hw) - before, 1, '兜底定时器也会调度')
  hw.cleanup()
}

// 台账写入之后去抖一次：不靠手动 runOnce。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 1 }, { file: hw.file })
  const router = routerFor(hw, { debounceMs: 10 })
  const { onLedgerWrite } = await import('../lib/ledger.js')
  const off = onLedgerWrite(file => {
    if (file === hw.file) router.notify('ledger/write')
  })
  const before = creates(hw)
  autoCard(hw, 'S3 合成：写入触发', { queue: { auto: true, at: 1 } })
  await delay(120)
  off()
  router.stop()
  assert.equal(creates(hw) - before, 1, '写台账会触发一次调度')
  hw.cleanup()
}

// 动作：router_mode / router_limit 只改设置，参数不对回 400。
{
  const hw = makeHarness()
  const routes = routesFor(hw.engine)
  const off = await routes.post({ action: 'router_mode', text: 'off' })
  assert.equal(off.status, 200)
  assert.equal(off.body.router.mode, 'off')
  assert.equal(readRouter(hw.file).mode, 'off')
  const limit = await routes.post({ action: 'router_limit', text: '3' })
  assert.equal(limit.status, 200)
  assert.equal(limit.body.router.maxRunning, 3)
  const badMode = await routes.post({ action: 'router_mode', text: 'always' })
  assert.equal(badMode.status, 400)
  const badLimit = await routes.post({ action: 'router_limit', text: '9' })
  assert.equal(badLimit.status, 400)
  assert.equal(readRouter(hw.file).maxRunning, 3)
  routes.dispose()
  hw.cleanup()
}

console.log('s3-router: ok')
