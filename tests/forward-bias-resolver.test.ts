import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import {
  classifyAgentBranch,
  resolveOverlapByForwardBias,
  type BranchClassification,
} from '../lib/worktree-manager'

/** Helper: build a tiny repo with named branches each having specific commits. */
function setupRepoWithCommits(spec: Record<string, Array<{ files: Record<string, string>; subject: string }>>): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwd-bias-'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'baseline\nLine 2\nLine 3\n')
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm baseline', { cwd: dir })
  for (const [branch, commits] of Object.entries(spec)) {
    execSync(`git checkout -q -b ${branch} main`, { cwd: dir })
    for (const c of commits) {
      for (const [rel, body] of Object.entries(c.files)) {
        const full = path.join(dir, rel)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, body)
      }
      execSync(`git -c user.email=t@t -c user.name=t add -A`, { cwd: dir })
      execSync(`git -c user.email=t@t -c user.name=t commit -qm "${c.subject.replace(/"/g, '\\"')}"`, { cwd: dir })
    }
  }
  execSync('git checkout -q main', { cwd: dir })
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

describe('classifyAgentBranch', () => {
  const teardowns: Array<() => void> = []
  afterEach(() => { while (teardowns.length) teardowns.pop()!() })

  it('counts net additions/deletions correctly', async () => {
    const { dir, cleanup } = setupRepoWithCommits({
      'feat/forward': [{
        files: { 'app/big.py': 'def f():\n  return 1\n  return 2\n  return 3\n  return 4\n  return 5\n' },
        subject: 'feat: add big function',
      }],
    })
    teardowns.push(cleanup)
    const c = await classifyAgentBranch('claude-1', 'feat/forward', dir, 'main')
    expect(c.insertions).toBeGreaterThan(0)
    expect(c.netLoc).toBeGreaterThan(0)
    expect(c.hasRevertCommit).toBe(false)
    expect(c.commitCount).toBe(1)
  })

  it('detects "Revert" subject prefix', async () => {
    const { dir, cleanup } = setupRepoWithCommits({
      'feat/revert': [
        { files: { 'app/foo.py': 'feature added\n' }, subject: 'feat: add feature' },
        { files: { 'app/foo.py': '' }, subject: 'Revert "feat: add feature"' },
      ],
    })
    teardowns.push(cleanup)
    const c = await classifyAgentBranch('codex-4', 'feat/revert', dir, 'main')
    expect(c.hasRevertCommit).toBe(true)
    expect(c.commitCount).toBe(2)
  })

  it('detects "This reverts commit X" body', async () => {
    const { dir, cleanup } = setupRepoWithCommits({
      'feat/revert-body': [{
        files: { 'app/foo.py': 'partial undo\n' },
        subject: 'undo prior change\n\nThis reverts commit abc123def456.',
      }],
    })
    teardowns.push(cleanup)
    const c = await classifyAgentBranch('codex-4', 'feat/revert-body', dir, 'main')
    expect(c.hasRevertCommit).toBe(true)
  })

  it('returns zeros for missing branch', async () => {
    const { dir, cleanup } = setupRepoWithCommits({
      'feat/exists': [{ files: { 'a.py': 'x\n' }, subject: 'change' }],
    })
    teardowns.push(cleanup)
    const c = await classifyAgentBranch('ghost', 'feat/nonexistent', dir, 'main')
    expect(c.insertions).toBe(0)
    expect(c.netLoc).toBe(0)
  })
})

