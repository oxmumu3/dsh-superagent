// dsh-superagent host bridge — the only file that knows the live host API.
//
// S1 step 0 (shared window) verifies five contracts on the official desktop:
// agents.create vs agents.createAgent, the shape of session/event, the claimed
// message id, the panel POST, and approval events. Until that run, this file
// tries the two known entry points and keeps the uncertainty visible in the
// report; identity and recovery rules stay in lib/engine.js, which is fully
// covered by simulated tests.
//
// Approval events are observed only. This file never answers an approval and
// never calls approval/request.

function unwrap(handle) {
  return handle?.agent ?? handle
}

function statusOf(handle) {
  const value = handle?.status ?? handle?.agent?.status
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof value.kind === 'string') return value.kind
  return undefined
}

function serviceOf(refs, name) {
  if (refs?.[name]) return refs[name]
  try {
    return refs?.ctx?.get?.(name, false) ?? refs?.ctx?.[name] ?? null
  } catch {
    return null
  }
}

export function createHostAdapter(refs, log = () => {}) {
  const handles = new Map()

  // 0.2.2-rc.1 的 session controller 用 resolveAgent() 返回 { agent } 或 { error }。
  // { error } 不是句柄；拿不到就按会话不在处理。
  async function resolveAgentWithHost(sessionId) {
    const controller = serviceOf(refs, 'sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') return undefined
    let found
    try {
      found = await controller.resolveAgent(sessionId)
    } catch (error) {
      log(`sessionController.resolveAgent failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
    if (!found || typeof found !== 'object') return null
    if ('error' in found) return null
    if (found.agent) return found.agent
    if (typeof found.id === 'string') return found
    return null
  }

  async function getHandle(sessionId) {
    if (handles.has(sessionId)) return handles.get(sessionId)
    const resolved = await resolveAgentWithHost(sessionId)
    if (resolved !== undefined) {
      if (!resolved) return null
      handles.set(sessionId, resolved)
      return resolved
    }
    const agents = refs.agents
    if (!agents || typeof agents.get !== 'function') return null
    let handle
    try {
      handle = await agents.get(sessionId)
    } catch {
      return null
    }
    if (!handle) return null
    handles.set(sessionId, handle)
    return handle
  }

  return {
    ready() {
      return Boolean(refs.agents)
    },

    async createSession({ sessionId, cwd, provider, model, reasoningEffort }) {
      const agents = refs.agents
      if (!agents) throw new Error('宿主 agents 服务还没有就绪')
      // 0.2.2-rc.2 的 web 宿主在 agents.create 里同时做两件事：meta 记默认
      // agentPreset，setup 里 mount 同一个 preset（见官方 session-controller
      // 与已验证的 proactive composeAgent）。少了 mount，子会话只有宿主平面
      // 工具，write/sa_report 之类会「unknown tool」。这里只复刻 mount，
      // 不调用 permissionPresets.apply，不代答审批，也不扩大权限。
      const presets = serviceOf(refs, 'agentPresets')
      const canMount = Boolean(presets && typeof presets.mount === 'function' && typeof presets.defaultId === 'string')
      const meta = {
        ...(cwd ? { cwd } : {}),
        ...(canMount ? { agentPreset: presets.defaultId } : {}),
      }
      const payload = {
        sessionId,
        ...(Object.keys(meta).length ? { meta } : {}),
        agentOptions: {
          provider,
          model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
        ...(canMount ? {
          setup: async (agentCtx, agent) => {
            const presetId = agent?.session?.header?.agentPreset ?? agent?.header?.agentPreset ?? presets.defaultId
            await presets.mount(agentCtx, presetId)
          },
        } : {}),
      }
      let handle
      // 0.1.5 的探针用 agents.create；Dot 的 0.2.2 探针用 agents.createAgent。
      // 两个都试，任一跑通即可；两个都失败时把两边原因都带出去。
      const errors = []
      if (typeof agents.create === 'function') {
        try {
          handle = await agents.create(payload)
        } catch (error) {
          errors.push(`create: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (!handle && typeof agents.createAgent === 'function') {
        try {
          handle = await agents.createAgent(refs.ctx, payload)
        } catch (error) {
          errors.push(`createAgent: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (!handle && errors.length === 0) {
        throw new Error('宿主 agents 服务既没有 create() 也没有 createAgent()')
      }
      if (!handle && errors.length > 0) {
        throw new Error(`建会话失败：${errors.join(' | ')}`)
      }
      if (handle) handles.set(sessionId, handle)
      return handle
    },

    async getSession(sessionId) {
      const handle = await getHandle(sessionId)
      if (!handle) return null
      return { handle, running: statusOf(handle) === 'running' ? true : statusOf(handle) === 'idle' ? false : undefined }
    },

    async reopenSession(sessionId) {
      return getHandle(sessionId)
    },

    async followup(sessionId, message, handle) {
      const target = unwrap(handle ?? await getHandle(sessionId))
      if (!target || typeof target.followup !== 'function') throw new Error('会话句柄上没有 followup()')
      await target.followup(message)
    },

    async cancel(sessionId) {
      const handle = await getHandle(sessionId)
      const agent = unwrap(handle)
      if (agent && typeof agent.cancel === 'function') {
        // 0.2.2-rc.1 要求有效 cause（原生控制器传 { kind: 'user' }）。
        // 不传 keepInbox：我们的排队动作已在台账里退役，宿主应一并丢弃，
        // 避免取消后又被旧消息唤醒。
        await agent.cancel({ kind: 'user' })
      } else if (agent && typeof agent.abort === 'function') {
        await agent.abort()
      } else if (handle && typeof handle.cancel === 'function') {
        await handle.cancel({ kind: 'user' })
      }
    },

    async dispose(sessionId, handle) {
      const target = handle ?? await getHandle(sessionId)
      const fn = typeof target?.dispose === 'function'
        ? target.dispose.bind(target)
        : typeof target?.agent?.dispose === 'function' ? target.agent.dispose.bind(target.agent) : null
      if (fn) await fn()
      handles.delete(sessionId)
    },

    async resolveModel() {
      // 0.2.2-rc.1 的默认模型服务是 agentDefaultModel；currentSelection()
      // 返回 detached 选择，只读，不调用会保存全局的 selectModel/saveSelection。
      const service = serviceOf(refs, 'agentDefaultModel')
      if (service && typeof service.currentSelection === 'function') {
        try {
          const selected = await service.currentSelection()
          if (selected?.provider && selected?.model) {
            return {
              provider: selected.provider,
              model: selected.model,
              ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
            }
          }
        } catch (error) {
          log(`agentDefaultModel.currentSelection failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (refs.model?.provider && refs.model?.model) return refs.model
      return null
    },
  }
}

export function installSessionEvents(ctx, engine) {
  const disposers = []
  const subscribe = (name, handler) => {
    try {
      const off = ctx.on?.(name, handler)
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      // 一个事件名不存在不应影响其它订阅。
      void error
    }
  }

  subscribe('session/event', (session, event) => {
    if (event && typeof event.type === 'string') engine.onEvent(event, session)
    else if (session && typeof session.type === 'string') engine.onEvent(session)
  })
  // 0.2.2-rc.1 由 Cordis 单独 emit agent/inbox/claimed，消息不在
  // session/event 的 persisted splice 里；照 S0 capture.js 的订阅方式补上。
  subscribe('agent/inbox/claimed', payload => {
    if (!payload || typeof payload !== 'object') return
    engine.onEvent({ type: 'agent/inbox/claimed', data: payload })
  })
  // 审批只观察，不拦截、不代答。
  subscribe('approval/asked', payload => engine.onEvent({ type: 'approval/asked', data: payload }))
  subscribe('approval/decided', payload => engine.onEvent({ type: 'approval/decided', data: payload }))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* already gone */ }
    }
  }
}
