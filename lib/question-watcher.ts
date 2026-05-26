/**
 * [QUESTION: X] watcher — Telegram passthrough to operator.
 *
 * When an agent emits `[QUESTION: X]`, the watcher:
 *   1. Posts X to the operator's Telegram (with team-id + agent + answer
 *      instructions: `/answer <team-id-prefix> <text>`)
 *   2. Tracks the pending question in-memory with timestamp
 *   3. Posts `🟡 awaiting answer (5min timeout)` into the team feed
 *   4. On each tick, expires unanswered questions: posts `🟡 timed out —
 *      proceed with best-effort` so the team isn't blocked indefinitely
 *
 * Operator answers are routed back via the `/api/ensemble/answer` endpoint
 * (called from telegram-commands proxy.js's `/answer` handler). When an
 * answer arrives, we resolve the matching pending question, post the
 * operator's message into the team feed, and remove from pending.
 *
 * Per-(team, claim, agent) dedupe so a re-emitted question doesn't ping the
 * operator twice. Pending state is process-local — server restart loses the
 * pending list but the team-feed messages persist.
 */

import { v4 as uuidv4 } from 'uuid'
import type { EnsembleMessage } from '../types/ensemble'
import { appendMessage, getMessages } from './ensemble-registry'
import { sendTelegramMessage, getTelegramToken } from './telegram-out'
import { findTags } from './tag-parser'

const QUESTION_BODY_MAX = 600
const DEFAULT_TIMEOUT_MS = 120 * 60_000  // 2 hours — operator works async (was 5min/W3 spec; 0/23 reply rate proved 5min unrealistic)

interface PendingQuestion {
  questionId: string  // short, used as the /answer correlation token
  teamId: string
  agent: string
  claim: string
  postedAt: number
  telegramMessageId?: number
}

const pendingByTeam = new Map<string, PendingQuestion[]>()
const pingedKeys = new Set<string>()  // (team, normalized claim, agent) → already pinged

