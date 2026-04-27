export interface EnsembleTeam {
  id: string
  name: string
  description: string
  status: 'forming' | 'active' | 'paused' | 'completed' | 'disbanded' | 'failed'
  agents: EnsembleTeamAgent[]
  createdBy: string
  createdAt: string
  completedAt?: string
  feedMode: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  result?: EnsembleTeamResult
}

export interface EnsembleTeamAgent {
  agentId: string
  name: string
  program: string
  role: string
  hostId: string
  status: 'spawning' | 'active' | 'idle' | 'done' | 'failed'
  worktreePath?: string
  worktreeBranch?: string
}

export interface EnsembleTeamResult {
  summary: string
  decisions: string[]
  discoveries: string[]
  filesChanged: string[]
  duration: number
}

export type ThinkingPhase = 'frame' | 'evidence' | 'synthesis' | 'action' | 'verify' | 'reflect'

export type EnsembleMessageType =
  | 'chat'
  | 'decision'
  | 'question'
  | 'result'
  // Thinking-mode structured messages:
  | 'phase'         // phase transition marker, content = ThinkingPhase name
  | 'hypothesis'    // unverified claim; meta holds {id, confidence}
  | 'evidence'      // data supporting a hypothesis; meta holds {hypothesisId, source}
  | 'decision_pick' // formal pick; meta holds {hypothesisId, dissents}
  | 'challenge'     // why a claim might be wrong; meta holds {targetId}
  | 'reflect'       // learning to persist; meta holds {tags}
  | 'supervisor_warning' // programmatic supervisor flag

export interface EnsembleMessage {
  id: string
  teamId: string
  from: string
  to: string
  content: string
  type: EnsembleMessageType
  timestamp: string
  options?: string[]
  meta?: Record<string, unknown>
}

export interface CreateTeamRequest {
  name: string
  description: string
  agents: Array<{
    program: string
    role?: string
    hostId?: string
  }>
  feedMode?: 'silent' | 'summary' | 'live'
  workingDirectory?: string
  templateName?: string
  useWorktrees?: boolean
  staged?: boolean
  stagedConfig?: StagedWorkflowConfig
  challengeMode?: ChallengeMode
}

/**
 * How aggressively agents challenge each other in the team feed.
 * - normal:    constructive evidence-based discussion (default)
 * - rigorous:  every claim demands evidence; polite-acks discouraged
 * - sparring:  full adversarial — polite-acks BANNED, every message must
 *              add evidence, propose a counter, find a flaw, or ship an
 *              artifact. Use for high-stakes / security / debug work.
 */
export type ChallengeMode = 'normal' | 'rigorous' | 'sparring'

export type StagedPhase = 'plan' | 'exec' | 'verify'

export interface StagedWorkflowConfig {
  planTimeoutMs?: number   // Max time for PLAN phase before auto-advancing (default: 120000 = 2min)
  execTimeoutMs?: number   // Max time for EXEC phase before auto-advancing (default: 300000 = 5min)
  verifyTimeoutMs?: number // Max time for VERIFY phase before completing (default: 120000 = 2min)
  pollIntervalMs?: number  // How often to check for phase completion (default: 5000 = 5s)
  // Auto-fix loop: when VERIFY concludes NO-GO, run another EXEC + VERIFY
  // pair with the blockers list. Bounded to maxFixIterations (default 2) to
  // prevent runaway loops; after the cap an escalation message lands in the
  // team feed so the user / watchdog can take it from there.
  maxFixIterations?: number  // 0 disables auto-fix entirely (default: 2)
}

export interface CollabTemplateRole {
  role: string
  focus: string
  expert?: string
}

export interface CollabTemplate {
  name: string
  description: string
  suggestedTaskPrefix: string
  roles: CollabTemplateRole[]
}

export interface CollabTemplatesFile {
  templates: Record<string, CollabTemplate>
}
