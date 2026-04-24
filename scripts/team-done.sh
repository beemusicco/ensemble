#!/usr/bin/env bash
# team-done — Deterministic completion signal from an agent.
# Usage:
#   team-done <team-id> <agent-name> [optional note]
# Effect:
#   - Appends a [SIGNAL_COMPLETE] message to the team log.
#   - Immediately disbands the team (no pattern matching, no idle tax).
#   - This is the ONLY reliable way for an agent to close a team cleanly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header)"

TEAM_ID="${1:?Usage: team-done <team-id> <agent-name> [note]}"
FROM="${2:?agent-name required}"
NOTE="${3:-}"
API="${ENSEMBLE_URL:-http://localhost:23000}"

PAYLOAD=$(FROM="$FROM" NOTE="$NOTE" python3 -c '
import json, os
body = {"from": os.environ["FROM"]}
note = os.environ.get("NOTE", "").strip()
if note: body["note"] = note
print(json.dumps(body))
')

RESPONSE=$(curl -sf -X POST "$API/api/ensemble/teams/$TEAM_ID/signal-complete" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HDR" \
  -d "$PAYLOAD" 2>&1) || { echo "[team-done] signal failed: $RESPONSE" >&2; exit 1; }
echo "[team-done] team $TEAM_ID closed by $FROM"
