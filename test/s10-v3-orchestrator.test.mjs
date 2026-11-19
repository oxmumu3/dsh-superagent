// S10 v0.3.0-preview.1 Intelligent Orchestrator end-to-end verification:
// Pillar 1: discoverKnownWorkspaces, AI triageIntent (split + LLM hallucination rejection), triage_backlog + restore.
// Pillar 2: Git worktree isolation (incl. monorepo subpath), Codex CLI exec & exec resume via executable stub, atomic settlement, cleanup.
// Pillar 3: sameDir === 'wait' concurrent exemption for isolated codex tasks + manual skip.
// Pillar 4: dsh-wechat autoDiscover gating (blocked under DSH_HOME sandbox) + Dual-View Cockpit/Backlog client.js checks.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's10-orchestrator-'))
const dshHome = path.join(tmpRoot, 'dsh-home')
const storagesDir = path.join(dshHome, 'storages')
const ledgerFile = path.join(dshHome, 'superagent-ledger.json')
fs.mkdirSync(storagesDir, { recursive: true })

process.env.DSH_HOME = dshHome
process.env.DSH_SUPERAGENT_LEDGER = ledgerFile

const { discoverKnownWorkspaces } = await import('../lib/workspace.js')
const {
  triageIntent,
  triageBacklogWorkspaces,
  restoreBacklogWorkspaces,
} = await import('../lib/triage.js')
const { prepareTaskWorktree, cleanupTaskWorktree } = await import('../lib/worktree.js')
const { resolveNotifyCommand } = await import('../lib/notify.js')
const { planSchedule } = await import('../lib/router.js')
const { createTask, getTask, updateTask } = await import('../lib/ledger.js')
const { createEngine } = await import('../lib/engine.js')
const { handleAction, registerViewRoute } = await import('../lib/route.js')

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// ---------------------------------------------------------------------------
// 1. Real temporary git repo (+ monorepo subpath) & plain repo + storage seeding
// ---------------------------------------------------------------------------
const alphaRepo = path.join(tmpRoot, 'alpha-blog')
const alphaWebSub = path.join(alphaRepo, 'packages', 'web')
const betaRepo = path.join(tmpRoot, 'beta-docs')
fs.mkdirSync(alphaWebSub, { recursive: true })
fs.mkdirSync(betaRepo, { recursive: true })
fs.writeFileSync(path.join(alphaWebSub, 'index.js'), 'export const search = () => "ok"\n')
fs.writeFileSync(path.join(betaRepo, 'README.md'), '# Beta Docs\n')

runGit(['init'], alphaRepo)
runGit(['config', 'user.email', 'test@example.com'], alphaRepo)
runGit(['config', 'user.name', 'Test User'], alphaRepo)
runGit(['add', '.'], alphaRepo)
runGit(['commit', '-m', 'init alpha'], alphaRepo)

fs.writeFileSync(
  path.join(storagesDir, 'workspace.json'),
  JSON.stringify([
    { path: betaRepo, name: 'beta-docs', isOpen: true },
  ], null, 2),
)

// 1a. Workspace discovery merges storage + extraDirs and tags git status
const known = discoverKnownWorkspaces([], {
  extraDirs: [alphaRepo],
  dshHome,
  ledgerFile,
})
assert.ok(known.some(entry => path.basename(entry.path) === 'alpha-blog' && entry.isGitRepo))
assert.ok(known.some(entry => path.basename(entry.path) === 'beta-docs'))

// 1b. Deterministic split + runner recommendation + nod detection
const detPlan = await triageIntent(
  '帮我把 alpha-blog 的搜索卡顿修一下；顺便发布 beta-docs 的上线文档',
  {
    candidates: known,
    codexAvailable: true,
  },
)
assert.equal(detPlan.usedLlm, false)
assert.equal(detPlan.items.length, 2)
assert.equal(path.basename(detPlan.items[0].workspacePath), 'alpha-blog')
assert.equal(detPlan.items[0].runner, 'codex', 'Git repo coding task should prefer codex when available')
assert.equal(path.basename(detPlan.items[1].workspacePath), 'beta-docs')
assert.equal(detPlan.items[1].needsNod, true, 'Publish/release task should flag needsNod')
assert.ok(detPlan.items[0].checklist.length >= 2)

