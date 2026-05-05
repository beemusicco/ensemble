import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  parseBracketTags,
  getCompletionConfidence,
  countEvidenceMarkers,
  loadTaxonomy,
  hasAnyPositiveCompletionSignal,
  __resetTaxonomyCache,
} from '../lib/completion-signals'

describe('parseBracketTags', () => {
  it('finds tag at message start', () => {
    const tags = parseBracketTags('[VERIFY_DONE] approved.')
    expect(tags).toHaveLength(1)
    expect(tags[0].name).toBe('VERIFY_DONE')
    expect(tags[0].position).toBe('message-start')
    expect(tags[0].isInstructional).toBe(false)
  })

  it('finds tag at start of LINE inside multi-line message (Pattern A)', () => {
    const text = `[VERIFY_DONE] FINAL — APPROVED. Independent evidence verified.
═══ ARTIFACT VERIFICATION (ARCHITECT independent check) ═══
✓ Path: /Users/aimusic/projects/accounting-helper/.worktrees/...
✓ sha256: abc123
✓ Tests 113/113 pass`
    const tags = parseBracketTags(text)
    expect(tags).toHaveLength(1)
    expect(tags[0].name).toBe('VERIFY_DONE')
    // First-line position with content after the tag
    expect(['message-start', 'line-start']).toContain(tags[0].position)
  })

  it('detects instructional context (Pattern E)', () => {
    const tags = parseBracketTags('Remember to emit [DONE] when ready')
    expect(tags).toHaveLength(1)
    expect(tags[0].isInstructional).toBe(true)
  })

  it('finds multiple tags across lines', () => {
    const text = `[GATES_GREEN] all checks passed
[BUILD_OK] APK 11.66 MiB
[REVIEW_OK_PARTIAL] size + grep audits clean`
    const tags = parseBracketTags(text)
    expect(tags).toHaveLength(3)
    expect(tags.map(t => t.name)).toEqual(['GATES_GREEN', 'BUILD_OK', 'REVIEW_OK_PARTIAL'])
    for (const t of tags) {
      expect(['line-start', 'message-start', 'message-end', 'line-end']).toContain(t.position)
    }
  })

  it('classifies buried tag', () => {
    const tags = parseBracketTags('the agent then said [DONE] in the middle of a sentence')
    expect(tags[0].position).toBe('buried')
  })
})

describe('countEvidenceMarkers', () => {
  it('counts glyph + word markers', () => {
    const taxonomy = loadTaxonomy()
    const n = countEvidenceMarkers('✓ tests passed ✓ build successful', taxonomy.evidence_markers)
    expect(n).toBeGreaterThanOrEqual(3)
  })

  it('returns 0 for evidence-free text', () => {
    expect(countEvidenceMarkers('nothing relevant here', loadTaxonomy().evidence_markers)).toBe(0)
  })
})

