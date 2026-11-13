// dsh-superagent eval — the slow path of the two-level filter.
//
// Called only when the rule fast path cannot decide. One tiny LLM call, strict
// JSON output, hard timeout and a fail-closed default: any error returns
// { isTask: false } so a flaky model can never invent cards or block a turn.
//
// The plugin owns this call. It does not depend on whichever agent session is
// running — that is the difference between system-level capture and a model
// "remembering" to call a tool.

const SYSTEM = [
  '你是任务分拣器。判断用户这句话里是否包含一个需要跟踪的待办事项。',
  '只有在「用户在说一件要做的事」时才算；单纯提问、闲聊、让我解释概念都不算。',
  '只输出一行 JSON，不要解释：{"isTask":true|false,"title":"不超过 40 字的动作短语"}',
  'title 用动词开头，去掉「我想」「可能」「回头」这类模糊词。',
].join('\n')

function collectText(chunks) {
  let text = ''
  for (const chunk of chunks) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

function parseVerdict(raw) {
  const match = String(raw).match(/\{[\s\S]*\}/)
  if (!match) return { isTask: false }
  try {
    const value = JSON.parse(match[0])
    const isTask = value?.isTask === true
    const title = typeof value?.title === 'string' ? value.title.trim().slice(0, 80) : ''
    return isTask && title ? { isTask: true, title } : { isTask: false }
  } catch {
    return { isTask: false }
  }
}

export async function judge(llm, text, options = {}) {
  if (!llm || typeof llm.stream !== 'function') return { isTask: false, reason: 'llm-unavailable' }
  const provider = options.provider || process.env.DSH_SUPERAGENT_PROVIDER || 'deepseek-account'
  const model = options.model || process.env.DSH_SUPERAGENT_MODEL || 'deepseek-flash'
  const timeoutMs = options.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const chunks = []
    for await (const chunk of llm.stream({
      provider,
      model,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(text).slice(0, 1200) }] }],
      temperature: 0,
      maxTokens: 120,
      signal: controller.signal,
    })) {
      chunks.push(chunk)
      if (chunk?.type === 'finish') break
    }
    return parseVerdict(collectText(chunks))
  } catch (error) {
    return { isTask: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
