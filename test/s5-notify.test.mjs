import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  writeNotify, syncNotices, runNotifyOnce, readNotify, sanitizeNotifyText, ensureWaitingCodes,
  recoverNotifyInFlight,
  isQuietAt, resolveNotifyCommand, sendWithCommand,
} from '../lib/notify.js'
import { readLedger, writeLedger } from '../lib/ledger.js'
import { buildView } from '../lib/viewmodel.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's5-notify-'))
const file = path.join(dir, 'ledger.json')
const now = Date.UTC(2026, 10, 13, 2, 0, 0) // 10:00 Asia/Shanghai
const base = (id, patch = {}) => ({
  id, title: `卡 ${id}`, status: 'todo', urgency: 'normal', workspacePath: dir,
  version: 1, createdAt: now, updatedAt: now, comments: [], checklist: [], executions: [],
  assignments: [], queue: null, nodded: false, dependsOn: [], ...patch,
})
const assign = (patch = {}) => ({ id: 'a1', sessionId: 'session-user-1', state: 'idle', createdAt: now, startedAt: now, lastEventAt: now, ...patch })
const tasks = [
  base('t-review', { status: 'in_review' }),
  base('t-question', { openQuestion: { text: '选哪个', askedAt: now } }),
  base('t-nod', { queue: { auto: true, at: now, by: 'user' }, needsNod: { kinds: ['outbound'], matched: ['发'], at: now } }),
  base('t-dep', { dependsOn: ['t-dead'] }),
  base('t-dead', { status: 'canceled' }),
  base('t-approval', { status: 'in_progress', assignments: [assign({ state: 'running', waitingApproval: true })] }),
  base('t-notstarted'),
  base('t-notdelivered'),
  base('t-stuck', { blocked: true }),
  base('t-silent', { status: 'in_progress', assignments: [assign({ lastTurn: { endKind: 'completed', at: now }, nudgedAt: now })] }),
  base('t-silent-uncalled', { status: 'in_progress', assignments: [assign({ lastTurn: { endKind: 'completed', at: now } })] }),
]
const effects = [
  { id: 'fx-start', kind: 'start', taskId: 't-notstarted', state: 'failed', lastError: '没启动', createdAt: now },
  { id: 'fx-deliver', kind: 'deliver', taskId: 't-notdelivered', state: 'failed', lastError: '没送到', createdAt: now },
]
writeLedger({ schemaVersion: 1, revision: 1, tasks, pending: [], effects }, file)
writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file, now })

syncNotices({ file, now })
const first = readNotify(file).notices
assert.equal(first.length, 9, '八种阶段 + 催过的 silent 各一条；没催过的不生成')
assert.ok(first.every(row => /^[A-Z][1-9]$/.test(row.code)))
assert.equal(new Set(first.map(row => row.code)).size, 9)
assert.ok(!first.some(row => row.taskId === 't-silent-uncalled'))
const before = first.length
syncNotices({ file, now: now + 1000 })
assert.equal(readNotify(file).notices.length, before, '同一次进入不重复')

// 合并与限频：60 秒后发 5 条 + 另有 4 件；不配置命令时不起进程。
const sent = []
const result = await runNotifyOnce({
  file, now: now + 61_000,
  sender: async message => { sent.push(message); return { ok: true } },
})
assert.equal(result.status, 'sent')
assert.equal(sent.length, 1)
assert.match(sent[0].title, /9 件事等你/)
assert.match(sent[0].text, /另有 4 件，打开面板看/)
assert.equal(readNotify(file).notices.filter(row => row.state === 'sent').length, 9)
const again = await runNotifyOnce({ file, now: now + 62_000, sender: async () => { throw new Error('must not resend') } })
assert.equal(again.status, 'idle', '同一批不能因只列 5 件而重发剩下 4 件')

// 安静时段跨午夜。
assert.equal(isQuietAt(Date.UTC(2026, 10, 12, 15, 30), { from: '23:00', to: '08:00' }), true) // 23:30
assert.equal(isQuietAt(Date.UTC(2026, 10, 12, 16, 0), { from: '23:00', to: '08:00' }), true) // 09:00? 1:00 UTC = 09:00 local
assert.equal(isQuietAt(Date.UTC(2026, 10, 13, 0, 0), { from: '23:00', to: '08:00' }), false)
assert.equal(isQuietAt(Date.UTC(2026, 10, 13, 0, 0), { from: '00:00', to: '00:00' }), false)