describe('getCompletionConfidence — production failure modes', () => {
  it('Pattern A: long evidence-laden [VERIFY_DONE] sign-off → high (was: dropped)', () => {
    // This is the real message from team 384fbb38 that failed to disband
    const text = `[VERIFY_DONE] FINAL — APPROVED. Independent evidence verified.
═══ ARTIFACT VERIFICATION (ARCHITECT independent check) ═══
✓ Path: /Users/aimusic/projects/accounting-helper/.worktrees/.../dist/libro-1.0.6-release.apk
✓ sha256 matches codex-2 reported
✓ apksigner verify: Verified using v1/v2/v3 scheme
✓ size 11.66 MiB
✓ Tests 113/113 pass
✓ Branch lineage: clean fast-forward from master
✓ haiku branch excluded (cited APIs do not exist on capacitor 8 typings)`
    expect(text.length).toBeGreaterThan(300)  // would have been dropped under old logic
    expect(getCompletionConfidence(text)).toBe('high')
  })

  it('Pattern B: [REVIEW_OK] alone → high', () => {
    expect(getCompletionConfidence('[REVIEW_OK] all gates clean.')).toBe('high')
  })

  it('Pattern B-extended: [GATES_GREEN] with evidence → high', () => {
    const text = `[GATES_GREEN] P5 + grep + lockfile audits all clean:
✓ Full vitest: 23 files / 136 tests pass
✓ Targeted QR: 5/5
✓ grep frontend src: 0 hits for barcode-scanning`
    expect(getCompletionConfidence(text)).toBe('high')
  })

  it('Pattern B-bare: [GATES_GREEN] without evidence → low', () => {
    expect(getCompletionConfidence('[GATES_GREEN]')).toBe('low')
  })

  it('Pattern C: novel tag [SHIP_FINAL] with evidence → low (graceful fallback)', () => {
    const text = `[SHIP_FINAL] ready for release.
✓ build successful
✓ tests pass`
    // SHIP_FINAL is not in default taxonomy; should still register low because
    // it's at edge with ≥2 evidence markers.
    expect(getCompletionConfidence(text)).toBe('low')
  })

  it('Pattern D: instructional reference → null', () => {
    expect(getCompletionConfidence("Remember to emit [DONE] when truly finished")).toBeNull()
  })

  it("Pattern D: agent quoting role spec — 'do not emit [DONE]' → null", () => {
    expect(getCompletionConfidence("Do not emit [DONE] in text; it is no longer auto-detected")).toBeNull()
  })

  it('Pattern E: explicit [BLOCKER] suppresses any positive signal', () => {
    const text = `[VERIFY_DONE] checks passed
[BLOCKER] but production build fails on signing config`
    expect(getCompletionConfidence(text)).toBeNull()
  })

  it('Pattern F: [EXEC_DONE] at end of message', () => {
    expect(getCompletionConfidence('Implementation wrapped [EXEC_DONE]')).toBe('high')
  })

  it('Pattern G: only [BLOCKER] → null', () => {
    expect(getCompletionConfidence('[BLOCKER] sandbox cannot escalate')).toBeNull()
  })

  it('Pattern H: high with strong negative evidence → downgrade', () => {
    const text = `[VERIFY_DONE] checking artifacts
❌ apksigner failed
❌ keystore mismatch
❌ build error
traceback follows`
    expect(getCompletionConfidence(text)).toBe('low')
  })

  it('Pattern I: empty / whitespace → null', () => {
    expect(getCompletionConfidence('')).toBeNull()
    expect(getCompletionConfidence('   \n  ')).toBeNull()
  })
})

describe('taxonomy override (FUTURE-N: new tags via JSON, no code change)', () => {
  let tempDir: string
  let overrideFile: string
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-signals-'))
    process.env.ENSEMBLE_DATA_DIR = tempDir
    overrideFile = path.join(tempDir, 'completion-signals.json')
    __resetTaxonomyCache()
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalDataDir
    fs.rmSync(tempDir, { recursive: true, force: true })
    __resetTaxonomyCache()
  })

  it('falls back to defaults when override file missing', () => {
    const tax = loadTaxonomy()
    expect(tax.positive_high).toContain('VERIFY_DONE')
  })

  it('honors operator-defined new tag in override file', () => {
    fs.writeFileSync(overrideFile, JSON.stringify({
      positive_high: ['STARSHIP_LANDED'],  // ridiculous tag to prove the path works
    }))
    __resetTaxonomyCache()
    expect(getCompletionConfidence('[STARSHIP_LANDED] all systems green.')).toBe('high')
    // Old default tags REPLACED when explicitly set in override
    expect(getCompletionConfidence('[VERIFY_DONE] approved.')).not.toBe('high')
  })

  it('partial override leaves other categories at defaults', () => {
    fs.writeFileSync(overrideFile, JSON.stringify({
      positive_high: ['SHIP_OK_FINAL'],
      // negative not specified → defaults still in effect
    }))
    __resetTaxonomyCache()
    expect(getCompletionConfidence('[SHIP_OK_FINAL] go go go.')).toBe('high')
    // [BLOCKER] still recognized as negative from default
    expect(getCompletionConfidence('[SHIP_OK_FINAL] go.\n[BLOCKER] wait.')).toBeNull()
  })

  it('hasAnyPositiveCompletionSignal mirrors getCompletionConfidence', () => {
    expect(hasAnyPositiveCompletionSignal('[VERIFY_DONE] ok.')).toBe(true)
    expect(hasAnyPositiveCompletionSignal('[BLOCKER] no.')).toBe(false)
    expect(hasAnyPositiveCompletionSignal('hello world')).toBe(false)
  })
})
