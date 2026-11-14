// dsh-superagent Codex runner — Background headless execution via codex-cli
// inside an isolated git worktree, streaming JSONL progress into the ledger
// and atomically settling checklist + structured report before turn/end.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  checkItem,
  currentAssignment,
  getTask,
  patchAssignment,
  reportExecution,
  setChecklist,
} from '../ledger.js'
import { rulesPromptSection } from '../rules.js'
import { inspectWorktreeSummary } from '../worktree.js'

const VALID_OUTCOMES = new Set(['ready', 'progress', 'waiting', 'blocked', 'failed', 'dropped'])

const CODEX_REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'changedFiles', 'risk', 'friction', 'question', 'checklist'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['ready', 'progress', 'waiting', 'blocked', 'failed', 'dropped'],
    },
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    risk: { type: ['string', 'null'] },
    friction: { type: ['string', 'null'] },
    question: { type: ['string', 'null'] },
    checklist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'done', 'note', 'evidence'],
        properties: {
          text: { type: 'string' },
          done: { type: 'boolean' },
          note: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

function isExecutableFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false
    const st = fs.statSync(filePath)
    if (!st.isFile()) return false
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveCodexBinary(options = {}) {
  const override = options.bin ?? process.env.DSH_SUPERAGENT_CODEX_BIN
  if (override !== undefined) {
    const clean = String(override).trim()
    if (!clean || clean === '0' || clean === 'none' || clean === 'disabled') return null
    return isExecutableFile(clean) ? clean : null
  }
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
  ]
  for (const p of candidates) {
    if (isExecutableFile(p)) return p
  }
  try {
    const found = execFileSync('which', ['codex'], { encoding: 'utf8', timeout: 2000 }).trim()
    if (isExecutableFile(found)) return found
  } catch {
    // Ignore when codex is not in PATH.
  }
  return null
}

