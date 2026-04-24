#!/usr/bin/env tsx
/**
 * ensemble MCP server (stub-level)
 *
 * Exposes 4 tools over stdio MCP so Claude Code / any MCP client can drive
 * an ensemble team without shelling out:
 *   - ensemble_create_team     create a new team with a task
 *   - ensemble_send_message    steer or contribute a message
 *   - ensemble_get_feed        read the message log
 *   - ensemble_signal_complete ask a team to disband (quorum aware once
 *                              the core supports it)
 *
 * Client config (Claude Code):
 *   {
 *     "mcpServers": {
 *       "ensemble": {
 *         "command": "tsx",
 *         "args": ["/path/to/ensemble/lib/mcp-server.ts"],
 *         "env": {
 *           "ENSEMBLE_URL": "http://localhost:23000",
 *           "ENSEMBLE_AUTH_TOKEN": "..."
 *         }
 *       }
 *     }
 *   }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const API_BASE = process.env.ENSEMBLE_URL || 'http://localhost:23000'
const TOKEN = process.env.ENSEMBLE_AUTH_TOKEN || ''

function authHeaders(): Record<string, string> {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`)
  return body ? JSON.parse(body) : null
}

const TOOLS = [
  {
    name: 'ensemble_create_team',
    description: 'Create a new ensemble team with a task description.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'team display name' },
        description: { type: 'string', description: 'the task for the team' },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: { program: { type: 'string' }, role: { type: 'string' } },
            required: ['program'],
          },
          default: [{ program: 'codex', role: 'lead' }, { program: 'claude code', role: 'worker' }],
        },
        workingDirectory: { type: 'string' },
        templateName: { type: 'string', description: 'optional template: review, implement, thinking, etc.' },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'ensemble_send_message',
    description: 'Send a message to an active team (steer, add context, or ask a question).',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        to: { type: 'string', default: 'team', description: "'team' or a specific agent name" },
        content: { type: 'string' },
        from: { type: 'string', default: 'user' },
      },
      required: ['teamId', 'content'],
    },
  },
  {
    name: 'ensemble_get_feed',
    description: "Read a team's message log (all messages or since a timestamp).",
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        since: { type: 'string', description: 'ISO timestamp; return only messages newer than this' },
      },
      required: ['teamId'],
    },
  },
  {
    name: 'ensemble_signal_complete',
    description: 'Signal that a team is done and disband it.',
    inputSchema: {
      type: 'object',
      properties: {
        teamId: { type: 'string' },
        from: { type: 'string', default: 'user' },
        note: { type: 'string' },
      },
      required: ['teamId'],
    },
  },
]

const server = new Server(
  { name: 'ensemble', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params as { name: string; arguments: Record<string, unknown> }
  try {
    let result: unknown
    switch (name) {
      case 'ensemble_create_team':
        result = await apiFetch('/api/ensemble/teams', {
          method: 'POST',
          body: JSON.stringify({
            name: args.name,
            description: args.description,
            agents: args.agents ?? [
              { program: 'codex', role: 'lead' },
              { program: 'claude code', role: 'worker' },
            ],
            feedMode: 'live',
            workingDirectory: args.workingDirectory,
            templateName: args.templateName,
          }),
        })
        break
      case 'ensemble_send_message':
        result = await apiFetch(`/api/ensemble/teams/${args.teamId}`, {
          method: 'POST',
          body: JSON.stringify({
            from: args.from ?? 'user',
            to: args.to ?? 'team',
            content: args.content,
          }),
        })
        break
      case 'ensemble_get_feed': {
        const qs = args.since ? `?since=${encodeURIComponent(String(args.since))}` : ''
        result = await apiFetch(`/api/ensemble/teams/${args.teamId}/feed${qs}`)
        break
      }
      case 'ensemble_signal_complete':
        result = await apiFetch(`/api/ensemble/teams/${args.teamId}/signal-complete`, {
          method: 'POST',
          body: JSON.stringify({ from: args.from ?? 'user', note: args.note }),
        })
        break
      default:
        throw new Error(`unknown tool: ${name}`)
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
})

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Stay alive; stdin close will end the transport.
}

main().catch(err => {
  console.error('[mcp-server] fatal:', err)
  process.exit(1)
})
