// S3 第 4 阶段：一轮结束时的落卡判断（默认关）+ 待确认的「补到那张卡上」。
// 模型判断用合成实现；不调真模型、不读真实台账。

import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { createTurnCapture } from '../lib/capture-turn.js'
import { installCapture } from '../lib/capture.js'
import {
  addPending,
  getTask,
  listPending,
  listTasks,
  readCapture,
  updateCapture,
} from '../lib/ledger.js'
import { buildView } from '../lib/viewmodel.js'
import { registerRoutes } from '../lib/route.js'

function routesFor(engine) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name !== 'connection') return null
      return {
        fetch: {
          register(definition) {
            routes.set(definition.path, definition)
            return () => routes.delete(definition.path)
          },
        },
      }
    },
  }
  const dispose = registerRoutes(ctx, { engine })
  async function post(body) {
    const route = routes.get('/api/superagent/action')
    const response = await route.fetch(new Request('http://localhost/api/superagent/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { dispose, post }
}

function userMessage(text, extra = {}) {
  return {
    agent: { id: extra.sessionId ?? 'session-user-1' },
    session: { header: { cwd: extra.cwd ?? null } },
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      source: { kind: extra.sourceKind ?? 'user' },
      content: [{ type: 'text', text }],
    },
  }
}

const turnEnd = sessionId => ({ type: 'turn/end', data: { agent: { id: sessionId }, turn: 1 } })

// 公开预览默认 explicit：只听本人明确的记录指令，不叫模型、不写待确认。
// 旧的 message / turn 分类路径只有在显式 opt-in 时才回来。
{
  const hw = makeHarness()
  assert.equal(readCapture(hw.file).mode, 'explicit')
  updateCapture({ mode: 'turn' }, { file: hw.file })
  assert.equal(readCapture(hw.file).mode, 'turn')
  updateCapture({ mode: 'message' }, { file: hw.file })
  assert.equal(readCapture(hw.file).mode, 'message')
  // 旧台账只写了 mode、没有 optIn → 关闭分类路径。
  updateCapture({ mode: 'message', optIn: false }, { file: hw.file })
  assert.equal(readCapture(hw.file).mode, 'explicit')
  updateCapture({ mode: 'not-a-mode' }, { file: hw.file })
  assert.equal(readCapture(hw.file).mode, 'explicit')
  hw.cleanup()
}

// new：只写进待确认，不直接建卡、不直接送留言。
{
  const hw = makeHarness()
  const beforeTasks = listTasks({ includeArchived: true }, { file: hw.file }).total
  let received = null
  const capture = createTurnCapture({
    file: hw.file,
    judge: async input => {
      received = input
      return { items: [{ kind: 'new', title: '写周报', text: '周五前把周报写了' }] }
    },
  })
  capture.note(userMessage('周五前把周报写了', { cwd: hw.dir }))
  const result = await capture.handle(turnEnd('session-user-1'))
  assert.equal(result.judged, true)
  assert.equal(result.pending.length, 1)
  assert.deepEqual(received.texts, ['周五前把周报写了'])
  assert.equal(received.workspacePath, hw.dir)
  const rows = listPending({ file: hw.file }).pending
  assert.equal(rows.length, 1)
  assert.equal(rows[0].by, 'turn')
  assert.equal(rows[0].title, '写周报')
  assert.equal(rows[0].text, '周五前把周报写了')
  assert.equal(rows[0].sessionId, 'session-user-1')
  assert.equal(rows[0].workspacePath, hw.dir)
  assert.equal(rows[0].suggestedTaskId, null)
  assert.equal(
    listTasks({ includeArchived: true }, { file: hw.file }).total,
    beforeTasks,
    '不直接建卡',
  )
  hw.cleanup()
}

// attach：带卡号进待确认；面板上显示「补到那张卡上」。
{
  const hw = makeHarness()
  const card = hw.task({ title: 'S3 合成：装修方案' })
  const capture = createTurnCapture({
    file: hw.file,
    judge: async input => {
      const target = input.cards.find(row => row.id === card.id)
      assert.ok(target, '判断时能看到板上没结束的卡（只有编号和标题）')
      assert.deepEqual(Object.keys(target).sort(), ['id', 'title'])
      return { items: [{ kind: 'attach', taskId: card.id, title: '补一句', text: '顺便把阳台也算进去' }] }
    },
  })
  capture.note(userMessage('顺便把阳台也算进去'))
  const result = await capture.handle(turnEnd('session-user-1'))
  assert.equal(result.pending.length, 1)
  const view = buildView({ file: hw.file })
  assert.equal(view.pending.length, 1)
  assert.equal(view.pending[0].suggestedTaskId, card.id)
  assert.equal(view.pending[0].suggestedTitle, card.title)
  assert.equal(view.pending[0].attach, true)
  assert.equal(getTask(card.id, { file: hw.file }).comments.length, 0, '落卡判断不直接送留言')
  hw.cleanup()
}

// none、一轮多件事、同一句话不重复记。
{
  const hw = makeHarness()
  let call = 0
  const capture = createTurnCapture({
    file: hw.file,
    judge: async () => {
      call += 1
      if (call === 1) return { items: [{ kind: 'none' }] }
      return {
        items: [
          { kind: 'new', title: '订机票', text: '下周三之前订机票' },
          { kind: 'new', title: '写周报', text: '周五前把周报写了' },
          { kind: 'new', title: '订机票（重复）', text: '下周三之前订机票' },
        ],
      }
    },
  })
  capture.note(userMessage('今天先随便聊聊', { sessionId: 'session-user-a' }))
  const none = await capture.handle(turnEnd('session-user-a'))
  assert.equal(none.judged, true)
  assert.equal(none.pending.length, 0)

  capture.note(userMessage('下周三之前订机票', { sessionId: 'session-user-b' }))
  capture.note(userMessage('周五前把周报写了', { sessionId: 'session-user-b' }))
  const multi = await capture.handle(turnEnd('session-user-b'))
  assert.equal(multi.pending.length, 2, '一轮可以出多件事，重复的只留一条')
  assert.deepEqual(
    listPending({ file: hw.file }).pending.map(row => row.title).sort(),
    ['写周报', '订机票'].sort(),
  )
  hw.cleanup()
}

// 执行会话、非用户来源、空轮、问候、没有 judge、judge 失败都不写待确认。
{
  const hw = makeHarness()
  let called = 0
  const capture = createTurnCapture({
    file: hw.file,
    judge: async () => {
      called += 1
      throw new Error('合成模型坏了')
    },
  })
  assert.equal(capture.note(userMessage('执行会话里的话', { sessionId: 'session-sa-test-1' })), false)
  const internal = await capture.handle(turnEnd('session-sa-test-1'))
  assert.equal(internal.judged, false)
  assert.equal(capture.note(userMessage('插件来源的话', { sourceKind: 'plugin:dsh-superagent' })), false)
  const noText = await capture.handle(turnEnd('session-user-empty'))
  assert.equal(noText.judged, false)
  capture.note(userMessage('好的', { sessionId: 'session-user-greeting' }))
  const greeting = await capture.handle(turnEnd('session-user-greeting'))
  assert.equal(greeting.judged, false)

  capture.note(userMessage('帮我订个会议室', { sessionId: 'session-user-broken' }))
  const broken = await capture.handle(turnEnd('session-user-broken'))
  assert.equal(broken.judged, false)
  assert.equal(broken.reason, 'judge-failed')
  assert.equal(called, 1)
  assert.equal(listPending({ file: hw.file }).pending.length, 0)

  const noJudge = createTurnCapture({ file: hw.file })
  noJudge.note(userMessage('帮我订个会议室', { sessionId: 'session-user-nojudge' }))
  const skipped = await noJudge.handle(turnEnd('session-user-nojudge'))
  assert.equal(skipped.judged, false)
  assert.equal(skipped.reason, 'no-judge')
  hw.cleanup()
}

// message 模式（默认）：规则路径照旧；没有 judge 时不产生待确认。
{
  const hw = makeHarness()
  const handlers = []
  installCapture({ on: (name, handler) => { handlers.push(handler); return () => {} } }, {})
  const previous = process.env.DSH_SUPERAGENT_LEDGER
  process.env.DSH_SUPERAGENT_LEDGER = hw.file
  try {
    await handlers[0](userMessage('我一直在想一个长期任务：用代码 Agent 可控出图', { cwd: hw.dir }))
    assert.equal(listTasks({ includeArchived: true }, { file: hw.file }).total, 0, '没有触发词就不是卡')
    assert.equal(listPending({ file: hw.file }).pending.length, 0, '没有 judge 就不写待确认')
    await handlers[0](userMessage('帮我记一下：周五之前把面板做好', { cwd: hw.dir }))
  } finally {
    if (previous === undefined) delete process.env.DSH_SUPERAGENT_LEDGER
    else process.env.DSH_SUPERAGENT_LEDGER = previous
  }
  const ruled = listTasks({ includeArchived: true }, { file: hw.file }).tasks.find(task => task.createdBy === 'rule')
  assert.ok(ruled, '规则路径在 message 模式下照旧建卡')
  hw.cleanup()
}

// pending_attach：给那张卡加一条留言，有当前派工就送过去，然后移出待确认。
{
  const hw = makeHarness()
  const card = hw.task({ title: 'S3 合成：装修方案' })
  await hw.startConfirmed(card.id)
  const deliverBefore = hw.listEffects().filter(effect => effect.kind === 'deliver').length
  const row = addPending({
    text: '顺便把阳台也算进去',
    title: '补一句',
    workspacePath: hw.dir,
    suggestedTaskId: card.id,
    by: 'turn',
  }, { file: hw.file })

  const routes = routesFor(hw.engine)
  const attached = await routes.post({ action: 'pending_attach', id: row.id })
  assert.equal(attached.status, 200, `补到卡上应成功：${attached.body.error ?? ''}`)
  const saved = getTask(card.id, { file: hw.file })
  assert.equal(saved.comments.length, 1)
  assert.equal(saved.comments[0].body, '顺便把阳台也算进去')
  assert.equal(saved.comments[0].author, 'user')
  const deliverAfter = hw.listEffects().filter(effect => effect.kind === 'deliver')
  assert.equal(deliverAfter.length, deliverBefore + 1, '有当前派工就送过去')
  assert.ok(deliverAfter.some(effect => effect.text === '顺便把阳台也算进去'))
  assert.equal(listPending({ file: hw.file }).pending.length, 0, '处理完从待确认移走')

  // 没有执行会话时只记留言，不报错。
  const idle = hw.task({ title: 'S3 合成：还没开工' })
  const row2 = addPending({
    text: '开工时记得加一条日志',
    title: '补一句',
    workspacePath: hw.dir,
    suggestedTaskId: idle.id,
    by: 'turn',
  }, { file: hw.file })
  const idleAttach = await routes.post({ action: 'pending_attach', id: row2.id })
  assert.equal(idleAttach.status, 200)
  assert.equal(getTask(idle.id, { file: hw.file }).comments.length, 1)

  // 指定的卡不在板上 → 400，待确认保留。
  const row3 = addPending({ text: '补到不存在的卡', title: '补一句', workspacePath: hw.dir, by: 'turn' }, { file: hw.file })
  const missing = await routes.post({ action: 'pending_attach', id: row3.id })
  assert.equal(missing.status, 400)
  assert.equal(listPending({ file: hw.file }).pending.length, 1)
  routes.dispose()
  hw.cleanup()
}

// 端到端：turn 模式判断出来的待确认，在面板上补到卡上。
{
  const hw = makeHarness()
  updateCapture({ mode: 'turn' }, { file: hw.file })
  const card = hw.task({ title: 'S3 合成：发布稿' })
  const capture = createTurnCapture({
    file: hw.file,
    judge: async input => ({ items: [{ kind: 'attach', taskId: input.cards[0].id, title: '补一句', text: '开头加一段背景' }] }),
  })
  capture.note(userMessage('开头加一段背景', { cwd: hw.dir }))
  await capture.handle(turnEnd('session-user-1'))
  const pending = listPending({ file: hw.file }).pending
  assert.equal(pending.length, 1)
  assert.equal(pending[0].suggestedTaskId, card.id)
  const routes = routesFor(hw.engine)
  const result = await routes.post({ action: 'pending_attach', id: pending[0].id })
  assert.equal(result.status, 200)
  assert.match(getTask(card.id, { file: hw.file }).comments[0].body, /开头加一段背景/)
  assert.equal(listPending({ file: hw.file }).pending.length, 0)
  routes.dispose()
  hw.cleanup()
}

console.log('s3-capture-turn: ok')
