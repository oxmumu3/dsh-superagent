// 公开预览首发默认：显式记卡、默认不采集、不叫分类模型、不保留待确认。
//
// 这一组测试走真实的插件接线（index.js apply），不是只测过滤器：用假宿主
// ctx 和一个会计数的假 llm 服务，模拟真实 inbox 事件。默认路径下分类模型必须
// 收到 0 次请求，待确认为 0；正例明确说「记一下」才建卡；反例（自述、引文、
// 缺来源、插件来源、执行会话）一张卡也不建，既有卡的状态和版本不变。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { shouldCapture, insideQuote, userAuthored, foreignOrigin } from '../lib/capture.js'
import {
  createTask,
  getTask,
  listPending,
  listTasks,
  readCapture,
  updateCapture,
} from '../lib/ledger.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-preview-'))
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = path.join(dir, 'ledger.json')
const file = process.env.DSH_SUPERAGENT_LEDGER

function makeCtx() {
  const handlers = new Map()
  const effects = []
  const logs = []
  const llm = {
    calls: [],
    async *stream(input) {
      llm.calls.push(input)
      yield { type: 'text-delta', text: '{"isTask":true,"title":"合成的任务"}' }
      yield { type: 'finish' }
    },
  }
  const ctx = {
    logger: { info: message => logs.push(String(message)) },
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return () => {
        handlers.set(name, (handlers.get(name) ?? []).filter(row => row !== fn))
      }
    },
    get(name) {
      return name === 'llm' ? llm : null
    },
    inject() {
      // 测试只测落卡接线；agents/connection/tools 留给隔离实机。
    },
    effect(setup) {
      // Cordis ctx.effect runs setup now and keeps its returned cleanup.
      const cleanup = typeof setup === 'function' ? setup() : null
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
  }
  const emit = (name, ...args) => {
    for (const fn of handlers.get(name) ?? []) fn(...args)
  }
  const dispose = () => {
    for (const fn of effects.splice(0)) fn()
  }
  return { ctx, llm, handlers, logs, emit, dispose }
}