function resolveRuntimeDir(options = {}) {
  const base = options.dshHome
    || process.env.DSH_HOME
    || (options.ledgerFile ? path.dirname(options.ledgerFile) : path.join(os.homedir(), '.dsh'))
  const dir = path.join(base, 'superagent-codex-runs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function ensureSchemaFile(runtimeDir) {
  const schemaPath = path.join(runtimeDir, 'codex-report-schema.json')
  const raw = `${JSON.stringify(CODEX_REPORT_SCHEMA, null, 2)}\n`
  try {
    if (!fs.existsSync(schemaPath) || fs.readFileSync(schemaPath, 'utf8') !== raw) {
      fs.writeFileSync(schemaPath, raw, 'utf8')
    }
  } catch {
    fs.writeFileSync(schemaPath, raw, 'utf8')
  }
  return schemaPath
}

export function buildCodexPrompt(task, cwd, context = {}) {
  const lines = [
    '你是 Super Agent 后台工程执行器（Codex headless），只专注于把当前卡片任务做完并交付可核验结果。',
    '',
    `卡号：${task.id}`,
    `标题：${task.title}`,
    `执行工作目录：${cwd ?? task.workspacePath ?? '(未指定)'}`,
  ]
  if (context.worktreeBranch) {
    lines.push(`隔离分支（Git Worktree）：${context.worktreeBranch}（仅在此 Worktree 内改动，不要操作用户主仓库工作区，不要做破坏性清理）`)
  }
  if (task.description) lines.push('', '## 任务描述', task.description)
  if (task.checklist?.length) {
    lines.push('', '## 既有验收清单（最终 JSON 的 checklist 请逐条如实回报 done / note / evidence）')
    for (const item of task.checklist) lines.push(`- [${item.done ? 'x' : ' '}] ${item.text}`)
  } else {
    lines.push('', '## 验收清单要求', '当前卡片尚无验收清单；请在完成前自行凝练 2–4 条客观可验证的 checklist 项，并在最终 JSON 中逐项填写 done=true、note 与 evidence。')
  }
  if (Array.isArray(task.comments) && task.comments.length) {
    lines.push('', '## 最近留言/补充上下文')
    for (const c of task.comments.slice(-5)) {
      lines.push(`- (${c.author || 'user'}) ${c.body}`)
    }
  }
  if (context.followupMessage) {
    lines.push('', '## 本轮新指示 / 返工或回答内容', String(context.followupMessage))
  }
  const rulesSection = rulesPromptSection(Array.isArray(context.rules) ? context.rules : [])
  if (rulesSection) lines.push(rulesSection)

  lines.push(
    '',
    '## 边界与交付协议',
    task.nodded
      ? '- 用户已批准本卡范围内的操作；超出本卡范围的发版、删库、对外发送等不可逆外部动作仍需停下并设 outcome="blocked" + question。'
      : '- 未获用户点头前，不要执行不可逆外部动作（发版/强推/外发/消费）；需要用户决断时设 outcome="blocked" 并写明单一清晰的 question。',
    '- 你的最终输出必须严格符合 --output-schema JSON Schema：',
    '  * outcome: ready（全部验收项完成且已验证）/ blocked（卡住或需要用户拍板）/ failed（执行失败）/ progress / waiting / dropped',
    '  * summary: 用简洁中文总结具体做了什么及验证结果',
    '  * changedFiles: 实际修改或新增的文件相对路径数组',
    '  * checklist: 与本卡验收项逐一对应（text, done, note, evidence；done=true 时 note 必须写明实际验证方法与观察结果）',
  )
  return lines.join('\n')
}

function summarizeStreamEvent(evt) {
  if (!evt || typeof evt !== 'object') return null
  const type = String(evt.type ?? '')
  if (type === 'thread.started' && evt.thread_id) {
    return { threadId: String(evt.thread_id), step: 'Codex 会话已建立，正在读取工程上下文' }
  }
  if (type === 'turn.started') {
    return { step: 'Codex 开始分析任务并规划改动' }
  }
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = evt.item && typeof evt.item === 'object' ? evt.item : {}
    const itemType = String(item.type ?? '')
    if (itemType === 'command_execution') {
      const cmd = String(item.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 72)
      if (!cmd) return { step: '正在执行命令检查' }
      return { step: type === 'item.completed' ? `已执行：${cmd}` : `运行中：${cmd}` }
    }
    if (itemType === 'file_change') {
      const file = String(item.changes?.[0]?.path ?? item.path ?? '').trim()
      return { step: file ? `改动文件：${file}` : '正在修改工作区文件' }
    }
    if (itemType === 'agent_message' && type === 'item.completed') {
      const txt = String(item.text ?? '').trim()
      return { lastAgentText: txt, step: '已生成阶段结论，准备收敛结果' }
    }
    if (itemType === 'reasoning') {
      const firstLine = String(item.text ?? '').split('\n')[0]?.trim().slice(0, 64)
      if (firstLine) return { step: firstLine }
    }
  }
  if (type === 'error' && evt.message) {
    return { step: `Codex 提示：${String(evt.message).slice(0, 72)}` }
  }
  return null
}

function parseStructuredOutput(outputPath, lastAgentText, exitCode, stderrTail) {
  let rawText = ''
  try {
    if (outputPath && fs.existsSync(outputPath)) {
      rawText = fs.readFileSync(outputPath, 'utf8').trim()
    }
  } catch {
    // Fall back to lastAgentText.
  }
  if (!rawText && lastAgentText) rawText = String(lastAgentText).trim()
  if (rawText) {
    const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)
    let body = fenced ? fenced[1].trim() : rawText
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      const start = body.indexOf('{')
      const end = body.lastIndexOf('}')
      if (start >= 0 && end > start) {
        try {
          parsed = JSON.parse(body.slice(start, end + 1))
        } catch {
          parsed = null
        }
      }
    }
    if (parsed && typeof parsed === 'object') {
      const outcome = VALID_OUTCOMES.has(parsed.outcome)
        ? parsed.outcome
        : (exitCode === 0 ? 'ready' : 'failed')
      return {
        outcome,
        summary: String(parsed.summary ?? '').trim() || (exitCode === 0 ? 'Codex 已完成执行' : 'Codex 执行异常结束'),
        changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.map(String).filter(Boolean) : [],
        risk: parsed.risk ? String(parsed.risk) : null,
        friction: parsed.friction ? String(parsed.friction) : null,
        question: parsed.question ? String(parsed.question) : null,
        checklist: Array.isArray(parsed.checklist) ? parsed.checklist : [],
      }
    }
  }
  const fallbackSummary = rawText
    ? rawText.slice(0, 600)
    : (stderrTail ? `Codex 退出码 ${exitCode}：${stderrTail.slice(0, 300)}` : `Codex 退出码 ${exitCode}，未产出结构化报告`)
  return {
    outcome: exitCode === 0 ? 'blocked' : 'failed',
    summary: fallbackSummary,
    changedFiles: [],
    risk: exitCode === 0 ? 'Codex 未输出结构化 JSON，已转人工确认' : null,
    friction: null,
    question: exitCode === 0 ? '请核对 Worktree 改动后决定验收或打回继续' : null,
    checklist: [],
  }
}

