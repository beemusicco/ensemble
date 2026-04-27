import { v4 as uuidv4 } from 'uuid'
import type {
  EnsembleTeam,
  EnsembleTeamAgent,
  StagedWorkflowConfig,
} from '../types/ensemble'
import { appendMessage, getMessages } from './ensemble-registry'
import { getRuntime, SessionGoneError } from './agent-runtime'
import { resolveAgentProgram } from './agent-config'
import { collabDeliveryFile } from './collab-paths'
import { isSelf, getHostById } from './hosts-config'
import { postRemoteSessionCommand } from './agent-spawner'
import fs from 'fs'
import path from 'path'

const DEFAULT_PLAN_TIMEOUT_MS = 120_000
const DEFAULT_EXEC_TIMEOUT_MS = 300_000
const DEFAULT_VERIFY_TIMEOUT_MS = 120_000
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_MAX_FIX_ITERATIONS = 2

// VERIFY-phase NO-GO detection. When agents complete VERIFY but flag the
// implementation as not approved (gate failed, blockers identified), we want
// to loop back into EXEC with the blockers list so the team self-resolves
// instead of stalling in a polite-ack loop until watchdog kills it.
//
// Patterns are deliberately strict — only count a NO-GO when the message
// uses the formal verdict language ("NO-GO", "NOT APPROVED", "verify failed").
// Casual mentions of "blocker" or "fail" mid-prose don't trigger the loop.
const NO_GO_PATTERNS = [
  /\bNO[-_ ]GO\b/i,
  /\bNOT[-_ ]APPROVED\b/i,
  /\bverify[: ]+failed\b/i,
  /\bgate[: ]+(failed|fail|reject(ed)?)\b/i,
  /\b(verify|review)[: ]+(reject(ed)?|denied)\b/i,
  /\[NO[-_ ]GO\]/i,
  /\[REJECTED\]/i,
]
function hasNoGoMarker(content: string): boolean {
  return NO_GO_PATTERNS.some(p => p.test(content))
}

const PLAN_HIGH_CONFIDENCE = /\[PLAN_READY\]/
const EXEC_HIGH_CONFIDENCE = /\[EXEC_DONE\]/
const VERIFY_HIGH_CONFIDENCE = /\[VERIFY_DONE\]/

const PLAN_LOW_CONFIDENCE_PATTERNS = [
  /\bplan\b/i,
  /\bstrateg/i,
  /\bapproach\b/i,
  /\bstappen\b/i,
  /\baanpak\b/i,
  /\bvoorstel\b/i,
  /\bready\b/i,
  /\bklaar\b/i,
]

const EXEC_LOW_CONFIDENCE_PATTERNS = [
  /\bdone\b/i,
  /\bcomplete(?:d)?\b/i,
  /\bafgerond\b/i,
  /\bklaar\b/i,
  /\bfinished\b/i,
  /\bimplemented\b/i,
  /\bgeïmplementeerd\b/i,
]

type MatchConfidence = 'high' | 'low' | 'none'

function matchPlanSignal(content: string): MatchConfidence {
  if (PLAN_HIGH_CONFIDENCE.test(content)) return 'high'
  if (PLAN_LOW_CONFIDENCE_PATTERNS.some(p => p.test(content))) return 'low'
  return 'none'
}

function matchExecSignal(content: string): MatchConfidence {
  if (EXEC_HIGH_CONFIDENCE.test(content)) return 'high'
  if (EXEC_LOW_CONFIDENCE_PATTERNS.some(p => p.test(content))) return 'low'
  return 'none'
}

type ActiveAgent = Pick<EnsembleTeamAgent, 'name' | 'program' | 'hostId' | 'status'>

interface PromptContext {
  agent: ActiveAgent
  teammates: string[]
  index: number
}

