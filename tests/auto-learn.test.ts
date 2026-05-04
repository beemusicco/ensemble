import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  classifyError, citationShape, weightLearning,
  recordFailureLearning, recordConfabLearning, recordResolutionLearning,
  TAG, PATTERN_TAGS,
} from '../lib/auto-learn'

describe('classifyError', () => {
  it('classifies common error categories', () => {
    expect(classifyError('ImportError: cannot import name foo')).toBe('import-error')
    expect(classifyError('ModuleNotFoundError: No module named bar')).toBe('import-error')
    expect(classifyError('SyntaxError: invalid syntax')).toBe('syntax-error')
    expect(classifyError('TypeError: argument of type int expected')).toBe('type-error')
    expect(classifyError('AssertionError: 1 != 2')).toBe('test-fail')
    expect(classifyError('test_foo failed')).toBe('test-fail')
    expect(classifyError('TIMEOUT after 240000ms')).toBe('timeout')
    expect(classifyError('permission denied')).toBe('auth-error')
    expect(classifyError('connection refused (econnrefused)')).toBe('network-error')
    expect(classifyError('ENOENT: no such file or directory')).toBe('fs-error')
    expect(classifyError('merge conflict in foo.py')).toBe('merge-conflict')
    expect(classifyError('ruff check failed: E501 line too long')).toBe('lint')
  })

  it('returns "other" for unrecognized errors', () => {
    expect(classifyError('random gibberish')).toBe('other')
    expect(classifyError('')).toBe('other')
  })
})

describe('citationShape', () => {
  it('extracts dir/*.ext from full paths', () => {
    expect(citationShape('frontend/InvoicesPage.jsx:217')).toBe('frontend/*.jsx')
    expect(citationShape('backend/app/api/invoices.py:402')).toBe('backend/*.py')
    expect(citationShape('scripts/sync.sh:14')).toBe('scripts/*.sh')
  })

  it('extracts *.ext from rootless paths', () => {
    expect(citationShape('InvoicesPage.jsx:217')).toBe('*.jsx')
    expect(citationShape('worker.ts:142')).toBe('*.ts')
  })

  it('returns null when no extension', () => {
    expect(citationShape('Makefile:14')).toBeNull()
    expect(citationShape('README:1')).toBeNull()
  })
})

describe('weightLearning', () => {
  const now = new Date().toISOString()

  it('discounts failure-tagged memories to 0.6×', () => {
    const successScore = weightLearning(1.0, [TAG.OUTCOME_SUCCESS], now)
    const failScore = weightLearning(1.0, [TAG.OUTCOME_FAILURE], now)
    // Both decayed identically (just-now), so failScore = 0.6 * successScore
    expect(failScore).toBeCloseTo(successScore * 0.6, 2)
  })

  it('applies exponential decay with ~30-day half-life', () => {
    const fresh = weightLearning(1.0, [], now)
    const oneHalfLifeAgo = new Date(Date.now() - 30 * 86400_000).toISOString()
    const halfLifeScore = weightLearning(1.0, [], oneHalfLifeAgo)
    expect(halfLifeScore).toBeCloseTo(fresh * 0.5, 1)

    const twoHalfLivesAgo = new Date(Date.now() - 60 * 86400_000).toISOString()
    const twoHLScore = weightLearning(1.0, [], twoHalfLivesAgo)
    expect(twoHLScore).toBeCloseTo(fresh * 0.25, 1)
  })

  it('returns 0 score for impossibly-old or invalid timestamps', () => {
    const yearAgo = new Date(Date.now() - 365 * 86400_000).toISOString()
    expect(weightLearning(1.0, [], yearAgo)).toBeLessThan(0.005)
    expect(weightLearning(0, [], now)).toBe(0)
    // Invalid timestamp: keep raw score (no decay applied)
    expect(weightLearning(1.0, [], 'not-a-timestamp')).toBe(1.0)
  })

  it('combines failure discount + recency decay multiplicatively', () => {
    const halfLifeAgo = new Date(Date.now() - 30 * 86400_000).toISOString()
    const score = weightLearning(1.0, [TAG.OUTCOME_FAILURE], halfLifeAgo)
    // 0.6 * 0.5 = 0.3
    expect(score).toBeCloseTo(0.3, 1)
  })
})

