// S6 B: rejection rules — storage, same-transaction rejection, injection and
// route actions. Synthetic ledger + fake host only.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeHarness } from './support/harness.mjs'
import { ensureEvidence } from './support/evidence-fixture.mjs'
import {
  acceptanceRulesFor, addAcceptanceRule, beginDispatch, createTask,
  deleteAcceptanceRule, getTask, listEffects, readLedger, reportExecution,
} from '../lib/ledger.js'
import { buildSuccessorPrompt } from '../lib/engine.js'
import { buildView } from '../lib/viewmodel.js'
import { handleAction } from '../lib/route.js'

function snapshot(hw, taskId) {
  return {
    bytes: fs.readFileSync(hw.file, 'utf8'),
    revision: readLedger(hw.file).revision,
    task: getTask(taskId, { file: hw.file }),
    followups: hw.calls.filter(call => call.type === 'followup').length,
  }
}

async function ready(hw, card) {
  const run = await hw.startConfirmed(card.id)
  ensureEvidence(card.id, hw.file)
  reportExecution(card.id, { outcome: 'ready', summary: '做完', checks: ['node test'] }, { file: hw.file })
  return run
}

function lastFollowup(hw) {
  return hw.calls.filter(call => call.type === 'followup').at(-1)?.message?.content?.[0]?.text ?? ''
}

// 1. reject + remember: 同一次写入保存状态、理由、次数和规矩；打回送达带规矩段。
{
  const hw = makeHarness()
  const card = hw.task({ title: '规则注入卡' })
  await ready(hw, card)
  const before = getTask(card.id, { file: hw.file })
  assert.equal(before.status, 'in_review')

  const result = await hw.engine.rejectTask(card.id, '以后都按这条检查', { remember: true })
  await hw.engine.whenIdle()
  const after = getTask(card.id, { file: hw.file })

  assert.equal(after.status, 'in_progress')
  assert.equal(after.rejectCount, 1)
  assert.equal(after.version, before.version + 1, '打回只加一次 version')
  assert.equal(after.comments.at(-1).body, '以后都按这条检查')
  assert.equal(after.comments.at(-1).author, 'user')
  const rules = acceptanceRulesFor(hw.dir, { file: hw.file })
  assert.equal(rules.length, 1)
  assert.equal(rules[0].text, '以后都按这条检查')
  assert.equal(rules[0].fromTaskId, card.id)
  assert.ok(result.rule?.id, '打回回执带上保存的规矩')
  const delivered = lastFollowup(hw)
  assert.match(delivered, /这个项目以前被打回过的原因/)
  assert.match(delivered, /以后都按这条检查/)

  // 2. 同样的文字再来一次不重复，但打回本身照常生效。
  await ready(hw, card)
  await hw.engine.rejectTask(card.id, '以后都按这条检查', { remember: true })
  await hw.engine.whenIdle()
  assert.equal(acceptanceRulesFor(hw.dir, { file: hw.file }).length, 1)
  assert.equal(getTask(card.id, { file: hw.file }).rejectCount, 2)
  hw.cleanup()
}

// 3. 第 21 条被拒绝，且打回不留下半截状态（同事务）。
{
  const hw = makeHarness()
  const card = hw.task({ title: '满额规矩卡' })
  await ready(hw, card)
  for (let index = 0; index < 20; index += 1) {
    addAcceptanceRule(card.id, `已有规矩 ${index}`, { file: hw.file })
  }
  assert.equal(acceptanceRulesFor(hw.dir, { file: hw.file }).length, 20)
  const before = snapshot(hw, card.id)
  await assert.rejects(
    () => hw.engine.rejectTask(card.id, '第 21 条规矩', { remember: true }),
    /已经 20 条/,
  )
  await hw.engine.whenIdle()
  const after = snapshot(hw, card.id)
  assert.deepEqual(after, before, '规矩满了：状态、理由、次数、台账和投递都不能变')
  assert.equal(after.task.status, 'in_review')
  assert.ok(!after.task.rejectCount, '拒收不能留下 rejectCount')
  hw.cleanup()
}

