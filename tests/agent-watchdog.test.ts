import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'
import {
  AgentWatchdog,
  getWatchdogNudgeMs,
  getWatchdogStallMs,
} from '../lib/agent-watchdog'

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: overrides.id ?? 'team-1',
    name: overrides.name ?? 'alpha',
    description: overrides.description ?? 'test team',
    status: overrides.status ?? 'active',
    agents: overrides.agents ?? [
      {
        agentId: 'agent-1',
        name: 'codex-1',
        program: 'codex',
        role: 'lead',
        hostId: 'local',
        status: 'active',
      },
    ],
    createdBy: overrides.createdBy ?? 'test',
    createdAt: overrides.createdAt ?? '2026-03-19T10:00:00.000Z',
    completedAt: overrides.completedAt,
    feedMode: overrides.feedMode ?? 'live',
    result: overrides.result,
  }
}

function makeMessage(overrides: Partial<EnsembleMessage> = {}): EnsembleMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    teamId: overrides.teamId ?? 'team-1',
    from: overrides.from ?? 'codex-1',
    to: overrides.to ?? 'team',
    content: overrides.content ?? 'progress',
    type: overrides.type ?? 'chat',
    timestamp: overrides.timestamp ?? '2026-03-19T10:00:00.000Z',
  }
}

