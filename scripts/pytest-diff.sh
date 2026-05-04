#!/usr/bin/env bash
# pytest-diff.sh — run pytest scoped to changed *.py files.
#
# Mirrors the W2.5j vitest-changed pattern + the original ruff diff-scope:
# we only fire the gate against tests that touch this branch's changes,
# not the full suite (which would fail on pre-existing master debt and
# block every collab unrelated to those failures).
#
# Selection logic:
#   1. Collect changed *.py files (git diff HEAD + untracked git ls-files).
#   2. Direct test files (test_*.py / *_test.py) → run those.
#   3. Source files → derive matching test files (test_<basename>.py /
#      <basename>_test.py) via repo-wide find.
#   4. If no targets resolve → fall back to `pytest --collect-only` as a
#      smoke check: proves pytest can still discover, no regression test.
#
# Usage:
#   pytest-diff.sh                 # auto-discover, scoped run
#   pytest-diff.sh --debug         # also echo the resolved target list
#
# Exit code = pytest exit code. If git is unavailable, falls back to
# the smoke check (collect-only) and surfaces its exit.
set -o pipefail

DEBUG=0
case "${1:-}" in
  --debug) DEBUG=1 ;;
esac

# 1. Collect changed *.py files from this branch.
changed=$(
  { git diff HEAD --name-only --diff-filter=ACMR -- '*.py' 2>/dev/null
    git ls-files --others --exclude-standard -- '*.py' 2>/dev/null
  } | sort -u
)

# 2. Split into direct test files vs source files.
test_files=$(printf '%s\n' "$changed" | grep -E '(^|/)(test_[^/]+\.py$|[^/]+_test\.py$)' || true)
src_files=$(printf '%s\n' "$changed" | grep -vE '(^|/)(test_[^/]+\.py$|[^/]+_test\.py$)' | grep -E '\.py$' || true)

# 3. For each source file, find matching test files.
derived=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  base=$(basename "$f" .py)
  # find tests that match this module name; skip vendor/build dirs.
  found=$(find . \
    -path './.venv' -prune -o \
    -path './venv' -prune -o \
    -path './node_modules' -prune -o \
    -path './.worktrees' -prune -o \
    -path './.git' -prune -o \
    -path './dist' -prune -o \
    -path './build' -prune -o \
    \( -name "test_${base}.py" -o -name "${base}_test.py" \) -print 2>/dev/null \
    | head -20)
  if [ -n "$found" ]; then
    derived="${derived}${found}"$'\n'
  fi
done <<<"$src_files"

# 4. Combine + dedupe.
targets=$(printf '%s\n%s\n' "$test_files" "$derived" | sort -u | grep -v '^$' || true)

if [ -z "$targets" ]; then
  echo '[pytest-diff] no changed test/source files — running smoke (--collect-only)'
  pytest --collect-only -q -m 'not e2e and not slow' 2>&1 | tail -10
  exit $?
fi

if [ "$DEBUG" = "1" ]; then
  echo '[pytest-diff] scoped to:'
  echo "$targets" | sed 's/^/  /'
fi

# shellcheck disable=SC2086 # intentional word-splitting on $targets
pytest -q --no-header -x --maxfail=3 -m 'not e2e and not slow' $targets
