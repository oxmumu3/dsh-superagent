// S3 第 5 阶段：面板最小改动 —— 排队组头、档位/上限、自动与老卡分行、nod 行、
// 待确认「补到那张卡上」。用假 React 真实走一遍 client.js 的渲染函数，不连宿主。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

const fetchCalls = []
let fetchHandler = null

function loadPlugin() {
  const factories = []
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: row => factories.push(row) } },
    fetch(url, options) {
      if (!fetchHandler) throw new Error('测试没有准备 fetch')
      return fetchHandler(url, options)
    },
  })
  assert.equal(factories.length, 1)
  return factories[0]
}

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
  walk(node, item => {
    if (predicate(item)) hits.push(item)
  })
  return hits
}

const queuedActions = [
  { action: 'start', label: '开始', primary: true, needsText: false },
  { action: 'later', label: '以后再说', primary: false, needsText: false },
]
const nodActions = [
  { action: 'nod', label: '可以做', primary: true, needsText: false },
  { action: 'later', label: '以后再说', primary: false, needsText: false },
  { action: 'cancel', label: '不做了', primary: false, needsText: false },
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
    actions: queuedActions,
  }, patch)
}

const view = {
  at: 0,
  revision: 5,
  counts: { waiting: 1, running: 0, queued: 4, later: 0, doneToday: 0 },
  router: { mode: 'observe', maxRunning: 2, running: 0, free: 2, stuckMinutes: 20, updatedAt: 1, source: 'ledger' },
  groups: {
    waiting: [card({
      id: 't-nod', title: '把稿子发布到公众号', stage: 'nod', group: 'waiting',
      reason: '要对外发，等你点头（命中：发布）', actions: nodActions,
    })],
    queued: [
      card({ id: 't-a1', title: '自动一', auto: true, position: 1, reason: '排队中' }),
      card({ id: 't-a2', title: '自动二', auto: true, position: 2, reason: '排在第 2 个，有空位就开始' }),
      card({ id: 't-old', title: '导入的老卡', auto: false, position: null, reason: '要你点开始' }),
      card({ id: 't-nodir', title: '还没定在哪做', auto: true, position: null, workspacePath: null, workspaceLabel: '', reason: '还没定在哪做，定了也不会自己开工' }),
    ],
    running: [],
    later: [],
    doneToday: [],
  },
  pending: [{
    id: 'p1', text: '开头加一段背景', title: '补一句', ago: '刚刚',
    workspacePath: null, workspaceLabel: '', suggestedTaskId: 't-9',
    suggestedTitle: '发布稿', attach: true,
  }],
  cards: [],
  workspaces: [],
  defaultWorkspace: null,
}

function panelTree() {
  fetchHandler = (url, options) => {
    fetchCalls.push({ url, body: JSON.parse(options.body) })
    return Promise.resolve({ ok: true, status: 200, json: async () => view })
  }
  const row = loadPlugin()
  const mounted = new Map()
  const disposers = []
  const React = {
    createElement: makeElement(),
    useState(initial) {
      if (initial && typeof initial === 'object' && 'view' in initial) {
        return [Object.assign({}, {
          loading: false,
          error: null,
          refresh: 0,
          tab: 'waiting',
          scrolled: false,
          expanded: {},
          composer: '',
          composerWorkspace: undefined,
          composerError: null,
          form: null,
          formText: '',
          rowError: null,
          busy: null,
          picker: null,
          routerOpen: true,
          drawer: null,
          toast: null,
        }, { view }), () => {}]
      }
      return [initial, () => {}]
    },
    useEffect() {},
    useRef(value) { return { current: value } },
  }
  const plugin = row.factory(() => React)
  plugin.apply({
    effect(setup) { disposers.push(setup()) },
    slots: {
      inject(_name, register) { return register() },
      register(options, Component) {
        mounted.set(options.name || options.key, { options, Component })
        return () => {}
      },
    },
  })
  const Panel = mounted.get('main').Component
  return Panel()
}

