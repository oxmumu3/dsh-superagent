import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A5：只听用户本人说的话。探针 8 回来之前先排除家人会话与非用户来源。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's0-a5-'))
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = path.join(dir, 'ledger.json')

const { listTasks } = await import('../lib/ledger.js')
const { installCapture } = await import('../lib/capture.js')

let handler
installCapture({ on: (_n, fn) => { handler = fn; return () => {} } }, { judge: undefined })

const payload = (sessionId, text, source) => ({
  agent: { id: sessionId },
  message: { id: 'm-1', role: 'user', ...(source ? { source } : {}), content: [{ type: 'text', text }] },
})

// 1) 家人会话：即使说了明确要记的话，也不建卡。
await handler(payload('session-family_member_0416', '记一下：明天买菜。'))
// 2) 非用户来源（模型/系统自己写的）：不建卡。
await handler(payload('session-mine', '记一下：明天买菜。', { kind: 'model', provider: 'x', model: 'y' }))
assert.equal(listTasks({ includeArchived: true }).tasks.length, 0)

// 3) 用户本人：正常建卡。
await handler(payload('session-mine', '记一下：明天买牛奶。', { kind: 'user' }))
assert.equal(listTasks({ includeArchived: true }).tasks.length, 1)

fs.rmSync(dir, { recursive: true, force: true })
console.log('s0-a5: ok')
