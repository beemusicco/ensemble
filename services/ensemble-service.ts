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
import { queryMemories, queryMemoriesSemantic, writeMemory } from '../lib/memory-store'
import { TAG as LEARN_TAG, weightLearning } from '../lib/auto-learn'
import * as cognee from '../lib/cognee-bridge'
import { computeCalibration, recommendRoleAssignments } from '../lib/calibration'
import {
  computeCalibration as computeConfidenceCalibration,
  formatCalibrationFeedback as formatConfidenceFeedback,
  scanAndPersistClaims,
  resolveClaimOutcome,
} from '../lib/confidence-tracker'
import { readProjectConfigText } from '../lib/project-config'
import { scanAndAnswerUnknowns, flagAssumptions } from '../lib/unknown-watcher'
import { scanAndDispatchQuestions, answerQuestion, type AnswerInput, type AnswerResult } from '../lib/question-watcher'
import { detectOperatorHold, isReleaseHoldRequest } from '../lib/operator-hold'
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
import { createWorktree, mergeWorktree, destroyWorktree, uncommittedChanges, evaluateWorktreeDisposition, detectCrossAgentOverlap, classifyAgentBranch, resolveOverlapByForwardBias, type WorktreeInfo, type WorktreeDisposition, type CrossAgentOverlap } from '../lib/worktree-manager'
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
// Patterns that signal "we're not going to call team-done" — agents have
// explicitly chosen to stop emitting messages. With uncommitted-work
// preservation now in disbandTeam (worktrees with local changes survive
// the destroy), there's no longer a strong reason to keep the team open;
// agents who said "silent" really mean it. 10 min default leaves room
// for one belated follow-up message before we close.
const STANDING_BY_PATTERNS = [
  /\bstand(?:s|ing)?\s+by\s+silently\b/i,
  /\bteam\s+stays\s+alive\b/i,
  /\b(?:will\s+not|won['’]t|do\s+not)\s+call\s+team[- ]?done\b/i,
  /\bgoing\s+silent\b/i,
  /\bclosing\s+loop,\s*going\s+silent\b/i,
]
const STANDING_BY_IDLE_MS = parseEnvMs('ENSEMBLE_STANDING_BY_IDLE_MS', 10 * 60 * 1000)

// W2.5d (Fix A): when an agent emits [READY-TO-MERGE], they're saying
// "human, take it from here" — premium-quad/ultrareview templates explicitly
// instruct this pattern. The team correctly goes silent, but watchdog
// can't distinguish "idle CLI prompt" from "long-running command in flight"
// (both show non-shell foreground), so it defers all-stalled disband and
// the team sits zombie until lifetime cap (90 min).
//
// W2.5e production-finding tightening (collab 25f8bf58, 2026-05-01):
//   1. Marker must be at message EDGE (start or end), not embedded in prose.
//      haiku-3 wrote "gates → [READY-TO-MERGE]\n[PLAN_READY]" inside a PLAN
//      describing the protocol — got mistaken for completion sign-off,
//      team disbanded after 6 min with deliverables half-built.
//      Same pattern as HIGH_CONFIDENCE_AT_START/AT_END for [DONE]/[VERIFY_DONE].
//   2. Idle is "since last team activity" not "since ready signal" — if
//      team kept messaging after signal, they're not actually done.
//   3. Quorum: solo emission requires LONGER silence (likely false alarm or
//      premature ack); >=50% emissions can disband on standard quiet.
const READY_AT_START_RE = /^\s*\[READY[-_ ]TO[-_ ]MERGE\]/i
const READY_AT_END_RE = /\[READY[-_ ]TO[-_ ]MERGE\]\s*[.!,:]?\s*$/i
const READY_LOCAL_NO_GO_RE = /\bNO[-_ ]GO\b|\bNOT[-_ ]APPROVED\b/i
const READY_TO_MERGE_QUIET_MS = parseEnvMs('ENSEMBLE_READY_QUIET_MS', 5 * 60 * 1000)
const READY_TO_MERGE_SOLO_QUIET_MS = parseEnvMs('ENSEMBLE_READY_SOLO_QUIET_MS', 30 * 60 * 1000)
const READY_TO_MERGE_MIN_AGE_MS = parseEnvMs('ENSEMBLE_READY_MIN_AGE_MS', 10 * 60 * 1000)

/**
 * W2.5f: Selective auto-merge based on disband reason.
 *
 * Auto-merging worktrees on EVERY disband (regardless of why) is silent
 * pollution: when the team is killed by lifetime-cap / soft-cap / manual /
 * watchdog, the work-in-progress in each agent's worktree gets fast-forward
 * merged into master before the operator has a chance to review it. This
 * happened with collab 25f8bf58 (TDD scaffolds shipped to master).
 *
 * Rule: merge only when the team explicitly signaled completion. Otherwise
 * preserve every worktree and surface a recovery alert with manual merge
 * commands. The operator chooses what (if anything) to merge.
 */
function isDisbandCompletionConfirmed(reason: string): boolean {
  return (
    reason.startsWith('ready-to-merge:') ||
    reason.startsWith('idle-tax: completion signal') ||
    reason.startsWith('signal-complete:')
  )
}

function isReadyToMergeSignoff(content: string): boolean {
  if (!content) return false
  // Allow on its own line — split & check each line's edges, plus first/last line of message.
  if (READY_AT_START_RE.test(content) || READY_AT_END_RE.test(content)) return true
  for (const line of content.split('\n')) {
    if (READY_AT_START_RE.test(line) && READY_AT_END_RE.test(line)) return true
  }
  return false
}

// W2.5d (Fix B): soft lifetime cap. The hard 90-min cap protects against
// runaway zombie teams, but real collabs that hit 60 min idle for 15+ min
// are almost always done — operator forgot to disband, or agents are at
// idle CLI prompts. Soft cap fires earlier than hard cap WITH an idle
// condition, so legit long-running sessions (75 min of active work) are
// not killed.
const SOFT_LIFETIME_CAP_MS = parseEnvMs('ENSEMBLE_SOFT_LIFETIME_CAP_MS', 60 * 60 * 1000)
const SOFT_LIFETIME_IDLE_MS = parseEnvMs('ENSEMBLE_SOFT_LIFETIME_IDLE_MS', 15 * 60 * 1000)

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

      // 🧭 W2 [UNKNOWN]/[ASSUMPTION] watcher — auto-fetch context for tags
      // emitted by agents. Each (team, tag, agent) is answered ONCE.
      // W3 extension: [ASSUMPTION: claim ## verify: cmd] auto-runs the cmd
      // in the team's workingDirectory and posts 🟢 verified / 🔴 rejected.
      // Errors are swallowed: a flaky query shouldn't crash the entire tick.
      try {
        await scanAndAnswerUnknowns(team.id)
        const wd = (team as { workingDirectory?: string }).workingDirectory
        await flagAssumptions(team.id, undefined, { verifyCwd: wd })
        // 📱 W3 [QUESTION] watcher — pings operator via Telegram when an
        // agent emits a [QUESTION: X] tag. Operator answers via /answer
        // command in Telegram → proxy.js → /api/ensemble/answer endpoint.
        // Timeouts (5min) are also expired here.
        await scanAndDispatchQuestions(team.id)
      } catch (err) {
        console.warn(`[Ensemble] watcher tick failed for ${team.id.slice(0, 8)}:`, (err as Error).message)
      }

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

      // Operator-hold: idle-tax fires when an agent emitted a completion
      // marker AND the team went quiet. That's a *claim* path — operator
      // explicitly said "wait for me" so this disband must not fire. Safety
      // nets (lifetime/soft-cap) already ran above and are unaffected.
      if (team.holdForOperator) {
        logHoldSuppression(team, 'idle-tax', 'completion signal + idle threshold')
        continue
      }

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

    // W2.5d/W2.5e: [READY-TO-MERGE] sign-off + team-silent → disband.
    // Tightened after collab 25f8bf58 false-positive (2026-05-01):
    //   - Marker must be at message edge, not embedded in prose
    //   - Use idle-since-last-team-activity, not wall-clock-since-signal
    //   - Single-agent emission needs LONGER quiet (premature/accidental
    //     emissions are common); quorum >=50% on standard quiet
    //   - Suppress in the first 10 min of team life — agents haven't had
    //     time to deliver real work
    if (ageMs >= READY_TO_MERGE_MIN_AGE_MS) {
      // Find all distinct agents who emitted [READY-TO-MERGE] as a sign-off
      // (edge-anchored), and the latest such message.
      const readyEmitters = new Set<string>()
      let lastReadyMsg: typeof agentMsgs[number] | undefined
      for (const m of agentMsgs) {
        if (isReadyToMergeSignoff(m.content || '')) {
          readyEmitters.add(m.from)
          lastReadyMsg = m
        }
      }
      if (lastReadyMsg) {
        const readyTs = lastReadyMsg.timestamp ? new Date(lastReadyMsg.timestamp).getTime() : 0
        // Honor post-ready dissent — someone said NO-GO after merge signal.
        const dissent = agentMsgs.find(m => {
          const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0
          return ts > readyTs && READY_LOCAL_NO_GO_RE.test(m.content || '')
        })
        if (!dissent) {
          // Quorum: how many ACTIVE agents are there, how many signaled?
          const activeCount = team.agents.filter(a => a.status === 'active' || a.status === 'idle').length
          const denom = activeCount > 0 ? activeCount : team.agents.length
          const hasQuorum = denom > 0 && readyEmitters.size * 2 >= denom  // >=50%
          const requiredQuietMs = hasQuorum ? READY_TO_MERGE_QUIET_MS : READY_TO_MERGE_SOLO_QUIET_MS
          if (idleMs > requiredQuietMs) {
            // Operator-hold: pattern-detected completion claim must NOT
            // override operator's "wait for me" instruction. Log once,
            // continue the loop (lifetime/soft-cap still fire below).
            if (team.holdForOperator) {
              const tag = hasQuorum ? `quorum ${readyEmitters.size}/${denom}` : `solo ${readyEmitters.size}/${denom}`
              logHoldSuppression(
                team, 'ready-to-merge',
                `${tag} signaled + ${Math.round(idleMs / 60_000)}min team-idle`,
              )
            } else {
              const tag = hasQuorum ? `quorum ${readyEmitters.size}/${denom}` : `solo ${readyEmitters.size}/${denom}`
              return {
                reason: `ready-to-merge: ${tag} signaled + ${Math.round(idleMs / 60_000)}min team-idle`,
                ageMs,
                idleMs,
              }
            }
          }
        }
      }
    }

    // W2.5d Fix B: soft lifetime cap with idle condition. Catches teams
    // that hit ~60 min and went quiet, before the 90-min hard cap. Active
    // long-running sessions stay alive because idleMs < threshold.
    if (
      SOFT_LIFETIME_CAP_MS > 0 &&
      ageMs > SOFT_LIFETIME_CAP_MS &&
      idleMs > SOFT_LIFETIME_IDLE_MS
    ) {
      return {
        reason: `soft-cap: ${Math.round(ageMs / 60_000)}min age + ${Math.round(idleMs / 60_000)}min idle (>${Math.round(SOFT_LIFETIME_CAP_MS / 60_000)}min/${Math.round(SOFT_LIFETIME_IDLE_MS / 60_000)}min thresholds)`,
        ageMs,
        idleMs,
      }
    }

    if (idleMs > STANDING_BY_IDLE_MS) {
      const recent = agentMsgs.slice(-5)
      for (const m of recent) {
        for (const pattern of STANDING_BY_PATTERNS) {
          const match = (m.content || '').match(pattern)
          if (match) {
            // Operator-hold: agents may "stand by" without operator wanting
            // disband. Only safety nets (lifetime/soft-cap) keep firing.
            if (team.holdForOperator) {
              logHoldSuppression(
                team, 'standing-by',
                `agents declared "${match[0]}" + ${Math.round(idleMs / 60_000)}min idle`,
              )
              return null
            }
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
/**
 * Bulletproof gate — applied across all modes when present. Defines the
 * minimum verification floor before any [VERIFY_DONE] sign-off can hold.
 * Auto-runner mechanically enforces test/lint gates; agent attestations
 * carry concrete file:line evidence (cannot be hand-waved).
 *
 * Per-project tunable via <repo>/.collab-bulletproof.json — when absent,
 * the default checklist below applies.
 */
function buildBulletproofBlock(): string {
  return [
    `🛡️ BULLETPROOF GATE — every [VERIFY_DONE] requires ALL of:`,
    `  1. ✅ Tests + typecheck + diff_check + attest checks (run mechanically by 🤖 verify-runner — see team feed for verdict)`,
    `  2. 🤝 Edge cases: list 3+ with file:line citations (citations are auto-verified — fake refs = REJECTED)`,
    `  3. 🤝 Revert plan: one line "to undo, do X"`,
    `  4. 🤝 Observability: log/metric added if behavior changed (or note "no observable change")`,
    `  5. 📱 High-risk paths (auth/payment/db migrations) → operator approval attestation required`,
    ``,
    `🤖 verify-runner posts results as ensemble messages — read them BEFORE [VERIFY_DONE].`,
    `If verify-runner says ❌ FAIL, the team has not converged regardless of agent opinions.`,
    `Hand-waved attestations ("looks good", "should work") are REJECTED.`,
    `Cited file:line refs are automatically checked — confabulated cites trigger NO-GO.`,
    `Auto-FIX iterates up to 2× on any FAIL. After 2 fails → escalation, no disband.`,
    `---`,
  ].join('\n')
}

/**
 * Learn-on-demand block — gives agents an explicit escape hatch from
 * hallucination. When stuck, they emit a tagged message; the operator
 * (or a future ensemble watcher) can fetch the answer and inject it back.
 */
function buildLearnOnDemandBlock(teamId: string, agentName: string): string {
  return [
    `🧭 LEARN-ON-DEMAND — when you don't know something, do not guess:`,
    `  • [UNKNOWN: <concept>]                          — ensemble auto-fetches memories + docs (~/.openclaw/{docs,workspace})`,
    `  • [ASSUMPTION: <claim>]                         — flagged in feed; if false, your work is REJECTED`,
    `  • [ASSUMPTION: <claim> ## verify: <bash-cmd>]   — auto-runs the cmd; exit 0 = 🟢 verified, non-zero = 🔴 rejected (treated as NO-GO blocker)`,
    `  • [QUESTION: <ask>]                             — pings operator on Telegram (5min timeout); answer routed back to feed by question-id`,
    `  • [CONFIDENCE: N% — <claim>]                    — Tetlock-style: attach a probability to any speculative claim. If you say 80%, you should be right ~80% of the time across many claims. Tracked + calibrated over teams. Avoid 90%+ unless you have direct evidence; avoid <30% unless you're red-teaming yourself. The system shows your past calibration in the prompt header — adjust accordingly.`,
    ``,
    `🚨 [QUESTION] is COSTLY — operator answers ~0% of them in production. Use ONLY when:`,
    `  ✓ You cannot proceed without an operator decision (both options valid, only operator knows preference)`,
    `  ✓ The action is destructive or irreversible (delete, push, deploy, drop table)`,
    `  ✓ Two interpretations of the task differ enough that picking wrong wastes >15min of work`,
    ``,
    `🚫 DO NOT use [QUESTION] for:`,
    `  ✗ Cosmetic choices (variable names, comment style, file layout)`,
    `  ✗ "Should I add X?" — decide based on the task, then describe in [PLAN_READY]`,
    `  ✗ Verifiable facts — run tests, read docs, or use [ASSUMPTION ## verify:] instead`,
    `  ✗ Exploratory framing ("what if we also...?") — pick a direction and ship`,
    ``,
    `Be ruthless. If you can decide and document the tradeoff in [PLAN_READY], do that. The operator's silence is not a green light — it means they're trusting you to decide.`,
    ``,
    `Use these tags inline in team-say. Better to flag uncertainty than ship hallucination.`,
    `Anti-sycophancy: replies starting with "you're right" without evidence are flagged. Either cite file:line / output OR add [ACK_NO_EVIDENCE].`,
    `---`,
  ].join('\n')
}

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
      // W8 counterfactual mandate. Every "we should do X" decision in
      // rigorous mode now carries an obligation: name Y as the
      // alternative + forecast outcome of both. This forces real
      // optionality instead of first-instinct anchoring, and the
      // forecast carries a [CONFIDENCE: N%] tag that joins the
      // calibration ledger.
      `🔁 COUNTERFACTUAL MANDATE — every decision message that proposes "we should do X" MUST include:`,
      `  1. Y = the strongest alternative (NOT "we could also Z" — Y must be a real competitor on its merits)`,
      `  2. FORECAST: what observable result do you expect from X vs Y in 3 measurable dimensions (latency / correctness / blast-radius / etc)? Pick metrics, not vibes.`,
      `  3. [CONFIDENCE: N% — X wins on metric M] — emit a confidence tag. Your past calibration is in the prompt header; calibrate accordingly.`,
      `  4. PICK: choose X or Y based on the forecast, NOT first-instinct. If the forecast says Y wins, take Y.`,
      `Skipping the counterfactual = your decision is anchoring, not reasoning. Teammates may reject it on those grounds alone.`,
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
export const PROJECT_DOMAIN_TAGS: Record<string, ReadonlySet<string>> = {
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
const FILE_LINE_RE = /[A-Za-z0-9_/.-]+\.(ts|tsx|js|jsx|py|sh|md|json|sql|yaml|yml|css|scss|html|svelte|vue|go|rs|kt|java|cpp|h)\b/

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
/**
 * W2.5f: aggregate per-team metrics from the feed's structured `meta.event`
 * markers. Used to post a one-line "collab impact" summary at disband so
 * the operator sees what the team did beyond the obvious code work — without
 * having to run team-stats.sh manually. Returns empty string when there
 * are no events worth summarizing.
 */
export function buildTeamImpactSummary(messages: EnsembleMessage[]): string {
  let assumeOk = 0, assumeRej = 0, assumeFlag = 0
  let confab = 0
  let qAsked = 0, qAnswered = 0, qTimeout = 0
  let runnerPass = 0, runnerFail = 0
  let autoFixExhausted = 0
  let unknownResolved = 0

  for (const m of messages) {
    const meta = (m.meta || {}) as Record<string, unknown>
    const e = meta.event as string | undefined
    if (!e) continue
    switch (e) {
      case 'assumption_verified':
        if (meta.passed === true) assumeOk++
        else assumeRej++
        break
      case 'assumption_flagged': assumeFlag++; break
      case 'confabulation': confab++; break
      case 'question_pending': qAsked++; break
      case 'question_answered': qAnswered++; break
      case 'question_timeout': qTimeout++; break
      case 'unknown_resolved': unknownResolved++; break
      case 'verify_runner': {
        const passed = (meta.passed as number | undefined) ?? 0
        const failed = (meta.failed as number | undefined) ?? 0
        const errored = (meta.errored as number | undefined) ?? 0
        if (failed === 0 && errored === 0 && passed > 0) runnerPass++
        else if (failed > 0 || errored > 0) runnerFail++
        break
      }
      case 'auto_fix_exhausted': autoFixExhausted++; break
    }
  }

  const parts: string[] = []
  if (assumeOk || assumeRej) parts.push(`assumptions ${assumeOk}🟢/${assumeRej}🔴`)
  if (assumeFlag) parts.push(`${assumeFlag} flagged`)
  if (confab) parts.push(`${confab} confab${confab === 1 ? '' : 's'} caught`)
  if (qAsked) parts.push(`questions ${qAnswered}✅/${qTimeout}⏱`)
  if (unknownResolved) parts.push(`${unknownResolved} [UNKNOWN] resolved`)
  if (runnerPass || runnerFail) parts.push(`verify-runner ${runnerPass}✅/${runnerFail}❌`)
  if (autoFixExhausted) parts.push(`auto-fix exhausted`)

  if (parts.length === 0) return ''
  return `📊 collab impact: ${parts.join(' · ')}`
}

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
        if (!/^[•*-]\s+|^\d+[.)]\s+/.test(line)) continue
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
 * Pre-kill reflection: deliver a private prompt to each active local agent's
 * tmux pane asking them to note ONE thing they'd do differently + ONE thing
 * the next team must know. Capture the response after a short delay, parse
 * lines, persist as memories tagged [reflection, auto_extracted, project].
 *
 * Mechanism:
 *   1. Paste the reflection prompt into each pane via runtime.pasteFromFile
 *   2. Wait 25s for agent to reason + emit
 *   3. capturePane(50 lines) and grep for the structured response
 *   4. Skip silently if pane is dead (agent already exited) or parse fails
 *
 * Cost: zero new API calls — uses the agent's already-running CLI session
 * to generate reflections. Time: ~25s added to disband path (parallelized
 * across agents).
 */
async function collectAgentReflections(team: EnsembleTeam): Promise<void> {
  const runtime = getRuntime()
  const activeLocalAgents = team.agents.filter(a =>
    a.status === 'active' && (!a.hostId || isSelf(a.hostId))
  )
  if (activeLocalAgents.length === 0) return
  const project = currentProjectFromCwd((team as { workingDirectory?: string }).workingDirectory)
  const reflectionPrompt = [
    `🪞 PRE-DISBAND REFLECTION (private; not visible to teammates).`,
    `In ONE message, output the following structured block exactly:`,
    ``,
    `[REFLECTION]`,
    `would_differently: <one-line — what would you change about your approach next time?>`,
    `must_know: <one-line — what must the NEXT team know to avoid your mistakes / build on your work?>`,
    `[/REFLECTION]`,
    ``,
    `Be specific (file:line, exact pitfall, concrete decision). Skip generic advice.`,
    `Do NOT use team-say — emit directly in this CLI's response. We'll read it from the pane.`,
  ].join('\n')

  // Deliver in parallel — avoid serial 25s × N agents wait.
  await Promise.allSettled(activeLocalAgents.map(async (agent) => {
    const sessionName = `${team.name}-${agent.name}`
    try {
      // Skip if pane is already dead (agent exited).
      if (runtime.paneCurrentCommand) {
        const cmd = (await runtime.paneCurrentCommand(sessionName)).toLowerCase().replace(/\.exe$/, '')
        if (cmd && new Set(['zsh','bash','sh','fish','dash']).has(cmd)) return
      }
      // Paste prompt + wait
      const tmpFile = collabDeliveryFile(team.id, sessionName) + '.reflection'
      fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
      fs.writeFileSync(tmpFile, reflectionPrompt)
      await runtime.pasteFromFile(sessionName, tmpFile)
      // Give agent 25s to reason + emit
      await new Promise(r => setTimeout(r, 25_000))
      const tail = await runtime.capturePane(sessionName, 80)
      const match = tail.match(/\[REFLECTION\]\s*\n?([\s\S]*?)\n?\[\/REFLECTION\]/i)
      if (!match) {
        console.log(`[Ensemble] Reflection: no structured response from ${agent.name}`)
        return
      }
      const body = match[1]
      const wouldMatch = body.match(/would_differently:\s*(.+?)(?:\n|$)/i)
      const mustMatch = body.match(/must_know:\s*(.+?)(?:\n|$)/i)
      const baseTags = ['reflection', 'auto_extracted', team.id.slice(0, 8)]
      if (project) baseTags.push(project)
      let saved = 0
      if (wouldMatch && wouldMatch[1].trim().length >= 20) {
        const v = wouldMatch[1].trim().slice(0, 400)
        writeMemory({
          scope: 'global',
          key: `reflection_${agent.name}_${shortHash('would|' + v)}`,
          value: `WOULD DIFFERENTLY (${agent.name}): ${v}`,
          tags: [...baseTags, 'would_differently'],
          agent: agent.name,
          teamId: team.id,
        })
        saved++
      }
      if (mustMatch && mustMatch[1].trim().length >= 20) {
        const v = mustMatch[1].trim().slice(0, 400)
        writeMemory({
          scope: 'global',
          key: `reflection_${agent.name}_${shortHash('must|' + v)}`,
          value: `MUST KNOW for next team (${agent.name}): ${v}`,
          tags: [...baseTags, 'must_know'],
          agent: agent.name,
          teamId: team.id,
        })
        saved++
      }
      if (saved > 0) {
        console.log(`[Ensemble] Reflection: saved ${saved} entries from ${agent.name}`)
      }
    } catch (err) {
      console.warn(`[Ensemble] Reflection failed for ${agent.name}:`, err)
    }
  }))
}

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
 * Read the optional `.collab-tools.md` config — free-form markdown the
 * operator drops to tell agents the project-specific tools they should use
 * (e.g. "lint=ruff not flake8", "test=vitest", "dev=bun run dev"). The body
 * is injected into the prompt verbatim; size capped so a runaway file can't
 * bloat the prompt.
 *
 * Resolution order (W2.5b): operator-config dir first
 * (`~/.openclaw/collab-config/<repo-basename>/.collab-tools.md`) then repo
 * root. This lets operators keep collab config out of git without losing
 * the per-project guidance — see lib/project-config.ts for full rationale.
 *
 * Returns null when neither tier has the file — caller skips the block.
 */
const COLLAB_TOOLS_MAX_BYTES = 4_000  // ~700 tokens — enough for a tight tool index
function loadProjectToolIndex(workingDirectory?: string): string | null {
  const found = readProjectConfigText('.collab-tools.md', workingDirectory)
  if (!found) return null
  const trimmed = found.text.trim()
  if (!trimmed) return null
  if (trimmed.length > COLLAB_TOOLS_MAX_BYTES) {
    return trimmed.slice(0, COLLAB_TOOLS_MAX_BYTES) + '\n…[truncated — keep .collab-tools.md under 4KB]'
  }
  return trimmed
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
  const teamResearchCmd = `${scriptsDir}/team-research.sh`
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
  // FIX: SEMANTIC memory retrieval. Replaces tag-only filter with hybrid
  // Jaccard + IDF scoring against the task description. The old top-5-by-
  // recency approach surfaced random recent libro memories regardless of
  // whether they were relevant to "fix WebSocket reconnect bug". Now the
  // system pulls top-5 most semantically similar to THIS task.
  // W4 self-upgrading: in addition to general semantic memories, fetch
  // pattern memories (failure-pattern + confab-pattern + resolution) with
  // outcome + recency weighting so prior team failures TEACH the next team.
  // Writes to these tags happen automatically in lib/auto-learn.ts hooks.
  let memoriesBlock = ''
  try {
    const project = currentProjectFromCwd(params.workingDirectory)
    let chosen = [] as Array<{ id?: string; key: string; value: string; tags: string[]; createdAt?: string; score?: number }>

    // ── Pattern-memory pull (HIGH priority, project-scoped) ─────────
    // Failures tell the team what NOT to do; resolutions tell what works;
    // confab-patterns tighten the agent's citation discipline. We pull
    // a generous pool, apply weight* (outcome + recency decay), then keep
    // top-3 patterns. Pattern memories ALWAYS rank ahead of general
    // semantic memories because they carry concrete prior-team evidence.
    const patternTags = [LEARN_TAG.FAILURE_PATTERN, LEARN_TAG.CONFAB_PATTERN, LEARN_TAG.RESOLUTION]
    const patternsRaw = queryMemoriesSemantic(params.description || '', {
      scope: 'global',
      tags: patternTags,
      pool: 200,
      limit: 20,
    })
    const projectFilter = project
      ? (m: { tags: string[] }) =>
          // Patterns survive iff they EITHER match this project's domain
          // tags OR carry no project tag at all. Cross-project patterns
          // (e.g. confab-pattern from a totally unrelated repo) are kept
          // out so an agent doesn't get warned about a path that only
          // makes sense in another project.
          m.tags.includes(project) ||
          !m.tags.some((t: string) => ALL_PROJECT_TAGS.has(t))
      : () => true
    const patterns = patternsRaw
      .filter(projectFilter)
      .map(m => ({
        ...m,
        score: weightLearning((m as { score?: number }).score ?? 1, m.tags, m.createdAt),
      }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3)

    // ── General semantic pool (existing logic) ──────────────────────
    let general: typeof chosen = []
    if (project) {
      const projectTags = PROJECT_DOMAIN_TAGS[project]
      const includeTags = projectTags ? Array.from(projectTags) : [project]
      const otherProjectTags: string[] = []
      for (const [otherProject, tags] of Object.entries(PROJECT_DOMAIN_TAGS)) {
        if (otherProject === project) continue
        for (const t of tags) {
          if (!includeTags.includes(t)) otherProjectTags.push(t)
        }
      }
      // Exclude pattern tags from the general pool so we don't double-count
      // a memory that already shows up in `patterns`.
      general = queryMemoriesSemantic(params.description || '', {
        scope: 'global',
        tags: includeTags,
        excludeTags: [...otherProjectTags, ...patternTags],
        pool: 200,
        limit: 5,
      })
      const remaining = 5 - general.length
      if (remaining > 0) {
        const pool = queryMemories({ scope: 'global', limit: 50 })
        const chosenIds = new Set([
          ...patterns.map(p => p.id),
          ...general.map(g => g.id),
        ])
        const generic = pool.filter(m =>
          !chosenIds.has(m.id) &&
          !isTaggedWithDifferentProject(m, project) &&
          !m.tags.some(t => patternTags.includes(t as typeof LEARN_TAG.FAILURE_PATTERN))
        )
        general = [...general, ...generic.slice(0, remaining)]
      }
    } else {
      general = queryMemoriesSemantic(params.description || '', {
        scope: 'global',
        excludeTags: patternTags,
        pool: 200,
        limit: 5,
      })
      if (general.length === 0) {
        general = queryMemories({ scope: 'global', limit: 5 })
      }
    }
    chosen = [...patterns, ...general]

    if (chosen.length) {
      const renderEntry = (m: typeof chosen[0]) => {
        const tags = m.tags.length ? ` [${m.tags.join(',')}]` : ''
        return `  - ${m.key}${tags}: ${m.value.slice(0, 200)}`
      }
      const sections: string[] = []
      if (patterns.length) {
        sections.push([
          `🧠 PRIOR-TEAM PATTERNS (apply BEFORE you start — failures, confabs, and fixes from past collabs):`,
          patterns.map(renderEntry).join('\n'),
        ].join('\n'))
      }
      if (general.length) {
        sections.push([
          `📚 RELATED MEMORIES (semantically matched to your task):`,
          general.map(renderEntry).join('\n'),
        ].join('\n'))
      }
      memoriesBlock = sections.join('\n\n') + '\n---\n'
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

  // 🛠 W4 Project tool index — when the repo ships `.collab-tools.md`, inject
  // it verbatim. Agents save discovery time + avoid wrong-tool errors (e.g.
  // running `npm test` in a bun project, or `pytest` when the project uses
  // unittest). The doc author owns the contract; we just paste it.
  const projectTools = loadProjectToolIndex(params.workingDirectory)
  const projectToolsBlock = !projectTools ? '' : [
    `🛠 PROJECT TOOLS — what to actually run in this repo (verbatim from .collab-tools.md):`,
    projectTools,
    `---`,
  ].join('\n')

  // Bulletproof gate + learn-on-demand: always present. Agents see them
  // alongside expert + challenge culture so the verification floor and
  // hallucination escape hatches are visible from message #1.
  const bulletproofBlock = buildBulletproofBlock()
  const learnOnDemandBlock = buildLearnOnDemandBlock(params.teamId, params.agentName)

  // W8: per-agent calibration feedback. If the agent has 10+ resolved
  // confidence claims in the global memory store, surface their
  // calibration curve so they self-adjust before claiming.
  let calibrationBlock = ''
  try {
    const program = params.agentName.split('-')[0]
    const projectScope = currentProjectFromCwd(params.workingDirectory)
    const curve = computeConfidenceCalibration({ agent: params.agentName, project: projectScope, windowDays: 60 })
    const fallback = curve.overallSamples < 10
      ? computeConfidenceCalibration({ agent: program, windowDays: 60 })
      : curve
    const fbText = formatConfidenceFeedback(fallback)
    if (fbText) calibrationBlock = `\n${fbText}\n---\n`
  } catch { /* non-fatal — calibration is augmentation, never required */ }

  return [
    memoriesBlock,
    calibrationBlock,
    expertBlock,
    challengeBlock,
    bulletproofBlock,
    learnOnDemandBlock,
    protectBlock,
    projectToolsBlock,
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
    `RESEARCH (proactive context broadening — distinct from reactive [UNKNOWN: ...]):`,
    `  ${teamResearchCmd} "<query>" [--url=<url>] [--limit=N]`,
    `  Aggregates: top-K semantic memory matches + ripgrep across ~/.openclaw/{docs,workspace} + (optional) one URL fetch.`,
    `  Use BEFORE making a non-obvious decision. Cite results in your team-say. URL fetch is for canonical refs (MDN, RFC, vendor docs) — pass the exact URL, no search.`,
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

/**
 * W7: classify a template role-name into one of the three calibration
 * role-classes (architect / builder / verifier). Lossy by design — many
 * template-specific role names (DIVERGER, RECON, ADVERSARY, etc.) map
 * onto the same underlying behavioral cluster for calibration purposes.
 */
function roleClassForCalibration(roleName: string): 'architect' | 'builder' | 'verifier' {
  const n = (roleName || '').toUpperCase()
  if (/REVIEW|CRITIC|ADVERSARY|VALIDAT|VERIF|CHALLENG|SYNTHESIZ|CONVERG|REPORTER/.test(n)) return 'verifier'
  if (/IMPLEMENT|BUILD|DEVELOP|EXPLOIT|REPRODUC|CONNECT|WORKER/.test(n)) return 'builder'
  return 'architect'  // default cluster — planning, design, research, lead
}

/**
 * W7: apply calibration-driven program reordering to a CreateTeamRequest's
 * agents list. Roles stay where the template put them (operator-driven);
 * only the order of programs is shuffled so the program with best
 * historical fit lands at each role's index. Anti-fragile guards from
 * recommendRoleAssignments (min_samples=20, epsilon-greedy 10%) prevent
 * lock-in.
 *
 * ENV: ENSEMBLE_CALIBRATION_ROLE_ASSIGN=0 disables. Default ON. Templates
 * with explicit per-agent role assignments STILL win — this only reorders
 * the program list, doesn't override role naming.
 *
 * Returns a new request with possibly-reordered agents, plus an array of
 * human-readable assignment reasons for the team feed.
 */
function applyCalibrationRoleAssignment(
  request: CreateTeamRequest,
  templateRoles: string[],
): { request: CreateTeamRequest; reasons: string[] } {
  if (process.env['ENSEMBLE_CALIBRATION_ROLE_ASSIGN'] === '0') {
    return { request, reasons: [] }
  }
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return { request, reasons: [] }
  }
  if (!request.agents || request.agents.length < 2) {
    return { request, reasons: [] }
  }
  if (templateRoles.length !== request.agents.length) {
    return { request, reasons: [] }
  }

  let calibration: ReturnType<typeof computeCalibration>
  try {
    calibration = computeCalibration({ windowDays: 30 })
  } catch {
    return { request, reasons: [] }
  }
  if (!calibration.perProgram || calibration.perProgram.length === 0) {
    return { request, reasons: [] }
  }

  const programs = request.agents.map(a => a.program)
  // Map each templated role name to a calibration role-class.
  const calibrationRoles = templateRoles.map(roleClassForCalibration)

  let recs: ReturnType<typeof recommendRoleAssignments>
  try {
    recs = recommendRoleAssignments({
      programs,
      roles: calibrationRoles,
      calibration,
    })
  } catch {
    return { request, reasons: [] }
  }
  if (recs.length !== request.agents.length) {
    return { request, reasons: [] }
  }

  // Reorder agents: at index i, place the program that calibration
  // recommended for role calibrationRoles[i]. Preserve original
  // hostId/role/etc. by matching on program name.
  const newAgents: typeof request.agents = []
  const reasons: string[] = []
  const consumed = new Set<number>()  // already-placed source indices
  for (let i = 0; i < recs.length; i++) {
    const wantProgram = recs[i].program
    // Find first unconsumed source agent with matching program.
    const srcIdx = request.agents.findIndex((a, idx) => a.program === wantProgram && !consumed.has(idx))
    if (srcIdx === -1) {
      // Calibration picked something not in our pool — fall back to original order.
      return { request, reasons: [] }
    }
    consumed.add(srcIdx)
    newAgents.push(request.agents[srcIdx])
    reasons.push(`  ${wantProgram} → ${templateRoles[i]} (${recs[i].role}-class): ${recs[i].reason}`)
  }
  // Verify all agents accounted for.
  if (newAgents.length !== request.agents.length) {
    return { request, reasons: [] }
  }
  // No-op if order is unchanged.
  const reordered = newAgents.some((a, i) => a.program !== request.agents[i].program)
  if (!reordered) {
    return { request, reasons: [] }
  }
  return { request: { ...request, agents: newAgents }, reasons }
}

async function createEnsembleTeamInner(
  request: CreateTeamRequest
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  // W7: calibration-driven program ordering. Roles stay where the template
  // put them; programs reorder so the historically-best program lands at
  // each role's index. ENV-gated default ON; templates / explicit roles
  // are preserved.
  let calibrationReasons: string[] = []
  try {
    const tmpl = loadCollabTemplate(request.templateName)
    if (tmpl && tmpl.roles && tmpl.roles.length === request.agents?.length) {
      const result = applyCalibrationRoleAssignment(
        request,
        tmpl.roles.map(r => r.role),
      )
      request = result.request
      calibrationReasons = result.reasons
    }
  } catch { /* calibration failure must NOT abort team creation */ }

  const team = createTeam(request)
  const cwd = request.workingDirectory || process.cwd()
  const worktreeMap = new Map<string, WorktreeInfo>()

  if (calibrationReasons.length > 0) {
    appendMessage(team.id, {
      id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
      content: [
        `📊 Calibration-driven role assignment (last 30d data):`,
        ...calibrationReasons,
        ``,
        `Set ENSEMBLE_CALIBRATION_ROLE_ASSIGN=0 to disable.`,
      ].join('\n'),
      type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'calibration_role_assignment', reasons: calibrationReasons },
    })
  }

  // W6: Cognee KG enrichment, posted as a team-feed message (NOT inlined
  // into the system prompt — buildPromptPreview is sync). Fire-and-forget;
  // if Cognee is down or disabled (default), nothing happens.
  if (cognee.isEnabled()) {
    const project = currentProjectFromCwd(cwd)
    cognee.searchGraph(
      `${team.description} ${project ?? ''}`.slice(0, 800),
      { limit: 5, tags: project ? [project] : [] },
    ).then(entries => {
      if (entries.length === 0) return
      const lines = entries.map(e => `  - ${e.id}: ${e.text.slice(0, 220)}`).join('\n')
      appendMessage(team.id, {
        id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
        content: [
          `🌐 KNOWLEDGE GRAPH (Cognee, cross-project structural patterns):`,
          lines,
          ``,
          `Apply these where they map onto your task. Cite the KG node id if you use one.`,
        ].join('\n'),
        type: 'chat', timestamp: new Date().toISOString(),
        meta: { event: 'kg_enrichment', count: entries.length, ids: entries.map(e => e.id) },
      })
    }).catch(() => { /* graceful degrade */ })
  }

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

      // W2.5k: per-template timeout defaults. premium-quad and sparring tasks
      // are typically more complex (4 agents, adversarial heat) — claude-1
      // (lead) frequently times out PLAN at 120s on real tasks. Caller can
      // still override via request.stagedConfig.
      const templateTimeouts: Record<string, { planTimeoutMs?: number; execTimeoutMs?: number; verifyTimeoutMs?: number }> = {
        'premium-quad':    { planTimeoutMs: 300_000, execTimeoutMs: 1_200_000, verifyTimeoutMs: 300_000 },  // 5min/20min/5min
        'ultrareview':     { planTimeoutMs: 240_000, execTimeoutMs: 600_000,  verifyTimeoutMs: 240_000 },  // 4min/10min/4min
        'pentest':         { planTimeoutMs: 240_000, execTimeoutMs: 900_000,  verifyTimeoutMs: 240_000 },  // 4min/15min/4min
        'crypto-strategy': { planTimeoutMs: 300_000, execTimeoutMs: 600_000,  verifyTimeoutMs: 240_000 },  // 5min/10min/4min
        'adversarial':     { planTimeoutMs: 240_000, execTimeoutMs: 600_000,  verifyTimeoutMs: 240_000 },  // 4min/10min/4min
        'audit-only':      { planTimeoutMs: 180_000, execTimeoutMs: 600_000,  verifyTimeoutMs: 180_000 },  // 3min/10min/3min
      }
      const challengeTimeouts: Record<string, { planTimeoutMs?: number; execTimeoutMs?: number; verifyTimeoutMs?: number }> = {
        // Sparring is high-heat — agents debate longer. Bump even when no specific template.
        'sparring': { planTimeoutMs: 240_000, execTimeoutMs: 600_000, verifyTimeoutMs: 240_000 },
        'rigorous': { planTimeoutMs: 180_000, execTimeoutMs: 480_000, verifyTimeoutMs: 180_000 },
      }
      const templateDefault = (request.templateName && templateTimeouts[request.templateName]) || {}
      const challengeDefault = (request.challengeMode && challengeTimeouts[request.challengeMode]) || {}
      // Merge order: caller's stagedConfig wins, then template, then challenge.
      const stagedConfigEffective: typeof request.stagedConfig = {
        ...challengeDefault,
        ...templateDefault,
        ...(request.stagedConfig ?? {}),
      }

      // Run in background so createEnsembleTeam returns immediately
      runStagedWorkflow(team, stagedConfigEffective, {
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

  // Operator can release hold inline by typing "/release-hold" or
  // "[/HOLD-OFF]" in the team feed. Only honored when sender is "user" or
  // "operator" — agents cannot release their own hold.
  const sender = from || 'user'
  if (
    team.holdForOperator &&
    (sender === 'user' || sender === 'operator') &&
    isReleaseHoldRequest(content)
  ) {
    await releaseOperatorHold(teamId, sender)
  }

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

  // Pre-kill reflection: ask each active local agent to privately note
  // ONE thing they'd do differently + ONE thing the next team must know.
  // Saved as memories with tag [reflection] so future collabs see them in
  // TEAM MEMORIES via semantic match.
  //
  // W4: flipped to opt-OUT (was opt-IN). Reflection collection takes ~25s
  // post-disband but disband is async (operator doesn't wait), so the
  // overhead is invisible. With reflections collected on every team, the
  // memory pool grows ~5x faster and pattern memories from auto-learn.ts
  // have peer reflections to anchor against.
  //
  // Toggle: ENSEMBLE_REFLECTION=0 disables. Auto-disabled under vitest
  // (mocked tmux runtime can't satisfy the 25s paste-and-wait — tests
  // would all time out). VITEST is auto-set by the vitest runner.
  const reflectionEnabled =
    process.env['ENSEMBLE_REFLECTION'] !== '0'
    && !process.env['VITEST']
    && process.env['NODE_ENV'] !== 'test'
  if (reflectionEnabled) {
    try {
      await collectAgentReflections(team)
    } catch (err) {
      console.warn(`[Ensemble] Reflection collection failed for ${teamId.slice(0, 8)}:`, err)
    }
  }

  // W7: push this team's accumulated learnings to Cognee KG so
  // cross-project knowledge accumulates beyond the local sqlite store.
  // Fire-and-forget; if Cognee is down or disabled, this is a no-op.
  // ENV gate already enforced by cognee.addKnowledge (returns false fast).
  if (cognee.isEnabled() && !process.env['VITEST'] && process.env['NODE_ENV'] !== 'test') {
    try {
      const teamLearnings = queryMemoriesSemantic(team.description || '', {
        scope: 'global',
        tags: ['reflection', 'failure-pattern', 'confab-pattern', 'resolution'],
        pool: 200,
        limit: 20,
      }).filter(m => m.teamId === teamId)  // only THIS team's writes
      let pushed = 0
      for (const m of teamLearnings) {
        const ok = await cognee.addKnowledge({
          key: `${teamId}:${m.key}`,
          text: m.value,
          tags: m.tags,
          scope: team.workingDirectory ? path.basename(team.workingDirectory) : undefined,
        })
        if (ok) pushed++
      }
      if (pushed > 0) {
        appendMessage(teamId, {
          id: uuidv4(), teamId, from: 'ensemble', to: 'team',
          content: `🌐 Pushed ${pushed} learning(s) to Cognee KG for cross-project recall.`,
          type: 'chat', timestamp: new Date().toISOString(),
          meta: { event: 'kg_writeback', count: pushed },
        })
      }
    } catch (err) {
      console.warn(`[Ensemble] Cognee writeback failed for ${teamId.slice(0, 8)}:`, err)
    }
  }

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

    // W2.5f: completion-confirmed reason gates AUTO-MERGE only.
    // W2.5m: destroy vs preserve is decided per-worktree by the disposition
    // evaluator (see evaluateWorktreeDisposition) — clean trees with no
    // ahead-of-default-branch commits get destroyed regardless of disband
    // reason. Pre-W2.5m, non-completion-confirmed reasons preserved EVERY
    // worktree blindly, accumulating 122 GB of dead trees in production.
    const completionConfirmed = isDisbandCompletionConfirmed(reason)

    // First pass: try merge for completion-confirmed disbands. Track
    // per-agent merge outcomes so the evaluator can mark them as conflict.
    //
    // W4 cross-agent overlap detection: BEFORE any merge runs, scan all
    // agent branches for files-touched-by-2+-agents. If overlap exists,
    // halt auto-merge for those agents (preserve their branches for
    // operator review). Non-overlapping agents merge normally.
    //
    // Production case driving this: 2026-05-04 R35 premium-quad. codex-4
    // committed REVERTS of W1/W2/W3 work in its own worktree. Sequential
    // merge applied claude-1+sonnet-2+codex-3 fine, then codex-4's
    // reverts applied CLEANLY (no conflict — reverts are designed that
    // way) and silently undid the prior merges. Operator had to manually
    // cherry-pick from each branch. Now those four would all be
    // preserved with a structured alert instead.
    const mergeFailedFor = new Set<string>()
    const overlapSkippedAgents = new Set<string>()
    let overlapDetected: CrossAgentOverlap | null = null
    if (completionConfirmed && agentsWithWorktrees.length >= 2) {
      overlapDetected = await detectCrossAgentOverlap(
        agentsWithWorktrees.map(a => ({
          agentName: a.name,
          branch: a.worktreeBranch!,
        })),
        basePath,
      )
      if (overlapDetected) {
        // W5 forward-bias autonomous resolver: classify each overlapping
        // branch by net LOC + revert-commit presence, pick a winner that
        // gets merged, demote losers (reverts or substantially-smaller
        // forward work). Falls back to "preserve all" if no clear winner
        // (close call between two legit forward branches).
        const classifications = await Promise.all(
          overlapDetected.agents.map(name => {
            const a = agentsWithWorktrees.find(x => x.name === name)!
            return classifyAgentBranch(name, a.worktreeBranch!, basePath)
          }),
        )
        const resolution = process.env['ENSEMBLE_AUTONOMOUS_MERGE'] === '0'
          ? null  // operator opted out — always preserve-all on overlap
          : resolveOverlapByForwardBias(classifications)

        const filesPreview = overlapDetected.files.slice(0, 10)
        const filesMore = overlapDetected.files.length > 10
          ? `\n  … (${overlapDetected.files.length - 10} more)`
          : ''

        if (resolution) {
          // Auto-resolved: only losers go into overlapSkippedAgents.
          // Winner falls through to the normal merge pass.
          for (const loser of resolution.losers) {
            overlapSkippedAgents.add(loser.agentName)
          }
          const loserLines = resolution.losers.map(l => `  - ${l.agentName}: ${l.reason}`).join('\n')
          appendMessage(teamId, {
            id: uuidv4(), teamId, from: 'ensemble', to: 'team',
            content: [
              `🤖 Cross-agent overlap auto-resolved (forward-bias rule).`,
              ``,
              `Files touched by 2+ agents:`,
              ...filesPreview.map(f => `  - ${f}`),
              filesMore,
              ``,
              `WINNER (auto-merged): ${resolution.winner}`,
              `  ${resolution.winnerReason}`,
              ``,
              `LOSERS (branch preserved, NOT merged):`,
              loserLines,
              ``,
              `If you disagree with the auto-pick: each loser branch is intact in`,
              `.worktrees/<teamId>-<agent>/. Cherry-pick what you want, or revert the winner.`,
              `Set ENSEMBLE_AUTONOMOUS_MERGE=0 to disable this and always preserve-all on overlap.`,
            ].filter(Boolean).join('\n'),
            type: 'chat', timestamp: new Date().toISOString(),
            meta: {
              event: 'cross_agent_overlap_auto_resolved',
              files: overlapDetected.files,
              winner: resolution.winner,
              winnerReason: resolution.winnerReason,
              losers: resolution.losers,
              fileToAgents: overlapDetected.fileToAgents,
            },
          })
        } else {
          // No clear winner — preserve all (W4 fallback).
          for (const a of overlapDetected.agents) overlapSkippedAgents.add(a)
          const recoveryLines = overlapDetected.agents.map(name => {
            const a = agentsWithWorktrees.find(x => x.name === name)
            return `  - ${name}:  git diff $(git merge-base HEAD ${a?.worktreeBranch}) ${a?.worktreeBranch}`
          }).join('\n')
          appendMessage(teamId, {
            id: uuidv4(), teamId, from: 'ensemble', to: 'team',
            content: [
              `⚠️ Cross-agent overlap with no clear winner — auto-merge SKIPPED for ${overlapDetected.agents.length} agent(s).`,
              ``,
              `Files touched by 2+ agents (revert/overwrite risk):`,
              ...filesPreview.map(f => `  - ${f}`),
              filesMore,
              ``,
              `Why no auto-pick: branches are within 20% LOC of each other OR all contain revert commits.`,
              ``,
              `Branches preserved for operator review:`,
              recoveryLines,
            ].filter(Boolean).join('\n'),
            type: 'chat', timestamp: new Date().toISOString(),
            meta: {
              event: 'cross_agent_overlap',
              files: overlapDetected.files,
              agents: overlapDetected.agents,
              fileToAgents: overlapDetected.fileToAgents,
            },
          })
        }

        // W4 auto-learn: persist a failure-pattern either way so the next
        // team in the same project gets pre-flight warned about overlap-
        // prone files. Fire-and-forget — never block disband on memory write.
        try {
          const { recordFailureLearning } = await import('../lib/auto-learn')
          recordFailureLearning({
            teamId,
            project: team.workingDirectory ? path.basename(team.workingDirectory) : undefined,
            gateId: 'cross-agent-overlap',
            errorSignature: `Files: ${overlapDetected.files.slice(0, 5).join(', ')}. Agents: ${overlapDetected.agents.join(', ')}.${resolution ? ` Auto-resolved: winner=${resolution.winner}.` : ' No auto-resolution.'}`,
            blockers: overlapDetected.files.slice(0, 6),
            iterationsTried: 0,
          })
        } catch (err) {
          console.warn(`[auto-learn] cross-agent-overlap pattern write failed: ${(err as Error).message}`)
        }
      }
    }
    if (completionConfirmed) {
      for (const agent of agentsWithWorktrees) {
        if (overlapSkippedAgents.has(agent.name)) continue  // preserved above
        const worktreeInfo: WorktreeInfo = {
          path: agent.worktreePath!,
          branch: agent.worktreeBranch!,
          agentName: agent.name,
        }
        const result = await mergeWorktree(worktreeInfo, basePath)
        if (!result.success) mergeFailedFor.add(agent.name)
        appendMessage(teamId, {
          id: uuidv4(), teamId, from: 'ensemble', to: 'team',
          content: result.success
            ? `🌳 Merged ${agent.name}'s worktree (${agent.worktreeBranch})`
            : `⚠️ Merge conflict for ${agent.name}: ${result.conflicts?.join(', ')}. Branch ${agent.worktreeBranch} preserved.`,
          type: 'chat', timestamp: new Date().toISOString(),
        })
      }
    } else {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content:
          `🛑 Auto-merge SKIPPED — disband reason "${reason.split(':')[0]}" is not an explicit completion signal. ` +
          `Worktrees with real work preserved; clean ones will be destroyed below.`,
        type: 'chat', timestamp: new Date().toISOString(),
        meta: { event: 'auto_merge_skipped', reason, agentCount: agentsWithWorktrees.length },
      })
    }

    // Second pass: per-worktree disposition evaluator decides destroy vs preserve.
    // Evaluator considers: uncommitted state, commits-ahead-of-default-branch,
    // merge-conflict signal from caller. Reason-agnostic.
    const dispositions = new Map<string, WorktreeDisposition>()
    const conflictedAgents = new Set<string>()  // kept for merge-conflict alert
    const preservedForUncommitted = new Map<string, string>()  // agentName → porcelain
    const preservedForCommits = new Set<string>()  // agentName → has commits-not-merged

    for (const agent of agentsWithWorktrees) {
      const worktreeInfo: WorktreeInfo = {
        path: agent.worktreePath!,
        branch: agent.worktreeBranch!,
        agentName: agent.name,
      }
      // W4: overlap-skipped agents force-preserve. The evaluator would
      // otherwise see "clean state, commits not in default branch" and
      // route them to commits-not-merged preserve — same outcome — but
      // we want the audit trail to say "merge-conflict" semantically
      // since the operator's mental model is "these branches conflict
      // with each other, not just with master."
      if (overlapSkippedAgents.has(agent.name)) {
        dispositions.set(agent.name, { action: 'preserve', why: 'merge-conflict', detail: 'cross-agent overlap' })
        conflictedAgents.add(agent.name)
        console.warn(`[Ensemble] Preserved (cross-agent-overlap): ${agent.name}`)
        continue
      }
      const disposition = await evaluateWorktreeDisposition({
        worktreePath: worktreeInfo.path,
        basePath,
        mergeFailed: mergeFailedFor.has(agent.name),
      })
      dispositions.set(agent.name, disposition)

      if (disposition.action === 'destroy') {
        await destroyWorktree(worktreeInfo, basePath)
        continue
      }
      // preserve — categorize for downstream alerting
      if (disposition.why === 'merge-conflict') {
        conflictedAgents.add(agent.name)
        console.warn(`[Ensemble] Preserved (merge-conflict): ${agent.name}`)
      } else if (disposition.why === 'uncommitted') {
        preservedForUncommitted.set(agent.name, disposition.detail || '(porcelain detail unavailable)')
        console.warn(`[Ensemble] Preserved (uncommitted): ${agent.name}`)
      } else if (disposition.why === 'commits-not-merged') {
        preservedForCommits.add(agent.name)
        console.warn(`[Ensemble] Preserved (commits-not-merged): ${agent.name}`)
      } else {
        // eval-error — treat as conservative preserve
        preservedForCommits.add(agent.name)
        console.warn(`[Ensemble] Preserved (eval-error): ${agent.name} — ${disposition.detail || 'unknown'}`)
      }
    }

    // Surface uncommitted-work preservation as a structured alert with
    // recovery commands. Mirrors the merge-conflict alert design (commit
    // dc3c898) so the operator has one consistent place to look.
    if (preservedForUncommitted.size > 0) {
      const recoveryLines: string[] = []
      for (const [name, porcelain] of preservedForUncommitted) {
        const agent = team.agents.find(a => a.name === name)
        const wpath = agent?.worktreePath ?? '(unknown path)'
        const branch = agent?.worktreeBranch ?? '(unknown branch)'
        const fileLines = porcelain.split('\n').slice(0, 5).map(l => `        ${l}`).join('\n')
        const more = porcelain.split('\n').length > 5 ? `\n        … (${porcelain.split('\n').length - 5} more)` : ''
        recoveryLines.push(
          `  • ${name} → \`${wpath}\`\n` +
          `      branch: \`${branch}\`\n` +
          `      uncommitted:\n${fileLines}${more}\n` +
          `      review:  cd ${wpath} && git diff && git status\n` +
          `      decide:  git stash  OR  git add -A && git commit  OR  git checkout -- .  (discard)\n` +
          `      cleanup: git worktree remove ${wpath}     # when done`
        )
      }
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: [
          `📦 ${preservedForUncommitted.size} worktree${preservedForUncommitted.size === 1 ? '' : 's'} preserved with uncommitted local changes:`,
          ...recoveryLines,
          ``,
          `These were NOT destroyed because the agent left local edits. Review and stash/commit/discard, then remove the worktree.`,
        ].join('\n'),
        type: 'chat', timestamp: new Date().toISOString(),
        meta: {
          event: 'worktree_uncommitted_preserved',
          count: preservedForUncommitted.size,
          agents: [...preservedForUncommitted.keys()],
        },
      })
    }

    // FIX 1: surface merge conflicts (or W2.5f review-required preservations)
    // as a single structured alert. Without this the operator only sees
    // individual per-agent warnings buried in the team feed and can miss
    // preserved branches. We post a recovery checklist + (if Telegram is
    // configured) a push notification.
    // W2.5m: combine merge-conflict + commits-not-merged into single alert.
    // Both classes need operator review (preserved worktree with real branch
    // commits). Distinguished by `why` so the alert can guide right action.
    const reviewAgents = new Set<string>([...conflictedAgents, ...preservedForCommits])
    if (reviewAgents.size > 0) {
      const reviewList = team.agents.filter(a => reviewAgents.has(a.name))
      const recoveryLines = reviewList.map(a => {
        const branch = a.worktreeBranch ?? 'unknown-branch'
        const why = conflictedAgents.has(a.name) ? 'merge-conflict' : 'commits-not-merged'
        return `  • ${a.name} → branch \`${branch}\` (${why})\n` +
               `      git diff master...${branch}\n` +
               `      git merge --no-ff ${branch}     # resolve manually OR\n` +
               `      git cherry-pick <commit>          # pick specific changes`
      }).join('\n')
      // Header / footer phrasing depends on WHY merge was skipped:
      const header = completionConfirmed
        ? `🚧 ${reviewAgents.size} branch${reviewAgents.size === 1 ? '' : 'es'} need review — merge conflict OR commits-not-yet-merged:`
        : `📋 ${reviewAgents.size} branch${reviewAgents.size === 1 ? '' : 'es'} preserved for manual review (no auto-merge — disband reason: "${reason.split(':')[0]}"):`
      const footer = completionConfirmed
        ? [
            ``,
            `Clean worktrees were destroyed automatically. Branches above have real commits — review and merge or discard.`,
            `Once resolved + merged, delete with: \`git branch -D <branch>\``,
          ]
        : [
            ``,
            `Team did NOT explicitly signal [READY-TO-MERGE]. Review each branch above and merge what you trust.`,
            `Clean worktrees with no commits/uncommitted were destroyed automatically (W2.5m).`,
            `Once merged (or discarded), delete with: \`git branch -D <branch>\` and \`git worktree remove <path>\`.`,
          ]
      const summary = [header, recoveryLines, ...footer].join('\n')
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: summary,
        type: 'chat', timestamp: new Date().toISOString(),
        meta: {
          event: 'worktree_review_alert',
          reviewCount: reviewAgents.size,
          conflictedAgents: [...conflictedAgents],
          commitsNotMergedAgents: [...preservedForCommits],
          branches: reviewList.map(a => a.worktreeBranch).filter(Boolean),
        },
      })
      // Telegram push if configured (uses existing TELEGRAM_BOT_TOKEN /
      // TELEGRAM_CHAT_ID env vars; silently skipped otherwise).
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        try {
          const taskShort = (team.description || '').split('\n')[0].slice(0, 80)
          const tgText = [
            `🚧 *${reviewAgents.size} worktree${reviewAgents.size === 1 ? '' : 's'} need review* on team \`${team.id.slice(0, 8)}\``,
            `Task: ${taskShort}`,
            ``,
            ...reviewList.map(a => `\`${a.worktreeBranch}\``),
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

  // W2.5f: post a one-line "collab impact" summary so the operator sees the
  // metrics without having to run team-stats.sh. Aggregates events emitted
  // during the team's lifetime (assumptions, confabs, questions, verify-runner).
  try {
    const allMessages = getMessages(teamId)
    const impact = buildTeamImpactSummary(allMessages)
    if (impact) {
      appendMessage(teamId, {
        id: uuidv4(), teamId, from: 'ensemble', to: 'team',
        content: impact, type: 'chat', timestamp: new Date().toISOString(),
        meta: { event: 'collab_impact_summary' },
      })
    }
  } catch (err) {
    console.error(`[Ensemble] Impact summary failed for ${teamId}:`, err)
  }

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

/**
 * Resolve a pending [QUESTION] with an operator answer. Called by the HTTP
 * endpoint that the Telegram proxy hits on `/answer <questionId> <text>`.
 * Idempotent: returns { resolved: false } if the question id was already
 * answered or expired.
 */
export function answerPendingQuestion(input: AnswerInput): ServiceResult<AnswerResult> {
  const result = answerQuestion(input)
  if (!result.resolved) return { data: result, status: 404 }
  return { data: result, status: 200 }
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
 * W7: rescue a team that has hit auto-fix exhaustion. Spawns ONE fresh-
 * context agent (different program from existing team agents when possible)
 * with prior-team failure-pattern context injected into its prompt. Hard-
 * capped: max 1 rescue per team lifetime — if the rescue itself fails,
 * escalate to operator (don't loop).
 *
 * Why: 17 teams/week pre-W4 hit auto_fix_exhausted and silently waited for
 * an operator who never answered Telegram. W6 added prior-pattern injection
 * into the team feed (~50% rescue rate). W7 closes the remaining gap by
 * spawning a fresh-context agent for cases where the existing agents are
 * mentally stuck and need a clean restart.
 *
 * ENV gate: ENSEMBLE_AUTO_RESCUE_SPAWN=0 disables. Default ON.
 */
export async function rescueFailingTeam(
  teamId: string,
  ctx: { gateId: string; errorContext: string },
): Promise<ServiceResult<{ rescued: boolean; rescueAgentName?: string; reason?: string }>> {
  if (process.env['ENSEMBLE_AUTO_RESCUE_SPAWN'] === '0') {
    return { data: { rescued: false, reason: 'env-disabled' }, status: 200 }
  }
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return { data: { rescued: false, reason: 'test-mode' }, status: 200 }
  }
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  if (team.status !== 'active') {
    return { data: { rescued: false, reason: `team-status-${team.status}` }, status: 200 }
  }
  // Cap: 1 rescue per team
  if (team.agents.some(a => a.name.startsWith('rescue-'))) {
    return { data: { rescued: false, reason: 'rescue-already-spawned' }, status: 200 }
  }
  // Pick a program that's NOT already on the team for genuine fresh context.
  const teamPrograms = new Set(team.agents.map(a => a.program.toLowerCase()))
  const candidates = ['claude', 'sonnet', 'codex', 'haiku']
  const freshProgram = candidates.find(p => !teamPrograms.has(p)) ?? 'claude'
  const rescueName = `rescue-${freshProgram}-${team.agents.length + 1}`
  const cwd = team.workingDirectory ?? process.cwd()

  // Worktree creation — best-effort; failure shouldn't block rescue.
  let worktreePath: string | undefined
  let worktreeBranch: string | undefined
  try {
    const wt = await createWorktree(teamId, rescueName, cwd)
    worktreePath = wt.path
    worktreeBranch = wt.branch
  } catch {
    /* not a git repo or worktree creation failed — proceed in shared dir */
  }

  // Pull prior-team learnings to inject into the rescue prompt.
  const learnings = queryMemoriesSemantic(ctx.errorContext.slice(0, 400), {
    scope: 'global',
    tags: ['failure-pattern', 'resolution', `gate:${ctx.gateId.replace(/[^a-z0-9-]/gi, '_').slice(0, 60)}`],
    pool: 200,
    limit: 5,
  })
  const learningsBlock = learnings.length > 0
    ? learnings.map(m => `  - ${m.key}: ${m.value.slice(0, 250).replace(/\n/g, ' ')}`).join('\n')
    : '  (no prior patterns matched — rely on fresh analysis)'

  const rescuePrompt = [
    `You are ${rescueName}, a fresh-context RESCUE agent in team "${team.name}".`,
    `Existing agents (${team.agents.map(a => a.name).join(', ')}) hit auto-fix exhaustion`,
    `on gate "${ctx.gateId}". Their context is exhausted; you are NOT.`,
    ``,
    `Your job:`,
    `  1. Read the failure context below.`,
    `  2. Apply ONE specific fix from prior team learnings (or, if none match,`,
    `     diagnose freshly and apply your own fix).`,
    `  3. Run team-done when verified.`,
    ``,
    `Failure context (gate output, truncated):`,
    `  ${ctx.errorContext.slice(0, 600).replace(/\n/g, '\n  ')}`,
    ``,
    `Prior team learnings on this gate (apply ONE if it fits):`,
    learningsBlock,
    ``,
    `Constraints (rescue agent rules):`,
    `  - You have ONE attempt. If your fix fails, signal-complete with diagnosis.`,
    `    Do NOT loop the existing agents — they're done.`,
    `  - Cite file:line for every claim — you'll be confab-checked.`,
    `  - Keep team-say brief; existing agents may not respond.`,
    `  - Working directory: ${worktreePath ?? cwd}`,
    ``,
    `team-say:    bash ${path.join(__dirname, '..', 'scripts')}/team-say.sh ${teamId} ${rescueName} team "<message>"`,
    `team-read:   bash ${path.join(__dirname, '..', 'scripts')}/team-read.sh ${teamId}`,
    `team-done:   bash ${path.join(__dirname, '..', 'scripts')}/team-done.sh ${teamId} ${rescueName} "<one-line summary>"`,
    ``,
    `Start NOW. Greet the team via team-say with your rescue plan.`,
  ].join('\n')

  // Persist prompt to disk so spawnLocalAgent + paste can pick it up.
  const promptFile = collabPromptFile(teamId, rescueName)
  try {
    fs.mkdirSync(path.dirname(promptFile), { recursive: true })
    fs.writeFileSync(promptFile, rescuePrompt)
  } catch (err) {
    return { error: `prompt write failed: ${(err as Error).message}`, status: 500 }
  }

  // Spawn the agent.
  let spawned: Awaited<ReturnType<typeof spawnLocalAgent>>
  try {
    spawned = await spawnLocalAgent({
      name: rescueName,
      program: freshProgram,
      workingDirectory: worktreePath ?? cwd,
      hostId: getSelfHostId(),
    })
  } catch (err) {
    return { error: `spawn failed: ${(err as Error).message}`, status: 500 }
  }

  // Wait for CLI ready, then paste prompt. Reuse the existing waitForReady
  // semantics: simple capturePane loop until readyMarker appears.
  const runtime = getRuntime()
  const agentCfg = resolveAgentProgram(freshProgram)
  const readyMarker = agentCfg.readyMarker
  const readyTimeoutMs = parseInt(process.env['ENSEMBLE_READY_TIMEOUT_MS'] || '180000', 10) || 180000
  const start = Date.now()
  let ready = false
  while (Date.now() - start < readyTimeoutMs) {
    try {
      const out = await runtime.capturePane(spawned.sessionName, 50)
      if (out.includes(readyMarker)) { ready = true; break }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  if (!ready) {
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: `❌ Rescue agent ${rescueName} failed to start within ${readyTimeoutMs / 1000}s — escalating to operator.`,
      type: 'chat', timestamp: new Date().toISOString(),
      meta: { event: 'rescue_agent_spawn_failed', name: rescueName },
    })
    return { data: { rescued: false, reason: 'spawn-timeout' }, status: 200 }
  }
  await new Promise(r => setTimeout(r, agentCfg.postReadyDelayMs ?? 2000))

  try {
    if (agentCfg.inputMethod === 'pasteFromFile') {
      await runtime.pasteFromFile(spawned.sessionName, promptFile)
    } else {
      await runtime.sendKeys(spawned.sessionName, rescuePrompt, { literal: true, enter: true })
    }
  } catch (err) {
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: `❌ Rescue prompt injection failed for ${rescueName}: ${(err as Error).message}`,
      type: 'chat', timestamp: new Date().toISOString(),
    })
    return { error: `prompt injection failed: ${(err as Error).message}`, status: 500 }
  }

  // Register the new agent in the team.
  updateTeam(teamId, {
    agents: [
      ...team.agents,
      {
        agentId: spawned.id,
        name: rescueName,
        program: freshProgram,
        role: 'rescue',
        hostId: spawned.hostId,
        status: 'active' as const,
        ...(worktreePath ? { worktreePath, worktreeBranch } : {}),
      },
    ],
  })

  appendMessage(teamId, {
    id: uuidv4(), teamId, from: 'ensemble', to: 'team',
    content: [
      `🆘 Rescue agent ${rescueName} (${freshProgram}) spawned with fresh context.`,
      `Past agents had context-exhaustion on gate "${ctx.gateId}".`,
      `${learnings.length} prior pattern(s) injected into rescue prompt.`,
      `Hard cap: 1 rescue per team. If this fails, operator must intervene.`,
    ].join('\n'),
    type: 'chat', timestamp: new Date().toISOString(),
    meta: {
      event: 'rescue_agent_spawned',
      name: rescueName,
      program: freshProgram,
      gateId: ctx.gateId,
      priorPatternsInjected: learnings.length,
    },
  })

  return {
    data: { rescued: true, rescueAgentName: rescueName },
    status: 200,
  }
}

/**
 * Explicit completion signal from an agent. Replaces the fragile regex-based
 * auto-disband for tasks where agents can deterministically say "I'm done."
 * Posts a structured [SIGNAL_COMPLETE] message so every observer sees it,
 * then disbands the team (no idle-tax, no pattern guessing).
 *
 * Operator-hold guard: if the team was created with holdForOperator=true
 * (either explicit flag or detected keyword in description), the
 * [SIGNAL_COMPLETE] message is still posted but the disband is suppressed.
 * Operator must POST /release-hold or send "/release-hold" / "[/HOLD-OFF]"
 * before another signal-complete will actually disband.
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
  if (team.holdForOperator) {
    appendMessage(teamId, {
      id: uuidv4(), teamId, from: 'ensemble', to: 'team',
      content: [
        `📋 [SIGNAL_COMPLETE] received but team is on operator-hold (reason: ${team.holdReason ?? 'unknown'}).`,
        `Disband suppressed — operator decides when this ends.`,
        `To release: POST /api/ensemble/teams/${teamId}/release-hold OR send "/release-hold" in the team feed.`,
      ].join('\n'),
      type: 'chat', timestamp: new Date().toISOString(),
      meta: {
        event: 'disband_suppressed_by_hold',
        path: 'signal-complete',
        from,
        holdReason: team.holdReason,
      },
    })
    return { data: { team }, status: 200 }
  }
  return disbandTeam(teamId, `signal-complete by ${from}`, {
    triggeredBy: 'signal-complete',
    by: from,
    note: note?.slice(0, 200),
  })
}

/**
 * Release the operator-hold on a team. Once released, future signal-complete
 * and pattern-detected disband paths fire normally. Does NOT trigger an
 * immediate disband — operator must signal-complete or wait for the team's
 * own completion path. Idempotent: releasing a team that has no hold is a no-op.
 */
export async function releaseOperatorHold(
  teamId: string, by: string,
): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const team = getTeam(teamId)
  if (!team) return { error: 'Team not found', status: 404 }
  if (!team.holdForOperator) {
    return { data: { team }, status: 200 }
  }
  const updated = updateTeam(teamId, {
    holdForOperator: false,
    holdReason: undefined,
  })
  appendMessage(teamId, {
    id: uuidv4(), teamId, from: 'ensemble', to: 'team',
    content: `🔓 Operator-hold released by ${by}. Future [SIGNAL_COMPLETE] / [READY-TO-MERGE] / standing-by disbands now fire normally.`,
    type: 'chat', timestamp: new Date().toISOString(),
    meta: { event: 'hold_released', by },
  })
  return { data: { team: updated ?? team }, status: 200 }
}

/**
 * Internal helper. Returns true if the team has an active operator-hold AND
 * logs a structured "would-disband suppressed" event so calibration can count
 * how often the hold actually saves a team. Rate-limited per-team to once per
 * 5 minutes per path so we don't spam the feed every 15s tick.
 */
const lastSuppressLogByTeamPath = new Map<string, number>()
function logHoldSuppression(team: EnsembleTeam, path: string, detail: string): void {
  const key = `${team.id}:${path}`
  const now = Date.now()
  const last = lastSuppressLogByTeamPath.get(key) ?? 0
  if (now - last < 5 * 60 * 1000) return
  lastSuppressLogByTeamPath.set(key, now)
  appendMessage(team.id, {
    id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
    content: `📋 Auto-disband (${path}) suppressed — operator-hold active. ${detail}`,
    type: 'chat', timestamp: new Date().toISOString(),
    meta: { event: 'disband_suppressed_by_hold', path, holdReason: team.holdReason, detail },
  })
}
