/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local/remote agent lifecycle.
 */

import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, CollabTemplatesFile } from '../types/ensemble'
import {
  createTeam, getTeam, updateTeam, loadTeams, loadAllTeamsIncludingArchives,
  appendMessage, getMessages, getActiveTeamsByWorkingDir,
} from '../lib/ensemble-registry'
import {
  spawnLocalAgent, killLocalAgent,
  spawnRemoteAgent as spawnRemote, killRemoteAgent,
  postRemoteSessionCommand, isRemoteSessionReady,
  getAgentTokenUsage,
} from '../lib/agent-spawner'
import { isSelf, getHostById, getSelfHostId } from '../lib/hosts-config'
import { getRuntime } from '../lib/agent-runtime'
import { resolveAgentProgram } from '../lib/agent-config'
import { AgentWatchdog } from '../lib/agent-watchdog'
import {
  collabPromptFile, collabDeliveryFile, collabSummaryFile,
  collabRuntimeDir, collabFinishedMarker, collabBridgePosted,
  collabBridgeResult, ensureCollabDirs, collabMessagesFile,
} from '../lib/collab-paths'
import { queryMemories, writeMemory } from '../lib/memory-store'
import { appendCostEntry } from '../lib/cost-ledger'
import { startSpan, endSpan } from '../lib/tracer'
import { analyzeThinking, pruneAlreadyWarned, getCurrentPhase } from '../lib/thinking-phases'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn, exec, execFile } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)
import { createWorktree, mergeWorktree, destroyWorktree, type WorktreeInfo } from '../lib/worktree-manager'
import { runStagedWorkflow } from '../lib/staged-workflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

const IDLE_CHECK_INTERVAL_MS = 15_000
const COMPLETION_SIGNAL_WINDOW_MS = 60_000
const MIN_MESSAGES_BEFORE_AUTO_DISBAND = 10

function parseEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Primary completion path is now the explicit signal-complete endpoint
// (scripts/team-done.sh). These pattern-based thresholds are safety nets
// for runaway sessions and legacy integrations — generous by design.
//
// Bumped after observing premature kills on real deep-work runs:
// - SINGLE_SIGNAL 180s→600s: claude-1 emitting [VERIFY_DONE] for its part while
//   codex spends 4-6 min on a multi-file edit was killing live teams. team-done
//   is the trusted disband path; this safety net just needs to outlast a long
//   single message-cycle.
// - LOW_CONF 900s→1800s: word-boundary "done" / "complete" / "klaar" matches
//   embedded in long messages were tripping after 15 min of real work. Combined
//   with the new tail-position guard in getCompletionConfidence(), 30 min is
//   the right ceiling for a true sign-off-without-team-done escape hatch.
const SINGLE_SIGNAL_IDLE_THRESHOLD_MS = parseEnvMs('ENSEMBLE_SINGLE_SIGNAL_IDLE_MS', 600_000)
const LOW_CONFIDENCE_IDLE_THRESHOLD_MS = parseEnvMs('ENSEMBLE_LOW_CONF_IDLE_MS', 1_800_000)

