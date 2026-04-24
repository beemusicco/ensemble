#!/usr/bin/env bash
# weekly-digest — Summary of the past 7 days of collab activity.
#
# Reads /api/ensemble/history/recent?limit=200, filters to last 7 days,
# groups by (day, agent-set), prints markdown digest to stdout AND writes
# /tmp/ensemble-digest-YYYY-WW.md for archival.
#
# Wire into a weekly cron (Sunday night / Monday morning) if you want it
# automated:
#   # ~/.ensemble/crontab  (example)
#   0 9 * * MON   /Users/you/.../scripts/weekly-digest.sh > /dev/null
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header)"
API="${ENSEMBLE_URL:-http://localhost:23000}"

RESPONSE=$(curl -sf -H "$AUTH_HDR" "$API/api/ensemble/history/recent?limit=200")
MEM_RESPONSE=$(curl -sf -H "$AUTH_HDR" "$API/api/ensemble/memory?scope=global&limit=200" || echo '{"memories":[]}')

OUT=$(ENSEMBLE_HIST="$RESPONSE" ENSEMBLE_MEM="$MEM_RESPONSE" python3 -c '
import json, os, datetime as dt
from collections import Counter, defaultdict

hist = json.loads(os.environ["ENSEMBLE_HIST"])
mem = json.loads(os.environ.get("ENSEMBLE_MEM","{}") or "{}")

now = dt.datetime.now(dt.timezone.utc)
cutoff = now - dt.timedelta(days=7)
iso_week = now.strftime("%G-W%V")

teams = hist.get("teams", [])
recent = []
for t in teams:
  raw = t.get("completedAt") or t.get("createdAt")
  if not raw: continue
  try:
    when = dt.datetime.fromisoformat(raw.replace("Z","+00:00"))
  except Exception:
    continue
  if when < cutoff: continue
  recent.append((when, t))

# Reflections written in the window
reflections = []
for m in mem.get("memories", []):
  if "reflection" not in m.get("tags", []): continue
  try:
    when = dt.datetime.fromisoformat(m["createdAt"].replace("Z","+00:00"))
  except Exception:
    continue
  if when < cutoff: continue
  reflections.append((when, m))

# Group by (date, agent-set)
groups = defaultdict(list)
for when, t in recent:
  agents = ",".join(sorted(a["name"] for a in t.get("agents",[])))
  day = when.strftime("%Y-%m-%d")
  groups[(day, agents)].append((when, t))

# Topic buckets from description first words
topic_counter = Counter()
for _, t in recent:
  desc = (t.get("description") or "").lower()
  # crude topic bucketing: pick first 2-3 meaningful words
  for kw in ["polymarket","kalshi","paper_trader","crypto","backtest","collab","memory","auth","health","bench","thinking","research","fix","implement"]:
    if kw in desc:
      topic_counter[kw] += 1

lines = []
lines.append("# Ensemble Weekly Digest — {}".format(iso_week))
lines.append("")
lines.append("- Window: {} → {}".format(cutoff.strftime("%Y-%m-%d"), now.strftime("%Y-%m-%d")))
lines.append("- Teams in window: **{}**".format(len(recent)))
lines.append("- Reflections saved: **{}**".format(len(reflections)))
lines.append("- Top topics: {}".format(", ".join(f"{k}({v})" for k,v in topic_counter.most_common(6)) or "(no topic keywords matched)"))
lines.append("")

if groups:
  lines.append("## Activity by day")
  for (day, agents) in sorted(groups.keys()):
    items = groups[(day, agents)]
    lines.append("")
    lines.append("### {} — {} ({})".format(day, agents, len(items)))
    for when, t in sorted(items):
      status = t.get("status","?")
      desc = (t.get("description") or "").strip().replace("\n"," ")
      lines.append("- `{}` [{}] {}: {}".format(t["id"][:8], status, when.strftime("%H:%M"), desc[:140]))

if reflections:
  lines.append("")
  lines.append("## Reflections saved this week")
  for when, m in sorted(reflections, reverse=True):
    tags = ",".join(t for t in m.get("tags",[]) if t not in ("reflection",))
    val = (m.get("value") or "").strip().replace("\n"," ")
    lines.append("- **{}** [{}]: {}".format(when.strftime("%m-%d"), tags, val[:200]))

print("\n".join(lines))
')

# Write archive file + print
ARCHIVE="/tmp/ensemble-digest-$(date -u +%G-W%V).md"
printf '%s\n' "$OUT" > "$ARCHIVE"
printf '%s\n' "$OUT"
echo ""
echo "(archived to $ARCHIVE)"
