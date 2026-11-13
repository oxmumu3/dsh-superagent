import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A4：规则路径建卡并记来源会话；模型路径只进 pending，不建卡。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's0-a4-'))
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = path.join(dir, 'ledger.json')

const { listTasks, listPending } = await import('../lib/ledger.js')
const { installCapture } = await import('../lib/capture.js')

let handler
const ctx = { on: (_name, fn) => { handler = fn; return () => {} } }
const seen = { captured: [], pending: [] }
installCapture(ctx, {
  judge: async () => ({ isTask: true, title: '模型认定的任务' }),
  onCaptured: task => seen.captured.push(task),
  onPending: row => seen.pending.push(row),
})

const message = text => ({
  agent: { id: 'session-test-a4' },
  message: {
    id: 'm-1',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  },
})

// 1) 规则路径：明确说「记一下」，建卡，卡上记下来源会话。
await handler(message('记一下：明天把报销单交财务。'))
const tasks = listTasks({ includeArchived: true }).tasks
assert.equal(tasks.length, 1)
assert.equal(tasks[0].sourceSessionId, 'session-test-a4')
assert.equal(listPending().pending.length, 0)

// 2) 模型路径：只是像任务，不建卡，只进 pending，并记下原话、会话、时间。
await handler(message('明天把上个月的报销单整理好发给财务那边。'))
const after = listTasks({ includeArchived: true }).tasks
assert.equal(after.length, 1, '模型路径不许再建卡')
const pending = listPending().pending
assert.equal(pending.length, 1)
assert.match(pending[0].text, /报销单/)
assert.equal(pending[0].sessionId, 'session-test-a4')
assert.ok(pending[0].at > 0)
assert.equal(seen.pending.length, 1)

fs.rmSync(dir, { recursive: true, force: true })
console.log('s0-a4: ok')
