/**
 * Memory GC primitive — declarative retention policy for the memory store.
 *
 * Why this exists: post-W4/W6/W7, every collab writes ~5-15 new memories
 * (reflections + failure-patterns + confab-patterns + resolutions). At
 * 30-50 collabs/week this is 200-700 new rows/week. queryMemoriesSemantic
 * does in-memory Jaccard scoring over a candidate pool — fine at 1k rows,
 * slow at 5k+, painful at 20k+. Without GC, the store crosses 5k in ~3
 * months and 20k in ~12 months.
 *
 * The retention policy is the LIST-of-cases that the FUTURE-N test
 * (BUILD-PROTOCOL Step 2.5) warns about. We refuse to hardcode "180d for
 * X tag, 30d for Y" — that's two-of-anything-is-a-list, and a list is
 * a primitive. Instead, retention is declared as RULES that the GC
 * engine walks. Adding a new memory kind = add one rule entry, no
 * code change to the engine.
 *
 * Override path: ~/.ensemble/memory-retention.json. If present, replaces
 * the defaults. The file format mirrors the rule shape exactly so the
 * operator can read defaults, copy them in, tweak.
 *
 * Usage:
 *   node --import tsx scripts/memory-gc.ts             # apply
 *   node --import tsx scripts/memory-gc.ts --dry-run   # report only
 *   node --import tsx scripts/memory-gc.ts --json      # machine-readable
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import Database from 'better-sqlite3'
import { getEnsembleDataDir } from './ensemble-paths'

export interface RetentionRule {
  /** Matches against a memory's tags array. Tag string OR /regex/ literal as JSON-loaded raw string */
  tagPattern: string
  /** Memories matching this rule are kept for N days from createdAt */
  retentionDays: number | 'forever'
  /** Human-readable explanation for the GC report */
  reason: string
}

/**
 * Default retention rules. Order matters — first matching rule wins.
 *
 * Design principles encoded here:
 *   - Resolutions never expire — fix patterns are timeless and we want
 *     them to keep informing future teams indefinitely.
 *   - Failure-patterns expire at 1y — gates evolve, frameworks change,
 *     a 14-month-old pytest failure is unlikely to recur unchanged.
 *   - Confab-patterns expire at 6m — agents iterate, stale confab
 *     warnings clutter the prompt without paying their keep.
 *   - Reflections expire at 90d — agent reflections are noisy and
 *     decay fast; the durable signal lives in the structured patterns.
 *   - Backfill data is shorter (90d) — bootstrap value is high but
 *     decays once organic data accumulates.
 *   - Untagged / generic memories are kept forever as a safety default
 *     until we understand what they are.
 */
export const DEFAULT_RETENTION_RULES: RetentionRule[] = [
  { tagPattern: 'resolution',      retentionDays: 'forever', reason: 'fix patterns are timeless — no expiry' },
  { tagPattern: 'failure-pattern', retentionDays: 365,       reason: '1y is enough for class-level learning to recur' },
  { tagPattern: 'confab-pattern',  retentionDays: 180,       reason: 'agents improve; old confabs less relevant' },
  { tagPattern: 'reflection',      retentionDays: 90,        reason: 'reflection signal decays fast' },
  { tagPattern: 'backfill:v1',     retentionDays: 90,        reason: 'historical bootstrap data; organic data takes over' },
  { tagPattern: 'auto_extracted',  retentionDays: 180,       reason: 'LLM-extracted lessons' },
]

// Override file path — resolved at call time so tests can set HOME and
// have it picked up without stale module-level caching.
function defaultOverrideFile(): string {
  return path.join(os.homedir(), '.ensemble', 'memory-retention.json')
}

export function loadRetentionRules(overrideFile?: string): RetentionRule[] {
  const file = overrideFile ?? defaultOverrideFile()
  if (!fs.existsSync(file)) return DEFAULT_RETENTION_RULES
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (Array.isArray(raw)) {
      return raw.filter(r =>
        r && typeof r.tagPattern === 'string'
        && (r.retentionDays === 'forever' || (typeof r.retentionDays === 'number' && r.retentionDays > 0))
      ) as RetentionRule[]
    }
  } catch (err) {
    console.warn(`[memory-gc] override file ${file} malformed: ${(err as Error).message} — falling back to defaults`)
  }
  return DEFAULT_RETENTION_RULES
}

