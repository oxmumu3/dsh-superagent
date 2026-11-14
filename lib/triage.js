// dsh-superagent triage — Turn raw natural language into an executable plan.
//
// Builds a deterministic plan immediately (split items, match real known
// workspaces, detect risky gates, draft objective checklists, recommend runner)
// and enhances it via host `ctx.llm` when ready, with strict whitelist
// validation so the model can never invent non-existent folders or task ids.

import path from 'node:path'
import { detectNod, nodReason as computeNodReason } from './nod.js'
import { sanitizeText } from './sanitize.js'
import {
  comparePath,
  discoverKnownWorkspaces,
  validateWorkspacePath,
  workspaceFromText,
  workspaceLabel,
} from './workspace.js'
import { currentAssignment, listTasks, updateTask } from './ledger.js'

const RUNNERS = new Set(['codex', 'dsh', 'manual'])
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'src', 'lib',
  'app', 'web', 'docs', 'test', 'tests', 'users', 'shan', 'projects',
])

function cleanLine(text) {
  return String(sanitizeText(text) ?? '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function cleanTitle(text) {
  const first = cleanLine(text)
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) || ''
  const stripped = first
    .replace(/^[\d①②③④⑤⑥⑦⑧⑨⑩]+[\.、\)\]]\s*/, '')
    .replace(/^[-*•]\s+/, '')
    .replace(/^(请|帮我|麻烦|顺便|然后|另外|还有|我想|需要|准备|继续)\s*/, '')
    .replace(/[。；;，,！!？?：:]+$/, '')
    .trim()
  const base = stripped || first.replace(/[。；;，,]+$/, '').trim()
  return (base || '新交办事项').slice(0, 64)
}

function tokenizeLower(text) {
  const lower = String(text ?? '').toLowerCase()
  const words = lower.match(/[a-z0-9][a-z0-9_-]{1,}|[\u4e00-\u9fa5]{2,}/g) ?? []
  const expanded = []
  for (const w of words) {
    expanded.push(w)
    if (w.includes('-') || w.includes('_')) {
      for (const part of w.split(/[-_]+/)) {
        if (part.length >= 2) expanded.push(part)
      }
    }
  }
  return [...new Set(expanded.filter(t => !STOPWORDS.has(t)))]
}

function candidateKeywords(candidate) {
  const parts = []
  const label = String(candidate.label ?? '')
  const custom = String(candidate.customLabel ?? '')
  const base = String(candidate.baseName ?? path.basename(candidate.path))
  const parent = String(candidate.parentName ?? path.basename(path.dirname(candidate.path)))
  for (const s of [base, custom, label, parent]) {
    const clean = s.trim()
    if (clean) parts.push(clean)
  }
  const tokens = tokenizeLower(parts.join(' '))
  return { base: base.toLowerCase(), custom: custom.toLowerCase(), label: label.toLowerCase(), parent: parent.toLowerCase(), tokens }
}

export function matchWorkspaceForText(text, candidates = [], options = {}) {
  const raw = cleanLine(text)
  const minScore = Number(options.minScore) > 0 ? Number(options.minScore) : 15
  const explicit = workspaceFromText(raw)
  if (explicit) {
    const known = candidates.find(c => comparePath(c.path) === comparePath(explicit))
    return {
      workspacePath: explicit,
      workspaceLabel: known?.label ?? workspaceLabel(explicit),
      isGitRepo: known?.isGitRepo ?? false,
      score: 100,
      reason: '文本里直接指定了目录',
    }
  }
  if (!raw || !Array.isArray(candidates) || candidates.length === 0) return null

  const lower = raw.toLowerCase()
  const textTokens = tokenizeLower(raw)
  let best = null

  for (const cand of candidates) {
    if (!cand?.path) continue
    const kw = candidateKeywords(cand)
    let score = 0
    if (kw.base && kw.base.length >= 2 && lower.includes(kw.base)) score += 45
    if (kw.custom && kw.custom.length >= 2 && lower.includes(kw.custom)) score += 40
    if (kw.label && kw.label.length >= 2 && lower.includes(kw.label)) score += 35

    let tokenHits = 0
    for (const tok of kw.tokens) {
      if (tok.length < 2) continue
      if (lower.includes(tok)) {
        tokenHits += 1
        score += tok.length >= 4 ? 14 : 9
      } else if (textTokens.some(t => t.includes(tok) && tok.length >= 3)) {
        tokenHits += 1
        score += 8
      }
    }
    if (tokenHits > 0) {
      score += Math.min(8, Number(cand.count || 0))
    }
    if (!best || score > best.score || (score === best.score && (cand.lastUsedAt || 0) > (best.cand.lastUsedAt || 0))) {
      best = { cand, score }
    }
  }

  if (!best || best.score < minScore) return null
  return {
    workspacePath: best.cand.path,
    workspaceLabel: best.cand.label ?? workspaceLabel(best.cand.path),
    isGitRepo: Boolean(best.cand.isGitRepo),
    score: best.score,
    reason: `按关键词匹配到常用目录 ${best.cand.label ?? path.basename(best.cand.path)}`,
  }
}

