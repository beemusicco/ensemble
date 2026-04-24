import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getEnsembleDataDir } from './ensemble-paths'

const TOKEN_ENV = 'ENSEMBLE_AUTH_TOKEN'
const TOKEN_FILENAME = 'auth-token'

function tokenFilePath(): string {
  return path.join(getEnsembleDataDir(), TOKEN_FILENAME)
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex')
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

export function verifyBearer(authHeader: string | undefined): boolean {
  if (!authHeader) return false
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const presented = match[1].trim()
  const expected = getAuthToken()
  if (presented.length !== expected.length) return false
  return crypto.timingSafeEqual(
    Buffer.from(presented, 'utf8'),
    Buffer.from(expected, 'utf8'),
  )
}
