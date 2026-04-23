# Collab Architecture

**Audience:** engineer who needs to understand, debug, or extend the multi-agent collab system.
**Last updated:** 2026-04-22 (post-ck 13f37cd).

---

## 1. System in one paragraph

A **collab** is a named team of AI agents (Claude Opus, GPT-5, Haiku, Sonnet, Codex-mini, …) that work together on one task, communicating via an append-only JSONL message log. Each agent runs in its own tmux session as a real CLI (`claude`, `codex`, `gemini`, etc.) and has shell access. A Node.js **ensemble server** (`server.ts`) holds team state + HTTP API. A per-team **bridge** (`ensemble-bridge.sh`) subscribes to the server's SSE stream and writes incoming messages to the local `messages.jsonl` so agents can `tail` it. A **watchdog** (`lib/agent-watchdog.ts`) kills ack-loops and stalled agents. A **launcher** (`scripts/collab-launch.sh`) spawns everything, picks a template, and registers process-group IDs for deterministic teardown.

---

## 2. Component map

```
                ┌──────────────────────────────────────────────────────┐
                │  ensemble-service.ts        (in-memory team registry)│
                │  · createTeam / disband                              │
                │  · appendMessage / getMessages                       │
                │  · buildPromptPreview  ← injects EXPERT MENTAL MODEL │
                │  · watchdog loop (nudge, stall, ack-loop detection)  │
                └──────────────┬───────────────────────────────────────┘
                               │ HTTP + SSE on :23000
                ┌──────────────▼──────────────────────────────────────┐
                │  server.ts — thin REST layer + static file serve     │
                └──────────────┬──────────────────────────────────────┘
                               │
        ┌──────────────────────┼───────────────────────────────┐
        │                      │                               │
        ▼                      ▼                               ▼
 collab-launch.sh       ensemble-bridge-        tmux sessions (agent CLIs)
  · detect_template      supervisor.sh          · claude code
  · setsid helpers       · retry w/ backoff     · codex --full-auto
  · write .state         · exits on .finished   · gemini …
  · write .pgid          · process-group aware
  · poll msg file        · self-cleans on .finished
```

### 2.1 Runtime directory layout

Every team gets `/tmp/ensemble/<uuid>/`:

| File | Who writes | Purpose |
|---|---|---|
| `team-id` | launcher | UUID marker |
| `.state` | launcher, terminate | lifecycle: `creating` \| `active` \| `finishing` \| `finished` |
| `.pgid` | launcher (via `setsid`) | process-group id for one-signal teardown |
| `.finished` | ensemble-service | set on disband; bridge+poller self-exit when present |
| `messages.jsonl` | bridge (from SSE) | **source of truth** — all agent + ensemble messages |
| `feed.txt` | poller | tail-follow of messages.jsonl for live dashboards |
| `prompts/<agent>.txt` | agent-spawner | first prompt injected into each agent's tmux session |
| `delivery/<agent>.txt` | runtime (sendKeys/pasteFromFile) | buffered messages pending send into agent |
| `bridge.pid`, `poller.pid`, `supervisor.pid` | launcher | individual PID fallbacks |
| `bridge.log` | bridge + supervisor | stderr of bridge retries |
| `summary.txt` | ensemble-service | human-readable summary on disband |

---

## 3. Lifecycle

### 3.1 Happy path

```
user → /collab <task>
  │
  ▼
collab-launch.sh
  1. health-check server (start if down)
  2. background cleanup (stale >24h dirs + zombie procs)
  3. resume active team on same cwd if alive
  4. detect_template(<task>) → "implement" / "debug" / "deep-research" / …
  5. POST /api/ensemble/teams { description, agents, templateName }
     └─ server.createEnsembleTeam:
          · allocates uuid
          · calls buildPromptPreview per agent
              └─ loads collab-templates.json[templateName]
              └─ resolves expert slug (templateRole.expert OR autoSelectExpert)
              └─ reads ~/.openclaw/context-profiles/<slug>.md
              └─ prepends "EXPERT MENTAL MODEL:\n{content}\nApply this expert's lens…"
          · spawns each agent via agent-spawner (tmux session + prompt injection)
  6. write .state = "creating"
  7. write team-id + per-PID id file + global latest id file (atomic)
  8. setsid nohup bridge-supervisor.sh → registers .pgid
  9. tmux split-window for monitor
 10. background poller (self-exits on .finished)
 11. wait up to 12s for first message
 12. write .state = "active"
```

