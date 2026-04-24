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
