/**
 * team-research — agent-callable research tool.
 *
 * Where the [UNKNOWN] watcher is REACTIVE (it triggers when an agent emits
 * a tag), team-research is PROACTIVE (an agent calls it directly to broaden
 * its context before making a decision). Three lookup tiers:
 *
 *   1. Semantic memory query (top-K from global memory store)
 *   2. ripgrep across docs paths (~/.openclaw/docs, ~/.openclaw/workspace)
 *   3. WebFetch — a single best-effort URL hit when the agent passes one
 *      explicitly (we don't search the web; agents pass a URL they know
 *      is canonical, e.g. "MDN page for Array.prototype.flatMap")
 *
 * The point of separating this from [UNKNOWN] is concurrency + intent:
 *   • [UNKNOWN] is a self-flag — agent admits ignorance, ensemble investigates
 *   • team-research is an active query — agent commits to using results
 *
 * Both surfaces share the same memory + rg helpers so a fix in one path
 * lands for both.
 */

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { queryMemoriesSemantic } from './memory-store'

const DEFAULT_DOCS_PATHS = [
  path.join(os.homedir(), '.openclaw', 'docs'),
  path.join(os.homedir(), '.openclaw', 'workspace'),
]

const RG_TIMEOUT_MS = 10_000
const WEB_TIMEOUT_MS = 15_000
const MAX_RG_HITS_PER_ROOT = 5
const MAX_OUTPUT_PER_HIT = 280
const MAX_WEB_BYTES = 60_000  // 60 KB cap on fetched body

export interface ResearchInput {
  query: string
  /** Optional URL to fetch as the third tier; only that exact URL — no search. */
  url?: string
  /** Override docs roots; defaults to ~/.openclaw/{docs,workspace}. */
  docsPaths?: string[]
  /** Top-K memories to return. Default 3. */
  memoryLimit?: number
}

export interface ResearchOutput {
  query: string
  memoryHits: Array<{ key: string; value: string; tags: string[]; score: number }>
  docHits: Array<{ source: string; lines: string[] }>
  web: { url: string; status: 'ok' | 'error'; body?: string; error?: string } | null
}

function rg(query: string, root: string): Promise<string[]> {
  return new Promise(resolve => {
    if (!fs.existsSync(root)) return resolve([])
    const args = [
      '-n', '-S', '--no-heading',
      '-m', '3',
      '--max-count', String(MAX_RG_HITS_PER_ROOT),
      '-F', query, root,
    ]
    const proc = spawn('rg', args, { env: process.env })
    const chunks: string[] = []
    proc.stdout?.on('data', d => chunks.push(d.toString('utf-8')))
    proc.stderr?.on('data', () => { /* swallow */ })
    const timer = setTimeout(() => { try { proc.kill('SIGTERM') } catch { /* */ } }, RG_TIMEOUT_MS)
    proc.on('close', () => {
      clearTimeout(timer)
      const lines = chunks.join('').split('\n').map(l => l.trim()).filter(Boolean)
      resolve(lines.slice(0, MAX_RG_HITS_PER_ROOT))
    })
    proc.on('error', () => { clearTimeout(timer); resolve([]) })
  })
}

