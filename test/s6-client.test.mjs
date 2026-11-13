// S6 final: real client.js contract against prep's buildView.
// Checklist/note/evidence, reject remember, rules list, vent row.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { makeHarness } from './support/harness.mjs'
import { addAcceptanceRule, addVent, checkItem, getTask, reportExecution, readLedger, writeLedger } from '../lib/ledger.js'
import { buildCardDetail } from '../lib/viewmodel.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')

const hw = makeHarness()
const card = hw.task({ title: 'S6 验收卡', checklist: ['页面能打开', '证据齐全'] })
const run = await hw.startConfirmed(card.id)
let row = getTask(card.id, { file: hw.file })
checkItem(card.id, row.checklist[0].id, { file: hw.file, note: '本地已打开' })
checkItem(card.id, row.checklist[1].id, {
  file: hw.file,
  note: '截图已存',
  evidence: ['/tmp/s6-proof/panel.png'],
})
reportExecution(card.id, { outcome: 'ready', summary: '做完', checks: ['node test'] }, {
  file: hw.file,
  sessionId: run.sessionId,
})
// UI fixture: 被打回两次；不改真实状态机，只为渲染计数。
{
  const ledger = readLedger(hw.file)
  const target = ledger.tasks.find(task => task.id === card.id)
  target.rejectCount = 2
  writeLedger(ledger, hw.file)
}
const rule = addAcceptanceRule(card.id, '这个项目的旧规矩', { file: hw.file }).rule
const vent = addVent({ text: '工具老超时', workspacePath: hw.dir, by: 'mcp' }, { file: hw.file })
const cardB = hw.task({ title: 'S6 打回 B', status: 'in_review' })
const view = hw.buildView()
const detail = buildCardDetail(getTask(card.id, { file: hw.file }))
assert.equal(view.groups.waiting.find(item => item.id === card.id)?.stage, 'review')

let fetchCalls = []
function makeElement() {
  return function createElement(type, props) {
    return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2).flat(Infinity) }
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
function loadPlugin() {
  fetchCalls = []
  const factories = []
  const sandbox = {
    window: { __ModuleLoader__: { load: row => factories.push(row) } },
    fetch(url, request) {
      fetchCalls.push({ url, body: request && request.body ? JSON.parse(request.body) : null })
      if (String(url).includes('/api/superagent/action') && request && request.body) {
        const sent = JSON.parse(request.body)
        if (sent.action === 'reject' && sent.text === '触发服务端拒收') {
          return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: '这个目录的规矩已经满了' }) })
        }
      }
      if (String(url).includes('/api/superagent/card')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ card: currentDetail }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => currentView })
    },
  }
  vm.runInNewContext(source, sandbox)
  assert.equal(factories.length, 1)
  return factories[0]
}
let currentView = view
let currentDetail = detail
let panelState = null
function panelTree(options = {}) {
  const row = loadPlugin()
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
    get() { return null },
    slots: {
      inject(_name, register) { return register() },
      register(optionsRow, Component) { mounted.set(optionsRow.name || optionsRow.key, { Component }) },
    },
  }
  plugin.apply(ctx)
  const render = () => mounted.get('main').Component()
  return { render, tree: render() }
}

