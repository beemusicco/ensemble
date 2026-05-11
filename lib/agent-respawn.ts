/**
 * agent-respawn — re-create a failed agent in an active team.
 *
 * Used by:
 *   - HTTP endpoint POST /api/ensemble/teams/:id/agents/:name/respawn  (manual)
 *   - Watchdog detectCrashedAgents()                                   (auto, env-gated)
 *   - Initial-spawn retry loop                                          (T2 retry)
 *
 * Safety guards:
 *   - Cooldown: refuse if lastRespawnAt is within DEFAULT_COOLDOWN_MS
 *   - Max attempts: refuse if respawnCount >= maxAttempts
 *   - Team must be active/forming (skip if disbanded/failed/completed)
 *   - Worktree REUSED — agent reads messages.jsonl on start to catch up
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'

import type { EnsembleTeam, EnsembleTeamAgent } from '../types/ensemble'
import { spawnLocalAgent, killLocalAgent, spawnRemoteAgent } from './agent-spawner'
import { updateTeam, appendMessage } from './ensemble-registry'

const DEFAULT_MAX_ATTEMPTS = Number(process.env.ENSEMBLE_AUTO_RESPAWN_MAX || 2)
const DEFAULT_COOLDOWN_MS = Number(process.env.ENSEMBLE_RESPAWN_COOLDOWN_MS || 30_000)
const TELEMETRY_LOG = path.join(os.homedir(), '.openclaw/logs/blocker-veto.jsonl')

export type RespawnTrigger = 'manual' | 'crash' | 'initial'

export interface RespawnOptions {
  reason: RespawnTrigger
  maxAttempts?: number
  cooldownMs?: number
}

export interface RespawnResult {
  success: boolean
  attempts: number
  agentId?: string
  error?: string
  reason?:
    | 'agent_not_found'
    | 'team_not_active'
    | 'cooldown_active'
    | 'max_attempts_reached'
    | 'spawn_failed'
}

function emitTelemetry(event: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(TELEMETRY_LOG), { recursive: true })
    fs.appendFileSync(
      TELEMETRY_LOG,
      JSON.stringify({ ts: Math.floor(Date.now() / 1000), ...event }) + '\n',
    )
  } catch {
    /* never fail because of telemetry */
  }
}

/** Return true if respawning would be safe given current team + agent state. */
function preflight(
  team: EnsembleTeam,
  agent: EnsembleTeamAgent,
  opts: RespawnOptions,
): { ok: true } | { ok: false; reason: RespawnResult['reason']; error: string } {
  if (!['active', 'forming', 'failed'].includes(team.status as string)) {
    return {
      ok: false,
      reason: 'team_not_active',
      error: `team status=${team.status} — refusing to respawn`,
    }
  }
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const count = agent.respawnCount ?? 0
  if (count >= max) {
    return {
      ok: false,
      reason: 'max_attempts_reached',
      error: `agent already respawned ${count}/${max} times`,
    }
  }
  if (agent.lastRespawnAt) {
    const sinceLast = Date.now() - new Date(agent.lastRespawnAt).getTime()
    const cooldown = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
    if (sinceLast < cooldown) {
      return {
        ok: false,
        reason: 'cooldown_active',
        error: `last respawn was ${Math.floor(sinceLast / 1000)}s ago, cooldown=${cooldown / 1000}s`,
      }
    }
  }
  return { ok: true }
}

/**
 * Respawn a single agent. Atomic w.r.t. registry update.
 * Caller is responsible for ensuring the latest team object is passed in.
 */
