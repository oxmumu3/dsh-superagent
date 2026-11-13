import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'

// 队列路径读环境变量，所以先把台账指到临时目录，再导入模块。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's0-behavior-'))
process.env.DSH_HOME = dir
process.env.DSH_SUPERAGENT_LEDGER = path.join(dir, 'ledger.json')

const { createTask, getTask } = await import('../lib/ledger.js')
const { applyRequest } = await import('../lib/queue.js')

// A3 行为测试：外部写队列不许把卡移到 done，且卡的状态不能变。
{
  const task = createTask({ title: '测试：队列不许移到 done' })
  const result = applyRequest({ action: 'move', payload: { id: task.id, status: 'done' } })
  assert.equal(result.ok, false, '移到 done 必须失败')
  assert.match(String(result.error), /done 只能由用户/)
  assert.equal(getTask(task.id).status, 'todo', '卡的状态不能变')
}

// 同一路径下合法移动仍然可用（确认拦截的是 done，不是整条队列）。
{
  const task = createTask({ title: '测试：正常移动仍可用' })
  const result = applyRequest({ action: 'move', payload: { id: task.id, status: 'in_progress' } })
  assert.equal(result.ok, true)
  assert.equal(getTask(task.id).status, 'in_progress')
}

// A1 静态检查：index.js 里不许再直接拼「已派工」，必须走 describeDispatch。
{
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /describeDispatch\(run, task\.id\)/)
  assert.doesNotMatch(src, /已派工 \$\{/)
}

fs.rmSync(dir, { recursive: true, force: true })
console.log('s0-behavior: ok')
