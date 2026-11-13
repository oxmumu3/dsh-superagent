// dsh-superagent queue — turns external write requests into cards without a model.
//
// External agents (MCP, scripts) append one JSON line per request to
// $DSH_HOME/taskboard-queue/requests.jsonl. The plugin watches that file and
// consumes new lines immediately: no scheduled session, no LLM call, no delay.
// Results are appended to results.jsonl so the caller can poll status.

import fs from 'node:fs'
import path from 'node:path'
import {
  createTask, addComment, moveTask, getTask, addPending, listPending,
  addVent, getVentByRequestId, externalSetChecklist, externalCheckItem,
  reportExecution,
} from './ledger.js'
import { assertAgentMayMove } from './policy.js'

export const QUEUE_DIR = () => path.join(process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh'), 'taskboard-queue')
export const REQUESTS = () => path.join(QUEUE_DIR(), 'requests.jsonl')
export const RESULTS = () => path.join(QUEUE_DIR(), 'results.jsonl')

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

function parse(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function appendResult(result) {
  const file = RESULTS()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(result) + '\n')
}

// Apply one request to the ledger. Returns the result record.
export function applyRequest(request, options = {}) {
  const at = new Date().toISOString()
  const { id, action, payload = {} } = request
  try {
    if (action === 'create') {
      const task = createTask({
        title: payload.title,
        description: payload.description,
        prompt: payload.prompt,
        workspaceId: payload.workspaceId,
        urgency: payload.urgency,
        checklist: payload.checklist,
        by: 'mcp',
      })
      return { id, ok: true, taskId: task.id, action, at }
    }
    if (action === 'comment') {
      const task = addComment(String(payload.id), String(payload.body), { author: 'mcp' })
      // S1：外部写队列进来的留言，也送到正在做这件事的会话。
      try {
        options.onComment?.(task, String(payload.body ?? ''))
      } catch {
        // 送不到不影响落卡；留言已在台账里。
      }
      return { id, ok: true, taskId: task.id, action, at }
    }
    if (action === 'move') {
      const current = getTask(String(payload.id))
      assertAgentMayMove(String(payload.status))
      const task = moveTask(String(payload.id), String(payload.status), { ifVersion: current.version })
      return { id, ok: true, taskId: task.id, action, at }
    }
    if (action === 'checklist') {
      const updated = externalSetChecklist(String(payload.id), payload.items, {
        requestId: id, ifVersion: payload.ifVersion,
      })
      return { id, ok: true, taskId: updated.id, items: updated.checklist.length, duplicate: Boolean(updated.mcpRequests?.[id]), action, at }
    }
    if (action === 'check') {
      const current = getTask(String(payload.id))
      let itemId = String(payload.itemId ?? '').trim()
      if (!itemId && Number.isInteger(payload.index)) itemId = String(current.checklist?.[payload.index]?.id ?? '')
      if (!itemId) return { id, ok: false, error: 'check 需要 itemId 或 index', action, at }
      const updated = externalCheckItem(String(payload.id), itemId, {
        requestId: id, ifVersion: payload.ifVersion, note: payload.note, evidence: payload.evidence,
      })
      return { id, ok: true, taskId: updated.id, itemId, duplicate: Boolean(updated.mcpRequests?.[id]), action, at }
    }
    if (action === 'report') {
      const updated = reportExecution(String(payload.id), payload, {
        ...(payload.ifVersion === undefined ? {} : { ifVersion: payload.ifVersion }),
        external: true, requestId: id, by: 'mcp',
      })
      return { id, ok: true, taskId: updated.id, status: updated.status, duplicate: Boolean(updated.mcpRequests?.[id]), action, at }
    }
    // C：外部队列恢复普通 pending。同一请求 id 重放时返回原来的那一行，
    // 不因为宿主重开或结果写入失败而产生第二份。
    if (action === 'pending') {
      const text = String(payload.text ?? '').trim()
      if (!text) return { id, ok: false, error: 'pending 需要 text', action, at }
      if (text.startsWith('[Vent]')) {
        const ventText = text.slice('[Vent]'.length).trim()
        if (!ventText) return { id, ok: false, error: '吐槽不能是空的', action, at }
        const existing = getVentByRequestId(id)
        if (existing) return { id, ok: true, ventId: existing.id, duplicate: true, action, at }
        const vent = addVent({
          text: ventText,
          workspacePath: payload.workspacePath ?? null,
          taskId: payload.taskId ?? null,
          by: 'mcp',
          requestId: id,
        })
        return { id, ok: true, ventId: vent.id, action, at }
      }
      const prior = listPending().pending.find(row => row.requestId === id)
      if (prior) return { id, ok: true, pendingId: prior.id, duplicate: true, action, at }
      const row = addPending({
        text,
        title: payload.title,
        sessionId: payload.sessionId,
        workspaceId: payload.workspaceId,
        workspacePath: payload.workspacePath,
        suggestedTaskId: payload.suggestedTaskId,
        by: 'mcp',
        requestId: id,
      })
      return { id, ok: true, pendingId: row.id, action, at }
    }
    return { id, ok: false, error: `unknown action: ${action}`, action, at }
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : String(error), action, at }
  }
}

// Consume every request not present in results.jsonl. Returns applied records.
export function consumeQueue(options = {}) {
  const requests = readLines(REQUESTS()).map(parse).filter(Boolean)
  if (!requests.length) return []
  const done = new Set(readLines(RESULTS()).map(parse)
    .filter(r => r && (r.ok || ['checklist', 'check', 'report'].includes(r.action)))
    .map(r => r.id))
  const applied = []
  for (const request of requests) {
    if (done.has(request.id)) continue
    const result = applyRequest(request, options)
    appendResult(result)
    applied.push(result)
  }
  return applied
}

// Watch the queue directory; calls onApplied(results) after each batch.
export function watchQueue(onApplied, options = {}) {
  const dir = QUEUE_DIR()
  fs.mkdirSync(dir, { recursive: true })
  // Consume anything that arrived while the host was down.
  const initial = consumeQueue(options)
  if (initial.length) onApplied(initial)
  let timer
  const watcher = fs.watch(dir, (_event, file) => {
    if (file && file !== 'requests.jsonl') return
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        const applied = consumeQueue(options)
        if (applied.length) onApplied(applied)
      } catch {
        // A malformed queue line must never break the watcher.
      }
    }, 50)
  })
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
