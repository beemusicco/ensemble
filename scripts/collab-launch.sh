#!/usr/bin/env bash
# collab-launch.sh — All-in-one team launcher with clean output
# Usage: collab-launch.sh <working-dir> <task-description>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=./collab-paths.sh
source "$SCRIPT_DIR/collab-paths.sh"
# shellcheck source=./ensemble-auth.sh
source "$SCRIPT_DIR/ensemble-auth.sh"
AUTH_HDR="$(ensemble_auth_header || true)"

CWD="${1:-.}"
TASK="${2:?Usage: collab-launch.sh <cwd> <task>}"

# Smart CWD: if the task mentions a known project path, use that as CWD
# so agents start in the right directory with correct sandbox access.
#
# W2.5h: production observation 2026-05-01 — 4 sparring libro.si collabs
# all spawned from `~/.openclaw/tools/ensemble/` cwd because operator was
# patching ensemble at the time. workingDirectory got recorded as ensemble
# itself → confab guard searched wrong tree (29 false positives), npm-test
# ran ensemble's package.json (always failed), auto-merge was a no-op
# (worktrees in ensemble dir, agents wrote directly to accounting-helper
# master). Original Smart CWD detection only matched the candidate's
# BASENAME against the task — "libro.si" doesn't contain "accounting-helper",
# so detection missed.
#
# Expanded keyword aliases below cover Slovenian + product-name forms.
# Detection happens when CWD is `.`, ensemble dir, or any tool dir under
# ~/.openclaw/tools/.
PROJECT_PARENTS=(
  "$HOME/projects"
  "$HOME/.openclaw/workspace/skills"
  "$HOME/.openclaw/workspace"
)

# Read project-declared keywords from .collab-tools.md.
# Supports two formats (operator picks):
#   • HTML comment:   <!-- collab-keywords: kw1, kw2, kw3 -->
#                     (invisible in rendered markdown — recommended)
#   • Plain line:     keywords: kw1, kw2, kw3
#                     (visible in doc, simpler to author)
#
# Resolution: operator-config dir wins over repo-root (matches W2.5b
# project-config resolver).
project_keywords() {
  local proj="$1"
  local basename
  basename=$(basename "$proj" | tr '[:upper:]' '[:lower:]')
  # Always include the basename itself
  local result="$basename"

  local f
  for f in \
    "$HOME/.openclaw/collab-config/$basename/.collab-tools.md" \
    "$proj/.collab-tools.md"; do
    [ -f "$f" ] || continue
    # Match HTML comment OR plain line. Take everything between the
    # marker and end-of-line (or -->), then split on commas.
    local extracted
    extracted=$(
      {
        grep -oE '<!--[[:space:]]*collab-keywords:[^>]*-->' "$f" 2>/dev/null \
          | sed 's|<!--[[:space:]]*collab-keywords:[[:space:]]*||; s|[[:space:]]*-->||'
        grep -iE '^[[:space:]]*(keywords|collab-keywords|aliases):' "$f" 2>/dev/null \
          | sed 's/^[^:]*:[[:space:]]*//'
      } | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$'
    )
    if [ -n "$extracted" ]; then
      local pipe_kw
      pipe_kw=$(echo "$extracted" | tr '\n' '|' | tr '[:upper:]' '[:lower:]')
      result="${result}|${pipe_kw%|}"
    fi
    break  # first hit wins (operator-config priority)
  done

  printf '%s' "$result"
}

# Resolve $COLLAB_PROJECT (env override) to an absolute project path.
# Accepts:
#   • Absolute path that exists
#   • Basename matching a directory under any parent in PROJECT_PARENTS
resolve_collab_project_env() {
  local arg="$1"
  [ -z "$arg" ] && return 1
  if [ -d "$arg" ]; then
    printf '%s' "$(cd "$arg" && pwd)"; return 0
  fi
  local parent
  for parent in "${PROJECT_PARENTS[@]}"; do
    if [ -d "$parent/$arg" ]; then
      printf '%s' "$parent/$arg"; return 0
    fi
  done
  return 1
}

