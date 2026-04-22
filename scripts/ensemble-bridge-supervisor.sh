#!/usr/bin/env bash
# Bridge supervisor — restarts ensemble-bridge.sh with exponential backoff.
# Usage: ensemble-bridge-supervisor.sh <team-id> [api-url]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$SCRIPT_DIR/ensemble-bridge.sh"

TEAM_ID="${1:?Usage: ensemble-bridge-supervisor.sh <team-id> [api-url]}"
API="${2:-http://localhost:23000}"

MAX_FAILURES=5
FAILURE_WINDOW=60
MAX_BACKOFF=30

# Watch for finish marker — stop retrying against a completed collab.
# Pre-fix forensics found 7 stale supervisors looping for 4 days.
FINISHED_MARKER="/tmp/ensemble/$TEAM_ID/.finished"

failures=()
backoff=1

while true; do
  if [ -f "$FINISHED_MARKER" ]; then
    echo "[bridge-supervisor] .finished detected — exiting cleanly" >&2
    exit 0
  fi

  "$BRIDGE" "$TEAM_ID" "$API"
  exit_code=$?

  if [ "$exit_code" -eq 0 ]; then
    break
  fi

  now=$(date +%s)
  failures+=("$now")

  cutoff=$((now - FAILURE_WINDOW))
  recent=()
  for ts in "${failures[@]}"; do
    if [ "$ts" -ge "$cutoff" ]; then
      recent+=("$ts")
    fi
  done
  failures=("${recent[@]}")

  if [ "${#failures[@]}" -ge "$MAX_FAILURES" ]; then
    echo "[bridge-supervisor] Bridge died ${#failures[@]} times in ${FAILURE_WINDOW}s — giving up" >&2
    exit 1
  fi

  echo "[bridge-supervisor] Bridge exited ($exit_code), restarting in ${backoff}s (${#failures[@]}/$MAX_FAILURES recent failures)" >&2

  # Split the sleep into 1s ticks so .finished written during backoff triggers
  # exit within ~1s instead of waiting the full cycle (up to 30s).
  slept=0
  while [ "$slept" -lt "$backoff" ]; do
    if [ -f "$FINISHED_MARKER" ]; then
      echo "[bridge-supervisor] .finished during backoff — exiting cleanly" >&2
      exit 0
    fi
    sleep 1
    slept=$((slept + 1))
  done

  backoff=$((backoff * 2))
  if [ "$backoff" -gt "$MAX_BACKOFF" ]; then
    backoff=$MAX_BACKOFF
  fi
done
