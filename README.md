# ensemble

**Multi-agent collaboration engine** — AI agents that work as one.

Ensemble orchestrates AI agents into collaborative teams. Out of the box it pairs **Claude Code + Codex** — they communicate, share findings, and solve problems together in real time. On macOS + iTerm2 the live TUI monitor opens in a **native iTerm split pane** (no tmux needed); elsewhere, or when you're already inside tmux, it falls back to a tmux session. Agents themselves are orchestrated via the ensemble bridge — the monitor is just a viewer.

> **Status:** Experimental developer tool. macOS and Linux only.

## Features

- **Team orchestration** — Spawn multi-agent teams with a single command
- **Real-time messaging** — Agents communicate via a structured message bus
- **TUI monitor** — Live viewer that opens in a native iTerm2 split pane on macOS (or tmux elsewhere)
- **Auto-disband** — Intelligent completion detection ends teams when work is done
- **Multi-host support** — Run agents across local and remote machines
- **CLI & HTTP API** — Full control via command line or REST endpoints

**[Full documentation →](https://michelhelsdingen.github.io/ensemble/)**

## Quick Start

### Prerequisites

- Node.js 18+, Python 3.6+, curl
- [tmux](https://github.com/tmux/tmux) — required on Linux; optional on macOS (only used as a fallback if iTerm2 is not available)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex) CLIs installed

### Install & Run

```bash
git clone https://github.com/michelhelsdingen/ensemble.git
cd ensemble
npm install

# Start the server (keep this running)
npm run dev
```

### Verify (in a second terminal)

```bash
curl http://localhost:23000/api/v1/health
# → {"status":"healthy","version":"1.0.0"}
```

### Create your first team

```bash
# Via CLI
npx ensemble status

# Via API — create a team of two agents
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "review-team",
    "description": "Review the authentication module",
    "agents": [
      { "program": "claude", "role": "lead" },
      { "program": "codex", "role": "worker" }
    ],
    "workingDirectory": "'$(pwd)'"
  }'

# Watch the collaboration live
npx ensemble monitor --latest

# Steer the team
npx ensemble steer <team-id> "focus on the auth module"
```

Or use the all-in-one collab script:

```bash
./scripts/collab-launch.sh "$(pwd)" "Review the authentication module"
```

## Claude Code: `/collab` command

Ensemble ships with a skill for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Once installed, just type:

```
/collab "Review the auth module for security issues"
```

Claude spawns a Codex + Claude team, shows their conversation live in your terminal, and presents a summary when done. One-command setup:

```bash
./scripts/setup-claude-code.sh
```

This installs the skill, configures permissions, and verifies prerequisites. See the [full setup guide](https://michelhelsdingen.github.io/ensemble/configuration#claude-code-integration) for details.

## Supported Agents

The default team is **Claude Code (lead) + Codex (worker)**. This is the tested, production-ready combination.

| Agent | Status | How to use |
|---|---|---|
| **Claude Code + Codex** | Fully tested | Default — just run `/collab` or `collab-launch.sh` |
| **Gemini CLI** | Experimental | Add explicitly (see below) |
| **Aider** | Untested | Add explicitly (see below) |
| **Any CLI tool** | Via `agents.json` | [Add a custom agent](https://michelhelsdingen.github.io/ensemble/configuration#adding-a-custom-agent) |

### Using a different team composition

Three ways to change which agents are on your team:

**1. Name them in your `/collab` prompt:**
```
/collab "Review the auth module with gemini and claude"
```

**2. Use the `--agents` flag with `collab-launch.sh`:**
```bash
# First agent = lead, rest = workers
./scripts/collab-launch.sh "$(pwd)" "Security audit" codex,claude,gemini
```

**3. Specify agents in the API call:**
```bash
curl -X POST http://localhost:23000/api/ensemble/teams \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-team",
    "description": "Security audit",
    "agents": [
      { "program": "codex", "role": "lead" },
      { "program": "claude", "role": "worker" },
      { "program": "gemini", "role": "worker" }
    ],
    "workingDirectory": "'$(pwd)'"
  }'
```

> **Note on Gemini:** Gemini CLI can join teams and send messages, but is experimental. It may stop responding due to free-tier rate limits or internal agent delegation issues in Gemini's TUI. For best results, configure a paid API key via `gemini /auth`.

## How It Works

1. **Create a team** — Define agents and their task via API or CLI
2. **Agents spawn** — Each agent is started by the ensemble bridge with the task prompt
3. **Communication** — Agents use `team-say`/`team-read` scripts to exchange messages
4. **Monitor** — Watch the collaboration unfold in real-time via the TUI monitor (iTerm split pane on macOS, tmux elsewhere)
5. **Auto-disband** — When agents signal completion, results are summarized and persisted

### Monitor selection

`collab-launch` picks the best viewer automatically:

| Situation | Monitor |
|---|---|
| Already inside tmux | tmux split pane (right) |
| macOS + iTerm2, no tmux | **native iTerm2 split pane** (default) |
| Linux, or no iTerm2 | detached tmux session (`tmux attach -t ensemble-<id>`) |

Override with env vars:

- `COLLAB_MONITOR=tmux\|iterm\|none` — force a specific mode (or disable the monitor)
- `COLLAB_ITERM_MODE=split\|tab\|window` — iTerm layout (default `split`)

On macOS, iTerm2 is the default — you never need `tmux attach` for the monitor.

## Configuration

Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable | Default | Description |
|---|---|---|
| `ENSEMBLE_PORT` | `23000` | Server port |
| `ENSEMBLE_URL` | `http://localhost:23000` | CLI target URL |
| `ENSEMBLE_DATA_DIR` | `~/.ensemble` | Data directory |
| `ENSEMBLE_CORS_ORIGIN` | localhost only | Allowed CORS origins |

See [full configuration docs](https://michelhelsdingen.github.io/ensemble/configuration) for all options including Telegram notifications, multi-host setup, and agent customization.

## Documentation

- [Getting Started](https://michelhelsdingen.github.io/ensemble/getting-started) — Prerequisites, install, first team
- [Configuration](https://michelhelsdingen.github.io/ensemble/configuration) — Environment variables, agents, hosts
- [API Reference](https://michelhelsdingen.github.io/ensemble/api) — All HTTP endpoints
- [CLI Reference](https://michelhelsdingen.github.io/ensemble/cli) — Commands and monitor keybindings
- [Collab Scripts](https://michelhelsdingen.github.io/ensemble/collab-scripts) — Shell scripts for automation
- [Architecture](https://michelhelsdingen.github.io/ensemble/architecture) — How it all fits together

## License

[MIT](LICENSE)
