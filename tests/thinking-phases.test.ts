import { describe, it, expect } from 'vitest'
import type { EnsembleMessage } from '../types/ensemble'
import {
  getCurrentPhase, isPhaseRegression, analyzeThinking, pruneAlreadyWarned,
  THINKING_PHASES,
} from '../lib/thinking-phases'

function msg(partial: Partial<EnsembleMessage>): EnsembleMessage {
  return {
    id: partial.id ?? 'id-' + Math.random().toString(36).slice(2, 8),
    teamId: 't1',
    from: partial.from ?? 'agent-1',
    to: 'team',
    content: partial.content ?? '',
    type: partial.type ?? 'chat',
    timestamp: partial.timestamp ?? '2026-04-24T10:00:00.000Z',
    ...(partial.meta ? { meta: partial.meta } : {}),
  }
}

describe('getCurrentPhase', () => {
  it('returns null when team has no phase messages', () => {
    expect(getCurrentPhase([msg({ type: 'chat' })])).toBeNull()
  })

  it('returns the most recent phase', () => {
    const messages = [
      msg({ type: 'phase', meta: { phase: 'frame' } }),
      msg({ type: 'chat', content: 'work...' }),
      msg({ type: 'phase', meta: { phase: 'evidence' } }),
    ]
    expect(getCurrentPhase(messages)).toBe('evidence')
  })

  it('falls back to parsing content when meta is missing', () => {
    const messages = [msg({ type: 'phase', content: '[PHASE] synthesis', meta: {} })]
    expect(getCurrentPhase(messages)).toBe('synthesis')
  })
})

describe('isPhaseRegression', () => {
  it('detects backwards movement', () => {
    expect(isPhaseRegression('evidence', 'frame')).toBe(true)
    expect(isPhaseRegression('synthesis', 'evidence')).toBe(true)
  })
  it('allows forward movement', () => {
    expect(isPhaseRegression('frame', 'evidence')).toBe(false)
    expect(isPhaseRegression('evidence', 'synthesis')).toBe(false)
  })
  it('treats null start as non-regression', () => {
    expect(isPhaseRegression(null, 'frame')).toBe(false)
  })
})

describe('analyzeThinking', () => {
  it('returns no findings outside thinking mode', () => {
    const findings = analyzeThinking([
      msg({ type: 'chat', content: 'hi' }),
      msg({ type: 'chat', content: 'bye' }),
    ])
    expect(findings).toEqual([])
  })

  it('flags hypothesis posted without preceding retrieval', () => {
    const messages = [
      msg({ type: 'phase', meta: { phase: 'frame' } }),
      msg({ type: 'hypothesis', from: 'codex-1', meta: { hypothesisId: 'H1' }, content: 'test' }),
    ]
    const findings = analyzeThinking(messages)
    expect(findings.some(f => f.code === 'hypothesis_without_retrieval')).toBe(true)
  })

  it('accepts hypothesis when retrieval happened within 20 messages', () => {
    const messages = [
      msg({ type: 'phase', meta: { phase: 'frame' } }),
      msg({ type: 'chat', from: 'codex-1', content: 'ran team-history search "off-by-one"' }),
      msg({ type: 'hypothesis', from: 'codex-1', meta: { hypothesisId: 'H1' }, content: 'test' }),
    ]
    const findings = analyzeThinking(messages)
    expect(findings.some(f => f.code === 'hypothesis_without_retrieval')).toBe(false)
  })

  it('flags evidence for unknown hypothesis', () => {
    const messages = [
      msg({ type: 'phase', meta: { phase: 'evidence' } }),
      msg({ type: 'chat', from: 'codex-1', content: 'team-recall results' }),
      msg({ type: 'hypothesis', from: 'codex-1', meta: { hypothesisId: 'H1' }, content: 'x' }),
      msg({ type: 'evidence', from: 'claude-2', meta: { hypothesisId: 'H99', source: 'cmd' }, content: 'ok' }),
    ]
    const findings = analyzeThinking(messages)
    expect(findings.some(f => f.code === 'evidence_for_unknown_hypothesis')).toBe(true)
  })

  it('flags decision without any evidence for the picked hypothesis', () => {
    const messages = [
      msg({ type: 'phase', meta: { phase: 'synthesis' } }),
      msg({ type: 'chat', from: 'codex-1', content: 'team-history search done' }),
      msg({ type: 'hypothesis', from: 'codex-1', meta: { hypothesisId: 'H1' } }),
      msg({ type: 'challenge', from: 'claude-2', meta: { targetId: 'H1' } }),
      msg({ type: 'decision_pick', from: 'codex-1', meta: { hypothesisId: 'H1' } }),
    ]
    const findings = analyzeThinking(messages)
    expect(findings.some(f => f.code === 'decision_without_evidence')).toBe(true)
  })

  it('flags decision when no challenge was ever logged', () => {
    const messages = [
      msg({ type: 'phase', meta: { phase: 'synthesis' } }),
      msg({ type: 'chat', from: 'codex-1', content: 'team-recall' }),
      msg({ type: 'hypothesis', from: 'codex-1', meta: { hypothesisId: 'H1' } }),
      msg({ type: 'evidence', from: 'codex-1', meta: { hypothesisId: 'H1', source: 'cmd' } }),
      msg({ type: 'decision_pick', from: 'codex-1', meta: { hypothesisId: 'H1' } }),
    ]
    const findings = analyzeThinking(messages)
    expect(findings.some(f => f.code === 'decision_without_challenge')).toBe(true)
  })

  it('flags circling: same hypothesis cited 4+ times with no decision', () => {
    const messages = [
      msg({ type: 'phase', meta: { phase: 'evidence' } }),
      msg({ type: 'chat', from: 'codex-1', content: 'team-recall' }),
      msg({ type: 'hypothesis', from: 'codex-1', meta: { hypothesisId: 'H1' } }),
      msg({ type: 'hypothesis', from: 'codex-1', meta: { hypothesisId: 'H1' } }),
      msg({ type: 'hypothesis', from: 'claude-2', meta: { hypothesisId: 'H1' } }),
      msg({ type: 'hypothesis', from: 'codex-1', meta: { hypothesisId: 'H1' } }),
    ]
    const findings = analyzeThinking(messages)
    expect(findings.some(f => f.code === 'hypothesis_circling')).toBe(true)
  })

  it('all six phases are declared in order', () => {
    expect(THINKING_PHASES).toEqual(['frame', 'evidence', 'synthesis', 'action', 'verify', 'reflect'])
  })
})

describe('pruneAlreadyWarned', () => {
  it('drops findings that match a prior supervisor_warning by code+target', () => {
    const messages = [
      msg({
        type: 'supervisor_warning',
        meta: { code: 'decision_without_challenge', target: 'H1' },
      }),
    ]
    const incoming = [
      { code: 'decision_without_challenge', severity: 'warn' as const, message: 'x', evidence: { hypothesisId: 'H1' } },
      { code: 'decision_without_challenge', severity: 'warn' as const, message: 'y', evidence: { hypothesisId: 'H2' } },
    ]
    const out = pruneAlreadyWarned(incoming, messages)
    expect(out).toHaveLength(1)
    expect(out[0].evidence?.hypothesisId).toBe('H2')
  })
})
