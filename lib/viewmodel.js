// dsh-superagent view model — one snapshot, five groups, no second opinion.
//
// Every number and every button on the panel comes from this file. The client
// only draws; it never decides a stage, an action or a count. The stage is
// computed on every read, never stored.
//
// S2 shape: counts + groups + pending + workspaces. Each card carries the
// actions a person can take, so the panel cannot invent one the server would
// reject (or hide one the server supports).

import { listPending, listTasks, readRouter, readRouterLog } from './ledger.js'
import { nodReason } from './nod.js'
import { listWorkspaces, workspaceLabel } from './workspace.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const GROUP_ORDER = ['waiting', 'running', 'queued', 'later', 'doneToday']

export const STAGE_GROUPS = {
  closed: 'doneToday',
  not_started: 'waiting',
  not_delivered: 'waiting',
  approval: 'waiting',
  question: 'waiting',
  review: 'waiting',
  nod: 'waiting',
  stuck: 'waiting',
  silent: 'waiting',
  working: 'running',
  later: 'later',
  queued: 'queued',
}

// 「等你」里的先后：没启动、没送到、等批准、等回答、等验收、卡住、没交结果。
export const WAITING_ORDER = [
  'not_started',
  'not_delivered',
  'approval',
  'question',
  'review',
  'nod',
  'stuck',
  'silent',
]

const URGENCY_RANK = { urgent: 0, normal: 1, relaxed: 2 }

const END_KIND_TEXT = {
  completed: '正常结束',
  aborted: '被打断',
  blocked: '被拦下',
  error: '出错',
  'max-tokens': '超出长度',
  interrupted: '中断',
}

