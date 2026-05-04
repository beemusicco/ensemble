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

  const url = `${DEFAULT_BASE}/api/v1/search`
  const body = JSON.stringify({
    query,
    limit,
    ...(opts.tags?.length ? { tags: opts.tags } : {}),
  })

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
    DEFAULT_TIMEOUT_MS,
  )
  if (!res || !res.ok) return []

  try {
    const data = (await res.json()) as { results?: unknown[] }
    if (!Array.isArray(data.results)) return []
    return data.results
      .map((raw): KGSearchResult | null => {
        if (!raw || typeof raw !== 'object') return null
        const r = raw as Record<string, unknown>
        const id = typeof r.id === 'string' ? r.id : null
        const text = typeof r.text === 'string'
          ? r.text
          : (typeof r.summary === 'string' ? r.summary : null)
        if (!id || !text) return null
        return {
          id,
          text,
          score: typeof r.score === 'number' ? r.score : undefined,
          source: typeof r.source === 'string' ? r.source : undefined,
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
  const url = `${DEFAULT_BASE}/api/v1/add`
  const body = JSON.stringify({
    key: input.key,
    text: input.text,
    tags: input.tags ?? [],
    scope: input.scope,
  })
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    },
    DEFAULT_TIMEOUT_MS,
  )
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
