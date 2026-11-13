import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from '../lib/engine.js'
import { readLedger, writeLedger } from '../lib/ledger.js'
import { decide } from '../lib/decide.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-decide-'))
const file = path.join(dir, 'ledger.json')
const now = Date.now()
const base = (id, patch = {}) => ({
  id, title: `卡 ${id}`, status: 'todo', urgency: 'normal', workspacePath: dir,
  version: 1, createdAt: now, updatedAt: now, comments: [], checklist: [], executions: [],
  assignments: [], queue: null, nodded: false, dependsOn: [], ...patch,
})
function reset(tasks, notices = []) {
  writeLedger({ schemaVersion: 1, revision: 1, tasks, pending: [], effects: [], notices }, file)
}
const engine = createEngine({
  file,
  adapter: {
    async createSession() { return { agent: { id: 'x' } } },
    async getSession() { return null }, async reopenSession() { return null },
    async followup() {}, async cancel() {}, async dispose() {}, async resolveModel() { return null },
  },
  wait: async () => {}, log: () => {},
})
const exec = { sessionId: 'session-user-1', callId: 'call-1' }
const notice = (id, code, taskId, stage) => ({ id, code, taskId, stage, state: 'new', enteredAt: now, taskVersion: 1 })
const auth = userText => async () => ({
  trusted: true, activeCall: true, sourceKind: 'user', sessionId: exec.sessionId,
  callId: exec.callId, turnId: 3, userText,
})
const call = (userText, args = {}) => decide(engine, args, exec, { file, authority: auth(userText) })

// 1. review + A1 通过 → done，通知关闭并留审计。
reset([base('t1', { status: 'in_review' })], [notice('n1', 'A1', 't1', 'review')])
let result = await call('A1 通过', { decision: 'accept', code: 'A1', text: '模型瞎传' })
assert.equal(result.ok, true, result.error)
assert.equal(readLedger(file).tasks[0].status, 'done')
assert.equal(readLedger(file).notices[0].state, 'closed')
assert.equal(readLedger(file).notices[0].audit.at(-1).passed, true)

// 2. 同一句/同一编号重放 → 拒绝，卡不再动。
result = await call('A1 通过', { decision: 'accept' })
assert.equal(result.ok, false)
assert.match(result.error, /没有找到还开着的编号/)
assert.equal(readLedger(file).tasks[0].status, 'done')

// 3. 打回理由从原话取，不用模型 text。
reset([base('t2', { status: 'in_review' })], [notice('n2', 'B2', 't2', 'review')])
result = await call('B2 打回 标题太长', { decision: 'reject', text: '模型说的理由' })
assert.equal(result.ok, true, result.error)
const rejected = readLedger(file).tasks[0]
assert.equal(rejected.status, 'in_progress')
assert.ok(rejected.comments.some(row => row.body === '标题太长'))

// 4. question 的回答取原话。
reset([base('t3', { status: 'in_progress', openQuestion: { text: '选哪个', askedAt: now } })], [notice('n3', 'C3', 't3', 'question')])
result = await call('C3 用第二种', { decision: 'answer', text: '模型编的答案' })
assert.equal(result.ok, true, result.error)
assert.equal(readLedger(file).tasks[0].openQuestion, null)

// 5. 没有可信 binding / 内部会话 / 包装文本 / 否定 / 多编号 → 都不动卡。
reset([base('t4', { status: 'in_review' })], [notice('n4', 'D4', 't4', 'review')])
let r = await decide(engine, { decision: 'accept' }, exec, { file })
assert.equal(r.ok, false)
assert.equal(readLedger(file).tasks[0].status, 'in_review')
r = await decide(engine, { decision: 'accept' }, { sessionId: 'session-sa-1', callId: 'c' }, {
  file, authority: async () => ({ trusted: true, activeCall: true, sourceKind: 'user', sessionId: 'session-sa-1', callId: 'c', turnId: 1, userText: 'D4 通过' }),
})
assert.equal(r.ok, false)
r = await call('当前 Owner 请求原文：\nD4 通过', { decision: 'accept' })
assert.equal(r.ok, false)
r = await call('D4 先别通过', { decision: 'accept' })
assert.equal(r.ok, false)
assert.equal(readLedger(file).tasks[0].status, 'in_review')
r = await call('D4 通过', { decision: 'accept' })
assert.equal(r.ok, true)

// 6. 两条开着的通知、原话没编号 → 拒绝。
reset([base('t5', { status: 'in_review' }), base('t6', { status: 'in_review' })], [
  notice('n5', 'E5', 't5', 'review'), notice('n6', 'F6', 't6', 'review'),
])
r = await call('通过', { decision: 'accept' })
assert.equal(r.ok, false)
assert.match(r.error, /不止一件/)
assert.equal(readLedger(file).tasks.every(t => t.status === 'in_review'), true)

// 7. 通知阶段与卡实际阶段对不上 → stale，拒绝。
reset([base('t7', { status: 'in_progress' })], [notice('n7', 'G7', 't7', 'review')])
r = await call('G7 通过', { decision: 'accept' })
assert.equal(r.ok, false)
assert.match(r.error, /不是「review」阶段/)

// 8. 多位数短号 A10：正常往返，且不能截成 A1。
reset([base('t8', { status: 'in_review' }), base('t9', { status: 'in_review' })], [
  notice('n8', 'A1', 't8', 'review'), notice('n9', 'A10', 't9', 'review'),
])
r = await call('A10 通过', { decision: 'accept' })
assert.equal(r.ok, true, r.error)
assert.equal(readLedger(file).tasks.find(t => t.id === 't9').status, 'done')
assert.equal(readLedger(file).tasks.find(t => t.id === 't8').status, 'in_review')
assert.equal(readLedger(file).notices.find(n => n.code === 'A10').state, 'closed')
assert.equal(readLedger(file).notices.find(n => n.code === 'A1').state, 'new')

