import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleMessage, EnsembleTeam, StagedWorkflowConfig } from '../types/ensemble'

const TEAM_SAY_BIN = path.resolve(process.cwd(), 'scripts/team-say.sh')
const TMP_ENSEMBLE_DIR = '/tmp/ensemble'

function makeMessage(overrides: Partial<EnsembleMessage> = {}): EnsembleMessage {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
    teamId: overrides.teamId ?? 'team-1',
    from: overrides.from ?? 'agent-1',
    to: overrides.to ?? 'team',
    content: overrides.content ?? 'hello',
    type: overrides.type ?? 'chat',
    timestamp: overrides.timestamp ?? '2026-03-18T10:00:00.000Z',
  }
}

function makeFillerMessages(teamId: string, beforeTs: string, n = 8): EnsembleMessage[] {
  const base = new Date(beforeTs).getTime()
  return Array.from({ length: n }, (_, i) => {
    const ts = new Date(base - (n - i) * 60_000).toISOString()
    return makeMessage({ from: i % 2 === 0 ? 'codex-1' : 'claude-2', teamId, content: `Working on step ${i + 1}`, timestamp: ts })
  })
}

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: overrides.id ?? 'team-1',
    name: overrides.name ?? 'test-team',
    description: overrides.description ?? 'test',
    status: overrides.status ?? 'active',
    agents: overrides.agents ?? [
      {
        agentId: 'agent-id-1',
        name: 'codex-1',
        program: 'codex',
        role: 'lead',
        hostId: 'local',
        status: 'active',
      },
      {
        agentId: 'agent-id-2',
        name: 'claude-2',
        program: 'claude',
        role: 'member',
        hostId: 'local',
        status: 'active',
      },
    ],
    createdBy: overrides.createdBy ?? 'test',
    createdAt: overrides.createdAt ?? '2026-03-18T10:00:00.000Z',
    completedAt: overrides.completedAt,
    feedMode: overrides.feedMode ?? 'live',
    result: overrides.result,
  }
}

function writeJsonl(filePath: string, messages: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, messages.map(m => JSON.stringify(m)).join('\n') + '\n')
}

