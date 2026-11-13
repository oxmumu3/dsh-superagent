// S4 第 5 阶段：派工记录里只记「谁在做」的类型。
import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { getTask, readLedger, writeLedger } from '../lib/ledger.js'
import { buildCardDetail } from '../lib/viewmodel.js'

// 新建派工写 executor；卡版本号不受影响。
{
  const hw = makeHarness()
  const card = hw.task({ title: 'S4 派工类型' })
  await hw.startConfirmed(card.id)
  const task = getTask(card.id, { file: hw.file })
  const assignment = task.assignments.find(item => item.state !== 'ended')
  assert.deepEqual(assignment.executor, { kind: 'dsh-session' })
  assert.equal(task.version, 2, '开始一张卡仍是 todo→in_progress 一次版本')
  const detail = buildCardDetail(task, { effects: hw.listEffects() })
  assert.equal(detail.assignments[0].executor, 'dsh-session')
  hw.cleanup()
}

// 老派工没有字段：详情按 dsh-session 读，不报错、不改台账。
{
  const hw = makeHarness()
  const card = hw.task({ title: 'S4 老派工' })
  await hw.startConfirmed(card.id)
  const ledger = readLedger(hw.file)
  const task = ledger.tasks.find(row => row.id === card.id)
  delete task.assignments[0].executor
  writeLedger(ledger, hw.file)
  const saved = getTask(card.id, { file: hw.file })
  assert.equal(saved.assignments[0].executor, undefined)
  const detail = buildCardDetail(saved, { effects: hw.listEffects() })
  assert.equal(detail.assignments[0].executor, 'dsh-session')
  hw.cleanup()
}

console.log('s4-executor: ok')
