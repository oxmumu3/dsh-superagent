// S9 UX v2: backend batch/later/titleFrom/lastReportBy contracts + client UX v2 invariants.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's9-ux-v2-'))
const wsDir = path.join(tmpRoot, 'repo-alpha')
const wsBeta = path.join(tmpRoot, 'repo-beta')
fs.mkdirSync(wsDir, { recursive: true })
fs.mkdirSync(wsBeta, { recursive: true })
process.env.DSH_HOME = tmpRoot
process.env.DSH_SUPERAGENT_LEDGER = path.join(tmpRoot, 'ledger.json')

const { titleFrom } = await import('../lib/capture.js')
const { applyRequest } = await import('../lib/queue.js')
const {
  addPending, checkItem, createTask, getTask, listPending, reportExecution,
} = await import('../lib/ledger.js')
const { handleAction } = await import('../lib/route.js')
const { buildView } = await import('../lib/viewmodel.js')
const { makeHarness } = await import('./support/harness.mjs')

const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function makeElement() {
  return function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
    return { type, props: props || {}, children }
  }
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

function hasClass(node, token) {
  const raw = String(node?.props?.className || '')
  return raw.split(/\s+/).includes(token)
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children)
  return ''
}

function createHooks() {
  const slotsState = []
  const effects = []
  const refs = []
  let idx = 0
  let refIdx = 0
  let effIdx = 0
  const React = {
    Fragment: 'Fragment',
    createElement: makeElement(),
    useState(initial) {
      const i = idx++
      if (!(i in slotsState)) slotsState[i] = typeof initial === 'function' ? initial() : initial
      const setState = next => {
        const val = typeof next === 'function' ? next(slotsState[i]) : next
        slotsState[i] = val
      }
      return [slotsState[i], setState]
    },
    useEffect(fn, deps) {
      const i = effIdx++
      const prev = effects[i]
      const changed = !prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps[k]))
      if (changed) {
        if (prev && typeof prev.cleanup === 'function') prev.cleanup()
        const cleanup = fn()
        effects[i] = { deps: deps || null, cleanup }
      }
    },
    useRef(initial) {
      const i = refIdx++
      if (!(i in refs)) refs[i] = { current: initial }
      return refs[i]
    },
  }
  const reset = () => { idx = 0; refIdx = 0; effIdx = 0 }
  return { React, reset, slotsState }
}

function mountPanel({ view, cardDetails = {}, actionHandler } = {}) {
  const fetchCalls = []
  const factories = []
  let clipboardText = null
  const fetchFn = async (url, opts = {}) => {
    if (url.startsWith('/api/superagent/card')) {
      const id = new URL('http://localhost' + url).searchParams.get('id')
      fetchCalls.push({ url, id })
      return {
        ok: true,
        status: 200,
        json: async () => ({ card: cardDetails[id] || null }),
      }
    }
    if (url === '/api/superagent/action') {
      const body = JSON.parse(opts.body || '{}')
      fetchCalls.push({ url, body })
      const reply = actionHandler ? actionHandler(body, view) : view
      return {
        ok: true,
        status: 200,
        json: async () => reply,
      }
    }
    fetchCalls.push({ url })
    return {
      ok: true,
      status: 200,
      json: async () => view,
    }
  }
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: { load: row => factories.push(row) },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    document: {
      visibilityState: 'visible',
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementById: () => null,
      createElement: () => ({}),
      head: { appendChild: () => {} },
    },
    navigator: {
      clipboard: {
        writeText: text => {
          clipboardText = text
          return Promise.resolve()
        },
      },
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: fetchFn,
  })
  assert.equal(factories.length, 1)
  const hooks = createHooks()
  const plugin = factories[0].factory(() => hooks.React)
  const mounted = new Map()
  plugin.apply({
    effect(setup) { setup() },
    get() { return null },
    slots: {
      factory() { return undefined },
      subscribeFactory() { return () => {} },
      inject(_name, reg) { return reg() },
      register(opts, Component) { mounted.set(opts.name, Component); return () => {} },
    },
  })
  const Panel = mounted.get('main')
  const render = () => {
    hooks.reset()
    return Panel({ renderFactorySlot: () => null })
  }
  return { render, hooks, fetchCalls, getClipboard: () => clipboardText }
}