// 1c. Mocked LLM triage strictly rejects hallucinated workspacePath & accepts valid attachToTaskId
const existingActive = createTask({
  title: '完善 beta-docs 说明',
  description: '补充文档章节',
  workspacePath: betaRepo,
}, { file: ledgerFile })

const llmPlan = await triageIntent(
  '在现有 beta-docs 任务里补一条示例，顺便整理 alpha-blog',
  {
    tasks: [existingActive],
    candidates: known,
    codexAvailable: true,
    llmAdapter: {
      ready: true,
      async streamText() {
        return JSON.stringify({
          summary: '已整理 2 件事项',
          items: [
            {
              title: '给 beta-docs 补示例代码',
              description: '补充安装示例并验证可读性',
              workspacePath: '/Users/fake/hallucinated/repo-does-not-exist',
              runner: 'dsh',
              runnerReason: '文案整理用 DSH',
              attachToTaskId: existingActive.id,
              checklist: ['补充示例段落', '检查链接有效'],
            },
            {
              title: '整理 alpha-blog 搜索代码',
              description: '排查搜索逻辑',
              workspacePath: alphaRepo,
              runner: 'codex',
              runnerReason: 'Git 仓独立修改用 Codex',
              checklist: ['定位慢查询', '运行单测'],
            },
          ],
        })
      },
    },
  },
)
assert.equal(llmPlan.usedLlm, true)
assert.equal(llmPlan.items[0].action, 'append')
assert.equal(llmPlan.items[0].attachToTaskId, existingActive.id)
assert.notEqual(llmPlan.items[0].workspacePath, '/Users/fake/hallucinated/repo-does-not-exist')
assert.equal(path.basename(llmPlan.items[1].workspacePath), 'alpha-blog')
assert.equal(llmPlan.items[1].runner, 'codex')

// 1d. Backlog auto-fill + undo snapshot restore
const unsetAlpha = createTask({
  title: '优化 alpha-blog 首屏查询',
  description: '排查 alpha-blog 索引耗时',
  status: 'backlog',
}, { file: ledgerFile })
assert.equal(unsetAlpha.workspacePath, null)

const fillRes = triageBacklogWorkspaces({
  file: ledgerFile,
  extraDirs: [alphaRepo],
  dshHome,
})
assert.equal(fillRes.matchedCount, 1)
assert.equal(path.basename(getTask(unsetAlpha.id, { file: ledgerFile }).workspacePath), 'alpha-blog')

const restoreRes = restoreBacklogWorkspaces(fillRes.snapshot, { file: ledgerFile })
assert.equal(restoreRes.restoredCount, 1)
assert.equal(getTask(unsetAlpha.id, { file: ledgerFile }).workspacePath, null)

// ---------------------------------------------------------------------------
// 2. Monorepo git worktree helper & cleanup
// ---------------------------------------------------------------------------
const wt = prepareTaskWorktree({
  taskId: 't-mono-1',
  workspacePath: alphaWebSub,
  worktreesDir: path.join(dshHome, 'superagent-worktrees'),
})
assert.equal(wt.usedWorktree, true)
assert.equal(wt.subpath, path.join('packages', 'web'))
assert.ok(wt.execCwd.endsWith(path.join('t-mono-1', 'packages', 'web')))
assert.ok(fs.existsSync(path.join(wt.execCwd, 'index.js')))
const cleanedMono = cleanupTaskWorktree({
  worktreeRoot: wt.worktreeRoot,
  repoRoot: wt.repoRoot,
})
assert.equal(cleanedMono.cleaned, true)
assert.equal(fs.existsSync(wt.worktreeRoot), false)

