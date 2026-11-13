// 首屏回归（2026-11-13）：真实积压时，待确认默认收成一条计数入口，
// 放在「等你」组之后、排队之前；展开先给短预览，原文按条再展开，
// 记下 / 补到卡上 / 不用 的已有动作和已有记录都还在。
//
// 用假 React 真实跑 client.js 的渲染函数，不连宿主；只锁这次改动的展示契约。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

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
  if (Array.isArray(node)) {
    node.forEach(item => walk(item, visit))
    return
  }
  visit(node)
  ;(node.children || []).forEach(child => walk(child, visit))
}

function elementsBy(node, predicate) {
  const hits = []
  walk(node, item => { if (predicate(item)) hits.push(item) })
  return hits
}

const idleActions = [
  { action: 'start', label: '开始', primary: true, needsText: false },
  { action: 'later', label: '以后再说', primary: false, needsText: false },
]

function card(patch) {
  return Object.assign({
    version: 1,
    urgency: 'normal',
    stage: 'queued',
    group: 'queued',
    reason: '排队中',
    who: '',
    workspacePath: '/tmp/ws',
    workspaceLabel: 'ws',
    needsWorkspace: false,
    auto: false,
    position: null,
    question: null,
    actions: idleActions,
  }, patch)
}

const waiting = [
  card({
    id: 'w-review', title: '等验收：把日报发出去', stage: 'review', group: 'waiting',
    reason: '做完了，等你验收',
    actions: [
      { action: 'accept', label: '验收', primary: true, needsText: false },
      { action: 'reject', label: '打回', primary: false, needsText: true },
    ],
  }),
  card({
    id: 'w-question', title: '等回答：用哪个模板', stage: 'question', group: 'waiting',
    reason: '等你回答：甲还是乙',
    actions: [{ action: 'answer', label: '回答', primary: true, needsText: true }],
  }),
]

const queued = Array.from({ length: 42 }, (_, index) => card({
  id: 'q-' + (index + 1),
  title: '排队合成 ' + (index + 1),
  auto: index < 10,
  position: index < 10 ? index + 1 : null,
  reason: index < 10 ? '排队中' : '要你点开始',
}))

// 30 条长中文：第一条能补到卡上，其余只能记下或不用。
const longTail = '这一段是合成的长原文，用来确认首屏不会被它整段铺满；真正要读的时候再点展开。'
const pending = Array.from({ length: 30 }, (_, index) => ({
  id: 'p-' + (index + 1),
  text: '第 ' + (index + 1) + ' 句：' + longTail.repeat(3) + ' END-' + (index + 1),
  title: '第 ' + (index + 1) + ' 句',
  ago: (index + 1) + ' 天前',
  workspacePath: '/tmp/ws',
  workspaceLabel: 'ws',
  suggestedTaskId: index === 0 ? 'w-review' : null,
  suggestedTitle: index === 0 ? '等验收：把日报发出去' : null,
  attach: index === 0,
}))

const view = {
  at: 0,
  revision: 1,
  counts: { waiting: 2, running: 0, queued: 42, later: 0, doneToday: 0 },
  router: { mode: 'observe', maxRunning: 2, running: 0, free: 2, stuckMinutes: 20, updatedAt: 1, source: 'ledger' },
  groups: { waiting, running: [], queued, later: [], doneToday: [] },
  pending,
  cards: [],
  workspaces: [],
  defaultWorkspace: null,
}

let fetchCalls = []
let panelState = null

