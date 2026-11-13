// S4 022 复验：自动派工在 resolveModel 期间被改卡/取消时，不能在恢复后
// 照样建宿主会话。手动派工不受这条约束。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { makeHarness, deferred } from './support/harness.mjs'
import { createRouter } from '../lib/router.js'
import {
  getTask, readLedger, updateTask, releaseRouterClaim,
} from '../lib/ledger.js'
import { buildView } from '../lib/viewmodel.js'
import { updateRouter } from '../lib/ledger.js'
import { registerRoutes } from '../lib/route.js'

function routerFor(hw) {
  return createRouter({
    file: hw.file,
    engine: hw.engine,
    debounceMs: 10,
    tickMs: 60 * 60_000,
    wait: async () => {},
  })
}

function dirOf(hw, name) {
  const dir = path.join(hw.dir, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
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

const claimOf = (hw, id) => readLedger(hw.file).router?.claimed?.[id] ?? null
const assignments = (hw, id) => (getTask(id, { file: hw.file }).assignments ?? []).filter(row => row.state !== 'ended')

// 1. 抢占并停在 resolveModel；期间给卡加依赖 → 恢复后不开工，抢占释放。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const dir = dirOf(hw, 'race')
  const a = hw.task({ title: 'S4 竞态 A', workspacePath: dir })
  const b = hw.task({ title: 'S4 竞态 B', workspacePath: dir, queue: { auto: true, by: 'user' } })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const router = routerFor(hw)
  const before = hw.calls.filter(call => call.type === 'create').length
  const running = router.runOnce()
  for (let index = 0; index < 100 && !claimOf(hw, b.id); index += 1) await delay(10)
  assert.equal(claimOf(hw, b.id)?.state, 'starting', 'Router 先抢占')

  hw.engine.updateDepends(b.id, [a.id])
  gate.resolve()
  const result = await running
  hw.state.modelGate = null
  assert.deepEqual(result.released.map(row => row.taskId), [b.id], '复核失败走 released')
  assert.equal(assignments(hw, b.id).length, 0, '不能建派工')
  assert.equal(hw.calls.filter(call => call.type === 'create').length, before, '不能建宿主会话')
  assert.equal(claimOf(hw, b.id), null, '抢占要释放')
  assert.equal(getTask(b.id, { file: hw.file }).status, 'todo', '仍在排队')
  const row = buildView({ file: hw.file }).cards.find(card => card.id === b.id)
  assert.equal(row.stage, 'queued')
  assert.match(row.reason, /等「S4 竞态 A」做完/)

  // A 做完后下一轮能开工。
  const aTask = getTask(a.id, { file: hw.file })
  const { moveTask } = await import('../lib/ledger.js')
  moveTask(a.id, 'in_progress', { file: hw.file, ifVersion: aTask.version })
  moveTask(a.id, 'in_review', { file: hw.file, ifVersion: getTask(a.id, { file: hw.file }).version })
  moveTask(a.id, 'done', { file: hw.file, ifVersion: getTask(a.id, { file: hw.file }).version })
  const next = await router.runOnce()
  assert.deepEqual(next.started.map(row => row.taskId), [b.id])
  assert.equal(assignments(hw, b.id).length, 1)
  router.stop()
  hw.cleanup()
}

// 2. 抢占期间取消卡 → 恢复后不开工，卡保持取消。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const dir = dirOf(hw, 'cancel')
  const b = hw.task({ title: 'S4 竞态取消', workspacePath: dir, queue: { auto: true, by: 'user' } })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const router = routerFor(hw)
  const running = router.runOnce()
  for (let index = 0; index < 100 && !claimOf(hw, b.id); index += 1) await delay(10)
  const routes = routesFor(hw.engine)
  const canceled = await routes.post({ action: 'cancel', id: b.id, version: getTask(b.id, { file: hw.file }).version })
  assert.equal(canceled.status, 200)
  gate.resolve()
  const result = await running
  hw.state.modelGate = null
  assert.deepEqual(result.released.map(row => row.taskId), [b.id])
  assert.equal(assignments(hw, b.id).length, 0)
  assert.equal(getTask(b.id, { file: hw.file }).status, 'canceled')
  assert.equal(hw.calls.filter(call => call.type === 'create').length, 0)
  routes.dispose()
  router.stop()
  hw.cleanup()
}

