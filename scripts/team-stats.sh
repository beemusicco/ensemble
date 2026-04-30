#!/usr/bin/env bash
# team-stats — print the calibration scoreboard.
# Usage:
#   team-stats                       # all-time, default 500 teams
#   team-stats --window=7            # last 7 days only
#   team-stats --json                # raw JSON for piping
set -euo pipefail

WINDOW=""
MAX_TEAMS=""
FORMAT="text"

for arg in "$@"; do
  case "$arg" in
    --window=*)    WINDOW="$arg" ;;
    --max-teams=*) MAX_TEAMS="$arg" ;;
    --json)        FORMAT="json" ;;
    -h|--help)
      sed -n '2,7p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header)"
API="${ENSEMBLE_URL:-http://localhost:23000}"

QS=""
if [ -n "$WINDOW" ]; then
  QS="${QS}&windowDays=${WINDOW#--window=}"
fi
if [ -n "$MAX_TEAMS" ]; then
  QS="${QS}&maxTeams=${MAX_TEAMS#--max-teams=}"
fi
if [ "$FORMAT" = "text" ]; then
  QS="${QS}&format=text"
fi
QS="${QS#&}"

URL="$API/api/ensemble/calibration"
[ -n "$QS" ] && URL="$URL?$QS"

if [ "$FORMAT" = "text" ]; then
  curl -sf -H "$AUTH_HDR" "$URL"
  echo
else
  curl -sf -H "$AUTH_HDR" "$URL"
fi
