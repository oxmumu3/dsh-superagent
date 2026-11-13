// S6 A: evidence gate, checklist and move-bypass regression.
// Synthetic ledger only; no host, no real model, no daily data.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-a-'))
const file = path.join(dir, 'ledger.json')
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = file

const {
  beginDispatch, checkItem, createTask, getTask, listEffects, readLedger,
  reportExecution, setChecklist,
} = await import('../lib/ledger.js')
const { buildCardDetail, buildView, stageOf } = await import('../lib/viewmodel.js')
const { buildPrompt } = await import('../lib/engine.js')
const { createToolDefinitions } = await import('../lib/tools.js')
const { applyRequest } = await import('../lib/queue.js')

const clean = () => fs.rmSync(dir, { recursive: true, force: true })

const tools = new Map(createToolDefinitions({}).map(def => [def.name, def]))
async function callTool(name, args = {}, exec = {}) {
  const def = tools.get(name)
  assert.ok(def, `缺少工具 ${name}`)
  return def.execute(args, exec)
}

function dispatched(patch = {}) {
  const card = createTask({ title: 'S6 A 合成卡', workspacePath: dir, ...patch }, { file })
  const run = beginDispatch(card.id, {
    sessionId: `session-s6a-${card.id}`,
    messageId: `msg-s6a-${card.id}`,
    text: '合成开场白',
    cwd: dir,
  }, { file })
  return { card: getTask(card.id, { file }), sessionId: run.assignment.sessionId }
}

function prove(card, sessionId, report = {}) {
  setChecklist(card.id, ['第一项', '第二项'], { file, sessionId })
  const row = getTask(card.id, { file })
  for (const item of row.checklist) checkItem(card.id, item.id, { file, note: '已核对' })
  return reportExecution(card.id, { outcome: 'ready', summary: '做完', checks: ['node test'], ...report }, {
    file,
    sessionId,
  })
}

// 1. 四种拒收各一条；拒收后台账字节、revision、状态、阶段、lastReport 都不动。
let taskId = null
{
  const snap = () => ({
    bytes: fs.readFileSync(file, 'utf8'),
    revision: readLedger(file).revision,
    task: getTask(taskId, { file }),
    stage: stageOf(getTask(taskId, { file }), { effects: listEffects({ file }) }),
  })

  // 1a. 没有清单
  {
    const { card, sessionId } = dispatched()
    taskId = card.id
    const before = snap()
    await assert.rejects(
      () => callTool('sa_report', { id: card.id, summary: '做完', checks: ['node test'] }, { sessionId }),
      /还不能交：没有验收清单/,
    )
    assert.deepEqual(snap(), before, '没有清单被拒收后必须原样不动')
  }
  // 1b. 有清单但有一项没勾
  {
    const { card, sessionId } = dispatched({ checklist: ['第一项', '第二项'] })
    taskId = card.id
    checkItem(card.id, getTask(card.id, { file }).checklist[0].id, { file, note: '已核对' })
    const before = snap()
    await assert.rejects(
      () => callTool('sa_report', { id: card.id, summary: '做完', checks: ['node test'] }, { sessionId }),
      /还不能交：第 2 项没勾/,
    )
    assert.deepEqual(snap(), before, '缺勾选被拒收后必须原样不动')
  }
  // 1c. 勾了但没写 note
  {
    const { card, sessionId } = dispatched({ checklist: ['第一项', '第二项'] })
    taskId = card.id
    const row = getTask(card.id, { file })
    checkItem(card.id, row.checklist[0].id, { file, note: '已核对' })
    checkItem(card.id, row.checklist[1].id, { file })
    const before = snap()
    await assert.rejects(
      () => callTool('sa_report', { id: card.id, summary: '做完', checks: ['node test'] }, { sessionId }),
      /还不能交：第 2 项没写怎么验的/,
    )
    assert.deepEqual(snap(), before, '缺 note 被拒收后必须原样不动')
  }
  // 1d. 清单齐了但 checks 为空 / 缺省
  {
    const { card, sessionId } = dispatched({ checklist: ['第一项'] })
    taskId = card.id
    const row = getTask(card.id, { file })
    checkItem(card.id, row.checklist[0].id, { file, note: '已核对' })
    const before = snap()
    await assert.rejects(
      () => callTool('sa_report', { id: card.id, summary: '做完' }, { sessionId }),
      /还不能交：没写 checks/,
    )
    assert.deepEqual(snap(), before, '缺 checks 被拒收后必须原样不动')
    assert.equal(getTask(card.id, { file }).executions.length, 0)
  }
}

