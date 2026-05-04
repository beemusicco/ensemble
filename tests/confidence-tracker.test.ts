import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  parseConfidenceClaims,
  recordConfidenceClaim,
  resolveClaimOutcome,
  computeCalibration,
  formatCalibrationFeedback,
  scanAndPersistClaims,
} from '../lib/confidence-tracker'

describe('parseConfidenceClaims', () => {
  it('parses single claim with em-dash separator', () => {
    const r = parseConfidenceClaims('Looking at the data, [CONFIDENCE: 85% — backend has a write-through cache] so writes are committed before read.', 'claude-1')
    expect(r).toHaveLength(1)
    expect(r[0].confidence).toBe(85)
    expect(r[0].claim).toContain('backend has a write-through cache')
  })

  it('parses claim with hyphen separator', () => {
    const r = parseConfidenceClaims('[CONFIDENCE: 70% - GET endpoint returns 200 even with bad token]', 'claude-1')
    expect(r).toHaveLength(1)
    expect(r[0].confidence).toBe(70)
  })

  it('parses claim without percent sign', () => {
    const r = parseConfidenceClaims('[CONFIDENCE: 60: this requires authentication]', 'haiku-3')
    expect(r).toHaveLength(1)
    expect(r[0].confidence).toBe(60)
  })

  it('extracts surrounding sentence when no inline claim text', () => {
    const r = parseConfidenceClaims('The auth middleware does not propagate tenant_id, [CONFIDENCE: 75%] which means all queries miss the filter.', 'codex-2')
    expect(r).toHaveLength(1)
    expect(r[0].confidence).toBe(75)
    expect(r[0].claim).toContain('tenant_id')
  })

  it('parses multiple claims in one message', () => {
    const r = parseConfidenceClaims(
      '[CONFIDENCE: 90% — first claim] then [CONFIDENCE: 40% — second weaker claim]',
      'claude-1',
    )
    expect(r).toHaveLength(2)
    expect(r[0].confidence).toBe(90)
    expect(r[1].confidence).toBe(40)
  })

  it('rejects out-of-range confidence values', () => {
    const r = parseConfidenceClaims('[CONFIDENCE: 150% — impossible] [CONFIDENCE: -5% — also impossible]', 'a')
    expect(r).toHaveLength(0)
  })

  it('attaches context to claim record', () => {
    const r = parseConfidenceClaims('[CONFIDENCE: 65% — claim]', 'a', {
      teamId: 'team-1', project: 'libro', gateId: 'pytest',
    })
    expect(r[0].teamId).toBe('team-1')
    expect(r[0].project).toBe('libro')
    expect(r[0].gateId).toBe('pytest')
  })

  it('handles malformed tags gracefully', () => {
    expect(parseConfidenceClaims('[CONFIDENCE]', 'a')).toEqual([])
    expect(parseConfidenceClaims('[CONFIDENCE: not-a-number]', 'a')).toEqual([])
    expect(parseConfidenceClaims('', 'a')).toEqual([])
  })
})

