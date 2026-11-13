// dsh-superagent engine — dispatch, delivery and recovery on top of the ledger.
//
// The engine owns three identities and persists them before touching the host:
//   task → assignment (one live assignment at a time) → effect (one host action)
//   effect.messageId is returned by the host's agent/inbox/claimed event, and
//   that event is the only thing that turns an action into "confirmed".
//
// Host ABI is injected as an adapter (createSession/getSession/followup/…).
// That keeps every identity and recovery rule testable with a fake host while
// S1 step 0 verifies the real 0.2.2 calls in a shared window.

import {
  getTask,
  listTasks,
  listEffects,
  getEffect,
  updateTask,
  moveTask,
  addComment,
  createTask,
  beginDispatch,
  beginSuccessorDelivery,
  createEffect,
  patchEffect,
  patchAssignment,
  confirmEffect,
  failEffect,
  finishTask,
  settleTerminalTask,
  settleEffectActivity,
  resetEffectForRetry,
  pruneConfirmedEffects,
  clearOpenQuestion,
  nodTask,
  currentAssignment,
  findTaskBySession,
  listPending,
  removePending,
  setTaskQueue,
  VersionConflict,
} from './ledger.js'
import { WorkspaceError, validateWorkspacePath } from './workspace.js'

const MINUTE = 60_000

// 调用失败或没等到确认时的重试间隔：2 秒起，每次翻倍，最多 60 秒，一共 5 次。
export const DEFAULT_RETRY_DELAYS = [2_000, 4_000, 8_000, 16_000, 32_000]
export const DEFAULT_CONFIRM_TIMEOUT = 60_000

let counter = 0

function newSessionId() {
  counter += 1
  return `session-sa-${Date.now().toString(36)}-${counter}`
}

