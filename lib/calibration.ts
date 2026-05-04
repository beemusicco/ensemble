/**
 * Calibration scoreboard — aggregates per-agent / per-program metrics from
 * the structured `meta.event` markers ensemble emits across the team feed.
 *
 * Tracked metrics (per agent and per-program rollup):
 *   • assumption_verified    — credit when passed=true, debit when false/timeout
 *   • assumption_flagged     — count (bare assumptions, no auto-verify)
 *   • question_pending       — agent asked the operator
 *   • question_answered      — operator replied (within 5min)
 *   • question_timeout       — 5min elapsed, no reply
 *   • confabulation          — agent cited a fake file:line
 *   • auto_fix_exhausted     — team's verify cycle didn't converge
 *   • verify_runner          — mechanical gate result (rollup of failed/passed)
 *
 * Derived KPIs:
 *   • assumption_accuracy = passed / (passed + rejected)
 *   • question_answer_rate = answered / (answered + timeout)
 *   • cleanliness_score = 1 - (confabulations + rejected_assumptions) / total_messages
 *
 * The aggregator is read-only — it scans the existing message feed for each
 * team. State lives in the feed; calibration just summarizes it. Cheap to
 * recompute on demand; we cap at the most-recent N teams to keep responses
 * fast even with thousands of historical disbands.
 */

import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'
import { loadAllTeamsIncludingArchives, getMessages } from './ensemble-registry'

export interface AgentMetrics {
  agent: string                  // agent name within a team (e.g. "codex-1")
  program?: string               // program rollup (e.g. "codex" — set on /by-program)
  teamCount: number              // number of teams this agent appeared in
  totalMessages: number
  assumptionsVerified: number
  assumptionsRejected: number
  assumptionsFlagged: number     // bare flags, no auto-verify
  questionsAsked: number
  questionsAnswered: number
  questionsTimedOut: number
  confabulations: number
  autoFixExhausted: number       // count of teams where this agent's team exhausted auto-fix
  verifyRunnerPassed: number
  verifyRunnerFailed: number
  assumptionAccuracy: number     // verified / (verified + rejected); -1 if no signal
  questionAnswerRate: number     // answered / (answered + timeout); -1 if no signal
  cleanlinessScore: number       // 1 - (confabs + rejected_assumptions) / totalMessages
}

export interface CalibrationSummary {
  scannedTeams: number
  scannedMessages: number
  perAgent: AgentMetrics[]
  perProgram: AgentMetrics[]      // rollup by `program` (codex, claude, haiku, …)
  windowDays: number              // age window applied (Infinity = all)
}

interface RawCounters {
  totalMessages: number
  assumptionsVerified: number
  assumptionsRejected: number
  assumptionsFlagged: number
  questionsAsked: number
  questionsAnswered: number
  questionsTimedOut: number
  confabulations: number
  autoFixExhaustedTeams: Set<string>  // dedup per team
  verifyRunnerPassed: number
  verifyRunnerFailed: number
  teamIds: Set<string>
}

function emptyCounters(): RawCounters {
  return {
    totalMessages: 0,
    assumptionsVerified: 0,
    assumptionsRejected: 0,
    assumptionsFlagged: 0,
    questionsAsked: 0,
    questionsAnswered: 0,
    questionsTimedOut: 0,
    confabulations: 0,
    autoFixExhaustedTeams: new Set(),
    verifyRunnerPassed: 0,
    verifyRunnerFailed: 0,
    teamIds: new Set(),
  }
}

function programOf(team: EnsembleTeam, agentName: string): string | undefined {
  return team.agents.find(a => a.name === agentName)?.program
}

function safeDiv(num: number, denom: number): number {
  return denom === 0 ? -1 : Number((num / denom).toFixed(3))
}

