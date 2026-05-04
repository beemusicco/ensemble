/**
 * Git Worktree Manager — Isolates each agent in its own git worktree
 * to prevent file conflicts when agents write concurrently.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface WorktreeInfo {
  path: string
  branch: string
  agentName: string
}

/**
 * Create an isolated git worktree for an agent.
 * Creates a new branch `collab/<teamId>/<agentName>` from the current HEAD.
 *
 * Also wires the worktree's git config to point hooksPath at the bundled
 * collab-hooks directory so the pre-commit guard for `.collab-protect`
 * runs inside this worktree without modifying the parent repo's hooks.
 */
export async function createWorktree(
  teamId: string,
  agentName: string,
  basePath: string,
): Promise<WorktreeInfo> {
  const branch = `collab/${teamId}/${agentName}`
  const worktreeDir = path.join(basePath, '.worktrees', `${teamId}-${agentName}`)

  // Ensure parent dir exists
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true })

  // Create a new branch + worktree in one step
  await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreeDir], {
    cwd: basePath,
  })

  // Install the .collab-protect pre-commit guard at the worktree level.
  // Path is relative to this lib file; resolve at runtime so it works when
  // the package is shipped (lib/collab-hooks/) or run from source.
  try {
    const hooksDir = path.resolve(__dirname, 'collab-hooks')
    if (fs.existsSync(hooksDir) && fs.existsSync(path.join(hooksDir, 'pre-commit'))) {
      // Make sure pre-commit is executable (might be cleared by `cp` etc.)
      try { fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755) } catch { /* non-fatal */ }
      await execFileAsync('git', ['config', 'core.hooksPath', hooksDir], {
        cwd: worktreeDir,
      })
      console.log(`[Worktree] Wired core.hooksPath → ${hooksDir} for ${agentName}`)
    }
  } catch (err) {
    // Hook install failure must NOT abort worktree creation — without the
    // hook the prompt-level rule is the only protection, but the worktree
    // is still safe to use.
    console.warn(`[Worktree] Failed to install collab-protect hook for ${agentName}:`, err)
  }

  console.log(`[Worktree] Created worktree for ${agentName}: ${worktreeDir} (branch: ${branch})`)
  return { path: worktreeDir, branch, agentName }
}

/**
 * W4: detect cross-agent file-overlap BEFORE merge.
 *
 * Production case (2026-05-04): premium-quad on R35 task. Four agents,
 * three of them (claude-1, sonnet-2, codex-3) added new code; codex-4
 * committed REVERTS of W1/W2/W3 work in their own worktree. When the
 * disband path sequentially merged each branch:
 *
 *   git merge collab/<id>/claude-1   ← OK
 *   git merge collab/<id>/sonnet-2   ← OK (different lines, no conflict)
 *   git merge collab/<id>/codex-3    ← OK
 *   git merge collab/<id>/codex-4    ← revert applies cleanly, undoes 3 above
 *
 * Reverts are designed to apply on top of the original change without
 * conflict — git has no way to tell them apart from "valid forward work."
 * Result: claude-1 + sonnet-2 work silently disappeared from master.
 * Operator had to manually cherry-pick from individual branches.
 *
 * The fix: any time 2+ agents touched the SAME FILE, halt auto-merge for
 * those agents and preserve their branches for operator review. Agents
 * that touched non-overlapping files merge normally.
 *
 * This catches THREE failure modes with one primitive:
 *   - non-conflicting overwrite (same file, different lines, last-write-wins)
 *   - revert stomping (reverts apply cleanly, undo prior merges)
 *   - subtle semantic conflicts that git's text-merger doesn't see
 */
export interface CrossAgentOverlap {
  files: string[]                           // files touched by 2+ agents
  agents: string[]                          // agents involved in the overlap
  perAgentChanges: Record<string, string[]> // per-agent full file list
  fileToAgents: Record<string, string[]>    // who touched what
}

