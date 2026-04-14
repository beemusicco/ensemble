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

failures=()
backoff=1

while true; do
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
  sleep "$backoff"

  backoff=$((backoff * 2))
  if [ "$backoff" -gt "$MAX_BACKOFF" ]; then
    backoff=$MAX_BACKOFF
  fi
done
