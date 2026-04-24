#!/usr/bin/env bash
# collab-terminate.sh — deterministic teardown of a single collab.
# Uses process-group signal when .pgid is present (1 syscall kills all helpers),
# falls back to individual PID kills when running on systems without setsid.
#
# Usage: collab-terminate.sh <team-id> [--disband]
#   --disband   also POST DELETE /api/ensemble/teams/{id} to the ensemble server
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"
# shellcheck source=./ensemble-auth.sh
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header || true)"

TEAM_ID="${1:?Usage: collab-terminate.sh <team-id> [--disband]}"
DISBAND=${2:-}
RD="$(collab_runtime_dir "$TEAM_ID")"
API="http://localhost:23000"

if [ ! -d "$RD" ]; then
  echo "[terminate] team dir missing: $RD" >&2
  exit 1
fi

# Phase 1: server-side disband if requested
if [ "$DISBAND" = "--disband" ]; then
  curl -sf -H "$AUTH_HDR" -X DELETE "$API/api/ensemble/teams/$TEAM_ID" >/dev/null 2>&1 || true
  echo "[terminate] server-side disband requested"
fi

# Phase 2: write state marker so any polling readers know we're finishing
if [ ! -f "$RD/.state" ] || [ "$(cat "$RD/.state" 2>/dev/null)" != "finished" ]; then
  STATE_TMP=$(mktemp "$RD/.state.XXXXXX")
  printf 'finishing\n' > "$STATE_TMP"
  mv -f "$STATE_TMP" "$RD/.state"
fi

# Phase 3: process-group kill if .pgid available (single atomic signal)
KILLED_VIA_PGID=0
if [ -f "$RD/.pgid" ]; then
  PGID=$(cat "$RD/.pgid" 2>/dev/null | tr -d ' \n')
  if [ -n "$PGID" ]; then
    # The negative PID form tells kill(2) to signal the entire process group
    kill -TERM -- -"$PGID" 2>/dev/null && KILLED_VIA_PGID=1
    # Short grace window, then SIGKILL any survivors
    sleep 1
    kill -KILL -- -"$PGID" 2>/dev/null || true
  fi
fi

# Phase 4: fallback/belt-and-suspenders individual PID kills
for pidfile in bridge.pid poller.pid supervisor.pid; do
  [ -f "$RD/$pidfile" ] || continue
  pid=$(cat "$RD/$pidfile" 2>/dev/null | tr -d ' \n')
  [ -z "$pid" ] && continue
  kill "$pid" 2>/dev/null || true
done

# Phase 5: kill any tmux sessions matching this team (monitor + agents)
tmux list-sessions -F '#{session_name}' 2>/dev/null | while read -r session; do
  if [ "$session" = "ensemble-$TEAM_ID" ] || echo "$session" | grep -q "$TEAM_ID"; then
    tmux kill-session -t "$session" 2>/dev/null || true
  fi
done

# Phase 6: write final state marker AND .finished marker.
# .finished is what skill-level background waits look for; writing it here
# ensures that a manual terminate (without --disband) still unblocks the
# caller instead of the skill wait hanging until its outer timeout.
FINAL_TMP=$(mktemp "$RD/.state.XXXXXX")
printf 'finished\n' > "$FINAL_TMP"
mv -f "$FINAL_TMP" "$RD/.state"

if [ ! -f "$RD/.finished" ]; then
  FIN_TMP=$(mktemp "$RD/.finished.XXXXXX")
  date -u +%Y-%m-%dT%H:%M:%SZ > "$FIN_TMP"
  mv -f "$FIN_TMP" "$RD/.finished"
fi

if [ "$KILLED_VIA_PGID" = "1" ]; then
  echo "[terminate] team $TEAM_ID: process group signalled"
else
  echo "[terminate] team $TEAM_ID: individual PID fallback"
fi
