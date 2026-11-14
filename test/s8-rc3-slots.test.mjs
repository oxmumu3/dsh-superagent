// RC3 UI 扩展槽位：sidebar.session.action 就地快记 + workspace.picker 接入与 RC2 优雅降级。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

assert.ok(
  manifest.dsh?.client?.inject?.includes('@deepseek-ai/dsh-client-ui-workspace'),
  'package.json must inject @deepseek-ai/dsh-client-ui-workspace for RC3 workspaces & picker'
)

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

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children)
  return ''
}

function loadFactory(fetchFn) {
  const factories = []
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
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: fetchFn,
  })
  assert.equal(factories.length, 1)
  return factories[0]
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

// 1. sidebar.session.action (QuickCaptureAction):
//    - returns Fragment wrapping children + trigger button (no wrapper div)
//    - wide=true -> 38x38 elevated button class + 14px icon; wide=false -> 18px icon
//    - modal opens, supports RC3 workspace.picker (+ 添加工作区), explicit "先不定", submits action=create & refreshes panel
{
  const fetches = []
  const factory = loadFactory((url, opts) => {
    fetches.push({ url, body: JSON.parse(opts.body) })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ counts: {}, groups: {} }) })
  })
  const hooks = createHooks()
  const plugin = factory.factory(() => hooks.React)
  const mounted = new Map()
  const wsListeners = new Set()
  let wsItems = [
    { workspaceId: 'ws-a', path: '/tmp/repo-a', title: 'repo-a' },
    { workspaceId: 'ws-b', path: '/tmp/repo-b', title: 'repo-b' },
  ]
  const ctx = {
    effect(setup) { setup() },
    get(name) {
      if (name === 'workspaces') {
        return {
          list: {
            getSnapshot: () => ({ items: wsItems }),
            subscribe: fn => { wsListeners.add(fn); return () => wsListeners.delete(fn) },
          },
        }
      }
      if (name === 'sessions') {
        return {
          list: {
            getSnapshot: () => ({
              byId: {
                s1: { id: 's1', workspaceId: 'ws-a', retainedBy: { mainView: 1 } },
              },
            }),
          },
        }
      }
      return null
    },
    slots: {
      factory(name) { return name === 'workspace.picker' ? { name } : undefined },
      subscribeFactory() { return () => {} },
      inject(_name, reg) { return reg() },
      register(opts, Component) { mounted.set(opts.name, { opts, Component }); return () => {} },
    },
  }
  plugin.apply(ctx)

  const QuickCapture = mounted.get('sidebar.session.action').Component
  const mockPicker = pickerProps => ({ type: 'RC3Picker', props: pickerProps, children: [] })
  const renderFactorySlot = (name, props) => name === 'workspace.picker' ? mockPicker(props) : null
  const renderQuick = wide => {
    hooks.reset()
    return QuickCapture({ wide, renderFactorySlot, children: { type: 'NewSessionBtn', props: {}, children: [] } })
  }

  const collapsedTree = renderQuick(false)
  assert.equal(collapsedTree.type, 'Fragment')
  assert.equal(collapsedTree.children[0].type, 'NewSessionBtn')
  const collapsedBtn = elementsBy(collapsedTree, n => n.props && String(n.props.className || '').includes('sa2-qa-trigger'))[0]
  assert.ok(collapsedBtn && !collapsedBtn.props.className.includes('wide'))
  const collapsedSvg = elementsBy(collapsedBtn, n => n.type === 'svg')[0]
  assert.equal(collapsedSvg.props.width, 18)

  const wideTree = renderQuick(true)
  const triggerBtn = elementsBy(wideTree, n => n.props && String(n.props.className || '').includes('sa2-qa-trigger'))[0]
  assert.ok(triggerBtn.props.className.includes('wide'))
  const wideSvg = elementsBy(triggerBtn, n => n.type === 'svg')[0]
  assert.equal(wideSvg.props.width, 14)

  // Open modal -> pre-populates foreground session's workspace (/tmp/repo-a)
  triggerBtn.props.onClick()
  let modalTree = renderQuick(true)
  const wsBtn = elementsBy(modalTree, n => n.props && n.props.className === 'sa2-qa-wsbtn')[0]
  assert.ok(wsBtn)
  assert.equal(textOf(wsBtn), 'repo-a')

  // Simulate adding a new directory through RC3 workspace.picker onPick
  const pickerNode = elementsBy(modalTree, n => n.type === 'RC3Picker')[0]
  assert.ok(pickerNode)
  wsBtn.props.onClick()
  modalTree = renderQuick(true)
  const openedPicker = elementsBy(modalTree, n => n.type === 'RC3Picker')[0]
  assert.equal(openedPicker.props.open, true)
  assert.equal(openedPicker.props.selectedId, 'ws-a')

  wsItems = [...wsItems, { workspaceId: 'ws-new', path: '/tmp/brand-new', title: 'brand-new' }]
  openedPicker.props.onPick('ws-new')
  modalTree = renderQuick(true)
  const updatedWsBtn = elementsBy(modalTree, n => n.props && n.props.className === 'sa2-qa-wsbtn')[0]
  assert.equal(textOf(updatedWsBtn), 'brand-new')

  // Explicit "先不定" button clears workspace explicitly
  const unsetBtn = elementsBy(modalTree, n => n.props && n.props.className === 'sa2-qa-unset')[0]
  unsetBtn.props.onClick()
  modalTree = renderQuick(true)
  assert.equal(textOf(elementsBy(modalTree, n => n.props && n.props.className === 'sa2-qa-wsbtn')[0]), '先不定')

  // Enter text and submit -> POSTs explicit workspacePath: null, workspaceExplicit: true
  const input = elementsBy(modalTree, n => n.props && n.props.className === 'sa2-qa-input')[0]
  input.props.onChange({ target: { value: '顺手记一条待办' } })
  modalTree = renderQuick(true)
  const form = elementsBy(modalTree, n => n.type === 'form')[0]
  form.props.onSubmit({ preventDefault() {} })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(fetches.length, 1)
  assert.equal(fetches[0].url, '/api/superagent/action')
  assert.deepEqual(fetches[0].body, {
    action: 'create',
    text: '顺手记一条待办',
    workspacePath: null,
    workspaceExplicit: true,
  })
}