detect_project_from_task() {
  local task_lower
  task_lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')

  # ── Tier 0: COLLAB_PROJECT env override (highest priority) ──
  if [ -n "${COLLAB_PROJECT:-}" ]; then
    if resolved="$(resolve_collab_project_env "$COLLAB_PROJECT")"; then
      printf '%s' "$resolved"; return 0
    fi
    echo "❌ COLLAB_PROJECT='$COLLAB_PROJECT' didn't resolve to a directory" >&2
    return 1
  fi

  # ── Tier 1: hardcoded built-in rules (Slovenian roots + product features) ──
  # Covers product-specific vocabulary that wouldn't appear in basename or
  # auto-derived keywords. First match wins; keep most-specific terms first.
  # This is the "shipping defaults" — for projects you control, prefer
  # Tier 2 (.collab-tools.md keywords) over editing this list.
  local rules=(
    'libro\.si|libro\b|accounting.helper|cost.allocat|alembic|postmark|invoice.intake|sepa.xml|minimax|gocardless|onedrive|sharepoint|cloud.intake|intake.račun|tenant_id|/libro|brainainstein.*libro|računovod|fakturir|tcg.invest|tate.trade|zvezdar|potcg|analitič|cost.allocation.suggester|monthly.close|bulk.approve|invoice.dispatch|file.hash.duplicate|graph.api.intake'
    "$HOME/projects/accounting-helper"
    'crypto.trading|crypto.trade|paper.trader|backtest|crypto.strateg|alphas|edge.classifier|kill.list|paper_trades|hyperliquid|deribit|funding.rate|exchange.fee'
    "$HOME/.openclaw/workspace/skills/crypto-trading-platform"
    'brainai.dashboard|/dashboard|task.queue|agent.queue'
    "$HOME/projects/brainai-dashboard"
    'tcg.price.tracker|tcg.scrap|tcg.invest|pokemon.cards'
    "$HOME/.openclaw/workspace/skills/tcg-price-tracker"
    'cs2.bett|counter.strike.bett'
    "$HOME/.openclaw/workspace/skills/cs2-betting"
  )
  local i=0
  while [ $i -lt ${#rules[@]} ]; do
    local pattern="${rules[$i]}"
    local path="${rules[$((i+1))]}"
    if echo "$task_lower" | grep -qE "$pattern" && [ -d "$path" ]; then
      printf '%s' "$path"; return 0
    fi
    i=$((i+2))
  done

  # ── Tier 2: per-project declared keywords + basename match ──
  # The bulletproof path for FUTURE projects: drop the project under any
  # known parent (~/projects, ~/.openclaw/workspace/skills) and either:
  #   (a) Add `<!-- collab-keywords: kw1, kw2 -->` to .collab-tools.md
  #   (b) Skip declaration → falls back to basename-only match
  # Word boundaries prevent partial-token collisions.
  local parent
  for parent in "${PROJECT_PARENTS[@]}"; do
    [ -d "$parent" ] || continue
    for proj in "$parent"/*; do
      [ -d "$proj" ] || continue
      local bn
      bn=$(basename "$proj" | tr '[:upper:]' '[:lower:]')
      [ ${#bn} -lt 3 ] && continue
      local kw
      kw=$(project_keywords "$proj")
      if echo "$task_lower" | grep -qE "(^|[^a-z0-9_/.-])(${kw})([^a-z0-9_/.-]|$)"; then
        printf '%s' "$proj"; return 0
      fi
    done
  done

  return 1
}

# ── Trigger conditions for auto-correct ──
# Run detection ALWAYS, but only override CWD when:
#   • Detection found a hit AND
#   • Current CWD is NOT already that project AND
#   • Either: current CWD lacks a project signal (.git or package.json or
#     pyproject.toml) — i.e., user is in a "non-project" location like
#     ~/.openclaw/tools/ensemble or ~/Downloads
#   • OR current CWD is a known tool dir (~/.openclaw/tools/*) — operator
#     was patching tools, not the target project
#
# This way: running /collab from inside a real project dir (with .git)
# trusts that dir; running from anywhere else with a clear task hint
# routes to the right project.
cwd_has_project_signal() {
  local d="$1"
  [ -d "$d/.git" ] && return 0
  [ -f "$d/package.json" ] && return 0
  [ -f "$d/pyproject.toml" ] && return 0
  [ -f "$d/Cargo.toml" ] && return 0
  [ -f "$d/go.mod" ] && return 0
  return 1
}

cwd_abs="$(cd "$CWD" 2>/dev/null && pwd || echo "$CWD")"
is_tool_dir=0
echo "$cwd_abs" | grep -q "/.openclaw/tools/\|tools/ensemble" && is_tool_dir=1

if detected="$(detect_project_from_task "$TASK")"; then
  if [ "$cwd_abs" != "$detected" ]; then
    if [ "$is_tool_dir" = "1" ] || ! cwd_has_project_signal "$cwd_abs"; then
      echo "🎯 Smart-CWD: task references $(basename "$detected") — overriding CWD from '$cwd_abs' to '$detected'" >&2
      CWD="$detected"
    else
      # Project signal in current CWD but task references a different project.
      # Don't override silently — warn the operator that they may be in the
      # wrong dir, but trust their CWD (they might intentionally be running
      # cross-project tooling).
      echo "⚠️ Smart-CWD: task mentions $(basename "$detected") but CWD is '$cwd_abs' (has project signal). NOT overriding. Set ENSEMBLE_FORCE_DETECTED_CWD=1 to override." >&2
      if [ "${ENSEMBLE_FORCE_DETECTED_CWD:-}" = "1" ]; then
        echo "🎯 Smart-CWD: ENSEMBLE_FORCE_DETECTED_CWD=1 — overriding to '$detected'" >&2
        CWD="$detected"
      fi
    fi
  fi
else
  # No detection match. Fail loudly when CWD is a tool dir (operator was
  # patching tools, not the target project) — silently using the tool dir
  # as workingDirectory was the root cause of 4 misrouted libro.si collabs
  # (2026-05-01 production observation).
  if [ "$is_tool_dir" = "1" ] && [ -z "${ENSEMBLE_ALLOW_NO_DETECT:-}" ]; then
    cat >&2 <<EOM
❌ Could not determine target project from task description, and CWD is a
   tool directory ('$cwd_abs'). Refusing to spawn — silently using a tool
   dir as workingDirectory misroutes verify-runner, confab guard, and
   auto-merge to the wrong repo.

   Options to resolve:
   • cd into the project directory before /collab
   • COLLAB_PROJECT=<basename-or-path> /collab "<task>"
   • Add to project's .collab-tools.md:
       <!-- collab-keywords: keyword1, keyword2 -->
   • ENSEMBLE_ALLOW_NO_DETECT=1 to bypass this check (not recommended)
EOM
    exit 2
  fi
fi
# Resolve to absolute path
CWD="$(cd "$CWD" 2>/dev/null && pwd || echo "$CWD")"
AGENTS="${3:-}"  # Optional: comma-separated agent names (e.g. "gemini,claude")
TARGET_PANE="${4:-}"  # Optional: tmux pane ID for monitor split
TEMPLATE_OVERRIDE="${5:-${COLLAB_TEMPLATE:-}}"  # Optional: explicit template name (else auto-detect)
# 6th positional arg (or COLLAB_CHALLENGE env) overrides challenge mode auto-pick.
# Allowed values: normal | rigorous | sparring. Empty/anything-else falls back
# to keyword + template auto-detection.
CHALLENGE_OVERRIDE="${6:-${COLLAB_CHALLENGE:-${ENSEMBLE_CHALLENGE_MODE:-}}}"
API="http://localhost:23000"
HOST_ID="${ENSEMBLE_HOST_ID:-local}"

# ─── Template auto-detection (fixes dead expert-injection code path) ───
# Previously: no template was ever passed → buildPromptPreview fell through to
# default LEAD/WORKER instructions → expert mental-models in collab-templates.json
# (25 `expert` tags, 7 templates) NEVER loaded. 0/24 historical prompts had
# EXPERT MENTAL MODEL. Now: keyword match on task description selects template,
# user can override via env COLLAB_TEMPLATE or 5th positional arg.
detect_template() {
  local task_lower
  task_lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  if [ -n "$TEMPLATE_OVERRIDE" ]; then
    printf '%s' "$TEMPLATE_OVERRIDE"; return
  fi
  # Priority order — more specific first
  if echo "$task_lower" | grep -qE '\b(ultrareview|ultra.review|4.agent.review|security.review)\b'; then
    printf 'ultrareview'; return
  fi
  # Audit-only: read-only sweep. Triggered by explicit keyword OR by "audit"
  # combined with a no-edit signal. Used when scope is large and a bad write
  # would be expensive to revert (e.g. design-system primitive sweep).
  # Slovenian: `pregled` (read), `samo.bra` (read-only), `seznam.popravkov` (fix-list).
  if echo "$task_lower" | grep -qE '\b(audit.only|read.only.audit|read-only.sweep|fix.list|fix-list|inventory.audit)\b|\b(samo.bran|seznam.popravkov|pregled.brez)'; then
    printf 'audit-only'; return
  fi
  # Premium-quad: high-stakes work (production, irreversible, security-critical).
  # Slovenian roots are matched without trailing \b because Slovenian inflects
  # heavily — `kritično` / `kritičen` / `kritični` / `kritičnost` all share the
  # `kritičn` stem. Same for `produkcija` / `produkcijski` / `produkcijo`,
  # `nepovratno` / `nepovratni`. Word-leading boundary is preserved so we don't
  # over-match inside unrelated tokens.
  #
  # NB: `varnost` was tested and dropped — too greedy. "varnostna kopija"
  # (backup) and "raziskava o varnosti seje" (security research) are routine
  # tasks that don't need the 4-agent quad. English `security` keeps the
  # cross-language coverage; users wanting Slovenian security-critical routing
  # should write `kritičn` or `produkcij` alongside the security concern.
  if echo "$task_lower" | grep -qE '\b(premium.quad|premium quad|critical|live.trading|production.deploy|security|irreversible)\b|\b(kritičn|produkcij|nepovratn)|\bživo[. ]+trgov'; then
    printf 'premium-quad'; return
  fi
  # Pentest before adversarial — pentest is the more specific "authorized
  # security testing" pipeline (RECON → EXPLOIT → VERIFY with disclosure
  # discipline) vs. adversarial's general "stress-test what we just built".
  # Slovenian roots: `pentest` is loanword; `ranljivost` covers ranljivosti /
  # ranljivosti, `napad` covers napad / napadi / napadalec.
  if echo "$task_lower" | grep -qE '\b(pentest|pen.test|penetration.test|owasp|security.test|exploit|vuln.scan|vulnerability.scan|cve.scan)\b|\b(ranljivost|napad)'; then
    printf 'pentest'; return
  fi
  if echo "$task_lower" | grep -qE '\b(adversarial|red.team|red team|stress.test)\b'; then
    printf 'adversarial'; return
  fi
  if echo "$task_lower" | grep -qE '\b(crypto.strategy|trading.strategy|backtest|paper.trading|backtesting)\b'; then
    printf 'crypto-strategy'; return
  fi
  if echo "$task_lower" | grep -qE '\b(deep.research|deep.dive|research|raziskava|investigate|forensic|analyze|audit)\b'; then
    printf 'deep-research'; return
  fi
  if echo "$task_lower" | grep -qE '\b(debug|bug|fix|troubleshoot|error|crash|broken|popravi)\b'; then
    printf 'debug'; return
  fi
  if echo "$task_lower" | grep -qE '\b(implement|build|develop|naredi|code|create.*feature|add.*endpoint)\b'; then
    printf 'implement'; return
  fi
  # No template → agents still get sensible LEAD/WORKER defaults (no expert)
  printf ''
}
TEMPLATE_NAME="$(detect_template "$TASK")"

# Challenge mode auto-pick. Priority:
#   1. CLI override (positional arg 6 OR COLLAB_CHALLENGE / ENSEMBLE_CHALLENGE_MODE env)
#   2. Explicit keyword in task: sparring|podjebavanje|nemiri|adversarial.heat → sparring
#   3. Rigorous-by-default templates: premium-quad/ultrareview/pentest/adversarial/crypto-strategy/debug
#   4. Default: normal
detect_challenge_mode() {
  local task_lower override
  override="$3"
  case "$override" in
    normal|rigorous|sparring)
      printf '%s' "$override"; return ;;
  esac
  task_lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  if echo "$task_lower" | grep -qE '\b(sparring|adversarial.heat|high.heat)\b|\b(podjebavanj|nemir)'; then
    printf 'sparring'; return
  fi
  case "$2" in
    premium-quad|ultrareview|pentest|adversarial|crypto-strategy|debug)
      printf 'rigorous'; return ;;
  esac
  printf 'normal'
}
CHALLENGE_MODE="$(detect_challenge_mode "$TASK" "$TEMPLATE_NAME" "$CHALLENGE_OVERRIDE")"

# ─── Colors ───
G='\033[92m'; C='\033[96m'; D='\033[2m'; W='\033[97m'; BD='\033[1m'; R='\033[0m'
CHECK="${G}✓${R}"
SPIN="${C}●${R}"

echo ""
echo -e "  ${BD}${W}◈ ensemble collab${R}"
echo -e "  ${D}${TASK:0:80}${R}"
echo ""

# ─── 1. Server ───
if curl -sf "$API/api/v1/health" > /dev/null 2>&1; then
  echo -e "  ${CHECK} Server running"
else
  echo -ne "  ${SPIN} Starting server..."
  cd "$REPO_DIR" && ./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &
  for _ in $(seq 1 8); do sleep 1; curl -sf "$API/api/v1/health" > /dev/null 2>&1 && break; done
  if curl -sf "$API/api/v1/health" > /dev/null 2>&1; then
    echo -e "\r  ${CHECK} Server started       "
  else
    echo -e "\r  \033[91m✗${R} Server failed to start"; exit 1
  fi
fi

# ─── 1b. Background cleanup of stale runtime dirs (>24h old) ───
"$SCRIPT_DIR/collab-cleanup.sh" --force > /dev/null 2>&1 &

# ─── 1c. Check for resumable active team on same CWD ───
ACTIVE_TEAM=$(curl -sf -H "$AUTH_HDR" "$API/api/ensemble/teams" 2>/dev/null | python3 -c "
import json, sys, os
cwd = os.path.realpath('$CWD')
teams = json.load(sys.stdin).get('teams', [])
active = [t for t in teams if t.get('status') == 'active' and t.get('workingDirectory') == cwd]
if active:
    active.sort(key=lambda t: t.get('createdAt', ''), reverse=True)
    print(active[0]['id'])
" 2>/dev/null || true)

if [ -n "$ACTIVE_TEAM" ]; then
  # Only resume if tmux sessions for agents are still alive — otherwise team is orphaned
  SESSIONS_ALIVE=$(tmux ls 2>/dev/null | grep -c "^${ACTIVE_TEAM}-\|-${ACTIVE_TEAM:0:8}-" || true)
  if [ "${SESSIONS_ALIVE:-0}" -gt 0 ]; then
    echo -e "  ${C}●${R} Active team found on same directory — resuming..."
    exec "$SCRIPT_DIR/collab-resume.sh" "$ACTIVE_TEAM"
  else
    echo -e "  ${C}●${R} Orphaned team $ACTIVE_TEAM (no live sessions) — disbanding and creating fresh..."
    curl -sf -H "$AUTH_HDR" -X DELETE "$API/api/ensemble/teams/$ACTIVE_TEAM" > /dev/null 2>&1 || true
  fi
fi

# ─── 2. Create team (use env vars to avoid quoting hell) ───
TEAM_NAME="collab-$(python3 -c 'import random,time; print(str(time.time_ns()//1000000)+"-"+str(random.randint(1000,9999)))')"
PAYLOAD_FILE=$(mktemp)
TNAME="$TEAM_NAME" TDESC="$TASK" TCWD="$CWD" THOST="$HOST_ID" TAGENTS="$AGENTS" TTEMPLATE="$TEMPLATE_NAME" TCHALLENGE="$CHALLENGE_MODE" PFILE="$PAYLOAD_FILE" python3 -c "
import json, os
agents_str = os.environ.get('TAGENTS', '')
if agents_str:
    names = [a.strip() for a in agents_str.split(',')]
    agents = [{'program': names[0], 'role': 'lead', 'hostId': os.environ['THOST']}]
    for n in names[1:]:
        agents.append({'program': n, 'role': 'worker', 'hostId': os.environ['THOST']})
else:
    agents = [
        {'program': 'codex', 'role': 'lead', 'hostId': os.environ['THOST']},
        {'program': 'claude code', 'role': 'worker', 'hostId': os.environ['THOST']}
    ]
import re
desc = os.environ['TDESC'].lower()
staged_patterns = [
    r'\bimplement\b', r'\bdevelop\b', r'\bbuild\b', r'\bnaredi\b',
    r'\bplan\b', r'\barhitektur', r'\bdesign\b', r'\bstress.?test\b',
    r'\badversarial\b', r'\bimplement.*(?:and|in)\s+(?:test|review)\b',
]
# W2.5i: multi-PR sequenced work doesn't fit single-stage workflow.
# Production observation 2026-05-01: 4 sparring libro.si collabs all
# tasked with 'PR1 + PR2 + PR3' delivered only PR1, then exhausted
# auto-fix iterations on incomplete state because EXEC ran out at 300s
# with PR2/PR3 untouched. Disable staged for these — let agents pace
# themselves and the watchdog handle disband.
multi_pr_patterns = [
    r'\b(?:pr|PR)\s*\d+\s*\+\s*(?:pr|PR)\s*\d+',                    # PR1 + PR2
    r'\b(?:pr|PR)\s*\d+\s*[,;]\s*(?:pr|PR)\s*\d+',                  # PR1, PR2
    r'\b(?:pr|PR)\s*\d+\s+(?:and|in|i?n)\s+(?:pr|PR)\s*\d+',        # PR6 and PR7
    r'\b\d+\s+sequenced\s+(?:pr|PR)',                                # 3 sequenced PRs
    r'\b\d+\s+(?:pr|PR)-?j',                                          # 3 PR-ji (Slovenian)
    r'\bsequenced\s+(?:pr|PR)-?j',                                   # sequenced PR-ji
    r'\b(?:pr|PR)\s*\d+\s*→\s*(?:pr|PR)\s*\d+',                     # PR1 → PR2 chain
]
multi_pr = any(re.search(p, desc) for p in multi_pr_patterns)
staged = any(re.search(p, desc) for p in staged_patterns) and not multi_pr
payload = {
    'name': os.environ['TNAME'],
    'description': os.environ['TDESC'],
    'agents': agents,
    'feedMode': 'live',
    'workingDirectory': os.environ['TCWD'],
}
if staged:
    payload['staged'] = True
# Fix: pass templateName so ensemble-service::buildPromptPreview actually
# loads the template and injects expert mental models into agent prompts.
tmpl = os.environ.get('TTEMPLATE', '').strip()
if tmpl:
    payload['templateName'] = tmpl
challenge = os.environ.get('TCHALLENGE', '').strip()
if challenge and challenge in ('normal', 'rigorous', 'sparring'):
    payload['challengeMode'] = challenge
json.dump(payload, open(os.environ['PFILE'], 'w'))
"
[ -n "$TEMPLATE_NAME" ] && echo -e "  ${D}Template: ${TEMPLATE_NAME}${R}"
[ -n "$CHALLENGE_MODE" ] && [ "$CHALLENGE_MODE" != "normal" ] && echo -e "  ${D}Challenge mode: ${CHALLENGE_MODE}${R}"
RESULT=$(curl -sf -X POST "$API/api/ensemble/teams" \
  -H "Content-Type: application/json" \
  -H "$AUTH_HDR" \
  -d @"$PAYLOAD_FILE")
rm -f "$PAYLOAD_FILE"

TEAM_ID=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['team']['id'])")
RUNTIME_DIR="$(collab_runtime_dir "$TEAM_ID")"
MESSAGES_FILE="$(collab_messages_file "$TEAM_ID")"
BRIDGE_PID_FILE="$(collab_bridge_pid "$TEAM_ID")"
BRIDGE_LOG_FILE="$(collab_bridge_log "$TEAM_ID")"
POLLER_PID_FILE="$(collab_poller_pid "$TEAM_ID")"
FEED_FILE="$(collab_feed_file "$TEAM_ID")"
TEAM_ID_FILE="$(collab_team_id_file "$TEAM_ID")"

mkdir -p "$RUNTIME_DIR" "$(dirname "$MESSAGES_FILE")" "$(dirname "$FEED_FILE")"
touch "$MESSAGES_FILE"
printf '%s\n' "$TEAM_ID" > "$TEAM_ID_FILE"

# ─── State machine marker (observable lifecycle) ───
# Writers move through creating → active → finishing → finished → cleaned.
# Readers query state without piecing together PID tables.
# Atomic write so a reader catching mid-write never sees a truncated value.
STATE_FILE="$RUNTIME_DIR/.state"
write_state() {
  local new_state="$1"
  local tmp
  tmp=$(mktemp "${STATE_FILE}.XXXXXX")
  printf '%s\n' "$new_state" > "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}
write_state "creating"

# ─── Shared latest-team-id: per-launcher-PID file (zero race) + global fallback ───
# Parent that invoked this script as a subprocess should read /tmp/collab-team-$PPID.txt
# to get its OWN team-id, not a concurrent launch's. Global /tmp/collab-team-id.txt
# kept for backward compat but atomically written.
PARENT_PID="${PPID:-0}"
PER_PARENT_FILE="/tmp/collab-team-${PARENT_PID}.txt"
printf '%s\n' "$TEAM_ID" > "$PER_PARENT_FILE"
LATEST_TMP=$(mktemp /tmp/collab-team-id.XXXXXX)
printf '%s\n' "$TEAM_ID" > "$LATEST_TMP"
mv -f "$LATEST_TMP" /tmp/collab-team-id.txt
echo -e "  ${CHECK} Team created ${D}(${TEAM_NAME})${R}"

# ─── 3. Bridge (writes its own PID file via single-instance guard) ───
# Use setsid so bridge-supervisor runs in its own process group. One signal
# (kill -TERM -- -$PGID) then cleanly nukes the entire helper subtree —
# supervisor, bridge child, any grandchildren. No more orphan procs surviving
# a parent exit.
if command -v setsid >/dev/null 2>&1; then
  setsid nohup "$SCRIPT_DIR/ensemble-bridge-supervisor.sh" "$TEAM_ID" "$API" >> "$BRIDGE_LOG_FILE" 2>&1 &
else
  nohup "$SCRIPT_DIR/ensemble-bridge-supervisor.sh" "$TEAM_ID" "$API" >> "$BRIDGE_LOG_FILE" 2>&1 &
fi
# macOS ps reports PGID in column 7 when we ask for it via -o pgid
SUPERVISOR_PID=$!
printf '%s\n' "$SUPERVISOR_PID" > "$RUNTIME_DIR/supervisor.pid"
SUPERVISOR_PGID=$(ps -p "$SUPERVISOR_PID" -o pgid= 2>/dev/null | tr -d ' ')
[ -n "$SUPERVISOR_PGID" ] && printf '%s\n' "$SUPERVISOR_PGID" > "$RUNTIME_DIR/.pgid"
echo -e "  ${CHECK} Bridge started"

# ─── 4. Monitor ───
# Monitor selection order (override via COLLAB_MONITOR=tmux|iterm|none):
#   1. tmux split   — if already inside a tmux session
#   2. iTerm split  — on macOS when iTerm2 is the active terminal (or forced)
#   3. tmux detached session — cross-platform fallback
MONITOR_CMD="cd '$REPO_DIR' && ./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
MONITOR_PREF="${COLLAB_MONITOR:-auto}"

use_iterm=false
if [ "$MONITOR_PREF" = "iterm" ]; then
  use_iterm=true
elif [ "$MONITOR_PREF" = "auto" ] && [ -z "${TMUX:-}" ] \
     && [ "$(uname)" = "Darwin" ] && [ "${TERM_PROGRAM:-}" = "iTerm.app" ]; then
  use_iterm=true
fi

if [ "$MONITOR_PREF" = "none" ]; then
  echo -e "  ${CHECK} Monitor skipped ${D}(COLLAB_MONITOR=none)${R}"
  MONITOR_MODE="none"
elif [ -n "${TMUX:-}" ] && [ "$MONITOR_PREF" != "iterm" ]; then
  # Resolve the pane the caller is running in (where the user typed /collab).
  # $TMUX_PANE is set per-pane by tmux — survives window switches.
  SPAWN_PANE="${TARGET_PANE:-${TMUX_PANE:-$(tmux display-message -p '#{pane_id}' 2>/dev/null || echo "")}}"
  if [ -n "$SPAWN_PANE" ]; then
    tmux split-window -h -t "$SPAWN_PANE" -l '40%' "$MONITOR_CMD"
  else
    tmux split-window -h -l '40%' "$MONITOR_CMD"
  fi
  echo -e "  ${CHECK} Monitor opened ${D}(right panel)${R}"
  MONITOR_MODE="split"
elif [ "$use_iterm" = true ]; then
  ITERM_MODE="${COLLAB_ITERM_MODE:-split}"
  if "$SCRIPT_DIR/open-iterm-monitor.sh" "$REPO_DIR" "$TEAM_ID" "$ITERM_MODE" 2>/tmp/ensemble-iterm.err; then
    echo -e "  ${CHECK} Monitor opened ${D}(iTerm ${ITERM_MODE})${R}"
    MONITOR_MODE="iterm"
  else
    echo -e "  ${D}iTerm launch failed: $(head -1 /tmp/ensemble-iterm.err 2>/dev/null)${R}"
    echo -e "  ${D}Falling back to tmux session...${R}"
    MONITOR_SESSION="ensemble-$TEAM_ID"
    tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
    tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
      "./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
    echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
    MONITOR_MODE="session"
  fi
else
  MONITOR_SESSION="ensemble-$TEAM_ID"
  tmux kill-session -t "$MONITOR_SESSION" 2>/dev/null || true
  tmux new-session -d -s "$MONITOR_SESSION" -c "$REPO_DIR" \
    "./node_modules/.bin/tsx cli/monitor.ts $TEAM_ID"
  echo -e "  ${CHECK} Monitor ready ${D}(tmux attach -t $MONITOR_SESSION)${R}"
  MONITOR_MODE="session"
fi

# ─── 5. Background poller (self-exits on .finished marker) ───
FINISHED_MARKER="$RUNTIME_DIR/.finished"
nohup bash -c '
TID="'"$TEAM_ID"'"
MESSAGES_FILE="'"$MESSAGES_FILE"'"
FEED_FILE="'"$FEED_FILE"'"
FINISHED="'"$FINISHED_MARKER"'"
S=0
while true; do
  # Auto-exit once ensemble-service writes the finish marker — prevents
  # zombie tail-feed loops (47 observed in pre-fix forensics).
  [ -f "$FINISHED" ] && exit 0
  M=$(wc -l < "$MESSAGES_FILE" 2>/dev/null | tr -d " "); [ -z "$M" ] && M=0
  if [ "$M" -gt "$S" ]; then
    tail -n +"$((S+1))" "$MESSAGES_FILE" >> "$FEED_FILE" 2>/dev/null
    S=$M
  fi
  sleep 5
done' > /dev/null 2>&1 &
printf '%s\n' "$!" > "$POLLER_PID_FILE"

# ─── 6. Wait for agents ───
echo -ne "  ${SPIN} Agents spawning..."
for _ in $(seq 1 12); do
  sleep 1
  MC=$(wc -l < "$MESSAGES_FILE" 2>/dev/null | tr -d ' ' || echo "0")
  [ "${MC:-0}" -gt "0" ] && break
done
MC=$(wc -l < "$MESSAGES_FILE" 2>/dev/null | tr -d ' ' || echo "0")
if [ "${MC:-0}" -gt "0" ]; then
  echo -e "\r  ${CHECK} Agents communicating ${D}(${MC} messages)${R}"
  write_state "active"
else
  echo -e "\r  ${SPIN} Agents warming up...       "
  write_state "active"
fi

# ─── Output ───
echo ""
# Build dynamic agent list for display
AGENT_NAMES=$(curl -sf -H "$AUTH_HDR" "$API/api/ensemble/teams/$TEAM_ID" 2>/dev/null \
  | python3 -c "import json,sys; t=json.load(sys.stdin); print(' + '.join(a['name'] for a in t['team']['agents']))" 2>/dev/null \
  || echo "agents")
echo -e "  ${BD}${G}Team is live!${R} ${W}${AGENT_NAMES}${R} are collaborating."
echo ""
if [ "$MONITOR_MODE" = "split" ]; then
  echo -e "  ${D}┌─ Monitor (right panel) ───────────────┐${R}"
elif [ "$MONITOR_MODE" = "iterm" ]; then
  echo -e "  ${D}┌─ Monitor (iTerm native pane) ─────────┐${R}"
elif [ "$MONITOR_MODE" = "none" ]; then
  echo -e "  ${D}┌─ Monitor (skipped) ───────────────────┐${R}"
else
  echo -e "  ${D}┌─ Monitor ─────────────────────────────┐${R}"
  echo -e "  ${D}│${R}  ${D}tmux attach -t $MONITOR_SESSION${R}      ${D}│${R}"
fi
echo -e "  ${D}│${R}  ${W}s${R}     ${D}steer team${R}                     ${D}│${R}"
echo -e "  ${D}│${R}  ${W}1${R}/${W}2${R}   ${D}steer codex / claude${R}           ${D}│${R}"
echo -e "  ${D}│${R}  ${W}j${R}/${W}k${R}   ${D}scroll${R}                         ${D}│${R}"
echo -e "  ${D}│${R}  ${W}d${R}     ${D}disband team${R}                   ${D}│${R}"
echo -e "  ${D}│${R}  ${W}q${R}     ${D}quit monitor${R}                   ${D}│${R}"
echo -e "  ${D}└───────────────────────────────────────┘${R}"
echo ""
