import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

function makeMessage(overrides: Partial<EnsembleMessage> = {}): EnsembleMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    teamId: overrides.teamId ?? 'team-staged',
    from: overrides.from ?? 'codex-1',
    to: overrides.to ?? 'team',
    content: overrides.content ?? 'hello',
    type: overrides.type ?? 'chat',
    timestamp: overrides.timestamp ?? '2026-03-19T10:00:00.000Z',
  }
}

function makeTeam(): EnsembleTeam {
  return {
    id: 'team-staged',
    name: 'team-staged',
    description: 'Implement staged workflow',
    status: 'active',
    agents: [
      { agentId: 'a1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'active' },
      { agentId: 'a2', name: 'claude-2', program: 'claude', role: 'member', hostId: 'local', status: 'active' },
    ],
    createdBy: 'test',
    createdAt: '2026-03-19T09:00:00.000Z',
    feedMode: 'live',
  }
}

describe('StagedWorkflowManager', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('runs PLAN → EXEC → VERIFY in order', async () => {
    const delivered: Array<{ session: string; text: string }> = []
    const appended: string[] = []
    let messageReadCount = 0

    vi.doMock('../lib/ensemble-registry', () => ({
      appendMessage: vi.fn((_teamId: string, message: EnsembleMessage) => appended.push(message.content)),
      getMessages: vi.fn((_teamId: string, _since?: string) => {
        messageReadCount += 1
        if (messageReadCount === 1) {
          return [
            makeMessage({ from: 'codex-1', content: 'plan ready', timestamp: '2026-03-19T10:00:01.000Z' }),
            makeMessage({ from: 'claude-2', content: 'plan klaar', timestamp: '2026-03-19T10:00:02.000Z' }),
          ]
        }
        return [
          makeMessage({ from: 'codex-1', content: 'implementation done', timestamp: '2026-03-19T10:00:03.000Z' }),
          makeMessage({ from: 'claude-2', content: 'implementatie klaar', timestamp: '2026-03-19T10:00:04.000Z' }),
        ]
      }),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      // Re-export the named SessionGoneError class so staged-workflow's
      // typed-error import resolves under the mock.
      SessionGoneError: class extends Error { sessionName = ''; constructor(s = '') { super(`tmux session "${s}" gone`); this.name = 'SessionGoneError'; this.sessionName = s } },
      getRuntime: vi.fn(() => ({
        sendKeys: vi.fn(async (session: string, text: string) => {
          delivered.push({ session, text })
        }),
        pasteFromFile: vi.fn(async () => {}),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ inputMethod: 'sendKeys' })),
    }))
    vi.doMock('../lib/collab-paths', () => ({
      collabDeliveryFile: vi.fn(() => '/tmp/unused'),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      postRemoteSessionCommand: vi.fn(async () => {}),
    }))

    const { StagedWorkflowManager } = await import('../lib/staged-workflow')

    const manager = new StagedWorkflowManager({
      team: makeTeam(),
      config: {
        planTimeoutMs: 100,
        execTimeoutMs: 100,
        verifyTimeoutMs: 0,
        pollIntervalMs: 0,
      },
      sleep: async () => {},
      buildPlanPrompt: ({ agent }) => `PLAN for ${agent.name}`,
      buildExecPrompt: ({ agent }) => `EXEC for ${agent.name}`,
      buildVerifyPrompt: ({ agent, teammateToReview }) => `VERIFY ${agent.name} reviews ${teammateToReview}`,
    })

    await manager.run()

    expect(delivered.map(entry => entry.text)).toEqual([
      'PLAN for codex-1',
      'PLAN for claude-2',
      'EXEC for codex-1',
      'EXEC for claude-2',
      'VERIFY codex-1 reviews claude-2',
      'VERIFY claude-2 reviews codex-1',
    ])
    expect(appended.some(message => message.includes('[Staged/PLAN] Starting PLAN phase'))).toBe(true)
    expect(appended.some(message => message.includes('[Staged/EXEC] Starting EXEC phase'))).toBe(true)
    expect(appended.some(message => message.includes('[Staged/VERIFY] Starting VERIFY phase'))).toBe(true)
  })

  // Race-condition guard: when one agent's tmux session dies between phases
  // (typical when watchdog or team-done disbands mid-flight), the staged
  // workflow used to crash with "Staged workflow failed for X" and strand the
  // surviving agents. Now: SessionGoneError on agent A is logged as a benign
  // skip and phase delivery for agents B+C still completes.
  it('survives one agent\'s session-gone error during phase delivery — others still get prompts', async () => {
    const delivered: Array<{ session: string; text: string }> = []
    const appended: string[] = []

    vi.doMock('../lib/ensemble-registry', () => ({
      appendMessage: vi.fn((_teamId: string, message: EnsembleMessage) => appended.push(message.content)),
      getMessages: vi.fn(() => [
        makeMessage({ from: 'codex-1', content: 'plan ready', timestamp: '2026-03-19T10:00:01.000Z' }),
        makeMessage({ from: 'claude-2', content: 'plan klaar', timestamp: '2026-03-19T10:00:02.000Z' }),
      ]),
    }))

    // Re-export SessionGoneError from the real module so the typed-error path
    // in staged-workflow's logSessionGoneOrRethrow recognizes the throw.
    const realRuntime = await import('../lib/agent-runtime')
    vi.doMock('../lib/agent-runtime', () => ({
      SessionGoneError: realRuntime.SessionGoneError,
      getRuntime: vi.fn(() => ({
        sendKeys: vi.fn(async (session: string, text: string) => {
          if (session === 'team-staged-codex-1') {
            throw new realRuntime.SessionGoneError(session)
          }
          delivered.push({ session, text })
        }),
        pasteFromFile: vi.fn(async () => {}),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ inputMethod: 'sendKeys' })),
    }))
    vi.doMock('../lib/collab-paths', () => ({
      collabDeliveryFile: vi.fn(() => '/tmp/unused'),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      postRemoteSessionCommand: vi.fn(async () => {}),
    }))

    const { StagedWorkflowManager } = await import('../lib/staged-workflow')

    const manager = new StagedWorkflowManager({
      team: makeTeam(),
      config: { planTimeoutMs: 50, execTimeoutMs: 50, verifyTimeoutMs: 0, pollIntervalMs: 0 },
      sleep: async () => {},
      buildPlanPrompt: ({ agent }) => `PLAN for ${agent.name}`,
      buildExecPrompt: ({ agent }) => `EXEC for ${agent.name}`,
      buildVerifyPrompt: ({ agent, teammateToReview }) => `VERIFY ${agent.name} reviews ${teammateToReview}`,
    })

    // Must NOT throw — the SessionGoneError is caught and logged as a skip.
    await expect(manager.run()).resolves.toBeUndefined()

    // claude-2 still got every phase prompt despite codex-1's session being gone.
    const claude2Texts = delivered.filter(d => d.session === 'team-staged-claude-2').map(d => d.text)
    expect(claude2Texts).toEqual([
      'PLAN for claude-2',
      'EXEC for claude-2',
      'VERIFY claude-2 reviews codex-1',
    ])

    // codex-1 was skipped — no successful deliveries to it.
    expect(delivered.filter(d => d.session === 'team-staged-codex-1')).toHaveLength(0)

    // Each missed delivery emitted a structured warning to the team feed.
    const skipWarnings = appended.filter(m => m.includes('Skipped phase prompt delivery to codex-1'))
    expect(skipWarnings.length).toBeGreaterThanOrEqual(3)  // PLAN + EXEC + VERIFY
  })

  // Auto-fix loop: when VERIFY emits NO-GO, the workflow re-runs EXEC + VERIFY
  // with the blockers list instead of stalling in a polite-ack loop. Bounded
  // to maxFixIterations so it can never run forever.
  it('runs FIX iteration when VERIFY phase contains NO-GO, then exits clean once fixed', async () => {
    const delivered: Array<{ session: string; text: string }> = []
    const appended: EnsembleMessage[] = []
    let pollCount = 0

    vi.doMock('../lib/ensemble-registry', () => ({
      appendMessage: vi.fn((_teamId: string, message: EnsembleMessage) => appended.push(message)),
      getMessages: vi.fn(() => {
        pollCount += 1
        // First few polls (PLAN + EXEC waiting) return signals from both agents
        if (pollCount <= 4) {
          return [
            makeMessage({ from: 'codex-1', content: '[PLAN_READY] mine', timestamp: '2026-03-19T10:00:01.000Z' }),
            makeMessage({ from: 'claude-2', content: '[PLAN_READY] mine', timestamp: '2026-03-19T10:00:02.000Z' }),
            makeMessage({ from: 'codex-1', content: '[EXEC_DONE] implementation', timestamp: '2026-03-19T10:00:10.000Z' }),
            makeMessage({ from: 'claude-2', content: '[EXEC_DONE] implementation', timestamp: '2026-03-19T10:00:11.000Z' }),
          ]
        }
        // First VERIFY: NO-GO from codex-1. Triggers FIX iteration 1.
        if (pollCount <= 6) {
          return [
            makeMessage({ from: 'codex-1', content: '[VERIFY_DONE] gate: NO-GO\n- Blocker 1: missing test\n- Blocker 2: stale doc', timestamp: '2026-03-19T10:00:20.000Z' }),
            makeMessage({ from: 'claude-2', content: '[VERIFY_DONE] approved', timestamp: '2026-03-19T10:00:21.000Z' }),
          ]
        }
        // After FIX iteration's EXEC: both done.
        if (pollCount <= 9) {
          return [
            makeMessage({ from: 'codex-1', content: '[EXEC_DONE] fixed both blockers', timestamp: '2026-03-19T10:00:40.000Z' }),
            makeMessage({ from: 'claude-2', content: '[EXEC_DONE] retests pass', timestamp: '2026-03-19T10:00:41.000Z' }),
          ]
        }
        // Re-VERIFY: clean (GO).
        return [
          makeMessage({ from: 'codex-1', content: '[VERIFY_DONE] gate: GO — fix landed', timestamp: '2026-03-19T10:01:00.000Z' }),
          makeMessage({ from: 'claude-2', content: '[VERIFY_DONE] approved', timestamp: '2026-03-19T10:01:01.000Z' }),
        ]
      }),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      SessionGoneError: class extends Error { sessionName = ''; constructor(s = '') { super(`mock`); this.name = 'SessionGoneError'; this.sessionName = s } },
      getRuntime: vi.fn(() => ({
        sendKeys: vi.fn(async (session: string, text: string) => { delivered.push({ session, text }) }),
        pasteFromFile: vi.fn(async () => {}),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ inputMethod: 'sendKeys' })),
    }))
    vi.doMock('../lib/collab-paths', () => ({ collabDeliveryFile: vi.fn(() => '/tmp/unused') }))
    vi.doMock('../lib/hosts-config', () => ({ isSelf: vi.fn(() => true), getHostById: vi.fn() }))
    vi.doMock('../lib/agent-spawner', () => ({ postRemoteSessionCommand: vi.fn(async () => {}) }))

    const { StagedWorkflowManager } = await import('../lib/staged-workflow')

    const manager = new StagedWorkflowManager({
      team: makeTeam(),
      config: { planTimeoutMs: 50, execTimeoutMs: 50, verifyTimeoutMs: 50, pollIntervalMs: 0, maxFixIterations: 2 },
      sleep: async () => {},
      buildPlanPrompt: ({ agent }) => `PLAN for ${agent.name}`,
      buildExecPrompt: ({ agent }) => `EXEC for ${agent.name}`,
      buildVerifyPrompt: ({ agent }) => `VERIFY for ${agent.name}`,
    })

    await manager.run()

    // The FIX iteration prompt must have landed for both agents
    const fixPrompts = delivered.filter(d => d.text.includes('FIX iteration 1/2'))
    expect(fixPrompts.length).toBeGreaterThanOrEqual(2)
    // Blockers list must be embedded in the FIX prompt
    expect(fixPrompts.every(d => d.text.includes('Blocker 1: missing test'))).toBe(true)
    // Re-VERIFY prompt must follow
    const reVerifyPrompts = delivered.filter(d => d.text.includes('RE-VERIFY 1/2'))
    expect(reVerifyPrompts.length).toBeGreaterThanOrEqual(2)
    // The auto-fix-exhausted escalation must NOT have fired (verify cleared)
    expect(appended.some(m => m.content.includes('Auto-fix budget exhausted'))).toBe(false)
  })

  it('emits auto-fix-exhausted escalation when NO-GO persists past maxFixIterations', async () => {
    const appended: EnsembleMessage[] = []

    // Every getMessages poll returns NO-GO so the loop must hit its cap.
    vi.doMock('../lib/ensemble-registry', () => ({
      appendMessage: vi.fn((_teamId: string, message: EnsembleMessage) => appended.push(message)),
      getMessages: vi.fn(() => [
        makeMessage({ from: 'codex-1', content: '[PLAN_READY]', timestamp: '2026-03-19T10:00:01.000Z' }),
        makeMessage({ from: 'claude-2', content: '[PLAN_READY]', timestamp: '2026-03-19T10:00:02.000Z' }),
        makeMessage({ from: 'codex-1', content: '[EXEC_DONE]', timestamp: '2026-03-19T10:00:05.000Z' }),
        makeMessage({ from: 'claude-2', content: '[EXEC_DONE]', timestamp: '2026-03-19T10:00:06.000Z' }),
        makeMessage({ from: 'codex-1', content: '[VERIFY_DONE] gate: NO-GO — blocker still present', timestamp: '2026-03-19T10:00:10.000Z' }),
        makeMessage({ from: 'claude-2', content: '[VERIFY_DONE] gate: NO-GO', timestamp: '2026-03-19T10:00:11.000Z' }),
      ]),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      SessionGoneError: class extends Error { sessionName = ''; constructor(s = '') { super('mock'); this.name = 'SessionGoneError'; this.sessionName = s } },
      getRuntime: vi.fn(() => ({
        sendKeys: vi.fn(async () => {}),
        pasteFromFile: vi.fn(async () => {}),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({ resolveAgentProgram: vi.fn(() => ({ inputMethod: 'sendKeys' })) }))
    vi.doMock('../lib/collab-paths', () => ({ collabDeliveryFile: vi.fn(() => '/tmp/unused') }))
    vi.doMock('../lib/hosts-config', () => ({ isSelf: vi.fn(() => true), getHostById: vi.fn() }))
    vi.doMock('../lib/agent-spawner', () => ({ postRemoteSessionCommand: vi.fn(async () => {}) }))

    const { StagedWorkflowManager } = await import('../lib/staged-workflow')

    const manager = new StagedWorkflowManager({
      team: makeTeam(),
      config: { planTimeoutMs: 30, execTimeoutMs: 30, verifyTimeoutMs: 30, pollIntervalMs: 0, maxFixIterations: 2 },
      sleep: async () => {},
      buildPlanPrompt: () => 'PLAN',
      buildExecPrompt: () => 'EXEC',
      buildVerifyPrompt: () => 'VERIFY',
    })

    await manager.run()

    const escalation = appended.find(m => m.content.includes('Auto-fix budget exhausted'))
    expect(escalation).toBeDefined()
    expect(escalation!.meta?.event).toBe('auto_fix_exhausted')
    expect(escalation!.meta?.iterations).toBe(2)
  })

  it('still surfaces unexpected (non-SessionGone) errors after allSettled — phase fails loudly', async () => {
    vi.doMock('../lib/ensemble-registry', () => ({
      appendMessage: vi.fn(),
      getMessages: vi.fn(() => []),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      SessionGoneError: class extends Error { sessionName = ''; constructor() { super('mock'); this.name = 'SessionGoneError' } },
      getRuntime: vi.fn(() => ({
        sendKeys: vi.fn(async () => {
          throw new Error('disk full while writing buffer')  // not a SessionGone-shaped error
        }),
        pasteFromFile: vi.fn(async () => {}),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ inputMethod: 'sendKeys' })),
    }))
    vi.doMock('../lib/collab-paths', () => ({ collabDeliveryFile: vi.fn(() => '/tmp/unused') }))
    vi.doMock('../lib/hosts-config', () => ({ isSelf: vi.fn(() => true), getHostById: vi.fn() }))
    vi.doMock('../lib/agent-spawner', () => ({ postRemoteSessionCommand: vi.fn(async () => {}) }))

    const { StagedWorkflowManager } = await import('../lib/staged-workflow')

    const manager = new StagedWorkflowManager({
      team: makeTeam(),
      config: { planTimeoutMs: 50, execTimeoutMs: 50, verifyTimeoutMs: 0, pollIntervalMs: 0 },
      sleep: async () => {},
      buildPlanPrompt: () => 'PLAN',
      buildExecPrompt: () => 'EXEC',
      buildVerifyPrompt: () => 'VERIFY',
    })

    await expect(manager.run()).rejects.toThrow(/disk full/)
  })
})
