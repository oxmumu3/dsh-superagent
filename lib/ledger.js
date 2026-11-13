// dsh-superagent ledger — the task store this plugin owns.
//
// Design constraints (see ../DESIGN.md):
// - One JSON file under $DSH_HOME; atomic writes (tmp + rename) so a crash
//   never leaves a half-written ledger.
// - Schema-compatible with the existing dsh-taskboard ledger where it matters
//   (id / title / status / urgency / workspaceId / comments / checklist /
//   executions / version), so cards can migrate without a rewrite.
// - Every mutation bumps the record version; callers pass ifVersion for
//   optimistic concurrency. A mismatch is a normal outcome, not an error.
// - No dependencies: this module must be testable with plain `node`.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { detectNod } from './nod.js'
import { validateWorkspacePath } from './workspace.js'
import {
  MAX_NOTE_TEXT, normalizeChecklistItems, normalizeEvidence, readyGateMessage,
} from './evidence.js'
import { prepareRule, removeRule, rulesForPath, rulesSnapshot } from './rules.js'
import {
  MAX_VENT_TEXT, MAX_VENTS, appendVent, findVent, findVentByRequestId,
  removeVent, ventRows, ventsSnapshot,
} from './vents.js'
import { sanitizeText } from './sanitize.js'

export const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled', 'archived']
export const URGENCIES = ['urgent', 'normal', 'relaxed']
// 终态卡不能再开动作或重试旧动作。
export const TERMINAL_STATUSES = ['done', 'canceled', 'archived']

// S3：自动开工的三档。没有这个字段时按 observe 处理；环境变量优先用来紧急停。
export const ROUTER_MODES = ['off', 'observe', 'auto']
export const ROUTER_DEFAULT_MAX = 2
export const ROUTER_DEFAULT_STUCK_MINUTES = 20
export const ROUTER_LOG_LIMIT = 200
// S3 0.2：只有这些「用户意图」变了才加卡的 version；派工、事件时间、最近一轮、
// 最近报告这类宿主事件推出来的更新只加台账 revision。
const VERSION_FIELDS = ['title', 'description', 'status', 'blocked', 'workspacePath', 'queue', 'nodded', 'dependsOn']

// S1: 执行会话交回来的结构化结果。老调用不带 outcome 时按 ready 处理。
export const OUTCOMES = ['ready', 'progress', 'waiting', 'blocked', 'failed', 'dropped']
// 派工记录的状态：pending 已记下还没确认开始；running 正在跑一轮；
// idle 会话在、这一轮停了；ended 不再由它承载。
export const ASSIGNMENT_STATES = ['pending', 'running', 'idle', 'ended']
export const END_REASONS = ['done', 'canceled', 'superseded', 'lost']
// 先记后做的动作：pending 待做 / sent 已交给宿主待确认 / confirmed 宿主已确认 / failed 放弃。
export const EFFECT_STATES = ['pending', 'sent', 'confirmed', 'failed']

const ALLOWED = {
  backlog: ['todo', 'canceled', 'archived'],
  todo: ['in_progress', 'backlog', 'canceled', 'archived'],
  in_progress: ['in_review', 'todo', 'backlog', 'canceled'],
  in_review: ['done', 'in_progress', 'todo', 'backlog', 'canceled'],
  done: ['archived'],
  canceled: ['archived', 'todo'],
  archived: [],
}

export function homeDir() {
  const override = process.env.DSH_HOME
  return override !== undefined && override.length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), '.dsh')
}

export function ledgerPath() {
  return process.env.DSH_SUPERAGENT_LEDGER || path.join(homeDir(), 'superagent-ledger.json')
}

function now() {
  return Date.now()
}

function emptyLedger() {
  return {
    schemaVersion: 1,
    revision: 0,
    tasks: [],
    pending: [],
    effects: [],
    // S6: project acceptance rules and the friction box. Old ledgers simply get
    // empty values in memory; nothing is rewritten until the next real write.
    acceptanceRules: {},
    vents: [],
  }
}

export function readLedger(file = ledgerPath()) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    // 只有「文件不存在」才等于空台账。其它读失败必须报出来，不能悄悄当空。
    if (error && error.code === 'ENOENT') return emptyLedger()
    throw error
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.tasks)) throw new Error('台账结构不对：缺少 tasks 数组')
    if (!Array.isArray(parsed.pending)) parsed.pending = []
    // S1：老台账没有 effects 时按空处理。只在内存里补，不重写文件。
    if (!Array.isArray(parsed.effects)) parsed.effects = []
    // S6：老台账没有规矩和吐槽时按空处理，同样不重写文件。
    if (!parsed.acceptanceRules || typeof parsed.acceptanceRules !== 'object' || Array.isArray(parsed.acceptanceRules)) {
      parsed.acceptanceRules = {}
    }
    if (!Array.isArray(parsed.vents)) parsed.vents = []
    return parsed
  } catch (error) {
    // 按内容哈希命名：同一份坏内容只留一个副本，读多少次都不会增多。
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)
    const backup = `${file}.corrupt-${hash}`
    let saved = false
    let backupError = null
    try {
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw, { flag: 'wx', mode: 0o600 })
      saved = true
    } catch (writeError) {
      if (writeError && writeError.code === 'EEXIST') saved = true
      else backupError = writeError
    }
    const detail = error instanceof Error ? error.message : String(error)
    const wrapped = new Error(
      saved
        ? `台账读不出来，已另存原文件到 ${backup}：${detail}`
        : `台账读不出来，另存失败（${backupError instanceof Error ? backupError.message : String(backupError)}）：${detail}`,
    )
    wrapped.code = 'LEDGER_UNREADABLE'
    wrapped.backup = saved ? backup : null
    throw wrapped
  }
}

// S3：任何一次落盘之后通知订阅者（Router 用它去抖调度）。订阅者抛错不能
// 影响写入本身；这里只做通知，不改台账。
const writeListeners = new Set()

export function onLedgerWrite(listener) {
  if (typeof listener !== 'function') return () => {}
  writeListeners.add(listener)
  return () => writeListeners.delete(listener)
}

function notifyWrite(file) {
  for (const listener of [...writeListeners]) {
    try {
      listener(file)
    } catch {
      // 通知失败不是台账失败。
    }
  }
}

export function writeLedger(ledger, file = ledgerPath()) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.superagent-ledger.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
  notifyWrite(file)
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

function normalizePath(value) {
  const text = String(value ?? '').trim()
  return text || null
}

function addRevision(ledger) {
  ledger.revision = (ledger.revision ?? 0) + 1
}

// S3 0.2：版本号只跟用户意图走。事件时间、最近一轮、最近报告、派工记录这些
// 由宿主事件推出来的字段变了，只加 ledger.revision，不动卡的 version。
function versionState(task) {
  const state = {}
  for (const key of VERSION_FIELDS) {
    const value = task?.[key]
    state[key] = value === undefined ? null : value
  }
  return JSON.stringify(state)
}

function addTaskRevision(task, stamp) {
  if (stamp !== undefined && versionState(task) === stamp) return false
  task.version = (task.version ?? 0) + 1
  task.updatedAt = now()
  return true
}