// ---------------------------------------------------------------------------
// 3. Scheduler sameDir === 'wait' exemption for codex + manual skip
// ---------------------------------------------------------------------------
const baseQueueAt = Date.now() - 10_000
const c1 = createTask({ title: 'codex-1', workspacePath: alphaRepo, preferredRunner: 'codex', queue: { auto: true, at: baseQueueAt + 1 } }, { file: ledgerFile })
const c2 = createTask({ title: 'codex-2', workspacePath: alphaRepo, preferredRunner: 'codex', queue: { auto: true, at: baseQueueAt + 2 } }, { file: ledgerFile })
const d1 = createTask({ title: 'dsh-1', workspacePath: betaRepo, preferredRunner: 'dsh', queue: { auto: true, at: baseQueueAt + 3 } }, { file: ledgerFile })
const d2 = createTask({ title: 'dsh-2', workspacePath: betaRepo, preferredRunner: 'dsh', queue: { auto: true, at: baseQueueAt + 4 } }, { file: ledgerFile })
const m1 = createTask({ title: 'manual-1', workspacePath: betaRepo, preferredRunner: 'manual', queue: { auto: true, at: baseQueueAt + 5 } }, { file: ledgerFile })

const plan = planSchedule(
  [c1, c2, d1, d2, m1],
  [],
  { mode: 'auto', maxRunning: 4, sameDir: 'wait' },
  Date.now(),
)
const scheduledIds = plan.startNow
assert.ok(scheduledIds.includes(c1.id), 'codex-1 scheduled')
assert.ok(scheduledIds.includes(c2.id), 'codex-2 scheduled concurrently on same repo (worktree isolated)')
assert.ok(scheduledIds.includes(d1.id), 'dsh-1 scheduled')
assert.ok(!scheduledIds.includes(d2.id), 'dsh-2 waits under sameDir=wait')
assert.ok(!scheduledIds.includes(m1.id), 'manual task never auto-scheduled')

// Clean up scheduler test queue flags so later engine reconcile is focused
for (const tid of [c1.id, c2.id, d1.id, d2.id, m1.id]) {
  updateTask(tid, { status: 'done', queue: null }, { file: ledgerFile })
}

// ---------------------------------------------------------------------------
// 4. Full Engine + Codex CLI stub E2E (exec -> lastStep -> pre-turn/end settlement -> reject resume -> accept -> cleanup)
// ---------------------------------------------------------------------------
const stubLogFile = path.join(tmpRoot, 'codex-invocations.jsonl')
const fakeCodexPath = path.join(tmpRoot, 'fake-codex')
fs.writeFileSync(
  fakeCodexPath,
  `#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const isResume = args[0] === 'exec' && args[1] === 'resume'
const oIdx = args.indexOf('-o')
const outFile = oIdx >= 0 ? args[oIdx + 1] : null
const schemaIdx = args.indexOf('--output-schema')
const schemaFile = schemaIdx >= 0 ? args[schemaIdx + 1] : null
let stdinData = ''
try { stdinData = fs.readFileSync(0, 'utf8') } catch {}
fs.appendFileSync(${JSON.stringify(stubLogFile)}, JSON.stringify({ args, cwd: process.cwd(), hasSchema: Boolean(schemaFile && fs.existsSync(schemaFile)), promptLen: stdinData.length }) + '\\n')

console.log(JSON.stringify({ type: 'thread.started', thread_id: 'th-codex-s10' }))
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: isResume ? 'npm run verify:round2' : 'npm test' } }))

const workFile = path.join(process.cwd(), 'codex-proof.txt')
fs.writeFileSync(workFile, isResume ? 'round2' : 'round1')

if (outFile) {
  const payload = {
    outcome: 'ready',
    summary: isResume ? '已按打回意见补充边界校验并重测通过' : '已完成首轮代码修复并通过单测',
    changedFiles: ['packages/web/index.js', 'codex-proof.txt'],
    risk: null,
    friction: null,
    question: null,
    checklist: [
      { text: '实现改动', done: true, note: isResume ? '补充边界判断' : '完成修改', evidence: 'node --test ok' },
      { text: '验证工作树隔离', done: true, note: 'git status clean', evidence: 'exit 0' },
    ],
  }
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2))
}
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }))
`,
  { mode: 0o755 },
)

const engineFile = path.join(tmpRoot, 'engine-ledger.json')
const engine = createEngine({
  file: engineFile,
  extraDirs: [alphaRepo, betaRepo],
  codexBin: fakeCodexPath,
  adapter: {
    startSession: async () => ({ sessionId: 'dummy-dsh-session' }),
    sendMessage: async () => {},
  },
})

