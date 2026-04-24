#!/usr/bin/env bash
# team-history — Look up what past collab teams worked on / said.
#
# Usage:
#   team-history search <query>          # find past teams by keyword (description + messages)
#   team-history feed <team-id>          # print full message log of a past team
#   team-history recent [N]              # N most recent teams (default 10)
#
# Use this when: starting a task similar to something a prior team tackled,
# debugging an issue someone else investigated, or recalling a decision.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header)"
API="${ENSEMBLE_URL:-http://localhost:23000}"

SUB="${1:-help}"
shift || true

case "$SUB" in
  search)
    Q="${1:?Usage: team-history search <query> [limit]}"
    LIMIT="${2:-20}"
    URL="$API/api/ensemble/history?q=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$Q")&limit=$LIMIT"
    RESPONSE=$(curl -sf -H "$AUTH_HDR" "$URL")
    ENSEMBLE_HIST_RESPONSE="$RESPONSE" ENSEMBLE_HIST_Q="$Q" python3 -c '
import json, os, sys
d = json.loads(os.environ["ENSEMBLE_HIST_RESPONSE"])
q = os.environ["ENSEMBLE_HIST_Q"]
matches = d.get("matches", [])
if not matches:
  print("(no past teams match: {!r})".format(q))
  sys.exit(0)
print("=== {} past team(s) matching {!r} ===".format(len(matches), q))
for m in matches:
  when = m.get("completedAt") or m.get("createdAt") or "?"
  agents = ",".join(m.get("agents", []))
  print("\n[{}] {} - {} - {}".format(m["teamId"][:8], m["status"], when, agents))
  desc = (m.get("description","") or "").strip()
  if desc:
    print("  task: {}".format(desc[:200]))
  for hit in m.get("matches", []):
    who = hit.get("from","?")
    sn = hit.get("snippet","")
    print("  {}: {}".format(who, sn))
    '
    ;;

  feed)
    TID_INPUT="${1:?Usage: team-history feed <team-id-or-prefix>}"
    # Resolve prefix -> full UUID so the 8-char ids from search/recent just work.
    if [ ${#TID_INPUT} -lt 36 ]; then
      TID=$(curl -sf -H "$AUTH_HDR" "$API/api/ensemble/teams" \
        | ENSEMBLE_HIST_PREFIX="$TID_INPUT" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
pre = os.environ["ENSEMBLE_HIST_PREFIX"]
matches = [t["id"] for t in d.get("teams", []) if t["id"].startswith(pre)]
if len(matches) == 1:
  print(matches[0])
elif not matches:
  sys.stderr.write("no team matches prefix {}\n".format(pre)); sys.exit(2)
else:
  sys.stderr.write("ambiguous prefix {}: {} matches\n".format(pre, len(matches))); sys.exit(3)
')
      if [ -z "$TID" ]; then exit 1; fi
    else
      TID="$TID_INPUT"
    fi
    RESPONSE=$(curl -sf -H "$AUTH_HDR" "$API/api/ensemble/teams/$TID/feed")
    ENSEMBLE_HIST_RESPONSE="$RESPONSE" python3 -c '
import json, os, sys
d = json.loads(os.environ["ENSEMBLE_HIST_RESPONSE"])
msgs = d.get("messages", [])
if not msgs:
  print("(no messages for team)")
  sys.exit(0)
for m in msgs:
  ts = m.get("timestamp","?")
  who = m.get("from","?")
  to  = m.get("to","team")
  c = (m.get("content","") or "").strip()
  print("[{}] {} -> {}: {}".format(ts, who, to, c))
    '
    ;;

  recent)
    LIMIT="${1:-10}"
    RESPONSE=$(curl -sf -H "$AUTH_HDR" "$API/api/ensemble/history/recent?limit=$LIMIT")
    ENSEMBLE_HIST_RESPONSE="$RESPONSE" python3 -c '
import json, os
d = json.loads(os.environ["ENSEMBLE_HIST_RESPONSE"])
teams = d.get("teams", [])
if not teams:
  print("(no past teams)")
else:
  print("=== {} most recent team(s) ===".format(len(teams)))
  for t in teams:
    when = t.get("completedAt") or t.get("createdAt") or "?"
    agents = ",".join(a["name"] for a in t.get("agents",[]))
    desc = (t.get("description","") or "").strip()[:120]
    print("[{}] {:10s} {} {}".format(t["id"][:8], t["status"], when, agents))
    if desc: print("   {}".format(desc))
    '
    ;;

  help|--help|-h|*)
    cat <<EOF
team-history — cross-team conversation + findings lookup

Subcommands:
  search <query> [limit]   find past teams matching a keyword
                           (searches description + message content)
  feed <team-id>           print full message log of a past team
  recent [N]               N most recent teams (default 10, active + disbanded)

Examples:
  team-history search "off-by-one"
  team-history search "paper_trader exit logic"
  team-history recent 5
  team-history feed 5d6b0613
EOF
    ;;
esac