// 3. 抢占期间目录被改成不存在 → 复核拒绝，不开工；手动派工照旧不受这条约束。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const dir = dirOf(hw, 'ws')
  const b = hw.task({ title: 'S4 竞态目录', workspacePath: dir, queue: { auto: true, by: 'user' } })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const router = routerFor(hw)
  const running = router.runOnce()
  for (let index = 0; index < 100 && !claimOf(hw, b.id); index += 1) await delay(10)
  updateTask(b.id, { workspacePath: path.join(dir, 'gone') }, { file: hw.file })
  gate.resolve()
  const result = await running
  hw.state.modelGate = null
  assert.deepEqual(result.released.map(row => row.taskId), [b.id])
  assert.equal(assignments(hw, b.id).length, 0)
  assert.equal(hw.calls.filter(call => call.type === 'create').length, 0)
  router.stop()
  hw.cleanup()
}

// 4. 手动开始不查依赖：resolveModel 期间加依赖也照旧开工。
{
  const hw = makeHarness()
  const dir = dirOf(hw, 'manual')
  const a = hw.task({ title: 'S4 手动竞态 A', workspacePath: dir })
  const b = hw.task({ title: 'S4 手动竞态 B', workspacePath: dir })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const starting = hw.engine.startTask(b.id, { by: 'user' })
  await delay(30)
  hw.engine.updateDepends(b.id, [a.id])
  gate.resolve()
  const result = await starting
  await hw.engine.whenIdle()
  assert.equal(result.ok, true, '手动开始不受自动复核影响')
  assert.equal(getTask(b.id, { file: hw.file }).status, 'in_progress')
  assert.equal(hw.calls.filter(call => call.type === 'create').length, 1)
  hw.cleanup()
}

// 5. 抢占记录被撤掉（另一个调度先放手）→ 复核失败，不建会话。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const dir = dirOf(hw, 'claim')
  const b = hw.task({ title: 'S4 抢占丢了', workspacePath: dir, queue: { auto: true, by: 'user' } })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const router = routerFor(hw)
  const running = router.runOnce()
  for (let index = 0; index < 100 && !claimOf(hw, b.id); index += 1) await delay(10)
  releaseRouterClaim(b.id, { file: hw.file })
  gate.resolve()
  const result = await running
  hw.state.modelGate = null
  assert.deepEqual(result.released.map(row => row.taskId), [b.id])
  assert.equal(assignments(hw, b.id).length, 0)
  router.stop()
  hw.cleanup()
}

// 6. 抢占后 resolveModel 期间用户手动启动同目录的另一张：B 复核占用后留队。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'wait' }, { file: hw.file })
  const dir = dirOf(hw, 'race-dir')
  const b = hw.task({ title: 'S4 自动 B', workspacePath: dir, queue: { auto: true, by: 'user' } })
  const a = hw.task({ title: 'S4 手动 A', workspacePath: dir })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const router = routerFor(hw)
  const running = router.runOnce()
  for (let index = 0; index < 100 && !claimOf(hw, b.id); index += 1) await delay(10)
  hw.state.modelGate = null
  const manual = await hw.engine.startTask(a.id, { by: 'user' })
  await hw.engine.whenIdle()
  assert.equal(manual.ok, true)
  assert.equal(getTask(a.id, { file: hw.file }).status, 'in_progress')
  gate.resolve()
  const result = await running
  hw.state.modelGate = null
  assert.deepEqual(result.released.map(row => row.taskId), [b.id], 'B 不能按过期计划开工')
  assert.equal(result.released[0].reason, 'dir', '同目录被手动卡占住')
  assert.equal(result.started.length, 0)
  assert.equal(assignments(hw, b.id).length, 0)
  assert.equal(claimOf(hw, b.id), null)
  assert.equal(hw.calls.filter(call => call.type === 'create').length, 1, '只有手动 A 建会话')
  const row = buildView({ file: hw.file }).cards.find(card => card.id === b.id)
  assert.equal(row.stage, 'queued')
  assert.match(row.reason, /^同一个目录里有一件在跑/)
  router.stop()
  hw.cleanup()
}