export async function detectCrossAgentOverlap(
  agentBranches: Array<{ agentName: string; branch: string }>,
  basePath: string,
  defaultBranch?: string,
): Promise<CrossAgentOverlap | null> {
  if (agentBranches.length < 2) return null
  const baseRef = defaultBranch ?? (await resolveDefaultBranchRef(basePath)) ?? 'HEAD'

  const perAgent: Record<string, string[]> = {}
  for (const { agentName, branch } of agentBranches) {
    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--name-only', `${baseRef}...${branch}`],
        { cwd: basePath },
      )
      perAgent[agentName] = stdout.trim().split('\n').filter(Boolean)
    } catch {
      perAgent[agentName] = []
    }
  }

  // Invert: file → agents who touched it.
  const fileToAgents: Record<string, string[]> = {}
  for (const [agent, files] of Object.entries(perAgent)) {
    for (const f of files) {
      if (!fileToAgents[f]) fileToAgents[f] = []
      fileToAgents[f].push(agent)
    }
  }

  // Files touched by 2+ agents.
  const overlapFiles = Object.entries(fileToAgents)
    .filter(([, agents]) => agents.length >= 2)
    .map(([f]) => f)
    .sort()
  if (overlapFiles.length === 0) return null

  const overlapAgents = new Set<string>()
  for (const f of overlapFiles) {
    for (const a of fileToAgents[f]) overlapAgents.add(a)
  }

  return {
    files: overlapFiles,
    agents: [...overlapAgents].sort(),
    perAgentChanges: perAgent,
    fileToAgents,
  }
}

/**
 * Classify a single agent branch by its work pattern. Used by the
 * forward-bias autonomous resolver — branches with revert commits or
 * net-negative LOC are demoted in favor of forward-work branches.
 */
export interface BranchClassification {
  branch: string
  agentName: string
  insertions: number
  deletions: number
  netLoc: number              // insertions - deletions
  filesChanged: number
  hasRevertCommit: boolean    // any commit message starts with "Revert" or contains "This reverts commit"
  commitCount: number
}

export async function classifyAgentBranch(
  agentName: string,
  branch: string,
  basePath: string,
  baseBranch?: string,
): Promise<BranchClassification> {
  const baseRef = baseBranch ?? (await resolveDefaultBranchRef(basePath)) ?? 'HEAD'
  let insertions = 0
  let deletions = 0
  let filesChanged = 0
  try {
    const { stdout } = await execFileAsync(
      'git', ['diff', '--shortstat', `${baseRef}...${branch}`],
      { cwd: basePath },
    )
    insertions  = parseInt(stdout.match(/(\d+)\s+insertion/)?.[1] || '0', 10)
    deletions   = parseInt(stdout.match(/(\d+)\s+deletion/)?.[1] || '0', 10)
    filesChanged = parseInt(stdout.match(/(\d+)\s+file/)?.[1] || '0', 10)
  } catch { /* branch missing or no commits — keep zeros */ }

  let hasRevertCommit = false
  let commitCount = 0
  try {
    const { stdout } = await execFileAsync(
      'git', ['log', '--format=%s%n%b%n----COMMIT-END----', `${baseRef}..${branch}`],
      { cwd: basePath },
    )
    commitCount = (stdout.match(/----COMMIT-END----/g) || []).length
    // Match "Revert " at the start of a line (subject prefix), OR
    // "This reverts commit <sha>" anywhere (git revert default body).
    hasRevertCommit = /^Revert\s|^revert\s|^Revert "|This reverts commit /m.test(stdout)
  } catch { /* ignore */ }

  return {
    branch, agentName,
    insertions, deletions,
    netLoc: insertions - deletions,
    filesChanged,
    hasRevertCommit,
    commitCount,
  }
}

/**
 * Forward-bias autonomous resolver. Given an overlap and per-branch
 * classifications, decides which branch to merge (winner) and which
 * to skip (losers). Returns null when there's no clear winner — the
 * caller should fall back to "preserve all" in that case.
 *
 * Rules (in order of evaluation):
 *   1. If exactly one branch has NO revert commits AND others all do,
 *      that branch wins regardless of LOC (clear forward vs revert).
 *   2. Among branches with no revert commits, the one with highest
 *      netLoc wins. Tie-break by filesChanged.
 *   3. Safety: if the winner's netLoc is within 20% of the runner-up
 *      (i.e. close call), return null — preserve all for operator.
 *      Reverts always lose this tie-break (bias against silent undo).
 *   4. If ALL branches have revert commits OR all have netLoc <= 0,
 *      return null — operator must pick.
 */
