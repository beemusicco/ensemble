/**
 * Calibrated-confidence primitive — Tetlock-style superforecasting on top
 * of the existing memory store.
 *
 * Why this exists: top-tier reasoning isn't just about generating hypotheses,
 * it's about being CALIBRATED — when you say "80% confident", you should be
 * right ~80% of the time over many predictions. Without tracking, agents
 * default to overconfident pattern-matching that masquerades as reasoning.
 *
 * The W8 hypothesis: if every speculative claim from an agent must carry a
 * `[CONFIDENCE: N%]` tag, AND we track which claims survived later checks,
 * then over time we can:
 *   1. Compute a per-agent calibration curve (predicted % vs actual hit rate)
 *   2. Identify systematic over/underconfidence patterns
 *   3. Inject calibration feedback into the agent's next role prompt
 *      ("your 80% claims have been 65% accurate — downgrade")
 *
 * Storage: piggybacks on the existing memory.db with structured tags. No
 * schema migration; memory-gc retention rules apply automatically.
 *
 * Outcome resolution paths (in order of automation):
 *   a. Auto-resolved: claim near `[ASSUMPTION ## verify: cmd]` — if verify
 *      passes, claim verified; if fails, rejected.
 *   b. Operator-resolved: API endpoint POST /api/ensemble/claims/:id/resolve
 *   c. Time-decayed: claims older than N days without resolution drop out
 *      of the calibration sample pool (don't pollute with stale unknowns).
 */

import { writeMemory, queryMemories, type MemoryRecord } from './memory-store'

// ── Tag constants (keep in sync with memory-gc retention if changed) ─
export const CONF_TAG = {
  CLAIM: 'confidence-claim',
  OUTCOME_VERIFIED: 'outcome:verified',
  OUTCOME_REJECTED: 'outcome:rejected',
  OUTCOME_PENDING: 'outcome:pending',
} as const

// Confidence bucket size for calibration histogram. 10 buckets gives good
// resolution without sample-starvation per bucket.
const BUCKET_SIZE = 10  // 0-9, 10-19, ..., 90-100
const BUCKET_COUNT = 10

export interface ConfidenceClaim {
  agent: string
  confidence: number          // 0-100
  claim: string               // text after `[CONFIDENCE: N%]` separator (— or - or :)
  teamId?: string
  project?: string
  /** Optional gate/check id this claim is linked to (auto-resolution path) */
  gateId?: string
}

export interface CalibrationBucket {
  /** [low, high) range in confidence percent */
  range: [number, number]
  /** How many claims fell into this bucket */
  sampleCount: number
  /** Of those, how many were resolved as verified */
  verifiedCount: number
  /** verifiedCount / (verifiedCount + rejectedCount); -1 if no resolved samples */
  actualHitRate: number
  /** Bucket midpoint / 100 — what the agent predicted */
  expectedHitRate: number
  /** actualHitRate - expectedHitRate; positive = underconfident, negative = overconfident */
  deviation: number
}

export interface CalibrationCurve {
  agent: string
  /** Optional: scoped to a specific project */
  project?: string
  buckets: CalibrationBucket[]
  /** Total resolved samples across all buckets */
  overallSamples: number
  /** Brier score: mean((predicted_prob - outcome_01)^2) — lower is better, range [0,1] */
  brierScore: number | null
  /** Average miscalibration in percentage points (signed: + = underconfident) */
  meanDeviationPp: number | null
}

// ── Parse `[CONFIDENCE: N%]` tags from agent message text ───────────
//
// Accepts forms:
//   [CONFIDENCE: 75%]
//   [CONFIDENCE: 75]
//   [CONFIDENCE: 75% — backend has a cache layer that handles this]
//   [CONFIDENCE: 75 — claim with no percent sign]
//   [CONFIDENCE:75% - dash separator] (whitespace + separator variants)
//
// The trailing claim text is optional. If absent, the claim string is the
// surrounding sentence (best-effort context grab).
const CONFIDENCE_RE = /\[CONFIDENCE:\s*(\d{1,3})\s*%?\s*(?:[—\-:]\s*([^\]]+?))?\]/gi

