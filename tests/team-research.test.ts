import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-research-test-'))
const prevDataDir = process.env.ENSEMBLE_DATA_DIR
process.env.ENSEMBLE_DATA_DIR = tmpDataDir

const { writeMemory } = await import('../lib/memory-store')
const { teamResearch, formatResearchOutput } = await import('../lib/team-research')

describe('team-research', () => {
  afterAll(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = prevDataDir
  })

  beforeAll(() => {
    writeMemory({
      scope: 'global',
      key: 'tenant_isolation_libro_rule',
      value: 'every libro endpoint MUST filter by session.tenant_id (non-negotiable)',
      tags: ['libro', 'tenant_id', 'iron_law'],
    })
    writeMemory({
      scope: 'global',
      key: 'crypto_mm_avellaneda_params',
      value: 'use sigma=0.6 gamma=0.1 for BTC market making at 1m bar',
      tags: ['crypto', 'market_making'],
    })
  })

  it('returns empty when query is blank', async () => {
    const out = await teamResearch({ query: '' })
    expect(out.memoryHits).toEqual([])
    expect(out.docHits).toEqual([])
    expect(out.web).toBeNull()
  })

  it('returns top semantic memory matches for a relevant query', async () => {
    const out = await teamResearch({
      query: 'how do libro endpoints handle tenant_id',
      docsPaths: [],
    })
    expect(out.memoryHits.length).toBeGreaterThan(0)
    expect(out.memoryHits[0].key).toContain('tenant')
  })

  it('respects memoryLimit', async () => {
    const out = await teamResearch({
      query: 'libro tenant',
      memoryLimit: 1,
      docsPaths: [],
    })
    expect(out.memoryHits.length).toBeLessThanOrEqual(1)
  })

  it('formatResearchOutput renders compact summary', async () => {
    const out = await teamResearch({
      query: 'libro tenant_id rule',
      docsPaths: [],
    })
    const text = formatResearchOutput(out)
    expect(text).toContain('team-research:')
    expect(text).toContain('memories')
  })

  it('formatResearchOutput shows graceful "no matches" when empty', () => {
    const text = formatResearchOutput({
      query: 'asdfqwerzxcv', memoryHits: [], docHits: [], web: null,
    })
    expect(text).toContain('No matches')
  })
})
