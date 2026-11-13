// Simulated host for S1 tests: a fake agents service plus a real ledger in a
// temp directory. No real session, no model, no network, no daily ledger.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from '../../lib/engine.js'
import { createTask, getTask, listEffects } from '../../lib/ledger.js'
import { buildView } from '../../lib/viewmodel.js'

export function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

export function makeHarness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-harness-'))
  const file = path.join(dir, 'ledger.json')
  const calls = []
  const handles = new Map()
  const state = {
    failCreate: 0,
    failFollowup: 0,
    autoConfirm: true,
    alive: true,
    running: undefined,
    createGate: null,
    reopenGate: null,
    model: { provider: 'test-provider', model: 'test-model' },
  }
  let engine

  const ledgerNow = () => JSON.parse(fs.readFileSync(file, 'utf8'))

  const adapter = {
    async createSession(input) {
      const atCall = ledgerNow()
      calls.push({ type: 'create', input, atCall })
      if (state.createGate) await state.createGate
      if (state.failCreate > 0) {
        state.failCreate -= 1
        throw new Error('fake create failure')
      }
      const handle = { agent: { id: input.sessionId, status: 'idle' } }
      handles.set(input.sessionId, handle)
      return handle
    },
    async getSession(id) {
      calls.push({ type: 'get', id })
      if (!state.alive || !handles.has(id)) return null
      return { handle: handles.get(id), running: state.running }
    },
    async reopenSession(id) {
      calls.push({ type: 'reopen', id })
      if (state.reopenGate) await state.reopenGate
      if (!state.alive) return null
      return handles.get(id) ?? null
    },
    async followup(id, message, handle) {
      calls.push({ type: 'followup', id, message, handle })
      if (state.failFollowup > 0) {
        state.failFollowup -= 1
        throw new Error('fake followup failure')
      }
      if (state.autoConfirm) {
        engine.onEvent({ type: 'agent/inbox/claimed', data: { agent: { id }, message } })
      }
    },
    async cancel(id) {
      calls.push({ type: 'cancel', id })
    },
    async dispose(id) {
      calls.push({ type: 'dispose', id })
      handles.delete(id)
    },
    async resolveModel() {
      return state.model
    },
  }

  engine = createEngine({
    file,
    adapter,
    retryDelays: overrides.retryDelays ?? [0, 0, 0, 0, 0],
    maxRetries: overrides.maxRetries ?? 5,
    confirmTimeoutMs: overrides.confirmTimeoutMs ?? 20,
    wait: overrides.wait ?? (async () => {}),
    log: () => {},
  })

  const task = patch => createTask({ title: 'S1 test card', workspacePath: dir, ...patch }, { file })
  const reload = () => getTask(taskId, { file })
  let taskId = null
  const stage = id => buildView({ file }).cards.find(card => card.id === id)
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true })

  async function startConfirmed(id) {
    const run = await engine.startTask(id)
    await engine.whenIdle()
    return run
  }

  function turnEnd(sessionId, kind, extra = {}) {
    engine.onEvent({
      type: 'turn/end',
      data: { agent: { id: sessionId }, turn: 1, reason: { kind, ...extra } },
    })
  }

  function sessionOf(id) {
    const row = getTask(id, { file })
    return (row.assignments ?? []).filter(a => a && a.state !== 'ended').pop()?.sessionId ?? null
  }

  return {
    dir,
    file,
    engine,
    adapter,
    calls,
    handles,
    state,
    task,
    setTaskId: id => { taskId = id },
    reload,
    stage,
    cleanup,
    startConfirmed,
    turnEnd,
    sessionOf,
    ledgerNow,
    listEffects: () => listEffects({ file }),
    buildView: () => buildView({ file }),
  }
}
