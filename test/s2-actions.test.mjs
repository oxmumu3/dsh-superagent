import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeHarness } from './support/harness.mjs'
import { addPending, getTask, listPending } from '../lib/ledger.js'
import { handleAction, registerRoutes } from '../lib/route.js'

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
  return { routes, dispose, post }
}

// F.1.3：create 的四种目录来源。显式路径优先，话里的路径是加分项，找不到就留空。
{
  const hw = makeHarness()
  const explicit = await handleAction(hw.engine, {
    action: 'create', text: '合成：显式目录', workspacePath: hw.dir,
  })
  assert.equal(explicit.task.workspacePath, hw.dir)

  const fromText = await handleAction(hw.engine, {
    action: 'create', text: `合成：话里写了 ${hw.dir} 这个目录`,
  })
  assert.equal(fromText.task.workspacePath, hw.dir)

  // 面板的最近目录只是预填；用户没明确选时，句子里紧贴中文的路径优先。
  const other = path.join(hw.dir, 'other')
  fs.mkdirSync(other)
  const tight = await handleAction(hw.engine, {
    action: 'create', text: `合成：请在${hw.dir}整理资料`, workspacePath: other,
  })
  assert.equal(tight.task.workspacePath, hw.dir, '紧贴中文的路径也要识别，并压过预填目录')

  const explicitWins = await handleAction(hw.engine, {
    action: 'create',
    text: `合成：请在${hw.dir}整理资料`,
    workspacePath: other,
    workspaceExplicit: true,
  })
  assert.equal(explicitWins.task.workspacePath, other, '明确选过目录就以选择为准')

  const explicitBlank = await handleAction(hw.engine, {
    action: 'create',
    text: `合成：请在${hw.dir}整理资料`,
    workspacePath: null,
    workspaceExplicit: true,
  })
  assert.equal(explicitBlank.task.workspacePath, null, '明确「先不定」不再从句子推断')

  const missingText = await handleAction(hw.engine, {
    action: 'create', text: '合成：话里写了 /tmp/s2-not-a-real-dir-8f4c 但这个不存在',
  })
  assert.equal(missingText.task.workspacePath, null, '话里的路径不存在时留空，不报错')

  const blank = await handleAction(hw.engine, { action: 'create', text: '合成：什么目录都没写' })
  assert.equal(blank.task.workspacePath, null)

  await assert.rejects(
    handleAction(hw.engine, { action: 'create', text: '合成：显式目录不存在', workspacePath: '/tmp/s2-no-such-dir-8f4c' }),
    /这个目录不存在/,
  )

  const explicitNone = await handleAction(hw.engine, {
    action: 'create', text: '合成：先不定', workspacePath: null, workspaceExplicit: true,
  })
  assert.equal(explicitNone.task.workspacePath, null)
  hw.cleanup()
}

// F.1.4：start 缺目录返回 400 + needWorkspace，不写失败的 start，阶段不变。
{
  const hw = makeHarness()
  const card = hw.task({ title: '合成：缺目录', workspacePath: null })
  const before = {
    effects: hw.listEffects().length,
    status: getTask(card.id, { file: hw.file }).status,
    version: getTask(card.id, { file: hw.file }).version,
    stage: hw.stage(card.id).stage,
  }
  const routes = routesFor(hw.engine)
  const result = await routes.post({ action: 'start', id: card.id })
  assert.equal(result.status, 400)
  assert.equal(result.body.needWorkspace, true)
  assert.match(result.body.error, /选个目录/)
  assert.equal(hw.listEffects().length, before.effects, '缺目录不写失败动作')
  assert.equal(getTask(card.id, { file: hw.file }).status, before.status)
  assert.equal(getTask(card.id, { file: hw.file }).version, before.version)
  assert.equal(hw.stage(card.id).stage, before.stage)
  routes.dispose()
  hw.cleanup()
}

// F.1.5：start 带 cwd 写进卡并生成一条 start；cwd 不存在时 400，什么都不写。
{
  const hw = makeHarness()
  const card = hw.task({ title: '合成：带目录开始', workspacePath: null })
  const routes = routesFor(hw.engine)
  const good = await routes.post({ action: 'start', id: card.id, cwd: hw.dir })
  assert.equal(good.status, 200)
  const saved = getTask(card.id, { file: hw.file })
  assert.equal(saved.workspacePath, hw.dir)
  assert.equal(saved.status, 'in_progress')
  const effects = hw.listEffects().filter(effect => effect.taskId === card.id)
  assert.equal(effects.length, 1)
  assert.equal(effects[0].kind, 'start')
  await hw.engine.whenIdle()
  assert.equal(hw.stage(card.id).stage, 'working')

  const invalid = hw.task({ title: '合成：坏目录开始', workspacePath: null })
  const before = hw.listEffects().length
  const bad = await routes.post({ action: 'start', id: invalid.id, cwd: path.join(hw.dir, 'missing') })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /这个目录不存在/)
  assert.equal(hw.listEffects().length, before)
  assert.equal(getTask(invalid.id, { file: hw.file }).workspacePath, null)
  assert.equal(getTask(invalid.id, { file: hw.file }).status, 'todo')
  routes.dispose()
  hw.cleanup()
}

