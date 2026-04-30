#!/usr/bin/env bash
# memory-consolidate — wrapper around the consolidation pass.
# Usage:
#   memory-consolidate            # dry-run report
#   memory-consolidate --apply    # commit merges (deletes originals)
#   memory-consolidate --json     # JSON output
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"
exec npx tsx cli/memory-consolidate.ts "$@"
