import assert from 'node:assert/strict'
import { createHostAdapter, installSessionEvents } from '../lib/host.js'
import { workspaceOf, agentIdOf } from '../lib/capture.js'
import { makeHarness } from './support/harness.mjs'

// 1) 默认模型只读 agentDefaultModel.currentSelection，不碰会保存全局的选择接口。
{
  const calls = []
  const service = {
    currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }),
    saveSelection: () => calls.push('saveSelection'),
    selectModel: () => calls.push('selectModel'),
  }
  const adapter = createHostAdapter({ ctx: { get: name => (name === 'agentDefaultModel' ? service : null) } })
  assert.deepEqual(await adapter.resolveModel(), {
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  })
  assert.deepEqual(calls, [], '不得调用 saveSelection/selectModel')
}

// 2) sessionController.resolveAgent 的 {error} 不是句柄；{agent} 才是。
{
  const controller = {
    async resolveAgent(id) {
      if (id === 'bad') return { error: { code: 'session/not-found', message: 'nope' } }
      return { agent: { id, status: 'idle', session: { header: { id } } } }
    },
  }
  const adapter = createHostAdapter({ sessionController: controller })
  assert.equal(await adapter.getSession('bad'), null)
  const found = await adapter.getSession('good')
  assert.equal(found.handle.id, 'good')
  assert.equal(found.running, false)
}

// 3) create 失败时退回 createAgent，两个入口都失败才报错。
{
  const agents = {
    create: async () => { throw new Error('create unavailable') },
    createAgent: async (_ctx, payload) => ({ agent: { id: payload.sessionId } }),
  }
  const adapter = createHostAdapter({ agents })
  const handle = await adapter.createSession({
    sessionId: 'session-1', cwd: '/tmp/x', provider: 'p', model: 'm', reasoningEffort: 'high',
  })
  assert.equal(handle.agent.id, 'session-1')
}

// 3b) 取消按 rc.1 契约带 cause；不传 keepInbox，让宿主丢弃已退役的排队消息。
{
  const args = []
  const agent = {
    id: 'session-cancel',
    status: 'running',
    cancel: (...received) => { args.push(received) },
  }
  const adapter = createHostAdapter({
    agents: { get: async () => ({ agent, status: 'running' }) },
  })
  await adapter.cancel('session-cancel')
  assert.deepEqual(args, [[{ kind: 'user' }]])
  assert.equal('keepInbox' in args[0][0], false)
}

// 4) capture 目录与 agent 身份：session.header.cwd / agent.session.header.id 直字段。
{
  assert.equal(workspaceOf({ session: { header: { cwd: '/tmp/direct' } } }), '/tmp/direct')
  assert.equal(workspaceOf({ agent: { session: { header: { cwd: '/tmp/agent' } } } }), '/tmp/agent')
  assert.equal(agentIdOf({ agent: { session: { header: { id: 'session-x' } } } }), 'session-x')
  assert.equal(agentIdOf({ session: { header: { id: 'session-y' } } }), 'session-y')
}

// 5) claimed 由 Cordis 单独 emit：直接订阅能确认；persisted splice 不能当确认。
{
  const hw = makeHarness({ confirmTimeoutMs: 30 })
  hw.state.autoConfirm = false
  const card = hw.task()
  hw.setTaskId(card.id)
  const run = await hw.engine.startTask(card.id)
  await new Promise(resolve => setTimeout(resolve, 5))

  const handlers = new Map()
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
  }
  installSessionEvents(ctx, hw.engine)
  assert.ok(handlers.has('agent/inbox/claimed'), '必须单独订阅 claimed')

  // persisted splice 先到：只刷新时间，不能把动作当已确认。
  handlers.get('session/event')(
    { header: { id: run.sessionId } },
    { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  )
  assert.equal(hw.listEffects()[0].state, 'sent', 'splice 不是 claimed')

  const effect = hw.listEffects()[0]
  handlers.get('agent/inbox/claimed')({
    agent: { session: { header: { id: run.sessionId } } },
    message: { id: effect.messageId },
    turn: 1,
  })
  assert.equal(hw.listEffects()[0].state, 'confirmed')
  assert.equal(hw.reload().assignments[0].state, 'running')

  // 同一 claimed 再从 session/event 到一次，状态不变且不重复收口。
  handlers.get('session/event')(
    { header: { id: run.sessionId } },
    { type: 'agent/inbox/claimed', data: { agent: { id: run.sessionId }, message: { id: effect.messageId } } },
  )
  assert.equal(hw.listEffects()[0].state, 'confirmed')
  assert.equal(hw.reload().assignments[0].state, 'running')
  hw.cleanup()
}

// 6) currentSelection 的 reasoningEffort 会带进建会话参数。
{
  const hw = makeHarness()
  hw.state.model = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  const card = hw.task()
  hw.setTaskId(card.id)
  await hw.startConfirmed(card.id)
  const create = hw.calls.find(call => call.type === 'create')
  assert.equal(create.input.reasoningEffort, 'high')
  assert.equal(hw.listEffects()[0].reasoningEffort, 'high')
  hw.cleanup()
}

console.log('s1-host: ok')
