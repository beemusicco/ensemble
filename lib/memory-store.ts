import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getEnsembleDataDir } from './ensemble-paths'

export type MemoryScope = 'session' | 'team' | 'global'

export interface MemoryRecord {
  id: string
  scope: MemoryScope
  teamId: string | null
  agent: string | null
  key: string
  value: string
  tags: string[]
  createdAt: string
  expiresAt: string | null
}

export interface WriteMemoryInput {
  scope: MemoryScope
  teamId?: string | null
  agent?: string | null
  key: string
  value: unknown
  tags?: string[]
  ttlSeconds?: number
}

export interface QueryMemoryInput {
  scope?: MemoryScope
  teamId?: string
  tags?: string[]
  key?: string
  limit?: number
}

let db: Database.Database | null = null

function dbPath(): string {
  return path.join(getEnsembleDataDir(), 'memory.db')
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('session','team','global')),
      team_id TEXT,
      agent TEXT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
    CREATE INDEX IF NOT EXISTS idx_memories_team ON memories(team_id);
    CREATE INDEX IF NOT EXISTS idx_memories_key ON memories(key);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
  `)
}

function getDb(): Database.Database {
  if (db) return db
  const file = dbPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  initSchema(db)
  return db
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  let tags: string[] = []
  try { tags = JSON.parse(row.tags as string) } catch { tags = [] }
  return {
    id: row.id as string,
    scope: row.scope as MemoryScope,
    teamId: (row.team_id as string | null) ?? null,
    agent: (row.agent as string | null) ?? null,
    key: row.key as string,
    value: row.value as string,
    tags,
    createdAt: row.created_at as string,
    expiresAt: (row.expires_at as string | null) ?? null,
  }
}

export function writeMemory(input: WriteMemoryInput): MemoryRecord {
  const database = getDb()
  const id = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const expiresAt = input.ttlSeconds
    ? new Date(Date.now() + input.ttlSeconds * 1000).toISOString()
    : null
  const value = typeof input.value === 'string' ? input.value : JSON.stringify(input.value)
  const tags = JSON.stringify(input.tags ?? [])

  database.prepare(`
    INSERT INTO memories (id, scope, team_id, agent, key, value, tags, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.scope, input.teamId ?? null, input.agent ?? null, input.key, value, tags, createdAt, expiresAt)

  return {
    id, scope: input.scope,
    teamId: input.teamId ?? null,
    agent: input.agent ?? null,
    key: input.key, value, tags: input.tags ?? [],
    createdAt, expiresAt,
  }
}

function pruneExpired(database: Database.Database): void {
  database.prepare(`
    DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?
  `).run(new Date().toISOString())
}

