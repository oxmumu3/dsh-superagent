const { strict: assert } = require('node:assert')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { runInNewContext } = require('node:vm')

const directory = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '..')
const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@oxmumu3/dsh-superagent', 'use the scoped Super Agent package name')
const source = readFileSync(join(directory, manifest.exports['./client']), 'utf8')
const factory = []
runInNewContext(source, { window: { __ModuleLoader__: { load: row => factory.push(row) } } })
assert.equal(factory.length, 1, 'one client factory per entry')
assert.equal(factory[0].id, manifest.name, 'the factory ID must match the package ID exactly')
const plugin = factory[0].factory(name => {
  assert.equal(name, 'react')
  return {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useEffect: () => {},
    useRef: value => ({ current: value }),
  }
})
assert.ok(plugin.inject.includes('slots'), 'wait for the host slot service')
const mounted = new Map()
const dispose = []
plugin.apply({
  effect(setup) { dispose.push(setup()) },
  slots: {
    inject(name, register) {
      const remove = register()
      assert.equal(typeof remove, 'function')
      return remove
    },
    register(options, Component) {
      assert.equal(mounted.has(options.name), false)
      mounted.set(options.name, { options, Component })
      return () => mounted.delete(options.name)
    },
  },
})
const icon = mounted.get('sidebar.panellist')
const panel = mounted.get('main')
const quick = mounted.get('sidebar.session.action')
assert.equal(icon.options.id, panel.options.key, 'sidebar entry must open its own panel')
assert.equal(quick.options.id, 'superagent-quick-capture', 'sidebar quick capture action registered cleanly')
assert.ok(icon.Component({ active: false, size: 18 }))
assert.ok(panel.Component())
const quickTree = quick.Component({ children: 'NEW', wide: true })
assert.equal(quickTree.type, 'Fragment', 'sidebar.session.action must return Fragment without wrapper div')
assert.equal(quickTree.children[0], 'NEW')
for (const cleanup of dispose.reverse()) cleanup()
assert.equal(mounted.size, 0, 'plugin teardown removes its slots')
console.log('Scoped bundle registration and slot lifecycle OK')
