import assert from 'node:assert/strict'
import { assertAgentMayMove, AGENT_MOVE_TARGETS } from '../lib/policy.js'

// A3：外部队列和 agent 工具共用一条移动规则，任何自动路径都不许移到 done。
assert.throws(() => assertAgentMayMove('done'), /done 只能由用户/)
assert.throws(() => assertAgentMayMove('随便写'), /未知目标状态/)
for (const status of AGENT_MOVE_TARGETS) assert.equal(assertAgentMayMove(status), status)

// 两处调用点都必须引用同一条规则（静态检查，防止以后被改回去）。
import { readFileSync } from 'node:fs'
for (const file of ['lib/queue.js', 'lib/tools.js']) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  assert.match(src, /assertAgentMayMove/, `${file} 必须使用共享规则`)
}

console.log('s0-a3: ok')