function normalizeQueue(input) {
  if (!input || typeof input !== 'object' || input.auto !== true) return null
  return {
    at: Number.isFinite(input.at) ? input.at : now(),
    by: String(input.by ?? 'user').slice(0, 40),
    auto: true,
  }
}

const NOD_KINDS = ['spend', 'outbound', 'permission']

function normalizeNeedsNod(input) {
  if (!input || typeof input !== 'object') return null
  const kinds = Array.isArray(input.kinds)
    ? input.kinds.filter(kind => NOD_KINDS.includes(kind))
    : []
  if (!kinds.length) return null
  return {
    kinds: [...new Set(kinds)],
    matched: Array.isArray(input.matched) ? input.matched.map(String).slice(0, 20) : [],
    at: Number.isFinite(input.at) ? input.at : now(),
  }
}

// S4 2：依赖校验。ids 必须存在、不能是自己、不能成环；最多 10 个。
function normalizeDepends(input, tasks, selfId) {
  const raw = Array.isArray(input) ? input : []
  const ids = [...new Set(raw.map(value => String(value ?? '').trim()).filter(Boolean))]
  if (ids.length > 10) throw new Error('一张卡最多等 10 张卡')
  const known = new Set((Array.isArray(tasks) ? tasks : []).map(task => task.id))
  for (const id of ids) {
    if (id === selfId) throw new Error('一张卡不能等自己做')
    if (!known.has(id)) throw new Error(`找不到要等的卡：${id}`)
  }
  // 用「当前依赖 + 这张卡的新依赖」检查成环；老台账里没有 dependsOn 的按空。
  const edges = new Map((Array.isArray(tasks) ? tasks : []).map(task => [
    task.id,
    Array.isArray(task.dependsOn)
      ? task.dependsOn.filter(dep => dep !== selfId || task.id !== selfId)
      : [],
  ]))
  edges.set(selfId, ids)
  const reaches = (start, target, seen) => {
    if (start === target) return true
    if (seen.has(start)) return false
    seen.add(start)
    for (const next of edges.get(start) ?? []) {
      if (reaches(next, target, seen)) return true
    }
    return false
  }
  for (const id of ids) {
    if (reaches(id, selfId, new Set())) throw new Error('依赖成环了，这张卡会等不到自己')
  }
  return ids
}

function findTask(ledger, id) {
  const task = ledger.tasks.find(t => t.id === id)
  if (!task) throw new Error(`task not found: ${id}`)
  return task
}

export class VersionConflict extends Error {
  constructor(id, expected, actual) {
    super(`version conflict on ${id}: expected ${expected}, actual ${actual}`)
    this.name = 'VersionConflict'
    this.id = id
    this.expected = expected
    this.actual = actual
  }
}

// 自动派工在不可逆的建会话之前复核失败时用这个错误；调用方据此释放抢占、
// 让卡留在可见的排队里，而不是写成「没启动」。
export class DispatchGuardError extends Error {
  constructor(message, reason = 'stale') {
    super(message)
    this.name = 'DispatchGuardError'
    this.reason = reason
  }
}

export class InvalidTransition extends Error {
  constructor(from, to) {
    super(`illegal transition ${from} -> ${to}`)
    this.name = 'InvalidTransition'
    this.from = from
    this.to = to
  }
}

function commit(task, stamp) {
  addTaskRevision(task, stamp)
  return task
}

export function createTask(input = {}, options = {}) {
  const title = String(input.title ?? '').trim()
  if (!title) throw new Error('title is required')
  const status = input.status ?? 'todo'
  if (!STATUSES.includes(status)) throw new Error(`unknown status: ${status}`)
  const urgency = URGENCIES.includes(input.urgency) ? input.urgency : 'normal'

  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const description = String(input.description ?? '')
  const detectedNod = input.needsNod === undefined ? detectNod(title, description) : input.needsNod
  const taskId = newId('t')
  const dependsOn = input.dependsOn === undefined ? [] : normalizeDepends(input.dependsOn, ledger.tasks, taskId)
  const task = {
    id: taskId,
    title,
    description,
    prompt: String(input.prompt ?? ''),
    workspaceId: input.workspaceId ?? null,
    urgency,
    status,
    blocked: false,
    execution: { mode: input.execution?.mode === 'scheduled' ? 'scheduled' : 'claim' },
    isolation: 'none',
    permission: null,
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    createdBy: input.by ?? 'agent',
    updatedBy: input.by ?? 'agent',
    sourceSessionId: input.sourceSessionId ?? null,
    // S6 C：从吐槽转来的卡记住来源，重复点击不会生成第二张。
    sourceVentId: input.sourceVentId ? String(input.sourceVentId) : null,
    // S1：派工身份与恢复所需字段。老卡没有这些字段时由读取方按空处理，
    // 这里只给新卡一个明确的初始值，不迁移旧数据。
    workspacePath: normalizePath(input.workspacePath),
    // S3 0.1：只有 queue.auto 为真的卡 Router 才会自动开工；老卡没有这个
    // 字段，一律按「手动排队」处理，不写迁移脚本。
    queue: normalizeQueue(input.queue),
    // S3 2：命中要点头的词时由建卡方写入；没命中就是 null。
    needsNod: normalizeNeedsNod(detectedNod),
    nodded: null,
    // S4 2：等这些卡都 done 之后才自动开始。老卡没有字段按空处理。
    dependsOn,
    assignments: [],
    openQuestion: null,
    comments: [],
    checklist: [],
    executions: [],
  }
  if (Array.isArray(input.checklist)) {
    task.checklist = input.checklist.map(text => ({
      id: newId('k'),
      text: String(text).slice(0, 200),
      checked: false,
    }))
  }
  ledger.tasks.push(task)
  ledger.revision = (ledger.revision ?? 0) + 1
  writeLedger(ledger, file)
  return task
}

// A4：模型判成「是任务」时不直接建卡，先记到 pending 列表，等用户确认。
// 记下原话、来源会话、工作区、时间；不参与状态机，也不算卡。
export function addPending(entry = {}, options = {}) {
  const text = String(entry.text ?? '').trim()
  if (!text) throw new Error('text is required')
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  if (!Array.isArray(ledger.pending)) ledger.pending = []
  const row = {
    id: newId('p'),
    text: text.slice(0, 400),
    title: String(entry.title ?? '').slice(0, 80),
    sessionId: entry.sessionId ?? null,
    workspaceId: entry.workspaceId ?? null,
    // 待确认的话也记住它来自哪个目录；转成卡时不必再猜。
    workspacePath: normalizePath(entry.workspacePath),
    // S3 4：一轮结束判断出「补到某张卡上」时带上卡号；其它来源为 null。
    suggestedTaskId: entry.suggestedTaskId ? String(entry.suggestedTaskId) : null,
    by: entry.by ?? 'model',
    // S6 C：外部队列按请求 id 去重，宿主重放同一条不会产生第二行。
    requestId: entry.requestId ? String(entry.requestId) : null,
    at: now(),
  }
  ledger.pending.push(row)
  if (ledger.pending.length > 200) ledger.pending = ledger.pending.slice(-200)
  ledger.revision = (ledger.revision ?? 0) + 1
  writeLedger(ledger, file)
  return row
}

