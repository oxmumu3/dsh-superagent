import assert from 'node:assert/strict'
import { describeDispatch } from '../lib/policy.js'

// A1：派工失败必须报失败，并把 diag 带出来。
{
  const run = { ok: false, mode: 'inject', sessionId: 's-x', diag: ['A seed failed: boom', 'B push: inject called'] }
  assert.throws(() => describeDispatch(run, 't-1'), err => {
    assert.match(err.message, /^派工失败 t-1/)
    assert.match(err.message, /mode=inject/)
    assert.match(err.message, /A seed failed: boom/)
    return true
  })
}

// 成功时保持原文案不变。
{
  const run = { ok: true, mode: 'followup', sessionId: 's-ok', diag: [] }
  assert.equal(describeDispatch(run, 't-2'), '已派工 t-2 → 会话 s-ok')
}

// 没有 diag 也不能把异常吞掉。
{
  assert.throws(() => describeDispatch(undefined, 't-3'), /无诊断/)
}

console.log('s0-a1: ok')
