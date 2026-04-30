/**
 * Bracket-balanced tag parser — extracts `[TAG: body]` markers from agent
 * messages while correctly handling `]` characters that legitimately appear
 * inside the body (e.g. shell command arrays, dict literals, list comprehensions).
 *
 * Why we don't use regex: production observation (collab 1781bdca, 2026-04-30)
 * showed agents emitting:
 *
 *   [ASSUMPTION: backend accepts None ## verify: python3 -c "x=[1,2,3]; print(x)"]
 *
 * The original regex `\[ASSUMPTION:\s*([^\]\n]{1,400})\]` stops at the FIRST
 * `]`, truncating the verify cmd at `x=[1,2,3` — which then fails bash parsing
 * with an "unbalanced quote" error. Agent had to fall back to manual verify.
 *
 * Strategy: find the opener `[<TAG>:`, then walk forward counting bracket
 * depth — open `[` increments, close `]` decrements, depth=0 closes the tag.
 * Newline still ends an unclosed tag (single-line by design — multi-line tag
 * bodies would conflict with team-say's line-buffered chat semantics).
 *
 * Body length cap is a sanity check against runaway emissions; default 600
 * chars is 50% over the original ASSUMPTION/QUESTION cap (400) and well over
 * UNKNOWN (200). Per-tag callers can override.
 */

export interface ParsedTag {
  tag: string
  body: string
  startIdx: number  // index in source text of the opening `[`
  endIdx: number    // index in source text of the closing `]`
}

export interface FindTagsOptions {
  maxBodyChars?: number
}

const DEFAULT_MAX_BODY = 600

export function findTags(
  text: string,
  tagName: string,
  opts: FindTagsOptions = {},
): ParsedTag[] {
  if (!text || !tagName) return []
  const maxBody = opts.maxBodyChars ?? DEFAULT_MAX_BODY
  const opener = `[${tagName}:`
  const out: ParsedTag[] = []
  let pos = 0
  while (pos < text.length) {
    const start = text.indexOf(opener, pos)
    if (start === -1) break
    const bodyStart = start + opener.length
    let i = bodyStart
    let depth = 1
    let endIdx = -1
    while (i < text.length) {
      // Hard cap: stop scanning if body grows past limit; treat as unmatched
      if (i - bodyStart > maxBody) break
      const c = text[i]
      if (c === '\n') {
        // Newline ends an unclosed tag at the outer level.
        // (We don't allow multi-line tag bodies — agents type these in chat.)
        break
      } else if (c === '[') {
        depth++
      } else if (c === ']') {
        depth--
        if (depth === 0) {
          endIdx = i
          break
        }
      }
      i++
    }
    if (endIdx === -1) {
      // No matching close — advance past the opener to avoid re-matching it,
      // but don't emit anything for this candidate.
      pos = bodyStart
      continue
    }
    const body = text.slice(bodyStart, endIdx).trim()
    if (body) {
      out.push({ tag: tagName, body, startIdx: start, endIdx })
    }
    pos = endIdx + 1
  }
  return out
}
