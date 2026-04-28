import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import type { EnsembleTeam, EnsembleMessage, CreateTeamRequest } from '../types/ensemble'
import { getEnsembleRegistryDir } from './ensemble-paths'
import { collabMessagesFile } from './collab-paths'

const ENSEMBLE_DIR = getEnsembleRegistryDir()
const TEAMS_FILE = path.join(ENSEMBLE_DIR, 'teams.json')
const MESSAGES_DIR = path.join(ENSEMBLE_DIR, 'messages')
const TEAMS_LOCK_DIR = `${TEAMS_FILE}.lock`
const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 5_000

function getCreatedBy(): string {
  return process.env.ENSEMBLE_CREATED_BY?.trim()
    || process.env.USER
    || process.env.LOGNAME
    || os.hostname()
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readTeamsFile(): EnsembleTeam[] {
  ensureDir(ENSEMBLE_DIR)
  if (!fs.existsSync(TEAMS_FILE)) return []
  return JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf-8'))
}

// Archive thresholds: when teams.json exceeds ARCHIVE_THRESHOLD entries,
// move all 'disbanded' / 'failed' teams whose completedAt (or createdAt
// fallback) is older than ARCHIVE_AGE_MS into a monthly archive file.
// The active team count + last 200 disbanded stay in teams.json for fast
// loadTeams(); team-history search reads archives on demand.
const ARCHIVE_THRESHOLD = parseInt(process.env['ENSEMBLE_TEAMS_ARCHIVE_THRESHOLD'] ?? '500', 10) || 500
const ARCHIVE_AGE_MS = parseInt(process.env['ENSEMBLE_TEAMS_ARCHIVE_AGE_MS'] ?? '', 10) || (7 * 24 * 60 * 60 * 1000)
const KEEP_RECENT_DISBANDED = 200

function archivePathForMonth(date: Date): string {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  return path.join(ENSEMBLE_DIR, `teams-archive-${yyyy}-${mm}.json`)
}

function maybeArchiveTeams(teams: EnsembleTeam[]): EnsembleTeam[] {
  if (teams.length < ARCHIVE_THRESHOLD) return teams
  const now = Date.now()
  const isOldDisbanded = (t: EnsembleTeam): boolean => {
    if (t.status !== 'disbanded' && t.status !== 'failed') return false
    const ts = t.completedAt || t.createdAt
    const tsMs = ts ? new Date(ts).getTime() : 0
    return Number.isFinite(tsMs) && now - tsMs > ARCHIVE_AGE_MS
  }
  const eligible = teams.filter(isOldDisbanded)
  if (eligible.length === 0) return teams

  // Always keep the most recent N disbanded teams in the live file so
  // dashboards / team-history's recent-list don't immediately fall through
  // to archives.
  const disbandedSorted = teams
    .filter(t => t.status === 'disbanded' || t.status === 'failed')
    .sort((a, b) => (b.completedAt || b.createdAt).localeCompare(a.completedAt || a.createdAt))
  const keepIds = new Set(disbandedSorted.slice(0, KEEP_RECENT_DISBANDED).map(t => t.id))
  const toArchive = eligible.filter(t => !keepIds.has(t.id))
  if (toArchive.length === 0) return teams

  // Group archive entries by month and append (don't overwrite — multiple
  // rotations can land in the same month).
  const byMonth = new Map<string, EnsembleTeam[]>()
  for (const t of toArchive) {
    const ts = t.completedAt || t.createdAt
    const date = new Date(ts || Date.now())
    const archivePath = archivePathForMonth(date)
    if (!byMonth.has(archivePath)) byMonth.set(archivePath, [])
    byMonth.get(archivePath)!.push(t)
  }
  try {
    for (const [archivePath, entries] of byMonth) {
      let existing: EnsembleTeam[] = []
      if (fs.existsSync(archivePath)) {
        try { existing = JSON.parse(fs.readFileSync(archivePath, 'utf-8')) } catch { existing = [] }
      }
      const seen = new Set(existing.map(t => t.id))
      const merged = existing.concat(entries.filter(t => !seen.has(t.id)))
      fs.writeFileSync(archivePath, JSON.stringify(merged, null, 2))
    }
    console.log(`[Ensemble] Archived ${toArchive.length} disbanded team(s) to ${byMonth.size} monthly file(s)`)
  } catch (err) {
    console.error('[Ensemble] Archive write failed (keeping in live file):', err)
    return teams
  }
  const archivedIds = new Set(toArchive.map(t => t.id))
  return teams.filter(t => !archivedIds.has(t.id))
}

function writeTeamsFile(teams: EnsembleTeam[]): void {
  ensureDir(ENSEMBLE_DIR)
  const compacted = maybeArchiveTeams(teams)
  fs.writeFileSync(TEAMS_FILE, JSON.stringify(compacted, null, 2))
}

function acquireTeamsLock(): () => void {
  ensureDir(ENSEMBLE_DIR)
  const startedAt = Date.now()

  for (;;) {
    try {
      fs.mkdirSync(TEAMS_LOCK_DIR)
      return () => {
        try {
          fs.rmSync(TEAMS_LOCK_DIR, { recursive: true, force: true })
        } catch { /* best effort */ }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'EEXIST') throw error

      try {
        const stat = fs.statSync(TEAMS_LOCK_DIR)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(TEAMS_LOCK_DIR, { recursive: true, force: true })
          continue
        }
      } catch { /* lock changed while checking; retry */ }

      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out acquiring teams.json lock after ${LOCK_TIMEOUT_MS}ms`)
      }

      sleepSync(50)
    }
  }
}

function withTeamsLock<T>(fn: () => T): T {
  const release = acquireTeamsLock()
  try {
    return fn()
  } finally {
    release()
  }
}

export function loadTeams(): EnsembleTeam[] {
  return withTeamsLock(() => readTeamsFile())
}

/**
 * Load every team — live registry plus all monthly archive files. Used by
 * cross-time search (team-history) so archived teams stay discoverable.
 * Live teams take precedence on id collision (shouldn't happen, but safe
 * default). Archive read is lazy: missing/unreadable archive files are
 * skipped silently — a corrupt archive doesn't break the search path.
 */
export function loadAllTeamsIncludingArchives(): EnsembleTeam[] {
  const live = loadTeams()
  const liveIds = new Set(live.map(t => t.id))
  const result = [...live]
  try {
    if (!fs.existsSync(ENSEMBLE_DIR)) return result
    const archiveFiles = fs.readdirSync(ENSEMBLE_DIR)
      .filter(f => f.startsWith('teams-archive-') && f.endsWith('.json'))
    for (const f of archiveFiles) {
      try {
        const archived: EnsembleTeam[] = JSON.parse(
          fs.readFileSync(path.join(ENSEMBLE_DIR, f), 'utf-8'),
        )
        for (const t of archived) {
          if (!liveIds.has(t.id)) {
            result.push(t)
            liveIds.add(t.id)
          }
        }
      } catch (err) {
        console.warn(`[Ensemble] Failed to read archive ${f}:`, err)
      }
    }
  } catch { /* directory walk failed — return live teams only */ }
  return result
}

export function saveTeams(teams: EnsembleTeam[]): void {
  withTeamsLock(() => {
    writeTeamsFile(teams)
  })
}

export function getTeam(id: string): EnsembleTeam | undefined {
  return loadTeams().find(t => t.id === id)
}

export function createTeam(request: CreateTeamRequest): EnsembleTeam {
  return withTeamsLock(() => {
    const teams = readTeamsFile()
    const team: EnsembleTeam = {
      id: uuidv4(),
      name: request.name,
      description: request.description,
      status: 'forming',
      agents: request.agents.map((a, i) => ({
        agentId: '',
        name: `${a.program.toLowerCase().replace(/\s+/g, '-').split('-')[0]}-${i + 1}`,
        program: a.program,
        role: a.role || (i === 0 ? 'lead' : 'member'),
        hostId: a.hostId || '',
        status: 'spawning' as const,
      })),
      createdBy: getCreatedBy(),
      createdAt: new Date().toISOString(),
      feedMode: request.feedMode || 'live',
      workingDirectory: request.workingDirectory,
    }
    teams.push(team)
    writeTeamsFile(teams)
    return team
  })
}

export function updateTeam(id: string, updates: Partial<EnsembleTeam>): EnsembleTeam | undefined {
  return withTeamsLock(() => {
    const teams = readTeamsFile()
    const idx = teams.findIndex(t => t.id === id)
    if (idx === -1) return undefined
    teams[idx] = { ...teams[idx], ...updates }
    writeTeamsFile(teams)
    return teams[idx]
  })
}

export function getActiveTeamsByWorkingDir(cwd: string): EnsembleTeam[] {
  return loadTeams().filter(t => t.status === 'active' && t.workingDirectory === cwd)
}

function acquireMessageLock(file: string): () => void {
  const lockDir = `${file}.lock`
  const startedAt = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      return () => { try { fs.rmSync(lockDir, { recursive: true, force: true }) } catch { /* */ } }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== 'EEXIST') throw error
      try {
        const stat = fs.statSync(lockDir)
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true })
          continue
        }
      } catch { /* lock changed while checking; retry */ }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        break
      }
      sleepSync(50)
    }
  }
  return () => {}
}

export function appendMessage(teamId: string, message: EnsembleMessage): void {
  const dir = path.join(MESSAGES_DIR, teamId)
  ensureDir(dir)
  const file = path.join(dir, 'feed.jsonl')
  const release = acquireMessageLock(file)
  try {
    const msg = message.timestamp ? message : { ...message, timestamp: new Date().toISOString() }
    fs.appendFileSync(file, JSON.stringify(msg) + '\n')
  } finally {
    release()
  }
}

export function getMessages(teamId: string, since?: string): EnsembleMessage[] {
  const sources = [
    path.join(MESSAGES_DIR, teamId, 'feed.jsonl'),
    collabMessagesFile(teamId),
  ]

  const seenIds = new Set<string>()
  let messages: EnsembleMessage[] = []

  for (const file of sources) {
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    for (const line of lines) {
      let msg: EnsembleMessage
      try { msg = JSON.parse(line) as EnsembleMessage } catch { continue }
      const dedupeKey = msg.id || `${msg.from}:${msg.timestamp}:${msg.content?.slice(0, 50)}`
      if (!seenIds.has(dedupeKey)) {
        seenIds.add(dedupeKey)
        messages.push(msg)
      }
    }
  }

  // Sort by timestamp (messages without timestamp go to the end)
  messages.sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : Infinity
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : Infinity
    return ta - tb
  })

  if (since) {
    messages = messages.filter(m => m.timestamp && m.timestamp >= since)
  }
  return messages
}