function finalize(name: string, c: RawCounters, programLabel?: string): AgentMetrics {
  const cleanlinessDenom = c.totalMessages
  const cleanlinessHits = c.confabulations + c.assumptionsRejected
  return {
    agent: name,
    program: programLabel,
    teamCount: c.teamIds.size,
    totalMessages: c.totalMessages,
    assumptionsVerified: c.assumptionsVerified,
    assumptionsRejected: c.assumptionsRejected,
    assumptionsFlagged: c.assumptionsFlagged,
    questionsAsked: c.questionsAsked,
    questionsAnswered: c.questionsAnswered,
    questionsTimedOut: c.questionsTimedOut,
    confabulations: c.confabulations,
    autoFixExhausted: c.autoFixExhaustedTeams.size,
    verifyRunnerPassed: c.verifyRunnerPassed,
    verifyRunnerFailed: c.verifyRunnerFailed,
    assumptionAccuracy: safeDiv(c.assumptionsVerified, c.assumptionsVerified + c.assumptionsRejected),
    questionAnswerRate: safeDiv(c.questionsAnswered, c.questionsAnswered + c.questionsTimedOut),
    cleanlinessScore: cleanlinessDenom === 0
      ? -1
      : Number((1 - cleanlinessHits / cleanlinessDenom).toFixed(3)),
  }
}

export interface CalibrationOptions {
  windowDays?: number       // default Infinity (all teams)
  maxTeams?: number         // hard cap, default 500 most recent
  includeArchives?: boolean // default true — search teams-archive-*.json too
}

export function computeCalibration(opts: CalibrationOptions = {}): CalibrationSummary {
  const windowDays = opts.windowDays ?? Number.POSITIVE_INFINITY
  const maxTeams = opts.maxTeams ?? 500
  const cutoffMs = Number.isFinite(windowDays)
    ? Date.now() - windowDays * 24 * 60 * 60 * 1000
    : -Infinity

  const allTeams = opts.includeArchives === false
    ? loadAllTeamsIncludingArchives().filter(t => !t.id.startsWith('archive-'))  // belt+braces
    : loadAllTeamsIncludingArchives()

  // Filter by age + cap.
  const eligible = allTeams
    .filter(t => {
      const ts = t.completedAt || t.createdAt
      const tsMs = ts ? new Date(ts).getTime() : 0
      return Number.isFinite(tsMs) && tsMs >= cutoffMs
    })
    .sort((a, b) => {
      const ta = new Date(a.completedAt || a.createdAt || 0).getTime()
      const tb = new Date(b.completedAt || b.createdAt || 0).getTime()
      return tb - ta
    })
    .slice(0, maxTeams)

  const perAgentCounters = new Map<string, RawCounters>()  // key = agent name
  const perProgramCounters = new Map<string, RawCounters>()  // key = program
  let totalMessages = 0

  for (const team of eligible) {
    const messages = getMessages(team.id)
    totalMessages += messages.length

    // Pre-index agent → counters seen in this team so we can later increment
    // teamCount once per (agent, team).
    const agentsSeenInThisTeam = new Set<string>()

    for (const m of messages) {
      const sender = m.from || ''
      // Count agent-emitted messages toward totalMessages (denominator for
      // cleanliness). Skip ensemble/system/operator — they're commentary, not
      // agent output.
      const isAgent = sender && sender !== 'ensemble' && sender !== 'system' && sender !== 'operator' && sender !== 'user'

      const event = (m.meta as Record<string, unknown> | undefined)?.event as string | undefined
      const targetAgent = isAgent
        ? sender
        : (m.meta as Record<string, unknown> | undefined)?.agent as string | undefined

      if (!targetAgent && !event) continue

      // Increment agent counters when we have an attributable target.
      if (targetAgent) {
        let c = perAgentCounters.get(targetAgent)
        if (!c) { c = emptyCounters(); perAgentCounters.set(targetAgent, c) }
        c.teamIds.add(team.id)
        if (isAgent) {
          c.totalMessages++
          agentsSeenInThisTeam.add(targetAgent)
        }
        applyEvent(c, event, m, team.id)

        // Mirror into program rollup.
        const program = programOf(team, targetAgent)
        if (program) {
          let pc = perProgramCounters.get(program)
          if (!pc) { pc = emptyCounters(); perProgramCounters.set(program, pc) }
          pc.teamIds.add(team.id)
          if (isAgent) pc.totalMessages++
          applyEvent(pc, event, m, team.id)
        }
      }

      // verify_runner / auto_fix_exhausted are team-level events without an
      // agent attribution — apply to a synthetic "team" bucket that callers
      // can show separately. We capture them here so they aren't lost.
      if (!targetAgent && event) {
        let tc = perAgentCounters.get('__team__')
        if (!tc) { tc = emptyCounters(); perAgentCounters.set('__team__', tc) }
        tc.teamIds.add(team.id)
        applyEvent(tc, event, m, team.id)
      }
    }
  }

  const perAgent: AgentMetrics[] = [...perAgentCounters.entries()]
    .map(([name, c]) => finalize(name, c))
    .sort((a, b) => b.teamCount - a.teamCount)

  const perProgram: AgentMetrics[] = [...perProgramCounters.entries()]
    .map(([name, c]) => finalize(`program:${name}`, c, name))
    .sort((a, b) => b.teamCount - a.teamCount)

  return {
    scannedTeams: eligible.length,
    scannedMessages: totalMessages,
    perAgent,
    perProgram,
    windowDays: Number.isFinite(windowDays) ? windowDays : Infinity,
  }
}

