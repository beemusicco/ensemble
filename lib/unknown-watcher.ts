/**
 * [UNKNOWN] watcher — auto-resolves agent uncertainty tags.
 *
 * Agents are instructed (via buildLearnOnDemandBlock) to emit
 * `[UNKNOWN: <concept>]` when they don't know something instead of guessing.
 * This watcher scans recent agent messages, extracts those tags, and answers
 * each one by:
 *
 *   1. Semantic memory query against the global memory store (top 3 matches)
 *   2. ripgrep across `~/.openclaw/docs/` (best 5 hits)
 *
 * Web fetch is intentionally NOT included in this first pass — adding it
 * would require an outbound network policy, an API key, and rate limiting.
 * Local sources cover the high-frequency case: "what's the convention for X
 * in this project" / "where is Y documented". Web research is a future W3
 * enhancement (the dedicated `team-research` tool will handle it).
 *
 * The watcher posts one consolidated answer per [UNKNOWN] back to the team
 * feed as `🧭 ensemble-research: re [UNKNOWN: X] from <agent> — ...`. Each
 * (teamId, rawTag, agent) tuple is answered ONCE — repeated emissions of
 * the same tag won't trigger redundant lookups.
 */

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import type { EnsembleMessage } from '../types/ensemble'
import { appendMessage, getMessages } from './ensemble-registry'
import { queryMemoriesSemantic } from './memory-store'
import { findTags } from './tag-parser'

// [ASSUMPTION: claim] — flagged-only (W2 behavior preserved)
// [ASSUMPTION: claim ## verify: cmd] — auto-executed by verifier (W3)
// We use `## verify:` as the separator because `||` and `|` can appear in
// shell commands, but `## verify:` is unlikely to collide.
//
// Parsing now uses bracket-balanced findTags() instead of regex — the regex
// `[^\]\n]` truncated cmds containing literals like `[1,2,3]` (W3 production
// finding from collab 1781bdca, 2026-04-30).
const ASSUMPTION_VERIFY_SEPARATOR = /\s*##\s*verify:\s*/i
const UNKNOWN_BODY_MAX = 200
const ASSUMPTION_BODY_MAX = 600  // bumped from 400 to accommodate `## verify:` clauses with realistic shell pipelines

interface ParsedAssumption {
  claim: string
  verifyCmd: string | null
}

function parseAssumption(raw: string): ParsedAssumption {
  const match = raw.match(ASSUMPTION_VERIFY_SEPARATOR)
  if (!match) return { claim: raw.trim(), verifyCmd: null }
  const idx = raw.search(ASSUMPTION_VERIFY_SEPARATOR)
  const claim = raw.slice(0, idx).trim()
  const verifyCmd = raw.slice(idx + match[0].length).trim()
  return { claim, verifyCmd: verifyCmd || null }
}

const DOCS_PATHS = [
  path.join(os.homedir(), '.openclaw', 'docs'),
  path.join(os.homedir(), '.openclaw', 'workspace'),
]

const MAX_RG_HITS = 5
const RG_TIMEOUT_MS = 8_000
const MEMORY_TOP_K = 3
const MAX_OUTPUT_PER_HIT = 240

type AnsweredKey = string  // `${teamId}::${normalizedTag}::${agent}`

const answeredCache = new Set<AnsweredKey>()

function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/\s+/g, ' ').trim()
}

function rg(query: string, root: string): Promise<string[]> {
  return new Promise(resolve => {
    if (!fs.existsSync(root)) return resolve([])
    // -S smart-case, -n line numbers, -m cap per-file matches, -F fixed-string
    // for safety (the query is user-text not regex). --max-count caps total
    // matches to keep results bounded.
    const args = ['-n', '-S', '--no-heading', '-m', '3', '--max-count', String(MAX_RG_HITS), '-F', query, root]
    const proc = spawn('rg', args, { env: process.env })
    const chunks: string[] = []
    proc.stdout?.on('data', d => chunks.push(d.toString('utf-8')))
    proc.stderr?.on('data', () => { /* ignore */ })
    const timer = setTimeout(() => { try { proc.kill('SIGTERM') } catch { /* */ } }, RG_TIMEOUT_MS)
    proc.on('close', () => {
      clearTimeout(timer)
      const lines = chunks.join('').split('\n').map(l => l.trim()).filter(Boolean)
      resolve(lines.slice(0, MAX_RG_HITS))
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve([])  // rg not installed — degrade gracefully
    })
  })
}

interface ResearchResult {
  memoryHits: Array<{ key: string; value: string; tags: string[] }>
  docHits: Array<{ source: string; lines: string[] }>
}