// 1. Backend: titleFrom strips imperative prefixes including 放到待办 / 加入看板 / 记一下.
assert.equal(titleFrom('放到待办：修登录超时'), '修登录超时')
assert.equal(titleFrom('加入看板: 补回归测试'), '补回归测试')
assert.equal(titleFrom('记一下，整理发布清单'), '整理发布清单')

// 2. Backend: applyRequest forwards workspacePath, queue, later.
{
  const resLater = applyRequest({
    id: 'r-s9-create-later',
    action: 'create',
    payload: { title: 'MCP 延迟任务', workspacePath: wsDir, queue: false, later: true },
  })
  assert.equal(resLater.ok, true, resLater.error)
  const taskLater = getTask(resLater.taskId, { file: process.env.DSH_SUPERAGENT_LEDGER })
  assert.equal(taskLater.workspacePath, wsDir)
  assert.equal(taskLater.status, 'backlog')
  assert.equal(Boolean(taskLater.queue?.auto), false)

  const resAuto = applyRequest({
    id: 'r-s9-create-auto',
    action: 'create',
    payload: { title: 'MCP 自动任务', workspacePath: wsDir, queue: true },
  })
  assert.equal(resAuto.ok, true, resAuto.error)
  const taskAuto = getTask(resAuto.taskId, { file: process.env.DSH_SUPERAGENT_LEDGER })
  assert.equal(taskAuto.workspacePath, wsDir)
  assert.equal(taskAuto.status, 'todo')
  assert.equal(taskAuto.queue?.auto, true)
}

// 3. Backend: handleAction create(later), pending_dismiss_all/restore, queued_manual_later/restore, buildView lastReportBy.
{
  const hw = makeHarness()
  try {
    const laterRes = await handleAction(hw.engine, {
      action: 'create', text: '以后再做的事', workspacePath: hw.dir, later: true,
    })
    assert.equal(laterRes.task.status, 'backlog')
    let view = buildView({ file: hw.file })
    assert.ok(view.groups.later.some(c => c.id === laterRes.task.id), 'later card in later group')
    assert.ok(!view.groups.queued.some(c => c.id === laterRes.task.id), 'later card not in queued')

    // Pending batch clear & restore
    addPending({ id: 'p1', text: '待确认一', workspacePath: hw.dir }, { file: hw.file })
    addPending({ id: 'p2', text: '待确认二', workspacePath: hw.dir }, { file: hw.file })
    assert.equal(listPending({ file: hw.file }).pending.length, 2)
    const dismissAll = await handleAction(hw.engine, { action: 'pending_dismiss_all' })
    assert.equal(dismissAll.cleared.count, 2)
    assert.equal(listPending({ file: hw.file }).pending.length, 0)
    const restorePending = await handleAction(hw.engine, {
      action: 'pending_restore', items: dismissAll.cleared.items,
    })
    assert.equal(restorePending.restored.count, 2)
    assert.equal(listPending({ file: hw.file }).pending.length, 2)

    // Manual queued archive & restore (auto queued card stays queued)
    const manualCard = createTask({ title: '手动老卡', workspacePath: hw.dir }, { file: hw.file })
    const autoCard = createTask({
      title: '自动队列卡', workspacePath: hw.dir, queue: { auto: true, queuedAt: new Date().toISOString() },
    }, { file: hw.file })
    const archived = await handleAction(hw.engine, { action: 'queued_manual_later' })
    assert.ok(archived.moved.ids.includes(manualCard.id))
    assert.ok(!archived.moved.ids.includes(autoCard.id))
    assert.equal(getTask(manualCard.id, { file: hw.file }).status, 'backlog')
    assert.equal(getTask(autoCard.id, { file: hw.file }).status, 'todo')

    const restored = await handleAction(hw.engine, {
      action: 'queued_manual_restore', ids: archived.moved.ids,
    })
    assert.deepEqual(restored.restored.ids, archived.moved.ids)
    assert.equal(getTask(manualCard.id, { file: hw.file }).status, 'todo')

    // buildView exposes lastReportBy === 'mcp'
    const mcpCard = createTask({ title: '外部交活卡', workspacePath: hw.dir, checklist: ['检查一'] }, { file: hw.file })
    checkItem(mcpCard.id, mcpCard.checklist[0].id, { note: '已检查', evidence: ['/tmp/e.png'], file: hw.file })
    reportExecution(mcpCard.id, {
      summary: '外部 CLI 做完', outcome: 'ready', checks: ['npm test'],
    }, { file: hw.file, by: 'mcp', external: true })
    view = buildView({ file: hw.file })
    const projected = view.groups.waiting.find(c => c.id === mcpCard.id)
    assert.equal(projected?.lastReportBy, 'mcp')
  } finally {
    hw.cleanup()
  }
}