// Max team lifetime — defensive cap. Some teams agree to "stand by silently"
// instead of calling team-done.sh, leaving the registry pinned to 'active'
// indefinitely and the user's Claude Code window blocked on the .finished
// watcher. After this window the team is force-disbanded with a clear
// reason. Default 90 min; set to 0 to disable. Observed in team 69db6548
// where claude-1+codex-2 explicitly declared "team stays alive for human
// cherry-pick" and went silent.
const MAX_TEAM_LIFETIME_MS = parseEnvMs('ENSEMBLE_MAX_TEAM_LIFETIME_MS', 90 * 60 * 1000)
// Patterns that signal "we're not going to call team-done" — short-circuits
// the lifetime check earlier when matched (e.g. 30 min instead of 90).
const STANDING_BY_PATTERNS = [
  /\bstand(?:s|ing)?\s+by\s+silently\b/i,
  /\bteam\s+stays\s+alive\b/i,
  /\b(?:will\s+not|won['’]t|do\s+not)\s+call\s+team[- ]?done\b/i,
  /\bgoing\s+silent\b/i,
  /\bclosing\s+loop,\s*going\s+silent\b/i,
]
const STANDING_BY_IDLE_MS = parseEnvMs('ENSEMBLE_STANDING_BY_IDLE_MS', 30 * 60 * 1000)

// FIX 1: bracket tag must occupy a message edge to count as a sign-off. The
// start anchor only allows whitespace before the tag (so "[DONE]" or "  [DONE]
// my part" matches, but "as instructed emit [DONE] when ready" does not). The
// end anchor only allows whitespace + optional terminal punctuation after the
// tag (so "Cross-check ok [VERIFY_DONE]" or "wrapped [EXEC_DONE]." matches,
// but "emit [DONE] when ready" does not). Together these reject bracket tags
// that an agent quotes from its own role spec without actually sign-off.
const HIGH_CONFIDENCE_AT_START = [
  /^\s*\[DONE\]/i,
  /^\s*\[COMPLETE\]/i,
  /^\s*\[FINISHED\]/i,
  /^\s*\[EXEC_DONE\]/i,
  /^\s*\[VERIFY_DONE\]/i,
]
const HIGH_CONFIDENCE_AT_END = [
  /\[DONE\]\s*[.!,:]?\s*$/i,
  /\[COMPLETE\]\s*[.!,:]?\s*$/i,
  /\[FINISHED\]\s*[.!,:]?\s*$/i,
  /\[EXEC_DONE\]\s*[.!,:]?\s*$/i,
  /\[VERIFY_DONE\]\s*[.!,:]?\s*$/i,
]
// Combined for legacy callers / tests that want a generic bracket presence.
const HIGH_CONFIDENCE_COMPLETION = [
  /\[DONE\]/i,
  /\[COMPLETE\]/i,
  /\[FINISHED\]/i,
  /\[EXEC_DONE\]/i,
  /\[VERIFY_DONE\]/i,
]

const LOW_CONFIDENCE_COMPLETION = [
  /(?:^|[^\p{L}\p{N}_])afgerond(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])\bdone\b(?![.\w])/iu,
  // "completed" but not ".completed" (method/property access) or "completion"
  /(?<!\.)(?:^|[^\p{L}\p{N}_])completed(?:[^\p{L}\p{N}_]|$)/iu,
  // "klaar" but not "klaar sta", "klaar ben", "klaar om", "klaar voor"
  /(?:^|[^\p{L}\p{N}_])klaar(?!\s+(?:sta|ben|om|voor|zodra))(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|\s)tot de volgende(?:\s|$)/i,
]

interface CompletionSignal {
  agentName: string
  timestamp: number
  confidence: 'high' | 'low'
}
// Telegram notifications: set both env vars to enable, omit to disable
const TELEGRAM_BOT_TOKEN = process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_CHAT_ID = process.env.ENSEMBLE_TELEGRAM_CHAT_ID || ''

class EnsembleService {
  private readonly disbandingTeams = new Set<string>()
  private readonly idleCheckTimer: NodeJS.Timeout
  private readonly watchdog: AgentWatchdog

  constructor() {
    // Boot-time cleanup of teams left in 'forming' / 'spawning' state by a
    // server crash or restart mid-spawn. Without this, the registry
    // accumulates zombies that can't be resumed but still block resume-
    // detection / scope-large auto-worktrees on the same cwd.
    void this.cleanupOrphanedSpawns()

    this.idleCheckTimer = setInterval(() => {
      void this.checkIdleTeams()
    }, IDLE_CHECK_INTERVAL_MS)
    this.idleCheckTimer.unref()
    this.watchdog = new AgentWatchdog({
      loadTeams,
      getMessages: (teamId: string) => getMessages(teamId),
      appendMessage,
      disbandTeam: async (teamId: string, reason: string) => {
        if (this.disbandingTeams.has(teamId)) return
        this.disbandingTeams.add(teamId)
        try {
          await disbandTeam(teamId, `watchdog: ${reason}`, { triggeredBy: 'watchdog' })
        } finally {
          this.disbandingTeams.delete(teamId)
        }
      },
      getRuntime,
      resolveAgentProgram,
      isSelf: (hostId?: string) => isSelf(hostId || ''),
      getHostById,
      postRemoteSessionCommand,
      collabDeliveryFile,
    })

    for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit', 'exit'] as const) {
      process.once(signal, () => this.stop())
    }
  }

  async checkIdleTeams(): Promise<void> {
    const teams = loadTeams().filter(team => team.status === 'active')

    for (const team of teams) {
      // Thinking-mode supervisor runs on every idle tick, independent of
      // disband logic. Each emitted warning is a team-visible message so
      // agents see the same feedback a human reviewer would give.
      this.runThinkingSupervisor(team.id)

      // FIX 2: detect agent CLI crashes mid-flight (UserPromptSubmit hook
      // ENOENT, OOM, manual Ctrl-C). When pane_current_command reports a
      // shell instead of the agent's CLI, the agent process is dead and
      // the team is operating short-handed. Mark the agent as 'failed'
      // so monitor + stats show it correctly, post a structured warning
      // to the team feed.
      await this.detectCrashedAgents(team)

      if (this.disbandingTeams.has(team.id)) continue

      // Hard timeout / standing-by detection — runs BEFORE shouldAutoDisband
      // so it kicks in even when no completion signal exists.
      const lifetimeReason = this.lifetimeOrStandingByReason(team)
      if (lifetimeReason) {
        this.disbandingTeams.add(team.id)
        try {
          await disbandTeam(team.id, lifetimeReason.reason, {
            triggeredBy: 'lifetime-cap',
            ageMs: lifetimeReason.ageMs,
            idleMs: lifetimeReason.idleMs,
            standingByMatch: lifetimeReason.standingByMatch,
          })
        } catch (err) {
          console.error(`[Ensemble] Lifetime-cap disband failed for ${team.id}:`, err)
        } finally {
          this.disbandingTeams.delete(team.id)
        }
        continue
      }

      if (!this.shouldAutoDisband(team)) continue

      this.disbandingTeams.add(team.id)

      try {
        await disbandTeam(team.id, 'idle-tax: completion signal + idle threshold', {
          triggeredBy: 'idle-checker',
        })
      } catch (err) {
        console.error(`[Ensemble] Auto-disband failed for ${team.id}:`, err)
      } finally {
        this.disbandingTeams.delete(team.id)
      }
    }
  }

  /**
   * FIX 1: hard lifetime cap + standing-by-silently detection.
   * Returns null if team is fine, or a structured reason if it should be
   * disbanded.
   *
   * Two trigger paths:
   *   - Lifetime: team age exceeds MAX_TEAM_LIFETIME_MS. Defensive cap to
   *     prevent indefinite zombie 'active' teams when agents never call
   *     team-done.sh.
   *   - Standing-by: any of last 5 agent messages explicitly says "team
   *     stays alive" / "going silent" / "will not call team-done" AND the
   *     team has been idle > STANDING_BY_IDLE_MS. This is a direct signal
   *     from agents that they've decided to wait indefinitely; we honor it
   *     for the configured idle window then disband with a clear reason
   *     so the operator's Claude Code window unblocks.
   */
  private lifetimeOrStandingByReason(team: EnsembleTeam): null | {
    reason: string; ageMs: number; idleMs: number; standingByMatch?: string
  } {
    const now = Date.now()
    const createdAt = new Date(team.createdAt).getTime()
    if (!Number.isFinite(createdAt)) return null
    const ageMs = now - createdAt

    if (MAX_TEAM_LIFETIME_MS > 0 && ageMs > MAX_TEAM_LIFETIME_MS) {
      return {
        reason: `lifetime-cap: team age ${Math.round(ageMs / 60_000)}min exceeded ${Math.round(MAX_TEAM_LIFETIME_MS / 60_000)}min cap`,
        ageMs,
        idleMs: 0,
      }
    }

    // Standing-by: scan last 5 non-ensemble messages for explicit "wait" pattern
    const messages = getMessages(team.id)
    const agentMsgs = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
    if (agentMsgs.length === 0) return null
    const lastAgentMsg = agentMsgs[agentMsgs.length - 1]
    const lastTs = lastAgentMsg.timestamp ? new Date(lastAgentMsg.timestamp).getTime() : 0
    const idleMs = lastTs ? now - lastTs : 0

    if (idleMs > STANDING_BY_IDLE_MS) {
      const recent = agentMsgs.slice(-5)
      for (const m of recent) {
        for (const pattern of STANDING_BY_PATTERNS) {
          const match = (m.content || '').match(pattern)
          if (match) {
            return {
              reason: `standing-by: agents declared "${match[0]}" + ${Math.round(idleMs / 60_000)}min idle`,
              ageMs,
              idleMs,
              standingByMatch: match[0],
            }
          }
        }
      }
    }
    return null
  }

  // Track which agents we've already flagged as crashed so we don't spam
  // the team feed every 15s tick.
  private readonly crashedAgentMarkers = new Set<string>()

  private async detectCrashedAgents(team: EnsembleTeam): Promise<void> {
    const runtime = getRuntime()
    if (!runtime.paneCurrentCommand) return
    const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh'])
    const activeAgents = team.agents.filter(a => a.status === 'active')
    for (const agent of activeAgents) {
      // Remote agents can't be introspected from the local host; skip.
      if (agent.hostId && !isSelf(agent.hostId)) continue
      const markerKey = `${team.id}:${agent.name}`
      if (this.crashedAgentMarkers.has(markerKey)) continue
      try {
        const sessionName = `${team.name}-${agent.name}`
        const cmd = (await runtime.paneCurrentCommand(sessionName))
          .toLowerCase()
          .replace(/\.exe$/, '')
        if (cmd && SHELLS.has(cmd)) {
          // CLI exited; pane fell back to parent shell. Mark + warn once.
          this.crashedAgentMarkers.add(markerKey)
          updateTeam(team.id, {
            agents: team.agents.map(a => a.name === agent.name ? { ...a, status: 'failed' } : a),
          })
          appendMessage(team.id, {
            id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
            content: `💀 ${agent.name} crashed — pane shows parent shell (${cmd}). The agent CLI exited (UserPromptSubmit hook error, OOM, or manual kill). Team continues with the other ${activeAgents.length - 1} agent(s); manual respawn needed if work depends on this role.`,
            type: 'chat', timestamp: new Date().toISOString(),
            meta: { event: 'agent_crashed', agent: agent.name, foreground: cmd },
          })
          console.warn(`[Ensemble] Agent crashed: team=${team.id.slice(0, 8)} agent=${agent.name} foreground=${cmd}`)
        }
      } catch { /* introspection failed — try next tick */ }
    }
  }

  private shouldAutoDisband(team: EnsembleTeam): boolean {
    const messages = getMessages(team.id)
    const nonEnsembleMessages = messages.filter(message => message.from !== 'ensemble')
    const lastMessage = nonEnsembleMessages[nonEnsembleMessages.length - 1]
    if (!lastMessage) return false

    // Don't auto-disband until agents have exchanged enough messages
    if (nonEnsembleMessages.length < MIN_MESSAGES_BEFORE_AUTO_DISBAND) return false

    const lastTimestamp = lastMessage.timestamp
      ? new Date(lastMessage.timestamp).getTime()
      : NaN
    if (Number.isNaN(lastTimestamp)) return false

    const activeAgents = team.agents.filter(agent => agent.status === 'active')
    if (activeAgents.length === 0) return false

    // Bridge-zombie guard: if ensemble-bridge.sh has died but agents are still
    // writing to messages.jsonl, the registry lastTimestamp freezes at the
    // moment the bridge stopped forwarding — which would cause a false
    // auto-disband while agents are actively working. Compare against the
    // on-disk file mtime and take the more-recent one as the real "last
    // activity" signal. If file is newer than registry by >10s, we're in
    // zombie mode — log it and trust the filesystem.
    let effectiveLastTimestamp = lastTimestamp
    try {
      const stat = fs.statSync(collabMessagesFile(team.id))
      const fileMtime = stat.mtimeMs
      if (fileMtime - lastTimestamp > 10_000) {
        console.warn(`[Ensemble] Bridge-zombie detected for team ${team.id}: file mtime ${Math.round((fileMtime - lastTimestamp) / 1000)}s ahead of registry — using file mtime`)
        effectiveLastTimestamp = fileMtime
      }
    } catch { /* file may not exist yet */ }

    const idleForMs = Date.now() - effectiveLastTimestamp
    const activeAgentNames = new Set(activeAgents.map(agent => agent.name))
    const completionSignals = messages
      .filter(message => activeAgentNames.has(message.from) && this.getCompletionConfidence(message.content) !== null)
      .map(message => ({
        agentName: message.from,
        timestamp: message.timestamp ? new Date(message.timestamp).getTime() : NaN,
        confidence: this.getCompletionConfidence(message.content)!,
      }))
      .filter((signal): signal is CompletionSignal => !Number.isNaN(signal.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp)

    const highConfSignals = completionSignals.filter(s => s.confidence === 'high')
    if (this.hasTwoRecentCompletionSignals(highConfSignals)) return true

    // FIX 2: single-signal disband requires majority of active agents to have
    // signaled, not just ANY one. Previously, claude-1 emitting [VERIFY_DONE]
    // for its slice (architecture review) + 10 min idle on the others would
    // disband a 4-agent team while sonnet-2 was still mid-implementation. Now
    // a 4-agent quad needs 2+ distinct agents to have signaled before the idle
    // path kicks in; a 3-agent triple needs 2+; a 2-agent pair still 1 (since
    // ceil(2/2)=1, the existing 2-agent behavior is preserved).
    const signaledAgentNames = new Set(highConfSignals.map(s => s.agentName))
    const requiredSignalers = Math.max(1, Math.ceil(activeAgents.length / 2))
    if (signaledAgentNames.size >= requiredSignalers && idleForMs > SINGLE_SIGNAL_IDLE_THRESHOLD_MS) {
      return true
    }

    if (idleForMs <= LOW_CONFIDENCE_IDLE_THRESHOLD_MS) return false
    return completionSignals.length >= 1
  }

  private getCompletionConfidence(content: string): 'high' | 'low' | null {
    const trimmed = content.trim()
    if (trimmed.length === 0) return null

    // FIX 1: high-conf bracket tags only count as a real sign-off when they
    // occupy a message EDGE — at the very start (only whitespace before) or
    // very end (only whitespace + optional terminal punctuation after) — AND
    // the message is reasonably short (≤300 chars). Real sign-offs:
    //   "[DONE]"                          (start)
    //   "[VERIFY_DONE] approved"          (start)
    //   "Cross-check ok [VERIFY_DONE]"    (end)
    //   "Implementation wrapped [EXEC_DONE]"  (end)
    // False positives (now correctly rejected):
    //   "as instructed I will emit [DONE] when ready"
    //   "Don't emit [DONE] in text; it is no longer auto-detected"
    //   "The instructions say to emit [EXEC_DONE] when the patch lands"
    if (trimmed.length <= 300) {
      const matchesEdge =
        HIGH_CONFIDENCE_AT_START.some(p => p.test(trimmed)) ||
        HIGH_CONFIDENCE_AT_END.some(p => p.test(trimmed))
      if (matchesEdge) return 'high'
    }
    // Anything longer than 300 chars OR with the tag buried mid-prose is
    // treated as discussion, not a sign-off.
    if (HIGH_CONFIDENCE_COMPLETION.some(p => p.test(trimmed))) {
      // Buried — explicitly drop to null (not low) so it doesn't accidentally
      // match low-conf patterns and creep back into idle-tax disband.
      return null
    }

    // Low-confidence words ("done", "complete", "klaar", "afgerond") are far
    // too common in productive in-flight messages — "almost done with phase 1",
    // "done reading paper_trader.py, now wiring tests" — to be treated as
    // sign-offs. Real wrap-ups are SHORT and END with the keyword. Restrict
    // matching to: trimmed message ≤200 chars AND keyword present in last 80
    // chars. Anything else is conversational.
    if (trimmed.length > 200) return null
    const tail = trimmed.slice(-80)
    if (LOW_CONFIDENCE_COMPLETION.some(p => p.test(tail))) return 'low'
    return null
  }

  private hasTwoRecentCompletionSignals(signals: CompletionSignal[]): boolean {
    for (let i = 0; i < signals.length; i++) {
      for (let j = i + 1; j < signals.length; j++) {
        if (signals[j].timestamp - signals[i].timestamp > COMPLETION_SIGNAL_WINDOW_MS) break
        if (signals[i].agentName !== signals[j].agentName) return true
      }
    }
    return false
  }

  /**
   * Programmatic thinking-mode supervisor. Runs deterministic structural
   * checks over the team's message log and emits supervisor_warning
   * messages into the team feed for anything agents should correct.
   *
   * No LLM call, no token cost. Fires ~once per IDLE_CHECK_INTERVAL tick.
   * Warnings are deduplicated across ticks so we don't spam.
   */
  private runThinkingSupervisor(teamId: string): void {
    try {
      const messages = getMessages(teamId)
      if (getCurrentPhase(messages) === null) return // not thinking mode

      const findings = analyzeThinking(messages)
      const fresh = pruneAlreadyWarned(findings, messages)
      for (const f of fresh) {
        const targetId = String(f.evidence?.hypothesisId ?? f.evidence?.messageId ?? '')
        appendMessage(teamId, {
          id: uuidv4(),
          teamId,
          from: 'ensemble',
          to: 'team',
          content: `🧠 supervisor: ${f.message}`,
          type: 'supervisor_warning',
          timestamp: new Date().toISOString(),
          meta: { code: f.code, target: targetId, severity: f.severity },
        })
      }
    } catch { /* non-fatal — supervisor failures must never break the service */ }
  }

  /**
   * Boot-time cleanup of teams the registry left in 'forming'/'spawning' state.
   * These are produced when the server crashes or is restarted mid-spawn — the
   * createEnsembleTeamInner loop is interrupted, so the team transitions
   * 'forming' → ... → never reaches 'active', and tmux sessions / worktrees
   * may be in a half-built state. Without cleanup the operator sees an
   * undismissable zombie in /api/ensemble/teams and resume-detection flags
   * the cwd as occupied.
   *
   * Heuristic: any team with status 'forming' AND createdAt > 60s ago is
   * orphaned (a healthy spawn finishes inside that window). We disband it
   * with a clear reason so the cause is auditable in the disband log.
   */
  private async cleanupOrphanedSpawns(): Promise<void> {
    try {
      const teams = loadTeams()
      const STALE_FORMING_AGE_MS = 60_000
      const now = Date.now()
      const stuck = teams.filter(t => {
        if (t.status !== 'forming') return false
        const created = new Date(t.createdAt || '').getTime()
        if (!Number.isFinite(created)) return false
        return now - created > STALE_FORMING_AGE_MS
      })
      if (stuck.length === 0) return
      console.warn(`[Ensemble] Found ${stuck.length} orphaned 'forming' team(s) at boot — disbanding`)
      for (const team of stuck) {
        try {
          await disbandTeam(team.id, 'orphaned spawn (server restart mid-spawn)', {
            triggeredBy: 'boot-cleanup',
            createdAt: team.createdAt,
            staleSeconds: Math.round((now - new Date(team.createdAt).getTime()) / 1000),
          })
        } catch (err) {
          console.error(`[Ensemble] Boot cleanup failed for ${team.id}:`, err)
        }
      }
    } catch (err) {
      console.error('[Ensemble] cleanupOrphanedSpawns top-level error:', err)
    }
  }

  private stop(): void {
    clearInterval(this.idleCheckTimer)
    this.watchdog.stop()
  }
}

const ensembleService = new EnsembleService()

function formatDuration(durationMs: number): string {
  const durationMin = Math.max(0, Math.round(durationMs / 60000))
  return durationMin >= 60
    ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
    : `${durationMin}m`
}

/** Escape special chars for Telegram MarkdownV2 */
function escMd(s: string): string {
  return s.replace(/([_[\]()~`>#+\-=|{}.!*\\])/g, '\\$1')
}

function sendTelegramSummary(params: {
  task: string
  duration: string
  messageCount: number
  agentSummaries: { name: string; msgs: number; tokens: string }[]
}): void {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return

  const agents = params.agentSummaries
  const agentLine = agents.map(a => `${escMd(a.name)} \\(${a.msgs}, ${escMd(a.tokens)}\\)`).join(' \\+ ')

  const text = [
    `\u2728 *Collab klaar* \u2014 ${escMd(params.duration)}, ${params.messageCount} msgs`,
    escMd(params.task.slice(0, 100)),
    agentLine,
  ].join('\n')

  const curl = spawn(
    'curl',
    [
      '-sS',
      '-X', 'POST',
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      '-d', `chat_id=${TELEGRAM_CHAT_ID}`,
      '-d', `parse_mode=MarkdownV2`,
      '--data-urlencode', `text=${text}`,
    ],
    {
      detached: true,
      stdio: 'ignore',
    },
  )

  curl.on('error', err => {
    console.error('[Ensemble] Failed to start Telegram notification:', err)
  })
  curl.unref()
}

async function routeToHost(_program: string, preferredHostId?: string): Promise<string> {
  if (preferredHostId) {
    const host = getHostById(preferredHostId)
    if (host) return preferredHostId
    console.warn(`[Ensemble] Unknown host ${preferredHostId}, falling back to self`)
  }
  return getSelfHostId()
}

export function loadCollabTemplate(templateName?: string): CollabTemplatesFile['templates'][string] | undefined {
  if (!templateName) return undefined
  try {
    const templatesPath = path.join(__dirname, '..', 'collab-templates.json')
    const raw = fs.readFileSync(templatesPath, 'utf-8')
    const data: CollabTemplatesFile = JSON.parse(raw)
    const template = data.templates[templateName]
    if (!template) {
      console.warn(`[Ensemble] Unknown template "${templateName}", falling back to default roles`)
      return undefined
    }
    console.log(`[Ensemble] Loaded template "${templateName}" (${template.name})`)
    return template
  } catch (err) {
    console.warn(`[Ensemble] Failed to load templates:`, err)
    return undefined
  }
}

// Expert profile library lives outside the repo so adding/editing experts
// doesn't churn the ensemble codebase. Override for tests via env var.
const EXPERT_PROFILES_DIR = process.env['ENSEMBLE_EXPERT_PROFILES_DIR']
  ?? path.join(process.env['HOME'] ?? '', '.openclaw/context-profiles/experts')

export function loadExpertProfile(slug?: string): string | undefined {
  if (!slug) return undefined
  const safe = slug.replace(/[^a-z0-9._-]/gi, '')
  if (!safe) return undefined
  const file = path.join(EXPERT_PROFILES_DIR, `${safe}.md`)
  try {
    return fs.readFileSync(file, 'utf-8').trim()
  } catch {
    console.warn(`[Ensemble] Expert profile not found: ${safe} (${file})`)
    return undefined
  }
}

// Role-keyword → expert slug. Used when a template role has no explicit
// `expert` field, so previously-authored templates still benefit from mental
// models. Keep this minimal and keyword-driven; explicit > implicit.
const ROLE_EXPERT_HINTS: Array<[RegExp, string]> = [
  [/architect|designer|planner/i, 'robert-c-martin'],
  [/developer|implementer|builder|engineer/i, 'steve-mcconnell'],
  [/reviewer|auditor|critic/i, 'michael-feathers'],
  [/adversary|red.?team|attacker/i, 'karl-popper'],
  [/reproducer|debugger/i, 'michael-feathers'],
  [/analyst|root.?cause/i, 'w-edwards-deming'],
  [/quant|strategist/i, 'howard-marks'],
  [/validator|risk/i, 'nassim-taleb'],
  [/researcher|investigator|forensic/i, 'julia-galef'],
  [/synthesizer|integrator/i, 'carl-sagan'],
]

export function autoSelectExpert(roleName: string): string | undefined {
  for (const [re, slug] of ROLE_EXPERT_HINTS) {
    if (re.test(roleName)) return slug
  }
  return undefined
}

// Strip class tags from user task description before injecting it into agent
// prompts. Without this, a task containing "[DONE]" would fire HIGH-confidence
// completion detection the moment the agent echoes it back — and "[PLAN]",
// "[FINDING]", "[PROGRESS]", etc. would poison the watchdog's loop detector.
// The architecture safety rails section documents this as "(tag-redacted)"
// replacement; the shell test expects that exact string to appear here.
function sanitizeTaskDescription(raw: string): string {
  return raw.replace(
    /\[(DONE|COMPLETE|FINISHED|EXEC_DONE|VERIFY_DONE|PLAN|PLAN_READY|FINDING|BLOCKER|REVIEW|PROGRESS|ACK|IDLE|STATUS)\]/gi,
    '(tag-redacted)',
  )
}

/**
 * Per-mode "challenge culture" block. Inserted before the role section so
 * everything below it operates under that tone. The blocks are deliberately
 * SHORT — one paragraph, four bullet rules — so they don't bloat the prompt
 * or fight the role focus. The patterns ensure that productive challenge
 * messages match watchdog PROGRESS_PATTERNS (file:line citations, command
 * output, concrete counter-proposals), so dialing this up doesn't trip
 * triangular-chatter detection.
 */
function buildChallengeBlock(mode: 'normal' | 'rigorous' | 'sparring'): string {
  if (mode === 'normal') return ''
  // Both rigorous and sparring tail with the SAME intermediate-commit
  // discipline rule (FIX 4 from 2026-04-27 audit). When the team is
  // sparring/rigorous, agents are also expected to be making concrete
  // file edits — without periodic commits, a mid-flight disband loses
  // partial work. The rule is short and concrete so it doesn't fight the
  // adversarial framing.
  const intermediateCommit = [
    `📦 INTERMEDIATE COMMIT RULE — applies whenever you edit files:`,
    `  • After every batch of 5-10 file edits, run "git add -A && git commit -m '<batch>'"`,
    `  • If a phase / phase-boundary closes (PLAN→EXEC, EXEC→VERIFY), commit before the boundary`,
    `  • Mid-flight disband must never lose more than 5-10 minutes of work`,
    `  • Commit messages should be one line, present-tense, scoped to the batch (e.g. "fix nav a11y on Account pages")`,
  ].join('\n')

  if (mode === 'rigorous') {
    return [
      `🔥 CHALLENGE CULTURE: rigorous`,
      `Polite-ack is weak. Every team-say message must do one of:`,
      `  ✓ Add evidence (file:line, command output, test result, citation)`,
      `  ✓ Disagree with a concrete counter-proposal`,
      `  ✓ Find a flaw in the teammate's claim and propose a fix`,
      `  ✓ Ship a concrete artifact (file edit, diff, command run)`,
      `If you agree, say WHY with a specific reason ("worker.ts:142 already covers this" — not "good plan").`,
      `If you disagree, propose THE alternative with reasoning.`,
      `Bias toward finding the second-order bug your teammate missed.`,
      ``,
      intermediateCommit,
      `---`,
    ].join('\n')
  }
  // sparring
  return [
    `🌶️ CHALLENGE CULTURE: sparring (high heat)`,
    `Polite-acks are BANNED. "Acknowledged. Standing by." is not a message — do not send it.`,
    `Every message must do at least one:`,
    `  • Cite hard evidence (file:line, exit code, command output, test name + result, version, hash)`,
    `  • Propose a SPECIFIC counter (replace X with Y at file:line, with reason)`,
    `  • Surface a flaw the teammate missed and PATCH it`,
    `  • Ship a real artifact (committed diff, applied edit, executed command with output)`,
    `Treat every claim from a teammate as a hypothesis until they prove it. "Looks good" without evidence = ask for the file:line. "Should work" without test = ask for the test command.`,
    `Adversarial pressure is the goal — find the second-order bug, the unhandled edge case, the silent assumption. Productive disagreement > comfortable agreement.`,
    `Format your challenges as: "🔍 [agent]: [specific claim] — counter: [evidence/alternative]". Stay concrete. No vague pushback.`,
    `Final sign-off requires GO from a teammate who tried to break your work and failed.`,
    ``,
    intermediateCommit,
    `---`,
  ].join('\n')
}

// Tags that identify a memory as belonging to a specific project. When a
// memory is tagged with one of these, it's scoped to that project; agents
// working on a DIFFERENT project should not see it in their TEAM MEMORIES.
//
// Two kinds of tags here:
//   1. Canonical project basenames (e.g. 'accounting-helper',
//      'crypto-trading-platform') — used to derive the project from cwd
//      and as primary filter keys.
//   2. Domain-specific tags strongly associated with one project, even
//      when the memory was saved without an explicit project basename
//      (e.g. 'iron_law', 'scalp_perp_basis_fade' for crypto trading,
//      'postmark' for libro mail intake). Agents organically tag with
//      domain terms more than project names, so this list catches the
//      cross-project leak that pure project-name filtering misses.
//
// Each entry tagged with its owning project. Memories whose tags include
// ANY of the OTHER project's domain tags are excluded.
const PROJECT_DOMAIN_TAGS: Record<string, ReadonlySet<string>> = {
  'accounting-helper': new Set([
    'accounting-helper', 'libro', 'postmark', 'intake', 'sectionheader',
    'invoice-events', 'erp-sync', 'bank_sync',
  ]),
  'crypto-trading-platform': new Set([
    'crypto-trading-platform', 'paper-trading', 'paper_trading', 'paper_trades_db',
    'iron_law', 'scalp_perp_basis_fade', 'liquidity_tier', 'liquidity_tier_hypothesis',
    'edge_classifier', 'pre_registration', 'regime_tagging', 'feature_snapshot',
    'kill_list', 'span_gate', 'l3_placebo_null_caveat', 'pooled', 'backtest',
    'paper_signals', 'whale_pack', 'retail_fade', 'sprint',
  ]),
  'brainai-dashboard': new Set(['brainai-dashboard', 'dashboard-api']),
  'brain-a2a': new Set(['brain-a2a']),
  'tcg-price-tracker': new Set(['tcg-price-tracker', 'tcg']),
  'cs2-betting': new Set(['cs2-betting', 'cs2']),
}
// Flat set of every project-scoped tag — used to detect "memory has SOME
// project-specific tag but not the current one's" → exclude.
const ALL_PROJECT_TAGS = new Set<string>(
  Object.values(PROJECT_DOMAIN_TAGS).flatMap(s => Array.from(s))
)
// Canonical project basenames that we'll match against cwd's basename.
const KNOWN_PROJECT_BASENAMES = new Set(Object.keys(PROJECT_DOMAIN_TAGS).concat(['libro']))

// Conservative cwd → project basename mapping. We match by basename of cwd
// (typical project layout: ~/projects/<name>, ~/.openclaw/workspace/skills/<name>).
// 'libro' is an alias for accounting-helper.
function currentProjectFromCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined
  const base = path.basename(cwd)
  if (!base) return undefined
  if (base === 'libro') return 'accounting-helper'
  if (KNOWN_PROJECT_BASENAMES.has(base)) return base
  return undefined
}

// True if the memory carries any tag that identifies it with a DIFFERENT
// project than `currentProject`. Memories with only generic tags (architect,
// refactor, a11y, p0_blocker, etc.) are treated as cross-project lessons
// and remain available.
function isTaggedWithDifferentProject(
  memory: { tags: string[] },
  currentProject: string,
): boolean {
  const ownDomain = PROJECT_DOMAIN_TAGS[currentProject]
  for (const tag of memory.tags) {
    if (ownDomain && ownDomain.has(tag)) continue   // tag belongs to current project
    if (ALL_PROJECT_TAGS.has(tag)) return true       // tag belongs to a different project
  }
  return false
}

// VERIFY NO-GO patterns reused from staged-workflow auto-fix detection.
// Kept here as a local mirror to avoid reaching into staged-workflow
// internals from disbandTeam.
const VERIFY_NO_GO_PATTERNS = [
  /\bNO[-_ ]GO\b/i,
  /\bNOT[-_ ]APPROVED\b/i,
  /\bverify[: ]+failed\b/i,
  /\bgate[: ]+(failed|fail|reject(ed)?)\b/i,
  /\b(verify|review)[: ]+(reject(ed)?|denied)\b/i,
  /\[NO[-_ ]GO\]/i,
  /\[REJECTED\]/i,
]
// Explicit "future-team please remember" markers an agent might emit
// without calling team-remember.sh themselves.
const GOTCHA_MARKER_RE = /\b(GOTCHA|LESSON|WARNING|REMEMBER|NOTE TO FUTURE|FUTURE TEAMS)[:\s]+([^\n]{30,500})/i
// Sparring-mode counter format: 🔍 [agent]: ... — counter: <evidence>
// We only treat it as a lesson if the counter cites concrete file:line
// or command-output evidence — opinion-only counters are noise.
const SPARRING_COUNTER_RE = /🔍\s+[\w@-]+[:\s][^\n]*?counter[:\s]+([^\n]{30,500})/i
const FILE_LINE_RE = /[A-Za-z0-9_/.\-]+\.(ts|tsx|js|jsx|py|sh|md|json|sql|yaml|yml|css|scss|html|svelte|vue|go|rs|kt|java|cpp|h)\b/

function shortHash(s: string): string {
  // Stable short hash, no crypto dep — tied to content for dedupe key.
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36).slice(0, 8)
}

