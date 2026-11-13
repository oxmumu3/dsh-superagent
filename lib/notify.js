// S5 通知：卡进入「等你」时生成一条，合并/限频/安静时段后交给外部发送命令。
//
// 这里不读微信凭据、不调家庭助手、不经过 shell。发送命令只来自环境变量或
// 插件配置；默认关闭。通知和编号写台账，用户原话不落盘。

import { spawn } from 'node:child_process'
import {
  createEffect, readLedger, readRouter, writeLedger,
} from './ledger.js'
import { stageOf } from './viewmodel.js'

export const NOTIFY_STAGES = ['question', 'review', 'nod', 'approval', 'dep', 'not_started', 'not_delivered', 'stuck', 'silent']
const STAGE_TEXT = {
  question: ['要你回答', '回「{code} 你的回答」'],
  review: ['等你验收', '回「{code} 通过」或「{code} 打回 理由」'],
  nod: ['等你点头', '回「{code} 可以做」或「{code} 不做」'],
  approval: ['要你批准', '去会话里批'],
  dep: ['等你决定', '回「{code} 照做」或「{code} 不做」'],
  not_started: ['没派出去', '回「{code} 重试」'],
  not_delivered: ['没送到', '回「{code} 重试」'],
  stuck: ['卡住了', '回「{code} 重试」或「{code} 不做」'],
  silent: ['催过一次，还是没交结果', '回「{code} 打回 理由」或「{code} 不做」'],
}
const RETENTION = 7 * 24 * 60 * 60 * 1000
const BATCH_WAIT = 60 * 1000
const RETRY_DELAYS = [10_000, 60_000, 5 * 60_000]
const NOTICE_LIMIT = 5
const MESSAGE_LIMIT = 600

export function defaultNotify() {
  return { mode: 'off', quiet: { from: '23:00', to: '08:00' }, perHour: 6, updatedAt: 0 }
}

function cleanTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function normalizeQuiet(input) {
  if (input === null) return null
  if (!input || typeof input !== 'object') return defaultNotify().quiet
  const from = cleanTime(input.from)
  const to = cleanTime(input.to)
  return from && to ? { from, to } : defaultNotify().quiet
}

export function normalizeNotify(input) {
  const base = defaultNotify()
  if (!input || typeof input !== 'object') return base
  return {
    mode: input.mode === 'on' ? 'on' : 'off',
    quiet: normalizeQuiet(input.quiet),
    perHour: Number.isFinite(input.perHour) ? Math.max(1, Math.min(24, Math.floor(input.perHour))) : base.perHour,
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : 0,
  }
}

export function readNotify(file) {
  const ledger = readLedger(file)
  return { settings: normalizeNotify(ledger.notify), notices: Array.isArray(ledger.notices) ? ledger.notices : [] }
}

export function writeNotify(patch, options = {}) {
  const file = options.file
  const ledger = readLedger(file)
  const current = normalizeNotify(ledger.notify)
  const next = normalizeNotify({ ...current, ...patch, updatedAt: options.now ?? Date.now() })
  if (Number.isFinite(ledger.notify?.nextIndex)) next.nextIndex = ledger.notify.nextIndex
  ledger.notify = next
  ledger.revision = (ledger.revision ?? 0) + 1
  writeLedger(ledger, file)
  return next
}