describe('record* — writes to memory store', () => {
  let originalDataDir: string | undefined
  let tempRoot: string

  beforeEach(() => {
    originalDataDir = process.env.ENSEMBLE_DATA_DIR
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-learn-'))
    process.env.ENSEMBLE_DATA_DIR = tempRoot
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalDataDir
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('recordFailureLearning persists with correct tags', async () => {
    // Re-import with tempRoot env in effect
    const { recordFailureLearning: rec } = await import('../lib/auto-learn?recF1=' + Date.now())
      .catch(() => import('../lib/auto-learn'))
    const { queryMemoriesSemantic } = await import('../lib/memory-store')

    rec({
      teamId: 'team-123',
      project: 'accounting-helper',
      gateId: 'pytest-diff',
      errorSignature: 'ImportError: cannot import name "parse" from "app.parser"',
      blockers: ['ImportError in test_parser.py:3'],
      iterationsTried: 2,
    })
    const found = queryMemoriesSemantic('pytest import parser', { scope: 'global', limit: 5 })
    const fail = found.find(m => m.tags.includes(TAG.FAILURE_PATTERN))
    expect(fail).toBeDefined()
    expect(fail!.tags).toContain('gate:pytest-diff')
    expect(fail!.tags).toContain('error:import-error')
    expect(fail!.tags).toContain(TAG.OUTCOME_FAILURE)
    expect(fail!.tags).toContain('accounting-helper')
    expect(fail!.value).toContain('Gate "pytest-diff" failed')
  })

  it('recordConfabLearning persists with agent + shape tags', async () => {
    const { recordConfabLearning: rec } = await import('../lib/auto-learn?recC1=' + Date.now())
      .catch(() => import('../lib/auto-learn'))
    const { queryMemoriesSemantic } = await import('../lib/memory-store')

    rec({
      teamId: 'team-456',
      project: 'accounting-helper',
      agent: 'codex-2',
      badCitation: 'frontend/InvoicesPage.jsx:217',
      derivedReal: 'frontend/src/components/InvoiceDetail.jsx:217',
    })
    const found = queryMemoriesSemantic('agent cited path does not exist InvoicesPage', { scope: 'global', limit: 5 })
    const confab = found.find(m => m.tags.includes(TAG.CONFAB_PATTERN))
    expect(confab).toBeDefined()
    expect(confab!.tags).toContain('agent:codex-2')
    expect(confab!.tags).toContain('shape:frontend/*.jsx')
    expect(confab!.value).toContain('does not exist')
    expect(confab!.value).toContain('Closest real path')
  })

  it('recordResolutionLearning persists with success outcome', async () => {
    const { recordResolutionLearning: rec } = await import('../lib/auto-learn?recR1=' + Date.now())
      .catch(() => import('../lib/auto-learn'))
    const { queryMemoriesSemantic } = await import('../lib/memory-store')

    rec({
      teamId: 'team-789',
      project: 'accounting-helper',
      problem: 'Worker stalls leave invoice.data NULL',
      fixApplied: 'Add Reobravnavaj button calling rescanInvoice()',
      evidence: 'frontend/src/components/InvoiceDetail.jsx:217',
    })
    const found = queryMemoriesSemantic('worker stall invoice null', { scope: 'global', limit: 5 })
    const resolution = found.find(m => m.tags.includes(TAG.RESOLUTION))
    expect(resolution).toBeDefined()
    expect(resolution!.tags).toContain(TAG.OUTCOME_SUCCESS)
    expect(resolution!.value).toContain('Worker stalls')
    expect(resolution!.value).toContain('rescanInvoice')
  })
})

describe('PATTERN_TAGS export', () => {
  it('contains all three pattern kinds', () => {
    expect(PATTERN_TAGS).toEqual([
      TAG.FAILURE_PATTERN,
      TAG.CONFAB_PATTERN,
      TAG.RESOLUTION,
    ])
  })
})
