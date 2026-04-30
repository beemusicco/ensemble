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

const UNKNOWN_TAG_RE = /\[UNKNOWN:\s*([^\]\n]{1,200})\]/g
const ASSUMPTION_TAG_RE = /\[ASSUMPTION:\s*([^\]\n]{1,200})\]/g

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
    const re = new RegExp(UNKNOWN_TAG_RE.source, UNKNOWN_TAG_RE.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(m.content))) {
      const tag = match[1].trim()
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
 * Surface ASSUMPTION tags into the feed without auto-resolving them. The
 * point of [ASSUMPTION] is "this is unverified — flag for verification";
 * we don't do auto-verification (that's W3) but we do echo the assumption
 * back to the team so it can't be silently dropped. Each assumption is
 * echoed once per (team, tag, agent).
 */
export async function flagAssumptions(
  teamId: string,
  sinceTimestamp?: string,
): Promise<number> {
  const messages = getMessages(teamId, sinceTimestamp)
  let flagged = 0
  for (const m of messages) {
    if (!m.from || m.from === 'ensemble' || !m.content) continue
    const re = new RegExp(ASSUMPTION_TAG_RE.source, ASSUMPTION_TAG_RE.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(m.content))) {
      const tag = match[1].trim()
      if (!tag) continue
      const cacheKey = `assumption::${teamId}::${normalizeTag(tag)}::${m.from}`
      if (answeredCache.has(cacheKey)) continue
      answeredCache.add(cacheKey)
      appendMessage(teamId, {
        id: uuidv4(),
        teamId,
        from: 'ensemble',
        to: 'team',
        content: `🟡 assumption-flag: ${m.from} stated [ASSUMPTION: ${tag}] — verify this before [VERIFY_DONE]. If unverifiable, escalate to [QUESTION: ...] or treat as a blocker.`,
        type: 'chat',
        timestamp: new Date().toISOString(),
        meta: { event: 'assumption_flagged', tag, agent: m.from },
      })
      flagged++
    }
  }
  return flagged
}

// Test-only: lets the test suite reset cached answers between cases.
export function _resetAnsweredCache(): void {
  answeredCache.clear()
}
