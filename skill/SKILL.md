---
name: collab
description: Start a collaborative AI team (Codex + Claude) to work on a task together. Use when the user says "werk samen met Codex", "collab", "team onderzoek", "laat Codex en Claude samenwerken", or wants multiple AI agents to analyze, research, or solve something together autonomously.
allowed-tools: Bash, Read, Write, Agent, TaskOutput
metadata:
  author: michel
  version: 6.1.0
---

# Collab: Autonomous AI Team Collaboration

**Language rule:** ALWAYS respond in the same language the user used to invoke /collab. If the user writes in English, all your output (status updates, summaries, everything) must be in English. If Dutch, respond in Dutch. Never mix languages.

Launch a Codex + Claude team. Scripts live in `__ENSEMBLE_DIR__/scripts/`. Runtime files namespaced under `/tmp/ensemble/<TEAM_ID>/`.

## Path Convention
All collab artifacts live in `/tmp/ensemble/<TEAM_ID>/`:
- `messages.jsonl` — agent + ensemble message log
- `summary.txt` — written on disband by ensemble-service
- `bridge.pid`, `bridge.log` — bridge process
- `poller.pid`, `feed.txt` — background poller
- `prompts/`, `delivery/` — agent prompt/delivery files
- `.finished` — written by ensemble-service AFTER summary.txt
- `team-id` — team ID marker

## Workflow

### Step 0: Detect environment
```bash
if [ -n "$TMUX" ]; then
  echo "TMUX_YES"
elif [ "$(uname)" = "Darwin" ] && [ "${TERM_PROGRAM:-}" = "iTerm.app" ]; then
  echo "ITERM_NATIVE"
else
  echo "TMUX_NO"
fi
```

Three monitor modes:
- `TMUX_YES` — already inside tmux; `collab-launch` opens a split pane right
- `ITERM_NATIVE` — macOS iTerm2 without tmux; `collab-launch` uses `osascript` to open a native iTerm split pane (no `tmux attach` needed)
- `TMUX_NO` — fallback: detached tmux session the user must attach to

Force a specific mode with `COLLAB_MONITOR=tmux|iterm|none` or change iTerm layout with `COLLAB_ITERM_MODE=split|tab|window` (default `split`).

### Step 1: Launch the team
```bash
collab-launch "$(pwd)" "$TASK_DESCRIPTION"
```

Extract TEAM_ID:
```bash
TEAM_ID=$(cat /tmp/collab-team-id.txt)
```

### Step 2: Tell the user where the monitor is

- `TMUX_YES`: "Team is live in the right tmux pane."
- `ITERM_NATIVE`: "Team is live in the new iTerm pane on the right."
- `TMUX_NO`: "`tmux attach -t ensemble-$TEAM_ID` — live TUI monitor (steer, disband, scroll)"

### Step 3: Monitoring — the user MUST see the conversation

**CRITICAL RULE**: The user wants to SEE the team's conversation as it happens. Every poll result must be presented clearly and formatted as a readable conversation. Do NOT just dump raw output — format it as a proper dialogue.

#### If `TMUX_NO`: poll and PRESENT messages inline

Use `collab-poll.sh` — a single-shot poller that tracks state automatically and gives clean output.

**Poll command:**
```bash
collab-poll "<TEAM_ID>" --sleep <seconds>
```

Output format: `sender\tcontent` lines, ending with one of:
- `---STATUS:ACTIVE` — new messages were found
- `---STATUS:QUIET` — no new messages (agents in deep work)
- `---STATUS:DONE` — team finished, followed by summary.txt content
- `---STATUS:WAITING` — messages file not yet created

**Presentation rules — THIS IS THE KEY PART:**
After each poll, present the new messages to the user like this:

> **codex-1**: [message content]
>
> **claude-2**: [message content]

Use markdown bold for agent names. Show the FULL message content (up to 500 chars), not truncated summaries. Between polls, add a brief status line like "Team is working... next check in 15s."