export interface GcReport {
  scanned: number
  deleted: number
  preserved: number
  perRule: Array<{ rule: RetentionRule; matched: number; deleted: number }>
  /** Rows that didn't match any rule (kept by default) */
  unmatched: number
  dryRun: boolean
  durationMs: number
}

interface MemoryRow {
  id: string
  tags: string  // JSON-encoded
  created_at: string
}

/**
 * Pure logic: classify each memory row by its first matching rule, decide
 * whether to retain. Exposed for unit testing without sqlite.
 */
export function classifyMemory(
  tagsJson: string,
  createdAt: string,
  rules: RetentionRule[],
  now: number = Date.now(),
): { matched: RetentionRule | null; shouldDelete: boolean } {
  let tags: string[] = []
  try { tags = JSON.parse(tagsJson) } catch { tags = [] }
  for (const rule of rules) {
    if (!tags.includes(rule.tagPattern)) continue
    if (rule.retentionDays === 'forever') return { matched: rule, shouldDelete: false }
    const created = new Date(createdAt).getTime()
    if (!Number.isFinite(created)) return { matched: rule, shouldDelete: false }
    const ageDays = (now - created) / (1000 * 60 * 60 * 24)
    return { matched: rule, shouldDelete: ageDays > rule.retentionDays }
  }
  return { matched: null, shouldDelete: false }
}

export function runMemoryGc(opts: { dryRun?: boolean; rules?: RetentionRule[]; now?: number; dbPath?: string } = {}): GcReport {
  const startedAt = Date.now()
  const dryRun = opts.dryRun ?? false
  const rules = opts.rules ?? loadRetentionRules()
  const now = opts.now ?? Date.now()

  const dbPath = opts.dbPath ?? path.join(getEnsembleDataDir(), 'memory.db')
  if (!fs.existsSync(dbPath)) {
    return {
      scanned: 0, deleted: 0, preserved: 0,
      perRule: rules.map(r => ({ rule: r, matched: 0, deleted: 0 })),
      unmatched: 0, dryRun,
      durationMs: Date.now() - startedAt,
    }
  }

  const db = new Database(dbPath, { readonly: dryRun })
  const rows = db.prepare<[], MemoryRow>('SELECT id, tags, created_at FROM memories').all()
  const perRuleStats = new Map<string, { rule: RetentionRule; matched: number; deleted: number }>()
  for (const r of rules) perRuleStats.set(r.tagPattern, { rule: r, matched: 0, deleted: 0 })

  const idsToDelete: string[] = []
  let unmatched = 0
  for (const row of rows) {
    const { matched, shouldDelete } = classifyMemory(row.tags, row.created_at, rules, now)
    if (matched === null) {
      unmatched++
      continue
    }
    const stat = perRuleStats.get(matched.tagPattern)!
    stat.matched++
    if (shouldDelete) {
      stat.deleted++
      idsToDelete.push(row.id)
    }
  }

  if (!dryRun && idsToDelete.length > 0) {
    const stmt = db.prepare('DELETE FROM memories WHERE id = ?')
    const txn = db.transaction((ids: string[]) => { for (const id of ids) stmt.run(id) })
    txn(idsToDelete)
  }
  db.close()

  return {
    scanned: rows.length,
    deleted: idsToDelete.length,
    preserved: rows.length - idsToDelete.length,
    perRule: [...perRuleStats.values()],
    unmatched,
    dryRun,
    durationMs: Date.now() - startedAt,
  }
}

export function formatGcReport(r: GcReport): string {
  const lines: string[] = []
  const verb = r.dryRun ? 'WOULD DELETE' : 'DELETED'
  lines.push(`📦 Memory GC ${r.dryRun ? '(DRY RUN)' : ''} — ${r.durationMs}ms`)
  lines.push(`   Scanned: ${r.scanned}`)
  lines.push(`   ${verb}: ${r.deleted}`)
  lines.push(`   Preserved: ${r.preserved}`)
  lines.push(`   Unmatched (kept by default): ${r.unmatched}`)
  lines.push('')
  lines.push('   Per-rule breakdown:')
  for (const s of r.perRule) {
    const retain = s.rule.retentionDays === 'forever' ? 'forever' : `${s.rule.retentionDays}d`
    lines.push(`     ${s.rule.tagPattern.padEnd(20)} retain=${retain.padEnd(8)} matched=${s.matched.toString().padStart(5)} ${verb.toLowerCase()}=${s.deleted}`)
  }
  return lines.join('\n')
}
