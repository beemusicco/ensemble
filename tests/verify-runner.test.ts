import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runVerifyChecks, formatVerifySummary } from '../lib/verify-runner'
import type { BulletproofConfig } from '../lib/bulletproof-config'

function cfg(overrides: Partial<BulletproofConfig> = {}): BulletproofConfig {
  return {
    always: [],
    high_risk_paths: [],
    high_risk_extra: [],
    source: 'file',
    ...overrides,
  }
}

describe('verify-runner', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-runner-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty summary when no checks configured', async () => {
    const summary = await runVerifyChecks({ cfg: cfg(), workingDirectory: tmpDir, modifiedPaths: [] })
    expect(summary.results).toEqual([])
    expect(summary.passed).toBe(0)
    expect(summary.failed).toBe(0)
  })

  it('passes a cmd check when the command exits 0', async () => {
    const summary = await runVerifyChecks({
      cfg: cfg({ always: [{ id: 'echo', type: 'cmd', cmd: 'echo hello', timeoutMs: 5000 }] }),
      workingDirectory: tmpDir,
      modifiedPaths: [],
    })
    expect(summary.results[0].status).toBe('pass')
    expect(summary.results[0].exitCode).toBe(0)
    expect(summary.results[0].output).toMatch(/hello/)
  })

  it('fails a cmd check when the command exits non-zero', async () => {
    const summary = await runVerifyChecks({
      cfg: cfg({ always: [{ id: 'fail', type: 'cmd', cmd: 'exit 7', timeoutMs: 5000 }] }),
      workingDirectory: tmpDir,
      modifiedPaths: [],
    })
    expect(summary.results[0].status).toBe('fail')
    expect(summary.results[0].exitCode).toBe(7)
    expect(summary.failed).toBe(1)
  })

  it('marks a cmd check failed on timeout', async () => {
    const summary = await runVerifyChecks({
      cfg: cfg({ always: [{ id: 'sleeper', type: 'cmd', cmd: 'sleep 30', timeoutMs: 1000 }] }),
      workingDirectory: tmpDir,
      modifiedPaths: [],
    })
    expect(summary.results[0].status).toBe('fail')
    expect(summary.results[0].reason).toBe('timeout')
    expect(summary.results[0].output).toMatch(/TIMEOUT/)
  }, 10_000)

  it('attest check passes when verify messages contain the required substring', async () => {
    const summary = await runVerifyChecks({
      cfg: cfg({ always: [{ id: 'must-revert', type: 'attest', message: 'Revert plan:' }] }),
      workingDirectory: tmpDir,
      verifyMessagesText: 'tests pass\nrevert plan: git reset HEAD~\n',
      modifiedPaths: [],
    })
    expect(summary.results[0].status).toBe('pass')
  })

  it('attest check fails when message text is absent', async () => {
    const summary = await runVerifyChecks({
      cfg: cfg({ always: [{ id: 'must-revert', type: 'attest', message: 'Revert plan:' }] }),
      workingDirectory: tmpDir,
      verifyMessagesText: 'tests pass — looks good',
      modifiedPaths: [],
    })
    expect(summary.results[0].status).toBe('fail')
    expect(summary.results[0].output).toMatch(/Required attestation/)
  })

  it('formatVerifySummary returns a single line when no checks ran', () => {
    const text = formatVerifySummary({
      results: [], passed: 0, failed: 0, errored: 0, skipped: 0,
      highRiskHit: null, configSource: 'empty',
    })
    expect(text).toMatch(/no checks configured/)
  })

  it('formatVerifySummary leads with PASS or FAIL banner', () => {
    const passText = formatVerifySummary({
      results: [{ id: 'a', type: 'cmd', status: 'pass', exitCode: 0, durationMs: 12, output: 'ok' }],
      passed: 1, failed: 0, errored: 0, skipped: 0, highRiskHit: null, configSource: 'file',
    })
    expect(passText).toMatch(/✅ PASS/)

    const failText = formatVerifySummary({
      results: [{ id: 'a', type: 'cmd', status: 'fail', exitCode: 1, durationMs: 12, output: 'boom' }],
      passed: 0, failed: 1, errored: 0, skipped: 0, highRiskHit: null, configSource: 'file',
    })
    expect(failText).toMatch(/❌ FAIL/)
    expect(failText).toMatch(/boom/)
  })
})
