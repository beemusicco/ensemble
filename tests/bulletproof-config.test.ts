import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadBulletproofConfig, selectChecks } from '../lib/bulletproof-config'

describe('bulletproof-config', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulletproof-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty config when no file and no auto-detect signals', () => {
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.always).toEqual([])
    expect(cfg.high_risk_paths).toEqual([])
    expect(cfg.high_risk_extra).toEqual([])
    expect(cfg.source).toBe('empty')
  })

  it('auto-detects pytest when pyproject.toml exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\n')
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.source).toBe('auto-detected')
    expect(cfg.always.find(c => c.id === 'pytest')).toBeDefined()
    expect(cfg.always.find(c => c.id === 'pytest')?.cmd).toMatch(/pytest/)
  })

  it('auto-detects npm test when package.json has a test script', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'x', scripts: { test: 'vitest run' },
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.source).toBe('auto-detected')
    expect(cfg.always.find(c => c.id === 'npm-test')).toBeDefined()
  })

  it('skips npm test when only the placeholder script is present', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'x', scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.always.find(c => c.id === 'npm-test')).toBeUndefined()
  })

  it('reads .collab-bulletproof.json and validates check shape', () => {
    fs.writeFileSync(path.join(tmpDir, '.collab-bulletproof.json'), JSON.stringify({
      always: [
        { id: 'tests', type: 'cmd', cmd: 'echo ok', timeoutMs: 5000 },
        { id: 'no-todo', type: 'diff_check', pattern: 'TODO' },
        { id: 'must-attest', type: 'attest', message: 'Revert plan' },
        { id: 'invalid-cmd', type: 'cmd' /* missing cmd */ },
      ],
      high_risk_paths: ['src/auth/file.ts'],
      high_risk_extra: [
        { id: 'human-approval', type: 'attest', message: 'operator-approved' },
      ],
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.source).toBe('file')
    expect(cfg.always.map(c => c.id)).toEqual(['tests', 'no-todo', 'must-attest'])  // invalid dropped
    expect(cfg.high_risk_paths).toEqual(['src/auth/file.ts'])
    expect(cfg.high_risk_extra).toHaveLength(1)
  })

  it('falls back to auto-detect when JSON is malformed', () => {
    fs.writeFileSync(path.join(tmpDir, '.collab-bulletproof.json'), '{ not json')
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'x', scripts: { test: 'vitest' },
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.source).toBe('auto-detected')
    expect(cfg.always.find(c => c.id === 'npm-test')).toBeDefined()
  })

  it('selectChecks adds high_risk_extra when modified path matches a glob', () => {
    const cfg = {
      source: 'file' as const,
      always: [{ id: 'a', type: 'cmd' as const, cmd: 'echo' }],
      high_risk_paths: ['src/auth/*.ts'],
      high_risk_extra: [{ id: 'b', type: 'attest' as const, message: 'approved' }],
    }
    const hit = selectChecks(cfg, ['src/auth/login.ts', 'README.md'])
    expect(hit.checks.map(c => c.id)).toEqual(['a', 'b'])
    expect(hit.highRiskHit).toBe('src/auth/login.ts')

    const miss = selectChecks(cfg, ['README.md'])
    expect(miss.checks.map(c => c.id)).toEqual(['a'])
    expect(miss.highRiskHit).toBeNull()
  })

  it('selectChecks supports double-star globs across nested dirs', () => {
    const cfg = {
      source: 'file' as const,
      always: [],
      high_risk_paths: ['scripts/migrations/**'],
      high_risk_extra: [{ id: 'm', type: 'attest' as const, message: 'reviewed' }],
    }
    const hit = selectChecks(cfg, ['scripts/migrations/2026/up.sql'])
    expect(hit.highRiskHit).toBe('scripts/migrations/2026/up.sql')
    expect(hit.checks).toHaveLength(1)
  })

  // ── W2.5c: monorepo-aware auto-detect ─────────────────────────────────

  it('detects pytest in subproject (backend/) for monorepo layouts', () => {
    fs.mkdirSync(path.join(tmpDir, 'backend'))
    fs.writeFileSync(path.join(tmpDir, 'backend/pyproject.toml'), '[project]\n')
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.source).toBe('auto-detected')
    const pytest = cfg.always.find(c => c.id === 'pytest-backend')
    expect(pytest).toBeDefined()
    expect(pytest!.cmd).toMatch(/cd backend &&/)
    expect(pytest!.cmd).toMatch(/not e2e and not slow/)
  })

  it('detects npm test in subproject (frontend/) for monorepo layouts', () => {
    fs.mkdirSync(path.join(tmpDir, 'frontend'))
    fs.writeFileSync(path.join(tmpDir, 'frontend/package.json'), JSON.stringify({
      name: 'fe', scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit' },
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.source).toBe('auto-detected')
    expect(cfg.always.find(c => c.id === 'npm-test-frontend')).toBeDefined()
    expect(cfg.always.find(c => c.id === 'lint-frontend')).toBeDefined()
    expect(cfg.always.find(c => c.id === 'typecheck-frontend')).toBeDefined()
  })

  it('emits diff-scoped ruff when pyproject.toml mentions ruff', () => {
    fs.mkdirSync(path.join(tmpDir, 'backend'))
    fs.writeFileSync(path.join(tmpDir, 'backend/pyproject.toml'),
      '[project]\ndependencies = ["ruff>=0.8"]\n[tool.ruff]\n')
    const cfg = loadBulletproofConfig(tmpDir)
    const ruff = cfg.always.find(c => c.id === 'ruff-diff-backend')
    expect(ruff).toBeDefined()
    expect(ruff!.cmd).toMatch(/git diff HEAD --name-only --diff-filter=ACMR/)
    expect(ruff!.cmd).toMatch(/git ls-files --others --exclude-standard/)
    expect(ruff!.cmd).toMatch(/xargs -0 -r ruff check/)
  })

  it('does NOT emit ruff when pyproject.toml has no ruff dependency', () => {
    fs.mkdirSync(path.join(tmpDir, 'backend'))
    fs.writeFileSync(path.join(tmpDir, 'backend/pyproject.toml'),
      '[project]\ndependencies = ["pytest>=8"]\n')
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.always.find(c => c.id?.startsWith('ruff'))).toBeUndefined()
  })

  it('handles full monorepo: backend (Python+ruff) + frontend (Node)', () => {
    fs.mkdirSync(path.join(tmpDir, 'backend'))
    fs.writeFileSync(path.join(tmpDir, 'backend/pyproject.toml'),
      '[project]\ndependencies=["ruff>=0.8"]\n[tool.ruff]\n')
    fs.mkdirSync(path.join(tmpDir, 'frontend'))
    fs.writeFileSync(path.join(tmpDir, 'frontend/package.json'), JSON.stringify({
      name: 'fe', scripts: { test: 'vitest run', lint: 'eslint .' },
    }))
    const cfg = loadBulletproofConfig(tmpDir)
    const ids = cfg.always.map(c => c.id)
    expect(ids).toContain('pytest-backend')
    expect(ids).toContain('ruff-diff-backend')
    expect(ids).toContain('npm-test-frontend')
    expect(ids).toContain('lint-frontend')
  })

  it('skips noisy subdirs (node_modules, .venv, dist, .git)', () => {
    for (const skip of ['node_modules', '.venv', 'dist', '.git', '__pycache__']) {
      fs.mkdirSync(path.join(tmpDir, skip))
      fs.writeFileSync(path.join(tmpDir, skip, 'package.json'), JSON.stringify({
        name: 'noise', scripts: { test: 'echo never run' },
      }))
    }
    const cfg = loadBulletproofConfig(tmpDir)
    // None of the noise should show up as detected checks
    for (const id of cfg.always.map(c => c.id)) {
      expect(id).not.toMatch(/node_modules|venv|dist/)
    }
  })

  it('detects Cargo + Go projects', () => {
    fs.mkdirSync(path.join(tmpDir, 'rust-svc'))
    fs.writeFileSync(path.join(tmpDir, 'rust-svc/Cargo.toml'), '[package]\n')
    fs.mkdirSync(path.join(tmpDir, 'go-svc'))
    fs.writeFileSync(path.join(tmpDir, 'go-svc/go.mod'), 'module x\n')
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.always.find(c => c.id === 'cargo-test-rust_svc')).toBeDefined()
    expect(cfg.always.find(c => c.id === 'go-test-go_svc')).toBeDefined()
  })

  it('still works for single-project root (back-compat)', () => {
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\n')
    const cfg = loadBulletproofConfig(tmpDir)
    expect(cfg.source).toBe('auto-detected')
    // Root-level check has no subdir suffix
    expect(cfg.always.find(c => c.id === 'pytest')).toBeDefined()
  })
})
