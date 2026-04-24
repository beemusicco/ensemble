#!/usr/bin/env bash
# team-read — Read messages from your team feed
# Usage: team-read <team-id>
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header || true)"
URL="${ENSEMBLE_URL:-http://localhost:23000}"
curl -sf -H "$AUTH_HDR" "$URL/api/ensemble/teams/$1/feed" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('messages',[]):
  print(f'{m[\"from\"]} -> {m[\"to\"]}: {m[\"content\"]}')
" 2>/dev/null
