/**
 * Agent Config Loader — reads agents.json and provides lookup helpers.
 * Single source of truth for agent-specific behavior across spawner, ensemble, and monitor.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentProgram, AgentsConfig } from '../types/agent-program'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let _cache: AgentsConfig | null = null

/** Load agents.json from repo root (cached after first read) */
export function loadAgentsConfig(): AgentsConfig {
  if (_cache) return _cache

  const configPath = process.env['ENSEMBLE_AGENTS_CONFIG']
    || path.join(__dirname, '..', 'agents.json')

  const raw = fs.readFileSync(configPath, 'utf-8')
  _cache = JSON.parse(raw) as AgentsConfig
  return _cache
}

/** Clear cached config (useful for tests) */
export function clearAgentsConfigCache(): void {
  _cache = null
}

/**
 * Resolve a program string (e.g. "codex", "claude code", "claude-code") to its AgentProgram config.
 * Throws on unknown program name — silent fallback hid mis-spawns (e.g. "sonnet"/"haiku"
 * not in agents.json silently resolved to claude/Opus, so premium-quad spawned 4×Opus).
 *
 * Substring match intentionally preferred over longest-key match: existing call sites pass
 * strings like "claude code" that must match "claude". New keys that are substrings of
 * existing ones (none today) would need explicit precedence handling.
 */
export function resolveAgentProgram(program: string): AgentProgram {
  const config = loadAgentsConfig()
  const p = program.toLowerCase()

  // Direct key match
  if (config[p]) return config[p]

  // Substring match (e.g. "claude code" matches "claude")
  for (const [key, agent] of Object.entries(config)) {
    if (p.includes(key)) return agent
  }

  throw new Error(
    `Unknown agent program: "${program}". Available: ${Object.keys(config).join(', ')}. ` +
    `Add a definition to agents.json (or set ENSEMBLE_AGENTS_CONFIG) before spawning this agent.`
  )
}

/**
 * Build the full CLI command for an agent, including env-level flags.
 */
export function buildAgentCommand(program: string): string {
  const agent = resolveAgentProgram(program)
  const envFlags = (process.env['ENSEMBLE_AGENT_FLAGS'] ?? '').trim()

  const envTokens = envFlags ? envFlags.split(/\s+/).filter(Boolean) : []
  const envFlagKeys = new Set(envTokens.filter(token => token.startsWith('-')))
  const defaultTokens: string[] = []

  for (let i = 0; i < agent.flags.length; i++) {
    const token = agent.flags[i]
    if (!token.startsWith('-')) {
      defaultTokens.push(token)
      continue
    }
    if (envFlagKeys.has(token)) {
      if (i + 1 < agent.flags.length && !agent.flags[i + 1].startsWith('-')) i++
      continue
    }
    defaultTokens.push(token)
    if (i + 1 < agent.flags.length && !agent.flags[i + 1].startsWith('-')) {
      defaultTokens.push(agent.flags[++i])
    }
  }

  return [agent.command, envFlags, defaultTokens.join(' ')].filter(Boolean).join(' ')
}
