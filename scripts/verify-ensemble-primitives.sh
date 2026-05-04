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

# ── Primitive 7: cross-agent overlap detection (premium-quad coordination) ──
check "overlap:detector-exported" "grep -q 'export async function detectCrossAgentOverlap' $ROOT/lib/worktree-manager.ts"
check "overlap:type-exported" "grep -q 'export interface CrossAgentOverlap' $ROOT/lib/worktree-manager.ts"
check "overlap:wired-in-disband" "grep -q 'detectCrossAgentOverlap(' $ROOT/services/ensemble-service.ts"
check "overlap:emits-structured-alert" "grep -q \"event: 'cross_agent_overlap'\" $ROOT/services/ensemble-service.ts"
check "overlap:writes-failure-learning" "grep -q \"gateId: 'cross-agent-overlap'\" $ROOT/services/ensemble-service.ts"
check "overlap:tests-exist" "test -f $ROOT/tests/cross-agent-overlap.test.ts"

# ── Primitive 8: forward-bias autonomous overlap resolver (W5) ───────
check "fwd-bias:classifier-exported" "grep -q 'export async function classifyAgentBranch' $ROOT/lib/worktree-manager.ts"
check "fwd-bias:resolver-exported" "grep -q 'export function resolveOverlapByForwardBias' $ROOT/lib/worktree-manager.ts"
check "fwd-bias:detects-revert-subject" "grep -q 'Revert\\\\s' $ROOT/lib/worktree-manager.ts"
check "fwd-bias:detects-revert-body" "grep -q 'This reverts commit' $ROOT/lib/worktree-manager.ts"
check "fwd-bias:close-call-margin" "grep -q '0.2' $ROOT/lib/worktree-manager.ts"
check "fwd-bias:wired-in-disband" "grep -q 'resolveOverlapByForwardBias(' $ROOT/services/ensemble-service.ts"
check "fwd-bias:operator-opt-out-env" "grep -q 'ENSEMBLE_AUTONOMOUS_MERGE' $ROOT/services/ensemble-service.ts"
check "fwd-bias:tests-exist" "test -f $ROOT/tests/forward-bias-resolver.test.ts"

# ── Primitive 9: alien-thinking template DEPLOYS INVENTION-PROTOCOL ──
# Each role must reference INVENTION-PROTOCOL.md AND name specific tools
# (Pre-mortem, Via Negativa, Ideal Final Result, etc.) — not just gesture.
check "alien:references-protocol-file" "grep -q 'INVENTION-PROTOCOL.md' $ROOT/collab-templates.json"
check "alien:diverger-deploys-reframe" "grep -q 'REFRAME the problem 5' $ROOT/collab-templates.json"
check "alien:diverger-deploys-inversion" "grep -q 'INVERSION' $ROOT/collab-templates.json"
check "alien:diverger-deploys-forcing-functions" "grep -q 'FORCING FUNCTIONS' $ROOT/collab-templates.json"
check "alien:connector-deploys-ideal-final-result" "grep -q 'IDEAL FINAL RESULT' $ROOT/collab-templates.json"
check "alien:connector-deploys-contradiction-resolution" "grep -q 'CONTRADICTION RESOLUTION' $ROOT/collab-templates.json"
check "alien:converger-deploys-pre-mortem" "grep -q 'PRE-MORTEM' $ROOT/collab-templates.json"
check "alien:converger-deploys-via-negativa" "grep -q 'VIA NEGATIVA' $ROOT/collab-templates.json"
check "alien:converger-deploys-second-order" "grep -q 'SECOND-ORDER' $ROOT/collab-templates.json"
check "alien:converger-deploys-10x-test" "grep -q '10X TEST' $ROOT/collab-templates.json"
check "alien:keyword-invent" "grep -q 'invent' $ROOT/scripts/collab-launch.sh"
check "alien:keyword-iznajdi" "grep -q 'iznajd' $ROOT/scripts/collab-launch.sh"
check "alien:priority-before-quad" "awk \"/printf 'alien-thinking'/{a=NR} /printf 'premium-quad'/{q=NR} END{exit (a<q && a>0) ? 0 : 1}\" $ROOT/scripts/collab-launch.sh"