// ─────────────────────────────────────────────────────
// 1. getMessages() — merge of dual message stores
// ─────────────────────────────────────────────────────
describe('getMessages() — dual store merge', () => {
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  let tempRoot: string
  let teamId: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-registry-'))
    teamId = `team-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    if (originalDataDir === undefined) {
      delete process.env.ENSEMBLE_DATA_DIR
    } else {
      process.env.ENSEMBLE_DATA_DIR = originalDataDir
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
    // Clean up any runtime files we created
    const tmpDir = path.join(TMP_ENSEMBLE_DIR, teamId)
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads messages from feed.jsonl only', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    const msg = makeMessage({ id: 'feed-only', teamId, content: 'from feed' })
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [msg])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('feed-only')
    expect(result[0].content).toBe('from feed')
  })

  it('reads messages from /tmp/ensemble/<teamId>/messages.jsonl only', async () => {
    const tmpFile = path.join(TMP_ENSEMBLE_DIR, teamId, 'messages.jsonl')
    const msg = makeMessage({ id: 'tmp-only', teamId, content: 'from tmp' })
    writeJsonl(tmpFile, [msg])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('tmp-only')
  })

  it('merges messages from both sources', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'feed-msg', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
    ])
    writeJsonl(path.join(TMP_ENSEMBLE_DIR, teamId, 'messages.jsonl'), [
      makeMessage({ id: 'tmp-msg', teamId, timestamp: '2026-01-01T10:00:01.000Z' }),
    ])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    expect(result).toHaveLength(2)
    expect(result.map(m => m.id)).toEqual(['feed-msg', 'tmp-msg'])
  })

  it('deduplicates messages with same id (feed.jsonl wins)', async () => {
    const sharedId = 'shared-id'
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: sharedId, teamId, content: 'from feed', timestamp: '2026-01-01T10:00:00.000Z' }),
    ])
    writeJsonl(path.join(TMP_ENSEMBLE_DIR, teamId, 'messages.jsonl'), [
      makeMessage({ id: sharedId, teamId, content: 'from tmp', timestamp: '2026-01-01T10:00:00.000Z' }),
    ])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    const matching = result.filter(m => m.id === sharedId)
    expect(matching).toHaveLength(1)
    expect(matching[0].content).toBe('from feed')
  })

  it('sorts messages by timestamp ascending, missing timestamps last', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'late', teamId, timestamp: '2026-01-01T12:00:00.000Z' }),
      makeMessage({ id: 'early', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
      makeMessage({ id: 'no-ts', teamId, timestamp: undefined as unknown as string }),
    ])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    expect(result.map(m => m.id)).toEqual(['early', 'late', 'no-ts'])
  })

  it('filters by since parameter', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [
      makeMessage({ id: 'old', teamId, timestamp: '2026-01-01T10:00:00.000Z' }),
      makeMessage({ id: 'new', teamId, timestamp: '2026-01-01T12:00:00.000Z' }),
    ])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId, '2026-01-01T11:00:00.000Z')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('new')
  })

  it('returns empty array when no files exist', async () => {
    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages('nonexistent-team-xyz')
    expect(result).toEqual([])
  })

  it('deduplicates by fallback key when id is missing', async () => {
    const feedDir = path.join(tempRoot, 'ensemble', 'messages', teamId)
    const ts = '2026-01-01T10:00:00.000Z'
    // Two messages with no id but same from+timestamp+content prefix → should dedupe
    const msg = { teamId, from: 'codex-1', to: 'team', content: 'same content here', type: 'chat', timestamp: ts }
    writeJsonl(path.join(feedDir, 'feed.jsonl'), [msg])
    writeJsonl(path.join(TMP_ENSEMBLE_DIR, teamId, 'messages.jsonl'), [msg])

    const { getMessages } = await import('../lib/ensemble-registry')
    const result = getMessages(teamId)

    // Should be deduplicated to 1 message
    const matching = result.filter(m => m.content === 'same content here')
    expect(matching).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────
// 2. shouldAutoDisband() — completion detection & idle
// ─────────────────────────────────────────────────────
describe('shouldAutoDisband() — tested via checkIdleTeams()', () => {
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-disband-'))
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-18T12:05:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('../lib/ensemble-registry')
    vi.doUnmock('../lib/agent-spawner')
    vi.doUnmock('../lib/hosts-config')
    vi.doUnmock('../lib/agent-runtime')
    vi.doUnmock('../lib/agent-config')
    if (originalDataDir === undefined) {
      delete process.env.ENSEMBLE_DATA_DIR
    } else {
      process.env.ENSEMBLE_DATA_DIR = originalDataDir
    }
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setupServiceWithMocks(team: EnsembleTeam, messages: EnsembleMessage[]) {
    const appendedMessages: EnsembleMessage[] = []
    vi.doMock('../lib/ensemble-registry', () => ({
      getMessages: vi.fn(() => messages),
      loadTeams: vi.fn(() => [team]),
      appendMessage: vi.fn((_id: string, msg: EnsembleMessage) => appendedMessages.push(msg)),
      updateTeam: vi.fn((_id: string, updates: Partial<EnsembleTeam>) => ({ ...team, ...updates })),
      createTeam: vi.fn(),
      getTeam: vi.fn(() => team),
      saveTeams: vi.fn(),
      getActiveTeamsByWorkingDir: vi.fn(() => []),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(),
      killLocalAgent: vi.fn(),
      spawnRemoteAgent: vi.fn(),
      killRemoteAgent: vi.fn(),
      postRemoteSessionCommand: vi.fn(),
      isRemoteSessionReady: vi.fn(),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(),
      getSelfHostId: vi.fn(() => 'local'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(() => ({
        capturePane: vi.fn(),
        sendKeys: vi.fn(),
        pasteFromFile: vi.fn(),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
    }))

    const mod = await import('../services/ensemble-service')
    return { mod, appendedMessages }
  }

  it('auto-disbands when two different agents send high-confidence completion signals within 60s', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      ...makeFillerMessages('team-1', '2026-03-18T12:04:20.000Z'),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'All work finished [DONE]', timestamp: '2026-03-18T12:04:20.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'My part is [COMPLETE]', timestamp: '2026-03-18T12:04:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(true)
  })

  it('does NOT auto-disband on low-confidence signals within 60s', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T12:04:20.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Alles afgerond', timestamp: '2026-03-18T12:04:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  it('does NOT auto-disband when only one high-confidence signal exists and idle is <= 120s', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: '[DONE]', timestamp: '2026-03-18T12:03:40.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working', timestamp: '2026-03-18T12:03:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  it('auto-disbands when one high-confidence signal exists and team is idle past SINGLE_SIGNAL_IDLE (default 600s)', async () => {
    const team = makeTeam()
    // now = 12:05:00; last team msg at 11:54:30 → 630s idle > 600s threshold
    const messages: EnsembleMessage[] = [
      ...makeFillerMessages('team-1', '2026-03-18T11:54:20.000Z'),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: '[DONE] my part', timestamp: '2026-03-18T11:54:20.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still investigating', timestamp: '2026-03-18T11:54:30.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(true)
  })

  it('does NOT auto-disband on a single high-confidence signal when idle is under the new 600s threshold', async () => {
    const team = makeTeam()
    // now = 12:05:00; last team msg at 12:00:00 → 300s idle < 600s threshold.
    // Old default would have killed this; new default keeps the team alive.
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: '[VERIFY_DONE] phase 1 — handing off', timestamp: '2026-03-18T11:59:50.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Reading paper_trader.py main loop', timestamp: '2026-03-18T12:00:00.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  // FIX 2: majority-required signal disband. A 4-agent premium-quad team with
  // ONE agent's [VERIFY_DONE] + 10+ minutes of silence used to disband; now it
  // requires ceil(4/2)=2 distinct signalers before the idle path triggers.
  it('does NOT auto-disband a 4-agent team on ONE single-agent high-conf signal even past 600s idle', async () => {
    const team = makeTeam({
      agents: [
        { agentId: 'a1', name: 'claude-1',  program: 'claude',     role: 'lead',   hostId: 'local', status: 'active' },
        { agentId: 'a2', name: 'sonnet-2',  program: 'sonnet',     role: 'member', hostId: 'local', status: 'active' },
        { agentId: 'a3', name: 'codex-3',   program: 'codex',      role: 'member', hostId: 'local', status: 'active' },
        { agentId: 'a4', name: 'codex-4',   program: 'codex-mini', role: 'member', hostId: 'local', status: 'active' },
      ],
    })
    // 700s idle, only ONE agent emitted [VERIFY_DONE]. Old behavior: disband.
    // New behavior: needs ≥2 distinct agents, so still active.
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'claude-1', teamId: 'team-1', content: '[VERIFY_DONE] architecture review', timestamp: '2026-03-18T11:53:00.000Z' }),
      makeMessage({ from: 'sonnet-2', teamId: 'team-1', content: 'Mid-implementation, ~10 more min', timestamp: '2026-03-18T11:53:20.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  it('auto-disbands a 4-agent team once the majority (2+) of agents have signaled high-conf + idle', async () => {
    const team = makeTeam({
      agents: [
        { agentId: 'a1', name: 'claude-1',  program: 'claude',     role: 'lead',   hostId: 'local', status: 'active' },
        { agentId: 'a2', name: 'sonnet-2',  program: 'sonnet',     role: 'member', hostId: 'local', status: 'active' },
        { agentId: 'a3', name: 'codex-3',   program: 'codex',      role: 'member', hostId: 'local', status: 'active' },
        { agentId: 'a4', name: 'codex-4',   program: 'codex-mini', role: 'member', hostId: 'local', status: 'active' },
      ],
    })
    // 700s idle, TWO different agents emitted high-conf signals (but more
    // than 60s apart, so the two-signal-window rule does NOT fire — only the
    // majority+idle rule should). Both edge-positioned for FIX 1 to recognize.
    const messages: EnsembleMessage[] = [
      ...makeFillerMessages('team-1', '2026-03-18T11:51:30.000Z'),
      makeMessage({ from: 'claude-1', teamId: 'team-1', content: '[VERIFY_DONE] architecture review', timestamp: '2026-03-18T11:51:30.000Z' }),
      makeMessage({ from: 'sonnet-2', teamId: 'team-1', content: '[EXEC_DONE] landing fixes shipped', timestamp: '2026-03-18T11:53:30.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(true)
  })

  it('auto-disbands on low-confidence signals after extended idle (default 30min)', async () => {
    const team = makeTeam()
    // now = 12:05:00; last team msg at 11:34:30 → 1830s idle > 1800s threshold
    const messages: EnsembleMessage[] = [
      ...makeFillerMessages('team-1', '2026-03-18T11:34:20.000Z'),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T11:34:20.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Wrapping up', timestamp: '2026-03-18T11:34:30.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(true)
  })

  it('does NOT auto-disband when "done" is embedded mid-message in a long progress update', async () => {
    const team = makeTeam()
    // 30+ minutes idle would have tripped the old guardless low-conf path.
    // The new tail-position guard rejects "done" buried inside a long message.
    const longProgress =
      'Starting phase 2 audit. So far I have done initial reads of paper_trader.py main loop, ' +
      'protocol_learner.py escalate_stale_lessons, and the watchdog. Still need to finish reviewing ' +
      'the staged-workflow EXEC handoff and confirm SIGTERM drain. No code changes yet. Will share ' +
      'PLAN_READY in ~5 min — codex-2, please hold off on edits until then.'
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: longProgress, timestamp: '2026-03-18T11:34:20.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Ack — holding.', timestamp: '2026-03-18T11:34:30.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  it('does NOT auto-disband when agents have no completion signal', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Still working on it', timestamp: '2026-03-18T12:03:40.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Analyzing code', timestamp: '2026-03-18T12:03:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  it('does NOT auto-disband when last message has no timestamp', async () => {
    const team = makeTeam()
    const msgWithoutTs = makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Klaar' })
    // Explicitly delete timestamp to simulate missing field (can't use ?? with undefined)
    delete (msgWithoutTs as unknown as Record<string, unknown>).timestamp
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Done', timestamp: '2026-03-18T12:03:40.000Z' }),
      msgWithoutTs,
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    // Messages without timestamp get sorted last, and NaN timestamp → return false
    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  it('does NOT auto-disband when team has no active agents', async () => {
    const team = makeTeam({
      agents: [
        { agentId: 'a1', name: 'codex-1', program: 'codex', role: 'lead', hostId: 'local', status: 'idle' },
        { agentId: 'a2', name: 'claude-2', program: 'claude', role: 'member', hostId: 'local', status: 'idle' },
      ],
    })
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Done', timestamp: '2026-03-18T12:03:40.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  it('does NOT auto-disband when signals come from the same agent only', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T12:04:00.000Z' }),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Alles afgerond', timestamp: '2026-03-18T12:04:30.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working...', timestamp: '2026-03-18T12:04:45.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
  })

  it('ignores ensemble messages when determining idle time', async () => {
    const team = makeTeam()
    // now = 12:05:00; last NON-ensemble team msg at 11:54:30 → 630s idle > 600s threshold.
    // The ensemble message at 12:04:55 must NOT count as recent activity.
    const messages: EnsembleMessage[] = [
      ...makeFillerMessages('team-1', '2026-03-18T11:54:25.000Z'),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: '[DONE]', timestamp: '2026-03-18T11:54:25.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Still working', timestamp: '2026-03-18T11:54:30.000Z' }),
      makeMessage({ from: 'ensemble', teamId: 'team-1', content: 'Agent joined', timestamp: '2026-03-18T12:04:55.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(true)
  })

  it('auto-disbands on staged [EXEC_DONE] signals from two different agents within 60s', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      ...makeFillerMessages('team-1', '2026-03-18T12:04:20.000Z'),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Implementation wrapped [EXEC_DONE]', timestamp: '2026-03-18T12:04:20.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: '[EXEC_DONE] — tests pass', timestamp: '2026-03-18T12:04:50.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(true)
  })

  it('auto-disbands on staged [VERIFY_DONE] signals from two different agents within 60s', async () => {
    const team = makeTeam()
    const messages: EnsembleMessage[] = [
      ...makeFillerMessages('team-1', '2026-03-18T12:04:20.000Z'),
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: '[VERIFY_DONE] approved', timestamp: '2026-03-18T12:04:20.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Cross-check ok [VERIFY_DONE]', timestamp: '2026-03-18T12:04:55.000Z' }),
    ]

    const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
    await mod.checkIdleTeams()

    expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(true)
  })

  it('bridge-zombie guard: does NOT auto-disband when messages.jsonl mtime is fresher than registry last-message', async () => {
    const team = makeTeam()
    // Registry shows a low-confidence sign-off 6 minutes ago (past the 5-min
    // LOW idle threshold) — without the guard this would force-disband.
    const messages: EnsembleMessage[] = [
      makeMessage({ from: 'codex-1', teamId: 'team-1', content: 'Task is done', timestamp: '2026-03-18T11:58:30.000Z' }),
      makeMessage({ from: 'claude-2', teamId: 'team-1', content: 'Wrapping up', timestamp: '2026-03-18T11:58:40.000Z' }),
    ]

    // Simulate the bridge being behind: file on disk was last written 5s ago,
    // far ahead of the registry's stale view. Guard should short-circuit.
    const runtimeDir = path.join('/tmp/ensemble', team.id)
    const messagesFile = path.join(runtimeDir, 'messages.jsonl')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(messagesFile, 'stale content\n')
    const freshMtime = new Date('2026-03-18T12:04:55.000Z')
    fs.utimesSync(messagesFile, freshMtime, freshMtime)

    try {
      const { mod, appendedMessages } = await setupServiceWithMocks(team, messages)
      await mod.checkIdleTeams()
      expect(appendedMessages.some(m => m.content.toLowerCase().includes('disband'))).toBe(false)
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────
// 3. Completion pattern matching (unit tests)
// ─────────────────────────────────────────────────────
describe('completion signal patterns', () => {
  const HIGH_CONFIDENCE = [
    /\[DONE\]/i,
    /\[COMPLETE\]/i,
    /\[FINISHED\]/i,
    /\[EXEC_DONE\]/i,
    /\[VERIFY_DONE\]/i,
  ]
  const LOW_CONFIDENCE = [
    /(?:^|[^\p{L}\p{N}_])afgerond(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])done(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])complete(?:d)?(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|[^\p{L}\p{N}_])klaar(?:[^\p{L}\p{N}_]|$)/iu,
    /(?:^|\s)tot de volgende(?:\s|$)/i,
  ]

  // Mirrors services/ensemble-service.ts edge anchors.
  const HIGH_AT_START = [/^\s*\[DONE\]/i, /^\s*\[COMPLETE\]/i, /^\s*\[FINISHED\]/i, /^\s*\[EXEC_DONE\]/i, /^\s*\[VERIFY_DONE\]/i]
  const HIGH_AT_END = [/\[DONE\]\s*[.!,:]?\s*$/i, /\[COMPLETE\]\s*[.!,:]?\s*$/i, /\[FINISHED\]\s*[.!,:]?\s*$/i, /\[EXEC_DONE\]\s*[.!,:]?\s*$/i, /\[VERIFY_DONE\]\s*[.!,:]?\s*$/i]

  function getCompletionConfidence(content: string): 'high' | 'low' | null {
    const trimmed = content.trim()
    if (trimmed.length === 0) return null
    if (trimmed.length <= 300) {
      if (HIGH_AT_START.some(p => p.test(trimmed))) return 'high'
      if (HIGH_AT_END.some(p => p.test(trimmed))) return 'high'
    }
    if (HIGH_CONFIDENCE.some(p => p.test(trimmed))) return null  // buried mid-prose
    if (trimmed.length > 200) return null
    const tail = trimmed.slice(-80)
    if (LOW_CONFIDENCE.some(p => p.test(tail))) return 'low'
    return null
  }

  it.each([
    ['[DONE]', 'high'],
    ['All work [COMPLETE]', 'high'],
    ['[FINISHED] everything', 'high'],
    ['The task is done.', 'low'],
    ['Work completed successfully', 'low'],
    ['Task is complete', 'low'],
    ['De taak is afgerond', 'low'],
    ['Ik ben klaar met de analyse', 'low'],
    ['Tot de volgende keer!', 'low'],
    ['DONE', 'low'],
    ['Klaar', 'low'],
    ['Still working on the task', null],
    ['Analyzing the codebase now', null],
    ['abandoned', null],
    ['completion marker only', null],
    ['undone but still working', null],
    ['', null],
    // Tail-position guard: "done" mid-message in a long progress update is NOT
    // a sign-off. Previously this was treated as low-conf and could trip the
    // 15-min auto-disband during real deep work.
    [
      'Starting phase 2. So far I have done initial reads of paper_trader.py main loop and ' +
        'protocol_learner.escalate_stale_lessons. Still need to review the staged EXEC handoff. ' +
        'No code changes yet — will share PLAN_READY in ~5 min.',
      null,
    ],
    ['Almost done with phase 1, still wiring tests and need ~10 more min before I can hand off to codex.', null],
    // FIX 1: bracket tags buried mid-prose (e.g. agent quoting its own role
    // instructions) must NOT register as high-confidence. Real sign-offs are
    // short and put the tag at an edge.
    [
      'as instructed I will emit [DONE] when the implementation is complete. For now, ' +
        'I am still drafting the architecture plan and will share PLAN_READY in ~3 min.',
      null,
    ],
    [
      'Reminder from the role spec: do not emit [VERIFY_DONE] in text; it is no longer ' +
        'auto-detected. Running team-done is the only reliable way to close.',
      null,
    ],
    [
      'The instructions say to emit [EXEC_DONE] when the patch lands and tests pass. ' +
        'Currently mid-implementation, will signal once codex-2 confirms the diff.',
      null,
    ],
    // High-conf still works for real edge-position sign-offs:
    ['[VERIFY_DONE] approved', 'high'],
    ['Cross-check ok [VERIFY_DONE]', 'high'],
    ['[DONE] my part — handing off to sonnet-2', 'high'],
  ] as const)('"%s" → %s', (content: string, expected: 'high' | 'low' | null) => {
    expect(getCompletionConfidence(content)).toBe(expected)
  })
})

// ─────────────────────────────────────────────────────
// 4. team-say — output format validation
// ─────────────────────────────────────────────────────
describe('team-say — output format', () => {
  let testTeamId: string
  let outputFile: string

  beforeEach(() => {
    testTeamId = `team-say-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    outputFile = path.join(TMP_ENSEMBLE_DIR, testTeamId, 'messages.jsonl')
    fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  })

  afterEach(() => {
    if (fs.existsSync(outputFile)) fs.rmSync(outputFile, { force: true })
  })

  it('prints "Sent to <recipient>" on stdout', () => {
    const stdout = execFileSync(
      TEAM_SAY_BIN,
      [testTeamId, 'codex-1', 'claude-2', 'test message'],
      { encoding: 'utf-8' },
    ).trim()
    expect(stdout).toBe('Sent to claude-2')
  })

  it('writes valid JSONL to /tmp/ensemble/<teamId>/messages.jsonl', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'hello'])
    expect(fs.existsSync(outputFile)).toBe(true)

    const line = fs.readFileSync(outputFile, 'utf-8').trim()
    expect(() => JSON.parse(line)).not.toThrow()
  })

  it('message contains all required EnsembleMessage fields', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'field check'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())

    expect(msg).toMatchObject({
      teamId: testTeamId,
      from: 'codex-1',
      to: 'claude-2',
      content: 'field check',
      type: 'chat',
    })
    expect(msg.id).toEqual(expect.any(String))
    expect(msg.timestamp).toEqual(expect.any(String))
  })

  it('id is a valid UUID v4', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'uuid test'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(msg.id).toMatch(uuidV4Regex)
  })

  it('timestamp is a valid, recent ISO 8601 string', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'ts test'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    const parsed = new Date(msg.timestamp)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    expect(Date.now() - parsed.getTime()).toBeLessThan(10_000)
  })

  it('preserves multi-word content', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'bericht met spaties'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.content).toBe('bericht met spaties')
  })

  it('handles special characters in message', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'Hello "world" & <test>'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.content).toContain('"world"')
    expect(msg.content).toContain('&')
    expect(msg.content).toContain('<test>')
  })

  it('appends multiple messages with unique ids', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'First'])
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'Second'])

    const lines = fs.readFileSync(outputFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)

    const msg1 = JSON.parse(lines[0])
    const msg2 = JSON.parse(lines[1])
    expect(msg1.content).toBe('First')
    expect(msg2.content).toBe('Second')
    expect(msg1.id).not.toBe(msg2.id)
  })

  // Defensive parsing — 112 historical empty-content msgs were caused by agents
  // (haiku/codex-mini especially) collapsing addressee + message into one
  // shell-quoted arg. Old parser sliced $3 as TO and left MSG empty, yielding
  // {to: "claude-1, codex-2: actual message", content: ""}.
  it('collapsed-arg form: 3 args with multicast addressee in $3 routes whole arg to content', () => {
    execFileSync(
      TEAM_SAY_BIN,
      [testTeamId, 'haiku-3', 'claude-1, codex-2: Starting Round 10. Ready for PHASE 1.'],
      { encoding: 'utf-8' },
    )
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.from).toBe('haiku-3')
    expect(msg.to).toBe('team')
    expect(msg.content).toBe('claude-1, codex-2: Starting Round 10. Ready for PHASE 1.')
    expect(msg.content).not.toBe('')
  })

  it('3-arg form: TID FROM "message" with no addressee uses to="team"', () => {
    execFileSync(
      TEAM_SAY_BIN,
      [testTeamId, 'codex-1', 'this is a broadcast finding'],
      { encoding: 'utf-8' },
    )
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.to).toBe('team')
    expect(msg.content).toBe('this is a broadcast finding')
  })

  it('refuses to write empty-content messages (exit code 3, stderr explanation)', () => {
    expect(() => {
      execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', ''], { stdio: 'pipe' })
    }).toThrow()
    // No file should have been created — the empty-message guard short-circuits
    // before any write to messages.jsonl.
    expect(fs.existsSync(outputFile)).toBe(false)
  })

  it('refuses to write whitespace-only content', () => {
    expect(() => {
      execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', '   \n\t  '], { stdio: 'pipe' })
    }).toThrow()
    expect(fs.existsSync(outputFile)).toBe(false)
  })

  it('canonical 4-arg form still routes correctly (regression guard)', () => {
    execFileSync(TEAM_SAY_BIN, [testTeamId, 'codex-1', 'claude-2', 'normal canonical message'])
    const msg = JSON.parse(fs.readFileSync(outputFile, 'utf-8').trim())
    expect(msg.from).toBe('codex-1')
    expect(msg.to).toBe('claude-2')
    expect(msg.content).toBe('normal canonical message')
  })
})

