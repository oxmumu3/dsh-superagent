// Executor sessions must mount the host's default agent preset, the same way
// the official RC2 session controller composes a fresh agent. Without the
// mount the child only sees host-plane tools (write/sa_report become unknown).
// This test stays at the adapter boundary: no real host, no permissions, no
// approval answer.
import assert from 'node:assert/strict'
import { createHostAdapter } from '../lib/host.js'

// 1) Preset available: meta carries the default id and setup mounts it.
{
  const mounted = []
  const payloads = []
  const agentCtx = { marker: 'agent-ctx' }
  const agent = { session: { header: { agentPreset: 'default' } } }
  const presets = {
    defaultId: 'default',
    async mount(ctx, id) { mounted.push({ ctx, id }) },
  }
  const agents = {
    async create(payload) {
      payloads.push(payload)
      if (typeof payload.setup === 'function') await payload.setup(agentCtx, agent)
      return { agent: { id: payload.sessionId } }
    },
  }
  const adapter = createHostAdapter({ agents, agentPresets: presets })
  const handle = await adapter.createSession({
    sessionId: 'session-sa-preset-1',
    cwd: '/tmp/example-workspace',
    provider: 'test-provider',
    model: 'test-model',
  })
  assert.equal(handle.agent.id, 'session-sa-preset-1')
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].meta.agentPreset, 'default')
  assert.equal(payloads[0].meta.cwd, '/tmp/example-workspace')
  assert.equal(typeof payloads[0].setup, 'function')
  assert.deepEqual(mounted, [{ ctx: agentCtx, id: 'default' }])
}

// 2) Header preset wins; a session that recorded another composition mounts it.
{
  const mounted = []
  const agents = {
    async create(payload) {
      await payload.setup({}, { session: { header: { agentPreset: 'explicit-one' } } })
      return { agent: { id: payload.sessionId } }
    },
  }
  const adapter = createHostAdapter({ agents, agentPresets: { defaultId: 'default', async mount(_ctx, id) { mounted.push(id) } } })
  await adapter.createSession({ sessionId: 'session-sa-preset-2', provider: 'p', model: 'm' })
  assert.deepEqual(mounted, ['explicit-one'])
}

// 3) No preset service: the old bare create stays, no setup, no throw.
{
  const payloads = []
  const agents = {
    async create(payload) {
      payloads.push(payload)
      return { agent: { id: payload.sessionId } }
    },
  }
  const adapter = createHostAdapter({ agents })
  const handle = await adapter.createSession({ sessionId: 'session-sa-preset-3', cwd: '/tmp/example-workspace' })
  assert.equal(handle.agent.id, 'session-sa-preset-3')
  assert.equal(payloads[0].meta.agentPreset, undefined)
  assert.equal(payloads[0].setup, undefined)
}

// 4) A preset mount failure is visible, not swallowed into a half-built session.
{
  const agents = {
    async create(payload) {
      await payload.setup({}, { session: { header: { agentPreset: 'default' } } })
      return { agent: { id: payload.sessionId } }
    },
  }
  const adapter = createHostAdapter({ agents, agentPresets: { defaultId: 'default', async mount() { throw new Error('mount failed') } } })
  await assert.rejects(
    () => adapter.createSession({ sessionId: 'session-sa-preset-4', provider: 'p', model: 'm' }),
    /mount failed/,
  )
}

console.log('s3-preview-preset: ok')
