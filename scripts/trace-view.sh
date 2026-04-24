#!/usr/bin/env bash
# trace-view — Pretty-print spans from traces-*.jsonl.
# Usage:
#   trace-view                  # today
#   trace-view 2026-04-24       # specific date
#   trace-view --team <teamId>  # filter by team
#   trace-view --slow <ms>      # only spans longer than <ms>
set -euo pipefail

DATA_DIR="${ENSEMBLE_DATA_DIR:-$HOME/.ensemble}"
LOGS_DIR="$DATA_DIR/logs"

DATE="$(date +%Y-%m-%d)"
TEAM_FILTER=""
SLOW_MS="0"
while [ $# -gt 0 ]; do
  case "$1" in
    --team=*) TEAM_FILTER="${1#--team=}" ;;
    --team)   TEAM_FILTER="$2"; shift ;;
    --slow=*) SLOW_MS="${1#--slow=}" ;;
    --slow)   SLOW_MS="$2"; shift ;;
    --help|-h)
      echo "Usage: trace-view [DATE] [--team <id>] [--slow <ms>]"
      exit 0 ;;
    *) DATE="$1" ;;
  esac
  shift
done

FILE="$LOGS_DIR/traces-$DATE.jsonl"
if [ ! -f "$FILE" ]; then
  echo "No traces at $FILE" >&2
  exit 1
fi

ENSEMBLE_TRACE_FILE="$FILE" \
ENSEMBLE_TRACE_TEAM="$TEAM_FILTER" \
ENSEMBLE_TRACE_SLOW="$SLOW_MS" \
python3 -c '
import json, os, sys

file = os.environ["ENSEMBLE_TRACE_FILE"]
team = os.environ.get("ENSEMBLE_TRACE_TEAM", "").strip()
try:
  slow = int(os.environ.get("ENSEMBLE_TRACE_SLOW", "0"))
except ValueError:
  slow = 0

RED = "\033[91m"
GREEN = "\033[92m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"

by_status = {"ok": 0, "error": 0}
by_name = {}
rows = []

with open(file) as f:
  for line in f:
    line = line.strip()
    if not line: continue
    try:
      s = json.loads(line)
    except json.JSONDecodeError:
      continue
    if team:
      tid = s.get("teamId") or s.get("attributes",{}).get("teamId")
      if tid != team:
        continue
    dur = s.get("durationMs", 0) or 0
    if dur < slow:
      continue
    by_status[s.get("status","ok")] = by_status.get(s.get("status","ok"), 0) + 1
    name = s.get("name","?")
    by_name.setdefault(name, []).append(dur)
    rows.append(s)

rows.sort(key=lambda r: r.get("startedAt", 0))

for s in rows[-100:]:
  dur = s.get("durationMs", 0) or 0
  status_col = GREEN if s.get("status") == "ok" else RED
  mark = "OK " if s.get("status") == "ok" else "ERR"
  name = s.get("name","?")
  attrs = s.get("attributes", {})
  tid = (s.get("teamId") or attrs.get("teamId") or "")[:8]
  ts = s.get("startedAt", 0)
  iso = ""
  if ts:
    import datetime as dt
    iso = dt.datetime.fromtimestamp(ts/1000).strftime("%H:%M:%S")
  extra_bits = []
  for k in ("teamId","messageId","agentCount","staged","disbandedAt"):
    if k in attrs and attrs[k] is not None:
      v = str(attrs[k])[:30]
      extra_bits.append("{}={}".format(k, v))
  extra = " ".join(extra_bits)
  print("{}{} {} {:20s} {:>6}ms {} {}{}".format(status_col, mark, RESET, name, dur, DIM + (tid or "--------") + RESET, extra, RESET))
  if s.get("error"):
    print("  {}error: {}{}".format(RED, s["error"], RESET))

print()
print("{}Summary{}".format(BOLD, RESET))
print("  total spans: {}".format(len(rows)))
print("  ok: {}  error: {}".format(by_status.get("ok",0), by_status.get("error",0)))
if by_name:
  print("  by name:")
  for name in sorted(by_name):
    durs = by_name[name]
    avg = sum(durs)/len(durs)
    mx  = max(durs)
    print("    {:20s} n={:3d}  avg={:5.0f}ms  max={:5.0f}ms".format(name, len(durs), avg, mx))
'
