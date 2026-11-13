import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { reportExecution } from '../lib/ledger.js'
import { ensureEvidence } from './support/evidence-fixture.mjs'

// 4) turn/end 的六种 reason.kind：completed 的三种结果 + 其余五种都算卡住。
{
  // completed + ready -> review
  {
    const hw = makeHarness()
    const card = hw.task()
    hw.setTaskId(card.id)
    const run = await hw.startConfirmed(card.id)
    ensureEvidence(card.id, hw.file, { sessionId: run.sessionId })
    reportExecution(card.id, { outcome: 'ready', summary: '做完了', checks: ['node test'] }, { file: hw.file })
    hw.turnEnd(run.sessionId, 'completed')
    const info = hw.stage(card.id)
    assert.equal(info.stage, 'review')
    assert.equal(hw.reload().status, 'in_review')
    hw.cleanup()
  }

  // completed 没交报告 -> silent
  {
    const hw = makeHarness()
    const card = hw.task()
    hw.setTaskId(card.id)
    const run = await hw.startConfirmed(card.id)
    hw.turnEnd(run.sessionId, 'completed')
    assert.equal(hw.stage(card.id).stage, 'silent')
    hw.cleanup()
  }

  // completed 只交 progress -> silent
  {
    const hw = makeHarness()
    const card = hw.task()
    hw.setTaskId(card.id)
    const run = await hw.startConfirmed(card.id)
    reportExecution(card.id, { outcome: 'progress', summary: '做了一半' }, { file: hw.file })
    hw.turnEnd(run.sessionId, 'completed')
    assert.equal(hw.stage(card.id).stage, 'silent')
    hw.cleanup()
  }

  // completed 交 waiting -> working
  {
    const hw = makeHarness()
    const card = hw.task()
    hw.setTaskId(card.id)
    const run = await hw.startConfirmed(card.id)
    reportExecution(card.id, { outcome: 'waiting', summary: '等外部接口' }, { file: hw.file })
    hw.turnEnd(run.sessionId, 'completed')
    const info = hw.stage(card.id)
    assert.equal(info.stage, 'working')
    assert.match(info.reason, /等外部/)
    hw.cleanup()
  }

  const stuckCases = [
    ['aborted', { reason: { kind: 'user' } }, /被打断/],
    ['blocked', {}, /被拦下/],
    ['error', { error: { message: '模型报错' } }, /模型报错/],
    ['max-tokens', {}, /超出长度/],
    ['interrupted', {}, /中断/],
  ]
  for (const [kind, extra, expected] of stuckCases) {
    const hw = makeHarness()
    const card = hw.task()
    hw.setTaskId(card.id)
    const run = await hw.startConfirmed(card.id)
    hw.turnEnd(run.sessionId, kind, extra)
    const assignment = hw.reload().assignments[0]
    assert.equal(assignment.lastTurn.endKind, kind)
    const info = hw.stage(card.id)
    assert.equal(info.stage, 'stuck', `${kind} 应该算卡住`)
    assert.match(info.reason, expected, `${kind} 的说明要可读`)
    hw.cleanup()
  }
}

// 5) question -> question；answer 清问题、生成 deliver；确认后回到 working。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  const run = await hw.startConfirmed(card.id)
  hw.turnEnd(run.sessionId, 'completed')
  reportExecution(card.id, {
    outcome: 'progress',
    summary: '需要用户选一个方案',
    question: { text: '选 A 还是 B？', options: ['A', 'B'] },
  }, { file: hw.file })

  assert.equal(hw.stage(card.id).stage, 'question')
  assert.match(hw.stage(card.id).reason, /选 A 还是 B/)
  assert.deepEqual(hw.reload().openQuestion.options, ['A', 'B'])

  await hw.engine.answerTask(card.id, '选 A')
  await hw.engine.whenIdle()

  const row = hw.reload()
  assert.equal(row.openQuestion, null)
  assert.equal(row.comments.at(-1).author, 'user')
  assert.equal(row.comments.at(-1).body, '选 A')
  assert.equal(row.assignments[0].lastReport, null)
  assert.equal(hw.stage(card.id).stage, 'working')
  const followup = hw.calls.filter(call => call.type === 'followup').at(-1)
  assert.match(followup.message.content[0].text, /选 A/)
  hw.cleanup()
}

// 6) reject：回 in_progress、deliver 确认后 working；这一轮正常结束没再交报告 -> silent。
{
  const hw = makeHarness()
  const card = hw.task()
  hw.setTaskId(card.id)
  const run = await hw.startConfirmed(card.id)
  ensureEvidence(card.id, hw.file)
  reportExecution(card.id, { outcome: 'ready', summary: '第一版', checks: ['node test'] }, { file: hw.file })
  hw.turnEnd(run.sessionId, 'completed')
  assert.equal(hw.stage(card.id).stage, 'review')

  await hw.engine.rejectTask(card.id, '按钮位置不对')
  await hw.engine.whenIdle()

  let row = hw.reload()
  assert.equal(row.status, 'in_progress')
  assert.equal(row.assignments[0].lastReport, null)
  assert.equal(hw.stage(card.id).stage, 'working')
  assert.equal(row.executions.at(-1).state, 'ready', '旧报告还在，但不代表当前轮')

  hw.turnEnd(run.sessionId, 'completed')
  row = hw.reload()
  assert.equal(row.executions.at(-1).state, 'ready')
  assert.equal(hw.stage(card.id).stage, 'silent')
  hw.cleanup()
}

console.log('s1-stage: ok')
