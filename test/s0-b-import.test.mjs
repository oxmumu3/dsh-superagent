import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// B 导入脚本：逐字段搬运、状态映射、卡号沿用、重复导入不新增。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's0-b-import-'))
const home = dir
const ledgerFile = path.join(dir, 'superagent-ledger.json')
const script = fileURLToPath(new URL('../scripts/import-taskboard.mjs', import.meta.url))

const oldCard = {
  id: 't-old-review',
  title: '旧卡：待验收',
  description: '原来的描述',
  prompt: '原来的执行指令',
  workspaceId: 'ws-1',
  urgency: 'urgent',
  status: 'in_review',
  blocked: false,
  execution: { mode: 'claim' },
  isolation: 'none',
  permission: null,
  version: 7,
  createdAt: 1700000000000,
  updatedAt: 1700000900000,
  createdBy: 'agent',
  updatedBy: 'agent',
  checklist: [
    { id: 'k-1', text: '第一项', checked: true, checkedBy: 'user', checkedAt: 1700000500000, note: '证据在这' },
    { id: 'k-2', text: '第二项', checked: false },
  ],
  comments: [{ id: 'c-1', body: '一条留言', createdBy: 'user', createdAt: 1700000600000, version: 3 }],
  executions: [{ id: 'e-1', sessionId: 'session-x', report: { summary: '做完了', changedFiles: ['a.js'] } }],
}

const inProgressCard = { ...oldCard, id: 't-old-wip', title: '旧卡：进行中', status: 'in_progress', comments: [], checklist: [], executions: [] }
const doneCard = { ...oldCard, id: 't-old-done', title: '旧卡：已完成', status: 'done' }

fs.writeFileSync(path.join(home, 'dsh-taskboard.json'), JSON.stringify({ tasks: [oldCard, inProgressCard, doneCard] }))

const env = { ...process.env, DSH_HOME: home, DSH_SUPERAGENT_LEDGER: ledgerFile }
const run = () => execFileSync(process.execPath, [script, '--apply'], { env, encoding: 'utf8' })

const first = JSON.parse(run())
assert.equal(first.created, 2, '只导入未结的两张')
const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))
assert.equal(ledger.tasks.length, 2)

const review = ledger.tasks.find(t => t.id === 't-old-review')
assert.ok(review, '旧卡号不冲突时沿用旧号')
assert.equal(review.status, 'in_review', '待验收保持待验收')
assert.equal(review.description, '原来的描述', '描述不能被替换')
assert.equal(review.prompt, '原来的执行指令')
assert.equal(review.workspaceId, 'ws-1')
assert.equal(review.urgency, 'urgent')
assert.equal(review.createdAt, 1700000000000)
assert.equal(review.updatedAt, 1700000900000)
assert.deepEqual(review.importedFrom, { board: 'dsh-taskboard', id: 't-old-review' })
assert.equal(review.checklist.length, 2)
assert.equal(review.checklist[0].checked, true)
assert.equal(review.checklist[0].note, '证据在这')
assert.equal(review.comments.length, 1)
assert.equal(review.comments[0].body, '一条留言')
assert.equal(review.executions.length, 1)
assert.equal(review.executions[0].report.summary, '做完了')

const wip = ledger.tasks.find(t => t.id === 't-old-wip')
assert.equal(wip.status, 'todo', '进行中改成待办')
assert.equal(wip.comments.length, 1, '并补一条说明留言')
assert.match(wip.comments[0].body, /进行中/)

// 第二次导入：不新增。
const second = JSON.parse(run())
assert.equal(second.created, 0)
assert.equal(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).tasks.length, 2)

fs.rmSync(dir, { recursive: true, force: true })
console.log('s0-b-import: ok')
