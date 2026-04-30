/**
 * Verify-runner — mechanical bulletproof gate executor.
 *
 * Given a bulletproof config + worktree path + recent verify-phase messages,
 * runs every check and returns structured results. Output is truncated to
 * keep the team feed readable; agents see a compact summary, the full output
 * is logged to the runtime dir for after-the-fact inspection.
 *
 * This is the "auto-runner in VERIFY" component of W2 — it's what makes the
 * gate mechanical instead of declarative. Without it, agents could (and did)
 * emit [VERIFY_DONE] off the back of a hand-waved "tests pass". Now they
 * cannot — the runner posts an authoritative result before the auto-fix loop
 * decides whether the team converged.
 */

import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import type {
  BulletproofCheck,
  BulletproofConfig,
} from './bulletproof-config'
import { selectChecks } from './bulletproof-config'

export interface VerifyRunResult {
  id: string
  type: BulletproofCheck['type']
  status: 'pass' | 'fail' | 'skip' | 'error'
  exitCode: number | null
  durationMs: number
  output: string
  reason?: string  // why skipped / errored
}

export interface VerifyRunSummary {
  results: VerifyRunResult[]
  passed: number
  failed: number
  skipped: number
  errored: number
  highRiskHit: string | null
  configSource: BulletproofConfig['source']
}

const MAX_OUTPUT_CHARS = 3000
const HARD_TIMEOUT_FLOOR_MS = 5_000

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output
  const head = output.slice(0, Math.floor(MAX_OUTPUT_CHARS * 0.65))
  const tail = output.slice(-Math.floor(MAX_OUTPUT_CHARS * 0.30))
  return `${head}\n…[truncated ${output.length - head.length - tail.length} chars]…\n${tail}`
}

/**
 * Execute a shell command with hard timeout + output cap. Captures stdout +
 * stderr together (consumers want the merged transcript, not separate streams).
 */
