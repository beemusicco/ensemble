#!/usr/bin/env tsx
/**
 * Benchmark runner: executes a task via either `solo` (single Claude CLI)
 * or `collab` (ensemble team) and reports pass/fail + duration.
 *
 * Usage:
 *   tsx bench/runner.ts --task add-cli-flag --mode solo
 *   tsx bench/runner.ts --task add-cli-flag --mode collab
 *   tsx bench/runner.ts --all
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(__dirname, '..')

interface VerifyStep {
  cmd?: string
  startBackground?: string
  waitForPort?: number
  killAfter?: boolean
  expectStdoutContains?: string
  expectExitCode?: number
}

interface Task {
  id: string
  description: string
  workspaceSeed: Record<string, string>
  verify: VerifyStep[]
  timeoutSeconds?: number
}

interface Trial {
  taskId: string
  mode: 'solo' | 'collab'
  startedAt: string
  durationSeconds: number
  passed: boolean
  failedStep?: string
  workspace: string
}

function loadTask(id: string): Task {
  const p = path.join(REPO, 'bench/tasks', id + '.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function listTaskIds(): string[] {
  const dir = path.join(REPO, 'bench/tasks')
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
}

function makeWorkspace(taskId: string): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${taskId}-`))
  return ws
}

function seedWorkspace(ws: string, task: Task): void {
  for (const [name, content] of Object.entries(task.workspaceSeed)) {
    fs.writeFileSync(path.join(ws, name), content)
  }
}

function substituteWorkspace(cmd: string, ws: string): string {
  return cmd.replace(/BENCH_WORKSPACE/g, ws)
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const net = await import('net')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const sock = net.createConnection({ port, host: '127.0.0.1' })
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => { sock.destroy(); resolve(false) })
    })
    if (ok) return true
    await new Promise(r => setTimeout(r, 200))
  }
  return false
}

async function runVerify(task: Task, ws: string): Promise<{ passed: boolean; failedStep?: string }> {
  const background: Array<ReturnType<typeof spawn>> = []
  try {
    for (let i = 0; i < task.verify.length; i++) {
      const step = task.verify[i]
      if (step.startBackground) {
        const proc = spawn('bash', ['-c', substituteWorkspace(step.startBackground, ws)], {
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: false,
        })
        background.push(proc)
        if (step.waitForPort) {
          const ok = await waitForPort(step.waitForPort, 10_000)
          if (!ok) return { passed: false, failedStep: `port ${step.waitForPort} did not open` }
        } else {
          await new Promise(r => setTimeout(r, 500))
        }
        continue
      }
      if (step.cmd) {
        const result = spawnSync('bash', ['-c', substituteWorkspace(step.cmd, ws)], {
          encoding: 'utf8',
          timeout: 30_000,
        })
        const stdout = result.stdout || ''
        const stderr = result.stderr || ''
        const exitCode = result.status ?? -1
        if (step.expectExitCode !== undefined && exitCode !== step.expectExitCode) {
          return { passed: false, failedStep: `step ${i}: exit=${exitCode}, expected=${step.expectExitCode}. stderr=${stderr.slice(0, 200)}` }
        }
        if (step.expectStdoutContains && !stdout.includes(step.expectStdoutContains)) {
          return { passed: false, failedStep: `step ${i}: stdout missing "${step.expectStdoutContains}". got=${stdout.slice(0, 200)}` }
        }
      }
    }
    return { passed: true }
  } finally {
    for (const proc of background) {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
    }
  }
}

async function runSolo(task: Task, ws: string): Promise<Trial> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const prompt = `Working directory: ${ws}. Task: ${task.description.replace(/BENCH_WORKSPACE/g, ws)}. Use your file tools to make the edits directly. When done, make no further edits.`

  const result = spawnSync('claude', ['--dangerously-skip-permissions', '--model', 'opus', '--print', prompt], {
    cwd: ws,
    encoding: 'utf8',
    timeout: (task.timeoutSeconds ?? 600) * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const duration = (Date.now() - t0) / 1000
  if (result.error || result.status !== 0) {
    return {
      taskId: task.id, mode: 'solo', startedAt, durationSeconds: duration,
      passed: false, failedStep: `claude exited: ${result.status} ${(result.stderr || '').slice(0, 200)}`,
      workspace: ws,
    }
  }

  const verify = await runVerify(task, ws)
  return {
    taskId: task.id, mode: 'solo', startedAt, durationSeconds: duration,
    passed: verify.passed, failedStep: verify.failedStep, workspace: ws,
  }
}

async function runCollab(task: Task, ws: string): Promise<Trial> {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  const collabLaunch = path.join(REPO, 'scripts/collab-launch.sh')
  const description = task.description.replace(/BENCH_WORKSPACE/g, ws)

  // Launch, capture team id from stdout
  const launch = spawnSync('bash', [collabLaunch, ws, description], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (launch.status !== 0) {
    return {
      taskId: task.id, mode: 'collab', startedAt, durationSeconds: (Date.now() - t0) / 1000,
      passed: false, failedStep: `launch failed: ${(launch.stderr || '').slice(0, 300)}`,
      workspace: ws,
    }
  }

  const teamIdFile = '/tmp/collab-team-id.txt'
  if (!fs.existsSync(teamIdFile)) {
    return {
      taskId: task.id, mode: 'collab', startedAt, durationSeconds: (Date.now() - t0) / 1000,
      passed: false, failedStep: `no team-id file at ${teamIdFile}`,
      workspace: ws,
    }
  }
  const teamId = fs.readFileSync(teamIdFile, 'utf8').trim()
  const finishedMarker = path.join('/tmp/ensemble', teamId, '.finished')
  const deadline = Date.now() + (task.timeoutSeconds ?? 600) * 1000
  while (Date.now() < deadline) {
    if (fs.existsSync(finishedMarker)) break
    await new Promise(r => setTimeout(r, 2000))
  }

  const duration = (Date.now() - t0) / 1000
  if (!fs.existsSync(finishedMarker)) {
    // Force disband
    spawnSync('bash', [path.join(REPO, 'scripts/collab-terminate.sh'), teamId, '--disband'], { encoding: 'utf8' })
    return {
      taskId: task.id, mode: 'collab', startedAt, durationSeconds: duration,
      passed: false, failedStep: `collab timed out after ${duration.toFixed(0)}s`,
      workspace: ws,
    }
  }

  const verify = await runVerify(task, ws)
  return {
    taskId: task.id, mode: 'collab', startedAt, durationSeconds: duration,
    passed: verify.passed, failedStep: verify.failedStep, workspace: ws,
  }
}

async function runOne(taskId: string, mode: 'solo' | 'collab'): Promise<Trial> {
  const task = loadTask(taskId)
  const ws = makeWorkspace(taskId)
  seedWorkspace(ws, task)
  console.log(`[bench] task=${taskId} mode=${mode} workspace=${ws}`)
  return mode === 'solo' ? runSolo(task, ws) : runCollab(task, ws)
}

function report(trials: Trial[]): void {
  console.log('\n=== BENCHMARK RESULTS ===')
  for (const t of trials) {
    const mark = t.passed ? 'PASS' : 'FAIL'
    console.log(`  ${mark}  ${t.taskId.padEnd(20)} ${t.mode.padEnd(7)} ${t.durationSeconds.toFixed(1).padStart(6)}s${t.failedStep ? '  ' + t.failedStep : ''}`)
  }
  const passed = trials.filter(t => t.passed).length
  console.log(`\n  Total: ${passed}/${trials.length} passed`)
  const byMode = new Map<string, { pass: number; fail: number; totalSec: number }>()
  for (const t of trials) {
    const e = byMode.get(t.mode) ?? { pass: 0, fail: 0, totalSec: 0 }
    e.pass += t.passed ? 1 : 0
    e.fail += t.passed ? 0 : 1
    e.totalSec += t.durationSeconds
    byMode.set(t.mode, e)
  }
  for (const [mode, e] of byMode) {
    console.log(`  ${mode}: ${e.pass}/${e.pass + e.fail} pass, avg ${(e.totalSec / (e.pass + e.fail)).toFixed(1)}s`)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let task: string | null = null
  let mode: 'solo' | 'collab' | 'both' = 'solo'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--task') task = args[++i]
    else if (args[i] === '--mode') mode = args[++i] as typeof mode
    else if (args[i] === '--all') { task = '__ALL__'; mode = 'both' }
  }
  if (!task) {
    console.error('Usage: tsx bench/runner.ts --task <id> --mode solo|collab|both')
    console.error('  Or: tsx bench/runner.ts --all')
    console.error(`  Available tasks: ${listTaskIds().join(', ')}`)
    process.exit(2)
  }

  const taskIds = task === '__ALL__' ? listTaskIds() : [task]
  const modes: Array<'solo' | 'collab'> =
    mode === 'both' ? ['solo', 'collab'] : [mode]

  const trials: Trial[] = []
  for (const t of taskIds) {
    for (const m of modes) {
      trials.push(await runOne(t, m))
    }
  }
  report(trials)

  // Persist results
  const resultsDir = path.join(REPO, 'bench/results')
  fs.mkdirSync(resultsDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  fs.writeFileSync(path.join(resultsDir, `run-${ts}.json`), JSON.stringify(trials, null, 2))
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