function panelTree() {
  fetchCalls = []
  panelState = null
  const factories = []
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: row => factories.push(row) } },
    fetch(url, options) {
      fetchCalls.push({ url, body: options && options.body ? JSON.parse(options.body) : null })
      return Promise.resolve({ ok: true, status: 200, json: async () => view })
    },
  })
  assert.equal(factories.length, 1)

  const mounted = new Map()
  const React = {
    createElement: makeElement(),
    useState(initial) {
      if (initial && typeof initial === 'object' && 'view' in initial) {
        if (!panelState) {
          panelState = Object.assign({
            loading: false, error: null, refresh: 0, tab: 'waiting', scrolled: false,
            expanded: {}, pendingOpen: false, pendingAll: false, pendingFull: {},
            composer: '', composerWorkspace: undefined, composerError: null,
            form: null, formText: '', rowError: null, busy: null, picker: null,
            routerOpen: false, quietDraft: null, rememberReject: false,
            ventsOpen: false, drawer: null, toast: null,
          }, initial, { view })
        }
        return [panelState, next => {
          const value = typeof next === 'function' ? next(panelState) : next
          if (!value || value === panelState) return
          panelState = Object.assign({}, panelState, value, { view })
        }]
      }
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
  }
  const plugin = factories[0].factory(() => React)
  plugin.apply({
    effect(setup) { setup() },
    get() { return null },
    slots: {
      inject(_name, register) { return register() },
      register(options, Component) {
        mounted.set(options.name || options.key, { options, Component })
        return () => {}
      },
    },
  })
  const Component = mounted.get('main').Component
  const render = () => Component()
  return { render, tree: render() }
}

const { render, tree } = panelTree()
const currentTree = () => render()
const rowsNow = () => elementsBy(currentTree(), item => item.props && item.props.className
  && item.props.className.indexOf('sa2-pending-row') === 0)
const collapsedText = textOf(tree)

// 1. 默认收着：首屏只有计数入口，30 句原文和动作都不出现。
const headOf = () => elementsBy(currentTree(), item => item.props && item.props.className === 'sa2-pending-head')[0]
assert.ok(collapsedText.includes('待确认'), '要有一个叫「待确认」的入口')
assert.match(textOf(headOf()), /30/, '入口要带条数')
assert.equal(headOf().props['aria-expanded'], 'false')
assert.equal(rowsNow().length, 0, '默认不铺记录')
assert.ok(!collapsedText.includes('补到那张卡上'), '折叠时不铺动作')
assert.ok(!collapsedText.includes('第 1 句：'), '折叠时不铺原文')
assert.ok(collapsedText.includes('等验收：把日报发出去'), '「等你」的卡要在首屏')
assert.ok(collapsedText.includes('等回答：用哪个模板'), '「等你」的卡要在首屏')

// 2. 页面顺序：等你组 → 待确认入口 → 排队；入口不在字段之前，也不在排队末尾。
const order = elementsBy(tree, item => item.props && (item.props.id === 'sa2-sec-waiting'
  || item.props.id === 'sa2-pending'
  || item.props.id === 'sa2-sec-queued'
  || item.props.role === 'navigation'))
assert.deepEqual(
  order.map(item => item.props.id || item.props.role),
  ['navigation', 'sa2-sec-waiting', 'sa2-pending', 'sa2-sec-queued'],
  '待确认入口要夹在「等你」和排队之间',
)

// 3. 展开：先给 8 条短预览 + 还有 22 条，不一次摊 30 条。
headOf().props.onClick()
const openedText = textOf(currentTree())
assert.equal(headOf().props['aria-expanded'], 'true')
assert.equal(rowsNow().length, 8, '展开先显示 8 条预览')
assert.ok(openedText.includes('还有 22 条'))
assert.ok(openedText.includes('补到那张卡上'), '补到卡上的动作还在')
assert.ok(openedText.includes('展开原文'), '长文要给展开原文入口')
assert.ok(openedText.includes('不用'), '不用动作还在')
assert.ok(openedText.includes('第 1 句：'), '展开先给短预览文本')
assert.ok(!openedText.includes('END-1'), '展开前 DOM 里没有整段原文，读屏也读不到')
const previewP = elementsBy(rowsNow()[0], item => item.props && item.props.className === 'sa2-pending-text')[0]
assert.ok(textOf(previewP).endsWith('…'), '预览是真截短串，不是靠 CSS 夹住整段')
assert.ok(textOf(previewP).length <= 73, '预览最多 72 字加一个省略号')

