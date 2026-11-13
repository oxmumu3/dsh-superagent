// dsh-superagent patrol — the program fast path of the coordinator.
//
// Runs deterministic checks over the ledger every few minutes and returns only
// findings. It never calls a model and never writes: the caller decides whether
// a finding deserves a notification or a model pass. This is the two-level
// filter the design asks for — code first, model only on a hit.

import { listTasks } from './ledger.js'

const MINUTE = 60_000

export const RULES = {
  staleInProgressMs: 4 * 60 * MINUTE,
  urgentTodoMs: 24 * 60 * MINUTE,
}

export function patrol(now = Date.now(), options = {}) {
  const r = { ...RULES, ...options.rules }
  const all = listTasks({ includeArchived: true }, options).tasks
  const live = all.filter(t => !['done', 'canceled', 'archived'].includes(t.status))
  const findings = []

  for (const t of live) {
    if (t.status === 'in_progress' && now - (t.updatedAt ?? 0) > r.staleInProgressMs) {
      findings.push({
        kind: 'stale',
        taskId: t.id,
        title: t.title,
        message: `「${t.title}」在推进中超过 ${Math.round((now - t.updatedAt) / MINUTE)} 分钟没动静`,
      })
    }
    if (t.status === 'todo' && t.urgency === 'urgent' && now - (t.createdAt ?? 0) > r.urgentTodoMs) {
      findings.push({
        kind: 'urgent_waiting',
        taskId: t.id,
        title: t.title,
        message: `紧急任务「${t.title}」还没开始，已经放了 ${Math.round((now - t.createdAt) / 60 / MINUTE)} 小时`,
      })
    }
    if (t.status === 'in_review') {
      const last = t.comments?.[t.comments.length - 1]
      if (last && last.author !== 'agent' && now - (last.at ?? 0) > r.staleInProgressMs) {
        findings.push({
          kind: 'waiting_reply',
          taskId: t.id,
          title: t.title,
          message: `「${t.title}」在待验收，最后一条是用户留言，还没人处理`,
        })
      }
    }
  }

  return {
    scanned: live.length,
    counts: {
      todo: live.filter(t => t.status === 'todo').length,
      in_progress: live.filter(t => t.status === 'in_progress').length,
      in_review: live.filter(t => t.status === 'in_review').length,
    },
    findings,
  }
}