function applyEvent(c: RawCounters, event: string | undefined, m: EnsembleMessage, teamId: string): void {
  if (!event) return
  const meta = (m.meta || {}) as Record<string, unknown>
  switch (event) {
    case 'assumption_verified':
      if (meta.passed === true) c.assumptionsVerified++
      else c.assumptionsRejected++
      break
    case 'assumption_flagged':
      c.assumptionsFlagged++
      break
    case 'question_pending':
      c.questionsAsked++
      break
    case 'question_answered':
      c.questionsAnswered++
      break
    case 'question_timeout':
      c.questionsTimedOut++
      break
    case 'confabulation':
      c.confabulations++
      break
    case 'auto_fix_exhausted':
      c.autoFixExhaustedTeams.add(teamId)
      break
    case 'verify_runner': {
      const passed = (meta.passed as number | undefined) ?? 0
      const failed = (meta.failed as number | undefined) ?? 0
      const errored = (meta.errored as number | undefined) ?? 0
      if (failed === 0 && errored === 0 && passed > 0) c.verifyRunnerPassed++
      else if (failed > 0 || errored > 0) c.verifyRunnerFailed++
      break
    }
  }
}

/**
 * W6: calibration-driven role assignment with anti-fragile guards.
 *
 * Reads existing per-program metrics and, for a given team's task, suggests
 * which PROGRAM (claude / codex / sonnet / haiku) is best suited to which
 * ROLE (architect / builder / verifier). Three guards prevent self-
 * reinforcing loops where the worst agent never gets a chance to improve:
 *
 *   1. min_samples=20 floor — programs with <20 sampled teams aren't
 *      ranked. They appear in the assignment pool unweighted, so new
 *      agents get exposure on equal footing with veterans.
 *
 *   2. epsilon-greedy randomization (default 10%) — even after ranking,
 *      one assignment in N is randomized so calibration data keeps
 *      flowing for low-rank programs. Without this, the worst-cleanliness
 *      program would be permanently demoted.
 *
 *   3. Operator override always wins — when CreateTeamRequest.agents
 *      includes explicit role assignments, this function is skipped.
 *
 * ENV gate: ENSEMBLE_CALIBRATION_ROLE_ASSIGN=1 enables the suggestion.
 * Default OFF — the existing template-driven role assignment stays
 * authoritative until production data shows this is actually better.
 */
export interface RoleAssignmentInput {
  /** Programs available on the team (e.g. ['claude','codex','haiku']) */
  programs: string[]
  /** Roles needed (e.g. ['architect','builder','verifier']) — order matters: index 0 → highest priority match */
  roles: string[]
  /** Pre-computed calibration summary (caller computes once per team-create) */
  calibration: CalibrationSummary
  /** Min teams sampled for a program to be ranked. Default 20. */
  minSamples?: number
  /** Probability of randomization per assignment (0..1). Default 0.10. */
  epsilon?: number
  /** Optional RNG for deterministic tests. */
  rng?: () => number
}

