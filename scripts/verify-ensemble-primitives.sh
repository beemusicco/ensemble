#!/usr/bin/env bash
# verify-ensemble-primitives.sh — drift detector for shipped primitives.
#
# Ensembe wave W3 (2026-05-04) shipped 3 primitives that future commits
# could regress without anyone noticing — a `git revert` or partial
# refactor could quietly remove the operator-hold flag, switch pytest
# back to full-suite, or strip the question-tag guidance from prompts.
#
# This drift detector locks all three by checking lib + tests directly.
# Runs in <1s so it can sit in CI / pre-commit cheaply.
#
# Exits 0 if all primitives intact. Exits 1 with a list of missing pieces
# if any check fails. Re-run after the underlying issue is fixed.
#
# Usage:
#   bash scripts/verify-ensemble-primitives.sh
#   bash scripts/verify-ensemble-primitives.sh --json    # machine-readable
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

JSON=0
case "${1:-}" in
  --json) JSON=1 ;;
esac

failures=()
ok=()

check() {
  local name="$1" cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    ok+=("$name")
  else
    failures+=("$name")
  fi
}

# ── Primitive 1: operator-hold ────────────────────────────────────────
check "hold:detector-exists" "test -f $ROOT/lib/operator-hold.ts"
check "hold:detector-exports-detect" "grep -q 'export function detectOperatorHold' $ROOT/lib/operator-hold.ts"
check "hold:detector-exports-release" "grep -q 'export function isReleaseHoldRequest' $ROOT/lib/operator-hold.ts"
check "hold:slovenian-patterns" "grep -q 'si:ne-disband' $ROOT/lib/operator-hold.ts && grep -q 'si:mirujte' $ROOT/lib/operator-hold.ts"
check "hold:english-patterns" "grep -q 'en:do-not-disband' $ROOT/lib/operator-hold.ts && grep -q 'en:wait-for-human' $ROOT/lib/operator-hold.ts"
check "hold:type-on-team" "grep -q 'holdForOperator' $ROOT/types/ensemble.ts"
check "hold:type-on-request" "grep -A20 'CreateTeamRequest' $ROOT/types/ensemble.ts | grep -q 'holdForOperator'"
check "hold:wired-in-createTeam" "grep -q 'detectOperatorHold' $ROOT/lib/ensemble-registry.ts"
check "hold:wired-in-signalComplete" "grep -A30 'export async function signalCompleteTeam' $ROOT/services/ensemble-service.ts | grep -q 'holdForOperator'"
check "hold:suppress-helper-defined" "grep -q 'function logHoldSuppression' $ROOT/services/ensemble-service.ts"
check "hold:wired-in-idle-tax" "grep -q \"logHoldSuppression(team, 'idle-tax'\" $ROOT/services/ensemble-service.ts"
check "hold:wired-in-ready-to-merge" "grep -q \"logHoldSuppression(\$\\?\\s*\\?team, 'ready-to-merge'\" $ROOT/services/ensemble-service.ts || grep -q \"'ready-to-merge'\" $ROOT/services/ensemble-service.ts && grep -q 'logHoldSuppression' $ROOT/services/ensemble-service.ts"
check "hold:wired-in-standing-by" "grep -q \"'standing-by'\" $ROOT/services/ensemble-service.ts"
check "hold:release-endpoint" "grep -q '/release-hold' $ROOT/server.ts"
check "hold:release-mcp-tool" "grep -q 'ensemble_release_hold' $ROOT/lib/mcp-server.ts"
check "hold:tests-detector" "test -f $ROOT/tests/operator-hold.test.ts"
check "hold:tests-integration" "grep -q 'operator-hold suppression' $ROOT/tests/ensemble.test.ts"

