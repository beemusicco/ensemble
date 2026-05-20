#!/usr/bin/env bash
# collab-archive.sh — preserve a collab's history before its runtime dir or
# worktree is garbage-collected. Idempotent: safe to call repeatedly; never
# re-copies a file that is already archived.
#
# Without this, the decision trail (summary + full agent conversation) lived
# only in the ephemeral /tmp/ensemble/<id>/ dir and was lost on every cleanup
# run or reboot. collab-cleanup.sh and worktree-gc.sh call this first.
#
# Archives into ~/.openclaw/state/collab-archive/<team-id>/:
#   summary.txt                — collab outcome (from /tmp/ensemble/<id>/)
#   messages.jsonl.gz          — full agent conversation, gzipped
#   replay.html                — visual replay, if present
#   <agent>.uncommitted.patch  — uncommitted worktree changes (--worktree mode)
#   meta.json                  — team-id + archived-at timestamps
#
# Usage:
#   collab-archive.sh <team-id>
#   collab-archive.sh <team-id> --worktree <worktree-path>
set -euo pipefail

TEAM_ID="${1:?team-id required}"
shift || true

WORKTREE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="${2:?--worktree needs a path}"; shift 2 ;;
    -h|--help)  sed -n '2,22p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "collab-archive: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

ARCHIVE_DEST="$HOME/.openclaw/state/collab-archive/$TEAM_ID"
RUNTIME_DIR="/tmp/ensemble/$TEAM_ID"
mkdir -p "$ARCHIVE_DEST"

archived_any=0

# ── Runtime-dir history: summary / messages / replay ─────────────────────
if [ -f "$RUNTIME_DIR/summary.txt" ] && [ ! -f "$ARCHIVE_DEST/summary.txt" ]; then
  cp "$RUNTIME_DIR/summary.txt" "$ARCHIVE_DEST/summary.txt" && archived_any=1
fi
if [ -f "$RUNTIME_DIR/messages.jsonl" ] && [ ! -f "$ARCHIVE_DEST/messages.jsonl.gz" ]; then
  gzip -c "$RUNTIME_DIR/messages.jsonl" > "$ARCHIVE_DEST/messages.jsonl.gz" && archived_any=1
fi
if [ -f "$RUNTIME_DIR/replay.html" ] && [ ! -f "$ARCHIVE_DEST/replay.html" ]; then
  cp "$RUNTIME_DIR/replay.html" "$ARCHIVE_DEST/replay.html" && archived_any=1
fi

# ── Worktree git state: uncommitted changes ──────────────────────────────
# Tracked modifications are captured as a real patch (bounded by source
# size). Untracked files are recorded by NAME only — a worktree can hold
# multi-GB of untracked data/build output, and staging that into a diff
# would blow up the archive. Commits already on the agent branch are
# preserved by the branch ref itself (worktree-gc keeps unmerged refs).
if [ -n "$WORKTREE" ] && [ -d "$WORKTREE" ]; then
  agent="$(basename "$WORKTREE")"
  agent="${agent#"$TEAM_ID"-}"

  patch_file="$ARCHIVE_DEST/${agent}.uncommitted.patch"
  if [ ! -f "$patch_file" ]; then
    if git -C "$WORKTREE" diff HEAD > "$patch_file" 2>/dev/null && [ -s "$patch_file" ]; then
      archived_any=1
    else
      rm -f "$patch_file"
    fi
  fi

  untracked_file="$ARCHIVE_DEST/${agent}.untracked-files.txt"
  if [ ! -f "$untracked_file" ]; then
    git -C "$WORKTREE" status --porcelain 2>/dev/null \
      | awk '/^\?\?/ { print substr($0, 4) }' > "$untracked_file" 2>/dev/null || true
    if [ -s "$untracked_file" ]; then archived_any=1; else rm -f "$untracked_file"; fi
  fi
fi

# ── meta.json ────────────────────────────────────────────────────────────
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ ! -f "$ARCHIVE_DEST/meta.json" ]; then
  printf '{"team_id":"%s","first_archived":"%s","last_archived":"%s"}\n' \
    "$TEAM_ID" "$NOW_UTC" "$NOW_UTC" > "$ARCHIVE_DEST/meta.json"
else
  python3 - "$ARCHIVE_DEST/meta.json" "$NOW_UTC" <<'PY' 2>/dev/null || true
import json, sys
path, now = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
except Exception:
    d = {}
d["last_archived"] = now
json.dump(d, open(path, "w"))
PY
fi

[ "$archived_any" = "1" ] && echo "collab-archive: $TEAM_ID → $ARCHIVE_DEST" >&2 || true
exit 0