/**
 * Extract structured lessons from a disbanded team's messages and write
 * them to the global memory store. No LLM call — three deterministic
 * patterns:
 *   1. VERIFY NO-GO blockers (verdict messages from VERIFY phase)
 *   2. Sparring counter-finds with file:line evidence
 *   3. Explicit GOTCHA / LESSON / REMEMBER markers in agent text
 *
 * Each lesson is keyed by content hash so reruns of the same finding
 * dedupe naturally. Capped at MAX_LESSONS per disband to avoid memory
 * spam from chatty teams.
 *
 * The caller (disbandTeam) wraps this in try/catch — extraction failures
 * never break the disband path.
 */
function extractAndSaveLessons(
  teamId: string,
  team: { id: string; name: string; description?: string },
  project?: string,
): void {
  const MAX_LESSONS = 10
  const messages = getMessages(teamId)
  const agentMessages = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
  if (agentMessages.length < 4) return  // not enough signal to be worth extracting

  type Lesson = { key: string; value: string; tags: string[]; agent: string }
  const lessons: Lesson[] = []
  const seenKeys = new Set<string>()
  const baseTags = ['auto_extracted', team.id.slice(0, 8)]
  if (project) baseTags.push(project)

  function add(category: string, value: string, agent: string, extraTags: string[]): void {
    const trimmed = value.trim().slice(0, 500)
    if (trimmed.length < 30) return
    const hash = shortHash(category + '|' + trimmed)
    const key = `lesson_${category}_${hash}`
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    lessons.push({
      key,
      value: trimmed,
      tags: [...baseTags, category, ...extraTags].filter((t, i, a) => t && a.indexOf(t) === i),
      agent,
    })
  }

  for (const m of agentMessages) {
    if (lessons.length >= MAX_LESSONS) break
    const content = m.content || ''
    const sender = m.from || 'unknown'

    // 1. VERIFY NO-GO blockers — extract bulleted/numbered lines from a
    //    NO-GO verdict message that mention concrete blocker language.
    if (VERIFY_NO_GO_PATTERNS.some(p => p.test(content))) {
      for (const raw of content.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        if (!/^[•*\-]\s+|^\d+[.)]\s+/.test(line)) continue
        if (!/\b(blocker|missing|broken|failed|reject|incomplete|stale|wrong|breaks)\b/i.test(line)) continue
        add('verify_blocker', line, sender, ['verify_blocker'])
        if (lessons.length >= MAX_LESSONS) break
      }
    }

    // 2. Sparring-mode counter with file:line evidence — concrete pushback
    //    that landed (an opinion-only counter has no .ext token).
    const counterMatch = content.match(SPARRING_COUNTER_RE)
    if (counterMatch && FILE_LINE_RE.test(counterMatch[1])) {
      add('adversarial_finding', counterMatch[1], sender, ['adversarial_finding', 'sparring'])
    }

    // 3. Explicit GOTCHA / LESSON / WARNING / REMEMBER marker.
    const gotchaMatch = content.match(GOTCHA_MARKER_RE)
    if (gotchaMatch) {
      add('gotcha', gotchaMatch[2], sender, ['gotcha'])
    }
  }

  if (lessons.length === 0) return

  // Persist via memory-store. Uses project-tag-aware filter on the read
  // side (buildPromptPreview), so writing without explicit project tag is
  // safe — auto_extracted tag + project tag cover both filter paths.
  for (const l of lessons) {
    try {
      writeMemory({
        scope: 'global',
        key: l.key,
        value: l.value,
        tags: l.tags,
        agent: l.agent,
        teamId: team.id,
      })
    } catch (err) {
      console.error(`[Ensemble] writeMemory failed for ${l.key}:`, err)
    }
  }
  console.log(`[Ensemble] Auto-extracted ${lessons.length} lesson(s) from team ${team.id.slice(0, 8)} → memory store`)

  // Optional LLM-aided extraction. Pattern-based gets the structured stuff;
  // LLM call captures the SUBTLE things (mid-prose realisations, "btw" notes,
  // architectural insights). Opt-in via ENSEMBLE_LLM_LESSONS=1 — costs ~1¢
  // per disband on Haiku.
  if (process.env['ENSEMBLE_LLM_LESSONS'] === '1' && agentMessages.length >= 6) {
    void runLlmLessonExtraction(team, project, lessons.length).catch(err => {
      console.warn(`[Ensemble] LLM lesson extraction failed for ${team.id.slice(0, 8)}:`, err)
    })
  }
}

