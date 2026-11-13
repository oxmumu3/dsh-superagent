// S6 C: the friction box. Vents are ledger rows only: they never become a card
// on their own, never enter a panel group and never trigger a notification.

import crypto from 'node:crypto'
import { sanitizeText } from './sanitize.js'

export const MAX_VENTS = 200
export const MAX_VENT_TEXT = 200
export const VENT_VIEW_LIMIT = 50

function clean(value) {
  return String(value ?? '').trim()
}

function newVentId() {
  return `v-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

export function appendVent(ledger, input = {}, at = Date.now()) {
  const text = sanitizeText(clean(input.text)).slice(0, MAX_VENT_TEXT)
  if (!text) throw new Error('吐槽不能是空的')
  if (!Array.isArray(ledger.vents)) ledger.vents = []
  const row = {
    id: newVentId(),
    text,
    at,
    taskId: input.taskId ?? null,
    workspacePath: input.workspacePath ?? null,
    by: clean(input.by) || 'unknown',
    ...(input.requestId ? { requestId: String(input.requestId) } : {}),
  }
  ledger.vents.push(row)
  if (ledger.vents.length > MAX_VENTS) ledger.vents = ledger.vents.slice(-MAX_VENTS)
  return row
}

export function ventRows(ledger) {
  return Array.isArray(ledger?.vents) ? ledger.vents : []
}

export function findVent(ledger, id) {
  const key = clean(id)
  if (!key) return null
  return ventRows(ledger).find(row => row?.id === key) ?? null
}

export function findVentByRequestId(ledger, requestId) {
  const key = clean(requestId)
  if (!key) return null
  return ventRows(ledger).find(row => row?.requestId === key) ?? null
}

export function removeVent(ledger, id) {
  const key = clean(id)
  if (!key) return null
  const rows = ventRows(ledger)
  const index = rows.findIndex(row => row?.id === key)
  if (index < 0) return null
  const [row] = rows.splice(index, 1)
  ledger.vents = rows
  return row
}

// Latest first; the panel only ever renders the newest 50.
export function ventsSnapshot(ledger, limit = VENT_VIEW_LIMIT) {
  const rows = ventRows(ledger)
    .slice()
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return {
    count: rows.length,
    items: rows.slice(0, Math.max(0, Math.min(Number(limit) || VENT_VIEW_LIMIT, VENT_VIEW_LIMIT))),
  }
}