interface StagedWorkflowManagerOptions {
  team: EnsembleTeam
  config?: StagedWorkflowConfig
  buildPlanPrompt?: (context: PromptContext) => string
  buildExecPrompt?: (context: PromptContext) => string
  buildVerifyPrompt?: (context: PromptContext & { teammateToReview?: string }) => string
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

function resolveConfig(config?: StagedWorkflowConfig): Required<StagedWorkflowConfig> {
  return {
    planTimeoutMs: config?.planTimeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS,
    execTimeoutMs: config?.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    verifyTimeoutMs: config?.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    pollIntervalMs: config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxFixIterations: config?.maxFixIterations ?? DEFAULT_MAX_FIX_ITERATIONS,
  }
}

function defaultPlanPrompt({ teammates }: PromptContext): string {
  return [
    `⏳ PHASE 1 — PLAN ONLY.`,
    `Do NOT write code or edit files yet.`,
    `Create a concrete implementation plan and share it with ${teammates.join(', ')} via team-say.`,
    `Include [PLAN_READY] in your message when you have shared your plan.`,
  ].join(' ')
}

function defaultExecPrompt({ teammates }: PromptContext): string {
  return [
    `🚀 PHASE 2 — EXECUTE.`,
    `You may now implement the agreed plan.`,
    `Keep ${teammates.join(', ')} updated via team-say.`,
    `Include [EXEC_DONE] in your message when your execution work is complete.`,
  ].join(' ')
}

function defaultVerifyPrompt({ teammateToReview }: PromptContext & { teammateToReview?: string }): string {
  return [
    `🔍 PHASE 3 — VERIFY.`,
    `Review ${teammateToReview || 'your teammate'}'s work.`,
    `Share findings via team-say and include [VERIFY_DONE] when done.`,
  ].join(' ')
}

export class StagedWorkflowManager {
  private readonly config: Required<StagedWorkflowConfig>
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => Date
  private readonly agents: ActiveAgent[]
  private messageCursor: string | undefined

  constructor(private readonly options: StagedWorkflowManagerOptions) {
    this.config = resolveConfig(options.config)
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = options.now || (() => new Date())
    this.agents = options.team.agents.filter(agent => agent.status === 'active')
  }