export function listPending(options = {}) {
  const ledger = readLedger(options.file ?? ledgerPath())
  return { revision: ledger.revision ?? 0, pending: (ledger.pending ?? []).slice() }
}

// 待确认的一条话被记下或丢掉后从列表移除。返回被移除的那条，调用方可以
// 用它建卡；找不到就是已经被另一个窗口处理过，不是致命错误。
export function removePending(id, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const rows = Array.isArray(ledger.pending) ? ledger.pending : []
  const index = rows.findIndex(row => row.id === id)
  if (index < 0) return null
  const [row] = rows.splice(index, 1)
  addRevision(ledger)
  writeLedger(ledger, file)
  return row
}

export function listTasks(filter = {}, options = {}) {  const ledger = readLedger(options.file ?? ledgerPath())
  let rows = ledger.tasks.slice()
  if (!filter.includeArchived) rows = rows.filter(t => !['archived', 'canceled'].includes(t.status))
  if (filter.status) rows = rows.filter(t => t.status === filter.status)
  if (filter.workspaceId) rows = rows.filter(t => t.workspaceId === filter.workspaceId)
  if (filter.urgency) rows = rows.filter(t => t.urgency === filter.urgency)
  rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  const total = rows.length
  // 200 只是「给模型看的输出」的上限；不传 limit 的调用方（巡检、面板）读全量。
  const rawLimit = Number(filter.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : Infinity
  return {
    total,
    revision: ledger.revision ?? 0,
    tasks: rows.slice(0, limit),
    // S1：阶段计算要看「这张卡有没有 failed 的 start/deliver」。
    effects: (ledger.effects ?? []).slice(),
  }
}

export function getTask(id, options = {}) {
  const ledger = readLedger(options.file ?? ledgerPath())
  const task = ledger.tasks.find(t => t.id === id)
  if (!task) throw new Error(`task not found: ${id}`)
  return task
}

function withTask(id, mutate, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const task = ledger.tasks.find(t => t.id === id)
  if (!task) throw new Error(`task not found: ${id}`)
  const expected = options.ifVersion
  if (expected !== undefined && expected !== null && task.version !== expected) {
    throw new VersionConflict(id, expected, task.version)
  }
  const stamp = versionState(task)
  mutate(task, ledger)
  commit(task, stamp)
  task.updatedBy = options.by ?? 'agent'
  ledger.revision = (ledger.revision ?? 0) + 1
  writeLedger(ledger, file)
  return task
}

export function updateTask(id, patch = {}, options = {}) {
  return withTask(id, task => {
    if (patch.title !== undefined) {
      const title = String(patch.title).trim()
      if (!title) throw new Error('title cannot be empty')
      task.title = title
    }
    if (patch.description !== undefined) task.description = String(patch.description)
    if (patch.prompt !== undefined) task.prompt = String(patch.prompt)
    if (patch.urgency !== undefined) {
      if (!URGENCIES.includes(patch.urgency)) throw new Error(`unknown urgency: ${patch.urgency}`)
      task.urgency = patch.urgency
    }
    if (patch.blocked !== undefined) task.blocked = Boolean(patch.blocked)
    if (patch.workspaceId !== undefined) task.workspaceId = patch.workspaceId
    if (patch.workspacePath !== undefined) task.workspacePath = normalizePath(patch.workspacePath)
  }, options)
}

export function moveTask(id, to, options = {}) {
  if (!STATUSES.includes(to)) throw new Error(`unknown status: ${to}`)
  return withTask(id, task => {
    if (task.status === to) return
    if (!(ALLOWED[task.status] ?? []).includes(to)) throw new InvalidTransition(task.status, to)
    task.status = to
  }, options)
}

export function addComment(id, body, options = {}) {
  const text = String(body ?? '').trim()
  if (!text) throw new Error('comment body is required')
  return withTask(id, task => {
    task.comments.push({
      id: newId('c'),
      body: text,
      author: options.author ?? 'agent',
      at: now(),
    })
  }, options)
}

// S1：报告改成结构化。老调用没有 outcome 时按 ready，行为和以前一致。
// 插件收到报告后自己动卡，不再指望执行会话调 sa_move。
function effectiveOutcome(report = {}) {
  return OUTCOMES.includes(report?.outcome) ? report.outcome : 'ready'
}

function reportSourceOf(task, sessionId) {
  const assignments = assignmentsOf(task)
  const current = currentAssignment(task)
  const reportedBy = sessionId
    ? assignments.find(a => a.sessionId === sessionId) ?? null
    : null
  const source = sessionId ? reportedBy : current
  const trusted = !sessionId || Boolean(source && current && source.id === current.id)
  return { assignments, current, reportedBy, source, trusted }
}

export function reportExecution(id, report = {}, options = {}) {
  const file = options.file ?? ledgerPath()
  // A1：ready 的证据门槛在写台账之前检查。拒收不写执行记录、不加 revision，
  // 卡的状态、阶段和 lastReport 全部保持原样。历史/迟到的报告本来就不能动卡，
  // 仍按原语义只留执行记录，不因缺证据被拒。
  const preview = readLedger(file)
  const target = findTask(preview, id)
  if (options.ifVersion !== undefined && options.ifVersion !== null && target.version !== options.ifVersion) {
    throw new VersionConflict(id, options.ifVersion, target.version)
  }
  const outcome = effectiveOutcome(report)
  const question = normalizeQuestion(report.question)
  const previewSource = reportSourceOf(target, options.sessionId)
  // 工具传入 requireSession 时，没有可靠执行身份的报告只能记历史，不能推进卡。
  const previewTrusted = previewSource.trusted && (!options.requireSession || Boolean(options.sessionId))
  if (previewTrusted && outcome === 'ready' && !TERMINAL_STATUSES.includes(target.status)) {
    const message = readyGateMessage(target, report)
    if (message) throw new Error(message)
  }
  return withTask(id, (task, ledger) => {
    const at = now()
    const { current, source, trusted: baseTrusted } = reportSourceOf(task, options.sessionId)
    const trusted = baseTrusted && (!options.requireSession || Boolean(options.sessionId))
    const friction = sanitizeText(String(report.friction ?? '').trim()).slice(0, MAX_VENT_TEXT)
    task.executions.push({
      id: newId('e'),
      state: outcome,
      outcome,
      summary: String(report.summary ?? ''),
      changedFiles: Array.isArray(report.changedFiles) ? report.changedFiles.slice(0, 50) : [],
      checks: Array.isArray(report.checks) ? report.checks.slice(0, 50) : [],
      risk: String(report.risk ?? ''),
      ...(friction ? { friction } : {}),
      at,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(source ? { assignmentId: source.id } : {}),
    })
    // C：只有当前合法派工的报告才能把摩擦写进吐槽箱；旧/他卡报告只留历史。
    if (friction && trusted) {
      appendVent(ledger, {
        text: friction,
        taskId: task.id,
        workspacePath: task.workspacePath,
        by: 'executor',
      }, at)
    }
    if (!trusted) return
    if (source && source.state !== 'ended' && (!current || source.id === current.id)) {
      source.lastReport = { outcome, at }
    }
    if (question) {
      task.openQuestion = {
        id: newId('q'),
        text: question.text,
        ...(question.options ? { options: question.options } : {}),
        askedAt: at,
        assignmentId: source ? source.id : null,
      }
    }
    if (outcome === 'ready' || outcome === 'dropped') {
      // 由系统移卡；直接赋值，避免执行会话借 sa_move 越权。
      if (!['done', 'canceled', 'archived'].includes(task.status)) task.status = 'in_review'
      task.blocked = false
    } else if (outcome === 'blocked' || outcome === 'failed') {
      task.blocked = true
    }
  }, options)
}

export function clearOpenQuestion(id, options = {}) {
  return withTask(id, task => {
    task.openQuestion = null
  }, options)
}

function normalizeQuestion(question) {
  if (!question || typeof question !== 'object') return null
  const text = String(question.text ?? '').trim()
  if (!text) return null
  const raw = Array.isArray(question.options) ? question.options : []
  const options = raw
    .map(option => String(option ?? '').trim())
    .filter(Boolean)
    .slice(0, 8)
  return { text: text.slice(0, 400), ...(options.length ? { options } : {}) }
}

export function checkItem(id, itemId, options = {}) {
  return withTask(id, task => {
    const item = (task.checklist ?? []).find(k => k.id === itemId)
    if (!item) throw new Error(`checklist item not found: ${itemId}`)
    item.checked = true
    if (options.note) item.note = String(options.note).slice(0, MAX_NOTE_TEXT)
    const evidence = normalizeEvidence(task, options.evidence)
    if (evidence !== undefined) item.evidence = evidence
  }, options)
}

// A3: only the executor currently assigned to this card may write the first
// checklist. A checklist the user already wrote is never replaced or extended.
export function setChecklist(id, items, options = {}) {
  return withTask(id, task => {
    if (Array.isArray(task.checklist) && task.checklist.length) {
      throw new Error('这张卡已经有验收清单，不能改写')
    }
    const sessionId = String(options.sessionId ?? '').trim()
    const current = currentAssignment(task)
    if (!sessionId) throw new Error('拿不到当前执行会话身份，不能写验收清单')
    if (!current) throw new Error('这张卡现在没有执行会话，不能写验收清单')
    if (String(current.sessionId ?? '') !== sessionId) {
      throw new Error('只有这张卡当前的执行会话能写验收清单')
    }
    const texts = normalizeChecklistItems(items)
    task.checklist = texts.map(text => ({
      id: newId('k'),
      text,
      checked: false,
    }))
  }, options)
}

// B: a rejection moves the card back, records the reason and bumps rejectCount
// in one ledger write. When remember is true the rule is validated and written
// in that same write: a bad rule must not leave a half-applied rejection.
export function rejectTask(id, reason, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const task = findTask(ledger, id)
  if (options.ifVersion !== undefined && options.ifVersion !== null && task.version !== options.ifVersion) {
    throw new VersionConflict(id, options.ifVersion, task.version)
  }
  if (task.status !== 'in_review') throw new Error(`只有待验收的卡能打回，当前是 ${task.status}`)
  const text = String(reason ?? '').trim() || '请继续修改'
  const at = now()
  let prepared = null
  if (options.remember === true) prepared = prepareRule(ledger, task, text, at)
  const stamp = versionState(task)
  task.status = 'in_progress'
  // rejectCount is not a VERSION_FIELD: this change must not add a second
  // version bump on top of the status change.
  task.rejectCount = (Number(task.rejectCount) || 0) + 1
  if (!Array.isArray(task.comments)) task.comments = []
  task.comments.push({
    id: newId('c'),
    body: text,
    author: 'user',
    at,
  })
  commit(task, stamp)
  task.updatedBy = 'user'
  addRevision(ledger)
  writeLedger(ledger, file)
  return {
    task,
    rule: prepared?.rule ?? null,
    ruleDuplicate: Boolean(prepared?.duplicate),
  }
}

// B: rules are project data, not card fields. The key is the normalized
// workspace path; every directory owns at most 20 unique sentences.
export function acceptanceRulesFor(workspacePath, options = {}) {
  return rulesForPath(readLedger(options.file ?? ledgerPath()), workspacePath)
}

export function acceptanceRulesSnapshot(options = {}) {
  return rulesSnapshot(readLedger(options.file ?? ledgerPath()))
}

export function addAcceptanceRule(taskId, text, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const task = findTask(ledger, taskId)
  const prepared = prepareRule(ledger, task, text, now())
  if (!prepared.duplicate) {
    addRevision(ledger)
    writeLedger(ledger, file)
  }
  return {
    task,
    rule: prepared.rule,
    duplicate: prepared.duplicate,
    workspacePath: prepared.workspacePath,
  }
}

export function deleteAcceptanceRule(ruleId, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const removed = removeRule(ledger, ruleId)
  if (removed) {
    addRevision(ledger)
    writeLedger(ledger, file)
  }
  return removed
}

// C: the friction box. Rows are sanitized on the way in, capped at 200, and the
// oldest is dropped when the 201st arrives. No card and no notification.
export function addVent(input = {}, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const row = appendVent(ledger, input, now())
  addRevision(ledger)
  writeLedger(ledger, file)
  return row
}

export function listVents(options = {}) {
  const ledger = readLedger(options.file ?? ledgerPath())
  return { revision: ledger.revision ?? 0, vents: ventRows(ledger).slice() }
}

export function getVent(id, options = {}) {
  return findVent(readLedger(options.file ?? ledgerPath()), id)
}

export function getVentByRequestId(requestId, options = {}) {
  return findVentByRequestId(readLedger(options.file ?? ledgerPath()), requestId)
}

export function dismissVent(id, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const row = removeVent(ledger, id)
  if (row) {
    addRevision(ledger)
    writeLedger(ledger, file)
  }
  return row
}

export function ventsView(options = {}) {
  return ventsSnapshot(readLedger(options.file ?? ledgerPath()))
}

// ---------------------------------------------------------------------------
// S1: 派工记录（assignments）
//
// 一张卡同一时间最多一条不是 ended 的派工。老卡没有 assignments 时按空处理，
// 不做迁移脚本；读取方一律走 assignmentsOf/currentAssignment。
// ---------------------------------------------------------------------------

export function assignmentsOf(task) {
  return Array.isArray(task?.assignments) ? task.assignments : []
}

export function currentAssignment(task) {
  return assignmentsOf(task).filter(a => a && a.state !== 'ended').pop() ?? null
}

export function findTaskBySession(sessionId, options = {}) {
  if (!sessionId) return null
  const ledger = readLedger(options.file ?? ledgerPath())
  for (const task of ledger.tasks) {
    const assignment = assignmentsOf(task).find(a => a && a.sessionId === sessionId && a.state !== 'ended')
    if (assignment) return { task, assignment, ledger }
  }
  return null
}

export function patchAssignment(taskId, assignmentId, patch = {}, options = {}) {
  return withTask(taskId, task => {
    if (!Array.isArray(task.assignments)) task.assignments = []
    const assignment = task.assignments.find(a => a.id === assignmentId)
    if (!assignment) throw new Error(`assignment not found: ${assignmentId}`)
    applyFields(assignment, patch, ASSIGNMENT_FIELDS)
  }, options)
}

export function endAssignment(taskId, assignmentId, endReason = 'lost', options = {}) {
  if (!END_REASONS.includes(endReason)) throw new Error(`unknown endReason: ${endReason}`)
  return patchAssignment(taskId, assignmentId, {
    state: 'ended',
    endReason,
    endedAt: options.at ?? now(),
    waitingApproval: false,
  }, options)
}

export function endCurrentAssignment(taskId, endReason = 'lost', options = {}) {
  const task = getTask(taskId, options)
  const current = currentAssignment(task)
  if (!current) return null
  return endAssignment(taskId, current.id, endReason, options)
}

// 先写台账再动宿主：一张卡开始做时，派工记录和 start 动作在同一个写里落盘。
export function beginDispatch(taskId, input = {}, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const task = findTask(ledger, taskId)
  // Router 在 resolveModel 之后、真正落派工之前再核一次；检查和写入在
  // 同一个同步段里完成，没有 await 插进来。复核放在状态检查之前，取消/
  // 改卡这类失效会走 guard，而不是普通的「不能开始」错误。
  if (typeof input.guard === 'function') input.guard(task, ledger)
  if (!['backlog', 'todo', 'in_progress'].includes(task.status)) {
    throw new Error('只有排队、待办或进行中的卡能开始')
  }
  const stamp = versionState(task)
  if (currentAssignment(task)) throw new Error('这张卡已有未结束的派工')
  if (task.status === 'backlog') task.status = 'todo'
  if (task.status === 'todo') task.status = 'in_progress'

  const at = now()
  const cwd = normalizePath(input.cwd ?? task.workspacePath)
  const assignment = {
    id: newId('a'),
    sessionId: input.sessionId,
    // S4 5：只记「谁在做」的类型，任何逻辑都不读它。
    executor: { kind: 'dsh-session' },
    state: 'pending',
    createdAt: at,
    startedAt: null,
    lastEventAt: at,
    endedAt: null,
    lastTurn: null,
    lastReport: null,
    waitingApproval: false,
    endReason: null,
    cwd,
    provider: input.provider ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
  }
  if (!Array.isArray(task.assignments)) task.assignments = []
  task.assignments.push(assignment)

  const effect = {
    id: newId('fx'),
    kind: 'start',
    taskId,
    assignmentId: assignment.id,
    sessionId: assignment.sessionId,
    messageId: input.messageId,
    text: String(input.text ?? ''),
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: at,
    confirmedAt: null,
    cwd,
    provider: assignment.provider,
    model: assignment.model,
    reasoningEffort: assignment.reasoningEffort,
  }
  if (!Array.isArray(ledger.effects)) ledger.effects = []
  ledger.effects.push(effect)

  commit(task, stamp)
  task.updatedBy = input.by ?? 'system'
  addRevision(ledger)
  writeLedger(ledger, file)
  return { task, assignment, effect }
}

// 会话不在了：结束旧派工，新建一条派工和一句带上下文的开场白。
// 效果仍记成 deliver，这样启动失败时 stage 是「没送到」。
export function beginSuccessorDelivery(taskId, oldAssignmentId, input = {}, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const task = findTask(ledger, taskId)
  const stamp = versionState(task)
  if (!Array.isArray(task.assignments)) task.assignments = []

  if (oldAssignmentId) {
    const old = task.assignments.find(a => a.id === oldAssignmentId)
    if (old && old.state !== 'ended') {
      old.state = 'ended'
      old.endReason = 'superseded'
      old.endedAt = input.at ?? now()
      old.waitingApproval = false
    }
  }
  if (currentAssignment(task)) throw new Error('接班会话之前还有未结束的派工')

  const at = input.at ?? now()
  const cwd = normalizePath(input.cwd ?? task.workspacePath)
  const assignment = {
    id: newId('a'),
    sessionId: input.sessionId,
    // S4 5：只记「谁在做」的类型，任何逻辑都不读它。
    executor: { kind: 'dsh-session' },
    state: 'pending',
    createdAt: at,
    startedAt: null,
    lastEventAt: at,
    endedAt: null,
    lastTurn: null,
    lastReport: null,
    waitingApproval: false,
    endReason: null,
    cwd,
    provider: input.provider ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
  }
  task.assignments.push(assignment)
  if (task.status === 'in_review') task.status = 'in_progress'

  if (!Array.isArray(ledger.effects)) ledger.effects = []
  let effect
  if (input.effectId) {
    // 送话时发现会话不在了：把原来那条 deliver 动作指到新派工上，
    // 不另造一条，失败时仍按「没送到」呈现。
    effect = ledger.effects.find(e => e.id === input.effectId)
    if (!effect) throw new Error(`effect not found: ${input.effectId}`)
    Object.assign(effect, {
      kind: 'deliver',
      successor: true,
      assignmentId: assignment.id,
      sessionId: assignment.sessionId,
      messageId: input.messageId,
      text: String(input.text ?? ''),
      cwd,
      provider: assignment.provider,
      model: assignment.model,
      reasoningEffort: assignment.reasoningEffort,
    })
  } else {
    effect = {
      id: newId('fx'),
      kind: 'deliver',
      successor: true,
      taskId,
      assignmentId: assignment.id,
      sessionId: assignment.sessionId,
      messageId: input.messageId,
      text: String(input.text ?? ''),
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      createdAt: at,
      confirmedAt: null,
      cwd,
      provider: assignment.provider,
      model: assignment.model,
      reasoningEffort: assignment.reasoningEffort,
    }
    ledger.effects.push(effect)
  }

  commit(task, stamp)
  task.updatedBy = input.by ?? 'system'
  addRevision(ledger)
  writeLedger(ledger, file)
  return { task, assignment, effect }
}

// ---------------------------------------------------------------------------
// S1: 先记后做（effects）
// ---------------------------------------------------------------------------

export function listEffects(options = {}) {
  return readLedger(options.file ?? ledgerPath()).effects.slice()
}

export function getEffect(id, options = {}) {
  const effect = listEffects(options).find(e => e.id === id)
  if (!effect) throw new Error(`effect not found: ${id}`)
  return effect
}

export function createEffect(input = {}, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  if (!Array.isArray(ledger.effects)) ledger.effects = []
  const effect = {
    id: newId('fx'),
    kind: input.kind === 'deliver' ? 'deliver' : input.kind === 'notify' ? 'notify' : 'start',
    taskId: input.taskId,
    assignmentId: input.assignmentId ?? null,
    sessionId: input.sessionId ?? null,
    messageId: input.messageId,
    text: String(input.text ?? ''),
    state: 'pending',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    createdAt: now(),
    confirmedAt: null,
    ...(input.successor ? { successor: true } : {}),
    cwd: normalizePath(input.cwd),
    provider: input.provider ?? null,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
  }
  ledger.effects.push(effect)
  addRevision(ledger)
  writeLedger(ledger, file)
  return effect
}

export function patchEffect(id, patch = {}, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const effect = ledger.effects.find(e => e.id === id)
  if (!effect) throw new Error(`effect not found: ${id}`)
  applyFields(effect, patch, EFFECT_FIELDS)
  addRevision(ledger)
  writeLedger(ledger, file)
  return effect
}

// 宿主确认消息已投入：动作 confirmed，派工 running，清掉「等它交报告」的标记。
export function confirmEffect(effectId, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const effect = ledger.effects.find(e => e.id === effectId)
  if (!effect) throw new Error(`effect not found: ${effectId}`)
  const at = options.at ?? now()
  const task = ledger.tasks.find(t => t.id === effect.taskId)
  const stamp = task ? versionState(task) : undefined
  let assignment = null
  if (task) {
    assignment = assignmentsOf(task).find(a => a.id === effect.assignmentId) ?? null
  }
  // 已经结束的派工不因迟到确认复活；动作也保持原状，等人工/对账处理。
  if (assignment && assignment.state === 'ended') {
    return { effect, task, assignment, ignored: true }
  }
  if (effect.state !== 'confirmed') {
    effect.state = 'confirmed'
    effect.confirmedAt = at
    effect.lastError = null
    if (Number.isFinite(options.attempts)) effect.attempts = options.attempts
  }
  if (task) {
    if (assignment) {
      assignment.state = 'running'
      if (!assignment.startedAt) assignment.startedAt = at
      assignment.lastEventAt = at
      // 用户已经回应/新一轮已开始，旧报告不再代表当前状态。
      assignment.lastReport = null
    }
    task.blocked = false
    task.updatedBy = 'system'
    commit(task, stamp)
  }
  addRevision(ledger)
  writeLedger(ledger, file)
  return { effect, task, assignment, ignored: false }
}

export function failEffect(effectId, errorText, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const effect = ledger.effects.find(e => e.id === effectId)
  if (!effect) throw new Error(`effect not found: ${effectId}`)
  effect.state = 'failed'
  effect.lastError = String(errorText ?? '未知错误')
  effect.confirmedAt = null
  if (Number.isFinite(options.attempts)) effect.attempts = options.attempts
  const task = ledger.tasks.find(t => t.id === effect.taskId)
  const stamp = task ? versionState(task) : undefined
  if (task && (effect.kind === 'start' || effect.successor)) {
    const assignment = assignmentsOf(task).find(a => a.id === effect.assignmentId)
    if (assignment && assignment.state !== 'ended') {
      assignment.state = 'ended'
      assignment.endReason = 'lost'
      assignment.endedAt = options.at ?? now()
      assignment.waitingApproval = false
    }
    task.updatedBy = 'system'
    commit(task, stamp)
  }
  addRevision(ledger)
  writeLedger(ledger, file)
  return effect
}

// 跑动作的同一把活性尺：卡、派工、动作必须同时活着。
// 不活跃时在同一次读/写里把还开着的动作关掉，避免 catch/await 回来后把它
// 从 failed 又改回 pending。返回的 effect 是写完后的当前值。
export function settleEffectActivity(effectId, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const effect = ledger.effects.find(e => e.id === effectId)
  if (!effect) {
    return { active: false, closed: false, reason: '动作不存在', effect: null, task: null, assignment: null }
  }
  const task = ledger.tasks.find(t => t.id === effect.taskId) ?? null
  const stamp = task ? versionState(task) : undefined
  const assignment = task ? assignmentsOf(task).find(a => a.id === effect.assignmentId) ?? null : null
  const open = effect.state === 'pending' || effect.state === 'sent'
  const terminal = Boolean(task && TERMINAL_STATUSES.includes(task.status))
  const assignmentEnded = !assignment || assignment.state === 'ended'
  const active = Boolean(task && open && !terminal && !assignmentEnded)
  if (active) {
    return { active: true, closed: false, reason: '', effect, task, assignment }
  }

  const reason = String(options.reason ?? '卡片或动作已结束，停止执行')
  let closed = false
  if (open) {
    effect.state = 'failed'
    effect.lastError = reason
    effect.confirmedAt = null
    effect.nextAttemptAt = null
    if (task && terminal && assignment && assignment.state !== 'ended') {
      assignment.state = 'ended'
      assignment.endReason = task.status === 'done' ? 'done' : task.status === 'canceled' ? 'canceled' : 'lost'
      assignment.endedAt = now()
      assignment.waitingApproval = false
      task.updatedBy = 'system'
      commit(task, stamp)
    }
    addRevision(ledger)
    writeLedger(ledger, file)
    closed = true
  }
  return { active: false, closed, reason, effect, task, assignment }
}

function retireOpenEffects(ledger, taskId, reason) {
  let count = 0
  for (const effect of ledger.effects) {
    if (effect.taskId !== taskId) continue
    if (effect.state !== 'pending' && effect.state !== 'sent') continue
    effect.state = 'failed'
    effect.lastError = reason
    effect.confirmedAt = null
    effect.nextAttemptAt = null
    count += 1
  }
  return count
}

// 验收/取消和「退役未发动作」放在同一次台账写入里。
// 这样即使宿主会话的解析或释放还在 await，也不会有排队消息后脚发出去。
export function finishTask(taskId, target, options = {}) {
  if (target !== 'done' && target !== 'canceled') throw new Error(`finishTask 不支持 ${target}`)
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const task = findTask(ledger, taskId)
  const stamp = versionState(task)
  if (options.ifVersion !== undefined && options.ifVersion !== null && task.version !== options.ifVersion) {
    throw new VersionConflict(task.id, options.ifVersion, task.version)
  }
  let changed = false
  if (task.status !== target) {
    if (!(ALLOWED[task.status] ?? []).includes(target)) throw new InvalidTransition(task.status, target)
    task.status = target
    changed = true
  }
  const reason = target === 'done' ? '卡片已验收，动作不再执行' : '卡片已取消，动作不再执行'
  const effectsRetired = retireOpenEffects(ledger, taskId, reason)
  if (effectsRetired > 0) changed = true
  const assignment = currentAssignment(task)
  if (assignment) {
    assignment.state = 'ended'
    assignment.endReason = target === 'done' ? 'done' : 'canceled'
    assignment.endedAt = options.at ?? now()
    assignment.waitingApproval = false
    changed = true
  }
  if (changed) {
    task.updatedBy = 'system'
    commit(task, stamp)
    addRevision(ledger)
    writeLedger(ledger, file)
  }
  return { task, assignment, effectsRetired }
}

// 验收/取消之后异步返回时再对一次账：终态卡上不许再留 open 动作或 live 派工。
export function settleTerminalTask(taskId, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const task = ledger.tasks.find(t => t.id === taskId)
  if (!task || !TERMINAL_STATUSES.includes(task.status)) {
    return { settled: false, effectsRetired: 0, assignmentsEnded: 0 }
  }
  const stamp = versionState(task)
  let changed = false
  const effectsRetired = retireOpenEffects(ledger, taskId, '卡片已结束，动作不再执行')
  if (effectsRetired > 0) changed = true
  let assignmentsEnded = 0
  for (const assignment of assignmentsOf(task)) {
    if (!assignment || assignment.state === 'ended') continue
    assignment.state = 'ended'
    assignment.endReason = task.status === 'done' ? 'done' : task.status === 'canceled' ? 'canceled' : 'lost'
    assignment.endedAt = options.at ?? now()
    assignment.waitingApproval = false
    assignmentsEnded += 1
    changed = true
  }
  if (changed) {
    task.updatedBy = 'system'
    commit(task, stamp)
    addRevision(ledger)
    writeLedger(ledger, file)
  }
  return { settled: true, effectsRetired, assignmentsEnded }
}

// 取消卡片时把还没确认的动作一并作废；异步返回后不会再把卡带起来。
export function cancelEffectsForTask(taskId, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  let canceled = 0
  for (const effect of ledger.effects) {
    if (effect.taskId !== taskId) continue
    if (effect.state !== 'pending' && effect.state !== 'sent') continue
    effect.state = 'failed'
    effect.lastError = '卡片已取消，动作不再执行'
    effect.nextAttemptAt = null
    effect.confirmedAt = null
    canceled += 1
  }
  if (canceled > 0) {
    addRevision(ledger)
    writeLedger(ledger, file)
  }
  return canceled
}

// 重试一条 failed 的动作：动作回 pending，派工如果被记成 lost 也恢复。
export function resetEffectForRetry(effectId, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const effect = ledger.effects.find(e => e.id === effectId)
  if (!effect) throw new Error(`effect not found: ${effectId}`)
  if (effect.state !== 'failed') throw new Error('只有失败的动作能重试')
  effect.state = 'pending'
  effect.attempts = 0
  effect.lastError = null
  effect.nextAttemptAt = null
  effect.confirmedAt = null
  const task = ledger.tasks.find(t => t.id === effect.taskId)
  const stamp = task ? versionState(task) : undefined
  if (task && TERMINAL_STATUSES.includes(task.status)) {
    throw new Error('卡片已结束，不能重试')
  }
  if (task) {
    const assignment = assignmentsOf(task).find(a => a.id === effect.assignmentId)
    if (assignment && assignment.state === 'ended') {
      // 已经开了新派工时，旧动作只能保持终态，不能把两条派工同时复活。
      const otherLive = assignmentsOf(task).find(a => a.id !== assignment.id && a.state !== 'ended')
      if (otherLive) throw new Error('这张卡已有新的派工，旧动作不能重试')
      assignment.state = 'pending'
      assignment.endReason = null
      assignment.endedAt = null
      assignment.startedAt = null
      assignment.lastEventAt = now()
    }
    task.updatedBy = 'system'
    commit(task, stamp)
  }
  addRevision(ledger)
  writeLedger(ledger, file)
  return { effect, task }
}

// 已确认超过七天的动作可以清掉，台账不至于无限长。
export function pruneConfirmedEffects(options = {}) {
  const file = options.file ?? ledgerPath()
  const olderThanMs = options.olderThanMs ?? 7 * 24 * 60 * 60_000
  const cutoff = (options.now ?? now()) - olderThanMs
  const ledger = readLedger(file)
  const before = ledger.effects.length
  ledger.effects = ledger.effects.filter(
    effect => !(effect.state === 'confirmed' && (effect.confirmedAt ?? effect.createdAt ?? 0) < cutoff),
  )
  const removed = before - ledger.effects.length
  if (removed > 0) {
    addRevision(ledger)
    writeLedger(ledger, file)
  }
  return removed
}

// ---------------------------------------------------------------------------
// S3: Router 设置、日志、抢占与落卡模式
//
// Router 的设置放在台账顶层 router 对象里；没有这个字段时按 observe 处理。
// 环境变量 DSH_SUPERAGENT_ROUTER 优先于台账（用来紧急停掉），它只影响本次
// 进程的生效档位，不写回台账。
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function rawRouter(ledger) {
  return ledger && typeof ledger.router === 'object' && ledger.router !== null ? ledger.router : {}
}

function storedRouter(ledger) {
  const raw = rawRouter(ledger)
  return {
    mode: ROUTER_MODES.includes(raw.mode) ? raw.mode : 'observe',
    maxRunning: clampInt(raw.maxRunning, 1, 5, ROUTER_DEFAULT_MAX),
    stuckMinutes: clampInt(raw.stuckMinutes, 1, 24 * 60, ROUTER_DEFAULT_STUCK_MINUTES),
    sameDir: raw.sameDir === 'allow' ? 'allow' : 'wait',
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
  }
}

export function routerEnvOverride() {
  const value = String(process.env.DSH_SUPERAGENT_ROUTER ?? '').trim().toLowerCase()
  return ROUTER_MODES.includes(value) ? value : null
}

// 生效档位 = 环境变量（有就优先）> 台账 > observe。
export function readRouter(file = ledgerPath()) {
  const stored = storedRouter(readLedger(file))
  const override = routerEnvOverride()
  return {
    ...stored,
    mode: override ?? stored.mode,
    storedMode: stored.mode,
    storedMaxRunning: stored.maxRunning,
    source: override ? 'env' : 'ledger',
  }
}

// 只写档位/上限；日志和抢占记录原样保留，不因改设置丢掉。
export function updateRouter(patch = {}, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const raw = rawRouter(ledger)
  const current = storedRouter(ledger)
  const next = { ...current }
  if (patch.mode !== undefined) {
    if (!ROUTER_MODES.includes(patch.mode)) throw new Error(`unknown router mode: ${patch.mode}`)
    next.mode = patch.mode
  }
  if (patch.maxRunning !== undefined) {
    const number = Number(patch.maxRunning)
    if (!Number.isInteger(number) || number < 1 || number > 5) {
      throw new Error('同时最多跑几件只能是 1 到 5 之间的整数')
    }
    next.maxRunning = number
  }
  if (patch.stuckMinutes !== undefined) {
    next.stuckMinutes = clampInt(patch.stuckMinutes, 1, 24 * 60, current.stuckMinutes)
  }
  if (patch.sameDir !== undefined) {
    if (patch.sameDir !== 'wait' && patch.sameDir !== 'allow') {
      throw new Error('同一个目录同时只跑一件只能是 wait 或 allow')
    }
    next.sameDir = patch.sameDir
  }
  ledger.router = {
    ...raw,
    mode: next.mode,
    maxRunning: next.maxRunning,
    stuckMinutes: next.stuckMinutes,
    sameDir: next.sameDir,
    updatedAt: now(),
  }
  addRevision(ledger)
  writeLedger(ledger, file)
  return ledger.router
}

// 观察档的「本来会开始」和每次调度结果都记在这里；最多保留 200 条。
export function appendRouterLog(entries, options = {}) {
  const rows = (Array.isArray(entries) ? entries : [entries]).filter(Boolean)
  if (!rows.length) return 0
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const raw = rawRouter(ledger)
  const log = Array.isArray(raw.log) ? raw.log.slice() : []
  for (const row of rows) {
    log.push({ at: Number.isFinite(row.at) ? row.at : now(), ...row })
  }
  ledger.router = { ...raw, log: log.slice(-ROUTER_LOG_LIMIT) }
  addRevision(ledger)
  writeLedger(ledger, file)
  return rows.length
}

// 开工前的条件写：台账 revision 没变才把要开工的卡写进 router.claimed。
// 返回 ok:false 表示这一轮放弃，等下一次调度。
export function claimRouterTasks(taskIds, expectedRevision, options = {}) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : []).map(String).filter(Boolean))]
  if (!ids.length) return { ok: true, claimed: [], revision: expectedRevision }
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const revision = ledger.revision ?? 0
  if (revision !== expectedRevision) return { ok: false, claimed: [], revision }
  const raw = rawRouter(ledger)
  const at = options.at ?? now()
  const claimed = { ...(raw.claimed && typeof raw.claimed === 'object' ? raw.claimed : {}) }
  for (const id of ids) claimed[id] = { at, by: 'router', state: 'starting' }
  const rows = Object.entries(claimed).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, ROUTER_LOG_LIMIT)
  ledger.router = { ...raw, claimed: Object.fromEntries(rows) }
  addRevision(ledger)
  writeLedger(ledger, file)
  return { ok: true, claimed: ids, revision: ledger.revision ?? 0 }
}

