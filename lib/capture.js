// dsh-superagent capture — turn an explicit "remember this" instruction into a
// card.
//
// Public preview default (capture.mode = 'explicit'):
//   - only an imperative to record something counts ("记一下…", "放到待办…");
//   - the line must come from the person themselves (message.source.kind ===
//     'user'); unknown, plugin and executor sources are skipped;
//   - quoted text, forwarded excerpts and self-narration ("这个要做") never
//     create a card; the person can still add one from the panel.
//   - no model call and no pending row.
// The older two-level path (rule fast path + tiny LLM judgement → pending) is
// kept only for an explicit non-default opt-in; see lib/ledger.js readCapture.
// Dedupe: same normalized text inside 30 minutes is ignored.

import { createTask, listTasks, addPending, listPending } from './ledger.js'

const MINUTE = 60_000
const DEDUPE_WINDOW = 30 * MINUTE
const seen = new Map()

// Explicit instructions only: an imperative at the start of the line, a
// delimiter, then a non-empty item. No "looks like a task" guessing, no
// mid-sentence mentions, no questions. Examples that count:
//   「帮我记一下：明天交报告」
//   「放到待办：核对示例文件」
// Examples that do not: 「不要记一下，明天开会」
//   「如果我说记一下，之后会怎么样？」「帮我记一下可以怎么翻译」
const EXPLICIT = [
  /^\s*(?:帮我|麻烦|请)?(?:记下来|记一下|记一笔|记录一下|记个|记下)\s*[:：]\s*\S/,
  /^\s*(?:帮我|麻烦|请)?(?:把[^:：]{0,20})?(?:加入|放进|放到|落到|写进)(?:待办|看板|任务|清单)\s*[:：]\s*\S/,
]

// Lines carrying somebody else's words are not the person's own instruction.
const QUOTE_INTRO = /^\s*(?:他说|她说|它说|有人说|据说|引用|原文|摘自|转自|摘自于|邮件里|对方说|客户说|同事说)[:：]?/

const QUOTE_PAIRS = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['‘', '’'],
  ['"', '"'],
]

// Executor sessions are our own children; never capture from them.
// A5: 探针 8 回来之前，先把家人会话排掉（family_member_ 开头）。
export const INTERNAL_SESSION = /^session-sa-|^session-taskboard-|^dsh_dot_|family_member_/
const GREETING = /^(?:好的|ok|嗯|收到|谢谢|哈哈|行|可以)[。！!\s]*$/i

// S4 3.2：会话的 meta 带 parentSession 或 origin=subagent 时是宿主子智能体，
// 它说的话不是用户说的，规则和模型两条路都跳过。
export function sessionHeaderOf(source) {
  const candidates = [
    source?.agent?.session?.header,
    source?.agent?.header,
    source?.session?.header,
    source?.header,
    source?.session,
  ]
  for (const value of candidates) {
    if (value && typeof value === 'object' && (value.parentSession || value.origin || value.id)) return value
  }
  return null
}

export function isSubagentSession(source) {
  const header = sessionHeaderOf(source)
  return Boolean(header && (header.parentSession || header.origin === 'subagent'))
}

// Skip unknown, plugin, and model sources before reading any message text.
export function userAuthored(message) {
  const source = message && typeof message === 'object' ? message.source : undefined
  if (!source || typeof source !== 'object') return false
  return source.kind === 'user'
}

// A plugin can send a message that looks user-authored (`source.kind === 'user'`)
// while the session is an automated child: DSH Dot's executor does exactly that
// for `dsh_dot_<uuid>` sessions. Skip it when the payload exposes a verifiable
// parent/origin; unknown stays a plain user message.
const FOREIGN_ORIGIN = /subagent|^session-sa-|^dsh_dot-/i

function originOf(payload) {
  const header = payload?.agent?.session?.header ?? payload?.session?.header ?? payload?.agent?.header ?? null
  const candidates = [
    payload?.origin,
    payload?.message?.origin,
    payload?.agent?.origin,
    header?.origin,
    payload?.session?.origin,
    payload?.parentSession,
    payload?.parentSessionId,
    payload?.agent?.parentSession,
    payload?.agent?.parentSessionId,
    header?.parentSession,
    header?.parentSessionId,
    payload?.session?.parentSession,
    payload?.session?.parentSessionId,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object' && typeof value.kind === 'string') return value.kind
  }
  return null
}

export function foreignOrigin(payload) {
  const origin = originOf(payload)
  return typeof origin === 'string' && FOREIGN_ORIGIN.test(origin)
}

// True when index sits inside quotation marks or on a markdown blockquote line.
export function insideQuote(text, index) {
  const value = String(text ?? '')
  const lineStart = value.lastIndexOf('\n', Math.max(0, index - 1)) + 1
  if (/^\s*>/.test(value.slice(lineStart, index + 1))) return true
  for (const [open, close] of QUOTE_PAIRS) {
    let cursor = 0
    let inside = false
    while (cursor < value.length) {
      const nextOpen = value.indexOf(open, cursor)
      if (nextOpen < 0 || nextOpen > index) break
      if (!inside) {
        inside = true
        cursor = nextOpen + open.length
        continue
      }
      const nextClose = value.indexOf(close, cursor)
      if (nextClose < 0) break
      if (nextClose < index) {
        inside = false
        cursor = nextClose + close.length
        continue
      }
      break
    }
    if (inside) return true
  }
  return false
}

export function isQuestion(text) {
  return /[?？]\s*$/.test(String(text ?? ''))
}