describe('record + resolve + computeCalibration', () => {
  let tempDir: string
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-tracker-'))
    process.env.ENSEMBLE_DATA_DIR = tempDir
  })
  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalDataDir
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('persists a claim and computes calibration after resolution', () => {
    const claim = recordConfidenceClaim({ agent: 'claude-1', confidence: 80, claim: 'X is true' })
    expect(claim.tags).toContain('confidence-claim')
    expect(claim.tags).toContain('agent:claude-1')
    expect(claim.tags).toContain('confidence:80')
    expect(claim.tags).toContain('bucket:8')  // 80 / 10 = bucket 8
    expect(claim.tags).toContain('outcome:pending')

    // Resolve as verified
    resolveClaimOutcome({ claimId: claim.id, outcome: 'verified', evidence: 'tested' })

    // Record + resolve a second claim at same bucket, this time rejected
    const c2 = recordConfidenceClaim({ agent: 'claude-1', confidence: 80, claim: 'Y' })
    resolveClaimOutcome({ claimId: c2.id, outcome: 'rejected' })

    const curve = computeCalibration({ agent: 'claude-1' })
    expect(curve.overallSamples).toBe(2)
    const bucket8 = curve.buckets[8]  // 80-90% bucket
    expect(bucket8.sampleCount).toBe(2)
    expect(bucket8.verifiedCount).toBe(1)
    expect(bucket8.actualHitRate).toBeCloseTo(0.5, 2)
    // 80% predicted, 50% actual → -30pp deviation (overconfident)
    expect(bucket8.deviation).toBeCloseTo(-0.35, 1)
    expect(curve.brierScore).not.toBeNull()
  })

  it('mean deviation flags overconfidence trend', () => {
    // 10 claims at 80%, 5 verified → 50% actual hit rate (overconfident)
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const c = recordConfidenceClaim({ agent: 'codex-2', confidence: 80, claim: `c${i}` })
      ids.push(c.id)
    }
    for (let i = 0; i < 5; i++) resolveClaimOutcome({ claimId: ids[i], outcome: 'verified' })
    for (let i = 5; i < 10; i++) resolveClaimOutcome({ claimId: ids[i], outcome: 'rejected' })

    const curve = computeCalibration({ agent: 'codex-2' })
    expect(curve.overallSamples).toBe(10)
    expect(curve.meanDeviationPp).not.toBeNull()
    expect(curve.meanDeviationPp!).toBeLessThan(-20)  // -35pp underconfident
  })

  it('formatCalibrationFeedback returns empty when <10 samples', () => {
    for (let i = 0; i < 5; i++) {
      const c = recordConfidenceClaim({ agent: 'haiku-3', confidence: 70, claim: `c${i}` })
      resolveClaimOutcome({ claimId: c.id, outcome: 'verified' })
    }
    const curve = computeCalibration({ agent: 'haiku-3' })
    expect(formatCalibrationFeedback(curve)).toBe('')
  })

  it('formatCalibrationFeedback flags overconfident verdict', () => {
    // 12 claims at 90% but only 6 verified → severe overconfidence
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      const c = recordConfidenceClaim({ agent: 'over-1', confidence: 90, claim: `x${i}` })
      ids.push(c.id)
    }
    for (let i = 0; i < 6; i++) resolveClaimOutcome({ claimId: ids[i], outcome: 'verified' })
    for (let i = 6; i < 12; i++) resolveClaimOutcome({ claimId: ids[i], outcome: 'rejected' })

    const curve = computeCalibration({ agent: 'over-1' })
    const text = formatCalibrationFeedback(curve)
    expect(text).toContain('YOUR CALIBRATION')
    expect(text).toMatch(/OVERCONFIDENT/i)
  })

  it('per-agent isolation: different agents have independent curves', () => {
    // claude well-calibrated at 80%, codex overconfident at 80%
    for (let i = 0; i < 10; i++) {
      const cc = recordConfidenceClaim({ agent: 'claude-x', confidence: 80, claim: `c${i}` })
      resolveClaimOutcome({ claimId: cc.id, outcome: i < 8 ? 'verified' : 'rejected' })
    }
    for (let i = 0; i < 10; i++) {
      const cc = recordConfidenceClaim({ agent: 'codex-x', confidence: 80, claim: `c${i}` })
      resolveClaimOutcome({ claimId: cc.id, outcome: i < 4 ? 'verified' : 'rejected' })
    }
    const claude = computeCalibration({ agent: 'claude-x' })
    const codex = computeCalibration({ agent: 'codex-x' })
    expect(claude.buckets[8].actualHitRate).toBeCloseTo(0.8, 1)
    expect(codex.buckets[8].actualHitRate).toBeCloseTo(0.4, 1)
  })

  it('scanAndPersistClaims is wire-able from message scanner', () => {
    const text = '[CONFIDENCE: 75% — first] random text [CONFIDENCE: 50% — second]'
    const count = scanAndPersistClaims(text, 'scan-test-uniq', { teamId: 't1', project: 'libro' })
    expect(count).toBe(2)
    // Use a unique agent name so this test is isolated from earlier-test leakage
    // through module-cached sqlite handles in memory-store.
    const curve = computeCalibration({ agent: 'scan-test-uniq' })
    // Persisted but not resolved → 0 samples in calibration sample pool
    expect(curve.overallSamples).toBe(0)
  })
})