// 4. 展开单条原文：行加 is-full，正文换成全文，再点收起。
const openButton = elementsBy(rowsNow()[0], item => item.props && item.props.className === 'sa2-link sa2-pending-open')[0]
assert.ok(openButton, '长文行要有「展开原文」')
assert.equal(openButton.props['aria-expanded'], 'false')
openButton.props.onClick()
assert.ok(rowsNow()[0].props.className.includes('is-full'), '展开后保留原文全文')
assert.equal(textOf(elementsBy(rowsNow()[0], item => item.props && item.props.className === 'sa2-pending-text')[0]), pending[0].text)
assert.ok(textOf(currentTree()).includes('END-1'), '展开后才把全文交给 DOM')
const closeButton = elementsBy(rowsNow()[0], item => item.props && item.props.className === 'sa2-link sa2-pending-open')[0]
assert.equal(textOf(closeButton), '收起原文')
assert.equal(closeButton.props['aria-expanded'], 'true')
closeButton.props.onClick()
assert.ok(!rowsNow()[0].props.className.includes('is-full'), '再点收起回到短预览')
assert.ok(!textOf(currentTree()).includes('END-1'), '收起后整段原文也从 DOM 退出')

// 5. 还有 22 条：一次展开到 30，已有记录一条不少。
const more = elementsBy(currentTree(), item => item.props && item.props.className === 'sa2-more'
  && textOf(item) === '还有 22 条')[0]
assert.ok(more)
more.props.onClick()
assert.equal(rowsNow().length, 30, '展开全部后 30 条都在')

// 6. 已有动作：补到卡上、记下、不用仍走原来的 action。
const attachButton = elementsBy(currentTree(), item => item.props && item.props.className === 'sa2-btn pri small'
  && textOf(item) === '补到那张卡上')[0]
assert.ok(attachButton, '带 suggestedTaskId 的记录仍能补到卡上')
attachButton.props.onClick()
assert.deepEqual(fetchCalls.pop(), {
  url: '/api/superagent/action',
  body: { action: 'pending_attach', id: 'p-1' },
})

const acceptButton = elementsBy(currentTree(), item => item.props && item.props.className === 'sa2-btn pri small'
  && textOf(item) === '记下')[0]
assert.ok(acceptButton)
acceptButton.props.onClick()
assert.deepEqual(fetchCalls.pop(), {
  url: '/api/superagent/action',
  body: { action: 'pending_accept', id: 'p-2' },
})

const dismissButton = elementsBy(currentTree(), item => item.props && item.props.className === 'sa2-btn small'
  && textOf(item) === '不用')[0]
assert.ok(dismissButton)
dismissButton.props.onClick()
assert.deepEqual(fetchCalls.pop(), {
  url: '/api/superagent/action',
  body: { action: 'pending_dismiss', id: 'p-1' },
})

// 7. 再点收起：回到只有计数入口。
headOf().props.onClick()
assert.equal(rowsNow().length, 0)
assert.ok(textOf(currentTree()).includes('待确认'))

// 8. 源码契约：默认折叠、入口在等你之后、预览两行截断、原文可展开。
assert.equal(source.includes('renderInbox'), false, '旧的整段 inbox 不能再铺在首屏')
assert.match(source, /pendingOpen: false/, '待确认默认折叠')
assert.match(source, /if \(key === 'waiting'\) parts\.push\(renderPendingRail\(\)\)/, '入口要紧跟「等你」')
assert.match(source, /\.sa2-pending-text\{[^}]*line-clamp:2/, '预览最多两行')
assert.match(source, /flat\.length > 72 \? flat\.slice\(0, 72\) \+ '…'/, '预览在数据层就截短，不靠 CSS 夹住整段')
assert.match(source, /\.sa2-pending-row\{[^}]*flex-wrap:wrap/, '窄宽时行要能换行，不能挤成 nowrap')
assert.match(source, /\.sa2-pending-acts\{[^}]*margin-left:0/, '窄宽时动作回到新一行的左边')
assert.match(source, /sa2-pending-row\.is-full \.sa2-pending-text\{[^}]*white-space:pre-wrap/, '展开后保留原文换行')
assert.match(source, /pendingAttach\(row\.id\)/, '补到卡上的动作保留')
assert.match(source, /pendingAccept\(row\.id\)/, '记下的动作保留')
assert.match(source, /pendingDismiss\(row\.id\)/, '不用的动作保留')

console.log('s2-pending-rail: ok')
