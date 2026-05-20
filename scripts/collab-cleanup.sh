#!/usr/bin/env bash
# collab-cleanup.sh — Clean up old finished collab runtime directories.
# Usage: collab-cleanup.sh [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"

ENSEMBLE_ROOT="/tmp/ensemble"
KEEP_RECENT=3
MIN_AGE_SECONDS=$((24 * 60 * 60))
MODE="dry-run"

G='\033[92m'; C='\033[96m'; D='\033[2m'; W='\033[97m'; Y='\033[93m'; R='\033[0m'; BD='\033[1m'

usage() {
  cat <<'EOF'
Usage: collab-cleanup.sh [--force]

Options:
  --force   Delete eligible runtime directories instead of printing a dry-run.
  -h, --help  Show this help text.
EOF
}

human_kb() {
  local kb="${1:-0}"
  if [ "$kb" -ge 1048576 ]; then
    awk -v kb="$kb" 'BEGIN { printf "%.1f GB", kb / 1048576 }'
  elif [ "$kb" -ge 1024 ]; then
    awk -v kb="$kb" 'BEGIN { printf "%.1f MB", kb / 1024 }'
  else
    printf '%s KB' "$kb"
  fi
}

mtime_epoch() {
  local path="${1:?path required}"
  if stat -f '%m' "$path" >/dev/null 2>&1; then
    stat -f '%m' "$path"
  else
    stat -c '%Y' "$path"
  fi
}

finished_entries() {
  [ -d "$ENSEMBLE_ROOT" ] || return 0
  find "$ENSEMBLE_ROOT" -mindepth 2 -maxdepth 2 -type f -name .finished -print0 |
    while IFS= read -r -d '' marker; do
      local runtime_dir ts
      runtime_dir="$(dirname "$marker")"
      ts="$(mtime_epoch "$marker")"
      printf '%s\t%s\n' "$ts" "$runtime_dir"
    done | sort -rn
}

# Orphan entries: runtime dirs that NEVER reached .finished state (zombie test
# spawns, agents that died before first message, collab-launch that errored).
# Production driver 2026-05-15: 28+ ghost dirs from 2026-05-11 accumulated for
# 4 days because finished_entries() only matched .finished marker — orphans
# slipped through. Now caught: dir mtime >24h AND no .finished AND
# (no messages.jsonl OR 0 messages).
orphan_entries() {
  [ -d "$ENSEMBLE_ROOT" ] || return 0
  find "$ENSEMBLE_ROOT" -mindepth 1 -maxdepth 1 -type d -print0 |
    while IFS= read -r -d '' runtime_dir; do
      # Skip if .finished exists — handled by finished_entries()
      [ -f "$runtime_dir/.finished" ] && continue
      # Compute message count (treat missing file as 0)
      local msg_file="$runtime_dir/messages.jsonl"
      local msg_count=0
      if [ -f "$msg_file" ]; then
        msg_count=$(wc -l < "$msg_file" 2>/dev/null | tr -d ' ' || echo 0)
      fi
      msg_count=${msg_count:-0}
      # Only target true orphans: zero messages = team never spoke
      if [ "$msg_count" -ne 0 ] 2>/dev/null; then
        continue
      fi
      local ts
      ts="$(mtime_epoch "$runtime_dir")"
      printf '%s\t%s\n' "$ts" "$runtime_dir"
    done | sort -rn
}

for arg in "$@"; do
  case "$arg" in
    --force)
      MODE="force"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$arg" >&2
      usage >&2
      exit 1
      ;;
  esac
done

NOW="$(date +%s)"
ENTRIES=()
while IFS= read -r line; do
  ENTRIES+=("$line")
done < <(finished_entries)

TOTAL_FINISHED="${#ENTRIES[@]}"
PRESERVED_RECENT=0
PRESERVED_FRESH=0
ELIGIBLE=0
REMOVED=0
FAILED=0
TOTAL_KB=0
REMOVED_KB=0

echo ""
echo -e "  ${BD}${W}◈ collab cleanup${R}"
echo -e "  ${D}${ENSEMBLE_ROOT}${R}"
echo -e "  ${D}mode: ${MODE} | keep latest ${KEEP_RECENT} | age threshold: 24h${R}"
echo ""

if [ ! -d "$ENSEMBLE_ROOT" ]; then
  echo -e "  ${Y}No runtime root found at ${ENSEMBLE_ROOT}${R}"
  exit 0
fi

if [ "$TOTAL_FINISHED" -eq 0 ]; then
  echo -e "  ${Y}No finished collabs found.${R}"
  exit 0
fi

