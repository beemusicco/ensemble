import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnsembleTeam } from '../types/ensemble'

vi.mock('../lib/agent-spawner', () => ({
  spawnLocalAgent: vi.fn(async () => ({ id: 'new-agent-id-spawned' })),
  spawnRemoteAgent: vi.fn(async () => ({ id: 'new-remote-agent-id' })),
  killLocalAgent: vi.fn(async () => {}),
}))

vi.mock('../lib/ensemble-registry', () => ({
  updateTeam: vi.fn(),
  appendMessage: vi.fn(),
  getTeam: vi.fn(),
}))

function makeTeam(overrides: Partial<EnsembleTeam> = {}): EnsembleTeam {
  return {
    id: 'team-test',
    name: 'team-test',
    status: 'active',
    description: 'test',
    workingDirectory: '/tmp',
    agents: [
      {
        agentId: 'a1',
        name: 'codex-1',
        program: 'codex',
        role: 'lead',
        hostId: 'local',
        status: 'failed',
      },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  } as EnsembleTeam
}

describe('respawnAgent preflight guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects agent_not_found when name does not match', async () => {
    const { respawnAgent } = await import('../lib/agent-respawn')
    const team = makeTeam()
    const result = await respawnAgent(team, 'nonexistent', { reason: 'manual' })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('agent_not_found')
  })

  it('rejects team_not_active when team is disbanded', async () => {
    const { respawnAgent } = await import('../lib/agent-respawn')
    const team = makeTeam({ status: 'disbanded' as EnsembleTeam['status'] })
    const result = await respawnAgent(team, 'codex-1', { reason: 'manual' })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('team_not_active')
  })

  it('rejects max_attempts_reached when respawnCount >= max', async () => {
    const { respawnAgent } = await import('../lib/agent-respawn')
    const team = makeTeam()
    team.agents[0].respawnCount = 2
    const result = await respawnAgent(team, 'codex-1', { reason: 'manual', maxAttempts: 2 })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('max_attempts_reached')
  })

  it('rejects cooldown_active when lastRespawnAt is within cooldown', async () => {
    const { respawnAgent } = await import('../lib/agent-respawn')
    const team = makeTeam()
    team.agents[0].lastRespawnAt = new Date(Date.now() - 5_000).toISOString()
    const result = await respawnAgent(team, 'codex-1', { reason: 'manual', cooldownMs: 30_000 })
    expect(result.success).toBe(false)
    expect(result.reason).toBe('cooldown_active')
  })

  it('proceeds when all guards pass — calls spawnLocalAgent', async () => {
    const spawner = await import('../lib/agent-spawner')
    const { respawnAgent } = await import('../lib/agent-respawn')
    const team = makeTeam()
    const result = await respawnAgent(team, 'codex-1', { reason: 'manual' })
    expect(result.success).toBe(true)
    expect(result.agentId).toBe('new-agent-id-spawned')
    expect(spawner.spawnLocalAgent).toHaveBeenCalledOnce()
  })
})

describe('spawnWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns first-call success without delay', async () => {
    const { spawnWithRetry } = await import('../lib/agent-respawn')
    const fn = vi.fn(async () => ({ id: 'ok' }))
    const result = await spawnWithRetry(fn, { teamId: 't', agentName: 'a', program: 'codex' }, 3, 100)
    expect(result).toEqual({ id: 'ok' })
    expect(fn).toHaveBeenCalledOnce()
  })

  it('retries on failure with exponential backoff (3 attempts, baseDelay×3^(i-1))', async () => {
    const { spawnWithRetry } = await import('../lib/agent-respawn')
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error(`fail-${calls}`)
      return { id: 'eventual-success' }
    })
    const start = Date.now()
    const result = await spawnWithRetry(fn, { teamId: 't', agentName: 'a', program: 'codex' }, 3, 50)
    const elapsed = Date.now() - start
    expect(result).toEqual({ id: 'eventual-success' })
    expect(fn).toHaveBeenCalledTimes(3)
    // Backoff: 0 + 50 + 150 = 200ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(190)
  })

  it('throws last error after exhausting attempts', async () => {
    const { spawnWithRetry } = await import('../lib/agent-respawn')
    const fn = vi.fn(async () => { throw new Error('persistent') })
    await expect(
      spawnWithRetry(fn, { teamId: 't', agentName: 'a', program: 'codex' }, 2, 10),
    ).rejects.toThrow('persistent')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