// 1. 验收清单、note、证据文件名、打回次数。
{
  const { tree } = panelTree()
  const text = textOf(tree)
  assert.ok(text.includes('打回过 2 次'), text)
  assert.ok(text.includes('页面能打开') && text.includes('本地已打开'), '清单文字与 note')
  assert.ok(text.includes('panel.png'), '证据只显示文件名')
  const evidence = elementsBy(tree, item => item.props && item.props.title === '/tmp/s6-proof/panel.png')[0]
  assert.ok(evidence, '证据节点保留完整路径 title')
  assert.ok(!text.includes('已自查') && !text.includes('已验证'))

  // 点开详情：同一证据 helper 在抽屉里也要出现文件名 + 完整路径 title。
  const { render } = panelTree()
  const board = render()
  const titleButton = elementsBy(board, item => item.type === 'button'
    && textOf(item).includes('S6 验收卡'))[0]
  assert.ok(titleButton, '验收卡标题可点开')
  titleButton.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  const drawer = render()
  const drawerText = textOf(drawer)
  assert.ok(drawerText.includes('panel.png'), drawerText)
  const drawerCheck = elementsBy(drawer, item => item.props && String(item.props.className || '').includes('sa2-check'))[0]
  assert.ok(drawerCheck, '抽屉里要有清单项')
  const drawerEvidence = elementsBy(drawerCheck, item => item.type === 'code'
    && item.props && item.props.title === '/tmp/s6-proof/panel.png')[0]
  assert.ok(drawerEvidence, '抽屉清单项要复用证据文件名/title')
  assert.equal(textOf(drawerEvidence), 'panel.png')
}

// 2. 打回勾选：只有勾上才发 remember:true。
{
  const { render, tree } = panelTree()
  const reject = elementsBy(tree, item => item.props && typeof item.props.onClick === 'function'
    && textOf(item) === '打回')[0]
  assert.ok(reject, '验收卡要有打回')
  reject.props.onClick()
  let next = render()
  assert.match(textOf(next), /以后这个项目都按这条查/)
  const formNode = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  assert.ok(formNode, '打回表单要渲染出来')
  const input = elementsBy(formNode, item => item.type === 'input' && item.props
    && item.props.type !== 'checkbox' && typeof item.props.onChange === 'function')[0]
  assert.ok(input, '打回输入框要能输入理由')
  input.props.onChange({ target: { value: '再改一版' } })
  next = render()
  const formNow = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  const checkbox = elementsBy(formNow, item => item.props && item.props.type === 'checkbox')[0]
  assert.ok(checkbox, '打回输入框下要有勾选项')
  checkbox.props.onChange({ target: { checked: true } })
  next = render()
  const formFinal = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  const submit = elementsBy(formFinal, item => item.type === 'button' && item.props
    && String(item.props.className || '').includes('sa2-btn pri')).at(-1)
  assert.ok(submit, '表单要有提交按钮')
  submit.props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  const body = fetchCalls.filter(call => call.body).map(call => call.body).at(-1)
  assert.equal(body.action, 'reject')
  assert.equal(body.remember, true)
}

// 2b. remember 只属于当前打回表单：A 勾选取消后，B 不勾不能带 remember；A 二次打开也不勾。
{
  const { render } = panelTree()
  const findRow = (title, tree) => elementsBy(tree, item => item.props
    && String(item.props.className || '').split(' ').includes('sa2-row')
    && textOf(item).includes(title))[0]
  const openReject = title => {
    const row = findRow(title, render())
    assert.ok(row, `要有 ${title} 的 row`)
    const button = elementsBy(row, item => item.type === 'button' && textOf(item).includes('打回'))[0]
    assert.ok(button, `${title} 要有打回`)
    button.props.onClick()
    return render()
  }
  let next = openReject('S6 验收卡')
  const formA = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  assert.ok(formA, 'A 表单')
  elementsBy(formA, item => item.props && item.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } })
  next = render()
  const formA2 = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  elementsBy(formA2, item => item.type === 'button' && textOf(item) === '取消')[0].props.onClick()
  next = render()

  next = openReject('S6 打回 B')
  assert.equal(panelState.rememberReject, false, 'B 的表单没有继承 A 的勾选')

  next = openReject('S6 验收卡')
  const formA3 = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  const boxA = elementsBy(formA3, item => item.props && item.props.type === 'checkbox')[0]
  assert.equal(boxA.props.checked, false, 'A 二次打开也要重置')
}