// F.1.6：workspace 设、清空、有派工时拒绝；非法路径不写。
{
  const hw = makeHarness()
  const card = hw.task({ title: '合成：设目录', workspacePath: null })
  const routes = routesFor(hw.engine)
  const set = await routes.post({ action: 'workspace', id: card.id, workspacePath: hw.dir })
  assert.equal(set.status, 200)
  assert.equal(getTask(card.id, { file: hw.file }).workspacePath, hw.dir)

  const cleared = await routes.post({ action: 'workspace', id: card.id, workspacePath: null })
  assert.equal(cleared.status, 200)
  assert.equal(getTask(card.id, { file: hw.file }).workspacePath, null)

  const invalid = await routes.post({ action: 'workspace', id: card.id, workspacePath: '/tmp/s2-no-such-dir-91ac' })
  assert.equal(invalid.status, 400)
  assert.equal(getTask(card.id, { file: hw.file }).workspacePath, null)

  const running = hw.task({ title: '合成：跑着不能改目录', workspacePath: null })
  await routes.post({ action: 'start', id: running.id, cwd: hw.dir })
  await hw.engine.whenIdle()
  const other = path.join(hw.dir, 'other')
  fs.mkdirSync(other)
  const refused = await routes.post({ action: 'workspace', id: running.id, workspacePath: other })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /派工在跑/)
  assert.equal(getTask(running.id, { file: hw.file }).workspacePath, hw.dir)
  routes.dispose()
  hw.cleanup()
}

// F.1.8：pending_accept 少一条、多一张带目录的卡；pending_dismiss 只少一条。
{
  const hw = makeHarness()
  const first = addPending({
    text: '合成：待确认的一句话',
    title: '合成：待确认标题',
    workspacePath: hw.dir,
    by: 'model',
  }, { file: hw.file })
  const second = addPending({ text: '合成：要丢掉的话', workspacePath: hw.dir }, { file: hw.file })
  const routes = routesFor(hw.engine)

  const accepted = await routes.post({ action: 'pending_accept', id: first.id, text: '合成：改过的标题' })
  assert.equal(accepted.status, 200)
  assert.equal(listPending({ file: hw.file }).pending.length, 1)
  const task = getTask(accepted.body.result.task.id, { file: hw.file })
  assert.equal(task.title, '合成：改过的标题')
  assert.equal(task.description, '合成：待确认的一句话')
  assert.equal(task.workspacePath, hw.dir)
  assert.ok(!accepted.body.pending.some(row => row.id === first.id))

  // 面板的「记下」只发 id 和 action；没给 text 时必须沿用原待确认标题。
  const plain = addPending({
    text: '合成：只发 id 也要保留的话',
    title: '合成：原待确认标题',
    workspacePath: hw.dir,
    by: 'model',
  }, { file: hw.file })
  const plainAccepted = await routes.post({ action: 'pending_accept', id: plain.id })
  assert.equal(plainAccepted.status, 200)
  const plainTask = getTask(plainAccepted.body.result.task.id, { file: hw.file })
  assert.equal(plainTask.title, '合成：原待确认标题')
  assert.equal(plainTask.description, '合成：只发 id 也要保留的话')

  const dismissed = await routes.post({ action: 'pending_dismiss', id: second.id })
  assert.equal(dismissed.status, 200)
  assert.equal(listPending({ file: hw.file }).pending.length, 0)
  assert.ok(!dismissed.body.pending.some(row => row.id === second.id))
  routes.dispose()
  hw.cleanup()
}

// F.1.9：queue 把 backlog 变 todo，阶段变 queued；其它状态不能排。
{
  const hw = makeHarness()
  const card = hw.task({ title: '合成：以后再说', status: 'backlog' })
  const routes = routesFor(hw.engine)
  const queued = await routes.post({ action: 'queue', id: card.id })
  assert.equal(queued.status, 200)
  assert.equal(getTask(card.id, { file: hw.file }).status, 'todo')
  assert.equal(hw.stage(card.id).stage, 'queued')

  const again = await routes.post({ action: 'queue', id: card.id })
  assert.equal(again.status, 200, '已经排队的卡再排一次是幂等的')

  const running = hw.task({ title: '合成：进行中不能排队', status: 'in_progress' })
  const refused = await routes.post({ action: 'queue', id: running.id })
  assert.equal(refused.status, 400)
  assert.equal(getTask(running.id, { file: hw.file }).status, 'in_progress')
  routes.dispose()
  hw.cleanup()
}

// 未知动作仍是 400，不会被新动作吞掉。
{
  const hw = makeHarness()
  const card = hw.task()
  const routes = routesFor(hw.engine)
  const unknown = await routes.post({ action: 'nope', id: card.id })
  assert.equal(unknown.status, 400)
  assert.match(unknown.body.error, /未知动作/)
  routes.dispose()
  hw.cleanup()
}

console.log('s2-actions: ok')
