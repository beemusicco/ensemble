/**
 * Bulletproof config reader.
 *
 * Reads optional `.collab-bulletproof.json` at the team's workingDirectory.
 * Defines the mechanical verification gate that runs before any [VERIFY_DONE]
 * sign-off can stand. Without this file a team can still operate — `defaultBulletproofConfig`
 * supplies a minimal "auto-detected" set (e.g. pytest if pyproject.toml exists,
 * vitest/npm test if package.json exists). With the file, the operator has
 * full control over which checks always run and which kick in only when
 * high-risk paths are touched.
 *
 * Schema (JSON):
 *
 * {
 *   "always": [
 *     { "id": "tests",      "type": "cmd",        "cmd": "pytest -q",        "timeoutMs": 120000 },
 *     { "id": "typecheck",  "type": "cmd",        "cmd": "tsc --noEmit",     "timeoutMs": 60000  },
 *     { "id": "no-todo",    "type": "diff_check", "pattern": "(?i)TODO|FIXME(?! \\(.*\\))", "message": "new TODO/FIXME without justification" },
 *     { "id": "revert",     "type": "attest",     "message": "Verify message must include 'Revert plan:'" }
 *   ],
 *   "high_risk_paths": ["src/auth/...", "src/payments/...", "scripts/migrations/..."],
 *   "high_risk_extra": [
 *     { "id": "human-approval", "type": "attest", "message": "High-risk change — operator approval required before disband." }
 *   ]
 * }
 *
 * `cmd` checks run with workingDirectory as cwd unless `cwd` overrides.
 * `diff_check` checks run a regex against `git diff` output (added lines only).
 * `attest` checks search verify-phase messages for `message` text — agents
 * must actively type it to pass.
 */

import fs from 'fs'
import path from 'path'
import url from 'url'
import { findProjectConfigPath } from './project-config'

// Absolute path to scripts/pytest-diff.sh — resolved at module-load time so
// it works regardless of the team's workingDirectory. Compute relative to
// this file so a relocation of the ensemble tool dir does not break it.
const HOME_REL_PYTEST_DIFF = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'pytest-diff.sh',
)

/**
 * Tiny gitignore-style glob matcher. Handles double-star (any depth), single-star
 * (single segment), and literal text. Avoids adding minimatch as a dependency for
 * the narrow set of patterns we expect (auth subtrees, lib/x.ts, etc.).
 *
 * Matching is anchored — the whole path is matched against the whole pattern.
 * `**` matches any sequence including slashes; `*` matches any chars except `/`.
 */
