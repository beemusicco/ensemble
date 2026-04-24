import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { getEnsembleDataDir } from './ensemble-paths'

export interface SpanFields {
  [key: string]: unknown
}

export interface Span {
  id: string
  parentId: string | null
  name: string
  teamId?: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  status: 'ok' | 'error'
  attributes: SpanFields
  error?: string
}

function tracesDir(): string {
  return path.join(getEnsembleDataDir(), 'logs')
}

function tracesFilePath(): string {
  const today = new Date().toISOString().slice(0, 10)
  return path.join(tracesDir(), `traces-${today}.jsonl`)
}

let stream: fs.WriteStream | null = null
let cachedPath: string | null = null
function getStream(): fs.WriteStream | null {
  const p = tracesFilePath()
  if (stream && cachedPath === p) return stream
  try {
    fs.mkdirSync(tracesDir(), { recursive: true })
    const s = fs.createWriteStream(p, { flags: 'a' })
    s.on('error', () => { /* swallow async write errors */ })
    stream = s
    cachedPath = p
    return s
  } catch {
    stream = null
    cachedPath = null
    return null
  }
}

export function startSpan(name: string, attrs: SpanFields = {}, parentId?: string): Span {
  return {
    id: crypto.randomUUID(),
    parentId: parentId ?? null,
    name,
    teamId: typeof attrs.teamId === 'string' ? attrs.teamId : undefined,
    startedAt: Date.now(),
    status: 'ok',
    attributes: { ...attrs },
  }
}

export function endSpan(span: Span, extraAttrs: SpanFields = {}, error?: Error | string): Span {
  span.endedAt = Date.now()
  span.durationMs = span.endedAt - span.startedAt
  Object.assign(span.attributes, extraAttrs)
  if (error) {
    span.status = 'error'
    span.error = typeof error === 'string' ? error : error.message
  }
  const s = getStream()
  if (s) {
    try { s.write(JSON.stringify(span) + '\n') } catch { /* shutdown */ }
  }
  return span
}

export async function trace<T>(
  name: string,
  attrs: SpanFields,
  fn: (span: Span) => Promise<T> | T,
  parentId?: string,
): Promise<T> {
  const span = startSpan(name, attrs, parentId)
  try {
    const result = await fn(span)
    endSpan(span)
    return result
  } catch (err) {
    endSpan(span, {}, err instanceof Error ? err : String(err))
    throw err
  }
}

export function getTracesFilePath(): string {
  return tracesFilePath()
}
