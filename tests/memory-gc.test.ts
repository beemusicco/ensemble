import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import {
  classifyMemory,
  loadRetentionRules,
  runMemoryGc,
  DEFAULT_RETENTION_RULES,
  type RetentionRule,
} from '../lib/memory-gc'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 4, 4, 12, 0, 0)  // 2026-05-04T12:00:00Z

function ts(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY_MS).toISOString()
}

function tagsJson(...tags: string[]): string {
  return JSON.stringify(tags)
}

describe('classifyMemory — pure rule application', () => {
  const rules: RetentionRule[] = [
    { tagPattern: 'resolution', retentionDays: 'forever', reason: 'r1' },
    { tagPattern: 'failure-pattern', retentionDays: 365, reason: 'r2' },
    { tagPattern: 'confab-pattern', retentionDays: 180, reason: 'r3' },
    { tagPattern: 'reflection', retentionDays: 90, reason: 'r4' },
  ]

  it('returns matched=null for memories with no matching tag', () => {
    const r = classifyMemory(tagsJson('random-tag'), ts(1), rules, NOW)
    expect(r.matched).toBeNull()
    expect(r.shouldDelete).toBe(false)
  })

  it('forever retention never deletes regardless of age', () => {
    const r = classifyMemory(tagsJson('resolution'), ts(10000), rules, NOW)
    expect(r.matched?.tagPattern).toBe('resolution')
    expect(r.shouldDelete).toBe(false)
  })

  it('retention=365 keeps a 100-day-old failure-pattern', () => {
    const r = classifyMemory(tagsJson('failure-pattern'), ts(100), rules, NOW)
    expect(r.shouldDelete).toBe(false)
  })

  it('retention=365 deletes a 400-day-old failure-pattern', () => {
    const r = classifyMemory(tagsJson('failure-pattern'), ts(400), rules, NOW)
    expect(r.shouldDelete).toBe(true)
    expect(r.matched?.tagPattern).toBe('failure-pattern')
  })

  it('retention=90 deletes 100-day-old reflection', () => {
    const r = classifyMemory(tagsJson('reflection'), ts(100), rules, NOW)
    expect(r.shouldDelete).toBe(true)
  })

  it('retention=90 keeps a 30-day-old reflection', () => {
    const r = classifyMemory(tagsJson('reflection'), ts(30), rules, NOW)
    expect(r.shouldDelete).toBe(false)
  })

  it('first matching rule wins (confab-pattern beats backfill:v1)', () => {
    const ordered: RetentionRule[] = [
      { tagPattern: 'confab-pattern', retentionDays: 180, reason: 'first' },
      { tagPattern: 'backfill:v1',    retentionDays: 30,  reason: 'second' },
    ]
    // 60-day-old memory tagged with BOTH — confab-pattern (180d) fires first → keep
    const r = classifyMemory(tagsJson('confab-pattern', 'backfill:v1'), ts(60), ordered, NOW)
    expect(r.matched?.tagPattern).toBe('confab-pattern')
    expect(r.shouldDelete).toBe(false)
    // If we reversed the order, backfill:v1 (30d) would fire → delete at 60d
    const reversed: RetentionRule[] = [...ordered].reverse()
    const r2 = classifyMemory(tagsJson('confab-pattern', 'backfill:v1'), ts(60), reversed, NOW)
    expect(r2.matched?.tagPattern).toBe('backfill:v1')
    expect(r2.shouldDelete).toBe(true)
  })

  it('handles malformed JSON tags gracefully', () => {
    const r = classifyMemory('not-json-{', ts(1000), rules, NOW)
    expect(r.matched).toBeNull()
    expect(r.shouldDelete).toBe(false)
  })

  it('handles invalid timestamp gracefully (preserves)', () => {
    const r = classifyMemory(tagsJson('failure-pattern'), 'not-a-date', rules, NOW)
    expect(r.shouldDelete).toBe(false)  // can't compute age → preserve
  })

  it('boundary case: exactly retention age preserves', () => {
    // 365 days exactly = ageDays = 365.0 — rule says "ageDays > retentionDays"
    // so 365 == 365 → not deleted
    const r = classifyMemory(tagsJson('failure-pattern'), ts(365), rules, NOW)
    expect(r.shouldDelete).toBe(false)
  })

  it('boundary case: retention age + 1 deletes', () => {
    const r = classifyMemory(tagsJson('failure-pattern'), ts(366), rules, NOW)
    expect(r.shouldDelete).toBe(true)
  })
})