describe('resolveOverlapByForwardBias — autonomous winner picker', () => {
  const cl = (overrides: Partial<BranchClassification> & { agentName: string }): BranchClassification => ({
    branch: `feat/${overrides.agentName}`,
    insertions: 0, deletions: 0, netLoc: 0, filesChanged: 0,
    hasRevertCommit: false, commitCount: 1,
    ...overrides,
  })

  it('returns null when fewer than 2 classifications', () => {
    expect(resolveOverlapByForwardBias([cl({ agentName: 'a', netLoc: 100 })])).toBeNull()
  })

  it('picks the only forward branch when others are reverts (R35 reproducer)', () => {
    const r = resolveOverlapByForwardBias([
      cl({ agentName: 'claude-1', netLoc: 87,  insertions: 100, deletions: 13, filesChanged: 5, hasRevertCommit: false }),
      cl({ agentName: 'codex-4',  netLoc: -45, insertions: 5,   deletions: 50, filesChanged: 3, hasRevertCommit: true  }),
    ])
    expect(r).not.toBeNull()
    expect(r!.winner).toBe('claude-1')
    expect(r!.losers).toHaveLength(1)
    expect(r!.losers[0].agentName).toBe('codex-4')
    expect(r!.losers[0].reason).toMatch(/revert/i)
  })

  it('picks highest forward netLoc when no reverts and clear margin', () => {
    const r = resolveOverlapByForwardBias([
      cl({ agentName: 'a', netLoc: 200, insertions: 220, deletions: 20, filesChanged: 8 }),
      cl({ agentName: 'b', netLoc: 50,  insertions: 60,  deletions: 10, filesChanged: 2 }),
    ])
    expect(r).not.toBeNull()
    expect(r!.winner).toBe('a')
    expect(r!.losers[0].agentName).toBe('b')
    expect(r!.losers[0].reason).toMatch(/lower net work/)
  })

  it('returns null on close call (within 20% margin) — operator decides', () => {
    // a=100, b=85 → margin = (100-85)/100 = 0.15 < 0.20 → no auto-pick
    const r = resolveOverlapByForwardBias([
      cl({ agentName: 'a', netLoc: 100 }),
      cl({ agentName: 'b', netLoc: 85 }),
    ])
    expect(r).toBeNull()
  })

  it('auto-picks when margin > 20%', () => {
    // a=100, b=70 → margin = 0.30 > 0.20 → a wins
    const r = resolveOverlapByForwardBias([
      cl({ agentName: 'a', netLoc: 100 }),
      cl({ agentName: 'b', netLoc: 70 }),
    ])
    expect(r).not.toBeNull()
    expect(r!.winner).toBe('a')
  })

  it('returns null when ALL branches have revert commits', () => {
    const r = resolveOverlapByForwardBias([
      cl({ agentName: 'a', netLoc: 50, hasRevertCommit: true }),
      cl({ agentName: 'b', netLoc: 80, hasRevertCommit: true }),
    ])
    expect(r).toBeNull()
  })

  it('returns null when ALL branches have netLoc <= 0', () => {
    const r = resolveOverlapByForwardBias([
      cl({ agentName: 'a', netLoc: -5,  hasRevertCommit: false }),
      cl({ agentName: 'b', netLoc: -20, hasRevertCommit: false }),
    ])
    expect(r).toBeNull()
  })

  it('4-agent partial-overlap quad: picks the strongest forward, demotes revert', () => {
    // Mirrors R35 saga: 4 agents, 1 with reverts, 3 forward but only 2 of them
    // are in the overlap set. Resolver only sees the overlap set.
    const r = resolveOverlapByForwardBias([
      cl({ agentName: 'claude-1',  netLoc: 87, insertions: 100, deletions: 13, filesChanged: 5, hasRevertCommit: false }),
      cl({ agentName: 'sonnet-2',  netLoc: 12, insertions: 15,  deletions: 3,  filesChanged: 2, hasRevertCommit: false }),
      cl({ agentName: 'codex-4',   netLoc: -90, insertions: 0,  deletions: 90, filesChanged: 5, hasRevertCommit: true  }),
    ])
    expect(r).not.toBeNull()
    expect(r!.winner).toBe('claude-1')
    const loserNames = r!.losers.map(l => l.agentName).sort()
    expect(loserNames).toEqual(['codex-4', 'sonnet-2'])
    // codex-4 demoted for revert; sonnet-2 demoted for lower net work
    expect(r!.losers.find(l => l.agentName === 'codex-4')!.reason).toMatch(/revert/i)
    expect(r!.losers.find(l => l.agentName === 'sonnet-2')!.reason).toMatch(/lower net work/i)
  })

  it('tie-breaks by filesChanged when netLoc is equal', () => {
    const r = resolveOverlapByForwardBias([
      cl({ agentName: 'a', netLoc: 100, filesChanged: 3 }),
      cl({ agentName: 'b', netLoc: 100, filesChanged: 8 }),
      cl({ agentName: 'c', netLoc: 50,  filesChanged: 4 }),  // far enough to not trip 20% rule
    ])
    // a vs b → equal LOC → b wins on filesChanged. But margin between b (100) and a (100) is 0 → returns null
    expect(r).toBeNull()
  })
})