// 一轮开工结束后把抢占记录改成 started / failed。失败的卡在用户改动它之前
// 不再自动重试（S3：开工失败走 S1 的「没启动」，Router 不自动重试）。
export function updateRouterClaim(taskId, patch = {}, options = {}) {
  const id = String(taskId ?? '')
  if (!id) return null
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const raw = rawRouter(ledger)
  const claimed = { ...(raw.claimed && typeof raw.claimed === 'object' ? raw.claimed : {}) }
  const current = claimed[id] ?? { at: options.at ?? now(), by: 'router' }
  claimed[id] = { ...current, ...patch }
  ledger.router = { ...raw, claimed }
  addRevision(ledger)
  writeLedger(ledger, file)
  return claimed[id]
}

// 开工前的复核没过：把抢占记录撤掉，卡仍留在排队里等下一轮。
export function releaseRouterClaim(taskId, options = {}) {
  const id = String(taskId ?? '')
  if (!id) return null
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const raw = rawRouter(ledger)
  const claimed = { ...(raw.claimed && typeof raw.claimed === 'object' ? raw.claimed : {}) }
  if (!(id in claimed)) return null
  delete claimed[id]
  ledger.router = { ...raw, claimed }
  addRevision(ledger)
  writeLedger(ledger, file)
  return id
}

