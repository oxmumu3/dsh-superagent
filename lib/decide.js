// S5 对话决定：只接受「行首编号 + 紧跟动作」的明确命令。模型只转达；
// 程序用可信 binding 里的用户原话核对，核对过才走面板同一动作函数。
//
// 真实微信/桌面通路尚未开放：没有可信 binding 时一律拒绝。合成 authority
// 只用于合同测试，不把它当生产授权。

import { readLedger, readRouter, writeLedger } from './ledger.js'
import { INTERNAL_SESSION } from './capture.js'
import { readNotify } from './notify.js'
import { handleAction } from './route.js'
import { stageOf } from './viewmodel.js'

export const DECISIONS = ['accept', 'reject', 'answer', 'nod', 'dep_clear', 'retry', 'later', 'cancel']
export const DECISION_STAGES = {
  accept: ['review'],
  reject: ['review', 'silent'],
  answer: ['question'],
  nod: ['nod'],
  dep_clear: ['dep'],
  retry: ['not_started', 'not_delivered', 'stuck'],
  later: ['question', 'review', 'nod', 'approval', 'dep', 'not_started', 'not_delivered', 'stuck', 'silent'],
  cancel: ['question', 'review', 'nod', 'approval', 'dep', 'not_started', 'not_delivered', 'stuck', 'silent'],
}
// 长词优先，避免「可以了」被「可以」之类截断。
const COMMANDS = [
  { decision: 'accept', words: ['可以了', '没问题', '验收', '通过'] },
  { decision: 'reject', words: ['打回', '重做', '返工', '不行'] },
  { decision: 'nod', words: ['可以做', '同意', '批准'] },
  { decision: 'dep_clear', words: ['照做', '不等了'] },
  { decision: 'retry', words: ['重试', '再来'] },
  { decision: 'later', words: ['以后', '先放'] },
  { decision: 'cancel', words: ['不做', '取消'] },
]
const UNCERTAIN = /[?？「」“”"'‘’]|吗|呢|如果|假如|要是|万一|历史|记录|显示|写了|说过|说|问|为什么|怎么|是否|能不能|可不可以|下一步|可能|大概/u
// 编号从 A1..Z9 之后接 A10..，必须整段识别多位数，不能把 A10 截成 A1。
const CODE_RE = /(?:^|[^A-Za-z0-9])([A-Za-z][0-9]+)(?![A-Za-z0-9])/g

export function sessionIdOfExec(exec) {
  for (const value of [exec?.sessionId, exec?.agentId, exec?.agent?.id, exec?.session?.header?.id, exec?.session?.id]) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function codesIn(text) {
  const found = []
  CODE_RE.lastIndex = 0
  let match
  while ((match = CODE_RE.exec(text))) found.push(match[1].toUpperCase())
  return [...new Set(found)]
}

function cleanTail(value) {
  return String(value ?? '')
    .replace(/^[\s，,：:。.!！]+/u, '')
    .replace(/[\s。.!！]+$/u, '')
    .trim()
}

// 只认单行、行首编号、紧跟动作。六个反例（转述、历史、问句、条件、
// 取消否定、间接询问）都会在这里被拒。
export function parseDecisionText(text, decision, activeNotices) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, reason: '这一轮没有用户原话' }
  const lines = raw.split('\n').map(row => row.trim()).filter(Boolean)
  if (lines.length !== 1) return { ok: false, reason: '只接受一行明确的命令' }
  const line = lines[0]
  if (UNCERTAIN.test(line)) return { ok: false, reason: '这句话不是明确命令（问句/条件/转述/引号）' }
  const codes = codesIn(line)
  if (codes.length > 1) return { ok: false, reason: '这句话里有不止一个编号' }
  const code = codes[0] ?? null
  let rest
  if (code) {
    const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`^${escaped}(?![A-Za-z0-9])\\s*[，,:：]?\\s*(.*)$`, 'i').exec(line)
    if (!match) return { ok: false, reason: '编号不在这一行开头，或者后面没有紧跟命令' }
    rest = match[1].trim()
  } else {
    if (activeNotices.length !== 1) return { ok: false, reason: '这句话没有编号，而且现在不止一件事等你' }
    rest = line
  }

  let matched = null
  for (const command of COMMANDS) {
    const word = command.words.find(item => rest.startsWith(item))
    if (!word) continue
    matched = { decision: command.decision, word, tail: cleanTail(rest.slice(word.length)) }
    break
  }
  // 无编号的 answer 必须有显式「回答：」前缀，避免把任意一句话当回答。
  if (!matched && decision === 'answer') {
    if (code) {
      if (!rest) return { ok: false, reason: '回答是空的' }
      matched = { decision: 'answer', word: '', tail: rest }
    } else {
      const explicit = /^(?:回答|答)\s*[:：]\s*(.+)$/u.exec(rest)
      if (explicit) matched = { decision: 'answer', word: '', tail: cleanTail(explicit[1]) }
    }
  }
  if (!matched) return { ok: false, reason: '没有以明确的动作开头' }
  if (decision !== matched.decision) return { ok: false, reason: '模型说的决定和用户原话对不上' }
  if (matched.decision === 'reject' && !matched.tail) return { ok: false, reason: '打回没有说理由' }
  if (matched.decision === 'answer' && !matched.tail) return { ok: false, reason: '回答是空的' }
  if (matched.tail && /^[不别]/u.test(matched.tail) && matched.decision !== 'cancel' && matched.decision !== 'reject') {
    return { ok: false, reason: '命令后面跟着否定' }
  }
  return { ok: true, code, command: matched.decision, word: matched.word, tail: matched.tail }
}