# ── Primitive 2: pytest diff-scope ────────────────────────────────────
check "pytest-diff:script-exists" "test -x $ROOT/scripts/pytest-diff.sh"
check "pytest-diff:wired-in-config" "grep -q 'pytest-diff.sh' $ROOT/lib/bulletproof-config.ts"
check "pytest-diff:id-renamed" "grep -q 'pytest-diff' $ROOT/lib/bulletproof-config.ts"
check "pytest-diff:no-old-fullsuite" "! grep -q \"id: \\\`pytest\\\${idSuffix}\\\`\" $ROOT/lib/bulletproof-config.ts"
check "pytest-diff:script-uses-git-diff" "grep -q 'git diff HEAD --name-only' $ROOT/scripts/pytest-diff.sh"
check "pytest-diff:script-skips-vendor" "grep -q '\\.venv\\|node_modules\\|\\.worktrees' $ROOT/scripts/pytest-diff.sh"
check "pytest-diff:script-collect-fallback" "grep -q -- '--collect-only' $ROOT/scripts/pytest-diff.sh"
check "pytest-diff:tests-exist" "test -f $ROOT/tests/pytest-diff.test.ts"

# ── Primitive 3: [QUESTION] tag tightening ────────────────────────────
check "question:cost-warning-in-prompt" "grep -q '\\[QUESTION\\] is COSTLY' $ROOT/services/ensemble-service.ts"
check "question:do-not-use-block" "grep -q 'DO NOT use \\[QUESTION\\]' $ROOT/services/ensemble-service.ts"
check "question:silence-not-greenlight" "grep -q \"operator.s silence is not a green light\" $ROOT/services/ensemble-service.ts"

# ── Primitive 4: auto-learn (self-upgrading learning loop) ────────────
check "auto-learn:module-exists" "test -f $ROOT/lib/auto-learn.ts"
check "auto-learn:exports-record-failure" "grep -q 'export function recordFailureLearning' $ROOT/lib/auto-learn.ts"
check "auto-learn:exports-record-confab" "grep -q 'export function recordConfabLearning' $ROOT/lib/auto-learn.ts"
check "auto-learn:exports-weight" "grep -q 'export function weightLearning' $ROOT/lib/auto-learn.ts"
check "auto-learn:tag-constants" "grep -q 'FAILURE_PATTERN' $ROOT/lib/auto-learn.ts && grep -q 'CONFAB_PATTERN' $ROOT/lib/auto-learn.ts"
check "auto-learn:wired-failure-hook" "grep -q 'recordFailureLearning(' $ROOT/lib/staged-workflow.ts"
check "auto-learn:wired-confab-hook" "grep -q 'recordConfabLearning(' $ROOT/lib/staged-workflow.ts"
check "auto-learn:tests-exist" "test -f $ROOT/tests/auto-learn.test.ts"

# ── Primitive 5: pre-spawn pattern-memory injection ───────────────────
check "pattern-injection:imported-from-auto-learn" "grep -q 'from .*auto-learn' $ROOT/services/ensemble-service.ts"
check "pattern-injection:queries-pattern-tags" "grep -q 'patternTags' $ROOT/services/ensemble-service.ts"
check "pattern-injection:applies-weighting" "grep -q 'weightLearning(' $ROOT/services/ensemble-service.ts"
check "pattern-injection:renders-prior-team-block" "grep -q 'PRIOR-TEAM PATTERNS' $ROOT/services/ensemble-service.ts"

# ── Primitive 6: reflection default-ON ────────────────────────────────
check "reflection:default-on" "grep -F \"ENSEMBLE_REFLECTION'] !== '0'\" $ROOT/services/ensemble-service.ts"
check "reflection:vitest-skip" "grep -q 'process.env..VITEST' $ROOT/services/ensemble-service.ts"

# ── Output ────────────────────────────────────────────────────────────
total=$(( ${#ok[@]} + ${#failures[@]} ))
if [ "$JSON" = "1" ]; then
  printf '{"total":%d,"passed":%d,"failed":%d,"failures":[' "$total" "${#ok[@]}" "${#failures[@]}"
  first=1
  for f in "${failures[@]}"; do
    [ "$first" = "0" ] && printf ','
    printf '"%s"' "$f"
    first=0
  done
  printf ']}\n'
else
  if [ "${#failures[@]}" -eq 0 ]; then
    printf '✅ All %d primitive checks passed.\n' "$total"
  else
    printf '❌ %d/%d primitive checks failed:\n' "${#failures[@]}" "$total"
    for f in "${failures[@]}"; do
      printf '   • %s\n' "$f"
    done
    printf '\n%d passed:\n' "${#ok[@]}"
    for o in "${ok[@]}"; do
      printf '   ✓ %s\n' "$o"
    done
  fi
fi

[ "${#failures[@]}" -eq 0 ]