export interface ResolveOverlapResult {
  winner: string                              // agentName
  winnerReason: string                        // human-readable
  losers: Array<{ agentName: string; reason: string }>
}

export function resolveOverlapByForwardBias(
  classifications: BranchClassification[],
): ResolveOverlapResult | null {
  if (classifications.length < 2) return null

  // Bucket by revert presence.
  const forwardOnly = classifications.filter(c => !c.hasRevertCommit)
  const reverts = classifications.filter(c => c.hasRevertCommit)

  // Rule 1: exactly one forward branch, others all reverts → clear winner.
  if (forwardOnly.length === 1 && reverts.length >= 1) {
    const winner = forwardOnly[0]
    if (winner.netLoc > 0) {
      return {
        winner: winner.agentName,
        winnerReason: `only branch with no revert commits (+${winner.insertions}/-${winner.deletions} LOC across ${winner.filesChanged} files)`,
        losers: reverts.map(c => ({
          agentName: c.agentName,
          reason: `revert commit detected (subject contains "Revert" or body contains "This reverts commit")`,
        })),
      }
    }
  }

  // Rule 4 trigger: all branches reverted or none added net work.
  if (forwardOnly.length === 0) return null
  const positiveForward = forwardOnly.filter(c => c.netLoc > 0)
  if (positiveForward.length === 0) return null

  // Rule 2 + 3: pick highest netLoc among forward, but require margin > 20%
  // over runner-up to avoid auto-picking on close calls.
  const sorted = [...positiveForward].sort((a, b) => {
    if (b.netLoc !== a.netLoc) return b.netLoc - a.netLoc
    return b.filesChanged - a.filesChanged
  })
  const winner = sorted[0]
  const runnerUp = sorted[1]
  if (runnerUp) {
    const margin = (winner.netLoc - runnerUp.netLoc) / Math.max(1, winner.netLoc)
    if (margin < 0.2) {
      // Close call between two forward-work branches — operator decides.
      return null
    }
  }

  const losers: Array<{ agentName: string; reason: string }> = []
  for (const c of classifications) {
    if (c.agentName === winner.agentName) continue
    if (c.hasRevertCommit) {
      losers.push({
        agentName: c.agentName,
        reason: `revert commit detected (winner has +${winner.netLoc} net LOC vs ${c.netLoc})`,
      })
    } else {
      losers.push({
        agentName: c.agentName,
        reason: `lower net work (+${c.netLoc} vs winner's +${winner.netLoc} LOC, >20% margin)`,
      })
    }
  }
  return {
    winner: winner.agentName,
    winnerReason: `highest forward work (+${winner.insertions}/-${winner.deletions} = +${winner.netLoc} net LOC across ${winner.filesChanged} files, no revert commits)`,
    losers,
  }
}

/**
 * Merge changes from a worktree branch back to the target branch.
 * Uses --no-ff to preserve the merge commit for traceability.
 * Returns true if merge succeeded, false if there were conflicts.
 */
