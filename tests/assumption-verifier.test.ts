import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assumption-verifier-test-'))
const prevDataDir = process.env.ENSEMBLE_DATA_DIR
process.env.ENSEMBLE_DATA_DIR = tmpDataDir

const { appendMessage, getMessages } = await import('../lib/ensemble-registry')
const watcher = await import('../lib/unknown-watcher')

describe('assumption verifier (W3 extension)', () => {
  afterAll(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = prevDataDir
  })

  beforeEach(() => {
    watcher._resetAnsweredCache()
  })

  it('still flags bare assumptions (no verify cmd) — preserves W2 behavior', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'codex-1', to: 'team',
      content: '[ASSUMPTION: tenant_id index already exists]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    const flagged = await watcher.flagAssumptions(teamId)
    expect(flagged).toBe(1)
    const out = getMessages(teamId).find(m => (m.content || '').includes('assumption-flag'))
    expect(out).toBeDefined()
    expect(out!.content).toMatch(/tip: append/i)
  })

  it('🟢 verifies assumption when verify command exits 0', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'codex-1', to: 'team',
      content: '[ASSUMPTION: bash is on path ## verify: which bash]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    const flagged = await watcher.flagAssumptions(teamId)
    expect(flagged).toBe(1)
    const out = getMessages(teamId).find(m => (m.content || '').includes('🟢 verified'))
    expect(out).toBeDefined()
    expect(out!.content).toMatch(/bash is on path/)
    expect(out!.meta?.passed).toBe(true)
  })

  it('🔴 rejects assumption when verify command exits non-zero', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'claude-2', to: 'team',
      content: '[ASSUMPTION: foo file exists ## verify: test -f /no/such/path/zzz]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    const flagged = await watcher.flagAssumptions(teamId)
    expect(flagged).toBe(1)
    const out = getMessages(teamId).find(m => (m.content || '').includes('🔴 rejected'))
    expect(out).toBeDefined()
    expect(out!.content).toMatch(/Rejected assumption/)
    expect(out!.meta?.passed).toBe(false)
  })

  it('marks assumption as rejected when verify cmd times out', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'haiku-3', to: 'team',
      content: '[ASSUMPTION: long check ## verify: sleep 30]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    const flagged = await watcher.flagAssumptions(teamId, undefined, { verifyTimeoutMs: 500 })
    expect(flagged).toBe(1)
    const out = getMessages(teamId).find(m => (m.content || '').includes('🔴 rejected'))
    expect(out).toBeDefined()
    expect(out!.meta?.timedOut).toBe(true)
  }, 5000)

  it('does not double-process the same (team, claim, agent) tuple', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'codex-1', to: 'team',
      content: '[ASSUMPTION: same claim ## verify: true]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    expect(await watcher.flagAssumptions(teamId)).toBe(1)
    expect(await watcher.flagAssumptions(teamId)).toBe(0)
  })
})