export function parseConfidenceClaims(
  text: string,
  agent: string,
  ctx?: { teamId?: string; project?: string; gateId?: string },
): ConfidenceClaim[] {
  if (!text) return []
  const out: ConfidenceClaim[] = []
  let m: RegExpExecArray | null
  CONFIDENCE_RE.lastIndex = 0
  while ((m = CONFIDENCE_RE.exec(text)) !== null) {
    const conf = parseInt(m[1], 10)
    if (!Number.isFinite(conf) || conf < 0 || conf > 100) continue
    let claim = (m[2] ?? '').trim()
    if (!claim) {
      // Grab surrounding sentence as best-effort context.
      const start = Math.max(0, m.index - 200)
      const end = Math.min(text.length, m.index + m[0].length + 200)
      const context = text.slice(start, end).replace(/\n/g, ' ').trim()
      claim = context.slice(0, 280)
    }
    out.push({
      agent,
      confidence: conf,
      claim: claim.slice(0, 500),
      teamId: ctx?.teamId,
      project: ctx?.project,
      gateId: ctx?.gateId,
    })
  }
  return out
}

// ── Persistence: write a claim as a memory ───────────────────────────
function bucketIndex(confidence: number): number {
  return Math.min(BUCKET_COUNT - 1, Math.floor(confidence / BUCKET_SIZE))
}

