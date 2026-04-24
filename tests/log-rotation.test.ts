import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { LOG_MAX_BYTES, LOG_RETENTION, RotatingFileWriter } from '../lib/log-rotation'

describe('RotatingFileWriter', () => {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-log-rotation-'))
    tempRoots.push(dir)
    return dir
  }

  it('rotates the active file when it exceeds the max size', () => {
    const dir = tempDir()
    const filePath = path.join(dir, 'ensemble-2026-04-24.jsonl')
    fs.writeFileSync(filePath, Buffer.alloc(LOG_MAX_BYTES + 1))

    const writer = new RotatingFileWriter(() => filePath, () => dir, 60_000)
    writer.checkRotation()
    writer.write('{"ok":true}')
    writer.close()

    expect(fs.existsSync(`${filePath}.1`)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf8')).toContain('"ok":true')
  })

  it('keeps only the configured number of rotated files', () => {
    const dir = tempDir()
    const filePath = path.join(dir, 'traces-2026-04-24.jsonl')
    fs.writeFileSync(filePath, Buffer.alloc(LOG_MAX_BYTES + 1))
    for (let i = 1; i <= LOG_RETENTION + 2; i++) {
      fs.writeFileSync(`${filePath}.${i}`, `${i}\n`)
    }

    const writer = new RotatingFileWriter(() => filePath, () => dir, 60_000)
    writer.checkRotation()
    writer.close()

    expect(fs.existsSync(`${filePath}.1`)).toBe(true)
    expect(fs.existsSync(`${filePath}.${LOG_RETENTION}`)).toBe(true)
    expect(fs.existsSync(`${filePath}.${LOG_RETENTION + 1}`)).toBe(false)
    expect(fs.existsSync(`${filePath}.${LOG_RETENTION + 2}`)).toBe(false)
  })
})