// 4. 没有目录的卡不能存规矩；整次打回都不生效。
{
  const hw = makeHarness()
  const card = createTask({ title: '没有目录的卡' }, { file: hw.file })
  beginDispatch(card.id, {
    sessionId: 'session-s6b-no-ws', messageId: 'msg-s6b-no-ws', text: 'x', cwd: hw.dir,
  }, { file: hw.file })
  ensureEvidence(card.id, hw.file, { sessionId: 'session-s6b-no-ws' })
  reportExecution(card.id, { outcome: 'ready', summary: '做完', checks: ['node test'] }, {
    file: hw.file,
    sessionId: 'session-s6b-no-ws',
  })
  const before = snapshot(hw, card.id)
  await assert.rejects(
    () => hw.engine.rejectTask(card.id, '没有目录也要记规矩', { remember: true }),
    /没有项目目录/,
  )
  await hw.engine.whenIdle()
  assert.deepEqual(snapshot(hw, card.id), before)
  hw.cleanup()
}

// 5. 重复回调：旧 version 的第二次打回只得到版本冲突，不重复理由、次数、规矩或投递。
{
  const hw = makeHarness()
  const card = hw.task({ title: '重复回调卡' })
  await ready(hw, card)
  const version = getTask(card.id, { file: hw.file }).version
  await hw.engine.rejectTask(card.id, '只该记一次', { remember: true, ifVersion: version })
  await hw.engine.whenIdle()
  const after = snapshot(hw, card.id)
  await assert.rejects(
    () => hw.engine.rejectTask(card.id, '只该记一次', { remember: true, ifVersion: version }),
    /version conflict/,
  )
  await hw.engine.whenIdle()
  assert.deepEqual(snapshot(hw, card.id), after)
  assert.equal(getTask(card.id, { file: hw.file }).rejectCount, 1)
  assert.equal(acceptanceRulesFor(hw.dir, { file: hw.file }).length, 1)
  hw.cleanup()
}

// 6. rule_add / rule_delete：text 携带规矩 id，必须在「缺卡 id」检查之前处理。
{
  const hw = makeHarness()
  const card = hw.task({ title: '手动规矩卡' })
  const added = await handleAction(hw.engine, { action: 'rule_add', id: card.id, text: '手动加一条' })
  assert.equal(added.rule.text, '手动加一条')
  assert.equal(added.rules.length, 1)
  const again = await handleAction(hw.engine, { action: 'rule_add', id: card.id, text: '手动加一条' })
  assert.equal(again.duplicate, true)
  assert.equal(again.rules.length, 1)
  await assert.rejects(
    () => handleAction(hw.engine, { action: 'rule_add', id: card.id, text: '  ' }),
    /需要规矩文字/,
  )
  // 注意：这里故意不传卡片 id，只把规矩 id 放在 text 里。
  const removed = await handleAction(hw.engine, { action: 'rule_delete', text: added.rule.id })
  assert.equal(removed.removed.id, added.rule.id)
  assert.equal(removed.rules.length, 0)
  const repeated = await handleAction(hw.engine, { action: 'rule_delete', text: added.rule.id })
  assert.equal(repeated.removed, null)
  await assert.rejects(
    () => handleAction(hw.engine, { action: 'rule_delete', text: '' }),
    /需要规矩 id/,
  )
  hw.cleanup()
}

