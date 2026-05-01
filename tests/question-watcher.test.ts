import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-watcher-test-'))
const prevDataDir = process.env.ENSEMBLE_DATA_DIR
process.env.ENSEMBLE_DATA_DIR = tmpDataDir

// Disable Telegram outbound for tests by clearing the env var.
const prevToken = process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN
delete process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN

const { appendMessage, getMessages } = await import('../lib/ensemble-registry')
const watcher = await import('../lib/question-watcher')

describe('question-watcher (W3)', () => {
  afterAll(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = prevDataDir
    if (prevToken !== undefined) process.env.ENSEMBLE_TELEGRAM_BOT_TOKEN = prevToken
  })

  beforeEach(() => {
    watcher._resetQuestionWatcher()
  })

  it('detects [QUESTION: X] tags and posts a feed marker (Telegram disabled)', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'codex-1', to: 'team',
      content: 'I cannot decide. [QUESTION: Should we use postgres or sqlite for the new collab metadata?]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    const pinged = await watcher.scanAndDispatchQuestions(teamId)
    expect(pinged).toBe(1)
    const marker = getMessages(teamId).find(m => (m.content || '').includes('awaiting answer'))
    expect(marker).toBeDefined()
    expect(marker!.content).toMatch(/postgres or sqlite/)
    expect(marker!.content).toMatch(/question-id:/)
    expect(watcher._pendingCount()).toBe(1)
  })

  it('does not double-ping the same (team, claim, agent) tuple', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'codex-1', to: 'team',
      content: '[QUESTION: same recurring ask]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    expect(await watcher.scanAndDispatchQuestions(teamId)).toBe(1)
    expect(await watcher.scanAndDispatchQuestions(teamId)).toBe(0)
  })

  it('answerQuestion resolves a pending question and posts to feed', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'claude-2', to: 'team',
      content: '[QUESTION: What is the deploy target?]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    await watcher.scanAndDispatchQuestions(teamId)

    const marker = getMessages(teamId).find(m => (m.content || '').includes('question-id:'))
    expect(marker).toBeDefined()
    const idMatch = marker!.content.match(/question-id:\s*([a-f0-9]+)/)
    expect(idMatch).not.toBeNull()
    const questionId = idMatch![1]

    const result = watcher.answerQuestion({ questionId, answer: 'production cluster A' })
    expect(result.resolved).toBe(true)
    expect(result.teamId).toBe(teamId)

    const reply = getMessages(teamId).find(m => (m.content || '').includes('🟢 answer'))
    expect(reply).toBeDefined()
    expect(reply!.content).toMatch(/production cluster A/)
    expect(watcher._pendingCount()).toBe(0)
  })

  it('answerQuestion returns resolved=false for unknown id', () => {
    const result = watcher.answerQuestion({ questionId: 'nope999', answer: 'irrelevant' })
    expect(result.resolved).toBe(false)
  })

  // W2.5g regression — production case 684b61fb 2026-05-01
  it('dedupes within a single scan when same [QUESTION:] appears in multiple agent messages', async () => {
    const teamId = uuidv4()
    // Same agent emits the same [QUESTION:] in 3 different messages (e.g. agent
    // quotes their own pending question in a follow-up summary). Should ping ONCE.
    for (let i = 0; i < 3; i++) {
      appendMessage(teamId, {
        id: `m${i}`, teamId, from: 'codex-1', to: 'team',
        content: `pass ${i}: still waiting on [QUESTION: branch first?]`,
        type: 'chat', timestamp: new Date(Date.now() + i * 1000).toISOString(),
      })
    }
    const pinged = await watcher.scanAndDispatchQuestions(teamId)
    expect(pinged).toBe(1)
    expect(watcher._pendingCount()).toBe(1)
  })

  it('survives "restart" — hydrates pingedKeys from feed events on next scan', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'codex-1', to: 'team',
      content: '[QUESTION: deploy target?]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    expect(await watcher.scanAndDispatchQuestions(teamId)).toBe(1)

    // Simulate server restart — process-local pingedKeys is wiped
    watcher._resetQuestionWatcher()

    // Re-scan the SAME feed. Without hydration this would re-ping (the bug).
    // With hydration, the existing question_pending event in the feed
    // populates pingedKeys before extraction.
    const re = await watcher.scanAndDispatchQuestions(teamId)
    expect(re).toBe(0)
  })

  it('ignores [QUESTION] inside ensemble or operator messages', async () => {
    const teamId = uuidv4()
    appendMessage(teamId, {
      id: 'm1', teamId, from: 'ensemble', to: 'team',
      content: 'Use [QUESTION: ...] when stuck',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    appendMessage(teamId, {
      id: 'm2', teamId, from: 'operator', to: 'team',
      content: '[QUESTION: this is the operator quoting]',
      type: 'chat', timestamp: new Date().toISOString(),
    })
    expect(await watcher.scanAndDispatchQuestions(teamId)).toBe(0)
  })
})