for idx in "${!ENTRIES[@]}"; do
  entry="${ENTRIES[$idx]}"
  finished_ts="${entry%%$'\t'*}"
  runtime_dir="${entry#*$'\t'}"
  runtime_name="$(basename "$runtime_dir")"
  age_seconds=$((NOW - finished_ts))
  age_hours=$((age_seconds / 3600))
  size_kb="$(du -sk "$runtime_dir" 2>/dev/null | awk '{print $1}')"
  size_kb="${size_kb:-0}"
  TOTAL_KB=$((TOTAL_KB + size_kb))

  if [ "$idx" -lt "$KEEP_RECENT" ]; then
    PRESERVED_RECENT=$((PRESERVED_RECENT + 1))
    echo -e "  ${C}keep${R}    ${runtime_name} ${D}(latest $((idx + 1))/${KEEP_RECENT}, ${age_hours}h old, $(human_kb "$size_kb"))${R}"
    continue
  fi

  if [ "$age_seconds" -lt "$MIN_AGE_SECONDS" ]; then
    PRESERVED_FRESH=$((PRESERVED_FRESH + 1))
    echo -e "  ${C}skip${R}    ${runtime_name} ${D}(finished ${age_hours}h ago, below 24h threshold, $(human_kb "$size_kb"))${R}"
    continue
  fi

  ELIGIBLE=$((ELIGIBLE + 1))
  if [ "$MODE" = "force" ]; then
    # Preserve the decision trail (summary + messages + replay) before the
    # ephemeral runtime dir is destroyed. runtime_name is the team-id UUID.
    bash "$SCRIPT_DIR/collab-archive.sh" "$runtime_name" >/dev/null 2>&1 || true
    if rm -rf "$runtime_dir"; then
      REMOVED=$((REMOVED + 1))
      REMOVED_KB=$((REMOVED_KB + size_kb))
      echo -e "  ${G}remove${R}  ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
    else
      FAILED=$((FAILED + 1))
      echo -e "  ${Y}failed${R}  ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
    fi
  else
    REMOVED_KB=$((REMOVED_KB + size_kb))
    echo -e "  ${Y}would rm${R} ${runtime_name} ${D}(${age_hours}h old, $(human_kb "$size_kb"))${R}"
  fi
done

# Orphan pass: zombie test spawns + crashed-at-start agents that never reached
# .finished. Production driver 2026-05-15: 42 ghost dirs from 4 days ago.
ORPHAN_ENTRIES=()
while IFS= read -r line; do
  ORPHAN_ENTRIES+=("$line")
done < <(orphan_entries)

ORPHAN_FOUND="${#ORPHAN_ENTRIES[@]}"
ORPHAN_REMOVED=0
ORPHAN_KEPT_FRESH=0
ORPHAN_FAILED=0
ORPHAN_KB=0

for entry in "${ORPHAN_ENTRIES[@]}"; do
  dir_mtime="${entry%%$'\t'*}"
  runtime_dir="${entry#*$'\t'}"
  runtime_name="$(basename "$runtime_dir")"
  age_seconds=$((NOW - dir_mtime))
  age_hours=$((age_seconds / 3600))
  size_kb="$(du -sk "$runtime_dir" 2>/dev/null | awk '{print $1}')"
  size_kb="${size_kb:-0}"

  if [ "$age_seconds" -lt "$MIN_AGE_SECONDS" ]; then
    ORPHAN_KEPT_FRESH=$((ORPHAN_KEPT_FRESH + 1))
    continue
  fi

  if [ "$MODE" = "force" ]; then
    if rm -rf "$runtime_dir"; then
      ORPHAN_REMOVED=$((ORPHAN_REMOVED + 1))
      ORPHAN_KB=$((ORPHAN_KB + size_kb))
      echo -e "  ${G}orphan${R}  ${runtime_name} ${D}(no .finished, 0 msgs, ${age_hours}h old, $(human_kb "$size_kb"))${R}"
    else
      ORPHAN_FAILED=$((ORPHAN_FAILED + 1))
    fi
  else
    ORPHAN_KB=$((ORPHAN_KB + size_kb))
    echo -e "  ${Y}would rm orphan${R} ${runtime_name} ${D}(no .finished, ${age_hours}h, $(human_kb "$size_kb"))${R}"
  fi
done

echo ""
echo -e "  ${BD}Stats${R}"
echo -e "  finished dirs:      ${TOTAL_FINISHED}"
echo -e "  kept (latest 3):    ${PRESERVED_RECENT}"
echo -e "  kept (<24h):        ${PRESERVED_FRESH}"
echo -e "  eligible old dirs:  ${ELIGIBLE}"
echo -e "  orphan dirs found:  ${ORPHAN_FOUND}"
echo -e "  orphan removed:     ${ORPHAN_REMOVED}"
echo -e "  orphan kept fresh:  ${ORPHAN_KEPT_FRESH}"
if [ "$MODE" = "force" ]; then
  echo -e "  removed dirs:       ${REMOVED}"
  echo -e "  failed removals:    ${FAILED}"
  echo -e "  reclaimed:          $(human_kb "$REMOVED_KB")"