export function shouldCapture(text) {
  const value = String(text ?? '').trim()
  if (!plausible(value)) return false
  if (QUOTE_INTRO.test(value)) return false
  if (isQuestion(value)) return false
  if (value.includes('```') || value.includes('~~~')) return false
  const match = EXPLICIT.map(re => re.exec(value)).find(Boolean)
  if (!match) return false
  return !insideQuote(value, match.index)
}

// Cheap gate before paying for a model call at all.
function plausible(text) {
  const value = String(text ?? '').trim()
  if (value.length < 8 || value.length > 400) return false
  if (GREETING.test(value)) return false
  return true
}

function topicKey(text) {
  return String(text)
    .toLowerCase()
    .replace(/[，。！？、,!.?\s]/g, '')
    .slice(0, 40)
}

function recentDuplicate(text, now) {
  const key = topicKey(text)
  const hit = seen.get(key)
  if (hit !== undefined && now - hit < DEDUPE_WINDOW) return true
  seen.set(key, now)
  return false
}

function recentBoardDuplicate(text, now) {
  const key = topicKey(text)
  try {
    return listTasks({ limit: 100 }, {}).tasks.some(
      t => topicKey(t.title) === key && now - (t.createdAt ?? 0) < DEDUPE_WINDOW,
    )
  } catch {
    return false
  }
}

export function textOf(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  return parts
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
}

export function titleFrom(text) {
  return String(text ?? '')
    .trim()
    .replace(/^\s*(?:帮我|麻烦|请)?(?:记下来|记一下|记一笔|记录一下|记个|记下)\s*[:：,，\s]*/u, '')
    .replace(/^\s*(?:帮我|麻烦|请)?(?:把[^:：]{0,20})?(?:加入|放进|放到|落到|写进)(?:待办|看板|任务|清单)\s*[:：,，\s]*/u, '')
    .trim()
    .slice(0, 80)
}

// 规则路径：明确说了「记一下」这类话，直接建卡，并记下来源会话、工作区与目录。
function commitCard(text, title, onCaptured, sessionId, workspaceId, workspacePath) {
  const now = Date.now()
  if (recentDuplicate(text, now)) return
  if (recentBoardDuplicate(text, now)) return
  try {
    const task = createTask({
      title: title || titleFrom(text) || text.slice(0, 80),
      description: text,
      urgency: 'normal',
      workspaceId,
      workspacePath,
      sourceSessionId: sessionId,
      by: 'rule',
      // S3 0.1：用户明说「记一下」的卡进自动队列。
      queue: { auto: true, by: 'rule' },
    })
    onCaptured?.(task, sessionId, 'rule')
  } catch {
    // Capture must never break a turn.
  }
}

// 0.2.2-rc.1 的 session header 直接带 cwd；旧位置保留兼容。
// 取不到就不写，start 时会如实报错。
export function workspaceOf(payload) {
  const candidates = [
    payload?.session?.header?.cwd,
    payload?.agent?.session?.header?.cwd,
    payload?.agent?.header?.cwd,
    payload?.agent?.meta?.cwd,
    payload?.agent?.cwd,
    payload?.agent?.header?.meta?.cwd,
    payload?.session?.header?.meta?.cwd,
    payload?.session?.meta?.cwd,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

// claimed 的 agent 是 Agent 句柄；不同版本有的把身份放在 agent.session.header.id。
export function agentIdOf(payload) {
  const agent = payload?.agent
  const candidates = [
    agent?.id,
    agent?.session?.header?.id,
    agent?.session?.id,
    agent?.header?.id,
    payload?.session?.header?.id,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

// A4：模型判成「是任务」时不建卡，只记进 pending，记下原话、来源会话、工作区、时间。
function recordPending(text, title, onPending, sessionId, workspaceId, workspacePath) {
  const now = Date.now()
  if (recentDuplicate(text, now)) return
  try {
    // 台账里已有的同一句话不再记：内存去重会随宿主重启失效。
    const key = topicKey(text)
    if (listPending().pending.some(row => topicKey(row.text) === key)) return
    const row = addPending({
      text,
      title: title || titleFrom(text),
      sessionId,
      workspaceId,
      workspacePath,
      by: 'model',
    })
    onPending?.(row)
  } catch {
    // Same rule: capture never breaks a turn.
  }
}

export function installCapture(ctx, options = {}) {
  const onCaptured = options.onCaptured
  const onPending = options.onPending
  const workspaceId = options.workspaceId ?? null
  const judge = typeof options.judge === 'function' ? options.judge : undefined

  const handle = async payload => {
    const sessionId = agentIdOf(payload)
    if (!sessionId || INTERNAL_SESSION.test(sessionId)) return
    if (isSubagentSession(payload)) return
    if (!userAuthored(payload?.message)) return
    if (foreignOrigin(payload)) return
    const text = textOf(payload?.message)
    if (!text) return
    const workspacePath = workspaceOf(payload) ?? options.workspacePath ?? null

    if (shouldCapture(text)) {
      commitCard(text, titleFrom(text), onCaptured, sessionId, workspaceId, workspacePath)
      return
    }
    if (!judge || !plausible(text) || isQuestion(text)) return

    // Slow path: one tiny judgement. Failure is a no-op, never a throw.
    const verdict = await judge(text)
    if (verdict?.isTask) recordPending(text, String(verdict.title ?? ''), onPending, sessionId, workspaceId, workspacePath)
  }

  return ctx.on('agent/inbox/claimed', payload => {
    void handle(payload).catch(() => {})
  })
}