const tree = panelTree()
const allText = textOf(tree)

// 组头一行：同时最多跑 2 件 · 观察中，以及切换入口。
assert.ok(allText.includes('同时最多跑 2 件 · 观察中'), '排队组头要写明上限和当前档位')
assert.ok(allText.includes('切到自动'), '观察档要能就地切到自动')
assert.ok(!allText.includes('会自动开始'), '非自动档不能写「会自动开始」')
assert.ok(!allText.includes('已读'), '面板不出现「已读」')

// 排队组：自动的带「第 N 个」在前，老卡前有分隔线和数量，总数仍是这一组的行数。
assert.ok(allText.includes('第 1 个'))
assert.ok(allText.includes('第 2 个'))
assert.ok(allText.includes('下面 1 张老卡 · 要你点开始'))
const queuedSection = elementsBy(tree, item => item.props && item.props.id === 'sa2-sec-queued')[0]
assert.ok(queuedSection, '要有排队组')
const queuedList = elementsBy(queuedSection, item => item.props && item.props.className === 'sa2-list')[0]
assert.equal(queuedList.children.length, 5, '4 张卡 + 1 条分隔线')
const rowItems = queuedList.children.filter(item => item.props && item.props.className && item.props.className.indexOf('sa2-row') === 0)
assert.equal(rowItems.length, 4, '行数等于这一组的卡数')
assert.ok(textOf(queuedSection).includes('4'), '组头计数是 4')

// nod 行用 S2 的行模板：标题、原因、三个动作。
const nodRow = elementsBy(tree, item => item.props && item.props.className && item.props.className.indexOf('sa2-row') === 0
  && textOf(item).includes('把稿子发布到公众号'))[0]
assert.ok(nodRow, 'nod 行要出现')
assert.ok(textOf(nodRow).includes('要对外发，等你点头（命中：发布）'))
assert.ok(textOf(nodRow).includes('可以做') && textOf(nodRow).includes('以后再说') && textOf(nodRow).includes('不做了'))

// 待确认默认收着：首屏只留计数入口，整句与动作要点开以后才铺出来。
// 「补到那张卡上」的展开态由 test/s2-pending-rail.test.mjs 覆盖。
assert.ok(allText.includes('待确认'))
assert.ok(!allText.includes('补到那张卡上'))
assert.ok(!allText.includes('补到「发布稿」'))

// 档位弹层：三档与 1–5 件；点「自动」和「3」会分别发 router_mode / router_limit。
assert.ok(allText.includes('自动开工'))
assert.ok(allText.includes('新装的默认是观察'))
const modeButton = elementsBy(tree, item => item.props && item.props.className === 'sa2-opt'
  && textOf(item) === '自动')[0]
assert.ok(modeButton, '要能选自动档')
modeButton.props.onClick()
assert.deepEqual(fetchCalls.pop(), {
  url: '/api/superagent/action',
  body: { action: 'router_mode', text: 'auto' },
})
const limitButton = elementsBy(tree, item => item.props && item.props.className === 'sa2-opt'
  && textOf(item) === '3')[0]
assert.ok(limitButton, '要能选 1 到 5 件')
limitButton.props.onClick()
assert.deepEqual(fetchCalls.pop(), {
  url: '/api/superagent/action',
  body: { action: 'router_limit', text: '3' },
})

// 待确认的「补到那张卡上」在展开态发 pending_attach；
// 默认折叠的展开/动作链路由 test/s2-pending-rail.test.mjs 覆盖。
assert.ok(source.includes("pendingAttach(row.id)"))
assert.ok(source.includes("post({ action: 'pending_attach', id: id })"))

// 源码层面的回归：档位/上限动作名、分行样式都在。
assert.ok(source.includes("routerSet('router_mode'"))
assert.ok(source.includes("routerSet('router_limit'"))
assert.ok(source.includes('.sa2-split'))
assert.ok(source.includes('第 \' + card.position + \' 个'))

console.log('s3-client-panel: ok')
