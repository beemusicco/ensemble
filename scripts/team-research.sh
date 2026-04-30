#!/usr/bin/env bash
# team-research — research a topic by querying memories + docs + optional URL.
# Usage:
#   team-research "<query>"                       # memories + docs only
#   team-research "<query>" --url=https://...    # also fetch one URL
#   team-research "<query>" --limit=5            # top-5 memory hits (default 3)
#   team-research "<query>" --json               # raw JSON instead of text
set -euo pipefail

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "Usage: team-research \"<query>\" [--url=<url>] [--limit=N] [--json]" >&2
  exit 2
fi

QUERY="$1"
shift || true

URL_PARAM=""
LIMIT_PARAM=""
FORMAT="text"

for arg in "$@"; do
  case "$arg" in
    --url=*)   URL_PARAM="$arg" ;;
    --limit=*) LIMIT_PARAM="$arg" ;;
    --json)    FORMAT="json" ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: team-research \"<query>\" [--url=<url>] [--limit=N] [--json]" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header)"
API="${ENSEMBLE_URL:-http://localhost:23000}"

# URL-encode the query so spaces/quotes don't break the request.
ENC_Q="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$QUERY")"

QS="q=${ENC_Q}"
if [ -n "$URL_PARAM" ]; then
  ENC_URL="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "${URL_PARAM#--url=}")"
  QS="${QS}&url=${ENC_URL}"
fi
if [ -n "$LIMIT_PARAM" ]; then
  QS="${QS}&limit=${LIMIT_PARAM#--limit=}"
fi
if [ "$FORMAT" = "text" ]; then
  QS="${QS}&format=text"
fi

ENDPOINT="$API/api/ensemble/research?$QS"

if [ "$FORMAT" = "text" ]; then
  curl -sf -H "$AUTH_HDR" "$ENDPOINT"
  echo
else
  curl -sf -H "$AUTH_HDR" "$ENDPOINT"
fi
