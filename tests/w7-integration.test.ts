import { describe, it, expect } from 'vitest'
import { recommendRoleAssignments } from '../lib/calibration'
import type { CalibrationSummary, AgentMetrics } from '../lib/calibration'

/**
 * W7 integration tests — calibration→role wiring + rescue spawn gating.
 * The rescueFailingTeam function itself short-circuits in test mode, so we
 * verify the GATING contract (env-disabled / test-mode / cap), not the
 * full spawn lifecycle (which requires a real tmux runtime).
 */

function metrics(o: Partial<AgentMetrics> & { program: string }): AgentMetrics {
  const base: AgentMetrics = {
    agent: o.program, program: o.program,
    teamCount: 50, totalMessages: 1000,
    assumptionsVerified: 0, assumptionsRejected: 0, assumptionsFlagged: 0,
    questionsAsked: 0, questionsAnswered: 0, questionsTimedOut: 0,
    confabulations: 0, autoFixExhausted: 0,
    verifyRunnerPassed: 0, verifyRunnerFailed: 0,
    assumptionAccuracy: -1, questionAnswerRate: -1, cleanlinessScore: 1,
  }
  return { ...base, ...o }
}

const summary = (perProgram: AgentMetrics[]): CalibrationSummary => ({
  scannedTeams: 100, scannedMessages: 5000,
  perAgent: [], perProgram, windowDays: Infinity,
})

describe('W7 calibration role assignment — three-program scenario', () => {
  it('correctly assigns architect/builder/verifier across diverse calibration', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'codex', 'haiku'],
      roles: ['architect', 'builder', 'verifier'],
      calibration: summary([
        // claude: best assumption accuracy, decent cleanliness
        metrics({ program: 'claude', assumptionAccuracy: 0.95, cleanlinessScore: 0.92, totalMessages: 1500, teamCount: 100 }),
        // codex: middling on both, highest productivity
        metrics({ program: 'codex',  assumptionAccuracy: 0.75, cleanlinessScore: 0.92, totalMessages: 2500, teamCount: 100 }),
        // haiku: highest cleanliness
        metrics({ program: 'haiku',  assumptionAccuracy: 0.50, cleanlinessScore: 0.99, totalMessages: 600, teamCount: 100 }),
      ]),
      epsilon: 0,
      rng: () => 0.99,
    })
    expect(r).toHaveLength(3)
    // First ranked role (architect) prefers high assumption accuracy → claude wins
    expect(r[0]).toMatchObject({ program: 'claude', role: 'architect' })
    // Verifier prefers highest cleanliness — haiku still has 0.99 vs codex 0.92
    // (claude already used). So haiku gets verifier-class assignment when role
    // is in [builder, verifier] order. Builder takes whoever is left.
    const remaining = r.slice(1).map(x => x.program).sort()
    expect(remaining).toEqual(['codex', 'haiku'])
  })

  it('two-program team: simpler choice, no double-assignment', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'codex'],
      roles: ['architect', 'verifier'],
      calibration: summary([
        metrics({ program: 'claude', assumptionAccuracy: 0.90, cleanlinessScore: 0.85, teamCount: 50 }),
        metrics({ program: 'codex',  assumptionAccuracy: 0.40, cleanlinessScore: 0.99, teamCount: 50 }),
      ]),
      epsilon: 0, rng: () => 0.99,
    })
    expect(r[0].program).toBe('claude')   // architect → high accuracy
    expect(r[1].program).toBe('codex')    // verifier → high cleanliness
  })

  it('single-program list returns single assignment', () => {
    const r = recommendRoleAssignments({
      programs: ['claude'],
      roles: ['architect'],
      calibration: summary([
        metrics({ program: 'claude', assumptionAccuracy: 0.90, cleanlinessScore: 0.85, teamCount: 50 }),
      ]),
    })
    expect(r).toHaveLength(1)
    expect(r[0].program).toBe('claude')
  })
})

describe('W7 rescueFailingTeam — env gating contract', () => {
  it('refuses to spawn when ENSEMBLE_AUTO_RESCUE_SPAWN=0', async () => {
    const original = process.env.ENSEMBLE_AUTO_RESCUE_SPAWN
    process.env.ENSEMBLE_AUTO_RESCUE_SPAWN = '0'
    try {
      const { rescueFailingTeam } = await import('../services/ensemble-service')
      const r = await rescueFailingTeam('does-not-matter', { gateId: 'pytest', errorContext: 'whatever' })
      expect(r.data?.rescued).toBe(false)
      expect(r.data?.reason).toBe('env-disabled')
    } finally {
      if (original === undefined) delete process.env.ENSEMBLE_AUTO_RESCUE_SPAWN
      else process.env.ENSEMBLE_AUTO_RESCUE_SPAWN = original
    }
  })

  it('refuses to spawn under VITEST (test-mode short-circuit)', async () => {
    const { rescueFailingTeam } = await import('../services/ensemble-service')
    // VITEST is auto-set by the test runner; this should always trip the test-mode guard
    const r = await rescueFailingTeam('does-not-matter', { gateId: 'pytest', errorContext: 'whatever' })
    expect(r.data?.rescued).toBe(false)
    expect(r.data?.reason).toBe('test-mode')
  })
})
