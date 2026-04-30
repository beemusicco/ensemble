import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-tools-test-'))
const prevDataDir = process.env.ENSEMBLE_DATA_DIR
process.env.ENSEMBLE_DATA_DIR = tmpDataDir

const { buildPromptPreview } = await import('../services/ensemble-service')

describe('project tool index (.collab-tools.md)', () => {
  let projectDir: string

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-tools-repo-'))
  })

  afterAll(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.ENSEMBLE_DATA_DIR
    else process.env.ENSEMBLE_DATA_DIR = prevDataDir
  })

  it('omits the PROJECT TOOLS block when no .collab-tools.md exists', () => {
    const prompt = buildPromptPreview({
      teamId: 't1', teamName: 'team-x', description: 'work',
      agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
      workingDirectory: projectDir,
    })
    expect(prompt).not.toContain('PROJECT TOOLS')
  })

  it('injects the .collab-tools.md body verbatim when present', () => {
    fs.writeFileSync(
      path.join(projectDir, '.collab-tools.md'),
      `# Tools\n\n- test: \`bun test\`\n- lint: \`ruff check\`\n- dev: \`bun run dev\`\n`,
    )
    const prompt = buildPromptPreview({
      teamId: 't1', teamName: 'team-x', description: 'work',
      agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
      workingDirectory: projectDir,
    })
    expect(prompt).toContain('PROJECT TOOLS')
    expect(prompt).toContain('bun test')
    expect(prompt).toContain('ruff check')
    expect(prompt).toContain('bun run dev')
  })

  it('truncates a runaway .collab-tools.md to keep prompt size sane', () => {
    const huge = 'x'.repeat(20_000)
    fs.writeFileSync(path.join(projectDir, '.collab-tools.md'), huge)
    const prompt = buildPromptPreview({
      teamId: 't1', teamName: 'team-x', description: 'work',
      agentName: 'codex-1', teammateNames: ['claude-2'], agentIndex: 0,
      workingDirectory: projectDir,
    })
    expect(prompt).toContain('PROJECT TOOLS')
    expect(prompt).toContain('truncated')
    // The block can't include the full 20KB — assert overall prompt is well below 30KB.
    expect(prompt.length).toBeLessThan(30_000)
  })
})
