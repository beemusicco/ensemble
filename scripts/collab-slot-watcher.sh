#!/usr/bin/env bash
# collab-slot-watcher — watches messages.jsonl for the LEAD's [SLOT_TABLE_v1]
# announcement and writes the parsed result to /tmp/ensemble/<team>/slot-table.json
# so the PreToolUse hook can enforce file-glob ownership per agent.
#
# Protocol:
#   The LEAD agent posts a message containing:
#     [SLOT_TABLE_v1]
#     agent-1: glob1, glob2, ...
#     agent-2: glob3, glob4, ...
#     ...
#     [END_SLOT_TABLE]
#
# Validation:
#   - At least 2 agents listed
#   - No overlapping globs (literal-prefix overlap check)
#   - All agents in this team are covered
#
# On valid SLOT_TABLE: writes slot-table.json + posts [SLOT_TABLE_ACCEPTED]
# On invalid:           keeps watching + posts [SLOT_TABLE_INVALID:<reason>]
# On team finish:       exits cleanly
#
# Usage:
#   ./collab-slot-watcher.sh <team-id>
set -uo pipefail

TEAM_ID="${1:?Usage: collab-slot-watcher.sh <team-id>}"
RUNTIME_DIR="/tmp/ensemble/$TEAM_ID"
MESSAGES="$RUNTIME_DIR/messages.jsonl"
SLOT_TABLE="$RUNTIME_DIR/slot-table.json"
FINISHED="$RUNTIME_DIR/.finished"
WATCHER_PID_FILE="$RUNTIME_DIR/slot-watcher.pid"
LOG="$RUNTIME_DIR/slot-watcher.log"

# Bypass: skip the whole watcher if operator sets ENSEMBLE_SLOT_BYPASS=1
if [ "${ENSEMBLE_SLOT_BYPASS:-0}" = "1" ]; then
  echo "[slot-watcher] BYPASS via ENSEMBLE_SLOT_BYPASS=1 — exiting" >> "$LOG"
  exit 0
fi

# Single-instance guard
if [ -f "$WATCHER_PID_FILE" ]; then
  EXISTING=$(tr -d ' ' < "$WATCHER_PID_FILE" 2>/dev/null || true)
  if [ -n "$EXISTING" ] && kill -0 "$EXISTING" 2>/dev/null; then
    echo "[slot-watcher] already running ($EXISTING)" >> "$LOG"
    exit 0
  fi
fi
echo $$ > "$WATCHER_PID_FILE"
trap 'rm -f "$WATCHER_PID_FILE"' EXIT

mkdir -p "$RUNTIME_DIR"
touch "$MESSAGES"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) $*" >> "$LOG"; }

log "=== slot-watcher start for $TEAM_ID ==="

POSTED_INDEX=0

# Auth for posting validation feedback as system messages
TOKEN=$(cat "$HOME/.ensemble/auth-token" 2>/dev/null || echo "")
API="${ENSEMBLE_API:-http://127.0.0.1:23000}"

post_system_msg() {
  local content="$1"
  [ -z "$TOKEN" ] && return 0
  # Use the team's messaging endpoint to inject a system message visible to all agents
  curl -sf -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -X POST "$API/api/ensemble/teams/$TEAM_ID/messages" \
    -d "{\"from\":\"slot-watcher\",\"to\":\"team\",\"content\":$(python3 -c "import sys,json; print(json.dumps(sys.argv[1]))" "$content"),\"type\":\"system\"}" \
    > /dev/null 2>&1 || true
}

while true; do
  [ -f "$FINISHED" ] && { log "finished marker — exit"; exit 0; }

  # Skip if slot-table already accepted (latched once)
  if [ -f "$SLOT_TABLE" ]; then
    log "slot-table already written — exit watcher"
    exit 0
  fi

  TOTAL=$(wc -l < "$MESSAGES" 2>/dev/null | tr -d ' ')
  TOTAL=${TOTAL:-0}

  if [ "$TOTAL" -gt "$POSTED_INDEX" ] 2>/dev/null; then
    # Process new lines through companion parser script
    tail -n "+$((POSTED_INDEX + 1))" "$MESSAGES" 2>/dev/null | \
      python3 "$(dirname "$0")/collab-slot-parser.py" "$TEAM_ID" "$SLOT_TABLE" "$RUNTIME_DIR" 2>>"$LOG" || true
    POSTED_INDEX=$TOTAL

    # Post acceptance/rejection back to team
    if [ -f "$SLOT_TABLE" ] && [ ! -f "$RUNTIME_DIR/.slot-table-announced" ]; then
      log "SLOT_TABLE_v1 accepted, persisted to $SLOT_TABLE"
      post_system_msg "[SLOT_TABLE_ACCEPTED] $(python3 -c "import json; d=json.load(open('$SLOT_TABLE')); print(f\"{len(d['slots'])} agents: \" + ', '.join(d['slots'].keys()))")"
      touch "$RUNTIME_DIR/.slot-table-announced"
    fi
    if [ -f "$RUNTIME_DIR/.slot-table-error" ] && [ ! -f "$RUNTIME_DIR/.slot-table-error-announced" ]; then
      ERR=$(head -c 200 "$RUNTIME_DIR/.slot-table-error")
      log "SLOT_TABLE_v1 invalid: $ERR"
      post_system_msg "[SLOT_TABLE_INVALID] ${ERR} — lead must repost a corrected SLOT_TABLE_v1 block"
      touch "$RUNTIME_DIR/.slot-table-error-announced"
      rm -f "$RUNTIME_DIR/.slot-table-error"
      # Allow re-parse of subsequent SLOT_TABLE attempts
      rm -f "$RUNTIME_DIR/.slot-table-error-announced"
    fi
  fi

  sleep 3
done
