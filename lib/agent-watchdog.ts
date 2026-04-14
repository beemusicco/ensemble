import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { AgentRuntime } from './agent-runtime'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

const DEFAULT_POLL_INTERVAL_MS = 30_000
const DEFAULT_NUDGE_MS = 90_000
const DEFAULT_STALL_MS = 180_000
const WATCHDOG_NUDGE_TEXT = 'Are you still working? Share your progress with team-say.'

const LOOP_WARN_THRESHOLD = 20
const LOOP_DISBAND_THRESHOLD = 30

interface AgentWatchdogState {
  lastMessageAt: string
  nudgedAt?: string
  stalledAt?: string
}

interface PairLoopState {
  count: number
  warned: boolean
}

interface LoopState {
  pairs: Map<string, PairLoopState>
  lastCheckedIndex: number
}

const PROGRESS_PATTERNS = [
  /\bfile[s]?\s+(?:changed|edited|created|modified|updated|written)\b/i,
  /\b(?:wrote|created|modified|edited|deleted)\s+\S+\.\w+/i,
  /\bcommit\b/i,
  /\bdiff\b/i,
  /\banalyz(?:ed|ing)\b/i,
  /\bfound\s+(?:the|a|an|that)\b/i,
  /\bchecked\s+(?:the|all|for)\b/i,
  /\btested\b/i,
  /\bverified\b/i,
  /\brevie(?:wed|wing)\b/i,
  /\binvestigat(?:ed|ing)\b/i,
  /\bread\s+\d+\s+file/i,
  /\bsearch(?:ed|ing)\s+(?:for|through|across)\b/i,
  /\[PROGRESS\]/i,
]

export function hasProgress(message: EnsembleMessage): boolean {
  if (message.type === 'result') return true
  return PROGRESS_PATTERNS.some(p => p.test(message.content))
}

function getPairKey(a: string, b: string): string {
  return [a, b].sort().join(':')
}

interface AgentWatchdogDeps {
  loadTeams: () => EnsembleTeam[]
  getMessages: (teamId: string) => EnsembleMessage[]
  appendMessage: (teamId: string, message: EnsembleMessage) => void
  disbandTeam?: (teamId: string, reason: string) => Promise<void>
  getRuntime: () => Pick<AgentRuntime, 'sendKeys' | 'pasteFromFile'>
  resolveAgentProgram: (program: string) => { inputMethod: 'pasteFromFile' | 'sendKeys' }
  isSelf: (hostId?: string) => boolean
  getHostById: (hostId: string) => { url: string } | undefined
  postRemoteSessionCommand: (url: string, sessionName: string, text: string) => Promise<void>
  collabDeliveryFile: (teamId: string, sessionName: string) => string
  now?: () => number
  nudgeAfterMs?: number
  stallAfterMs?: number
  pollIntervalMs?: number
  loopWarnThreshold?: number
  loopDisbandThreshold?: number
}