// 脱敏。
const clean = sanitizeNotifyText('key sk-abcdefghijklmnop Bearer abc.def.ghi ' + 'a'.repeat(40))
assert.ok(!clean.includes('sk-abcdefghijklmnop'))
assert.ok(!clean.includes('Bearer abc.def.ghi'))
assert.ok(clean.includes('***'))

// 命令只从环境变量/配置读，必须绝对路径，参数占位符原样数组传递。
assert.deepEqual(resolveNotifyCommand({ env: { DSH_SUPERAGENT_NOTIFY_CMD: '["/bin/echo","{title}","{text}"]' }, config: {} }).command, ['/bin/echo', '{title}', '{text}'])
assert.equal(resolveNotifyCommand({ env: { DSH_SUPERAGENT_NOTIFY_CMD: '["/bin/echo","x"]' }, config: {} }).error, undefined)
assert.ok(resolveNotifyCommand({ env: {}, config: { notifyCommand: ['relative', 'x'] } }).error)
assert.equal(resolveNotifyCommand({ env: {}, config: { notifyCommand: null } }).command, null)

// 无 shell：参数里的空格/引号/$(…) 原样传入，不执行命令替换。
const out = path.join(dir, 'argv.json')
const script = 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))'
const shellHit = path.join(dir, 'should-not-exist')
const command = [process.execPath, '-e', script, out, 'a b', '"quote"', '$(touch ' + shellHit + ')']
const sendResult = await sendWithCommand(command, { title: 'T', text: 'X' })
assert.equal(sendResult.ok, true)
const argv = JSON.parse(fs.readFileSync(out, 'utf8'))
assert.deepEqual(argv, ['a b', '"quote"', '$(touch ' + shellHit + ')'])
assert.equal(fs.existsSync(shellHit), false)

// 未配置命令：通知保留 queued，视图状态可说明没配置。
const file2 = path.join(dir, 'ledger2.json')
writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('x', { status: 'in_review' })], pending: [], effects: [] }, file2)
writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: file2, now })
syncNotices({ file: file2, now })
const unconfigured = await runNotifyOnce({ file: file2, now: now + 61_000, env: {} })
assert.equal(unconfigured.status, 'unconfigured')
assert.equal(readNotify(file2).notices[0].state, 'new')

// closed 去掉后不发；全 closed 时没有消息。
const file3 = path.join(dir, 'ledger3.json')
writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('y', { status: 'in_review' })], pending: [], effects: [] }, file3)
writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: file3, now })
syncNotices({ file: file3, now })
const ledger3 = readLedger(file3)
ledger3.tasks[0].status = 'in_progress'
writeLedger(ledger3, file3)
const none = await runNotifyOnce({ file: file3, now: now + 61_000, sender: async () => { throw new Error('should not send') } })
assert.equal(none.status, 'idle')

// 发送成功后 effect 和通知一次结算；fake sender 内卡离开阶段时，closed 不复活。
{
  const fileR = path.join(dir, 'race.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('r1', { status: 'in_review' })], pending: [], effects: [] }, fileR)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: fileR, now })
  syncNotices({ file: fileR, now })
  const result = await runNotifyOnce({ file: fileR, now: now + 61_000, sender: async () => {
    const ledger = readLedger(fileR)
    ledger.tasks[0].status = 'done'
    writeLedger(ledger, fileR)
    syncNotices({ file: fileR, now: now + 61_100 })
    return { ok: true }
  } })
  assert.equal(result.status, 'sent')
  assert.equal(readNotify(fileR).notices[0].state, 'closed', '发送期间关掉的通知不能复活')
  assert.equal(readLedger(fileR).effects.at(-1).state, 'sent', '成功必须结算 effect')
  assert.equal(readLedger(fileR).tasks[0].status, 'done', '不能覆盖并发 card 变化')
}

// perHour 按批次计：两卡一批算 1 条，下一小时/同小时下一批仍可发。
{
  const fileRate = path.join(dir, 'rate.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('p1', { status: 'in_review' }), base('p2', { status: 'in_review' })], pending: [], effects: [] }, fileRate)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' }, perHour: 2 }, { file: fileRate, now })
  syncNotices({ file: fileRate, now })
  assert.equal((await runNotifyOnce({ file: fileRate, now: now + 61_000, sender: async () => ({ ok: true }) })).status, 'sent')
  const l = readLedger(fileRate)
  l.tasks.push(base('p3', { status: 'in_review' }))
  writeLedger(l, fileRate)
  syncNotices({ file: fileRate, now: now + 62_000 })
  const second = await runNotifyOnce({ file: fileRate, now: now + 123_000, sender: async () => ({ ok: true }) })
  assert.equal(second.status, 'sent', '两卡一批只占 1 条额度，第二批应能发')
}