async function researchUnknown(query: string): Promise<ResearchResult> {
  const memoryHits = queryMemoriesSemantic(query, {
    scope: 'global',
    pool: 200,
    limit: MEMORY_TOP_K,
  }).map(m => ({ key: m.key, value: m.value, tags: m.tags }))

  // Run rg against each docs root in parallel; preserve provenance per root
  // so the reply tells the agent where it came from.
  const docHits = await Promise.all(DOCS_PATHS.map(async root => {
    if (!fs.existsSync(root)) return null
    const lines = await rg(query, root)
    if (lines.length === 0) return null
    return {
      source: path.basename(root),
      lines: lines.map(l => l.length > MAX_OUTPUT_PER_HIT ? l.slice(0, MAX_OUTPUT_PER_HIT) + '…' : l),
    }
  }))

  return {
    memoryHits,
    docHits: docHits.filter((d): d is ResearchResult['docHits'][number] => d !== null),
  }
}

function formatResearchReply(agent: string, tag: string, result: ResearchResult): string {
  const parts: string[] = [`🧭 ensemble-research: re [UNKNOWN: ${tag}] from ${agent}`]

  if (result.memoryHits.length === 0 && result.docHits.length === 0) {
    parts.push(`  No matches in team memories or docs/. Consider [QUESTION: ...] to ask the operator, or do a fresh investigation (read source / run command / WebFetch).`)
    return parts.join('\n')
  }

  if (result.memoryHits.length > 0) {
    parts.push(`  📚 memories:`)
    for (const m of result.memoryHits) {
      const tags = m.tags.length ? ` [${m.tags.slice(0, 3).join(',')}]` : ''
      const body = m.value.length > MAX_OUTPUT_PER_HIT
        ? m.value.slice(0, MAX_OUTPUT_PER_HIT) + '…'
        : m.value
      parts.push(`    • ${m.key}${tags}: ${body}`)
    }
  }

  if (result.docHits.length > 0) {
    parts.push(`  📖 docs:`)
    for (const d of result.docHits) {
      parts.push(`    [${d.source}]`)
      for (const l of d.lines) parts.push(`      ${l}`)
    }
  }

  parts.push(`  (verify before relying on this — memories/docs may be stale.)`)
  return parts.join('\n')
}

interface UnknownTagFound {
  agent: string
  tag: string
  cacheKey: AnsweredKey
}

function extractUnknowns(messages: EnsembleMessage[], teamId: string): UnknownTagFound[] {
  const found: UnknownTagFound[] = []
  for (const m of messages) {
    if (!m.from || m.from === 'ensemble' || m.from === 'system') continue
    if (!m.content) continue
    const tags = findTags(m.content, 'UNKNOWN', { maxBodyChars: UNKNOWN_BODY_MAX })
    for (const t of tags) {
      const tag = t.body
      if (!tag) continue
      const cacheKey = `${teamId}::${normalizeTag(tag)}::${m.from}`
      if (answeredCache.has(cacheKey)) continue
      found.push({ agent: m.from, tag, cacheKey })
    }
  }
  return found
}

/**
 * One scan-and-answer pass. Caller invokes periodically (e.g. from the
 * existing idle-checker tick or a dedicated interval). The watcher only
 * answers each (team, tag, agent) tuple once — reset by process restart.
 */
export async function scanAndAnswerUnknowns(
  teamId: string,
  sinceTimestamp?: string,
): Promise<number> {
  const messages = getMessages(teamId, sinceTimestamp)
  const unknowns = extractUnknowns(messages, teamId)
  if (unknowns.length === 0) return 0

  let answered = 0
  for (const u of unknowns) {
    try {
      const research = await researchUnknown(u.tag)
      const reply = formatResearchReply(u.agent, u.tag, research)
      appendMessage(teamId, {
        id: uuidv4(),
        teamId,
        from: 'ensemble',
        to: 'team',
        content: reply,
        type: 'chat',
        timestamp: new Date().toISOString(),
        meta: {
          event: 'unknown_resolved',
          tag: u.tag,
          agent: u.agent,
          memoryCount: research.memoryHits.length,
          docHitCount: research.docHits.reduce((n, d) => n + d.lines.length, 0),
        },
      })
      answeredCache.add(u.cacheKey)
      answered++
    } catch (err) {
      console.warn(`[unknown-watcher] Failed to answer "${u.tag}": ${(err as Error).message}`)
    }
  }
  return answered
}

