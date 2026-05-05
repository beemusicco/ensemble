/**
 * Ensemble Server — Standalone HTTP server
 * Lightweight replacement for Next.js API routes.
 */

import http from 'http'
import {
  createEnsembleTeam, getEnsembleTeam, listEnsembleTeams,
  getTeamFeed, sendTeamMessage, disbandTeam, signalCompleteTeam,
  searchHistory, getRecentTeams, answerPendingQuestion,
  releaseOperatorHold,
} from './services/ensemble-service'
import { getTeam } from './lib/ensemble-registry'
import { verifyBearer, getAuthToken, getAuthTokenPath } from './lib/auth'
import { logger } from './lib/logger'
import { buildHealthReport } from './lib/health'
import {
  writeMemory, queryMemories, deleteMemory, memoryStats,
  type MemoryScope,
} from './lib/memory-store'
import { teamResearch, formatResearchOutput } from './lib/team-research'
import { computeCalibration, formatCalibrationText } from './lib/calibration'

const SERVER_VERSION = '1.0.0'

const PORT = parseInt(process.env.ENSEMBLE_PORT || process.env.ORCHESTRA_PORT || '23000', 10)
const HOST = process.env.ENSEMBLE_HOST || '127.0.0.1'
const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 500
const DEFAULT_CORS_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(?::\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^http:\/\/\[::1\](?::\d+)?$/i,
]

type RateLimitEntry = {
  count: number
  windowStart: number
}

const rateLimitByIp = new Map<string, RateLimitEntry>()

// Periodic cleanup of stale rate limit entries to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of rateLimitByIp) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitByIp.delete(ip)
    }
  }
}, 60_000)

function getAllowedCorsOrigins(): string[] {
  const configured = process.env.ENSEMBLE_CORS_ORIGIN?.trim()
  if (!configured) return []

  return configured
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
}

function isAllowedOrigin(origin: string): boolean {
  const configuredOrigins = getAllowedCorsOrigins()
  if (configuredOrigins.length > 0) return configuredOrigins.includes(origin)
  return DEFAULT_CORS_ORIGIN_PATTERNS.some(pattern => pattern.test(origin))
}

function buildCorsHeaders(origin?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  }

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }

  return headers
}

