// S3 第 2 阶段：等你点头（花钱 / 对外 / 权限）——只按规则判断，不调模型。
// 全部用临时合成台账和假宿主。

import assert from 'node:assert/strict'
import { makeHarness } from './support/harness.mjs'
import { detectNod, nodReason } from '../lib/nod.js'
import { createRouter } from '../lib/router.js'
import {
  addPending,
  getTask,
  readLedger,
  updateRouter,
} from '../lib/ledger.js'
import { installCapture } from '../lib/capture.js'
import { registerRoutes } from '../lib/route.js'
import { buildPrompt } from '../lib/engine.js'
import { buildView, WAITING_ORDER } from '../lib/viewmodel.js'

function routesFor(engine) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name !== 'connection') return null
      return {
        fetch: {
          register(definition) {
            routes.set(definition.path, definition)
            return () => routes.delete(definition.path)
          },
        },
      }
    },
  }
  const dispose = registerRoutes(ctx, { engine })
  async function post(body) {
    const route = routes.get('/api/superagent/action')
    const response = await route.fetch(new Request('http://localhost/api/superagent/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    return { status: response.status, body: await response.json() }
  }
  return { dispose, post }
}

function routerFor(hw) {
  return createRouter({
    file: hw.file,
    engine: hw.engine,
    debounceMs: 10,
    tickMs: 60 * 60_000,
    wait: async () => {},
  })
}

const creates = hw => hw.calls.filter(call => call.type === 'create').length

// 规则判断：三类词各命中，普通整理不命中。
{
  const spend = detectNod('给供应商付款并下单买素材')
  assert.deepEqual(spend.kinds, ['spend'])
  assert.ok(spend.matched.includes('付款') && spend.matched.includes('下单'))

  const outbound = detectNod('把这篇文章发布到公众号，再群发一遍')
  assert.deepEqual(outbound.kinds, ['outbound'])
  assert.ok(outbound.matched.includes('发布') && outbound.matched.includes('群发'))

  const permission = detectNod('删掉远端分支，再改系统设置')
  assert.deepEqual(permission.kinds, ['permission'])
  assert.ok(permission.matched.includes('改系统设置'))

  assert.equal(detectNod('整理会议纪要，归档到文档'), null)
  assert.equal(detectNod(''), null)

  const mixed = detectNod('npm publish 之后把链接发给客户')
  assert.deepEqual(mixed.kinds, ['outbound'])
  assert.ok(mixed.matched.includes('npm publish'))

  assert.equal(nodReason({ kinds: ['spend'], matched: ['付款'] }), '要花钱，等你点头（命中：付款）')
  assert.equal(
    nodReason({ kinds: ['spend', 'outbound'], matched: ['付款', '发布'] }),
    '要花钱 / 要对外发，等你点头（命中：付款、发布）',
  )
}

// 建卡时按标题和描述写 needsNod：面板 create、pending_accept、queue 动作、规则落卡。
{
  const hw = makeHarness()
  const routes = routesFor(hw.engine)
  const created = await routes.post({
    action: 'create',
    text: '给供应商付款买素材',
    workspacePath: hw.dir,
  })
  assert.equal(created.status, 200)
  const card = getTask(created.body.result.task.id, { file: hw.file })
  assert.deepEqual(card.needsNod.kinds, ['spend'])
  assert.equal(card.nodded, null)
  assert.equal(card.queue.auto, true)

  const plain = await routes.post({ action: 'create', text: '整理会议纪要', workspacePath: hw.dir })
  assert.equal(getTask(plain.body.result.task.id, { file: hw.file }).needsNod, null)

  const pendingRow = addPending({
    text: '把稿子发布到公众号',
    title: '把稿子发布到公众号',
    workspacePath: hw.dir,
  }, { file: hw.file })
  const accepted = hw.engine.acceptPending(pendingRow.id)
  assert.deepEqual(accepted.needsNod.kinds, ['outbound'])

  const later = hw.task({ title: '之后要充值续费', status: 'backlog' })
  assert.deepEqual(later.needsNod?.kinds, ['spend'], '建卡时先记下，排队时再用')
  const queued = hw.engine.queueTask(later.id)
  assert.equal(queued.queue.auto, true)
  assert.deepEqual(queued.needsNod.kinds, ['spend'])

  // 规则落卡也走同一套判断。
  const handlers = []
  installCapture({ on: (name, handler) => { handlers.push(handler); return () => {} } }, {})
  const previous = process.env.DSH_SUPERAGENT_LEDGER
  process.env.DSH_SUPERAGENT_LEDGER = hw.file
  try {
    await handlers[0]({
      agent: { id: 'session-user-nod' },
      session: { header: { cwd: hw.dir } },
      message: {
        id: 'msg-rule-nod',
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '帮我记一下：给团队报名费并付款' }],
      },
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_SUPERAGENT_LEDGER
    else process.env.DSH_SUPERAGENT_LEDGER = previous
  }
  const led = readLedger(hw.file)
  const ruled = led.tasks.find(task => task.createdBy === 'rule')
  assert.ok(ruled, '规则落卡要建出卡')
  assert.deepEqual(ruled.needsNod.kinds, ['spend'])
  routes.dispose()
  hw.cleanup()
}

// 三类各一张卡都进 nod，分组在「等你」，排在 review 之后；动作表正确。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2 }, { file: hw.file })
  const auto = { queue: { auto: true, by: 'user' } }
  const review = hw.task({ title: 'S3 合成：等验收', status: 'in_review' })
  const spend = hw.task({ title: 'S3 合成：付款', description: '给供应商付款', ...auto })
  const outbound = hw.task({ title: 'S3 合成：发布', description: '把结果发布到公众号', ...auto })
  const permission = hw.task({ title: 'S3 合成：提权', description: '用 sudo 改系统设置', ...auto })
  const plain = hw.task({ title: 'S3 合成：普通自动', description: '整理会议纪要', ...auto })

  const view = buildView({ file: hw.file })
  const byId = id => view.cards.find(card => card.id === id)
  for (const [card, kind] of [[spend, 'spend'], [outbound, 'outbound'], [permission, 'permission']]) {
    assert.equal(byId(card.id).stage, 'nod')
    assert.equal(byId(card.id).group, 'waiting')
    assert.deepEqual(byId(card.id).actions.map(item => item.label), ['可以做', '以后再说', '不做了'])
    assert.equal(byId(card.id).actions[0].action, 'nod')
    assert.equal(byId(card.id).actions[0].primary, true)
    const task = getTask(card.id, { file: hw.file })
    assert.ok(task.needsNod.kinds.includes(kind))
  }
  assert.equal(byId(outbound.id).reason, '要对外发，等你点头（命中：发布）')
  assert.match(byId(permission.id).reason, /要更大权限，等你点头/)
  assert.equal(byId(plain.id).stage, 'queued')

  const stages = view.groups.waiting.map(card => card.stage)
  assert.ok(stages.indexOf('review') < stages.indexOf('nod'), '等你里 review 在 nod 之前')
  assert.ok(WAITING_ORDER.indexOf('review') < WAITING_ORDER.indexOf('nod'))
  assert.ok(WAITING_ORDER.indexOf('nod') < WAITING_ORDER.indexOf('stuck'))

  const router = routerFor(hw)
  const before = creates(hw)
  await router.runOnce()
  assert.equal(creates(hw) - before, 1, '三张要点头的都不开工，只有普通那张有资格')
  assert.equal(hw.buildView().router.free, 1, '空位还在，等用户点头')
  router.stop()
  hw.cleanup()
}