During collab:

```
agent-spawner → tmux sendKeys into agent CLI
agent runs: scripts/team-say.sh <tid> <from> <to> "msg"
  └─ appends to local messages.jsonl (for own tail) AND POSTs to server
     └─ server stores + broadcasts via SSE
        └─ bridge-supervisor → ensemble-bridge.sh receives SSE
           └─ writes line to messages.jsonl on every teammate's side
```

### 3.2 Teardown

Triggered by one of:

- Agent emits `[DONE]` → ensemble-service detects completion → writes `.finished`
- Watchdog detects ack-loop or stall → disbands
- User runs `scripts/collab-terminate.sh <tid>` → explicit kill
- User presses `d` in monitor TUI

Teardown order:

```
1. .state = "finishing"
2. kill -TERM -- -$PGID        ← one syscall, kills supervisor + bridge + grandchildren
3. 1s grace, then kill -KILL -- -$PGID
4. Fallback PID kills for bridge.pid / poller.pid / supervisor.pid
5. tmux kill-session for each matching session
6. .state = "finished"
7. ensemble-service writes summary.txt then .finished (if not already)
```

**Invariant:** after teardown, `ps -ef | grep <team-id>` returns 0 lines.

---

## 4. Template + expert injection (the part that was broken until 2026-04-22)

### 4.1 Templates (`collab-templates.json`)

Each template defines roles with an optional `expert` slug:

```json
{
  "templates": {
    "implement": {
      "roles": [
        { "role": "ARCHITECT", "expert": "vaughn-vernon", "focus": "…" },
        { "role": "DEVELOPER", "expert": "robert-c-martin", "focus": "…" }
      ]
    }
  }
}
```

### 4.2 Auto-detection (`collab-launch.sh::detect_template`)

Keyword patterns on task description — priority order:

| Priority | Keywords | Template |
|---|---|---|
| 1 | `ultrareview`, `4-agent review`, `security review` | `ultrareview` |
| 2 | `premium quad`, `critical`, `live trading`, `production deploy` | `premium-quad` |
| 3 | `adversarial`, `red team`, `stress test` | `adversarial` |
| 4 | `crypto strategy`, `trading strategy`, `backtest` | `crypto-strategy` |
| 5 | `deep research`, `research`, `investigate`, `audit` | `deep-research` |
| 6 | `debug`, `bug`, `fix`, `troubleshoot`, `popravi` | `debug` |
| 7 | `implement`, `build`, `develop`, `naredi`, `code` | `implement` |

Override: 5th positional arg OR `COLLAB_TEMPLATE=<name>` env var.

### 4.3 Server-side injection (`services/ensemble-service.ts::buildPromptPreview`)

```ts
if (template && agentIndex < template.roles.length) {
  const role = template.roles[agentIndex]
  const expertSlug = role.expert ?? autoSelectExpert(task, role.role, role.focus)
  const expertContext = expertSlug ? loadExpertProfile(expertSlug) : null
  // Prepends: "EXPERT MENTAL MODEL:\n{content}\nApply this expert's lens…"
}
```

### 4.4 Auto-select fallback (`autoSelectExpert`)

If a role lacks explicit `expert`, the function scores all experts by keyword overlap with (task + role name + focus) and returns the highest scorer ≥ 3 points. Source: `~/.openclaw/context-profiles/search-index.json`.

---

## 5. Watchdog (`lib/agent-watchdog.ts`)

Runs as an interval loop inside the server. Poll every `DEFAULT_POLL_INTERVAL_MS` (30 s); per team:

| Trigger | Env var / constant | Default | Action |
|---|---|---|---|
| Idle since agent's last message | `ENSEMBLE_WATCHDOG_NUDGE_MS` / `DEFAULT_NUDGE_MS` | 90 s | nudge agent with `[DONE]`/`[PROGRESS]` prompt |
| Still idle after nudge | `ENSEMBLE_WATCHDOG_STALL_MS` / `DEFAULT_STALL_MS` | 180 s after nudge | mark agent `stalledAt` |
| **All** active agents are stalled | — | — | **disband** with `all agents stalled` |
| Same pair of agents ping-ponging acks | `LOOP_WARN_THRESHOLD` | 6 | warn once |
| Same ack loop continuing | `LOOP_DISBAND_THRESHOLD` | 8 | disband |
| Triangular chatter | fixed `TRIANGULAR_WINDOW` | 9 msgs / 3+ senders / no progress | disband |
| `isSemanticIdle(recent, 3)` true | — | 3 identical OR 3 ack phrases in last 4 | disband |

