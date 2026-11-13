import assert from 'node:assert/strict'
import { makeHarness, deferred } from './support/harness.mjs'
import { ensureEvidence } from './support/evidence-fixture.mjs'
import { reportExecution, patchAssignment } from '../lib/ledger.js'

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))

// 1) start：先写 pending 动作和派工，再调建会话；claimed 之后变 confirmed/running。
{
  const hw = makeHarness({ confirmTimeoutMs: 1000 })
  hw.state.autoConfirm = false
  const card = hw.task()
  hw.setTaskId(card.id)
  const gate = deferred()
  hw.state.createGate = gate.promise

  const run = await hw.engine.startTask(card.id)
  assert.equal(run.ok, true)
  assert.equal(run.queued, true)
  await pause()

  const create = hw.calls.find(call => call.type === 'create')
  assert.ok(create, '必须调用建会话')
  const atCall = create.atCall.tasks.find(row => row.id === card.id)
  assert.equal(atCall.assignments.length, 1, '建会话前派工记录已落盘')
  assert.equal(atCall.assignments[0].state, 'pending')
  assert.ok(
    create.atCall.effects.some(effect => effect.state === 'sent' || effect.state === 'pending'),
    '建会话前动作已落盘',
  )

  gate.resolve()
  await pause()
  const followup = hw.calls.find(call => call.type === 'followup')
  assert.equal(followup.message.source.kind, 'plugin:dsh-superagent', 'v4 只接受 producer-owned source kind')
  const effect = hw.listEffects()[0]
  assert.equal(effect.assignmentId, run.assignmentId)
  hw.engine.onEvent({
    type: 'agent/inbox/claimed',
    data: { agent: { id: run.sessionId }, message: { id: effect.messageId } },
  })
  await hw.engine.whenIdle()

  const after = hw.reload()
  const assignment = after.assignments[0]
  assert.equal(hw.listEffects()[0].state, 'confirmed')
  assert.equal(assignment.state, 'running')
  assert.ok(assignment.startedAt > 0)
  assert.equal(hw.stage(card.id).stage, 'working')
  hw.cleanup()
}

// 2) 建会话抛错：重试 5 次后 failed，stage=not_started；retry 后重新开始。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  hw.state.failCreate = 6

  await hw.engine.startTask(card.id)
  await hw.engine.whenIdle()

  const creates = hw.calls.filter(call => call.type === 'create')
  assert.equal(creates.length, 6, '初次 + 重试 5 次')
  const effect = hw.listEffects()[0]
  assert.equal(effect.state, 'failed')
  assert.match(effect.lastError, /fake create failure/)
  assert.equal(hw.stage(card.id).stage, 'not_started')

  hw.state.failCreate = 0
  hw.engine.retryTask(card.id)
  await hw.engine.whenIdle()

  assert.equal(hw.listEffects()[0].state, 'confirmed')
  const assignment = hw.reload().assignments[0]
  assert.equal(assignment.state, 'running')
  assert.equal(hw.stage(card.id).stage, 'working')
  hw.cleanup()
}

// 2b) 失败后不点重试、直接重新开始：旧的 failed 不该继续让卡停在 not_started。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  hw.state.failCreate = 6
  await hw.engine.startTask(card.id)
  await hw.engine.whenIdle()
  assert.equal(hw.stage(card.id).stage, 'not_started')

  hw.state.failCreate = 0
  await hw.engine.startTask(card.id)
  await hw.engine.whenIdle()
  assert.equal(hw.stage(card.id).stage, 'working')
  assert.equal(hw.reload().assignments.length, 2, '旧派工 ended，新派工活着')
  hw.cleanup()
}

// 2c) 宿主收下了但没确认：不自动重发；保持已落盘身份，迟到确认仍能收口。
{
  const hw = makeHarness({ confirmTimeoutMs: 5 })
  hw.state.autoConfirm = false
  const card = hw.task()
  hw.setTaskId(card.id)
  const run = await hw.engine.startTask(card.id)
  await hw.engine.whenIdle()

  const effect = hw.listEffects()[0]
  assert.equal(effect.state, 'sent', '没确认时停在 sent，不记 failed')
  assert.match(effect.lastError, /未重发/)
  assert.equal(hw.calls.filter(call => call.type === 'create').length, 1)
  assert.equal(hw.calls.filter(call => call.type === 'followup').length, 1, '只发过一次')

  hw.engine.onEvent({
    type: 'agent/inbox/claimed',
    data: { agent: { id: run.sessionId }, message: { id: effect.messageId } },
  })
  assert.equal(hw.listEffects()[0].state, 'confirmed')
  assert.equal(hw.reload().assignments[0].state, 'running')
  hw.cleanup()
}