export async function mergeWorktree(
  worktreeInfo: WorktreeInfo,
  basePath: string,
  targetBranch?: string,
): Promise<{ success: boolean; conflicts?: string[] }> {
  // Determine what branch to merge into
  const target = targetBranch || await getCurrentBranch(basePath)

  // Check if the worktree branch has any commits ahead of target
  try {
    const { stdout: diffStat } = await execFileAsync(
      'git', ['diff', '--stat', `${target}...${worktreeInfo.branch}`],
      { cwd: basePath },
    )
    if (!diffStat.trim()) {
      console.log(`[Worktree] No changes in ${worktreeInfo.branch}, skipping merge`)
      return { success: true }
    }
  } catch {
    // Branch comparison failed, try merge anyway
  }

  try {
    await execFileAsync(
      'git',
      ['merge', worktreeInfo.branch, '--no-ff', '-m', `collab: merge ${worktreeInfo.agentName} work`],
      { cwd: basePath },
    )
    console.log(`[Worktree] Merged ${worktreeInfo.branch} into ${target}`)
    return { success: true }
  } catch (err: unknown) {
    const message = err instanceof Error ? (err as Error & { stderr?: string }).stderr || err.message : String(err)
    console.error(`[Worktree] Merge conflict for ${worktreeInfo.branch}:`, message)

    // Get list of conflicted files
    try {
      const { stdout } = await execFileAsync(
        'git', ['diff', '--name-only', '--diff-filter=U'],
        { cwd: basePath },
      )
      const conflicts = stdout.trim().split('\n').filter(Boolean)

      // Abort the failed merge
      await execFileAsync('git', ['merge', '--abort'], { cwd: basePath })
      return { success: false, conflicts }
    } catch {
      // If we can't even get conflicts, abort and report
      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd: basePath })
      } catch { /* already clean */ }
      return { success: false, conflicts: ['unknown — merge aborted'] }
    }
  }
}

/**
 * W2.5m bulletproof primitive — per-worktree disposition evaluator.
 *
 * Replaces the W2.5f blanket "completion-confirmed → destroy ALL else
 * preserve ALL" decision. The disband reason gates auto-merge only;
 * destroy vs. preserve is decided per-worktree based on real-work signals.
 *
 * Production case (2026-05-03): 7 worktrees in crypto-trading-platform
 * accumulated 122 GB because non-completion-confirmed disband preserved
 * even fully-clean trees that had zero work. 5 of 7 had no commits and
 * no uncommitted changes — they were dead weight.
 *
 * Same evaluator is used by:
 *   - disbandTeam (per-agent decision after merge attempt)
 *   - scripts/worktree-gc.sh (operator-driven sweep across all repos)
 *
 * Decisions (most-conservative wins):
 *   1. PRESERVE-MERGE-CONFLICT — caller passed mergeFailed=true
 *   2. PRESERVE-UNCOMMITTED    — `git status --porcelain` non-empty
 *   3. PRESERVE-COMMITS        — HEAD has commits NOT in default branch
 *   4. DESTROY                 — clean state + HEAD already in default branch
 *
 * Default branch resolution: try `main` (refs/heads/main) first, then
 * `master`, fallback to whatever the parent repo says is HEAD.
 */
export type WorktreeDisposition =
  | { action: 'destroy' }
  | { action: 'preserve'; why: 'uncommitted' | 'commits-not-merged' | 'merge-conflict' | 'eval-error'; detail?: string }

interface EvaluateInput {
  worktreePath: string
  basePath: string
  mergeFailed?: boolean
}

async function resolveDefaultBranchRef(basePath: string): Promise<string | null> {
  for (const ref of ['main', 'master']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], {
        cwd: basePath,
      })
      return ref
    } catch { /* try next */ }
  }
  // Fallback to whatever HEAD points at in the parent repo (rare).
  try {
    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: basePath })
    return stdout.trim() || null
  } catch {
    return null
  }
}