function globToRegex(glob: string): RegExp {
  // Normalize backslashes to forward slashes in the pattern so authors writing
  // `lib\foo` accidentally still get usable behavior.
  const cleaned = glob.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]
    if (c === '*' && cleaned[i + 1] === '*') {
      // ** — match any chars (including slashes). Trailing /** allows zero segments.
      re += '.*'
      i++
      // Consume the optional trailing /
      if (cleaned[i + 1] === '/') i++
    } else if (c === '*') {
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+()[]{}|^$\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

function matchGlob(pathStr: string, glob: string): boolean {
  const normPath = pathStr.replace(/\\/g, '/')
  const re = globToRegex(glob)
  return re.test(normPath)
}

export type BulletproofCheckType = 'cmd' | 'diff_check' | 'attest'

export interface BulletproofCheck {
  id: string
  type: BulletproofCheckType
  cmd?: string
  pattern?: string
  message?: string
  cwd?: string
  timeoutMs?: number
}

export interface BulletproofConfig {
  always: BulletproofCheck[]
  high_risk_paths: string[]
  high_risk_extra: BulletproofCheck[]
  source: 'file' | 'auto-detected' | 'empty'
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_CHECKS = 30  // hard cap so a runaway file can't bloat the runner
const FILENAME = '.collab-bulletproof.json'

function isCheckType(t: unknown): t is BulletproofCheckType {
  return t === 'cmd' || t === 'diff_check' || t === 'attest'
}

/**
 * Validate a single check entry. Returns null if invalid (caller skips).
 * Defensive — accept missing optional fields, reject malformed required fields.
 */
function normalizeCheck(raw: unknown, idx: number): BulletproofCheck | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `check-${idx}`
  const type = isCheckType(r.type) ? r.type : 'cmd'

  // Type-specific requirements:
  if (type === 'cmd' && (typeof r.cmd !== 'string' || !r.cmd.trim())) return null
  if (type === 'diff_check' && (typeof r.pattern !== 'string' || !r.pattern.trim())) return null
  if (type === 'attest' && (typeof r.message !== 'string' || !r.message.trim())) return null

  const out: BulletproofCheck = { id, type }
  if (typeof r.cmd === 'string') out.cmd = r.cmd
  if (typeof r.pattern === 'string') out.pattern = r.pattern
  if (typeof r.message === 'string') out.message = r.message
  if (typeof r.cwd === 'string') out.cwd = r.cwd
  if (typeof r.timeoutMs === 'number' && r.timeoutMs > 0 && r.timeoutMs < 600_000) {
    out.timeoutMs = r.timeoutMs
  } else {
    out.timeoutMs = DEFAULT_TIMEOUT_MS
  }
  return out
}

function normalizeChecks(raw: unknown): BulletproofCheck[] {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(0, MAX_CHECKS)
    .map((r, i) => normalizeCheck(r, i))
    .filter((c): c is BulletproofCheck => c !== null)
}

function normalizePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, 50)
}

/**
 * Auto-detect a minimal set of always-checks based on what's in the
 * workingDirectory + one level of subdirs. Used when no
 * `.collab-bulletproof.json` is present in either operator-config or repo root.
 *
 * W2.5c: walks ONE level deep so monorepos (`backend/pyproject.toml` +
 * `frontend/package.json`) work without explicit config. Each detected
 * subproject contributes `cd <subdir> && <cmd>` checks. Skips obvious noise
 * dirs (node_modules, .venv, .git, dist, etc.).
 *
 * Diff-scoped commands by default (W2.5 lesson, collab f652ac34): ruff +
 * pytest run only against changed files / not-slow tests so pre-existing
 * master debt doesn't fail every gate.
 *
 * The detection stays conservative — skips when the assumed command doesn't
 * fit (e.g. package.json with placeholder test script). Operator can always
 * drop an explicit `.collab-bulletproof.json` in the operator-config dir
 * for full control.
 */

const SUBDIR_SKIP = new Set([
  'node_modules', '.git', '.venv', 'venv', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.next', '.cache', '.turbo', '.parcel-cache', '.gradle',
  '.idea', '.vscode', 'dist', 'build', 'target', '.worktrees', 'coverage',
  '__pycache__', 'vendor', '.tox', '.nox', '.eggs', '.benchmarks',
  '.history', 'storage', 'tmp', 'temp', '.DS_Store',
])

function autoDetect(workingDirectory: string): BulletproofCheck[] {
  const checks: BulletproofCheck[] = []

  // Detect at the root first (covers single-project repos).
  detectInDir(workingDirectory, '', checks)

  // Then walk one level deep — monorepo subprojects.
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(workingDirectory, { withFileTypes: true })
  } catch { return checks }

  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (SUBDIR_SKIP.has(e.name)) continue
    if (e.name.startsWith('.')) continue  // skip hidden dirs by default
    const subAbs = path.join(workingDirectory, e.name)
    detectInDir(subAbs, e.name, checks)
  }

  return checks
}

/**
 * Detect runnable verifications in a single dir. `prefix` is the relative
 * path from the team's workingDirectory; empty string means we're at root.
 * Each check's cmd is wrapped with `cd <prefix> && ...` when non-root.
 */
