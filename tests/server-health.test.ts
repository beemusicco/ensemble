import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalDataDir = process.env.ENSEMBLE_DATA_DIR

let tempRoot: string

describe('buildHealthReport — component-aware probe', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-health-'))
    process.env.ENSEMBLE_DATA_DIR = tempRoot
    vi.resetModules()
  })

  afterEach(() => {
    vi.resetModules()
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* */ }
    if (originalDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = originalDataDir
  })

  it('returns status=healthy with all component keys when paths are writable', async () => {
    const { buildHealthReport } = await import('../lib/health')
    const report = await buildHealthReport('9.9.9')
    expect(report).toMatchObject({
      status: 'healthy',
      version: '9.9.9',
      uptimeS: expect.any(Number),
      components: expect.objectContaining({
        memoryDb: 'ok',
        logsWritable: 'ok',
        tracesWritable: 'ok',
      }),
    })
    // diskFreeGb must be a number on any sane host; null only if statfs throws
    expect(typeof report.components.diskFreeGb).toBe('number')
  })

  it('returns status=degraded when logs directory cannot be created', async () => {
    // Regular file masks the would-be data dir → mkdir('<file>/logs') rejects
    const blocker = path.join(tempRoot, 'not-a-dir')
    fs.writeFileSync(blocker, 'x')
    process.env.ENSEMBLE_DATA_DIR = blocker
    vi.resetModules()
    const { buildHealthReport } = await import('../lib/health')
    const report = await buildHealthReport('t')
    expect(report.status).toBe('degraded')
    expect(report.components.logsWritable).toBe('fail')
  })
})
