import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

let tmpHome: string
let tmpRepo: string
let prevConfigDir: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-home-'))
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-repo-'))
  prevConfigDir = process.env.ENSEMBLE_COLLAB_CONFIG_DIR
  process.env.ENSEMBLE_COLLAB_CONFIG_DIR = path.join(tmpHome, 'collab-config')
})

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true })
  fs.rmSync(tmpRepo, { recursive: true, force: true })
  if (prevConfigDir === undefined) delete process.env.ENSEMBLE_COLLAB_CONFIG_DIR
  else process.env.ENSEMBLE_COLLAB_CONFIG_DIR = prevConfigDir
})

describe('project-config resolver', () => {
  it('returns null when neither tier has the file', async () => {
    const { findProjectConfigPath } = await import('../lib/project-config')
    expect(findProjectConfigPath('.collab-tools.md', tmpRepo)).toBeNull()
  })

  it('finds file in repo root when operator-config is missing', async () => {
    const { findProjectConfigPath } = await import('../lib/project-config')
    const file = path.join(tmpRepo, '.collab-tools.md')
    fs.writeFileSync(file, '# repo content')
    const r = findProjectConfigPath('.collab-tools.md', tmpRepo)
    expect(r).not.toBeNull()
    expect(r!.path).toBe(file)
    expect(r!.source).toBe('repo-root')
  })

  it('finds file in operator-config dir keyed by repo basename', async () => {
    const { findProjectConfigPath } = await import('../lib/project-config')
    const basename = path.basename(tmpRepo)
    const opDir = path.join(tmpHome, 'collab-config', basename)
    fs.mkdirSync(opDir, { recursive: true })
    const opFile = path.join(opDir, '.collab-tools.md')
    fs.writeFileSync(opFile, '# operator content')
    const r = findProjectConfigPath('.collab-tools.md', tmpRepo)
    expect(r).not.toBeNull()
    expect(r!.path).toBe(opFile)
    expect(r!.source).toBe('operator-config')
  })

  it('operator-config wins when BOTH tiers have the file', async () => {
    const { findProjectConfigPath, readProjectConfigText } = await import('../lib/project-config')
    const basename = path.basename(tmpRepo)
    const opDir = path.join(tmpHome, 'collab-config', basename)
    fs.mkdirSync(opDir, { recursive: true })
    fs.writeFileSync(path.join(opDir, '.collab-tools.md'), '# operator wins')
    fs.writeFileSync(path.join(tmpRepo, '.collab-tools.md'), '# repo loses')
    const r = findProjectConfigPath('.collab-tools.md', tmpRepo)
    expect(r!.source).toBe('operator-config')
    const text = readProjectConfigText('.collab-tools.md', tmpRepo)
    expect(text!.text).toContain('operator wins')
  })

  it('returns null when workingDirectory is undefined', async () => {
    const { findProjectConfigPath } = await import('../lib/project-config')
    expect(findProjectConfigPath('.collab-tools.md', undefined)).toBeNull()
  })

  it('readProjectConfigText returns null when nothing exists', async () => {
    const { readProjectConfigText } = await import('../lib/project-config')
    expect(readProjectConfigText('.collab-tools.md', tmpRepo)).toBeNull()
  })
})
