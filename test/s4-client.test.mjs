// S4 第 4 阶段：面板「打开会话」、同目录勾选项、dep 行。
// 用真实 buildView 产出的合成台账视图渲染 client.js；会话号来自活动派工，
// 不再手写 sessionId 遮住投影问题。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { makeHarness } from './support/harness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

const hw = makeHarness()
const runningTask = hw.task({ title: 'S4 在跑的卡' })
await hw.startConfirmed(runningTask.id)
const realSessionId = hw.sessionOf(runningTask.id)
assert.ok(realSessionId && realSessionId.startsWith('session-'), '合成卡要有真实派工会话')
const view = hw.buildView()
assert.equal(view.groups.running.length, 1)
const runningCard = view.groups.running[0]
assert.equal(runningCard.id, runningTask.id)
assert.equal(runningCard.sessionId, realSessionId, 'buildView 要把活动派工的会话投影到卡片')

let fetchCalls = []
let openedSessions = []
let clipboardWrites = []
let clipboardMode = 'resolve'

function makeElement() {
  return function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
    return { type, props: props || {}, children }
  }
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children)
  return ''
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(item => walk(item, visit)); return }
  visit(node)
  ;(node.children || []).forEach(child => walk(child, visit))
}

function elementsBy(node, predicate) {
  const hits = []
  walk(node, item => { if (predicate(item)) hits.push(item) })
  return hits
}