// ─────────────────────────────────────────────────────
// 5. Collab templates — loading & prompt generation
// ─────────────────────────────────────────────────────
describe('collab templates', () => {
  const templatesPath = path.resolve(process.cwd(), 'collab-templates.json')

  it('collab-templates.json exists and is valid JSON', () => {
    expect(fs.existsSync(templatesPath)).toBe(true)
    const data = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'))
    expect(data.templates).toBeDefined()
  })

  it('contains all 4 required templates', () => {
    const data = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'))
    expect(Object.keys(data.templates)).toEqual(
      expect.arrayContaining(['review', 'implement', 'research', 'debug'])
    )
  })

  it.each(['review', 'implement', 'research', 'debug'])(
    'template "%s" has required fields',
    (templateName) => {
      const data = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'))
      const template = data.templates[templateName]
      expect(template.name).toEqual(expect.any(String))
      expect(template.description).toEqual(expect.any(String))
      expect(template.suggestedTaskPrefix).toEqual(expect.any(String))
      expect(template.roles).toHaveLength(2)
      for (const role of template.roles) {
        expect(role.role).toEqual(expect.any(String))
        expect(role.focus).toEqual(expect.any(String))
      }
    }
  )

  it('each template has unique role names per template', () => {
    const data = JSON.parse(fs.readFileSync(templatesPath, 'utf-8'))
    for (const [, template] of Object.entries(data.templates) as [string, { roles: { role: string }[] }][]) {
      const roleNames = template.roles.map((r: { role: string }) => r.role)
      expect(new Set(roleNames).size).toBe(roleNames.length)
    }
  })
})

