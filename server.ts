/**
 * Ensemble Server — Standalone HTTP server
 * Lightweight replacement for Next.js API routes.
 */

import http from 'http'
import {
  createEnsembleTeam, getEnsembleTeam, listEnsembleTeams,
  getTeamFeed, sendTeamMessage, disbandTeam, signalCompleteTeam,
  searchHistory, getRecentTeams,
} from './services/ensemble-service'
import { getTeam } from './lib/ensemble-registry'
import { verifyBearer, getAuthToken, getAuthTokenPath } from './lib/auth'
import { logger } from './lib/logger'
import { buildHealthReport } from './lib/health'
import {
  writeMemory, queryMemories, deleteMemory, memoryStats,
  type MemoryScope,
} from './lib/memory-store'

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
        const result = await disbandTeam(teamId)
        if (result.error) return json(res, { error: result.error }, result.status, origin)
        return json(res, result.data, result.status, origin)
      }
    }

    // Disband: /api/ensemble/teams/:id/disband
    const disbandMatch = path.match(/^\/api\/ensemble\/teams\/([^/]+)\/disband$/)
    if (disbandMatch && method === 'POST') {
      const result = await disbandTeam(disbandMatch[1])
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

server.listen(PORT, HOST, () => {
  // Force token initialization so operators see the path on first boot.
  getAuthToken()
  logger.info('server_started', {
    host: HOST,
    port: PORT,
    auth_token_path: getAuthTokenPath(),
  })
})
