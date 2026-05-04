import { describe, it, expect } from 'vitest'
import { recommendRoleAssignments, type RoleAssignment } from '../lib/calibration'
import type { CalibrationSummary, AgentMetrics } from '../lib/calibration'

function metrics(overrides: Partial<AgentMetrics> & { program: string }): AgentMetrics {
  return {
    agent: overrides.program,
    program: overrides.program,
    teamCount: 50,
    totalMessages: 1000,
    assumptionsVerified: 0, assumptionsRejected: 0, assumptionsFlagged: 0,
    questionsAsked: 0, questionsAnswered: 0, questionsTimedOut: 0,
    confabulations: 0,
    autoFixExhausted: 0,
    verifyRunnerPassed: 0, verifyRunnerFailed: 0,
    assumptionAccuracy: -1,
    questionAnswerRate: -1,
    cleanlinessScore: 1,
    ...overrides,
  }
}

function summaryWith(perProgram: AgentMetrics[]): CalibrationSummary {
  return {
    scannedTeams: 100,
    scannedMessages: 5000,
    perAgent: [],
    perProgram,
    windowDays: Infinity,
  }
}

describe('recommendRoleAssignments — calibration-driven role assignment', () => {
  it('verifier role goes to highest-cleanliness program', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'codex', 'haiku'],
      roles: ['verifier'],
      calibration: summaryWith([
        metrics({ program: 'claude', cleanlinessScore: 0.95, teamCount: 50 }),
        metrics({ program: 'codex',  cleanlinessScore: 0.90, teamCount: 50 }),
        metrics({ program: 'haiku',  cleanlinessScore: 0.99, teamCount: 50 }),
      ]),
      epsilon: 0,  // disable randomization for deterministic test
      rng: () => 0.99,
    })
    expect(r[0].program).toBe('haiku')
    expect(r[0].role).toBe('verifier')
    expect(r[0].reason).toContain('cleanliness')
  })

  it('architect role weighs assumption accuracy + cleanliness', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'codex'],
      roles: ['architect'],
      calibration: summaryWith([
        metrics({ program: 'claude', assumptionAccuracy: 0.95, cleanlinessScore: 0.85, teamCount: 50 }),
        metrics({ program: 'codex',  assumptionAccuracy: 0.50, cleanlinessScore: 0.95, teamCount: 50 }),
      ]),
      epsilon: 0, rng: () => 0.99,
    })
    expect(r[0].program).toBe('claude')
  })

  it('does not assign the same program to two roles', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'codex', 'haiku'],
      roles: ['architect', 'builder', 'verifier'],
      calibration: summaryWith([
        metrics({ program: 'claude', cleanlinessScore: 0.99, assumptionAccuracy: 0.90, teamCount: 50, totalMessages: 1000 }),
        metrics({ program: 'codex',  cleanlinessScore: 0.95, assumptionAccuracy: 0.80, teamCount: 50, totalMessages: 1500 }),
        metrics({ program: 'haiku',  cleanlinessScore: 0.97, assumptionAccuracy: 0.70, teamCount: 50, totalMessages: 800 }),
      ]),
      epsilon: 0, rng: () => 0.99,
    })
    const programsUsed = r.map(a => a.program)
    expect(new Set(programsUsed).size).toBe(programsUsed.length)
    expect(r).toHaveLength(3)
  })

  it('respects min_samples floor — under-sampled program is not ranked', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'sonnet'],
      roles: ['verifier'],
      calibration: summaryWith([
        metrics({ program: 'claude', cleanlinessScore: 0.85, teamCount: 100 }),  // ranked
        metrics({ program: 'sonnet', cleanlinessScore: 0.99, teamCount: 5 }),    // under min_samples
      ]),
      minSamples: 20,
      epsilon: 0, rng: () => 0.99,
    })
    // claude wins because sonnet has too few samples to trust its 0.99
    // (could be lucky); claude's 0.85 over 100 teams is more reliable.
    expect(r[0].program).toBe('claude')
  })

  it('epsilon-greedy fires when rng < epsilon', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'codex'],
      roles: ['verifier'],
      calibration: summaryWith([
        metrics({ program: 'claude', cleanlinessScore: 0.99, teamCount: 50 }),
        metrics({ program: 'codex',  cleanlinessScore: 0.50, teamCount: 50 }),
      ]),
      epsilon: 0.50,
      rng: () => 0.10,  // < epsilon → randomize
    })
    expect(r[0].randomized).toBe(true)
    expect(r[0].reason).toMatch(/epsilon-greedy/)
  })

  it('epsilon-greedy does NOT fire when rng >= epsilon', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'codex'],
      roles: ['verifier'],
      calibration: summaryWith([
        metrics({ program: 'claude', cleanlinessScore: 0.99, teamCount: 50 }),
        metrics({ program: 'codex',  cleanlinessScore: 0.50, teamCount: 50 }),
      ]),
      epsilon: 0.10,
      rng: () => 0.50,  // > epsilon → use ranking
    })
    expect(r[0].randomized).toBe(false)
    expect(r[0].program).toBe('claude')  // wins on cleanliness
  })

  it('handles empty calibration (no programs sampled yet)', () => {
    const r = recommendRoleAssignments({
      programs: ['claude', 'codex'],
      roles: ['architect', 'builder'],
      calibration: summaryWith([]),
      epsilon: 0, rng: () => 0.99,
    })
    expect(r).toHaveLength(2)
    // Both programs treated equally — no panics, no errors
    expect(new Set(r.map(a => a.program)).size).toBe(2)
  })

  it('returns empty when no programs available', () => {
    const r = recommendRoleAssignments({
      programs: [],
      roles: ['verifier'],
      calibration: summaryWith([]),
    })
    expect(r).toEqual([])
  })
})
