// S6-B 合成合同：只有可信当前用户原话末尾独立说「以后都这样/以后都按这个」
// 才在打回时写项目规矩；模型参数、否定、转述、旧轮都不写。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEngine } from '../lib/engine.js'
import { readLedger, writeLedger, acceptanceRulesFor } from '../lib/ledger.js'
import { decide } from '../lib/decide.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's6-remember-'))
const file = path.join(dir, 'ledger.json')
const at = Date.now()
const task = {
  id: 't-synthetic', title: 'Synthetic review', status: 'in_review', urgency: 'normal',
  workspacePath: dir, version: 1, createdAt: at, updatedAt: at, comments: [], checklist: [],
  executions: [], assignments: [], queue: null, nodded: false, dependsOn: [],
}
const notice = { id: 'n-synthetic', code: 'A1', taskId: task.id, stage: 'review', state: 'new', enteredAt: at, taskVersion: 1 }
const exec = { sessionId: 'session-user-1', callId: 'fixture-call' }
const engine = createEngine({ file, adapter: {}, wait: async () => {} })
const cases = [
  { label: 'trailing 按这个', userText: 'A1 打回，报告保留标题，以后都按这个', expectedRule: '报告保留标题' },
  { label: 'trailing 都这样', userText: 'A1 打回，标题别丢，以后都这样', expectedRule: '标题别丢' },
  { label: 'no phrase', userText: 'A1 打回，报告保留标题', expectedRule: null },
  { label: 'model-only consent', userText: 'A1 打回，报告保留标题', args: { text: '以后都按这个', remember: true }, expectedRule: null },
  { label: 'negated', userText: 'A1 打回，报告保留标题，但不要以后都按这个', expectedRule: null },
  { label: 'paraphrase', userText: 'A1 打回，报告保留标题，以后都照这个', expectedRule: null },
  { label: 'middle not tail', userText: 'A1 打回，以后都按这个，报告保留标题', expectedRule: null },
]
try {
  for (const entry of cases) {
    writeLedger({ schemaVersion: 1, revision: 1, tasks: [task], pending: [], effects: [], notices: [notice] }, file)
    const authority = async () => ({
      trusted: true, activeCall: true, sourceKind: 'user', sessionId: exec.sessionId,
      callId: exec.callId, turnId: 3, userText: entry.userText,
    })
    const result = await decide(engine, { decision: 'reject', ...entry.args }, exec, { file, authority })
    assert.equal(result.ok, true, entry.label)
    assert.equal(readLedger(file).tasks[0].status, 'in_progress', entry.label)
    const rules = acceptanceRulesFor(dir, { file }).map(rule => rule.text)
    assert.deepEqual(rules, entry.expectedRule ? [entry.expectedRule] : [], entry.label)
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
console.log('s6-decide-remember: ok')
