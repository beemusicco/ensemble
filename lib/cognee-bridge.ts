/**
 * Cognee Knowledge Graph bridge.
 *
 * The user's CLAUDE.md references a Cognee instance at 127.0.0.1:8000 with
 * 2500+ nodes of connected learnings (Gemini extraction, nightly auto-sync).
 * Pre-W6 the ensemble system never queried it — every collab cold-started
 * against local memory only, missing project-specific patterns the KG holds.
 *
 * This bridge adds two operations:
 *   - searchGraph(query) — pre-spawn enrichment of the prompt context
 *   - addKnowledge(entry) — post-disband write-back of new learnings
 *
 * Failure mode: Cognee is allowed to be DOWN. Both operations have a
 * 2-second timeout and degrade silently to empty/null. Ensemble's local
 * memory store remains the primary source — Cognee is augmentation, not
 * dependency. Verified 2026-05-04: Cognee was down, ensemble worked fine.
 *
 * ENV gates:
 *   ENSEMBLE_USE_KG=1     — enable bridge (default OFF)
 *   ENSEMBLE_KG_URL=...   — override base URL (default http://127.0.0.1:8000)
 *   ENSEMBLE_KG_TIMEOUT_MS=2000 — request timeout
 */

const DEFAULT_BASE = process.env['ENSEMBLE_KG_URL'] || 'http://127.0.0.1:8000'
const DEFAULT_TIMEOUT_MS = parseInt(process.env['ENSEMBLE_KG_TIMEOUT_MS'] || '2000', 10) || 2000
const KG_USER = process.env['ENSEMBLE_KG_USER']
const KG_PASS = process.env['ENSEMBLE_KG_PASS']

// Bearer token cache. Cognee tokens typically last 60min; we refresh on
// 401 OR after CACHE_MS, whichever comes first. Keeps the working set
// "log in once, reuse for the duration of a typical disband" but never
// holds onto a stale token.
const TOKEN_CACHE_MS = 50 * 60 * 1000
let cachedToken: { value: string; until: number } | null = null