export async function evaluateWorktreeDisposition(input: EvaluateInput): Promise<WorktreeDisposition> {
  const { worktreePath, basePath, mergeFailed } = input

  // Tier 1: caller-supplied merge-conflict signal — preserve, decision done.
  if (mergeFailed) {
    return { action: 'preserve', why: 'merge-conflict' }
  }

  // Tier 2: uncommitted check.
  let porcelain = ''
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreePath })
    porcelain = stdout.trim()
  } catch (err) {
    // Can't even run git status — be conservative and preserve.
    return { action: 'preserve', why: 'eval-error', detail: (err as Error).message?.slice(0, 200) }
  }
  if (porcelain) {
    return { action: 'preserve', why: 'uncommitted', detail: porcelain.slice(0, 500) }
  }

  // Tier 3: commits-not-merged check (HEAD ancestor of default branch?)
  const defaultRef = await resolveDefaultBranchRef(basePath)
  if (!defaultRef) {
    // Parent repo has no clear default branch — preserve to be safe.
    return { action: 'preserve', why: 'eval-error', detail: 'no default branch in parent' }
  }
  let head = ''
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
    head = stdout.trim()
  } catch (err) {
    return { action: 'preserve', why: 'eval-error', detail: 'cannot resolve HEAD' }
  }
  try {
    // is-ancestor exits 0 if true, 1 if false, other if error
    await execFileAsync('git', ['merge-base', '--is-ancestor', head, defaultRef], { cwd: basePath })
    // Exit 0 → HEAD is ancestor → fully merged → safe to destroy.
    return { action: 'destroy' }
  } catch (err) {
    const code = (err as { code?: number }).code
    if (code === 1) {
      // HEAD has commits not in default branch → preserve.
      return { action: 'preserve', why: 'commits-not-merged' }
    }
    // Other error (rare — corrupted ref, etc.) → preserve conservatively.
    return { action: 'preserve', why: 'eval-error', detail: (err as Error).message?.slice(0, 200) }
  }
}

/**
 * Check whether a worktree has uncommitted work (modified, staged, or
 * untracked files). Used by the disband path to preserve worktrees agents
 * left in an in-flight state instead of silently nuking their changes.
 *
 * Returns the porcelain output trimmed (empty string = fully clean).
 *
 * Kept for back-compat with disbandTeam. New code should prefer
 * evaluateWorktreeDisposition() which makes the full decision.
 */
export async function uncommittedChanges(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain'],
      { cwd: worktreePath },
    )
    return stdout.trim()
  } catch {
    // If we can't run git status, conservatively say "no uncommitted" so the
    // disband path doesn't get blocked. Real failures land in the destroy
    // step's existing error path.
    return ''
  }
}

/**
 * Remove a worktree and optionally delete its branch.
 */
export async function destroyWorktree(
  worktreeInfo: WorktreeInfo,
  basePath: string,
  deleteBranch = true,
): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'remove', worktreeInfo.path, '--force'], {
      cwd: basePath,
    })
    console.log(`[Worktree] Removed worktree at ${worktreeInfo.path}`)
  } catch (err) {
    // Worktree may already be gone
    console.warn(`[Worktree] Could not remove worktree ${worktreeInfo.path}:`, err)
    // Try manual cleanup if the dir exists
    if (fs.existsSync(worktreeInfo.path)) {
      fs.rmSync(worktreeInfo.path, { recursive: true, force: true })
    }
    // Prune stale worktree entries
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: basePath })
    } catch { /* non-fatal */ }
  }

  if (deleteBranch) {
    try {
      await execFileAsync('git', ['branch', '-D', worktreeInfo.branch], {
        cwd: basePath,
      })
      console.log(`[Worktree] Deleted branch ${worktreeInfo.branch}`)
    } catch {
      // Branch may already be gone or not fully merged — that's OK after force remove
    }
  }
}

/**
 * Get the current branch name for a repo.
 */
async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: repoPath },
  )
  return stdout.trim()
}

/**
 * List all active worktrees for a given team.
 */
export async function listTeamWorktrees(
  teamId: string,
  basePath: string,
): Promise<WorktreeInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['worktree', 'list', '--porcelain'],
      { cwd: basePath },
    )

    const worktrees: WorktreeInfo[] = []
    const entries = stdout.split('\n\n')

    for (const entry of entries) {
      const branchMatch = entry.match(/branch refs\/heads\/(collab\/[^\n]+)/)
      const pathMatch = entry.match(/^worktree (.+)$/m)
      if (branchMatch && pathMatch) {
        const branch = branchMatch[1]
        if (branch.startsWith(`collab/${teamId}/`)) {
          const agentName = branch.replace(`collab/${teamId}/`, '')
          worktrees.push({ path: pathMatch[1], branch, agentName })
        }
      }
    }

    return worktrees
  } catch {
    return []
  }
}
