// dsh-superagent tools — the agent-facing tools over the native ledger.
//
// Contract source: Host Service "tools".register(definition, options); a
// ToolDefinition is ToolSchema (name/description/parameters) plus
// output { schema, render(args, value) } and execute(args, exec).
// The render() result is what the model reads — so it must carry the facts an
// agent needs (ids, versions, statuses), not a terse UI summary.
//
// S1: sa_report carries an outcome and an optional question, and the plugin
// moves the card itself. sa_comment also delivers the comment to the live
// executor. sa_dispatch lives in index.js because it needs the engine/host
// adapter; keeping it there also keeps the old S0 regression contract.

import {
  createTask, listTasks, getTask, moveTask, addComment,
  reportExecution, checkItem,
} from './ledger.js'
import { assertAgentMayMove } from './policy.js'

const text = value => [{ type: 'text', text: String(value) }]

const str = description => ({ type: 'string', description })
const num = description => ({ type: 'number', description })
const bool = description => ({ type: 'boolean', description })

function summarise(t) {
  const bits = [
    t.id,
    `[${t.status}]`,
    `(${t.urgency})`,
    `「${t.title}」`,
    t.comments?.length ? `评论${t.comments.length}` : '',
    t.checklist?.length ? `清单${t.checklist.filter(k => k.checked).length}/${t.checklist.length}` : '',
    t.blocked ? '受阻' : '',
  ]
  return bits.filter(Boolean).join(' ')
}

