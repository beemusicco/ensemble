import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'

const SCRIPT = path.resolve(process.cwd(), 'scripts/pytest-diff.sh')

/**
 * Set up a tiny git repo with a known set of files, commit them as the
 * "master" baseline, then optionally make changes that the script should
 * pick up via `git diff HEAD`. Each test gets its own tempdir.
 */
function setupRepo(opts: {
  baseline: Record<string, string>      // committed files
  changed?: Record<string, string>      // additional diffs
}): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pytest-diff-'))
  for (const [rel, body] of Object.entries(opts.baseline)) {
    const full = path.join(dir, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  // Provide a minimal pyproject so pytest can collect; conftest no-op so
  // collection doesn't blow up on missing rootdir markers.
  if (!opts.baseline['pyproject.toml']) {
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "tmp"\nversion = "0.0.0"\n')
  }
  if (!opts.baseline['conftest.py']) {
    fs.writeFileSync(path.join(dir, 'conftest.py'), '')
  }
  execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm baseline', { cwd: dir })
  if (opts.changed) {
    for (const [rel, body] of Object.entries(opts.changed)) {
      const full = path.join(dir, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    }
  }
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

/**
 * Exercise the script up to the point where it would invoke pytest. We
 * dry-run by replacing the `pytest` invocation with `echo` via PATH override:
 * a fake `pytest` shim in a temp bin dir gets called instead.
 */
function runScriptDryRun(repoDir: string): { stdout: string; status: number } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pytest-diff-bin-'))
  const shim = path.join(binDir, 'pytest')
  fs.writeFileSync(
    shim,
    '#!/usr/bin/env bash\necho "[shim:pytest] args=$*"\nexit 0\n',
  )
  fs.chmodSync(shim, 0o755)
  try {
    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
    }
    const stdout = execSync(`bash ${SCRIPT} --debug`, {
      cwd: repoDir,
      env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { stdout, status: 0 }
  } catch (e: unknown) {
    const err = e as { stdout?: Buffer; status?: number }
    return {
      stdout: err.stdout?.toString('utf-8') ?? '',
      status: err.status ?? -1,
    }
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true })
  }
}

describe('pytest-diff.sh', () => {
  const teardowns: Array<() => void> = []
  afterEach(() => {
    while (teardowns.length) teardowns.pop()!()
  })

  it('no .py changes → falls back to --collect-only smoke', () => {
    const repo = setupRepo({
      baseline: {
        'app/foo.py': 'def hi(): return 1\n',
        'tests/test_foo.py': 'from app.foo import hi\ndef test_hi(): assert hi() == 1\n',
        'README.md': 'docs',
      },
      changed: {
        'README.md': 'docs updated',
      },
    })
    teardowns.push(repo.cleanup)
    const { stdout, status } = runScriptDryRun(repo.dir)
    expect(status).toBe(0)
    expect(stdout).toMatch(/no changed test\/source files — running smoke/)
    expect(stdout).toMatch(/--collect-only/)
  })

  it('changed test file → pytest scoped to that test file', () => {
    const repo = setupRepo({
      baseline: {
        'tests/test_foo.py': 'def test_a(): assert True\n',
      },
      changed: {
        'tests/test_foo.py': 'def test_a(): assert True\ndef test_b(): assert True\n',
      },
    })
    teardowns.push(repo.cleanup)
    const { stdout, status } = runScriptDryRun(repo.dir)
    expect(status).toBe(0)
    expect(stdout).toMatch(/scoped to:/)
    expect(stdout).toMatch(/tests\/test_foo\.py/)
    expect(stdout).toMatch(/\[shim:pytest\] args=.*tests\/test_foo\.py/)
  })

  it('untracked test file → picked up via git ls-files --others', () => {
    const repo = setupRepo({
      baseline: { 'tests/test_existing.py': 'def test(): pass\n' },
    })
    teardowns.push(repo.cleanup)
    fs.writeFileSync(
      path.join(repo.dir, 'tests/test_new.py'),
      'def test_new(): pass\n',
    )
    const { stdout, status } = runScriptDryRun(repo.dir)
    expect(status).toBe(0)
    expect(stdout).toMatch(/tests\/test_new\.py/)
  })

  it('changed source file → derives test_<basename>.py via find', () => {
    const repo = setupRepo({
      baseline: {
        'app/parser.py': 'def parse(): return None\n',
        'tests/test_parser.py': 'from app.parser import parse\ndef test_p(): parse()\n',
      },
      changed: {
        'app/parser.py': 'def parse(): return 42\n',
      },
    })
    teardowns.push(repo.cleanup)
    const { stdout, status } = runScriptDryRun(repo.dir)
    expect(status).toBe(0)
    expect(stdout).toMatch(/scoped to:/)
    expect(stdout).toMatch(/tests\/test_parser\.py/)
    expect(stdout).toMatch(/\[shim:pytest\] args=.*tests\/test_parser\.py/)
  })

  it('changed source file → derives <basename>_test.py alternate naming', () => {
    const repo = setupRepo({
      baseline: {
        'app/util.py': 'def u(): return 1\n',
        'tests/util_test.py': 'from app.util import u\ndef test_u(): u()\n',
      },
      changed: {
        'app/util.py': 'def u(): return 2\n',
      },
    })
    teardowns.push(repo.cleanup)
    const { stdout, status } = runScriptDryRun(repo.dir)
    expect(status).toBe(0)
    expect(stdout).toMatch(/util_test\.py/)
  })

  it('mixed: changed test + changed source → both run', () => {
    const repo = setupRepo({
      baseline: {
        'app/foo.py': 'def f(): return 1\n',
        'tests/test_foo.py': 'def test_f(): pass\n',
        'tests/test_other.py': 'def test_o(): pass\n',
      },
      changed: {
        'app/foo.py': 'def f(): return 99\n',
        'tests/test_other.py': 'def test_o(): assert True\n',
      },
    })
    teardowns.push(repo.cleanup)
    const { stdout, status } = runScriptDryRun(repo.dir)
    expect(status).toBe(0)
    expect(stdout).toMatch(/test_foo\.py/)
    expect(stdout).toMatch(/test_other\.py/)
  })

  it('changed source with no matching test → falls back to smoke', () => {
    const repo = setupRepo({
      baseline: {
        'app/orphan.py': 'def lonely(): return 1\n',
      },
      changed: {
        'app/orphan.py': 'def lonely(): return 2\n',
      },
    })
    teardowns.push(repo.cleanup)
    const { stdout, status } = runScriptDryRun(repo.dir)
    expect(status).toBe(0)
    // Source file changed, but no test file matches → derived empty,
    // test_files empty → targets empty → smoke fallback fires.
    expect(stdout).toMatch(/no changed test\/source files — running smoke/)
  })

  it('skips .venv / node_modules / .worktrees when finding tests', () => {
    const repo = setupRepo({
      baseline: {
        'app/foo.py': 'def f(): return 1\n',
        'tests/test_foo.py': 'def test(): pass\n',
        // Decoys that should be ignored:
        '.venv/lib/python3.13/site-packages/somepkg/test_foo.py': 'def test(): assert False\n',
        'node_modules/test_foo.py': 'def test(): assert False\n',
      },
      changed: {
        'app/foo.py': 'def f(): return 2\n',
      },
    })
    teardowns.push(repo.cleanup)
    const { stdout, status } = runScriptDryRun(repo.dir)
    expect(status).toBe(0)
    expect(stdout).toMatch(/tests\/test_foo\.py/)
    expect(stdout).not.toMatch(/\.venv\/.*test_foo\.py/)
    expect(stdout).not.toMatch(/node_modules\/.*test_foo\.py/)
  })
})