// 2c. 提交中不收起表单；服务端拒收后保留输入，改正后重提一次成功。
{
  const { render } = panelTree()
  const row = elementsBy(render(), item => item.props
    && String(item.props.className || '').split(' ').includes('sa2-row')
    && textOf(item).includes('S6 验收卡'))[0]
  const reject = elementsBy(row, item => item.type === 'button' && textOf(item).includes('打回'))[0]
  reject.props.onClick()
  let next = render()
  const form = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  const input = elementsBy(form, item => item.type === 'input' && item.props.type !== 'checkbox')[0]
  input.props.onChange({ target: { value: '触发服务端拒收' } })
  next = render()
  const form2 = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  elementsBy(form2, item => item.props && item.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } })
  next = render()
  const form3 = elementsBy(next, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  const submit = elementsBy(form3, item => item.type === 'button' && String(item.props.className || '').includes('sa2-btn pri'))[0]
  submit.props.onClick()
  assert.ok(panelState.form, '提交中表单还在')
  assert.equal(panelState.formText, '触发服务端拒收')
  assert.equal(panelState.rememberReject, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(panelState.form, '拒收后表单还在')
  assert.equal(panelState.formText, '触发服务端拒收')
  assert.equal(panelState.rememberReject, true)

  const retryTree = render()
  const retryForm = elementsBy(retryTree, item => item.props && String(item.props.className || '').includes('sa2-form'))[0]
  const retryInput = elementsBy(retryForm, item => item.type === 'input' && item.props.type !== 'checkbox')[0]
  retryInput.props.onChange({ target: { value: '按钮位置还是不对' } })
  const retry = elementsBy(render(), item => item.type === 'button' && String(item.props.className || '').includes('sa2-btn pri'))[0]
  assert.ok(retry, '可重试')
  retry.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(panelState.form, null, '成功后才收起')
  const body = fetchCalls.filter(call => call.body).map(call => call.body).at(-1)
  assert.equal(body.action, 'reject')
  assert.equal(body.text, '按钮位置还是不对')
  assert.equal(body.remember, true)
}

// 3. 规矩列表：全部可删、带目录；4. 吐槽默认收起、展开后动作可用。
{
  for (let index = 0; index < 7; index += 1) {
    addAcceptanceRule(card.id, `补充规矩 ${index}`, { file: hw.file })
  }
  const { tree, render } = panelTree({ view: hw.buildView() })
  const text = textOf(tree)
  assert.ok(text.includes('这个项目的规矩 8 条'), text)
  assert.ok(text.includes('这个项目的旧规矩'))
  assert.ok(text.includes('补充规矩 6'), '第 8 条也要显示')
  assert.ok(text.includes(hw.dir.split('/').pop()), '每条带目录标签')
  const dels = elementsBy(tree, item => item.props && typeof item.props.onClick === 'function'
    && textOf(item) === '删')
  assert.equal(dels.length, 8, '8 条规矩都要有删除入口')
  const target = dels.at(-1)
  target.props.onClick()
  assert.equal(fetchCalls.at(-1).body.action, 'rule_delete')

  const collapsed = textOf(render())
  assert.ok(collapsed.includes('AGENT 吐槽 1 条'), collapsed)
  assert.ok(!collapsed.includes('工具老超时'), '默认收起，不列吐槽正文')
  const toggle = elementsBy(render(), item => item.props && typeof item.props.onClick === 'function'
    && textOf(item).includes('AGENT 吐槽'))[0]
  assert.ok(toggle, '吐槽行可展开')
  toggle.props.onClick()
  const expanded = render()
  assert.ok(textOf(expanded).includes('工具老超时'))
  const make = elementsBy(expanded, item => item.props && typeof item.props.onClick === 'function'
    && textOf(item) === '记成一件事')[0]
  assert.ok(make)
  make.props.onClick()
  assert.deepEqual(fetchCalls.at(-1).body, { action: 'vent_card', text: vent.id })
}

hw.cleanup()
console.log('s6-client: ok')