  async run(): Promise<void> {
    if (this.agents.length < 2) {
      this.log('plan', 'Staged workflow requires at least 2 active agents')
      return
    }

    this.log('plan', 'Starting PLAN phase — agents may only plan and coordinate')
    const planStartedAt = this.now().toISOString()
    await this.deliverPhasePrompts('plan', this.agents.map((agent, index) => () => this.deliverPlanPrompt(agent, index)))

    const planResult = await this.waitForConditionOrTimeout(
      () => this.agentsSharedPlans(planStartedAt),
      this.config.planTimeoutMs,
      () => this.agentsSharedPlansLowConfidence(planStartedAt),
    )
    this.log(
      'plan',
      planResult === 'condition'
        ? 'All agents shared their plans (high confidence [PLAN_READY]) — advancing to EXEC'
        : planResult === 'fallback'
          ? 'All agents likely shared plans (low confidence, old-style match) — advancing to EXEC'
          : `PLAN phase timed out after ${Math.round(this.config.planTimeoutMs / 1000)}s — advancing to EXEC`,
    )

    const plannedAgents = planResult === 'timeout'
      ? this.agentsWhoSignaled(planStartedAt, matchPlanSignal)
      : new Set(this.agentNames())
    const slowPlanAgents = this.agentNames().filter(n => !plannedAgents.has(n))
    if (planResult === 'timeout' && slowPlanAgents.length > 0) {
      this.log('plan', `Completed: [${[...plannedAgents].join(', ')}]. Timed out: [${slowPlanAgents.join(', ')}].`)
    }

    this.resetCursor()

    this.log('exec', 'Starting EXEC phase — agents may now implement')
    const execStartedAt = this.now().toISOString()
    await this.deliverPhasePrompts('exec', this.agents.map((agent, index) => async () => {
      if (slowPlanAgents.includes(agent.name)) {
        const teammates = this.agentNames().filter(name => name !== agent.name)
        const base = (this.options.buildExecPrompt || defaultExecPrompt)({ agent, teammates, index })
        await this.deliverToAgent(agent,
          `⚠️ PLAN phase timed out. Your teammates shared plans already. Review via team-read before implementing.\n\n${base}`)
      } else {
        await this.deliverExecPrompt(agent, index)
      }
    }))

    const execResult = await this.waitForConditionOrTimeout(
      () => this.agentsCompletedExec(execStartedAt),
      this.config.execTimeoutMs,
      () => this.agentsCompletedExecLowConfidence(execStartedAt),
    )
    this.log(
      'exec',
      execResult === 'condition'
        ? 'All agents completed implementation (high confidence [EXEC_DONE]) — advancing to VERIFY'
        : execResult === 'fallback'
          ? 'All agents likely completed (low confidence, old-style match) — advancing to VERIFY'
          : `EXEC phase timed out after ${Math.round(this.config.execTimeoutMs / 1000)}s — advancing to VERIFY`,
    )

    const execCompletedAgents = execResult === 'timeout'
      ? this.agentsWhoSignaled(execStartedAt, matchExecSignal)
      : new Set(this.agentNames())
    const slowExecAgents = this.agentNames().filter(n => !execCompletedAgents.has(n))
    if (execResult === 'timeout' && slowExecAgents.length > 0) {
      this.log('exec', `Completed: [${[...execCompletedAgents].join(', ')}]. Timed out: [${slowExecAgents.join(', ')}].`)
    }

    this.resetCursor()

    this.log('verify', 'Starting VERIFY phase — agents review each other\'s work')
    let verifyStartedAt = this.now().toISOString()
    await this.deliverPhasePrompts('verify', this.agents.map((agent, index) => async () => {
      if (slowExecAgents.includes(agent.name)) {
        const teammates = this.agentNames().filter(name => name !== agent.name)
        const base = (this.options.buildVerifyPrompt || defaultVerifyPrompt)({
          agent, teammates, teammateToReview: teammates[0], index,
        })
        await this.deliverToAgent(agent,
          `⚠️ EXEC phase timed out. Your teammates completed implementation. Check their work before reviewing.\n\n${base}`)
      } else {
        await this.deliverVerifyPrompt(agent, index)
      }
    }))

    if (this.config.verifyTimeoutMs > 0) {
      const verifyResult = await this.waitForConditionOrTimeout(
        () => this.agentsCompletedVerify(verifyStartedAt),
        this.config.verifyTimeoutMs,
      )
      this.log(
        'verify',
        verifyResult === 'condition'
          ? 'All agents completed verification ([VERIFY_DONE])'
          : `VERIFY phase window elapsed after ${Math.round(this.config.verifyTimeoutMs / 1000)}s`,
      )
    }

    // Auto-fix loop: when VERIFY concludes NO-GO, re-run EXEC + VERIFY with
    // the blockers list so the team self-resolves instead of stalling in a
    // polite-ack loop until watchdog kills it. Bounded to maxFixIterations.
    for (let iter = 1; iter <= this.config.maxFixIterations; iter++) {
      const verifyMessages = this.collectAgentMessagesSince(verifyStartedAt)
      const noGoSignals = verifyMessages.filter(m => hasNoGoMarker(m.content))
      if (noGoSignals.length === 0) break  // verified clean — exit cleanly

      const blockersBlock = this.summarizeBlockers(verifyMessages)
      this.log(
        'exec',
        `🔧 VERIFY concluded NO-GO (${noGoSignals.length} signal${noGoSignals.length === 1 ? '' : 's'} from ${[...new Set(noGoSignals.map(m => m.from))].join(', ')}) — entering FIX iteration ${iter}/${this.config.maxFixIterations}`,
      )

      this.resetCursor()
      const fixExecStartedAt = this.now().toISOString()
      await this.deliverPhasePrompts('exec', this.agents.map((agent, index) => async () => {
        const teammates = this.agentNames().filter(name => name !== agent.name)
        const base = (this.options.buildExecPrompt || defaultExecPrompt)({ agent, teammates, index })
        await this.deliverToAgent(
          agent,
          `🔧 FIX iteration ${iter}/${this.config.maxFixIterations} — VERIFY found blockers. Address them now, then emit [EXEC_DONE].\n\n` +
          `BLOCKERS FROM VERIFY:\n${blockersBlock}\n\n${base}`,
        )
      }))
      await this.waitForConditionOrTimeout(
        () => this.agentsCompletedExec(fixExecStartedAt),
        this.config.execTimeoutMs,
        () => this.agentsCompletedExecLowConfidence(fixExecStartedAt),
      )

      this.resetCursor()
      verifyStartedAt = this.now().toISOString()
      this.log('verify', `Re-running VERIFY after FIX iteration ${iter}/${this.config.maxFixIterations}`)
      await this.deliverPhasePrompts('verify', this.agents.map((agent, index) => async () => {
        const teammates = this.agentNames().filter(name => name !== agent.name)
        const base = (this.options.buildVerifyPrompt || defaultVerifyPrompt)({
          agent, teammates, teammateToReview: teammates[0], index,
        })
        await this.deliverToAgent(
          agent,
          `🔁 RE-VERIFY ${iter}/${this.config.maxFixIterations} — confirm the fix landed. Emit [VERIFY_DONE] with explicit GO or NO-GO verdict.\n\n${base}`,
        )
      }))
      if (this.config.verifyTimeoutMs > 0) {
        await this.waitForConditionOrTimeout(
          () => this.agentsCompletedVerify(verifyStartedAt),
          this.config.verifyTimeoutMs,
        )
      }
    }

    // After the loop, if STILL NO-GO post the final escalation marker so the
    // user / external observer sees that the team exhausted its auto-fix
    // budget without converging. We do not disband here — let the normal
    // signal-complete or watchdog handle the actual close.
    if (this.config.maxFixIterations > 0) {
      const finalVerifyMessages = this.collectAgentMessagesSince(verifyStartedAt)
      const stillNoGo = finalVerifyMessages.filter(m => hasNoGoMarker(m.content))
      if (stillNoGo.length > 0) {
        appendMessage(this.options.team.id, {
          id: uuidv4(),
          teamId: this.options.team.id,
          from: 'ensemble',
          to: 'team',
          content: `🚧 Auto-fix budget exhausted after ${this.config.maxFixIterations} iteration(s) — VERIFY still NO-GO. Team standing by for human direction or signal-complete.`,
          type: 'chat',
          timestamp: this.now().toISOString(),
          meta: {
            event: 'auto_fix_exhausted',
            iterations: this.config.maxFixIterations,
            noGoSenders: [...new Set(stillNoGo.map(m => m.from))],
          },
        })
      }
    }
  }