// Module-scoped LLM circuit breaker. When the CLI returns a rate-limit /
// usage-cap response, we set llmCooldownUntilTs so subsequent disbands skip
// the call until the cooldown expires. Default 1h — typical Anthropic
// subscription cap windows reset hourly or daily.
const LLM_COOLDOWN_MS = parseInt(process.env['ENSEMBLE_LLM_COOLDOWN_MS'] ?? '', 10) || (60 * 60 * 1000)
let llmCooldownUntilTs = 0

/**
 * Optional LLM-aided lesson extraction. Spawns `claude -p --model haiku`
 * with the disbanded team's last 50 agent messages and asks for 1-5 reusable
 * lessons in JSON. Each accepted lesson is persisted via writeMemory with
 * tag `[auto_extracted, llm_summary, <project>]`.
 *
 * Wrapped fully in try/catch — any failure (binary missing, Haiku unreachable,
 * malformed JSON) is logged and dropped, never breaks disband.
 *
 * Cost: ~1¢ per disband (1-2k input tokens × Haiku rates). Disabled by
 * default; set ENSEMBLE_LLM_LESSONS=1 to opt in.
 */
async function runLlmLessonExtraction(
  team: { id: string; name: string; description?: string },
  project: string | undefined,
  patternCount: number,
): Promise<void> {
  const messages = getMessages(team.id)
  const tail = messages
    .filter(m => m.from !== 'ensemble' && m.from !== 'user')
    .slice(-50)
    .map(m => `[${(m.timestamp || '').slice(11, 19)}] ${m.from}: ${(m.content || '').slice(0, 600)}`)
    .join('\n')
  if (tail.length === 0) return

  const prompt = [
    `You are reviewing the message log of a just-disbanded multi-agent team.`,
    `Extract 1-5 REUSABLE LESSONS for FUTURE TEAMS — things the next team`,
    `working in the same project should know to avoid repeating mistakes.`,
    ``,
    `Output ONLY JSON. Schema: an array of objects, each with:`,
    `  "key":   short slug (snake_case, ≤50 chars)`,
    `  "value": one-line lesson body (≤300 chars), specific not generic`,
    `  "tags":  array of 2-5 short tags (lowercase, snake_case)`,
    ``,
    `Rules: SKIP generic engineering platitudes ("write tests", "use types").`,
    `Save concrete file paths, gotchas tied to this codebase, real disagreements.`,
    `If nothing concrete found, output empty array [].`,
    `Already-saved pattern lessons: ${patternCount}. Don't duplicate them.`,
    ``,
    `Team description: ${(team.description || '').slice(0, 200)}`,
    `Last messages:`,
    tail,
  ].join('\n')

  // Circuit breaker: when we see a usage-cap / rate-limit response from
  // Anthropic, suppress further calls for COOLDOWN_MS so we don't keep
  // hammering on every disband. Per-process state — restart clears it.
  if (Date.now() < llmCooldownUntilTs) {
    return
  }

  // Shell out to Haiku via Claude CLI using spawn — gives us proper stdin
  // control (close it immediately so the CLI doesn't wait 3s for piped
  // input) without the shell-escaping problems of exec(). Prompt passes
  // as a literal -p arg, real newlines preserved.
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  try {
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      const proc = spawn('claude', ['--model', 'haiku', '-p', prompt], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      let totalSize = 0
      const MAX = 1024 * 1024
      proc.stdout.on('data', (d: Buffer) => {
        totalSize += d.length
        if (totalSize <= MAX) chunks.push(d)
      })
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d))
      const killer = setTimeout(() => {
        try { proc.kill('SIGTERM') } catch { /* ignore */ }
        reject(new Error('claude CLI timed out after 90s'))
      }, 90_000)
      proc.on('error', err => { clearTimeout(killer); reject(err) })
      proc.on('close', (code) => {
        clearTimeout(killer)
        resolve({
          stdout: Buffer.concat(chunks).toString('utf-8'),
          stderr: Buffer.concat(errChunks).toString('utf-8'),
          code: code ?? 0,
        })
      })
      // Close stdin immediately — we don't pipe additional content.
      proc.stdin.end()
    })
    stdout = result.stdout
    stderr = result.stderr
    exitCode = result.code
  } catch (err) {
    console.warn(
      `[Ensemble] LLM Haiku spawn failed for ${team.id.slice(0, 8)}: ${(err as Error).message ?? err}`,
    )
    return
  }
  // Detect Anthropic subscription cap / rate-limit hit. The CLI currently
  // emits these phrases on quota exhaustion; both produce non-JSON stdout
  // but should NOT spam logs every disband.
  const QUOTA_MARKERS = [
    /monthly usage limit/i,
    /rate.?limit/i,
    /quota/i,
    /usage cap/i,
  ]
  if (QUOTA_MARKERS.some(p => p.test(stdout) || p.test(stderr))) {
    llmCooldownUntilTs = Date.now() + LLM_COOLDOWN_MS
    console.warn(
      `[Ensemble] LLM extraction backing off until ${new Date(llmCooldownUntilTs).toISOString()} — Anthropic quota hit. ` +
      `stdout=${stdout.trim().slice(0, 100)}`,
    )
    return
  }
  if (stderr.trim()) {
    console.warn(`[Ensemble] LLM Haiku stderr for ${team.id.slice(0, 8)}: ${stderr.slice(0, 200)}`)
  }
  if (!stdout.trim()) {
    console.warn(`[Ensemble] LLM Haiku returned empty stdout for ${team.id.slice(0, 8)}`)
    return
  }
  const json = stdout.trim()
  let parsed: Array<{ key: string; value: string; tags?: string[] }>
  try {
    // Tolerate fenced code blocks Haiku sometimes wraps JSON in.
    const cleaned = json.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    parsed = JSON.parse(cleaned)
  } catch {
    console.warn(`[Ensemble] LLM lessons JSON parse failed for ${team.id.slice(0, 8)} — output:`, json.slice(0, 300))
    return
  }
  if (!Array.isArray(parsed)) return

  const baseTags = ['auto_extracted', 'llm_summary', team.id.slice(0, 8)]
  if (project) baseTags.push(project)
  let saved = 0
  for (const item of parsed.slice(0, 5)) {
    if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') continue
    const value = item.value.trim().slice(0, 500)
    const key = `lesson_llm_${item.key.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40)}_${shortHash(value)}`
    const tags = [...baseTags, ...(item.tags || []).slice(0, 5).map(t => String(t).toLowerCase().replace(/[^a-z0-9_]+/g, '_'))]
      .filter((t, i, a) => t && a.indexOf(t) === i)
    try {
      writeMemory({ scope: 'global', key, value, tags, teamId: team.id })
      saved++
    } catch (err) {
      console.error(`[Ensemble] LLM lesson writeMemory failed for ${key}:`, err)
    }
  }
  if (saved > 0) {
    console.log(`[Ensemble] LLM extracted ${saved} additional lesson(s) for team ${team.id.slice(0, 8)}`)
  }
}