export function splitIntentSegments(rawText) {
  const normalized = String(sanitizeText(rawText) ?? '')
    .replace(/\r/g, '\n')
    .trim()
  if (!normalized) return []

  // First try explicit line/list splitting when multiple lines or numbered items exist.
  const lineParts = normalized
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)

  let segments = []
  if (lineParts.length > 1) {
    segments = lineParts
  } else {
    // Try numbered markers like `1. xxx 2. xxx` or `① xxx ② xxx` inside one paragraph.
    const numbered = normalized
      .replace(/(?:^|\s+)([1-9][\.、\)]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/g, '\n$1 ')
      .split(/\n+/)
      .map(s => s.trim())
      .filter(Boolean)
    if (numbered.length > 1) {
      segments = numbered
    } else {
      // Split on strong clause separators (`；` / `;` / `，然后` / `，顺便` / `，另外` / `，还有`)
      const byCue = normalized
        .replace(/[；;]+/g, '\n')
        .replace(/[，,]+\s*(?=顺便|另外|还有就是|还有一件|然后再|并且|同时再|以及)/g, '\n')
        .split(/\n+/)
        .map(s => s.trim())
        .filter(Boolean)
      segments = byCue.length > 1 && byCue.every(s => s.length >= 6) ? byCue : [normalized]
    }
  }

  const cleaned = []
  for (const part of segments) {
    const trimmed = part
      .replace(/^[1-9][\.、\)\]]\s*/, '')
      .replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '')
      .replace(/^[-*•]\s+/, '')
      .trim()
    if (trimmed.length >= 2) cleaned.push(trimmed)
  }
  if (cleaned.length <= 1) return cleaned.length ? cleaned : [normalized]
  if (cleaned.length > 6) {
    return [...cleaned.slice(0, 5), cleaned.slice(5).join('；')]
  }
  return cleaned
}

const CODE_HINT_RE = /(代码|重构|修复|修\s*bug|bug|fix|feat|refactor|测试|单测|脚本|接口|api|frontend|backend|ui|css|html|组件|插件|构建|打包|发布|仓库|repo|git|worktree|codex|cli|mcp|electron|cordis|react)/i
const WRITE_HINT_RE = /(文章|文档|文案|总结|报告|梳理|分析|调研|写一|起草|大纲|推文|小红书|公众号|微信|帖子|邮件|readme|spec|design)/i
const MANUAL_HINT_RE = /(我自己|手动做|人工|先别派|暂不派|线下|打电话|付款|买|预约)/i
const CODEX_EXPLICIT_RE = /\b(codex|worktree)\b/i
const DSH_EXPLICIT_RE = /(用\s*dsh|dsh\s*会话|在面板里|自己对话)/i
const DEPENDENCY_CUE_RE = /^(等(上一|前一个|那个)?做?完|完成(后|以后)|然后等|下一步|之后再|接着再)/

export function draftChecklistForText(text, runner = 'dsh') {
  const s = String(text ?? '')
  if (CODE_HINT_RE.test(s) || runner === 'codex') {
    return [
      '完成目标改动并确保相关代码边界清晰、无未处理异常',
      '运行相关单元测试、语法或构建检查并记录通过结果',
      '整理改动文件清单与核心验证结论供人工拍板',
    ]
  }
  if (WRITE_HINT_RE.test(s)) {
    return [
      '完成背景素材核对，确保论据与引用来源真实可靠',
      '产出结构完整、可直接使用的文档或成稿',
      '复核关键诉求与事实表述无遗漏',
    ]
  }
  return [
    '确认执行环境与前置条件完整',
    '完成核心事项并保留可核验的结果或证据',
    '汇总完成情况与遗留风险供验收',
  ]
}

