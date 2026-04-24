import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getEnsembleDataDir } from './ensemble-paths'

const TOKEN_ENV = 'ENSEMBLE_AUTH_TOKEN'
const TOKEN_FILENAME = 'auth-token'
const USERS_DIRNAME = 'users'
const USER_TOKEN_EXT = '.token'
const TOKEN_HEX_BYTES = 32
const USER_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

interface TokenRecord {
  token: string
  userPath?: string
}

function tokenFilePath(): string {
  return path.join(getEnsembleDataDir(), TOKEN_FILENAME)
}

function usersDirPath(): string {
  return path.join(getEnsembleDataDir(), USERS_DIRNAME)
}

function userTokenPath(name: string): string {
  return path.join(usersDirPath(), `${name}${USER_TOKEN_EXT}`)
}

function generateToken(): string {
  return crypto.randomBytes(TOKEN_HEX_BYTES).toString('hex')
}

function validateUserName(name: string): void {
  if (!USER_NAME_RE.test(name)) {
    throw new Error('user name must be 1-64 chars: letters, numbers, underscore, dash')
  }
}

export function getAuthToken(): string {
  const fromEnv = process.env[TOKEN_ENV]?.trim()
  if (fromEnv) return fromEnv

  const filePath = tokenFilePath()
  if (fs.existsSync(filePath)) {
    const stored = fs.readFileSync(filePath, 'utf8').trim()
    if (stored) return stored
  }

  const token = generateToken()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, token, { mode: 0o600 })
  return token
}

export function getAuthTokenPath(): string {
  return tokenFilePath()
}

function loadTokenRecords(): TokenRecord[] {
  const records: TokenRecord[] = []
  const seen = new Set<string>()
  const add = (token: string | undefined, userPath?: string) => {
    const trimmed = token?.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    records.push({ token: trimmed, userPath })
  }

  add(process.env[TOKEN_ENV])

  const filePath = tokenFilePath()
  if (fs.existsSync(filePath)) {
    try { add(fs.readFileSync(filePath, 'utf8')) } catch { /* ignore unreadable token */ }
  }

  const dir = usersDirPath()
  if (fs.existsSync(dir)) {
    let entries: string[] = []
    try { entries = fs.readdirSync(dir) } catch { entries = [] }
    for (const entry of entries) {
      if (!entry.endsWith(USER_TOKEN_EXT)) continue
      const fullPath = path.join(dir, entry)
      try {
        const stat = fs.statSync(fullPath)
        if (stat.isFile()) add(fs.readFileSync(fullPath, 'utf8'), fullPath)
      } catch { /* skip bad user token */ }
    }
  }

  return records
}

export function loadAllValidTokens(): string[] {
  return loadTokenRecords().map(record => record.token)
}

export function verifyToken(presented: string): boolean {
  const candidate = presented.trim()
  const records = loadTokenRecords()
  let matchedUserPath: string | undefined
  let matched = false

  for (const record of records) {
    let equal = false
    if (candidate.length === record.token.length) {
      equal = crypto.timingSafeEqual(
        Buffer.from(candidate, 'utf8'),
        Buffer.from(record.token, 'utf8'),
      )
    }
    if (equal) {
      matched = true
      if (record.userPath) matchedUserPath = record.userPath
    }
  }

  if (matchedUserPath) {
    try {
      const now = new Date()
      fs.utimesSync(matchedUserPath, now, now)
    } catch { /* best-effort last-used tracking */ }
  }

  return matched
}

export function listUsers(): Array<{ name: string; path: string; lastUsedAt: string }> {
  const dir = usersDirPath()
  if (!fs.existsSync(dir)) return []

  let entries: string[] = []
  try { entries = fs.readdirSync(dir) } catch { return [] }

  return entries
    .filter(entry => entry.endsWith(USER_TOKEN_EXT))
    .map(entry => {
      const fullPath = path.join(dir, entry)
      try {
        const stat = fs.statSync(fullPath)
        if (!stat.isFile()) return null
        return {
          name: entry.slice(0, -USER_TOKEN_EXT.length),
          path: fullPath,
          lastUsedAt: stat.mtime.toISOString(),
        }
      } catch {
        return null
      }
    })
    .filter((item): item is { name: string; path: string; lastUsedAt: string } => item !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function addUser(name: string): { name: string; token: string; path: string } {
  validateUserName(name)
  const dir = usersDirPath()
  const fullPath = userTokenPath(name)
  if (fs.existsSync(fullPath)) throw new Error(`user already exists: ${name}`)

  const token = generateToken()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(fullPath, token, { mode: 0o600, flag: 'wx' })
  return { name, token, path: fullPath }
}

export function revokeUser(name: string): boolean {
  validateUserName(name)
  const fullPath = userTokenPath(name)
  if (!fs.existsSync(fullPath)) return false
  fs.unlinkSync(fullPath)
  return true
}

export function verifyBearer(authHeader: string | undefined): boolean {
  if (!authHeader) return false
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  return verifyToken(match[1])
}