# ── Primitive 10: auto-rescue (W6) ────────────────────────────────────
check "rescue:queries-memory-on-exhausted" "grep -q 'queryMemoriesSemantic' $ROOT/lib/staged-workflow.ts"
check "rescue:emits-rescue-text" "grep -q 'Auto-rescue' $ROOT/lib/staged-workflow.ts"
check "rescue:meta-flag-set" "grep -q 'autoRescueOffered' $ROOT/lib/staged-workflow.ts"

# ── Primitive 11: calibration → role assignment (W6) ──────────────────
check "role:fn-exported" "grep -q 'export function recommendRoleAssignments' $ROOT/lib/calibration.ts"
check "role:has-min-samples-guard" "grep -q 'minSamples' $ROOT/lib/calibration.ts"
check "role:has-epsilon-greedy" "grep -q 'epsilon' $ROOT/lib/calibration.ts"
check "role:role-scoring-rules" "grep -q 'ROLE_SCORING' $ROOT/lib/calibration.ts"
check "role:tests-exist" "test -f $ROOT/tests/role-assignment.test.ts"

# ── Primitive 12: Cognee KG bridge (W6) ───────────────────────────────
check "cognee:module-exists" "test -f $ROOT/lib/cognee-bridge.ts"
check "cognee:env-gated" "grep -q 'ENSEMBLE_USE_KG' $ROOT/lib/cognee-bridge.ts"
check "cognee:graceful-degrade" "grep -q 'fetchWithTimeout' $ROOT/lib/cognee-bridge.ts"
check "cognee:wired-in-spawn" "grep -q 'cognee.searchGraph' $ROOT/services/ensemble-service.ts"
check "cognee:tests-exist" "test -f $ROOT/tests/cognee-bridge.test.ts"
check "cognee:writeback-on-disband" "grep -q 'kg_writeback' $ROOT/services/ensemble-service.ts"

# ── Primitive 13: rescue agent spawn (W7) ─────────────────────────────
check "rescue-spawn:fn-exported" "grep -q 'export async function rescueFailingTeam' $ROOT/services/ensemble-service.ts"
check "rescue-spawn:env-gate" "grep -q 'ENSEMBLE_AUTO_RESCUE_SPAWN' $ROOT/services/ensemble-service.ts"
check "rescue-spawn:cap-1-per-team" "grep -q 'rescue-already-spawned' $ROOT/services/ensemble-service.ts"
check "rescue-spawn:wired-from-staged-workflow" "grep -q 'rescueFailingTeam(' $ROOT/lib/staged-workflow.ts"
check "rescue-spawn:test-mode-short-circuit" "grep -q 'test-mode' $ROOT/services/ensemble-service.ts"

# ── Primitive 14: calibration role assignment wired (W7) ──────────────
check "role-wired:applyCalibrationRoleAssignment" "grep -q 'applyCalibrationRoleAssignment' $ROOT/services/ensemble-service.ts"
check "role-wired:roleClassForCalibration" "grep -q 'roleClassForCalibration' $ROOT/services/ensemble-service.ts"
check "role-wired:env-opt-out" "grep -q 'ENSEMBLE_CALIBRATION_ROLE_ASSIGN' $ROOT/services/ensemble-service.ts"
check "role-wired:emits-feed-msg" "grep -q 'calibration_role_assignment' $ROOT/services/ensemble-service.ts"
check "role-wired:tests-exist" "test -f $ROOT/tests/w7-integration.test.ts"

