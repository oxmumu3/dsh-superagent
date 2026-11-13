// dsh-superagent — native coordination layer for DeepSeek Harness.
//
// The plugin owns the ledger, watches conversation and external queue events
// without model polling, dispatches cards into real host sessions, and (S2)
// serves the five-group panel, its actions and the card drawer.
// The engine keeps identity and recovery rules; this file only wires it to the
// host.

import path from 'node:path'
import os from 'node:os'
import { registerTools } from './lib/tools.js'
import { watchQueue } from './lib/queue.js'
import { patrol } from './lib/patrol.js'
import { installCapture } from './lib/capture.js'
import { installTurnCapture } from './lib/capture-turn.js'
import { registerRoutes } from './lib/route.js'
import { createEngine } from './lib/engine.js'
import { createRouter } from './lib/router.js'
import { onLedgerWrite } from './lib/ledger.js'
import { recoverNotifyInFlight, resolveNotifyCommand, runNotifyOnce, syncNotices } from './lib/notify.js'
import { createHostAdapter, installSessionEvents } from './lib/host.js'
import { describeDispatch } from './lib/policy.js'
import { judge } from './lib/eval.js'
import { judgeTurn } from './lib/eval-turn.js'
import { getTask, readCapture } from './lib/ledger.js'

export const name = 'dsh-superagent'
export const inject = []

function homeDir() {
  const override = process.env.DSH_HOME
  return override !== undefined && override.length > 0 ? path.resolve(override) : path.join(os.homedir(), '.dsh')
}

