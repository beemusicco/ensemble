import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { searchGraph, addKnowledge, isHealthy, isEnabled } from '../lib/cognee-bridge'

describe('cognee-bridge — graceful degradation contract', () => {
  const originalEnv = process.env
  beforeEach(() => {
    vi.resetAllMocks()
    process.env = { ...originalEnv }
  })
  afterEach(() => {
    process.env = originalEnv
  })

  it('isEnabled returns false by default', () => {
    delete process.env.ENSEMBLE_USE_KG
    expect(isEnabled()).toBe(false)
  })

  it('isEnabled returns true when ENSEMBLE_USE_KG=1', () => {
    process.env.ENSEMBLE_USE_KG = '1'
    expect(isEnabled()).toBe(true)
  })

  it('searchGraph returns [] when bridge is disabled (no Cognee call)', async () => {
    delete process.env.ENSEMBLE_USE_KG
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('should not be called')
    })
    const r = await searchGraph('any query')
    expect(r).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('searchGraph returns [] when fetch fails (Cognee down)', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await searchGraph('test query')
    expect(r).toEqual([])
  })

  it('searchGraph returns [] on HTTP error (5xx)', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }))
    const r = await searchGraph('test query')
    expect(r).toEqual([])
  })

  it('searchGraph returns [] on malformed JSON response', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }))
    const r = await searchGraph('test query')
    expect(r).toEqual([])
  })

  it('searchGraph parses well-formed response', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        results: [
          { id: 'node-1', text: 'pattern about retries', score: 0.9 },
          { id: 'node-2', summary: 'pattern about backoff', source: 'docs' },
          { id: 'node-3', text: 'unrelated', score: 0.5 },
        ],
      }), { status: 200 }),
    )
    const r = await searchGraph('retry pattern', { limit: 3 })
    expect(r).toHaveLength(3)
    expect(r[0]).toMatchObject({ id: 'node-1', text: 'pattern about retries', score: 0.9 })
    // Falls back to `summary` field when `text` missing
    expect(r[1]).toMatchObject({ id: 'node-2', text: 'pattern about backoff', source: 'docs' })
  })

  it('searchGraph filters out malformed entries (missing id or text)', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        results: [
          { id: 'ok', text: 'good entry' },
          { id: 'no-text' },                  // missing text → filtered
          { text: 'no-id' },                  // missing id → filtered
          null,                               // null → filtered
          { id: 'ok2', text: 'another good' },
        ],
      }), { status: 200 }),
    )
    const r = await searchGraph('q')
    expect(r.map(x => x.id)).toEqual(['ok', 'ok2'])
  })

  it('searchGraph respects limit', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        results: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, text: `t${i}` })),
      }), { status: 200 }),
    )
    const r = await searchGraph('q', { limit: 3 })
    expect(r).toHaveLength(3)
  })

  it('searchGraph returns [] for empty query (no fetch)', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await searchGraph('   ')
    expect(r).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('addKnowledge returns false when disabled', async () => {
    delete process.env.ENSEMBLE_USE_KG
    const r = await addKnowledge({ key: 'k', text: 't' })
    expect(r).toBe(false)
  })

  it('addKnowledge returns true on 200', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    const r = await addKnowledge({ key: 'failure-x', text: 'gate Y failed', tags: ['failure-pattern'] })
    expect(r).toBe(true)
  })

  it('addKnowledge returns false on network error (Cognee down)', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await addKnowledge({ key: 'k', text: 't' })
    expect(r).toBe(false)
  })

  it('isHealthy returns false when disabled', async () => {
    delete process.env.ENSEMBLE_USE_KG
    expect(await isHealthy()).toBe(false)
  })

  it('isHealthy returns false when Cognee unreachable', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await isHealthy()).toBe(false)
  })

  it('isHealthy returns true on 200', async () => {
    process.env.ENSEMBLE_USE_KG = '1'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    expect(await isHealthy()).toBe(true)
  })
})
