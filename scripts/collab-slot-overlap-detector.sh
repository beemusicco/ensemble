#!/usr/bin/env bash
# collab-slot-overlap-detector — every 30s scan active worktrees for
# cross-agent file overlap in recent commits, post [SLOT_VIOLATION] message
# back to the team when detected. Backstop for T3 hook (which doesn't run
# for codex agents) and for tools that bypass Edit/Write (e.g. Bash sed -i).
#
# Production driver 2026-05-13: in collab 0b945ff9 three agents committed
# overlapping scaffolds (c9f5253 + 0898af5 + fb0e5cc) — slot-table was not
# yet a concept. Now with SLOT_TABLE_v1, this watcher posts violations
# referencing the LEAD's published table.
#
# Skips silently if slot-table.json doesn't exist (no enforcement contract).
#
# Usage:
#   ./collab-slot-overlap-detector.sh <team-id>
set -uo pipefail

TEAM_ID="${1:?Usage: collab-slot-overlap-detector.sh <team-id>}"
RUNTIME_DIR="/tmp/ensemble/$TEAM_ID"
SLOT_TABLE="$RUNTIME_DIR/slot-table.json"
FINISHED="$RUNTIME_DIR/.finished"
PID_FILE="$RUNTIME_DIR/slot-overlap.pid"
LOG="$RUNTIME_DIR/slot-overlap.log"
ANNOUNCED_FILE="$RUNTIME_DIR/slot-overlap-announced.txt"

# Bypass
[ "${ENSEMBLE_SLOT_BYPASS:-0}" = "1" ] && exit 0

# Must have runtime dir (collab-launch.sh creates it before spawning us)
[ ! -d "$RUNTIME_DIR" ] && exit 0

# Single-instance
if [ -f "$PID_FILE" ]; then
  EXISTING=$(tr -d ' ' < "$PID_FILE" 2>/dev/null || true)
  if [ -n "$EXISTING" ] && kill -0 "$EXISTING" 2>/dev/null; then
    exit 0
  fi
fi
echo $$ > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT
touch "$ANNOUNCED_FILE"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) $*" >> "$LOG"; }
log "=== slot-overlap-detector start for $TEAM_ID ==="

API="${ENSEMBLE_API:-http://127.0.0.1:23000}"
TOKEN=$(cat "$HOME/.ensemble/auth-token" 2>/dev/null || echo "")

post_violation() {
  local content="$1"
  [ -z "$TOKEN" ] && return 0
  curl -sf -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -X POST "$API/api/ensemble/teams/$TEAM_ID/messages" \
    -d "{\"from\":\"slot-overlap-detector\",\"to\":\"team\",\"content\":$(python3 -c "import sys,json; print(json.dumps(sys.argv[1]))" "$content"),\"type\":\"system\"}" \
    > /dev/null 2>&1 || true
}

# Discover the repo dir for this team (read from team registry HTTP)
REPO_DIR=""
for _ in $(seq 1 6); do
  REPO_DIR=$(curl -sf -H "Authorization: Bearer $TOKEN" "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('team',{}).get('workingDirectory',''))" 2>/dev/null || echo "")
  [ -n "$REPO_DIR" ] && break
  sleep 2
done
if [ -z "$REPO_DIR" ] || [ ! -d "$REPO_DIR" ]; then
  log "could not resolve repo dir for team — exiting"
  exit 1
fi
log "repo: $REPO_DIR"

WORKTREES_DIR="$REPO_DIR/.worktrees"

while true; do
  [ -f "$FINISHED" ] && { log "finished — exit"; exit 0; }
  [ ! -d "$WORKTREES_DIR" ] && { sleep 30; continue; }

  # Gather: agent_name → list of files committed in last 5 min
  # Iterate worktrees matching this team-id prefix
  TMP_AGENTS_FILES=$(mktemp)
  trap 'rm -f "$TMP_AGENTS_FILES"' RETURN

  for wt in "$WORKTREES_DIR/${TEAM_ID}"-*; do
    [ -d "$wt" ] || continue
    # Extract agent name: <team>-<agent-name>-<idx>  →  agent-name-idx
    agent=$(basename "$wt" | sed "s/^${TEAM_ID}-//")
    # Get files changed in commits in last 5 minutes
    files=$(git -C "$wt" log --since='5 minutes ago' --name-only --pretty=format: 2>/dev/null \
      | grep -v '^$' | sort -u || true)
    if [ -n "$files" ]; then
      while IFS= read -r f; do
        echo "$agent|$f" >> "$TMP_AGENTS_FILES"
      done <<< "$files"
    fi
  done

  # Detect overlap: same file appearing under 2+ agents
  OVERLAPS=$(awk -F'|' '{print $2 "\t" $1}' "$TMP_AGENTS_FILES" 2>/dev/null \
    | sort -u | awk -F'\t' '{print $1}' | sort | uniq -c | awk '$1>1 {print $2}')

  if [ -n "$OVERLAPS" ]; then
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      # Get the agent list for this file
      AGENTS=$(awk -F'|' -v file="$f" '$2==file {print $1}' "$TMP_AGENTS_FILES" | sort -u | tr '\n' ',' | sed 's/,$//')
      KEY="$f|$AGENTS"
      if ! grep -qF "$KEY" "$ANNOUNCED_FILE" 2>/dev/null; then
        log "OVERLAP: $f touched by $AGENTS"
        post_violation "[SLOT_VIOLATION] file '$f' committed by multiple agents: $AGENTS — REVIEW required. If [SLOT_TABLE_v1] was published, this means an agent edited outside its slot or LEAD's table needs amendment."
        echo "$KEY" >> "$ANNOUNCED_FILE"
      fi
    done <<< "$OVERLAPS"
  fi

  rm -f "$TMP_AGENTS_FILES"
  trap - RETURN
  sleep 30
done