/**
 * Surface ASSUMPTION tags into the feed. Two modes:
 *   • Bare: `[ASSUMPTION: claim]` — flagged-only, echoed to feed
 *   • With verifier: `[ASSUMPTION: claim ## verify: cmd]` — runs the cmd,
 *     posts 🟢 verified / 🔴 rejected based on exit code.
 *
 * The cmd is run via bash -c with a hard 30s timeout in the team's working
 * directory (resolved by the caller — for unknown-watcher we use cwd that
 * the operator started ensemble in, which is typically ~/.openclaw). Output
 * is captured + truncated to 1200 chars and embedded in the result message.
 *
 * Each (team, claim, agent) tuple is processed once — re-emissions don't
 * trigger redundant verification.
 */
export async function flagAssumptions(
  teamId: string,
  sinceTimestamp?: string,
  opts: { verifyCwd?: string; verifyTimeoutMs?: number } = {},
): Promise<number> {
  const messages = getMessages(teamId, sinceTimestamp)
  let flagged = 0
  for (const m of messages) {
    if (!m.from || m.from === 'ensemble' || !m.content) continue
    const tags = findTags(m.content, 'ASSUMPTION', { maxBodyChars: ASSUMPTION_BODY_MAX })
    for (const t of tags) {
      const raw = t.body
      if (!raw) continue
      const { claim, verifyCmd } = parseAssumption(raw)
      const cacheKey = `assumption::${teamId}::${normalizeTag(claim)}::${m.from}`
      if (answeredCache.has(cacheKey)) continue
      answeredCache.add(cacheKey)

      if (verifyCmd) {
        // Auto-verify path
        const result = await runVerifyCommand(verifyCmd, opts.verifyCwd, opts.verifyTimeoutMs)
        const icon = result.passed ? '🟢 verified' : '🔴 rejected'
        const banner = result.timedOut
          ? `⏱ TIMEOUT after ${result.durationMs}ms`
          : `exit=${result.exitCode}`
        const truncatedOut = result.output.length > 1200
          ? result.output.slice(0, 1100) + '\n…[truncated]'
          : result.output
        appendMessage(teamId, {
          id: uuidv4(),
          teamId,
          from: 'ensemble',
          to: 'team',
          content: [
            `${icon}: ${m.from}'s [ASSUMPTION: ${claim}]`,
            `  $ ${verifyCmd}  (${banner})`,
            `  ${truncatedOut.split('\n').join('\n  ')}`,
            result.passed
              ? ''
              : `  ⚠️ Rejected assumption — agent must address this before [VERIFY_DONE].`,
          ].filter(Boolean).join('\n'),
          type: 'chat',
          timestamp: new Date().toISOString(),
          meta: {
            event: 'assumption_verified',
            claim, verifyCmd,
            agent: m.from,
            passed: result.passed,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          },
        })
      } else {
        // Bare flag (no verify cmd) — same behavior as W2
        appendMessage(teamId, {
          id: uuidv4(),
          teamId,
          from: 'ensemble',
          to: 'team',
          content: `🟡 assumption-flag: ${m.from} stated [ASSUMPTION: ${claim}] — verify this before [VERIFY_DONE]. Tip: append \` ## verify: <cmd>\` to auto-verify on next tick. If unverifiable, escalate to [QUESTION: ...].`,
          type: 'chat',
          timestamp: new Date().toISOString(),
          meta: { event: 'assumption_flagged', tag: claim, agent: m.from },
        })
      }
      flagged++
    }
  }
  return flagged
}

interface VerifyCmdResult {
  passed: boolean
  exitCode: number | null
  output: string
  durationMs: number
  timedOut: boolean
}

async function runVerifyCommand(
  cmd: string,
  cwd: string | undefined,
  timeoutMs: number = 30_000,
): Promise<VerifyCmdResult> {
  const startedAt = Date.now()
  const { spawn } = await import('child_process')
  return await new Promise(resolve => {
    const proc = spawn('bash', ['-lc', cmd], {
      cwd: cwd || process.cwd(),
      env: process.env,
    })
    const chunks: string[] = []
    let totalLen = 0
    const onData = (data: Buffer): void => {
      const s = data.toString('utf-8')
      totalLen += s.length
      if (totalLen <= 6000) chunks.push(s)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* */ }
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* */ } }, 1500)
    }, timeoutMs)
    proc.on('close', exitCode => {
      clearTimeout(timer)
      resolve({
        passed: !timedOut && exitCode === 0,
        exitCode: exitCode ?? null,
        output: chunks.join('').trim(),
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    })
    proc.on('error', err => {
      clearTimeout(timer)
      resolve({
        passed: false,
        exitCode: null,
        output: `spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      })
    })
  })
}

// Test-only: lets the test suite reset cached answers between cases.
export function _resetAnsweredCache(): void {
  answeredCache.clear()
}