// 2d) 取消卡时连未执行的动作一起作废；异步返回后不再投消息，也不复活派工。
{
  const hw = makeHarness({ confirmTimeoutMs: 20 })
  hw.state.autoConfirm = false
  const card = hw.task()
  hw.setTaskId(card.id)
  const gate = deferred()
  hw.state.createGate = gate.promise

  const run = await hw.engine.startTask(card.id)
  await pause()
  const effectId = run.effectId
  assert.equal(hw.listEffects()[0].state, 'sent')

  await hw.engine.cancelTask(card.id)
  assert.equal(hw.reload().status, 'canceled')
  assert.equal(hw.reload().assignments[0].state, 'ended')
  assert.equal(hw.reload().assignments[0].endReason, 'canceled')
  assert.equal(hw.listEffects()[0].state, 'failed')
  assert.match(hw.listEffects()[0].lastError, /卡片已取消/)

  gate.resolve()
  await pause(30)
  await hw.engine.whenIdle()

  assert.equal(hw.calls.filter(call => call.type === 'followup').length, 0, '取消后不再投第一句话')
  assert.equal(hw.reload().assignments[0].state, 'ended', '迟到返回不复活派工')
  assert.equal(hw.reload().status, 'canceled')

  // 迟到的 claimed 也不改变状态。
  hw.engine.onEvent({
    type: 'agent/inbox/claimed',
    data: { agent: { id: run.sessionId }, message: { id: hw.listEffects().find(e => e.id === effectId).messageId } },
  })
  assert.equal(hw.reload().assignments[0].state, 'ended')
  hw.cleanup()
}

// 2d-1) create 进行中取消，之后 create reject：catch 不能把已取消 effect 改回 pending。
{
  const hw = makeHarness({ confirmTimeoutMs: 20 })
  hw.state.autoConfirm = false
  hw.state.failCreate = 1
  const card = hw.task()
  hw.setTaskId(card.id)
  const gate = deferred()
  hw.state.createGate = gate.promise

  await hw.engine.startTask(card.id)
  await pause()
  assert.equal(hw.calls.filter(call => call.type === 'create').length, 1)
  await hw.engine.cancelTask(card.id)
  gate.resolve()
  await pause(30)
  await hw.engine.whenIdle()

  assert.equal(hw.calls.filter(call => call.type === 'create').length, 1, '取消后不能再 create')
  assert.equal(hw.calls.filter(call => call.type === 'followup').length, 0, '取消后不能 followup')
  assert.equal(hw.reload().status, 'canceled')
  assert.equal(hw.listEffects()[0].state, 'failed', 'catch 不能把 failed 改回 pending')
  assert.match(hw.listEffects()[0].lastError, /卡片已取消/)
  assert.equal(hw.reload().assignments.filter(a => a.state !== 'ended').length, 0)
  hw.cleanup()
}

// 2d-2) create 成功时取消已发生：刚取到的 handle 要释放，不能留 cache。
{
  const hw = makeHarness({ confirmTimeoutMs: 20 })
  hw.state.autoConfirm = false
  const card = hw.task()
  hw.setTaskId(card.id)
  const gate = deferred()
  hw.state.createGate = gate.promise

  const run = await hw.engine.startTask(card.id)
  await pause()
  await hw.engine.cancelTask(card.id)
  gate.resolve()
  await pause(30)
  await hw.engine.whenIdle()

  assert.equal(hw.calls.filter(call => call.type === 'create').length, 1)
  assert.equal(hw.calls.filter(call => call.type === 'followup').length, 0)
  assert.ok(hw.calls.some(call => call.type === 'dispose' && call.id === run.sessionId), '刚拿到的句柄要释放')
  assert.equal(hw.engine.handles.size, 0, '不能留 cache')
  assert.equal(hw.reload().assignments[0].state, 'ended')
  assert.equal(hw.reload().status, 'canceled')
  hw.cleanup()
}

