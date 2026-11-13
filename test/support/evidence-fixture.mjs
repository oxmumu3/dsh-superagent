// S6 test helper: turn a card into a genuinely provable "ready" fixture.
// Production code only accepts ready when the checklist is complete with notes
// and the report carries checks; old tests that used ready as a mere stage
// builder call this first instead of weakening the gate.

import { checkItem, getTask, reportExecution, setChecklist } from '../../lib/ledger.js'

function currentSession(task) {
  return (task.assignments ?? []).filter(row => row && row.state !== 'ended').pop()?.sessionId ?? null
}

export function ensureEvidence(taskId, file, options = {}) {
  let task = getTask(taskId, { file })
  if (!Array.isArray(task.checklist) || !task.checklist.length) {
    setChecklist(taskId, options.items ?? ['做完并自验'], {
      file,
      sessionId: options.sessionId ?? currentSession(task),
    })
    task = getTask(taskId, { file })
  }
  for (const item of task.checklist) {
    if (item.checked && String(item.note ?? '').trim()) continue
    checkItem(taskId, item.id, { file, note: options.note ?? '测试：本地断言通过' })
  }
  return getTask(taskId, { file })
}

export function reportReady(taskId, file, extra = {}, options = {}) {
  ensureEvidence(taskId, file, options)
  return reportExecution(taskId, {
    outcome: 'ready',
    summary: '做完了',
    checks: ['node test'],
    ...extra,
  }, { file, ...(options.sessionId ? { sessionId: options.sessionId } : {}) })
}