else
  echo -e "  would remove:       ${ELIGIBLE}"
  echo -e "  reclaimable:        $(human_kb "$REMOVED_KB")"
fi
echo -e "  finished footprint: $(human_kb "$TOTAL_KB")"
echo ""

if [ "$MODE" = "dry-run" ]; then
  echo -e "  ${D}Run with --force to delete eligible runtime directories.${R}"
  echo ""
fi

# FM20 fix: sweep orphan team-say-* scratch dirs left by scripts/team-say.sh.
# These accumulate indefinitely (210+ seen in forensics audit) and obscure
# the real trace inventory. Always prune older than 1h — they're ephemeral.
TEAM_SAY_ORPHANS=0
TEAM_SAY_REMOVED=0
if [ -d "$ENSEMBLE_ROOT" ]; then
  while IFS= read -r -d '' dir; do
    TEAM_SAY_ORPHANS=$((TEAM_SAY_ORPHANS + 1))
    if [ "$MODE" = "force" ]; then
      if rm -rf "$dir"; then
        TEAM_SAY_REMOVED=$((TEAM_SAY_REMOVED + 1))
      fi
    fi
  done < <(find "$ENSEMBLE_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'team-say-*' -mmin +60 -print0 2>/dev/null)
fi

if [ "$TEAM_SAY_ORPHANS" -gt 0 ]; then
  if [ "$MODE" = "force" ]; then
    echo -e "  ${G}team-say orphans swept:${R} ${TEAM_SAY_REMOVED}/${TEAM_SAY_ORPHANS}"
  else
    echo -e "  ${Y}team-say orphans (>1h old):${R} ${TEAM_SAY_ORPHANS} ${D}(run with --force to sweep)${R}"
  fi
fi

# ─── FIX: kill zombie tail-feed loops + bridge supervisors for teams
# that already have .finished markers. These were accumulating 40+ at a time
# because the poller had no exit condition (pre-fix) and bridge-supervisors
# kept retrying against mrtev server.
ZOMBIE_FEED=0
ZOMBIE_BRIDGE=0

# Find feed loops whose team dir has .finished OR whose dir no longer exists
while IFS= read -r line; do
  pid=$(echo "$line" | awk '{print $2}')
  # Extract TID from the bash -c env var assignment
  tid=$(echo "$line" | grep -oE 'TID="[a-f0-9-]{36}"' | head -1 | sed 's/TID="//;s/"//')
  [ -z "$tid" ] && continue
  if [ -f "/tmp/ensemble/$tid/.finished" ] || [ ! -d "/tmp/ensemble/$tid" ]; then
    if [ "$MODE" = "force" ]; then
      kill "$pid" 2>/dev/null && ZOMBIE_FEED=$((ZOMBIE_FEED + 1))
    else
      ZOMBIE_FEED=$((ZOMBIE_FEED + 1))
    fi
  fi
done < <(ps -ef | grep -E 'feed\.txt|MESSAGES_FILE' | grep -v grep | grep "while true")

# Find bridge supervisors whose team is .finished
while IFS= read -r line; do
  pid=$(echo "$line" | awk '{print $2}')
  tid=$(echo "$line" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
  [ -z "$tid" ] && continue
  if [ -f "/tmp/ensemble/$tid/.finished" ] || [ ! -d "/tmp/ensemble/$tid" ]; then
    if [ "$MODE" = "force" ]; then
      kill "$pid" 2>/dev/null && ZOMBIE_BRIDGE=$((ZOMBIE_BRIDGE + 1))
    else
      ZOMBIE_BRIDGE=$((ZOMBIE_BRIDGE + 1))
    fi
  fi
done < <(ps -ef | grep "ensemble-bridge-supervisor" | grep -v grep)

if [ "$ZOMBIE_FEED" -gt 0 ] || [ "$ZOMBIE_BRIDGE" -gt 0 ]; then
  if [ "$MODE" = "force" ]; then
    echo -e "  ${G}zombie feed-loops killed:${R} ${ZOMBIE_FEED}"
    echo -e "  ${G}zombie bridge supervisors killed:${R} ${ZOMBIE_BRIDGE}"
  else
    echo -e "  ${Y}zombie feed-loops (finished):${R} ${ZOMBIE_FEED} ${D}(--force to kill)${R}"
    echo -e "  ${Y}zombie bridge supervisors:${R} ${ZOMBIE_BRIDGE} ${D}(--force to kill)${R}"
  fi
fi