async function fetchAuthToken(): Promise<string | null> {
  if (!KG_USER || !KG_PASS) return null
  if (cachedToken && cachedToken.until > Date.now()) return cachedToken.value
  // Cognee 1.0 uses fastapi-users which expects OAuth2 form-encoded login,
  // not JSON. Sending JSON returns 422 Unprocessable Entity.
  const formBody = new URLSearchParams({
    username: KG_USER,
    password: KG_PASS,
  }).toString()
  const res = await fetchWithTimeout(
    `${DEFAULT_BASE}/api/v1/auth/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody,
    },
    DEFAULT_TIMEOUT_MS,
  )
  if (!res || !res.ok) {
    cachedToken = null
    return null
  }
  try {
    const data = (await res.json()) as { access_token?: string; token?: string }
    const token = data.access_token ?? data.token ?? null
    if (token) {
      cachedToken = { value: token, until: Date.now() + TOKEN_CACHE_MS }
      return token
    }
  } catch { /* fallthrough */ }
  return null
}

async function authedHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = await fetchAuthToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

export interface KGSearchResult {
  /** Concept / node identifier in the graph */
  id: string
  /** Human-readable summary of the node */
  text: string
  /** Optional: relevance score from the graph search */
  score?: number
  /** Optional: source dataset (which sync ingested this) */
  source?: string
}

export interface KGAddInput {
  /** Stable key for dedup on the Cognee side */
  key: string
  /** Body of the knowledge entry */
  text: string
  /** Tags for cross-referencing */
  tags?: string[]
  /** Optional: project / scope */
  scope?: string
}

export function isEnabled(): boolean {
  return process.env['ENSEMBLE_USE_KG'] === '1'
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Search the knowledge graph for entries matching the query. Returns up to
 * `limit` results. On any failure (Cognee down, timeout, malformed response),
 * returns []. Never throws — caller can always proceed without graph data.
 */
export async function searchGraph(
  query: string,
  opts: { limit?: number; tags?: string[] } = {},
): Promise<KGSearchResult[]> {
  if (!isEnabled() || !query.trim()) return []
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 25))

  // Cognee 1.0.5 SearchPayloadDTO: { query, searchType, topK, datasets?,
  // datasetIds?, systemPrompt?, nodeName?, onlyContext?, verbose? }.
  // Default searchType=CHUNKS gives raw text matches; INSIGHTS gives
  // graph-derived structured nodes; GRAPH_COMPLETION runs LLM over
  // matched subgraph (slower, higher cost). CHUNKS is the cheapest fit
  // for our use-case (pre-spawn enrichment).
  const url = `${DEFAULT_BASE}/api/v1/search`
  const body = JSON.stringify({
    query,
    searchType: 'CHUNKS',
    topK: limit,
  })

  const headers = await authedHeaders()
  let res = await fetchWithTimeout(url, { method: 'POST', headers, body }, DEFAULT_TIMEOUT_MS)
  if (res && res.status === 401) {
    cachedToken = null
    const refreshed = await authedHeaders()
    res = await fetchWithTimeout(url, { method: 'POST', headers: refreshed, body }, DEFAULT_TIMEOUT_MS)
  }
  if (!res || !res.ok) return []

  try {
    // Cognee 1.0 returns either an array of result rows OR an object with
    // a `results` field — handle both shapes. Each row is loosely shaped:
    // { id, text/content/payload, score?, source/dataset? }.
    const raw = (await res.json()) as unknown
    const results = Array.isArray(raw)
      ? raw
      : (Array.isArray((raw as { results?: unknown[] })?.results)
          ? (raw as { results: unknown[] }).results
          : [])
    return results
      .map((entry): KGSearchResult | null => {
        if (!entry || typeof entry !== 'object') return null
        const r = entry as Record<string, unknown>
        const id = typeof r.id === 'string' ? r.id : (typeof r.uuid === 'string' ? r.uuid : null)
        const text = typeof r.text === 'string'
          ? r.text
          : (typeof r.content === 'string'
              ? r.content
              : (typeof r.payload === 'string'
                  ? r.payload
                  : (typeof r.summary === 'string' ? r.summary : null)))
        if (!id || !text) return null
        return {
          id,
          text,
          score: typeof r.score === 'number' ? r.score : (typeof r.distance === 'number' ? 1 - r.distance : undefined),
          source: typeof r.source === 'string'
            ? r.source
            : (typeof r.dataset === 'string' ? r.dataset : undefined),
        }
      })
      .filter((r): r is KGSearchResult => r !== null)
      .slice(0, limit)
  } catch {
    return []
  }
}

/**
 * Write a knowledge entry to Cognee for ingestion in its next sync cycle.
 * Returns true on success, false on failure (treat as best-effort — the
 * local memory store is still the authoritative record).
 */
export async function addKnowledge(input: KGAddInput): Promise<boolean> {
  if (!isEnabled()) return false
  // Cognee 1.0.5 /api/v1/add expects multipart/form-data with `data`
  // (string or file array), `datasetName`, `node_set`. We send the
  // memory body as one text item to a project-scoped dataset so KG
  // queries can filter by dataset for project-aware recall.
  const url = `${DEFAULT_BASE}/api/v1/add`
  const datasetName = input.scope || 'ensemble-default'
  const form = new FormData()
  // Prefix body with the key+tags so semantic search can match by them
  // even though Cognee's add doesn't carry them as first-class fields.
  const enriched = [
    `[${input.key}] tags=[${(input.tags ?? []).join(',')}]`,
    input.text,
  ].join('\n')
  // Cognee's /api/v1/add validates `data` as UploadFile, not a plain string.
  // Wrapping the text in a Blob with an explicit filename satisfies the
  // multipart parser. Plain `form.append('data', enriched)` returns 422.
  const blob = new Blob([enriched], { type: 'text/plain' })
  const safeKey = input.key.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40)
  form.append('data', blob, `${safeKey || 'entry'}.txt`)
  form.append('datasetName', datasetName)
  if (input.tags?.length) form.append('node_set', input.tags.join(','))

  // For multipart, fetch sets the boundary header automatically — DON'T
  // include Content-Type explicitly, only Authorization.
  const token = await fetchAuthToken()
  const baseHeaders: Record<string, string> = {}
  if (token) baseHeaders['Authorization'] = `Bearer ${token}`

  let res = await fetchWithTimeout(url, { method: 'POST', headers: baseHeaders, body: form as unknown as BodyInit }, DEFAULT_TIMEOUT_MS)
  if (res && res.status === 401) {
    cachedToken = null
    const refreshedToken = await fetchAuthToken()
    const refreshHeaders: Record<string, string> = refreshedToken ? { Authorization: `Bearer ${refreshedToken}` } : {}
    res = await fetchWithTimeout(url, { method: 'POST', headers: refreshHeaders, body: form as unknown as BodyInit }, DEFAULT_TIMEOUT_MS)
  }
  return !!res && res.ok
}

/**
 * Health check — used by drift detector and operator diagnostics. Never
 * throws; returns false on any error.
 */
export async function isHealthy(): Promise<boolean> {
  if (!isEnabled()) return false
  const res = await fetchWithTimeout(
    `${DEFAULT_BASE}/health`,
    { method: 'GET' },
    Math.min(DEFAULT_TIMEOUT_MS, 1500),
  )
  return !!res && res.ok
}