  private collectAgentMessagesSince(sinceTimestamp: string): ReturnType<typeof getMessages> {
    const all = getMessages(this.options.team.id, sinceTimestamp)
    const agentNames = new Set(this.agentNames())
    return all.filter(m => agentNames.has(m.from))
  }

  private summarizeBlockers(verifyMessages: ReturnType<typeof getMessages>): string {
    // Pull lines that look like blocker enumerations from each verify-phase
    // message. Heuristic: lines starting with a marker (•, *, -, 1.) OR
    // containing "blocker" / "no-go" / "fail" / "reject". Cap to 12 entries
    // so the FIX prompt stays readable.
    const lines: string[] = []
    for (const m of verifyMessages) {
      if (!hasNoGoMarker(m.content)) continue
      for (const raw of m.content.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        if (/^[•*\-]\s+/.test(line) || /^\d+[.)]\s+/.test(line) || /\b(blocker|no[-_ ]go|fail(ed)?|reject(ed)?|unfixed|missing|broken)\b/i.test(line)) {
          lines.push(`  ${line}`)
        }
        if (lines.length >= 12) break
      }
      if (lines.length >= 12) break
    }
    if (lines.length === 0) return '  (no structured blockers extracted — re-read the most recent VERIFY messages via team-read for context)'
    return lines.join('\n')
  }

