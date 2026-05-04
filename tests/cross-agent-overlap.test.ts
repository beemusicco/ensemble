import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { detectCrossAgentOverlap } from '../lib/worktree-manager'

/**
 * Set up a tiny git repo with `main` baseline + N feature branches that
 * each modify a known set of files. Returns the basepath. Branches are
 * named `feat/<n>` (no actual worktrees needed for overlap detection —
 * `git diff main...feat/n` just walks commits).
 */
function setupRepo(branches: Record<string, Record<string, string>>): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-'))
  fs.writeFileSync(path.join(dir, 'README.md'), 'baseline\n')
  execSync('git init -q -b main && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm baseline', { cwd: dir })

  for (const [branchName, fileChanges] of Object.entries(branches)) {
    execSync(`git checkout -q -b ${branchName} main`, { cwd: dir })
    for (const [rel, body] of Object.entries(fileChanges)) {
      const full = path.join(dir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
    execSync(`git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm "${branchName} changes"`, { cwd: dir })
  }
  execSync('git checkout -q main', { cwd: dir })

  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

describe('detectCrossAgentOverlap', () => {
  const teardowns: Array<() => void> = []
  afterEach(() => { while (teardowns.length) teardowns.pop()!() })

  it('returns null when fewer than 2 agents', async () => {
    const { dir, cleanup } = setupRepo({
      'feat/a': { 'app/foo.py': 'def a(): pass\n' },
    })
    teardowns.push(cleanup)
    const result = await detectCrossAgentOverlap(
      [{ agentName: 'claude-1', branch: 'feat/a' }],
      dir, 'main',
    )
    expect(result).toBeNull()
  })

  it('returns null when agents touch DIFFERENT files', async () => {
    const { dir, cleanup } = setupRepo({
      'feat/a': { 'app/foo.py': 'def a(): pass\n' },
      'feat/b': { 'app/bar.py': 'def b(): pass\n' },
    })
    teardowns.push(cleanup)
    const result = await detectCrossAgentOverlap(
      [
        { agentName: 'claude-1', branch: 'feat/a' },
        { agentName: 'codex-2', branch: 'feat/b' },
      ],
      dir, 'main',
    )
    expect(result).toBeNull()
  })

  it('detects 2-agent overlap on shared file', async () => {
    const { dir, cleanup } = setupRepo({
      'feat/a': { 'app/shared.py': 'def a_version(): return 1\n' },
      'feat/b': { 'app/shared.py': 'def b_version(): return 2\n' },
    })
    teardowns.push(cleanup)
    const result = await detectCrossAgentOverlap(
      [
        { agentName: 'claude-1', branch: 'feat/a' },
        { agentName: 'codex-2', branch: 'feat/b' },
      ],
      dir, 'main',
    )
    expect(result).not.toBeNull()
    expect(result!.files).toEqual(['app/shared.py'])
    expect(result!.agents.sort()).toEqual(['claude-1', 'codex-2'])
    expect(result!.fileToAgents['app/shared.py'].sort()).toEqual(['claude-1', 'codex-2'])
  })

  it('detects partial overlap in 4-agent quad — only overlapping agents reported', async () => {
    // Mirrors the production R35 saga: 4 agents, 2 of them touch the
    // same critical file, others are clean.
    const { dir, cleanup } = setupRepo({
      'feat/c1': { 'app/critical.py': 'A\n', 'app/exclusive_a.py': 'just A\n' },
      'feat/s2': { 'app/critical.py': 'B\n' },
      'feat/c3': { 'config/paper.yml': 'paper config\n' },
      'feat/c4': { 'app/exclusive_d.py': 'just D\n' },
    })
    teardowns.push(cleanup)
    const result = await detectCrossAgentOverlap(
      [
        { agentName: 'claude-1', branch: 'feat/c1' },
        { agentName: 'sonnet-2', branch: 'feat/s2' },
        { agentName: 'codex-3',  branch: 'feat/c3' },
        { agentName: 'codex-4',  branch: 'feat/c4' },
      ],
      dir, 'main',
    )
    expect(result).not.toBeNull()
    expect(result!.files).toEqual(['app/critical.py'])
    // ONLY claude-1 + sonnet-2 are flagged; codex-3 + codex-4 are NOT.
    expect(result!.agents.sort()).toEqual(['claude-1', 'sonnet-2'])
    // perAgentChanges contains every agent's full file list
    expect(result!.perAgentChanges['codex-3']).toEqual(['config/paper.yml'])
    expect(result!.perAgentChanges['codex-4']).toEqual(['app/exclusive_d.py'])
  })

  it('detects revert-style overlap (reverts and originals touch same file)', async () => {
    // Production failure mode: agent X commits forward changes to file F,
    // agent Y commits a revert that also rewrites file F. Without overlap
    // detection, sequential merge applies X then Y, undoing X cleanly.
    const { dir, cleanup } = setupRepo({
      'feat/forward': { 'app/feature.py': 'def new_feature(): return 42\n' },
      'feat/revert':  { 'app/feature.py': '# reverted — prefer no feature for now\n' },
    })
    teardowns.push(cleanup)
    const result = await detectCrossAgentOverlap(
      [
        { agentName: 'claude-1', branch: 'feat/forward' },
        { agentName: 'codex-4',  branch: 'feat/revert' },
      ],
      dir, 'main',
    )
    expect(result).not.toBeNull()
    expect(result!.files).toContain('app/feature.py')
    expect(result!.agents.sort()).toEqual(['claude-1', 'codex-4'])
  })

  it('detects 3-way overlap (all three agents touched same file)', async () => {
    const { dir, cleanup } = setupRepo({
      'feat/a': { 'app/hot.py': 'A\n' },
      'feat/b': { 'app/hot.py': 'B\n' },
      'feat/c': { 'app/hot.py': 'C\n' },
    })
    teardowns.push(cleanup)
    const result = await detectCrossAgentOverlap(
      [
        { agentName: 'a', branch: 'feat/a' },
        { agentName: 'b', branch: 'feat/b' },
        { agentName: 'c', branch: 'feat/c' },
      ],
      dir, 'main',
    )
    expect(result).not.toBeNull()
    expect(result!.fileToAgents['app/hot.py'].sort()).toEqual(['a', 'b', 'c'])
  })

  it('handles missing branch gracefully (treats as no changes)', async () => {
    const { dir, cleanup } = setupRepo({
      'feat/a': { 'app/foo.py': 'A\n' },
    })
    teardowns.push(cleanup)
    const result = await detectCrossAgentOverlap(
      [
        { agentName: 'claude-1', branch: 'feat/a' },
        { agentName: 'codex-2', branch: 'feat/nonexistent-branch' },
      ],
      dir, 'main',
    )
    // codex-2's branch missing → no files attributed → no overlap
    expect(result).toBeNull()
  })
})
