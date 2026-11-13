// The exact previous public release (preview.1) must read a
// ledger written by S6 without throwing, and card id/status stay unchanged.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'


const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-compat-'))
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = path.join(dir, 'ledger.json')
const file = process.env.DSH_SUPERAGENT_LEDGER

const { addAcceptanceRule, addVent, beginDispatch, createTask, getTask } = await import('../lib/ledger.js')

const workspace = path.join(dir, 'project')
fs.mkdirSync(workspace, { recursive: true })
const card = createTask({ title: 'S6 台账兼容卡', workspacePath: workspace, checklist: ['一项'] }, { file })
beginDispatch(card.id, { sessionId: 'session-s6-compat', messageId: 'msg-s6-compat', text: 'x', cwd: workspace }, { file })
addAcceptanceRule(card.id, '这条规矩旧代码不认识也不能报错', { file })
addVent({ text: '这条吐槽旧代码不认识也不能报错', workspacePath: workspace, by: 'mcp' }, { file })

const baseline = await import('./fixtures/public-preview-1/ledger.js')
const read = baseline.listTasks({ includeArchived: true }, { file })
assert.equal(read.total, 1)
assert.equal(read.tasks[0].id, card.id)
assert.equal(read.tasks[0].status, getTask(card.id, { file }).status)
assert.deepEqual(read.tasks.map(task => task.id), [card.id])
const raw = baseline.readLedger(file)
assert.equal(raw.tasks.length, 1)
assert.ok(raw.acceptanceRules, '旧代码读到时只是忽略，不报错也不改卡')
assert.ok(Array.isArray(raw.vents))

fs.rmSync(dir, { recursive: true, force: true })
console.log('s6-compat: ok')
