import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { handleAction, registerRoutes } from '../lib/route.js'
import { reportExecution, getTask } from '../lib/ledger.js'

// E. 用户动作：start / comment / answer / reject / accept / later / cancel / create。
{
  const hw = makeHarness()
  const card = hw.task({ status: 'backlog' })
  hw.setTaskId(card.id)

  const started = await handleAction(hw.engine, { action: 'start', id: card.id })
  await hw.engine.whenIdle()
  assert.equal(started.ok, true)
  assert.equal(getTask(card.id, { file: hw.file }).status, 'in_progress')
  assert.equal(hw.stage(card.id).stage, 'working')

  await handleAction(hw.engine, { action: 'comment', id: card.id, text: '补一句要求' })
  await hw.engine.whenIdle()
  const followup = hw.calls.filter(call => call.type === 'followup').at(-1)
  assert.match(followup.message.content[0].text, /补一句要求/)

  reportExecution(card.id, {
    outcome: 'progress',
    summary: '要选方案',
    question: { text: 'A 还是 B？' },
  }, { file: hw.file })
  await handleAction(hw.engine, { action: 'answer', id: card.id, text: '选 A' })
  await hw.engine.whenIdle()
  assert.equal(getTask(card.id, { file: hw.file }).openQuestion, null)

  // 回到待验收，再打回。
  reportExecution(card.id, { outcome: 'ready', summary: '做完了' }, { file: hw.file })
  assert.equal(getTask(card.id, { file: hw.file }).status, 'in_review')
  await handleAction(hw.engine, { action: 'reject', id: card.id, text: '再改一版' })
  await hw.engine.whenIdle()
  assert.equal(getTask(card.id, { file: hw.file }).status, 'in_progress')

  // accept 移到 done，并结束派工。
  reportExecution(card.id, { outcome: 'ready', summary: '再做完' }, { file: hw.file })
  await handleAction(hw.engine, { action: 'accept', id: card.id })
  const accepted = getTask(card.id, { file: hw.file })
  assert.equal(accepted.status, 'done')
  assert.equal(accepted.assignments[0].state, 'ended')
  assert.equal(accepted.assignments[0].endReason, 'done')
  assert.ok(hw.calls.some(call => call.type === 'dispose'))
  hw.cleanup()
}

// 取消：卡 canceled，取消会话，结束派工；later：回到 backlog。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  const run = await hw.startConfirmed(card.id)

  await handleAction(hw.engine, { action: 'cancel', id: card.id })
  const canceled = getTask(card.id, { file: hw.file })
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.assignments[0].endReason, 'canceled')
  assert.ok(hw.calls.some(call => call.type === 'cancel' && call.id === run.sessionId))

  const later = hw.task()
  await handleAction(hw.engine, { action: 'later', id: later.id })
  assert.equal(getTask(later.id, { file: hw.file }).status, 'backlog')
  hw.cleanup()
}

// 重试：路由把 failed 动作重新置 pending 并再跑。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.state.failCreate = 6
  await hw.engine.startTask(card.id)
  await hw.engine.whenIdle()
  assert.equal(hw.stage(card.id).stage, 'not_started')

  hw.state.failCreate = 0
  await handleAction(hw.engine, { action: 'retry', id: card.id })
  await hw.engine.whenIdle()
  assert.equal(hw.stage(card.id).stage, 'working')
  hw.cleanup()
}

// 面板路由：GET 快照、POST 动作，返回最新 buildView；坏请求 400。
{
  const hw = makeHarness()
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
  const dispose = registerRoutes(ctx, { engine: hw.engine })
  assert.ok(routes.has('/api/superagent/view'))
  assert.ok(routes.has('/api/superagent/action'))

  const viewRoute = routes.get('/api/superagent/view')
  const viewResponse = await viewRoute.fetch(new Request('http://localhost/api/superagent/view'))
  assert.equal(viewResponse.status, 200)
  assert.ok(Array.isArray((await viewResponse.json()).cards))

  const actionRoute = routes.get('/api/superagent/action')
  const card = hw.task()
  const post = body => actionRoute.fetch(new Request('http://localhost/api/superagent/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

  const startResponse = await post({ action: 'start', id: card.id })
  assert.equal(startResponse.status, 200)
  const startView = await startResponse.json()
  assert.equal(startView.cards.find(c => c.id === card.id).stage, 'working')
  await hw.engine.whenIdle()

  // 版本冲突：409 并回读最新视图；用对版本再成功。
  const versionCard = hw.task()
  const stale = await post({ action: 'later', id: versionCard.id, version: versionCard.version + 5 })
  assert.equal(stale.status, 409)
  const staleView = await stale.json()
  assert.equal(staleView.conflict, true)
  assert.ok(staleView.cards.some(c => c.id === versionCard.id), '冲突响应也带最新视图')
  const fresh = await post({ action: 'later', id: versionCard.id, version: versionCard.version })
  assert.equal(fresh.status, 200)
  assert.equal(getTask(versionCard.id, { file: hw.file }).status, 'backlog')

  const createResponse = await post({ action: 'create', text: '面板随手记' })
  assert.equal(createResponse.status, 200)
  const createdView = await createResponse.json()
  assert.ok(createdView.cards.some(c => c.title === '面板随手记'))

  const badResponse = await post({ action: 'nope', id: card.id })
  assert.equal(badResponse.status, 400)
  assert.match((await badResponse.json()).error, /未知动作/)

  dispose()
  assert.equal(routes.size, 0)
  hw.cleanup()
}

console.log('s1-actions: ok')
