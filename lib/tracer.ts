import path from 'path'
import crypto from 'crypto'
import { getEnsembleDataDir } from './ensemble-paths'
import { RotatingFileWriter } from './log-rotation'

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

const traceWriter = new RotatingFileWriter(tracesFilePath, tracesDir)

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
  traceWriter.write(JSON.stringify(span))
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

export function checkTraceRotation(): void {
  traceWriter.checkRotation()
}
