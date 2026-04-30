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
    // Use unique basenames so the W2.5 basename-fallback doesn't rescue the
    // missing one. (The whole point of basename fallback is "if foo exists
    // anywhere, accept it"; this test must verify the genuine miss.)
    fs.mkdirSync(path.join(tmpDir, 'real'))
    fs.writeFileSync(path.join(tmpDir, 'real/realonly.ts'), 'a\nb\n')
    const out = scanCitations({
      text: 'real/realonly.ts:1 vs missing/uniquemiss.ts:1',
      worktreePath: tmpDir,
    })
    const fab = findConfabulations(out)
    expect(fab).toHaveLength(1)
    expect(fab[0].rawCitation).toBe('missing/uniquemiss.ts:1')
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

  // ── W2.5 production-finding regression tests ──────────────────────────

  it('basename-only citation resolves via search index when file lives in subdir', () => {
    // Production case: claude-1 cited `DashboardPage.jsx:67` without the
    // `frontend/src/pages/` prefix. Old guard reported "not found in
    // worktree" because resolve(workingDir, 'DashboardPage.jsx') doesn't exist.
    // New guard walks subdirs and matches by basename.
    fs.mkdirSync(path.join(tmpDir, 'frontend/src/pages'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'frontend/src/pages/DashboardPage.jsx'),
      Array(120).fill('// line').join('\n'),  // 120 lines
    )
    const out = scanCitations({
      text: 'see DashboardPage.jsx:67 for the widget',
      worktreePath: tmpDir,
    })
    expect(out).toHaveLength(1)
    expect(out[0].exists).toBe(true)
    expect(out[0].inRange).toBe(true)
    expect(out[0].lineCount).toBe(120)
  })

  it('citation in agent worktree (not project root) resolves via fallbackPaths', () => {
    // Production case: codex-2 created CostAllocationPage.jsx (596 lines)
    // in its worktree. At VERIFY (before merge), the file does NOT exist in
    // project root. Guard should still resolve it from the agent's worktree.
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-root-'))
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-wt-'))
    try {
      fs.mkdirSync(path.join(worktree, 'frontend/src/pages/settings'), { recursive: true })
      fs.writeFileSync(
        path.join(worktree, 'frontend/src/pages/settings/CostAllocationPage.jsx'),
        Array(600).fill('// line').join('\n'),
      )
      const out = scanCitations({
        text: 'CostAllocationPage.jsx:167 has the form',
        worktreePath: projectRoot,
        fallbackPaths: [worktree],
      })
      expect(out[0].exists).toBe(true)
      expect(out[0].inRange).toBe(true)
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true })
      fs.rmSync(worktree, { recursive: true, force: true })
    }
  })

  it('takes max line count when basename matches across multiple roots', () => {
    // Two worktrees both have foo.ts but with different lengths (one agent
    // edited it, one didn't). Guard should accept the longer version so we
    // don't flag valid cites against the edited file.
    const wt1 = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-wt1-'))
    const wt2 = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-wt2-'))
    try {
      fs.writeFileSync(path.join(wt1, 'foo.ts'), Array(20).fill('x').join('\n'))   // 20 lines
      fs.writeFileSync(path.join(wt2, 'foo.ts'), Array(150).fill('x').join('\n'))  // 150 lines
      const out = scanCitations({
        text: 'see foo.ts:120 for the change',
        worktreePath: wt1,
        fallbackPaths: [wt2],
      })
      // Direct resolve hits wt1 first (20 lines) → out of range. But basename
      // tier sees both, takes max=150, so 120 IS in range. We expect Tier 1
      // (direct resolve) to win when present, returning the 20-line file.
      // Then the test below validates basename-only path takes max correctly.
      expect(out[0].exists).toBe(true)
      // Tier 1 wins for the explicit `foo.ts` since wt1 has it directly.
      expect(out[0].lineCount).toBe(20)
    } finally {
      fs.rmSync(wt1, { recursive: true, force: true })
      fs.rmSync(wt2, { recursive: true, force: true })
    }
  })

  it('basename fallback takes MAX line count across all matches', () => {
    // When direct resolve fails (cite doesn't include any path), basename
    // fallback should accept the citation if ANY version of the file is long
    // enough.
    const wt1 = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-wt1-'))
    const wt2 = fs.mkdtempSync(path.join(os.tmpdir(), 'confab-wt2-'))
    try {
      fs.mkdirSync(path.join(wt1, 'a'))
      fs.mkdirSync(path.join(wt2, 'b'))
      fs.writeFileSync(path.join(wt1, 'a/Foo.tsx'), Array(30).fill('x').join('\n'))   // 30
      fs.writeFileSync(path.join(wt2, 'b/Foo.tsx'), Array(200).fill('x').join('\n'))  // 200
      // Cite is basename-only — direct resolve fails in BOTH roots (different
      // subdirs). Basename fallback should still resolve.
      const out = scanCitations({
        text: 'see Foo.tsx:150',
        worktreePath: wt1,
        fallbackPaths: [wt2],
      })
      expect(out[0].exists).toBe(true)
      expect(out[0].lineCount).toBe(200)  // max across matches
      expect(out[0].inRange).toBe(true)
    } finally {
      fs.rmSync(wt1, { recursive: true, force: true })
      fs.rmSync(wt2, { recursive: true, force: true })
    }
  })

  it('still flags cites whose basename does not appear anywhere — true confabs', () => {
    fs.mkdirSync(path.join(tmpDir, 'real'))
    fs.writeFileSync(path.join(tmpDir, 'real/exists.ts'), 'a\nb\n')
    const out = scanCitations({
      text: 'fictional-file-xyz.ts:42 does not exist',
      worktreePath: tmpDir,
    })
    expect(out[0].exists).toBe(false)
    expect(out[0].inRange).toBe(false)
  })
})
