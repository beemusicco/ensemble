import fs from 'fs'
import path from 'path'
import { getEnsembleDataDir } from './ensemble-paths'

const COST_DIR = 'costs'

export interface CostEntry {
  teamId: string
  teamName?: string
  description?: string
  completedAt: string
  perAgent: Record<string, string>
}

export interface AggregatedAgentCost {
  agent: string
  teams: number
  totalTokens: number
  lastSeen: string
  rawSamples: number
}

export function getCostDir(): string {
  return path.join(getEnsembleDataDir(), COST_DIR)
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function appendCostEntry(entry: CostEntry, now: Date = new Date()): void {
  try {
    const dir = getCostDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${todayKey(now)}.jsonl`)
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
  } catch { /* never fail caller on ledger disk error */ }
}

/**
 * Parse a "7d" / "30d" / ISO-date-ish value into a cutoff Date. Returns
 * epoch (everything passes) if the input is missing or unparseable.
 */
export function parseSince(since: string | undefined, now: Date = new Date()): Date {
  if (!since) return new Date(now.getTime() - 7 * 86_400_000)
  const dayMatch = since.match(/^(\d+)d$/i)
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10)
    return new Date(now.getTime() - days * 86_400_000)
  }
  const parsed = new Date(since)
  if (!Number.isNaN(parsed.getTime())) return parsed
  return new Date(0)
}

export function readCostEntries(since: Date): CostEntry[] {
  const dir = getCostDir()
  if (!fs.existsSync(dir)) return []
  const cutoffMs = since.getTime()
  const entries: CostEntry[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const raw = fs.readFileSync(path.join(dir, name), 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as CostEntry
        const ts = new Date(entry.completedAt).getTime()
        if (Number.isNaN(ts) || ts < cutoffMs) continue
        entries.push(entry)
      } catch { /* skip malformed */ }
    }
  }
  return entries
}

/**
 * tokenUsageMap values are scraped from tmux panes as free-form strings
 * (e.g. "12,345 tokens", "8.2k tokens", "unknown"). Pull the first numeric
 * token, treating "k" as *1000 and "m" as *1_000_000. Anything unparseable
 * contributes 0 to the total but still counts as a raw sample.
 */
export function parseTokenString(raw: string): number {
  if (!raw) return 0
  const match = raw.match(/([0-9][0-9,.]*)\s*([kmKM]?)/)
  if (!match) return 0
  const num = parseFloat(match[1].replace(/,/g, ''))
  if (!Number.isFinite(num)) return 0
  const suffix = match[2].toLowerCase()
  if (suffix === 'k') return Math.round(num * 1000)
  if (suffix === 'm') return Math.round(num * 1_000_000)
  return Math.round(num)
}

export function aggregateByAgent(entries: CostEntry[]): AggregatedAgentCost[] {
  const byAgent = new Map<string, AggregatedAgentCost>()
  for (const entry of entries) {
    const teamAgents = new Set<string>()
    for (const [agent, raw] of Object.entries(entry.perAgent ?? {})) {
      teamAgents.add(agent)
      const tokens = parseTokenString(raw)
      const prev = byAgent.get(agent)
      if (prev) {
        prev.totalTokens += tokens
        prev.rawSamples += 1
        if (entry.completedAt > prev.lastSeen) prev.lastSeen = entry.completedAt
      } else {
        byAgent.set(agent, {
          agent,
          teams: 0,
          totalTokens: tokens,
          lastSeen: entry.completedAt,
          rawSamples: 1,
        })
      }
    }
    for (const agent of teamAgents) {
      const rec = byAgent.get(agent)
      if (rec) rec.teams += 1
    }
  }
  return [...byAgent.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}
