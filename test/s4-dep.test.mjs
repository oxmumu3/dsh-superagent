// S4 第 2 阶段：卡之间的依赖。
// 全部临时合成台账和假宿主；每个用例结束清理。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeHarness } from './support/harness.mjs'
import { ensureEvidence } from './support/evidence-fixture.mjs'
import { createRouter } from '../lib/router.js'
import {
  createTask,
  getTask,
  listTasks,
  reportExecution,
  setTaskDepends,
  updateRouter,
} from '../lib/ledger.js'
import { createToolDefinitions } from '../lib/tools.js'
import { registerRoutes } from '../lib/route.js'
import { buildView } from '../lib/viewmodel.js'

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

function autoCard(hw, title, workspacePath, extra = {}) {
  return hw.task({
    title,
    workspacePath,
    queue: { auto: true, by: 'user' },
    ...extra,
  })
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

async function finishAsReady(hw, taskId) {
  const task = getTask(taskId, { file: hw.file })
  const assignment = (task.assignments ?? []).filter(item => item.state !== 'ended').pop()
  assert.ok(assignment, '要有当前派工')
  ensureEvidence(taskId, hw.file, { sessionId: assignment.sessionId })
  reportExecution(taskId, { outcome: 'ready', summary: '合成完成', checks: ['node test'] }, {
    file: hw.file,
    sessionId: assignment.sessionId,
  })
  await hw.engine.acceptTask(taskId)
}

// 1. B 等 A：A 没做完时 B 不开，kind=dep；A done 以后下一轮 B 开工。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const dir = dirOf(hw, 'a')
  const a = autoCard(hw, 'S4 依赖 A', dirOf(hw, 'a1'))
  const b = autoCard(hw, 'S4 依赖 B', dirOf(hw, 'b1'), { dependsOn: [a.id] })
  const router = routerFor(hw)
  const before = creates(hw)
  const round1 = await router.runOnce()
  assert.deepEqual(round1.started.map(row => row.taskId), [a.id])
  assert.equal(creates(hw) - before, 1)
  const depSkip = round1.plan.skipped.find(row => row.taskId === b.id)
  assert.equal(depSkip.kind, 'dep')
  assert.equal(depSkip.reason, '等「S4 依赖 A」做完')
  assert.equal(getTask(b.id, { file: hw.file }).status, 'todo', '依赖没等到的卡还在排队')
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === b.id).stage, 'queued')
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === b.id).reason, '等「S4 依赖 A」做完')

  await finishAsReady(hw, a.id)
  assert.equal(getTask(a.id, { file: hw.file }).status, 'done')
  const round2 = await router.runOnce()
  assert.deepEqual(round2.started.map(row => row.taskId), [b.id], 'A 做完后 B 开工')
  assert.equal(creates(hw) - before, 2)
  router.stop()
  hw.cleanup()
}

// 2. 依赖校验：不存在、自己、两级成环、三级成环；台账不变。
{
  const hw = makeHarness()
  const dir = dirOf(hw, 'v')
  const a = createTask({ title: 'S4 校验 A', workspacePath: dir }, { file: hw.file })
  assert.throws(
    () => createTask({ title: 'S4 校验 缺卡', dependsOn: ['t-not-exist'] }, { file: hw.file }),
    /找不到要等的卡/,
  )
  assert.equal(listTasks({ includeArchived: true }, { file: hw.file }).total, 1, '校验失败不建卡')
  assert.throws(() => setTaskDepends(a.id, [a.id], { file: hw.file }), /不能等自己做/)
  assert.deepEqual(getTask(a.id, { file: hw.file }).dependsOn, [])

  const b = createTask({ title: 'S4 校验 B', workspacePath: dir, dependsOn: [a.id] }, { file: hw.file })
  assert.throws(() => setTaskDepends(a.id, [b.id], { file: hw.file }), /成环/)
  assert.deepEqual(getTask(a.id, { file: hw.file }).dependsOn, [])
  assert.deepEqual(getTask(b.id, { file: hw.file }).dependsOn, [a.id])

  const c = createTask({ title: 'S4 校验 C', workspacePath: dir, dependsOn: [b.id] }, { file: hw.file })
  assert.throws(() => setTaskDepends(a.id, [c.id], { file: hw.file }), /成环/, '三级也要挡住')
  assert.deepEqual(getTask(a.id, { file: hw.file }).dependsOn, [])
  hw.cleanup()
}

// 3. A 被取消 → B 进 dep（等你）；dep_clear 后回到排队并能开工。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const a = hw.task({ title: 'S4 会被取消的 A', workspacePath: dirOf(hw, 'c1') })
  const b = autoCard(hw, 'S4 等 A 的 B', dirOf(hw, 'c2'), { dependsOn: [a.id] })
  const routes = routesFor(hw.engine)
  assert.equal((await routes.post({ action: 'cancel', id: a.id, version: getTask(a.id, { file: hw.file }).version })).status, 200)
  const view = buildView({ file: hw.file })
  const row = view.cards.find(card => card.id === b.id)
  assert.equal(row.stage, 'dep')
  assert.equal(row.group, 'waiting')
  assert.equal(row.reason, '它等的「S4 会被取消的 A」取消了，还做不做？')
  assert.deepEqual(row.actions.map(item => item.label), ['照做', '以后再说', '不做了'])
  assert.equal(row.actions[0].primary, true)

  const router = routerFor(hw)
  const before = creates(hw)
  assert.equal((await router.runOnce()).started.length, 0, 'dep 阶段不自动开工')

  const cleared = await routes.post({ action: 'dep_clear', id: b.id, version: getTask(b.id, { file: hw.file }).version })
  assert.equal(cleared.status, 200)
  assert.deepEqual(getTask(b.id, { file: hw.file }).dependsOn, [])
  assert.equal(buildView({ file: hw.file }).cards.find(card => card.id === b.id).stage, 'queued')
  const round = await router.runOnce()
  assert.deepEqual(round.started.map(item => item.taskId), [b.id])
  assert.equal(creates(hw) - before, 1)
  router.stop()
  routes.dispose()
  hw.cleanup()
}

