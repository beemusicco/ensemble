import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

// Set the data dir BEFORE importing memory-store / registry so SQLite + the
// messages dir resolve to a temp location for the duration of this test file.
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unknown-watcher-test-'))
const prevDataDir = process.env.ENSEMBLE_DATA_DIR
process.env.ENSEMBLE_DATA_DIR = tmpDataDir

const { writeMemory } = await import('../lib/memory-store')
const { appendMessage, getMessages } = await import('../lib/ensemble-registry')
const watcher = await import('../lib/unknown-watcher')

describe('unknown-watcher', () => {
  beforeAll(() => {
    // make sure docs path is missing so we exercise the memory-only path
    // (rg may or may not be installed and the user's docs may have hits we
    // don't control — keep the test deterministic by ignoring that branch)
  })

  afterAll(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = prevDataDir
  })

  beforeEach(() => {
    watcher._resetAnsweredCache()
  })

  it('extracts [UNKNOWN: ...] tags and posts an answer back to the team feed', async () => {
    writeMemory({
      scope: 'global',
      key: 'libro_tenant_id_rule',
      value: 'every libro endpoint must filter by session.tenant_id',
      tags: ['libro', 'tenant_id'],
    })

    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'codex-1', to: 'team',
      content: 'I need to add a books endpoint. [UNKNOWN: tenant_id filtering convention]',
      type: 'chat', timestamp: new Date().toISOString(),
    })

    const answered = await watcher.scanAndAnswerUnknowns(teamId)
    expect(answered).toBe(1)

    const msgs = getMessages(teamId)
    const reply = msgs.find(m => m.from === 'ensemble' && (m.content || '').includes('ensemble-research'))
    expect(reply).toBeDefined()
    expect(reply!.content).toMatch(/tenant_id/)
  })

  it('does not double-answer the same (team, tag, agent) tuple', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'codex-1', to: 'team',
      content: '[UNKNOWN: same question xyz]',
      type: 'chat', timestamp: new Date().toISOString(),
    })

    const first = await watcher.scanAndAnswerUnknowns(teamId)
    expect(first).toBe(1)
    const second = await watcher.scanAndAnswerUnknowns(teamId)
    expect(second).toBe(0)
  })

  it('flagAssumptions surfaces [ASSUMPTION: ...] tags as warnings', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'claude-2', to: 'team',
      content: '[ASSUMPTION: the index already has tenant_id]',
      type: 'chat', timestamp: new Date().toISOString(),
    })

    const flagged = await watcher.flagAssumptions(teamId)
    expect(flagged).toBe(1)

    const flag = getMessages(teamId).find(m => (m.content || '').includes('assumption-flag'))
    expect(flag).toBeDefined()
    expect(flag!.content).toMatch(/the index already has tenant_id/)
  })

  it('ignores tags inside ensemble-authored messages', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'ensemble', to: 'team',
      content: 'reminder: use [UNKNOWN: protocol-name] tags when stuck',
      type: 'chat', timestamp: new Date().toISOString(),
    })

    const answered = await watcher.scanAndAnswerUnknowns(teamId)
    expect(answered).toBe(0)
  })
})