const commitRes = await engine.triageCommit([
  {
    action: 'create',
    title: '用 Codex 在独立 Worktree 修复搜索',
    description: '修改 alpha-blog/packages/web 并跑验证',
    workspacePath: alphaWebSub,
    runner: 'codex',
    checklist: ['实现改动', '验证工作树隔离'],
    later: false,
  },
], { autoQueue: true, startImmediate: true })

assert.equal(commitRes.created.length, 1)
assert.equal(commitRes.started.length, 1)
const codexTaskId = commitRes.created[0].id

await engine.whenCodexIdle()

const afterRound1 = getTask(codexTaskId, { file: engineFile })
assert.equal(afterRound1.status, 'in_review', 'Codex turn should settle task directly into in_review')
const round1Asg = [...(afterRound1.assignments ?? [])].reverse().find(a => a.executor?.kind === 'codex-cli')
assert.equal(round1Asg.executor?.kind, 'codex-cli')
assert.equal(round1Asg.executor?.codexThreadId, 'th-codex-s10')
assert.ok(round1Asg.executor?.worktreePath && fs.existsSync(round1Asg.executor.worktreePath))
assert.ok(round1Asg.lastStep, 'live lastStep should be captured')
const round1Exec = afterRound1.executions?.[afterRound1.executions.length - 1]
assert.ok(round1Exec?.summary?.includes('首轮代码修复'))
assert.ok(Array.isArray(round1Exec?.changedFiles) && round1Exec.changedFiles.length === 2)
assert.ok(afterRound1.checklist.every(item => item.checked === true && item.note && Array.isArray(item.evidence) && item.evidence.length > 0))

// Reject triggers `codex exec resume th-codex-s10`
await engine.rejectTask(codexTaskId, '请补充空输入边界校验', { ifVersion: afterRound1.version })
await engine.whenCodexIdle()

const invocations = fs.readFileSync(stubLogFile, 'utf8').trim().split('\n').map(l => JSON.parse(l))
assert.equal(invocations.length, 2)
assert.ok(invocations[0].args.includes('-C'), 'Initial exec uses -C')
assert.equal(invocations[0].hasSchema, true)
assert.equal(invocations[1].args[0], 'exec')
assert.equal(invocations[1].args[1], 'resume')
assert.ok(invocations[1].args.includes('th-codex-s10'), 'Reject resumes same Codex threadId')
assert.ok(!invocations[1].args.includes('-C'), 'codex exec resume must not pass -C flag')

const afterRound2 = getTask(codexTaskId, { file: engineFile })
assert.equal(afterRound2.status, 'in_review')
const round2Exec = afterRound2.executions?.[afterRound2.executions.length - 1]
assert.ok(round2Exec?.summary?.includes('补充边界校验'))

// Accept & cleanup worktree via route action
await handleAction(engine, { action: 'accept', id: codexTaskId, ifVersion: afterRound2.version })
assert.equal(getTask(codexTaskId, { file: engineFile }).status, 'done')

const wtCleanup = await handleAction(engine, { action: 'worktree_cleanup', id: codexTaskId })
assert.equal(wtCleanup.cleaned, true)
assert.equal(fs.existsSync(round1Asg.executor.worktreePath), false)

// ---------------------------------------------------------------------------
// 5. WeChat auto-discovery gating (disabled under DSH_HOME sandbox, works unsandboxed)
// ---------------------------------------------------------------------------
const fakeWechat = path.join(tmpRoot, 'dsh-wechat.mjs')
const fakeCreds = path.join(os.homedir(), '.local', 'share', 'dsh-wechat', 'credentials.json')
const sandboxedCmd = resolveNotifyCommand({
  env: { DSH_HOME: tmpRoot },
  autoDiscover: true,
  wechatBin: fakeWechat,
})
assert.equal(sandboxedCmd.command, null, 'Sandboxed DSH_HOME must never auto-discover live dsh-wechat')

const stubFs = {
  existsSync(p) {
    return p === fakeWechat || p === fakeCreds || p === '/opt/homebrew/bin/node'
  },
  readdirSync() { return [] },
}
const discoveredCmd = resolveNotifyCommand({
  env: {},
  autoDiscover: true,
  wechatBin: fakeWechat,
  fsImpl: stubFs,
})
assert.deepEqual(discoveredCmd.command, ['/opt/homebrew/bin/node', fakeWechat, 'send', '{title}', '{text}'])

