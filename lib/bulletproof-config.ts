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
import { findProjectConfigPath } from './project-config'

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
 * workingDirectory. Used when no `.collab-bulletproof.json` is present.
 *
 * The detection is intentionally conservative — better to skip a check than
 * to wedge VERIFY on a project where the assumed command doesn't exist. The
 * operator can always commit a `.collab-bulletproof.json` for full control.
 */
function autoDetect(workingDirectory: string): BulletproofCheck[] {
  const checks: BulletproofCheck[] = []
  const exists = (rel: string): boolean => {
    try { return fs.existsSync(path.join(workingDirectory, rel)) } catch { return false }
  }

  // Python: pytest if conftest.py / pyproject.toml / pytest.ini / tests dir.
  if (exists('pyproject.toml') || exists('pytest.ini') || exists('conftest.py') || exists('tests')) {
    checks.push({
      id: 'pytest',
      type: 'cmd',
      cmd: 'pytest -q --no-header -x --maxfail=3',
      timeoutMs: 180_000,
    })
  }
  // OpenClaw repos commonly have scripts/verify_system.py — trust if present.
  if (exists('scripts/verify_system.py')) {
    checks.push({
      id: 'verify-system',
      type: 'cmd',
      cmd: 'python3 scripts/verify_system.py',
      timeoutMs: 240_000,
    })
  }
  // Node: prefer `npm test` if package.json declares a test script.
  if (exists('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workingDirectory, 'package.json'), 'utf-8'))
      const hasTest = pkg?.scripts?.test && !/no test specified/i.test(String(pkg.scripts.test))
      if (hasTest) {
        checks.push({
          id: 'npm-test',
          type: 'cmd',
          cmd: 'npm test --silent',
          timeoutMs: 240_000,
        })
      }
      const hasTypecheck = pkg?.scripts?.typecheck || pkg?.scripts?.['type-check']
      if (hasTypecheck) {
        const cmd = pkg.scripts.typecheck ? 'npm run typecheck --silent' : 'npm run type-check --silent'
        checks.push({ id: 'typecheck', type: 'cmd', cmd, timeoutMs: 120_000 })
      }
    } catch { /* malformed package.json — skip */ }
  }

  return checks
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
