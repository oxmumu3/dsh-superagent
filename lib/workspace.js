// dsh-superagent workspace — where a card is allowed to run.
//
// The ledger only stores a path; this module is the one place that decides
// whether a path is usable and how a human-readable label is derived. It never
// scans the disk for candidates: the panel only offers directories already
// present on cards, so a random folder cannot become a place to work.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export class WorkspaceError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = 'WORKSPACE'
    this.needWorkspace = Boolean(options.needWorkspace)
  }
}

export function expandHome(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~' + path.sep)) {
    return path.join(os.homedir(), text.slice(2))
  }
  return text
}

function isDirectory(value) {
  try {
    return fs.statSync(value, { throwIfNoEntry: false })?.isDirectory() === true
  } catch {
    return false
  }
}

export function workspaceLabel(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const cleaned = text.replace(/[\\/]+$/, '')
  if (!cleaned) return path.parse(text).root || text
  return path.basename(cleaned) || cleaned
}

// Validate a path a person explicitly chose. Empty is a valid "clear"; callers
// decide whether that is allowed. A non-directory must never be stored.
export function validateWorkspacePath(value) {
  const text = expandHome(value)
  if (!text) return null
  if (!path.isAbsolute(text)) {
    throw new WorkspaceError(`这个目录不是绝对路径：${String(value).trim()}`)
  }
  const normalized = path.normalize(text)
  if (!isDirectory(normalized)) {
    throw new WorkspaceError(`这个目录不存在：${String(value).trim()}`)
  }
  return normalized
}

const EDGE_PUNCT = /^[\s"'（(【「]+|[\s"'）)】」,，。；;：:！!？?、]+$/g
const DELIMITERS = new Set([
  ' ', '\t', '\n', '\r', '"', "'", '（', '(', '【', '「', '）', ')', '】', '」',
  ',', '，', '。', '；', ';', '！', '!', '？', '?', '、',
])

function cleanToken(value) {
  let text = String(value ?? '')
  text = text.replace(EDGE_PUNCT, '')
  // A path typed inside a Chinese sentence often runs into the next word:
  // "/Users/example/Projects里做" must try "/Users/example/Projects" before giving up. Only
  // prefixes ending right before a CJK character are candidates, and the
  // longest existing one wins, so a Chinese directory name still works.
  const candidates = [text]
  for (let index = 1; index < text.length; index += 1) {
    if (/[\u3400-\u9fff]/.test(text[index])) candidates.push(text.slice(0, index))
  }
  return candidates
    .filter((candidate, index, all) => candidate.length > 1 && all.indexOf(candidate) === index)
    .sort((a, b) => b.length - a.length)
}

// The second source of a workspace: a path the user wrote in the sentence.
// It is a bonus, not a requirement; an unknown path simply leaves the card
// without one instead of failing the whole create.
function tokenEnd(value, start) {
  let end = start
  while (end < value.length && !DELIMITERS.has(value[end])) end += 1
  return end
}

export function workspaceFromText(text) {
  const value = String(text ?? '')
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const previous = index > 0 ? value[index - 1] : ''
    // A path may sit directly after a Chinese word: 「请在/Users/example/Projects 整理」.
    // Skip URL schemes and the second slash in a protocol so a link is not
    // mistaken for a local directory.
    const startsPath = char === '/'
      ? previous !== ':' && previous !== '/' && previous !== '~'
      : char === '~' && value[index + 1] === '/'
    if (!startsPath) continue
    const end = tokenEnd(value, index)
    const token = value.slice(index, end)
    for (const candidate of cleanToken(token)) {
      try {
        const resolved = validateWorkspacePath(candidate)
        if (resolved) return resolved
      } catch {
        // Try the next shorter boundary; a missing path is not an error here.
      }
    }
    index = Math.max(index, end - 1)
  }
  return null
}

// S4：按执行路径的规范化比较：展开 ~、path.normalize（会解析 . 和 ..）、保留根。
// 执行会话最终拿到的 cwd 走 validateWorkspacePath 同一套规则；这里不解析
// symlink、不做大小写折叠，也不扫盘。
export function comparePath(value) {
  const expanded = expandHome(String(value ?? '').trim())
  if (!expanded) return ''
  const normalized = path.normalize(expanded)
  if (normalized === path.sep) return path.sep
  const trimmed = normalized.replace(/[\\/]+$/, '')
  return trimmed || path.sep
}

export function overlaps(a, b) {
  const left = comparePath(a)
  const right = comparePath(b)
  if (!left || !right) return false
  if (left === right) return true
  // 用 relative 判断上下级，避免字符串前缀把 / 吃掉，也避免同前缀兄弟误判。
  const inside = (parent, child) => {
    const relative = path.relative(parent, child)
    return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
  }
  return inside(left, right) || inside(right, left)
}

function timeOf(task) {
  return Number(task?.updatedAt ?? task?.createdAt ?? 0) || 0
}

// Candidates come from the ledger, never from a disk scan. Closed cards still
// count: a folder that held yesterday's work is a fine place for today's.
export function listWorkspaces(tasks = [], options = {}) {
  const limit = Number(options.limit) > 0 ? Math.min(Number(options.limit), 8) : 8
  const rows = new Map()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const raw = String(task?.workspacePath ?? '').trim()
    if (!raw) continue
    let normalized
    try {
      normalized = validateWorkspacePath(raw)
    } catch {
      continue
    }
    if (!normalized) continue
    const current = rows.get(normalized)
    if (current) {
      current.count += 1
      current.lastUsedAt = Math.max(current.lastUsedAt, timeOf(task))
    } else {
      rows.set(normalized, {
        path: normalized,
        label: workspaceLabel(normalized),
        lastUsedAt: timeOf(task),
        count: 1,
      })
    }
  }
  return [...rows.values()]
    .sort((a, b) => (b.lastUsedAt - a.lastUsedAt) || a.path.localeCompare(b.path))
    .slice(0, limit)
}