// 只有 A1 时，A10 不能被截成 A1，也不能掉进无号分支。
reset([base('t10', { status: 'in_review' })], [notice('n10', 'A1', 't10', 'review')])
r = await call('A10 通过', { decision: 'accept' })
assert.equal(r.ok, false)
assert.match(r.error, /没有找到还开着的编号 A10/)
assert.equal(readLedger(file).tasks[0].status, 'in_review')
assert.equal(readLedger(file).notices[0].state, 'new')

// A10 的回答也不能落到 A1 的 question 尾文里。
reset([base('t11', { status: 'in_progress', openQuestion: { text: '选哪个', askedAt: now } })], [notice('n11', 'A1', 't11', 'question')])
r = await call('A10 回答 用第二种', { decision: 'answer' })
assert.equal(r.ok, false)
assert.match(r.error, /没有找到还开着的编号 A10/)
assert.deepEqual(readLedger(file).tasks[0].openQuestion, { text: '选哪个', askedAt: now })

// A1 与 A10 同时在时，A1 只动自己。
reset([base('t12', { status: 'in_review' }), base('t13', { status: 'in_review' })], [
  notice('n12', 'A1', 't12', 'review'), notice('n13', 'A10', 't13', 'review'),
])
r = await call('A1 通过', { decision: 'accept' })
assert.equal(r.ok, true, r.error)
assert.equal(readLedger(file).tasks.find(t => t.id === 't12').status, 'done')
assert.equal(readLedger(file).tasks.find(t => t.id === 't13').status, 'in_review')

// 六个反例：转述、历史、问句、条件、取消否定、间接问，都不改卡。
const negatives = [
  ['她写了「A7 通过」', 'accept'],
  ['历史记录显示 A7 通过', 'accept'],
  ['A7 通过了吗？', 'accept'],
  ['如果 A7 通过，下一步怎么走？', 'accept'],
  ['A7 不要取消', 'cancel'],
  ['只想问 A7 为什么取消', 'cancel'],
]
for (const [said, decision] of negatives) {
  reset([base('neg', { status: 'in_review' })], [notice('nneg', 'A7', 'neg', 'review')])
  const r = await call(said, { decision })
  assert.equal(r.ok, false, `反例不能通过：${said}`)
  assert.equal(readLedger(file).tasks[0].status, 'in_review', said)
}

// 三个任务书正例：编号+动作、打回理由、回答。
reset([base('pos', { status: 'in_review' })], [notice('npos', 'A7', 'pos', 'review')])
assert.equal((await call('A7 通过', { decision: 'accept' })).ok, true)
reset([base('pos', { status: 'in_review' })], [notice('npos', 'B2', 'pos', 'review')])
assert.equal((await call('a7 打回 标题太长', { decision: 'reject' })).ok, false, '编号必须对得上')
reset([base('pos', { status: 'in_review' })], [notice('npos', 'B2', 'pos', 'review')])
assert.equal((await call('B2 打回 标题太长', { decision: 'reject' })).ok, true)
reset([base('pos', { status: 'in_progress', openQuestion: { text: '选哪个', askedAt: now } })], [notice('npos', 'C3', 'pos', 'question')])
assert.equal((await call('C3 用第二种', { decision: 'answer' })).ok, true)

// 同一会话同一轮：第一次成功后，即使另一个 callId/无号，也不能再落一张卡。
{
  reset([base('r1', { status: 'in_review' }), base('r2', { status: 'in_review' })], [
    notice('nr1', 'A7', 'r1', 'review'),
  ])
  const first = await decide(engine, { decision: 'accept' }, exec, { file, authority: auth('A7 通过') })
  assert.equal(first.ok, true)
  const l = readLedger(file)
  l.notices.push(notice('nr2', 'B2', 'r2', 'review'))
  writeLedger(l, file)
  const replay = await decide(engine, { decision: 'accept' }, { sessionId: exec.sessionId, callId: 'call-2' }, {
    file, authority: async () => ({ trusted: true, activeCall: true, sourceKind: 'user', sessionId: exec.sessionId, callId: 'call-2', turnId: 3, userText: '通过' }),
  })
  assert.equal(replay.ok, false)
  assert.match(replay.error, /这一轮已经执行过/)
  assert.equal(readLedger(file).tasks.find(t => t.id === 'r2').status, 'in_review')
}

// 并行两个 callId 同一轮：最多一个成功。
{
  reset([base('p1', { status: 'in_review' }), base('p2', { status: 'in_review' })], [
    notice('np1', 'A7', 'p1', 'review'), notice('np2', 'B2', 'p2', 'review'),
  ])
  const authorityFor = call => async () => ({ trusted: true, activeCall: true, sourceKind: 'user', sessionId: exec.sessionId, callId: call, turnId: 4, userText: 'A7 通过' })
  const [a, b] = await Promise.all([
    decide(engine, { decision: 'accept' }, { sessionId: exec.sessionId, callId: 'par-1' }, { file, authority: authorityFor('par-1') }),
    decide(engine, { decision: 'accept' }, { sessionId: exec.sessionId, callId: 'par-2' }, { file, authority: authorityFor('par-2') }),
  ])
  assert.equal([a, b].filter(row => row.ok).length, 1)
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('s5-decide: ok')
