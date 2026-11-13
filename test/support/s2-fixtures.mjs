// Synthetic S2 fixture: a temporary ledger and enough ledger operations to
// create every stage without a host session or a real model.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addPending,
  beginDispatch,
  createEffect,
  createTask,
  failEffect,
  getTask,
  patchAssignment,
  readLedger,
  reportExecution,
  writeLedger,
} from '../../lib/ledger.js'
import { buildView } from '../../lib/viewmodel.js'

let sequence = 0

export function makeLedger(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2-fixture-'))
  const file = path.join(dir, 'ledger.json')
  const options = { file }
  const workspace = overrides.workspace === undefined ? dir : overrides.workspace

  function card(title, patch = {}) {
    return createTask({
      title,
      description: title,
      workspacePath: workspace,
      ...patch,
    }, options)
  }

  function dispatch(task, extra = {}) {
    sequence += 1
    const sessionId = extra.sessionId ?? `session-s2-${sequence}-${Date.now().toString(36)}`
    const created = beginDispatch(task.id, {
      sessionId,
      messageId: `msg-s2-${sequence}`,
      text: extra.text ?? 'synthetic prompt',
      cwd: extra.cwd === undefined ? workspace : extra.cwd,
    }, options)
    return { ...created, sessionId }
  }

  function failStart(task, reason = 'synthetic start failure') {
    const run = dispatch(task)
    failEffect(run.effect.id, reason, options)
    return run
  }

  function failDeliver(task, reason = 'synthetic delivery failure') {
    const run = dispatch(task)
    const effect = createEffect({
      kind: 'deliver',
      taskId: task.id,
      assignmentId: run.assignment.id,
      sessionId: run.sessionId,
      messageId: `msg-deliver-${sequence}`,
      text: 'synthetic delivery',
      cwd: workspace,
    }, options)
    failEffect(effect.id, reason, options)
    return run
  }

  function report(task, run, value) {
    return reportExecution(task.id, value, { ...options, sessionId: run.sessionId })
  }

  function patch(task, assignment, value) {
    return patchAssignment(task.id, assignment.id, value, options)
  }

  function pending(text, patchRow = {}) {
    return addPending({ text, title: text, workspacePath: workspace, ...patchRow }, options)
  }

  function raw(mutate) {
    const ledger = readLedger(file)
    mutate(ledger)
    writeLedger(ledger, file)
    return ledger
  }

  function view() {
    return buildView(options)
  }

  function stage(id) {
    return view().cards.find(row => row.id === id) ?? null
  }

  return {
    dir,
    file,
    options,
    workspace,
    card,
    dispatch,
    failStart,
    failDeliver,
    report,
    patch,
    pending,
    raw,
    view,
    stage,
    task: id => getTask(id, options),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

export function makeStageSet(fixture) {
  const rows = {}
  rows.not_started = fixture.card('S2 合成：没启动')
  fixture.failStart(rows.not_started, '合成启动失败')

  rows.not_delivered = fixture.card('S2 合成：没送到', { status: 'in_progress' })
  fixture.failDeliver(rows.not_delivered, '合成投递失败')

  rows.approval = fixture.card('S2 合成：等批准', { status: 'in_progress' })
  {
    const run = fixture.dispatch(rows.approval)
    fixture.patch(rows.approval, run.assignment, { waitingApproval: true })
  }

  rows.question = fixture.card('S2 合成：等回答', { status: 'in_progress' })
  {
    const run = fixture.dispatch(rows.question)
    fixture.report(rows.question, run, {
      outcome: 'progress',
      summary: '合成进度',
      question: { text: '要用哪个方案？', options: ['方案甲', '方案乙'] },
    })
  }

  rows.review = fixture.card('S2 合成：等验收', { status: 'in_progress' })
  {
    const run = fixture.dispatch(rows.review)
    fixture.report(rows.review, run, { outcome: 'ready', summary: '合成报告' })
  }

  rows.stuck = fixture.card('S2 合成：卡住')
  fixture.raw(ledger => {
    const task = ledger.tasks.find(row => row.id === rows.stuck.id)
    task.blocked = true
  })

  rows.silent = fixture.card('S2 合成：没交结果', { status: 'in_progress' })
  {
    const run = fixture.dispatch(rows.silent)
    fixture.patch(rows.silent, run.assignment, {
      state: 'idle',
      lastTurn: { turn: 1, endKind: 'completed', detail: '', at: Date.now() },
    })
  }

  rows.working = fixture.card('S2 合成：在跑', { status: 'in_progress' })
  fixture.dispatch(rows.working)

  rows.queued = fixture.card('S2 合成：排队')
  rows.later = fixture.card('S2 合成：以后再说', { status: 'backlog' })

  rows.done = fixture.card('S2 合成：今天做完', { status: 'done' })
  rows.canceled = fixture.card('S2 合成：取消', { status: 'canceled' })
  rows.oldDone = fixture.card('S2 合成：昨天做完', { status: 'done' })
  fixture.raw(ledger => {
    const task = ledger.tasks.find(row => row.id === rows.oldDone.id)
    task.updatedAt = Date.now() - 48 * 60 * 60 * 1000
  })
  return rows
}