// 4. Client UI: onboarding empty state + prompt click fills composer.
{
  const emptyView = {
    counts: { waiting: 0, running: 0, queued: 0, later: 0, doneToday: 0 },
    groups: { waiting: [], running: [], queued: [], later: [], doneToday: [] },
    pending: [],
    workspaces: [],
    router: { mode: 'observe', maxRunning: 2, sameDir: 'wait' },
    notify: { mode: 'off', quiet: { from: '23:00', to: '08:00' }, status: 'off' },
    acceptanceRules: { count: 0, items: [] },
    vents: { count: 0, items: [] },
  }
  const app = mountPanel({ view: emptyView })
  app.render()
  await flush()
  const tree = app.render()
  const ob = elementsBy(tree, n => hasClass(n, 'sa2-onboarding'))
  assert.equal(ob.length, 1, '空板显示新手引导')
  const tryBtn = elementsBy(tree, n => hasClass(n, 'sa2-ob-try'))[0]
  assert.ok(tryBtn)
  tryBtn.props.onClick()
  assert.ok(app.hooks.slotsState[0].composer.length > 5)
}

// 5. Client UI: 6-dot cap, auto/later toggle, filter + search, pending batch clear & undo,
//    legacy archive & undo, 3-tab modal + quiet auto-save, drawer sticky footer + CLI brief.
{
  const makeQueued = n => Array.from({ length: n }, (_, i) => ({
    id: `t-q-${i + 1}`,
    code: `#${i + 10}`,
    version: 1,
    title: `排队任务 ${i + 1}`,
    stage: 'queued',
    group: 'queued',
    auto: i === 0,
    position: i === 0 ? 1 : undefined,
    workspacePath: i % 2 === 0 ? wsDir : wsBeta,
    workspaceLabel: i % 2 === 0 ? 'repo-alpha' : 'repo-beta',
    actions: [{ action: 'start', label: '现在开始', primary: true }],
  }))
  const waitCard = {
    id: 't-wait-1',
    code: '#1',
    version: 3,
    title: '验收新版面板',
    stage: 'review',
    group: 'waiting',
    reason: '外部 Agent 已交回报告',
    lastReportBy: 'mcp',
    workspacePath: wsDir,
    workspaceLabel: 'repo-alpha',
    checklist: [{ id: 'i1', text: '无溢出', checked: true, note: 'chrome 实测', evidence: ['/tmp/shot.png'] }],
    actions: [
      { action: 'approve', label: '通过', primary: true },
      { action: 'reject', label: '打回', needsText: true },
    ],
  }
  const cardDetails = {
    't-wait-1': {
      ...waitCard,
      description: '完整详情',
      executions: [{ id: 'e1', at: '2026-11-14T12:00:00Z', outcome: 'ready', by: 'mcp', summary: '完成 UX v2', checks: ['50/50'] }],
      assignments: [],
      comments: [],
    },
  }
  const baseView = {
    defaultWorkspace: wsDir,
    counts: { waiting: 1, running: 0, queued: 42, later: 0, doneToday: 0 },
    groups: {
      waiting: [waitCard],
      running: [],
      queued: makeQueued(42),
      later: [],
      doneToday: [],
    },
    pending: [
      { id: 'p-1', text: '第一条待确认', workspacePath: wsDir, workspaceLabel: 'repo-alpha', ago: '刚刚' },
      { id: 'p-2', text: '第二条待确认', workspacePath: wsBeta, workspaceLabel: 'repo-beta', ago: '1 分钟前' },
    ],
    workspaces: [
      { path: wsDir, label: 'repo-alpha', count: 22 },
      { path: wsBeta, label: 'repo-beta', count: 21 },
    ],
    router: { mode: 'observe', maxRunning: 2, sameDir: 'wait' },
    notify: { mode: 'on', quiet: { from: '23:00', to: '08:00' }, configured: true, status: 'on' },
    acceptanceRules: { count: 1, items: [{ id: 'r1', workspacePath: wsDir, text: '先跑 check-client' }] },
    vents: { count: 1, items: [{ id: 'v1', text: '旧卡片堆了 41 张手动队列' }] },
  }

  let currentView = baseView
  const app = mountPanel({
    view: currentView,
    cardDetails,
    actionHandler: body => {
      if (body.action === 'pending_dismiss_all') {
        const cleared = { count: currentView.pending.length, items: currentView.pending }
        currentView = { ...currentView, pending: [] }
        return { ...currentView, result: { cleared } }
      }
      if (body.action === 'pending_restore') {
        currentView = { ...currentView, pending: body.items }
        return { ...currentView, result: { restored: { count: body.items.length } } }
      }
      if (body.action === 'queued_manual_later') {
        const movedIds = ['t-q-2', 't-q-3']
        return { ...currentView, result: { moved: { count: movedIds.length, ids: movedIds } } }
      }
      if (body.action === 'queued_manual_restore') {
        return { ...currentView, result: { restored: { count: body.ids.length, ids: body.ids } } }
      }
      if (body.action === 'notify_quiet') {
        const [from, to] = String(body.text).split('-')
        currentView = { ...currentView, notify: { ...currentView.notify, quiet: { from, to } } }
        return currentView
      }
      return currentView
    },
  })

  // Scroll port contracts: outer .sa2 shell + inner .sa2-scroll port (keeps overlays pinned when scrolled)
  assert.match(
    source,
    /'position:relative;height:100%;min-height:0;overflow:hidden;background:var\(--sa2-bg\);color:var\(--sa2-ink\);'/,
    '.sa2 必须作为非滚动固定壳容器',
  )
  assert.match(
    source,
    /'\.sa2-scroll\{height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain\}'/,
    '必须定义独立的 .sa2-scroll 纵向滚动视口',
  )
  assert.doesNotMatch(
    source,
    /'min-height:100%;background:var\(--sa2-bg\);color:var\(--sa2-ink\);'/,
    '.sa2 不得退化为无 overflow-y:auto 的 min-height:100%',
  )

  app.render()
  await flush()
  let tree = app.render()
  assert.ok(hasClass(tree, 'sa2'))
  const scrollPort = tree.children.find(c => c && typeof c === 'object' && hasClass(c, 'sa2-scroll'))
  assert.ok(scrollPort, '.sa2 直接子级必须包含 .sa2-scroll')
  assert.equal(elementsBy(scrollPort, n => hasClass(n, 'sa2-inner')).length, 1, '.sa2-scroll 内包着 .sa2-inner')

  // 6-dot cap + '+36' on queued zone
  const zones = elementsBy(tree, n => hasClass(n, 'sa2-zone'))
  const queuedZone = zones[2]
  assert.equal(elementsBy(queuedZone, n => hasClass(n, 'sa2-mk')).length, 6, '态势场每格最多显示 6 枚点')
  assert.equal(textOf(elementsBy(queuedZone, n => hasClass(n, 'sa2-mk-more'))[0]), '+36')

  // Two-tier composer auto/later toggle submits later: true
  const modeChip = elementsBy(tree, n => hasClass(n, 'sa2-mode-chip'))[0]
  assert.ok(textOf(modeChip).includes('自动队'))
  modeChip.props.onClick()
  tree = app.render()
  const composerInput = elementsBy(tree, n => hasClass(n, 'sa2-say'))[0].children[0]
  composerInput.props.onChange({ target: { value: '稍后再排的任务' } })
  tree = app.render()
  const formEl = elementsBy(tree, n => hasClass(n, 'sa2-say'))[0]
  formEl.props.onSubmit({ preventDefault() {} })
  await flush()
  assert.equal(app.fetchCalls.at(-1).body.later, true)

  // External badge + proof pill on waiting card
  const allText = textOf(tree)
  assert.ok(allText.includes('外部 Agent 交的'))
  assert.ok(allText.includes('✓ 验收单 1/1'))

  // Project filter + search bar
  const betaPill = elementsBy(tree, n => hasClass(n, 'sa2-fpill') && textOf(n).includes('repo-beta'))[0]
  betaPill.props.onClick()
  tree = app.render()
  assert.ok(!textOf(elementsBy(tree, n => n.props?.id === 'sa2-sec-waiting')[0]).includes('验收新版面板'))
  const allPill = elementsBy(tree, n => hasClass(n, 'sa2-fpill') && textOf(n).includes('全部'))[0]
  allPill.props.onClick()
  tree = app.render()
  const searchInput = elementsBy(tree, n => hasClass(n, 'sa2-search'))[0].children[0]
  searchInput.props.onChange({ target: { value: '不存在的关键字xyz' } })
  tree = app.render()
  assert.ok(textOf(tree).includes('当前筛选条件下这一组没有匹配的卡片'))
  searchInput.props.onChange({ target: { value: '' } })
  tree = app.render()

  // Pending batch dismiss all & toast undo
  elementsBy(tree, n => hasClass(n, 'sa2-pending-head'))[0].props.onClick()
  tree = app.render()
  const clearAllBtn = elementsBy(tree, n => hasClass(n, 'sa2-pending-tools'))[0].children[1]
  assert.equal(textOf(clearAllBtn), '全部忽略清空')
  clearAllBtn.props.onClick()
  await flush()
  tree = app.render()
  assert.equal(app.fetchCalls.at(-1).body.action, 'pending_dismiss_all')
  const toastUndoBtn = elementsBy(tree, n => hasClass(n, 'sa2-toast'))[0].children.find(c => c && c.type === 'button')
  toastUndoBtn.props.onClick()
  await flush()
  assert.equal(app.fetchCalls.at(-1).body.action, 'pending_restore')
  tree = app.render()

  // Queued legacy archive button & undo
  const legacyBtn = elementsBy(tree, n => hasClass(n, 'sa2-legacy-btn'))[0]
  assert.equal(textOf(legacyBtn), '收进以后再说')
  legacyBtn.props.onClick()
  await flush()
  assert.equal(app.fetchCalls.at(-1).body.action, 'queued_manual_later')
  tree = app.render()
  const legacyUndo = elementsBy(tree, n => hasClass(n, 'sa2-toast'))[0].children.find(c => c && c.type === 'button')
  legacyUndo.props.onClick()
  await flush()
  assert.equal(app.fetchCalls.at(-1).body.action, 'queued_manual_restore')
  tree = app.render()

  // 3-tab modal + quiet auto-save
  const rulesPill = elementsBy(tree, n => hasClass(n, 'sa2-pill') && textOf(n).includes('规矩'))[0]
  rulesPill.props.onClick()
  tree = app.render()
  assert.equal(
    tree.children.some(c => c && typeof c === 'object' && hasClass(c, 'sa2-pop')),
    true,
    '.sa2-pop 弹窗必须作为 .sa2 直接子级挂载，位于 .sa2-scroll 之外',
  )
  assert.equal(
    elementsBy(tree.children.find(c => c && typeof c === 'object' && hasClass(c, 'sa2-scroll')), n => hasClass(n, 'sa2-pop')).length,
    0,
    '.sa2-pop 不得落在 .sa2-scroll 内部随滚动偏移',
  )
  assert.ok(textOf(elementsBy(tree, n => hasClass(n, 'sa2-popcard'))[0]).includes('先跑 check-client'))
  const ventsTab = elementsBy(tree, n => hasClass(n, 'sa2-mdl-tab') && textOf(n).includes('Agent 吐槽'))[0]
  ventsTab.props.onClick()
  tree = app.render()
  assert.ok(textOf(elementsBy(tree, n => hasClass(n, 'sa2-popcard'))[0]).includes('旧卡片堆了 41 张手动队列'))
  const routerTab = elementsBy(tree, n => hasClass(n, 'sa2-mdl-tab') && textOf(n) === '自动调度')[0]
  routerTab.props.onClick()
  tree = app.render()
  const timeInputs = elementsBy(tree, n => n.type === 'input' && n.props?.type === 'time')
  assert.equal(timeInputs.length, 2)
  timeInputs[0].props.onChange({ target: { value: '22:30' } })
  await flush()
  tree = app.render()
  assert.equal(app.fetchCalls.at(-1).body.action, 'notify_quiet')
  assert.equal(app.fetchCalls.at(-1).body.text, '22:30-08:00')
  assert.ok(textOf(elementsBy(tree, n => hasClass(n, 'sa2-popcard'))[0]).includes('已自动保存'))
  elementsBy(tree, n => hasClass(n, 'sa2-pop-foot'))[0].children.find(c => c && c.type === 'button').props.onClick()
  tree = app.render()

  // Drawer: header CLI copy + ID copy + sticky decision footer + inDrawer inline form isolation
  const openWaitTitle = elementsBy(tree, n => hasClass(n, 'sa2-title') && textOf(n).includes('验收新版面板'))[0]
  openWaitTitle.props.onClick()
  await flush()
  tree = app.render()
  const drwHead = elementsBy(tree, n => hasClass(n, 'sa2-drw-head'))[0]
  const drwFoot = elementsBy(tree, n => hasClass(n, 'sa2-drw-foot'))[0]
  assert.ok(drwHead && drwFoot, '抽屉要有吸顶头和吸底拍板栏')
  elementsBy(drwHead, n => hasClass(n, 'sa2-cli-btn'))[0].props.onClick()
  await flush()
  assert.ok(app.getClipboard().includes('t-wait-1') && app.getClipboard().includes('dsh_taskboard'))
  const drawerRejectBtn = elementsBy(drwFoot, n => n.type === 'button' && textOf(n) === '打回')[0]
  drawerRejectBtn.props.onClick()
  tree = app.render()
  const formsAll = elementsBy(tree, n => hasClass(n, 'sa2-form'))
  const formsInDrawer = elementsBy(elementsBy(tree, n => hasClass(n, 'sa2-drw-foot'))[0], n => hasClass(n, 'sa2-form'))
  assert.equal(formsInDrawer.length, 1, '打回表单位于抽屉底栏内')
  assert.equal(formsAll.length, 1, '背景行不会重复弹出第二份表单')
  assert.equal(
    tree.children.some(c => c && typeof c === 'object' && hasClass(c, 'sa2-scrim')),
    true,
    '.sa2-scrim 抽屉必须作为 .sa2 直接子级挂载，位于 .sa2-scroll 之外',
  )
  assert.equal(
    elementsBy(tree.children.find(c => c && typeof c === 'object' && hasClass(c, 'sa2-scroll')), n => hasClass(n, 'sa2-scrim')).length,
    0,
    '.sa2-scrim 不得落在 .sa2-scroll 内部随滚动偏移',
  )
}

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('s9-ux-v2: ok')