export function recommendRunnerForTask(input = {}) {
  const combined = `${input.title ?? ''}\n${input.text ?? ''}`
  const codexAvailable = input.codexAvailable === true
  const hasWorkspace = Boolean(input.workspacePath)
  const isGitRepo = Boolean(input.isGitRepo)

  if (MANUAL_HINT_RE.test(combined)) {
    return { runner: 'manual', reason: '内容更像线下/人工确认动作，建议标为人工自办或稍后处理' }
  }
  if (DSH_EXPLICIT_RE.test(combined)) {
    return { runner: 'dsh', reason: '按你的指令交给 DeepSeek Harness 原生会话执行' }
  }
  if (codexAvailable && (CODEX_EXPLICIT_RE.test(combined) || (hasWorkspace && isGitRepo && CODE_HINT_RE.test(combined)))) {
    return { runner: 'codex', reason: '代码仓工程任务：建议用 Codex CLI 在独立 Worktree 后台并行交付' }
  }
  if (codexAvailable && hasWorkspace && isGitRepo && !WRITE_HINT_RE.test(combined)) {
    return { runner: 'codex', reason: '命中 Git 代码仓：可用 Codex Worktree 沙盒并行隔离改动' }
  }
  return {
    runner: 'dsh',
    reason: hasWorkspace
      ? '交给 DeepSeek Harness 宿主会话执行并写入证据清单'
      : '尚未绑定 Git 工程目录，默认由 DeepSeek Harness 宿主会话承接',
  }
}

function sanitizeJsonReply(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

function normalizeLlmProposal(parsed, baseline, context) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    return null
  }
  const candByPath = new Map(context.candidates.map(c => [comparePath(c.path), c]))
  const activeIds = new Set(context.activeTasks.map(t => t.id))
  const items = []

  for (let i = 0; i < Math.min(parsed.items.length, 6); i += 1) {
    const raw = parsed.items[i]
    if (!raw || typeof raw !== 'object') continue
    const base = baseline[Math.min(i, baseline.length - 1)] ?? baseline[0]
    const description = String(raw.description ?? base?.description ?? '').trim()
    const title = cleanTitle(raw.title ?? description)
    if (!title || !description) continue

    let workspacePath = base?.workspacePath ?? null
    let workspaceReason = base?.workspaceReason ?? ''
    if (typeof raw.workspacePath === 'string' && raw.workspacePath.trim()) {
      const normalized = comparePath(raw.workspacePath)
      const matched = candByPath.get(normalized)
      if (matched) {
        workspacePath = matched.path
        workspaceReason = `AI 绑定到常用目录 ${matched.label}`
      } else {
        try {
          const validExplicit = validateWorkspacePath(raw.workspacePath)
          if (validExplicit && context.rawText.includes(raw.workspacePath.trim())) {
            workspacePath = validExplicit
            workspaceReason = '保留你在文本里给出的目录'
          }
        } catch {
          // Reject hallucinated path silently and fall back to deterministic workspace.
        }
      }
    }

    const cand = workspacePath ? candByPath.get(comparePath(workspacePath)) : null
    let runner = RUNNERS.has(raw.runner) ? raw.runner : (base?.runner ?? 'dsh')
    if (runner === 'codex' && !context.codexAvailable) runner = 'dsh'

    const detNod = detectNod(description)
    const needsNod = Boolean(detNod || raw.needsNod === true)
    const nodReason = needsNod
      ? String(raw.nodReason ?? (detNod ? computeNodReason(detNod) : 'AI 识别到高风险外部影响，建议人工点头后再动')).trim()
      : null

    const checklist = Array.isArray(raw.checklist)
      ? raw.checklist.map(s => String(s ?? '').trim()).filter(Boolean).slice(0, 4)
      : []
    const attachToTaskId = (typeof raw.attachToTaskId === 'string' && activeIds.has(raw.attachToTaskId))
      ? raw.attachToTaskId
      : null

    items.push({
      key: `plan-${i + 1}`,
      action: attachToTaskId ? 'append' : 'create',
      attachToTaskId,
      title,
      description,
      workspacePath,
      workspaceLabel: workspacePath ? (cand?.label ?? workspaceLabel(workspacePath)) : null,
      workspaceReason,
      isGitRepo: Boolean(cand?.isGitRepo),
      runner,
      runnerReason: String(raw.runnerReason ?? base?.runnerReason ?? '').trim() || recommendRunnerForTask({
        title,
        text: description,
        workspacePath,
        isGitRepo: Boolean(cand?.isGitRepo),
        codexAvailable: context.codexAvailable,
      }).reason,
      needsNod,
      nodReason,
      checklist: checklist.length >= 2 ? checklist : draftChecklistForText(description, runner),
      later: raw.later === true,
      dependsOnPrevious: Boolean(raw.dependsOnPrevious ?? base?.dependsOnPrevious),
    })
  }
  if (!items.length) return null
  return {
    summary: String(parsed.summary ?? '').trim() || `已拆解为 ${items.length} 条可执行任务提案`,
    items,
  }
}