// ---------------------------------------------------------------------------
// 6. Client Dual-View Cockpit vs Backlog & Unset Backlog Triage + Undo
// ---------------------------------------------------------------------------
const clientSource = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
function makeElement() {
  return function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
    return { type, props: props || {}, children }
  }
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(item => walk(item, visit)); return }
  visit(node)
  ;(node.children || []).forEach(child => walk(child, visit))
}
function elementsBy(node, predicate) {
  const hits = []
  walk(node, item => { if (predicate(item)) hits.push(item) })
  return hits
}
function hasClass(node, token) {
  return String(node?.props?.className || '').split(/\s+/).includes(token)
}
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && Array.isArray(node.children)) return textOf(node.children)
  return ''
}
function createHooks() {
  const slotsState = []
  const effects = []
  const refs = []
  let idx = 0, refIdx = 0, effIdx = 0
  return {
    React: {
      Fragment: 'Fragment',
      createElement: makeElement(),
      useState(initial) {
        const i = idx++
        if (!(i in slotsState)) slotsState[i] = typeof initial === 'function' ? initial() : initial
        return [slotsState[i], next => {
          slotsState[i] = typeof next === 'function' ? next(slotsState[i]) : next
        }]
      },
      useEffect(fn, deps) {
        const i = effIdx++
        const prev = effects[i]
        if (!prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps[k]))) {
          if (prev?.cleanup) prev.cleanup()
          effects[i] = { deps: deps || null, cleanup: fn() }
        }
      },
      useRef(initial) {
        const i = refIdx++
        if (!(i in refs)) refs[i] = { current: initial }
        return refs[i]
      },
    },
    reset() { idx = 0; refIdx = 0; effIdx = 0 },
  }
}

async function renderClientView(view, actionHandler) {
  const fetchCalls = []
  const factories = []
  const fetchFn = async (url, opts = {}) => {
    if (url === '/api/superagent/action') {
      const body = JSON.parse(opts.body || '{}')
      fetchCalls.push(body)
      const reply = actionHandler ? actionHandler(body) : view
      return { ok: true, status: 200, json: async () => reply }
    }
    return { ok: true, status: 200, json: async () => view }
  }
  vm.runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load: r => factories.push(r) }, addEventListener: () => {}, removeEventListener: () => {} },
    document: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}, getElementById: () => null, createElement: () => ({}), head: { appendChild: () => {} } },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: fetchFn, URL, URLSearchParams, Promise, Math, Date, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    console: { warn: () => {}, error: () => {} },
  })
  const hooks = createHooks()
  const plugin = factories[0].factory(() => hooks.React)
  const mounted = new Map()
  plugin.apply({
    effect(setup) { setup() },
    get() { return null },
    slots: {
      factory() { return undefined },
      subscribeFactory() { return () => {} },
      inject(_name, reg) { return reg() },
      register(opts, Component) { mounted.set(opts.name, Component); return () => {} },
    },
  })
  const Panel = mounted.get('main')
  const renderNow = () => { hooks.reset(); return Panel({ workspaces: [{ id: 'w1', path: alphaRepo, name: 'alpha-blog' }] }) }
  renderNow()
  await flush()
  await flush()
  return { renderNow, fetchCalls }
}

// 6a. Live route /api/superagent/view includes orchestrator, defaults Panel to Cockpit, renders Live Strip & Review Summary
let registeredViewRoute = null
const connSvc = {
  fetch: {
    register(def) { registeredViewRoute = def; return () => {} },
  },
}
const stopViewRoute = registerViewRoute({
  connection: connSvc,
  get: name => (name === 'connection' ? connSvc : null),
}, { engine })
const liveViewRes = await registeredViewRoute.fetch(new Request('http://localhost/api/superagent/view'))
const liveView = await liveViewRes.json()
stopViewRoute?.()
assert.ok(liveView.orchestrator && liveView.orchestrator.codexAvailable === true)