export function queryMemories(input: QueryMemoryInput = {}): MemoryRecord[] {
  const database = getDb()
  pruneExpired(database)

  const clauses: string[] = []
  const params: unknown[] = []

  if (input.scope) { clauses.push('scope = ?'); params.push(input.scope) }
  if (input.teamId) { clauses.push('team_id = ?'); params.push(input.teamId) }
  if (input.key) { clauses.push('key = ?'); params.push(input.key) }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
  const limit = Math.min(input.limit ?? 100, 500)

  const rows = database.prepare(`
    SELECT * FROM memories ${where}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit) as Record<string, unknown>[]

  let records = rows.map(rowToRecord)
  if (input.tags && input.tags.length) {
    const needed = new Set(input.tags)
    records = records.filter(r => r.tags.some(t => needed.has(t)))
  }
  return records
}

// ───────────────────────────────────────────────────────────────────
// Semantic-ish memory retrieval — local, no external API.
// We tokenize the lesson body + key + tags into a normalized term set,
// then score against the same tokenization of the task description.
// Score is a hybrid of Jaccard overlap + IDF-weighted term match — gives
// rare/specific tokens (like "tenant_id" or "useSSE") much more weight
// than generic ones ("the", "for", "that"). Outperforms pure tag-match
// at the small scale we're operating (currently 37 memories; should
// stay good up to a few thousand without needing a real embedding model).
// ───────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','else','when','to','of','in','on',
  'at','for','with','by','as','is','are','was','were','be','been','being','have',
  'has','had','do','does','did','done','this','that','these','those','it','its',
  'we','you','they','i','he','she','what','which','who','how','why','where',
  'about','from','into','out','over','under','up','down','too','very','can','will',
  'would','should','could','might','may','must','also','just','only','any','all',
  'no','not','don','t','s','m','re','ll','ve','ne','je','sem','si','so','smo','ste','ne',
])

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_./:-]+/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && t.length <= 60 && !STOPWORDS.has(t))
}

function memoryTokens(m: MemoryRecord): string[] {
  // Weight: tags + key tokens count more than body (in terms of
  // representativeness) — multiply via duplication.
  const tagTokens = m.tags.flatMap(t => tokenize(t))
  const keyTokens = tokenize(m.key)
  const bodyTokens = tokenize(m.value).slice(0, 80)  // cap body to first 80 tokens
  return [...keyTokens, ...keyTokens, ...tagTokens, ...tagTokens, ...bodyTokens]
}

interface SemanticScoreOptions {
  scope?: MemoryScope
  tags?: string[]                  // optional pre-filter (e.g. project tags)
  excludeTags?: string[]           // exclude any memory carrying these tags
  pool?: number                    // how many candidates to score (default 200)
  limit?: number                   // top-K to return
}

export function queryMemoriesSemantic(
  taskDescription: string,
  opts: SemanticScoreOptions = {},
): Array<MemoryRecord & { score: number }> {
  const database = getDb()
  pruneExpired(database)
  const taskTokens = new Set(tokenize(taskDescription))
  if (taskTokens.size === 0) return []

  // Pull candidate pool. Tags filter (if set) narrows; otherwise scan all.
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.scope) { clauses.push('scope = ?'); params.push(opts.scope) }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''
  const pool = Math.min(opts.pool ?? 200, 2000)
  const rows = database.prepare(`
    SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?
  `).all(...params, pool) as Record<string, unknown>[]
  let candidates = rows.map(rowToRecord)
  if (opts.tags?.length) {
    const wanted = new Set(opts.tags)
    candidates = candidates.filter(m => m.tags.some(t => wanted.has(t)))
  }
  if (opts.excludeTags?.length) {
    const banned = new Set(opts.excludeTags)
    candidates = candidates.filter(m => !m.tags.some(t => banned.has(t)))
  }
  if (candidates.length === 0) return []

  // Compute IDF over the candidate pool. Rare tokens score higher.
  const docFreq = new Map<string, number>()
  const memTokens = candidates.map(m => {
    const tokens = new Set(memoryTokens(m))
    for (const tok of tokens) docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1)
    return tokens
  })
  const N = candidates.length
  const idf = (tok: string): number => Math.log(1 + N / (1 + (docFreq.get(tok) ?? 0)))

  // Score each memory: sum IDF over (taskTokens ∩ memTokens), normalized
  // by sqrt(memTokens.size) so verbose memories don't always dominate.
  const scored: Array<{ rec: MemoryRecord; score: number }> = []
  for (let i = 0; i < candidates.length; i++) {
    const tokens = memTokens[i]
    let s = 0
    for (const tok of taskTokens) {
      if (tokens.has(tok)) s += idf(tok)
    }
    if (s > 0) {
      const norm = Math.sqrt(tokens.size) || 1
      scored.push({ rec: candidates[i], score: s / norm })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const limit = Math.min(opts.limit ?? 5, 50)
  return scored.slice(0, limit).map(x => ({ ...x.rec, score: x.score }))
}

// Wrapper: when a task description is provided, retrieve top-K semantic
// matches; otherwise fall back to recency. Keeps the existing top-of-file
// surface area unchanged.
export function queryMemoriesForTask(
  taskDescription: string | undefined,
  opts: SemanticScoreOptions = {},
): MemoryRecord[] {
  if (!taskDescription || taskDescription.trim().length < 10) {
    // No useful task description — fall back to recency-ordered tag query.
    return queryMemories({
      scope: opts.scope,
      tags: opts.tags,
      limit: opts.limit ?? 5,
    })
  }
  return queryMemoriesSemantic(taskDescription, opts)
}

export function deleteMemory(id: string): boolean {
  const database = getDb()
  const result = database.prepare('DELETE FROM memories WHERE id = ?').run(id)
  return result.changes > 0
}

export function memoryStats(): { total: number; byScope: Record<string, number> } {
  const database = getDb()
  pruneExpired(database)
  const total = (database.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n
  const scoped = database.prepare('SELECT scope, COUNT(*) AS n FROM memories GROUP BY scope').all() as Array<{ scope: string; n: number }>
  const byScope: Record<string, number> = {}
  for (const row of scoped) byScope[row.scope] = row.n
  return { total, byScope }
}