async function fetchUrl(url: string): Promise<{ status: 'ok' | 'error'; body?: string; error?: string }> {
  // Use Node's built-in fetch (Node 18+). We cap the body size + content type.
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), WEB_TIMEOUT_MS)
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    clearTimeout(timer)
    if (!res.ok) {
      return { status: 'error', error: `HTTP ${res.status} ${res.statusText}` }
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase()
    if (ct && !/^(text|application\/(json|xml|xhtml|x-www-form))/.test(ct)) {
      return { status: 'error', error: `unsupported content-type ${ct}` }
    }
    const reader = res.body?.getReader()
    if (!reader) {
      return { status: 'error', error: 'no body' }
    }
    let total = 0
    const parts: string[] = []
    const dec = new TextDecoder('utf-8', { fatal: false })
    let reading = true
    while (reading) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      parts.push(dec.decode(value, { stream: true }))
      if (total >= MAX_WEB_BYTES) {
        try { reader.cancel() } catch { /* */ }
        reading = false
      }
    }
    parts.push(dec.decode())
    let body = parts.join('')
    // Strip the most obvious HTML chrome — agents only need the readable text.
    if (/<html|<body/i.test(body.slice(0, 1000))) {
      body = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
    }
    return { status: 'ok', body: body.length > MAX_WEB_BYTES ? body.slice(0, MAX_WEB_BYTES) + '\n…[truncated]' : body }
  } catch (err) {
    return { status: 'error', error: (err as Error).message }
  }
}

export async function teamResearch(input: ResearchInput): Promise<ResearchOutput> {
  const query = input.query.trim()
  if (!query) {
    return { query, memoryHits: [], docHits: [], web: null }
  }

  const memorySize = Math.max(1, Math.min(input.memoryLimit ?? 3, 10))
  const memoryHits = queryMemoriesSemantic(query, {
    scope: 'global',
    pool: 200,
    limit: memorySize,
  }).map(m => ({
    key: m.key,
    value: m.value,
    tags: m.tags,
    score: Number((m.score ?? 0).toFixed(3)),
  }))

  const roots = input.docsPaths ?? DEFAULT_DOCS_PATHS
  const docHits = (await Promise.all(roots.map(async root => {
    if (!fs.existsSync(root)) return null
    const lines = await rg(query, root)
    if (lines.length === 0) return null
    return {
      source: path.basename(root),
      lines: lines.map(l => l.length > MAX_OUTPUT_PER_HIT ? l.slice(0, MAX_OUTPUT_PER_HIT) + '…' : l),
    }
  }))).filter((d): d is { source: string; lines: string[] } => d !== null)

  let web: ResearchOutput['web'] = null
  if (input.url) {
    const fetched = await fetchUrl(input.url)
    web = { url: input.url, ...fetched }
  }

  return { query, memoryHits, docHits, web }
}

/**
 * Compact human-readable formatter — the same shape used when posting back
 * to a team feed or rendering on the CLI.
 */
export function formatResearchOutput(out: ResearchOutput): string {
  const parts: string[] = [`📚 team-research: "${out.query}"`]

  if (out.memoryHits.length === 0 && out.docHits.length === 0 && !out.web) {
    parts.push(`  No matches in memories or docs/. Either narrow the query, or pass a URL to fetch.`)
    return parts.join('\n')
  }

  if (out.memoryHits.length > 0) {
    parts.push(`  📝 memories (top ${out.memoryHits.length}):`)
    for (const m of out.memoryHits) {
      const tags = m.tags.length ? ` [${m.tags.slice(0, 3).join(',')}]` : ''
      const body = m.value.length > MAX_OUTPUT_PER_HIT
        ? m.value.slice(0, MAX_OUTPUT_PER_HIT) + '…'
        : m.value
      parts.push(`    • ${m.key}${tags} (score=${m.score}): ${body}`)
    }
  }

  if (out.docHits.length > 0) {
    parts.push(`  📖 docs:`)
    for (const d of out.docHits) {
      parts.push(`    [${d.source}]`)
      for (const l of d.lines) parts.push(`      ${l}`)
    }
  }

  if (out.web) {
    if (out.web.status === 'ok') {
      const snippet = (out.web.body || '').slice(0, 1500)
      parts.push(`  🌐 web (${out.web.url}):`)
      parts.push(`    ${snippet.replace(/\n/g, '\n    ')}`)
    } else {
      parts.push(`  🌐 web (${out.web.url}): ${out.web.error}`)
    }
  }

  parts.push(`  (verify before relying on this — sources may be stale or wrong.)`)
  return parts.join('\n')
}
