// 把旧看板并进原生台账的导入脚本。
//
// 默认只预演，不写任何东西；加 --apply 才真正导入。
// 旧看板：~/.dsh/dsh-taskboard.json（taskboard_* 插件）
// 原生台账：~/.dsh/superagent-ledger.json（本插件）
//
// 逐字段搬：描述、执行指令、紧急度、工作区、验收清单（含勾选状态与证据）、
// 留言（含作者与时间）、执行记录与报告、创建/更新时间。
// 状态：待验收保持待验收；进行中改成待办并补一条留言（原生这边没有会话在跑它）。
// 卡号：旧卡号在原生台账里不冲突就沿用，冲突才生成新号。
// 写入只做一次读、一次写；重复导入按 importedFrom.id 跳过。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLedger, writeLedger, ledgerPath } from '../lib/ledger.js'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const OLD = path.join(HOME, 'dsh-taskboard.json')
const NEW = ledgerPath()
const APPLY = process.argv.includes('--apply')
const OUT = path.join(import.meta.dirname ?? '.', '..', 'docs', 'handoff', 's0', 'private', 'b-preflight.md')

const CLOSED = new Set(['done', 'canceled', 'archived'])

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${label} 读不出来：${error instanceof Error ? error.message : String(error)}`)
  }
}

const clone = value => JSON.parse(JSON.stringify(value ?? null))

const oldBoard = readJson(OLD, '旧看板')
const native = fs.existsSync(NEW) ? readLedger(NEW) : { revision: 0, tasks: [], pending: [] }
const oldCards = Array.isArray(oldBoard.tasks) ? oldBoard.tasks : Array.isArray(oldBoard.cards) ? oldBoard.cards : []

const nativeIds = new Set(native.tasks.map(t => t.id))
const importedIds = new Set(native.tasks.map(t => t.importedFrom && t.importedFrom.id).filter(Boolean))

function nextId(existing) {
  let n = 1
  let id = `t-import-${Date.now().toString(36)}-${n}`
  while (existing.has(id)) {
    n += 1
    id = `t-import-${Date.now().toString(36)}-${n}`
  }
  existing.add(id)
  return id
}

function countReports(card) {
  const list = Array.isArray(card.executions) ? card.executions : []
  return list.filter(e => e && e.report).length
}

const rows = []
for (const card of oldCards) {
  if (CLOSED.has(card.status)) continue
  const already = importedIds.has(card.id)
  const idTaken = nativeIds.has(card.id)
  rows.push({
    oldId: card.id,
    title: card.title,
    oldStatus: card.status,
    newStatus: card.status === 'in_review' ? 'in_review' : 'todo',
    idTaken,
    already,
    comments: Array.isArray(card.comments) ? card.comments.length : 0,
    checklist: Array.isArray(card.checklist) ? card.checklist.length : 0,
    reports: countReports(card),
  })
}

const counts = {
  oldTotal: oldCards.length,
  open: rows.length,
  alreadyImported: rows.filter(r => r.already).length,
  idKept: rows.filter(r => !r.already && !r.idTaken).length,
  idRenamed: rows.filter(r => !r.already && r.idTaken).length,
  toCreate: rows.filter(r => !r.already).length,
  comments: rows.filter(r => !r.already).reduce((n, r) => n + r.comments, 0),
  checklist: rows.filter(r => !r.already).reduce((n, r) => n + r.checklist, 0),
  reports: rows.filter(r => !r.already).reduce((n, r) => n + r.reports, 0),
  nativeTotal: native.tasks.length,
}

if (!APPLY) {
  const lines = [
    '# B 预演：旧看板并入原生台账（不入库）',
    '',
    `生成时间：${new Date().toISOString()}`,
    `旧看板：${OLD}`,
    `原生台账：${NEW}`,
    '',
    '| 旧卡号 | 标题 | 旧状态 | 去处 | 留言 | 清单 | 报告 |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(r => {
      const where = r.already
        ? '跳过（已导入过）'
        : r.idTaken
          ? `新建（旧卡号被占，改号）→ ${r.newStatus}`
          : `新建（沿用旧卡号）→ ${r.newStatus}`
      return `| ${r.oldId} | ${r.title} | ${r.oldStatus} | ${where} | ${r.comments} | ${r.checklist} | ${r.reports} |`
    }),
  ]
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, lines.join('\n') + '\n')
  console.log(JSON.stringify({ mode: 'dry-run', counts, detailFile: OUT }, null, 2))
  process.exit(0)
}

// --apply：写之前重新读一次台账。宿主在跑，落卡和队列随时可能写；
// 如果 revision 在我们组装期间变了，就丢掉这次组装、用新状态重来，最多三次。
function applyOnce() {
  const state = fs.existsSync(NEW) ? readLedger(NEW) : { revision: 0, tasks: [], pending: [] }
  const ids = new Set(state.tasks.map(t => t.id))
  const imported = new Set(state.tasks.map(t => t.importedFrom && t.importedFrom.id).filter(Boolean))
  const added = []
  for (const card of oldCards) {
    if (CLOSED.has(card.status)) continue
    if (imported.has(card.id)) continue
    const task = clone(card)
    if (ids.has(card.id)) task.id = nextId(ids)
    else ids.add(card.id)
    task.status = card.status === 'in_review' ? 'in_review' : 'todo'
    task.importedFrom = { board: 'dsh-taskboard', id: card.id }
    task.createdBy = card.createdBy ?? 'import'
    task.updatedBy = 'import'
    if (!Array.isArray(task.comments)) task.comments = []
    if (card.status === 'in_progress') {
      task.comments.push({
        id: `c-import-${Date.now().toString(36)}`,
        body: '旧看板里是进行中，导入时没有对应的会话',
        createdBy: 'import',
        createdAt: Date.now(),
        version: 0,
      })
    }
    state.tasks.push(task)
    added.push({ oldId: card.id, newId: task.id })
  }
  if (added.length === 0) return { created: 0, ok: true, pairs: [] }
  const expectedRev = (state.revision ?? 0) + 1
  state.revision = expectedRev
  writeLedger(state, NEW)
  // 写完再读：如果宿主的写入覆盖了我们，revision 或卡号会对不上，重来。
  const after = readLedger(NEW)
  const ok = (after.revision ?? 0) >= expectedRev && added.every(a => after.tasks.some(t => t.id === a.newId))
  return { created: added.length, ok, pairs: added }
}

let result = { created: 0, ok: true, pairs: [] }
for (let attempt = 0; attempt < 3; attempt += 1) {
  result = applyOnce()
  if (result.ok) break
}
if (result.ok === false) {
  console.error('导入失败：台账在写入期间被其它进程改动，重试三次仍未成功')
  process.exit(1)
}
console.log(JSON.stringify({ mode: 'apply', created: result.created, pairs: result.pairs }, null, 2))