# ── Primitive 15: Cognee auth (W7.1) ──────────────────────────────────
check "cognee-auth:fetchAuthToken-exists" "grep -q 'fetchAuthToken' $ROOT/lib/cognee-bridge.ts"
check "cognee-auth:env-credentials" "grep -q 'ENSEMBLE_KG_USER' $ROOT/lib/cognee-bridge.ts && grep -q 'ENSEMBLE_KG_PASS' $ROOT/lib/cognee-bridge.ts"
check "cognee-auth:401-retry" "grep -q '401' $ROOT/lib/cognee-bridge.ts"
check "cognee-auth:bearer-header" "grep -q 'Bearer' $ROOT/lib/cognee-bridge.ts"

# ── Primitive 16: memory GC primitive (W7.1) ──────────────────────────
check "memory-gc:module-exists" "test -f $ROOT/lib/memory-gc.ts"
check "memory-gc:declarative-rules" "grep -q 'DEFAULT_RETENTION_RULES' $ROOT/lib/memory-gc.ts"
check "memory-gc:resolution-forever" "grep -q \"tagPattern: 'resolution'\" $ROOT/lib/memory-gc.ts"
check "memory-gc:override-file-support" "grep -q 'memory-retention.json' $ROOT/lib/memory-gc.ts"
check "memory-gc:script-runnable" "test -x $ROOT/scripts/memory-gc.ts"
check "memory-gc:cron-plist" "test -f $ROOT/launchd/co.openclaw.ensemble-memory-gc.plist.template"
check "memory-gc:tests-exist" "test -f $ROOT/tests/memory-gc.test.ts"

# ── Primitive 17: confidence-tracker (W8 calibrated forecasting) ─────
check "confidence:module-exists" "test -f $ROOT/lib/confidence-tracker.ts"
check "confidence:parse-fn-exported" "grep -q 'export function parseConfidenceClaims' $ROOT/lib/confidence-tracker.ts"
check "confidence:record-fn-exported" "grep -q 'export function recordConfidenceClaim' $ROOT/lib/confidence-tracker.ts"
check "confidence:resolve-fn-exported" "grep -q 'export function resolveClaimOutcome' $ROOT/lib/confidence-tracker.ts"
check "confidence:calibration-fn-exported" "grep -q 'export function computeCalibration' $ROOT/lib/confidence-tracker.ts"
check "confidence:wired-in-prompt" "grep -q 'computeConfidenceCalibration' $ROOT/services/ensemble-service.ts"
check "confidence:tag-in-learn-on-demand" "grep -q 'CONFIDENCE: N%' $ROOT/services/ensemble-service.ts"
check "confidence:scan-from-watcher" "grep -q 'scanAndPersistClaims' $ROOT/lib/unknown-watcher.ts"
check "confidence:resolve-script" "test -x $ROOT/scripts/resolve-claim.ts"
check "confidence:tests-exist" "test -f $ROOT/tests/confidence-tracker.test.ts"

# ── Primitive 18: hypothesis-test template (W8 Popperian) ────────────
check "hypothesis:template-exists" "grep -q '\"hypothesis-test\":' $ROOT/collab-templates.json"
check "hypothesis:has-three-roles" "python3 -c 'import json; t=json.load(open(\"$ROOT/collab-templates.json\"))[\"templates\"][\"hypothesis-test\"]; assert len(t[\"roles\"])==3, t[\"roles\"]'"
check "hypothesis:hypothesizer-role" "grep -q '\"role\": \"HYPOTHESIZER\"' $ROOT/collab-templates.json"
check "hypothesis:falsifier-role" "grep -q '\"role\": \"FALSIFIER\"' $ROOT/collab-templates.json"
check "hypothesis:runner-role" "grep -q '\"role\": \"RUNNER\"' $ROOT/collab-templates.json"
check "hypothesis:keyword-detection" "grep -q 'hypothesis.test\\|falsify\\|hipotez' $ROOT/scripts/collab-launch.sh"

