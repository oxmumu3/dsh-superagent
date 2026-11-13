// Run every test file with plain node. Each file is its own process so a
// failure names exactly one area and no test can inherit another's temp env.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  'lib/ledger.test.mjs',
  ...fs.readdirSync(path.join(root, 'test'))
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => path.join('test', name)),
]

const failed = []
for (const file of files) {
  console.log(`\n== ${file}`)
  const result = spawnSync(process.execPath, [path.join(root, file)], {
    cwd: root,
    stdio: 'inherit',
  })
  if (result.status !== 0) failed.push(file)
}

console.log('')
if (failed.length > 0) {
  console.error(`FAILED ${failed.length}/${files.length}: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`PASS ${files.length}/${files.length}`)