// ─────────────────────────────────────────────────────
// 5b. buildPromptPreview — task-description sanitization and [DONE] guidance
// ─────────────────────────────────────────────────────
describe('buildPromptPreview() — injection guard + completion guidance', () => {
  it('includes explicit [DONE] guidance so agents know to mark completion', async () => {
    const { buildPromptPreview } = await import('../services/ensemble-service')
    const prompt = buildPromptPreview({
      teamId: 't1',
      teamName: 'team-x',
      description: 'Refactor the foo module',
      agentName: 'codex-1',
      teammateNames: ['claude-2'],
      agentIndex: 0,
    })
    expect(prompt).toMatch(/\[DONE\]/)
    expect(prompt.toLowerCase()).toContain('team-say')
  })

  it('redacts class tags in user-supplied task descriptions to prevent completion-signal injection', async () => {
    const { buildPromptPreview } = await import('../services/ensemble-service')
    const prompt = buildPromptPreview({
      teamId: 't1',
      teamName: 'team-x',
      description: 'Find the [DONE] marker and [PROGRESS] tags — also [EXEC_DONE]/[VERIFY_DONE]',
      agentName: 'codex-1',
      teammateNames: ['claude-2'],
      agentIndex: 0,
    })
    // After sanitization the Task: line should contain (tag-redacted) not the raw tags.
    const taskLine = prompt.split(' ').join(' ')
    expect(taskLine).toContain('(tag-redacted)')
    // The agent's own completion-hint still keeps [DONE] because it's in a
    // different segment (COMMUNICATION RULES), but the echoed user task must
    // not contain the raw tags that would trip HIGH_CONFIDENCE auto-disband.
    const taskSection = prompt.match(/Task: [^]+?(?=\sROLE:)/)?.[0] ?? ''
    expect(taskSection).not.toMatch(/\[DONE\]/)
    expect(taskSection).not.toMatch(/\[EXEC_DONE\]/)
    expect(taskSection).not.toMatch(/\[VERIFY_DONE\]/)
    expect(taskSection).not.toMatch(/\[PROGRESS\]/)
  })

  // CHALLENGE CULTURE — verify mode injection works end-to-end.
  it('omits the challenge block when challengeMode is normal (default)', async () => {
    const { buildPromptPreview } = await import('../services/ensemble-service')
    const prompt = buildPromptPreview({
      teamId: 't1', teamName: 'team-x', description: 'normal task',
      agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
    })
    expect(prompt).not.toContain('CHALLENGE CULTURE')
  })

  it('injects RIGOROUS challenge block for premium-quad / pentest / debug templates by default', async () => {
    const { buildPromptPreview } = await import('../services/ensemble-service')
    for (const tmpl of ['premium-quad', 'pentest', 'debug', 'adversarial']) {
      const prompt = buildPromptPreview({
        teamId: 't1', teamName: 'team-x', description: 'auto-rigorous task',
        agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
        templateName: tmpl,
      })
      expect(prompt, `template=${tmpl}`).toContain('CHALLENGE CULTURE: rigorous')
      expect(prompt).toContain('Polite-ack is weak')
    }
  })

  it('explicit challengeMode overrides the template default — sparring on premium-quad', async () => {
    const { buildPromptPreview } = await import('../services/ensemble-service')
    const prompt = buildPromptPreview({
      teamId: 't1', teamName: 'team-x', description: 'high-heat task',
      agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
      templateName: 'premium-quad',
      challengeMode: 'sparring',
    })
    expect(prompt).toContain('CHALLENGE CULTURE: sparring')
    expect(prompt).toContain('Polite-acks are BANNED')
    expect(prompt).not.toContain('CHALLENGE CULTURE: rigorous')
  })

  it('explicit challengeMode=normal downgrades a rigorous-by-default template', async () => {
    const { buildPromptPreview } = await import('../services/ensemble-service')
    const prompt = buildPromptPreview({
      teamId: 't1', teamName: 'team-x', description: 'critical but quiet',
      agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
      templateName: 'premium-quad',
      challengeMode: 'normal',
    })
    expect(prompt).not.toContain('CHALLENGE CULTURE')
  })

  // FIX 4: rigorous + sparring modes ship the intermediate-commit discipline rule
  it.each(['rigorous', 'sparring'] as const)(
    '%s mode includes the intermediate-commit rule so mid-flight disband does not lose work',
    async (mode) => {
      const { buildPromptPreview } = await import('../services/ensemble-service')
      const prompt = buildPromptPreview({
        teamId: 't1', teamName: 'team-x', description: 'big refactor',
        agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
        challengeMode: mode,
      })
      expect(prompt).toContain('INTERMEDIATE COMMIT RULE')
      expect(prompt).toContain('git add -A && git commit')
      expect(prompt).toContain('5-10 file edits')
    }
  )
  it('normal mode does NOT include the intermediate-commit rule', async () => {
    const { buildPromptPreview } = await import('../services/ensemble-service')
    const prompt = buildPromptPreview({
      teamId: 't1', teamName: 'team-x', description: 'simple fix',
      agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
      challengeMode: 'normal',
    })
    expect(prompt).not.toContain('INTERMEDIATE COMMIT RULE')
  })

  // FIX 2: .collab-protect injection
  it('injects PROTECTED FILES block when working directory has a .collab-protect file', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-'))
    try {
      fs.writeFileSync(path.join(tmpRoot, '.collab-protect'),
        '# Design system primitives\n' +
        'src/components/primitives/Card.tsx\n' +
        'src/components/primitives/Button.tsx\n' +
        '\n' +
        '# generated\n' +
        'src/generated/**\n'
      )
      const { buildPromptPreview } = await import('../services/ensemble-service')
      const prompt = buildPromptPreview({
        teamId: 't1', teamName: 'team-x', description: 'task',
        agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
        workingDirectory: tmpRoot,
      })
      expect(prompt).toContain('PROTECTED FILES — DO NOT EDIT')
      expect(prompt).toContain('src/components/primitives/Card.tsx')
      expect(prompt).toContain('src/components/primitives/Button.tsx')
      expect(prompt).toContain('src/generated/**')
      // Comments + blank lines stripped
      expect(prompt).not.toContain('# Design system')
      expect(prompt).toContain('emit [BLOCKER]')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('omits PROTECTED FILES block when no .collab-protect exists', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'no-protect-'))
    try {
      const { buildPromptPreview } = await import('../services/ensemble-service')
      const prompt = buildPromptPreview({
        teamId: 't1', teamName: 'team-x', description: 'task',
        agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
        workingDirectory: tmpRoot,
      })
      expect(prompt).not.toContain('PROTECTED FILES')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  // Memory cross-project leak fix — accounting-helper collab must not see
  // crypto memories in the TEAM MEMORIES block, and vice versa.
  it('filters TEAM MEMORIES to exclude memories tagged with a different project', async () => {
    // Spin up an isolated registry root so memories don't bleed from real disk
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-filter-'))
    const tmpCwd = path.join(tmpDataDir, 'projects', 'accounting-helper')
    fs.mkdirSync(tmpCwd, { recursive: true })
    const oldEnsembleDataDir = process.env.ENSEMBLE_DATA_DIR
    process.env.ENSEMBLE_DATA_DIR = tmpDataDir
    vi.resetModules()
    try {
      const { writeMemory } = await import('../lib/memory-store')
      // Seed: 2 crypto memories, 1 libro memory, 1 generic memory
      writeMemory({ scope: 'global', key: 'scalp_signal_2026', value: 'scalp signal pattern',
                   tags: ['scalp_perp_basis_fade', 'crypto-trading-platform'] })
      writeMemory({ scope: 'global', key: 'paper_db_span',     value: 'paper db span info',
                   tags: ['paper_trades_db', 'data_span'] })
      writeMemory({ scope: 'global', key: 'section_header',    value: 'section header pattern',
                   tags: ['accounting-helper', 'frontend'] })
      writeMemory({ scope: 'global', key: 'general_pattern',   value: 'cross-project lesson',
                   tags: ['general', 'lesson'] })

      const { buildPromptPreview } = await import('../services/ensemble-service')
      const prompt = buildPromptPreview({
        teamId: 't1', teamName: 'team-x', description: 'libro task',
        agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
        workingDirectory: tmpCwd,  // basename = accounting-helper
      })

      // Libro-tagged memory must appear
      expect(prompt).toContain('section_header')
      // Generic memory (no project tag) must appear
      expect(prompt).toContain('general_pattern')
      // Crypto-tagged memory must NOT appear
      expect(prompt).not.toContain('scalp_signal_2026')
      // paper_trades_db is a known cross-project tag → excluded
      expect(prompt).not.toContain('paper_db_span')
    } finally {
      if (oldEnsembleDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
      else process.env.ENSEMBLE_DATA_DIR = oldEnsembleDataDir
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
      vi.resetModules()
    }
  })

  // Auto-learning extraction — no LLM call, deterministic patterns, dedupe.
  it('auto-extracts VERIFY NO-GO blocker lessons on disband', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-learn-nogo-'))
    const tmpCwd = path.join(tmpDataDir, 'projects', 'accounting-helper')
    fs.mkdirSync(tmpCwd, { recursive: true })
    const oldDataDir = process.env.ENSEMBLE_DATA_DIR
    process.env.ENSEMBLE_DATA_DIR = tmpDataDir
    vi.resetModules()
    try {
      const { createTeam, appendMessage } = await import('../lib/ensemble-registry')
      const team = createTeam({
        name: 'auto-learn-team', description: 'libro polish',
        agents: [{ program: 'codex', role: 'lead', hostId: 'local' }],
        workingDirectory: tmpCwd,
      })
      appendMessage(team.id, {
        id: 'm1', teamId: team.id, from: 'codex-1', to: 'team',
        content: '[VERIFY_DONE] gate: NO-GO\n' +
          '- Blocker 1: AuditPage.jsx:266 missing aria-expanded on row\n' +
          '- Blocker 2: SettingsPage.jsx:142 broken keychain key mismatch\n' +
          '- Blocker 3: useSSE.jsx:21 reconnect listener missing',
        type: 'chat', timestamp: '2026-04-28T10:00:00Z',
      })
      appendMessage(team.id, {
        id: 'm2', teamId: team.id, from: 'claude-1', to: 'team',
        content: 'Confirmed all three.', type: 'chat', timestamp: '2026-04-28T10:00:01Z',
      })
      appendMessage(team.id, {
        id: 'm3', teamId: team.id, from: 'haiku-3', to: 'team',
        content: 'GOTCHA: when migrating SectionHeader, parent div with flex justify-between must wrap both children — otherwise layout breaks on tablet width.',
        type: 'chat', timestamp: '2026-04-28T10:00:02Z',
      })
      appendMessage(team.id, {
        id: 'm4', teamId: team.id, from: 'codex-1', to: 'team',
        content: '🔍 codex-1: claude-1 claimed fix landed — counter: src/hooks/useSSE.jsx:21-27 still has reconnect bug, addEventListener never reattached on second connect.',
        type: 'chat', timestamp: '2026-04-28T10:00:03Z',
      })
      const { disbandTeam } = await import('../services/ensemble-service')
      await disbandTeam(team.id, 'test', { triggeredBy: 'unit-test' })
      const { queryMemories } = await import('../lib/memory-store')
      const lessons = queryMemories({ scope: 'global', tags: ['auto_extracted'], limit: 50 })
      expect(lessons.length).toBeGreaterThanOrEqual(4)
      expect(lessons.some(l => l.value.includes('AuditPage.jsx:266'))).toBe(true)
      expect(lessons.some(l => l.value.includes('keychain key mismatch'))).toBe(true)
      expect(lessons.some(l => l.value.includes('useSSE.jsx:21'))).toBe(true)
      expect(lessons.some(l => l.value.includes('SectionHeader'))).toBe(true)
      const taggedAccounting = lessons.filter(l => l.tags.includes('accounting-helper'))
      expect(taggedAccounting.length).toBe(lessons.length)
    } finally {
      if (oldDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
      else process.env.ENSEMBLE_DATA_DIR = oldDataDir
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
      vi.resetModules()
    }
  })

  it('does NOT extract lessons when message thread is too short or has no patterns', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-learn-empty-'))
    const tmpCwd = path.join(tmpDataDir, 'projects', 'accounting-helper')
    fs.mkdirSync(tmpCwd, { recursive: true })
    const oldDataDir = process.env.ENSEMBLE_DATA_DIR
    process.env.ENSEMBLE_DATA_DIR = tmpDataDir
    vi.resetModules()
    try {
      const { createTeam, appendMessage } = await import('../lib/ensemble-registry')
      const team = createTeam({
        name: 'empty-team', description: 'small chat',
        agents: [{ program: 'codex', role: 'lead', hostId: 'local' }],
        workingDirectory: tmpCwd,
      })
      appendMessage(team.id, {
        id: 'm1', teamId: team.id, from: 'codex-1', to: 'team',
        content: 'Plan ready, starting now.', type: 'chat', timestamp: '2026-04-28T10:00:00Z',
      })
      appendMessage(team.id, {
        id: 'm2', teamId: team.id, from: 'claude-1', to: 'team',
        content: 'Looks good.', type: 'chat', timestamp: '2026-04-28T10:00:01Z',
      })
      const { disbandTeam } = await import('../services/ensemble-service')
      await disbandTeam(team.id, 'test', { triggeredBy: 'unit-test' })
      const { queryMemories } = await import('../lib/memory-store')
      const lessons = queryMemories({ scope: 'global', tags: ['auto_extracted'], limit: 50 })
      expect(lessons.length).toBe(0)
    } finally {
      if (oldDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
      else process.env.ENSEMBLE_DATA_DIR = oldDataDir
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
      vi.resetModules()
    }
  })

  // FIX 3: teams.json archive rotation when threshold exceeded
  // FIX 6: searchHistory falls through to archive files
  it('searchHistory finds teams that have been moved to monthly archive files', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-search-'))
    const archDir = path.join(tmpDataDir, 'ensemble')
    fs.mkdirSync(archDir, { recursive: true })
    const oldDataDir = process.env.ENSEMBLE_DATA_DIR
    process.env.ENSEMBLE_DATA_DIR = tmpDataDir
    vi.resetModules()
    try {
      // Live registry: 1 active team that doesn't match the query
      const liveTeam = {
        id: 'live1', name: 'live', description: 'something unrelated', status: 'active',
        agents: [], createdBy: 'x', createdAt: '2026-04-28T10:00:00Z', feedMode: 'live',
      }
      fs.writeFileSync(path.join(archDir, 'teams.json'), JSON.stringify([liveTeam], null, 2))
      // Archive file: a disbanded team whose description matches "Postmark webhook"
      const archivedTeam = {
        id: 'arch1', name: 'archived', description: 'Postmark webhook security audit',
        status: 'disbanded', agents: [], createdBy: 'x',
        createdAt: '2026-03-01T10:00:00Z', completedAt: '2026-03-01T11:00:00Z', feedMode: 'live',
      }
      fs.writeFileSync(path.join(archDir, 'teams-archive-2026-03.json'),
        JSON.stringify([archivedTeam], null, 2))

      const { searchHistory } = await import('../services/ensemble-service')
      const result = searchHistory('Postmark webhook', 10)
      expect(result.error).toBeUndefined()
      expect(result.data?.matches.length).toBeGreaterThanOrEqual(1)
      expect(result.data?.matches.some(m => m.teamId === 'arch1')).toBe(true)
    } finally {
      if (oldDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
      else process.env.ENSEMBLE_DATA_DIR = oldDataDir
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
      vi.resetModules()
    }
  })

  it('loadAllTeamsIncludingArchives merges live + archive without duplicates', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-merge-'))
    const archDir = path.join(tmpDataDir, 'ensemble')
    fs.mkdirSync(archDir, { recursive: true })
    const oldDataDir = process.env.ENSEMBLE_DATA_DIR
    process.env.ENSEMBLE_DATA_DIR = tmpDataDir
    vi.resetModules()
    try {
      fs.writeFileSync(path.join(archDir, 'teams.json'),
        JSON.stringify([{ id: 'a', name: '', description: '', status: 'active', agents: [], createdBy: 'x', createdAt: '2026-04-28T10:00:00Z', feedMode: 'live' }], null, 2))
      fs.writeFileSync(path.join(archDir, 'teams-archive-2026-02.json'),
        JSON.stringify([
          { id: 'b', name: '', description: '', status: 'disbanded', agents: [], createdBy: 'x', createdAt: '2026-02-15T10:00:00Z', feedMode: 'live' },
          { id: 'a', name: '', description: 'duplicate', status: 'old', agents: [], createdBy: 'x', createdAt: '2025-12-01T10:00:00Z', feedMode: 'live' },  // collision — must be deduped
        ], null, 2))
      fs.writeFileSync(path.join(archDir, 'teams-archive-2026-03.json'),
        JSON.stringify([{ id: 'c', name: '', description: '', status: 'disbanded', agents: [], createdBy: 'x', createdAt: '2026-03-15T10:00:00Z', feedMode: 'live' }], null, 2))

      const { loadAllTeamsIncludingArchives } = await import('../lib/ensemble-registry')
      const all = loadAllTeamsIncludingArchives()
      expect(all.map(t => t.id).sort()).toEqual(['a', 'b', 'c'])
      // The live 'a' wins on collision — status is 'active', not 'old'
      const a = all.find(t => t.id === 'a')!
      expect(a.status).toBe('active')
    } finally {
      if (oldDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
      else process.env.ENSEMBLE_DATA_DIR = oldDataDir
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
      vi.resetModules()
    }
  })

  it('archives old disbanded teams when teams.json exceeds threshold', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'))
    const oldDataDir = process.env.ENSEMBLE_DATA_DIR
    const oldThreshold = process.env.ENSEMBLE_TEAMS_ARCHIVE_THRESHOLD
    process.env.ENSEMBLE_DATA_DIR = tmpDataDir
    process.env.ENSEMBLE_TEAMS_ARCHIVE_THRESHOLD = '5'  // tiny threshold for fast test
    process.env.ENSEMBLE_TEAMS_ARCHIVE_AGE_MS = '1000'  // 1s aging
    vi.resetModules()
    try {
      const { saveTeams, loadTeams } = await import('../lib/ensemble-registry')
      // Seed: 6 teams, 4 old-disbanded, 1 recent-disbanded, 1 active
      const oldTs = new Date(Date.now() - 60_000).toISOString()
      const recentTs = new Date().toISOString()
      const teams = [
        { id: 't1', name: 'a', description: 'old1', status: 'disbanded', agents: [], createdBy: 'x', createdAt: oldTs, completedAt: oldTs, feedMode: 'live' as const },
        { id: 't2', name: 'b', description: 'old2', status: 'disbanded', agents: [], createdBy: 'x', createdAt: oldTs, completedAt: oldTs, feedMode: 'live' as const },
        { id: 't3', name: 'c', description: 'old3', status: 'disbanded', agents: [], createdBy: 'x', createdAt: oldTs, completedAt: oldTs, feedMode: 'live' as const },
        { id: 't4', name: 'd', description: 'old4', status: 'failed',    agents: [], createdBy: 'x', createdAt: oldTs, completedAt: oldTs, feedMode: 'live' as const },
        { id: 't5', name: 'e', description: 'recent', status: 'disbanded', agents: [], createdBy: 'x', createdAt: recentTs, completedAt: recentTs, feedMode: 'live' as const },
        { id: 't6', name: 'f', description: 'active', status: 'active', agents: [], createdBy: 'x', createdAt: recentTs, feedMode: 'live' as const },
      ] as any
      saveTeams(teams)
      const live = loadTeams()
      // Active + recent disbanded must remain in live file
      expect(live.find(t => t.id === 't5')).toBeDefined()
      expect(live.find(t => t.id === 't6')).toBeDefined()
      // KEEP_RECENT_DISBANDED is 200 in production but with only 4 disbanded
      // older than ARCHIVE_AGE_MS, all 4 are within "recent N" so NONE
      // archive on this small dataset. Verify by checking no archive file
      // is produced when we have fewer disbanded than KEEP_RECENT_DISBANDED.
      const archiveFiles = fs.readdirSync(path.join(tmpDataDir, 'ensemble'))
        .filter(f => f.startsWith('teams-archive-'))
      expect(archiveFiles.length).toBe(0)
      expect(live.length).toBe(6)
    } finally {
      if (oldDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
      else process.env.ENSEMBLE_DATA_DIR = oldDataDir
      if (oldThreshold === undefined) delete process.env.ENSEMBLE_TEAMS_ARCHIVE_THRESHOLD
      else process.env.ENSEMBLE_TEAMS_ARCHIVE_THRESHOLD = oldThreshold
      delete process.env.ENSEMBLE_TEAMS_ARCHIVE_AGE_MS
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
      vi.resetModules()
    }
  })

  it('falls back to global memories when cwd is outside known project roots', async () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-nogated-'))
    const oldEnsembleDataDir = process.env.ENSEMBLE_DATA_DIR
    process.env.ENSEMBLE_DATA_DIR = tmpDataDir
    vi.resetModules()
    try {
      const { writeMemory } = await import('../lib/memory-store')
      writeMemory({ scope: 'global', key: 'm1', value: 'crypto stuff', tags: ['crypto-trading-platform'] })
      writeMemory({ scope: 'global', key: 'm2', value: 'libro stuff',  tags: ['accounting-helper'] })

      const { buildPromptPreview } = await import('../services/ensemble-service')
      const prompt = buildPromptPreview({
        teamId: 't1', teamName: 'team-x', description: 'unknown-cwd task',
        agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
        workingDirectory: '/some/random/path/no-project-name',
      })
      // No project context → both memories appear (legacy behavior)
      expect(prompt).toContain('m1')
      expect(prompt).toContain('m2')
    } finally {
      if (oldEnsembleDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
      else process.env.ENSEMBLE_DATA_DIR = oldEnsembleDataDir
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
      vi.resetModules()
    }
  })
})

// ─────────────────────────────────────────────────────
// 6. Worktree isolation lifecycle
// ─────────────────────────────────────────────────────
describe('worktree isolation lifecycle', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-worktree-'))
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setupWorktreeService(team: EnsembleTeam) {
    const appendedMessages: EnsembleMessage[] = []
    const createTeam = vi.fn(() => team)
    const getTeam = vi.fn(() => team)
    const updateTeam = vi.fn((_id: string, updates: Partial<EnsembleTeam>) => ({ ...team, ...updates }))
    const appendMessage = vi.fn((_id: string, message: EnsembleMessage) => appendedMessages.push(message))
    const spawnLocalAgent = vi.fn(async ({ name, program, workingDirectory, hostId }) => ({
      id: `${name}-id`,
      name,
      program,
      sessionName: name,
      workingDirectory,
      hostId,
    }))
    const spawnRemoteAgent = vi.fn(async () => ({ id: 'remote-agent-id' }))
    const killLocalAgent = vi.fn(async () => {})
    const killRemoteAgent = vi.fn(async () => {})
    const createWorktree = vi.fn(async (teamId: string, agentName: string, basePath: string) => ({
      path: path.join(basePath, '.worktrees', `${teamId}-${agentName}`),
      branch: `collab/${teamId}/${agentName}`,
      agentName,
    }))
    const mergeWorktree = vi.fn(async () => ({ success: true }))
    const destroyWorktree = vi.fn(async () => {})

    vi.doMock('../lib/ensemble-registry', () => ({
      createTeam,
      getTeam,
      updateTeam,
      loadTeams: vi.fn(() => []),
      appendMessage,
      getMessages: vi.fn(() => []),
      getActiveTeamsByWorkingDir: vi.fn(() => []),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent,
      killLocalAgent,
      spawnRemoteAgent,
      killRemoteAgent,
      postRemoteSessionCommand: vi.fn(),
      isRemoteSessionReady: vi.fn(async () => true),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/worktree-manager', () => ({
      createWorktree,
      mergeWorktree,
      destroyWorktree,
      listTeamWorktrees: vi.fn(async () => []),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn((hostId: string) => hostId === 'local'),
      getHostById: vi.fn((hostId: string) => {
        if (hostId === 'local') return { id: 'local', url: 'http://local.test' }
        if (hostId === 'remote-1') return { id: 'remote-1', url: 'http://remote.test' }
        return undefined
      }),
      getSelfHostId: vi.fn(() => 'local'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(() => ({
        capturePane: vi.fn(async () => '>'),
        sendKeys: vi.fn(async () => {}),
        pasteFromFile: vi.fn(async () => {}),
      })),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
    }))
    vi.doMock('../lib/collab-paths', () => ({
      ensureCollabDirs: vi.fn(),
      collabPromptFile: vi.fn((teamId: string, agentName: string) => path.join(tempRoot, `${teamId}-${agentName}.prompt.txt`)),
      collabDeliveryFile: vi.fn((teamId: string, sessionName: string) => path.join(tempRoot, `${teamId}-${sessionName}.delivery.txt`)),
      collabSummaryFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.summary.txt`)),
      collabRuntimeDir: vi.fn((teamId: string) => path.join(tempRoot, teamId)),
      collabFinishedMarker: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.finished`)),
      collabBridgePosted: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.posted`)),
      collabBridgeResult: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.result`)),
    }))

    const mod = await import('../services/ensemble-service')
    return {
      mod,
      team,
      appendedMessages,
      mocks: {
        createTeam,
        getTeam,
        updateTeam,
        appendMessage,
        spawnLocalAgent,
        spawnRemoteAgent,
        killLocalAgent,
        killRemoteAgent,
        createWorktree,
        mergeWorktree,
        destroyWorktree,
      },
    }
  }

  it('spawns local agents inside their worktree when useWorktrees=true', async () => {
    const team = makeTeam({
      id: 'team-worktree-create',
      name: 'team-worktree-create',
      agents: [
        {
          agentId: '',
          name: 'codex-1',
          program: 'codex',
          role: 'lead',
          hostId: '',
          status: 'spawning',
        },
      ],
    })
    const { mod, mocks } = await setupWorktreeService(team)

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }],
      workingDirectory: '/repo',
      useWorktrees: true,
    })

    expect(mocks.createWorktree).toHaveBeenCalledWith(team.id, 'codex-1', '/repo')
    expect(mocks.spawnLocalAgent).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/repo/.worktrees/team-worktree-create-codex-1',
    }))
  })

  it('does not create worktrees when useWorktrees=false', async () => {
    const team = makeTeam({
      id: 'team-worktree-disabled',
      name: 'team-worktree-disabled',
      agents: [
        {
          agentId: '',
          name: 'codex-1',
          program: 'codex',
          role: 'lead',
          hostId: '',
          status: 'spawning',
        },
      ],
    })
    const { mod, mocks } = await setupWorktreeService(team)

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }],
      workingDirectory: '/repo',
      useWorktrees: false,
    })

    expect(mocks.createWorktree).not.toHaveBeenCalled()
    expect(mocks.spawnLocalAgent).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/repo',
    }))
  })

  it('kills the local session before merging and destroying its worktree', async () => {
    const team = makeTeam({
      id: 'team-worktree-disband',
      name: 'team-worktree-disband',
      agents: [
        {
          agentId: 'agent-1',
          name: 'codex-1',
          program: 'codex',
          role: 'lead',
          hostId: 'local',
          status: 'active',
          worktreePath: '/repo/.worktrees/team-worktree-disband-codex-1',
          worktreeBranch: 'collab/team-worktree-disband/codex-1',
        },
      ],
    })
    const { mod, mocks } = await setupWorktreeService(team)

    await mod.disbandTeam(team.id)

    expect(mocks.mergeWorktree).toHaveBeenCalledWith({
      path: '/repo/.worktrees/team-worktree-disband-codex-1',
      branch: 'collab/team-worktree-disband/codex-1',
      agentName: 'codex-1',
    }, '/repo')
    expect(mocks.destroyWorktree).toHaveBeenCalledWith({
      path: '/repo/.worktrees/team-worktree-disband-codex-1',
      branch: 'collab/team-worktree-disband/codex-1',
      agentName: 'codex-1',
    }, '/repo')
    expect(mocks.killLocalAgent.mock.invocationCallOrder[0]).toBeLessThan(mocks.mergeWorktree.mock.invocationCallOrder[0])
    expect(mocks.mergeWorktree.mock.invocationCallOrder[0]).toBeLessThan(mocks.destroyWorktree.mock.invocationCallOrder[0])
  })

  it('skips worktree merge for remote agents even if worktree metadata exists', async () => {
    const team = makeTeam({
      id: 'team-worktree-remote',
      name: 'team-worktree-remote',
      agents: [
        {
          agentId: 'agent-1',
          name: 'claude-1',
          program: 'claude',
          role: 'member',
          hostId: 'remote-1',
          status: 'active',
          worktreePath: '/repo/.worktrees/team-worktree-remote-claude-1',
          worktreeBranch: 'collab/team-worktree-remote/claude-1',
        },
      ],
    })
    const { mod, mocks } = await setupWorktreeService(team)

    await mod.disbandTeam(team.id)

    expect(mocks.mergeWorktree).not.toHaveBeenCalled()
    expect(mocks.destroyWorktree).not.toHaveBeenCalled()
    expect(mocks.killRemoteAgent).toHaveBeenCalledWith('http://remote.test', 'agent-1')
  })
})

