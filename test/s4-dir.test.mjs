// S4 第 1 阶段：同目录保护。
// 全部临时合成台账和假宿主；路径都建在临时目录里。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeHarness } from './support/harness.mjs'
import { createRouter, planSchedule } from '../lib/router.js'
import { overlaps } from '../lib/workspace.js'
import { getTask, readRouter, updateRouter } from '../lib/ledger.js'
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

function autoCard(hw, title, workspacePath, at) {
  return hw.task({ title, workspacePath, queue: { auto: true, by: 'user', at } })
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

const creates = hw => hw.calls.filter(call => call.type === 'create').length

// 1. overlaps：相同、上下级、兄弟、结尾斜杠。
{
  const root = '/tmp/s4-overlaps'
  assert.equal(overlaps(root, root), true)
  assert.equal(overlaps(root, root + '/'), true)
  assert.equal(overlaps(root + '/', root), true)
  assert.equal(overlaps(root, root + '/sub'), true)
  assert.equal(overlaps(root + '/sub', root), true)
  assert.equal(overlaps(root + '/sub/deep', root + '/sub'), true)
  assert.equal(overlaps(root + '/a', root + '/b'), false)
  assert.equal(overlaps(root, '/tmp/s4-overlaps-other'), false)
  assert.equal(overlaps('', root), false)
  assert.equal(overlaps(null, root), false)
}

// 1b. 022 复验：点段、同前缀兄弟、根目录、家目录都要按执行路径规范化比较。
{
  const os = await import('node:os')
  assert.equal(overlaps('/tmp/project', '/tmp/sibling/../project'), true, '点段要解析成同一目录')
  assert.equal(overlaps('/tmp/project/', '/tmp/project/.'), true)
  assert.equal(overlaps('/tmp/project', '/tmp/project2'), false, '同前缀兄弟不是上下级')
  assert.equal(overlaps('/', '/tmp/project'), true, '根是任何绝对路径的上级')
  assert.equal(overlaps('/tmp/project', '/'), true)
  assert.equal(overlaps(os.homedir() + '/x', '~/x'), true, '家目录要展开')
  assert.equal(overlaps('~/x', os.homedir() + '/x/'), true)
}

// 2. 上限 2，同一目录三张自动排队，另一目录一张 → 各开一张，其余 kind=dir。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2 }, { file: hw.file })
  const dirA = path.join(hw.dir, 'a')
  const dirB = path.join(hw.dir, 'b')
  fs.mkdirSync(dirA)
  fs.mkdirSync(dirB)
  const a1 = autoCard(hw, 'S4 同目录 1', dirA, 1)
  const a2 = autoCard(hw, 'S4 同目录 2', dirA, 2)
  const a3 = autoCard(hw, 'S4 同目录 3', dirA, 3)
  const b1 = autoCard(hw, 'S4 另一目录', dirB, 4)
  const router = routerFor(hw)
  const before = creates(hw)
  const round = await router.runOnce()
  assert.equal(creates(hw) - before, 2)
  assert.deepEqual(round.started.map(row => row.taskId).sort(), [a1.id, b1.id].sort(), '各目录各开一张')
  const dirSkips = round.plan.skipped.filter(row => row.kind === 'dir')
  assert.deepEqual(dirSkips.map(row => row.taskId).sort(), [a2.id, a3.id].sort())
  assert.match(dirSkips[0].reason, /^同一个目录里有一件在跑，等它停下再开始/)
  assert.match(dirSkips[0].reason, /（在跑：S4 同目录 1）/)
  const view = hw.buildView()
  const byId = id => view.cards.find(card => card.id === id)
  assert.match(byId(a2.id).reason, /^同一个目录里有一件在跑，等它停下再开始/)
  assert.match(byId(a3.id).reason, /^同一个目录里有一件在跑，等它停下再开始/)
  assert.equal(byId(a2.id).position, null, '被同目录挡住的不算第 N 个')
  assert.equal(view.router.sameDir, 'wait')
  router.stop()
  hw.cleanup()
}

// 3. 同目录有一张手动在跑时，自动卡不开；用户手动点开始能开。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2 }, { file: hw.file })
  const dir = path.join(hw.dir, 'a')
  fs.mkdirSync(dir)
  const manual = hw.task({ title: 'S4 手动在跑', workspacePath: dir })
  await hw.startConfirmed(manual.id)
  const auto = autoCard(hw, 'S4 自动等这个目录', dir, 1)
  const router = routerFor(hw)
  const before = creates(hw)
  const round = await router.runOnce()
  assert.equal(round.started.length, 0, '同目录手动在跑，自动卡等')
  assert.equal(creates(hw) - before, 0)
  assert.equal(round.plan.skipped.find(row => row.taskId === auto.id)?.kind, 'dir')

  const routes = routesFor(hw.engine)
  const started = await routes.post({ action: 'start', id: auto.id })
  assert.equal(started.status, 200, '用户手动开始不受同目录保护限制')
  assert.equal(getTask(auto.id, { file: hw.file }).status, 'in_progress')
  routes.dispose()
  router.stop()
  hw.cleanup()
}

