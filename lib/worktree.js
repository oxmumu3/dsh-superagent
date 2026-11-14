// dsh-superagent worktree — Isolated git worktrees for parallel Codex runs.
//
// Each Codex task inside a git repository gets its own worktree under
// `<dshHome>/superagent-worktrees/<taskId>` on branch `sa/<taskId>`, while
// preserving the relative `subpath` when the task targets a subdirectory of a
// monorepo or workspace root. Non-git directories fall back safely to running
// directly in `workspacePath`.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { validateWorkspacePath } from './workspace.js'

const GIT_TIMEOUT_MS = 10_000

function safeIdSegment(taskId) {
  return String(taskId ?? 'task')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'task'
}

export function resolveWorktreeBase(options = {}) {
  const base = options.dshHome
    || process.env.DSH_HOME
    || (options.ledgerFile ? path.dirname(options.ledgerFile) : path.join(os.homedir(), '.dsh'))
  return path.join(base, 'superagent-worktrees')
}

function runGitSync(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function inspectGitRepo(workspacePath) {
  const validPath = validateWorkspacePath(workspacePath)
  let repoRoot = null
  try {
    repoRoot = runGitSync(['rev-parse', '--show-toplevel'], validPath)
  } catch {
    return {
      isGitRepo: false,
      repoRoot: null,
      hasCommit: false,
      subpath: '',
      dirty: false,
      reason: '目录不是 Git 仓库，直接使用原目录执行',
    }
  }

  let realValid = validPath
  let realRoot = repoRoot
  try {
    realValid = fs.realpathSync(validPath)
    realRoot = fs.realpathSync(repoRoot)
  } catch {
    // Keep logical paths if realpath fails.
  }
  const rel = path.relative(realRoot, realValid)
  const subpath = rel && rel !== '.' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : ''

  let hasCommit = false
  try {
    runGitSync(['rev-parse', '--verify', 'HEAD'], repoRoot)
    hasCommit = true
  } catch {
    hasCommit = false
  }

  let dirty = false
  try {
    dirty = Boolean(runGitSync(['status', '--porcelain', '--untracked-files=no'], repoRoot))
  } catch {
    dirty = false
  }

  if (!hasCommit) {
    return {
      isGitRepo: true,
      repoRoot,
      hasCommit: false,
      subpath,
      dirty,
      reason: 'Git 仓库尚无首次提交，无法拉出 Worktree，回退到原目录执行',
    }
  }

  return {
    isGitRepo: true,
    repoRoot,
    hasCommit: true,
    subpath,
    dirty,
    reason: null,
  }
}

export function prepareTaskWorktree(input = {}) {
  const validPath = validateWorkspacePath(input.workspacePath)
  const info = inspectGitRepo(validPath)
  if (!info.isGitRepo || !info.hasCommit) {
    return {
      usedWorktree: false,
      worktreeRoot: null,
      execCwd: validPath,
      branch: null,
      repoRoot: info.repoRoot,
      subpath: info.subpath,
      dirtyMainRepo: info.dirty,
      reason: info.reason,
    }
  }

  const baseDir = input.worktreesDir || resolveWorktreeBase(input)
  fs.mkdirSync(baseDir, { recursive: true })
  const slug = safeIdSegment(input.taskId)
  const worktreeRoot = path.join(baseDir, slug)
  const desiredBranch = input.branch || `sa/${slug}`

  // Reuse an already provisioned valid worktree for the same task id.
  if (fs.existsSync(worktreeRoot)) {
    try {
      const check = runGitSync(['rev-parse', '--is-inside-work-tree'], worktreeRoot)
      if (check === 'true') {
        const currentBranch = runGitSync(['rev-parse', '--abbrev-ref', 'HEAD'], worktreeRoot)
        const execCwd = info.subpath ? path.join(worktreeRoot, info.subpath) : worktreeRoot
        if (!fs.existsSync(execCwd)) fs.mkdirSync(execCwd, { recursive: true })
        return {
          usedWorktree: true,
          reused: true,
          worktreeRoot,
          execCwd,
          branch: currentBranch === 'HEAD' ? desiredBranch : currentBranch,
          repoRoot: info.repoRoot,
          subpath: info.subpath,
          dirtyMainRepo: info.dirty,
          reason: null,
        }
      }
    } catch {
      fs.rmSync(worktreeRoot, { recursive: true, force: true })
    }
  }

  try {
    runGitSync(['worktree', 'prune'], info.repoRoot)
  } catch {
    // Prune is best-effort.
  }

  let branchUsed = desiredBranch
  try {
    runGitSync(['worktree', 'add', '-B', desiredBranch, worktreeRoot, 'HEAD'], info.repoRoot)
  } catch {
    // Fallback if desiredBranch is checked out in another active worktree.
    branchUsed = `sa/${slug}-${Date.now().toString(36)}`
    try {
      runGitSync(['worktree', 'add', '-b', branchUsed, worktreeRoot, 'HEAD'], info.repoRoot)
    } catch {
      branchUsed = 'HEAD (detached)'
      runGitSync(['worktree', 'add', '--detach', worktreeRoot, 'HEAD'], info.repoRoot)
    }
  }

  const execCwd = info.subpath ? path.join(worktreeRoot, info.subpath) : worktreeRoot
  if (!fs.existsSync(execCwd)) fs.mkdirSync(execCwd, { recursive: true })

  return {
    usedWorktree: true,
    reused: false,
    worktreeRoot,
    execCwd,
    branch: branchUsed,
    repoRoot: info.repoRoot,
    subpath: info.subpath,
    dirtyMainRepo: info.dirty,
    reason: null,
  }
}

export function inspectWorktreeSummary(worktreeRoot) {
  if (!worktreeRoot || !fs.existsSync(worktreeRoot)) return null
  try {
    const status = runGitSync(['status', '--short'], worktreeRoot)
    const files = status
      ? status.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      : []
    const head = runGitSync(['rev-parse', '--short', 'HEAD'], worktreeRoot)
    return { head, changedCount: files.length, statusLines: files.slice(0, 20) }
  } catch {
    return null
  }
}

export function cleanupTaskWorktree(input = {}) {
  const worktreeRoot = input.worktreeRoot
  const repoRoot = input.repoRoot
  const branch = input.branch
  if (repoRoot && worktreeRoot && fs.existsSync(repoRoot)) {
    try {
      runGitSync(['worktree', 'remove', '--force', worktreeRoot], repoRoot)
    } catch {
      // Ignore if worktree metadata was already pruned.
    }
    try {
      runGitSync(['worktree', 'prune'], repoRoot)
    } catch {
      // Ignore prune failures.
    }
    if (input.deleteBranch && branch && !String(branch).startsWith('HEAD')) {
      try {
        runGitSync(['branch', '-D', branch], repoRoot)
      } catch {
        // Ignore branch deletion failures.
      }
    }
  }
  if (worktreeRoot && fs.existsSync(worktreeRoot)) {
    fs.rmSync(worktreeRoot, { recursive: true, force: true })
  }
  return { cleaned: true }
}
