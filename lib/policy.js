// 共享规则：哪些话能说、哪些话不能说。
//
// A1：派工失败必须报失败，不许把「已派工」当成功文案。
// 这里只做判断和文案，不碰宿主服务，方便单测。

/** 把 dispatch()/引擎的结果转成对外文案；失败就抛错，并把原因带出来。 */
export function describeDispatch(run, taskId) {
  if (run && run.ok === true) {
    if (run.deduped) return `这张卡已经在跑：${taskId}（会话 ${run.sessionId ?? '未记录'}）`
    if (run.queued) return `已记下 ${taskId}，正在启动${run.sessionId ? `（会话 ${run.sessionId}）` : ''}`
    return `已派工 ${taskId} → 会话 ${run.sessionId}`
  }
  if (run && typeof run.error === 'string' && run.error.length > 0) {
    throw new Error(`任务没有启动 ${taskId}：${run.error}`)
  }
  const mode = (run && run.mode) || 'unknown'
  const diag = Array.isArray(run && run.diag) && run.diag.length ? run.diag.join(' | ') : '无诊断'
  throw new Error(`派工失败 ${taskId}（mode=${mode}）：${diag}`)
}

// A3：外部写队列和 agent 工具用同一条移动规则。
// done 只有用户能确认，任何自动路径都不许把卡移到 done。
export const AGENT_MOVE_TARGETS = ['todo', 'in_progress', 'in_review', 'canceled', 'archived']

export function assertAgentMayMove(target) {
  if (target === 'done') throw new Error('done 只能由用户在界面上确认，agent 不能移动')
  if (!AGENT_MOVE_TARGETS.includes(target)) throw new Error(`未知目标状态：${target}`)
  return target
}
