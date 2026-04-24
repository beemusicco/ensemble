import fs from 'fs'
import path from 'path'
import { getEnsembleDataDir } from './ensemble-paths'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function getLogsDir(): string {
  return path.join(getEnsembleDataDir(), 'logs')
}

function logFilePath(): string {
  const today = new Date().toISOString().slice(0, 10)
  return path.join(getLogsDir(), `ensemble-${today}.jsonl`)
}

let minLevel: LogLevel = (process.env.ENSEMBLE_LOG_LEVEL as LogLevel) || 'info'
if (!(minLevel in LEVEL_PRIORITY)) minLevel = 'info'

let fileStream: fs.WriteStream | null = null
let cachedPath: string | null = null
function getFileStream(): fs.WriteStream | null {
  const p = logFilePath()
  if (fileStream && cachedPath === p) return fileStream
  try {
    fs.mkdirSync(getLogsDir(), { recursive: true })
    const s = fs.createWriteStream(p, { flags: 'a' })
    s.on('error', () => { /* swallow async write errors */ })
    fileStream = s
    cachedPath = p
    return s
  } catch {
    fileStream = null
    cachedPath = null
    return null
  }
}

export interface LogFields {
  [key: string]: unknown
}

function emit(level: LogLevel, msg: string, fields?: LogFields) {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  }
  const line = JSON.stringify(record)
  const s = getFileStream()
  if (s) {
    try { s.write(line + '\n') } catch { /* shutdown */ }
  }
  const target = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  target.write(line + '\n')
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
  with: (bound: LogFields) => ({
    debug: (msg: string, fields?: LogFields) => emit('debug', msg, { ...bound, ...fields }),
    info: (msg: string, fields?: LogFields) => emit('info', msg, { ...bound, ...fields }),
    warn: (msg: string, fields?: LogFields) => emit('warn', msg, { ...bound, ...fields }),
    error: (msg: string, fields?: LogFields) => emit('error', msg, { ...bound, ...fields }),
  }),
}

export function getLogFilePath(): string {
  return logFilePath()
}
