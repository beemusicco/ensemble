/**
 * Disband-time claim resolution — closes the W8 calibration loop.
 *
 * The W8 module records every `[CONFIDENCE: N%]` claim as a memory tagged
 * `outcome:pending`. The unknown-watcher independently runs verify-commands
 * for `[ASSUMPTION: X ## verify: cmd]` tags and emits `assumption_verified`
 * meta events. Without this module, the two streams never meet: claims sit
 * pending forever, the per-agent calibration block never has data, role
 * prompts never carry feedback.
 *
 * What this does on disband: scan the team's message feed for
 * `assumption_verified` events, jaccard-match each pending confidence claim
 * against verified assumption text, and propagate the verify outcome
 * (passed → verified, failed → rejected) to the claim memory.
 *
 * Same-agent constraint: only match a claim against assumptions emitted by
 * the same agent. Cross-agent text overlap is too noisy and would credit
 * agent A for agent B's verify result.
 *
 * Threshold: jaccard >= 0.4 on token sets. Calibrated against synthetic
 * test cases — paired claim+assumption messages typically score 0.5-0.9,
 * unrelated messages 0-0.2.
 */

import { getMessages } from './ensemble-registry'
import { queryMemories } from './memory-store'
import { resolveClaimOutcome, CONF_TAG } from './confidence-tracker'

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have', 'has', 'was',
  'were', 'been', 'will', 'would', 'should', 'could', 'into', 'than', 'then',
  'when', 'where', 'what', 'which', 'while', 'about', 'they', 'their', 'them',
  'there', 'these', 'those', 'because', 'also', 'just', 'some', 'much', 'many',
  'are', 'not', 'but', 'all', 'any', 'one', 'two', 'three', 'our', 'out',
])

function tokenize(s: string): Set<string> {
  if (!s) return new Set()
  const tokens = s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
  return new Set(tokens)
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

interface AssumptionVerification {
  claim: string
  passed: boolean
  agent?: string
  tokens: Set<string>
}

function extractVerifications(teamId: string): AssumptionVerification[] {
  const out: AssumptionVerification[] = []
  for (const m of getMessages(teamId)) {
    const meta = (m as { meta?: Record<string, unknown> }).meta
    if (!meta || meta.event !== 'assumption_verified') continue
    if (typeof meta.passed !== 'boolean') continue
    if (typeof meta.claim !== 'string' || !meta.claim) continue
    out.push({
      claim: meta.claim,
      passed: meta.passed,
      agent: typeof meta.agent === 'string' ? meta.agent : undefined,
      tokens: tokenize(meta.claim),
    })
  }
  return out
}

export interface ClaimResolutionResult {
  resolved: number
  pending: number
  matched: Array<{ claimId: string; outcome: 'verified' | 'rejected'; similarity: number }>
}

const SIMILARITY_THRESHOLD = parseFloat(process.env.ENSEMBLE_CLAIM_RESOLVE_THRESHOLD || '0.4') || 0.4

export function resolveLinkedClaimsForTeam(teamId: string): ClaimResolutionResult {
  const verifications = extractVerifications(teamId)
  const claims = queryMemories({
    scope: 'global',
    teamId,
    tags: [CONF_TAG.CLAIM, CONF_TAG.OUTCOME_PENDING],
    limit: 500,
  })

  if (verifications.length === 0 || claims.length === 0) {
    return { resolved: 0, pending: claims.length, matched: [] }
  }

  const matched: ClaimResolutionResult['matched'] = []
  for (const c of claims) {
    const cTokens = tokenize(c.value)
    if (cTokens.size === 0) continue
    let best: { v: AssumptionVerification; sim: number } | null = null
    for (const v of verifications) {
      if (v.agent && c.agent && v.agent !== c.agent) continue
      const sim = jaccardSimilarity(cTokens, v.tokens)
      if (sim > (best?.sim ?? 0)) best = { v, sim }
    }
    if (best && best.sim >= SIMILARITY_THRESHOLD) {
      const outcome: 'verified' | 'rejected' = best.v.passed ? 'verified' : 'rejected'
      resolveClaimOutcome({
        claimId: c.id,
        outcome,
        evidence: `auto-resolved on disband — jaccard=${best.sim.toFixed(2)} match against verified assumption: "${best.v.claim.slice(0, 150)}"`,
        resolvedBy: 'auto-resolver',
      })
      matched.push({ claimId: c.id, outcome, similarity: best.sim })
    }
  }
  return { resolved: matched.length, pending: claims.length - matched.length, matched }
}
