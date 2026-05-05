/**
 * Operator-hold primitive.
 *
 * Lets the operator say "this team must NOT auto-disband — I will decide when
 * it ends" inside the task description, OR explicitly via an API field. When
 * set, three completion-claim paths are suppressed:
 *
 *   1. signalCompleteTeam()              — agent's [SIGNAL_COMPLETE] tool call
 *   2. [READY-TO-MERGE] quorum + idle    — pattern-based completion sniffer
 *   3. standing-by + idle                — "agents declared waiting" sniffer
 *
 * NOT suppressed (genuine safety nets — must fire even with hold):
 *   - Lifetime-cap (90min default)       — prevents zombie teams forever
 *   - Soft-cap (60min age + 15min idle)  — defends against hung sessions
 *   - Watchdog (triangular-chatter etc.) — defends against runaway loops
 *   - All-stalled with live-bash check   — defends against truly dead teams
 *
 * Released via:
 *   - POST /api/ensemble/teams/:id/release-hold
 *   - operator message containing /release-hold or [/HOLD-OFF]
 *
 * Why this exists: 7-day production data showed 154 signal-complete disbands
 * vs explicit operator instructions like "NE DISBAND-AJTE" / "wait for human"
 * being completely ignored. The agent's claim of completion overrides the
 * operator's instruction every time. This primitive flips that.
 */

export interface HoldDetection {
  hold: boolean
  reason?: string
  matchedPattern?: string
}

// Multi-language detection patterns. Operator can write in SI or EN; both
// must reach the same flag. Patterns are intentionally specific — generic
// declarative phrases like "operator decides" or "human decides" false-fire
// on review-style language ("operator decides which feature to ship next",
// "human decides whether to merge"), so they were dropped 2026-05-05 after
// a DEEP RESEARCH collab silently held for 36+ minutes on a single
// post-collab review sentence ("Operator decides which to implement").
//
// Iron rule for hold patterns: only IMPERATIVE / DIRECTIVE forms count. The
// operator must be telling the *team* not to disband, not describing a
// post-collab decision flow.
//
// Unicode-aware boundaries: `\b` in JS is ASCII-only, so it breaks for words
// starting with `č`, `š`, `ž`. We use Unicode property escapes (`\p{L}` =
// any letter) with the `u` flag to compose proper word boundaries for
// Slovenian patterns: NB = "not preceded/followed by a letter".
const NB = '(?:^|(?<=[^\\p{L}]))'        // start or after non-letter
const NA = '(?=[^\\p{L}]|$)'             // end or before non-letter
const HOLD_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // Slovenian — imperatives / explicit hold-on-team directives
  { name: 'si:ne-disband', regex: new RegExp(`${NB}ne\\s+disband[-\\s]?ajte?${NA}`, 'iu') },
  { name: 'si:ne-razpust', regex: new RegExp(`${NB}ne\\s+razpust(i|ite)${NA}`, 'iu') },
  { name: 'si:mirujte', regex: new RegExp(`${NB}miruj(te)?${NA}`, 'iu') },
  { name: 'si:cakaj-na', regex: new RegExp(`${NB}čak(am|aj(te)?|amo)\\s+na\\s+(mene|operatorja|človeka|Sama)`, 'iu') },
  // English — imperatives only
  { name: 'en:do-not-disband', regex: /\bdo\s+not\s+(auto[-\s]?)?disband\b/i },
  { name: 'en:wait-for-human', regex: /\bwait\s+for\s+(human|operator|me)\b/i },
  { name: 'en:hold-position', regex: /\bhold\s+position\b/i },
  { name: 'en:hold-for-review', regex: /\bhold\s+for\s+review\b/i },
  // Self-describing inline marker — operator drops [HOLD] in their task text
  { name: 'marker:hold', regex: /\[HOLD\]|\[HOLD-FOR-OPERATOR\]/ },
  // Removed (2026-05-05): si:clovek-odloca, si:operator-odloca, en:human-decides,
  // en:operator-decides — declarative forms with too-broad recall. Operators
  // who genuinely want a hold use one of the imperative patterns above OR
  // the explicit [HOLD] marker.
]

// Strip code blocks and inline code so a `\bdo not disband\b` mentioned in
// a quoted example doesn't false-trigger. Keep paragraph text only.
function stripCodeBlocksAndQuotes(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')      // fenced code blocks
    .replace(/`[^`]*`/g, '')             // inline code
    .replace(/^\s*>\s.*$/gm, '')         // blockquoted lines (markdown)
}

/**
 * Detects operator's hold intent in arbitrary text.
 *
 * Defensive: returns hold=true on FIRST match. Operator only needs to write
 * one of the patterns — they don't all have to be present. Code blocks are
 * stripped so a hold pattern quoted as an example doesn't false-trigger.
 */
export function detectOperatorHold(text: string | null | undefined): HoldDetection {
  if (!text) return { hold: false }
  const cleaned = stripCodeBlocksAndQuotes(text)
  for (const { name, regex } of HOLD_PATTERNS) {
    const match = cleaned.match(regex)
    if (match) {
      return {
        hold: true,
        reason: `keyword:${name}`,
        matchedPattern: match[0].slice(0, 60),
      }
    }
  }
  return { hold: false }
}

// Release patterns — what operator types when they want to take the hold off.
// Used both for HTTP body parsing AND for parsing operator messages posted to
// the team feed.
const RELEASE_PATTERNS: RegExp[] = [
  /^\s*\/release[-\s]?hold\b/i,
  /\[\/?HOLD[-\s]?OFF\]/i,
  /\[RELEASE[-\s]?HOLD\]/i,
]

export function isReleaseHoldRequest(text: string | null | undefined): boolean {
  if (!text) return false
  return RELEASE_PATTERNS.some((re) => re.test(text))
}