// 无命令时是「尚未发送」，配置好后恢复；off 下的 listed 切 on 也要转 new。
{
  const fileC = path.join(dir, 'backlog.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('c1', { status: 'in_review' })], pending: [], effects: [] }, fileC)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: fileC, now })
  syncNotices({ file: fileC, now })
  assert.equal((await runNotifyOnce({ file: fileC, now: now + 61_000, env: {} })).status, 'unconfigured')
  assert.equal((await runNotifyOnce({ file: fileC, now: now + 62_000, sender: async () => ({ ok: true }) })).status, 'sent')

  const fileL = path.join(dir, 'listed.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('l1', { status: 'in_review' })], pending: [], effects: [] }, fileL)
  writeNotify({ mode: 'off', quiet: { from: '00:00', to: '00:00' } }, { file: fileL, now })
  ensureWaitingCodes(fileL, { now })
  assert.equal(readNotify(fileL).notices[0].state, 'listed')
  writeNotify({ mode: 'on' }, { file: fileL, now: now + 1000 })
  syncNotices({ file: fileL, now: now + 1000 })
  assert.equal(readNotify(fileL).notices[0].state, 'new', 'listed 在 on 后要变成待发')
  assert.equal((await runNotifyOnce({ file: fileL, now: now + 62_000, sender: async () => ({ ok: true }) })).status, 'sent')
}

// 未知结局不重试；stderr 不回显；env 非数组拒绝、[] 覆盖并禁用。
{
  const fileU = path.join(dir, 'unknown.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('u1', { status: 'in_review' })], pending: [], effects: [] }, fileU)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: fileU, now })
  syncNotices({ file: fileU, now })
  const unknown = await runNotifyOnce({ file: fileU, now: now + 61_000, sender: async () => ({ ok: false, uncertain: true, error: '发送命令超时，结果未知' }) })
  assert.equal(unknown.status, 'unknown')
  assert.equal(readNotify(fileU).notices[0].state, 'unknown')
  const noRetry = await runNotifyOnce({ file: fileU, now: now + 600_000, sender: async () => { throw new Error('must not resend') } })
  assert.equal(noRetry.status, 'idle')

  const stderrResult = await sendWithCommand([process.execPath, '-e', 'process.stderr.write("SECRET sk-abcdefghijklmnop"); process.exit(1)'], { title: 'T', text: 'X' })
  assert.equal(stderrResult.ok, false)
  assert.ok(!String(stderrResult.error).includes('SECRET'))
  assert.ok(!String(stderrResult.error).includes('sk-'))
  assert.match(String(stderrResult.error), /退出 1/)

  assert.ok(resolveNotifyCommand({ env: { DSH_SUPERAGENT_NOTIFY_CMD: '{"a":1}' }, config: {} }).error)
  assert.equal(resolveNotifyCommand({ env: { DSH_SUPERAGENT_NOTIFY_CMD: '[]' }, config: { notifyCommand: ['/bin/echo', 'x'] } }).command, null)
}

// 已启动进程：非零退出、写回执后退出、超时都算未知，不自动重发；ENOENT 才可重试。
{
  const receipt = path.join(dir, 'sent-receipt.txt')
  const short = await sendWithCommand([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, 'attempted'); process.exit(2)`], { title: 'T', text: 'X' })
  assert.equal(short.ok, false)
  assert.equal(short.uncertain, true, '已启动并退出非零，可能已送出，必须未知')
  assert.equal(short.retryable, undefined)
  assert.ok(fs.existsSync(receipt), '进程确实先写了回执')
  assert.ok(!String(short.error).includes('attempted'))

  const missing = await sendWithCommand(['/definitely/not/a/sender'], { title: 'T', text: 'X' })
  assert.equal(missing.retryable, true, 'ENOENT 证明进程未启动，可重试')

  const slow = await sendWithCommand([process.execPath, '-e', 'setTimeout(() => {}, 5000)'], { title: 'T', text: 'X' }, { timeoutMs: 80 })
  assert.equal(slow.uncertain, true)
}

// unknown 通知不重发；重启恢复 inFlight 为 unknown。
{
  const fileU = path.join(dir, 'unknown2.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('u2', { status: 'in_review' })], pending: [], effects: [] }, fileU)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: fileU, now })
  syncNotices({ file: fileU, now })
  const r = await runNotifyOnce({ file: fileU, now: now + 61_000, command: [process.execPath, '-e', 'process.exit(2)'] })
  assert.equal(r.status, 'unknown')
  assert.equal(readNotify(fileU).notices[0].state, 'unknown')
  assert.equal((await runNotifyOnce({ file: fileU, now: now + 600_000, sender: async () => { throw new Error('must not resend') } })).status, 'idle')

  const ledger = readLedger(fileU)
  ledger.notices[0].state = 'queued'; ledger.notices[0].inFlight = true; ledger.notices[0].uncertain = false
  writeLedger(ledger, fileU)
  recoverNotifyInFlight(fileU)
  assert.equal(readNotify(fileU).notices[0].state, 'unknown')
  assert.match(readNotify(fileU).notices[0].lastError, /未知/)
  const viewU = buildView({ file: fileU })
  assert.equal(viewU.notify.lastState, 'unknown', '结果未知不能当成可证明没发出去')
  assert.match(viewU.notify.lastError, /未知/)
}

// 短号持久单调：Z9 之后是 A10，清理 closed 不后退。
{
  const fileC = path.join(dir, 'codes.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('c10', { status: 'in_review' })], pending: [], effects: [] }, fileC)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: fileC, now })
  const l = readLedger(fileC); l.notify.nextIndex = 26 * 9
  writeLedger(l, fileC)
  syncNotices({ file: fileC, now })
  assert.equal(readNotify(fileC).notices[0].code, 'A10')
  const n = readLedger(fileC); n.notices[0].state = 'closed'; n.notices[0].closedAt = now
  writeLedger(n, fileC)
  const t2 = base('c11', { status: 'in_review' })
  const l2 = readLedger(fileC); l2.tasks.push(t2); writeLedger(l2, fileC)
  syncNotices({ file: fileC, now: now + 1000 })
  assert.notEqual(readNotify(fileC).notices.at(-1).code, 'A10'); assert.ok(Number(readNotify(fileC).notices.at(-1).code.slice(1)) >= 10)
}

// 限频按已送出的批次算：卡验收后通知 closed，这一小时的额度不能退回来。
{
  const fileQuota = path.join(dir, 'quota.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('q1', { status: 'in_review' })], pending: [], effects: [] }, fileQuota)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' }, perHour: 1 }, { file: fileQuota, now })
  syncNotices({ file: fileQuota, now })
  assert.equal((await runNotifyOnce({ file: fileQuota, now: now + 61_000, sender: async () => ({ ok: true }) })).status, 'sent')
  const q = readLedger(fileQuota)
  q.tasks[0].status = 'done'
  q.tasks.push(base('q2', { status: 'in_review' }))
  writeLedger(q, fileQuota)
  syncNotices({ file: fileQuota, now: now + 62_000 })
  const closedSent = readNotify(fileQuota).notices.find(row => row.taskId === 'q1')
  assert.equal(closedSent.state, 'closed')
  assert.ok(Number.isFinite(closedSent.sentAt), 'closed 后仍保留送出时间')
  const blocked = await runNotifyOnce({ file: fileQuota, now: now + 122_000, sender: async () => { throw new Error('must not send') } })
  assert.equal(blocked.status, 'rate', '卡验收后不能把已发批次从这一小时里扣掉')
  const later = await runNotifyOnce({ file: fileQuota, now: now + 3_661_001, sender: async () => ({ ok: true }) })
  assert.equal(later.status, 'sent', '满一小时后额度才恢复')
}

// 旧 retry 已到点的 queued：进入 inFlight 时清掉 nextAttemptAt，调度也要排除 inFlight。
{
  const fileRetry = path.join(dir, 'retry-due.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('r1', { status: 'in_review' })], pending: [], effects: [] }, fileRetry)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: fileRetry, now })
  syncNotices({ file: fileRetry, now })
  const r = readLedger(fileRetry)
  Object.assign(r.notices[0], { state: 'queued', attempts: 1, nextAttemptAt: now - 1000, enteredAt: now - 120_000, inFlight: true })
  writeLedger(r, fileRetry)
  const skipped = await runNotifyOnce({ file: fileRetry, now, sender: async () => { throw new Error('must not resend inFlight') } })
  assert.equal(skipped.status, 'idle', 'inFlight 的 queued 不能按旧 nextAttemptAt 再发一次')

  const r2 = readLedger(fileRetry)
  Object.assign(r2.notices[0], { state: 'queued', attempts: 1, nextAttemptAt: now - 1000, inFlight: false })
  writeLedger(r2, fileRetry)
  let during = null
  const sent = await runNotifyOnce({
    file: fileRetry, now: now + 61_000,
    sender: async () => {
      const row = readLedger(fileRetry).notices[0]
      during = { state: row.state, inFlight: row.inFlight, nextAttemptAt: row.nextAttemptAt }
      return { ok: true }
    },
  })
  assert.equal(sent.status, 'sent')
  assert.deepEqual(during, { state: 'queued', inFlight: true, nextAttemptAt: null }, '进入 inFlight 时先清旧重试时间')
}

// 同一批发送期间再进一次调度：inFlight 挡住重复发送。
{
  const fileParallel = path.join(dir, 'parallel.json')
  writeLedger({ schemaVersion: 1, revision: 1, tasks: [base('s1', { status: 'in_review' })], pending: [], effects: [] }, fileParallel)
  writeNotify({ mode: 'on', quiet: { from: '00:00', to: '00:00' } }, { file: fileParallel, now })
  syncNotices({ file: fileParallel, now })
  const p = readLedger(fileParallel)
  Object.assign(p.notices[0], { state: 'queued', attempts: 1, nextAttemptAt: now + 60_000, enteredAt: now })
  writeLedger(p, fileParallel)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = runNotifyOnce({
    file: fileParallel, now: now + 61_000,
    sender: async () => { await gate; return { ok: true } },
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = await runNotifyOnce({ file: fileParallel, now: now + 61_000, sender: async () => { throw new Error('must not overlap') } })
  assert.equal(second.status, 'idle', '发送中的批次不能被第二次调度拿走')
  release()
  assert.equal((await first).status, 'sent')
}

// 旧台账缺 nextIndex：清理前从存量所有 code 的最大值恢复，不复用历史号。
{
  const fileOld = path.join(dir, 'old-index.json')
  const oldClosed = (code, id) => ({
    id, code, taskId: `gone-${code}`, stage: 'review', state: 'closed',
    enteredAt: now - 8 * 24 * 60 * 60_000, closedAt: now - 8 * 24 * 60 * 60_000,
  })
  writeLedger({
    schemaVersion: 1, revision: 1,
    tasks: [base('o1', { status: 'in_review' }), base('o2', { status: 'in_review' })],
    pending: [], effects: [],
    notices: [oldClosed('A1', 'old1'), oldClosed('A10', 'old10')],
    notify: { mode: 'on', quiet: { from: '00:00', to: '00:00' }, perHour: 6, updatedAt: now },
  }, fileOld)
  syncNotices({ file: fileOld, now })
  const old = readLedger(fileOld)
  assert.deepEqual(old.notices.map(row => row.code).sort(), ['B10', 'C10'], 'A10 之后是 B10，不能回到 A1')
  assert.equal(old.notify.nextIndex, 237)
  assert.ok(old.notices.every(row => row.code !== 'A1' && row.code !== 'A10'))

  const fileListed = path.join(dir, 'old-listed.json')
  writeLedger({
    schemaVersion: 1, revision: 1,
    tasks: [base('w1', { status: 'in_review' })],
    pending: [], effects: [],
    notices: [{
      id: 'old-l', code: 'A10', taskId: 'gone-l', stage: 'review', state: 'closed',
      enteredAt: now - 1000, closedAt: now - 1000,
    }],
    notify: { mode: 'off', quiet: { from: '00:00', to: '00:00' }, perHour: 6, updatedAt: now },
  }, fileListed)
  ensureWaitingCodes(fileListed, { now })
  assert.equal(readNotify(fileListed).notices.at(-1).code, 'B10', 'sa_list 提前分配也要从存量恢复')
  assert.equal(readLedger(fileListed).notify.nextIndex, 236)
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('s5-notify: ok')
