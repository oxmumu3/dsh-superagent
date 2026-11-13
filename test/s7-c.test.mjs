// S7 C: isolated MCP board_request check note aligns with the host ready gate.
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
const clean = () => fs.rmSync(dir, { recursive: true, force: true })

const child = spawn(process.execPath, [server], {
  cwd: root,
  env: {
    ...process.env,
    DSH_HOME: dir,
    DSH_TASKBOARD_QUEUE: path.join(dir, 'taskboard-queue'),
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
  const boardRequest = listed.tools.find(row => row.name === 'board_request')
  assert.ok(boardRequest, 'MCP 必须暴露 board_request')
  const payload = boardRequest.inputSchema.properties.payload.description
  assert.match(payload, /note（必填/, 'MCP 必须把 check 的 note 写成必填')
  assert.match(payload, /宿主交 ready 时逐项检查，缺 note 会被拒收/, '说明要与宿主强制口径一致')

  const missing = await tool('board_request', {
    action: 'check',
    payload: { id: 't-synthetic', itemId: 'k-synthetic' },
  })
  assert.equal(missing.isError, true, '缺 note 的 check 不能入队')
  assert.match(missing.text, /check 需要 note：写清这一项是怎么验的/, missing.text)
  assert.match(missing.text, /交 ready 时逐项检查/, missing.text)

  const queued = await tool('board_request', {
    action: 'check',
    payload: { id: 't-synthetic', itemId: 'k-synthetic', note: '打开页面核对过' },
  })
  assert.equal(queued.isError, false, queued.text)
  assert.match(queued.text, /已入队：\S+/)
  const requests = fs.readFileSync(path.join(dir, 'taskboard-queue', 'requests.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].action, 'check')
  assert.equal(requests[0].payload.note, '打开页面核对过')
} finally {
  child.kill()
  clean()
}

console.log('s7-c: ok')