// Router 的调度日志（只读）。面板用它写观察档的原因。
export function readRouterLog(file = ledgerPath()) {
  const raw = rawRouter(readLedger(file))
  return Array.isArray(raw.log) ? raw.log.slice() : []
}

// 读 Router 最近一次「本来会开始」的记录时间。
export function routerWouldStartAt(file, taskId) {
  const hit = readRouterLog(file)
    .filter(row => row && row.taskId === taskId && row.would === 'start')
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
  return hit?.at ?? null
}

// 落卡模式（公开预览首发默认 explicit）：
// - explicit：只听本人明确的「记一下／放到待办」，不叫模型、不写待确认；
// - message / turn：旧的分类路径，只在显式开启（capture.optIn === true）时生效。
// 无配置、坏值、旧台账（没有 optIn）一律按 explicit 处理。公开 README 不提供
// 开启指令；这条路径仍保留给内部配置与回归测试。
const CAPTURE_MODES = new Set(['explicit', 'message', 'turn'])

export function readCapture(file = ledgerPath()) {
  const ledger = readLedger(file)
  const raw = ledger?.capture && typeof ledger.capture === 'object' ? ledger.capture : {}
  const optedIn = raw.optIn === true && CAPTURE_MODES.has(raw.mode) && raw.mode !== 'explicit'
  return { mode: optedIn ? raw.mode : 'explicit' }
}

