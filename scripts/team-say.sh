#!/usr/bin/env bash
# team-say — Send a message to your team feed
# Works inside sandboxed environments (no network needed - writes to file)
#
# Canonical:  team-say <team-id> <from> <to> <message>
# Tolerated:  team-say <team-id> <from> <message>             (to defaults to 'team')
# Tolerated:  team-say <team-id> <from> "<to-list>: <message>" (collapsed-arg form
#             observed in haiku and codex-mini output — argv[3] gets the whole
#             addressee+message blob in one shell-quoted arg, leaving MSG=""
#             with the canonical parser. We now route the whole arg to MSG.)
#
# Empty-content guard: if MSG ends up empty we exit 3 instead of polluting
# messages.jsonl. 112 historical empties traced back to the collapsed-arg
# pattern; without this guard the message log fills with `content=""` rows
# that the monitor renders as ghost replies.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

if [ $# -lt 3 ]; then
  echo "Usage: team-say <team-id> <from> [<to>] <message>" >&2
  exit 2
fi

TEAM_ID="$1"; FROM="$2"

# Real agent names are short, alphanumeric + dash (claude-1, codex-2, haiku-3,
# codex-mini-4, sonnet-2). Anything else in $3 — a space, colon, newline, or
# >30 chars — means the agent collapsed addressee + message into one arg.
# In that case the entire $3 is content; recipient falls back to 'team'.
if [ $# -ge 4 ] && printf '%s' "$3" | grep -qE '^[A-Za-z0-9_-]{1,30}$'; then
  TO="$3"; shift 3
  MSG="$*"
else
  TO="team"
  shift 2
  MSG="$*"
fi

if [ -z "$MSG" ] || [ "${MSG//[[:space:]]/}" = "" ]; then
  echo "team-say: refusing to send empty message (got: from=$FROM to=$TO)" >&2
  exit 3
fi
FILE="$(collab_messages_file "$TEAM_ID")"
DIR="$(dirname "$FILE")"
LOCK_DIR="$FILE.lock"
mkdir -p "$DIR"
touch "$FILE"
python3 -c "
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone

team_id, sender, recipient, content, output_path, lock_dir = sys.argv[1:7]
msg = {
    'id': str(uuid.uuid4()),
    'teamId': team_id,
    'from': sender,
    'to': recipient,
    'content': content,
    'type': 'chat',
    'timestamp': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
}

# Acquire mkdir-based lock (compatible with ensemble-registry.ts appendMessage)
start = time.time()
acquired = False
while time.time() - start < 5.0:
    try:
        os.mkdir(lock_dir)
        acquired = True
        break
    except FileExistsError:
        try:
            if time.time() - os.stat(lock_dir).st_mtime > 10.0:
                import shutil; shutil.rmtree(lock_dir, ignore_errors=True)
                continue
        except OSError:
            pass
        time.sleep(0.05)

try:
    with open(output_path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(msg) + '\n')
finally:
    if acquired:
        import shutil; shutil.rmtree(lock_dir, ignore_errors=True)
" "$TEAM_ID" "$FROM" "$TO" "$MSG" "$FILE" "$LOCK_DIR"

echo "Sent to $TO"