function relative(now, at) {
  if (!at) return ''
  const diff = now - at
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.round(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.round(diff / HOUR)} 小时前`
  return `${Math.round(diff / DAY)} 天前`
}

function assignmentsOf(task) {
  return Array.isArray(task?.assignments) ? task.assignments : []
}

function liveAssignment(task) {
  return assignmentsOf(task).filter(a => a && a.state !== 'ended').pop() ?? null
}

function endText(lastTurn) {
  if (!lastTurn) return '没有记录'
  const label = END_KIND_TEXT[lastTurn.endKind] ?? String(lastTurn.endKind ?? '未知原因')
  return lastTurn.detail ? `${label}（${lastTurn.detail}）` : label
}

function sessionShort(sessionId) {
  const text = String(sessionId ?? '')
  if (!text) return ''
  return text.length > 4 ? `…${text.slice(-4)}` : text
}

function whoOf(current, now) {
  if (!current?.sessionId) return ''
  const short = sessionShort(current.sessionId)
  if (current.state === 'pending') return `会话 ${short} · 正在起会话`
  const ago = relative(now, current.lastEventAt)
  if (ago) return `会话 ${short} · ${ago}有动静`
  return `会话 ${short}`
}

function cardResult(task, stage, reason, current, now) {
  return {
    stage,
    group: STAGE_GROUPS[stage] ?? 'waiting',
    reason,
    sessionId: current?.sessionId ?? null,
    lastEventAt: current?.lastEventAt ?? null,
    lastEventAgo: relative(now, current?.lastEventAt),
    workspacePath: task.workspacePath ?? null,
  }
}

// The stage rules are S1's and do not move in S2.
export function stageOf(task, context = {}) {
  const now = context.now ?? Date.now()
  const stuckMinutes = Number.isFinite(context.stuckMinutes) ? context.stuckMinutes : 20
  // off 档要和 S2 完全一样：不做「长时间没动静」的判断。
  const stuckEnabled = context.stuckEnabled !== false
  const effects = (context.effects ?? []).filter(effect => effect && effect.taskId === task.id)
  const current = liveAssignment(task)
  // 只看最近一条同类动作：重试或重新开始之后，旧的失败不该继续压着这张卡。
  const latest = kind => effects
    .filter(effect => effect.kind === kind)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    .at(-1) ?? null
  const lastStart = latest('start')
  const lastDeliver = latest('deliver')
  const failedStart = lastStart?.state === 'failed' ? lastStart : null
  const failedDeliver = lastDeliver?.state === 'failed' ? lastDeliver : null

  if (['done', 'canceled', 'archived'].includes(task.status)) {
    const reason = task.status === 'done' ? '已完成' : task.status === 'canceled' ? '已取消' : '已归档'
    return cardResult(task, 'closed', reason, current, now)
  }
  if (failedStart) {
    const reason = failedStart.lastError || '没启动'
    return cardResult(task, 'not_started', `没启动：${reason}`, current, now)
  }
  if (failedDeliver) {
    const reason = failedDeliver.lastError || '没送到'
    return cardResult(task, 'not_delivered', `没送到：${reason}`, current, now)
  }
  if (current?.waitingApproval) {
    const where = current.sessionId ? `去会话 ${sessionShort(current.sessionId)} 里批准` : '去那个会话里批准'
    return cardResult(task, 'approval', `停在一个操作上，${where}`, current, now)
  }
  if (task.openQuestion) {
    return cardResult(task, 'question', `等你回答：${task.openQuestion.text}`, current, now)
  }
  if (task.status === 'in_review') {
    return cardResult(task, 'review', '做完了，等你验收', current, now)
  }
  // S3 2：自动排队的卡命中花钱/对外/权限的词，先停下来等用户点头。
  if (
    !current
    && task.status !== 'backlog'
    && task.queue?.auto === true
    && task.needsNod
    && !task.nodded
  ) {
    return cardResult(task, 'nod', nodReason(task.needsNod), current, now)
  }
  if (task.blocked) {
    return cardResult(task, 'stuck', '卡住了，需要你处理', current, now)
  }
  if (current?.state === 'idle' && current.lastTurn?.endKind !== 'completed') {
    const reason = `它 ${relative(now, current.lastTurn?.at)}结束了一轮，原因：${endText(current.lastTurn)}`
    return cardResult(task, 'stuck', reason, current, now)
  }
  if (current?.state === 'idle' && current.lastTurn?.endKind === 'completed') {
    const last = current.lastReport
    if (!last || last.outcome === 'progress') {
      const reason = current.nudgedAt
        ? '催过一次，还是没交结果'
        : '它结束了上一轮，没交结果'
      return cardResult(task, 'silent', reason, current, now)
    }
  }
  // S3 3.2：跑着但很久没有动静，可能在等审批或已经卡住。给用户一个可看的去处。
  if (stuckEnabled && current?.state === 'running' && Number.isFinite(current.lastEventAt)) {
    const quietMs = now - current.lastEventAt
    if (quietMs > stuckMinutes * MINUTE) {
      const short = sessionShort(current.sessionId)
      return cardResult(
        task,
        'stuck',
        `${stuckMinutes} 分钟没有动静，可能停在审批或卡住了，去会话 ${short || '…'} 看看`,
        current,
        now,
      )
    }
  }
  if (
    (current && (current.state === 'pending' || current.state === 'running'))
    || (current?.state === 'idle' && current.lastReport?.outcome === 'waiting')
  ) {
    const reason = current.state === 'pending' ? '已记下，正在启动' : current.state === 'running' ? '正在跑' : '在等外部'
    return cardResult(task, 'working', reason, current, now)
  }
  if (task.status === 'backlog') {
    return cardResult(task, 'later', '以后再说', current, now)
  }
  return cardResult(task, 'queued', '排队中', current, now)
}

function effectAt(taskId, effects, kind, state) {
  return (effects ?? [])
    .filter(effect => effect.taskId === taskId && effect.kind === kind && effect.state === state)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null
}

// 「等得久」的起点：能说清是什么时候进入这个阶段的，就用那个时间。
function waitingSince(task, stage, effects) {
  const current = liveAssignment(task)
  if (stage === 'not_started') {
    return effectAt(task.id, effects, 'start', 'failed')?.createdAt ?? task.updatedAt ?? 0
  }
  if (stage === 'not_delivered') {
    return effectAt(task.id, effects, 'deliver', 'failed')?.createdAt ?? task.updatedAt ?? 0
  }
  if (stage === 'approval') return current?.lastEventAt ?? task.updatedAt ?? 0
  if (stage === 'question') return task.openQuestion?.askedAt ?? task.updatedAt ?? 0
  if (stage === 'review') return current?.lastReport?.at ?? task.updatedAt ?? 0
  if (stage === 'stuck' || stage === 'silent') {
    return current?.lastTurn?.at ?? current?.lastEventAt ?? task.updatedAt ?? 0
  }
  return task.updatedAt ?? 0
}

function action(action, label, options = {}) {
  return {
    action,
    label,
    primary: Boolean(options.primary),
    needsText: Boolean(options.needsText),
    ...(options.preset ? { preset: options.preset } : {}),
  }
}

export function actionsFor(task, info, context = {}) {
  const needsWorkspace = Boolean(context.needsWorkspace)
  const question = task.openQuestion ?? null
  switch (info.stage) {
    case 'not_started':
      return [action('retry', '再试一次', { primary: true }), action('cancel', '不做了')]
    case 'not_delivered':
      return [action('retry', '再送一次', { primary: true }), action('cancel', '不做了')]
    case 'approval':
      // 面板不能替用户批准，只能引导去那个会话；取消是唯一的卡片动作。
      return [action('cancel', '不做了')]
    case 'question': {
      const list = []
      const options = Array.isArray(question?.options) ? question.options : []
      options.forEach((option, index) => {
        list.push(action('answer', option, { primary: index === 0, preset: option }))
      })
      list.push(action('answer', '自己写', { primary: options.length === 0, needsText: true }))
      list.push(action('cancel', '不做了'))
      return list
    }
    case 'review':
      return [
        action('accept', '验收', { primary: true }),
        action('reject', '打回', { needsText: true }),
        action('cancel', '不做了'),
      ]
    case 'nod':
      return [
        action('nod', '可以做', { primary: true }),
        action('later', '以后再说'),
        action('cancel', '不做了'),
      ]
    case 'stuck':
      return [
        action('comment', '告诉它怎么办', { primary: true, needsText: true }),
        action('cancel', '不做了'),
      ]
    case 'silent':
      return [
        action('comment', '催一下', {
          primary: true,
          needsText: true,
          preset: '你上一轮停下了但没交报告。请用 sa_report 说明现在的情况。',
        }),
        action('cancel', '不做了'),
      ]
    case 'working':
      return [
        action('comment', '补一句', { primary: true, needsText: true }),
        action('cancel', '不做了'),
      ]
    case 'queued':
      return [
        action('start', needsWorkspace ? '选个目录并开始' : '开始', { primary: true }),
        action('later', '以后再说'),
      ]
    case 'later':
      return [
        action('queue', '排进去', { primary: true }),
        action('start', needsWorkspace ? '选个目录并开始' : '现在就做'),
      ]
    default:
      return []
  }
}

function cardOf(task, info, now) {
  const current = liveAssignment(task)
  const workspacePath = task.workspacePath ?? null
  const closed = ['done', 'canceled', 'archived'].includes(task.status)
  const needsWorkspace = !closed && !current && !workspacePath
  const question = task.openQuestion
    ? {
        text: String(task.openQuestion.text ?? ''),
        options: Array.isArray(task.openQuestion.options) ? task.openQuestion.options.slice() : [],
      }
    : null
  return {
    id: task.id,
    title: task.title,
    version: task.version ?? 0,
    urgency: task.urgency ?? 'normal',
    stage: info.stage,
    group: info.group,
    reason: info.reason,
    who: whoOf(current, now),
    workspacePath,
    workspaceLabel: workspaceLabel(workspacePath),
    needsWorkspace,
    // S3：这张卡是不是自动排队的，以及在自动队列里排第几。
    auto: Boolean(task.queue && task.queue.auto === true),
    position: null,
    question,
    actions: actionsFor(task, info, { needsWorkspace }),
  }
}

// S3：自动队列的先后必须和 Router 一致：紧急的在前，再按进队时间从早到晚。
function queueSort(a, b) {
  const urgency = (URGENCY_RANK[a.card.urgency] ?? 1) - (URGENCY_RANK[b.card.urgency] ?? 1)
  if (urgency !== 0) return urgency
  const aAt = a.task.queue?.at ?? a.task.createdAt ?? 0
  const bAt = b.task.queue?.at ?? b.task.createdAt ?? 0
  if (aAt !== bAt) return aAt - bAt
  return String(a.card.id).localeCompare(String(b.card.id))
}

function clockLabel(at) {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

// 排队组里每张卡的说明。自动排队的卡由 Router 的三档和空位决定；
// 老卡（没有 queue 字段）永远只写「要你点开始」。
function queuedReason(entry, context) {
  if (!entry.card.auto) return '要你点开始'
  if (!entry.card.workspacePath) {
    // 只有自动档才能承诺「定了就开始」；观察/关档不许写「会自动开始」。
    return context.mode === 'auto'
      ? '还没定在哪做，定了就会自动开始'
      : '还没定在哪做，定了也不会自己开工'
  }
  const { mode, free, position, wouldAt } = context
  if (mode === 'off') return '排队中，自动开工已关'
  if (mode === 'observe') {
    return wouldAt ? `观察中：本来会在 ${clockLabel(wouldAt)} 开始` : '观察中：等下一次调度'
  }
  if (position !== null && position <= free) return '排队中'
  if (position !== null) return `排在第 ${position} 个，有空位就开始`
  return '排队中'
}

function groupSort(a, b) {
  if (a.card.group === 'waiting' || b.card.group === 'waiting') {
    const rank = WAITING_ORDER.indexOf(a.card.stage) - WAITING_ORDER.indexOf(b.card.stage)
    if (rank !== 0) return rank
    const urgency = (URGENCY_RANK[a.card.urgency] ?? 1) - (URGENCY_RANK[b.card.urgency] ?? 1)
    if (urgency !== 0) return urgency
    if (a.since !== b.since) return a.since - b.since
  }
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return String(a.card.id).localeCompare(String(b.card.id))
}

export function buildView(ledgerOptions = {}) {
  const at = Date.now()
  const { tasks, effects = [], revision: taskRevision } = listTasks({ includeArchived: true }, ledgerOptions)
  const pendingResult = listPending(ledgerOptions)
  const pendingRows = Array.isArray(pendingResult.pending) ? pendingResult.pending : []
  const pendingRevision = pendingResult.revision ?? 0

  const file = ledgerOptions.file
  const router = readRouter(file)
  const wouldStartAt = new Map()
  for (const row of readRouterLog(file)) {
    if (row?.would !== 'start' || typeof row.taskId !== 'string') continue
    const previous = wouldStartAt.get(row.taskId) ?? 0
    if ((row.at ?? 0) > previous) wouldStartAt.set(row.taskId, row.at ?? 0)
  }

  const entries = tasks.map(task => {
    const info = stageOf(task, {
      effects,
      now: at,
      stuckMinutes: router.stuckMinutes,
      stuckEnabled: router.mode !== 'off',
    })
    const card = cardOf(task, info, at)
    return {
      task,
      card,
      since: waitingSince(task, info.stage, effects),
      updatedAt: task.updatedAt ?? 0,
    }
  })

  // 空位与自动队列的位置：只算「排队中、自动、有目录、不需要点头」的卡。
  const running = entries.filter(entry => entry.card.stage === 'working').length
  const free = Math.max(0, router.maxRunning - running)
  const autoQueue = entries
    .filter(entry => entry.card.stage === 'queued' && entry.card.auto)
    .sort(queueSort)
  const ready = autoQueue.filter(entry => entry.card.workspacePath)
  ready.forEach((entry, index) => { entry.card.position = index + 1 })
  for (const entry of autoQueue) {
    entry.card.reason = queuedReason(entry, {
      mode: router.mode,
      free,
      position: entry.card.position,
      wouldAt: wouldStartAt.get(entry.card.id) ?? null,
    })
  }
  // 老卡没有 queue 字段：照旧算排队，但要标成手动。off 档保持 S2 原样。
  if (router.mode !== 'off') {
    for (const entry of entries) {
      if (entry.card.stage === 'queued' && !entry.card.auto) entry.card.reason = '要你点开始'
    }
  }

  const buckets = Object.fromEntries(GROUP_ORDER.map(key => [key, []]))
  for (const entry of entries) {
    const { task, card } = entry
    if (card.stage === 'closed') {
      // 只有 24 小时内做完的进「今天做完」；更早的 done、canceled、archived 不进任何组。
      if (task.status === 'done' && at - (task.updatedAt ?? 0) < DAY) {
        buckets.doneToday.push(entry)
      }
      continue
    }
    if (buckets[card.group]) buckets[card.group].push(entry)
  }

  // 排队组：自动排队的在前（第 1 个在最上面），老卡在后，各自按原规则排。
  if (buckets.queued.length) {
    const automatic = buckets.queued.filter(entry => entry.card.auto).sort(queueSort)
    const manual = buckets.queued.filter(entry => !entry.card.auto).sort(groupSort)
    buckets.queued = [...automatic, ...manual]
  }
  const groups = Object.fromEntries(
    GROUP_ORDER.map(key => [
      key,
      (key === 'queued' ? buckets[key] : buckets[key].sort(groupSort)).map(entry => entry.card),
    ]),
  )

  const counts = Object.fromEntries(GROUP_ORDER.map(key => [key, groups[key].length]))
  const workspaces = listWorkspaces(tasks, { limit: 8 })

  const taskTitles = new Map(tasks.map(task => [task.id, task.title]))
  const pending = pendingRows
    .slice()
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .map(row => {
      const suggestedTaskId = row.suggestedTaskId ?? null
      return {
        id: row.id,
        text: String(row.text ?? ''),
        title: String(row.title ?? '').trim() || String(row.text ?? '').slice(0, 80),
        ago: relative(at, row.at),
        workspacePath: row.workspacePath ?? null,
        workspaceLabel: workspaceLabel(row.workspacePath),
        // S3 4：有计划补到某张卡上时，面板把「记下」换成「补到那张卡上」。
        suggestedTaskId,
        suggestedTitle: suggestedTaskId ? taskTitles.get(suggestedTaskId) ?? null : null,
        attach: Boolean(suggestedTaskId),
      }
    })

  return {
    at,
    revision: Math.max(taskRevision ?? 0, pendingRevision ?? 0),
    counts,
    groups,
    pending,
    workspaces,
    defaultWorkspace: workspaces[0]?.path ?? null,
    // S3：面板「排队」组头读这一个字段，不再猜。
    router: {
      mode: router.mode,
      maxRunning: router.maxRunning,
      running,
      free,
      stuckMinutes: router.stuckMinutes,
      updatedAt: router.updatedAt,
      source: router.source,
    },
    // 兼容 S1 的测试与调用方；面板只读 groups。
    cards: entries.map(entry => entry.card),
  }
}

function isoAt(value) {
  return value ? new Date(value).toISOString() : null
}

// 详情抽屉：描述、验收清单、留言、每一份报告、每一条派工。
export function buildCardDetail(task, context = {}) {
  const now = context.now ?? Date.now()
  const effects = context.effects ?? []
  const info = stageOf(task, { effects, now })
  const card = cardOf(task, info, now)
  return {
    ...card,
    status: task.status,
    description: String(task.description ?? ''),
    createdAt: isoAt(task.createdAt),
    updatedAt: isoAt(task.updatedAt),
    checklist: (Array.isArray(task.checklist) ? task.checklist : []).map(item => ({
      id: item.id,
      text: String(item.text ?? ''),
      checked: Boolean(item.checked),
      note: item.note ? String(item.note) : null,
    })),
    comments: (Array.isArray(task.comments) ? task.comments : []).map(comment => ({
      id: comment.id ?? null,
      author: comment.author ?? 'agent',
      body: String(comment.body ?? ''),
      at: isoAt(comment.at),
    })),
    executions: (Array.isArray(task.executions) ? task.executions : []).map(execution => ({
      id: execution.id ?? null,
      state: execution.state ?? execution.outcome ?? null,
      outcome: execution.outcome ?? execution.state ?? null,
      summary: String(execution.summary ?? ''),
      changedFiles: Array.isArray(execution.changedFiles) ? execution.changedFiles : [],
      checks: Array.isArray(execution.checks) ? execution.checks : [],
      risk: String(execution.risk ?? ''),
      at: isoAt(execution.at),
      sessionId: execution.sessionId ?? null,
    })),
    assignments: assignmentsOf(task).map(assignment => ({
      id: assignment.id,
      sessionId: assignment.sessionId ?? null,
      state: assignment.state ?? null,
      createdAt: isoAt(assignment.createdAt),
      startedAt: isoAt(assignment.startedAt),
      endedAt: isoAt(assignment.endedAt),
      endReason: assignment.endReason ?? null,
      waitingApproval: Boolean(assignment.waitingApproval),
      lastTurn: assignment.lastTurn ? {
        turn: assignment.lastTurn.turn ?? null,
        endKind: assignment.lastTurn.endKind ?? null,
        detail: assignment.lastTurn.detail ?? '',
        at: isoAt(assignment.lastTurn.at),
      } : null,
      lastReport: assignment.lastReport ? {
        outcome: assignment.lastReport.outcome ?? null,
        at: isoAt(assignment.lastReport.at),
      } : null,
    })),
  }
}
