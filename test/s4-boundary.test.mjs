// S4 第 3 阶段：和宿主团队功能划清界线。
// 合成 payload 与临时台账；没有真实会话。

import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { installCapture } from '../lib/capture.js'
import { createTurnCapture } from '../lib/capture-turn.js'
import { getTask, listPending, listTasks, patchAssignment } from '../lib/ledger.js'
import { buildView } from '../lib/viewmodel.js'
import { buildPrompt } from '../lib/engine.js'
import { createToolDefinitions } from '../lib/tools.js'

function payloadOf(text, options = {}) {
  const header = Object.assign({ id: options.sessionId ?? 'session-user-1' }, options.header ?? {})
  return {
    agent: { id: header.id, session: { header } },
    session: { header },
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      source: options.source ?? { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  }
}

async function captureOnce(hw, payload, options = {}) {
  const handlers = []
  installCapture({
    on: (name, handler) => { handlers.push(handler); return () => {} },
    judge: options.judge,
  }, options)
  const previous = process.env.DSH_SUPERAGENT_LEDGER
  process.env.DSH_SUPERAGENT_LEDGER = hw.file
  try {
    await handlers[0](payload)
    for (let index = 0; index < 40; index += 1) {
      const hasCard = listTasks({ includeArchived: true }, { file: hw.file }).tasks
        .some(task => task.description === payload.message.content[0].text)
      const hasPending = listPending({ file: hw.file }).pending
        .some(row => row.text === payload.message.content[0].text)
      if ((options.expect === 'card' && hasCard) || (options.expect === 'pending' && hasPending) || options.expect === 'none') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_SUPERAGENT_LEDGER
    else process.env.DSH_SUPERAGENT_LEDGER = previous
  }
}

const tasksOf = hw => listTasks({ includeArchived: true }, { file: hw.file }).tasks
const pendingOf = hw => listPending({ file: hw.file }).pending

// 1. 子会话（meta.parentSession / origin=subagent）：带触发词也不建卡、不进待确认。
{
  const hw = makeHarness()
  await captureOnce(hw, payloadOf('帮我记一下：子会话不该建卡', {
    sessionId: 'session-child-1',
    header: { parentSession: 'session-parent-1', origin: 'subagent' },
  }), { expect: 'none' })
  await captureOnce(hw, payloadOf('帮我记一下：origin 是 subagent 也不该建卡', {
    sessionId: 'session-child-2',
    header: { origin: 'subagent' },
  }), { expect: 'none' })
  assert.equal(tasksOf(hw).length, 0)
  assert.equal(pendingOf(hw).length, 0)
  hw.cleanup()
}

// 2. agent-message / subagent-settled 来源不落卡、不进待确认。
{
  const hw = makeHarness()
  await captureOnce(hw, payloadOf('帮我记一下：子智能体转来的话', { source: { kind: 'agent-message' } }), { expect: 'none' })
  await captureOnce(hw, payloadOf('帮我记一下：子智能体结束通知', { source: { kind: 'subagent-settled' } }), { expect: 'none' })
  assert.equal(tasksOf(hw).length, 0)
  assert.equal(pendingOf(hw).length, 0)
  hw.cleanup()
}

// 3. dsh_dot_* 会话不听（第一句是派工指令）。
{
  const hw = makeHarness()
  await captureOnce(hw, payloadOf('帮我记一下：Dot 派工的指令', { sessionId: 'dsh_dot_1234' }), { expect: 'none' })
  assert.equal(tasksOf(hw).length, 0)
  hw.cleanup()
}

// 4. 家庭主人会话照常听：带触发词建卡；不带触发词进待确认。
{
  const hw = makeHarness()
  const family = { sessionId: 'family_owner_abcd-1234' }
  await captureOnce(hw, payloadOf('帮我记一下：家庭助手转来的事', family), { expect: 'card' })
  assert.equal(tasksOf(hw).length, 1, 'family_owner 带触发词要建卡')
  await captureOnce(hw, payloadOf('下周安排一次家庭聚餐', family), {
    expect: 'pending',
    judge: async () => ({ isTask: true, title: '安排家庭聚餐' }),
  })
  assert.equal(pendingOf(hw).length, 1, 'family_owner 不带触发词进待确认')
  hw.cleanup()
}

// 5. turn 模式也不听子会话；family_owner 的话照常缓冲。
{
  const hw = makeHarness()
  let judged = 0
  const capture = createTurnCapture({
    file: hw.file,
    judge: async input => {
      judged += 1
      return { items: [{ kind: 'new', title: '家庭聚餐', text: input.text }] }
    },
  })
  assert.equal(capture.note(payloadOf('顺路买点水果', {
    sessionId: 'session-child-3',
    header: { parentSession: 'session-parent-1' },
  })), false)
  const skipped = await capture.handle({ type: 'turn/end', data: { agent: { id: 'session-child-3', session: { header: { parentSession: 'p' } } } } })
  assert.equal(skipped.judged, false)
  assert.equal(judged, 0)
  assert.equal(capture.note(payloadOf('帮我记一下：家庭会话里的话', { sessionId: 'family_owner_x' })), true)
  const family = await capture.handle({ type: 'turn/end', data: { agent: { id: 'family_owner_x' } } })
  assert.equal(family.judged, true)
  assert.equal(pendingOf(hw).length, 1)
  hw.cleanup()
}

// 6. 子会话有动静：执行会话 25 分钟没事件是 stuck；子会话刚有事件就回到 working；
//    孙辈的事件不起作用，也不改 lastTurn/状态。
{
  const hw = makeHarness()
  const card = hw.task({ title: 'S4 子会话动静' })
  const run = await hw.startConfirmed(card.id)
  const assignment = getTask(card.id, { file: hw.file }).assignments.find(item => item.state !== 'ended')
  const old = Date.now() - 25 * 60_000
  patchAssignment(card.id, assignment.id, {
    state: 'running',
    lastEventAt: old,
    lastTurn: { turn: 1, endKind: 'completed', detail: '', at: old },
  }, { file: hw.file })
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === card.id).stage, 'stuck')

  hw.engine.onEvent({
    type: 'turn/end',
    data: { agent: { id: 'session-child-a', session: { header: { parentSession: run.sessionId } } }, turn: 2, reason: { kind: 'completed' } },
  })
  const awake = getTask(card.id, { file: hw.file })
  const afterChild = awake.assignments.find(item => item.state !== 'ended')
  assert.ok(afterChild.lastEventAt > old, '子会话事件刷新了父派工的 lastEventAt')
  assert.deepEqual(afterChild.lastTurn, assignment.lastTurn ?? afterChild.lastTurn, '不记子会话的 lastTurn')
  assert.equal(afterChild.state, 'running', '不改派工状态')
  assert.equal(getTask(card.id, { file: hw.file }).status, 'in_progress', '不动卡')
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === card.id).stage, 'working')

  patchAssignment(card.id, assignment.id, { lastEventAt: old }, { file: hw.file })
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === card.id).stage, 'stuck')
  hw.engine.onEvent({
    type: 'turn/end',
    data: { agent: { id: 'session-grandchild', session: { header: { parentSession: 'session-child-a' } } }, turn: 1 },
  })
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === card.id).stage, 'stuck', '孙辈事件不算')
  hw.cleanup()
}

// 7. 工具说明固定两句；开场白有分工三句。
{
  const hw = makeHarness()
  const defs = createToolDefinitions(hw.engine)
  const line = '这是用户跨会话的事项台账。只在这次对话内部给子智能体分工时，用 team_task_*，不要记到这里。'
  assert.ok(defs.find(item => item.name === 'sa_list').description.includes(line))
  assert.ok(defs.find(item => item.name === 'sa_create').description.includes(line))
  const prompt = buildPrompt(getTask(hw.task({ title: 'S4 开场白' }).id, { file: hw.file }), hw.dir)
  assert.match(prompt, /活太大可以自己用 subagent 工具分给子智能体/)
  assert.match(prompt, /报告只由你交，子智能体不要调 sa_\*/)
  assert.match(prompt, /你等子智能体的时候不用另外报进度/)
  hw.cleanup()
}

console.log('s4-boundary: ok')
