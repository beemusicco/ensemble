#!/usr/bin/env bash
# worktree-gc.sh — operator-driven worktree garbage collector.
# Walks all known repo .worktrees/ dirs and applies the same disposition
# evaluator used by disbandTeam (W2.5m primitive). Destroys clean worktrees
# that have no uncommitted changes AND whose HEAD is already in default branch.
# Preserves anything with real work: uncommitted, commits-not-merged, or eval errors.
#
# Usage:
#   worktree-gc                  # dry-run by default — shows verdict, destroys nothing
#   worktree-gc --apply          # actually destroy clean worktrees + delete their branches
#   worktree-gc --repo=PATH      # restrict to one repo (else walks known parents)
#   worktree-gc --json           # machine-readable output (for cron)
set -euo pipefail

APPLY=0
JSON=0
REPO_OVERRIDE=""

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --json)  JSON=1 ;;
    --repo=*) REPO_OVERRIDE="${arg#--repo=}" ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Discover all `.worktrees` directories under known scan roots. The repo
# root for each is resolved via `git rev-parse --show-toplevel` from inside,
# because some monorepo skills nest `.worktrees/` inside a subdir whose
# actual git root is higher up (e.g. workspace/skills/.git managing
# workspace/skills/crypto-trading-platform/.worktrees).
SCAN_ROOTS=(
  "$HOME/projects"
  "$HOME/.openclaw/workspace"
  "$HOME/.openclaw/tools"
)
[ -n "$REPO_OVERRIDE" ] && SCAN_ROOTS=("$REPO_OVERRIDE")

WORKTREE_PARENTS=()
for root in "${SCAN_ROOTS[@]}"; do
  [ -d "$root" ] || continue
  while IFS= read -r -d '' wt_dir; do
    parent_dir=$(dirname "$wt_dir")
    WORKTREE_PARENTS+=("$parent_dir")
  done < <(find "$root" -maxdepth 5 -type d -name ".worktrees" \
            -not -path "*/.worktrees/*/.worktrees" \
            -not -path "*/node_modules/*" \
            -print0 2>/dev/null)
done

resolve_default_branch() {
  for ref in main master; do
    git -C "$1" rev-parse --verify --quiet "refs/heads/$ref" >/dev/null 2>&1 && { echo "$ref"; return 0; }
  done
  return 1
}

evaluate_disposition() {
  # Returns: destroy | preserve:uncommitted | preserve:commits-not-merged | preserve:eval-error
  local worktree="$1" repo="$2"
  local porcelain
  if ! porcelain=$(git -C "$worktree" status --porcelain 2>/dev/null); then
    echo "preserve:eval-error"; return
  fi
  if [ -n "$porcelain" ]; then
    echo "preserve:uncommitted"; return
  fi
  local default_ref
  if ! default_ref=$(resolve_default_branch "$repo"); then
    echo "preserve:eval-error"; return
  fi
  local head
  if ! head=$(git -C "$worktree" rev-parse HEAD 2>/dev/null); then
    echo "preserve:eval-error"; return
  fi
  if git -C "$repo" merge-base --is-ancestor "$head" "$default_ref" 2>/dev/null; then
    echo "destroy"
  else
    echo "preserve:commits-not-merged"
  fi
}

DESTROYED_COUNT=0
PRESERVED_COUNT=0
RECLAIMED_BYTES=0

# Output mode setup
if [ "$JSON" = "1" ]; then
  RESULTS_JSON="["
  FIRST=1
fi

for parent_dir in "${WORKTREE_PARENTS[@]}"; do
  [ -d "$parent_dir/.worktrees" ] || continue
  # Resolve the actual git repo root (may differ from parent_dir when nested).
  repo=$(git -C "$parent_dir" rev-parse --show-toplevel 2>/dev/null) || continue
  for wt in "$parent_dir/.worktrees"/*/; do
      [ -d "$wt" ] || continue
      wt="${wt%/}"
      verdict=$(evaluate_disposition "$wt" "$repo")
      size_bytes=$(du -sk "$wt" 2>/dev/null | awk '{print $1}')
      size_human=$(du -sh "$wt" 2>/dev/null | cut -f1)
      branch=""
      if git -C "$wt" branch --show-current >/dev/null 2>&1; then
        branch=$(git -C "$wt" branch --show-current 2>/dev/null)
      fi

      action="dry-skip"
      case "$verdict" in
        destroy)
          if [ "$APPLY" = "1" ]; then
            git -C "$repo" worktree remove "$wt" --force >/dev/null 2>&1 || rm -rf "$wt"
            [ -n "$branch" ] && git -C "$repo" branch -D "$branch" >/dev/null 2>&1 || true
            git -C "$repo" worktree prune >/dev/null 2>&1 || true
            action="destroyed"
            RECLAIMED_BYTES=$((RECLAIMED_BYTES + size_bytes))
          else
            action="would-destroy"
          fi
          DESTROYED_COUNT=$((DESTROYED_COUNT + 1))
          ;;
        preserve:*)
          action="preserved (${verdict#preserve:})"
          PRESERVED_COUNT=$((PRESERVED_COUNT + 1))
          ;;
      esac

      if [ "$JSON" = "1" ]; then
        [ "$FIRST" = "0" ] && RESULTS_JSON="$RESULTS_JSON,"
        FIRST=0
        RESULTS_JSON="${RESULTS_JSON}{\"path\":\"$wt\",\"branch\":\"$branch\",\"verdict\":\"$verdict\",\"action\":\"$action\",\"size\":\"$size_human\"}"
      else
        case "$verdict" in
          destroy) icon="💀" ;;
          preserve:uncommitted) icon="📝" ;;
          preserve:commits-not-merged) icon="🌳" ;;
          *) icon="⚠️" ;;
        esac
        printf "  %s [%6s]  %-26s  %s\n" "$icon" "$size_human" "$verdict" "${wt#$HOME/}"
      fi
  done
done

reclaimed_human=$(awk "BEGIN { gb=$RECLAIMED_BYTES/1024/1024; mb=$RECLAIMED_BYTES/1024; if (gb>1) printf \"%.1f GB\", gb; else printf \"%.0f MB\", mb }")

if [ "$JSON" = "1" ]; then
  RESULTS_JSON="$RESULTS_JSON]"
  printf '{"summary":{"destroyed":%d,"preserved":%d,"reclaimed":"%s","apply":%d},"results":%s}\n' \
    "$DESTROYED_COUNT" "$PRESERVED_COUNT" "$reclaimed_human" "$APPLY" "$RESULTS_JSON"
else
  echo
  if [ "$APPLY" = "1" ]; then
    echo "✓ Done — destroyed: $DESTROYED_COUNT, preserved: $PRESERVED_COUNT, reclaimed: $reclaimed_human"
  else
    echo "🔍 Dry-run — would-destroy: $DESTROYED_COUNT, preserve: $PRESERVED_COUNT"
    echo "   Re-run with --apply to actually destroy + delete branches."
  fi
fi