export interface RoleAssignment {
  program: string
  role: string
  reason: string                  // human-readable explanation
  randomized: boolean             // true if epsilon-greedy fired
}

interface RoleScoringRule {
  /** Higher score = better fit */
  score: (m: AgentMetrics) => number
  rationale: string
}

const ROLE_SCORING: Record<string, RoleScoringRule> = {
  // Architect role — prefers high assumption accuracy (agent thinks
  // before claiming) and low confab count (cites real things).
  architect: {
    score: m => {
      const a = m.assumptionAccuracy >= 0 ? m.assumptionAccuracy : 0.5
      const c = m.cleanlinessScore >= 0 ? m.cleanlinessScore : 0.5
      return 0.6 * a + 0.4 * c
    },
    rationale: 'high assumption accuracy + cleanliness',
  },
  // Builder role — prefers prolific output (more messages = more work)
  // BUT not at the cost of cleanliness.
  builder: {
    score: m => {
      const c = m.cleanlinessScore >= 0 ? m.cleanlinessScore : 0.5
      const productivity = Math.min(1, m.totalMessages / 1000)  // cap at 1k msgs
      return 0.5 * c + 0.5 * productivity
    },
    rationale: 'productive output paired with cleanliness',
  },
  // Verifier role — prefers MAX cleanliness; verifiers must NOT introduce
  // new errors. Confabs in a verifier are catastrophic.
  verifier: {
    score: m => {
      return m.cleanlinessScore >= 0 ? m.cleanlinessScore : 0.5
    },
    rationale: 'highest cleanliness (verifier mistakes are catastrophic)',
  },
  // Generic fallback for unknown roles — balanced score.
  '__default__': {
    score: m => {
      const a = m.assumptionAccuracy >= 0 ? m.assumptionAccuracy : 0.5
      const c = m.cleanlinessScore >= 0 ? m.cleanlinessScore : 0.5
      return 0.5 * a + 0.5 * c
    },
    rationale: 'balanced calibration',
  },
}

export function recommendRoleAssignments(input: RoleAssignmentInput): RoleAssignment[] {
  const minSamples = input.minSamples ?? 20
  const epsilon = input.epsilon ?? 0.10
  const rng = input.rng ?? Math.random

  // Map program → metrics. Skip programs below min_samples for ranking
  // purposes (but they remain in the pool — they get assigned at random
  // when no ranked candidates remain).
  const programMetrics = new Map<string, AgentMetrics>()
  for (const m of input.calibration.perProgram) {
    if (m.program) programMetrics.set(m.program, m)
  }

  const rankedPool: string[] = []
  const newPool: string[] = []  // below min_samples
  for (const program of input.programs) {
    const m = programMetrics.get(program)
    if (!m || m.teamCount < minSamples) {
      newPool.push(program)
    } else {
      rankedPool.push(program)
    }
  }

  const assignments: RoleAssignment[] = []
  const usedPrograms = new Set<string>()

  // Sort each role's candidates by score, pick top unused. Apply epsilon-
  // greedy: with probability epsilon, swap the picked top with a random
  // other-pool candidate. This keeps low-rank programs in the rotation
  // so we never lock into "haiku is the verifier forever, claude never
  // verifies".
  for (const role of input.roles) {
    const rule = ROLE_SCORING[role.toLowerCase()] ?? ROLE_SCORING.__default__
    const available = [...rankedPool, ...newPool].filter(p => !usedPrograms.has(p))
    if (available.length === 0) break

    let picked: string
    let randomized = false
    let reason: string

    if (rng() < epsilon && available.length > 1) {
      // Randomize for exploration.
      picked = available[Math.floor(rng() * available.length)]
      randomized = true
      reason = `epsilon-greedy randomization (${(epsilon * 100).toFixed(0)}% explore rate) — keeps calibration data flowing for all programs`
    } else {
      // Score-pick. Programs in newPool (below min_samples) get a NEUTRAL
      // baseline score 0.5 — we don't trust their metrics yet (could be
      // lucky or unlucky on small N). Programs in rankedPool get their
      // actual score. This means a ranked-pool program with score >= 0.5
      // wins over any newPool program; only when ranked candidates score
      // worse than baseline does a newPool one get the role. Eliminates
      // the "lucky 5-team sonnet beats 100-team claude" failure mode.
      const scored = available
        .map(p => {
          const m = programMetrics.get(p)
          const isRanked = !!m && m.teamCount >= minSamples
          const score = isRanked ? rule.score(m!) : 0.5  // newPool gets baseline
          return { program: p, score, hasData: isRanked }
        })
        .sort((a, b) => b.score - a.score)
      picked = scored[0].program
      const winnerMetrics = programMetrics.get(picked)
      const winnerScore = winnerMetrics && scored[0].hasData
        ? rule.score(winnerMetrics).toFixed(3)
        : '0.500 (baseline)'
      reason = scored[0].hasData
        ? `${rule.rationale}: ${picked} scored ${winnerScore} (${winnerMetrics?.teamCount ?? 0} sampled teams)`
        : `${rule.rationale}: ${picked} chosen by default — below min_samples=${minSamples} threshold, ranking inconclusive`
    }

    usedPrograms.add(picked)
    assignments.push({ program: picked, role, reason, randomized })
  }

  return assignments
}

