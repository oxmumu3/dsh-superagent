// dsh-superagent turn capture — 一轮结束时再判断要不要记下什么（S3 第 4 阶段）。
//
// 默认关闭。切到 'turn' 后：
// - 只听用户自己的会话；执行会话（session-sa-*）和非用户来源一律跳过。
// - 一轮里用户说的话按会话缓冲，turn/end 时交给 judge（模型在接口后面）。
// - 输出三种：new（新事）、attach（补到某张卡上）、none；一轮可以出多件事。
// - 只写进待确认（pending），不直接建卡、不直接送留言。
// judge 在测试里换成合成实现；调用失败一律当没有，不打断会话。

import { addPending, listTasks, listPending } from './ledger.js'
import {
  INTERNAL_SESSION,
  agentIdOf,
  foreignOrigin,
  isSubagentSession,
  textOf,
  userAuthored,
  workspaceOf,
} from './capture.js'

const MAX_MESSAGES_PER_TURN = 20
const TERMINAL = ['done', 'canceled', 'archived']

const GREETING = /^(?:好的|ok|嗯|收到|谢谢|哈哈|行|可以)[。！!\s]*$/i

function normalizeItems(verdict, context) {
  const rows = Array.isArray(verdict?.items) ? verdict.items : Array.isArray(verdict) ? verdict : []
  const cards = new Map(context.cards.map(card => [card.id, card]))
  const items = []
  for (const raw of rows.slice(0, 10)) {
    if (!raw || typeof raw !== 'object') continue
    const kind = raw.kind
    if (kind === 'none') continue
    const text = String(raw.text ?? context.text).trim().slice(0, 400)
    const title = String(raw.title ?? '').trim().slice(0, 80) || text.slice(0, 80)
    if (!text) continue
    if (kind === 'new') {
      items.push({ kind, text, title })
      continue
    }
    if (kind === 'attach') {
      const taskId = String(raw.taskId ?? raw.suggestedTaskId ?? '')
      if (!taskId || !cards.has(taskId)) continue // 模型说的卡不在板上就丢掉
      items.push({ kind, text, title, suggestedTaskId: taskId })
    }
  }
  return items
}

export function createTurnCapture(options = {}) {
  const file = options.file
  const judge = typeof options.judge === 'function' ? options.judge : undefined
  const log = options.log ?? (() => {})
  const buffers = new Map()

  function note(payload) {
    const sessionId = agentIdOf(payload)
    if (!sessionId || INTERNAL_SESSION.test(sessionId)) return false
    if (isSubagentSession(payload)) return false
    if (!userAuthored(payload?.message)) return false
    if (foreignOrigin(payload)) return false
    const text = textOf(payload?.message)
    if (!text.trim()) return false
    const row = buffers.get(sessionId) ?? { texts: [], workspacePath: null }
    row.texts.push(text)
    if (row.texts.length > MAX_MESSAGES_PER_TURN) row.texts = row.texts.slice(-MAX_MESSAGES_PER_TURN)
    row.workspacePath = row.workspacePath ?? workspaceOf(payload)
    buffers.set(sessionId, row)
    return true
  }

  function sessionIdOf(event, session) {
    const raw = event?.data ?? event?.payload ?? {}
    const data = Array.isArray(raw) ? raw[0] ?? {} : raw
    const candidates = [
      session?.id,
      session?.header?.id,
      data?.sessionId,
      data?.agent?.id,
      data?.agent?.session?.header?.id,
      data?.session?.header?.id,
      data?.session?.id,
    ]
    for (const value of candidates) {
      if (typeof value === 'string' && value.length > 0) return value
    }
    return null
  }

  async function handle(event, session) {
    if (!event || event.type !== 'turn/end') return { judged: false }
    const sessionId = sessionIdOf(event, session)
    if (!sessionId) return { judged: false }
    const buffer = buffers.get(sessionId) ?? null
    buffers.delete(sessionId)
    if (INTERNAL_SESSION.test(sessionId)) return { judged: false, reason: 'internal-session' }
    if (isSubagentSession({ session })) return { judged: false, reason: 'subagent-session' }
    if (!buffer || buffer.texts.length === 0) return { judged: false, reason: 'no-user-text' }
    if (!judge) return { judged: false, reason: 'no-judge' }
    const text = buffer.texts.join('\n').trim()
    if (!text || GREETING.test(text)) return { judged: false, reason: 'greeting' }

    const tasks = listTasks({}, { file }).tasks
      .filter(task => !TERMINAL.includes(task.status))
      .map(task => ({ id: task.id, title: task.title }))
    let verdict = null
    try {
      verdict = await judge({ texts: buffer.texts.slice(), text, workspacePath: buffer.workspacePath, cards: tasks })
    } catch (error) {
      log(`turn judge failed: ${error instanceof Error ? error.message : String(error)}`)
      return { judged: false, reason: 'judge-failed' }
    }
    const items = normalizeItems(verdict, { text, cards: tasks })
    const pending = []
    const existing = new Set(listPending({ file }).pending.map(row => String(row.text ?? '').trim()))
    for (const item of items) {
      if (existing.has(item.text)) continue // 同一句话不重复记
      const row = addPending({
        text: item.text,
        title: item.title,
        sessionId,
        workspacePath: buffer.workspacePath,
        by: 'turn',
        ...(item.suggestedTaskId ? { suggestedTaskId: item.suggestedTaskId } : {}),
      }, { file })
      pending.push(row)
      existing.add(item.text)
    }
    return { judged: true, items, pending }
  }

  function install(ctx) {
    const disposers = []
    const subscribe = (name, handler) => {
      try {
        const off = ctx?.on?.(name, handler)
        if (typeof off === 'function') disposers.push(off)
      } catch {
        // 一个事件名不存在不影响其它订阅。
      }
    }
    subscribe('agent/inbox/claimed', payload => {
      try {
        note(payload)
      } catch {
        // 缓冲失败不能影响会话。
      }
    })
    subscribe('session/event', (session, event) => {
      const current = event && typeof event.type === 'string' ? event : session
      if (!current || current.type !== 'turn/end') return
      void handle(current, session).catch(error => log(`turn capture failed: ${error instanceof Error ? error.message : String(error)}`))
    })
    return () => {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* already gone */ }
      }
      buffers.clear()
    }
  }

  return {
    note,
    handle,
    install,
    get buffers() { return buffers },
  }
}

export function installTurnCapture(ctx, options = {}) {
  const capture = createTurnCapture(options)
  const dispose = capture.install(ctx)
  dispose.capture = capture
  return dispose
}
