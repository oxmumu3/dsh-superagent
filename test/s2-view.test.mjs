import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeLedger, makeStageSet } from './support/s2-fixtures.mjs'

// F.1.1 / F.1.2：五组、计数、动作表。所有数据都是临时合成台账。
{
  const fx = makeLedger()
  const rows = makeStageSet(fx)
  const view = fx.view()

  for (const key of ['waiting', 'running', 'queued', 'later', 'doneToday']) {
    assert.equal(view.counts[key], view.groups[key].length, `${key} 的数必须等于列表长度`)
  }
  assert.deepEqual(view.counts, { waiting: 7, running: 1, queued: 1, later: 1, doneToday: 1 })
  assert.deepEqual(view.groups.waiting.map(card => card.stage), [
    'not_started',
    'not_delivered',
    'approval',
    'question',
    'review',
    'stuck',
    'silent',
  ])

  const unfinished = Object.values(rows).filter(row => !['done', 'canceled'].includes(fx.task(row.id).status))
  const firstFour = new Set([
    ...view.groups.waiting,
    ...view.groups.running,
    ...view.groups.queued,
    ...view.groups.later,
  ].map(card => card.id))
  for (const row of unfinished) {
    assert.ok(firstFour.has(row.id), `${row.title} 必须在前四组之一`)
  }
  const allGrouped = [
    ...view.groups.waiting,
    ...view.groups.running,
    ...view.groups.queued,
    ...view.groups.later,
    ...view.groups.doneToday,
  ].map(card => card.id)
  assert.equal(new Set(allGrouped).size, allGrouped.length, '五组互斥，一张卡只能出现一次')
  assert.equal(view.groups.doneToday[0].id, rows.done.id)
  assert.ok(!allGrouped.includes(rows.canceled.id), 'canceled 不进任何组')
  assert.ok(!allGrouped.includes(rows.oldDone.id), '超过 24 小时的 done 不进今天做完')

  const byId = id => view.cards.find(card => card.id === id)
  const labels = id => byId(id).actions.map(item => item.label)
  assert.deepEqual(labels(rows.not_started.id), ['再试一次', '不做了'])
  assert.equal(byId(rows.not_started.id).actions[0].primary, true)
  assert.deepEqual(labels(rows.not_delivered.id), ['再送一次', '不做了'])
  assert.equal(byId(rows.not_delivered.id).actions[0].primary, true)
  assert.deepEqual(labels(rows.approval.id), ['不做了'])
  assert.equal(byId(rows.approval.id).actions[0].primary, false, '批准只能在会话里做，不把取消做成主按钮')
  assert.deepEqual(labels(rows.question.id), ['方案甲', '方案乙', '自己写', '不做了'])
  assert.equal(byId(rows.question.id).actions[0].primary, true)
  assert.equal(byId(rows.question.id).actions[2].needsText, true)
  assert.deepEqual(byId(rows.question.id).question, { text: '要用哪个方案？', options: ['方案甲', '方案乙'] })
  assert.deepEqual(labels(rows.review.id), ['验收', '打回', '不做了'])
  assert.equal(byId(rows.review.id).actions[0].primary, true)
  assert.equal(byId(rows.review.id).actions[1].needsText, true)
  assert.deepEqual(labels(rows.stuck.id), ['告诉它怎么办', '不做了'])
  assert.equal(byId(rows.stuck.id).actions[0].needsText, true)
  assert.deepEqual(labels(rows.silent.id), ['催一下', '不做了'])
  assert.equal(
    byId(rows.silent.id).actions[0].preset,
    '你上一轮停下了但没交报告。请用 sa_report 说明现在的情况。',
  )
  assert.deepEqual(labels(rows.working.id), ['补一句', '不做了'])
  assert.equal(byId(rows.working.id).actions[0].needsText, true)
  assert.deepEqual(labels(rows.queued.id), ['开始', '以后再说'])
  assert.equal(byId(rows.queued.id).actions[0].primary, true)
  assert.deepEqual(labels(rows.later.id), ['排进去', '现在就做'])
  assert.equal(byId(rows.later.id).actions[0].primary, true)
  assert.deepEqual(byId(rows.done.id).actions, [])

  assert.match(byId(rows.working.id).who, /^会话 …/)
  assert.equal(byId(rows.working.id).workspaceLabel, path.basename(fx.dir))
  assert.equal(byId(rows.queued.id).needsWorkspace, false)
  assert.equal(byId(rows.working.id).needsWorkspace, false)
  fx.cleanup()
}