const cockpitMockView = {
  ...liveView,
  counts: { waiting: 1, running: 1, queued: 0, later: 1, doneToday: 1 },
  groups: {
    waiting: [{
      id: 't-wait-1',
      code: 'SA-11',
      title: '等待拍板的新卡',
      stage: 'review',
      group: 'waiting',
      version: 1,
      workspacePath: alphaRepo,
      workspaceLabel: 'alpha-blog',
      preferredRunner: 'codex',
      executorKind: 'codex-cli',
      worktreeBranch: 'sa/t-wait-1',
      lastSummary: '已完成回归测试并修改两处入口',
      changedFiles: ['client.js', 'lib/route.js'],
      checklist: [{ id: 'c1', text: '跑单测', checked: true, note: 'PASS', evidence: ['node test'] }],
      actions: [{ action: 'accept', label: '通过', primary: true }],
    }],
    running: [{
      id: 't-run-1',
      code: 'SA-12',
      title: 'Codex 正在修工作区',
      stage: 'running',
      group: 'running',
      version: 1,
      workspacePath: betaRepo,
      workspaceLabel: 'beta-docs',
      preferredRunner: 'codex',
      executorKind: 'codex-cli',
      worktreeBranch: 'sa/t-run-1',
      lastStep: '运行: npm test',
      actions: [],
    }],
    queued: [],
    later: [{
      id: 't-later-unset',
      code: 'SA-13',
      title: 'alpha-blog 未定目录老卡',
      stage: 'later',
      group: 'later',
      version: 1,
      workspacePath: null,
      needsWorkspace: true,
      actions: [],
    }],
    doneToday: [],
  },
}

const ui = await renderClientView(cockpitMockView, body => {
  if (body.action === 'triage_backlog') {
    return {
      ...cockpitMockView,
      result: { matchedCount: 1, snapshot: [{ taskId: 't-later-unset', previousWorkspacePath: null, appliedWorkspacePath: alphaRepo }] },
    }
  }
  return cockpitMockView
})

let tree = ui.renderNow()
assert.equal(elementsBy(tree, n => hasClass(n, 'sa2-surface-bar')).length, 1, 'Cockpit surface bar visible')
assert.equal(elementsBy(tree, n => hasClass(n, 'sa2-triage')).length, 1, 'AI Triage composer shown in Cockpit')
assert.ok(textOf(elementsBy(tree, n => hasClass(n, 'sa2-live-strip'))[0]).includes('运行: npm test'), 'Live strip shows running lastStep')
assert.ok(textOf(elementsBy(tree, n => hasClass(n, 'sa2-dec-summary'))[0]).includes('已完成回归测试'), 'Decision summary rendered inline')
assert.equal(elementsBy(tree, n => hasClass(n, 'sa2-dec-file')).length, 2, 'Changed files chips rendered')

// Switch to Backlog -> shows AI 补齐未定目录 -> click -> triggers triage_backlog -> undo triggers triage_backlog_restore
const backlogTab = elementsBy(tree, n => hasClass(n, 'sa2-surf-btn') && textOf(n).includes('选题仓库'))[0]
backlogTab.props.onClick()
tree = ui.renderNow()
const aiFillBtn = elementsBy(tree, n => hasClass(n, 'sa2-fpill') && textOf(n).includes('AI 补齐未定目录'))[0]
assert.ok(aiFillBtn, 'Backlog filter bar displays AI 补齐未定目录 pill')
aiFillBtn.props.onClick()
await flush()
await flush()
assert.equal(ui.fetchCalls[0].action, 'triage_backlog')
tree = ui.renderNow()
const toastUndo = elementsBy(tree, n => hasClass(n, 'sa2-toast'))[0].children.find(c => c && c.type === 'button')
toastUndo.props.onClick()
await flush()
assert.equal(ui.fetchCalls[1].action, 'triage_backlog_restore')

// 6b. View without view.orchestrator falls back directly to Backlog view (backward compat)
const legacyUi = await renderClientView({ ...cockpitMockView, orchestrator: undefined })
const legacyTree = legacyUi.renderNow()
assert.equal(elementsBy(legacyTree, n => hasClass(n, 'sa2-surface-bar')).length, 0)
assert.equal(elementsBy(legacyTree, n => hasClass(n, 'sa2-say')).length, 1)

console.log('s10-v3-orchestrator: ok')
