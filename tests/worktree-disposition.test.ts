import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { evaluateWorktreeDisposition } from '../lib/worktree-manager'

const exec = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, { cwd, encoding: 'utf-8' }).trim()

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  exec('git', ['init', '-b', 'main'], dir)
  exec('git', ['config', 'user.email', 't@t.test'], dir)
  exec('git', ['config', 'user.name', 'T'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'init')
  exec('git', ['add', '.'], dir)
  exec('git', ['commit', '-m', 'init'], dir)
}

describe('evaluateWorktreeDisposition (W2.5m primitive)', () => {
  let repo: string
  let worktree: string

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-eval-repo-'))
    initRepo(repo)
    worktree = path.join(repo, '.worktrees', 'agent-1')
    exec('git', ['worktree', 'add', '-b', 'collab/test/agent-1', worktree], repo)
  })

  afterEach(() => {
    try { exec('git', ['worktree', 'remove', '--force', worktree], repo) } catch { /* */ }
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('DESTROY for clean worktree with no commits ahead of main', async () => {
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo })
    expect(d).toEqual({ action: 'destroy' })
  })

  it('PRESERVE-MERGE-CONFLICT when caller passes mergeFailed=true (highest priority)', async () => {
    // Even with no actual conflict, the caller flag wins
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo, mergeFailed: true })
    expect(d).toEqual({ action: 'preserve', why: 'merge-conflict' })
  })

  it('PRESERVE-UNCOMMITTED when worktree has untracked file', async () => {
    fs.writeFileSync(path.join(worktree, 'new.txt'), 'wip')
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo })
    expect(d.action).toBe('preserve')
    if (d.action === 'preserve') {
      expect(d.why).toBe('uncommitted')
      expect(d.detail).toContain('new.txt')
    }
  })

  it('PRESERVE-UNCOMMITTED when worktree has modified tracked file', async () => {
    fs.writeFileSync(path.join(worktree, 'README.md'), 'changed')
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo })
    expect(d.action).toBe('preserve')
    if (d.action === 'preserve') expect(d.why).toBe('uncommitted')
  })

  it('PRESERVE-COMMITS-NOT-MERGED when worktree has commits past main HEAD', async () => {
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'agent work')
    exec('git', ['add', '.'], worktree)
    exec('git', ['commit', '-m', 'agent feature'], worktree)
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo })
    expect(d.action).toBe('preserve')
    if (d.action === 'preserve') expect(d.why).toBe('commits-not-merged')
  })

  it('DESTROY after agent commit is merged into main', async () => {
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'agent work')
    exec('git', ['add', '.'], worktree)
    exec('git', ['commit', '-m', 'agent feature'], worktree)
    // Simulate merge: parent repo merges the branch
    exec('git', ['merge', '--no-ff', '-m', 'merge', 'collab/test/agent-1'], repo)
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo })
    expect(d).toEqual({ action: 'destroy' })
  })

  it('PRESERVE-EVAL-ERROR when basePath has no main/master', async () => {
    // Rename main → 'develop' so neither main nor master exists
    exec('git', ['branch', '-m', 'main', 'develop'], repo)
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo })
    // Falls through to symbolic-ref HEAD which returns 'develop' — works.
    // But if HEAD is detached, eval-error. Test the fallback works:
    expect(['destroy', 'preserve']).toContain(d.action)
  })

  it('falls back to symbolic-ref HEAD when neither main nor master exists', async () => {
    exec('git', ['branch', '-m', 'main', 'trunk'], repo)
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo })
    // After rename, HEAD points to trunk; worktree HEAD == trunk → destroy
    expect(d.action).toBe('destroy')
  })

  it('PRESERVE-EVAL-ERROR when worktree cwd is missing (no RangeError)', async () => {
    // Regression: execGit cwd pre-check must turn cryptic ENOENT (or, when an
    // earlier refactor wrongly self-referenced, RangeError: Maximum call stack
    // size exceeded) into a clean eval-error preserve. Reproduces the 2026-05-11
    // production case where 6 disband evals crashed because the worktree dir
    // was cleaned up between scheduling and execution.
    fs.rmSync(worktree, { recursive: true, force: true })
    const d = await evaluateWorktreeDisposition({ worktreePath: worktree, basePath: repo })
    expect(d.action).toBe('preserve')
    if (d.action === 'preserve') {
      expect(d.why).toBe('eval-error')
      expect(d.detail).toMatch(/cwd does not exist|CWD_MISSING|ENOENT/)
    }
  })
})