  /**
   * Deliver one phase's prompts to all agents in parallel using allSettled.
   * Previously we used Promise.all, which meant ONE agent's session-gone error
   * (typical when watchdog/team-done disbands mid-phase) rejected the whole
   * phase delivery — the staged-workflow then crashed with "Staged workflow
   * failed for X" and the surviving agents were stranded with the previous
   * phase's prompt while their teammates moved on.
   *
   * allSettled lets each agent's delivery succeed or fail independently.
   * SessionGoneError is already caught + logged in deliverToAgent, so a
   * rejection here means a real unexpected error — we re-throw the FIRST one
   * after the phase finishes so the caller sees a real failure (not a swallow).
   */
  private async deliverPhasePrompts(
    phase: 'plan' | 'exec' | 'verify',
    deliverers: Array<() => Promise<void>>,
  ): Promise<void> {
    const results = await Promise.allSettled(deliverers.map(d => d()))
    const realFailures = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === 'rejected')
    if (realFailures.length > 0) {
      const reasons = realFailures
        .map(({ r, i }) => `agent[${i}]: ${(r as PromiseRejectedResult).reason}`)
        .join('; ')
      this.log(phase, `Phase ${phase.toUpperCase()} delivery had ${realFailures.length} unexpected failure(s): ${reasons}`)
      throw (realFailures[0].r as PromiseRejectedResult).reason
    }
  }

  private async deliverPlanPrompt(agent: ActiveAgent, index: number): Promise<void> {
    const teammates = this.agentNames().filter(name => name !== agent.name)
    const prompt = (this.options.buildPlanPrompt || defaultPlanPrompt)({ agent, teammates, index })
    await this.deliverToAgent(agent, prompt)
  }

  private async deliverExecPrompt(agent: ActiveAgent, index: number): Promise<void> {
    const teammates = this.agentNames().filter(name => name !== agent.name)
    const prompt = (this.options.buildExecPrompt || defaultExecPrompt)({ agent, teammates, index })
    await this.deliverToAgent(agent, prompt)
  }

  private async deliverVerifyPrompt(agent: ActiveAgent, index: number): Promise<void> {
    const teammates = this.agentNames().filter(name => name !== agent.name)
    const prompt = (this.options.buildVerifyPrompt || defaultVerifyPrompt)({
      agent,
      teammates,
      teammateToReview: teammates[0],
      index,
    })
    await this.deliverToAgent(agent, prompt)
  }

  private async deliverToAgent(agent: ActiveAgent, text: string): Promise<void> {
    const sessionName = `${this.options.team.name}-${agent.name}`
    const runtime = getRuntime()

    if (agent.hostId && !isSelf(agent.hostId)) {
      const host = getHostById(agent.hostId)
      if (host) {
        try {
          await postRemoteSessionCommand(host.url, sessionName, text)
        } catch (err) {
          this.logSessionGoneOrRethrow(agent.name, err)
        }
      }
      return
    }

    const agentCfg = resolveAgentProgram(agent.program)
    try {
      if (agentCfg.inputMethod === 'pasteFromFile') {
        const tmpFile = collabDeliveryFile(this.options.team.id, sessionName)
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true })
        fs.writeFileSync(tmpFile, text)
        await runtime.pasteFromFile(sessionName, tmpFile)
        return
      }
      await runtime.sendKeys(sessionName, text, { literal: true, enter: true })
    } catch (err) {
      this.logSessionGoneOrRethrow(agent.name, err)
    }
  }

  /**
   * Race between staged-workflow phase delivery and team disband: by the time
   * we run paste-buffer, the agent's tmux session may already be killed. Treat
   * SessionGoneError as a benign skip (log a structured warning so it surfaces
   * in the team feed but doesn't tank the phase delivery for the other agents).
   * Real errors still propagate.
   */
  private logSessionGoneOrRethrow(agentName: string, err: unknown): void {
    const isSessionGone =
      err instanceof SessionGoneError ||
      (err instanceof Error && /can't find pane|no such session|session not found/i.test(err.message))
    if (!isSessionGone) throw err
    appendMessage(this.options.team.id, {
      id: uuidv4(),
      teamId: this.options.team.id,
      from: 'ensemble',
      to: 'team',
      content: `⚠️ Skipped phase prompt delivery to ${agentName} — session already gone (team disbanded mid-flight)`,
      type: 'chat',
      timestamp: this.now().toISOString(),
    })
  }

  private resetCursor(): void {
    this.messageCursor = undefined
    this.messageCache = []
    this.messageCacheIds.clear()
  }

  /**
   * Fetch messages incrementally using a cursor (consistent with monitor.ts).
   * On first call for a phase, uses sinceTimestamp. Subsequent polls advance
   * the cursor to the latest message timestamp to avoid re-reading old data.
   */
  private fetchMessagesSince(sinceTimestamp: string): ReturnType<typeof getMessages> {
    const since = this.messageCursor ?? sinceTimestamp
    const messages = getMessages(this.options.team.id, since)
    if (messages.length > 0) {
      this.messageCursor = messages[messages.length - 1].timestamp
    }
    return messages
  }

  private messageCache: ReturnType<typeof getMessages> = []
  private messageCacheIds = new Set<string>()

  private appendToCache(messages: ReturnType<typeof getMessages>): void {
    for (const m of messages) {
      const key = m.id || `${m.from}:${m.timestamp}`
      if (!this.messageCacheIds.has(key)) {
        this.messageCacheIds.add(key)
        this.messageCache.push(m)
      }
    }
  }

  private agentsSharedPlans(sinceTimestamp: string): boolean {
    const newMessages = this.fetchMessagesSince(sinceTimestamp)
    this.appendToCache(newMessages)
    return this.agentNames().every(name =>
      this.messageCache.some(message =>
        message.from === name && matchPlanSignal(message.content) === 'high'
      ),
    )
  }

  private agentsSharedPlansLowConfidence(sinceTimestamp: string): boolean {
    const newMessages = this.fetchMessagesSince(sinceTimestamp)
    this.appendToCache(newMessages)
    return this.agentNames().every(name =>
      this.messageCache.some(message =>
        message.from === name && matchPlanSignal(message.content) !== 'none'
      ),
    )
  }

  private agentsCompletedExec(sinceTimestamp: string): boolean {
    const newMessages = this.fetchMessagesSince(sinceTimestamp)
    this.appendToCache(newMessages)
    return this.agentNames().every(name =>
      this.messageCache.some(message =>
        message.from === name && matchExecSignal(message.content) === 'high'
      ),
    )
  }

  private agentsCompletedExecLowConfidence(sinceTimestamp: string): boolean {
    const newMessages = this.fetchMessagesSince(sinceTimestamp)
    this.appendToCache(newMessages)
    return this.agentNames().every(name =>
      this.messageCache.some(message =>
        message.from === name && matchExecSignal(message.content) !== 'none'
      ),
    )
  }

  private agentsCompletedVerify(sinceTimestamp: string): boolean {
    const newMessages = this.fetchMessagesSince(sinceTimestamp)
    this.appendToCache(newMessages)
    return this.agentNames().every(name =>
      this.messageCache.some(message =>
        message.from === name && VERIFY_HIGH_CONFIDENCE.test(message.content)
      ),
    )
  }

  private agentsWhoSignaled(sinceTimestamp: string, matcher: (content: string) => MatchConfidence): Set<string> {
    const completed = new Set<string>()
    for (const name of this.agentNames()) {
      if (this.messageCache.some(m => m.from === name && matcher(m.content) !== 'none')) {
        completed.add(name)
      }
    }
    return completed
  }

  private async waitForConditionOrTimeout(
    check: () => boolean,
    timeoutMs: number,
    fallbackCheck?: () => boolean,
  ): Promise<'condition' | 'fallback' | 'timeout'> {
    const deadline = this.now().getTime() + timeoutMs
    while (this.now().getTime() < deadline) {
      if (check()) return 'condition'
      await this.sleep(this.config.pollIntervalMs)
    }
    if (fallbackCheck?.()) return 'fallback'
    return 'timeout'
  }

  private log(phase: 'plan' | 'exec' | 'verify', content: string): void {
    appendMessage(this.options.team.id, {
      id: uuidv4(),
      teamId: this.options.team.id,
      from: 'ensemble',
      to: 'team',
      content: `[Staged/${phase.toUpperCase()}] ${content}`,
      type: 'chat',
      timestamp: this.now().toISOString(),
    })
  }

  private agentNames(): string[] {
    return this.agents.map(agent => agent.name)
  }
}

export async function runStagedWorkflow(
  team: EnsembleTeam,
  config?: StagedWorkflowConfig,
  promptBuilders?: Pick<StagedWorkflowManagerOptions, 'buildPlanPrompt' | 'buildExecPrompt' | 'buildVerifyPrompt'>,
): Promise<void> {
  const manager = new StagedWorkflowManager({
    team,
    config,
    ...promptBuilders,
  })
  await manager.run()
}
