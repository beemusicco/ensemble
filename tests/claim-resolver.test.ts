import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { recordConfidenceClaim } from '../lib/confidence-tracker'
import { collabMessagesFile, collabRuntimeDir } from '../lib/collab-paths'
import { queryMemories } from '../lib/memory-store'
import { jaccardSimilarity, resolveLinkedClaimsForTeam } from '../lib/claim-resolver'

function writeMsg(teamId: string, msg: Record<string, unknown>): void {
  const dir = collabRuntimeDir(teamId)
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(collabMessagesFile(teamId), JSON.stringify(msg) + '\n')
}

describe('jaccardSimilarity', () => {
  it('returns 1 for identical token sets', () => {
    expect(jaccardSimilarity(new Set(['foo', 'bar', 'baz']), new Set(['foo', 'bar', 'baz']))).toBe(1)
  })
  it('returns 0 for disjoint sets', () => {
    expect(jaccardSimilarity(new Set(['a', 'b']), new Set(['c', 'd']))).toBe(0)
  })
  it('returns 0 for empty input', () => {
    expect(jaccardSimilarity(new Set(), new Set(['a']))).toBe(0)
  })
  it('partial overlap is interior', () => {
    const sim = jaccardSimilarity(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))
    expect(sim).toBeGreaterThan(0.4)
    expect(sim).toBeLessThan(0.6)
  })
})

describe('resolveLinkedClaimsForTeam', () => {
  let tempDir: string
  const originalDataDir = process.env.ENSEMBLE_DATA_DIR
  const teamIds: string[] = []

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-resolver-'))
    process.env.ENSEMBLE_DATA_DIR = tempDir
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalDataDir
    fs.rmSync(tempDir, { recursive: true, force: true })
    for (const tid of teamIds) {
      fs.rmSync(collabRuntimeDir(tid), { recursive: true, force: true })
    }
    teamIds.length = 0
  })

  function newTeamId(suffix: string): string {
    const tid = `claim-resolver-test-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    teamIds.push(tid)
    return tid
  }

  it('resolves a claim when a verified assumption shares enough tokens', () => {
    const teamId = newTeamId('A')
    const claim = recordConfidenceClaim({
      agent: 'claude-1',
      confidence: 80,
      claim: 'backend has a write-through cache layer that handles tenant isolation',
      teamId,
    })
    writeMsg(teamId, {
      id: 'm1',
      teamId,
      from: 'ensemble',
      to: 'team',
      content: 'verify result',
      type: 'chat',
      timestamp: new Date().toISOString(),
      meta: {
        event: 'assumption_verified',
        passed: true,
        agent: 'claude-1',
        claim: 'backend has a write-through cache layer for tenant isolation',
      },
    })

    const r = resolveLinkedClaimsForTeam(teamId)
    expect(r.resolved).toBe(1)
    expect(r.matched[0].outcome).toBe('verified')
    const resolutions = queryMemories({ scope: 'global', tags: ['confidence-resolution'] })
    expect(resolutions.length).toBe(1)
    expect(resolutions[0].tags).toContain(`claim-id:${claim.id}`)
    expect(resolutions[0].tags).toContain('outcome:verified')
  })

  it('propagates rejected outcome from a failed assumption', () => {
    const teamId = newTeamId('B')
    recordConfidenceClaim({
      agent: 'codex-2',
      confidence: 75,
      claim: 'mlkit document scanner ships in capacitor 8 plugin',
      teamId,
    })
    writeMsg(teamId, {
      id: 'm1',
      teamId,
      from: 'ensemble',
      to: 'team',
      content: 'verify result',
      type: 'chat',
      timestamp: new Date().toISOString(),
      meta: {
        event: 'assumption_verified',
        passed: false,
        agent: 'codex-2',
        claim: 'mlkit document scanner ships in capacitor 8 plugin tree',
      },
    })

    const r = resolveLinkedClaimsForTeam(teamId)
    expect(r.resolved).toBe(1)
    expect(r.matched[0].outcome).toBe('rejected')
  })

  it('does not match across agents', () => {
    const teamId = newTeamId('C')
    recordConfidenceClaim({
      agent: 'claude-1',
      confidence: 80,
      claim: 'frontend handles tenant isolation correctly',
      teamId,
    })
    writeMsg(teamId, {
      id: 'm1',
      teamId,
      from: 'ensemble',
      to: 'team',
      content: 'verify result',
      type: 'chat',
      timestamp: new Date().toISOString(),
      meta: {
        event: 'assumption_verified',
        passed: true,
        agent: 'sonnet-2',
        claim: 'frontend handles tenant isolation correctly',
      },
    })
    const r = resolveLinkedClaimsForTeam(teamId)
    expect(r.resolved).toBe(0)
    expect(r.pending).toBe(1)
  })

  it('does not match when token overlap is below threshold', () => {
    const teamId = newTeamId('D')
    recordConfidenceClaim({
      agent: 'claude-1',
      confidence: 70,
      claim: 'gradle release build pulls mlkit document scanner aar from google maven',
      teamId,
    })
    writeMsg(teamId, {
      id: 'm1',
      teamId,
      from: 'ensemble',
      to: 'team',
      content: 'verify result',
      type: 'chat',
      timestamp: new Date().toISOString(),
      meta: {
        event: 'assumption_verified',
        passed: true,
        agent: 'claude-1',
        claim: 'tenant isolation works on the backend api routes',
      },
    })
    const r = resolveLinkedClaimsForTeam(teamId)
    expect(r.resolved).toBe(0)
  })

  it('returns zero when no assumption_verified events exist', () => {
    const teamId = newTeamId('E')
    recordConfidenceClaim({ agent: 'claude-1', confidence: 80, claim: 'something here', teamId })
    const r = resolveLinkedClaimsForTeam(teamId)
    expect(r.resolved).toBe(0)
    expect(r.pending).toBe(1)
  })
})