export async function respawnAgent(
  team: EnsembleTeam,
  agentName: string,
  opts: RespawnOptions,
): Promise<RespawnResult> {
  const agent = team.agents.find(a => a.name === agentName)
  if (!agent) {
    return { success: false, attempts: 0, reason: 'agent_not_found', error: `agent '${agentName}' not in team` }
  }

  const pf = preflight(team, agent, opts)
  if (!pf.ok) {
    emitTelemetry({
      action: 'respawn_skipped',
      team_id: team.id,
      agent: agentName,
      reason: pf.reason,
      detail: pf.error,
      trigger: opts.reason,
    })
    return { success: false, attempts: agent.respawnCount ?? 0, reason: pf.reason, error: pf.error }
  }

  const attemptNumber = (agent.respawnCount ?? 0) + 1
  emitTelemetry({
    action: 'respawn_attempt',
    team_id: team.id,
    agent: agentName,
    program: agent.program,
    attempt: attemptNumber,
    trigger: opts.reason,
  })

  const sessionName = `${team.name}-${agent.name}`
  // Best-effort cleanup of any leftover tmux session.
  try {
    await killLocalAgent(sessionName)
  } catch {
    /* session may already be gone */
  }
  // Brief delay so tmux fully tears down before recreate.
  await new Promise(r => setTimeout(r, 500))

  const cwd = agent.worktreePath || team.workingDirectory || process.cwd()

  let newAgentId: string
  try {
    if (!agent.hostId || agent.hostId === 'local') {
      const spawned = await spawnLocalAgent({
        name: sessionName,
        program: agent.program,
        workingDirectory: cwd,
        hostId: agent.hostId,
      })
      newAgentId = spawned.id
    } else {
      // Remote agent — re-use same host
      const remote = await spawnRemoteAgent(
        agent.hostId,
        sessionName,
        agent.program,
        cwd,
        team.description,
        team.name,
      )
      newAgentId = remote.id
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitTelemetry({
      action: 'respawn_failed',
      team_id: team.id,
      agent: agentName,
      attempt: attemptNumber,
      error: msg,
      trigger: opts.reason,
    })

    // Persist the increment even on failure so we don't infinite-loop.
    updateTeam(team.id, {
      agents: team.agents.map(a =>
        a.name === agentName
          ? {
              ...a,
              respawnCount: attemptNumber,
              lastRespawnAt: new Date().toISOString(),
            }
          : a,
      ),
    })

    return { success: false, attempts: attemptNumber, reason: 'spawn_failed', error: msg }
  }

  // Persist success — agent.status='active', clear out any failed marker.
  updateTeam(team.id, {
    agents: team.agents.map(a =>
      a.name === agentName
        ? {
            ...a,
            agentId: newAgentId,
            status: 'active',
            respawnCount: attemptNumber,
            lastRespawnAt: new Date().toISOString(),
          }
        : a,
    ),
  })

  appendMessage(team.id, {
    id: uuidv4(),
    teamId: team.id,
    from: 'ensemble',
    to: 'team',
    content:
      `🔄 ${agent.name} (${agent.program}) respawned (${opts.reason}, attempt ${attemptNumber}). ` +
      `Worktree preserved — agent will read recent feed to catch up.`,
    type: 'chat',
    timestamp: new Date().toISOString(),
    meta: { event: 'agent_respawned', agent: agent.name, trigger: opts.reason, attempt: attemptNumber },
  })

  emitTelemetry({
    action: 'respawn_success',
    team_id: team.id,
    agent: agentName,
    program: agent.program,
    attempts_used: attemptNumber,
    new_agent_id: newAgentId,
    trigger: opts.reason,
  })

  return { success: true, attempts: attemptNumber, agentId: newAgentId }
}

/**
 * Initial-spawn retry helper — used by createEnsembleTeam to wrap the first
 * spawn attempt with bounded backoff. Different from respawnAgent because
 * the agent doesn't yet exist in the team registry.
 */
export async function spawnWithRetry<T>(
  fn: () => Promise<T>,
  ctx: { teamId: string; agentName: string; program: string },
  attempts = 3,
  baseDelayMs = 2000,
): Promise<T> {
  let lastErr: Error | null = null
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      const delay = baseDelayMs * Math.pow(3, i - 1)
      emitTelemetry({
        action: 'spawn_retry_wait',
        team_id: ctx.teamId,
        agent: ctx.agentName,
        program: ctx.program,
        next_attempt: i + 1,
        delay_ms: delay,
      })
      await new Promise(r => setTimeout(r, delay))
    }
    try {
      const result = await fn()
      if (i > 0) {
        emitTelemetry({
          action: 'spawn_retry_success',
          team_id: ctx.teamId,
          agent: ctx.agentName,
          program: ctx.program,
          attempt: i + 1,
        })
      }
      return result
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      emitTelemetry({
        action: 'spawn_attempt_failed',
        team_id: ctx.teamId,
        agent: ctx.agentName,
        program: ctx.program,
        attempt: i + 1,
        error: lastErr.message,
      })
    }
  }
  throw lastErr ?? new Error('spawn failed after retries')
}