**Polling cadence:**
- First poll: `--sleep 10`
- Normal: `--sleep 15` to `--sleep 20`
- If 3+ polls QUIET: `--sleep 30` (agents in deep work)
- On `---STATUS:DONE`: stop polling, present final summary

**When done**, present structured summary + clean up:
```bash
TEAM_ID="<id>" && RD="/tmp/ensemble/$TEAM_ID" && kill "$(cat "$RD/poller.pid" 2>/dev/null)" 2>/dev/null || true; kill "$(cat "$RD/bridge.pid" 2>/dev/null)" 2>/dev/null || true; tmux kill-session -t "ensemble-$TEAM_ID" 2>/dev/null || true
```

#### If `ITERM_NATIVE`: background summary watcher

Same as `TMUX_YES`: the monitor pane is visible to the user, so don't inline-poll. Wait for completion in the background (same snippet as below) and present the final summary when done. On cleanup, the iTerm pane lives on — the user closes it with `q` or Cmd+W. Do NOT try to `tmux kill-session` (no tmux session exists in this mode).

#### If `TMUX_YES`: background summary watcher

Monitor visible in right pane. Wait in background:
```bash
TEAM_ID="<id>" && RD="/tmp/ensemble/$TEAM_ID" && while [ ! -f "$RD/.finished" ] && [ ! -f "$RD/summary.txt" ]; do sleep 8; done && echo "COLLAB_COMPLETE" && cat "$RD/summary.txt" 2>/dev/null
```
Run with `run_in_background: true`, `timeout: 1800000`. The 30-min cap accommodates longer staged collabs (observed runtimes up to ~20 min incl. the post-work idle tail). The server-side watchdog + idle-check will still disband well before this; the timeout exists only to prevent truly stuck waits from hanging forever.

When done: summarize + cleanup poller/bridge PIDs.

## Important Notes
- Agents run with auto-accept permissions (configured in agents.json: codex `--full-auto`, claude `--dangerously-skip-permissions`). They should NEVER ask for file write approval.
- Do not modify project code during a collab session unless the user explicitly asks
- Do not truncate or remove `messages.jsonl`
- Multiple collabs can run simultaneously — each has own `/tmp/ensemble/<TEAM_ID>/` namespace
- `team-say.sh` uses `fcntl.flock` for atomic JSONL writes
- `ensemble-bridge.sh` has single-instance guard, health check, exponential backoff
- `.finished` and `summary.txt` are written by ensemble-service, NOT by scripts
- Bridge auto-stops when it sees `.finished` marker

## Citation Evidence Rule (audit/review/verification collabs)

When a task asks agents to VERIFY, AUDIT, REVIEW, or CHECK code state, every
`file:line` citation in the final report MUST be a literal copy-paste of
`grep -n <pattern> <file>` or `sed -n 'Np'` output — never a paraphrase from
memory or reconstruction based on typical project layout.

Why: collabs that cite file paths like `app/validators.py` or `app/eventlog.py`
when the real paths are `app/pipeline/validators/__init__.py` and `app/events.py`
look convincing but silently hallucinate. High-level pass/fail can be correct
while every line number is fabricated — undermining the audit's trustworthiness
and making root-cause investigation harder when something later breaks.

Add these task clauses to audit/regression/verify prompts:

```
EVIDENCE FORMAT RULE:
- Every file:line citation MUST be a literal grep -n / sed -n output paste,
  wrapped in a ```bash fenced block showing the command + its output.
- If grep returns no match, report the item as UNVERIFIED with a note
  explaining the missing pattern. Never invent a plausible file path.
- Report section "Verification evidence" is mandatory; report section
  "Overall verdict" must reference the evidence by anchor (e.g. [E1], [E2]).
```

Haiku-3 (TEST-RUNNER) role is responsible for enforcing this — if claude-1 or
codex-2 produces a citation without grep-backed proof, haiku rejects it during
review phase with [REVIEW] citation_missing <path>.
