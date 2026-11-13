// S3 第 0 阶段：老卡不进自动队列、事件不改卡的版本号、Router 总开关。
// 全部用临时合成台账和假宿主，不碰真实台账或模型。

import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { createRouter } from '../lib/router.js'
import { addPending, getTask, listTasks, readRouter, updateRouter } from '../lib/ledger.js'
import { installCapture } from '../lib/capture.js'
import { registerRoutes } from '../lib/route.js'

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

function routerFor(hw) {
  return createRouter({
    file: hw.file,
    engine: hw.engine,
    debounceMs: 1,
    tickMs: 60 * 60_000,
    wait: async () => {},
  })
}

const createCalls = hw => hw.calls.filter(call => call.type === 'create').length

// 0.1：35 张没有 queue 字段的老待办，切到自动、跑 10 次调度，宿主建会话次数为 0。
{
  const hw = makeHarness()
  for (let index = 0; index < 35; index += 1) {
    hw.task({ title: `S3 老卡 ${index}`, description: '导入的老待办' })
  }
  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 2 }, { file: hw.file })
  const router = routerFor(hw)

  for (let round = 0; round < 10; round += 1) {
    const result = await router.runOnce()
    assert.equal(result.mode, 'auto')
    assert.deepEqual(result.started, [], `第 ${round + 1} 轮不应开任何老卡`)
  }
  assert.equal(createCalls(hw), 0, '老卡没有 queue.auto，Router 不碰')
  const { tasks } = listTasks({ includeArchived: true }, { file: hw.file })
  assert.equal(tasks.length, 35)
  assert.ok(tasks.every(task => (task.assignments ?? []).length === 0), '不该给老卡写派工')
  assert.ok(tasks.every(task => task.queue === null))
  router.stop()
  hw.cleanup()
}

// 0.1 续：四种写入点会写 queue.auto —— 规则落卡、面板 create、pending_accept、queue 动作。
{
  const hw = makeHarness()
  const routes = routesFor(hw.engine)
  const created = await routes.post({ action: 'create', text: 'S3 合成：面板记一下', workspacePath: hw.dir })
  assert.equal(created.status, 200)
  const createdTask = getTask(created.body.result.task.id, { file: hw.file })
  assert.deepEqual(
    { auto: createdTask.queue?.auto, by: createdTask.queue?.by },
    { auto: true, by: 'user' },
    '面板 create 要标成自动排队',
  )

  const pendingRow = addPending({ text: 'S3 合成：待确认的事', title: 'S3 合成：待确认的事', workspacePath: hw.dir }, { file: hw.file })
  const accepted = hw.engine.acceptPending(pendingRow.id)
  assert.equal(accepted.queue?.auto, true)
  assert.equal(accepted.queue?.by, 'user', 'pending_accept 也是用户确认过的')

  const later = hw.task({ title: 'S3 合成：以后再说', status: 'backlog' })
  assert.equal(later.queue, null)
  const queued = hw.engine.queueTask(later.id)
  assert.equal(queued.status, 'todo')
  assert.equal(queued.queue?.auto, true, 'queue 动作要把卡标成自动排队')

  // 规则落卡：明确说「记一下」的那条话直接建自动排队的卡。
  // capture 走台账默认路径，这里把默认路径指到临时台账。
  const handlers = []
  installCapture({ on: (name, handler) => { handlers.push({ name, handler }); return () => {} } }, {})
  assert.equal(handlers.length, 1)
  const previousLedger = process.env.DSH_SUPERAGENT_LEDGER
  process.env.DSH_SUPERAGENT_LEDGER = hw.file
  try {
    await handlers[0].handler({
      agent: { id: 'session-user-1' },
      session: { header: { cwd: hw.dir } },
      message: {
        id: 'msg-rule-1',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '帮我记一下：周五之前把面板做好' }],
      },
    })
  } finally {
    if (previousLedger === undefined) delete process.env.DSH_SUPERAGENT_LEDGER
    else process.env.DSH_SUPERAGENT_LEDGER = previousLedger
  }
  let ruleCard = null
  for (let index = 0; index < 100 && !ruleCard; index += 1) {
    ruleCard = listTasks({ includeArchived: true }, { file: hw.file }).tasks
      .find(task => task.createdBy === 'rule') ?? null
    if (!ruleCard) await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(ruleCard, '规则落卡应该建出一张卡')
  assert.equal(ruleCard.queue?.auto, true)
  assert.equal(ruleCard.queue?.by, 'rule')
  routes.dispose()
  hw.cleanup()
}

