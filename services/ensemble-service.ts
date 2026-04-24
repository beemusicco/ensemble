/**
 * Ensemble Service — Standalone
 * No dependency on ai-maestro's agent-registry or agents-core-service.
 * Uses agent-spawner.ts for local/remote agent lifecycle.
 */

import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest, CollabTemplatesFile } from '../types/ensemble'
import {
  createTeam, getTeam, updateTeam, loadTeams,
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
import { queryMemories } from '../lib/memory-store'
import { startSpan, endSpan } from '../lib/tracer'
import { analyzeThinking, pruneAlreadyWarned, getCurrentPhase } from '../lib/thinking-phases'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
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

function parseEnvMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Primary completion path is now the explicit signal-complete endpoint
// (scripts/team-done.sh). These pattern-based thresholds are safety nets
// for runaway sessions and legacy integrations — generous by design.
const SINGLE_SIGNAL_IDLE_THRESHOLD_MS = parseEnvMs('ENSEMBLE_SINGLE_SIGNAL_IDLE_MS', 180_000)
const LOW_CONFIDENCE_IDLE_THRESHOLD_MS = parseEnvMs('ENSEMBLE_LOW_CONF_IDLE_MS', 900_000)

const HIGH_CONFIDENCE_COMPLETION = [
  /\[DONE\]/i,
  /\[COMPLETE\]/i,
  /\[FINISHED\]/i,
  // Staged-workflow phase markers — agents emit these when staged EXEC/VERIFY
  // phases finish. Without them, even a clean staged run waits the full
  // 5-minute LOW_CONFIDENCE idle tax before auto-disband fires.
  /\[EXEC_DONE\]/i,
  /\[VERIFY_DONE\]/i,
]

const LOW_CONFIDENCE_COMPLETION = [
  /(?:^|[^\p{L}\p{N}_])afgerond(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])done(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])complete(?:d)?(?:[^\p{L}\p{N}_]|$)/iu,
  /(?:^|[^\p{L}\p{N}_])klaar(?:[^\p{L}\p{N}_]|$)/iu,
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
    this.idleCheckTimer = setInterval(() => {
      void this.checkIdleTeams()
    }, IDLE_CHECK_INTERVAL_MS)
    this.idleCheckTimer.unref()
    this.watchdog = new AgentWatchdog({
      loadTeams,
      getMessages: (teamId: string) => getMessages(teamId),
      appendMessage,
      disbandTeam: async (teamId: string, _reason: string) => {
        if (this.disbandingTeams.has(teamId)) return
        this.disbandingTeams.add(teamId)
        try {
          await disbandTeam(teamId)
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

      if (this.disbandingTeams.has(team.id)) continue
      if (!this.shouldAutoDisband(team)) continue

      this.disbandingTeams.add(team.id)

      try {
        appendMessage(team.id, {
          id: uuidv4(),
          teamId: team.id,
          from: 'ensemble',
          to: 'team',
          content: 'Auto-disband triggered after 60s idle and completion-like agent messages',
          type: 'chat',
          timestamp: new Date().toISOString(),
        })

        await disbandTeam(team.id)
      } catch (err) {
        console.error(`[Ensemble] Auto-disband failed for ${team.id}:`, err)
      } finally {
        this.disbandingTeams.delete(team.id)
      }
    }
  }

  private shouldAutoDisband(team: EnsembleTeam): boolean {
    const messages = getMessages(team.id)
    const nonEnsembleMessages = messages.filter(message => message.from !== 'ensemble')
    const lastMessage = nonEnsembleMessages[nonEnsembleMessages.length - 1]
    if (!lastMessage) return false

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
    if (highConfSignals.length >= 1 && idleForMs > SINGLE_SIGNAL_IDLE_THRESHOLD_MS) return true

    if (idleForMs <= LOW_CONFIDENCE_IDLE_THRESHOLD_MS) return false
    return completionSignals.length >= 1
  }

  private getCompletionConfidence(content: string): 'high' | 'low' | null {
    if (HIGH_CONFIDENCE_COMPLETION.some(p => p.test(content))) return 'high'
    if (LOW_CONFIDENCE_COMPLETION.some(p => p.test(content))) return 'low'
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

export function buildPromptPreview(params: {
  teamId: string
  teamName: string
  description: string
  agentName: string
  teammateNames: string[]
  agentIndex: number
  templateName?: string
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

  let memoriesBlock = ''
  try {
    const globals = queryMemories({ scope: 'global', limit: 5 })
    if (globals.length) {
      const lines = globals.map(m => {
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

  return [
    memoriesBlock,
    expertBlock,
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

  // Auto-enable worktrees when another collab is active on the same working directory
  const concurrentTeams = getActiveTeamsByWorkingDir(cwd).filter(t => t.id !== team.id)
  const useWorktrees = request.useWorktrees || concurrentTeams.length > 0
  if (concurrentTeams.length > 0 && !request.useWorktrees) {
    appendMessage(team.id, {
      id: uuidv4(), teamId: team.id, from: 'ensemble', to: 'team',
      content: `⚠️ Concurrent collab detected (${concurrentTeams.length} active on same dir) — using git worktrees for isolation`,
      type: 'chat', timestamp: new Date().toISOString(),
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
    const defaultReadyTimeout = Number.parseInt(
      process.env['ENSEMBLE_READY_TIMEOUT_MS'] ?? '120000', 10,
    ) || 120000
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

export async function disbandTeam(teamId: string): Promise<ServiceResult<{ team: EnsembleTeam }>> {
  const span = startSpan('disband_team', { teamId })
  const team = getTeam(teamId)
  if (!team) {
    endSpan(span, {}, 'team_not_found')
    return { error: 'Team not found', status: 404 }
  }
  span.attributes.agentCount = team.agents.length
  span.attributes.createdAt = team.createdAt

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
  }

  const updated = updateTeam(teamId, {
    status: 'disbanded',
    completedAt: new Date().toISOString(),
  })

  // Soft cleanup: remove ephemeral files, keep messages/summary/log, write .finished marker
  try {
    const deliveryDir = path.join(collabRuntimeDir(teamId), 'delivery')
    if (fs.existsSync(deliveryDir)) fs.rmSync(deliveryDir, { recursive: true, force: true })
    for (const f of [collabBridgeResult(teamId), collabBridgePosted(teamId)]) {
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    fs.writeFileSync(collabFinishedMarker(teamId), new Date().toISOString())
  } catch { /* non-fatal cleanup */ }

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
  const allTeams = loadTeams()
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
  return disbandTeam(teamId)
}
