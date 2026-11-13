// Compare the router-off view and ledger compatibility with the public preview.1.
// The fixture files are unchanged from the v0.2.0-preview.1 Git tag.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildView, stageOf } from '../lib/viewmodel.js'
import { beginDispatch, createTask, readLedger, updateRouter } from '../lib/ledger.js'

import * as previewViewmodel from './fixtures/public-preview-1/viewmodel.js'
import * as previewLedger from './fixtures/public-preview-1/ledger.js'

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 's4-off-'))
}

function writeFixedLedger(dir, workspace) {
  const file = path.join(dir, 'ledger.json')
  const base = 1_760_000_000_000
  const task = (id, patch) => ({
    id,
    title: `S4 合成 ${id}`,
    description: '',
    prompt: '',
    workspaceId: null,
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'claim' },
    isolation: 'none',
    permission: null,
    version: 2,
    createdAt: base,
    updatedAt: base,
    createdBy: 'user',
    updatedBy: 'user',
    sourceSessionId: null,
    workspacePath: workspace,
    assignments: [],
    openQuestion: null,
    comments: [],
    checklist: [],
    executions: [],
    ...patch,
  })
  const tasks = [
    task('t-queued', {}),
    task('t-working', {
      status: 'in_progress',
      assignments: [{
        id: 'a-working', sessionId: 'session-sa-fixed-1', state: 'running',
        createdAt: base, startedAt: base, lastEventAt: base, endedAt: null,
        lastTurn: null, lastReport: null, waitingApproval: false, endReason: null, cwd: workspace,
      }],
    }),
    task('t-review', { status: 'in_review' }),
    task('t-stuck', { blocked: true }),
    task('t-later', { status: 'backlog' }),
    task('t-done', { status: 'done' }),
    task('t-failed', {}),
  ]
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    tasks,
    pending: [],
    effects: [{
      id: 'fx-failed', kind: 'start', taskId: 't-failed', assignmentId: null,
      sessionId: null, messageId: 'msg-fixed', text: '合成', state: 'failed',
      attempts: 1, nextAttemptAt: null, lastError: '合成启动失败', createdAt: base,
      confirmedAt: null, cwd: workspace, provider: null, model: null, reasoningEffort: null,
    }],
  }, null, 2))
  return file
}

function stripS4(view) {
  const copy = JSON.parse(JSON.stringify(view))
  if (copy.router) delete copy.router.sameDir
  delete copy.notify
  delete copy.acceptanceRules
  delete copy.vents
  for (const rows of Object.values(copy.groups)) for (const card of rows) {
    delete card.sessionId
    delete card.rejectCount
    delete card.checklist
  }
  for (const card of copy.cards) {
    delete card.sessionId
    delete card.rejectCount
    delete card.checklist
  }
  return copy
}

// 11. off 档：S4 的 buildView 去掉新字段后，和 S3 的 buildView 相同。
{
  const dir = makeWorkspace()
  const file = writeFixedLedger(dir, dir)
  updateRouter({ mode: 'off', sameDir: 'wait' }, { file })
  const s4View = stripS4(buildView({ file }))
  const s3View = previewViewmodel.buildView({ file })
  s4View.at = 0
  s3View.at = 0
  assert.deepEqual(s4View, s3View, 'off 档下视图必须和 S3 一致')
  fs.rmSync(dir, { recursive: true, force: true })
}

// 12. S3 的代码读 S4 写出来的台账（dependsOn、executor、router.sameDir）：不报错，编号/状态/阶段不变。
{
  const dir = makeWorkspace()
  const file = path.join(dir, 'ledger.json')
  const options = { file }
  const done = createTask({ title: 'S4 兼容：已经做完', workspacePath: dir }, options)
  beginDispatch(done.id, { sessionId: 'session-sa-compat-done', messageId: 'msg-c1', text: '合成', cwd: dir }, options)
  previewLedger.moveTask(done.id, 'in_progress', options)
  previewLedger.moveTask(done.id, 'in_review', options)
  previewLedger.moveTask(done.id, 'done', options)

  const dependent = createTask({
    title: 'S4 兼容：等上面那张',
    workspacePath: dir,
    queue: { auto: true, by: 'user' },
    dependsOn: [done.id],
  }, options)
  const working = createTask({ title: 'S4 兼容：在跑', workspacePath: dir, status: 'in_progress' }, options)
  beginDispatch(working.id, { sessionId: 'session-sa-compat-2', messageId: 'msg-c2', text: '合成', cwd: dir }, options)
  const review = createTask({ title: 'S4 兼容：等验收', workspacePath: dir, status: 'in_review' }, options)
  updateRouter({ mode: 'observe', sameDir: 'allow' }, { file })

  const s4View = buildView({ file })
  const s4Tasks = s4View.cards
  assert.ok(s4Tasks.find(card => card.id === dependent.id), 'S4 自己读得出来')
  const read = previewLedger.listTasks({ includeArchived: true }, options)
  assert.equal(read.total, 4, 'S3 能读出全部卡')
  assert.deepEqual(
    read.tasks.map(row => row.id).sort(),
    [done.id, dependent.id, working.id, review.id].sort(),
  )
  assert.deepEqual(read.tasks.map(row => row.status).sort(), ['done', 'in_progress', 'in_review', 'todo'])
  const workingRow = read.tasks.find(row => row.id === working.id)
  assert.equal(workingRow.assignments[0].executor.kind, 'dsh-session')
  assert.deepEqual(read.tasks.find(row => row.id === dependent.id).dependsOn, [done.id])
  assert.equal(readLedger(file).router.sameDir, 'allow', 'S4 台账里确实写了 sameDir')
  assert.ok(read.tasks.every(task => Array.isArray(task.dependsOn) || task.dependsOn === undefined))

  const s3View = previewViewmodel.buildView({ file })
  for (const taskId of [done.id, dependent.id, working.id, review.id]) {
    const before = s4View.cards.find(card => card.id === taskId)
    const after = s3View.cards.find(card => card.id === taskId)
    assert.ok(before && after)
    assert.equal(after.stage, before.stage, `${taskId} 的阶段不能被 S3 读歪`)
    assert.equal(after.reason, before.reason)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('s4-off: ok')