Separate from the watchdog, the in-service **idle-checker** (`checkIdleTeams`, 15 s poll) closes teams on completion signals:

| Trigger | Threshold | Action |
|---|---|---|
| 2× HIGH-confidence `[DONE]`/`[COMPLETE]`/`[FINISHED]`/`[EXEC_DONE]`/`[VERIFY_DONE]` from different agents within 60 s | `COMPLETION_SIGNAL_WINDOW_MS` | disband immediately |
| 1× HIGH-confidence + idle > 120 s | `SINGLE_SIGNAL_IDLE_THRESHOLD_MS` | disband |
| 1× LOW-confidence (`done`, `complete`, `klaar`, `afgerond`, …) + idle > 300 s | `LOW_CONFIDENCE_IDLE_THRESHOLD_MS` | disband |

The idle-checker also uses `messages.jsonl` mtime as a bridge-zombie guard: if the on-disk file has grown past the registry's last-seen timestamp by more than 10 s, the file mtime is treated as the real last-activity signal (prevents false disband when the bridge has died while agents are still writing).

`isPoliteAckPhrase()` catches the standing-by / ready-to-help family of acknowledgement messages across English, Slovenian, and Dutch.

---

## 6. Safety rails

| Class | Mitigation |
|---|---|
| **Prompt injection in task** | `[DONE]` / `[PLAN]` tokens in user-supplied task are redacted to `(tag-redacted)` before being inlined into agent prompts |
| **Orphan processes** | `setsid` → `.pgid` → `kill -TERM -- -$PGID` + 24h/5min cleanup sweeps |
| **Cross-launch contamination** | per-PID `/tmp/collab-team-$PPID.txt` eliminates race on shared `/tmp/collab-team-id.txt` |
| **Truncated state reads** | `.state` writes go via `mktemp` + `mv -f` (POSIX-atomic on same fs) |
| **Bridge retry storm** | supervisor watches `.finished`; if dead server, gives up after 5 failures in 60s |
| **Polite-ack token waste** | `isPoliteAckPhrase` classifier + `isSemanticIdle` 2-signal disband |

---

## 7. Extending

**New template**: add entry to `collab-templates.json`. Auto-detection works if task-keywords match; otherwise user passes `COLLAB_TEMPLATE=<name>`.

**New agent CLI (new program)**: add entry to `agents.json` (command + flags + icon). Add spawn logic in `lib/agent-spawner.ts` if it needs special handling.

**New expert profile**: drop `.md` into `~/.openclaw/context-profiles/experts/`, run `sync-experts.py`, rebuild `search-index.json`. Auto-select picks it up; reference by slug in template.

**New host (for distributed collab)**: edit `~/.openclaw/hosts.json`. `lib/hosts-config.ts` looks up by `hostId`. Agents on remote hosts spawn via `spawnRemoteAgent`.

---

## 8. Files worth knowing

| Path | LoC | What |
|---|---|---|
| `server.ts` | ~300 | HTTP + SSE |
| `services/ensemble-service.ts` | ~900 | business logic (createTeam, disband, buildPromptPreview) |
| `lib/agent-watchdog.ts` | ~450 | nudge / stall / ack-loop detection |
| `lib/agent-spawner.ts` | ~250 | tmux + prompt injection + kill |
| `scripts/collab-launch.sh` | ~275 | this is the thing users actually run |
| `scripts/collab-terminate.sh` | ~75 | deterministic teardown (use this in tests) |
| `scripts/collab-health.sh` | ~90 | JSON per-team status |
| `scripts/collab-cleanup.sh` | ~260 | daily sweep (stale dirs + zombie procs) |
| `scripts/ensemble-bridge-supervisor.sh` | ~65 | supervised retry of ensemble-bridge.sh |
| `collab-templates.json` | — | template definitions (25 experts across 10 templates) |
| `tests/watchdog_ack.test.ts` | — | vitest: polite-ack classifier |
| `tests/test_expert_injection.sh` | — | shell: 16-assertion integration |

---

## 9. See also

- `docs/RUNBOOK.md` — when something breaks, start here
- `docs/architecture.md` — older server/protocol write-up
- `docs/collab-scripts.md` — user-facing script reference
