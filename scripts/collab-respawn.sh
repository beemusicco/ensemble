#!/usr/bin/env bash
# collab-respawn.sh — re-spawn one or all failed agents in a team.
#
# Usage:
#   collab-respawn.sh <team-id> [agent-name]
#   collab-respawn.sh <team-id>            # respawns ALL failed agents in the team
#   collab-respawn.sh <team-id> codex-2    # respawns just that one agent
#
# Behaviour:
#   - GET team to find failed agents
#   - For each: POST /api/ensemble/teams/:id/agents/:name/respawn
#   - Telemetry written to ~/.openclaw/logs/blocker-veto.jsonl
#
# Exit codes:
#   0 — at least one respawn succeeded (or no failed agents)
#   1 — all respawn attempts failed
#   2 — usage error or team not found
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <team-id> [agent-name]" >&2
  exit 2
fi

TEAM_ID="$1"
AGENT_FILTER="${2:-}"
API="${ENSEMBLE_API:-http://127.0.0.1:23000}"
TOKEN=$(cat "$HOME/.ensemble/auth-token" 2>/dev/null || true)
AUTH_HDR=()
[ -n "$TOKEN" ] && AUTH_HDR=(-H "Authorization: Bearer $TOKEN")

# UUID validation
if ! [[ "$TEAM_ID" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]]; then
  echo "Error: '$TEAM_ID' is not a valid UUID" >&2
  exit 2
fi

# Fetch team
TEAM_JSON=$(curl -sf "${AUTH_HDR[@]}" "$API/api/ensemble/teams/$TEAM_ID" 2>&1) || {
  echo "Error: team $TEAM_ID not found or API unreachable" >&2
  exit 2
}

# Find failed agents (filtered by AGENT_FILTER if provided)
FAILED_AGENTS=$(echo "$TEAM_JSON" | python3 -c "
import sys, json
d = json.load(sys.stdin)
team = d.get('team', d)
agents = team.get('agents', [])
filt = '${AGENT_FILTER}'
for a in agents:
    if a.get('status') != 'failed':
        continue
    if filt and a.get('name') != filt:
        continue
    print(a.get('name', ''))
")

if [ -z "$FAILED_AGENTS" ]; then
  if [ -n "$AGENT_FILTER" ]; then
    echo "No failed agent named '$AGENT_FILTER' in team $TEAM_ID"
  else
    echo "No failed agents in team $TEAM_ID — nothing to do"
  fi
  exit 0
fi

echo "Respawning failed agents in $TEAM_ID:"
SUCCESS=0
FAIL=0
while IFS= read -r AGENT; do
  [ -z "$AGENT" ] && continue
  echo -n "  → $AGENT ... "
  RESULT=$(curl -s -X POST "${AUTH_HDR[@]}" \
    -H 'Content-Type: application/json' \
    -d '{"reason":"manual"}' \
    "$API/api/ensemble/teams/$TEAM_ID/agents/$AGENT/respawn" 2>&1) || true
  OK=$(echo "$RESULT" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('YES' if d.get('success') else 'NO')
    print(d.get('error') or d.get('reason') or '')
except Exception as e:
    print('NO')
    print(f'parse error: {e}')
")
  STATUS=$(echo "$OK" | head -1)
  DETAIL=$(echo "$OK" | tail -1)
  if [ "$STATUS" = "YES" ]; then
    echo "✓ respawned"
    SUCCESS=$((SUCCESS+1))
  else
    echo "✗ $DETAIL"
    FAIL=$((FAIL+1))
  fi
done <<< "$FAILED_AGENTS"

echo ""
echo "  $SUCCESS succeeded, $FAIL failed"
[ $SUCCESS -gt 0 ] && exit 0 || exit 1
