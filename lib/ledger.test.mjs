// Plain-node self-test for the ledger. Run: node lib/ledger.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createTask, listTasks, getTask, updateTask, moveTask, addComment,
  reportExecution, checkItem, VersionConflict, InvalidTransition,
} from './ledger.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-test-'))
const file = path.join(dir, 'ledger.json')
const opts = { file }

// empty
assert.equal(listTasks({}, opts).total, 0)

// create
const t = createTask({
  title: '拆解头部插件并沉淀经验',
  description: '读源码，产出可复用判断卡',
  workspaceId: 'ws-1',
  urgency: 'urgent',
  checklist: ['选 5 个插件', '每插件拆四件事'],
}, opts)
assert.equal(t.version, 1)
assert.equal(t.status, 'todo')
assert.equal(t.checklist.length, 2)

// list + filter
assert.equal(listTasks({}, opts).total, 1)
assert.equal(listTasks({ status: 'todo' }, opts).total, 1)
assert.equal(listTasks({ status: 'done' }, opts).total, 0)
assert.equal(listTasks({ workspaceId: 'ws-1' }, opts).total, 1)

// move + version bump
const moved = moveTask(t.id, 'in_progress', { ...opts, ifVersion: 1 })
assert.equal(moved.status, 'in_progress')
assert.equal(moved.version, 2)

// stale version -> conflict
assert.throws(() => moveTask(t.id, 'in_review', { ...opts, ifVersion: 1 }), VersionConflict)

// illegal transition
assert.throws(() => moveTask(t.id, 'done', { ...opts, ifVersion: 2 }), InvalidTransition)

// comment + report + checklist
addComment(t.id, '先跑第一批', { ...opts, author: 'user' })
reportExecution(t.id, { summary: '完成 5 个', changedFiles: ['a.md'], checks: ['node test'] }, opts)
const after = getTask(t.id, opts)
assert.equal(after.comments.length, 1)
assert.equal(after.comments[0].author, 'user')
assert.equal(after.executions.length, 1)
checkItem(t.id, after.checklist[0].id, { ...opts, note: '已选定' })
assert.equal(getTask(t.id, opts).checklist[0].checked, true)

// review -> done is allowed for a human actor
const reviewed = moveTask(t.id, 'in_review', { ...opts, ifVersion: getTask(t.id, opts).version })
assert.equal(reviewed.status, 'in_review')

// persistence: reopen
const reloaded = listTasks({}, opts)
assert.equal(reloaded.total, 1)
assert.equal(reloaded.tasks[0].comments.length, 1)

// atomic write leaves no tmp files behind
const leftovers = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))
assert.equal(leftovers.length, 0)

fs.rmSync(dir, { recursive: true, force: true })
console.log('ledger: all checks passed')
