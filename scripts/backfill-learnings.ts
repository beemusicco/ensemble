#!/usr/bin/env -S node --import tsx
/**
 * backfill-learnings.ts — bootstrap pattern memories from historical feed.jsonl.
 *
 * Why this exists: lib/auto-learn.ts (W4) writes failure-pattern + confab-pattern
 * memories on every collab outcome going forward — but the memory store starts
 * EMPTY for these tags. The first 5-10 collabs after W4 ships have nothing to
 * inject because no patterns have been written yet.
 *
 * 7-day production data has ~88 confabulation events + ~17 auto_fix_exhausted
 * events sitting in ~/.ensemble/ensemble/messages/<teamId>/feed.jsonl. Those
 * are EXACTLY the patterns next teams need to see. This script reads them and
 * writes retroactive learnings, so day-0 of W4 has useful pattern memories.
 *
 * Idempotent: writeMemory creates new rows with random UUIDs, so re-running
 * adds duplicates. To avoid that we tag each backfill row with `backfill:v1`
 * and skip events whose teamId+citation already exist with that tag.
 *
 * Scope: confabulation events only on this pass. auto_fix_exhausted events
 * lack direct gate-id + error-signature in their meta; would need cross-
 * message correlation with verify-runner output to backfill. Out of scope
 * for v1 — confabs alone account for the bulk of recurring patterns.
 *
 * Usage:
 *   npx tsx scripts/backfill-learnings.ts             # apply
 *   npx tsx scripts/backfill-learnings.ts --dry-run   # show counts, write nothing
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { recordConfabLearning, TAG } from '../lib/auto-learn'
import { queryMemories, writeMemory } from '../lib/memory-store'

const DRY_RUN = process.argv.includes('--dry-run')
const ENSEMBLE_DIR = path.join(os.homedir(), '.ensemble', 'ensemble')
const MESSAGES_DIR = path.join(ENSEMBLE_DIR, 'messages')
const TEAMS_FILE = path.join(ENSEMBLE_DIR, 'teams.json')

type Team = { id: string; workingDirectory?: string; name?: string }
type ConfabEvent = {
  teamId: string
  agent: string
  citation: string
  timestamp: string
}

function loadTeams(): Map<string, Team> {
  if (!fs.existsSync(TEAMS_FILE)) return new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf-8'))
    const list: Team[] = Array.isArray(raw) ? raw : (raw.teams ?? [])
    return new Map(list.map(t => [t.id, t]))
  } catch {
    return new Map()
  }
}

function projectFromCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined
  return path.basename(cwd)
}

function scanConfabEvents(): ConfabEvent[] {
  if (!fs.existsSync(MESSAGES_DIR)) return []
  const events: ConfabEvent[] = []
  for (const teamDir of fs.readdirSync(MESSAGES_DIR)) {
    const feedFile = path.join(MESSAGES_DIR, teamDir, 'feed.jsonl')
    if (!fs.existsSync(feedFile)) continue
    let lines: string[]
    try {
      lines = fs.readFileSync(feedFile, 'utf-8').split('\n').filter(Boolean)
    } catch { continue }
    for (const line of lines) {
      let msg: { meta?: { event?: string; agent?: string; citation?: string }; teamId?: string; timestamp?: string }
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.meta?.event !== 'confabulation') continue
      if (!msg.meta?.agent || !msg.meta?.citation) continue
      events.push({
        teamId: msg.teamId ?? teamDir,
        agent: msg.meta.agent,
        citation: msg.meta.citation,
        timestamp: msg.timestamp ?? new Date().toISOString(),
      })
    }
  }
  return events
}

function alreadyBackfilled(): Set<string> {
  // Existing backfill rows are tagged with `backfill:v1`. We pull all of them
  // (recency-based, no semantic scoring needed — we want EVERY existing
  // backfill row, not the relevant ones) and key by `<agent>::<citation>`
  // so we don't duplicate on re-run.
  const found = new Set<string>()
  try {
    const memories = queryMemories({
      scope: 'global',
      tags: ['backfill:v1'],
      limit: 500,
    })
    for (const m of memories) {
      if (!m.tags.includes(TAG.CONFAB_PATTERN)) continue
      const agentTag = m.tags.find(t => t.startsWith('agent:'))
      const agent = agentTag?.replace('agent:', '') ?? ''
      const citationMatch = m.value.match(/cited a path that does not exist:\s*(\S+)/)
      const citation = citationMatch?.[1]
      if (agent && citation) found.add(`${agent}::${citation}`)
    }
  } catch { /* memory store may not exist on first call — ignore */ }
  return found
}

function main(): void {
  const teams = loadTeams()
  const events = scanConfabEvents()
  const seen = alreadyBackfilled()

  console.log(`📜 Scanned: ${events.length} historical confab events`)
  console.log(`📚 Already backfilled: ${seen.size}`)
  if (DRY_RUN) console.log('--- DRY RUN — no writes ---')

  let written = 0
  let skipped = 0
  const byProject = new Map<string, number>()
  const byAgent = new Map<string, number>()
  for (const e of events) {
    const key = `${e.agent}::${e.citation}`
    if (seen.has(key)) { skipped++; continue }
    seen.add(key)
    const team = teams.get(e.teamId)
    const project = projectFromCwd(team?.workingDirectory)

    if (!DRY_RUN) {
      // Use the existing primitive but inject one extra tag (`backfill:v1`)
      // so re-runs of this script don't duplicate. recordConfabLearning
      // doesn't accept extra tags, so we mirror its writeMemory shape
      // here with the backfill marker added.
      const tags: string[] = [
        TAG.CONFAB_PATTERN,
        `agent:${e.agent.replace(/[^a-z0-9-]/gi, '_').slice(0, 40)}`,
        TAG.OUTCOME_FAILURE,
        'backfill:v1',
      ]
      if (project) tags.push(project.replace(/[^a-z0-9-]/gi, '_').slice(0, 40))
      // Citation shape: "<dir>/*.ext"
      const pathOnly = e.citation.replace(/:\d+$/, '')
      const ext = pathOnly.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
      const segments = pathOnly.split('/').filter(Boolean)
      const shape = ext
        ? (segments.length >= 2 ? `${segments[0]}/*.${ext}` : `*.${ext}`)
        : null
      if (shape) tags.push(`shape:${shape}`)
      writeMemory({
        scope: 'global',
        teamId: e.teamId,
        key: `confab:${e.agent}:${shape ?? 'unknown'}:${e.teamId.slice(0, 8)}-bf`,
        value: [
          `Agent "${e.agent}" cited a path that does not exist: ${e.citation}`,
          `(Backfilled from historical feed; original timestamp: ${e.timestamp})`,
          `Lesson: BEFORE citing a path, verify with "git ls-files <pattern>" or "ls <dir>".`,
        ].join('\n'),
        tags,
      })
    }
    written++
    if (project) byProject.set(project, (byProject.get(project) ?? 0) + 1)
    byAgent.set(e.agent, (byAgent.get(e.agent) ?? 0) + 1)
  }

  console.log(`\n${DRY_RUN ? 'WOULD WRITE' : 'WROTE'}: ${written} new confab-pattern memories`)
  console.log(`Skipped (already backfilled): ${skipped}`)
  if (byProject.size) {
    console.log('\nBy project:')
    for (const [p, n] of [...byProject].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${p.padEnd(30)} ${n}`)
    }
  }
  if (byAgent.size) {
    console.log('\nBy agent:')
    for (const [a, n] of [...byAgent].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${a.padEnd(20)} ${n}`)
    }
  }
}

main()
