/**
 * Completion-signal detection — config-driven, FUTURE-N correct.
 *
 * Background: the previous detector hardcoded HIGH_CONFIDENCE_AT_START /
 * AT_END regexes for [DONE], [VERIFY_DONE], [EXEC_DONE] only, AND required
 * the entire trimmed message to be ≤300 chars to count. Two production
 * failure modes followed:
 *
 *   1. Pattern A (evidence-laden sign-off): claude-1 emits
 *      "[VERIFY_DONE] FINAL — APPROVED. Independent evidence verified.
 *       ✓ Path: ... ✓ Tests 113/113 ..." (>300 chars)
 *      → silently dropped → team idle 615 min, never auto-disbanded.
 *      (libro-doc-scanner team 384fbb38, 2026-05-04)
 *
 *   2. Pattern B (non-canonical sign-off tag): agents use [REVIEW_OK],
 *      [GATES_GREEN], [BUILD_OK], [REVIEW_OK_PARTIAL] which were never in
 *      the whitelist → no detection at all → status=failed without proper
 *      cleanup.  (jsQR team 933f3acc, 2026-05-05)
 *
 * Both are instances of the same root cause: hardcoded tag list +
 * whole-message edge requirement is too narrow. Two of anything is a list,
 * a list is a primitive.
 *
 * Design (FUTURE-N test passes):
 *   - Tag taxonomy lives in JSON config (default embedded, override
 *     readable from ~/.ensemble/completion-signals.json).
 *     New tag forms → JSON edit, zero code change.
 *   - Edge detection runs per-LINE inside the message — long evidence
 *     bodies no longer hide the sign-off.
 *   - Unknown tags still score positive when they:
 *     (a) sit at line edge AND
 *     (b) have ≥2 lexical evidence markers (✓, "passed", "verified", …)
 *     in the same message.
 *     This degrades gracefully for novel sign-off forms agents invent.
 *   - Instructional context (preceded by "emit", "say", "include", …)
 *     suppresses the tag — protects against agents quoting their own role
 *     spec ("don't emit [DONE] in text").
 *
 * Returns the legacy 'high' | 'low' | null shape so the disband watchdog's
 * existing thresholds (TWO_RECENT_COMPLETION, SINGLE_SIGNAL_IDLE_THRESHOLD,
 * LOW_CONFIDENCE_IDLE_THRESHOLD) keep working unchanged.
 */

import fs from 'fs'
import path from 'path'
import { getEnsembleDataDir } from './ensemble-paths'

export interface CompletionTaxonomy {
  /** Strong sign-off tags — "this work is done". */
  positive_high: string[]
  /** Per-stage / partial sign-offs — count toward sign-off when paired with
   *  evidence markers. */
  positive_partial: string[]
  /** Explicit negative — work is NOT done. Force-null any positive score. */
  negative: string[]
  /** Lexical markers immediately preceding a tag that mark instructional
   *  use ("emit X", "say X", "type X"). Suppress detection. */
  instructional_markers: string[]
  /** Lexical markers indicating real work happened. Boost partial tags
   *  and unknown tags. */
  evidence_markers: string[]
  /** Lexical markers indicating failure. Pull score below zero. */
  negative_evidence_markers: string[]
}

const DEFAULT_TAXONOMY: CompletionTaxonomy = {
  positive_high: [
    'DONE', 'COMPLETE', 'FINISHED', 'EXEC_DONE', 'VERIFY_DONE',
    'REVIEW_OK', 'READY-TO-MERGE', 'READY_TO_MERGE',
    'SHIPPED', 'SHIP_OK', 'SIGN_OFF', 'FINAL_SIGN_OFF',
  ],
  positive_partial: [
    'REVIEW_OK_PARTIAL', 'BUILD_OK', 'TESTS_GREEN', 'GATES_GREEN',
    'ENV_AUDIT', 'PROGRESS', 'GATES_OK', 'CHECKS_GREEN',
  ],
  negative: [
    'BLOCKER', 'BLOCKED', 'FAILED', 'REJECT', 'REJECTED',
    'QUESTION', 'UNKNOWN', 'NEEDS_REVIEW',
  ],
  instructional_markers: [
    'emit', 'say', 'use', 'call', 'include', 'append', 'type',
    'write', 'output', 'put', 'add', "don't", 'do not', 'never',
    'avoid', 'should', 'must', 'instructions', 'rule', 'rules',
    'remember to', 'make sure to', 'when ready', 'when done',
  ],
  evidence_markers: [
    '✓', '✅', 'passed', 'succeeded', 'verified', 'approved',
    'merged', '🟢', 'green', 'all clean', 'no errors',
    'build successful', 'BUILD SUCCESSFUL', 'tests pass',
  ],
  negative_evidence_markers: [
    '❌', '🔴', 'failed', 'blocker', 'rejected', 'error', 'exception',
    'traceback', 'cannot', 'unable to',
  ],
}

let cachedTaxonomy: CompletionTaxonomy | null = null
let cachedTaxonomyMtime = 0