/**
 * Read the optional .collab-protect file at the repo root and return a list
 * of patterns. Each non-empty, non-comment line is a glob the agent must NOT
 * edit. Used by buildPromptPreview to inject a "PROTECTED FILES" block.
 *
 * Falls back to empty list if the file doesn't exist or can't be read; callers
 * still get a working prompt, just no extra protection.
 */
function loadCollabProtectPatterns(workingDirectory?: string): string[] {
  if (!workingDirectory) return []
  try {
    const file = path.join(workingDirectory, '.collab-protect')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf-8').split('\n')
    return lines
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .slice(0, 50) // hard cap so a runaway file can't bloat the prompt
  } catch {
    return []
  }
}

export function buildPromptPreview(params: {
  teamId: string
  teamName: string
  description: string
  agentName: string
  teammateNames: string[]
  agentIndex: number
  templateName?: string
  challengeMode?: 'normal' | 'rigorous' | 'sparring'
  workingDirectory?: string
}): string {
  const template = loadCollabTemplate(params.templateName)
  const scriptsDir = path.join(__dirname, '..', 'scripts')
  const teamSayCmd = `${scriptsDir}/team-say.sh ${params.teamId} ${params.agentName} ${params.teammateNames[0] || 'team'}`
  const teamReadCmd = `${scriptsDir}/team-read.sh ${params.teamId}`
  const teamDoneCmd = `${scriptsDir}/team-done.sh ${params.teamId} ${params.agentName}`
  const teamRememberCmd = `${scriptsDir}/team-remember.sh`
  const teamRecallCmd = `${scriptsDir}/team-recall.sh`
  const teamHistoryCmd = `${scriptsDir}/team-history.sh`
  const teamThinkCmd = `${scriptsDir}/team-think.sh`
  const safeDescription = sanitizeTaskDescription(params.description)
  const isThinkingMode = params.templateName === 'thinking'

  // FIX: scope memories to the current project. The global memory store
  // mixes findings across all collabs (crypto trading + libro accounting +
  // future projects), and "TEAM MEMORIES" block was injecting crypto
  // memories into libro prompts (and vice versa) — token waste plus a real
  // risk that an agent cites unrelated crypto context in a libro decision.
  // Now: prefer memories explicitly tagged with the current project; pad
  // the remainder with truly project-agnostic memories (no cross-project
  // tag); exclude memories tagged with OTHER known projects.
  let memoriesBlock = ''
  try {
    const project = currentProjectFromCwd(params.workingDirectory)
    let chosen = [] as ReturnType<typeof queryMemories>
    if (project) {
      // Primary lookup: any of the project's domain tags. queryMemories does
      // OR semantics on the tag filter, so this catches memories tagged with
      // the canonical project name OR domain-specific tags (iron_law,
      // postmark, etc.) — both are valid project signals.
      const projectTags = PROJECT_DOMAIN_TAGS[project]
      const tagList = projectTags ? Array.from(projectTags) : [project]
      const tagged = queryMemories({ scope: 'global', tags: tagList, limit: 5 })
      chosen = tagged
      const remaining = 5 - tagged.length
      if (remaining > 0) {
        const pool = queryMemories({ scope: 'global', limit: 50 })
        const taggedIds = new Set(tagged.map(t => t.id))
        const generic = pool.filter(m =>
          !taggedIds.has(m.id) && !isTaggedWithDifferentProject(m, project)
        )
        chosen = [...tagged, ...generic.slice(0, remaining)]
      }
    } else {
      // No project context (e.g. cwd outside known roots) → fall back to
      // the original global query.
      chosen = queryMemories({ scope: 'global', limit: 5 })
    }
    if (chosen.length) {
      const lines = chosen.map(m => {
        const tags = m.tags.length ? ` [${m.tags.join(',')}]` : ''
        return `  - ${m.key}${tags}: ${m.value.slice(0, 200)}`
      }).join('\n')
      memoriesBlock = `TEAM MEMORIES (from past sessions — apply when relevant):\n${lines}\n---\n`
    }
  } catch {
    memoriesBlock = ''
  }

  let roleInstructions: string[]
  let expertSlug: string | undefined

  if (template && params.agentIndex < template.roles.length) {
    const templateRole = template.roles[params.agentIndex]
    roleInstructions = [
      `ROLE: ${templateRole.role}.`,
      templateRole.focus,
    ]
    expertSlug = templateRole.expert ?? autoSelectExpert(templateRole.role)
  } else {
    const isLead = params.agentIndex === 0
    const roleName = isLead ? 'LEAD' : 'WORKER'
    roleInstructions = isLead
      ? [
          `ROLE: ${roleName}.`,
          `You own architecture, planning, high-level design, task breakdown, and code review.`,
          `Your first action after greeting is to share a concrete implementation plan with the worker before any implementation starts.`,
          `Keep the worker focused by delegating clear implementation steps, reviewing progress, and calling out risks or design corrections early.`,
        ]
      : [
          `ROLE: ${roleName}.`,
          `You own implementation, writing code, running tests, and reporting concrete execution progress.`,
          `After greeting, wait for the lead's plan before starting implementation work.`,
          `Once the lead shares a plan, execute it pragmatically, report what you changed, and surface blockers or test failures quickly.`,
        ]
    expertSlug = isLead ? 'robert-c-martin' : 'steve-mcconnell'
  }

  const expertBody = loadExpertProfile(expertSlug)
  const expertBlock = expertBody
    ? `EXPERT MENTAL MODEL (${expertSlug}):\n${expertBody}\n---\nAdopt this expert's frameworks, questions, and operating beliefs while executing the role below.\n`
    : ''

  // Auto-pick challenge mode from the template if the caller didn't override.
  // Templates that are inherently adversarial / high-stakes get rigorous by
  // default; everything else stays normal. Explicit `params.challengeMode`
  // wins absolutely (caller can downgrade premium-quad to normal, or upgrade
  // anything to sparring).
  const RIGOROUS_TEMPLATES = new Set(['premium-quad', 'ultrareview', 'pentest', 'adversarial', 'crypto-strategy', 'debug'])
  const effectiveChallenge: 'normal' | 'rigorous' | 'sparring' =
    params.challengeMode
    ?? (params.templateName && RIGOROUS_TEMPLATES.has(params.templateName) ? 'rigorous' : 'normal')
  const challengeBlock = buildChallengeBlock(effectiveChallenge)

  // FIX 2: PROTECTED FILES block. Repos can ship a .collab-protect file
  // listing globs the agents must not edit (typically: design system primitives,
  // generated code, lockfiles, secrets). The block is mandatory — agents see
  // the absolute prohibition before the role focus, so even rigorous/sparring
  // pressure to "fix everything" can't drag them into editing protected paths.
  const protectPatterns = loadCollabProtectPatterns(params.workingDirectory)
  const protectBlock = protectPatterns.length === 0 ? '' : [
    `🔒 PROTECTED FILES — DO NOT EDIT (read-only references only):`,
    ...protectPatterns.map(p => `  • ${p}`),
    `If a fix appears to require editing a protected file, STOP and emit [BLOCKER]`,
    `with a one-line explanation of why; the operator will lift the protection`,
    `or rescope the task. Do not work around the rule.`,
    `---`,
  ].join('\n')

  return [
    memoriesBlock,
    expertBlock,
    challengeBlock,
    protectBlock,
    `You are ${params.agentName} in team "${params.teamName}" with teammate ${params.teammateNames.join(', ')}.`,
    `Task: ${safeDescription}`,
    ...roleInstructions,
    `COMMUNICATION RULES:`,
    `1. Send findings: ${teamSayCmd} "your message"`,
    `2. Read teammate messages: ${teamReadCmd}`,
    `3. After EVERY analysis step, run team-say to share what you found`,
    `4. After EVERY team-say, run team-read to check for responses`,
    `5. If teammate shared findings, RESPOND to them`,
    `6. Keep alternating: analyze, share, read, respond, analyze`,
    `7. When the task is DONE — not earlier, not "almost done" — run: ${teamDoneCmd} "one-line summary". This is the ONLY reliable way to close the team. Do not emit [DONE] in text; it is no longer auto-detected. Running team-done disbands the team immediately, so don't call it until you're truly finished.`,
    `MEMORY (persists across sessions):`,
    `  Save a durable finding for future teams: ${teamRememberCmd} global <key> "<value>" [--tags=a,b]`,
    `  Recall prior findings: ${teamRecallCmd} [--scope=global] [--tags=a,b]`,
    `  Use scope=session for this team only, team for this team-id, global for all future teams.`,
    `HISTORY (previous collab teams' full conversations):`,
    `  Search past teams by keyword (task desc + messages): ${teamHistoryCmd} search "<keyword>"`,
    `  Read a specific past team's full log: ${teamHistoryCmd} feed <team-id>`,
    `  Browse recent teams: ${teamHistoryCmd} recent [N]`,
    `  Use this BEFORE starting a similar task — prior teams may have solved it, hit dead ends worth avoiding, or surfaced relevant context. Always cite the team-id when building on prior work.`,
    isThinkingMode ? [
      `THINKING MODE — this team operates under a deliberate reasoning protocol.`,
      `You MUST follow a six-phase flow. Skipping phases or bypassing the typed-message commands triggers supervisor warnings.`,
      ``,
      `  PHASE 1 FRAME        — understand the problem. MANDATORY: first run ${teamHistoryCmd} search "<key-terms>" AND ${teamRecallCmd} --tags=<topic> to see what prior teams learned. Then enumerate 2-5 hypotheses via: ${teamThinkCmd} hypothesize ${params.teamId} ${params.agentName} <H-id> <low|medium|high> "<statement>". Each hypothesis needs a unique id (H1, H2, ...). When your hypotheses are logged, emit: ${teamThinkCmd} phase ${params.teamId} ${params.agentName} evidence`,
      ``,
      `  PHASE 2 EVIDENCE     — gather data for EACH hypothesis. Run commands, read files, query memory. For every piece of evidence: ${teamThinkCmd} evidence ${params.teamId} ${params.agentName} <H-id> "<what-you-observed>" "<source-command-or-file>". Evidence for a hypothesis that was never registered will be flagged by the supervisor. When each hypothesis has at least one piece of evidence (or is marked unverifiable), emit: ${teamThinkCmd} phase ${params.teamId} ${params.agentName} synthesis`,
      ``,
      `  PHASE 3 SYNTHESIS    — compare the evidence. BEFORE any decision, at least one challenge MUST be logged: ${teamThinkCmd} challenge ${params.teamId} ${params.agentName} <H-id> "<why-it-might-still-be-wrong>". A decision without a preceding challenge is flagged. When converged, pick the winning hypothesis: ${teamThinkCmd} decide ${params.teamId} ${params.agentName} <H-id> "<reasoning-referencing-evidence>". Then: ${teamThinkCmd} phase ${params.teamId} ${params.agentName} action`,
      ``,
      `  PHASE 4 ACTION       — implement based on the decision. Keep changes minimal. Cite the hypothesis id in commit messages / diffs so the reasoning trail stays connected. When the implementation is ready to test: ${teamThinkCmd} phase ${params.teamId} ${params.agentName} verify`,
      ``,
      `  PHASE 5 VERIFY       — run the tests. If they pass, the hypothesis is confirmed. If they fail, log a new piece of evidence (type=evidence) linking the failure to a hypothesis, and return to PHASE 2 or 3 as appropriate — do NOT paper over failures. When verification succeeds: ${teamThinkCmd} phase ${params.teamId} ${params.agentName} reflect`,
      ``,
      `  PHASE 6 REFLECT      — save durable learnings: ${teamThinkCmd} reflect ${params.teamId} ${params.agentName} "<lesson-for-future-teams>" --tags=<topic>,<component>. Reflections auto-persist to global memory so future teams see them. Write at least one reflection, then ${teamDoneCmd} "<one-line-summary>".`,
      ``,
      `HARD RULES:`,
      `- NO hypothesis without a preceding ${teamHistoryCmd} search + ${teamRecallCmd}. The supervisor flags unverified starts.`,
      `- NO decision without at least one challenge in the same synthesis phase.`,
      `- NO decision without at least one piece of evidence for the picked hypothesis.`,
      `- NO phase regression (going backwards) without explicitly explaining why in a chat message.`,
      `- Supervisor warnings show up as 🧠 messages from 'ensemble'. Read them. Fix what they flag.`,
    ].join('\n') : '',
    `Start NOW: greet your teammate with team-say, then begin.`,
  ].filter(Boolean).join(' ')
}

