import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadBulletproofConfig } from '../lib/bulletproof-config'

describe('auto-detect: vitest diff-scoped', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodetect-vitest-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('emits vitest --changed HEAD when scripts.test contains vitest', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'p', scripts: { test: 'vitest run' },
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.always.find(c => c.id === 'vitest-changed')).toBeDefined()
    expect(cfg.always.find(c => c.id === 'vitest-changed')?.cmd).toMatch(/vitest run --changed HEAD/)
    // npm-test should NOT be emitted (mutually exclusive)
    expect(cfg.always.find(c => c.id === 'npm-test')).toBeUndefined()
  })

  it('emits vitest --changed when devDependencies has vitest (script is e.g. jest)', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'p',
      scripts: { test: 'echo run-tests' },
      devDependencies: { vitest: '^1.0' },
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.always.find(c => c.id === 'vitest-changed')).toBeDefined()
  })

  it('falls back to npm-test when not vitest', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'p',
      scripts: { test: 'jest' },
      devDependencies: { jest: '^29' },
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.always.find(c => c.id === 'npm-test')).toBeDefined()
    expect(cfg.always.find(c => c.id === 'vitest-changed')).toBeUndefined()
  })

  it('subproject monorepo: vitest in frontend/, pytest in backend/', () => {
    fs.mkdirSync(path.join(tmpDir, 'frontend'))
    fs.writeFileSync(path.join(tmpDir, 'frontend/package.json'), JSON.stringify({
      name: 'fe', scripts: { test: 'vitest run' },
    }))
    fs.mkdirSync(path.join(tmpDir, 'backend'))
    fs.writeFileSync(path.join(tmpDir, 'backend/pyproject.toml'), '[project]\n')
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.always.find(c => c.id === 'vitest-changed-frontend')).toBeDefined()
    expect(cfg.always.find(c => c.id === 'vitest-changed-frontend')?.cmd).toMatch(/cd frontend &&/)
    expect(cfg.always.find(c => c.id === 'pytest-diff-backend')).toBeDefined()
  })
})
