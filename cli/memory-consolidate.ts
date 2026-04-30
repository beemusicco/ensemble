#!/usr/bin/env tsx
/**
 * memory-consolidate — find and (optionally) merge near-duplicate memories.
 *
 * Usage:
 *   tsx cli/memory-consolidate.ts                # dry-run, prints proposals
 *   tsx cli/memory-consolidate.ts --apply        # commit merges (DELETES originals)
 *   tsx cli/memory-consolidate.ts --json         # machine-readable output
 *   tsx cli/memory-consolidate.ts --max=20       # examine more clusters
 */

import { runConsolidation, formatConsolidationReport } from '../lib/memory-consolidate'
import { PROJECT_DOMAIN_TAGS } from '../services/ensemble-service'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const json = args.includes('--json')
  const maxArg = args.find(a => a.startsWith('--max='))
  const maxClusters = maxArg ? Math.max(1, Math.min(50, parseInt(maxArg.split('=')[1], 10) || 12)) : undefined

  // Convert Record<string, ReadonlySet<string>> → Map<string, Set<string>>
  const tagMap = new Map<string, Set<string>>()
  for (const [project, tags] of Object.entries(PROJECT_DOMAIN_TAGS)) {
    tagMap.set(project, new Set(tags))
  }

  const report = await runConsolidation({
    projectDomainTags: tagMap,
    apply,
    maxClusters,
  })

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log(formatConsolidationReport(report))
}

main().catch(err => {
  console.error('memory-consolidate failed:', err)
  process.exit(1)
})
