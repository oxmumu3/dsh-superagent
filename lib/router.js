// dsh-superagent router — 排队、空位与自动开工。
//
// 所有开工都走 S1 的 engine.startTask（先记后做）：这里只决定「现在该开哪
// 几张」，不自己建会话、不自己写派工。三档：
//   off     完全不动，行为和 S2 一样
//   observe 照常算，只记「本来会开始」，不开工
//   auto    有空位就开工，同时最多 maxRunning 张
//
// 老卡没有 queue 字段，一律按「要你点开始」处理；Router 只碰 queue.auto 为真
// 的卡（S3 0.1）。调度失败不自动重试，交给 S1 原有的「没启动」路径。

import {
  listTasks,
  readRouter,
  routerEnvOverride,
  appendRouterLog,
  claimRouterTasks,
  updateRouterClaim,
  releaseRouterClaim,
  readLedger,
  patchAssignment,
  currentAssignment,
} from './ledger.js'
import { stageOf } from './viewmodel.js'
import { overlaps } from './workspace.js'

const MINUTE = 60_000
export const ROUTER_DEBOUNCE_MS = 1_000
export const ROUTER_TICK_MS = 30_000

// S2 的催一下预设文字：Router 自动催一次时原样投递。
export const NUDGE_TEXT = '你上一轮停下了但没交报告。请用 sa_report 说明现在的情况。'

const URGENCY_RANK = { urgent: 0, normal: 1, relaxed: 2 }

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? '未知错误')
}