function detectInDir(absDir: string, prefix: string, checks: BulletproofCheck[]): void {
  const exists = (rel: string): boolean => {
    try { return fs.existsSync(path.join(absDir, rel)) } catch { return false }
  }
  const cdPrefix = prefix ? `cd ${prefix} && ` : ''
  const idSuffix = prefix ? `-${prefix.replace(/[^a-z0-9]+/gi, '_')}` : ''

  // Python: pytest if pyproject.toml / pytest.ini / conftest.py.
  // (Don't trigger on `tests/` directory alone — Node/Rust/Go projects
  // also use `tests/`, would false-positive pytest on them.)
  //
  // W2.5l: diff-scope pytest. 7-day production data showed pytest as the
  // #1 verify-runner failure (41 hits vs 14 ruff / 7 vitest) because the
  // full suite hits pre-existing master debt — same lesson as W2.5j (vitest)
  // and the original ruff diff-scope. Logic lives in scripts/pytest-diff.sh
  // (testable, readable, no inline-bash-quoting hell). Falls back to
  // --collect-only smoke when no targets resolve.
  if (exists('pyproject.toml') || exists('pytest.ini') || exists('conftest.py')) {
    checks.push({
      id: `pytest-diff${idSuffix}`,
      type: 'cmd',
      // Path is fixed relative to the ensemble tool dir — every team's
      // workingDirectory is a project repo, but the script is a tool.
      cmd: `${cdPrefix}bash ${HOME_REL_PYTEST_DIFF}`,
      timeoutMs: 240_000,
    })
  }

  // ruff (Python lint) — only if pyproject.toml mentions ruff. Diff-scoped:
  // git diff (committed changes since branch base) + git ls-files --others
  // (untracked) → only NEW lint debt fires the gate, master debt doesn't.
  if (exists('pyproject.toml')) {
    try {
      const py = fs.readFileSync(path.join(absDir, 'pyproject.toml'), 'utf-8')
      if (/(^|\n)\[tool\.ruff\b|"ruff"\s*[:=]|ruff\s*[>=<]/i.test(py)) {
        checks.push({
          id: `ruff-diff${idSuffix}`,
          type: 'cmd',
          // Note: git is repo-rooted, so diff from inside subdir naturally
          // returns paths relative to that subdir. Works for both root and subprojects.
          cmd: `${cdPrefix}(git diff HEAD --name-only --diff-filter=ACMR -- '*.py'; git ls-files --others --exclude-standard -- '*.py') | sort -u | tr '\\n' '\\0' | xargs -0 -r ruff check`,
          timeoutMs: 60_000,
        })
      }
    } catch { /* malformed pyproject — skip */ }
  }

  // OpenClaw repos: scripts/verify_system.py
  if (exists('scripts/verify_system.py')) {
    checks.push({
      id: `verify-system${idSuffix}`,
      type: 'cmd',
      cmd: `${cdPrefix}python3 scripts/verify_system.py`,
      timeoutMs: 240_000,
    })
  }

  // Node: npm test + npm run typecheck if defined and not the default placeholder.
  if (exists('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(absDir, 'package.json'), 'utf-8'))
      const testScript: string | undefined = pkg?.scripts?.test
      const hasTest = !!testScript && !/no test specified/i.test(String(testScript))
      // W2.5j: vitest supports `--changed HEAD` to scope to changed files only.
      // Production observation 2026-05-01: full `npm test` (vitest) failed every
      // verify-runner pass on accounting-helper because of pre-existing master
      // test debt — same lesson as ruff. Detect vitest from script value or
      // devDependencies and emit a diff-scoped command. Other test runners
      // (jest, mocha) keep `npm test` since their --changed support varies.
      const isVitest = !!testScript && /\bvitest\b/i.test(testScript)
        || !!(pkg?.devDependencies?.vitest || pkg?.dependencies?.vitest)
      if (hasTest && isVitest) {
        // Pre-flight git check — if the diff is empty, vitest --changed is a
        // fast no-op, but we wrap to ensure exit 0 in that case.
        checks.push({
          id: `vitest-changed${idSuffix}`,
          type: 'cmd',
          cmd: `${cdPrefix}npx vitest run --changed HEAD --reporter=basic 2>&1 | tail -50; exit \${PIPESTATUS[0]}`,
          timeoutMs: 240_000,
        })
      } else if (hasTest) {
        checks.push({
          id: `npm-test${idSuffix}`,
          type: 'cmd',
          cmd: `${cdPrefix}npm test --silent`,
          timeoutMs: 240_000,
        })
      }
      const hasTypecheck = pkg?.scripts?.typecheck || pkg?.scripts?.['type-check']
      if (hasTypecheck) {
        const which = pkg.scripts.typecheck ? 'typecheck' : 'type-check'
        checks.push({
          id: `typecheck${idSuffix}`,
          type: 'cmd',
          cmd: `${cdPrefix}npm run ${which} --silent`,
          timeoutMs: 120_000,
        })
      }
      const hasLint = pkg?.scripts?.lint
      if (hasLint) {
        checks.push({
          id: `lint${idSuffix}`,
          type: 'cmd',
          cmd: `${cdPrefix}npm run lint --silent`,
          timeoutMs: 120_000,
        })
      }
    } catch { /* malformed package.json — skip */ }
  }

  // Rust
  if (exists('Cargo.toml')) {
    checks.push({
      id: `cargo-test${idSuffix}`,
      type: 'cmd',
      cmd: `${cdPrefix}cargo test --quiet`,
      timeoutMs: 300_000,
    })
  }

  // Go
  if (exists('go.mod')) {
    checks.push({
      id: `go-test${idSuffix}`,
      type: 'cmd',
      cmd: `${cdPrefix}go test ./...`,
      timeoutMs: 240_000,
    })
  }
}

export function loadBulletproofConfig(workingDirectory: string | undefined): BulletproofConfig {
  const empty: BulletproofConfig = { always: [], high_risk_paths: [], high_risk_extra: [], source: 'empty' }
  if (!workingDirectory) return empty

  // W2.5b: resolve via operator-config dir → repo root, in that order.
  // Operator-config wins so per-machine tuning isn't shadowed by a stale
  // checked-in copy at the repo root.
  const resolved = findProjectConfigPath(FILENAME, workingDirectory)
  if (resolved) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resolved.path, 'utf-8')) as Record<string, unknown>
      return {
        always: normalizeChecks(parsed.always),
        high_risk_paths: normalizePaths(parsed.high_risk_paths),
        high_risk_extra: normalizeChecks(parsed.high_risk_extra),
        source: 'file',
      }
    } catch (err) {
      console.warn(`[bulletproof] Failed to parse ${resolved.path}: ${(err as Error).message} — falling back to auto-detect`)
    }
  }

  const auto = autoDetect(workingDirectory)
  if (auto.length === 0) return empty
  return { always: auto, high_risk_paths: [], high_risk_extra: [], source: 'auto-detected' }
}

/**
 * Decide which check list to run for this VERIFY pass.
 * If any modified path matches a high_risk glob → include high_risk_extra
 * on top of the always-checks.
 */
export function selectChecks(
  cfg: BulletproofConfig,
  modifiedPaths: string[],
): { checks: BulletproofCheck[]; highRiskHit: string | null } {
  const out = [...cfg.always]
  if (cfg.high_risk_paths.length === 0 || cfg.high_risk_extra.length === 0) {
    return { checks: out, highRiskHit: null }
  }
  let hit: string | null = null
  for (const p of modifiedPaths) {
    for (const glob of cfg.high_risk_paths) {
      if (matchGlob(p, glob)) {
        hit = p
        break
      }
    }
    if (hit) break
  }
  if (hit) out.push(...cfg.high_risk_extra)
  return { checks: out, highRiskHit: hit }
}
