/**
 * Watchdog polite-ack detection tests — ensures the expanded isPoliteAckPhrase
 * classifier catches the "Standing by / Ready to assist / Awaiting instructions"
 * family that used to escape repeat-based idle detection.
 *
 * Run: cd ensemble && ./node_modules/.bin/vitest run tests/test_watchdog_ack.ts
 */
import { describe, expect, it } from 'vitest'
import { isPoliteAckPhrase, isSemanticIdle } from '../lib/agent-watchdog'
import type { EnsembleMessage } from '../types/ensemble'

function msg(content: string, from = 'agent-1'): EnsembleMessage {
  return {
    id: crypto.randomUUID(),
    teamId: 'test',
    from,
    to: 'team',
    content,
    type: 'chat',
    timestamp: new Date().toISOString(),
  }
}

describe('isPoliteAckPhrase', () => {
  it.each([
    'Idle.',
    'Acknowledged.',
    '[ACK] Idle.',
    'Standing by.',
    'Ready to assist.',
    "I'm ready to assist with the next task.",
    'Awaiting instructions.',
    'Awaiting your input.',
    'Let me know how I can help.',
    'How can I help?',
    'Waiting for further guidance.',
    'On standby.',
    'No new update.',
    'Still monitoring.',
    'OK',
    'Got it',
    'Understood.',
    'Zaključeno.',
  ])('detects "%s" as ack', (text) => {
    expect(isPoliteAckPhrase(text)).toBe(true)
  })

  it.each([
    '[PLAN] I will tackle task X by writing module Y and tests Z.',
    '[FINDING] Bug at app.py:42 — null dereference on empty config.',
    'The database query returned 3 rows with unexpected nulls.',
    'I have implemented the feature and ran the tests.',
  ])('does NOT match substantive message "%s"', (text) => {
    expect(isPoliteAckPhrase(text)).toBe(false)
  })
})

describe('isSemanticIdle', () => {
  it('detects 3 varied ack-phrases in a row', () => {
    // Different wording each time — escapes the old repeat-hash detector
    const window = [
      msg('Idle.'),
      msg('Standing by.'),
      msg("I'm ready to assist."),
    ]
    expect(isSemanticIdle(window, 3)).toBe(true)
  })

  it('still detects 3 identical messages (legacy signal)', () => {
    const window = [msg('[ACK] Idle.'), msg('Idle.'), msg('Idle.')]
    expect(isSemanticIdle(window, 3)).toBe(true)
  })

  it('does not flag substantive work', () => {
    const window = [
      msg('[PLAN] I own file A and will ship in 30 min.'),
      msg('[PROGRESS] Wrote 3 files, 120 lines.'),
      msg('[FINDING] Tests passed, committing.'),
    ]
    expect(isSemanticIdle(window, 3)).toBe(false)
  })

  it('mixed: some ack, some real — only 1/3 ack, not idle', () => {
    const window = [
      msg('[ACK] Idle.'),
      msg('[PLAN] I will refactor X.'),
      msg('[PROGRESS] Done with X.'),
    ]
    expect(isSemanticIdle(window, 3)).toBe(false)
  })
})