/**
 * Load taxonomy with optional file override. Default path is
 * `<ensembleDataDir>/completion-signals.json`. Caches by mtime so changes
 * propagate without restart but the hot path stays cheap.
 */
export function loadTaxonomy(overrideFile?: string): CompletionTaxonomy {
  const file = overrideFile
    ?? path.join(getEnsembleDataDir(), 'completion-signals.json')
  let mtime = 0
  try {
    mtime = fs.statSync(file).mtimeMs
  } catch {
    // No override file → use default. Cache against mtime=0.
  }
  if (cachedTaxonomy && cachedTaxonomyMtime === mtime) return cachedTaxonomy
  if (mtime === 0) {
    cachedTaxonomy = DEFAULT_TAXONOMY
    cachedTaxonomyMtime = 0
    return cachedTaxonomy
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<CompletionTaxonomy>
    cachedTaxonomy = {
      positive_high: raw.positive_high ?? DEFAULT_TAXONOMY.positive_high,
      positive_partial: raw.positive_partial ?? DEFAULT_TAXONOMY.positive_partial,
      negative: raw.negative ?? DEFAULT_TAXONOMY.negative,
      instructional_markers: raw.instructional_markers ?? DEFAULT_TAXONOMY.instructional_markers,
      evidence_markers: raw.evidence_markers ?? DEFAULT_TAXONOMY.evidence_markers,
      negative_evidence_markers: raw.negative_evidence_markers ?? DEFAULT_TAXONOMY.negative_evidence_markers,
    }
    cachedTaxonomyMtime = mtime
    return cachedTaxonomy
  } catch {
    cachedTaxonomy = DEFAULT_TAXONOMY
    cachedTaxonomyMtime = mtime  // don't reread broken file every call
    return cachedTaxonomy
  }
}

/** Reset the cache. Tests use this between mutations. */
export function __resetTaxonomyCache(): void {
  cachedTaxonomy = null
  cachedTaxonomyMtime = 0
}

export type TagPosition = 'line-start' | 'line-end' | 'message-start' | 'message-end' | 'buried'

export interface BracketTag {
  /** The tag name (uppercase, no brackets). */
  name: string
  /** Start char index in the source text. */
  index: number
  /** End-of-tag char index (exclusive). */
  endIndex: number
  /** Where it sits structurally. */
  position: TagPosition
  /** True if preceded by an instructional marker like "emit" or "say". */
  isInstructional: boolean
  /** The full original tag text including brackets. */
  raw: string
}

const TAG_RE = /\[([A-Z][A-Z0-9_\- ]{1,40})\]/g
const INSTRUCTIONAL_LOOKBACK_CHARS = 40

/**
 * Find every bracket-tag in `text` and classify its structural position
 * + instructional context. The structural classification is line-aware:
 * a tag at the start of LINE 3 in a multi-line message is `line-start`,
 * not `buried`.
 */
export function parseBracketTags(text: string, taxonomy: CompletionTaxonomy = loadTaxonomy()): BracketTag[] {
  if (!text) return []
  const tags: BracketTag[] = []
  TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TAG_RE.exec(text)) !== null) {
    const name = match[1].trim().replace(/[ ]+/g, '_').toUpperCase()
    if (!name) continue
    const index = match.index
    const endIndex = index + match[0].length
    const position = classifyTagPosition(text, index, endIndex)
    const lookback = text.slice(Math.max(0, index - INSTRUCTIONAL_LOOKBACK_CHARS), index)
    const isInstructional = isInstructionalContext(lookback, taxonomy.instructional_markers)
    tags.push({ name, index, endIndex, position, isInstructional, raw: match[0] })
  }
  return tags
}

function classifyTagPosition(text: string, start: number, end: number): TagPosition {
  // Find the line boundaries enclosing this tag.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nextNL = text.indexOf('\n', end)
  const lineEnd = nextNL === -1 ? text.length : nextNL
  const before = text.slice(lineStart, start)
  const after = text.slice(end, lineEnd)
  // Allow whitespace + light punctuation around the tag at edges.
  const onlyWsBefore = /^\s*$/.test(before)
  const onlyWsAfter = /^[\s.!,:]*$/.test(after)
  const trimmed = text.trim()
  const messageStart = start === text.indexOf(trimmed) ||
    (onlyWsBefore && lineStart === 0)
  const messageEnd = onlyWsAfter && lineEnd === text.length
  if (messageStart && onlyWsBefore) return 'message-start'
  if (messageEnd && onlyWsAfter) return 'message-end'
  if (onlyWsBefore) return 'line-start'
  if (onlyWsAfter) return 'line-end'
  return 'buried'
}

function isInstructionalContext(lookback: string, markers: string[]): boolean {
  if (!lookback) return false
  const lower = lookback.toLowerCase()
  for (const m of markers) {
    if (m.length === 0) continue
    if (lower.includes(m.toLowerCase())) return true
  }
  return false
}

