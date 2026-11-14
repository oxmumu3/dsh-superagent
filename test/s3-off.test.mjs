// S3 第 1 阶段：off 档和 S2 一致。
//
// 公开仓库不带内部 Git 历史，所以不再从历史提交里取 S2 代码：对照物是一份
// 冻结的 golden（`test/fixtures/s2-off-view.json`，由 ac6f2d1 的 S2
// `buildView()` 在同一份合成台账上生成）。这里只核对结果形状，不需要 git。
// 全部是合成台账；不启动宿主、不调模型。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildView, stageOf } from '../lib/viewmodel.js'
import { beginDispatch, createTask, updateRouter } from '../lib/ledger.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 's2-off-view.json'), 'utf8'))

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 's3-off-'))
}

// 一份确定的合成台账：覆盖排队、在跑、等验收、卡住、以后再说、今天做完。
function writeFixedLedger(dir) {
  const workspace = dir
  const file = path.join(dir, 'ledger.json')
  const base = 1_760_000_000_000
  const task = (id, patch) => ({
    id,
    title: `S3 合成 ${id}`,
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
        id: 'a-working',
        sessionId: 'session-sa-fixed-1',
        state: 'running',
        createdAt: base,
        startedAt: base,
        lastEventAt: base,
        endedAt: null,
        lastTurn: null,
        lastReport: null,
        waitingApproval: false,
        endReason: null,
        cwd: workspace,
      }],
    }),
    task('t-review', { status: 'in_review' }),
    task('t-stuck', { blocked: true }),
    task('t-later', { status: 'backlog' }),
    task('t-done', { status: 'done' }),
    task('t-failed', {}),
  ]
  const effects = [{
    id: 'fx-failed',
    kind: 'start',
    taskId: 't-failed',
    assignmentId: null,
    sessionId: null,
    messageId: 'msg-fixed',
    text: '合成',
    state: 'failed',
    attempts: 1,
    nextAttemptAt: null,
    lastError: '合成启动失败',
    createdAt: base,
    confirmedAt: null,
    cwd: workspace,
    provider: null,
    model: null,
    reasoningEffort: null,
  }]
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    tasks,
    pending: [],
    effects,
  }, null, 2))
  return file
}

function normalizeView(view, workspace) {
  const copy = JSON.parse(JSON.stringify(view)
    .replaceAll(workspace, '<workspace>')
    .replaceAll(path.basename(workspace), '<workspace-label>'))
  copy.at = 0
  copy.revision = 0
  delete copy.router
  delete copy.notify
  for (const rows of Object.values(copy.groups)) {
    for (const card of rows) {
      delete card.auto
      delete card.position
      delete card.sessionId
      delete card.rejectCount
      delete card.checklist
    }
  }
  for (const card of copy.cards) {
    delete card.auto
    delete card.position
    delete card.sessionId
    delete card.rejectCount
    delete card.checklist
  }
  delete copy.acceptanceRules
  delete copy.vents
  return copy
}

// 1. off 档：去掉 S3 新字段后，视图和冻结的 S2 golden 相同。
{
  const dir = makeWorkspace()
  const file = writeFixedLedger(dir)
  updateRouter({ mode: 'off' }, { file })
  const fixedNow = 1_760_000_000_000 + 400 * 86_400_000
  const view = normalizeView(buildView({ file, now: fixedNow }), dir)
  const expected = JSON.parse(JSON.stringify(golden.view))
  expected.revision = 0
  assert.deepEqual(view, expected, 'off 档下视图必须和 S2 golden 一致')
  assert.equal(view.router, undefined, 'S2 golden 没有 router 字段')
  fs.rmSync(dir, { recursive: true, force: true })
}

// 2. 同一份合成台账的阶段判断和 S2 golden 一致。
{
  const dir = makeWorkspace()
  const file = writeFixedLedger(dir)
  updateRouter({ mode: 'off' }, { file })
  const fixedNow = 1_760_000_000_000 + 400 * 86_400_000
  const view = buildView({ file, now: fixedNow })
  const stages = Object.fromEntries(view.cards.map(card => [card.id, card.stage]))
  assert.deepEqual(stages, golden.stages, '阶段不能被 S3 的默认值读歪')
  fs.rmSync(dir, { recursive: true, force: true })
}

// 3. 当前台账写出来的卡仍保有 S2 认识的字段，阶段也和 golden 一致。
{
  const dir = makeWorkspace()
  const options = { file: path.join(dir, 'ledger.json') }
  const queued = createTask({ title: 'S3 合成：自动排队', workspacePath: dir, queue: { auto: true, by: 'rule' } }, options)
  const working = createTask({ title: 'S3 合成：在跑', workspacePath: dir, status: 'in_progress' }, options)
  beginDispatch(working.id, { sessionId: 'session-sa-compat-1', messageId: 'msg-compat-1', text: '合成', cwd: dir }, options)
  const review = createTask({ title: 'S3 合成：等验收', workspacePath: dir, status: 'in_review' }, options)
  const done = createTask({ title: 'S3 合成：做完', workspacePath: dir, status: 'done' }, options)

  const view = buildView({ file: options.file })
  const expect = { [queued.id]: 'queued', [working.id]: 'working', [review.id]: 'review', [done.id]: 'closed' }
  for (const taskId of Object.keys(expect)) {
    const card = view.cards.find(row => row.id === taskId)
    assert.ok(card, '每张卡都要进视图')
    assert.equal(card.stage, expect[taskId], `${taskId} 的阶段`)
    for (const field of ['id', 'title', 'stage', 'version', 'actions']) {
      assert.ok(field in card, `S2 认识的基础字段仍在：${field}`)
    }
  }
  assert.equal(stageOf(JSON.parse(fs.readFileSync(options.file, 'utf8')).tasks.find(row => row.id === working.id), {
    effects: [], now: 1_760_000_000_000,
  }).stage, 'working')
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('s3-off: ok')