// 2. Panel:
//    - On RC3: composer chip opens renderFactorySlot('workspace.picker'), onPick updates composerWorkspace
//    - Keeps workspace.picker mounted during + 添加工作区 onClose -> onPick round-trip!
//    - On RC2 (no workspace.picker factory): composer chip falls back to .sa2-pop
{
  const sampleView = {
    at: 0, revision: 1,
    counts: { waiting: 0, running: 0, queued: 1, later: 0, doneToday: 0 },
    router: { mode: 'observe', maxRunning: 2, running: 0, free: 2, stuckMinutes: 20, source: 'ledger' },
    groups: {
      waiting: [], running: [], later: [], doneToday: [],
      queued: [{
        id: 't-1', version: 1, title: '任务一', stage: 'queued', group: 'queued',
        reason: '排队中', workspacePath: '/tmp/ws-one', workspaceLabel: 'ws-one',
        needsWorkspace: false, auto: false, actions: [],
      }],
    },
    pending: [], workspaces: [{ path: '/tmp/ws-one', label: 'ws-one', count: 1 }],
    defaultWorkspace: '/tmp/ws-one',
  }
  const fetches = []
  const factory = loadFactory((url, opts) => {
    if (opts && opts.body) fetches.push(JSON.parse(opts.body))
    return Promise.resolve({ ok: true, status: 200, json: async () => sampleView })
  })

  // RC3 mode
  const rc3Hooks = createHooks()
  const rc3Plugin = factory.factory(() => rc3Hooks.React)
  const rc3Mounted = new Map()
  let rc3Items = [
    { workspaceId: 'id-1', path: '/tmp/ws-one', title: 'ws-one' },
    { workspaceId: 'id-2', path: '/tmp/ws-two', title: 'ws-two' },
  ]
  rc3Plugin.apply({
    effect(setup) { setup() },
    get(name) {
      if (name === 'workspaces') {
        return { list: { getSnapshot: () => ({ items: rc3Items }), subscribe: () => () => {} } }
      }
      return null
    },
    slots: {
      factory(name) { return name === 'workspace.picker' ? { name } : undefined },
      subscribeFactory() { return () => {} },
      inject(_name, reg) { return reg() },
      register(opts, Component) { rc3Mounted.set(opts.name, Component); return () => {} },
    },
  })
  const Panel = rc3Mounted.get('main')
  const renderFactorySlot = (name, props) => ({ type: 'RC3PanelPicker', props, children: [] })
  const renderPanel = () => {
    rc3Hooks.reset()
    return Panel({ renderFactorySlot })
  }
  let tree = renderPanel()
  // Inject sample view directly into panel state slot (index 0)
  rc3Hooks.slotsState[0] = Object.assign({}, rc3Hooks.slotsState[0], { loading: false, view: sampleView })
  tree = renderPanel()

  const anchorEl = { tagName: 'BUTTON' }
  const chip = elementsBy(tree, n => n.props && n.props.className === 'sa2-chip')[0]
  assert.ok(chip)
  chip.props.onClick({ currentTarget: anchorEl })
  tree = renderPanel()
  const nativePicker = elementsBy(tree, n => n.type === 'RC3PanelPicker')[0]
  assert.equal(nativePicker.props.open, true)
  assert.equal(nativePicker.props.selectedId, 'id-1')
  assert.equal(nativePicker.props.anchorRef.current, anchorEl)

  // Simulate "+ 添加工作区" closing the menu via onClose before directory flow yields onPick('id-3')!
  nativePicker.props.onClose()
  tree = renderPanel()
  const keptMountedPicker = elementsBy(tree, n => n.type === 'RC3PanelPicker')[0]
  assert.ok(keptMountedPicker, 'workspace.picker must stay mounted during directoryFlow')
  assert.equal(keptMountedPicker.props.open, false)
  rc3Items = [...rc3Items, { workspaceId: 'id-3', path: '/tmp/ws-three', title: 'ws-three' }]
  keptMountedPicker.props.onPick('id-3')
  tree = renderPanel()
  const updatedChip = elementsBy(tree, n => n.props && n.props.className === 'sa2-chip')[0]
  assert.ok(textOf(updatedChip).includes('ws-three'), 'composer chip updated after directoryFlow pick')

  // Quick clear button "先不定"
  const clearChip = elementsBy(tree, n => n.props && n.props.className === 'sa2-chip-x')[0]
  assert.ok(clearChip)
  clearChip.props.onClick()
  tree = renderPanel()
  assert.ok(textOf(elementsBy(tree, n => n.props && n.props.className === 'sa2-chip')[0]).includes('先不定'))

  // Card workspace chip opens RC3 picker and dispatches workspace action
  const cardWsBtn = elementsBy(tree, n => n.props && n.props.className === 'sa2-ws')[0]
  cardWsBtn.props.onClick({ currentTarget: { tagName: 'BUTTON' }, stopPropagation() {} })
  tree = renderPanel()
  const cardPicker = elementsBy(tree, n => n.type === 'RC3PanelPicker')[0]
  assert.equal(cardPicker.props.open, true)
  cardPicker.props.onPick('id-2')
  await Promise.resolve()
  assert.equal(fetches[0].action, 'workspace')
  assert.equal(fetches[0].workspacePath, '/tmp/ws-two')

  // RC2 fallback: no workspace.picker factory -> clicking chip opens legacy .sa2-pop
  const rc2Hooks = createHooks()
  const rc2Plugin = factory.factory(() => rc2Hooks.React)
  const rc2Mounted = new Map()
  rc2Plugin.apply({
    effect(setup) { setup() },
    get() { return null },
    slots: {
      factory() { return undefined },
      subscribeFactory() { return () => {} },
      inject(_name, reg) { return reg() },
      register(opts, Component) { rc2Mounted.set(opts.name, Component); return () => {} },
    },
  })
  const Rc2Panel = rc2Mounted.get('main')
  rc2Hooks.reset()
  Rc2Panel({})
  rc2Hooks.slotsState[0] = Object.assign({}, rc2Hooks.slotsState[0], { loading: false, view: sampleView })
  rc2Hooks.reset()
  let rc2Tree = Rc2Panel({})
  assert.equal(elementsBy(rc2Tree, n => n.type === 'RC3PanelPicker').length, 0)
  elementsBy(rc2Tree, n => n.props && n.props.className === 'sa2-chip')[0].props.onClick({ currentTarget: anchorEl })
  rc2Hooks.reset()
  rc2Tree = Rc2Panel({})
  assert.equal(elementsBy(rc2Tree, n => n.props && n.props.className === 'sa2-pop').length, 1)
}

console.log('s8 rc3 slots ok')
