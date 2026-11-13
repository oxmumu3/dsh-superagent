// Write the CI build receipt that binds one archive to one commit.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const dir = path.resolve(process.argv[2] ?? 'dist')
const sha = text => crypto.createHash('sha256').update(text).digest('hex')
const tgz = fs.readdirSync(dir).find(name => name.endsWith('.tgz'))
if (!tgz) throw new Error(`no .tgz in ${dir}`)
const archive = fs.readFileSync(path.join(dir, tgz))
const tar = zlib.gunzipSync(archive)
const files = JSON.parse(fs.readFileSync(path.join(dir, 'FILES.json'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const commit = process.env.GITHUB_SHA ?? process.env.BUILD_COMMIT
if (!commit) throw new Error('GITHUB_SHA or BUILD_COMMIT is required')
const receipt = {
  package: manifest.name,
  version: manifest.version,
  host: manifest.engines?.dsh ?? null,
  repository: typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url ?? null,
  commit,
  archive: tgz,
  archiveSha256: sha(archive),
  tarSha256: sha(tar),
  bytes: archive.length,
  files: files.files.length,
  clientSha256: files.files.find(row => row.path === 'client.js')?.sha256 ?? null,
}
fs.writeFileSync(path.join(dir, 'BUILD.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt, null, 2))