function json(res: http.ServerResponse, data: unknown, status = 200, origin?: string) {
  res.writeHead(status, buildCorsHeaders(origin))
  res.end(JSON.stringify(data))
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function getClientIp(req: http.IncomingMessage): string {
  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string') {
    const firstIp = forwardedFor.split(',')[0]?.trim()
    if (firstIp) return firstIp
  }

  return req.socket.remoteAddress || 'unknown'
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const current = rateLimitByIp.get(ip)

  if (!current || now - current.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitByIp.set(ip, { count: 1, windowStart: now })
    return false
  }

  current.count += 1
  return current.count > RATE_LIMIT_MAX_REQUESTS
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  const path = url.pathname
  const method = req.method || 'GET'
  const origin = req.headers.origin

  if (origin && !isAllowedOrigin(origin)) {
    return json(res, { error: 'CORS origin forbidden' }, 403, origin)
  }

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, buildCorsHeaders(origin))
    res.end()
    return
  }

  if (isRateLimited(getClientIp(req))) {
    logger.warn('rate_limited', { ip: getClientIp(req), path, method })
    return json(res, { error: 'Rate limit exceeded' }, 429, origin)
  }

  try {
    // Health check — unauthenticated, component-aware probe
    if (path === '/api/v1/health') {
      const report = await buildHealthReport(SERVER_VERSION)
      return json(res, report, 200, origin)
    }

    // Dashboard — browser-friendly HTML shell. Accepts token via either
    // Authorization header or ?token=XXX query param (needed because
    // browser <a href> navigation can't set a Bearer header).
    if (path === '/dashboard' && method === 'GET') {
      const queryToken = url.searchParams.get('token') || ''
      const headerToken = req.headers['authorization'] || ''
      const authOk = verifyBearer(headerToken) ||
        (queryToken ? verifyBearer(`Bearer ${queryToken}`) : false)
      if (!authOk) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>401 Unauthorized</h1><p>append <code>?token=YOUR_TOKEN</code> to the URL</p>')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderDashboardHtml(queryToken || (headerToken.match(/Bearer\s+(.+)/i)?.[1] ?? '')))
      return
    }

    // Auth gate for all other endpoints
    if (!verifyBearer(req.headers['authorization'])) {
      logger.warn('auth_failed', { ip: getClientIp(req), path, method })
      return json(res, { error: 'Unauthorized' }, 401, origin)
    }

    // List teams / Create team
    if (path === '/api/ensemble/teams') {
      if (method === 'GET') {
        const result = listEnsembleTeams()
        return json(res, result.data, result.status, origin)
      }
      if (method === 'POST') {
        let body: unknown
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const result = await createEnsembleTeam(body as Parameters<typeof createEnsembleTeam>[0])
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Team operations: /api/ensemble/teams/:id
    const teamMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)$/)
    if (teamMatch) {
      const teamId = teamMatch[1]
      if (method === 'GET') {
        const result = getEnsembleTeam(teamId)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
      if (method === 'POST') {
        let body: Record<string, unknown>
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        const sender = body.from as string
        if (sender) {
          const team = getTeam(teamId)
          if (team) {
            const validSenders = new Set([...team.agents.map(a => a.name), 'user', 'ensemble'])
            if (!validSenders.has(sender)) {
              return json(res, { error: `Unauthorized: unknown sender '${sender}'` }, 403, origin)
            }
          }
        }
        const result = await sendTeamMessage(
          teamId,
          (body.to as string) || 'team',
          body.content as string,
          sender,
          body.id as string,
          body.timestamp as string,
          body.type as string | undefined,
          body.meta as Record<string, unknown> | undefined,
        )
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
      if (method === 'DELETE') {
        const result = await disbandTeam(teamId, 'manual: HTTP DELETE', { triggeredBy: 'http-delete' })
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Disband: /api/ensemble/teams/:id/disband
    const disbandMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/disband$/)
    if (disbandMatch && method === 'POST') {
      const result = await disbandTeam(disbandMatch[1], 'manual: explicit disband endpoint', { triggeredBy: 'http-disband' })
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Explicit completion signal: /api/ensemble/teams/:id/signal-complete
    const signalMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/signal-complete$/)
    if (signalMatch && method === 'POST') {
      let body: Record<string, unknown> = {}
      const raw = await readBody(req)
      if (raw.trim()) {
        try { body = JSON.parse(raw) } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
      }
      const from = (body.from as string) || ''
      if (!from) return json(res, { error: 'from required' }, 400, origin)
      const result = await signalCompleteTeam(signalMatch[1], from, body.note as string | undefined)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Release operator-hold: /api/ensemble/teams/:id/release-hold
    const releaseMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/release-hold$/)
    if (releaseMatch && method === 'POST') {
      let body: Record<string, unknown> = {}
      const raw = await readBody(req)
      if (raw.trim()) {
        try { body = JSON.parse(raw) } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
      }
      const by = (body.by as string) || 'operator'
      const result = await releaseOperatorHold(releaseMatch[1], by)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Thinking-mode: current phase
    const phaseMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/phase$/)
    if (phaseMatch && method === 'GET') {
      const { getCurrentPhase } = await import('./lib/thinking-phases')
      const teamId = phaseMatch[1]
      const team = getTeam(teamId)
      if (!team) return json(res, { error: 'Team not found' }, 404, origin)
      const { getMessages } = await import('./lib/ensemble-registry')
      const phase = getCurrentPhase(getMessages(teamId))
      return json(res, { teamId, phase }, 200, origin)
    }

    // Feed: /api/ensemble/teams/:id/feed
    const feedMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/feed$/)
    if (feedMatch && method === 'GET') {
      const since = url.searchParams.get('since') || undefined
      const result = getTeamFeed(feedMatch[1], since)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Memory endpoints
    if (path === '/api/ensemble/memory') {
      if (method === 'GET') {
        const scope = url.searchParams.get('scope') as MemoryScope | null
        const teamId = url.searchParams.get('team') || undefined
        const key = url.searchParams.get('key') || undefined
        const tagsParam = url.searchParams.get('tags')
        const tags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : undefined
        const limitParam = url.searchParams.get('limit')
        const limit = limitParam ? parseInt(limitParam, 10) : undefined
        const records = queryMemories({
          scope: scope || undefined,
          teamId, key, tags, limit,
        })
        return json(res, { memories: records }, 200, origin)
      }
      if (method === 'POST') {
        let body: Record<string, unknown>
        try { body = JSON.parse(await readBody(req)) } catch {
          return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
        }
        if (!body.scope || !body.key || body.value === undefined) {
          return json(res, { error: 'scope, key, value required' }, 400, origin)
        }
        if (!['session', 'team', 'global'].includes(body.scope as string)) {
          return json(res, { error: 'scope must be session|team|global' }, 400, origin)
        }
        const record = writeMemory({
          scope: body.scope as MemoryScope,
          teamId: (body.teamId as string) ?? null,
          agent: (body.agent as string) ?? null,
          key: body.key as string,
          value: body.value,
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
          ttlSeconds: typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
        })
        logger.info('memory_written', { id: record.id, scope: record.scope, key: record.key })
        return json(res, { memory: record }, 201, origin)
      }
    }

    if (path === '/api/ensemble/memory/stats' && method === 'GET') {
      return json(res, memoryStats(), 200, origin)
    }

    // Cross-team history search: /api/ensemble/history?q=<query>&limit=N
    if (path === '/api/ensemble/history' && method === 'GET') {
      const q = url.searchParams.get('q') || ''
      const limitParam = url.searchParams.get('limit')
      const limit = limitParam ? parseInt(limitParam, 10) : undefined
      const result = searchHistory(q, limit)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    // Recent teams (regardless of content): /api/ensemble/history/recent?limit=N
    if (path === '/api/ensemble/history/recent' && method === 'GET') {
      const limitParam = url.searchParams.get('limit')
      const limit = limitParam ? parseInt(limitParam, 10) : undefined
      const result = getRecentTeams(limit)
      if (result.error) return json(res, { error: result.error }, result.status, origin)
      return json(res, result.data, result.status, origin)
    }

    const memoryIdMatch = path.match(/^\/api\/ensemble\/memory\/([^/]+)$/)
    if (memoryIdMatch && method === 'DELETE') {
      const deleted = deleteMemory(memoryIdMatch[1])
      if (!deleted) return json(res, { error: 'not found' }, 404, origin)
      return json(res, { deleted: true }, 200, origin)
    }

    // Operator answer to a pending [QUESTION]: POST /api/ensemble/answer
    // Body: { questionId, answer, fromLabel? }
    // Called by the Telegram proxy's `/answer <id> <text>` handler.
    if (path === '/api/ensemble/answer' && method === 'POST') {
      let body: Record<string, unknown>
      try { body = JSON.parse(await readBody(req)) } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }
      const questionId = (body.questionId as string || '').trim()
      const answer = (body.answer as string || '').trim()
      if (!questionId || !answer) {
        return json(res, { error: 'questionId and answer required' }, 400, origin)
      }
      const fromLabel = typeof body.fromLabel === 'string' ? body.fromLabel : undefined
      const result = answerPendingQuestion({ questionId, answer, fromLabel })
      return json(res, result.data, result.status, origin)
    }

    // Calibration scoreboard: /api/ensemble/calibration?windowDays=N&maxTeams=N&format=text|json
    if (path === '/api/ensemble/calibration' && method === 'GET') {
      const windowDaysParam = url.searchParams.get('windowDays')
      const windowDays = windowDaysParam ? Math.max(1, Math.min(parseInt(windowDaysParam, 10) || 30, 365)) : undefined
      const maxTeamsParam = url.searchParams.get('maxTeams')
      const maxTeams = maxTeamsParam ? Math.max(1, Math.min(parseInt(maxTeamsParam, 10) || 500, 2000)) : undefined
      const summary = computeCalibration({ windowDays, maxTeams })
      const wantsText = (url.searchParams.get('format') || '').toLowerCase() === 'text'
      if (wantsText) {
        res.statusCode = 200
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        if (origin) res.setHeader('access-control-allow-origin', origin)
        res.end(formatCalibrationText(summary))
        return
      }
      return json(res, summary, 200, origin)
    }

    // Pending confidence claims: /api/ensemble/claims/pending?agent=&limit=
    if (path === '/api/ensemble/claims/pending' && method === 'GET') {
      const agent = url.searchParams.get('agent') || undefined
      const limitParam = url.searchParams.get('limit')
      const limit = limitParam ? Math.max(1, Math.min(parseInt(limitParam, 10) || 100, 500)) : 100
      const claims = queryMemories({
        scope: 'global',
        tags: ['confidence-claim', 'outcome:pending'],
        limit,
      })
      const filtered = agent ? claims.filter(c => c.tags.includes(`agent:${agent}`)) : claims
      const items = filtered.map(c => ({
        id: c.id,
        teamId: c.teamId,
        agent: c.agent,
        confidence: parseInt((c.tags.find(t => t.startsWith('confidence:')) || 'confidence:').replace('confidence:', ''), 10) || null,
        claim: c.value,
        createdAt: c.createdAt,
      }))
      return json(res, { count: items.length, claims: items }, 200, origin)
    }

    // Resolve a confidence claim: POST /api/ensemble/claims/:id/resolve
    // Body: { outcome: 'verified'|'rejected', evidence?: string, resolvedBy?: string }
    const claimResolveMatch = path.match(/^\/api\/ensemble\/claims\/([^/]+)\/resolve$/)
    if (claimResolveMatch && method === 'POST') {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(await readBody(req)) } catch {
        return json(res, { error: 'Bad Request: malformed JSON' }, 400, origin)
      }
      const outcome = body.outcome as 'verified' | 'rejected' | undefined
      if (outcome !== 'verified' && outcome !== 'rejected') {
        return json(res, { error: "outcome must be 'verified' or 'rejected'" }, 400, origin)
      }
      const { resolveClaimOutcome } = await import('./lib/confidence-tracker')
      const resolution = resolveClaimOutcome({
        claimId: claimResolveMatch[1],
        outcome,
        evidence: typeof body.evidence === 'string' ? body.evidence : undefined,
        resolvedBy: typeof body.resolvedBy === 'string' ? body.resolvedBy : 'operator',
      })
      return json(res, { resolution }, 200, origin)
    }

    // Agent-callable research: /api/ensemble/research?q=<query>&url=<optional>&format=text|json
    // Aggregates semantic memory + ripgrep over docs + optional WebFetch.
    if (path === '/api/ensemble/research' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim()
      if (!q) return json(res, { error: 'q query param required' }, 400, origin)
      const fetchUrlParam = url.searchParams.get('url') || undefined
      const limitParam = url.searchParams.get('limit')
      const memoryLimit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 3, 1), 10) : 3
      const out = await teamResearch({ query: q, url: fetchUrlParam, memoryLimit })
      const wantsText = (url.searchParams.get('format') || '').toLowerCase() === 'text'
      if (wantsText) {
        res.statusCode = 200
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        if (origin) res.setHeader('access-control-allow-origin', origin)
        res.end(formatResearchOutput(out))
        return
      }
      return json(res, out, 200, origin)
    }

    json(res, { error: 'Not found' }, 404, origin)
  } catch (err) {
    logger.error('server_error', { path, method, err: err instanceof Error ? err.message : String(err) })
    json(res, { error: 'Internal server error' }, 500, origin)
  }
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error('port_in_use', { port: PORT, host: HOST })
    process.exit(1)
  }

  logger.error('server_start_failed', { err: err.message, code: err.code })
  process.exit(1)
})

