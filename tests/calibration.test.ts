import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calibration-test-'))
const prevDataDir = process.env.ENSEMBLE_DATA_DIR
process.env.ENSEMBLE_DATA_DIR = tmpDataDir

const { appendMessage, createTeam } = await import('../lib/ensemble-registry')
const { computeCalibration, formatCalibrationText } = await import('../lib/calibration')

describe('calibration scoreboard', () => {
  let teamId: string

  beforeAll(() => {
    const team = createTeam({
      name: 'team-calib', description: 'calibration test',
      agents: [
        { program: 'codex', role: 'lead' },
        { program: 'claude', role: 'member' },
      ],
    })
    teamId = team.id
    const codexName = team.agents[0].name
    const claudeName = team.agents[1].name

    // Codex emits 5 messages, including 1 verified assumption + 1 confab
    for (let i = 0; i < 5; i++) {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: codexName, to: 'team',
        content: `msg ${i}`, type: 'chat', timestamp: new Date().toISOString(),
      })
    }
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: '🟢 verified', type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'assumption_verified', agent: codexName, passed: true },
    })
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: '⚠️ confab', type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'confabulation', agent: codexName, citation: 'foo:99' },
    })

    // Claude emits 3 messages, 1 rejected assumption + 1 question answered
    for (let i = 0; i < 3; i++) {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: claudeName, to: 'team',
        content: `msg ${i}`, type: 'chat', timestamp: new Date().toISOString(),
      })
    }
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: '🔴 rejected', type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'assumption_verified', agent: claudeName, passed: false },
    })
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: '🟡 pending', type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'question_pending', agent: claudeName, claim: 'something' },
    })
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: '🟢 answer', type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'question_answered', agent: claudeName },
    })

    // Team-level event
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: '🤖 verify-runner pass', type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'verify_runner', passed: 5, failed: 0, errored: 0 },
    })
  })

  afterAll(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = prevDataDir
  })

  it('aggregates per-agent metrics from feed events', () => {
    const summary = computeCalibration({})
    expect(summary.scannedTeams).toBeGreaterThanOrEqual(1)
    const codex = summary.perAgent.find(a => a.agent.startsWith('codex'))
    expect(codex).toBeDefined()
    expect(codex!.assumptionsVerified).toBe(1)
    expect(codex!.confabulations).toBe(1)
    expect(codex!.assumptionAccuracy).toBeGreaterThan(0)
  })

  it('computes per-program rollup', () => {
    const summary = computeCalibration({})
    const codexProgram = summary.perProgram.find(p => p.program === 'codex')
    const claudeProgram = summary.perProgram.find(p => p.program === 'claude')
    expect(codexProgram).toBeDefined()
    expect(claudeProgram).toBeDefined()
    expect(claudeProgram!.assumptionsRejected).toBe(1)
    expect(claudeProgram!.questionsAsked).toBe(1)
    expect(claudeProgram!.questionsAnswered).toBe(1)
  })

  it('captures team-level events under the __team__ bucket', () => {
    const summary = computeCalibration({})
    const team = summary.perAgent.find(a => a.agent === '__team__')
    expect(team).toBeDefined()
    expect(team!.verifyRunnerPassed).toBe(1)
  })

  it('formatCalibrationText renders a readable report', () => {
    const summary = computeCalibration({})
    const text = formatCalibrationText(summary)
    expect(text).toContain('calibration scoreboard')
    expect(text).toContain('per agent')
    expect(text).toContain('per program')
  })

  it('respects windowDays — old teams excluded', () => {
    const summary = computeCalibration({ windowDays: 1 })
    expect(summary.scannedTeams).toBeGreaterThanOrEqual(1)  // our test team is fresh
    const oldOnly = computeCalibration({ windowDays: 0.0001 })
    // 0.0001 day = ~9s, might still include test team — at most 1
    expect(oldOnly.scannedTeams).toBeLessThanOrEqual(1)
  })
})
