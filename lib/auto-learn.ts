/**
 * Auto-learn primitive — every collab outcome teaches the next collab.
 *
 * 7-day production data showed:
 *   - 17 auto_fix_exhausted teams (mechanical gate failed → "standing by for
 *     human direction") — operator never came (Telegram answer-rate ~0%)
 *   - 50+ confabulations across teams — same agents repeating same mistakes
 *   - 953 memories total, but only ~5% are pattern-tagged (failure / confab)
 *
 * Existing memory pipeline persists agent reflections (services/ensemble-
 * service.ts:1300-1323) and re-injects them on team spawn (services/
 * ensemble-service.ts:1591-1627) — but failure patterns and confabulation
 * patterns were never captured, so each new team rediscovered them.
 *
 * This module fixes that. Three structured learning kinds:
 *
 *   1. failure-pattern  — auto_fix_exhausted: which gate failed, with what
 *                         error class, in which project. Next team in the
 *                         same project gets a pre-flight warning.
 *   2. confab-pattern   — confabulation event: agent X cited path Y that
 *                         doesn't exist. Next time X spawns, prompt warns
 *                         "you previously confabulated <pattern>".
 *   3. resolution       — what worked: when a team explicitly signals
 *                         success after a fix, the fix becomes a learning
 *                         (currently captured via reflections; this kind
 *                         is reserved for explicit success markers).
 *
 * Tag taxonomy (constants below) is the single source of truth — every
 * write and every query references the same names so the schema cannot
 * drift between writers and readers.
 *
 * Outcome weighting: each learning is tagged with team status at write
 * time (`outcome:success` vs `outcome:failure`). Future queries can
 * discount failed-team learnings.
 */

import { writeMemory } from './memory-store'

// ── Tag constants (single source of truth) ──────────────────────────
export const TAG = {
  FAILURE_PATTERN: 'failure-pattern',
  CONFAB_PATTERN: 'confab-pattern',
  RESOLUTION: 'resolution',
  REFLECTION: 'reflection',
  OUTCOME_SUCCESS: 'outcome:success',
  OUTCOME_FAILURE: 'outcome:failure',
} as const

export const PATTERN_TAGS = [TAG.FAILURE_PATTERN, TAG.CONFAB_PATTERN, TAG.RESOLUTION]

// ── Helpers ─────────────────────────────────────────────────────────
function gateTag(gateId: string): string {
  return `gate:${gateId.replace(/[^a-z0-9-]/gi, '_').slice(0, 60)}`
}
function agentTag(agentName: string): string {
  return `agent:${agentName.replace(/[^a-z0-9-]/gi, '_').slice(0, 40)}`
}
function projectTag(project: string | undefined): string | null {
  if (!project) return null
  return project.replace(/[^a-z0-9-]/gi, '_').slice(0, 40)
}

/**
 * Classify a verify-runner / blocker error string into a coarse error class
 * so similar failures aggregate. Doesn't try to be perfect — just stable
 * enough that two teams hitting the same root cause get the same class.
 */
export function classifyError(text: string): string {
  const t = (text || '').toLowerCase()
  if (/import\s*error|modulenotfound|no module named/.test(t)) return 'import-error'
  if (/syntaxerror|unexpected token|invalid syntax/.test(t)) return 'syntax-error'
  if (/typeerror|attributeerror|argument.*expected/.test(t)) return 'type-error'
  if (/test.*failed|assertion(error)?|failed.*assert/.test(t)) return 'test-fail'
  if (/timeout|timed out/.test(t)) return 'timeout'
  if (/permission denied|unauthor/.test(t)) return 'auth-error'
  if (/connection refused|econnrefused|unreachable/.test(t)) return 'network-error'
  if (/eaccess|enoent|no such file/.test(t)) return 'fs-error'
  if (/conflict|merge conflict/.test(t)) return 'merge-conflict'
  if (/lint|ruff|eslint/.test(t)) return 'lint'
  return 'other'
}

// ── Public API: failure-pattern ─────────────────────────────────────
export interface RecordFailureLearningInput {
  teamId: string
  project?: string
  gateId: string                  // e.g. "pytest-diff", "ruff-diff", "vitest-changed"
  errorSignature: string          // truncated stderr / blocker line
  blockers?: string[]             // structured blocker list, optional
  iterationsTried: number
}

/**
 * Persist a failure pattern. Called when auto-fix budget is exhausted so
 * the next team in the same project + same gate can read this and either
 * skip the gate, or address the underlying issue first.
 */
