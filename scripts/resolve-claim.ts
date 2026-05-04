#!/usr/bin/env -S node --import tsx
/**
 * resolve-claim.ts — operator/agent-callable to mark a confidence claim's
 * outcome (verified / rejected). Once resolved, the claim contributes to
 * the per-agent calibration curve.
 *
 * Usage:
 *   resolve-claim.ts --id <claim-id> --outcome verified|rejected [--evidence "..."]
 *   resolve-claim.ts --list-pending [--agent <name>]   # show unresolved claims
 *   resolve-claim.ts --calibration <agent>             # show calibration curve
 */

import {
  resolveClaimOutcome,
  computeCalibration,
  formatCalibrationFeedback,
} from '../lib/confidence-tracker'
import { queryMemories } from '../lib/memory-store'

const args = process.argv.slice(2)
function flag(name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

if (args.includes('--list-pending')) {
  const agent = flag('--agent')
  const claims = queryMemories({
    scope: 'global',
    tags: ['confidence-claim', 'outcome:pending'],
    limit: 200,
  })
  const filtered = agent ? claims.filter(c => c.tags.includes(`agent:${agent}`)) : claims
  console.log(`Pending confidence claims${agent ? ` for ${agent}` : ''}: ${filtered.length}`)
  for (const c of filtered.slice(0, 50)) {
    const conf = c.tags.find(t => t.startsWith('confidence:'))?.replace('confidence:', '') ?? '?'
    const ag = c.tags.find(t => t.startsWith('agent:'))?.replace('agent:', '') ?? '?'
    console.log(`  ${c.id}  ${ag} @${conf}%  ${c.value.slice(0, 80)}`)
  }
  process.exit(0)
}

if (args.includes('--calibration')) {
  const agent = flag('--calibration')
  if (!agent) { console.error('--calibration requires agent name'); process.exit(2) }
  const curve = computeCalibration({ agent, windowDays: 60 })
  console.log(formatCalibrationFeedback(curve) || `(insufficient data: ${curve.overallSamples} resolved samples for ${agent}; need 10+)`)
  process.exit(0)
}

const id = flag('--id')
const outcome = flag('--outcome') as 'verified' | 'rejected' | undefined
if (!id || !outcome || !['verified', 'rejected'].includes(outcome)) {
  console.error('Usage: --id <claim-id> --outcome verified|rejected [--evidence "..."]')
  console.error('  OR:  --list-pending [--agent <name>]')
  console.error('  OR:  --calibration <agent>')
  process.exit(2)
}

const r = resolveClaimOutcome({
  claimId: id,
  outcome,
  evidence: flag('--evidence'),
  resolvedBy: 'operator-cli',
})
console.log(`✓ resolved ${id} → ${outcome}  (resolution memory: ${r.id})`)