export async function createEnsembleTeam(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const span = startSpan('create_team', {
    agentCount: request.agents?.length ?? 0,
    staged: !!request.staged,
    useWorktrees: !!request.useWorktrees,
  })
  try {
    const result = await createEnsembleTeamInner(request)
    endSpan(span, { teamId: result.data?.team.id })
    return result
  } catch (err) {
    endSpan(span, {}, err instanceof Error ? err : String(err))
    throw err
  }
}

async function createEnsembleTeamInner(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = createTeam(request)
  const cwd = request.workingDirectory || process.cwd()
  const worktreeMap = new Map<string, WorktreeInfo>()

  // Auto-enable worktrees in three cases:
  //   1. Caller explicitly asked (request.useWorktrees=true)
  //   2. Concurrent collab on same cwd (race risk)
  //   3. Scope-large heuristic: task description mentions a refactor/sweep/
  //      redesign/migration keyword OR enumerates 5+ file paths.
  // The third case is new (FIX 1 from 2026-04-27 audit) — historically the
  // 24-file LIBRO BACKEND POLISH task ran with worktrees=false because it
  // was a single collab, then agents wrote in parallel to the same files
  // and overwrote each other's edits. Now any large-scope sweep gets
  // isolation by default; the operator can still force false via
  // ENSEMBLE_DISABLE_AUTO_WORKTREE=1 for fast trivial edits.
  const concurrentTeams = getActiveTeamsByWorkingDir(cwd).filter(t => t.id !== team.id)
  const desc = (team.description || '')
  const SCOPE_LARGE_KEYWORDS = /\b(refactor|sweep|redesign|overhaul|migrat(e|ion|ing)|polish[- ]?pass|rewrite|restructur)/i
  const fileMentions = (desc.match(/[A-Za-z0-9_/\-.]+\.(ts|tsx|js|jsx|py|sh|md|json|sql|yaml|yml|css|scss|html|svelte|vue|go|rs|kt|java|cpp|h)\b/g) || []).length
  const isScopeLarge = SCOPE_LARGE_KEYWORDS.test(desc) || fileMentions >= 5
  const autoWorktreeDisabled = process.env['ENSEMBLE_DISABLE_AUTO_WORKTREE'] === '1'
  const useWorktrees = !!request.useWorktrees
    || concurrentTeams.length > 0
    || (isScopeLarge && !autoWorktreeDisabled)
  if (concurrentTeams.length > 0 && !request.useWorktrees) {
    appendMessage(team.id, {
      id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
      content: `⚠️ Concurrent collab detected (${concurrentTeams.length} active on same dir) — using git worktrees for isolation`,
      type: 'chat', timestamp: new Date().toISOString(),
    })
  } else if (isScopeLarge && !request.useWorktrees && !autoWorktreeDisabled) {
    const reason = SCOPE_LARGE_KEYWORDS.test(desc) ? 'refactor/sweep keyword' : `${fileMentions}+ file paths in task`
    appendMessage(team.id, {
      id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
      content: `🌳 Scope-large task detected (${reason}) — auto-enabling git worktrees so agents don't overwrite each other. Set ENSEMBLE_DISABLE_AUTO_WORKTREE=1 to opt out.`,
      type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'auto_worktree', reason, fileMentions },
    })
  }

  if (useWorktrees) {
    for (let i = 0; i < team.agents.length; i++) {
      const agentSpec = team.agents[i]
      const hostId = request.agents[i].hostId
        ? (getHostById(request.agents[i].hostId!) ? request.agents[i].hostId! : getSelfHostId())
        : getSelfHostId()

      // Only create worktrees for local agents
      if (isSelf(hostId)) {
        try {
          const worktreeInfo = await createWorktree(team.id, agentSpec.name, cwd)
          worktreeMap.set(agentSpec.name, worktreeInfo)
          team.agents[i].worktreePath = worktreeInfo.path
          team.agents[i].worktreeBranch = worktreeInfo.branch
          appendMessage(team.id, {
            id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
            content: `🌳 Worktree created for ${agentSpec.name}: ${worktreeInfo.branch}`,
            type: 'chat', timestamp: new Date().toISOString(),
          })
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[Ensemble] Failed to create worktree for ${agentSpec.name}:`, message)
          appendMessage(team.id, {
            id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
            content: `⚠️ Worktree creation failed for ${agentSpec.name}: ${message}. Using shared directory.`,
            type: 'chat', timestamp: new Date().toISOString(),
          })
        }
      }
    }
  }

  const buildPrompt = (agentName: string, otherNames: string[], agentIndex: number) => {
    return buildPromptPreview({
      teamId: team.id,
      teamName: team.name,
      description: team.description,
      agentName,
      teammateNames: otherNames,
      agentIndex,
      templateName: request.templateName,
      challengeMode: request.challengeMode,
      workingDirectory: request.workingDirectory || cwd,
    })
  }

  // Phase 1: Spawn all agents
  for (let i = 0; i < team.agents.length; i++) {
    const agentSpec = team.agents[i]
    const hostId = await routeToHost(agentSpec.program, request.agents[i].hostId)
    const agentName = `${team.name}-${agentSpec.name}`
    const prompt = buildPrompt(agentSpec.name, team.agents.filter((_, j) => j !== i).map(a => a.name), i)

    ensureCollabDirs(team.id)
    const promptFile = collabPromptFile(team.id, agentSpec.name)
    fs.writeFileSync(promptFile, prompt)
    console.log(`[Ensemble] Prompt for ${agentSpec.name}: ${prompt}`)

    try {
      let agentId: string
      console.log(`[Ensemble] Spawning ${agentName} (${agentSpec.program}) on ${hostId} (self=${isSelf(hostId)})`)

      if (isSelf(hostId)) {
        const agentCwd = worktreeMap.get(agentSpec.name)?.path || cwd
        const spawned = await spawnLocalAgent({
          name: agentName,
          program: agentSpec.program,
          workingDirectory: agentCwd,
          hostId,
        })
        agentId = spawned.id
      } else {
        const host = getHostById(hostId)
        if (!host) throw new Error(`Unknown host: ${hostId}`)
        const remote = await spawnRemote(host.url, agentName, agentSpec.program, cwd, team.description, team.name)
        agentId = remote.id
      }

      team.agents[i].agentId = agentId
      team.agents[i].hostId = hostId
      team.agents[i].status = 'active'

      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `${agentSpec.name} (${agentSpec.program} @ ${hostId}) has joined #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[Ensemble] Failed to spawn ${agentName}:`, message)
      team.agents[i].status = 'failed'
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `Failed to spawn ${agentName}: ${message}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  const activeAgents = team.agents.filter(a => a.status === 'active')
  updateTeam(team.id, { ...team, status: activeAgents.length >= 2 ? 'active' : 'failed' })

  // Phase 2: Wait for ALL agents to be ready, then inject prompts
  if (activeAgents.length >= 2) {
    const runtime = getRuntime()

    // 60s was tight for cold-starting claude with --model verification on a
    // busy system — bumped to 120s, overridable via env for slow hosts.
    // Bumped 120s→180s (FIX G) — Codex/Claude CLIs occasionally hit a slow
    // login flow (OAuth refresh, rate-limit warning banner) that pushes the
    // ready marker past the previous 2-minute window. Agents in that state
    // were marked failed and the team aborted with "only N/M agents ready"
    // even though they would have come up in another 30-60s. Still
    // env-tunable via ENSEMBLE_READY_TIMEOUT_MS.
    const defaultReadyTimeout = Number.parseInt(
      process.env['ENSEMBLE_READY_TIMEOUT_MS'] ?? '180000', 10,
    ) || 180000
    const waitForReady = async (
      sessionName: string, program: string, hostId?: string, maxWait = defaultReadyTimeout,
    ): Promise<boolean> => {
      const start = Date.now()
      const agentConfig = resolveAgentProgram(program)
      const readyMarker = agentConfig.readyMarker
      while (Date.now() - start < maxWait) {
        try {
          if (hostId && !isSelf(hostId)) {
            const host = getHostById(hostId)
            if (host && await isRemoteSessionReady(host.url, sessionName)) {
              console.log(`[Ensemble] ${sessionName} is remotely reachable (${Math.round((Date.now() - start) / 1000)}s)`)
              return true
            }
          } else {
            // Claude CLI can pin persistent status banners to the bottom of
            // the TUI (e.g. "You've used 83% of your weekly limit"), which
            // pushes the ❯ ready marker above a 5-line tail window. Scan the
            // full captured viewport — false positives are unlikely on a
            // fresh session, and 50 lines covers the whole pane anyway.
            const output = await runtime.capturePane(sessionName, 50)
            if (output.includes(readyMarker)) {
              console.log(`[Ensemble] ${sessionName} is ready (${Math.round((Date.now() - start) / 1000)}s)`)
              return true
            }
          }
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 1000))
      }
      console.error(`[Ensemble] ${sessionName} did not become ready within ${maxWait / 1000}s`)
      return false
    }

    console.log(`[Ensemble] Waiting for all ${activeAgents.length} agents to be ready...`)
    const readyResults = await Promise.all(
      activeAgents.map(agent => {
        const sessionName = `${team.name}-${agent.name}`
        return waitForReady(sessionName, agent.program, agent.hostId).then(ready => ({ agent, sessionName, ready }))
      })
    )

    const ready = readyResults.filter(r => r.ready)
    const notReady = readyResults.filter(r => !r.ready)

    for (const nr of notReady) {
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ ${nr.agent.name} failed to start — timed out`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    if (ready.length < 2) {
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `❌ Team start aborted: only ${ready.length}/${activeAgents.length} agents ready`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
      updateTeam(team.id, { status: 'failed' })
      return { data: { team: { ...team, status: 'failed' } }, status: 201 }
    }

    const postReadyDelay = Math.max(
      ...ready.map(({ agent }) => resolveAgentProgram(agent.program).postReadyDelayMs ?? 2000)
    )
    await new Promise(r => setTimeout(r, postReadyDelay))

    // Phase 3: Inject prompts (skip if staged — staged workflow handles its own prompts)
    if (request.staged) {
      // Staged mode: skip normal prompt injection, run plan→exec→verify workflow
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 All ${ready.length} agents ready — starting staged workflow (plan → exec → verify)`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      const buildStagedPlanPrompt = (agentName: string, otherNames: string[], agentIndex: number): string => [
        buildPrompt(agentName, otherNames, agentIndex),
        `STAGED WORKFLOW MODE.`,
        `PHASE 1 PLAN: ONLY create and share a plan via team-say.`,
        `Do NOT write code, edit files, or run mutating commands yet.`,
        `Both agents must share their plan before implementation begins.`,
        `After sharing your plan, run team-read and align on the execution approach.`,
        `Include [PLAN_READY] in your team-say message when your plan is finalized.`,
      ].join(' ')

      const buildStagedExecPrompt = (otherNames: string[]): string => [
        `PHASE 2 EXEC: Planning is complete.`,
        `You may now execute the agreed plan and make code changes.`,
        `Share concrete progress via team-say. Include [EXEC_DONE] in your message when your implementation is done.`,
        `Keep coordinating with ${otherNames.join(', ')} as you work.`,
      ].join(' ')

      const buildStagedVerifyPrompt = (teammateToReview?: string): string => [
        `PHASE 3 VERIFY: Review ${teammateToReview || 'your teammate'}'s work.`,
        `Inspect what they changed, compare it against the plan, and report findings via team-say.`,
        `Focus on bugs, regressions, missing tests, and mismatches with the agreed approach.`,
        `Include [VERIFY_DONE] in your message when review is complete.`,
      ].join(' ')

      // Run in background so createEnsembleTeam returns immediately
      runStagedWorkflow(team, request.stagedConfig, {
        buildPlanPrompt: ({ agent, teammates, index }) => buildStagedPlanPrompt(agent.name, teammates, index),
        buildExecPrompt: ({ teammates }) => buildStagedExecPrompt(teammates),
        buildVerifyPrompt: ({ teammateToReview }) => buildStagedVerifyPrompt(teammateToReview),
      }).catch(err => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[Ensemble] Staged workflow failed for ${team.id}:`, message)
        appendMessage(team.id, {
          id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
          content: `❌ Staged workflow failed: ${message}`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
        updateTeam(team.id, { status: 'failed' })
      })
    } else {
      // Normal mode: inject prompts simultaneously
      console.log(`[Ensemble] All ${ready.length} agents ready — injecting prompts simultaneously`)
      await Promise.all(
        ready.map(async ({ agent, sessionName }) => {
          const promptFile = collabPromptFile(team.id, agent.name)
          try {
            if (agent.hostId && !isSelf(agent.hostId)) {
              const host = getHostById(agent.hostId)
              if (host) {
                const prompt = fs.readFileSync(promptFile, 'utf-8')
                await postRemoteSessionCommand(host.url, sessionName, prompt)
              }
            } else {
              const agentCfg = resolveAgentProgram(agent.program)
              if (agentCfg.inputMethod === 'pasteFromFile') {
                await runtime.pasteFromFile(sessionName, promptFile)
              } else {
                const prompt = fs.readFileSync(promptFile, 'utf-8')
                await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true })
              }
            }
            console.log(`[Ensemble] ✓ Prompt injected into ${sessionName}`)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            appendMessage(team.id, {
              id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
              content: `❌ Delivery to ${agent.name} failed: ${message}`,
              type: 'chat', timestamp: new Date().toISOString(),
            })
            console.error(`[Ensemble] ✗ Failed to inject prompt into ${sessionName}:`, err)
          }
        })
      )

      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: `🚀 All ${ready.length} agents received their task — collaboration started`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  return { data: { team }, status: 201 }
}

export function getEnsembleTeam(teamId: string): ServiceResult<{ team: EnsembleTeam; messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { team, messages: getMessages(teamId) }, status: 200 }
}

export function listEnsembleTeams(): ServiceResult<{ teams: EnsembleTeam[] }> {
  return { data: { teams: loadTeams() }, status: 200 }
}

export async function checkIdleTeams(): Promise<void> {
  await ensembleService.checkIdleTeams()
}

export function getTeamFeed(teamId: string, since?: string): ServiceResult<{ messages: EnsembleMessage[] }> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  return { data: { messages: getMessages(teamId, since) }, status: 200 }
}

export async function sendTeamMessage(
  teamId: string, to: string, content: string, from?: string,
  existingId?: string, existingTimestamp?: string,
  type?: string, meta?: Record<string, unknown>,
): Promise<ServiceResult<{ message: EnsembleMessage }>> {
  const span = startSpan('send_message', { teamId, from: from || 'user', to, contentLen: content.length, type: type || 'chat' })
  const team = getTeam(teamId)
  if (!team) {
    endSpan(span, {}, 'team_not_found')
    return { error: 'Team not found', status: 404 }
  }

  const validTypes = new Set([
    'chat', 'decision', 'question', 'result',
    'phase', 'hypothesis', 'evidence', 'decision_pick', 'challenge', 'reflect', 'supervisor_warning',
  ])
  const msgType = (type && validTypes.has(type)) ? type : 'chat'

  const message: EnsembleMessage = {
    id: existingId || uuidv4(), teamId, from: from || 'user', to, content,
    type: msgType as EnsembleMessage['type'],
    timestamp: existingTimestamp || new Date().toISOString(),
    ...(meta ? { meta } : {}),
  }
  appendMessage(teamId, message)

  // Auto-persist reflections to global memory so future teams can recall them.
  if (msgType === 'reflect') {
    try {
      const { writeMemory } = await import('../lib/memory-store')
      const tags = Array.isArray(meta?.tags) ? (meta!.tags as string[]) : []
      writeMemory({
        scope: 'global', key: `reflection:${message.id.slice(0, 8)}`,
        value: content, tags: [...tags, 'reflection', teamId.slice(0, 8)],
        agent: from, teamId,
      })
    } catch { /* non-fatal */ }
  }

  endSpan(span, { messageId: message.id, type: msgType })

  // Determine which agents should receive this message in their tmux pane
  const sender = from || 'user'
  const recipients = to === 'team'
    ? team.agents.filter(a => a.status === 'active' && a.name !== sender)
    : team.agents.filter(a => a.status === 'active' && a.name === to)

  const runtime = getRuntime()

  for (const targetAgent of recipients) {
    try {
      const sessionName = `${team.name}-${targetAgent.name}`

      const deliveryText = [
        `[Team message from ${sender}]: ${content}`,
        `→ Respond with team-say. Then run team-read to check for more messages.`,
      ].join('\n')

      if (targetAgent.hostId && !isSelf(targetAgent.hostId)) {
        const host = getHostById(targetAgent.hostId)
        if (host) await postRemoteSessionCommand(host.url, sessionName, deliveryText)
      } else {
        const paneAlive = await runtime.sessionExists(sessionName)
        if (!paneAlive) continue
        const tmpFile = collabDeliveryFile(teamId, sessionName)
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
        fs.writeFileSync(tmpFile, deliveryText)
        await runtime.cancelCopyMode(sessionName)
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await runtime.pasteFromFile(sessionName, tmpFile)
            try { fs.unlinkSync(tmpFile) } catch { /* */ }
            break
          } catch (e) {
            if (attempt === 0) {
              console.warn(`[Ensemble] Delivery attempt 1 failed for ${sessionName}, retrying in 2s`)
              await new Promise(r => setTimeout(r, 2000))
              await runtime.cancelCopyMode(sessionName)
            } else {
              try { fs.unlinkSync(tmpFile) } catch { /* */ }
              throw e
            }
          }
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: `❌ Delivery to ${targetAgent.name} failed: ${reason}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }
  }

  return { data: { message }, status: 200 }
}

/**
 * Write a summary file for a disbanded team — used by auto-disband and can be
 * picked up by the background watcher in the Claude Code session.
 * Mirrors the format from cli/monitor.ts disbandTeam().
 */
export async function writeDisbandSummary(teamId: string): Promise<Record<string, string>> {
  const team = getTeam(teamId)
  if (!team) return {}

  const messages = getMessages(teamId)
  const agentMsgs = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
  if (agentMsgs.length === 0) return {}

  const now = new Date()
  const createdAt = new Date(team.createdAt)
  const durationMs = now.getTime() - createdAt.getTime()
  const duration = formatDuration(durationMs)

  const agents = [...new Set(agentMsgs.map(m => m.from))]

  // Scrape token usage from each agent's tmux pane (best-effort). Returned to
  // the caller so disbandTeam can reuse it for the Telegram / observation
  // payloads instead of running capture-pane twice per agent.
  const tokenUsageMap: Record<string, string> = {}
  await Promise.all(
    team.agents
      .filter(a => a.status === 'active')
      .map(async (agent) => {
        const sessionName = `${team.name}-${agent.name}`
        tokenUsageMap[agent.name] = await getAgentTokenUsage(sessionName)
      })
  )

  const summaryText = agents.map(agent => {
    const msgs = agentMsgs.filter(m => m.from === agent)
    const first = msgs[0]?.content.replace(/\/tmp\/ensemble[-\w]*/g, '').trim() || ''
    const last = msgs[msgs.length - 1]?.content.replace(/\/tmp\/ensemble[-\w]*/g, '').trim() || ''
    const tokens = tokenUsageMap[agent] || 'unknown'
    return `${agent} (${msgs.length} msgs, tokens: ${tokens}):\n  Start: ${first.slice(0, 300)}\n  Eind: ${last.slice(0, 500)}`
  }).join('\n\n')

  const summaryFile = collabSummaryFile(teamId)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(
    summaryFile,
    `Task: ${team.description || 'unknown'}\nDuration: ${duration}\nMessages: ${agentMsgs.length}\n\n${summaryText}`,
  )
  console.log(`[Ensemble] Summary written to ${summaryFile}`)
  return tokenUsageMap
}

export async function disbandTeam(
  teamId: string,
  reason: string = 'manual',
  meta?: Record<string, unknown>,
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const span = startSpan('disband_team', { teamId, reason })
  const team = getTeam(teamId)
  if (!team) {
    endSpan(span, {}, 'team_not_found')
    return { error: 'Team not found', status: 404 }
  }
  span.attributes.agentCount = team.agents.length
  span.attributes.createdAt = team.createdAt

  // FIX A: structured disband-reason marker.
  // Every disband (watchdog, idle-tax, manual, signal-complete) writes a
  // single typed message with `reason` and free-form `meta`. Without this,
  // diagnosing premature kills required correlating ensemble.err.log against
  // JSONL — slow and lossy. With it, `team-history feed <id>` shows the kill
  // cause inline.
  appendMessage(teamId, {
    id: uuidv4(),
    teamId,
    from: 'ensemble',
    to: 'team',
    content: `🛑 Team disband triggered — reason: ${reason}`,
    type: 'chat',
    timestamp: new Date().toISOString(),
    meta: { event: 'disband', reason, ...(meta ?? {}) },
  })

  // FIX D: write .finished BEFORE killing sessions so the bridge sees the
  // marker and exits cleanly, instead of racing against tmux paste-buffer
  // failures during the kill loop. Bridge auto-exit is keyed on .finished
  // existence (see scripts/ensemble-bridge.sh).
  try {
    fs.writeFileSync(
      collabFinishedMarker(teamId),
      JSON.stringify({ reason, timestamp: new Date().toISOString(), ...(meta ?? {}) }) + '\n',
    )
  } catch { /* non-fatal */ }

  // Write summary before killing sessions so the Claude Code session can
  // present it. writeDisbandSummary already scraped tmux panes for token
  // usage — reuse its result here so we don't run capture-pane twice per
  // agent on disband.
  const tokenUsageMap = await writeDisbandSummary(teamId)

  for (const agent of team.agents) {
    if (agent.status === 'active') {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: `${agent.name} has left #${team.name}`,
        type: 'chat', timestamp: new Date().toISOString(),
      })

      try {
        if (agent.hostId && !isSelf(agent.hostId)) {
          const host = getHostById(agent.hostId)
          if (host && agent.agentId) await killRemoteAgent(host.url, agent.agentId)
        } else {
          await killLocalAgent(`${team.name}-${agent.name}`)
        }
      } catch { /* session may already be gone */ }
    }
  }

  const agentsWithWorktrees = team.agents.filter(
    a => a.worktreePath && a.worktreeBranch && (!a.hostId || isSelf(a.hostId))
  )
  if (agentsWithWorktrees.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 2000))

    const firstWorktree = agentsWithWorktrees[0].worktreePath!
    const worktreesDir = path.dirname(firstWorktree)
    const basePath = path.dirname(worktreesDir)

    const conflictedAgents = new Set<string>()
    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      const result = await mergeWorktree(worktreeInfo, basePath)

      if (!result.success) conflictedAgents.add(agent.name)
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: result.success
          ? `🌳 Merged ${agent.name}'s worktree (${agent.worktreeBranch})`
          : `⚠️ Merge conflict for ${agent.name}: ${result.conflicts?.join(', ')}. Branch ${agent.worktreeBranch} preserved.`,
        type: 'chat', timestamp: new Date().toISOString(),
      })
    }

    for (const agent of agentsWithWorktrees) {
      if (conflictedAgents.has(agent.name)) {
        console.warn(`[Ensemble] Skipping worktree destroy for ${agent.name} — merge had conflicts, branch preserved`)
        continue
      }
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      await destroyWorktree(worktreeInfo, basePath)
    }

    // FIX 1: surface merge conflicts as a single structured alert. Without
    // this the operator only sees individual per-agent warnings buried in
    // the team feed and can miss preserved branches. We post a recovery
    // checklist + (if Telegram is configured) a push notification.
    if (conflictedAgents.size > 0) {
      const conflicted = team.agents.filter(a => conflictedAgents.has(a.name))
      const recoveryLines = conflicted.map(a => {
        const branch = a.worktreeBranch ?? 'unknown-branch'
        return `  • ${a.name} → branch \`${branch}\`\n` +
               `      git diff master...${branch}\n` +
               `      git merge --no-ff ${branch}     # resolve manually OR\n` +
               `      git cherry-pick <commit>          # pick specific changes`
      }).join('\n')
      const summary = [
        `🚧 ${conflictedAgents.size} merge conflict${conflictedAgents.size === 1 ? '' : 's'} — manual resolution needed:`,
        recoveryLines,
        ``,
        `All other agent worktrees merged cleanly. Branches above are preserved (NOT data loss).`,
        `Once resolved + merged, delete with: \`git branch -D <branch>\``,
      ].join('\n')
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: summary,
        type: 'chat', timestamp: new Date().toISOString(),
        meta: {
          event: 'merge_conflict_alert',
          conflictCount: conflictedAgents.size,
          conflictedAgents: [...conflictedAgents],
          branches: conflicted.map(a => a.worktreeBranch).filter(Boolean),
        },
      })
      // Telegram push if configured (uses existing TELEGRAM_BOT_TOKEN /
      // TELEGRAM_CHAT_ID env vars; silently skipped otherwise).
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        try {
          const taskShort = (team.description || '').split('\n')[0].slice(0, 80)
          const tgText = [
            `🚧 *${conflictedAgents.size} merge conflict${conflictedAgents.size === 1 ? '' : 's'}* on team \`${team.id.slice(0, 8)}\``,
            `Task: ${taskShort}`,
            ``,
            ...conflicted.map(a => `\`${a.worktreeBranch}\``),
            ``,
            `Run \`git branch --list "collab/${team.id.slice(0, 8)}*"\` to see preserved branches.`,
          ].join('\n')
          await execAsync(
            `curl -s -X POST 'https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage' ` +
            `-d 'chat_id=${TELEGRAM_CHAT_ID}' ` +
            `-d 'parse_mode=Markdown' ` +
            `--data-urlencode 'text=${tgText}' > /dev/null`,
            { timeout: 5000 }
          )
        } catch { /* Telegram failure must never break disband */ }
      }
    }
  }

  const updated = updateTeam(teamId, {
    status: 'disbanded',
    completedAt: new Date().toISOString(),
  })

  // Cost ledger append — runs inside disbandTeam so it's captured once per
  // real disband. Reuses tokenUsageMap scraped by writeDisbandSummary so we
  // don't re-scan tmux panes. Failures never propagate (appendCostEntry
  // swallows disk errors).
  if (updated?.completedAt) {
    appendCostEntry({
      teamId,
      teamName: team.name,
      description: (team.description ?? '').slice(0, 200),
      completedAt: updated.completedAt,
      perAgent: tokenUsageMap,
    })
  }

  // Soft cleanup: remove ephemeral files, keep messages/summary/log.
  // .finished was already written before the kill loop (see FIX D above).
  try {
    const deliveryDir = path.join(collabRuntimeDir(teamId), 'delivery')
    if (fs.existsSync(deliveryDir)) fs.rmSync(deliveryDir, { recursive: true, force: true })
    for (const f of [collabBridgeResult(teamId), collabBridgePosted(teamId)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
  } catch { /* non-fatal cleanup */ }

  // Auto-learning: scan the disbanded team's messages for structured lesson
  // patterns and persist them to the global memory store so future teams
  // see them in TEAM MEMORIES. Pattern-only extraction — no LLM call.
  // See extractAndSaveLessons() for the patterns + dedupe logic.
  try {
    const project = currentProjectFromCwd(team.workingDirectory)
    extractAndSaveLessons(teamId, team, project)
  } catch (err) {
    console.error(`[Ensemble] Auto-learning extraction failed for ${teamId}:`, err)
  }

  // Optional: save session summary to claude-mem
  try {
    const messages = getMessages(teamId)
    const agentMessages = messages.filter(m => m.from !== 'ensemble' && m.from !== 'user')
    if (agentMessages.length > 0) {
      const durationMs = updated!.completedAt && team.createdAt
        ? new Date(updated!.completedAt).getTime() - new Date(team.createdAt).getTime()
        : 0
      const duration = formatDuration(durationMs)

      // Build a concise summary with token usage
      const agents = [...new Set(agentMessages.map(m => m.from))]
      const summaryParts = agents.map(agent => {
        const msgs = agentMessages.filter(m => m.from === agent)
        const first = msgs[0]?.content.slice(0, 300) || ''
        const last = msgs[msgs.length - 1]?.content.slice(0, 500) || ''
        const tokens = tokenUsageMap[agent] || 'unknown'
        return `${agent} (${msgs.length} msgs, tokens: ${tokens}):\n  Start: ${first}\n  Eind: ${last}`
      })

      sendTelegramSummary({
        task: team.description || 'unknown',
        duration,
        messageCount: agentMessages.length,
        agentSummaries: agents.map(agent => ({
          name: agent,
          msgs: agentMessages.filter(m => m.from === agent).length,
          tokens: tokenUsageMap[agent] || '?',
        })),
      })

      // Detect the working directory as project hint
      const cwdMatch = team.description.match(/workingDirectory[:\s]*([^\s,}]+)/)
      const project = process.env.ENSEMBLE_PROJECT
        || (cwdMatch ? cwdMatch[1].split('/').pop() : undefined)
        || 'ensemble'

      fetch('http://localhost:37777/api/observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Collab: ${team.description.slice(0, 80)}`,
          subtitle: `${agents.join(' + ')} — ${duration}, ${agentMessages.length} messages`,
          type: 'discovery',
          narrative: `Team "${team.name}" (${duration}):\nTask: ${team.description.slice(0, 200)}\n\n${summaryParts.join('\n\n')}`,
          project,
        }),
      }).catch(() => {})
    }
  } catch { /* non-fatal */ }

  endSpan(span, { disbandedAt: updated?.completedAt })
  return { data: { team: updated! }, status: 200 }
}

