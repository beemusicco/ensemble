import { describe, it, expect } from 'vitest'
import { detectOperatorHold, isReleaseHoldRequest } from '../lib/operator-hold'

describe('detectOperatorHold — Slovenian patterns', () => {
  it('matches "ne disbandajte"', () => {
    expect(detectOperatorHold('Naredi nalogo. NE DISBAND-AJTE.').hold).toBe(true)
    expect(detectOperatorHold('ne disbandajte plz').hold).toBe(true)
  })

  it('matches "ne razpustite"', () => {
    expect(detectOperatorHold('Ne razpustite tima.').hold).toBe(true)
    expect(detectOperatorHold('NE RAZPUSTI EKIPE').hold).toBe(true)
  })

  it('matches "mirujte"', () => {
    expect(detectOperatorHold('Po koncu mirujte. Človek odloči.').hold).toBe(true)
  })

  it('matches "čakam na operatorja"', () => {
    expect(detectOperatorHold('Čakam na operatorja.').hold).toBe(true)
    expect(detectOperatorHold('čakajte na človeka').hold).toBe(true)
  })

  it('matches "človek odloča"', () => {
    expect(detectOperatorHold('Človek se odloči.').hold).toBe(true)
  })
})

describe('detectOperatorHold — English patterns', () => {
  it('matches "do not disband"', () => {
    expect(detectOperatorHold('Do not disband. Human decides.').hold).toBe(true)
    expect(detectOperatorHold('do not auto-disband').hold).toBe(true)
  })

  it('matches "wait for human"', () => {
    expect(detectOperatorHold('After completion, wait for human review.').hold).toBe(true)
    expect(detectOperatorHold('Wait for operator before merging.').hold).toBe(true)
  })

  it('matches "hold position" / "hold for review"', () => {
    expect(detectOperatorHold('Hold position until I check.').hold).toBe(true)
    expect(detectOperatorHold('Then hold for review.').hold).toBe(true)
  })

  it('matches "human decides" / "operator decides"', () => {
    expect(detectOperatorHold('Human decides on merge.').hold).toBe(true)
    expect(detectOperatorHold('operator decides').hold).toBe(true)
  })

  it('matches the inline [HOLD] marker', () => {
    expect(detectOperatorHold('Just do the work. [HOLD]').hold).toBe(true)
    expect(detectOperatorHold('Some text [HOLD-FOR-OPERATOR] more text').hold).toBe(true)
  })
})

describe('detectOperatorHold — false-positive resistance', () => {
  it('returns hold=false on unrelated text', () => {
    const cases = [
      'Implement the bug fix and run tests.',
      'Add a SEPA XML generator.',
      'Refactor the database schema.',
      '',
    ]
    for (const c of cases) {
      expect(detectOperatorHold(c).hold).toBe(false)
    }
  })

  it('ignores patterns inside fenced code blocks', () => {
    const text = [
      'Implement parser. Example to follow:',
      '```',
      '// do not disband — left as a TODO comment for later',
      '```',
      'Now run tests.',
    ].join('\n')
    expect(detectOperatorHold(text).hold).toBe(false)
  })

  it('ignores patterns inside inline code', () => {
    const text = 'The flag is `do not disband` in the config.'
    expect(detectOperatorHold(text).hold).toBe(false)
  })

  it('ignores patterns inside markdown blockquotes', () => {
    const text = ['Background quoted from past convo:', '> human decides', 'Now do the work.'].join('\n')
    expect(detectOperatorHold(text).hold).toBe(false)
  })

  it('returns hold=false for null/undefined input', () => {
    expect(detectOperatorHold(null).hold).toBe(false)
    expect(detectOperatorHold(undefined).hold).toBe(false)
  })
})

describe('detectOperatorHold — metadata', () => {
  it('returns matched pattern name as reason', () => {
    const r = detectOperatorHold('NE DISBAND-AJTE plz')
    expect(r.hold).toBe(true)
    expect(r.reason).toMatch(/^keyword:si:ne-disband$/)
    expect(r.matchedPattern).toBeDefined()
  })

  it('returns first-match wins (deterministic)', () => {
    // Both "ne disbandajte" AND "[HOLD]" present — should pick whichever fires first.
    const r = detectOperatorHold('Mixed: ne disbandajte and [HOLD]')
    expect(r.hold).toBe(true)
    expect(r.reason?.startsWith('keyword:')).toBe(true)
  })
})

describe('isReleaseHoldRequest', () => {
  it('matches "/release-hold"', () => {
    expect(isReleaseHoldRequest('/release-hold')).toBe(true)
    expect(isReleaseHoldRequest('  /release-hold now')).toBe(true)
    expect(isReleaseHoldRequest('/release hold')).toBe(true)
  })

  it('matches "[/HOLD-OFF]" + "[RELEASE-HOLD]"', () => {
    expect(isReleaseHoldRequest('done [/HOLD-OFF]')).toBe(true)
    expect(isReleaseHoldRequest('[RELEASE-HOLD]')).toBe(true)
  })

  it('does not match unrelated text', () => {
    expect(isReleaseHoldRequest('release the kraken')).toBe(false)
    expect(isReleaseHoldRequest('hold for review')).toBe(false)
    expect(isReleaseHoldRequest('')).toBe(false)
  })
})
