#!/usr/bin/env bash
# team-state-injector — prints a compact <team-current-state> block for a
# given team UUID. Used by the prompt-enricher UserPromptSubmit hook when
# the operator's prompt mentions a UUID, so the receiving Claude session
# sees the CANONICAL state of that team before reasoning about it.
#
# Production driver 2026-05-13: a Claude session in another pane misread a
# watchdog "stalled" log line and declared 3 agents dead. Ground truth via
# teams.json showed all 4 status=active with last message 7s prior.
#
# Output is empty if team not found, exit 0 always (best-effort surface).
#
# Usage:
#   ./team-state-injector.sh <team-uuid>
set -uo pipefail

TID="${1:?Usage: team-state-injector.sh <team-uuid>}"

# Quick UUID sanity check
if ! [[ "$TID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  exit 0
fi

TEAMS_JSON="${ENSEMBLE_TEAMS_JSON:-$HOME/.ensemble/ensemble/teams.json}"
[ -f "$TEAMS_JSON" ] || exit 0

python3 - "$TID" "$TEAMS_JSON" <<'PY'
import json, sys, time, os
from datetime import datetime, timezone
from pathlib import Path

tid = sys.argv[1]
teams_json = sys.argv[2]

try:
    with open(teams_json) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

teams = list(data.values()) if isinstance(data, dict) else data
team = next((t for t in teams if t.get('id','').lower() == tid.lower()), None)
if not team:
    sys.exit(0)

status = team.get('status', '?')
cwd = team.get('workingDirectory', '?')
created = team.get('createdAt', '')
completed = team.get('completedAt', '')

def age(iso):
    if not iso: return '?'
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        secs = (datetime.now(timezone.utc) - dt).total_seconds()
        if secs < 60: return f"{int(secs)}s ago"
        if secs < 3600: return f"{int(secs/60)}m ago"
        if secs < 86400: return f"{int(secs/3600)}h ago"
        return f"{int(secs/86400)}d ago"
    except Exception:
        return '?'

# Last message from messages.jsonl
msg_path = Path(f"/tmp/ensemble/{tid}/messages.jsonl")
last_msg_age_secs = None
last_msg_sender = None
last_msg_preview = None
msg_count = 0
if msg_path.exists():
    try:
        with msg_path.open() as f:
            lines = f.readlines()
        msg_count = len(lines)
        if lines:
            last = json.loads(lines[-1])
            ts = last.get('timestamp', '')
            if ts:
                dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
                last_msg_age_secs = (datetime.now(timezone.utc) - dt).total_seconds()
            last_msg_sender = last.get('from', '?')
            last_msg_preview = (last.get('content') or '').replace('\n',' ')[:90]
    except Exception:
        pass

def fmt_secs(s):
    if s is None: return '?'
    if s < 60: return f"{int(s)}s"
    if s < 3600: return f"{int(s/60)}m"
    return f"{int(s/3600)}h"

print(f"<team-current-state id='{tid}' source='teams.json+messages.jsonl' note='canonical ground truth — trust this over watchdog logs or stale recall'>")
print(f"  team_status: {status}")
print(f"  cwd: {cwd}")
print(f"  created: {age(created)}")
if status in ('disbanded', 'failed', 'completed'):
    print(f"  ended: {age(completed)}")
print(f"  agents:")
for a in team.get('agents', []):
    name = a.get('name', '?')
    astat = a.get('status', '?')
    print(f"    {name:<14s} status={astat}")
print(f"  messages_total: {msg_count}")
print(f"  last_message: {fmt_secs(last_msg_age_secs)} ago by {last_msg_sender}")
if last_msg_preview:
    print(f"    preview: {last_msg_preview}")
print(f"  if you were about to declare an agent dead/stalled/crashed based on")
print(f"  a log line elsewhere, this is the canonical state. Long silence is")
print(f"  by-design WAVE pattern; trust this block over watchdog notices.")
print(f"</team-current-state>")
PY
