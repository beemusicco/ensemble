#!/usr/bin/env bash
# collab-health.sh — machine-readable health of a single collab team.
# Usage: collab-health.sh <team-id>
# Output: one-line JSON with state, process counts, message count, expert injection check.
#
# Designed for integration tests and external monitors (exit 0 = healthy, 1 = degraded, 2 = dead).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

TEAM_ID="${1:?Usage: collab-health.sh <team-id>}"
RD="$(collab_runtime_dir "$TEAM_ID")"

if [ ! -d "$RD" ]; then
  printf '{"team_id":"%s","state":"missing","healthy":false}\n' "$TEAM_ID"
  exit 2
fi

# Read state marker (fallback to inferred state)
STATE="unknown"
[ -f "$RD/.state" ] && STATE=$(cat "$RD/.state")
[ -f "$RD/.finished" ] && STATE="finished"

# Message count
MSG_COUNT=0
[ -f "$RD/messages.jsonl" ] && MSG_COUNT=$(wc -l < "$RD/messages.jsonl" | tr -d ' ')

# Process counts
BRIDGE_ALIVE=0
POLLER_ALIVE=0
PGID_ALIVE=0
[ -f "$RD/bridge.pid" ] && kill -0 "$(cat "$RD/bridge.pid")" 2>/dev/null && BRIDGE_ALIVE=1
[ -f "$RD/poller.pid" ] && kill -0 "$(cat "$RD/poller.pid")" 2>/dev/null && POLLER_ALIVE=1
if [ -f "$RD/.pgid" ]; then
  PGID=$(cat "$RD/.pgid" 2>/dev/null | tr -d ' \n')
  if [ -n "$PGID" ] && pgrep -g "$PGID" >/dev/null 2>&1; then
    PGID_ALIVE=1
  fi
fi

# Recent message rate (heuristic — count of last 20 lines as proxy for activity)
MSG_RATE_RECENT=0
if [ -f "$RD/messages.jsonl" ] && [ "$MSG_COUNT" -gt 0 ]; then
  MSG_RATE_RECENT=$(tail -20 "$RD/messages.jsonl" 2>/dev/null | wc -l | tr -d ' ')
fi

# Tmux sessions for agents
TMUX_SESSIONS=0
TMUX_SESSIONS=$(tmux ls 2>/dev/null | grep -c "^collab-.*-${TEAM_ID:0:8}\|^${TEAM_ID}\|-${TEAM_ID}-" || true)

# Expert injection check — scan prompts/ for EXPERT MENTAL MODEL marker
EXPERTS_INJECTED=0
if [ -d "$RD/prompts" ]; then
  EXPERTS_INJECTED=$(grep -l "EXPERT MENTAL MODEL" "$RD/prompts"/*.txt 2>/dev/null | wc -l | tr -d ' ')
fi

# Healthy if: active state with live bridge+poller, OR finished state
HEALTHY=false
if [ "$STATE" = "active" ] && [ "$BRIDGE_ALIVE" = "1" ] && [ "$POLLER_ALIVE" = "1" ]; then
  HEALTHY=true
elif [ "$STATE" = "finished" ]; then
  HEALTHY=true
fi

# Last message age (seconds since last message)
LAST_AGE=-1
if [ -f "$RD/messages.jsonl" ] && [ "$MSG_COUNT" -gt 0 ]; then
  if stat -f '%m' "$RD/messages.jsonl" >/dev/null 2>&1; then
    MTIME=$(stat -f '%m' "$RD/messages.jsonl")
  else
    MTIME=$(stat -c '%Y' "$RD/messages.jsonl")
  fi
  NOW=$(date +%s)
  LAST_AGE=$((NOW - MTIME))
fi

printf '{"team_id":"%s","state":"%s","healthy":%s,"messages":%s,"last_message_age_sec":%s,"bridge_alive":%s,"poller_alive":%s,"pgid_alive":%s,"tmux_sessions":%s,"experts_injected":%s,"msg_rate_recent":%s}\n' \
  "$TEAM_ID" "$STATE" "$HEALTHY" "$MSG_COUNT" "$LAST_AGE" "$BRIDGE_ALIVE" "$POLLER_ALIVE" "$PGID_ALIVE" "$TMUX_SESSIONS" "$EXPERTS_INJECTED" "$MSG_RATE_RECENT"

# Exit codes for scripting
[ "$HEALTHY" = "true" ] && exit 0
[ "$STATE" = "unknown" ] || [ "$STATE" = "missing" ] && exit 2
exit 1