// 4. allow：照 S3 结果开工；在跑的卡 reason 带「同目录还有 N 件在跑」。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const dir = path.join(hw.dir, 'a')
  fs.mkdirSync(dir)
  const cards = [1, 2, 3].map(index => autoCard(hw, `S4 允许同目录 ${index}`, dir, index))
  const router = routerFor(hw)
  const before = creates(hw)
  const round = await router.runOnce()
  assert.equal(creates(hw) - before, 2, 'allow 档按 S3 结果开两张')
  assert.deepEqual(round.started.map(row => row.taskId).sort(), [cards[0].id, cards[1].id].sort())
  const view = hw.buildView()
  const running = view.groups.running
  assert.equal(running.length, 2)
  for (const card of running) assert.match(card.reason, /同目录还有 1 件在跑/)
  router.stop()
  hw.cleanup()
}

// 5. 设置默认与动作：缺字段 wait；allow/wait 可切；非法值 400。
{
  const hw = makeHarness()
  assert.equal(readRouter(hw.file).sameDir, 'wait')
  const routes = routesFor(hw.engine)
  const allow = await routes.post({ action: 'router_same_dir', text: 'allow' })
  assert.equal(allow.status, 200)
  assert.equal(allow.body.router.sameDir, 'allow')
  const wait = await routes.post({ action: 'router_same_dir', text: 'wait' })
  assert.equal(wait.status, 200)
  assert.equal(wait.body.router.sameDir, 'wait')
  const bad = await routes.post({ action: 'router_same_dir', text: 'parallel' })
  assert.equal(bad.status, 400)
  assert.equal(readRouter(hw.file).sameDir, 'wait')
  assert.throws(() => updateRouter({ sameDir: 'whatever' }, { file: hw.file }), /wait 或 allow/)
  routes.dispose()
  hw.cleanup()
}

// 5b. 022 复验：/tmp/project 与 /tmp/sibling/../project 同时排队时只能开一张。
{
  const tasks = [
    { id: 't-p1', title: 'P1', status: 'todo', workspacePath: '/tmp/project', queue: { auto: true, at: 1 } },
    { id: 't-p2', title: 'P2', status: 'todo', workspacePath: '/tmp/sibling/../project', queue: { auto: true, at: 2 } },
    { id: 't-other', title: 'Other', status: 'todo', workspacePath: '/tmp/other', queue: { auto: true, at: 3 } },
  ]
  const plan = planSchedule(tasks, [], { mode: 'auto', maxRunning: 2, sameDir: 'wait' }, 1_000, {})
  assert.deepEqual(plan.startNow, ['t-p1', 't-other'])
  assert.deepEqual(plan.skipped.map(row => [row.taskId, row.kind]), [['t-p2', 'dir']])
}

// 5c. 022 复验：根目录的卡在跑时，任何后代都不能同时开。
{
  const tasks = [
    { id: 't-root', title: 'Root', status: 'in_progress', workspacePath: '/', assignments: [{ id: 'a-root', state: 'running', sessionId: 's-root', cwd: '/' }] },
    { id: 't-deep', title: 'Deep', status: 'todo', workspacePath: '/tmp/deep', queue: { auto: true, at: 1 } },
  ]
  const plan = planSchedule(tasks, [], { mode: 'auto', maxRunning: 2, sameDir: 'wait' }, 1_000, {})
  assert.deepEqual(plan.startNow, [])
  assert.deepEqual(plan.skipped.map(row => row.taskId), ['t-deep'])
}

// 5d. 022 复验：手动开始用了和卡上不同的 cwd 时，按派工实际 cwd 防撞。
{
  const tasks = [
    {
      id: 't-manual',
      title: 'Manual',
      status: 'in_progress',
      workspacePath: '/tmp/card-dir',
      assignments: [{ id: 'a-manual', state: 'running', sessionId: 's-manual', cwd: '/tmp/actual-dir' }],
    },
    { id: 't-same-actual', title: 'SameActual', status: 'todo', workspacePath: '/tmp/actual-dir', queue: { auto: true, at: 1 } },
    { id: 't-same-card', title: 'SameCard', status: 'todo', workspacePath: '/tmp/card-dir', queue: { auto: true, at: 2 } },
  ]
  const plan = planSchedule(tasks, [], { mode: 'auto', maxRunning: 2, sameDir: 'wait' }, 1_000, {})
  assert.deepEqual(plan.startNow, ['t-same-card'], '卡上目录已经空出来，实际 cwd 仍被占着')
  assert.deepEqual(plan.skipped.map(row => [row.taskId, row.kind]), [['t-same-actual', 'dir']])
}

// 6. 纯计算：被跳过的卡不占空位，后面的不重叠卡照开。
{
  const tasks = [
    { id: 't-a1', title: 'A1', status: 'todo', workspacePath: '/tmp/d', queue: { auto: true, at: 1 } },
    { id: 't-a2', title: 'A2', status: 'todo', workspacePath: '/tmp/d/sub', queue: { auto: true, at: 2 } },
    { id: 't-b1', title: 'B1', status: 'todo', workspacePath: '/tmp/e', queue: { auto: true, at: 3 } },
  ]
  const plan = planSchedule(tasks, [], { mode: 'auto', maxRunning: 2, sameDir: 'wait' }, 1_000, {})
  assert.deepEqual(plan.startNow, ['t-a1', 't-b1'])
  assert.deepEqual(plan.skipped.map(row => row.taskId), ['t-a2'])
  assert.equal(plan.waiting.length, 0)
}

console.log('s4-dir: ok')