export interface HistoryMatch {
  teamId: string
  name: string
  description: string
  status: string
  createdAt?: string
  completedAt?: string
  agents: string[]
  matches: Array<{ from: string; timestamp: string; snippet: string }>
}

/**
 * Cross-team search across past collab history. Looks at team descriptions
 * and the persistent message log (registry feed, not /tmp) so reboots don't
 * lose the trail. Default: latest 20 matching teams, up to 3 message
 * snippets per team.
 */
export function searchHistory(
  query: string, limit = 20, perTeamSnippets = 3,
): ServiceResult<{ matches: HistoryMatch[]; total: number }> {
  const q = query.trim().toLowerCase()
  if (!q) return { error: 'query required', status: 400 }
  // Include archived teams in cross-time search (FIX 6) — archives are the
  // monthly rotations created when the live registry exceeds the threshold.
  const allTeams = loadAllTeamsIncludingArchives()
  const sorted = [...allTeams].sort((a, b) => {
    const ta = new Date(a.completedAt ?? a.createdAt ?? 0).getTime()
    const tb = new Date(b.completedAt ?? b.createdAt ?? 0).getTime()
    return tb - ta
  })

  const matches: HistoryMatch[] = []
  for (const team of sorted) {
    if (matches.length >= limit) break
    const descHit = (team.description ?? '').toLowerCase().includes(q)
    const messages = getMessages(team.id)
    const messageHits = messages
      .filter(m => m.from !== 'ensemble' && (m.content ?? '').toLowerCase().includes(q))
      .slice(0, perTeamSnippets)
    if (!descHit && messageHits.length === 0) continue

    matches.push({
      teamId: team.id,
      name: team.name,
      description: team.description ?? '',
      status: team.status,
      createdAt: team.createdAt,
      completedAt: team.completedAt,
      agents: team.agents.map(a => a.name),
      matches: messageHits.map(m => ({
        from: m.from,
        timestamp: m.timestamp ?? '',
        snippet: (m.content ?? '').slice(0, 300),
      })),
    })
  }
  return { data: { matches, total: matches.length }, status: 200 }
}