// 点头：没空位时等，点头后有空位就开工；开场白写明批准范围。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 1 }, { file: hw.file })
  const card = hw.task({
    title: 'S3 合成：发布文章',
    description: '把稿子发布到公众号',
    queue: { auto: true, by: 'user' },
  })
  const routes = routesFor(hw.engine)
  const router = routerFor(hw)

  const before = creates(hw)
  const first = await router.runOnce()
  assert.equal(first.started.length, 0, '没点头不开工')
  assert.equal(creates(hw) - before, 0)
  const view = buildView({ file: hw.file })
  assert.equal(view.cards.find(row => row.id === card.id).stage, 'nod')

  const versionBefore = getTask(card.id, { file: hw.file }).version
  const nodded = await routes.post({ action: 'nod', id: card.id, version: versionBefore })
  assert.equal(nodded.status, 200, `点头应成功：${nodded.body.error ?? ''}`)
  const saved = getTask(card.id, { file: hw.file })
  assert.deepEqual(saved.nodded.by, 'user')
  assert.ok(Number.isFinite(saved.nodded.at))
  assert.ok(saved.version > versionBefore, '点头要加版本号')
  assert.equal(saved.status, 'todo', '点头不动状态')
  assert.equal(saved.needsNod.kinds[0], 'outbound')

  const afterNod = buildView({ file: hw.file })
  assert.equal(afterNod.cards.find(row => row.id === card.id).stage, 'queued', '点头后回到排队')

  const started = await router.runOnce()
  assert.deepEqual(started.started.map(row => row.taskId), [card.id])
  const led = readLedger(hw.file)
  const effect = led.effects.find(item => item.taskId === card.id && item.kind === 'start')
  assert.match(effect.text, /用户已经点头的范围/)
  assert.match(effect.text, /超出的部分/)
  assert.match(effect.text, /blocked/)
  router.stop()
  routes.dispose()
  hw.cleanup()
}