// 2. 全部满足 -> in_review；outcome 缺省同样按 ready 走闸门（先拒后收）。
{
  const { card, sessionId } = dispatched({ checklist: ['第一项'] })
  taskId = card.id
  const row = getTask(card.id, { file })
  checkItem(card.id, row.checklist[0].id, { file, note: '已核对' })

  await assert.rejects(
    () => callTool('sa_report', { id: card.id, summary: '没写 outcome 也没 checks' }, { sessionId }),
    /还不能交：没写 checks/,
    'outcome 缺省等于 ready，必须过闸门',
  )
  const accepted = await callTool('sa_report', {
    id: card.id, summary: '做完', checks: ['node test'],
  }, { sessionId })
  assert.match(accepted, /ready/)
  const after = getTask(card.id, { file })
  assert.equal(after.status, 'in_review')
  assert.equal(after.executions.at(-1).outcome, 'ready')
  assert.equal(after.assignments.at(-1).lastReport.outcome, 'ready')
}

// 3. dropped / blocked / failed / waiting / progress 不受证据门槛限制。
{
  const outcomes = ['dropped', 'blocked', 'failed', 'waiting', 'progress']
  for (const outcome of outcomes) {
    const { card, sessionId } = dispatched()
    taskId = card.id
    reportExecution(card.id, { outcome, summary: outcome }, { file, sessionId })
    const row = getTask(card.id, { file })
    if (outcome === 'dropped') {
      assert.equal(row.status, 'in_review', 'dropped 的可信正常路径保留')
    } else {
      assert.equal(row.status, 'in_progress', `${outcome} 不该被搬进待验收`)
    }
    if (outcome === 'blocked' || outcome === 'failed') assert.equal(row.blocked, true)
    if (outcome === 'progress' || outcome === 'waiting') assert.equal(row.blocked, false)
  }
}

// 3b. dropped 没有清单也能交；面板必须说「不用做了」，不能假装「做完了」。
{
  const { card, sessionId } = dispatched()
  taskId = card.id
  reportExecution(card.id, { outcome: 'dropped', summary: '确认不用做了' }, { file, sessionId })
  const view = buildView({ file })
  const entry = view.cards.find(row => row.id === card.id)
  assert.equal(entry.stage, 'review')
  assert.match(entry.reason, /不用做了，等你确认/)
  assert.doesNotMatch(entry.reason, /做完了/)
  assert.equal(entry.checklist.length, 0)
  assert.equal(entry.actions.find(action => action.action === 'accept').label, '确认不做')
}

// 4. 模型 sa_move 与外部 move 都不能直接把卡带进 in_review；低层历史状态照读。
{
  const { card } = dispatched({ checklist: ['第一项'] })
  taskId = card.id
  const version = getTask(card.id, { file }).version
  await assert.rejects(
    () => callTool('sa_move', { id: card.id, status: 'in_review', ifVersion: version }),
    /in_review 只能由带齐验收证据的 sa_report ready 进入/,
  )
  const external = applyRequest({ id: 'q-move-review', action: 'move', payload: { id: card.id, status: 'in_review' } })
  assert.equal(external.ok, false)
  assert.match(String(external.error), /in_review 只能由带齐验收证据/)
  assert.equal(getTask(card.id, { file }).status, 'in_progress')
  // 合法的非验收移动仍然可用。
  const moved = await callTool('sa_move', { id: card.id, status: 'todo', ifVersion: version })
  assert.match(moved, /todo/)
}

