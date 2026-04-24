#!/usr/bin/env bash
# team-think — Structured thinking protocol for collab teams.
#
# Subcommands:
#   phase <team-id> <agent> <frame|evidence|synthesis|action|verify|reflect>
#   hypothesize <team-id> <agent> <id> <confidence low|med|high> "<statement>"
#   evidence <team-id> <agent> <hypothesis-id> "<data>" [source-ref]
#   challenge <team-id> <agent> <target-id> "<why-it-might-be-wrong>"
#   decide <team-id> <agent> <picked-hypothesis-id> "<reasoning>"
#   reflect <team-id> <agent> "<learning>" [--tags=a,b]
#
# Each emits a typed message so history + supervisor can reason about structure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header)"
API="${ENSEMBLE_URL:-http://localhost:23000}"

post_typed() {
  local team_id="$1" from="$2" content="$3" type="$4" meta_json="$5"
  local payload
  payload=$(CONTENT="$content" FROM="$from" TYPE="$type" META="$meta_json" python3 -c '
import json, os
body = {
  "from": os.environ["FROM"],
  "to": "team",
  "content": os.environ["CONTENT"],
  "type": os.environ["TYPE"],
}
meta_raw = os.environ.get("META", "").strip()
if meta_raw and meta_raw != "{}":
  body["meta"] = json.loads(meta_raw)
print(json.dumps(body))
')
  curl -sf -X POST "$API/api/ensemble/teams/$team_id" \
    -H "Content-Type: application/json" -H "$AUTH_HDR" \
    -d "$payload" > /dev/null
}

SUB="${1:-help}"
shift || true

case "$SUB" in
  phase)
    TID="${1:?Usage: team-think phase <team-id> <agent> <phase-name>}"
    FROM="${2:?agent required}"
    PHASE="${3:?phase required}"
    case "$PHASE" in
      frame|evidence|synthesis|action|verify|reflect) ;;
      *) echo "invalid phase: $PHASE (must be frame|evidence|synthesis|action|verify|reflect)" >&2; exit 2 ;;
    esac
    post_typed "$TID" "$FROM" "[PHASE] $PHASE" "phase" "{\"phase\":\"$PHASE\"}"
    echo "[team-think] phase -> $PHASE"
    ;;

  hypothesize)
    TID="${1:?Usage: team-think hypothesize <team-id> <agent> <id> <confidence> <statement>}"
    FROM="${2:?agent required}"
    HID="${3:?hypothesis id required (e.g. H1)}"
    CONF="${4:?confidence required: low|medium|high}"
    shift 4
    STATEMENT="$*"
    [ -n "$STATEMENT" ] || { echo "statement required" >&2; exit 2; }
    case "$CONF" in low|medium|high) ;; *) echo "confidence must be low|medium|high" >&2; exit 2 ;; esac
    META=$(HID="$HID" CONF="$CONF" python3 -c 'import json,os; print(json.dumps({"hypothesisId":os.environ["HID"],"confidence":os.environ["CONF"]}))')
    post_typed "$TID" "$FROM" "[H:$HID conf=$CONF] $STATEMENT" "hypothesis" "$META"
    echo "[team-think] hypothesis $HID ($CONF) registered"
    ;;

  evidence)
    TID="${1:?Usage: team-think evidence <team-id> <agent> <hypothesis-id> <data> [source]}"
    FROM="${2:?agent required}"
    HID="${3:?hypothesis-id required}"
    shift 3
    DATA="${1:?data required}"
    SRC="${2:-unspecified}"
    META=$(HID="$HID" SRC="$SRC" python3 -c 'import json,os; print(json.dumps({"hypothesisId":os.environ["HID"],"source":os.environ["SRC"]}))')
    post_typed "$TID" "$FROM" "[E:$HID src=$SRC] $DATA" "evidence" "$META"
    echo "[team-think] evidence for $HID posted"
    ;;

  challenge)
    TID="${1:?Usage: team-think challenge <team-id> <agent> <target-id> <reason>}"
    FROM="${2:?agent required}"
    TARGET="${3:?target-id required}"
    shift 3
    REASON="$*"
    [ -n "$REASON" ] || { echo "reason required" >&2; exit 2; }
    META=$(TARGET="$TARGET" python3 -c 'import json,os; print(json.dumps({"targetId":os.environ["TARGET"]}))')
    post_typed "$TID" "$FROM" "[CHALLENGE:$TARGET] $REASON" "challenge" "$META"
    echo "[team-think] challenge on $TARGET posted"
    ;;

  decide)
    TID="${1:?Usage: team-think decide <team-id> <agent> <picked-id> <reasoning>}"
    FROM="${2:?agent required}"
    PICKED="${3:?picked-id required}"
    shift 3
    REASONING="$*"
    [ -n "$REASONING" ] || { echo "reasoning required" >&2; exit 2; }
    META=$(PICKED="$PICKED" python3 -c 'import json,os; print(json.dumps({"hypothesisId":os.environ["PICKED"]}))')
    post_typed "$TID" "$FROM" "[DECIDE:$PICKED] $REASONING" "decision_pick" "$META"
    echo "[team-think] decision: picked $PICKED"
    ;;

  reflect)
    TID="${1:?Usage: team-think reflect <team-id> <agent> <learning> [--tags=a,b]}"
    FROM="${2:?agent required}"
    shift 2
    TAGS=""
    LEARNING=""
    for arg in "$@"; do
      case "$arg" in
        --tags=*) TAGS="${arg#--tags=}" ;;
        *) LEARNING="$LEARNING $arg" ;;
      esac
    done
    LEARNING="${LEARNING# }"
    [ -n "$LEARNING" ] || { echo "learning required" >&2; exit 2; }
    META=$(TAGS="$TAGS" python3 -c '
import json, os
tags = [t.strip() for t in os.environ.get("TAGS","").split(",") if t.strip()]
print(json.dumps({"tags": tags}))
')
    post_typed "$TID" "$FROM" "$LEARNING" "reflect" "$META"
    echo "[team-think] reflection saved (auto-persisted to global memory)"
    ;;

  help|--help|-h|*)
    cat <<EOF
team-think — structured thinking protocol for collab teams

Subcommands:
  phase <tid> <agent> <frame|evidence|synthesis|action|verify|reflect>
  hypothesize <tid> <agent> <id> <low|medium|high> "<statement>"
  evidence <tid> <agent> <hypothesis-id> "<data>" [source]
  challenge <tid> <agent> <target-id> "<why-might-be-wrong>"
  decide <tid> <agent> <picked-hypothesis-id> "<reasoning>"
  reflect <tid> <agent> "<learning>" [--tags=a,b]

Flow: frame -> hypothesize -> evidence -> synthesis -> challenge -> decide
      -> action -> verify -> reflect -> team-done

Example:
  team-think phase T1 codex-1 frame
  team-think hypothesize T1 codex-1 H1 medium "bug is in range(start,end) off-by-one"
  team-think evidence T1 codex-1 H1 "pytest failure: expected 15 got 10" --source="pytest test_sum.py -q"
  team-think phase T1 codex-1 synthesis
  team-think challenge T1 claude-2 H1 "could also be test asserting wrong value"
  team-think decide T1 codex-1 H1 "evidence in test_sum line 4 confirms inclusive intent"
EOF
    ;;
esac