# ── Primitive 19: counterfactual mandate (W8 rigorous mode addition) ─
check "counterfactual:in-rigorous-block" "grep -q 'COUNTERFACTUAL MANDATE' $ROOT/services/ensemble-service.ts"
check "counterfactual:requires-Y-alternative" "grep -q 'strongest alternative' $ROOT/services/ensemble-service.ts"
check "counterfactual:requires-confidence-tag" "grep -q 'X wins on metric' $ROOT/services/ensemble-service.ts"

# ── Primitive 20: monte-carlo template (W9) ────────────────────────
check "mc:template-exists" "grep -q '\"monte-carlo\":' $ROOT/collab-templates.json"
check "mc:has-four-roles" "python3 -c 'import json; t=json.load(open(\"$ROOT/collab-templates.json\"))[\"templates\"][\"monte-carlo\"]; assert len(t[\"roles\"])==4'"
check "mc:has-modeler" "grep -q '\"role\": \"MODELER\"' $ROOT/collab-templates.json"
check "mc:has-simulator" "grep -q '\"role\": \"SIMULATOR\"' $ROOT/collab-templates.json"
check "mc:has-analyst" "grep -q '\"role\": \"ANALYST\"' $ROOT/collab-templates.json"
check "mc:has-critic" "grep -q '\"role\": \"CRITIC\"' $ROOT/collab-templates.json"
check "mc:keyword-detection" "grep -q 'monte.carlo\\|simulir' $ROOT/scripts/collab-launch.sh"

# ── Primitive 21: causal-dag template (W9) ─────────────────────────
check "causal:template-exists" "grep -q '\"causal-dag\":' $ROOT/collab-templates.json"
check "causal:has-three-roles" "python3 -c 'import json; t=json.load(open(\"$ROOT/collab-templates.json\"))[\"templates\"][\"causal-dag\"]; assert len(t[\"roles\"])==3'"
check "causal:has-dag-builder" "grep -q '\"role\": \"DAG-BUILDER\"' $ROOT/collab-templates.json"
check "causal:has-confounder-hunter" "grep -q '\"role\": \"CONFOUNDER-HUNTER\"' $ROOT/collab-templates.json"
check "causal:has-intervention-designer" "grep -q '\"role\": \"INTERVENTION-DESIGNER\"' $ROOT/collab-templates.json"
check "causal:keyword-detection" "grep -q 'causal.analy\\|confounder' $ROOT/scripts/collab-launch.sh"

# ── Primitive 22: reference-class template (W9) ────────────────────
check "rcf:template-exists" "grep -q '\"reference-class\":' $ROOT/collab-templates.json"
check "rcf:has-three-roles" "python3 -c 'import json; t=json.load(open(\"$ROOT/collab-templates.json\"))[\"templates\"][\"reference-class\"]; assert len(t[\"roles\"])==3'"
check "rcf:has-class-finder" "grep -q '\"role\": \"CLASS-FINDER\"' $ROOT/collab-templates.json"
check "rcf:has-base-rate-computer" "grep -q '\"role\": \"BASE-RATE-COMPUTER\"' $ROOT/collab-templates.json"
check "rcf:has-adjuster" "grep -q '\"role\": \"ADJUSTER\"' $ROOT/collab-templates.json"
check "rcf:keyword-detection" "grep -q 'reference.class\\|base.rate\\|napoved' $ROOT/scripts/collab-launch.sh"

# ── Primitive 23: FMEA structure embedded in alien-thinking ────────
check "fmea:in-alien-thinking" "grep -q 'FMEA' $ROOT/collab-templates.json"
check "fmea:has-rpn" "grep -q 'RPN' $ROOT/collab-templates.json"

# ── Primitive 24: Base-rate check embedded in hypothesis-test ──────
check "base-rate:in-hypothesis-test" "grep -q 'BASE RATE' $ROOT/collab-templates.json"
check "base-rate:references-kahneman" "grep -q 'Kahneman outside view' $ROOT/collab-templates.json"

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
