import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  scanCitations, findConfabulations, formatConfabulationWarning,
} from '../lib/confabulation-guard'

describe('confabulation-guard', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('flags a citation pointing to a non-existent file', () => {
    const out = scanCitations({
      text: 'see lib/missing.ts:42 for the change',
      worktreePath: tmpDir,
    })
    expect(out).toHaveLength(1)
    expect(out[0].exists).toBe(false)
    expect(out[0].inRange).toBe(false)
    expect(out[0].rawCitation).toBe('lib/missing.ts:42')
  })

  it('flags a citation with line out of range', () => {
    fs.mkdirSync(path.join(tmpDir, 'lib'))
    fs.writeFileSync(path.join(tmpDir, 'lib/short.ts'), 'a\nb\nc\n')  // 3 lines
    const out = scanCitations({ text: 'check lib/short.ts:99', worktreePath: tmpDir })
    expect(out[0].exists).toBe(true)
    expect(out[0].lineCount).toBe(3)
    expect(out[0].inRange).toBe(false)
  })

  it('passes a citation that resolves and is in range', () => {
    fs.mkdirSync(path.join(tmpDir, 'lib'))
    fs.writeFileSync(path.join(tmpDir, 'lib/file.ts'), 'a\nb\nc\nd\ne\n')
    const out = scanCitations({ text: 'see lib/file.ts:3 for detail', worktreePath: tmpDir })
    expect(out[0].exists).toBe(true)
    expect(out[0].inRange).toBe(true)
  })

  it('ignores patterns that look like timestamps or version strings', () => {
    const out = scanCitations({
      text: 'logged at 12:34, version 2.0:1 ready',
      worktreePath: tmpDir,
    })
    expect(out).toEqual([])
  })

  it('ignores http URLs containing colon-port patterns', () => {
    const out = scanCitations({
      text: 'see http://localhost:3000 for the dashboard',
      worktreePath: tmpDir,
    })
    expect(out).toEqual([])
  })

  it('dedupes repeated identical citations', () => {
    const out = scanCitations({
      text: 'lib/x.ts:42 and lib/x.ts:42 again',
      worktreePath: tmpDir,
    })
    expect(out).toHaveLength(1)
  })

  it('findConfabulations returns only confabulated entries', () => {
    fs.mkdirSync(path.join(tmpDir, 'real'))
    fs.writeFileSync(path.join(tmpDir, 'real/file.ts'), 'a\nb\n')
    const out = scanCitations({
      text: 'real/file.ts:1 vs missing/file.ts:1',
      worktreePath: tmpDir,
    })
    const fab = findConfabulations(out)
    expect(fab).toHaveLength(1)
    expect(fab[0].rawCitation).toBe('missing/file.ts:1')
  })

  it('formatConfabulationWarning produces a readable message', () => {
    const text = formatConfabulationWarning('codex-1', {
      rawCitation: 'foo.ts:99',
      filePath: 'foo.ts',
      line: 99,
      exists: true,
      lineCount: 12,
      inRange: false,
    })
    expect(text).toMatch(/codex-1/)
    expect(text).toMatch(/foo.ts:99/)
    expect(text).toMatch(/12 line/)
  })
})
