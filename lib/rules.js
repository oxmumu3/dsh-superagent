// S6 B: project acceptance rules.
//
// Rules live in the ledger, never in the user's project directory. A rule is
// keyed by the normalized workspace path and inherited by descendant
// directories (nearest first). Text is exact-matched inside one directory:
// saving the same sentence twice is a no-op, not a duplicate row.

import crypto from 'node:crypto'
import path from 'node:path'
import { comparePath } from './workspace.js'

export const MAX_RULES_PER_DIR = 20
export const MAX_RULE_TEXT = 200

function clean(value) {
  return String(value ?? '').trim()
}

function newRuleId() {
  return `r-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

// The only accepted key is a defined, absolute, lexically-normalized directory.
// Symlinks are not resolved and the disk is never scanned.
export function ruleKeyForPath(value) {
  const key = comparePath(value)
  return key && path.isAbsolute(key) ? key : ''
}

export function ruleAncestorKeys(key) {
  const normalized = ruleKeyForPath(key)
  if (!normalized) return []
  const keys = []
  let current = normalized
  while (current) {
    keys.push(current)
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return keys
}

function rowsOf(ledger, key) {
  const groups = ledger?.acceptanceRules
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return []
  return Array.isArray(groups[key]) ? groups[key] : []
}

// Nearest directory first. Identical text inherited from more than one
// ancestor is shown once (the nearest copy wins).
export function rulesForPath(ledger, workspacePath) {
  const rows = []
  const seen = new Set()
  for (const key of ruleAncestorKeys(workspacePath)) {
    for (const rule of rowsOf(ledger, key)) {
      const text = clean(rule?.text)
      if (!text || seen.has(text)) continue
      seen.add(text)
      rows.push({
        id: String(rule.id ?? ''),
        text,
        at: Number.isFinite(rule.at) ? rule.at : 0,
        fromTaskId: rule.fromTaskId ?? null,
        workspacePath: key,
      })
    }
  }
  return rows
}

// Prompt block. Empty rules mean the whole block disappears (no empty heading).
export function rulesPromptSection(rules) {
  const rows = Array.isArray(rules) ? rules.filter(rule => clean(rule?.text)) : []
  if (!rows.length) return ''
  return [
    '',
    '## 这个项目以前被打回过的原因',
    '交活前逐条自查，别重复：',
    ...rows.map(rule => `- ${clean(rule.text)}`),
  ].join('\n')
}

// Validate and append one rule inside the caller's ledger object. Returns the
// stored row (or the existing identical row). Throws before mutating anything
// when the directory is missing, the text is too long, or the list is full, so
// a rejected save can share one transaction with the action that triggered it.
export function prepareRule(ledger, task, text, at = Date.now()) {
  const key = ruleKeyForPath(task?.workspacePath)
  if (!key) throw new Error('这张卡没有项目目录，先给卡定目录再存规矩')
  const value = clean(text)
  if (!value) throw new Error('规矩不能是空的')
  if (value.length > MAX_RULE_TEXT) {
    throw new Error(`规矩最多 ${MAX_RULE_TEXT} 字，这条没有保存`)
  }
  if (!ledger.acceptanceRules || typeof ledger.acceptanceRules !== 'object' || Array.isArray(ledger.acceptanceRules)) {
    ledger.acceptanceRules = {}
  }
  const rows = Array.isArray(ledger.acceptanceRules[key]) ? ledger.acceptanceRules[key] : []
  const existing = rows.find(rule => clean(rule?.text) === value)
  if (existing) return { rule: existing, duplicate: true, workspacePath: key }
  if (rows.length >= MAX_RULES_PER_DIR) {
    throw new Error(`这个目录的规矩已经 ${MAX_RULES_PER_DIR} 条，先删一条再存`)
  }
  const rule = {
    id: newRuleId(),
    text: value,
    at,
    fromTaskId: task?.id ?? null,
  }
  ledger.acceptanceRules[key] = [...rows, rule]
  return { rule, duplicate: false, workspacePath: key }
}

export function findRule(ledger, ruleId) {
  const id = clean(ruleId)
  if (!id) return null
  const groups = ledger?.acceptanceRules
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return null
  for (const [workspacePath, rows] of Object.entries(groups)) {
    if (!Array.isArray(rows)) continue
    const rule = rows.find(row => row?.id === id)
    if (rule) return { rule, workspacePath }
  }
  return null
}

export function removeRule(ledger, ruleId) {
  const found = findRule(ledger, ruleId)
  if (!found) return null
  const rows = ledger.acceptanceRules[found.workspacePath]
  ledger.acceptanceRules[found.workspacePath] = rows.filter(row => row?.id !== found.rule.id)
  if (!ledger.acceptanceRules[found.workspacePath].length) delete ledger.acceptanceRules[found.workspacePath]
  return found
}

// Flat, panel-friendly snapshot: every rule with its directory attached.
export function rulesSnapshot(ledger) {
  const groups = ledger?.acceptanceRules
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) return []
  const rows = []
  for (const [workspacePath, items] of Object.entries(groups)) {
    if (!Array.isArray(items)) continue
    for (const rule of items) {
      const text = clean(rule?.text)
      if (!text) continue
      rows.push({
        id: String(rule.id ?? ''),
        text,
        at: Number.isFinite(rule.at) ? rule.at : 0,
        fromTaskId: rule.fromTaskId ?? null,
        workspacePath,
      })
    }
  }
  return rows
}