// 写入本身就是显式配置：默认把 optIn 置真，只有明确传 false 才关闭。
export function updateCapture(patch = {}, options = {}) {
  const file = options.file ?? ledgerPath()
  const ledger = readLedger(file)
  const raw = ledger.capture && typeof ledger.capture === 'object' ? ledger.capture : {}
  const mode = patch.mode === 'turn' ? 'turn' : patch.mode === 'message' ? 'message' : 'explicit'
  const optIn = patch.optIn === false ? false : true
  ledger.capture = { ...raw, mode, optIn, updatedAt: now() }
  addRevision(ledger)
  writeLedger(ledger, file)
  return ledger.capture
}

// 「排进去」：把卡写回队列表，并明确标成自动排队（queue.auto）。
export function setTaskQueue(id, input = {}, options = {}) {
  return withTask(id, task => {
    task.queue = normalizeQueue(input)
    if (task.queue && !task.needsNod) {
      task.needsNod = normalizeNeedsNod(detectNod(task.title, task.description))
    }
  }, options)
}

// S3 2：用户点了「可以做」。只记点头，不动状态；Router 会在下一次调度里
// 把它当成可开工的自动卡（有空位就开始）。
export function nodTask(id, input = {}, options = {}) {
  return withTask(id, task => {
    if (TERMINAL_STATUSES.includes(task.status)) throw new Error('这张卡已经结束了，不用再点头')
    if (task.status === 'backlog') throw new Error('这张卡在「以后再说」里，先排进去再点头')
    task.nodded = { at: Number.isFinite(input.at) ? input.at : now(), by: 'user' }
  }, options)
}

// S4 2：设置这张卡等谁。空数组表示不再等；校验不通过就报可读的错。
export function setTaskDepends(id, input = [], options = {}) {
  return withTask(id, (task, ledger) => {
    task.dependsOn = normalizeDepends(input, ledger.tasks, task.id)
  }, options)
}

// Router 在选中候选时才发现老卡命中要点头的词，补写一次；只补空值。
export function setTaskNeedsNod(id, needsNod, options = {}) {
  return withTask(id, task => {
    if (task.needsNod) return
    task.needsNod = normalizeNeedsNod(needsNod)
  }, options)
}

const ASSIGNMENT_FIELDS = [
  'state', 'startedAt', 'lastEventAt', 'endedAt', 'lastTurn', 'lastReport',
  'waitingApproval', 'endReason', 'lastError', 'nudgedAt',
]

const EFFECT_FIELDS = [
  'state', 'attempts', 'nextAttemptAt', 'lastError', 'confirmedAt',
  'sessionId', 'assignmentId', 'messageId', 'text', 'successor',
  'provider', 'model', 'reasoningEffort', 'cwd',
]

function applyFields(target, patch, allowed) {
  for (const key of allowed) {
    if (patch[key] !== undefined) target[key] = patch[key]
  }
}
