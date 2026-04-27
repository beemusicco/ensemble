import fs from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import type { AgentRuntime } from './agent-runtime'
import type { EnsembleMessage, EnsembleTeam } from '../types/ensemble'

const DEFAULT_POLL_INTERVAL_MS = 30_000
// Bumped 180s→300s and 420s→900s after observing that real "deep work"
// often exceeds the older 10-minute kill window. Multi-file edits + test
// runs + reading large source files commonly burn 6-12 min between team-say
// messages. The all-stalled disband path multiplies these (nudge + stall),
// so total tolerance is now ~20 minutes. Both still env-tunable; agents
// doing rapid coordination can drop them via ENSEMBLE_WATCHDOG_*_MS.
const DEFAULT_NUDGE_MS = 300_000
const DEFAULT_STALL_MS = 900_000
// Replaced generic "are you working" nudge — the old text rewarded chatter and
// reset idle timers on "Idle." / "Still working." replies. New text forces the
// agent to produce evidence (file list + diff) or emit [DONE]. Pure status
// replies no longer satisfy the nudge.
const WATCHDOG_NUDGE_TEXT = [
  'If you still have open work, reply with [PROGRESS] listing files you touched since your last message and a one-line diff summary.',
  'If the task is finished, reply with [DONE] plus an artifacts: list of absolute file paths and a verify: command.',
  'Otherwise, stay silent — acknowledgement loops are killed automatically.',
].join(' ')

// Lowered thresholds: real idle loops (trace 7dc68c69) peaked at ~11 exchanges
// before manual kill. WARN=6 fires early as a soft prod, DISBAND=8 force-closes
// the loop well before it wastes 45 min of nudge cadence.
const LOOP_WARN_THRESHOLD = 6
const LOOP_DISBAND_THRESHOLD = 8

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