function normalizeClaim(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

function shortQuestionId(): string {
  // 6 hex chars from a fresh uuid — short enough for the operator to type
  // but unique within a process lifetime.
  return uuidv4().replace(/-/g, '').slice(0, 6)
}

/**
 * W2.5g: hydrate pingedKeys from existing `question_pending` events in the
 * team feed. Process-local Set is wiped on every server restart, which
 * caused massive Telegram spam (production case 684b61fb, 2026-05-01: 7
 * unique questions → 40 Telegram messages because each restart re-scanned
 * the whole feed and re-pinged everything). The feed itself is the durable
 * source of truth — every question we've ever pinged left a `question_pending`
 * event there, so deriving the cache from feed makes restart idempotent.
 */
function hydrateCacheFromFeed(messages: EnsembleMessage[]): void {
  for (const m of messages) {
    const meta = (m.meta || {}) as Record<string, unknown>
    if (meta.event !== 'question_pending') continue
    const agent = meta.agent as string | undefined
    const claim = meta.claim as string | undefined
    if (!agent || !claim) continue
    pingedKeys.add(`${m.teamId}::${normalizeClaim(claim)}::${agent}`)
  }
}

function extractQuestions(messages: EnsembleMessage[]): Array<{ agent: string; claim: string; cacheKey: string; teamId: string }> {
  const found: Array<{ agent: string; claim: string; cacheKey: string; teamId: string }> = []
  // W2.5g: also dedupe WITHIN this scan — if the same agent emits the same
  // [QUESTION:] tag in multiple messages (or the same message references it
  // multiple times), only the first occurrence counts. Without this, the
  // global pingedKeys check happens BEFORE the loop adds new entries, so
  // multiple messages with identical tags all flow through.
  const seenInScan = new Set<string>()
  for (const m of messages) {
    if (!m.from || m.from === 'ensemble' || m.from === 'system' || m.from === 'operator') continue
    if (!m.content) continue
    const tags = findTags(m.content, 'QUESTION', { maxBodyChars: QUESTION_BODY_MAX })
    for (const t of tags) {
      const claim = t.body
      if (!claim) continue
      const cacheKey = `${m.teamId}::${normalizeClaim(claim)}::${m.from}`
      if (pingedKeys.has(cacheKey)) continue
      if (seenInScan.has(cacheKey)) continue
      seenInScan.add(cacheKey)
      found.push({ agent: m.from, claim, cacheKey, teamId: m.teamId })
    }
  }
  return found
}

/**
 * Per-tick scan + dispatch. Caller invokes this from checkIdleTeams.
 * Returns the count of NEWLY pinged questions (not including timeouts).
 */
export async function scanAndDispatchQuestions(
  teamId: string,
  sinceTimestamp?: string,
): Promise<number> {
  const messages = getMessages(teamId, sinceTimestamp)
  // W2.5g: hydrate pingedKeys from existing question_pending events in the
  // feed BEFORE extracting new questions. This survives server restart so
  // the same agent message doesn't re-ping every restart.
  hydrateCacheFromFeed(messages)
  const questions = extractQuestions(messages)
  let pinged = 0

  // ── Phase 1: dispatch new questions to operator ────────────────────
  for (const q of questions) {
    pingedKeys.add(q.cacheKey)
    const questionId = shortQuestionId()
    const teamPrefix = teamId.slice(0, 8)

    const tgText = [
      `🟡 ensemble question`,
      `team: ${teamPrefix}  agent: ${q.agent}`,
      ``,
      q.claim,
      ``,
      `Reply: /answer ${questionId} <your-answer>`,
    ].join('\n')

    let telegramMessageId: number | undefined
    if (getTelegramToken()) {
      const sent = await sendTelegramMessage(tgText)
      if (sent.ok) telegramMessageId = sent.messageId
      else console.warn(`[Ensemble] Telegram send failed for ${questionId}: ${sent.error}`)
    }

    const pending: PendingQuestion = {
      questionId,
      teamId,
      agent: q.agent,
      claim: q.claim,
      postedAt: Date.now(),
      telegramMessageId,
    }
    if (!pendingByTeam.has(teamId)) pendingByTeam.set(teamId, [])
    pendingByTeam.get(teamId)!.push(pending)

    // Post a feed marker so the team sees the question is en route.
    const channelDescription = telegramMessageId
      ? `📱 Pinged operator on Telegram. Reply with: /answer ${questionId} <text>`
      : `(Telegram unavailable — operator must answer via dashboard or /api/ensemble/answer)`
    appendMessage(teamId, {
      id: uuidv4(),
      teamId,
      from: 'ensemble',
      to: 'team',
      content: [
        `🟡 awaiting answer (5min timeout) — ${q.agent} asked: ${q.claim}`,
        `  question-id: ${questionId}`,
        `  ${channelDescription}`,
      ].join('\n'),
      type: 'chat',
      timestamp: new Date().toISOString(),
      meta: { event: 'question_pending', questionId, agent: q.agent, claim: q.claim },
    })
    pinged++
  }

  // ── Phase 2: expire timeouts ────────────────────────────────────────
  expirePendingQuestions(teamId)

  return pinged
}

function expirePendingQuestions(teamId: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): void {
  const list = pendingByTeam.get(teamId)
  if (!list || list.length === 0) return
  const now = Date.now()
  const remaining: PendingQuestion[] = []
  for (const p of list) {
    if (now - p.postedAt < timeoutMs) {
      remaining.push(p)
      continue
    }
    appendMessage(teamId, {
      id: uuidv4(),
      teamId,
      from: 'ensemble',
      to: 'team',
      content: `🟡 question ${p.questionId} timed out (${Math.round((now - p.postedAt) / 60_000)}min, no operator reply) — ${p.agent}, proceed with best-effort or treat as a NO-GO blocker.`,
      type: 'chat',
      timestamp: new Date().toISOString(),
      meta: { event: 'question_timeout', questionId: p.questionId, agent: p.agent },
    })
  }
  if (remaining.length > 0) pendingByTeam.set(teamId, remaining)
  else pendingByTeam.delete(teamId)
}

/**
 * Operator-side: route an answer to the matching pending question. Called
 * from the HTTP endpoint (which the Telegram proxy hits when it sees
 * `/answer <questionId> <text>`).
 *
 * Returns `{ resolved: true, teamId }` on hit, `{ resolved: false }` if no
 * pending question matches the id (idempotent — duplicate answers are dropped).
 */
export interface AnswerInput {
  questionId: string
  answer: string
  fromLabel?: string  // e.g. "operator" or telegram username
}

export interface AnswerResult {
  resolved: boolean
  teamId?: string
  agent?: string
}

export function answerQuestion(input: AnswerInput): AnswerResult {
  const id = input.questionId.trim()
  if (!id) return { resolved: false }
  for (const [teamId, list] of pendingByTeam) {
    const idx = list.findIndex(p => p.questionId === id)
    if (idx === -1) continue
    const p = list[idx]
    list.splice(idx, 1)
    if (list.length === 0) pendingByTeam.delete(teamId)
    appendMessage(teamId, {
      id: uuidv4(),
      teamId,
      from: input.fromLabel || 'operator',
      to: 'team',
      content: [
        `🟢 answer to ${p.questionId} (${p.agent}'s [QUESTION: ${p.claim}]):`,
        input.answer,
      ].join('\n'),
      type: 'chat',
      timestamp: new Date().toISOString(),
      meta: { event: 'question_answered', questionId: p.questionId, agent: p.agent },
    })
    return { resolved: true, teamId, agent: p.agent }
  }
  return { resolved: false }
}

// Test-only helper: clears in-memory pending state between cases.
export function _resetQuestionWatcher(): void {
  pendingByTeam.clear()
  pingedKeys.clear()
}

export function _pendingCount(): number {
  let total = 0
  for (const list of pendingByTeam.values()) total += list.length
  return total
}