function clockLabel(at) {
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

function isAutoQueued(task) {
  return Boolean(task && task.queue && task.queue.auto === true)
}

function needsNodding(task) {
  return Boolean(task && task.needsNod && !task.nodded)
}

// 抢占记录的两道闸：starting 只挡很短一段时间（防两个调度同时开工）；
// failed 一直挡到用户改动这张卡（updatedAt 晚于失败时间）为止。
function claimBlocks(task, claims, now) {
  const claim = task && claims ? claims[task.id] : null
  if (!claim || typeof claim !== 'object') return false
  if (claim.state === 'starting') return now - (claim.at ?? 0) < 5 * MINUTE
  if (claim.state === 'failed') return (claim.at ?? 0) >= (task.updatedAt ?? 0)
  return false
}

// 当前真正占着目录的在跑卡：阶段用 stageOf 算，目录用活动派工的实际 cwd
// （手动开始可以指定和卡上不同的目录）。Router 计划和开工前复核共用这一份。
export function workingOccupancy(tasks = [], effects = [], now = Date.now()) {
  const workingTasks = (Array.isArray(tasks) ? tasks : [])
    .filter(task => task && stageOf(task, { effects, now, tasks }).stage === 'working')
  return {
    running: workingTasks.length,
    working: workingTasks
      .map(task => ({
        taskId: task.id,
        title: task.title,
        workspacePath: currentAssignment(task)?.cwd ?? task.workspacePath,
      }))
      .filter(row => row.workspacePath),
  }
}

// 纯计算：给定台账和设置，算出这一轮谁在跑、几个空位、该开哪几张、
// 哪些被跳过以及原因。不读写台账、不碰宿主，方便单测。
export function planSchedule(tasks = [], effects = [], settings = {}, now = Date.now(), claims = {}) {
  const mode = settings.mode === 'off' ? 'off' : settings.mode === 'auto' ? 'auto' : 'observe'
  const maxRunning = Number.isInteger(settings.maxRunning) ? settings.maxRunning : 2
  const live = (Array.isArray(tasks) ? tasks : []).filter(
    task => task && !['done', 'canceled', 'archived'].includes(task.status),
  )
  const staged = live.map(task => ({
    task,
    stage: stageOf(task, { effects, now, tasks }).stage,
  }))
  const occupancy = workingOccupancy(tasks, effects, now)
  const running = occupancy.running
  const free = Math.max(0, maxRunning - running)

  const allById = new Map((Array.isArray(tasks) ? tasks : []).map(task => [task.id, task]))
  const unmetOf = task => (Array.isArray(task?.dependsOn) ? task.dependsOn : [])
    .filter(id => allById.get(id)?.status !== 'done')
  const queued = staged.filter(row => row.stage === 'queued').map(row => row.task)
  const automatic = queued.filter(isAutoQueued)
  const manual = queued.filter(task => !isAutoQueued(task))

  const skipped = []
  const candidates = []
  for (const task of automatic) {
    if (claimBlocks(task, claims, now)) {
      // 刚抢占还没落地，或开工失败后用户还没动过这张卡：这一轮先不碰。
      skipped.push({ taskId: task.id, reason: '上一次开工没有落地，等你处理', kind: 'claim' })
      continue
    }
    if (needsNodding(task)) {
      skipped.push({ taskId: task.id, reason: '等你点头', kind: 'nod' })
      continue
    }
    const unmet = unmetOf(task)
    if (unmet.length) {
      const first = allById.get(unmet[0])
      skipped.push({
        taskId: task.id,
        kind: 'dep',
        reason: `等「${first?.title ?? unmet[0]}」做完${unmet.length > 1 ? `（等 ${unmet.length} 件）` : ''}`,
      })
      continue
    }
    if (!task.workspacePath) {
      skipped.push({ taskId: task.id, reason: '还没定在哪做，定了就会自动开始', kind: 'workspace' })
      continue
    }
    candidates.push(task)
  }

  candidates.sort((a, b) => {
    const urgency = (URGENCY_RANK[a.urgency] ?? 1) - (URGENCY_RANK[b.urgency] ?? 1)
    if (urgency !== 0) return urgency
    const aAt = a.queue?.at ?? a.createdAt ?? 0
    const bAt = b.queue?.at ?? b.createdAt ?? 0
    if (aAt !== bAt) return aAt - bAt
    return String(a.id).localeCompare(String(b.id))
  })

  // S4 同目录保护：在跑的目录先占着；这一轮选中的也占着。
  const sameDir = settings.sameDir === 'allow' ? 'allow' : 'wait'
  const occupied = occupancy.working.slice()
  const startNow = []
  const waitingTasks = []
  for (const task of candidates) {
    // 先判目录：即使这一轮没有空位，被同目录挡住的卡也要在 skipped 里说清楚。
    if (sameDir === 'wait') {
      const conflict = occupied.find(row => overlaps(task.workspacePath, row.workspacePath))
      if (conflict) {
        skipped.push({
          taskId: task.id,
          kind: 'dir',
          reason: `同一个目录里有一件在跑，等它停下再开始${conflict.title ? `（在跑：${conflict.title}）` : ''}`,
        })
        continue
      }
    }
    if (startNow.length >= free) {
      waitingTasks.push(task)
      continue
    }
    startNow.push(task)
    if (task.workspacePath) {
      occupied.push({ taskId: task.id, title: task.title, workspacePath: task.workspacePath })
    }
  }
  const waiting = waitingTasks.map((task, index) => {
    const position = startNow.length + index + 1
    return { taskId: task.id, position, reason: `排在第 ${position} 个，有空位就开始` }
  })

  return {
    at: now,
    mode,
    maxRunning,
    sameDir,
    running,
    free,
    candidates: candidates.map(task => task.id),
    startNow: startNow.map(task => task.id),
    waiting,
    manual: manual.map(task => task.id),
    skipped,
  }
}

// Router 本体：只管调度。engine 提供 startTask/deliverTask；clock 和 wait
// 可注入，测试里不用真的等 1 秒。
export function createRouter(options = {}) {
  const file = options.file
  const engine = options.engine
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const debounceMs = options.debounceMs ?? ROUTER_DEBOUNCE_MS
  const tickMs = options.tickMs ?? ROUTER_TICK_MS

  let inflight = null
  let debounceTimer = null
  let tickTimer = null
  let disposed = false
  let writing = false

  const ledgerOptions = () => ({ file })

  function readSettings() {
    return readRouter(file)
  }

  function readLedgerView() {
    return listTasks({ includeArchived: true }, ledgerOptions())
  }

  function readClaims() {
    const ledger = readLedger(file)
    const raw = ledger?.router && typeof ledger.router === 'object' ? ledger.router : {}
    return raw.claimed && typeof raw.claimed === 'object' ? raw.claimed : {}
  }

  // 自己的写不触发自己调度，否则观察档每写一条日志就会再排一轮。
  function asInternalWrite(fn) {
    writing = true
    try {
      return fn()
    } finally {
      writing = false
    }
  }

  // 3.1 催一次：静默（停了但没交结果）且这次派工还没催过的卡，投递 S2 的催促
  // 预设文字。每条派工只催一次；观察档只记「本来会催」，不投递。
  async function followUp(tasks, effects, settings, at) {
    const nudges = []
    const would = []
    for (const task of tasks) {
      const stage = stageOf(task, { effects, now: at, stuckMinutes: settings.stuckMinutes }).stage
      if (stage !== 'silent') continue
      const current = currentAssignment(task)
      if (!current || current.nudgedAt) continue
      if (settings.mode === 'observe') {
        would.push({ at, taskId: task.id, would: 'nudge' })
        continue
      }
      if (settings.mode !== 'auto') continue
      const delivered = await engine.deliverTask(task.id, NUDGE_TEXT, { kind: 'nudge' })
      if (!delivered || delivered.ok !== true) continue
      asInternalWrite(() => patchAssignment(task.id, current.id, { nudgedAt: at }, { file }))
      nudges.push({ at, taskId: task.id, did: 'nudge' })
    }
    if (would.length) asInternalWrite(() => appendRouterLog(would, { file }))
    if (nudges.length) asInternalWrite(() => appendRouterLog(nudges, { file }))
    return { nudges: nudges.map(row => row.taskId), wouldNudge: would.map(row => row.taskId) }
  }

  async function runAuto(settings) {
    const { tasks, effects, revision } = readLedgerView()
    const at = now()
    const plan = planSchedule(tasks, effects, settings, at, readClaims())
    const nudged = await followUp(tasks, effects, settings, at)
    if (!plan.startNow.length) return { mode: 'auto', plan, started: [], failed: [], released: [], ...nudged }
    const versions = new Map(tasks.map(task => [task.id, task.version]))
    const claim = asInternalWrite(() => claimRouterTasks(plan.startNow, revision, { file, at }))
    if (!claim.ok) {
      // 条件写失败：这一轮什么都不做，等下一次调度。
      return { mode: 'auto', plan, started: [], failed: [], skipped: 'revision' }
    }
    const started = []
    const failed = []
    const released = []
    for (const taskId of plan.startNow) {
      try {
        const run = await engine.startTask(taskId, {
          by: 'router',
          expectedVersion: versions.get(taskId),
          expectedClaimAt: at,
        })
        if (run && run.ok === false && run.released) {
          // 复核发现卡改过/依赖变了/目录没了：撤掉抢占，留在排队，不写成没启动。
          asInternalWrite(() => releaseRouterClaim(taskId, { file }))
          released.push({ taskId, reason: run.reason ?? null, message: run.message ?? null })
          continue
        }
        asInternalWrite(() => updateRouterClaim(taskId, { state: 'started', at: now() }, { file }))
        started.push({ taskId, sessionId: run?.sessionId ?? null, queued: Boolean(run?.queued), deduped: Boolean(run?.deduped) })
      } catch (error) {
        // S1 的失败路径：卡进「没启动」，Router 不自动重试。
        asInternalWrite(() => updateRouterClaim(taskId, {
          state: 'failed',
          at: now(),
          error: errorText(error),
        }, { file }))
        failed.push({ taskId, error: errorText(error) })
        log(`start ${taskId} failed: ${errorText(error)}`)
      }
    }
    return { mode: 'auto', plan, started, failed, released, ...nudged }
  }

  async function runOnce() {
    if (inflight) return { skipped: 'busy' }
    inflight = (async () => {
      const settings = readSettings()
      if (settings.mode === 'off') return { mode: 'off', plan: null, started: [], failed: [] }
      if (settings.mode === 'observe') {
        const { tasks, effects } = readLedgerView()
        const claims = readClaims()
        const at = now()
        const plan = planSchedule(tasks, effects, settings, at, claims)
        if (plan.startNow.length) {
          asInternalWrite(() => appendRouterLog(
            plan.startNow.map(taskId => ({ at, taskId, would: 'start' })),
            { file },
          ))
        }
        const followed = await followUp(tasks, effects, settings, at)
        return {
          mode: 'observe',
          plan,
          started: [],
          failed: [],
          would: plan.startNow,
          wouldNudge: followed.wouldNudge,
        }
      }
      return runAuto(settings)
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  function schedule() {
    if (disposed || writing) return
    if (debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void runOnce().catch(error => log(`schedule failed: ${errorText(error)}`))
    }, debounceMs)
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref()
  }

  function notify(type) {
    if (type === 'turn/end') schedule()
    if (type === 'ledger/write') schedule()
  }

  function start() {
    if (disposed) return
    schedule()
    if (!tickTimer) {
      tickTimer = setInterval(() => {
        void runOnce().catch(error => log(`tick failed: ${errorText(error)}`))
      }, tickMs)
      if (typeof tickTimer.unref === 'function') tickTimer.unref()
    }
  }

  function stop() {
    disposed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    if (tickTimer) clearInterval(tickTimer)
    debounceTimer = null
    tickTimer = null
  }

  return {
    runOnce,
    schedule,
    notify,
    start,
    stop,
    planSchedule: (tasks, effects, settings) => planSchedule(tasks, effects, settings ?? readSettings(), now()),
    readSettings,
    get disposed() { return disposed },
    // 给测试用的内部写抑制开关。
    _asInternalWrite: asInternalWrite,
    _wait: wait,
  }
}

export { clockLabel, isAutoQueued, needsNodding }
export { routerEnvOverride }