function newMessageId() {
  return `msg-sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? '未知错误')
}

export function buildPrompt(task, workspacePath) {
  const lines = [
    '你是执行会话，负责把这张卡做完。只做卡片描述里的事，不扩大范围。',
    '',
    `卡号：${task.id}`,
    `标题：${task.title}`,
    `项目目录：${workspacePath ?? '(未指定)'}`,
  ]
  if (task.description) lines.push('', '## 描述', task.description)
  if (task.checklist?.length) {
    lines.push('', '## 验收清单（做完逐项用 sa_check 勾上，附证据）')
    for (const item of task.checklist) lines.push(`- ${item.text}`)
  }
  lines.push(
    '',
    '## 工作规则',
    '1. 开工前先 sa_get 读这张卡，看看有没有新评论（评论是后续需求）。',
    '2. 每次停下来之前必须调一次 sa_report，用 outcome 说清楚是哪种情况：',
    '   ready 做完了待验收 / progress 还在做 / waiting 在等外部 / blocked 卡住了 / failed 做不下去 / dropped 发现不用做了。',
    '3. 要问用户：把问题放进 question（一次只问一个），然后能继续的部分接着做，不能继续就停。',
    '4. 不要调 sa_move，卡由系统移动。',
    '5. 需要审批的操作按宿主流程等用户处理，不要绕过。',
  )
  if (task.nodded) {
    lines.push(
      '',
      '## 用户已经点头的范围',
      '用户已经同意做卡片上写明的这件事，范围就是这张卡。',
      '超出的部分（再花钱、对外发送、需要更大权限、改到别的目录）仍不要自己做：',
      '用 sa_report 交 outcome: "blocked"，并把问题放进 question 问用户。',
    )
  } else {
    lines.push(
      '',
      '## 边界',
      '要花钱、对外发送、需要更大权限的步骤，不要自己做。',
      '遇到这类步骤就停下来，用 sa_report 交 outcome: "blocked"，并把问题放进 question 问用户。',
    )
  }
  return lines.join('\n')
}

export function buildSuccessorPrompt(task, previousExecution, message, workspacePath) {
  const previous = previousExecution?.summary
    ? `上一份报告（${previousExecution.outcome ?? previousExecution.state ?? 'unknown'}）：${previousExecution.summary}`
    : '上一份报告：没有'
  return [
    buildPrompt(task, workspacePath),
    '',
    '## 接续说明',
    '上一个执行会话已经不在了，你接替它继续做这张卡。',
    previous,
    '',
    '这次用户的新消息：',
    String(message ?? ''),
    '',
    '先 sa_get 读卡和评论，再按上面的规则继续。',
  ].join('\n')
}

export function createEngine(options = {}) {
  const file = options.file
  const adapter = options.adapter ?? {}
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const clock = options.now ?? (() => Date.now())
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS
  const maxRetries = options.maxRetries ?? retryDelays.length
  const confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT
  const log = options.log ?? (() => {})

  const handles = new Map()
  const waiters = new Map()
  // claimed 可能从 session/event 与 Cordis 单独 emit 两处到达；按动作去重。
  const claimedEffects = new Set()
  const chains = new Set()

  const ledgerOptions = () => ({ file })

  function retryDelay(attempt) {
    const index = Math.max(0, attempt - 1)
    if (index < retryDelays.length) return retryDelays[index]
    const last = retryDelays[retryDelays.length - 1] ?? 2_000
    return Math.min(60_000, last * 2)
  }

  function schedule(promise) {
    const tracked = Promise.resolve(promise)
      .catch(error => log(`effect chain failed: ${errorText(error)}`))
      .finally(() => chains.delete(tracked))
    chains.add(tracked)
    return tracked
  }

  async function whenIdle() {
    while (chains.size > 0) await Promise.allSettled([...chains])
  }

  async function resolveModel() {
    const envProvider = process.env.DSH_SUPERAGENT_PROVIDER
    const envModel = process.env.DSH_SUPERAGENT_MODEL
    let base = null
    try {
      base = typeof adapter.resolveModel === 'function' ? await adapter.resolveModel() : null
    } catch (error) {
      log(`resolveModel failed: ${errorText(error)}`)
    }
    const provider = envProvider || base?.provider
    const model = envModel || base?.model
    if (!provider || !model) return null
    return {
      provider,
      model,
      ...(base?.reasoningEffort ? { reasoningEffort: base.reasoningEffort } : {}),
    }
  }

  // 卡、派工、动作三者的统一活性检查；不活跃时同一次写里把动作关掉。
  function checkActive(effectId, reason = '卡片或动作已结束，停止执行') {
    return settleEffectActivity(effectId, { ...ledgerOptions(), reason })
  }

  function messageFor(effect) {
    return {
      id: effect.messageId,
      role: 'user',
      content: [{ type: 'text', text: effect.text }],
      // 0.2.2-rc.1 / session format v4 只接受 producer-owned source kind；
      // 旧写法 { kind: 'plugin', plugin } 会被拒为 UNKNOWN 并让整轮报错。
      source: { kind: 'plugin:dsh-superagent' },
    }
  }

  function waitForConfirmation(effectId, timeoutMs) {
    const current = getEffect(effectId, ledgerOptions())
    if (current.state === 'confirmed') return Promise.resolve(true)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        waiters.delete(effectId)
        resolve(false)
      }, timeoutMs)
      waiters.set(effectId, () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  function resolveWaiter(effectId) {
    const waiter = waiters.get(effectId)
    if (!waiter) return
    waiters.delete(effectId)
    waiter()
  }

  // 句柄缓存不能当存活证据：宿主重启、会话被销毁后，缓存里还可能有旧句柄。
  // 先问宿主；只有宿主没有查询接口时才退回缓存。
  async function resolveLiveHandle(sessionId) {
    let checked = false
    if (typeof adapter.reopenSession === 'function') {
      checked = true
      try {
        const reopened = await adapter.reopenSession(sessionId)
        if (reopened) {
          handles.set(sessionId, reopened)
          return reopened
        }
      } catch {
        // 打不开就当不在，走接班。
      }
    }
    if (typeof adapter.getSession === 'function') {
      checked = true
      const info = await adapter.getSession(sessionId)
      if (info) {
        const handle = info.handle ?? info
        handles.set(sessionId, handle)
        return handle
      }
    }
    return checked ? null : handles.get(sessionId) ?? null
  }

  async function sendStart(effect) {
    if (typeof adapter.createSession !== 'function') throw new Error('宿主没有 agents.create')
    if (!checkActive(effect.id).active) return
    let handle = await resolveLiveHandle(effect.sessionId)
    if (!checkActive(effect.id).active) {
      await disposeDetached(effect.sessionId, handle)
      return
    }
    if (!handle) {
      const created = await adapter.createSession({
        sessionId: effect.sessionId,
        cwd: effect.cwd,
        provider: effect.provider,
        model: effect.model,
        reasoningEffort: effect.reasoningEffort,
      })
      // create 期间被取消：刚拿到的句柄要释放，不能留在 cache 里。
      if (!checkActive(effect.id).active) {
        await disposeDetached(effect.sessionId, created)
        return
      }
      handle = created
      if (handle) handles.set(effect.sessionId, handle)
    }
    if (!checkActive(effect.id).active) {
      await disposeDetached(effect.sessionId, handle)
      return
    }
    if (typeof adapter.followup !== 'function') throw new Error('宿主没有 agent.followup')
    await adapter.followup(effect.sessionId, messageFor(effect), handle)
  }

  async function promoteToSuccessor(effect) {
    const task = getTask(effect.taskId, ledgerOptions())
    const previous = task.executions?.[task.executions.length - 1] ?? null
    const model = effect.provider && effect.model
      ? { provider: effect.provider, model: effect.model, reasoningEffort: effect.reasoningEffort }
      : await resolveModel()
    if (!model) throw new Error('宿主没有给出模型和服务商，不能开接班会话')
    const sessionId = newSessionId()
    const text = buildSuccessorPrompt(task, previous, effect.text, effect.cwd ?? task.workspacePath)
    const promoted = beginSuccessorDelivery(effect.taskId, effect.assignmentId, {
      sessionId,
      messageId: effect.messageId,
      text,
      cwd: effect.cwd ?? task.workspacePath,
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      effectId: effect.id,
    }, ledgerOptions())
    return promoted
  }

  async function sendDeliver(effect) {
    if (!checkActive(effect.id).active) return
    let handle = await resolveLiveHandle(effect.sessionId)
    if (!checkActive(effect.id).active) {
      await disposeDetached(effect.sessionId, handle)
      return
    }
    if (!handle) {
      // 会话不在了：旧派工 superseded，新派工带上一份报告和新消息。
      // 已经是接班动作时不再换代，重试同一接班派工，身份保持稳定。
      const target = effect.successor ? { effect } : await promoteToSuccessor(effect)
      const current = target.effect
      if (!checkActive(current.id).active) return
      const created = await adapter.createSession({
        sessionId: current.sessionId,
        cwd: current.cwd,
        provider: current.provider,
        model: current.model,
      })
      if (!checkActive(current.id).active) {
        await disposeDetached(current.sessionId, created)
        return
      }
      if (created) handles.set(current.sessionId, created)
      if (!checkActive(current.id).active) {
        await disposeDetached(current.sessionId, created)
        return
      }
      await adapter.followup(current.sessionId, messageFor(current), created)
      return
    }
    if (!checkActive(effect.id).active) return
    await adapter.followup(effect.sessionId, messageFor(effect), handle)
  }

  async function runEffect(effectId) {
    let lastError = null
    // 入口先过同一把活性尺；已取消的动作不再开跑。
    const initial = checkActive(effectId)
    if (!initial.active) return
    // 恢复时沿用已落盘的重试记录，不把计数清零重来。
    const persistedAttempts = Number(initial.effect.attempts) || 0
    for (let attempt = persistedAttempts + 1; attempt <= maxRetries + 1; attempt += 1) {
      const gate = checkActive(effectId)
      if (!gate.active) return
      const effect = gate.effect
      patchEffect(effectId, { state: 'sent', attempts: attempt, nextAttemptAt: null }, ledgerOptions())
      try {
        if (effect.kind === 'start') await sendStart(effect)
        else await sendDeliver(effect)
      } catch (error) {
        lastError = errorText(error)
        // catch 回来先对账；取消后的 failed 不能被改回 pending。
        if (!checkActive(effectId).active) return
        if (attempt > maxRetries) break
        const waitMs = retryDelay(attempt)
        patchEffect(effectId, {
          state: 'pending',
          attempts: attempt,
          lastError,
          nextAttemptAt: clock() + waitMs,
        }, ledgerOptions())
        await wait(waitMs)
        if (!checkActive(effectId).active) return
        continue
      }
      if (!checkActive(effectId).active) return
      if (await waitForConfirmation(effectId, confirmTimeoutMs)) return
      if (!checkActive(effectId).active) return
      // 宿主可能还排着同一条消息。官方未证实按稳定消息 ID 去重之前，
      // 这里只保留已落盘身份等核对，不自动重发。
      patchEffect(effectId, {
        state: 'sent',
        attempts: attempt,
        nextAttemptAt: null,
        lastError: `已交给宿主，${Math.round(confirmTimeoutMs / 1000)} 秒内没等到确认；按未证实去重处理，未重发`,
      }, ledgerOptions())
      return
    }
    if (!checkActive(effectId).active) return
    failEffect(effectId, lastError ?? '调用宿主失败', ledgerOptions())
  }

  function failStart(taskId, error, input = {}) {
    const sessionId = newSessionId()
    const created = beginDispatch(taskId, {
      sessionId,
      messageId: newMessageId(),
      text: '',
      cwd: input.cwd ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      by: 'system',
    }, ledgerOptions())
    failEffect(created.effect.id, error, ledgerOptions())
    return {
      ok: false,
      error,
      taskId,
      effectId: created.effect.id,
      assignmentId: created.assignment.id,
      task: getTask(taskId, ledgerOptions()),
    }
  }

  async function startTask(taskId, input = {}) {
    let task = getTask(String(taskId ?? ''), ledgerOptions())
    if (input.ifVersion !== undefined && input.ifVersion !== null && task.version !== input.ifVersion) {
      throw new VersionConflict(task.id, input.ifVersion, task.version)
    }
    if (!['backlog', 'todo', 'in_progress'].includes(task.status)) {
      throw new Error(`这张卡当前是 ${task.status}，不能开始`)
    }
    const existing = currentAssignment(task)
    if (existing) {
      return {
        ok: true,
        queued: true,
        deduped: true,
        taskId: task.id,
        assignmentId: existing.id,
        effectId: null,
        sessionId: existing.sessionId,
        task,
      }
    }

    // S2: a missing workspace is a normal answer, not a failed start. Validate
    // before writing anything so the card never falls into「没启动」because the
    // user simply has not chosen a folder yet.
    let workspacePath = task.workspacePath ?? null
    if (input.cwd !== undefined && input.cwd !== null && String(input.cwd).trim()) {
      workspacePath = validateWorkspacePath(input.cwd)
    }
    if (!workspacePath) {
      throw new WorkspaceError('还没定在哪做，先选个目录', { needWorkspace: true })
    }
    // A stored folder may have been deleted since the card was written.
    workspacePath = validateWorkspacePath(workspacePath)
    if (workspacePath !== task.workspacePath) {
      task = updateTask(task.id, { workspacePath }, {
        ...ledgerOptions(),
        ifVersion: task.version,
      })
    }

    let model = null
    try {
      model = await resolveModel()
    } catch {
      model = null
    }
    if (typeof adapter.ready === 'function' && !adapter.ready()) {
      return failStart(task.id, '宿主 agents 服务还没就绪，不能开始', { cwd: workspacePath })
    }
    if (!model) return failStart(task.id, '宿主没有给出模型和服务商，不能开始', { cwd: workspacePath })
    if (typeof adapter.createSession !== 'function') {
      return failStart(task.id, '宿主没有 agents.create，不能开始', { cwd: workspacePath })
    }

    const sessionId = newSessionId()
    const messageId = newMessageId()
    const created = beginDispatch(task.id, {
      sessionId,
      messageId,
      text: buildPrompt(task, workspacePath),
      cwd: workspacePath,
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      by: input.by ?? 'system',
    }, ledgerOptions())
    schedule(runEffect(created.effect.id))
    return {
      ok: true,
      queued: true,
      taskId: task.id,
      effectId: created.effect.id,
      assignmentId: created.assignment.id,
      sessionId,
      task,
    }
  }

  async function deliverTask(taskId, text, input = {}) {
    const task = getTask(String(taskId ?? ''), ledgerOptions())
    if (['done', 'canceled', 'archived'].includes(task.status)) {
      return { ok: false, reason: 'task_finished', taskId: task.id }
    }
    const current = currentAssignment(task)
    if (!current) {
      // E.comment：没有当前派工就只记留言，不擅自开工。
      return { ok: false, reason: 'no_current_assignment', taskId: task.id }
    }
    const effect = createEffect({
      kind: 'deliver',
      taskId: task.id,
      assignmentId: current.id,
      sessionId: current.sessionId,
      messageId: newMessageId(),
      text: String(text ?? ''),
      cwd: current.cwd ?? task.workspacePath,
      provider: current.provider,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
    }, ledgerOptions())
    schedule(runEffect(effect.id))
    return {
      ok: true,
      taskId: task.id,
      effectId: effect.id,
      assignmentId: current.id,
      // 还没确认；调用方只能说「已记录，等待宿主确认」，不能说已送。
      effectState: 'pending',
    }
  }

  async function answerTask(taskId, text, input = {}) {
    const answer = String(text ?? '').trim()
    if (!answer) throw new Error('回答不能为空')
    const task = getTask(String(taskId ?? ''), ledgerOptions())
    const question = task.openQuestion
    if (!question) throw new Error('这张卡没有等你回答的问题')
    addComment(task.id, answer, { ...ledgerOptions(), author: 'user', ifVersion: input.ifVersion })
    clearOpenQuestion(task.id, ledgerOptions())
    const prompt = question.text
      ? `用户回答了你的问题（原问题：${question.text}）：\n${answer}\n按这个回答继续。`
      : `用户回答了你的问题：\n${answer}\n按这个回答继续。`
    return deliverTask(task.id, prompt, { kind: 'answer' })
  }

  async function commentTask(taskId, text, input = {}) {
    const task = addComment(String(taskId ?? ''), String(text ?? ''), {
      ...ledgerOptions(),
      author: 'user',
      ifVersion: input.ifVersion,
    })
    const delivered = await deliverTask(task.id, String(text ?? ''), { kind: 'comment' })
    return { task, delivered }
  }

  async function rejectTask(taskId, text, input = {}) {
    const reason = String(text ?? '').trim() || '请继续修改'
    const task = getTask(String(taskId ?? ''), ledgerOptions())
    if (task.status !== 'in_review') throw new Error(`只有待验收的卡能打回，当前是 ${task.status}`)
    moveTask(task.id, 'in_progress', { ...ledgerOptions(), ifVersion: input.ifVersion })
    addComment(task.id, reason, { ...ledgerOptions(), author: 'user' })
    const delivered = await deliverTask(task.id, `用户把这张卡打回了，理由：\n${reason}\n请继续修改。`)
    return { task: getTask(task.id, ledgerOptions()), delivered }
  }

  async function acceptTask(taskId, input = {}) {
    // 移卡、退役未发动作、结束派工在同一次台账写入里完成。
    const finished = finishTask(String(taskId ?? ''), 'done', {
      ...ledgerOptions(),
      ifVersion: input.ifVersion,
    })
    if (finished.assignment) await releaseHandle(finished.assignment.sessionId)
    // 释放是异步的；回来后再对一次账，终态卡不许留 live 动作/派工。
    await settleTerminalTask(finished.task.id, ledgerOptions())
    return getTask(finished.task.id, ledgerOptions())
  }

  async function cancelTask(taskId, input = {}) {
    // 同一次写入里移卡并退役未发动作；宿主 cancel 只负责停当前 turn。
    const finished = finishTask(String(taskId ?? ''), 'canceled', {
      ...ledgerOptions(),
      ifVersion: input.ifVersion,
    })
    if (finished.assignment) {
      try {
        // rc.1 的 agent.cancel 需要有效 cause；不传 keepInbox，让宿主丢弃
        // 已由我们退役的排队消息，避免取消后又被唤醒。
        await adapter.cancel?.(finished.assignment.sessionId)
      } catch (error) {
        log(`cancel ${finished.assignment.sessionId} failed: ${errorText(error)}`)
      }
      await releaseHandle(finished.assignment.sessionId)
      await settleTerminalTask(finished.task.id, ledgerOptions())
    }
    return getTask(finished.task.id, ledgerOptions())
  }

  function laterTask(taskId, input = {}) {
    return moveTask(String(taskId ?? ''), 'backlog', { ...ledgerOptions(), ifVersion: input.ifVersion })
  }

  function confirmNod(taskId, input = {}) {
    const task = getTask(String(taskId ?? ''), ledgerOptions())
    if (input.ifVersion !== undefined && input.ifVersion !== null && task.version !== input.ifVersion) {
      throw new VersionConflict(task.id, input.ifVersion, task.version)
    }
    return nodTask(task.id, { by: 'user' }, {
      ...ledgerOptions(),
      ifVersion: task.version,
      by: 'user',
    })
  }

  function retryTask(taskId, input = {}) {
    const task = getTask(String(taskId ?? ''), ledgerOptions())
    if (input.ifVersion !== undefined && input.ifVersion !== null && task.version !== input.ifVersion) {
      throw new VersionConflict(task.id, input.ifVersion, task.version)
    }
    if (['done', 'canceled', 'archived'].includes(task.status)) {
      throw new Error('卡片已结束，不能重试')
    }
    const current = currentAssignment(task)
    const failed = listEffects(ledgerOptions())
      .filter(effect => effect.taskId === taskId && effect.state === 'failed')
      // 已有新派工时，只允许重试当前派工自己的失败动作。
      .filter(effect => !current || effect.assignmentId === current.id)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
    if (!failed) throw new Error('这张卡没有失败的动作可以重试（已有新的派工时旧动作不能重试）')
    const reset = resetEffectForRetry(failed.id, ledgerOptions())
    schedule(runEffect(failed.id))
    return { ...reset, effectId: failed.id }
  }

  function createCard(text, input = {}) {
    const title = String(text ?? '').trim()
    if (!title) throw new Error('内容不能为空')
    return createTask({
      title: title.slice(0, 80),
      description: title,
      workspacePath: input.workspacePath ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      by: 'user',
      // S3 0.1：面板随手记的卡进自动队列（用户自己刚说要做的）。
      queue: { auto: true, by: 'user' },
    }, ledgerOptions())
  }

  // 给一张还没跑起来的卡设目录或清空。有派工时不允许改，避免把正在跑
  // 的会话指到另一个项目。
  function setWorkspace(taskId, value, input = {}) {
    const task = getTask(String(taskId ?? ''), ledgerOptions())
    if (input.ifVersion !== undefined && input.ifVersion !== null && task.version !== input.ifVersion) {
      throw new VersionConflict(task.id, input.ifVersion, task.version)
    }
    if (currentAssignment(task)) {
      throw new Error('这张卡有派工在跑，不能改目录')
    }
    const workspacePath = value === null || value === undefined || String(value).trim() === ''
      ? null
      : validateWorkspacePath(value)
    return updateTask(task.id, { workspacePath }, {
      ...ledgerOptions(),
      ifVersion: task.version,
      by: 'user',
    })
  }

  // 「以后再说」的卡排回队列，并标成自动排队（S3 0.1）。
  function queueTask(taskId, input = {}) {
    const task = getTask(String(taskId ?? ''), ledgerOptions())
    if (input.ifVersion !== undefined && input.ifVersion !== null && task.version !== input.ifVersion) {
      throw new VersionConflict(task.id, input.ifVersion, task.version)
    }
    if (task.status === 'todo') {
      return setTaskQueue(task.id, { auto: true, by: 'user' }, {
        ...ledgerOptions(),
        ifVersion: task.version,
        by: 'user',
      })
    }
    if (task.status !== 'backlog') throw new Error(`只有「以后再说」的卡能排进去，当前是 ${task.status}`)
    const moved = moveTask(task.id, 'todo', {
      ...ledgerOptions(),
      ifVersion: task.version,
      by: 'user',
    })
    return setTaskQueue(moved.id, { auto: true, by: 'user' }, {
      ...ledgerOptions(),
      ifVersion: moved.version,
      by: 'user',
    })
  }

  // 待确认的一句话转成卡。先读完再建卡，最后移除 pending；中途失败时
  // 那条话还在，用户不会丢东西。
  function acceptPending(pendingId, input = {}) {
    const rows = listPending(ledgerOptions()).pending
    const row = rows.find(item => item.id === pendingId) ?? null
    if (!row) throw new Error('这条待确认的话不在了')
    // 面板只发 id 时 route 里的 text 是空字符串；空标题必须回退到原来
    // 记下的标题，而不是把待确认的话当成空的。
    const provided = String(input.title ?? input.text ?? '').trim()
    const title = provided || String(row.title ?? '').trim() || String(row.text ?? '').trim()
    if (!title) throw new Error('这条待确认的话是空的')
    const task = createTask({
      title: title.slice(0, 80),
      description: String(row.text ?? title),
      workspacePath: row.workspacePath ?? null,
      sourceSessionId: row.sessionId ?? null,
      by: 'user',
      // S3 0.1：用户点了「记下」，这张卡才算自动排队。
      queue: { auto: true, by: 'user' },
    }, ledgerOptions())
    removePending(row.id, ledgerOptions())
    return task
  }

  // S3 4：待确认里的「补到那张卡上」。只加留言并尝试送给当前执行会话，
  // 不新建卡、不移动状态。
  async function attachPending(pendingId, input = {}) {
    const rows = listPending(ledgerOptions()).pending
    const row = rows.find(item => item.id === pendingId) ?? null
    if (!row) throw new Error('这条待确认的话不在了')
    const taskId = String(input.taskId ?? row.suggestedTaskId ?? '').trim()
    if (!taskId) throw new Error('这条待确认的话没有指定卡片')
    const task = getTask(taskId, ledgerOptions())
    if (['done', 'canceled', 'archived'].includes(task.status)) throw new Error('那张卡已经结束了')
    const body = String(row.text ?? row.title ?? '').trim()
    if (!body) throw new Error('这条待确认的话是空的')
    const commented = await commentTask(taskId, body, { ifVersion: input.ifVersion })
    removePending(row.id, ledgerOptions())
    return {
      task: getTask(taskId, ledgerOptions()),
      delivered: commented.delivered,
      pendingId: row.id,
    }
  }

  function dismissPending(pendingId) {
    const removed = removePending(String(pendingId ?? ''), ledgerOptions())
    if (!removed) throw new Error('这条待确认的话不在了')
    return removed
  }

  // 释放一个还没进 handles 表的句柄（create 返回后才发现卡已取消）。
  async function disposeDetached(sessionId, handle) {
    handles.delete(sessionId)
    if (!handle) return
    try {
      if (typeof adapter.dispose === 'function') await adapter.dispose(sessionId, handle)
      else if (typeof handle.dispose === 'function') await handle.dispose()
    } catch (error) {
      log(`dispose ${sessionId} failed: ${errorText(error)}`)
    }
  }

  async function releaseHandle(sessionId) {
    const handle = handles.get(sessionId)
    await disposeDetached(sessionId, handle)
  }

  async function releaseAllHandles() {
    for (const sessionId of [...handles.keys()]) await releaseHandle(sessionId)
  }

  function normalizeEvent(event, session) {
    if (event && typeof event === 'object' && typeof event.type === 'string') {
      return { type: event.type, data: event.data ?? event.payload ?? {} }
    }
    if (session && typeof session === 'object' && typeof session.type === 'string') {
      return { type: session.type, data: session.data ?? session.payload ?? {} }
    }
    return { type: null, data: {} }
  }

  function sessionIdOf(data, session) {
    const fromData = Array.isArray(data) ? data[0] : data
    const candidates = [
      session?.id,
      session?.header?.id,
      fromData?.sessionId,
      fromData?.agentId,
      typeof fromData?.agent === 'string' ? fromData.agent : undefined,
      fromData?.agent?.id,
      fromData?.agent?.session?.header?.id,
      fromData?.agent?.session?.id,
      fromData?.agent?.header?.id,
      fromData?.session?.header?.id,
      fromData?.session?.id,
    ]
    for (const value of candidates) {
      if (typeof value === 'string' && value.length > 0) return value
    }
    return null
  }

  function messageIdOf(data) {
    return data?.message?.id ?? data?.messageId ?? data?.message?.messageId ?? null
  }

  function endDetail(reason, data) {
    if (reason && typeof reason === 'object') {
      if (reason.error?.message) return String(reason.error.message)
      if (reason.reason?.kind) return `被打断：${reason.reason.kind}`
      if (typeof reason.message === 'string') return reason.message
    }
    if (Array.isArray(data) && typeof data[1] === 'string') return data[1]
    if (typeof data?.error?.message === 'string') return data.error.message
    return ''
  }

  function apiErrorText(data) {
    if (Array.isArray(data)) {
      const text = data.find((part, index) => index > 0 && typeof part === 'string')
      return text ?? '宿主报告了一个错误'
    }
    if (typeof data?.error === 'string') return data.error
    if (typeof data?.error?.message === 'string') return data.error.message
    if (typeof data?.message === 'string') return data.message
    return '宿主报告了一个错误'
  }

  // 只观察审批：不拦 approval/request，也不替用户点同意。
  // afterEvent 只用来通知 Router（turn/end 时排一次），不改变任何判断。
  function onEvent(event, session) {
    const handled = handleEvent(event, session)
    try {
      const type = normalizeEvent(event, session).type
      if (type) options.afterEvent?.(type)
    } catch {
      // 通知失败不能影响事件处理。
    }
    return handled
  }

  function handleEvent(event, session) {
    const { type, data } = normalizeEvent(event, session)
    if (!type) return false
    const sessionId = sessionIdOf(data, session)
    if (!sessionId) return false
    const found = findTaskBySession(sessionId, ledgerOptions())
    if (!found) return false // 别的会话：静默丢掉，不写日志。
    const { task, assignment } = found
    const at = clock()

    if (type === 'agent/inbox/claimed') {
      const messageId = messageIdOf(data)
      if (messageId) {
        const effect = listEffects(ledgerOptions()).find(item => item.messageId === messageId)
        if (effect) {
          // 只认当前派工的动作；旧派工的迟到确认不改变任何状态。
          if (effect.assignmentId !== assignment.id) return true
          if (effect.state === 'failed') return true
          if (effect.state === 'confirmed' || claimedEffects.has(effect.id)) {
            claimedEffects.add(effect.id)
            return true
          }
          const confirmed = confirmEffect(effect.id, { ...ledgerOptions(), at })
          if (!confirmed.ignored) {
            claimedEffects.add(effect.id)
            resolveWaiter(effect.id)
          }
          return true
        }
      }
      patchAssignment(task.id, assignment.id, { state: 'running', lastEventAt: at }, ledgerOptions())
      return true
    }

    if (type === 'agent/inbox/spliced') {
      // persisted splice 只说明 inbox 结构变了；被移除的消息身份只在
      // claimed 里，不能把 splice 当确认。保留它刷新 lastEventAt 用于对账。
      patchAssignment(task.id, assignment.id, { lastEventAt: at }, ledgerOptions())
      return true
    }

    if (type === 'turn/start') {
      patchAssignment(task.id, assignment.id, { state: 'running', lastEventAt: at }, ledgerOptions())
      return true
    }

    if (type === 'turn/end') {
      const reason = data?.reason && typeof data.reason === 'object' ? data.reason : {}
      const endKind = String(reason.kind ?? data?.endKind ?? 'interrupted')
      patchAssignment(task.id, assignment.id, {
        state: 'idle',
        lastEventAt: at,
        waitingApproval: false,
        lastTurn: {
          turn: data?.turn ?? null,
          endKind,
          detail: endDetail(reason, data),
          at,
        },
      }, ledgerOptions())
      return true
    }

    if (type === 'api-session/error') {
      const detail = apiErrorText(data)
      const turn = assignment.lastTurn?.turn ?? null
      patchAssignment(task.id, assignment.id, {
        lastEventAt: at,
        lastTurn: { turn, endKind: 'error', detail, at },
        lastError: detail,
      }, ledgerOptions())
      return true
    }

    if (type === 'approval/asked') {
      patchAssignment(task.id, assignment.id, {
        waitingApproval: true,
        lastEventAt: at,
      }, ledgerOptions())
      return true
    }

    if (type === 'approval/decided') {
      patchAssignment(task.id, assignment.id, {
        waitingApproval: false,
        lastEventAt: at,
      }, ledgerOptions())
      return true
    }

    patchAssignment(task.id, assignment.id, { lastEventAt: at }, ledgerOptions())
    return true
  }

  // B6：插件启动时对一遍账。待做/已发的动作接着做；派工活着且在跑就不动，
  // 否则记 idle + interrupted。
  async function reconcile() {
    if (typeof adapter.ready === 'function' && !adapter.ready()) {
      return { skipped: true, resumed: 0, awaiting: 0, checked: 0, interrupted: 0 }
    }
    const allEffects = listEffects(ledgerOptions())
    const liveEffects = allEffects.filter(effect => effect.state === 'pending')
    // 已经交给宿主但没等到确认的动作：不重发，等共享窗口确认去重口径。
    const awaitingEffects = allEffects.filter(effect => effect.state === 'sent')
    for (const effect of liveEffects) schedule(runEffect(effect.id))

    let checked = 0
    let interrupted = 0
    const { tasks } = listTasks({ includeArchived: true }, ledgerOptions())
    for (const task of tasks) {
      for (const assignment of task.assignments ?? []) {
        if (!assignment || !['pending', 'running'].includes(assignment.state)) continue
        checked += 1
        const inFlight = [...liveEffects, ...awaitingEffects]
          .some(effect => effect.assignmentId === assignment.id)
        if (inFlight) continue
        let info = null
        try {
          info = typeof adapter.getSession === 'function'
            ? await adapter.getSession(assignment.sessionId)
            : null
        } catch (error) {
          log(`reconcile getSession ${assignment.sessionId} failed: ${errorText(error)}`)
        }
        if (info && info.running !== false) continue
        const at = clock()
        patchAssignment(task.id, assignment.id, {
          state: 'idle',
          lastEventAt: at,
          // 会话都停了，过期审批状态不能继续挂着。
          waitingApproval: false,
          lastTurn: {
            turn: assignment.lastTurn?.turn ?? null,
            endKind: 'interrupted',
            detail: '插件启动时找不到正在跑的会话',
            at,
          },
        }, ledgerOptions())
        interrupted += 1
      }
    }
    return { skipped: false, resumed: liveEffects.length, awaiting: awaitingEffects.length, checked, interrupted }
  }

  function pruneEffects(days = 7) {
    return pruneConfirmedEffects({
      ...ledgerOptions(),
      olderThanMs: days * 24 * 60 * MINUTE,
      now: clock(),
    })
  }

  return {
    startTask,
    deliverTask,
    answerTask,
    commentTask,
    rejectTask,
    acceptTask,
    cancelTask,
    laterTask,
    confirmNod,
    retryTask,
    queueTask,
    setWorkspace,
    createCard,
    acceptPending,
    attachPending,
    dismissPending,
    onEvent,
    reconcile,
    whenIdle,
    pruneEffects,
    releaseAllHandles,
    buildPrompt,
    // 暴露给宿主接线与测试用；不要把它当成持久状态。
    handles,
    ledgerOptions,
    get file() { return file },
  }
}
