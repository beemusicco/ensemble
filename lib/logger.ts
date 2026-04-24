import path from 'path'
import { getEnsembleDataDir } from './ensemble-paths'
import { RotatingFileWriter } from './log-rotation'

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

const logWriter = new RotatingFileWriter(logFilePath, getLogsDir)

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
  logWriter.write(line)
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

export function checkLogRotation(): void {
  logWriter.checkRotation()
}
