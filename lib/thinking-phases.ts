import type { EnsembleMessage, ThinkingPhase } from '../types/ensemble'

export const THINKING_PHASES: ThinkingPhase[] = [
  'frame', 'evidence', 'synthesis', 'action', 'verify', 'reflect',
]

export const PHASE_INDEX: Record<ThinkingPhase, number> =
  Object.fromEntries(THINKING_PHASES.map((p, i) => [p, i])) as Record<ThinkingPhase, number>

/**
 * Return the most recent phase the team declared via team-think phase <x>.
 * Returns null if the team has never entered any phase (classic collab, not
 * thinking mode).
 */
export function getCurrentPhase(messages: EnsembleMessage[]): ThinkingPhase | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type !== 'phase') continue
    const name = (m.meta?.phase as string) || m.content.replace(/^\[PHASE\]\s*/, '').trim()
    if (THINKING_PHASES.includes(name as ThinkingPhase)) {
      return name as ThinkingPhase
    }
  }
  return null
}

/** Regression detection: moving backwards in the phase order. */
export function isPhaseRegression(from: ThinkingPhase | null, to: ThinkingPhase): boolean {
  if (from === null) return false
  return PHASE_INDEX[to] < PHASE_INDEX[from]
}

/** Which message types are expected in each phase. Used by supervisor. */
export const PHASE_EXPECTATIONS: Record<ThinkingPhase, {
  allowed: string[]
  must: string[]
  forbidden: string[]
}> = {
  frame: {
    allowed: ['chat', 'phase', 'hypothesis'],
    must: ['hypothesis'],
    forbidden: ['decision_pick'],
  },
  evidence: {
    allowed: ['chat', 'phase', 'evidence', 'hypothesis'],
    must: ['evidence'],
    forbidden: ['decision_pick'],
  },
  synthesis: {
    allowed: ['chat', 'phase', 'challenge', 'decision_pick'],
    must: ['decision_pick'],
    forbidden: [],
  },
  action: {
    allowed: ['chat', 'phase'],
    must: [],
    forbidden: [],
  },
  verify: {
    allowed: ['chat', 'phase', 'result'],
    must: [],
    forbidden: [],
  },
  reflect: {
    allowed: ['chat', 'phase', 'reflect'],
    must: ['reflect'],
    forbidden: [],
  },
}

export interface SupervisorFinding {
  code: string
  severity: 'info' | 'warn' | 'error'
  message: string
  evidence?: Record<string, unknown>
}

/**
 * Run deterministic structural checks over the team's message log.
 * Never calls an LLM — purely rule-based so it's cheap and auditable.
 */
export function analyzeThinking(messages: EnsembleMessage[]): SupervisorFinding[] {
  const findings: SupervisorFinding[] = []
  const phase = getCurrentPhase(messages)
  if (phase === null) return findings // not thinking mode

  const hypothesisIds = new Set<string>()
  const evidenceIdsSeen = new Map<string, number>()
  const hypothesesCited = new Map<string, number>()
  const decisionTargets = new Set<string>()
  const challengeTargets = new Set<string>()

  // Track per-agent retrieval history: did this agent invoke team-history
  // or team-recall before emitting a hypothesis?
  const agentLastRetrieval = new Map<string, number>()
  const retrievalPattern = /team-history|team-recall/

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.from === 'ensemble') continue
    // Retrieval detection: any agent-authored chat mentioning team-history/recall
    // counts. This is heuristic (agents describe what they ran), which matches
    // prompt norms — we're looking for the act of retrieval being claimed.
    if (m.type === 'chat' && retrievalPattern.test(m.content)) {
      agentLastRetrieval.set(m.from, i)
    }
    if (m.type === 'hypothesis') {
      const hid = (m.meta?.hypothesisId as string) || ''
      if (hid) hypothesisIds.add(hid)
      hypothesesCited.set(hid, (hypothesesCited.get(hid) ?? 0) + 1)
      const lastRetrieval = agentLastRetrieval.get(m.from) ?? -1
      if (lastRetrieval < 0 || i - lastRetrieval > 20) {
        findings.push({
          code: 'hypothesis_without_retrieval',
          severity: 'warn',
          message: `${m.from} emitted hypothesis ${hid} without a prior team-history/team-recall call`,
          evidence: { messageId: m.id, hypothesisId: hid },
        })
      }
    }
    if (m.type === 'evidence') {
      const hid = (m.meta?.hypothesisId as string) || ''
      evidenceIdsSeen.set(hid, (evidenceIdsSeen.get(hid) ?? 0) + 1)
      if (hid && !hypothesisIds.has(hid)) {
        findings.push({
          code: 'evidence_for_unknown_hypothesis',
          severity: 'warn',
          message: `${m.from} posted evidence for hypothesis ${hid} which was never declared`,
          evidence: { messageId: m.id, hypothesisId: hid },
        })
      }
    }
    if (m.type === 'challenge') {
      const tgt = (m.meta?.targetId as string) || ''
      if (tgt) challengeTargets.add(tgt)
    }
    if (m.type === 'decision_pick') {
      const tgt = (m.meta?.hypothesisId as string) || ''
      if (tgt) decisionTargets.add(tgt)
      if (tgt && (evidenceIdsSeen.get(tgt) ?? 0) === 0) {
        findings.push({
          code: 'decision_without_evidence',
          severity: 'warn',
          message: `Decision picked ${tgt} but no evidence was ever logged for it`,
          evidence: { messageId: m.id, hypothesisId: tgt },
        })
      }
      if (tgt && !challengeTargets.has(tgt)) {
        findings.push({
          code: 'decision_without_challenge',
          severity: 'warn',
          message: `Decision picked ${tgt} but no challenge was logged against any hypothesis in this phase`,
          evidence: { messageId: m.id, hypothesisId: tgt },
        })
      }
    }
  }

  // Circling: same hypothesis cited 4+ times without resolution via decision
  for (const [hid, count] of hypothesesCited) {
    if (count >= 4 && !decisionTargets.has(hid)) {
      findings.push({
        code: 'hypothesis_circling',
        severity: 'warn',
        message: `Hypothesis ${hid} cited ${count} times without a decision — team may be circling`,
        evidence: { hypothesisId: hid, citations: count },
      })
    }
  }

  return findings
}

/**
 * Deduplicate findings we've already warned about so we don't re-fire the
 * same warning each supervisor tick.
 */
export function pruneAlreadyWarned(
  findings: SupervisorFinding[], messages: EnsembleMessage[],
): SupervisorFinding[] {
  const alreadyWarned = new Set<string>()
  for (const m of messages) {
    if (m.type !== 'supervisor_warning') continue
    const code = (m.meta?.code as string) || ''
    const target = (m.meta?.target as string) || ''
    alreadyWarned.add(`${code}:${target}`)
  }
  return findings.filter(f => {
    const target = String(f.evidence?.hypothesisId ?? f.evidence?.messageId ?? '')
    return !alreadyWarned.has(`${f.code}:${target}`)
  })
}
