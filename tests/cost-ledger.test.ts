import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalDataDir = process.env.ENSEMBLE_DATA_DIR
let tempRoot: string

describe('cost-ledger', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-costs-'))
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* */ }
    if (originalDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalDataDir
  })

  it('appendCostEntry writes one jsonl line per call into costs/YYYY-MM-DD.jsonl', async () => {
    const { appendCostEntry, getCostDir } = await import('../lib/cost-ledger')
    const frozenNow = new Date('2026-04-24T12:34:56.000Z')
    appendCostEntry(
      {
        teamId: 't1',
        teamName: 'alpha',
        description: 'task one',
        completedAt: frozenNow.toISOString(),
        perAgent: { codex: '1,200 tokens', claude: '2.5k tokens' },
      },
      frozenNow,
    )
    appendCostEntry(
      {
        teamId: 't2',
        teamName: 'beta',
        completedAt: frozenNow.toISOString(),
        perAgent: { codex: '800 tokens' },
      },
      frozenNow,
    )
    const file = path.join(getCostDir(), '2026-04-24.jsonl')
    const content = fs.readFileSync(file, 'utf-8').trim().split('\n')
    expect(content).toHaveLength(2)
    expect(JSON.parse(content[0])).toMatchObject({ teamId: 't1', teamName: 'alpha' })
  })

  it('readCostEntries filters by since and aggregateByAgent sums token strings', async () => {
    const {
      appendCostEntry, readCostEntries, aggregateByAgent, parseSince,
    } = await import('../lib/cost-ledger')

    const old = new Date('2026-04-10T00:00:00.000Z')
    const fresh = new Date('2026-04-24T00:00:00.000Z')
    appendCostEntry(
      { teamId: 'old', completedAt: old.toISOString(), perAgent: { codex: '999' } },
      old,
    )
    appendCostEntry(
      { teamId: 'f1', completedAt: fresh.toISOString(), perAgent: { codex: '1k', claude: '500 tokens' } },
      fresh,
    )
    appendCostEntry(
      { teamId: 'f2', completedAt: fresh.toISOString(), perAgent: { codex: '2,000 tokens' } },
      fresh,
    )

    const cutoff = parseSince('7d', new Date('2026-04-25T00:00:00.000Z'))
    const entries = readCostEntries(cutoff)
    // 'old' is >7d before 2026-04-25, must be excluded
    expect(entries.map(e => e.teamId).sort()).toEqual(['f1', 'f2'])

    const agg = aggregateByAgent(entries)
    const codex = agg.find(r => r.agent === 'codex')
    const claude = agg.find(r => r.agent === 'claude')
    expect(codex?.totalTokens).toBe(3000)
    expect(claude?.totalTokens).toBe(500)
    expect(codex?.teams).toBe(2)
    expect(claude?.teams).toBe(1)
  })

  it('parseTokenString handles k/m suffix, commas, unknown', async () => {
    const { parseTokenString } = await import('../lib/cost-ledger')
    expect(parseTokenString('1,234 tokens')).toBe(1234)
    expect(parseTokenString('8.2k tokens')).toBe(8200)
    expect(parseTokenString('1.5M')).toBe(1_500_000)
    expect(parseTokenString('unknown')).toBe(0)
    expect(parseTokenString('')).toBe(0)
  })

  it('parseSince defaults to 7d, accepts 30d and ISO date', async () => {
    const { parseSince } = await import('../lib/cost-ledger')
    const now = new Date('2026-04-25T00:00:00.000Z')
    expect(parseSince(undefined, now).toISOString().slice(0, 10)).toBe('2026-04-18')
    expect(parseSince('30d', now).toISOString().slice(0, 10)).toBe('2026-03-26')
    expect(parseSince('2026-01-15', now).toISOString().slice(0, 10)).toBe('2026-01-15')
  })
})
