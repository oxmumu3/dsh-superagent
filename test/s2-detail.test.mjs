import assert from 'node:assert/strict'
import { makeLedger } from './support/s2-fixtures.mjs'
import { addComment } from '../lib/ledger.js'
import { registerCardRoute } from '../lib/route.js'

// F.1.10：GET /api/superagent/card 带回描述、清单、留言、报告和派工；不存在是 404。
{
  const fx = makeLedger()
  const card = fx.card('S2 合成：详情抽屉', { checklist: ['核对结果', '核对记录'] })
  const run = fx.dispatch(card)
  fx.report(card, run, {
    outcome: 'ready',
    summary: '合成报告摘要',
    changedFiles: ['lib/example.js'],
    checks: ['npm test'],
    risk: '合成风险',
  })
  addComment(card.id, '用户的合成留言', { file: fx.file, author: 'user' })

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
  const dispose = registerCardRoute(ctx, { engine: { ledgerOptions: () => ({ file: fx.file }) } })
  assert.ok(routes.has('/api/superagent/card'))

  const route = routes.get('/api/superagent/card')
  const response = await route.fetch(new Request(`http://localhost/api/superagent/card?id=${encodeURIComponent(card.id)}`))
  assert.equal(response.status, 200)
  const body = await response.json()
  const detail = body.card
  assert.equal(detail.id, card.id)
  assert.equal(detail.title, 'S2 合成：详情抽屉')
  assert.equal(detail.description, 'S2 合成：详情抽屉')
  assert.deepEqual(detail.checklist.map(item => item.text), ['核对结果', '核对记录'])
  assert.equal(detail.comments.length, 1)
  assert.equal(detail.comments[0].author, 'user')
  assert.equal(detail.comments[0].body, '用户的合成留言')
  assert.equal(detail.executions.length, 1)
  assert.equal(detail.executions[0].outcome, 'ready')
  assert.equal(detail.executions[0].summary, '合成报告摘要')
  assert.deepEqual(detail.executions[0].changedFiles, ['lib/example.js'])
  assert.equal(detail.assignments.length, 1)
  assert.equal(detail.assignments[0].sessionId, run.sessionId)
  assert.equal(detail.assignments[0].lastTurn, null)
  assert.equal(detail.stage, 'review')
  assert.equal(detail.actions[0].action, 'accept')

  const missing = await route.fetch(new Request('http://localhost/api/superagent/card?id=does-not-exist'))
  assert.equal(missing.status, 404)
  assert.match((await missing.json()).error, /卡片不存在/)

  const noId = await route.fetch(new Request('http://localhost/api/superagent/card'))
  assert.equal(noId.status, 400)
  dispose()
  assert.equal(routes.size, 0)
  fx.cleanup()
}

console.log('s2-detail: ok')