export async function triageIntent(rawText, options = {}) {
  const input = cleanLine(rawText)
  if (!input) throw new Error('先告诉我你想交办什么事')

  const tasks = Array.isArray(options.tasks) ? options.tasks : []
  const candidates = Array.isArray(options.candidates) && options.candidates.length
    ? options.candidates
    : discoverKnownWorkspaces(tasks, {
        extraDirs: options.extraDirs,
        ledgerFile: options.ledgerFile,
        dshHome: options.dshHome,
      })
  const codexAvailable = options.codexAvailable === true
  const activeTasks = tasks
    .filter(t => t && ['todo', 'in_progress'].includes(t.status))
    .slice(0, 12)
    .map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      workspacePath: t.workspacePath ?? null,
    }))

  const segments = splitIntentSegments(input)
  const baselineItems = segments.map((segment, index) => {
    const title = cleanTitle(segment)
    const matched = matchWorkspaceForText(segment, candidates, { minScore: 15 })
      ?? (segments.length > 1 ? matchWorkspaceForText(input, candidates, { minScore: 30 }) : null)
    const workspacePath = matched?.workspacePath ?? (options.defaultWorkspacePath || null)
    const cand = workspacePath ? candidates.find(c => comparePath(c.path) === comparePath(workspacePath)) : null
    const isGitRepo = Boolean(matched?.isGitRepo ?? cand?.isGitRepo)
    const rec = recommendRunnerForTask({
      title,
      text: segment,
      workspacePath,
      isGitRepo,
      codexAvailable,
    })
    const nod = detectNod(segment)
    return {
      key: `plan-${index + 1}`,
      action: 'create',
      attachToTaskId: null,
      title,
      description: segment,
      workspacePath,
      workspaceLabel: workspacePath ? (matched?.workspaceLabel ?? workspaceLabel(workspacePath)) : null,
      workspaceReason: matched?.reason ?? (workspacePath ? '沿用当前默认工作区' : '暂未匹配到目录，可直接在下面选定'),
      isGitRepo,
      runner: rec.runner,
      runnerReason: rec.reason,
      needsNod: Boolean(nod),
      nodReason: nod ? computeNodReason(nod) : null,
      checklist: draftChecklistForText(segment, rec.runner),
      later: false,
      dependsOnPrevious: index > 0 && DEPENDENCY_CUE_RE.test(segment),
    }
  })

  let usedLlm = false
  let llmError = null
  let finalItems = baselineItems
  let summary = baselineItems.length > 1
    ? `识别到 ${baselineItems.length} 件独立事项，已按真实目录和引擎能力生成分诊计划`
    : '已整理成可执行任务卡（含目标目录、推荐引擎与验收清单）'

  const llm = options.llmAdapter
  if (llm && typeof llm.streamText === 'function' && (!typeof llm.ready || llm.ready !== false)) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000
    const prompt = [
      '你是 Super Agent 任务总参谋（只输出严格 JSON，不要解释）。',
      '请把用户随手写下的一段或多段需求整理成结构化交办提案。',
      '硬规则：',
      '1. workspacePath 只能从下方 knownWorkspaces 的 path 中原样选取（除非用户原文自己写出了本地绝对路径），找不到时填 null，绝对禁止编造不存在的路径。',
      '2. 若明显是向已有任务补充需求，可填 attachToTaskId（只能从 activeTasks 选取），否则为 null。',
      `3. runner 只能取 "codex" / "dsh" / "manual"（当前 codexAvailable=${codexAvailable}；false 时不要选 codex）。涉及 Git 仓写代码/改测试/排查源码且 codexAvailable=true 时优先推荐 "codex"。`,
      '4. 每张卡给 2-3 条客观、可验证的 checklist 短句。',
      '5. 若涉及发布/删除/外发/转账/不可逆修改，needsNod=true 并给出 nodReason。',
      '',
      `knownWorkspaces: ${JSON.stringify(candidates.slice(0, 16).map(c => ({ path: c.path, label: c.label, isGitRepo: c.isGitRepo })))}`,
      `activeTasks: ${JSON.stringify(activeTasks.slice(0, 10))}`,
      `userInput: ${JSON.stringify(input)}`,
      '',
      '返回 JSON 结构: {"summary":"一句话分诊总结","items":[{"title":"短标题","description":"完整需求描述","workspacePath":null,"runner":"dsh","runnerReason":"简短原因","needsNod":false,"nodReason":null,"checklist":["清单1","清单2"],"attachToTaskId":null,"later":false,"dependsOnPrevious":false}]}',
    ].join('\n')

    try {
      const reply = await Promise.race([
        llm.streamText(prompt),
        new Promise((_, reject) => setTimeout(() => reject(new Error('LLM 分诊超时')), timeoutMs)),
      ])
      const parsed = sanitizeJsonReply(reply)
      const validated = normalizeLlmProposal(parsed, baselineItems, {
        candidates,
        activeTasks,
        codexAvailable,
        rawText: input,
      })
      if (validated) {
        usedLlm = true
        finalItems = validated.items
        summary = validated.summary
      }
    } catch (error) {
      llmError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    ok: true,
    usedLlm,
    ...(llmError ? { llmError } : {}),
    input,
    summary,
    items: finalItems,
    candidates: candidates.slice(0, 16).map(c => ({
      path: c.path,
      label: c.label,
      customLabel: c.customLabel ?? null,
      isGitRepo: Boolean(c.isGitRepo),
    })),
    activeTasks,
  }
}