function loadPlugin(options) {
  fetchCalls = []
  openedSessions = []
  clipboardWrites = []
  clipboardMode = options.clipboard ?? 'absent'
  const factories = []
  const sandbox = {
    window: { __ModuleLoader__: { load: row => factories.push(row) } },
    fetch(url, request) {
      fetchCalls.push({ url, body: request ? JSON.parse(request.body) : null })
      return Promise.resolve({ ok: true, status: 200, json: async () => currentView })
    },
  }
  if (clipboardMode !== 'absent') {
    sandbox.navigator = {
      clipboard: {
        writeText(text) {
          clipboardWrites.push(text)
          return clipboardMode === 'reject' ? Promise.reject(new Error('denied')) : Promise.resolve()
        },
      },
    }
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(factories.length, 1)
  return factories[0]
}

let currentView = view
let panelState = null

function panelTree(options = {}) {
  const row = loadPlugin(options)
  panelState = null
  currentView = options.view ?? view
  const mounted = new Map()
  const React = {
    createElement: makeElement(),
    useState(initial) {
      if (initial && typeof initial === 'object' && 'view' in initial) {
        if (!panelState) {
          panelState = Object.assign({
            loading: false, error: null, refresh: 0, tab: 'waiting', scrolled: false,
            expanded: {}, composer: '', composerWorkspace: undefined, composerError: null,
            form: null, formText: '', rowError: null, busy: null, picker: null,
            routerOpen: true, drawer: null, toast: null,
          }, initial, { view: currentView, routerOpen: true })
        }
        return [panelState, next => {
          const value = typeof next === 'function' ? next(panelState) : next
          if (!value || value === panelState) return
          panelState = Object.assign({}, panelState, value, { view: currentView })
        }]
      }
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
  }
  const plugin = row.factory(() => React)
  const ctx = {
    effect(setup) { setup() },
    get(name) {
      if (name !== 'uiWorkspace') return null
      return options.withHost ? { openSession(id) { openedSessions.push(id) } } : null
    },
    slots: {
      inject(_name, register) { return register() },
      register(optionsRow, Component) {
        mounted.set(optionsRow.name || optionsRow.key, { options: optionsRow, Component })
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  const Component = mounted.get('main').Component
  const render = () => Component()
  return { render, tree: render() }
}

// 1. 没有宿主 uiWorkspace、没有剪贴板：显示会话号后 8 位，点一下不谎报复制。
{
  const { render, tree } = panelTree({ withHost: false, clipboard: 'absent' })
  const text = textOf(tree)
  assert.ok(text.includes('…' + realSessionId.slice(-8)), '退路显示后 8 位')
  assert.ok(!text.includes('已读'))
  const sessionButton = elementsBy(tree, item => item.props && item.props.className === 'sa2-btn'
    && textOf(item) === '…' + realSessionId.slice(-8))[0]
  assert.ok(sessionButton, '在跑行要有会话按钮')
  assert.equal(sessionButton.props.title, realSessionId)
  sessionButton.props.onClick()
  const after = textOf(render())
  assert.match(after, new RegExp(`会话编号：${realSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.ok(!after.includes('已复制'), '没有剪贴板就不能说已复制')
}

// 2. 剪贴板可用：复制的是真实会话号，并显示已复制。
{
  const { render, tree } = panelTree({ withHost: false, clipboard: 'resolve' })
  const sessionButton = elementsBy(tree, item => item.props && item.props.className === 'sa2-btn'
    && textOf(item) === '…' + realSessionId.slice(-8))[0]
  sessionButton.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(clipboardWrites, [realSessionId])
  assert.match(textOf(render()), /会话编号已复制/)
}

// 3. 剪贴板失败：复制动作发生了，但不能显示已复制。
{
  const { render, tree } = panelTree({ withHost: false, clipboard: 'reject' })
  const sessionButton = elementsBy(tree, item => item.props && item.props.className === 'sa2-btn'
    && textOf(item) === '…' + realSessionId.slice(-8))[0]
  sessionButton.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  const after = textOf(render())
  assert.match(after, /会话编号：/)
  assert.ok(!after.includes('已复制'))
}

// 4. 有 uiWorkspace：按钮叫「打开会话」，点一下把真实会话号交过去。
{
  const { tree } = panelTree({ withHost: true })
  assert.ok(textOf(tree).includes('打开会话'))
  const sessionButton = elementsBy(tree, item => item.props && item.props.className === 'sa2-btn'
    && textOf(item) === '打开会话')[0]
  sessionButton.props.onClick()
  assert.deepEqual(openedSessions, [realSessionId])
}

// 4b. uiWorkspace 在 apply(ctx) 之后才挂上：渲染与点击时通过 ctx.get('uiWorkspace', false) 懒查仍能打开会话。
{
  const row = loadPlugin({ clipboard: 'absent' })
  panelState = null
  currentView = view
  const mounted = new Map()
  let lateUiWorkspace = null
  const React = {
    createElement: makeElement(),
    useState(initial) {
      if (initial && typeof initial === 'object' && 'view' in initial) {
        if (!panelState) {
          panelState = Object.assign({
            loading: false, error: null, refresh: 0, tab: 'waiting', scrolled: false,
            expanded: {}, composer: '', composerWorkspace: undefined, composerError: null,
            form: null, formText: '', rowError: null, busy: null, picker: null,
            routerOpen: false, drawer: null, toast: null,
          }, initial, { view: currentView, routerOpen: false })
        }
        return [panelState, next => {
          const value = typeof next === 'function' ? next(panelState) : next
          if (!value || value === panelState) return
          panelState = Object.assign({}, panelState, value, { view: currentView })
        }]
      }
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
  }
  const plugin = row.factory(() => React)
  plugin.apply({
    effect(setup) { setup() },
    get(name) {
      return name === 'uiWorkspace' ? lateUiWorkspace : null
    },
    slots: {
      inject(_name, register) { return register() },
      register(optionsRow, Component) {
        mounted.set(optionsRow.name || optionsRow.key, { options: optionsRow, Component })
        return () => {}
      },
    },
  })
  const Component = mounted.get('main').Component
  assert.ok(!textOf(Component()).includes('打开会话'))
  lateUiWorkspace = { openSession(id) { openedSessions.push(id) } }
  const lateTree = Component()
  assert.ok(textOf(lateTree).includes('打开会话'))
  const sessionButton = elementsBy(lateTree, item => item.props && item.props.className === 'sa2-btn'
    && textOf(item) === '打开会话')[0]
  sessionButton.props.onClick()
  assert.deepEqual(openedSessions, [realSessionId])
}

// 5. 同目录勾选项：默认勾上；取消勾选发 router_same_dir=allow。
{
  const { tree } = panelTree({ withHost: false })
  assert.ok(textOf(tree).includes('同一个目录同时只跑一件'))
  const checkbox = elementsBy(tree, item => item.props && item.props.type === 'checkbox')[0]
  assert.ok(checkbox, '档位弹层里要有勾选项')
  assert.equal(checkbox.props.checked, true)
  checkbox.props.onChange({ target: { checked: false } })
  assert.deepEqual(fetchCalls.pop(), {
    url: '/api/superagent/action',
    body: { action: 'router_same_dir', text: 'allow' },
  })
}

// 6. dep 行沿用现有模板：服务端给的动作和原因直接画。
{
  const depCard = Object.assign({}, runningCard, {
    id: 't-dep', title: 'S4 等着的卡', stage: 'dep', group: 'waiting', sessionId: null,
    reason: '它等的「S4 别的事」取消了，还做不做？',
    actions: [
      { action: 'dep_clear', label: '照做', primary: true, needsText: false },
      { action: 'later', label: '以后再说', primary: false, needsText: false },
      { action: 'cancel', label: '不做了', primary: false, needsText: false },
    ],
  })
  const depView = JSON.parse(JSON.stringify(view))
  depView.groups = { waiting: [depCard], running: [], queued: [], later: [], doneToday: [] }
  depView.counts = { waiting: 1, running: 0, queued: 0, later: 0, doneToday: 0 }
  const { tree } = panelTree({ withHost: false, view: depView })
  const text = textOf(tree)
  assert.ok(text.includes('它等的「S4 别的事」取消了，还做不做？'))
  assert.ok(text.includes('照做') && text.includes('以后再说') && text.includes('不做了'))
  const primary = elementsBy(tree, item => item.props && item.props.className === 'sa2-btn pri'
    && textOf(item) === '照做')[0]
  assert.ok(primary, '照做是主按钮')
}

assert.ok(source.includes("ctx.get('uiWorkspace', false)"))
assert.equal(source.includes('ctx.inject('), false, 'RC3 dynamic ctx forbids ctx.inject; optional services resolve lazily via ctx.get(..., false)')
assert.ok(source.includes('navigator.clipboard'))

hw.cleanup()
console.log('s4-client: ok')