/**
 * Remove every bracket-tag region from text. Used by the scorer so a tag
 * whose name contains an evidence word doesn't self-promote.
 */
export function stripBracketTagRegions(text: string, tags: BracketTag[]): string {
  if (tags.length === 0) return text
  const sorted = [...tags].sort((a, b) => a.index - b.index)
  let out = ''
  let cursor = 0
  for (const t of sorted) {
    out += text.slice(cursor, t.index)
    cursor = t.endIndex
  }
  out += text.slice(cursor)
  return out
}

/** Count lexical evidence markers present in `text`. */
export function countEvidenceMarkers(text: string, markers: string[]): number {
  if (!text) return 0
  const lower = text.toLowerCase()
  let count = 0
  for (const m of markers) {
    if (m.length === 0) continue
    // Glyphs (✓, ✅, ❌) are matched literally; words are matched lowercased.
    if (m.length <= 2) {
      let idx = 0
      while ((idx = text.indexOf(m, idx)) !== -1) { count++; idx += m.length }
    } else {
      const ml = m.toLowerCase()
      let idx = 0
      while ((idx = lower.indexOf(ml, idx)) !== -1) { count++; idx += ml.length }
    }
  }
  return count
}

/**
 * Score-based completion confidence. Returns the legacy tri-state
 * shape so existing watchdog thresholds keep working.
 *
 * Decision tree (first match wins):
 *   1. Negative tag at edge (non-instructional) → null
 *      (explicit blocker; never disband on this signal)
 *   2. Positive-high tag at edge (non-instructional) → 'high'
 *      (full sign-off, e.g. [VERIFY_DONE], [DONE], [REVIEW_OK])
 *   3. Positive-partial tag at edge + ≥1 evidence marker (non-instructional) → 'high'
 *      (partial sign-off promoted by evidence, e.g. [GATES_GREEN] with ✓✓✓)
 *   4. Positive-partial tag at edge alone → 'low'
 *   5. Unknown tag at edge (non-instructional) + ≥2 evidence markers → 'low'
 *      (graceful fallback for novel sign-off forms)
 *   6. Buried positive tag → null
 *      (consistent with old behavior: buried tags don't sign off)
 */
export function getCompletionConfidence(
  text: string,
  taxonomy: CompletionTaxonomy = loadTaxonomy(),
): 'high' | 'low' | null {
  if (!text || !text.trim()) return null
  const tags = parseBracketTags(text, taxonomy)
  if (tags.length === 0) return null

  // Evidence markers are counted on the *prose*, not the tag bodies. Otherwise
  // a tag whose name contains an evidence word (e.g. [GATES_GREEN] → "green")
  // self-promotes — exactly the false-positive that motivated the original
  // 300-char hack. Strip every bracket-tag region first.
  const prose = stripBracketTagRegions(text, tags)
  const evidenceCount = countEvidenceMarkers(prose, taxonomy.evidence_markers)
  const negativeEvidenceCount = countEvidenceMarkers(prose, taxonomy.negative_evidence_markers)

  const high = new Set(taxonomy.positive_high.map(s => s.toUpperCase()))
  const partial = new Set(taxonomy.positive_partial.map(s => s.toUpperCase()))
  const negative = new Set(taxonomy.negative.map(s => s.toUpperCase()))

  let bestScore: 'high' | 'low' | null = null
  let sawNegativeAtEdge = false

  for (const t of tags) {
    if (t.isInstructional) continue
    const isEdge =
      t.position === 'line-start' ||
      t.position === 'line-end' ||
      t.position === 'message-start' ||
      t.position === 'message-end'
    if (!isEdge) continue

    if (negative.has(t.name)) {
      sawNegativeAtEdge = true
      continue
    }
    if (high.has(t.name)) {
      // Negative evidence markers can downgrade a high signal.
      if (negativeEvidenceCount > evidenceCount + 1) {
        bestScore = bestScore === 'high' ? bestScore : 'low'
      } else {
        bestScore = 'high'
      }
      continue
    }
    if (partial.has(t.name)) {
      if (evidenceCount >= 1 && negativeEvidenceCount <= evidenceCount) {
        bestScore = bestScore === 'high' ? bestScore : 'high'  // promoted
      } else if (bestScore === null) {
        bestScore = 'low'
      }
      continue
    }
    // Unknown tag at edge — graceful fallback for novel sign-off forms.
    if (evidenceCount >= 2 && negativeEvidenceCount === 0 && bestScore === null) {
      bestScore = 'low'
    }
  }

  if (sawNegativeAtEdge) {
    // Explicit blocker overrides positive — agent declared trouble. Don't disband.
    return null
  }
  return bestScore
}

/**
 * Convenience: does this text contain any positive completion signal
 * (high or low) regardless of strength? Used by the stuck-idle safety
 * net to detect "agents claim done but watchdog didn't fire".
 */
export function hasAnyPositiveCompletionSignal(
  text: string,
  taxonomy: CompletionTaxonomy = loadTaxonomy(),
): boolean {
  return getCompletionConfidence(text, taxonomy) !== null
}
