// S7 A: decisionAvailable gates notification copy, sa_decide and short codes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's7-a-'))
const file = path.join(dir, 'ledger.json')
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = file
const { createTask, readLedger } = await import('../lib/ledger.js')
const { buildNoticeMessage, readNotify, writeNotify, syncNotices } = await import('../lib/notify.js')
const { createToolDefinitions } = await import('../lib/tools.js')

const now = Date.UTC(2026, 10, 13, 2, 0, 0)
const clean = () => fs.rmSync(dir, { recursive: true, force: true })
const task = createTask({
  title: 'S7 A 等你验收', status: 'in_review', workspacePath: dir,
  checklist: [{ id: 'k1', text: '打开', checked: true, note: '已打开' }],
}, { file })
writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file, now })
syncNotices({ file, now })
const notices = readNotify(file).notices
assert.equal(notices.length, 1)
const off = buildNoticeMessage(notices, [task], { decisionAvailable: false })
assert.ok(off.text && !off.text.startsWith('\n'), '正文不以空行开头')
assert.ok(!off.text.includes('A1') && !off.text.includes('回「'), '关闭时没有短号和回话提示')
assert.ok(off.text.trim().endsWith('打开 Super Agent 面板处理'), off.text)
const on = buildNoticeMessage(notices, [task], { decisionAvailable: true })
assert.ok(on.text.includes('A1') && on.text.includes('回「A1 通过」'), '开启时保持 S6 回话')

const defsOff = createToolDefinitions({ ledgerOptions: () => ({ file }) }, { decisionAvailable: false })
const defsOn = createToolDefinitions({ ledgerOptions: () => ({ file }) }, { decisionAvailable: true })
assert.equal(defsOff.some(def => def.name === 'sa_decide'), false)
assert.equal(defsOn.some(def => def.name === 'sa_decide'), true)

// false 的 sa_list 不为了展示分配短号，且台账 notices 不变。
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 's7-a-list-'))
const file2 = path.join(dir2, 'ledger.json')
const task2 = createTask({ title: 'S7 A 列表', status: 'in_review', workspacePath: dir2 }, { file: file2 })
const engine2 = { ledgerOptions: () => ({ file: file2 }) }
const listOff = createToolDefinitions(engine2, { decisionAvailable: false }).find(def => def.name === 'sa_list')
const before = JSON.stringify(readLedger(file2).notices ?? [])
const textOff = await listOff.execute({ group: 'waiting' }, {})
assert.ok(!/A\d+/.test(textOff), textOff)
assert.equal(JSON.stringify(readLedger(file2).notices ?? []), before, 'false 时不得写短号')
const listOn = createToolDefinitions(engine2, { decisionAvailable: true }).find(def => def.name === 'sa_list')
const textOn = await listOn.execute({ group: 'waiting' }, {})
assert.match(textOn, /A\d+/, textOn)
assert.ok(task2.id)

// 极限 5 条 × 80 字标题 + 120 字问题：正文超 600 字时固定面板行必须完整保留。
const extremeTasks = Array.from({ length: 5 }, (_, index) => ({
  id: `extreme-${index}`,
  title: `标题${index}${'长'.repeat(76)}`,
  openQuestion: { text: `问题${index}${'问'.repeat(116)}` },
}))
const extremeNotices = extremeTasks.map((task, index) => ({
  id: `notice-${index}`, taskId: task.id, stage: 'question', code: `A${index + 1}`,
}))
const extreme = buildNoticeMessage(extremeNotices, extremeTasks, { decisionAvailable: false })
assert.ok(extreme, '极限通知应生成')
assert.ok(extreme.text.endsWith('打开 Super Agent 面板处理'), '固定面板行不得被截断')
const fullLength = extreme.title.length + 1 + extreme.text.length
assert.ok(fullLength <= 600, `通知总长 ${fullLength} 不应超过 600`)
assert.ok(!extreme.text.includes('回「') && !extreme.text.includes('A1'), '关闭时仍无短号')

clean()
fs.rmSync(dir2, { recursive: true, force: true })
console.log('s7-a: ok')
