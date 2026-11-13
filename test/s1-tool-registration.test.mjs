import assert from 'node:assert/strict'
import { installToolRegistration } from '../index.js'

// 0.2.2 在 apply 之后才挂 tools；这里模拟晚注入、重复注入和卸载后重挂。
const makeRegistry = () => {
  const names = new Set()
  return {
    names,
    register(definition) {
      names.add(definition.name)
      return () => names.delete(definition.name)
    },
  }
}

let injector = null
const logs = []
const ctx = {
  inject(names, callback) {
    assert.deepEqual(names, ['tools'])
    injector = callback
  },
}

const dispose = installToolRegistration(ctx, {}, message => logs.push(message))
assert.equal(typeof injector, 'function')

// 服务还没就绪：不注册、不抛错，等下一次注入。
assert.equal(injector(null), undefined)
assert.match(logs.at(-1), /service missing/)

// 服务就绪后注册全部工具，包含执行会话回报用的 sa_report。
const first = makeRegistry()
const off = injector({ tools: first })
assert.equal(typeof off, 'function')
for (const name of ['sa_list', 'sa_get', 'sa_create', 'sa_move', 'sa_comment', 'sa_report', 'sa_check', 'sa_checklist', 'sa_depend', 'sa_decide', 'sa_dispatch']) {
  assert.ok(first.names.has(name), `应注册 ${name}`)
}
assert.equal(first.names.size, 11)

// 没有卸载前再次注入：忽略，避免同名工具重复。
const second = makeRegistry()
injector({ tools: second })
assert.equal(second.names.size, 0)
assert.equal(first.names.size, 11)
assert.match(logs.at(-1), /skip duplicate/)

// 卸载后注销干净，再次挂载能重新注册。
off()
assert.equal(first.names.size, 0)
injector({ tools: second })
assert.equal(second.names.size, 11)

// 插件整体卸载也要能收口（幂等）。
dispose()
assert.equal(second.names.size, 0)
dispose()
assert.equal(second.names.size, 0)

console.log('s1-tool-registration: ok')