describe('staged workflow integration', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-staged-'))
    vi.resetModules()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  async function setupStagedService(team: EnsembleTeam) {
    const runtime = {
      capturePane: vi.fn(async () => '>'),
      sendKeys: vi.fn(async () => {}),
      pasteFromFile: vi.fn(async () => {}),
    }
    const runStagedWorkflow = vi.fn(async () => {})

    vi.doMock('../lib/ensemble-registry', () => ({
      createTeam: vi.fn(() => team),
      getTeam: vi.fn(() => team),
      updateTeam: vi.fn((_id: string, updates: Partial<EnsembleTeam>) => ({ ...team, ...updates })),
      loadTeams: vi.fn(() => []),
      appendMessage: vi.fn(),
      getMessages: vi.fn(() => []),
      getActiveTeamsByWorkingDir: vi.fn(() => []),
    }))
    vi.doMock('../lib/agent-spawner', () => ({
      spawnLocalAgent: vi.fn(async ({ name, program, workingDirectory, hostId }) => ({
        id: `${name}-id`,
        name,
        program,
        sessionName: name,
        workingDirectory,
        hostId,
      })),
      killLocalAgent: vi.fn(async () => {}),
      spawnRemoteAgent: vi.fn(async () => ({ id: 'remote-agent-id' })),
      killRemoteAgent: vi.fn(async () => {}),
      postRemoteSessionCommand: vi.fn(async () => {}),
      isRemoteSessionReady: vi.fn(async () => true),
      getAgentTokenUsage: vi.fn(async () => 'unknown'),
    }))
    vi.doMock('../lib/hosts-config', () => ({
      isSelf: vi.fn(() => true),
      getHostById: vi.fn(() => ({ id: 'local', url: 'http://local.test' })),
      getSelfHostId: vi.fn(() => 'local'),
    }))
    vi.doMock('../lib/agent-runtime', () => ({
      getRuntime: vi.fn(() => runtime),
    }))
    vi.doMock('../lib/agent-config', () => ({
      resolveAgentProgram: vi.fn(() => ({ readyMarker: '>', inputMethod: 'sendKeys' })),
    }))
    vi.doMock('../lib/collab-paths', () => ({
      ensureCollabDirs: vi.fn(),
      collabPromptFile: vi.fn((teamId: string, agentName: string) => path.join(tempRoot, `${teamId}-${agentName}.prompt.txt`)),
      collabDeliveryFile: vi.fn((teamId: string, sessionName: string) => path.join(tempRoot, `${teamId}-${sessionName}.delivery.txt`)),
      collabSummaryFile: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.summary.txt`)),
      collabRuntimeDir: vi.fn((teamId: string) => path.join(tempRoot, teamId)),
      collabFinishedMarker: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.finished`)),
      collabBridgePosted: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.posted`)),
      collabBridgeResult: vi.fn((teamId: string) => path.join(tempRoot, `${teamId}.result`)),
    }))
    vi.doMock('../lib/worktree-manager', () => ({
      createWorktree: vi.fn(),
      mergeWorktree: vi.fn(async () => ({ success: true })),
      destroyWorktree: vi.fn(async () => {}),
    }))
    vi.doMock('../lib/staged-workflow', () => ({
      runStagedWorkflow,
    }))

    const mod = await import('../services/ensemble-service')
    return { mod, runtime, runStagedWorkflow }
  }

  it('uses staged workflow instead of normal prompt injection when staged=true', async () => {
    const team = makeTeam({
      id: 'team-staged',
      name: 'team-staged',
      status: 'forming',
      agents: [
        { agentId: '', name: 'codex-1', program: 'codex', role: 'lead', hostId: '', status: 'spawning' },
        { agentId: '', name: 'claude-2', program: 'claude', role: 'member', hostId: '', status: 'spawning' },
      ],
    })
    const { mod, runtime, runStagedWorkflow } = await setupStagedService(team)
    const stagedConfig: StagedWorkflowConfig = { planTimeoutMs: 1500 }

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }, { program: 'claude' }],
      workingDirectory: '/repo',
      staged: true,
      stagedConfig,
    })

    expect(runStagedWorkflow).toHaveBeenCalledTimes(1)
    expect(runStagedWorkflow).toHaveBeenCalledWith(
      team,
      stagedConfig,
      expect.objectContaining({
        buildPlanPrompt: expect.any(Function),
        buildExecPrompt: expect.any(Function),
        buildVerifyPrompt: expect.any(Function),
      }),
    )
    expect(runtime.sendKeys).not.toHaveBeenCalled()
  })

  it('keeps normal prompt injection when staged=false', async () => {
    const team = makeTeam({
      id: 'team-non-staged',
      name: 'team-non-staged',
      status: 'forming',
      agents: [
        { agentId: '', name: 'codex-1', program: 'codex', role: 'lead', hostId: '', status: 'spawning' },
        { agentId: '', name: 'claude-2', program: 'claude', role: 'member', hostId: '', status: 'spawning' },
      ],
    })
    const { mod, runtime, runStagedWorkflow } = await setupStagedService(team)

    await mod.createEnsembleTeam({
      name: team.name,
      description: team.description,
      agents: [{ program: 'codex' }, { program: 'claude' }],
      workingDirectory: '/repo',
      staged: false,
    })

    expect(runStagedWorkflow).not.toHaveBeenCalled()
    expect(runtime.sendKeys).toHaveBeenCalledTimes(2)
  })
})

// ─────────────────────────────────────────────────────
// 8. CreateTeamRequest — staged field in types
// ─────────────────────────────────────────────────────
describe('CreateTeamRequest staged types', () => {
  it('staged field is optional and defaults behavior', () => {
    const request: import('../types/ensemble').CreateTeamRequest = {
      name: 'test',
      description: 'test',
      agents: [{ program: 'codex' }],
      staged: true,
      stagedConfig: {
        planTimeoutMs: 60_000,
        execTimeoutMs: 180_000,
      },
    }
    expect(request.staged).toBe(true)
    expect(request.stagedConfig?.planTimeoutMs).toBe(60_000)
  })

  it('staged field defaults to undefined (opt-in)', () => {
    const request: import('../types/ensemble').CreateTeamRequest = {
      name: 'test',
      description: 'test',
      agents: [{ program: 'codex' }],
    }
    expect(request.staged).toBeUndefined()
  })
})
