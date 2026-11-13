import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLedger } from '../lib/ledger.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's0-a2-'))
const file = path.join(dir, 'ledger.json')

// 1) 文件不存在 = 空台账（这是唯一允许的「空」）。
{
  const empty = readLedger(file)
  assert.deepEqual(empty.tasks, [])
  assert.deepEqual(empty.pending, [])
}

// 2) 文件存在但读不出来：必须报错，不许当空，并且原文件另存了一份。
fs.writeFileSync(file, '{ this is not json')
for (let i = 0; i < 3; i += 1) {
  assert.throws(
    () => readLedger(file),
    err => {
      assert.equal(err.code, 'LEDGER_UNREADABLE')
      assert.match(err.message, /corrupt-/)
      return true
    },
  )
}
const backups = fs.readdirSync(dir).filter(name => name.includes('.corrupt-'))
assert.equal(backups.length, 1, '同一份坏内容只许留一个副本（连读三次）')
assert.match(backups[0], /\.corrupt-[0-9a-f]{12}$/)
assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ this is not json')
// 原文件没被覆盖或清空
assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json')

// 2b) 内容变了才多一个副本。
fs.writeFileSync(file, '{ different broken json')
assert.throws(() => readLedger(file), err => err.code === 'LEDGER_UNREADABLE')
assert.equal(fs.readdirSync(dir).filter(n => n.includes('.corrupt-')).length, 2)

// 3) 结构不对（合法 JSON 但不是台账）同样报错。
fs.writeFileSync(file, JSON.stringify({ hello: 1 }))
assert.throws(() => readLedger(file), err => err.code === 'LEDGER_UNREADABLE')

fs.rmSync(dir, { recursive: true, force: true })
console.log('s0-a2: ok')
