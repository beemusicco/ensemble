#!/usr/bin/env bash
# get-template-agents.sh — resolve a template name to its ideal agent mix.
#
# Reads `default_agents` from collab-templates.json. The ideal mix is encoded
# per-template based on cognitive role-fit (Sonnet for divergence, Opus for
# depth, Codex for empirical/cross-family, Haiku only where the role is
# literally a test-runner / verifier, etc.).
#
# Usage:
#   get-template-agents.sh <template-name>     → prints comma-separated agents
#   get-template-agents.sh <template-name> --fallback "claude,codex,haiku"
#                                              → emits fallback if template
#                                                lookup fails. Default fallback
#                                                is the empty string (caller
#                                                decides what to do).
#
# Why a separate primitive: collab-launch.sh, the user's collab skill, the
# dashboard /api/collab/templates, and any future MCP tool all need the same
# answer. One source of truth, one resolver. Adding a new template = JSON
# edit only — FUTURE-N correct.

set -euo pipefail

TEMPLATE="${1:-}"
FALLBACK=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --fallback) FALLBACK="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$TEMPLATE" ]; then
  echo "Usage: $0 <template-name> [--fallback <agents>]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_JSON="${ENSEMBLE_TEMPLATES_JSON:-$REPO_DIR/collab-templates.json}"

if [ ! -r "$TEMPLATES_JSON" ]; then
  if [ -n "$FALLBACK" ]; then printf '%s\n' "$FALLBACK"; exit 0; fi
  echo "Templates file not readable: $TEMPLATES_JSON" >&2
  exit 1
fi

# Use python3 (already required elsewhere in collab-launch.sh) for safe JSON
# parsing — avoids fragile sed/grep that breaks on escaped quotes etc.
RESULT=$(TEMPLATES_JSON="$TEMPLATES_JSON" TPL="$TEMPLATE" python3 - <<'PY'
import json, os, sys
try:
    with open(os.environ['TEMPLATES_JSON']) as f:
        d = json.load(f)
    tpl = d.get('templates', {}).get(os.environ['TPL'], {})
    val = (tpl.get('default_agents') or '').strip()
    if val:
        print(val)
        sys.exit(0)
    sys.exit(3)  # template found but no default_agents
except KeyError:
    sys.exit(4)  # template not found
except Exception as e:
    print(f'parse error: {e}', file=sys.stderr)
    sys.exit(5)
PY
) || RC=$?
RC=${RC:-0}

if [ "$RC" -eq 0 ] && [ -n "$RESULT" ]; then
  printf '%s\n' "$RESULT"
  exit 0
fi

if [ -n "$FALLBACK" ]; then
  printf '%s\n' "$FALLBACK"
  exit 0
fi

exit "$RC"
