#!/usr/bin/env bash
# team-recall — Read memories by scope/tags/key.
# Usage:
#   team-recall [--scope=global|team|session] [--tags=a,b] [--team=ID] [--key=KEY] [--limit=N]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header)"
API="${ENSEMBLE_URL:-http://localhost:23000}"

QS=""
for arg in "$@"; do
  case "$arg" in
    --scope=*) QS="${QS}&scope=${arg#--scope=}" ;;
    --tags=*)  QS="${QS}&tags=${arg#--tags=}" ;;
    --team=*)  QS="${QS}&team=${arg#--team=}" ;;
    --key=*)   QS="${QS}&key=${arg#--key=}" ;;
    --limit=*) QS="${QS}&limit=${arg#--limit=}" ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done
QS="${QS#&}"
URL="$API/api/ensemble/memory"
[ -n "$QS" ] && URL="$URL?$QS"

RESPONSE=$(curl -sf -H "$AUTH_HDR" "$URL")
ENSEMBLE_MEM_RESPONSE="$RESPONSE" python3 -c '
import json, os, sys
d = json.loads(os.environ["ENSEMBLE_MEM_RESPONSE"])
mems = d.get("memories", [])
if not mems:
  print("(no memories match)")
  sys.exit(0)
for m in mems:
  tags = ",".join(m.get("tags", []))
  tag_str = " [{}]".format(tags) if tags else ""
  print("{}:{}{}".format(m["scope"], m["key"], tag_str))
  for line in m["value"].splitlines():
    print("  {}".format(line))
'
