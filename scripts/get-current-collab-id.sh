#!/usr/bin/env bash
# get-current-collab-id.sh — resolve the current /collab team-id with proper
# attribution priority. Replaces direct `cat /tmp/collab-team-id.txt` reads
# which fail when concurrent collabs from different panes / parents clobber
# the single global file.
#
# Priority order:
#   1. /tmp/collab-team-by-pane-${TMUX_PANE}.txt   — own tmux pane wins
#   2. /tmp/collab-team-${PPID}.txt                — own parent process
#   3. /tmp/collab-team-id.txt                     — global fallback (last spawn)
#
# Output: the resolved UUID on stdout, or empty + non-zero exit on miss.
# Caller may pass --pane <id> to override, useful from non-tmux contexts that
# know the originating pane (e.g. the SKILL.md preflight step).
#
# Production driver: 2026-05-05 — operator's jsQR team-id was clobbered by an
# unrelated brainai-dashboard /collab from another pane, the skill chased the
# wrong team after /compact. Per-pane attribution closes that gap.

set -euo pipefail

OVERRIDE_PANE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pane) OVERRIDE_PANE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

uuid_re='^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'

emit_if_valid() {
  local file="$1"
  [ -r "$file" ] || return 1
  local val
  val=$(tr -d '\n\r ' < "$file")
  [ -n "$val" ] || return 1
  if [[ ! "$val" =~ $uuid_re ]]; then return 1; fi
  printf '%s\n' "$val"
  return 0
}

# 1) Per-pane file
PANE_RAW="${OVERRIDE_PANE:-${TMUX_PANE:-}}"
if [ -n "$PANE_RAW" ]; then
  PANE_SAFE=$(printf '%s' "${PANE_RAW#%}" | tr -c 'A-Za-z0-9_-' '_')
  if [ -n "$PANE_SAFE" ] && emit_if_valid "/tmp/collab-team-by-pane-${PANE_SAFE}.txt"; then
    exit 0
  fi
fi

# 2) Per-parent-PID file (PPID is the script's invoker; a wrapper script
# loses the chain, so read MY parent's PPID via /proc isn't portable on
# macOS — rely on $PPID of the SHELL that invoked this).
if [ -n "${PPID:-}" ] && emit_if_valid "/tmp/collab-team-${PPID}.txt"; then
  exit 0
fi

# 3) Global fallback
if emit_if_valid "/tmp/collab-team-id.txt"; then
  exit 0
fi

exit 1