// 7. 开工 / 接班 / 打回三段都注入；子目录包含上级，近的排在前面；别的目录没有；空规矩整段不出现。
{
  const hw = makeHarness()
  const parent = path.join(hw.dir, 'project')
  const child = path.join(parent, 'sub')
  const other = path.join(hw.dir, 'project2')
  fs.mkdirSync(child, { recursive: true })
  fs.mkdirSync(other, { recursive: true })

  const parentCard = createTask({ title: '父目录', workspacePath: parent }, { file: hw.file })
  const childCard = createTask({ title: '子目录', workspacePath: child }, { file: hw.file })
  addAcceptanceRule(parentCard.id, '父目录的规矩', { file: hw.file })
  addAcceptanceRule(childCard.id, '子目录的规矩', { file: hw.file })

  const run = await hw.engine.startTask(childCard.id)
  await hw.engine.whenIdle()
  const prompt = listEffects({ file: hw.file }).filter(effect => effect.taskId === childCard.id && effect.kind === 'start').at(-1).text
  assert.match(prompt, /父目录的规矩/)
  assert.match(prompt, /子目录的规矩/)
  assert.ok(prompt.indexOf('子目录的规矩') < prompt.indexOf('父目录的规矩'), '近的规矩排在前面')

  const successor = buildSuccessorPrompt(getTask(childCard.id, { file: hw.file }), {
    summary: '上一轮', outcome: 'progress',
  }, '继续做', child, { rules: acceptanceRulesFor(child, { file: hw.file }) })
  assert.match(successor, /这个项目以前被打回过的原因/)
  assert.match(successor, /父目录的规矩/)
  assert.match(successor, /子目录的规矩/)

  // 别的目录（project2 不是 project 的子目录）不带 project 的规矩。
  const otherCard = createTask({ title: '别的目录', workspacePath: other }, { file: hw.file })
  const otherPromptRun = await hw.engine.startTask(otherCard.id)
  await hw.engine.whenIdle()
  const otherPrompt = listEffects({ file: hw.file }).filter(effect => effect.taskId === otherCard.id && effect.kind === 'start').at(-1).text
  assert.doesNotMatch(otherPrompt, /父目录的规矩/)
  assert.doesNotMatch(otherPrompt, /这个项目以前被打回过的原因/)

  // 空规矩：整段不出现。
  const cleanDir = path.join(hw.dir, 'clean')
  fs.mkdirSync(cleanDir)
  const cleanCard = createTask({ title: '空规矩', workspacePath: cleanDir }, { file: hw.file })
  await hw.engine.startTask(cleanCard.id)
  await hw.engine.whenIdle()
  const cleanPrompt = listEffects({ file: hw.file }).filter(effect => effect.taskId === cleanCard.id && effect.kind === 'start').at(-1).text
  assert.doesNotMatch(cleanPrompt, /以前被打回过的原因/)
  assert.ok(run.sessionId)
  assert.ok(otherPromptRun.sessionId)
  hw.cleanup()
}

// 8. 规矩是项目级数据：视图带目录，删除后消失；不进入任何分组/标题数字。
{
  const hw = makeHarness()
  const card = hw.task({ title: '视图规矩卡' })
  addAcceptanceRule(card.id, '视图里能看到', { file: hw.file })
  const view = buildView({ file: hw.file })
  assert.equal(view.acceptanceRules.count, 1)
  assert.equal(view.acceptanceRules.items[0].workspacePath, hw.dir)
  assert.deepEqual(view.counts, buildView({ file: hw.file }).counts)
  assert.equal(deleteAcceptanceRule(view.acceptanceRules.items[0].id, { file: hw.file }).rule.text, '视图里能看到')
  assert.equal(buildView({ file: hw.file }).acceptanceRules.count, 0)
  assert.ok(Array.isArray(listEffects({ file: hw.file })))
  hw.cleanup()
}

// 9. 路由只认严格布尔 true：字符串 "yes" 不能替用户授权存规矩。
{
  const hw = makeHarness()
  const card = hw.task({ title: '严格布尔卡' })
  await ready(hw, card)
  await handleAction(hw.engine, { action: 'reject', id: card.id, text: '字符串不算', remember: 'yes' })
  await hw.engine.whenIdle()
  assert.equal(acceptanceRulesFor(hw.dir, { file: hw.file }).length, 0)

  await ready(hw, card)
  const accepted = await handleAction(hw.engine, { action: 'reject', id: card.id, text: '布尔算', remember: true })
  await hw.engine.whenIdle()
  assert.equal(accepted.rule.text, '布尔算')
  assert.equal(acceptanceRulesFor(hw.dir, { file: hw.file }).length, 1)
  hw.cleanup()
}

console.log('s6-b: ok')
