import { describe, expect, it } from 'vitest'
import type { EnsembleMessage } from '../types/ensemble'
import { buildTeamImpactSummary } from '../services/ensemble-service'

function evt(event: string, meta: Record<string, unknown> = {}): EnsembleMessage {
  return {
    id: 'x', teamId: 't', from: 'ensemble', to: 'team',
    content: '', type: 'chat', timestamp: new Date().toISOString(),
    meta: { event, ...meta },
  }
}

describe('buildTeamImpactSummary', () => {
  it('returns empty string when no events', () => {
    expect(buildTeamImpactSummary([])).toBe('')
    expect(buildTeamImpactSummary([{
      id: 'x', teamId: 't', from: 'codex-1', to: 'team',
      content: 'just chatting', type: 'chat', timestamp: new Date().toISOString(),
    }])).toBe('')
  })

  it('aggregates assumption verified vs rejected', () => {
    const text = buildTeamImpactSummary([
      evt('assumption_verified', { passed: true }),
      evt('assumption_verified', { passed: true }),
      evt('assumption_verified', { passed: false }),
    ])
    expect(text).toContain('assumptions 2🟢/1🔴')
  })

  it('aggregates confabulations + questions + verify-runner together', () => {
    const text = buildTeamImpactSummary([
      evt('confabulation'),
      evt('confabulation'),
      evt('question_pending'),
      evt('question_answered'),
      evt('question_timeout'),
      evt('verify_runner', { passed: 3, failed: 0, errored: 0 }),
      evt('verify_runner', { passed: 1, failed: 1, errored: 0 }),
    ])
    expect(text).toContain('2 confabs caught')
    expect(text).toContain('questions 1✅/1⏱')
    expect(text).toContain('verify-runner 1✅/1❌')
  })

  it('shows auto-fix exhausted when present', () => {
    const text = buildTeamImpactSummary([
      evt('auto_fix_exhausted'),
    ])
    expect(text).toContain('auto-fix exhausted')
  })

  it('starts with the 📊 collab impact header', () => {
    const text = buildTeamImpactSummary([evt('confabulation')])
    expect(text.startsWith('📊 collab impact:')).toBe(true)
  })

  it('reports unknown_resolved as a separate metric', () => {
    const text = buildTeamImpactSummary([
      evt('unknown_resolved'),
      evt('unknown_resolved'),
    ])
    expect(text).toContain('2 [UNKNOWN] resolved')
  })
})