// 4. 手动开始一张依赖没做完的卡 → 能开。
{
  const hw = makeHarness()
  const a = hw.task({ title: 'S4 手动依赖 A', workspacePath: dirOf(hw, 'm1') })
  const b = hw.task({ title: 'S4 手动依赖 B', workspacePath: dirOf(hw, 'm2'), dependsOn: [a.id] })
  const routes = routesFor(hw.engine)
  const started = await routes.post({ action: 'start', id: b.id })
  assert.equal(started.status, 200, '手动开始不受依赖限制')
  assert.equal(getTask(b.id, { file: hw.file }).status, 'in_progress')
  routes.dispose()
  hw.cleanup()
}

// 5. 工具：sa_create 带 dependsOn；sa_depend 改依赖；空数组清空。
{
  const hw = makeHarness()
  const engine = hw.engine
  const definitions = createToolDefinitions(engine)
  const saCreate = definitions.find(item => item.name === 'sa_create')
  const saDepend = definitions.find(item => item.name === 'sa_depend')
  const a = createTask({ title: 'S4 工具 A' }, { file: hw.file })
  const previous = process.env.DSH_SUPERAGENT_LEDGER
  process.env.DSH_SUPERAGENT_LEDGER = hw.file
  let createdText
  try {
    createdText = await saCreate.execute({
      title: 'S4 工具 B',
      workspacePath: hw.dir,
      dependsOn: [a.id],
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_SUPERAGENT_LEDGER
    else process.env.DSH_SUPERAGENT_LEDGER = previous
  }
  const b = listTasks({ includeArchived: true }, { file: hw.file }).tasks.find(task => task.title === 'S4 工具 B')
  assert.ok(b, createdText)
  assert.deepEqual(b.dependsOn, [a.id])
  process.env.DSH_SUPERAGENT_LEDGER = hw.file
  try {
    assert.match(await saDepend.execute({ id: b.id, on: [] }), /不再等别的卡/)
    assert.deepEqual(getTask(b.id, { file: hw.file }).dependsOn, [])
    assert.match(await saDepend.execute({ id: b.id, on: [a.id] }), /等 /)
  } finally {
    if (previous === undefined) delete process.env.DSH_SUPERAGENT_LEDGER
    else process.env.DSH_SUPERAGENT_LEDGER = previous
  }
  assert.deepEqual(getTask(b.id, { file: hw.file }).dependsOn, [a.id])
  hw.cleanup()
}

// 6. 动作 depends 用逗号分隔；空串清空；成环报 400。
{
  const hw = makeHarness()
  const a = createTask({ title: 'S4 动作 A', workspacePath: hw.dir }, { file: hw.file })
  const b = createTask({ title: 'S4 动作 B', workspacePath: hw.dir }, { file: hw.file })
  const c = createTask({ title: 'S4 动作 C', workspacePath: hw.dir }, { file: hw.file })
  const routes = routesFor(hw.engine)
  const set = await routes.post({ action: 'depends', id: c.id, text: `${a.id}, ${b.id}` })
  assert.equal(set.status, 200)
  assert.deepEqual(getTask(c.id, { file: hw.file }).dependsOn, [a.id, b.id])
  const bad = await routes.post({ action: 'depends', id: a.id, text: c.id })
  assert.equal(bad.status, 400, '成环要 400')
  assert.match(bad.body.error, /成环/)
  const empty = await routes.post({ action: 'depends', id: c.id, text: '' })
  assert.equal(empty.status, 200)
  assert.deepEqual(getTask(c.id, { file: hw.file }).dependsOn, [])
  routes.dispose()
  hw.cleanup()
}

// 7. 等多张时只写第一张没做完的，并带「等 N 件」。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2, sameDir: 'allow' }, { file: hw.file })
  const a = autoCard(hw, 'S4 多依赖 A', dirOf(hw, 'd1'))
  const b = autoCard(hw, 'S4 多依赖 B', dirOf(hw, 'd2'))
  const c = autoCard(hw, 'S4 多依赖 C', dirOf(hw, 'd3'), { dependsOn: [a.id, b.id] })
  const router = routerFor(hw)
  const round = await router.runOnce()
  const skip = round.plan.skipped.find(row => row.taskId === c.id)
  assert.equal(skip.kind, 'dep')
  assert.match(skip.reason, /^等「S4 多依赖 A」做完/)
  assert.match(skip.reason, /（等 2 件）/)
  router.stop()
  hw.cleanup()
}

console.log('s4-dep: ok')
