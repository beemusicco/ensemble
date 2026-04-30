import { describe, expect, it } from 'vitest'
import { findTags } from '../lib/tag-parser'

describe('tag-parser (bracket-balanced)', () => {
  it('extracts a simple tag body', () => {
    const r = findTags('hello [UNKNOWN: what is X] world', 'UNKNOWN')
    expect(r).toHaveLength(1)
    expect(r[0].body).toBe('what is X')
  })

  it('extracts multiple tags in one message', () => {
    const r = findTags('[UNKNOWN: a] and [UNKNOWN: b]', 'UNKNOWN')
    expect(r.map(x => x.body)).toEqual(['a', 'b'])
  })

  it('preserves array literals inside the body — the production bug fix', () => {
    // The OLD regex truncated this at the first `]`. Now bracket-balanced
    // parsing keeps the full body.
    const text = '[ASSUMPTION: backend accepts None ## verify: python3 -c "x=[1,2,3]; print(x)"]'
    const r = findTags(text, 'ASSUMPTION')
    expect(r).toHaveLength(1)
    expect(r[0].body).toContain('python3 -c')
    expect(r[0].body).toContain('[1,2,3]')
    expect(r[0].body.endsWith('print(x)"')).toBe(true)
  })

  it('handles nested same-tag — outer body includes the inner', () => {
    const text = '[UNKNOWN: foo [UNKNOWN: bar]]'
    const r = findTags(text, 'UNKNOWN')
    // The outer `[UNKNOWN:` opens depth=1, then inner `[` increments to 2,
    // first `]` decrements to 1, second `]` decrements to 0 → outer closes.
    // findTags emits ONE outer tag; subsequent search resumes after outer end.
    expect(r).toHaveLength(1)
    expect(r[0].body).toBe('foo [UNKNOWN: bar]')
  })

  it('newline before close → no match (single-line by design)', () => {
    const r = findTags('[UNKNOWN: foo\nbar]', 'UNKNOWN')
    expect(r).toEqual([])
  })

  it('respects maxBodyChars cap', () => {
    const long = 'x'.repeat(700)
    const r = findTags(`[UNKNOWN: ${long}]`, 'UNKNOWN', { maxBodyChars: 100 })
    expect(r).toEqual([])  // body grew past cap before close — unmatched
  })

  it('returns startIdx/endIdx for tag span', () => {
    const text = 'before [UNKNOWN: x] after'
    const r = findTags(text, 'UNKNOWN')
    expect(text.slice(r[0].startIdx, r[0].endIdx + 1)).toBe('[UNKNOWN: x]')
  })

  it('skips empty tags', () => {
    const r = findTags('[UNKNOWN: ]', 'UNKNOWN')
    expect(r).toEqual([])
  })

  it('ignores unmatched openers without crashing', () => {
    const r = findTags('[UNKNOWN: foo with no close', 'UNKNOWN')
    expect(r).toEqual([])
  })

  it('does not match a different tag name', () => {
    const r = findTags('[QUESTION: hi]', 'UNKNOWN')
    expect(r).toEqual([])
  })
})