export function getRecentTeams(limit = 10): ServiceResult<{ teams: EnsembleTeam[] }> {
  const all = loadTeams()
  const sorted = [...all].sort((a, b) => {
    const ta = new Date(a.completedAt ?? a.createdAt ?? 0).getTime()
    const tb = new Date(b.completedAt ?? b.createdAt ?? 0).getTime()
    return tb - ta
  })
  return { data: { teams: sorted.slice(0, Math.max(1, Math.min(limit, 100))) }, status: 200 }
}

/**
 * Explicit completion signal from an agent. Replaces the fragile regex-based
 * auto-disband for tasks where agents can deterministically say "I'm done."
 * Posts a structured [SIGNAL_COMPLETE] message so every observer sees it,
 * then disbands the team (no idle-tax, no pattern guessing).
 */
export async function signalCompleteTeam(
  teamId: string, from: string, note?: string,
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  const validSenders = new Set([...team.agents.map(a => a.name), 'user', 'ensemble'])
  if (!validSenders.has(from)) {
    return { error: `Unauthorized sender: ${from}`, status: 403 }
  }
  appendMessage(teamId, {
    id: uuidv4(), teamId, from, to: 'team',
    content: `[SIGNAL_COMPLETE]${note ? ' ' + note.slice(0, 500) : ''}`,
    type: 'chat', timestamp: new Date().toISOString(),
  })
  return disbandTeam(teamId, `signal-complete by ${from}`, {
    triggeredBy: 'signal-complete',
    by: from,
    note: note?.slice(0, 200),
  })
}