export function apply(ctx, config = {}) {
  const home = homeDir()
  const queueDir = path.join(home, 'taskboard-queue')
  const requests = path.join(queueDir, 'requests.jsonl')

  const log = message => {
    try {
      ctx.logger?.info?.(`[dsh-superagent] ${message}`)
    } catch {
      // Logging is best effort; a logger failure must not break the host.
    }
  }

  const decisionAvailable = false
  log(`loaded; queue=${requests}; decisionAvailable=${decisionAvailable}`)

  // The adapter is the only host-ABI surface. refs stays empty until the
  // services mount; every call explains what is missing instead of guessing.
  const refs = { ctx, agents: null, agentPresets: null, llm: null, model: null }
  // S3：Router 与引擎互相需要；先用一个引用位接好 turn/end 通知，再建 Router。
  const routerRef = { current: null }
  const engine = createEngine({
    decisionAvailable,
    adapter: createHostAdapter(refs, log),
    log,
    afterEvent: type => routerRef.current?.notify(type),
  })
  const router = createRouter({ file: engine.file, engine, log })
  routerRef.current = router
  // 任何一次台账写入之后去抖调度（Router 自己的写会被它内部抑制）。
  let disposeRouterWatch = () => {}
  try {
    disposeRouterWatch = onLedgerWrite(file => {
      try {
        if (engine.file && path.resolve(file) === path.resolve(engine.file)) router.notify('ledger/write')
      } catch {
        // 路径比较失败不影响写入。
      }
    })
  } catch (error) {
    log(`router watch unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // S5：通知调度。只从环境变量/插件配置取发送命令，默认关闭；定时器只做
  // 合并/限频/安静时段检查，不读任何外部账号。
  const notifyCommand = resolveNotifyCommand({ env: process.env, config }).command
  let notifyBusy = false
  const notifyTimer = setInterval(() => {
    if (notifyBusy) return
    notifyBusy = true
    void runNotifyOnce({ file: engine.file, config, env: process.env, log, decisionAvailable })
      .catch(error => log(`notify cycle failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { notifyBusy = false })
  }, 10_000)
  if (typeof notifyTimer.unref === 'function') notifyTimer.unref()
  try { recoverNotifyInFlight(engine.file); syncNotices({ file: engine.file, decisionAvailable }) } catch (error) { log(`notify sync skipped: ${error instanceof Error ? error.message : String(error)}`) }

  // Approval events are observed only: installSessionEvents never answers one.
  let disposeEvents
  try {
    disposeEvents = installSessionEvents(ctx, engine)
  } catch (error) {
    log(`event bridge unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Confirmed effects older than a week are safe to drop.
  try {
    const pruned = engine.pruneEffects(7)
    if (pruned > 0) log(`pruned ${pruned} confirmed effect(s)`)
  } catch (error) {
    log(`effect prune skipped: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Tools are registered against the host registry when it becomes ready.
  // 0.2.2 mounts `tools` after the plugin's apply, so sampling ctx.get at
  // startup misses it and the executor never sees sa_report. Listen for the
  // service instead; keep one registration per mount and drop it on teardown.
  const disposeToolRegistration = installToolRegistration(ctx, engine, log, { decisionAvailable })

  // 公开首发的最小宿主修复：新执行会话要挂宿主默认 preset，否则只有宿主
  // 平面工具，write/sa_report 会 unknown tool。没有这个服务就保持原样。
  try {
    ctx.inject(['agentPresets'], scope => {
      try {
        refs.agentPresets = scope?.agentPresets ?? scope?.get?.('agentPresets', false) ?? null
        if (!refs.agentPresets) log('agentPresets inject: service missing')
        else log('agentPresets bound')
        return () => { refs.agentPresets = null }
      } catch (error) {
        log(`agentPresets inject failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    })
  } catch (error) {
    log(`agentPresets inject unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Agents arrive after mount; bind them, then reconcile once. Until then the
  // engine returns a readable "宿主还没就绪" failure instead of inventing one.
  try {
    ctx.inject(['agents'], scope => {
      try {
        refs.agents = scope?.agents ?? scope?.get?.('agents', false) ?? null
        if (!refs.agents) {
          log('agents inject: service missing')
          return undefined
        }
        log('agents bound')
        engine.reconcile()
          .then(result => {
            log(`reconcile: resumed=${result.resumed} checked=${result.checked} interrupted=${result.interrupted}`)
            // S3：对账之后再开始自动调度，避免和启动恢复抢同一批卡。
            router.start()
          })
          .catch(error => log(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`))
        return () => { refs.agents = null }
      } catch (error) {
        log(`agents inject failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    })
  } catch (error) {
    log(`agents inject unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Panel data + action routes. The client half has no direct host access, so
  // it reads one JSON snapshot and posts one action over HTTP.
  let disposeRoute
  try {
    ctx.inject(['connection'], scope => {
      try {
        const off = registerRoutes(scope, { engine, notifyConfigured: Boolean(notifyCommand) })
        if (typeof off === 'function') {
          disposeRoute = off
          log('routes registered: /api/superagent/view, /api/superagent/action')
        } else {
          log('route: connection.fetch unavailable')
        }
      } catch (error) {
        log(`route registration failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } catch (error) {
    log(`route inject unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Capture: public preview default listens only for an explicit instruction
  // from the person ("记一下…", "放到待办…"). No model call, no pending row.
  // The older message/turn judgement paths stay available only when the ledger
  // carries an explicit opt-in; they are not part of the public preview.
  let disposeCapture
  let disposeTurnCapture
  try {
    refs.llm = ctx.get?.('llm', false) ?? null
    if (!refs.llm) log('capture: llm service unavailable, model path disabled')
    let captureMode = 'explicit'
    try {
      captureMode = readCapture(engine.file).mode
    } catch (error) {
      log(`capture mode unreadable, using explicit: ${error instanceof Error ? error.message : String(error)}`)
    }
    disposeCapture = installCapture(ctx, {
      onCaptured: (task, _sessionId, how) => log(`captured(${how}) ${task.id}: ${task.title}`),
      onPending: row => log(`pending ${row.id}: ${row.title || row.text.slice(0, 40)}`),
      judge: captureMode === 'message' && refs.llm ? text => judge(refs.llm, text) : undefined,
    })
    if (captureMode === 'turn') {
      disposeTurnCapture = installTurnCapture(ctx, {
        file: engine.file,
        judge: refs.llm ? input => judgeTurn(refs.llm, input) : undefined,
        log,
      })
    }
    log(`capture mode: ${captureMode}`)
  } catch (error) {
    log(`capture unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Queue: external writes land immediately, no model involved. Comments are
  // also delivered to the live executor.
  let disposeQueue
  try {
    disposeQueue = watchQueue(applied => {
      for (const r of applied) log(`queue ${r.ok ? 'ok' : 'failed'} ${r.id}${r.taskId ? ` -> ${r.taskId}` : ''}`)
    }, {
      onComment: (task, body) => {
        Promise.resolve(engine.deliverTask(task.id, body, { kind: 'comment' }))
          .then(result => {
            if (!result.ok) log(`queue comment ${task.id}: ${result.reason ?? 'not delivered'}`)
          })
          .catch(error => log(`queue comment failed: ${error instanceof Error ? error.message : String(error)}`))
      },
    })
  } catch (error) {
    log(`queue watcher unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // Patrol: deterministic checks on a timer; never calls a model.
  const patrolTimer = setInterval(() => {
    try {
      const result = patrol()
      if (result.findings.length) {
        log(`patrol: ${result.findings.length} finding(s)`)
        for (const f of result.findings) log(`  ${f.kind}: ${f.message}`)
      }
    } catch (error) {
      log(`patrol failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, 15 * 60_000)

  const dispose = () => {
    try { router.stop() } catch { /* ignore */ }
    try { disposeRouterWatch() } catch { /* ignore */ }
    try { clearInterval(patrolTimer) } catch { /* ignore */ }
    try { clearInterval(notifyTimer) } catch { /* ignore */ }
    try { disposeEvents?.() } catch { /* ignore */ }
    try { disposeQueue?.() } catch { /* ignore */ }
    try { disposeTurnCapture?.() } catch { /* ignore */ }
    try { disposeCapture?.() } catch { /* ignore */ }
    try { disposeToolRegistration?.() } catch { /* ignore */ }
    try { disposeRoute?.() } catch { /* ignore */ }
    // 插件卸载时释放句柄，但不结束台账里的派工；会话进程归宿主管。
    Promise.resolve(engine.releaseAllHandles()).catch(() => {})
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  // 给测试与宿主诊断用；不是持久状态。
  dispose.router = router
  dispose.engine = engine
  return dispose
}

// Tools must follow the host lifecycle: 0.2.2 mounts the `tools` service
// after apply, so a one-shot ctx.get at startup misses it. Wait for injection,
// register once, and unregister both groups on teardown. A second injection
// without teardown is ignored so a reload cannot leave duplicate tool names.
export function installToolRegistration(ctx, engine, log = () => {}, extra = {}) {
  let disposeTools
  let disposeDispatch
  const unregister = () => {
    try { disposeDispatch?.() } catch { /* already gone */ }
    try { disposeTools?.() } catch { /* already gone */ }
    disposeDispatch = undefined
    disposeTools = undefined
  }

  try {
    ctx.inject(['tools'], scope => {
      try {
        const tools = scope?.tools ?? scope?.get?.('tools', false) ?? null
        if (!tools || typeof tools.register !== 'function') {
          log('tools inject: service missing')
          return undefined
        }
        if (disposeTools || disposeDispatch) {
          log('tools already registered; skip duplicate')
          return undefined
        }
        disposeTools = registerTools(tools, { engine, ...extra })
        disposeDispatch = registerDispatchTool(tools, engine)
        log('tools registered: sa_list, sa_get, sa_create, sa_move, sa_comment, sa_report, sa_check, sa_checklist, sa_dispatch')
        return unregister
      } catch (error) {
        log(`tool registration failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    })
  } catch (error) {
    log(`tools inject unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  return unregister
}

// sa_dispatch: record the dispatch first, then start the session. It returns
// "已记下，正在启动" rather than waiting for the whole run; failures throw with
// the recorded reason (A1: never report a failed dispatch as success).
function registerDispatchTool(tools, engine) {
  return tools.register({
    name: 'sa_dispatch',
    description: '把一张卡派给独立执行会话去跑。先记下派工再启动；卡必须是 todo 或 in_progress。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '任务 id' },
        cwd: { type: 'string', description: '执行会话的工作目录（项目根）' },
        ifVersion: { type: 'number', description: '可选：卡片版本号' },
      },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    execute: async args => {
      const task = getTask(String(args?.id ?? ''))
      if (!['backlog', 'todo', 'in_progress'].includes(task.status)) {
        throw new Error(`只能派 backlog / todo / in_progress 的卡，当前是 ${task.status}`)
      }
      const run = await engine.startTask(task.id, {
        cwd: args?.cwd,
        ifVersion: args?.ifVersion === undefined ? undefined : Number(args.ifVersion),
        by: 'agent',
      })
      return describeDispatch(run, task.id)
    },
  })
}