export function sanitizeNotifyText(value) {
  return String(value ?? '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '***')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isQuietAt(now, quiet) {
  const q = normalizeQuiet(quiet)
  if (!q) return false
  const date = new Date(now)
  const minutes = date.getHours() * 60 + date.getMinutes()
  const toMinutes = value => {
    const [h, m] = value.split(':').map(Number)
    return h * 60 + m
  }
  const from = toMinutes(q.from)
  const to = toMinutes(q.to)
  if (from === to) return false
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

function codeFor(index) {
  if (index < 26 * 9) {
    const letter = String.fromCharCode(65 + Math.floor(index / 9))
    return `${letter}${(index % 9) + 1}`
  }
  // Z9 之后接 A10..Z10、A11..，编号单调向后，清理 closed 记录也不后退。
  const rest = index - 26 * 9
  const letter = String.fromCharCode(65 + (rest % 26))
  return `${letter}${10 + Math.floor(rest / 26)}`
}

// codeFor 的逆映射；旧台账没有 nextIndex 时，用它从存量短号恢复下一个号。
function codeIndex(code) {
  const match = /^([A-Z])(\d+)$/.exec(String(code ?? '').toUpperCase())
  if (!match) return -1
  const letter = match[1].charCodeAt(0) - 65
  const number = Number(match[2])
  if (!Number.isSafeInteger(number) || number < 1) return -1
  if (number <= 9) return letter * 9 + (number - 1)
  return 26 * 9 + (number - 10) * 26 + letter
}

// 存量里任何出现过的编号都不能再分配；缺 nextIndex 的旧台账在清理 closed
// 之前先恢复，避免 7 天后清掉记录又把历史号发给新卡。
function recoverNextIndex(notices, stored) {
  let next = Number.isFinite(stored) ? Math.max(0, Math.floor(stored)) : 0
  for (const row of notices) {
    const index = codeIndex(row?.code)
    if (index >= next) next = index + 1
  }
  return next
}

function allocCode(notices, start = 0) {
  const used = new Set(notices.map(row => row.code))
  for (let index = Math.max(0, start); index < 100000; index += 1) {
    const code = codeFor(index)
    if (!used.has(code)) return { code, index }
  }
  return null
}

function activeAssignment(task) {
  return (Array.isArray(task.assignments) ? task.assignments : []).filter(row => row && row.state !== 'ended').pop() ?? null
}

function stageContext(file, now) {
  const ledger = readLedger(file)
  const router = readRouter(file)
  return { ledger, router, effects: ledger.effects ?? [], tasks: ledger.tasks, now, stuckMinutes: router.stuckMinutes }
}

function currentStage(task, context) {
  const info = stageOf(task, {
    effects: context.effects,
    tasks: context.tasks,
    now: context.now,
    stuckMinutes: context.stuckMinutes,
    stuckEnabled: true,
  })
  if (info.stage === 'silent' && !activeAssignment(task)?.nudgedAt) return 'silent-uncalled'
  return info.stage
}

// 卡进入可通知阶段时记一条；同一次进入只记一条。离开时 close，编号在保留期内
// 不复用，避免旧微信回复落到新卡上。
export function syncNotices(options = {}) {
  const file = options.file
  const now = options.now ?? Date.now()
  const ledger = readLedger(file)
  const settings = normalizeNotify(ledger.notify)
  const storedIndex = Number(ledger.notify?.nextIndex)
  // 先按存量所有 code 恢复，再做清理；否则 7 天清掉 closed 后旧号会被重发。
  let nextIndex = recoverNextIndex(Array.isArray(ledger.notices) ? ledger.notices : [], storedIndex)
  let changed = false
  const notices = Array.isArray(ledger.notices) ? ledger.notices.slice() : []
  // 清掉超过 7 天的 closed；编号不随记录释放，nextIndex 只前进。
  const kept = notices.filter(row => !(row.state === 'closed' && now - (row.closedAt ?? row.enteredAt ?? 0) > RETENTION))
  if (kept.length !== notices.length) { notices.length = 0; notices.push(...kept); changed = true }

  if (settings.mode !== 'on') {
    for (const row of notices) {
      if (row.state !== 'closed' && row.state !== 'listed') { row.state = 'closed'; row.closedAt = now; changed = true }
    }
  } else {
    const context = { ...stageContext(file, now), tasks: ledger.tasks }
    const byTask = new Map()
    for (const row of notices) {
      if (row.state === 'closed') continue
      byTask.set(row.taskId, [...(byTask.get(row.taskId) ?? []), row])
    }
    for (const task of ledger.tasks) {
      const stage = currentStage(task, context)
      const allowed = NOTIFY_STAGES.includes(stage)
      const open = byTask.get(task.id) ?? []
      if (!allowed) {
        for (const row of open) { row.state = 'closed'; row.closedAt = now; changed = true }
        continue
      }
      // 同阶段同一次进入不重复；换阶段先关旧条目。listed 是 sa_list 提前
      // 分配的展示号，切到 on 时要转成真正待发，不能永久吞掉通知。
      const listed = open.find(row => row.stage === stage)
      if (listed) {
        if (listed.state === 'listed') {
          listed.state = 'new'
          listed.enteredAt = now
          listed.taskVersion = task.version ?? 0
          changed = true
        }
        continue
      }
      for (const row of open) { row.state = 'closed'; row.closedAt = now; changed = true }
      const allocated = allocCode(notices, nextIndex)
      if (!allocated) continue
      const { code } = allocated
      nextIndex = allocated.index + 1
      notices.push({
        id: `n-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        code,
        taskId: task.id,
        stage,
        enteredAt: now,
        taskVersion: task.version ?? 0,
        state: 'new',
        effectId: null,
        sentAt: null,
        attempts: 0,
        nextAttemptAt: null,
        lastError: null,
      })
      changed = true
    }
  }
  if (changed) {
    ledger.notices = notices
    ledger.notify = { ...settings, nextIndex }
    ledger.revision = (ledger.revision ?? 0) + 1
    writeLedger(ledger, file)
  }
  return { notices, created: changed }
}

function noticeLine(notice, task, decisionAvailable) {
  const [stageText, reply] = STAGE_TEXT[notice.stage] ?? ['等你', `回「${notice.code}」`]
  const title = sanitizeNotifyText(task?.title ?? '(无标题)').slice(0, 80)
  const lines = [decisionAvailable === false ? `${stageText}｜${title}` : `${notice.code} ${stageText}｜${title}`]
  if (notice.stage === 'question') {
    lines.push(`问：${sanitizeNotifyText(task?.openQuestion?.text ?? '').slice(0, 120)}`)
  }
  if (decisionAvailable !== false) lines.push(reply.replaceAll('{code}', notice.code))
  return lines.join('\n')
}

export function buildNoticeMessage(notices, tasks, options = {}) {
  const byId = new Map((tasks ?? []).map(task => [task.id, task]))
  const rows = (notices ?? []).slice(0, NOTICE_LIMIT)
  if (!rows.length) return null
  const decisionAvailable = options.decisionAvailable !== false
  const lines = [`Super Agent：${notices.length} 件事等你`]
  for (const notice of rows) {
    lines.push(noticeLine(notice, byId.get(notice.taskId), decisionAvailable))
    lines.push('')
  }
  if (notices.length > rows.length) lines.push(`另有 ${notices.length - rows.length} 件，打开面板看`)
  // 面板兜底行是固定指令，不能被 600 字截断砍掉；先给它留出长度，再截正文。
  const panelLine = decisionAvailable ? '' : '打开 Super Agent 面板处理'
  const tail = panelLine ? `\n${panelLine}` : ''
  const budget = Math.max(0, MESSAGE_LIMIT - tail.length)
  let body = lines.join('\n').trim()
  if (body.length > budget) body = `${body.slice(0, Math.max(0, budget - 1))}…`
  const text = `${body}${tail}`
  const [title, ...rest] = text.split('\n')
  return { title, text: rest.join('\n').replace(/^\n+/, '') }
}

export function resolveNotifyCommand(options = {}) {
  const env = options.env ?? process.env
  const raw = env?.DSH_SUPERAGENT_NOTIFY_CMD
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return normalizeCommand(parsed)
      return { error: '环境变量 DSH_SUPERAGENT_NOTIFY_CMD 不是 JSON 数组' }
    } catch {
      return { error: '环境变量 DSH_SUPERAGENT_NOTIFY_CMD 不是 JSON 数组' }
    }
  }
  const configured = options.config?.notifyCommand
  if (Array.isArray(configured)) return normalizeCommand(configured)
  return { command: null }
}

function normalizeCommand(value) {
  if (!Array.isArray(value) || value.length === 0) return { command: null }
  if (!value.every(item => typeof item === 'string')) return { error: '发送命令必须是字符串数组' }
  if (!value[0].startsWith('/')) return { error: '发送命令第一项必须是绝对路径' }
  return { command: value.slice() }
}

function withPlaceholders(command, message) {
  return command.map(arg => arg.replaceAll('{title}', message.title).replaceAll('{text}', message.text))
}

// 同步部分：spawn 之前就失败（找不到文件/没权限）才可安全重试。进程已经起来
// 之后超时或拿不到退出码，一律按「结果未知」处理，不重发。
export function sendWithCommand(command, message, options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn
  const timeoutMs = options.timeoutMs ?? 20_000
  return new Promise(resolve => {
    let child
    try {
      child = spawnImpl(command[0], withPlaceholders(command.slice(1), message), { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ ok: false, uncertain: true, error: '发送命令超时，结果未知' })
    }, timeoutMs)
    // stderr 可能有命令回显/私密内容，只消费不保存、不进台账/UI。
    child.stderr?.on?.('data', () => {})
    child.on?.('error', error => {
      const code = error && typeof error === 'object' ? error.code : null
      if (code === 'ENOENT' || code === 'EACCES') return finish({ ok: false, retryable: true, error: '发送命令无法启动' })
      finish({ ok: false, uncertain: true, error: '发送命令启动后异常，结果未知' })
    })
    child.on?.('close', (code, signal) => {
      if (code === 0) return finish({ ok: true })
      if (code === null || signal) return finish({ ok: false, uncertain: true, error: '发送命令被信号结束，结果未知' })
      // 进程已经起来并留下退出码：可能已经送出，按未知处理，不自动重发。
      finish({ ok: false, uncertain: true, error: `发送命令退出 ${code}，结果未知` })
    })
  })
}

function dueRows(ledger, notices, now) {
  return notices
    .filter(row => row.inFlight !== true && (row.state === 'new' || (row.state === 'queued' && Number.isFinite(row.nextAttemptAt) && row.nextAttemptAt <= now)))
    .sort((a, b) => (a.enteredAt ?? 0) - (b.enteredAt ?? 0))
}

// 一次调度：同步通知、去掉已离开阶段的、合并、限频、安静时段，再尝试发送。
// sender 只在测试/隔离里注入；生产用配置命令。
export async function runNotifyOnce(options = {}) {
  const file = options.file
  const now = options.now ?? Date.now()
  syncNotices({ file, now })
  const ledger = readLedger(file)
  const settings = normalizeNotify(ledger.notify)
  if (settings.mode !== 'on') return { status: 'off' }
  const notices = Array.isArray(ledger.notices) ? ledger.notices : []
  const tasks = ledger.tasks ?? []
  const tasksById = new Map(tasks.map(task => [task.id, task]))
  // 发送前重算阶段：已经离开的通知直接去掉，并落盘，避免下次又按旧阶段发。
  let stageClosed = false
  for (const row of notices) {
    if (row.state === 'closed') continue
    const task = tasksById.get(row.taskId)
    const stage = task ? currentStage(task, { ...stageContext(file, now), tasks }) : null
    if (stage !== row.stage) { row.state = 'closed'; row.closedAt = now; stageClosed = true }
  }
  if (stageClosed) {
    ledger.notices = notices
    ledger.revision = (ledger.revision ?? 0) + 1
    writeLedger(ledger, file)
  }
  const due = dueRows(ledger, notices, now)
  if (!due.length) {
    ledger.notices = notices
    writeLedgerIfChanged(ledger, file, options)
    return { status: 'idle' }
  }
  if (now - (due[0].enteredAt ?? now) < BATCH_WAIT) {
    ledger.notices = notices
    writeLedgerIfChanged(ledger, file, options)
    return { status: 'batched' }
  }
  if (isQuietAt(now, settings.quiet)) {
    ledger.notices = notices
    writeLedgerIfChanged(ledger, file, options)
    return { status: 'quiet' }
  }
  // 按已送出的批次计，不按当前 state 计：卡验收后通知会 closed，但这一小时
  // 里确实发过；sentAt 保留在记录上，跨重开和关闭都不把额度退回来。
  const sentThisHour = new Set(notices
    .filter(row => Number.isFinite(row.sentAt) && row.sentAt > now - 60 * 60_000)
    .map(row => row.effectId ?? row.id)).size
  if (sentThisHour >= settings.perHour) {
    ledger.notices = notices
    writeLedgerIfChanged(ledger, file, options)
    return { status: 'rate' }
  }
  const batch = due.slice()
  const message = buildNoticeMessage(due, tasks, { decisionAvailable: options.decisionAvailable })
  if (!message) return { status: 'idle' }
  const sender = options.sender
  const command = options.command ?? resolveNotifyCommand(options).command
  if (!sender && !command) {
    // 还没开始发送：保持 new，配置好之后下一轮可以正常合并发出。
    for (const row of batch) { row.state = 'new'; row.lastError = '还没配置发送方式'; row.nextAttemptAt = null }
    ledger.notices = notices
    writeLedger(ledger, file)
    return { status: 'unconfigured', message }
  }
  // 进入发送时清掉旧的重试时间，并用 inFlight 挡住并发调度把同一条再发一次。
  for (const row of batch) { row.state = 'queued'; row.lastError = null; row.inFlight = true; row.nextAttemptAt = null }
  ledger.notices = notices
  writeLedger(ledger, file)
  const effect = createEffect({ kind: 'notify', taskId: null, messageId: batch.map(row => row.id).join(','), text: `${message.title}\n${message.text}` }, { file })
  const send = sender ?? (message => sendWithCommand(command, message))
  let result
  try {
    result = await send(message)
  } catch (error) {
    result = { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) }
  }
  settleNotifySend({
    file, effectId: effect.id, batchIds: batch.map(row => row.id),
    result, now,
  })
  return { status: result.ok ? 'sent' : result.uncertain ? 'unknown' : 'retry', message, error: result.error ?? null }
}

// 发送 await 回来后，重新读当前台账，只结算这一次的动作和通知；不写回发送前
// 的旧对象，也不复活 fake sender 期间已经 closed 的通知。
export function settleNotifySend(options = {}) {
  const file = options.file
  const { effectId, batchIds, result, now } = options
  const ledger = readLedger(file)
  const notices = Array.isArray(ledger.notices) ? ledger.notices : []
  const ids = new Set(batchIds ?? [])
  for (const row of notices) {
    if (!ids.has(row.id)) continue
    if (row.state === 'closed') continue // 期间卡已离开阶段，不复活
    row.effectId = effectId
    row.inFlight = false
    if (result.ok) {
      row.state = 'sent'; row.sentAt = now; row.lastError = null; row.nextAttemptAt = null
    } else if (result.uncertain) {
      row.state = 'unknown'; row.lastError = result.error; row.uncertain = true; row.nextAttemptAt = null
    } else {
      row.attempts = (row.attempts ?? 0) + 1
      if (row.attempts >= RETRY_DELAYS.length + 1) { row.state = 'failed'; row.lastError = result.error; row.nextAttemptAt = null }
      else { row.state = 'queued'; row.lastError = result.error; row.nextAttemptAt = now + RETRY_DELAYS[row.attempts - 1] }
    }
  }
  const effect = (ledger.effects ?? []).find(item => item.id === effectId)
  if (effect) {
    effect.state = result.ok ? 'sent' : result.uncertain ? 'failed' : 'pending'
    effect.lastError = result.ok ? null : result.error
    effect.attempts = 1
  }
  ledger.notices = notices
  ledger.revision = (ledger.revision ?? 0) + 1
  writeLedger(ledger, file)
  return { notices, effect }
}

// 重启恢复：上次进程在发送途中崩溃，通知仍是 queued/inFlight，不能重发。
export function recoverNotifyInFlight(file, options = {}) {
  const ledger = readLedger(file)
  const notices = Array.isArray(ledger.notices) ? ledger.notices : []
  let changed = false
  for (const row of notices) {
    if (row.state !== 'closed' && row.inFlight === true) {
      row.state = 'unknown'
      row.uncertain = true
      row.lastError = '上次发送结果未知，没有重发'
      row.nextAttemptAt = null
      row.inFlight = false
      changed = true
    }
  }
  if (changed) {
    ledger.notices = notices
    ledger.revision = (ledger.revision ?? 0) + 1
    writeLedger(ledger, file)
  }
  return { changed }
}

function writeLedgerIfChanged(ledger, file, options) {
  if (!options?.forceWrite) return
  ledger.revision = (ledger.revision ?? 0) + 1
  writeLedger(ledger, file)
}

// 面板用：编号 + 阶段说法 + 一句原因。
export function noticeView(file, tasks, options = {}) {
  const { notices } = readNotify(file)
  const byId = new Map(notices.filter(row => row.state !== 'closed').map(row => [row.taskId, row]))
  return tasks.map(task => ({ task, notice: byId.get(task.id) ?? null }))
}

export function noticeForTask(file, taskId) {
  const { notices } = readNotify(file)
  return notices.filter(row => row.taskId === taskId && row.state !== 'closed').at(-1) ?? null
}

// sa_list group=waiting：还没通知的卡也给一个能拿来回话的短号。state='listed'
// 只用于展示，不进入发送队列；off 档也保留。
export function ensureWaitingCodes(file, options = {}) {
  const now = options.now ?? Date.now()
  const ledger = readLedger(file)
  const notices = Array.isArray(ledger.notices) ? ledger.notices : []
  const context = { ...stageContext(file, now), tasks: ledger.tasks }
  const active = new Map(notices.filter(row => row.state !== 'closed').map(row => [row.taskId, row]))
  let changed = false
  let nextIndex = recoverNextIndex(notices, Number(ledger.notify?.nextIndex))
  for (const task of ledger.tasks) {
    if (active.has(task.id)) continue
    const stage = currentStage(task, context)
    if (!NOTIFY_STAGES.includes(stage)) continue
    const allocated = allocCode(notices, nextIndex)
    if (!allocated) continue
    const { code } = allocated
    nextIndex = allocated.index + 1
    notices.push({
      id: `n-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      code, taskId: task.id, stage, enteredAt: now, taskVersion: task.version ?? 0,
      state: 'listed', effectId: null, sentAt: null, attempts: 0, nextAttemptAt: null, lastError: null,
    })
    changed = true
  }
  if (changed) {
    ledger.notices = notices
    ledger.notify = { ...normalizeNotify(ledger.notify), nextIndex }
    ledger.revision = (ledger.revision ?? 0) + 1
    writeLedger(ledger, file)
  }
  return { notices }
}