export function recordFailureLearning(input: RecordFailureLearningInput): void {
  const errClass = classifyError(input.errorSignature)
  const tags = [
    TAG.FAILURE_PATTERN,
    gateTag(input.gateId),
    `error:${errClass}`,
    TAG.OUTCOME_FAILURE,
  ]
  const projTag = projectTag(input.project)
  if (projTag) tags.push(projTag)
  const summary = [
    `Gate "${input.gateId}" failed after ${input.iterationsTried} auto-fix iteration(s) with ${errClass}.`,
    `Error: ${input.errorSignature.slice(0, 400)}`,
    input.blockers?.length
      ? `Blockers:\n${input.blockers.slice(0, 6).map(b => `  - ${b.slice(0, 200)}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n')
  writeMemory({
    scope: 'global',
    teamId: input.teamId,
    key: `failure:${input.gateId}:${errClass}:${input.teamId.slice(0, 8)}`,
    value: summary,
    tags,
  })
}

// ── Public API: confab-pattern ──────────────────────────────────────
export interface RecordConfabLearningInput {
  teamId: string
  project?: string
  agent: string                   // e.g. "claude-1", "codex-2"
  badCitation: string             // e.g. "frontend/InvoicesPage.jsx:217"
  derivedReal?: string            // closest real path if guard found one
}

/**
 * Persist a confabulation pattern. The next time the SAME agent name spawns
 * in the SAME project, its role prompt can warn: "you've previously cited
 * paths matching X — verify before citing similar paths."
 *
 * Per-(agent, project, citation-shape) — the citation-shape is the file
 * extension + first segment, so we don't store every individual line number,
 * just the recurring shapes.
 */
export function recordConfabLearning(input: RecordConfabLearningInput): void {
  const tags = [
    TAG.CONFAB_PATTERN,
    agentTag(input.agent),
    TAG.OUTCOME_FAILURE,
  ]
  const projTag = projectTag(input.project)
  if (projTag) tags.push(projTag)
  // Citation shape: first dir + extension. e.g. "frontend/*.jsx"
  const shape = citationShape(input.badCitation)
  if (shape) tags.push(`shape:${shape}`)
  const summary = [
    `Agent "${input.agent}" cited a path that does not exist: ${input.badCitation}`,
    input.derivedReal ? `Closest real path: ${input.derivedReal}` : '(no near-match found in worktree)',
    `Lesson: BEFORE citing a path, verify with "git ls-files <pattern>" or "ls <dir>".`,
  ].join('\n')
  writeMemory({
    scope: 'global',
    teamId: input.teamId,
    key: `confab:${input.agent}:${shape || 'unknown'}:${input.teamId.slice(0, 8)}`,
    value: summary,
    tags,
  })
}

/**
 * Extract a stable citation shape from a path:line citation. Examples:
 *   "frontend/InvoicesPage.jsx:217"         → "frontend/*.jsx"
 *   "backend/app/api/invoices.py:402"       → "backend/*.py"
 *   "scripts/sync.sh:14"                    → "scripts/*.sh"
 *   "InvoicesPage.jsx:217"                  → "*.jsx"
 * Returns null if the citation has no parseable shape.
 */
export function citationShape(citation: string): string | null {
  // Strip :line if present
  const path = citation.replace(/:\d+$/, '')
  const ext = path.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  if (!ext) return null
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return `*.${ext}`
  return `${segments[0]}/*.${ext}`
}

// ── Public API: resolution ──────────────────────────────────────────
export interface RecordResolutionLearningInput {
  teamId: string
  project?: string
  problem: string                 // 1-line summary of what was broken
  fixApplied: string              // 1-line summary of what fixed it
  evidence?: string               // file:line or test name proving the fix
}

/**
 * Persist a successful fix pattern. Optional: agents can call this via the
 * MCP `ensemble_learn_resolution` tool when they explicitly want to teach
 * future teams "this fix worked." Currently captured via reflections, but
 * this kind allows a more structured shape than free-form reflection text.
 */
export function recordResolutionLearning(input: RecordResolutionLearningInput): void {
  const tags: string[] = [TAG.RESOLUTION, TAG.OUTCOME_SUCCESS]
  const projTag = projectTag(input.project)
  if (projTag) tags.push(projTag)
  const summary = [
    `Problem: ${input.problem.slice(0, 300)}`,
    `Fix: ${input.fixApplied.slice(0, 300)}`,
    input.evidence ? `Evidence: ${input.evidence.slice(0, 200)}` : '',
  ].filter(Boolean).join('\n')
  writeMemory({
    scope: 'global',
    teamId: input.teamId,
    key: `resolution:${input.teamId.slice(0, 8)}:${Date.now()}`,
    value: summary,
    tags,
  })
}

// ── Outcome weighting (consumed by pre-spawn query enhancement) ────
const HALF_LIFE_DAYS = parseInt(
  process.env.ENSEMBLE_LEARNING_HALF_LIFE_DAYS || '30', 10,
) || 30

/**
 * Apply outcome + recency weighting to a memory's raw semantic score.
 *
 * - Failure-tagged memories are kept (they teach "don't do this again")
 *   but discounted to 0.6× so success patterns rank higher when both apply.
 * - Recency: exponential decay with HALF_LIFE_DAYS half-life. A learning
 *   from yesterday counts ~1.0×; one from a month ago ~0.5×; six months
 *   ~0.06×. Keeps the recall pool fresh without aggressive deletion.
 *
 * Returns the adjusted score (>= 0). Callers re-sort by this value before
 * top-K truncation.
 */
export function weightLearning(
  rawScore: number,
  tags: string[],
  createdAt: string,
): number {
  let score = rawScore
  if (tags.includes(TAG.OUTCOME_FAILURE)) score *= 0.6
  // Recency decay
  const created = new Date(createdAt).getTime()
  if (Number.isFinite(created)) {
    const ageDays = (Date.now() - created) / (1000 * 60 * 60 * 24)
    const decay = Math.exp(-ageDays * Math.LN2 / HALF_LIFE_DAYS)
    score *= decay
  }
  return Math.max(0, score)
}

// ── Re-export the half-life constant for tests ──────────────────────
export const __test_HALF_LIFE_DAYS = HALF_LIFE_DAYS