describe('loadRetentionRules — override file behavior', () => {
  let tempDir: string
  let overridePath: string
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-override-'))
    overridePath = path.join(tempDir, 'memory-retention.json')
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns DEFAULT_RETENTION_RULES when no override exists', () => {
    const r = loadRetentionRules(overridePath)
    expect(r).toEqual(DEFAULT_RETENTION_RULES)
  })

  it('loads valid override file', () => {
    const customRules = [
      { tagPattern: 'custom-tag', retentionDays: 7, reason: 'short retention test' },
    ]
    fs.writeFileSync(overridePath, JSON.stringify(customRules))
    const r = loadRetentionRules(overridePath)
    expect(r).toEqual(customRules)
  })

  it('falls back to defaults on malformed override JSON', () => {
    fs.writeFileSync(overridePath, '{ broken')
    const r = loadRetentionRules(overridePath)
    expect(r).toEqual(DEFAULT_RETENTION_RULES)
  })

  it('drops invalid entries from override array', () => {
    const mixed = [
      { tagPattern: 'good', retentionDays: 30, reason: 'ok' },
      { tagPattern: 'no-retention' },
      { retentionDays: 30, reason: 'no tag' },
      { tagPattern: 'negative', retentionDays: -5, reason: 'neg' },
      { tagPattern: 'forever-ok', retentionDays: 'forever', reason: 'ok' },
    ]
    fs.writeFileSync(overridePath, JSON.stringify(mixed))
    const r = loadRetentionRules(overridePath)
    expect(r.map(x => x.tagPattern)).toEqual(['good', 'forever-ok'])
  })
})

describe('runMemoryGc — end-to-end with sqlite (dbPath override avoids module-cache)', () => {
  let tempDir: string
  let dbPath: string

  function createMemoriesTable(file: string) {
    const db = new Database(file)
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('session','team','global')),
        team_id TEXT, agent TEXT,
        key TEXT NOT NULL, value TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, expires_at TEXT
      );
    `)
    return db
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-db-'))
    dbPath = path.join(tempDir, 'memory.db')
  })
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns zero counts on missing memory.db', () => {
    const r = runMemoryGc({ dryRun: true, dbPath: path.join(tempDir, 'nonexistent.db') })
    expect(r.scanned).toBe(0)
    expect(r.deleted).toBe(0)
  })

  it('dry-run reports would-delete count but does not modify DB', () => {
    const db = createMemoriesTable(dbPath)
    db.prepare("INSERT INTO memories VALUES (?, 'global', NULL, NULL, ?, ?, ?, ?, NULL)")
      .run('id-1', 'old-r', 'aged reflection content', '["reflection"]', '2025-01-01T00:00:00Z')
    db.close()

    const r = runMemoryGc({ dryRun: true, dbPath })
    // Old reflection (>90d) → counted in would-delete
    expect(r.deleted).toBe(1)
    expect(r.dryRun).toBe(true)
    expect(r.perRule.find(x => x.rule.tagPattern === 'reflection')?.matched).toBe(1)
    // But the row is still in the DB
    const verify = new Database(dbPath, { readonly: true })
    const remaining = verify.prepare<[], { c: number }>('SELECT count(*) as c FROM memories').get()!
    verify.close()
    expect(remaining.c).toBe(1)
  })

  it('apply-mode actually deletes expired memories', () => {
    const db = createMemoriesTable(dbPath)
    const insert = db.prepare("INSERT INTO memories VALUES (?, 'global', NULL, NULL, ?, ?, ?, ?, NULL)")
    insert.run('fresh-id', 'fresh-r', 'fresh reflection', '["reflection"]', new Date().toISOString())
    insert.run('old-id', 'old-r', 'old reflection 200 days', '["reflection"]', '2025-10-01T00:00:00Z')
    insert.run('forever-id', 'forever-r', 'fix that worked', '["resolution"]', '2023-08-01T00:00:00Z')
    db.close()

    const r = runMemoryGc({ dryRun: false, dbPath })
    expect(r.deleted).toBe(1)
    expect(r.preserved).toBe(2)

    // Verify directly: old-r gone, others remain.
    const verify = new Database(dbPath, { readonly: true })
    const remainingKeys = verify.prepare<[], { key: string }>('SELECT key FROM memories').all().map(r => r.key)
    verify.close()
    expect(remainingKeys.sort()).toEqual(['forever-r', 'fresh-r'])
  })
})
