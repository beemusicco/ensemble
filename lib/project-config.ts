/**
 * Project-config resolver — operator-config dir overrides repo root.
 *
 * Why this exists: when ensemble dropped `.collab-bulletproof.json` and
 * `.collab-tools.md` at repo roots, operators kept committing them to git
 * "by accident" then deleting them as orchestration noise (commits ef3fbb9,
 * 1aaffa8 in accounting-helper, 2026-04-30). The repo-root location made
 * sense from "config travels with code" perspective but conflicted with
 * operator mental model of "anything in repo root is product code".
 *
 * Resolver order:
 *   1. Operator-config: `<COLLAB_CONFIG_DIR>/<repo-basename>/<filename>`
 *      — never in git, per-machine, persists across repo cleanups
 *   2. Repo root: `<workingDirectory>/<filename>`
 *      — for repos that explicitly want collab config in version control
 *
 * COLLAB_CONFIG_DIR defaults to `~/.openclaw/collab-config/` if
 * `~/.openclaw/` exists, else `~/.ensemble/collab-config/`. Override with
 * env `ENSEMBLE_COLLAB_CONFIG_DIR`.
 *
 * The first hit wins. Operator-config takes priority because that's where
 * the LATEST setup lives — if operator dropped a tuned bulletproof in
 * `~/.openclaw/collab-config/foo/`, an old repo-root copy shouldn't shadow it.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

function defaultConfigDir(): string {
  const env = process.env.ENSEMBLE_COLLAB_CONFIG_DIR
  if (env && env.trim()) return env.trim()
  const openclawRoot = path.join(os.homedir(), '.openclaw')
  if (fs.existsSync(openclawRoot)) {
    return path.join(openclawRoot, 'collab-config')
  }
  return path.join(os.homedir(), '.ensemble', 'collab-config')
}

export interface ResolvedConfig {
  path: string
  source: 'operator-config' | 'repo-root'
}

/**
 * Find a project-scoped config file. Returns the resolved path + which tier
 * it came from, or null if neither tier has it. The `workingDirectory` is the
 * team's project root (used both as repo-root tier AND to derive the
 * operator-config bucket name).
 */
export function findProjectConfigPath(
  filename: string,
  workingDirectory: string | undefined,
): ResolvedConfig | null {
  if (!workingDirectory) return null

  // Tier 1: operator-config dir, keyed by repo basename
  try {
    const basename = path.basename(path.resolve(workingDirectory))
    if (basename) {
      const opConfigPath = path.join(defaultConfigDir(), basename, filename)
      if (fs.existsSync(opConfigPath) && fs.statSync(opConfigPath).isFile()) {
        return { path: opConfigPath, source: 'operator-config' }
      }
    }
  } catch { /* fall through */ }

  // Tier 2: repo root
  try {
    const repoRootPath = path.join(workingDirectory, filename)
    if (fs.existsSync(repoRootPath) && fs.statSync(repoRootPath).isFile()) {
      return { path: repoRootPath, source: 'repo-root' }
    }
  } catch { /* */ }

  return null
}

/**
 * Read a project-scoped config file as text. Convenience wrapper. Returns
 * null when neither tier has the file.
 */
export function readProjectConfigText(
  filename: string,
  workingDirectory: string | undefined,
): { text: string; resolved: ResolvedConfig } | null {
  const resolved = findProjectConfigPath(filename, workingDirectory)
  if (!resolved) return null
  try {
    const text = fs.readFileSync(resolved.path, 'utf-8')
    return { text, resolved }
  } catch {
    return null
  }
}

export function getCollabConfigDir(): string {
  return defaultConfigDir()
}
