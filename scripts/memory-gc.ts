#!/usr/bin/env -S node --import tsx
/**
 * memory-gc.ts — operator-runnable + cron-friendly GC for the memory store.
 *
 * Default mode: APPLY. The retention rules in lib/memory-gc.ts are
 * conservative (resolutions never expire, failures 1y, reflections 90d) so
 * apply-mode is safe. To audit first, pass --dry-run.
 *
 * Override path: ~/.ensemble/memory-retention.json — JSON array of
 * { tagPattern, retentionDays, reason } objects. See DEFAULT_RETENTION_RULES
 * for the format. Operator-declared rules REPLACE defaults entirely.
 *
 * Cron candidate: weekly Sunday 03:00 (after memory-consolidate at 04:00 —
 * ordering matters; consolidate writes new aggregates that GC shouldn't
 * touch on the same day). See launchd/co.openclaw.ensemble-memory-gc.plist.template.
 */

import { runMemoryGc, formatGcReport } from '../lib/memory-gc'

const DRY_RUN = process.argv.includes('--dry-run')
const JSON_OUT = process.argv.includes('--json')

const report = runMemoryGc({ dryRun: DRY_RUN })

if (JSON_OUT) {
  console.log(JSON.stringify({
    ...report,
    perRule: report.perRule.map(r => ({
      tagPattern: r.rule.tagPattern,
      retentionDays: r.rule.retentionDays,
      reason: r.rule.reason,
      matched: r.matched,
      deleted: r.deleted,
    })),
  }))
} else {
  console.log(formatGcReport(report))
}
process.exit(0)
