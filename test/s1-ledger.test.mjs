import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createTask, getTask, beginDispatch, beginSuccessorDelivery, confirmEffect,
  patchEffect, failEffect, reportExecution, addComment, listEffects,
  pruneConfirmedEffects, readLedger, currentAssignment, createEffect,
} from '../lib/ledger.js'
import { buildView } from '../lib/viewmodel.js'
import { ensureEvidence } from './support/evidence-fixture.mjs'

function tempLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-ledger-'))
  return { dir, file: path.join(dir, 'ledger.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

// A. 新卡带 S1 字段；派工与动作成对落盘；确认后派工 running。
{
  const { dir, file, cleanup } = tempLedger()
  const card = createTask({ title: '台账卡', workspacePath: dir }, { file })
  assert.deepEqual(card.assignments, [])
  assert.equal(card.openQuestion, null)
  assert.equal(card.workspacePath, dir)

  const created = beginDispatch(card.id, {
    sessionId: 'session-x',
    messageId: 'msg-x',
    text: '开场白',
    cwd: dir,
    provider: 'p',
    model: 'm',
  }, { file })
  assert.equal(created.assignment.state, 'pending')
  assert.equal(created.effect.state, 'pending')
  assert.equal(created.effect.assignmentId, created.assignment.id)
  assert.equal(getTask(card.id, { file }).status, 'in_progress')

  const confirmed = confirmEffect(created.effect.id, { file, attempts: 1 })
  assert.equal(confirmed.effect.state, 'confirmed')
  assert.equal(confirmed.assignment.state, 'running')
  assert.ok(confirmed.assignment.startedAt > 0)
  assert.equal(listEffects({ file }).length, 1)
  cleanup()
}

// B. 同一张卡不能同时有两条未结束派工。
{
  const { dir, file, cleanup } = tempLedger()
  const card = createTask({ title: '单派工', workspacePath: dir }, { file })
  beginDispatch(card.id, { sessionId: 's1', messageId: 'm1', text: 'x', cwd: dir }, { file })
  assert.throws(
    () => beginDispatch(card.id, { sessionId: 's2', messageId: 'm2', text: 'y', cwd: dir }, { file }),
    /已有未结束的派工/,
  )
  assert.equal(listEffects({ file }).length, 1)
  cleanup()
}

// C. 接班：旧派工 superseded，原 deliver 动作指到新派工，不另造一条动作。
{
  const { dir, file, cleanup } = tempLedger()
  const card = createTask({ title: '接班', workspacePath: dir }, { file })
  const first = beginDispatch(card.id, { sessionId: 's1', messageId: 'm1', text: 'x', cwd: dir }, { file })
  confirmEffect(first.effect.id, { file })

  const promoted = beginSuccessorDelivery(card.id, first.assignment.id, {
    effectId: first.effect.id,
    sessionId: 's2',
    messageId: 'm1',
    text: '带上下文的开场白',
    cwd: dir,
  }, { file })

  assert.equal(getTask(card.id, { file }).assignments.length, 2)
  assert.equal(getTask(card.id, { file }).assignments[0].endReason, 'superseded')
  assert.equal(promoted.effect.assignmentId, promoted.assignment.id)
  assert.equal(promoted.effect.sessionId, 's2')
  assert.equal(listEffects({ file }).length, 1, '不另造动作')
  cleanup()
}

// D. 结构化报告：outcome 动卡，question 进 openQuestion，lastReport 记录。
{
  const { dir, file, cleanup } = tempLedger()
  const card = createTask({ title: '报告卡', workspacePath: dir }, { file })
  const created = beginDispatch(card.id, { sessionId: 's1', messageId: 'm1', text: 'x', cwd: dir }, { file })
  confirmEffect(created.effect.id, { file })

  reportExecution(card.id, { outcome: 'progress', summary: '做一半' }, { file })
  let row = getTask(card.id, { file })
  assert.equal(row.status, 'in_progress')
  assert.equal(row.executions.at(-1).state, 'progress')
  assert.equal(currentAssignment(row).lastReport.outcome, 'progress')

  reportExecution(card.id, { outcome: 'waiting', summary: '等接口' }, { file })
  row = getTask(card.id, { file })
  assert.equal(row.status, 'in_progress')
  assert.equal(currentAssignment(row).lastReport.outcome, 'waiting')

  reportExecution(card.id, {
    outcome: 'progress',
    summary: '需要用户选',
    question: { text: '选哪个？', options: ['甲', '乙'] },
  }, { file })
  row = getTask(card.id, { file })
  assert.equal(row.openQuestion.text, '选哪个？')
  assert.deepEqual(row.openQuestion.options, ['甲', '乙'])
  assert.equal(row.openQuestion.assignmentId, created.assignment.id)

  reportExecution(card.id, { outcome: 'blocked', summary: '卡住了' }, { file })
  row = getTask(card.id, { file })
  assert.equal(row.blocked, true)

  ensureEvidence(card.id, file)
  reportExecution(card.id, { outcome: 'ready', summary: '做完了', checks: ['node test'] }, { file })
  row = getTask(card.id, { file })
  assert.equal(row.status, 'in_review')
  assert.equal(row.blocked, false)
  assert.equal(row.executions.at(-1).state, 'ready')

  ensureEvidence(card.id, file)
  reportExecution(card.id, { summary: '老调用不带 outcome', checks: ['node test'] }, { file })
  row = getTask(card.id, { file })
  assert.equal(row.executions.at(-1).state, 'ready', '不传 outcome 当 ready')
  cleanup()
}

// D2. 报告带来源：旧派工/未知会话的报告只留记录，不覆盖当前派工、也不动卡。
{
  const { dir, file, cleanup } = tempLedger()
  const card = createTask({ title: '报告来源', workspacePath: dir }, { file })
  const first = beginDispatch(card.id, { sessionId: 's1', messageId: 'm1', text: 'x', cwd: dir }, { file })
  confirmEffect(first.effect.id, { file })
  reportExecution(card.id, { outcome: 'progress', summary: '旧会话进度' }, { file, sessionId: 's1' })
  assert.equal(currentAssignment(getTask(card.id, { file })).lastReport.outcome, 'progress')

  const promoted = beginSuccessorDelivery(card.id, first.assignment.id, {
    sessionId: 's2', messageId: 'm2', text: '接班', cwd: dir,
  }, { file })
  assert.equal(currentAssignment(getTask(card.id, { file })).lastReport, null)

  reportExecution(card.id, { outcome: 'ready', summary: '旧会话迟到的报告' }, { file, sessionId: 's1' })
  let row = getTask(card.id, { file })
  assert.equal(currentAssignment(row).lastReport, null, '旧派工不能覆盖当前派工')
  assert.equal(row.status, 'in_progress', '旧派工的报告不能把卡推到待验收')
  assert.equal(row.executions.at(-1).sessionId, 's1', '报告仍留在执行记录里')

  ensureEvidence(card.id, file, { sessionId: 's2' })
  reportExecution(card.id, { outcome: 'ready', summary: '当前会话报告', checks: ['node test'] }, { file, sessionId: 's2' })
  row = getTask(card.id, { file })
  assert.equal(currentAssignment(row).id, promoted.assignment.id)
  assert.equal(currentAssignment(row).lastReport.outcome, 'ready')
  assert.equal(row.status, 'in_review')
  cleanup()
}

// E. 被打回后 deliver 被确认：lastReport 清空，卡 blocked 清掉。
{
  const { dir, file, cleanup } = tempLedger()
  const card = createTask({ title: '清报告', workspacePath: dir }, { file })
  const created = beginDispatch(card.id, { sessionId: 's1', messageId: 'm1', text: 'x', cwd: dir }, { file })
  confirmEffect(created.effect.id, { file })
  ensureEvidence(card.id, file)
  reportExecution(card.id, { outcome: 'ready', summary: '第一版', checks: ['node test'] }, { file })
  assert.ok(currentAssignment(getTask(card.id, { file })).lastReport)

  // 用公开接口造一条 deliver 动作，再确认。
  const effect = createEffect({
    kind: 'deliver',
    taskId: card.id,
    assignmentId: created.assignment.id,
    sessionId: 's1',
    messageId: 'm-deliver',
    text: '打回理由',
    cwd: dir,
  }, { file })
  confirmEffect(effect.id, { file })
  assert.equal(currentAssignment(getTask(card.id, { file })).lastReport, null)
  cleanup()
}

// F. 老卡：没有 assignments / effects / outcome，读出来不报错，stage 能算。
{
  const { dir, file, cleanup } = tempLedger()
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    revision: 3,
    pending: [],
    tasks: [
      {
        id: 't-old-review',
        title: '旧卡待验收',
        status: 'in_review',
        blocked: false,
        urgency: 'normal',
        comments: [],
        checklist: [],
        executions: [{ id: 'e-old', state: 'succeeded', summary: '旧报告', at: 1 }],
        createdAt: 1,
        updatedAt: 2,
      },
      {
        id: 't-old-blocked',
        title: '旧卡受阻',
        status: 'in_progress',
        blocked: true,
        urgency: 'normal',
        comments: [],
        checklist: [],
        executions: [],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  }))
  const ledger = readLedger(file)
  assert.deepEqual(ledger.effects, [], '缺失的 effects 按空处理')
  const view = buildView({ file })
  assert.equal(view.cards.find(c => c.id === 't-old-review').stage, 'review')
  assert.equal(view.cards.find(c => c.id === 't-old-blocked').stage, 'stuck')
  assert.equal(getTask('t-old-review', { file }).assignments, undefined, '不在读时迁移旧卡')

  addComment('t-old-review', '旧卡还能留言', { file, author: 'user' })
  assert.equal(getTask('t-old-review', { file }).comments.length, 1)
  assert.equal(getTask('t-old-review', { file }).assignments, undefined)
  cleanup()
}

// G. 已确认超过七天的动作可以清掉；失败的不清。
{
  const { dir, file, cleanup } = tempLedger()
  const card = createTask({ title: '清理', workspacePath: dir }, { file })
  const old = beginDispatch(card.id, { sessionId: 's1', messageId: 'm1', text: 'x', cwd: dir }, { file })
  confirmEffect(old.effect.id, { file })
  patchEffect(old.effect.id, { confirmedAt: Date.now() - 8 * 24 * 60 * 60_000 }, { file })

  const card2 = createTask({ title: '失败动作', workspacePath: dir }, { file })
  const failed = beginDispatch(card2.id, { sessionId: 's2', messageId: 'm2', text: 'y', cwd: dir }, { file })
  failEffect(failed.effect.id, 'boom', { file })

  const removed = pruneConfirmedEffects({ file })
  assert.equal(removed, 1)
  assert.equal(listEffects({ file }).length, 1)
  assert.equal(listEffects({ file })[0].state, 'failed')
  cleanup()
}

console.log('s1-ledger: ok')