// 没点过头的卡：开场白走通用边界；已点头的卡也只做卡上那件事。
{
  const hw = makeHarness()
  const plain = hw.task({ title: 'S3 合成：普通卡' })
  const boundary = buildPrompt(getTask(plain.id, { file: hw.file }), hw.dir)
  assert.match(boundary, /## 边界/)
  assert.match(boundary, /要花钱、对外发送、需要更大权限的步骤，不要自己做/)
  assert.match(boundary, /outcome: "blocked"/)

  const nodCard = hw.task({ title: 'S3 合成：发布', description: '发布到公众号' })
  hw.engine.confirmNod(nodCard.id)
  const scoped = buildPrompt(getTask(nodCard.id, { file: hw.file }), hw.dir)
  assert.match(scoped, /## 用户已经点头的范围/)
  assert.match(scoped, /范围就是这张卡/)
  hw.cleanup()
}

// 以后再说 + 排进去：needsNod 不丢，回到 nod 继续等。
{
  const hw = makeHarness()
  updateRouter({ mode: 'auto', maxRunning: 2 }, { file: hw.file })
  const card = hw.task({
    title: 'S3 合成：稍后付款',
    description: '付款买素材',
    queue: { auto: true, by: 'user' },
  })
  const routes = routesFor(hw.engine)
  const later = await routes.post({ action: 'later', id: card.id })
  assert.equal(later.status, 200)
  assert.equal(getTask(card.id, { file: hw.file }).status, 'backlog')
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === card.id).stage, 'later')

  const queued = await routes.post({ action: 'queue', id: card.id })
  assert.equal(queued.status, 200)
  const saved = getTask(card.id, { file: hw.file })
  assert.equal(saved.queue.auto, true)
  assert.deepEqual(saved.needsNod.kinds, ['spend'])
  assert.equal(buildView({ file: hw.file }).cards.find(row => row.id === card.id).stage, 'nod')

  const rejected = await routes.post({ action: 'nod', id: card.id, version: saved.version })
  assert.equal(rejected.status, 200)
  routes.dispose()
  hw.cleanup()
}

// 没点头的卡也能被用户手动开始（手动不受 Router 限制）。
{
  const hw = makeHarness()
  const card = hw.task({ title: 'S3 合成：手动付款', description: '付款买素材' })
  const routes = routesFor(hw.engine)
  const started = await routes.post({ action: 'start', id: card.id })
  assert.equal(started.status, 200)
  assert.equal(getTask(card.id, { file: hw.file }).status, 'in_progress')
  const effect = readLedger(hw.file).effects.find(item => item.taskId === card.id && item.kind === 'start')
  assert.match(effect.text, /## 边界/, '没点头也要在开场白里写边界')
  routes.dispose()
  hw.cleanup()
}

console.log('s3-nod: ok')