// 5. sa_checklist：只有当前派工会话、只在没有清单时能写；0/9 条拒绝。
{
  const { card, sessionId } = dispatched()
  taskId = card.id
  await assert.rejects(
    () => callTool('sa_checklist', { id: card.id, items: ['怎么算做完'] }, {}),
    /拿不到当前执行会话身份/,
  )
  await assert.rejects(
    () => callTool('sa_checklist', { id: card.id, items: ['怎么算做完'] }, { sessionId: 'session-other' }),
    /只有这张卡当前的执行会话/,
  )
  await assert.rejects(
    () => callTool('sa_checklist', { id: card.id, items: [] }, { sessionId }),
    /至少 1 条/,
  )
  await assert.rejects(
    () => callTool('sa_checklist', { id: card.id, items: Array.from({ length: 9 }, (_, i) => `第 ${i} 项`) }, { sessionId }),
    /最多 8 条/,
  )
  assert.equal(getTask(card.id, { file }).checklist.length, 0)

  const written = await callTool('sa_checklist', { id: card.id, items: ['本地测试通过', '文档已更新'] }, { sessionId })
  const row = getTask(card.id, { file })
  assert.equal(row.checklist.length, 2)
  for (const item of row.checklist) assert.match(written, new RegExp(`id: ${item.id}`))

  // 已有清单（用户建的）不能改写。
  const userCard = createTask({ title: '用户清单卡', workspacePath: dir, checklist: ['用户写的项'] }, { file })
  beginDispatch(userCard.id, { sessionId: 'session-s6a-user', messageId: 'msg-user', text: 'x', cwd: dir }, { file })
  await assert.rejects(
    () => callTool('sa_checklist', { id: userCard.id, items: ['模型想改的项'] }, { sessionId: 'session-s6a-user' }),
    /已经有验收清单/,
  )
  assert.deepEqual(getTask(userCard.id, { file }).checklist.map(item => item.text), ['用户写的项'])
  // 用户已有清单的卡也能从 sa_get 发现 itemId，并正常 sa_check。
  const userView = await callTool('sa_get', { id: userCard.id })
  const userId = (userView.match(/id: (k-[a-z0-9-]+)/) ?? [])[1]
  assert.ok(userId, '用户清单也要有稳定 itemId')
  const userChecked = await callTool('sa_check', { id: userCard.id, itemId: userId, note: '按用户清单验过' }, { sessionId: 'session-s6a-user' })
  assert.match(userChecked, /已勾选/)
  assert.equal(getTask(userCard.id, { file }).checklist[0].note, '按用户清单验过')
}

// 6. 模型靠 sa_get 的稳定 itemId 发现并 sa_check；evidence 存路径、第六条拒绝；review 视图带 note/evidence。
{
  const { card, sessionId } = dispatched()
  taskId = card.id
  await callTool('sa_checklist', { id: card.id, items: ['可核对的一项'] }, { sessionId })
  const got = await callTool('sa_get', { id: card.id })
  const itemId = (got.match(/id: (k-[a-z0-9-]+)/) ?? [])[1]
  assert.ok(itemId, `sa_get 必须给出稳定 itemId：${got}`)

  await assert.rejects(
    () => callTool('sa_check', { id: card.id, itemId, note: '没有身份' }),
    /拿不到当前执行会话身份/,
  )
  const checked = await callTool('sa_check', {
    id: card.id, itemId, note: 'node test 全绿', evidence: ['artifacts/proof.txt'],
  }, { sessionId })
  assert.match(checked, /证据 1 个/)
  const row = getTask(card.id, { file })
  assert.equal(row.checklist[0].checked, true)
  assert.equal(row.checklist[0].note, 'node test 全绿')
  assert.deepEqual(row.checklist[0].evidence, [path.join(dir, 'artifacts/proof.txt')])
  assert.equal(fs.existsSync(path.join(dir, 'artifacts/proof.txt')), false, '只存路径，不读、不建文件')

  await assert.rejects(
    () => callTool('sa_check', {
      id: card.id, itemId, note: '太多', evidence: ['1', '2', '3', '4', '5', '6'],
    }, { sessionId }),
    /最多 5 个/,
  )

  await callTool('sa_report', { id: card.id, summary: '完成', checks: ['node test'] }, { sessionId })
  const view = buildView({ file })
  const review = view.cards.find(entry => entry.id === card.id)
  assert.equal(review.stage, 'review')
  assert.equal(review.checklist[0].note, 'node test 全绿')
  assert.deepEqual(review.checklist[0].evidence, [path.join(dir, 'artifacts/proof.txt')])
  const detail = buildCardDetail(getTask(card.id, { file }))
  assert.equal(detail.checklist[0].evidence.length, 1)
}

// 7. 开场白：没有清单带「先写清单」；有清单不带。
{
  const bare = createTask({ title: '没有清单', workspacePath: dir }, { file })
  const withList = createTask({ title: '有清单', workspacePath: dir, checklist: ['先做这个'] }, { file })
  const a = buildPrompt(getTask(bare.id, { file }), dir)
  const b = buildPrompt(getTask(withList.id, { file }), dir)
  assert.match(a, /还没有验收清单/)
  assert.match(a, /sa_checklist/)
  assert.doesNotMatch(b, /还没有验收清单/)
  assert.match(b, /验收清单/)
}

// 8. 回退兼容：旧数字段仍在，新增字段不改变卡号/状态/阶段。
{
  const row = getTask(taskId ?? createTask({ title: '兼容卡' }, { file }).id, { file })
  assert.equal(typeof row.id, 'string')
  assert.ok(['todo', 'in_progress', 'in_review'].includes(row.status))
  assert.equal(typeof stageOf(row, { effects: listEffects({ file }) }).stage, 'string')
}

clean()
console.log('s6-a: ok')