export function triageBacklogWorkspaces(options = {}) {
  const ledgerOpts = { file: options.file }
  const { tasks } = listTasks({ includeArchived: false }, ledgerOpts)
  const candidates = discoverKnownWorkspaces(tasks, {
    extraDirs: options.extraDirs,
    ledgerFile: options.file,
    dshHome: options.dshHome,
    limit: 32,
  })
  const targets = tasks.filter(task =>
    task
    && ['backlog', 'todo'].includes(task.status)
    && !task.workspacePath
    && !currentAssignment(task),
  )

  const snapshot = []
  const updates = []
  for (const task of targets) {
    const match = matchWorkspaceForText(`${task.title}\n${task.description ?? ''}`, candidates, {
      minScore: Number(options.minScore) > 0 ? Number(options.minScore) : 20,
    })
    if (!match) continue
    try {
      const updated = updateTask(task.id, { workspacePath: match.workspacePath }, {
        ...ledgerOpts,
        ifVersion: task.version,
        by: 'triage-backlog',
      })
      snapshot.push({
        taskId: task.id,
        previousWorkspacePath: task.workspacePath ?? null,
        appliedWorkspacePath: updated.workspacePath,
      })
      updates.push({
        taskId: task.id,
        title: task.title,
        workspacePath: updated.workspacePath,
        workspaceLabel: match.workspaceLabel,
        reason: match.reason,
      })
    } catch {
      // Skip cards modified concurrently.
    }
  }

  return {
    ok: true,
    scannedCount: targets.length,
    matchedCount: updates.length,
    updates,
    snapshot,
  }
}

export function restoreBacklogWorkspaces(snapshot = [], options = {}) {
  const ledgerOpts = { file: options.file }
  let restoredCount = 0
  for (const entry of Array.isArray(snapshot) ? snapshot : []) {
    if (!entry?.taskId) continue
    try {
      const { tasks } = listTasks({ includeArchived: true }, ledgerOpts)
      const task = tasks.find(t => t.id === entry.taskId)
      if (!task || currentAssignment(task)) continue
      if (comparePath(task.workspacePath) !== comparePath(entry.appliedWorkspacePath)) continue
      updateTask(task.id, { workspacePath: entry.previousWorkspacePath ?? null }, {
        ...ledgerOpts,
        ifVersion: task.version,
        by: 'triage-undo',
      })
      restoredCount += 1
    } catch {
      // Ignore individual restore conflicts.
    }
  }
  return { ok: true, restoredCount }
}