// 0.2：开始一张卡后模拟 20 个宿主事件，再带原来的版本号取消，应返回 200。
{
  const hw = makeHarness()
  const card = hw.task({ title: 'S3 合成：事件不改版本' })
  const run = await hw.startConfirmed(card.id)
  assert.equal(run.ok, true)
  const afterStart = getTask(card.id, { file: hw.file })
  const version = afterStart.version
  const assignment = afterStart.assignments.find(item => item.state !== 'ended')
  assert.ok(assignment, '开始后要有当前派工')
  const startEffect = hw.listEffects().find(effect => effect.kind === 'start' && effect.state === 'confirmed')
  assert.ok(startEffect, '开始动作要被宿主确认')

  const sessionId = assignment.sessionId
  for (let index = 0; index < 20; index += 1) {
    const kind = index % 4
    if (kind === 0) {
      hw.engine.onEvent({ type: 'turn/start', data: { agent: { id: sessionId }, turn: index + 1 } })
    } else if (kind === 1) {
      hw.engine.onEvent({
        type: 'turn/end',
        data: { agent: { id: sessionId }, turn: index + 1, reason: { kind: 'completed' } },
      })
    } else if (kind === 2) {
      hw.engine.onEvent({
        type: 'agent/inbox/claimed',
        data: { agent: { id: sessionId }, message: { id: startEffect.messageId } },
      })
    } else {
      hw.engine.onEvent({ type: 'agent/inbox/spliced', data: { agent: { id: sessionId } } })
    }
  }
  const afterEvents = getTask(card.id, { file: hw.file })
  assert.equal(afterEvents.version, version, '宿主事件只加台账 revision，不加卡的 version')
  assert.ok(
    listTasks({ includeArchived: true }, { file: hw.file }).revision > 0,
    '事件仍要推进台账 revision',
  )

  const routes = routesFor(hw.engine)
  const canceled = await routes.post({ action: 'cancel', id: card.id, version })
  assert.equal(canceled.status, 200, `带原版本取消应成功，实际 ${canceled.status}：${canceled.body.error ?? ''}`)
  assert.equal(getTask(card.id, { file: hw.file }).status, 'canceled')
  routes.dispose()
  hw.cleanup()
}

// 0.3：没有 router 字段按 observe；环境变量 off 优先于台账；off 时任何卡都不开工。
{
  const hw = makeHarness()
  const router = routerFor(hw)
  assert.equal(readRouter(hw.file).mode, 'observe', '没有字段时默认观察档')

  const card = hw.task({ title: 'S3 合成：自动排队', queue: { auto: true, by: 'user' } })
  const observed = await router.runOnce()
  assert.equal(observed.mode, 'observe')
  assert.equal(createCalls(hw), 0, '观察档不开工')

  updateRouter({ mode: 'auto', sameDir: 'allow', maxRunning: 1 }, { file: hw.file })
  assert.equal(readRouter(hw.file).mode, 'auto')
  assert.equal(readRouter(hw.file).maxRunning, 1)

  process.env.DSH_SUPERAGENT_ROUTER = 'off'
  try {
    const routed = readRouter(hw.file)
    assert.equal(routed.mode, 'off', '环境变量优先')
    assert.equal(routed.storedMode, 'auto', '台账里的设置不被环境变量改写')
    const offRun = await router.runOnce()
    assert.equal(offRun.mode, 'off')
    assert.equal(createCalls(hw), 0, 'off 档完全不动')
  } finally {
    delete process.env.DSH_SUPERAGENT_ROUTER
  }

  const autoRun = await router.runOnce()
  assert.equal(autoRun.mode, 'auto')
  assert.deepEqual(autoRun.started.map(row => row.taskId), [card.id], '去掉紧急停之后自动档才开工')
  assert.equal(createCalls(hw), 1)
  router.stop()
  hw.cleanup()
}

// 0.3 续：上限只接受 1–5；档位只接受三档。
{
  const hw = makeHarness()
  assert.throws(() => updateRouter({ maxRunning: 0 }, { file: hw.file }), /1 到 5/)
  assert.throws(() => updateRouter({ maxRunning: 6 }, { file: hw.file }), /1 到 5/)
  assert.throws(() => updateRouter({ maxRunning: 2.5 }, { file: hw.file }), /1 到 5/)
  assert.throws(() => updateRouter({ mode: 'always' }, { file: hw.file }), /unknown router mode/)
  const written = updateRouter({ mode: 'observe', sameDir: 'allow', maxRunning: 3 }, { file: hw.file })
  assert.equal(written.mode, 'observe')
  assert.equal(written.maxRunning, 3)
  assert.ok(Number.isFinite(written.updatedAt))
  hw.cleanup()
}

console.log('s3-env: ok')
