// dsh-superagent eval-turn — 一轮结束时的落卡判断（模型在接口后面）。
//
// 输入：这一轮用户说的话、会话目录，以及板上没结束的卡（只给编号和标题）。
// 输出三选一：new / attach（带卡号）/ none；一轮可以出多件事。任何失败都当
// 没有，绝不让一次模型抖动打断会话或凭空建卡。

const SYSTEM = [
  '你在一轮对话结束后判断：用户这一轮说的话里，有没有需要记进待办清单的事。',
  '只输出一行 JSON，不要解释：{"items":[{"kind":"new","title":"动作短语","text":"用户原话"},',
  '{"kind":"attach","taskId":"板上已有卡的编号","title":"补什么","text":"用户原话"}]}',
  '没有要记的就输出 {"items":[]}。',
  '规则：',
  '1. 只有用户说了一件要做的事才算；提问、闲聊、让我解释概念都不算。',
  '2. 如果这件事明显是给板上某张卡补要求，用 attach，taskId 必须是给的编号之一。',
  '3. 一轮可以有多件事；同一件事不要拆成两条。',
  '4. title 用动词开头，不超过 40 字；text 用用户原话。',
].join('\n')

function collectText(chunks) {
  let text = ''
  for (const chunk of chunks) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

function looseJson(raw) {
  const value = String(raw ?? '')
  const match = value.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
  const array = value.match(/\[[\s\S]*\]/)
  if (array) {
    try {
      return { items: JSON.parse(array[0]) }
    } catch {
      return null
    }
  }
  return null
}

export function parseTurnVerdict(raw) {
  const value = looseJson(raw)
  if (!value || !Array.isArray(value.items)) return { items: [] }
  return { items: value.items }
}

export async function judgeTurn(llm, input = {}, options = {}) {
  if (!llm || typeof llm.stream !== 'function') return { items: [] }
  const texts = Array.isArray(input.texts) ? input.texts : []
  const text = String(input.text ?? texts.join('\n')).slice(0, 2000)
  if (!text.trim()) return { items: [] }
  const cards = (Array.isArray(input.cards) ? input.cards : []).slice(0, 50)
  const provider = options.provider || process.env.DSH_SUPERAGENT_PROVIDER || 'deepseek-account'
  const model = options.model || process.env.DSH_SUPERAGENT_MODEL || 'deepseek-flash'
  const timeoutMs = options.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const chunks = []
    const cardLines = cards.map(card => `- ${card.id}：${card.title}`).join('\n') || '（板上没有未结束的卡）'
    for await (const chunk of llm.stream({
      provider,
      model,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: `这一轮用户说的话：\n${text}\n\n会话目录：${input.workspacePath ?? '(未指定)'}\n\n板上没结束的卡：\n${cardLines}`,
        }],
      }],
      temperature: 0,
      maxTokens: 400,
      signal: controller.signal,
    })) {
      chunks.push(chunk)
      if (chunk?.type === 'finish') break
    }
    return parseTurnVerdict(collectText(chunks))
  } catch {
    return { items: [] }
  } finally {
    clearTimeout(timer)
  }
}