/**
 * Compact human-readable summary suitable for `team-stats` shell output.
 */
export function formatCalibrationText(summary: CalibrationSummary): string {
  const lines: string[] = []
  const win = summary.windowDays === Infinity ? 'all-time' : `last ${summary.windowDays}d`
  lines.push(`📊 calibration scoreboard (${win}, ${summary.scannedTeams} teams / ${summary.scannedMessages} messages)`)
  lines.push('')

  if (summary.perAgent.length === 0) {
    lines.push('  (no events recorded yet — agents need to emit [ASSUMPTION ## verify:] / [QUESTION] / cite file:line for metrics)')
    return lines.join('\n')
  }

  lines.push(`  ── per agent ──`)
  for (const a of summary.perAgent.filter(x => x.agent !== '__team__').slice(0, 25)) {
    lines.push(`  ${a.agent} (${a.program ?? '?'}, ${a.teamCount} teams, ${a.totalMessages} msgs)`)
    lines.push(`    assumptions: ${a.assumptionsVerified}🟢/${a.assumptionsRejected}🔴 ${a.assumptionAccuracy >= 0 ? `(accuracy=${a.assumptionAccuracy})` : ''}`)
    lines.push(`    questions: ${a.questionsAsked} asked, ${a.questionsAnswered}✅/${a.questionsTimedOut}⏱  ${a.questionAnswerRate >= 0 ? `(reply rate=${a.questionAnswerRate})` : ''}`)
    lines.push(`    confabulations: ${a.confabulations}  cleanliness=${a.cleanlinessScore >= 0 ? a.cleanlinessScore : 'n/a'}`)
  }

  if (summary.perProgram.length > 0) {
    lines.push('')
    lines.push(`  ── per program (rollup) ──`)
    for (const p of summary.perProgram.slice(0, 10)) {
      lines.push(`  ${p.program} (${p.teamCount} teams, ${p.totalMessages} msgs)`)
      lines.push(`    assumptions: ${p.assumptionsVerified}🟢/${p.assumptionsRejected}🔴  questions: ${p.questionsAnswered}✅/${p.questionsTimedOut}⏱  confabs: ${p.confabulations}  cleanliness: ${p.cleanlinessScore >= 0 ? p.cleanlinessScore : 'n/a'}`)
    }
  }

  const teamBucket = summary.perAgent.find(x => x.agent === '__team__')
  if (teamBucket) {
    lines.push('')
    lines.push(`  ── team-level events ──`)
    lines.push(`  verify-runner: ${teamBucket.verifyRunnerPassed}✅ / ${teamBucket.verifyRunnerFailed}❌`)
    lines.push(`  auto-fix exhausted: ${teamBucket.autoFixExhausted} teams`)
  }

  return lines.join('\n')
}
