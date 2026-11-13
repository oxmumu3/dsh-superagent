import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installCapture } from '../lib/capture.js'
import { applyRequest } from '../lib/queue.js'
import { registerTools } from '../lib/tools.js'
import { describeDispatch } from '../lib/policy.js'
import { createTask, getTask, listTasks } from '../lib/ledger.js'
import { makeHarness } from './support/harness.mjs'

// 所有接线测试只碰临时台账。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-wiring-'))
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = path.join(dir, 'ledger.json')

// 1) 规则落卡：来源会话的目录写进 workspacePath。
{
  let handler
  installCapture({ on: (_name, fn) => { handler = fn; return () => {} } }, {})
  await handler({
    agent: { id: 'session-user-1', meta: { cwd: dir } },
    message: {
      id: 'm-1',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '记一下：明天把报销单交财务。' }],
    },
  })
  const tasks = listTasks({ includeArchived: true }).tasks
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].workspacePath, dir)
  assert.equal(tasks[0].sourceSessionId, 'session-user-1')
}

// 1b) capture 也认 0.2.2 的 session.header.cwd 与 agent.session.header.id。
{
  let handler
  installCapture({ on: (_name, fn) => { handler = fn; return () => {} } }, {})
  await handler({
    agent: { session: { header: { id: 'session-user-2' } } },
    session: { header: { cwd: dir } },
    message: {
      id: 'm-2',
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '记一下：把窗口尺寸记到备忘录。' }],
    },
  })
  const task = listTasks({ includeArchived: true }).tasks.find(t => t.title.includes('窗口尺寸'))
  assert.ok(task, '应该建卡')
  assert.equal(task.workspacePath, dir)
  assert.equal(task.sourceSessionId, 'session-user-2')
}

// 2) 外部写队列的留言会触发投递回调。
{
  const card = createTask({ title: '队列留言卡' })
  let seen = null
  const result = applyRequest(
    { id: 'q-1', action: 'comment', payload: { id: card.id, body: '外部留言' } },
    { onComment: (task, body) => { seen = { id: task.id, body } } },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(seen, { id: card.id, body: '外部留言' })
  assert.equal(getTask(card.id).comments.length, 1)
}

// 3) 工具：sa_report 用结构化 outcome 并自己动卡；sa_comment 记留言。
{
  const defs = new Map()
  const tools = {
    register(definition) {
      defs.set(definition.name, definition)
      return () => defs.delete(definition.name)
    },
  }
  const dispose = registerTools(tools, {})
  assert.ok(defs.has('sa_report'))
  assert.ok(defs.has('sa_comment'))
  assert.ok(!defs.has('sa_dispatch'), 'sa_dispatch 在 index.js 接宿主')

  const card = createTask({ title: '工具报告卡' })
  const report = await defs.get('sa_report').execute({
    id: card.id,
    summary: '做完了',
    outcome: 'ready',
    question: { text: '还要不要加日志？' },
  })
  const row = getTask(card.id)
  assert.equal(row.status, 'in_review')
  assert.equal(row.executions.at(-1).state, 'ready')
  assert.equal(row.openQuestion.text, '还要不要加日志？')
  assert.match(report, /ready/)

  const comment = await defs.get('sa_comment').execute({ id: card.id, body: '补一句' })
  assert.match(comment, /已留言/)
  assert.equal(getTask(card.id).comments.length, 1)
  dispose()
}

// 4) 派工文案：排队的说「已记下」，重复派工不谎报新会话，失败带原因。
{
  assert.equal(
    describeDispatch({ ok: true, queued: true, sessionId: 's-1' }, 't-1'),
    '已记下 t-1，正在启动（会话 s-1）',
  )
  assert.equal(
    describeDispatch({ ok: true, queued: true, deduped: true, sessionId: 's-1' }, 't-1'),
    '这张卡已经在跑：t-1（会话 s-1）',
  )
  assert.throws(
    () => describeDispatch({ ok: false, error: '这张卡没有项目目录，不能开始' }, 't-2'),
    /没有项目目录/,
  )
}

// 5) sa_comment 只有拿到投递证据才写「已送」；确认前只说已记录、等确认。
{
  const hw = makeHarness({ confirmTimeoutMs: 30 })
  hw.state.autoConfirm = false
  process.env.DSH_HOME = hw.dir
  process.env.DSH_SUPERAGENT_LEDGER = hw.file

  const card = createTask({ title: '等待确认的留言', workspacePath: hw.dir }, { file: hw.file })
  const defs = new Map()
  registerTools({
    register(definition) {
      defs.set(definition.name, definition)
      return () => {}
    },
  }, { engine: hw.engine })

  await hw.engine.startTask(card.id)
  const text = await defs.get('sa_comment').execute({ id: card.id, body: '请补充日志' })
  assert.match(text, /已记录，等待宿主确认/)
  assert.doesNotMatch(text, /已送到/)
  await hw.engine.whenIdle()
  hw.cleanup()
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('s1-wiring: ok')