// S6-B：只有本轮当前用户原话在拒绝理由末尾独立说「以后都这样 / 以后都按这个」
// 才把干净理由落成项目规矩。模型参数、否定、转述、旧轮都不构成授权。
const REMEMBER_RE = /(?:^|[，,；;])\s*(以后都这样|以后都按这个)\s*[。.!！]?$/u
function rejectRemember(tail) {
  const text = String(tail ?? '').trim()
  const match = REMEMBER_RE.exec(text)
  if (!match) return { text, remember: false }
  const reason = text.slice(0, match.index).replace(/[，,；;。.!！\s]+$/u, '').trim()
  if (!reason) return { text, remember: false }
  // 「但不要以后都按这个」前面是否定，不能算同意。
  if (/(?:不|别|不要|不用|不必)\s*$/u.test(reason)) return { text, remember: false }
  return { text: reason, remember: true }
}

function audit(notice, entry, file) {
  if (!notice) return
  const ledger = readLedger(file)
  const row = (ledger.notices ?? []).find(item => item.id === notice.id)
  if (!row) return
  row.audit = [...(row.audit ?? []), entry].slice(-20)
  ledger.revision = (ledger.revision ?? 0) + 1
  writeLedger(ledger, file)
}

function fail(message, notice, decision, file, code = 'refused') {
  audit(notice, { at: Date.now(), decision: decision ?? null, passed: false, reason: code }, file)
  return { ok: false, refused: true, error: message }
}

// 同一会话同一轮只允许落一次；并行 callId、重开旧号、无号重放都挡住。
function claimTurn(file, binding, notice, decision) {
  const ledger = readLedger(file)
  const turns = ledger.decisionTurns && typeof ledger.decisionTurns === 'object' ? ledger.decisionTurns : {}
  for (const [key, row] of Object.entries(turns)) {
    if (!row || Date.now() - Number(row.at ?? 0) > 24 * 60 * 60_000) delete turns[key]
  }
  const key = `${binding.sessionId}:${binding.turnId}`
  if (turns[key]) return { ok: false }
  turns[key] = {
    at: Date.now(), sessionId: binding.sessionId, turnId: binding.turnId,
    callId: binding.callId, noticeId: notice.id, taskId: notice.taskId,
    decision, state: 'claimed',
  }
  ledger.decisionTurns = turns
  ledger.revision = (ledger.revision ?? 0) + 1
  writeLedger(ledger, file)
  return { ok: true }
}

function finishTurn(file, binding, notice, decision, result) {
  const ledger = readLedger(file)
  const key = `${binding.sessionId}:${binding.turnId}`
  const row = ledger.decisionTurns?.[key]
  if (row) {
    row.state = result.ok ? 'applied' : 'failed'
    row.taskId = result.taskId ?? row.taskId
    row.noticeId = notice.id
    ledger.revision = (ledger.revision ?? 0) + 1
    writeLedger(ledger, file)
  }
}

function validBinding(binding, exec) {
  if (!binding || typeof binding !== 'object') return '没有可信的当前轮绑定，没有执行。'
  if (binding.trusted !== true || binding.activeCall !== true) return '没有可信的当前轮与真实工具调用，没有执行。'
  if (binding.sourceKind !== 'user') return '这一轮没有用户来源的原话，没有执行。'
  const execSession = sessionIdOfExec(exec)
  if (!execSession || binding.sessionId !== execSession) return '拿不到与调用一致的会话，没有执行。'
  if (INTERNAL_SESSION.test(execSession) || execSession.startsWith('family_member_') || execSession.startsWith('session-sa-')) {
    return '执行会话或内部会话不能替用户做决定，没有执行。'
  }
  if (typeof binding.callId !== 'string' || !binding.callId) return '拿不到当前工具调用编号，没有执行。'
  if (exec?.callId !== undefined && binding.callId !== exec.callId) return '工具调用编号对不上，没有执行。'
  if (!Number.isSafeInteger(binding.turnId) || binding.turnId < 1) return '拿不到当前轮编号，没有执行。'
  if (typeof binding.userText !== 'string' || !binding.userText.trim()) return '这一轮没有用户原话，没有执行。'
  if (binding.userText.includes('当前 Owner 请求原文：') || binding.userText.includes('这个会话就是主人本人的原生会话')) {
    return '来源带着无法可信拆分的外部包装，没有执行。'
  }
  return null
}