describe('AgentWatchdog', () => {
  const originalNudgeMs = process.env.ENSEMBLE_WATCHDOG_NUDGE_MS
  const originalStallMs = process.env.ENSEMBLE_WATCHDOG_STALL_MS

  let nowMs: number
  let teams: EnsembleTeam[]
  let messages: EnsembleMessage[]
  let appended: EnsembleMessage[]
  let sendKeys: ReturnType<typeof vi.fn>
  let pasteFromFile: ReturnType<typeof vi.fn>
  let postRemoteSessionCommand: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.restoreAllMocks()
    nowMs = new Date('2026-03-19T10:00:00.000Z').getTime()
    teams = [makeTeam()]
    messages = [makeMessage({ timestamp: '2026-03-19T10:00:00.000Z' })]
    appended = []
    sendKeys = vi.fn(async () => {})
    pasteFromFile = vi.fn(async () => {})
    postRemoteSessionCommand = vi.fn(async () => {})
  })

  afterEach(() => {
    if (originalNudgeMs === undefined) {
      delete process.env.ENSEMBLE_WATCHDOG_NUDGE_MS
    } else {
      process.env.ENSEMBLE_WATCHDOG_NUDGE_MS = originalNudgeMs
    }
    if (originalStallMs === undefined) {
      delete process.env.ENSEMBLE_WATCHDOG_STALL_MS
    } else {
      process.env.ENSEMBLE_WATCHDOG_STALL_MS = originalStallMs
    }
  })

  function createWatchdog() {
    return new AgentWatchdog({
      loadTeams: () => teams,
      getMessages: () => messages,
      appendMessage: (_teamId, message) => appended.push(message),
      getRuntime: () => ({ sendKeys, pasteFromFile, capturePane: vi.fn(async () => '$ ') }),
      resolveAgentProgram: () => ({ inputMethod: 'sendKeys' }),
      isSelf: () => true,
      getHostById: () => undefined,
      postRemoteSessionCommand,
      collabDeliveryFile: (teamId, sessionName) => `/tmp/${teamId}/${sessionName}.txt`,
      now: () => nowMs,
      pollIntervalMs: 60_000,
      nudgeAfterMs: 90_000,
      stallAfterMs: 180_000,
    })
  }

  it('nudges an active agent after prolonged silence and logs it to the team feed', async () => {
    const watchdog = createWatchdog()
    await watchdog.poll()

    nowMs += 91_000
    await watchdog.poll()

    expect(pasteFromFile).toHaveBeenCalledWith('alpha-codex-1', `/tmp/team-1/alpha-codex-1.txt`)
    expect(appended).toHaveLength(1)
    expect(appended[0].content).toContain('Watchdog nudged codex-1')
    watchdog.stop()
  })

  it('marks an agent stalled when silence continues after the nudge', async () => {
    const watchdog = createWatchdog()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()

    nowMs += 181_000
    await watchdog.poll()

    expect(appended).toHaveLength(2)
    expect(appended[1].content).toContain('marked codex-1 as stalled')
    expect(warnSpy).toHaveBeenCalledWith('[Watchdog] Agent codex-1 in team team-1 stalled after watchdog nudge')
    watchdog.stop()
  })

  it('resets stall tracking when a new agent message arrives after a nudge', async () => {
    const watchdog = createWatchdog()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()

    messages = [
      ...messages,
      makeMessage({ id: 'msg-new', timestamp: new Date(nowMs + 1_000).toISOString(), content: 'Still working' }),
    ]
    nowMs += 2_000
    await watchdog.poll()

    // Advance 80s — below nudge threshold, so no new nudge and no stall
    nowMs += 80_000
    await watchdog.poll()

    expect(appended).toHaveLength(1) // only the original nudge
    expect(warnSpy).not.toHaveBeenCalled()
    watchdog.stop()
  })

  it('drops watchdog state for non-active teams so disbanded teams are no longer monitored', async () => {
    const watchdog = createWatchdog()

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()

    teams = []
    nowMs += 181_000
    await watchdog.poll()

    teams = [makeTeam()]
    await watchdog.poll()

    expect(appended).toHaveLength(2)
    expect(appended[0].content).toContain('Watchdog nudged codex-1')
    expect(appended[1].content).toContain('Watchdog nudged codex-1')
    expect(appended.some(message => message.content.includes('marked codex-1 as stalled'))).toBe(false)
    watchdog.stop()
  })

  it('force-disbands when every active agent has been marked stalled', async () => {
    const disbandTeam = vi.fn(async () => {})
    teams = [makeTeam({
      agents: [
        { agentId: 'agent-1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'active' },
        { agentId: 'agent-2', name: 'claude-2', program: 'claude', role: 'worker', hostId: 'local', status: 'active' },
      ],
    })]
    messages = [
      makeMessage({ id: 'm1', from: 'codex-1', timestamp: '2026-03-19T10:00:00.000Z' }),
      makeMessage({ id: 'm2', from: 'claude-2', timestamp: '2026-03-19T10:00:00.000Z' }),
    ]

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watchdog = new AgentWatchdog({
      loadTeams: () => teams,
      getMessages: () => messages,
      appendMessage: (_teamId, message) => appended.push(message),
      disbandTeam,
      getRuntime: () => ({ sendKeys, pasteFromFile, capturePane: vi.fn(async () => '$ ') }),
      resolveAgentProgram: () => ({ inputMethod: 'sendKeys' }),
      isSelf: () => true,
      getHostById: () => undefined,
      postRemoteSessionCommand,
      collabDeliveryFile: (teamId, sessionName) => `/tmp/${teamId}/${sessionName}.txt`,
      now: () => nowMs,
      pollIntervalMs: 60_000,
      nudgeAfterMs: 90_000,
      stallAfterMs: 180_000,
    })

    await watchdog.poll()            // seed state
    nowMs += 91_000
    await watchdog.poll()            // both agents get nudged
    nowMs += 181_000
    await watchdog.poll()            // both flip to stalled → force-disband

    expect(disbandTeam).toHaveBeenCalledWith('team-1', 'all agents stalled')
    expect(appended.some(m => m.content.includes('Force-disband: all agents stalled'))).toBe(true)
    watchdog.stop()
    warnSpy.mockRestore()
  })

  it('reads watchdog thresholds from environment variables', () => {
    process.env.ENSEMBLE_WATCHDOG_NUDGE_MS = '1234'
    process.env.ENSEMBLE_WATCHDOG_STALL_MS = '5678'

    expect(getWatchdogNudgeMs()).toBe(1234)
    expect(getWatchdogStallMs()).toBe(5678)
  })

  // FIX 4: live-bash detection defers all-stalled disband when an agent's
  // tmux pane shows running output instead of the idle prompt. Real case:
  // 25-min test suite or large worktree merge — we don't want to kill the
  // team while it's just waiting for a long command.
  it('defers all-stalled disband when capturePane shows a long-running command on at least one agent', async () => {
    const disbandTeam = vi.fn(async () => {})
    teams = [makeTeam({
      agents: [
        { agentId: 'agent-1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'active' },
        { agentId: 'agent-2', name: 'claude-2', program: 'claude', role: 'worker', hostId: 'local', status: 'active' },
      ],
    })]
    messages = [
      makeMessage({ id: 'm1', from: 'codex-1', timestamp: '2026-03-19T10:00:00.000Z' }),
      makeMessage({ id: 'm2', from: 'claude-2', timestamp: '2026-03-19T10:00:00.000Z' }),
    ]

    // claude-2 idle prompt visible (❯), codex-2 in middle of test output (no prompt)
    const captureMock = vi.fn(async (session: string) => {
      if (session.includes('codex-1')) {
        return [
          'PASS  tests/integration/db.test.ts  (4.2s)',
          'PASS  tests/integration/queue.test.ts  (5.1s)',
          'Test Suites: 12 of 24 |',
          'Time: 142.3s',  // last line, no idle prompt
        ].join('\n')
      }
      return 'some banner\n❯ '  // claude-2 at idle
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const watchdog = new AgentWatchdog({
      loadTeams: () => teams,
      getMessages: () => messages,
      appendMessage: (_teamId, message) => appended.push(message),
      disbandTeam,
      getRuntime: () => ({ sendKeys, pasteFromFile, capturePane: captureMock }),
      resolveAgentProgram: () => ({ inputMethod: 'sendKeys' }),
      isSelf: () => true,
      getHostById: () => undefined,
      postRemoteSessionCommand,
      collabDeliveryFile: (teamId, sessionName) => `/tmp/${teamId}/${sessionName}.txt`,
      now: () => nowMs,
      pollIntervalMs: 60_000,
      nudgeAfterMs: 90_000,
      stallAfterMs: 180_000,
    })

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()         // nudge both
    nowMs += 181_000
    await watchdog.poll()         // both stalled → would disband, but captureMock says codex-1 busy

    // Disband should be DEFERRED, not called
    expect(disbandTeam).not.toHaveBeenCalled()
    expect(appended.some(m => m.content.includes('All-stalled disband deferred'))).toBe(true)
    watchdog.stop()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  // Regression — the zsh prompt "%" was missed by the original idle regex,
  // which left team 86db468a stuck active forever after the Claude CLI exited
  // and left "aimusic@dash X %" at pane bottom. The 2026-04-28 fix adds %
  // to the idle character class.
  it('treats zsh % prompt as idle (Claude CLI exited, parent shell remains)', async () => {
    const disbandTeam = vi.fn(async () => {})
    teams = [makeTeam({
      agents: [
        { agentId: 'agent-1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'active' },
        { agentId: 'agent-2', name: 'claude-2', program: 'claude', role: 'worker', hostId: 'local', status: 'active' },
      ],
    })]
    messages = [
      makeMessage({ id: 'm1', from: 'codex-1', timestamp: '2026-03-19T10:00:00.000Z' }),
      makeMessage({ id: 'm2', from: 'claude-2', timestamp: '2026-03-19T10:00:00.000Z' }),
    ]
    // Both agents' CLIs have exited — only the parent zsh prompt remains
    const captureMock = vi.fn(async (session: string) =>
      `Resume this session with: claude --resume X\naimusic@dash ${session} %`)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watchdog = new AgentWatchdog({
      loadTeams: () => teams,
      getMessages: () => messages,
      appendMessage: (_teamId, message) => appended.push(message),
      disbandTeam,
      getRuntime: () => ({ sendKeys, pasteFromFile, capturePane: captureMock }),
      resolveAgentProgram: () => ({ inputMethod: 'sendKeys' }),
      isSelf: () => true,
      getHostById: () => undefined,
      postRemoteSessionCommand,
      collabDeliveryFile: (teamId, sessionName) => `/tmp/${teamId}/${sessionName}.txt`,
      now: () => nowMs,
      pollIntervalMs: 60_000,
      nudgeAfterMs: 90_000,
      stallAfterMs: 180_000,
    })
    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()
    nowMs += 181_000
    await watchdog.poll()
    expect(disbandTeam).toHaveBeenCalledWith('team-1', 'all agents stalled')
    watchdog.stop()
    warnSpy.mockRestore()
  })

  it('proceeds with all-stalled disband when capturePane shows idle prompt on every agent', async () => {
    const disbandTeam = vi.fn(async () => {})
    teams = [makeTeam({
      agents: [
        { agentId: 'agent-1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'active' },
        { agentId: 'agent-2', name: 'claude-2', program: 'claude', role: 'worker', hostId: 'local', status: 'active' },
      ],
    })]
    messages = [
      makeMessage({ id: 'm1', from: 'codex-1', timestamp: '2026-03-19T10:00:00.000Z' }),
      makeMessage({ id: 'm2', from: 'claude-2', timestamp: '2026-03-19T10:00:00.000Z' }),
    ]

    // Both panes show their CLI's idle prompt
    const captureMock = vi.fn(async (session: string) =>
      session.includes('codex-1') ? 'banner\n› ' : 'banner\n❯ ')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watchdog = new AgentWatchdog({
      loadTeams: () => teams,
      getMessages: () => messages,
      appendMessage: (_teamId, message) => appended.push(message),
      disbandTeam,
      getRuntime: () => ({ sendKeys, pasteFromFile, capturePane: captureMock }),
      resolveAgentProgram: () => ({ inputMethod: 'sendKeys' }),
      isSelf: () => true,
      getHostById: () => undefined,
      postRemoteSessionCommand,
      collabDeliveryFile: (teamId, sessionName) => `/tmp/${teamId}/${sessionName}.txt`,
      now: () => nowMs,
      pollIntervalMs: 60_000,
      nudgeAfterMs: 90_000,
      stallAfterMs: 180_000,
    })

    await watchdog.poll()
    nowMs += 91_000
    await watchdog.poll()
    nowMs += 181_000
    await watchdog.poll()

    expect(disbandTeam).toHaveBeenCalledWith('team-1', 'all agents stalled')
    watchdog.stop()
    warnSpy.mockRestore()
  })
})