function renderDashboardHtml(token: string): string {
  const safeToken = token.replace(/[^a-f0-9]/gi, '')
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>ensemble — dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
*{box-sizing:border-box}
body{font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:24px;background:#0d1117;color:#c9d1d9}
h1{font-size:18px;margin:0 0 16px;color:#f0f6fc}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;margin:24px 0 8px;color:#8b949e}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.ok{background:#238636;color:#fff}.warn{background:#d29922;color:#000}.fail{background:#da3633;color:#fff}.idle{background:#30363d;color:#8b949e}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{padding:6px 8px;text-align:left;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.dim{color:#6e7681}
#refresh{font-size:11px;color:#6e7681;float:right}
.k{color:#8b949e}.v{color:#c9d1d9;font-weight:500}
.row{display:flex;justify-content:space-between;padding:4px 0}
</style></head><body>
<h1>◈ ensemble <span id="refresh">refreshing…</span></h1>

<div class="grid">
  <div class="card"><h2>Health</h2><div id="health">loading…</div></div>
  <div class="card"><h2>Memory</h2><div id="memory">loading…</div></div>
</div>

<h2>Recent teams</h2>
<div class="card"><table id="teams"><thead><tr><th>status</th><th>name</th><th>agents</th><th>desc</th><th>when</th></tr></thead><tbody><tr><td colspan="5" class="dim">loading…</td></tr></tbody></table></div>

<script>
const TOKEN = ${JSON.stringify(safeToken)};
async function api(p) {
  const r = await fetch(p, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function pill(text, kind) { return '<span class="pill ' + kind + '">' + text + '</span>'; }
function renderHealth(h) {
  const overall = h.status === 'healthy' ? pill('healthy','ok')
    : h.status === 'degraded' ? pill('degraded','warn')
    : pill(h.status || 'unknown','fail');
  const rows = Object.entries(h.components || {}).map(([k, v]) => {
    const val = typeof v === 'object' ? (v.ok ? 'ok' : 'fail') : String(v);
    const kind = (val === 'ok' || typeof v === 'number') ? 'v' : 'k';
    return '<div class="row"><span class="k">' + k + '</span><span class="' + kind + '">' + val + '</span></div>';
  }).join('');
  return '<div class="row"><span class="k">overall</span>' + overall + '</div>' + rows;
}
function renderMemory(s) {
  const total = s.total || 0;
  const by = s.byScope || {};
  const rows = Object.entries(by).map(([k, v]) =>
    '<div class="row"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'
  ).join('');
  return '<div class="row"><span class="k">total</span><span class="v">' + total + '</span></div>' + rows;
}
function statusPill(s) {
  if (s === 'active') return pill('active','ok');
  if (s === 'disbanded') return pill('disbanded','idle');
  if (s === 'failed') return pill('failed','fail');
  return pill(s,'idle');
}
function renderTeams(data) {
  const teams = (data.teams || []).slice(0, 10);
  if (!teams.length) return '<tr><td colspan="5" class="dim">no teams</td></tr>';
  return teams.map(t => {
    const agents = (t.agents || []).map(a => a.name).join(' + ');
    const when = t.completedAt || t.createdAt || '';
    const whenShort = when ? when.slice(0, 19).replace('T', ' ') : '';
    const desc = (t.description || '').slice(0, 80);
    return '<tr><td>' + statusPill(t.status) + '</td><td class="mono">' + (t.name || '') + '</td><td class="mono">' + agents + '</td><td class="dim">' + desc + '</td><td class="mono dim">' + whenShort + '</td></tr>';
  }).join('');
}
async function refresh() {
  document.getElementById('refresh').textContent = 'refreshing…';
  try {
    const [h, m, t] = await Promise.all([
      api('/api/v1/health'),
      api('/api/ensemble/memory/stats'),
      api('/api/ensemble/history/recent?limit=10'),
    ]);
    document.getElementById('health').innerHTML = renderHealth(h);
    document.getElementById('memory').innerHTML = renderMemory(m);
    document.getElementById('teams').querySelector('tbody').innerHTML = renderTeams(t);
    document.getElementById('refresh').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('refresh').textContent = 'error: ' + e.message;
  }
}
refresh();
setInterval(refresh, 15000);
</script>
</body></html>`
}

server.listen(PORT, HOST, () => {
  // Force token initialization so operators see the path on first boot.
  getAuthToken()
  logger.info('server_started', {
    host: HOST,
    port: PORT,
    auth_token_path: getAuthTokenPath(),
  })
})