// 7. 抢占后 resolveModel 期间手动把档位唯一的位置占了：B 复核容量后留队。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 1, sameDir: 'allow' }, { file: hw.file })
  const b = hw.task({ title: 'S4 容量 B', workspacePath: dirOf(hw, 'cap-b'), queue: { auto: true, by: 'user' } })
  const a = hw.task({ title: 'S4 容量 A', workspacePath: dirOf(hw, 'cap-a') })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const router = routerFor(hw)
  const running = router.runOnce()
  for (let index = 0; index < 100 && !claimOf(hw, b.id); index += 1) await delay(10)
  hw.state.modelGate = null
  await hw.engine.startTask(a.id, { by: 'user' })
  await hw.engine.whenIdle()
  gate.resolve()
  const result = await running
  hw.state.modelGate = null
  assert.deepEqual(result.released.map(row => row.taskId), [b.id])
  assert.equal(result.released[0].reason, 'capacity')
  assert.equal(assignments(hw, b.id).length, 0)
  assert.equal(hw.calls.filter(call => call.type === 'create').length, 1)
  router.stop()
  hw.cleanup()
}

// 8. sameDir=allow：手动占了同目录但还有容量，B 复核后照常开工。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const dir = dirOf(hw, 'allow-dir')
  const b = hw.task({ title: 'S4 allow B', workspacePath: dir, queue: { auto: true, by: 'user' } })
  const a = hw.task({ title: 'S4 allow A', workspacePath: dir })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const router = routerFor(hw)
  const running = router.runOnce()
  for (let index = 0; index < 100 && !claimOf(hw, b.id); index += 1) await delay(10)
  hw.state.modelGate = null
  await hw.engine.startTask(a.id, { by: 'user' })
  await hw.engine.whenIdle()
  gate.resolve()
  const result = await running
  hw.state.modelGate = null
  assert.deepEqual(result.released, [])
  assert.deepEqual(result.started.map(row => row.taskId), [b.id])
  assert.equal(assignments(hw, b.id).length, 1)
  router.stop()
  hw.cleanup()
}

// 9. 占用按手动派工实际 cwd 算：卡上目录不同也挡得住。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'wait' }, { file: hw.file })
  const dirX = dirOf(hw, 'cwd-x')
  const dirY = dirOf(hw, 'cwd-y')
  const b = hw.task({ title: 'S4 cwd B', workspacePath: dirX, queue: { auto: true, by: 'user' } })
  const a = hw.task({ title: 'S4 cwd A', workspacePath: dirY })
  const gate = deferred()
  hw.state.modelGate = gate.promise
  const router = routerFor(hw)
  const running = router.runOnce()
  for (let index = 0; index < 100 && !claimOf(hw, b.id); index += 1) await delay(10)
  hw.state.modelGate = null
  await hw.engine.startTask(a.id, { by: 'user', cwd: dirX })
  await hw.engine.whenIdle()
  gate.resolve()
  const result = await running
  hw.state.modelGate = null
  assert.deepEqual(result.released.map(row => row.taskId), [b.id])
  assert.equal(result.released[0].reason, 'dir')
  assert.equal(assignments(hw, b.id).length, 0)
  router.stop()
  hw.cleanup()
}

console.log('s4-guard: ok')
