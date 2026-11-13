// S6 A: acceptance evidence, kept free of storage so both the ledger and the
// tools can use the exact same rules. Program checks presence only; it never
// decides whether a note is good enough — that stays with the person reviewing.

import path from 'node:path'

export const MAX_CHECKLIST_ITEMS = 8
export const MAX_CHECKLIST_TEXT = 200
export const MAX_EVIDENCE_FILES = 5
export const MAX_EVIDENCE_PATH = 300
export const MAX_NOTE_TEXT = 400

function clean(value) {
  return String(value ?? '').trim()
}

// A ready report may only move a card when every item is checked, every checked
// item says how it was verified, and the report itself has at least one check.
// Returns human-readable problems; an empty array means the gate is satisfied.
export function readyGateProblems(task, report = {}) {
  const problems = []
  const checklist = Array.isArray(task?.checklist) ? task.checklist : []
  if (!checklist.length) {
    problems.push('没有验收清单')
  } else {
    const unchecked = []
    const unproven = []
    checklist.forEach((item, index) => {
      if (!item || item.checked !== true) unchecked.push(index + 1)
      else if (!clean(item.note)) unproven.push(index + 1)
    })
    if (unchecked.length) problems.push(`第 ${unchecked.join('、')} 项没勾`)
    if (unproven.length) problems.push(`第 ${unproven.join('、')} 项没写怎么验的`)
  }
  const checks = Array.isArray(report?.checks)
    ? report.checks.map(clean).filter(Boolean)
    : []
  if (!checks.length) problems.push('没写 checks（怎么验证的）')
  return problems
}

export function readyGateMessage(task, report = {}) {
  const problems = readyGateProblems(task, report)
  if (!problems.length) return null
  return `还不能交：${problems.join('；')}。卡没有动，补齐后再用 ready 交。`
}

// A2: evidence is a list of paths, at most five, each at most 300 chars.
// Relative paths are read against the card's workspace. Nothing is opened or
// stat'ed: a missing file is the reviewer's problem, not a write failure.
export function normalizeEvidence(task, value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('evidence 必须是路径数组')
  if (value.length > MAX_EVIDENCE_FILES) throw new Error(`证据文件最多 ${MAX_EVIDENCE_FILES} 个`)
  const base = clean(task?.workspacePath)
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new Error(`第 ${index + 1} 个证据必须是路径文字`)
    const text = entry.trim()
    if (!text) throw new Error(`第 ${index + 1} 个证据是空的`)
    if (text.length > MAX_EVIDENCE_PATH) throw new Error(`第 ${index + 1} 个证据超过 ${MAX_EVIDENCE_PATH} 字`)
    if (base && !path.isAbsolute(text)) return path.resolve(base, text)
    return text
  })
}

// A3: checklist input for sa_checklist. Empty items are dropped, over-long
// items are cut at 200 chars, and 1..8 items are required.
export function normalizeChecklistItems(value) {
  if (!Array.isArray(value)) throw new Error('items 必须是数组')
  const items = value.map(clean).filter(Boolean).map(text => text.slice(0, MAX_CHECKLIST_TEXT))
  if (!items.length) throw new Error('验收清单至少 1 条')
  if (items.length > MAX_CHECKLIST_ITEMS) throw new Error(`验收清单最多 ${MAX_CHECKLIST_ITEMS} 条`)
  return items
}