// 执行会话的身份字段还没有在 0.2.2 上实测；这里只认常见位置，取不到就
// 退回原来的「按当前派工记」行为，不拿工具调用 id 冒充会话。
function sessionIdOfExec(exec) {
  const candidates = [
    exec?.sessionId,
    exec?.agentId,
    exec?.agent?.id,
    exec?.session?.header?.id,
    exec?.session?.id,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function reportLine(t, report) {
  const last = t.executions[t.executions.length - 1]
  const outcome = last?.outcome ?? report?.outcome ?? 'ready'
  const bits = [`已提交报告 ${t.id}：${outcome}，执行记录 ${t.executions.length} 条，v${t.version}`]
  if (outcome === 'ready' || outcome === 'dropped') bits.push(`卡的状态：${t.status}`)
  if (t.openQuestion) bits.push(`问题已记下：${t.openQuestion.text}`)
  return bits.join('\n')
}

export function createToolDefinitions(engine) {
  return [
    {
      name: 'sa_list',
      description: '列出 Super Agent 台账上的任务（原生台账，不是旧看板）。可按状态、项目过滤。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: str('todo / in_progress / in_review / done / canceled / archived'),
          workspaceId: str('按项目过滤'),
          includeArchived: bool('是否包含已归档与已取消'),
          limit: num('最多返回多少条，默认 50'),
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      execute: async args => {
        // 不传条数时默认 50：给模型看的输出有上限，巡检和面板才读全量。
        const r = listTasks({ ...(args || {}), limit: Number(args?.limit) || 50 })
        const head = `任务 ${r.total} 条（台账 rev ${r.revision}）`
        const lines = r.tasks.map(t => `- ${summarise(t)}`)
        return [head, ...lines].join('\n')
      },
    },
    {
      name: 'sa_get',
      description: '读一张卡的完整内容：描述、验收清单、评论、执行记录、派工与待回答的问题。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: str('任务 id') },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      execute: async args => {
        const t = getTask(String(args?.id ?? ''))
        const out = [
          `# ${t.title}`,
          `- id: ${t.id}`,
          `- 状态: ${t.status}${t.blocked ? '（受阻）' : ''}`,
          `- 紧急度: ${t.urgency} · 版本: ${t.version}`,
          `- 项目: ${t.workspaceId ?? '(未指定)'}`,
          `- 工作目录: ${t.workspacePath ?? '(未指定)'}`,
          `- 更新: ${new Date(t.updatedAt).toLocaleString('sv-SE')}`,
        ]
        if (t.openQuestion) {
          out.push(`- 等你回答: ${t.openQuestion.text}`)
          for (const option of t.openQuestion.options ?? []) out.push(`  - ${option}`)
        }
        const current = (t.assignments ?? []).filter(a => a && a.state !== 'ended').pop()
        if (current) {
          out.push(`- 当前派工: ${current.id} · 会话 ${current.sessionId ?? '(未记录)'} · ${current.state}`)
          if (current.lastTurn) {
            out.push(`- 上一轮: ${current.lastTurn.endKind}${current.lastTurn.detail ? `（${current.lastTurn.detail}）` : ''}`)
          }
          if (current.lastReport) out.push(`- 最近报告: ${current.lastReport.outcome}`)
        }
        if (t.description) out.push('', '## 描述', t.description)
        if (t.checklist?.length) {
          out.push('', '## 验收清单')
          for (const k of t.checklist) out.push(`- [${k.checked ? 'x' : ' '}] ${k.text}${k.note ? ` · ${k.note}` : ''}`)
        }
        if (t.comments?.length) {
          out.push('', '## 评论')
          for (const c of t.comments) out.push(`- [${new Date(c.at).toLocaleString('sv-SE')} ${c.author}] ${c.body}`)
        }
        if (t.executions?.length) {
          out.push('', '## 执行记录')
          for (const e of t.executions) {
            out.push(`- [${new Date(e.at).toLocaleString('sv-SE')} ${e.outcome ?? e.state ?? 'ready'}] ${e.summary}`)
          }
        }
        return out.join('\n')
      },
    },
    {
      name: 'sa_create',
      description: '建一张卡。标题必填；可带描述、项目、工作目录、紧急度和验收清单。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: str('标题'),
          description: str('描述'),
          prompt: str('执行时给执行会话的指令'),
          workspaceId: str('项目 id'),
          workspacePath: str('这件事在哪个目录做（开始做时要用来建会话）'),
          urgency: str('urgent / normal / relaxed'),
          checklist: { type: 'array', items: { type: 'string' }, description: '验收清单，最多 30 条' },
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      execute: async args => {
        const t = createTask(args || {})
        return `已建卡 ${t.id}「${t.title}」v${t.version}`
      },
    },
    {
      name: 'sa_move',
      description: '移动卡片状态。必须带 ifVersion（先 sa_get 拿）。agent 不能移到 done。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'ifVersion'],
        properties: {
          id: str('任务 id'),
          status: str('目标状态'),
          ifVersion: num('卡片当前版本号'),
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      execute: async args => {
        const target = assertAgentMayMove(String(args?.status ?? ''))
        const t = moveTask(String(args?.id ?? ''), target, { ifVersion: Number(args?.ifVersion) })
        return `已移动 ${t.id} → ${t.status} v${t.version}`
      },
    },
    {
      name: 'sa_comment',
      description: '给一张卡留言。留言是后续需求；有执行会话时会同时送过去。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'body'],
        properties: { id: str('任务 id'), body: str('留言内容'), ifVersion: num('可选：卡片版本号') },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      execute: async args => {
        const body = String(args?.body ?? '')
        const t = addComment(String(args?.id ?? ''), body, {
          author: 'agent',
          ifVersion: args?.ifVersion === undefined ? undefined : Number(args.ifVersion),
        })
        let delivery = '这张卡还没有执行会话，留言会在开工时读到。'
        if (engine && typeof engine.deliverTask === 'function') {
          try {
            const result = await engine.deliverTask(t.id, body, { kind: 'comment' })
            if (result.ok) {
              delivery = result.effectState === 'confirmed'
                ? '已送到当前执行会话。'
                : '已记录，等待宿主确认投递；确认前不当作已送。'
            }
          } catch (error) {
            delivery = `留言已记下，但没送出去：${error instanceof Error ? error.message : String(error)}`
          }
        }
        return `已留言 ${t.id}，当前 ${t.comments.length} 条评论，v${t.version}\n${delivery}`
      },
    },
    {
      name: 'sa_report',
      description:
        '提交执行报告：摘要必填。用 outcome 说明做完了/还在做/在等外部/卡住/做不下去/不用做了；要问用户就把问题放进 question。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'summary'],
        properties: {
          id: str('任务 id'),
          summary: str('做了什么'),
          outcome: str('ready 做完待验收 / progress 还在做 / waiting 等外部 / blocked 卡住 / failed 做不下去 / dropped 不用做了'),
          question: {
            type: 'object',
            description: '要问用户的问题；一次只问一个',
            additionalProperties: false,
            properties: {
              text: str('问题'),
              options: { type: 'array', items: { type: 'string' }, description: '可选答案' },
            },
          },
          changedFiles: { type: 'array', items: { type: 'string' }, description: '改动文件' },
          checks: { type: 'array', items: { type: 'string' }, description: '怎么验证的' },
          risk: str('剩余风险'),
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      execute: async (args, exec) => {
        const sessionId = sessionIdOfExec(exec)
        const t = reportExecution(String(args?.id ?? ''), args || {}, sessionId ? { sessionId } : {})
        return reportLine(t, args)
      },
    },
    {
      name: 'sa_check',
      description: '勾选一张卡验收清单里的一项（附证据）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'itemId'],
        properties: { id: str('任务 id'), itemId: str('清单项 id'), note: str('证据') },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => text(v) },
      execute: async args => {
        const t = checkItem(String(args?.id ?? ''), String(args?.itemId ?? ''), { note: args?.note })
        return `已勾选 ${t.id} 的一项，v${t.version}`
      },
    },
  ]
}

// Register every tool; returns a disposer that unregisters them all.
export function registerTools(tools, options = {}) {
  const disposers = createToolDefinitions(options.engine).map(def => tools.register(def))
  return () => { for (const d of disposers.splice(0)) { try { d() } catch { /* already gone */ } } }
}