// 2d-3) 已取消卡片拒绝 retry 取消的 failed effect；不能复活派工或投消息。
{
  const hw = makeHarness({ confirmTimeoutMs: 20 })
  hw.state.autoConfirm = false
  const card = hw.task()
  hw.setTaskId(card.id)
  const gate = deferred()
  hw.state.createGate = gate.promise

  await hw.engine.startTask(card.id)
  await pause()
  await hw.engine.cancelTask(card.id)
  gate.resolve()
  await pause(30)
  await hw.engine.whenIdle()

  const before = hw.calls.length
  assert.throws(() => hw.engine.retryTask(card.id), /卡片已结束/)
  await pause(20)
  assert.equal(hw.calls.length, before, '拒绝后不能有新的宿主调用')
  assert.equal(hw.calls.filter(call => call.type === 'followup').length, 0)
  assert.equal(hw.reload().assignments.filter(a => a.state !== 'ended').length, 0, '不能复活派工')
  assert.equal(hw.listEffects()[0].state, 'failed', '被取消的动作保持终态')
  hw.cleanup()
}

// 2d-4) 延迟取宿主会话时验收卡片：退役动作/派工后，取回句柄也不能再 followup。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  await hw.startConfirmed(card.id)
  ensureEvidence(card.id, hw.file)
  reportExecution(card.id, { outcome: 'ready', summary: '第一版', checks: ['node test'] }, { file: hw.file })
  const before = hw.calls.filter(call => call.type === 'followup').length

  const gate = deferred()
  hw.state.reopenGate = gate.promise
  await hw.engine.commentTask(card.id, '验收前追加的评论')
  await pause()
  const lateEffect = hw.listEffects().at(-1)
  assert.ok(['pending', 'sent'].includes(lateEffect.state))

  await hw.engine.acceptTask(card.id)
  gate.resolve()
  await pause(30)
  await hw.engine.whenIdle()

  assert.equal(hw.reload().status, 'done')
  assert.equal(hw.listEffects().find(e => e.id === lateEffect.id).state, 'failed', '验收时退役动作')
  assert.equal(hw.calls.filter(call => call.type === 'followup').length, before, '验收后不能再 followup')
  assert.equal(hw.reload().assignments.filter(a => a.state !== 'ended').length, 0)
  hw.cleanup()
}

// 2d-5) 延迟取宿主会话时取消卡片：同样不能把已退役的评论发出去。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  await hw.startConfirmed(card.id)
  const before = hw.calls.filter(call => call.type === 'followup').length

  const gate = deferred()
  hw.state.reopenGate = gate.promise
  await hw.engine.commentTask(card.id, '取消前追加的评论')
  await pause()
  const lateEffect = hw.listEffects().at(-1)
  assert.ok(['pending', 'sent'].includes(lateEffect.state))

  await hw.engine.cancelTask(card.id)
  gate.resolve()
  await pause(30)
  await hw.engine.whenIdle()

  assert.equal(hw.reload().status, 'canceled')
  assert.equal(hw.listEffects().find(e => e.id === lateEffect.id).state, 'failed', '取消时退役动作')
  assert.equal(hw.calls.filter(call => call.type === 'followup').length, before, '取消后不能再 followup')
  assert.equal(hw.reload().assignments.filter(a => a.state !== 'ended').length, 0)
  hw.cleanup()
}

// 2e) 失败后已经开了新派工：旧 effect 不能重试，只能保持终态。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  hw.state.failCreate = 6
  await hw.engine.startTask(card.id)
  await hw.engine.whenIdle()
  const oldEffect = hw.listEffects()[0]
  assert.equal(oldEffect.state, 'failed')

  hw.state.failCreate = 0
  await hw.engine.startTask(card.id)
  await hw.engine.whenIdle()
  assert.equal(hw.listEffects().filter(e => e.assignmentId === hw.reload().assignments[1].id)[0].state, 'confirmed')

  assert.throws(() => hw.engine.retryTask(card.id), /新的派工|没有失败的动作/)
  assert.equal(hw.listEffects().find(e => e.id === oldEffect.id).state, 'failed')
  assert.equal(hw.reload().assignments.filter(a => a.state !== 'ended').length, 1)
  hw.cleanup()
}