export function recordConfidenceClaim(claim: ConfidenceClaim): MemoryRecord {
  const bucket = bucketIndex(claim.confidence)
  const tags: string[] = [
    CONF_TAG.CLAIM,
    `agent:${claim.agent.replace(/[^a-z0-9-]/gi, '_').slice(0, 40)}`,
    `bucket:${bucket}`,
    `confidence:${claim.confidence}`,
    CONF_TAG.OUTCOME_PENDING,
  ]
  if (claim.project) tags.push(claim.project.replace(/[^a-z0-9-]/gi, '_').slice(0, 40))
  if (claim.gateId) tags.push(`gate:${claim.gateId.replace(/[^a-z0-9-]/gi, '_').slice(0, 60)}`)
  return writeMemory({
    scope: 'global',
    teamId: claim.teamId ?? null,
    agent: claim.agent,
    key: `confidence-claim:${claim.agent}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    value: claim.claim,
    tags,
  })
}

// ── Outcome resolution ───────────────────────────────────────────────
// Outcomes are recorded by writing a NEW memory with the same key prefix
// + outcome tag. queryMemories surfaces the latest record per key, but
// since we don't update in place (memory-store has no UPDATE), we use a
// separate "resolution" memory with a stable key linkage.
//
// Schema: a resolution memory has key=`confidence-resolution:<original-id>`
// and tags include the outcome and the original claim's id.

export interface OutcomeResolution {
  claimId: string
  outcome: 'verified' | 'rejected'
  evidence?: string
  resolvedBy?: string
}

export function resolveClaimOutcome(input: OutcomeResolution): MemoryRecord {
  const outcomeTag = input.outcome === 'verified'
    ? CONF_TAG.OUTCOME_VERIFIED
    : CONF_TAG.OUTCOME_REJECTED
  return writeMemory({
    scope: 'global',
    key: `confidence-resolution:${input.claimId}`,
    value: input.evidence || '(no evidence provided)',
    tags: ['confidence-resolution', `claim-id:${input.claimId}`, outcomeTag],
    agent: input.resolvedBy,
  })
}

// ── Calibration computation ──────────────────────────────────────────
export function computeCalibration(opts: {
  agent?: string
  project?: string
  windowDays?: number
} = {}): CalibrationCurve {
  // Pull all claim memories within window.
  const claims = queryMemories({
    scope: 'global',
    tags: [CONF_TAG.CLAIM],
    limit: 500,
  })

  // Filter by agent + project + age.
  const cutoffMs = opts.windowDays ? Date.now() - opts.windowDays * 86400_000 : 0
  const filtered = claims.filter(m => {
    if (opts.agent && !m.tags.includes(`agent:${opts.agent}`)) return false
    if (opts.project && !m.tags.includes(opts.project)) return false
    if (cutoffMs && new Date(m.createdAt).getTime() < cutoffMs) return false
    return true
  })

  // Pull all resolutions in batch (one query, then index by claim-id).
  const resolutions = queryMemories({
    scope: 'global',
    tags: ['confidence-resolution'],
    limit: 500,
  })
  const resolutionByClaimId = new Map<string, 'verified' | 'rejected'>()
  for (const r of resolutions) {
    const claimIdTag = r.tags.find(t => t.startsWith('claim-id:'))
    if (!claimIdTag) continue
    const claimId = claimIdTag.replace('claim-id:', '')
    if (r.tags.includes(CONF_TAG.OUTCOME_VERIFIED)) {
      resolutionByClaimId.set(claimId, 'verified')
    } else if (r.tags.includes(CONF_TAG.OUTCOME_REJECTED)) {
      resolutionByClaimId.set(claimId, 'rejected')
    }
  }

  // Bucketize and compute hit rates.
  const buckets: CalibrationBucket[] = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
    range: [i * BUCKET_SIZE, (i + 1) * BUCKET_SIZE] as [number, number],
    sampleCount: 0,
    verifiedCount: 0,
    actualHitRate: -1,
    expectedHitRate: (i * BUCKET_SIZE + BUCKET_SIZE / 2) / 100,
    deviation: 0,
  }))

  let resolvedTotal = 0
  let brierSum = 0
  let weightedDeviationSum = 0
  let weightedSamples = 0

  for (const m of filtered) {
    const bucketTag = m.tags.find(t => t.startsWith('bucket:'))
    const confTag = m.tags.find(t => t.startsWith('confidence:'))
    if (!bucketTag || !confTag) continue
    const bIdx = parseInt(bucketTag.replace('bucket:', ''), 10)
    const conf = parseInt(confTag.replace('confidence:', ''), 10)
    if (!Number.isFinite(bIdx) || bIdx < 0 || bIdx >= BUCKET_COUNT) continue

    const outcome = resolutionByClaimId.get(m.id)
    if (!outcome) continue  // unresolved → skip from calibration

    buckets[bIdx].sampleCount++
    if (outcome === 'verified') buckets[bIdx].verifiedCount++

    // Brier: (p - o)^2 where p = conf/100, o = 1 if verified else 0
    const p = conf / 100
    const o = outcome === 'verified' ? 1 : 0
    brierSum += (p - o) ** 2
    resolvedTotal++
  }

  // Finalize bucket stats.
  for (const b of buckets) {
    if (b.sampleCount > 0) {
      b.actualHitRate = b.verifiedCount / b.sampleCount
      b.deviation = b.actualHitRate - b.expectedHitRate
      weightedDeviationSum += b.deviation * b.sampleCount
      weightedSamples += b.sampleCount
    }
  }

  const meanDeviation = weightedSamples > 0
    ? (weightedDeviationSum / weightedSamples) * 100  // pp
    : null

  return {
    agent: opts.agent ?? '*',
    project: opts.project,
    buckets,
    overallSamples: resolvedTotal,
    brierScore: resolvedTotal > 0 ? brierSum / resolvedTotal : null,
    meanDeviationPp: meanDeviation,
  }
}

// ── Format calibration feedback for inclusion in agent role prompt ──
export function formatCalibrationFeedback(curve: CalibrationCurve): string {
  if (curve.overallSamples < 10) {
    return ''  // Insufficient data — silent rather than misleading
  }
  const lines: string[] = []
  lines.push(`📊 YOUR CALIBRATION (last ${curve.overallSamples} resolved confidence claims):`)
  // Surface only buckets with samples.
  const populated = curve.buckets.filter(b => b.sampleCount >= 3)
  if (populated.length === 0) {
    return ''
  }
  for (const b of populated) {
    const expectPct = (b.expectedHitRate * 100).toFixed(0)
    const actualPct = (b.actualHitRate * 100).toFixed(0)
    const devPp = (b.deviation * 100).toFixed(0)
    const devSign = b.deviation > 0 ? '+' : ''
    const verdict = Math.abs(b.deviation) < 0.05
      ? '✓ calibrated'
      : (b.deviation < 0 ? '⚠️ OVERCONFIDENT — downgrade' : '⚠️ underconfident — upgrade')
    lines.push(
      `  ${expectPct}% claims (${b.sampleCount} samples): actual ${actualPct}% accurate (${devSign}${devPp}pp) — ${verdict}`
    )
  }
  if (curve.brierScore !== null) {
    lines.push(`  Brier score: ${curve.brierScore.toFixed(3)} (lower = better, 0.25 = always-50% baseline)`)
  }
  if (curve.meanDeviationPp !== null && Math.abs(curve.meanDeviationPp) > 5) {
    const direction = curve.meanDeviationPp < 0 ? 'overconfident' : 'underconfident'
    lines.push(`  Overall trend: ${direction} by ${Math.abs(curve.meanDeviationPp).toFixed(0)}pp — adjust your default confidence accordingly.`)
  }
  return lines.join('\n')
}

// ── Auto-scan helper: parse claims from a message + persist them ────
export function scanAndPersistClaims(
  messageContent: string,
  agent: string,
  ctx?: { teamId?: string; project?: string; gateId?: string },
): number {
  const claims = parseConfidenceClaims(messageContent, agent, ctx)
  for (const c of claims) recordConfidenceClaim(c)
  return claims.length
}