export function createCodexRunner(options = {}) {
  const clock = options.now ?? (() => Date.now())
  const log = options.log ?? (() => {})
  const ledgerOptions = options.ledgerOptions ?? (() => ({ file: options.file }))
  const emitEvent = options.onEvent ?? (() => {})
  const runs = new Map()

  function resolveArgs({ execCwd, schemaPath, outputPath, resumeThreadId, sandboxMode }) {
    const mode = sandboxMode || process.env.DSH_SUPERAGENT_CODEX_SANDBOX || 'workspace-write'
    if (resumeThreadId) {
      return [
        'exec',
        'resume',
        '--json',
        '--trust',
        '--skip-git-repo-check',
        '-c',
        `sandbox_mode="${mode}"`,
        '--output-schema',
        schemaPath,
        '-o',
        outputPath,
        String(resumeThreadId),
        '-',
      ]
    }
    return [
      'exec',
      '--json',
      '--trust',
      '--skip-git-repo-check',
      '--sandbox',
      mode,
      '-C',
      execCwd,
      '--output-schema',
      schemaPath,
      '-o',
      outputPath,
      '-',
    ]
  }

  function settleBeforeTurnEnd(taskId, assignmentId, sessionId, execCwd, worktreeRoot, parsed) {
    const opts = ledgerOptions()
    let task
    try {
      task = getTask(taskId, opts)
    } catch {
      return { settled: false, reason: 'missing_task' }
    }
    if (['done', 'canceled', 'archived'].includes(task.status)) {
      return { settled: false, reason: 'terminal_task' }
    }
    const current = currentAssignment(task)
    if (!current || current.id !== assignmentId) {
      return { settled: false, reason: 'stale_assignment' }
    }

    // Fill checklist when Codex generated items for a card with no existing checklist.
    if ((!task.checklist || task.checklist.length === 0) && Array.isArray(parsed.checklist) && parsed.checklist.length > 0) {
      const texts = parsed.checklist.map(c => String(c?.text ?? '').trim()).filter(Boolean).slice(0, 8)
      if (texts.length > 0) {
        try {
          task = setChecklist(task.id, texts, { ...opts, sessionId, by: 'codex-cli' })
        } catch (err) {
          log(`codex setChecklist failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // Apply item-level check notes from structured Codex report.
    if (Array.isArray(task.checklist) && task.checklist.length > 0 && Array.isArray(parsed.checklist)) {
      for (let i = 0; i < task.checklist.length; i += 1) {
        const item = task.checklist[i]
        if (!item || item.checked === true) continue
        const match = parsed.checklist.find(c => String(c?.text ?? '').trim() === item.text.trim())
          ?? parsed.checklist[i]
        if (!match || match.done !== true) continue
        const note = String(match.note ?? '').trim()
        if (!note) continue
        const ev = String(match.evidence ?? '').trim()
        try {
          task = checkItem(task.id, item.id, {
            ...opts,
            note,
            evidence: ev ? [ev.slice(0, 300)] : undefined,
            by: 'codex-cli',
          })
        } catch (err) {
          log(`codex checkItem failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    // Enrich changedFiles from git status when Worktree was used and schema list is sparse.
    let changedFiles = Array.isArray(parsed.changedFiles) ? [...parsed.changedFiles] : []
    if (changedFiles.length === 0 && worktreeRoot) {
      const diff = inspectWorktreeSummary(worktreeRoot)
      if (diff?.statusLines?.length) {
        changedFiles = diff.statusLines.map(line => line.replace(/^[MADRCU?!\s]+/, '').trim()).filter(Boolean)
      }
    }

    const checksList = (task.checklist ?? [])
      .filter(c => c.checked && c.note)
      .map(c => `${c.text}: ${c.note}`)
    const checks = checksList.length ? checksList : [parsed.summary]

    let outcome = parsed.outcome
    let reportResult = null
    const reportOptions = {
      ...opts,
      sessionId,
      by: 'codex-cli',
    }
    const questionObj = parsed.question ? { text: String(parsed.question).trim() } : undefined
    try {
      reportResult = reportExecution(task.id, {
        outcome,
        summary: parsed.summary,
        checks,
        changedFiles,
        risk: parsed.risk ?? undefined,
        friction: parsed.friction ?? undefined,
        question: questionObj,
      }, reportOptions)
    } catch (err) {
      // Ready gate blocked ready? Downgrade transparently to blocked so turn never becomes silent.
      const msg = err instanceof Error ? err.message : String(err)
      outcome = 'blocked'
      try {
        reportResult = reportExecution(task.id, {
          outcome: 'blocked',
          summary: `${parsed.summary}\n（未自动进入待拍板：${msg}）`,
          checks,
          changedFiles,
          risk: msg,
          question: { text: String(parsed.question || `请核对未勾选的验收项（${msg}）或补充指示`).trim() },
        }, reportOptions)
      } catch (err2) {
        log(`codex fallback reportExecution failed: ${err2 instanceof Error ? err2.message : String(err2)}`)
      }
    }
    return { settled: Boolean(reportResult), outcome }
  }

  async function launchTurn({
    taskId,
    assignmentId,
    sessionId,
    messageId,
    execCwd,
    worktreeRoot,
    worktreeBranch,
    prompt,
    resumeThreadId,
    sandboxMode,
    allowFallbackFresh = true,
  }) {
    const bin = resolveCodexBinary(options)
    if (!bin) throw new Error('本机未找到 codex-cli 可执行文件，无法启动 Codex 执行器')

    const runtimeDir = resolveRuntimeDir({ ...options, ledgerFile: ledgerOptions().file })
    const schemaPath = ensureSchemaFile(runtimeDir)
    const runStamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const outputPath = path.join(runtimeDir, `${assignmentId}-${runStamp}.json`)

    const args = resolveArgs({ execCwd, schemaPath, outputPath, resumeThreadId, sandboxMode })
    const spawnImpl = options.spawn ?? spawn
    const child = spawnImpl(bin, args, {
      cwd: execCwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const run = {
      sessionId,
      taskId,
      assignmentId,
      proc: child,
      execCwd,
      worktreeRoot,
      worktreeBranch,
      threadId: resumeThreadId || null,
      ended: false,
      canceled: false,
      lastAgentText: '',
      stderrChunks: [],
      lastStepFlushAt: 0,
      pendingStep: null,
    }
    runs.set(sessionId, run)

    // Confirm inbox message immediately so engine's waitForConfirmation does not stall.
    if (messageId) {
      emitEvent({
        type: 'agent/inbox/claimed',
        data: { sessionId, messageId },
      }, { id: sessionId })
    }
    emitEvent({
      type: 'turn/start',
      data: { sessionId },
    }, { id: sessionId })

    const flushStep = (force = false) => {
      const now = clock()
      if (!force && now - run.lastStepFlushAt < 800) return
      const step = run.pendingStep
      if (!step && !run.threadId) return
      run.lastStepFlushAt = now
      try {
        const opts = ledgerOptions()
        const task = getTask(taskId, opts)
        const curr = currentAssignment(task)
        if (!curr || curr.id !== assignmentId) return
        const nextExec = {
          ...(curr.executor ?? { kind: 'codex-cli' }),
          kind: 'codex-cli',
          ...(worktreeRoot ? { worktreePath: worktreeRoot } : {}),
          ...(worktreeBranch ? { branch: worktreeBranch } : {}),
          ...(run.threadId ? { codexThreadId: run.threadId } : {}),
        }
        patchAssignment(taskId, assignmentId, {
          lastEventAt: now,
          ...(step ? { lastStep: step } : {}),
          executor: nextExec,
        }, opts)
      } catch {
        // Best-effort live step trace.
      }
    }

    let stdoutBuf = ''
    child.stdout?.on('data', chunk => {
      stdoutBuf += chunk.toString('utf8')
      let nl = stdoutBuf.indexOf('\n')
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        nl = stdoutBuf.indexOf('\n')
        if (!line) continue
        try {
          const evt = JSON.parse(line)
          const info = summarizeStreamEvent(evt)
          if (info?.threadId) {
            run.threadId = info.threadId
            run.pendingStep = info.step
            flushStep(true)
          } else {
            if (info?.lastAgentText) run.lastAgentText = info.lastAgentText
            if (info?.step) {
              run.pendingStep = info.step
              flushStep(false)
            }
          }
        } catch {
          // Non-JSON diagnostic line; ignore cleanly.
        }
      }
    })

    child.stderr?.on('data', chunk => {
      run.stderrChunks.push(chunk.toString('utf8'))
      if (run.stderrChunks.length > 20) run.stderrChunks.shift()
    })

    const finishPromise = new Promise(resolve => {
      let finalized = false
      const finalize = async ({ code, error }) => {
        if (finalized) return
        finalized = true
        if (stdoutBuf.trim()) {
          try {
            const evt = JSON.parse(stdoutBuf.trim())
            const info = summarizeStreamEvent(evt)
            if (info?.threadId) run.threadId = info.threadId
            if (info?.lastAgentText) run.lastAgentText = info.lastAgentText
            if (info?.step) run.pendingStep = info.step
          } catch {
            // Ignore partial trailing line.
          }
        }
        flushStep(true)

        const exitCode = error ? 1 : (Number.isInteger(code) ? code : 1)
        const stderrTail = run.stderrChunks.join('').trim()

        // If `exec resume` failed before producing output, fall back cleanly to fresh `exec`
        // inside the same worktree/cwd preserving accumulated changes.
        if (
          resumeThreadId
          && allowFallbackFresh
          && !run.canceled
          && exitCode !== 0
          && !fs.existsSync(outputPath)
          && !run.lastAgentText
        ) {
          log(`codex exec resume ${resumeThreadId} failed (${stderrTail.slice(0, 120)}), falling back to fresh exec in ${execCwd}`)
          try {
            const fallbackRes = await launchTurn({
              taskId,
              assignmentId,
              sessionId,
              messageId: null,
              execCwd,
              worktreeRoot,
              worktreeBranch,
              prompt,
              resumeThreadId: null,
              sandboxMode,
              allowFallbackFresh: false,
            })
            resolve(fallbackRes)
            return
          } catch (fbErr) {
            log(`codex fallback fresh exec failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`)
          }
        }

        run.ended = true

        if (run.canceled) {
          runs.delete(sessionId)
          resolve({ canceled: true })
          return
        }

        const parsed = parseStructuredOutput(
          outputPath,
          run.lastAgentText,
          exitCode,
          error ? error.message : stderrTail,
        )
        const settled = settleBeforeTurnEnd(taskId, assignmentId, sessionId, execCwd, worktreeRoot, parsed)
        const endKind = exitCode === 0 ? 'complete' : 'error'
        emitEvent({
          type: 'turn/end',
          data: {
            sessionId,
            reason: {
              kind: endKind,
              detail: parsed.summary?.slice(0, 200) || (exitCode === 0 ? 'Codex 已完成' : `退出码 ${exitCode}`),
            },
          },
        }, { id: sessionId })
        runs.delete(sessionId)
        resolve({ exitCode, outcome: settled.outcome ?? parsed.outcome, threadId: run.threadId })
      }

      child.on('error', err => { void finalize({ code: 1, error: err }) })
      child.on('close', code => { void finalize({ code }) })
    })
    run.donePromise = finishPromise

    try {
      child.stdin?.write(prompt)
      child.stdin?.end()
    } catch {
      // Ignore EPIPE if child terminated early.
    }

    return { run, finishPromise }
  }

  function getSession(sessionId) {
    const run = runs.get(sessionId)
    if (!run) return null
    return {
      id: sessionId,
      kind: 'codex-cli',
      running: !run.ended,
      threadId: run.threadId,
    }
  }

  async function cancel(sessionId) {
    const run = runs.get(sessionId)
    if (!run || run.ended) return false
    run.canceled = true
    run.ended = true
    try {
      run.proc.kill('SIGTERM')
    } catch {
      // Process may already have exited.
    }
    return true
  }

  function hasBinary() {
    return Boolean(resolveCodexBinary(options))
  }

  return {
    hasBinary,
    resolveBinary: () => resolveCodexBinary(options),
    launchTurn,
    getSession,
    cancel,
    dispose: cancel,
    runs,
  }
}
