// S7 C: isolated MCP envelope — board_get version, required ifVersion for the
// three evidence actions, check note, and old actions staying compatible.
// Pure stdio MCP client against the isolated server copy; no host, no desktop,
// no daily queue.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const server = path.join(root, 'verification', 'mcp-isolated', 'server.mjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's7-c-'))
const queueDir = path.join(dir, 'taskboard-queue')
const ledgerFile = path.join(dir, 'superagent-ledger.json')
const clean = () => fs.rmSync(dir, { recursive: true, force: true })

fs.writeFileSync(ledgerFile, JSON.stringify({
  schemaVersion: 1,
  revision: 1,
  tasks: [{
    id: 't-version',
    title: '版本卡',
    status: 'todo',
    version: 7,
    workspacePath: dir,
    urgency: 'normal',
    checklist: [],
    comments: [],
    executions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }],
  pending: [],
}))

function queuedRequests() {
  try {
    return fs.readFileSync(path.join(queueDir, 'requests.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

const child = spawn(process.execPath, [server], {
  cwd: root,
  env: {
    ...process.env,
    DSH_HOME: dir,
    DSH_SUPERAGENT_LEDGER: ledgerFile,
    DSH_TASKBOARD_QUEUE: queueDir,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let buffer = ''
let nextId = 0
const pending = new Map()
const stderr = []
child.stdout.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
    }
  }
})
child.stderr.on('data', chunk => { stderr.push(String(chunk).slice(0, 1000)) })

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`mcp timeout ${method}: ${stderr.join('')}`))
    }, 10000)
    pending.set(id, message => {
      clearTimeout(timer)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function tool(name, args) {
  const result = await request('tools/call', { name, arguments: args })
  return {
    isError: result?.isError === true,
    text: result?.content?.[0]?.text ?? '',
  }
}

try {
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 's7-c', version: '1' },
  })
  const listed = await request('tools/list')
  const boardGet = listed.tools.find(row => row.name === 'board_get')
  const boardRequest = listed.tools.find(row => row.name === 'board_request')
  assert.ok(boardGet, 'MCP 必须暴露 board_get')
  assert.ok(boardRequest, 'MCP 必须暴露 board_request')
  assert.match(boardGet.description, /version/, 'board_get 说明必须提到 version')
  const payload = boardRequest.inputSchema.properties.payload.description
  assert.match(payload, /note（必填/, 'MCP 必须把 check 的 note 写成必填')
  assert.match(payload, /宿主交 ready 时逐项检查，缺 note 会被拒收/, 'note 说明要与宿主强制口径一致')
  assert.match(payload, /ifVersion（必填/, '三个证据动作的 ifVersion 必须写成必填')
  assert.match(payload, /成功后先重新 board_get/, '说明写成功后要回读新版本')

  const card = await tool('board_get', { id: 't-version' })
  assert.equal(card.isError, false, card.text)
  assert.match(card.text, /- version: 7\b/, card.text)

  const missingVersion = await tool('board_request', {
    action: 'checklist',
    payload: { id: 't-version', items: ['一'] },
  })
  assert.equal(missingVersion.isError, true, '缺 ifVersion 不能入队')
  assert.match(missingVersion.text, /ifVersion/, missingVersion.text)
  assert.equal(queuedRequests().length, 0, '缺 ifVersion 不写队列')

  const badVersion = await tool('board_request', {
    action: 'checklist',
    payload: { id: 't-version', items: ['一'], ifVersion: '7' },
  })
  assert.equal(badVersion.isError, true, '字符串版本不能入队')
  assert.match(badVersion.text, /非负整数/, badVersion.text)
  assert.equal(queuedRequests().length, 0, '非法版本不写队列')

  const negativeVersion = await tool('board_request', {
    action: 'checklist',
    payload: { id: 't-version', items: ['一'], ifVersion: -1 },
  })
  assert.equal(negativeVersion.isError, true, '负数版本不能入队')
  assert.match(negativeVersion.text, /非负整数/, negativeVersion.text)
  assert.equal(queuedRequests().length, 0, '负数版本不写队列')

  const missingNote = await tool('board_request', {
    action: 'check',
    payload: { id: 't-version', itemId: 'k-synthetic', ifVersion: 7 },
  })
  assert.equal(missingNote.isError, true, '缺 note 的 check 不能入队')
  assert.match(missingNote.text, /check 需要 note：写清这一项是怎么验的/, missingNote.text)
  assert.match(missingNote.text, /交 ready 时逐项检查/, missingNote.text)
  assert.equal(queuedRequests().length, 0, '缺 note 不写队列')

  const queued = await tool('board_request', {
    action: 'check',
    payload: {
      id: 't-version', itemId: 'k-synthetic', note: '打开页面核对过', ifVersion: 7,
    },
  })
  assert.equal(queued.isError, false, queued.text)
  assert.match(queued.text, /已入队：\S+/)
  assert.match(queued.text, /成功后重新 board_get 读取新 version/)
  let requests = queuedRequests()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].action, 'check')
  assert.equal(requests[0].payload.note, '打开页面核对过')
  assert.equal(requests[0].payload.ifVersion, 7)

  // 旧的 create/pending/comment/move 不要求 version，入队行为保持不变。
  for (const [action, payload] of [
    ['create', { title: '旧动作卡' }],
    ['pending', { text: '旧动作候选' }],
    ['comment', { id: 't-version', body: '旧动作留言' }],
    ['move', { id: 't-version', status: 'todo' }],
  ]) {
    const result = await tool('board_request', { action, payload })
    assert.equal(result.isError, false, `${action}: ${result.text}`)
  }
  requests = queuedRequests()
  assert.equal(requests.length, 5)
  for (const row of requests.slice(1)) {
    assert.equal(row.payload.ifVersion, undefined, `${row.action} 不应被强加 version`)
  }
} finally {
  child.kill()
  clean()
}

console.log('s7-c: ok')