// FM17 fix: added Slovenian / Dutch progress verbs so non-English collabs
// don't silently increment the loop counter during productive work.
// Also added concrete-evidence patterns (file paths, line counts, md5)
// because those are unambiguous progress signals regardless of language.
const PROGRESS_PATTERNS = [
  // English
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
  /\bimplement(?:ed|ing)\b/i,
  /\bship(?:ped|ping)\b/i,
  // Slovenian
  /\bnapisal\b/i,
  /\bpregled(?:al|ujem)\b/i,
  /\bpopravil\b/i,
  /\bimplementiral\b/i,
  /\bustvaril\b/i,
  /\btestiral\b/i,
  /\bpreveril\b/i,
  /\bposkusil\b/i,
  /\bidentificiral\b/i,
  /\bdodal\b/i,
  /\b(?:spremenil|spremenila|spremenili)\b/i,
  /\bnašel\b/i,
  // Dutch
  /\bgeschreven\b/i,
  /\bgetest\b/i,
  /\bgevonden\b/i,
  /\baangepast\b/i,
  // Concrete evidence (language-agnostic)
  /[/~]\S+\.(?:ts|js|jsx|tsx|py|sh|md|json|sql|yaml|yml)\b/,  // file path
  /\b\d{2,}\s+lines?\b/i,                                     // line count
  /\bmd5=[a-f0-9]{8,}\b/i,                                    // hash
  /\b\d+\s+file[s]?\s+chang(?:ed|es)\b/i,                     // git stat
  /\[PROGRESS\]/i,
  /\[FINDING\]/i,
  // Real-world progress phrases agents use while coordinating — previously
  // missed because they don't use a past-tense verb. Triangular-chatter
  // detection mis-fired on "patch is in / tests next / ready for gate"
  // messages during the 2026-04-24 company-ops collabs.
  /\bpatch\s+(?:is\s+in|in|applied|landed|ready)\b/i,
  /\bready\s+for\s+(?:gate|review|test|verify|local\s+gate)\b/i,
  /\bready\s+to\s+(?:gate|verify|test|review|ship)\b/i,
  /\b(?:still\s+)?cod(?:ing|ed)\b/i,
  /\bin\s+progress\b/i,
  /\bworking\s+on\b/i,
  /\bon\s+it\b/i,
  /\bwip\b/i,
  /\bitem\s+\d+\s+(?:done|complete|ready|in|patched|landed)\b/i,
  /\bgate\s+(?:pass|passes|passed|passing|next|now)\b/i,
  /\b(?:starting|started)\s+(?:item|phase|work)\b/i,
  // Round 2 coordination patterns (2026-04-27 LIBRO NAV team killed at 2.6min
  // mid-implementation — codex-3 was emitting "[WRITING X] Starting scoped
  // patch now" + "I'm patching exactly that audit surface" but neither phrase
  // matched the previous regex set). Add bracketed action tags + present-
  // continuous verbs that real implementers use during coordination.
  /\[(?:WRITING|EDITING|PATCHING|CODING|IMPLEMENTING|FIXING|SHIPPING|REFACTORING|WIRING)\b/i,
  /\b(?:patching|editing|wiring|refactoring|shipping|implementing|fixing)\b/i,
  /\bscoped\s+patch\b/i,
  /\bstart(?:ing|ed)?\s+(?:the\s+|a\s+|scoped\s+)?patch\b/i,
  /\b(?:writing|drafting|building)\s+\w/i,
  // Research / inspection phrases — when an agent says "opened X / Y / Z" they
  // are reporting concrete external sources just inspected. That counts as
  // progress in the same way "checked" / "read" do.
  /\bopened\s+\w/i,
  /\b(?:fetching|fetched|inspecting|inspected|loaded|loading)\s+\w/i,
]

// Fix 6: parse class tag from message content [PLAN]/[FINDING]/etc.
export function parseMessageClass(content: string): string | undefined {
  const m = content.match(/^\s*\[(PLAN|FINDING|BLOCKER|REVIEW|PROGRESS|DONE)\]/i)
  return m ? m[1].toUpperCase() : undefined
}

export function hasProgress(message: EnsembleMessage): boolean {
  if (message.type === 'result') return true
  // Fix 5/6: explicit [PROGRESS]/[FINDING]/[PLAN]/[REVIEW] tags always count.
  // [DONE] is terminal and also resets counters.
  const cls = parseMessageClass(message.content)
  if (cls && cls !== 'BLOCKER') return true
  // Explicit filler — never counts as progress.
  if (/^\s*\[(ACK|IDLE|STATUS)\]/i.test(message.content)) return false
  return PROGRESS_PATTERNS.some(p => p.test(message.content))
}

// Fix 5: semantic idle — same normalized content repeated N times = stuck.
// Normalizes by lowercasing, stripping whitespace, and removing the class tag
// so "[ACK] Idle." and "Idle." hash the same.
function normalizeForSemanticHash(content: string): string {
  return content
    .replace(/^\s*\[[A-Z_]+\]\s*/i, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}

/**
 * Polite-ack phrase detector — catches the "I'm standing by / ready to help /
 * awaiting instructions" family of messages that previously escaped the
 * repeat-based idle detector because each turn was worded slightly differently.
 */
export function isPoliteAckPhrase(content: string): boolean {
  const norm = normalizeForSemanticHash(content)
  if (norm.length === 0 || norm.length > 180) return false
  const ACK_PATTERNS = [
    // English
    /\bidle\b/,
    /\back(nowledge(d)?|nowledging)\b/,
    /\bstanding\s+by\b/,
    /\bready\s+(to\s+(assist|help|begin|start|work|continue)|when\s+you|for\s+(next|your|instructions))/,
    /\bawaiting\s+(instructions|input|guidance|your|the|next|further)/,
    /\blet\s+me\s+know\s+(how|if|when|what)/,
    /\bhow\s+can\s+i\s+(help|assist|support)/,
    /\bwaiting\s+(for|on)\s+(your|further|next)/,
    /\bon\s+standby\b/,
    /\bno\s+(new|further)\s+(update|action|finding)/,
    /\b(still|just)\s+(monitoring|observing|watching)/,
    /^(ok|okay|got it|understood|noted|roger|will do|sure|alright)[.!]?$/i,
    // Slovenian — only whole-message / sentence-final forms so productive
    // in-line acknowledgements ("razumem, grem dalje...") are not counted.
    /^zaključeno[.!]?$/,
    /\bpripravljen(a)?\s+(sem|da)\s+(pomag|nadaljuj|začn)/,
    /\bčakam\s+(na\s+)?(navodila|nasledn|vaš|dodatn)/,
    /^na\s+voljo\s+(sem|za)/,
    /\bsvoje\s+naloge\s+(sem\s+)?zaključil/,
    /^v\s+mirovanju[.!]?$/,
    /^razumem[.!]?$/,
    /\bbrez\s+(novih|nadaljnjih)\s+(opazk|ugotov|spremem)/,
  ]
  return ACK_PATTERNS.some(p => p.test(norm))
}

export function isSemanticIdle(recent: EnsembleMessage[], minRepeats = 3): boolean {
  if (recent.length < minRepeats) return false

  // Signal 1: same message repeated N times (legacy)
  const last = normalizeForSemanticHash(recent[recent.length - 1].content)
  if (last.length >= 3) {
    let repeats = 1
    for (let i = recent.length - 2; i >= 0 && repeats < minRepeats; i--) {
      if (normalizeForSemanticHash(recent[i].content) === last) repeats++
      else break
    }
    if (repeats >= minRepeats) return true
  }

  // Signal 2: N of last M messages are polite-acks even if worded differently.
  const window = recent.slice(-Math.max(minRepeats + 1, 4))
  const ackCount = window.filter(m => isPoliteAckPhrase(m.content)).length
  if (ackCount >= minRepeats) return true

  return false
}

function getPairKey(a: string, b: string): string {
  return [a, b].sort().join(':')
}

interface AgentWatchdogDeps {
  loadTeams: () => EnsembleTeam[]
  getMessages: (teamId: string) => EnsembleMessage[]
  appendMessage: (teamId: string, message: EnsembleMessage) => void
  disbandTeam?: (teamId: string, reason: string) => Promise<void>
  getRuntime: () => Pick<AgentRuntime, 'sendKeys' | 'pasteFromFile' | 'capturePane'>
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

    // FM19 fix: progress in one A↔B exchange no longer resets B↔C's counter.
    // We only reset the pair(s) that include the sender of the progress message,
    // so a pathological loop between two agents isn't hidden by productive
    // work from a third agent in the same team.
    let lastSender: string | undefined
    for (let i = ls.lastCheckedIndex; i < agentMessages.length; i++) {
      const msg = agentMessages[i]
      if (hasProgress(msg)) {
        for (const [pairKey, pair] of ls.pairs) {
          if (pairKey.split(':').includes(msg.from)) {
            pair.count = 0
            pair.warned = false
          }
        }
        lastSender = msg.from
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

    // D2: triangular chatter detection — if last N agent msgs cycle through 3+
    // distinct senders with no progress, force-disband. Catches A→B→C→A loops.
    // Window scales with agent count (FIX 3):
    //   - Triple (3 agents) gets 18 → 6 rounds per agent
    //   - Premium-quad (4 agents) gets 18 → 4.5 rounds per agent
    //   - 5-agent custom team gets 20 → 4 rounds per agent
    //   - 6-agent gets 24 → 4 rounds, etc.
    // Math: max(18, 4 * activeAgents). Each agent gets at least 4 rounds of
    // grace, never less than the previous flat-18 default.
    // Env override `ENSEMBLE_TRIANGULAR_WINDOW` still wins absolutely.
    const envWindow = parseInt(process.env['ENSEMBLE_TRIANGULAR_WINDOW'] ?? '', 10)
    const TRIANGULAR_WINDOW = Number.isFinite(envWindow) && envWindow > 0
      ? Math.max(6, envWindow)
      : Math.max(18, 4 * team.agents.filter(a => a.status === 'active').length)
    if (agentMessages.length >= TRIANGULAR_WINDOW) {
      const tail = agentMessages.slice(-TRIANGULAR_WINDOW)
      const uniqueSenders = new Set(tail.map(m => m.from))
      const anyProgress = tail.some(m => hasProgress(m))
      if (uniqueSenders.size >= 3 && !anyProgress) {
        console.warn(`[Watchdog] Triangular chatter: ${TRIANGULAR_WINDOW} msgs from ${uniqueSenders.size} senders, no progress in team ${team.id}`)
        this.deps.appendMessage(team.id, {
          id: uuidv4(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: `🛑 Force-disband: triangular chatter detected (${uniqueSenders.size} senders, ${TRIANGULAR_WINDOW} msgs without progress)`,
          type: 'chat',
          timestamp: new Date(this.now()).toISOString(),
        })
        if (this.deps.disbandTeam) {
          await this.deps.disbandTeam(team.id, 'triangular chatter')
        }
        return
      }
    }

    // Fix 5: semantic-idle check — if last 3 agent messages are identical
    // (after normalization), force-close regardless of pair count.
    const lastThreePerAgent = new Map<string, EnsembleMessage[]>()
    for (let i = agentMessages.length - 1; i >= 0 && lastThreePerAgent.size < team.agents.length; i--) {
      const m = agentMessages[i]
      const arr = lastThreePerAgent.get(m.from) ?? []
      if (arr.length < 3) arr.push(m)
      lastThreePerAgent.set(m.from, arr)
    }
    for (const [agentName, msgs] of lastThreePerAgent) {
      if (isSemanticIdle(msgs.slice().reverse(), 3)) {
        console.warn(`[Watchdog] Semantic idle detected in team ${team.id}: ${agentName} repeated same content 3+ times`)
        this.deps.appendMessage(team.id, {
          id: uuidv4(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: `🛑 Force-disband: semantic-idle loop (${agentName} repeated identical content 3+ times). ${msgs[0]?.content?.slice(0, 80) ?? ''}`,
          type: 'chat',
          timestamp: new Date(this.now()).toISOString(),
        })
        if (this.deps.disbandTeam) {
          await this.deps.disbandTeam(team.id, 'semantic-idle loop')
        }
        return
      }
    }

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

    // If EVERY active agent is now stalled, the team is effectively dead — the
    // idle-checker won't notice because it looks at last message from ANY
    // non-ensemble sender, which could be the stall notice itself. The docs
    // promise "no message in stall window → disband"; this delivers it.
    if (activeAgents.length > 0 && this.deps.disbandTeam) {
      const allStalled = activeAgents.every(agent => {
        const s = this.state.get(`${team.id}:${agent.name}`)
        return Boolean(s?.stalledAt)
      })
      if (allStalled) {
        // FIX 4: live-bash check. Before pulling the trigger on a team
        // marked all-stalled, capture each agent's tmux pane and look for
        // signs of a long-running command (no idle prompt, output flowing).
        // Real long tests (>20 min) and large-file edits both produce this
        // signature: the readyMarker is absent and there's recent stdout.
        // If ANY agent shows live work, defer the disband — agents will
        // emit team-say once the command completes.
        const anyLiveBash = await this.anyAgentRunningLongCommand(team)
        if (anyLiveBash) {
          console.log(`[Watchdog] All-stalled disband DEFERRED for team ${team.id} — at least one agent has live shell output (long-running command in flight)`)
          this.deps.appendMessage(team.id, {
            id: uuidv4(),
            teamId: team.id,
            from: 'ensemble',
            to: 'team',
            content: `⏳ All-stalled disband deferred — at least one agent has a long-running command in flight. Waiting for it to finish.`,
            type: 'chat',
            timestamp: new Date(this.now()).toISOString(),
          })
          return
        }
        console.warn(`[Watchdog] All ${activeAgents.length} agents stalled in team ${team.id} — force-disbanding`)
        this.deps.appendMessage(team.id, {
          id: uuidv4(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: `🛑 Force-disband: all agents stalled past nudge window (no progress after ${Math.round(this.stallAfterMs / 1000)}s post-nudge)`,
          type: 'chat',
          timestamp: new Date(this.now()).toISOString(),
        })
        await this.deps.disbandTeam(team.id, 'all agents stalled')
      }
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

  /**
   * FIX 4: detect agents running long-lived shell commands so we can defer
   * the all-stalled disband. A capture-pane snapshot of the bottom of each
   * agent's tmux session shows either:
   *   - the CLI's idle prompt (❯ for Claude/Sonnet/Haiku, › for Codex) in
   *     the last few lines → agent is waiting for input → really stalled
   *   - active stdout from a running command (no prompt visible, recent
   *     terminal output) → agent IS working, just busy
   * If any agent shows the busy signature, defer the disband.
   *
   * Heuristic, not perfect — but the alternative is killing collabs that
   * are running a 25-min test suite or large worktree merge.
   */
  private async anyAgentRunningLongCommand(team: EnsembleTeam): Promise<boolean> {
    const runtime = this.deps.getRuntime()
    if (!runtime.capturePane) return false
    const activeAgents = team.agents.filter(a => a.status === 'active')
    for (const agent of activeAgents) {
      // Remote agents — we can't introspect their pane. Default-defer is too
      // permissive (would never disband remote teams), so default to "not
      // busy" for remote and let the local-only check decide.
      if (agent.hostId && !this.deps.isSelf(agent.hostId)) continue
      try {
        const sessionName = `${team.name}-${agent.name}`
        const tail = await runtime.capturePane(sessionName, 8)
        // Idle markers per supported program; scan the LAST non-empty line so
        // banners/headers in the upper viewport don't mask a busy bottom row.
        const lines = tail.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0)
        const lastLines = lines.slice(-4).join('\n')
        const idle = /[❯›>](?:\s|$)|\$ ?$|# ?$/.test(lastLines)
        if (!idle) return true   // not at idle prompt → command running
      } catch { /* capture failed → assume idle, fall through */ }
    }
    return false
  }
}

export {
  DEFAULT_POLL_INTERVAL_MS, DEFAULT_NUDGE_MS, DEFAULT_STALL_MS, WATCHDOG_NUDGE_TEXT,
  LOOP_WARN_THRESHOLD, LOOP_DISBAND_THRESHOLD,
}