// 3) 没有 workspacePath：S2 起这是正常缺项，不写失败动作，也不建会话。
{
  const hw = makeHarness()
  const card = hw.task({ title: '无目录卡', workspacePath: null })
  hw.setTaskId(card.id)

  let error = null
  try {
    await hw.engine.startTask(card.id)
  } catch (caught) {
    error = caught
  }
  await hw.engine.whenIdle()

  assert.ok(error, '缺目录要明确报出来')
  assert.equal(error.needWorkspace, true)
  assert.match(error.message, /选个目录/)
  assert.equal(hw.calls.filter(call => call.type === 'create').length, 0)
  assert.equal(hw.listEffects().length, 0, '缺目录不写失败的 start')
  assert.equal(hw.reload().assignments.length, 0)
  assert.equal(hw.stage(card.id).stage, 'queued')
  hw.cleanup()
}

// 7) 会话不在了再 deliver：旧派工 superseded，新派工第一句话带上报告和新留言。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  const run = await hw.startConfirmed(card.id)
  const firstSession = run.sessionId

  ensureEvidence(card.id, hw.file)
  reportExecution(card.id, { outcome: 'ready', summary: '第一版做完了', checks: ['node test'] }, { file: hw.file })
  hw.turnEnd(firstSession, 'completed')
  assert.equal(hw.stage(card.id).stage, 'review')

  hw.state.alive = false
  await hw.engine.commentTask(card.id, '请补充双人复核')
  await hw.engine.whenIdle()

  const row = hw.reload()
  assert.equal(row.assignments.length, 2)
  assert.equal(row.assignments[0].state, 'ended')
  assert.equal(row.assignments[0].endReason, 'superseded')
  assert.equal(row.assignments[1].state, 'running')
  assert.notEqual(row.assignments[1].sessionId, firstSession)

  const lastFollowup = hw.calls.filter(call => call.type === 'followup').at(-1)
  assert.match(lastFollowup.message.content[0].text, /第一版做完了/)
  assert.match(lastFollowup.message.content[0].text, /请补充双人复核/)
  hw.cleanup()
}

// 8) 同一张卡连着 start 两次：只有一条没结束的派工。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  await hw.startConfirmed(card.id)

  const second = await hw.engine.startTask(card.id)
  await hw.engine.whenIdle()

  assert.equal(second.deduped, true)
  const live = hw.reload().assignments.filter(a => a.state !== 'ended')
  assert.equal(live.length, 1)
  assert.equal(hw.listEffects().length, 1)
  hw.cleanup()
}

// 9) 启动对账：running 的派工、会话已不在 → idle + interrupted。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  await hw.startConfirmed(card.id)
  assert.equal(hw.reload().assignments[0].state, 'running')
  patchAssignment(card.id, hw.reload().assignments[0].id, { waitingApproval: true }, { file: hw.file })

  hw.state.alive = false
  const result = await hw.engine.reconcile()
  assert.equal(result.interrupted, 1)

  const assignment = hw.reload().assignments[0]
  assert.equal(assignment.state, 'idle')
  assert.equal(assignment.waitingApproval, false, '会话停了，过期审批状态要清掉')
  assert.equal(assignment.lastTurn.endKind, 'interrupted')
  assert.equal(hw.stage(card.id).stage, 'stuck')
  assert.match(hw.stage(card.id).reason, /找不到正在跑的会话/)
  hw.cleanup()
}

// 启动对账（续做）：台账里待做的动作会被接着做完。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  const { beginDispatch } = await import('../lib/ledger.js')
  const pending = beginDispatch(card.id, {
    sessionId: 'session-resume-1',
    messageId: 'msg-resume-1',
    text: '断点前没发出去的开场白',
    cwd: hw.dir,
    provider: 'test-provider',
    model: 'test-model',
  }, { file: hw.file })

  const result = await hw.engine.reconcile()
  await hw.engine.whenIdle()
  assert.equal(result.resumed, 1)
  assert.equal(hw.listEffects().find(effect => effect.id === pending.effect.id).state, 'confirmed')
  assert.equal(hw.reload().assignments[0].state, 'running')
  hw.cleanup()
}

// 审批只观察：asked 置 true，decided 清掉，不产生任何代答动作。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  const run = await hw.startConfirmed(card.id)

  hw.engine.onEvent({ type: 'approval/asked', data: { agent: { id: run.sessionId } } })
  assert.equal(hw.reload().assignments[0].waitingApproval, true)
  assert.equal(hw.stage(card.id).stage, 'approval')

  hw.engine.onEvent({ type: 'approval/decided', data: { agent: { id: run.sessionId } } })
  assert.equal(hw.reload().assignments[0].waitingApproval, false)
  assert.equal(hw.calls.filter(call => call.type === 'approval').length, 0)
  hw.cleanup()
}

console.log('s1-engine: ok')
