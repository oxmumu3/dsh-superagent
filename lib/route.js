// dsh-superagent routes — the panel's data endpoint and the user's actions.
//
// The client half is a plain browser bundle with no direct access to the host
// services, so it reads JSON snapshots over HTTP. POST /api/superagent/action
// is the only path a person can use to start, answer, reject or accept a card.
// `accept` is deliberately not exposed as an agent tool: only the route (the
// user's click) may move a card to done.

import { buildCardDetail, buildView } from './viewmodel.js'
import { getTask, listEffects, readRouter, updateRouter } from './ledger.js'
import { validateWorkspacePath, workspaceFromText } from './workspace.js'

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}

// 用引擎同一份台账算视图；测试里台账文件是临时的，不能退回环境默认路径。
function viewOf(engine) {
  return buildView(engine?.ledgerOptions?.() ?? {})
}

function optionsOf(engine) {
  return engine?.ledgerOptions?.() ?? {}
}

function connectionOf(ctx) {
  try {
    return ctx.get('connection')
  } catch {
    return null
  }
}

function resolveCreatedWorkspace(engine, body, text) {
  const selected = body.workspacePath
  // 用户明确选过（包括「先不定」）就以选择为准，绝不再从句子或默认值推断。
  if (body.workspaceExplicit === true) {
    return selected === null || selected === undefined || String(selected).trim() === ''
      ? null
      : validateWorkspacePath(selected)
  }
  // 没有明确选择时，句子里的有效目录优先于输入框预填的最近目录。
  const fromText = workspaceFromText(text)
  if (fromText) return fromText
  if (selected !== undefined && selected !== null && String(selected).trim() !== '') {
    return validateWorkspacePath(selected)
  }
  return null
}

export async function handleAction(engine, body = {}) {
  if (!engine || typeof engine.startTask !== 'function') throw new Error('执行引擎还没接上宿主')
  const action = String(body.action ?? '')
  const id = body.id === undefined ? '' : String(body.id)
  const text = body.text === undefined ? '' : String(body.text)
  const ifVersion = body.version === undefined ? undefined : Number(body.version)

  if (action === 'create') {
    if (!text.trim()) throw new Error('create 需要 text')
    const workspacePath = resolveCreatedWorkspace(engine, body, text)
    return { task: engine.createCard(text, { workspacePath }) }
  }
  // S3：Router 的档位与上限只从面板/用户动作改，不需要卡片 id。
  if (action === 'router_mode') {
    const mode = String(text ?? '').trim()
    updateRouter({ mode }, optionsOf(engine))
    return { router: readRouter(optionsOf(engine).file) }
  }
  if (action === 'router_limit') {
    const limit = Number(String(text ?? '').trim())
    updateRouter({ maxRunning: limit }, optionsOf(engine))
    return { router: readRouter(optionsOf(engine).file) }
  }
  if (!id) throw new Error(`${action || 'action'} 需要卡片 id`)

  switch (action) {
    case 'start': {
      const cwd = body.cwd === undefined ? undefined : body.cwd
      return engine.startTask(id, { ifVersion, cwd })
    }
    case 'retry':
      return engine.retryTask(id, { ifVersion })
    case 'answer':
      if (!text.trim()) throw new Error('answer 需要 text')
      return engine.answerTask(id, text, { ifVersion })
    case 'comment':
      if (!text.trim()) throw new Error('comment 需要 text')
      return engine.commentTask(id, text, { ifVersion })
    case 'reject':
      if (!text.trim()) throw new Error('打回要写一句原因')
      return engine.rejectTask(id, text, { ifVersion })
    case 'accept':
      return { task: await engine.acceptTask(id, { ifVersion }) }
    case 'later':
      return { task: engine.laterTask(id, { ifVersion }) }
    case 'nod':
      return { task: engine.confirmNod(id, { ifVersion }) }
    case 'cancel':
      return { task: await engine.cancelTask(id, { ifVersion }) }
    case 'queue':
      return { task: engine.queueTask(id, { ifVersion }) }
    case 'workspace':
      return {
        task: engine.setWorkspace(id, body.workspacePath === undefined ? null : body.workspacePath, { ifVersion }),
      }
    case 'pending_accept':
      return { task: engine.acceptPending(body.pendingId === undefined ? id : String(body.pendingId), { title: text }) }
    case 'pending_attach': {
      const pendingId = body.pendingId === undefined ? id : String(body.pendingId)
      return engine.attachPending(pendingId, {
        ifVersion,
        ...(body.taskId === undefined ? {} : { taskId: String(body.taskId) }),
      })
    }
    case 'pending_dismiss':
      return { removed: engine.dismissPending(body.pendingId === undefined ? id : String(body.pendingId)) }
    default:
      throw new Error(`未知动作：${action || '(空)'}`)
  }
}

export function registerViewRoute(ctx, options = {}) {
  const connection = connectionOf(ctx)
  if (!connection || typeof connection.fetch?.register !== 'function') return null

  const unregister = connection.fetch.register({
    path: '/api/superagent/view',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      try {
        return json(viewOf(options.engine))
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  })
  return typeof unregister === 'function' ? unregister : null
}

// 详情抽屉用：只读一张卡，带上报告、留言和派工记录。
export function registerCardRoute(ctx, options = {}) {
  const connection = connectionOf(ctx)
  if (!connection || typeof connection.fetch?.register !== 'function') return null

  const unregister = connection.fetch.register({
    path: '/api/superagent/card',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const url = new URL(request.url ?? '', 'http://localhost')
        const id = url.searchParams.get('id') ?? ''
        if (!id) return json({ error: 'card 需要 id' }, 400)
        let task
        try {
          task = getTask(id, optionsOf(options.engine))
        } catch {
          return json({ error: `卡片不存在：${id}` }, 404)
        }
        return json({
          card: buildCardDetail(task, { effects: listEffects(optionsOf(options.engine)) }),
        })
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500)
      }
    },
  })
  return typeof unregister === 'function' ? unregister : null
}

export function registerActionRoute(ctx, options = {}) {
  const connection = connectionOf(ctx)
  if (!connection || typeof connection.fetch?.register !== 'function') return null

  const unregister = connection.fetch.register({
    path: '/api/superagent/action',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        let body
        try {
          body = await request.json()
        } catch {
          throw new Error('请求体必须是 JSON')
        }
        if (!body || typeof body !== 'object') throw new Error('请求体必须是 JSON 对象')
        const result = await handleAction(options.engine, body)
        return json({ ...viewOf(options.engine), result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 版本冲突不是「请求写错了」：回读最新视图，让面板能刷新后重试。
        if (error?.name === 'VersionConflict') {
          return json({ ...viewOf(options.engine), error: message, conflict: true }, 409)
        }
        return json({ error: message, ...(error?.needWorkspace ? { needWorkspace: true } : {}) }, 400)
      }
    },
  })
  return typeof unregister === 'function' ? unregister : null
}

export function registerRoutes(ctx, options = {}) {
  const disposers = [
    registerViewRoute(ctx, options),
    registerActionRoute(ctx, options),
    registerCardRoute(ctx, options),
  ].filter(disposer => typeof disposer === 'function')
  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* already gone */ }
    }
  }
}