function parseDuration(rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getWatchdogNudgeMs(): number {
  return parseDuration(process.env.ENSEMBLE_WATCHDOG_NUDGE_MS, DEFAULT_NUDGE_MS)
}

export function getWatchdogStallMs(): number {
  return parseDuration(process.env.ENSEMBLE_WATCHDOG_STALL_MS, DEFAULT_STALL_MS)
}

export class AgentWatchdog {
  private readonly state = new Map<string, AgentWatchdogState>()
  private readonly loopState = new Map<string, LoopState>()
  private readonly timer: NodeJS.Timeout
  private readonly now: () => number
  private readonly nudgeAfterMs: number
  private readonly stallAfterMs: number
  private readonly loopWarnThreshold: number
  private readonly loopDisbandThreshold: number

  constructor(private readonly deps: AgentWatchdogDeps) {
    this.now = deps.now ?? Date.now
    this.nudgeAfterMs = deps.nudgeAfterMs ?? getWatchdogNudgeMs()
    this.stallAfterMs = deps.stallAfterMs ?? getWatchdogStallMs()
    this.loopWarnThreshold = deps.loopWarnThreshold ?? LOOP_WARN_THRESHOLD
    this.loopDisbandThreshold = deps.loopDisbandThreshold ?? LOOP_DISBAND_THRESHOLD

    this.timer = setInterval(() => {
      void this.poll()
    }, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.timer.unref()
  }

  async poll(): Promise<void> {
    const activeTeams = this.deps.loadTeams().filter(team => team.status === 'active')
    const activeTeamIds = new Set(activeTeams.map(team => team.id))

    for (const key of this.state.keys()) {
      const teamId = key.split(':', 1)[0]
      if (!activeTeamIds.has(teamId)) this.state.delete(key)
    }

    for (const key of this.loopState.keys()) {
      if (!activeTeamIds.has(key)) this.loopState.delete(key)
    }

    for (const team of activeTeams) {
      await this.checkCommunicationLoop(team)
      await this.pollTeam(team)
    }
  }

  stop(): void {
    clearInterval(this.timer)
    this.state.clear()
    this.loopState.clear()
  }

  private async checkCommunicationLoop(team: EnsembleTeam): Promise<void> {
    const messages = this.deps.getMessages(team.id)
    const agentMessages = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
    const ls = this.loopState.get(team.id) ?? { pairs: new Map(), lastCheckedIndex: 0 }

    let lastSender: string | undefined
    for (let i = ls.lastCheckedIndex; i < agentMessages.length; i++) {
      const msg = agentMessages[i]
      if (hasProgress(msg)) {
        for (const pair of ls.pairs.values()) {
          pair.count = 0
          pair.warned = false
        }
        lastSender = undefined
        continue
      }
      if (msg.from !== lastSender && lastSender) {
        const pairKey = getPairKey(lastSender, msg.from)
        const pair = ls.pairs.get(pairKey) ?? { count: 0, warned: false }
        pair.count++
        ls.pairs.set(pairKey, pair)
      }
      lastSender = msg.from
    }

    ls.lastCheckedIndex = agentMessages.length
    this.loopState.set(team.id, ls)

    for (const [pairKey, pair] of ls.pairs) {
      if (pair.count >= this.loopDisbandThreshold) {
        const agents = pairKey.split(':')
        console.warn(`[Watchdog] Communication loop detected in team ${team.id} between ${agents.join(' and ')} (${pair.count} exchanges without progress)`)
        this.deps.appendMessage(team.id, {
          id: uuidv4(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: `🛑 Force-disband: communication loop detected (${agents.join(' ↔ ')}: ${pair.count} exchanges without code changes or results)`,
          type: 'chat',
          timestamp: new Date(this.now()).toISOString(),
        })
        if (this.deps.disbandTeam) {
          await this.deps.disbandTeam(team.id, 'communication loop detected')
        }
        return
      }

      if (pair.count >= this.loopWarnThreshold && !pair.warned) {
        pair.warned = true
        const agents = pairKey.split(':')
        this.deps.appendMessage(team.id, {
          id: uuidv4(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: `⚠️ Warning: ${agents.join(' ↔ ')} exchanged ${pair.count} messages without code changes or concrete results. Focus on producing artifacts, not discussion.`,
          type: 'chat',
          timestamp: new Date(this.now()).toISOString(),
        })
      }
    }
  }

  private async pollTeam(team: EnsembleTeam): Promise<void> {
    const messages = this.deps.getMessages(team.id)
    const activeAgents = team.agents.filter(candidate => candidate.status === 'active')
    const activeAgentNames = new Set(activeAgents.map(agent => agent.name))

    for (const key of this.state.keys()) {
      if (!key.startsWith(`${team.id}:`)) continue
      const agentName = key.slice(team.id.length + 1)
      if (!activeAgentNames.has(agentName)) this.state.delete(key)
    }

    for (const agent of activeAgents) {
      const stateKey = `${team.id}:${agent.name}`
      const lastAgentMessage = [...messages].reverse().find(message => message.from === agent.name)
      const lastMessageAt = lastAgentMessage?.timestamp || team.createdAt
      const previousState = this.state.get(stateKey)

      if (!previousState) {
        this.state.set(stateKey, { lastMessageAt })
      } else if (previousState.lastMessageAt !== lastMessageAt) {
        this.state.set(stateKey, { lastMessageAt })
        continue
      }

      const lastMessageMs = new Date(lastMessageAt).getTime()
      if (Number.isNaN(lastMessageMs)) continue

      const nowMs = this.now()
      const idleMs = nowMs - lastMessageMs
      const currentState = this.state.get(stateKey) ?? { lastMessageAt }

      if (!currentState.nudgedAt && idleMs >= this.nudgeAfterMs) {
        try {
          await this.nudgeAgent(team, agent.name, agent.program, agent.hostId)
          this.state.set(stateKey, {
            lastMessageAt,
            nudgedAt: new Date(nowMs).toISOString(),
          })
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          this.deps.appendMessage(team.id, {
            id: uuidv4(),
            teamId: team.id,
            from: 'ensemble',
            to: 'team',
            content: `❌ Watchdog failed to nudge ${agent.name}: ${reason}`,
            type: 'chat',
            timestamp: new Date(nowMs).toISOString(),
          })
        }
        continue
      }

      if (!currentState.nudgedAt || currentState.stalledAt) continue

      const nudgedMs = new Date(currentState.nudgedAt).getTime()
      if (Number.isNaN(nudgedMs) || nowMs - nudgedMs < this.stallAfterMs) continue

      console.warn(`[Watchdog] Agent ${agent.name} in team ${team.id} stalled after watchdog nudge`)
      this.deps.appendMessage(team.id, {
        id: uuidv4(),
        teamId: team.id,
        from: 'ensemble',
        to: 'team',
        content: `⚠️ Watchdog marked ${agent.name} as stalled after ${Math.round((nowMs - nudgedMs) / 1000)}s without progress after nudge`,
        type: 'chat',
        timestamp: new Date(nowMs).toISOString(),
      })
      this.state.set(stateKey, {
        ...currentState,
        stalledAt: new Date(nowMs).toISOString(),
      })
    }
  }

  private async nudgeAgent(team: EnsembleTeam, agentName: string, _program: string, hostId?: string): Promise<void> {
    const timestamp = new Date(this.now()).toISOString()
    this.deps.appendMessage(team.id, {
      id: uuidv4(),
      teamId: team.id,
      from: 'ensemble',
      to: 'team',
      content: `👀 Watchdog nudged ${agentName}: ${WATCHDOG_NUDGE_TEXT}`,
      type: 'chat',
      timestamp,
    })

    const sessionName = `${team.name}-${agentName}`
    if (hostId && !this.deps.isSelf(hostId)) {
      const host = this.deps.getHostById(hostId)
      if (host) {
        await this.deps.postRemoteSessionCommand(host.url, sessionName, WATCHDOG_NUDGE_TEXT)
      }
      return
    }

    // Always use pasteFromFile to avoid shell escaping issues with sendKeys
    const runtime = this.deps.getRuntime()
    const filePath = this.deps.collabDeliveryFile(team.id, sessionName)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, WATCHDOG_NUDGE_TEXT)
    await runtime.pasteFromFile(sessionName, filePath)
  }
}

export {
  DEFAULT_POLL_INTERVAL_MS, DEFAULT_NUDGE_MS, DEFAULT_STALL_MS, WATCHDOG_NUDGE_TEXT,
  LOOP_WARN_THRESHOLD, LOOP_DISBAND_THRESHOLD,
}
