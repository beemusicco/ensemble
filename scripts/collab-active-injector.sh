#!/usr/bin/env bash
# collab-active-injector — prints a compact <active-collabs> block for the
# prompt-enricher UserPromptSubmit hook. Read-only over teams.json — never
# touches running teams.
#
# Output format (when active teams exist):
#   <active-collabs source='teams.json' note='passive surface'>
#   2 active collab(s) RIGHT NOW. Before spawning a new one, decide:
#   ATTACH to a match · DISBAND first · or PARALLEL (different cwd/task).
#     [1] 226f22ab.. cwd=accounting-helper  age=3m  task=...
#     [2] 0b945ff9.. cwd=octanorm-adria     age=12m task=...
#   Resolve YOUR pane's team via: bash <ensemble>/scripts/get-current-collab-id.sh
#   Full dashboard: bash <ensemble>/scripts/collab-status.sh --once
#   </active-collabs>
#
# Output is empty when no active+forming team exists. Caller decides whether
# to inject (typically only when prompt has collab-spawn intent keywords).
set -uo pipefail

TEAMS_JSON="${ENSEMBLE_TEAMS_JSON:-$HOME/.ensemble/ensemble/teams.json}"
[ -f "$TEAMS_JSON" ] || exit 0

python3 - "$TEAMS_JSON" <<'PY'
import json, os, sys, time
from datetime import datetime, timezone

path = sys.argv[1]
try:
    with open(path) as f:
        data = json.load(f)
except Exception:
    sys.exit(0)

teams = list(data.values()) if isinstance(data, dict) else data
active = [t for t in teams if t.get('status') in ('active', 'forming')]
if not active:
    sys.exit(0)

def parse_iso(s):
    if not s: return 0
    try:
        return datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()
    except Exception:
        return 0

def fmt_age(epoch):
    if not epoch: return '?'
    delta = max(0, time.time() - epoch)
    if delta < 60: return f"{int(delta)}s"
    if delta < 3600: return f"{int(delta//60)}m"
    if delta < 86400: return f"{int(delta//3600)}h"
    return f"{int(delta//86400)}d"

def short_cwd(c):
    if not c: return '?'
    parts = c.rstrip('/').split('/')
    # ~/projects/foo → projects/foo; ~/.openclaw/... → .openclaw/...
    for i, p in enumerate(parts):
        if p in ('projects', '.openclaw', '.claude'):
            return '/'.join(parts[i:])
    return parts[-1] if parts else c

active.sort(key=lambda t: (0 if t.get('status') == 'forming' else 1, -parse_iso(t.get('createdAt',''))))

lines = []
lines.append("<active-collabs source='teams.json' note='passive surface — agent SHOULD use this to decide attach/disband/parallel before spawning'>")
lines.append(f"{len(active)} active+forming collab(s) RIGHT NOW. Before spawning, decide: ATTACH to a match · DISBAND-and-fresh · or PARALLEL (different cwd & task).")
for i, t in enumerate(active[:8], 1):
    tid = (t.get('id') or '?')[:8]
    status = t.get('status', '?')
    cwd = short_cwd(t.get('workingDirectory'))
    age = fmt_age(parse_iso(t.get('createdAt','')))
    desc_raw = (t.get('description') or t.get('task') or '')
    # Boilerplate stripping: collab tasks are prepended with BLOCKER-VETO+TOOLCHAIN
    # blocks (see scripts/collab-prepend.sh). Boilerplate ends with the literal
    # separator "ORIGINAL TASK" before the real task content.
    idx = desc_raw.upper().rfind('ORIGINAL TASK')
    if idx >= 0:
        # skip past marker and any trailing dashes/box-chars/newlines
        desc = desc_raw[idx + len('ORIGINAL TASK'):].lstrip(' :─—-\n\r').replace('\n', ' ').strip()
    else:
        desc = desc_raw.replace('\n', ' ').strip()
    desc_short = desc[:110] + ('…' if len(desc) > 110 else '')
    agents = t.get('agents', [])
    agent_str = ','.join(a.get('program','?')[:4] for a in agents[:4])
    lines.append(f"  [{i}] {tid}.. status={status:9s} cwd={cwd:32s} age={age:>4s} agents={agent_str}")
    if desc_short:
        lines.append(f"      task: {desc_short}")
lines.append("Resolve YOUR pane's TEAM_ID via: bash $HOME/.openclaw/tools/ensemble/scripts/get-current-collab-id.sh")
lines.append("Full dashboard: bash $HOME/.openclaw/tools/ensemble/scripts/collab-status.sh --once")
lines.append("Bypass guard for legitimate parallel: export ENSEMBLE_PARALLEL_OK=1 before invoking collab-launch.sh")
lines.append("</active-collabs>")
print('\n'.join(lines))
PY
