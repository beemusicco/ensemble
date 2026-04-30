import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-test-'))
const prevDataDir = process.env.ENSEMBLE_DATA_DIR
process.env.ENSEMBLE_DATA_DIR = tmpDataDir

const { writeMemory, queryMemories } = await import('../lib/memory-store')
const { runConsolidation, formatConsolidationReport } = await import('../lib/memory-consolidate')

const projectDomainTags = new Map<string, Set<string>>([
  ['accounting-helper', new Set(['libro', 'accounting-helper', 'tenant_id'])],
  ['crypto-trading-platform', new Set(['crypto', 'paper-trading'])],
])

describe('memory-consolidate (clustering only — does not call Haiku in tests)', () => {
  beforeAll(() => {
    // Two near-duplicate libro memories (high sim) — should cluster.
    // Identical tags + heavily overlapping body tokens.
    writeMemory({
      scope: 'global', key: 'libro_tenant_id_index_books_42',
      value: 'tenant_id index ix_books_tenant_id at books models hot reads enforcement libro endpoint required filter',
      tags: ['libro', 'tenant_id', 'index'],
    })
    writeMemory({
      scope: 'global', key: 'libro_books_tenant_id_index',
      value: 'tenant_id index ix_books_tenant_id at books models hot reads required libro endpoint filter enforcement',
      tags: ['libro', 'tenant_id', 'index'],
    })
    // A third unrelated libro memory — same project, low semantic overlap.
    writeMemory({
      scope: 'global', key: 'libro_postmark_envelope_setup',
      value: 'postmark webhook envelope signs HMAC-SHA256 secret intake services payload',
      tags: ['libro', 'postmark'],
    })
    // A crypto memory — different project bucket.
    writeMemory({
      scope: 'global', key: 'crypto_paper_btc_baseline',
      value: 'paper trading BTC baseline 50/30/20 across three regimes',
      tags: ['crypto', 'paper-trading'],
    })
  })

  afterAll(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = prevDataDir
  })

  it('groups memories by project and finds near-duplicate clusters', async () => {
    // maxClusters=0 so we never spend a Haiku call — we only validate the
    // detection layer here.
    const report = await runConsolidation({ projectDomainTags, maxClusters: 0 })
    expect(report.scannedRecords).toBeGreaterThanOrEqual(4)
    expect(report.clustersFound).toBeGreaterThanOrEqual(1)  // the libro pair
    expect(report.proposals.length).toBe(0)  // capped to 0
    expect(report.applied).toBe(false)
  })

  it('formatConsolidationReport renders a readable dry-run summary', async () => {
    const report = await runConsolidation({ projectDomainTags, maxClusters: 0 })
    const text = formatConsolidationReport(report)
    expect(text).toContain('memory consolidation')
    expect(text).toContain('scanned:')
    expect(text).toContain('clusters found:')
  })

  it('does not delete originals in dry-run mode', async () => {
    const before = queryMemories({ scope: 'global', limit: 200 })
    await runConsolidation({ projectDomainTags, maxClusters: 0 })  // no apply
    const after = queryMemories({ scope: 'global', limit: 200 })
    expect(after.length).toBe(before.length)
  })
})
