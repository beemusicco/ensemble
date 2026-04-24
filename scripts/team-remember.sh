#!/usr/bin/env bash
# team-remember — Write a memory the team (or future teams) can recall.
# Usage:
#   team-remember <scope> <key> <value> [--tags=a,b] [--team=ID] [--agent=NAME] [--ttl=SECONDS]
#   scope ∈ session|team|global
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header)"
API="${ENSEMBLE_URL:-http://localhost:23000}"

SCOPE="${1:?Usage: team-remember <scope> <key> <value> [--tags=a,b] [--team=ID] [--agent=NAME] [--ttl=SEC]}"
KEY="${2:?key required}"
VALUE="${3:?value required}"
shift 3

export ENSEMBLE_MEM_SCOPE="$SCOPE"
export ENSEMBLE_MEM_KEY="$KEY"
export ENSEMBLE_MEM_VALUE="$VALUE"
export ENSEMBLE_MEM_TAGS=""
export ENSEMBLE_MEM_TEAM=""
export ENSEMBLE_MEM_AGENT=""
export ENSEMBLE_MEM_TTL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --tags=*)  ENSEMBLE_MEM_TAGS="${1#--tags=}" ;;
    --team=*)  ENSEMBLE_MEM_TEAM="${1#--team=}" ;;
    --agent=*) ENSEMBLE_MEM_AGENT="${1#--agent=}" ;;
    --ttl=*)   ENSEMBLE_MEM_TTL="${1#--ttl=}" ;;
    *) echo "Unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

PAYLOAD=$(python3 <<'PY'
import json, os
body = {
  'scope': os.environ['ENSEMBLE_MEM_SCOPE'],
  'key':   os.environ['ENSEMBLE_MEM_KEY'],
  'value': os.environ['ENSEMBLE_MEM_VALUE'],
}
tags = os.environ.get('ENSEMBLE_MEM_TAGS', '').strip()
if tags:
  body['tags'] = [t.strip() for t in tags.split(',') if t.strip()]
team = os.environ.get('ENSEMBLE_MEM_TEAM', '').strip()
if team: body['teamId'] = team
agent = os.environ.get('ENSEMBLE_MEM_AGENT', '').strip()
if agent: body['agent'] = agent
ttl = os.environ.get('ENSEMBLE_MEM_TTL', '').strip()
if ttl.isdigit(): body['ttlSeconds'] = int(ttl)
print(json.dumps(body))
PY
)

RESPONSE=$(curl -sf -X POST "$API/api/ensemble/memory" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HDR" \
  -d "$PAYLOAD")
ENSEMBLE_MEM_RESPONSE="$RESPONSE" python3 -c 'import json, os; d=json.loads(os.environ["ENSEMBLE_MEM_RESPONSE"]); m=d.get("memory",{}); print("[remember] {}:{} -> {}".format(m.get("scope","?"), m.get("key","?"), m.get("id","?")[:8]))'