async function runCmd(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string; durationMs: number; timedOut: boolean }> {
  const startedAt = Date.now()
  return await new Promise(resolve => {
    const proc = spawn('bash', ['-lc', cmd], { cwd, env: process.env })
    const chunks: string[] = []
    let totalLen = 0
    const onData = (data: Buffer): void => {
      const s = data.toString('utf-8')
      totalLen += s.length
      // Cap at 4× the truncation limit to avoid unbounded memory if the
      // command spews logs. We still let the child finish — just drop bytes.
      if (totalLen <= MAX_OUTPUT_CHARS * 4) chunks.push(s)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)

    const effectiveTimeout = Math.max(timeoutMs, HARD_TIMEOUT_FLOOR_MS)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { proc.kill('SIGTERM') } catch { /* */ }
      // Give it 2s to clean up, then SIGKILL.
      setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* */ } }, 2000)
    }, effectiveTimeout)

    proc.on('close', exitCode => {
      clearTimeout(timer)
      const output = chunks.join('')
      resolve({
        exitCode: exitCode ?? null,
        output: truncate(output),
        durationMs: Date.now() - startedAt,
        timedOut,
      })
    })
    proc.on('error', err => {
      clearTimeout(timer)
      resolve({
        exitCode: null,
        output: `spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      })
    })
  })
}

/**
 * Get added-line content for a diff_check. Defaults to comparing against
 * the worktree's HEAD (uncommitted + committed changes). Falls back to
 * empty string if git is unavailable.
 */
async function getAddedDiffLines(cwd: string): Promise<string> {
  // `git diff HEAD` shows all changes in the worktree (committed-but-unpushed
  // are NOT included since they're already part of HEAD on this branch).
  // For a worktree spawned from main, this captures everything the agent did.
  const res = await runCmd('git diff HEAD --no-color --unified=0 || true', cwd, 30_000)
  if (!res.output) return ''
  // Keep only added lines (start with `+`, not `+++`).
  const added: string[] = []
  for (const line of res.output.split('\n')) {
    if (line.startsWith('++') || line.startsWith('+++')) continue
    if (line.startsWith('+')) added.push(line.slice(1))
  }
  return added.join('\n')
}

async function getModifiedPaths(cwd: string): Promise<string[]> {
  const res = await runCmd('git diff HEAD --name-only || true', cwd, 30_000)
  return res.output.split('\n').map(l => l.trim()).filter(Boolean)
}

function evalDiffCheck(check: BulletproofCheck, addedLines: string): VerifyRunResult {
  const startedAt = Date.now()
  if (!check.pattern) {
    return {
      id: check.id, type: 'diff_check', status: 'error',
      exitCode: null, durationMs: 0, output: '', reason: 'missing pattern',
    }
  }
  let re: RegExp
  try { re = new RegExp(check.pattern, 'm') }
  catch (err) {
    return {
      id: check.id, type: 'diff_check', status: 'error',
      exitCode: null, durationMs: 0, output: '', reason: `bad regex: ${(err as Error).message}`,
    }
  }
  const match = addedLines.match(re)
  const status: VerifyRunResult['status'] = match ? 'fail' : 'pass'
  const output = match
    ? `Pattern hit: ${check.pattern}\nFirst match: ${match[0].slice(0, 200)}\n${check.message ?? ''}`.trim()
    : `No new lines matched: ${check.pattern}`
  return {
    id: check.id, type: 'diff_check', status,
    exitCode: null, durationMs: Date.now() - startedAt, output,
  }
}

function evalAttest(check: BulletproofCheck, verifyMessages: string): VerifyRunResult {
  const startedAt = Date.now()
  if (!check.message) {
    return {
      id: check.id, type: 'attest', status: 'error',
      exitCode: null, durationMs: 0, output: '', reason: 'missing message',
    }
  }
  // Search verify-phase messages for the literal attest text. We use a loose
  // match (case-insensitive substring) since agents won't quote it exactly.
  const needle = check.message.toLowerCase()
  const haystack = verifyMessages.toLowerCase()
  const found = haystack.includes(needle)
  return {
    id: check.id, type: 'attest', status: found ? 'pass' : 'fail',
    exitCode: null, durationMs: Date.now() - startedAt,
    output: found
      ? `Found in verify messages: "${check.message.slice(0, 100)}"`
      : `Required attestation not found in verify messages: "${check.message}"`,
  }
}

async function evalCmd(
  check: BulletproofCheck,
  defaultCwd: string,
): Promise<VerifyRunResult> {
  if (!check.cmd) {
    return {
      id: check.id, type: 'cmd', status: 'error',
      exitCode: null, durationMs: 0, output: '', reason: 'missing cmd',
    }
  }
  const cwd = check.cwd ? path.resolve(defaultCwd, check.cwd) : defaultCwd
  const { exitCode, output, durationMs, timedOut } = await runCmd(
    check.cmd, cwd, check.timeoutMs ?? 120_000,
  )
  let status: VerifyRunResult['status']
  if (timedOut) status = 'fail'
  else if (exitCode === 0) status = 'pass'
  else if (exitCode === null) status = 'error'
  else status = 'fail'

  const banner = timedOut
    ? `⏱ TIMEOUT after ${durationMs}ms (limit ${check.timeoutMs ?? 120_000}ms) — process killed.\n`
    : ''
  return {
    id: check.id, type: 'cmd', status,
    exitCode, durationMs,
    output: `${banner}$ ${check.cmd}\n${output}`,
    reason: timedOut ? 'timeout' : undefined,
  }
}

export interface RunVerifyChecksInput {
  cfg: BulletproofConfig
  workingDirectory: string
  /** Optional override — if not given, derived from `git diff HEAD --name-only`. */
  modifiedPaths?: string[]
  /** Concatenated verify-phase messages for `attest` checks. */
  verifyMessagesText?: string
  /** Optional file to write the full per-check log into (no truncation). */
  fullLogPath?: string
}

export async function runVerifyChecks(
  input: RunVerifyChecksInput,
): Promise<VerifyRunSummary> {
  const { cfg, workingDirectory } = input
  const verifyText = input.verifyMessagesText ?? ''

  const modifiedPaths = input.modifiedPaths ?? await getModifiedPaths(workingDirectory)
  const { checks, highRiskHit } = selectChecks(cfg, modifiedPaths)

  // For diff_check we only fetch added lines if any check needs them.
  const needsDiff = checks.some(c => c.type === 'diff_check')
  const addedLines = needsDiff ? await getAddedDiffLines(workingDirectory) : ''

  const results: VerifyRunResult[] = []
  for (const check of checks) {
    if (check.type === 'cmd') {
      results.push(await evalCmd(check, workingDirectory))
    } else if (check.type === 'diff_check') {
      results.push(evalDiffCheck(check, addedLines))
    } else if (check.type === 'attest') {
      results.push(evalAttest(check, verifyText))
    }
  }

  // Optional: dump full log to file (without per-check truncation since results
  // are already truncated in-place; this captures them at present-detail).
  if (input.fullLogPath) {
    try {
      fs.mkdirSync(path.dirname(input.fullLogPath), { recursive: true })
      const lines = results.map(r =>
        `## ${r.id} (${r.type}) — ${r.status} (${r.durationMs}ms${r.exitCode !== null ? `, exit=${r.exitCode}` : ''})\n${r.output}\n`
      )
      fs.writeFileSync(input.fullLogPath, lines.join('\n---\n'))
    } catch { /* logging best-effort */ }
  }

  return {
    results,
    passed: results.filter(r => r.status === 'pass').length,
    failed: results.filter(r => r.status === 'fail').length,
    skipped: results.filter(r => r.status === 'skip').length,
    errored: results.filter(r => r.status === 'error').length,
    highRiskHit,
    configSource: cfg.source,
  }
}

/**
 * Compact human-readable summary suitable for pasting into the team feed.
 * Each check gets one line; failed/errored checks include the (truncated)
 * output so the team can act on it.
 */
export function formatVerifySummary(summary: VerifyRunSummary): string {
  if (summary.results.length === 0) {
    return `🤖 verify-runner: no checks configured (config source: ${summary.configSource})`
  }
  const lines: string[] = []
  const overall = summary.failed === 0 && summary.errored === 0 ? '✅ PASS' : '❌ FAIL'
  lines.push(`🤖 verify-runner — ${overall} (${summary.passed} pass / ${summary.failed} fail / ${summary.errored} error / ${summary.skipped} skip — config: ${summary.configSource})`)
  if (summary.highRiskHit) {
    lines.push(`  ⚠️ high-risk path touched: ${summary.highRiskHit} (extra checks active)`)
  }
  for (const r of summary.results) {
    const icon = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : r.status === 'error' ? '⚠️' : '⏭'
    const head = `  ${icon} ${r.id} (${r.type}, ${r.durationMs}ms${r.exitCode !== null ? `, exit=${r.exitCode}` : ''})`
    lines.push(head)
    if (r.status !== 'pass') {
      // Indent the output 4 spaces so it stays under the check header.
      const body = (r.output || r.reason || '').split('\n').map(l => `    ${l}`).join('\n')
      lines.push(body)
    }
  }
  return lines.join('\n')
}