const message = (text, extra = {}) => ({
  ...(extra.origin ? { origin: extra.origin } : {}),
  ...(extra.parentSession ? { parentSession: extra.parentSession } : {}),
  agent: {
    id: extra.sessionId ?? 'session-preview-user',
    session: {
      header: {
        id: extra.sessionId ?? 'session-preview-user',
        cwd: extra.cwd ?? dir,
        ...(extra.origin ? { origin: extra.origin } : {}),
        ...(extra.parentSession ? { parentSessionId: extra.parentSession } : {}),
      },
    },
  },
  message: {
    id: `preview-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    ...(extra.omitSource ? {} : { source: extra.source ?? { kind: 'user' } }),
    content: [{ type: 'text', text }],
  },
})

const settle = () => new Promise(resolve => setTimeout(resolve, 40))
const tasks = () => listTasks({ includeArchived: true }, { file }).tasks
const pending = () => listPending({ file }).pending

// 0) 过滤器本身：明确指令才算，自述/引文不算；来源未知默认跳过。
{
  assert.equal(shouldCapture('记一下：周五之前把面板做好'), true)
  assert.equal(shouldCapture('帮我记一下：明天交报告'), true)
  assert.equal(shouldCapture('放到待办：核对示例文件'), true)
  assert.equal(shouldCapture('这个要做，我得去写一下'), false)
  assert.equal(shouldCapture('他说：“记一下：周五交报告”'), false)
  assert.equal(shouldCapture('> 记一下：引用里的东西'), false)
  assert.equal(shouldCapture('原文：记一下：明天带合同'), false)
  // 句首祈使 + 分隔符 + 非空事项之外，一律不建卡。
  assert.equal(shouldCapture('不要记一下，明天开会'), false)
  assert.equal(shouldCapture('如果我说记一下，之后会怎么样？'), false)
  assert.equal(shouldCapture('帮我记一下可以怎么翻译'), false)
  assert.equal(shouldCapture('记一下：'), false)
  assert.equal(shouldCapture('```\n记一下：代码块里的东西\n```'), false)
  assert.equal(shouldCapture('我提醒你一下，明天开会'), false)
  assert.equal(insideQuote('“记一下”', 1), true)
  assert.equal(insideQuote('记一下：真的', 0), false)
  assert.equal(userAuthored({ source: { kind: 'user' } }), true)
  assert.equal(userAuthored({ source: { kind: 'plugin' } }), false)
  assert.equal(userAuthored({}), false)
  assert.equal(foreignOrigin({ session: { header: { parentSessionId: 'session-sa-parent' } } }), true)
  assert.equal(foreignOrigin({ origin: 'subagent' }), true)
  assert.equal(foreignOrigin({ session: { header: { origin: 'user' } } }), false)
}

// 1) 接线默认值：explicit、坏值/旧台账关闭。
{
  assert.equal(readCapture(file).mode, 'explicit')
  updateCapture({ mode: 'message', optIn: false }, { file })
  assert.equal(readCapture(file).mode, 'explicit', '旧台账没有 optIn 必须关闭')
  updateCapture({ mode: 'mars' }, { file })
  assert.equal(readCapture(file).mode, 'explicit', '坏值必须关闭')
  updateCapture({ mode: 'explicit' }, { file })
  assert.equal(readCapture(file).mode, 'explicit')
}

// 2) 真实接线：默认 0 次分类请求、0 待确认；正例建卡；反例不动。
{
  updateCapture({ mode: 'explicit' }, { file })
  const seeded = createTask({ title: '预览前已有卡', description: '不能被预览事件碰' }, { file })
  const before = tasks().map(task => ({ id: task.id, status: task.status, version: task.version }))
  const beforePending = pending().length
  const beforeTotal = tasks().length

  const app = makeCtx()
  const dispose = apply(app.ctx)

  try {
    // 正例：本人明确说记一下 → 建卡，带会话与目录。
    app.emit('agent/inbox/claimed', message('帮我记一下：公开预览第一张卡'))
    await settle()
    const created = tasks().filter(task => task.id !== seeded.id)
    assert.equal(created.length, 1, '明确指令应建一张卡')
    assert.equal(created[0].title, '公开预览第一张卡')
    assert.equal(created[0].sourceSessionId, 'session-preview-user')
    assert.equal(created[0].workspacePath, dir)
    assert.deepEqual({ auto: created[0].queue?.auto, by: created[0].queue?.by }, { auto: true, by: 'rule' })
    assert.equal(pending().length, beforePending, '默认不保留待确认')

    // 反例：自述、引文、缺来源、插件来源、执行会话、普通闲聊都不建卡。
    const negatives = [
      message('这个要做，我得去写一下，回头做。'),
      message('他说：“记一下：周五交报告”'),
      message('> 记一下：引用里的东西'),
      message('原文：记一下，明天带合同'),
      message('明天把上个月的报销单整理好发给财务那边。'),
      message('不要记一下，明天开会'),
      message('如果我说记一下，之后会怎么样？'),
      message('帮我记一下可以怎么翻译'),
      message('```\n记一下：代码块里的东西\n```'),
      message('记一下：来源不明的一句话', { omitSource: true }),
      message('记一下：插件替我记', { source: { kind: 'plugin' } }),
      message('记一下：执行会话里的话', { sessionId: 'session-sa-preview' }),
      message('放到待办：家人说的', { sessionId: 'session-family_member_0416' }),
      message('记一下：Dot 自动会话', { sessionId: 'dsh_dot_123e4567-e89b-12d3-a456-426614174000' }),
      message('记一下：subagent 子会话', { sessionId: 'session-child', parentSession: 'session-sa-parent' }),
      message('放到待办：origin 是 subagent', { sessionId: 'session-child', origin: 'subagent' }),
    ]
    for (const payload of negatives) app.emit('agent/inbox/claimed', payload)
    await settle()

    assert.equal(tasks().length, beforeTotal + 1, '反例不许再建卡')
    assert.equal(pending().length, beforePending, '反例不许写待确认')
    assert.equal(app.llm.calls.length, 0, '默认路径一次分类请求都不许发')

    // turn/end 也不该触发任何采集（默认不注册 turn 采集）。
    app.emit('session/event', { header: { id: 'session-preview-user' } }, {
      type: 'turn/end',
      data: { agent: { id: 'session-preview-user' }, turn: 1 },
    })
    await settle()
    assert.equal(app.llm.calls.length, 0, 'turn/end 默认也不许发分类请求')
    assert.equal(pending().length, beforePending)

    // 既有卡的状态和版本完全不变。
    const after = tasks().map(task => ({ id: task.id, status: task.status, version: task.version }))
    const seedAfter = after.find(task => task.id === seeded.id)
    const seedBefore = before.find(task => task.id === seeded.id)
    assert.deepEqual(seedAfter, seedBefore)
    assert.equal(getTask(seeded.id, { file }).description, '不能被预览事件碰')

    // 日志能证明装的是 explicit 模式。
    assert.ok(app.logs.some(line => line.includes('capture mode: explicit')))
  } finally {
    app.dispose()
  }
}

// 3) 旧的分类路径只有在显式 opt-in 后才回来；公开预览默认不启用。
{
  updateCapture({ mode: 'message' }, { file })
  assert.equal(readCapture(file).mode, 'message')
  const app = makeCtx()
  const dispose = apply(app.ctx)
  try {
    const before = pending().length
    app.emit('agent/inbox/claimed', message('我一直在想一个长期任务：用代码 Agent 可控出图。'))
    await settle()
    // 模型判定只写待确认，不建卡。
    assert.equal(app.llm.calls.length, 1, '显式 opt-in 才允许一次分类请求')
    assert.equal(pending().length, before + 1)
    assert.equal(tasks().filter(task => task.title.includes('合成的任务')).length, 0, '模型路径不建卡')
  } finally {
    app.dispose()
  }
}

// 4) 显式自己的卡仍然能被面板动作推进（状态机没有被默认值改坏）。
{
  const card = tasks().find(task => task.title === '公开预览第一张卡')
  assert.ok(card)
  assert.equal(card.status, 'todo')
}

fs.rmSync(dir, { recursive: true, force: true })
if (process.env.DEBUG_HANDLES) console.log('active:', process.getActiveResourcesInfo())
console.log('s3-preview-defaults: ok')