// F.1.2 续：没有目录的卡，开始按钮改成「选个目录并开始」。
{
  const fx = makeLedger({ workspace: null })
  const card = fx.card('S2 合成：缺目录')
  const view = fx.view()
  const row = view.cards.find(item => item.id === card.id)
  assert.equal(row.needsWorkspace, true)
  assert.equal(row.workspacePath, null)
  assert.equal(row.actions[0].action, 'start')
  assert.equal(row.actions[0].label, '选个目录并开始')
  fx.cleanup()
}

// F.1.1 续：同阶段急的在前，其次等得久的在前。
{
  const fx = makeLedger()
  const oldNormal = fx.card('S2 合成：旧的普通')
  const urgent = fx.card('S2 合成：急的')
  const newerNormal = fx.card('S2 合成：新的普通')
  fx.failStart(oldNormal)
  fx.failStart(urgent)
  fx.failStart(newerNormal)
  fx.raw(ledger => {
    const at = Date.now() - 60_000
    ledger.tasks.find(row => row.id === oldNormal.id).urgency = 'normal'
    ledger.tasks.find(row => row.id === urgent.id).urgency = 'urgent'
    ledger.tasks.find(row => row.id === newerNormal.id).urgency = 'normal'
    for (const [id, offset] of [[oldNormal.id, 0], [newerNormal.id, 20_000], [urgent.id, 40_000]]) {
      const task = ledger.tasks.find(row => row.id === id)
      task.updatedAt = at + offset
    }
    // 等待起点来自最近一次失败的 start 动作。
    const order = [oldNormal.id, urgent.id, newerNormal.id]
    ledger.effects
      .filter(effect => effect.kind === 'start' && order.includes(effect.taskId))
      .forEach(effect => {
        effect.createdAt = at + order.indexOf(effect.taskId) * 10_000
      })
  })
  const waiting = fx.view().groups.waiting
  assert.deepEqual(waiting.map(row => row.id), [urgent.id, oldNormal.id, newerNormal.id])
  fx.cleanup()
}

// F.1.7：候选目录去重、只留存在的、最近用过在前、最多 8 个。
{
  const fx = makeLedger()
  const root = path.join(fx.dir, 'candidates')
  fs.mkdirSync(root)
  const dirs = []
  for (let index = 0; index < 9; index += 1) {
    const dir = path.join(root, 'p' + index)
    fs.mkdirSync(dir)
    dirs.push(dir)
  }
  const cards = dirs.map((dir, index) => fx.card('S2 候选 ' + index, { workspacePath: dir }))
  fx.card('S2 候选重复', { workspacePath: dirs[7] })
  fx.card('S2 候选不存在', { workspacePath: path.join(root, 'gone') })
  fx.raw(ledger => {
    const base = Date.now() - 100_000
    cards.forEach((card, index) => {
      const task = ledger.tasks.find(row => row.id === card.id)
      task.updatedAt = base + index * 1_000
    })
    const duplicate = ledger.tasks.find(row => row.title === 'S2 候选重复')
    duplicate.updatedAt = base + 500
  })

  const view = fx.view()
  assert.equal(view.workspaces.length, 8)
  assert.equal(view.workspaces[0].path, dirs[8])
  assert.equal(view.defaultWorkspace, dirs[8])
  assert.ok(view.workspaces.every(row => fs.statSync(row.path).isDirectory()))
  assert.ok(!view.workspaces.some(row => row.path.endsWith('/gone')))
  const first = view.workspaces.find(row => row.path === dirs[7])
  assert.equal(first.count, 2, '重复目录只出现一次，件数合并')
  assert.equal(first.label, 'p7')
  fx.cleanup()
}

// 空台账时两个字段都为空。
{
  const fx = makeLedger()
  const view = fx.view()
  assert.deepEqual(view.workspaces, [])
  assert.equal(view.defaultWorkspace, null)
  assert.deepEqual(view.pending, [])
  fx.cleanup()
}

console.log('s2-view: ok')
