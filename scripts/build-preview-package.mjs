// Build the preview archive from the package.json `files` whitelist.
//
// Deterministic on purpose: fixed mtime/uid/gid/order, gzip without a timestamp.
// Running it twice on the same source must produce one SHA-256. The archive is
// npm-shaped (`package/` root) and carries no tests, docs, handoff, screenshots
// or user state.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const MTIME = 1_794_528_000 // fixed 2026-11-13T00:00:00Z
const MODE = 0o644

function fail(message) {
  console.error(`build-preview: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  let out = path.join(root, 'dist')
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      out = path.resolve(argv[index + 1] ?? '')
      index += 1
    } else {
      fail(`unknown argument: ${argv[index]}`)
    }
  }
  return { out }
}

function expand(pattern) {
  if (!pattern.endsWith('/')) return [pattern]
  const base = pattern.slice(0, -1)
  const found = []
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (entry.isFile()) found.push(next)
    }
  }
  walk(base)
  return found
}

function listPackageFiles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const declared = Array.isArray(manifest.files) ? manifest.files : []
  if (declared.length === 0) fail('package.json has no files whitelist')
  const names = new Set(['package.json'])
  for (const pattern of declared) {
    for (const name of expand(pattern)) names.add(name)
  }
  const sorted = [...names].sort()
  for (const name of sorted) {
    if (name.startsWith('/') || name.includes('..')) fail(`unsafe path in whitelist: ${name}`)
    if (!fs.existsSync(path.join(root, name))) fail(`missing whitelist file: ${name}`)
    if (fs.statSync(path.join(root, name)).isDirectory()) fail(`directory in whitelist: ${name}`)
  }
  return { manifest, names: sorted }
}

function header(name, size) {
  if (Buffer.byteLength(name) > 100) fail(`path too long for ustar: ${name}`)
  const block = Buffer.alloc(512, 0)
  block.write(name, 0, 100, 'utf8')
  block.write(MODE.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii')
  block.write('0000000\0', 108, 8, 'ascii')
  block.write('0000000\0', 116, 8, 'ascii')
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii')
  block.write(MTIME.toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write('0', 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write('\0', 329, 1, 'ascii')
  block.write('\0', 337, 1, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
  return block
}

function tar(files) {
  const chunks = []
  for (const { name, body } of files) {
    chunks.push(header(`package/${name}`, body.length))
    chunks.push(body)
    const pad = (512 - (body.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(chunks)
}

function digest(body) {
  return crypto.createHash('sha256').update(body).digest('hex')
}

const { out } = parseArgs(process.argv.slice(2))
const { manifest, names } = listPackageFiles()
const rootReal = fs.realpathSync(root)
if (out === rootReal || rootReal.startsWith(out + path.sep)) fail('refuse to write over the source tree')
if (fs.existsSync(out)) {
  const stat = fs.lstatSync(out)
  if (stat.isSymbolicLink()) fail('refuse to follow a symlink for --out')
  if (!stat.isDirectory()) fail('--out exists and is not a directory')
  if (fs.readdirSync(out).length > 0) fail('--out already has files; use a new empty directory')
} else {
  fs.mkdirSync(out, { recursive: false })
}
if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(manifest.version)) fail(`unexpected version: ${manifest.version}`)
if (manifest.private !== false) fail('package.json still private')
if (manifest.license !== 'MIT') fail('license must be MIT')

const files = names.map(name => ({ name, body: fs.readFileSync(path.join(root, name)) }))
const archive = zlib.gzipSync(tar(files), { level: 9 })
const archiveName = `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`
fs.writeFileSync(path.join(out, archiveName), archive)

const fileList = files.map(({ name, body }) => ({ path: name, bytes: body.length, sha256: digest(body) }))
fs.writeFileSync(path.join(out, 'FILES.json'), JSON.stringify({
  package: manifest.name,
  version: manifest.version,
  archive: archiveName,
  archiveSha256: digest(archive),
  files: fileList,
}, null, 2) + '\n')
fs.writeFileSync(path.join(out, 'SHA256SUMS'), fileList.map(row => `${row.sha256}  ${row.path}`).join('\n') + '\n')

console.log(JSON.stringify({
  package: manifest.name,
  version: manifest.version,
  archive: path.join(out, archiveName),
  archiveSha256: digest(archive),
  bytes: archive.length,
  files: fileList.length,
  clientSha256: digest(files.find(row => row.name === 'client.js').body),
}, null, 2))