export async function decide(engine, args = {}, exec = {}, options = {}) {
  const file = options.file ?? engine?.ledgerOptions?.().file
  const requested = String(args.decision ?? '')
  if (!DECISIONS.includes(requested)) return { ok: false, refused: true, error: `不认识的决定：${requested || '(空)'}` }
  if (typeof options.authority !== 'function') {
    return { ok: false, refused: true, error: '这个宿主没有可信的当前轮绑定，没有执行。桌面/微信的真实回复通路尚未开放。' }
  }
  let binding
  try {
    binding = await options.authority({ args, exec, engine })
  } catch (error) {
    return { ok: false, refused: true, error: `拿不到可信的当前轮绑定：${error instanceof Error ? error.message : String(error)}` }
  }
  const invalid = validBinding(binding, exec)
  if (invalid) return { ok: false, refused: true, error: invalid }

  const { notices } = readNotify(file)
  const active = notices.filter(row => row.state !== 'closed')
  const parsed = parseDecisionText(binding.userText, requested, active)
  if (!parsed.ok) {
    // 能唯一指向一条通知时才把审计挂上去。
    const hint = active.length === 1 ? active[0] : null
    return fail(parsed.reason, hint, requested, file, 'parse')
  }
  const notice = parsed.code ? active.find(row => row.code === parsed.code) : active[0]
  if (!notice) return fail(`没有找到还开着的编号 ${parsed.code}`, null, requested, file, 'stale-code')

  const ledger = readLedger(file)
  const task = (ledger.tasks ?? []).find(row => row.id === notice.taskId)
  if (!task) return fail('这张卡不在了，没有执行。', notice, requested, file, 'no-task')
  const router = readRouter(file)
  const stage = options.stageOf
    ? options.stageOf(task, ledger)
    : stageOf(task, {
      effects: ledger.effects ?? [], tasks: ledger.tasks, now: Date.now(),
      stuckMinutes: router.stuckMinutes, stuckEnabled: true,
    }).stage
  if (stage !== notice.stage || !DECISION_STAGES[requested].includes(notice.stage)) {
    return fail(`这张卡现在不是「${notice.stage}」阶段，这个决定不能执行。`, notice, requested, file, 'stage')
  }

  // 核对通过后、执行前，原子占住这一轮。同 turn 的第二个 callId（含并行）
  // 或重开后的旧调用都从这里被挡。
  const claimed = claimTurn(file, binding, notice, requested)
  if (!claimed.ok) return fail('这一轮已经执行过一个决定，不会再次执行。', notice, requested, file, 'replay')

  const payload = { action: requested, id: task.id, version: task.version }
  if (requested === 'reject') {
    const rejected = rejectRemember(parsed.tail)
    payload.text = rejected.text
    payload.remember = rejected.remember
  }
  if (requested === 'answer') payload.text = parsed.tail
  let result
  try {
    result = await handleAction(engine, payload)
  } catch (error) {
    finishTurn(file, binding, notice, requested, { ok: false })
    audit(notice, { at: Date.now(), decision: requested, passed: false, reason: 'action-failed' }, file)
    return { ok: false, refused: true, error: `决定没有落到卡上：${error instanceof Error ? error.message : String(error)}` }
  }

  const latest = readLedger(file)
  const row = (latest.notices ?? []).find(item => item.id === notice.id)
  if (row) {
    row.state = 'closed'
    row.closedAt = Date.now()
    row.decidedAt = Date.now()
    row.decision = requested
    row.audit = [...(row.audit ?? []), {
      at: Date.now(), decision: requested, passed: true,
      sessionId: binding.sessionId, callId: binding.callId, turnId: binding.turnId,
    }].slice(-20)
    latest.revision = (latest.revision ?? 0) + 1
    writeLedger(latest, file)
  }
  finishTurn(file, binding, notice, requested, { ok: true, taskId: task.id })
  const title = result?.task?.title ?? task.title
  const messages = {
    accept: `已验收：${title}`,
    reject: `已打回：${title}（${payload.text}）`,
    answer: `已回答：${title}`,
    nod: `已点头：${title}`,
    dep_clear: `已让它照做：${title}`,
    retry: `已重试：${title}`,
    later: `已先放：${title}`,
    cancel: `已取消：${title}`,
  }
  return { ok: true, decision: requested, taskId: task.id, title, message: messages[requested] }
}
