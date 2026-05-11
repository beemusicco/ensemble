#!/usr/bin/env bash
# collab-prepend.sh — emits the toolchain prepend that gets prepended to
# every collab task description, reaching codex/sonnet/haiku agents that
# do NOT receive Claude Code hooks.
#
# Prints to stdout. Used by collab-launch.sh:
#   PREPEND="$(bash collab-prepend.sh)"
#   TASK="${PREPEND}${ORIGINAL_TASK}"
#
# Idempotency: if TASK already contains "BLOCKER-VETO" marker, caller skips.
#
# Why a separate script: when new primitives ship (think, retro, similar,
# auto-install, calibration), they update THIS file, not collab-launch.sh.
# Adding the 6th primitive in 3 months → no edit to launch script.

cat << 'EOF'
🚨 BLOCKER-VETO + TOOLCHAIN (mandatory for every agent in this team — claude, codex, sonnet, haiku):

Codex agents: you do NOT receive Claude Code hooks. Self-enforce these rules. Claude/sonnet/haiku agents: hooks ALSO enforce, so you have a backstop.

══════════════════════════════════════════════════════════════════════
1. BEFORE claiming any "manual action required" / "structural limit" /
   "cannot be automated" / "operator action required" / "obvezno ročno" /
   "ni programatične" / "I don't have access" / "no X on disk" /
   equivalent in any language — you MUST first run:

     python3 ~/.openclaw/scripts/discover-tools.py <domain> [keyword ...]

   and include the resulting [DISCOVERY_RECEIPT domain=<slug> tools=… paths=…
   queries=… result=… ts=…] line in your next team-say message. Hook L1 will
   reject team-done.sh / gh pr create / git push without a domain-matching receipt.

   Escape hatch (only when discovery genuinely turns up nothing):
     [VERIFIED_LIMIT: <one-line reason> ## verify: <cmd>]
   <cmd> starts with one of {grep, rg, find, security, git, mdfind, ls, which}
   and produces content output. echo/exit/pipe-tricks are rejected.

══════════════════════════════════════════════════════════════════════
2. NEGATIVE-EXISTENCE claims must be verified, not hallucinated.
   Before claiming "operator doesn't use Chrome" / "X is not installed" /
   "no Y on disk" / "ni nameščen" / equivalent:

     ls /Applications/<App>.app                    # bundle present?
     mdfind -name "<Name>.app"                     # Spotlight (less reliable)
     which <tool>                                  # binary on PATH?
     ls "$HOME/Library/Application Support/<X>/"   # config dir?

   Production case 2026-05-08: a collab claimed "operator doesn't use Chrome"
   without checking. Chrome WAS installed. Wrong solution shipped. L4 hook
   now blocks this — codex agents must self-check.

══════════════════════════════════════════════════════════════════════
3. NOT FOUND LOCALLY? Walk the 6-step chain IN ORDER. Most 'novel' problems
   are solved in steps 2-4 of:

     1. FIND-LOCAL   — /discover-tools (just done)
     2. FIND-WEB     — bash ~/.openclaw/scripts/find-web.sh "<query>"
                       (gh code + gh repos + npm + PyPI; exhaust BEFORE inventing)
     3. INSTALL      — bash ~/.openclaw/scripts/auto-install.sh <pm> <pkg>
                       OR: git clone <repo> ~/.openclaw/state/installs/<name>
                       (PMs whitelisted: brew/npm/pnpm/pip/uv/cargo/playwright)
     4. ADAPT        — /think shape=adapt-existing (fork+modify a found repo)
     5. INVENT       — /think shape=invent-from-scratch (only if nothing adaptable)
     6. LIMIT        — [VERIFIED_LIMIT: <reason>; see /think <slug> ## verify: <cmd>]
                       (LAST RESORT — only after 2-5 exhausted)

   Believe the solution exists somewhere. Do NOT skip steps.

══════════════════════════════════════════════════════════════════════
4. STUCK / open-ended problem / inventing? Use /think persistent scratchpad:

     ~/.openclaw/scripts/think-log.sh init <slug> "<problem statement>"
     ~/.openclaw/scripts/think-log.sh append-evidence <slug> <approach> '<probe>' '<result>' '<conclusion>'
     ~/.openclaw/scripts/think-log.sh status <slug> solved      # gated
     ~/.openclaw/scripts/think-log.sh explain <slug> "<≥100 char Feynman explanation>"

   Slug = kebab-case ≤40 chars describing the PROBLEM (not the solution).
   Forces hypothesis pre-commitment, ≥10 approaches in ≥5 categories,
   evidence log, calibrated decisions. Survives /compact.

   Find prior similar problems:
     ~/.openclaw/scripts/think-similar.sh "<keywords>"

   When solved/verified-limit, retro auto-templates a learning entry.
   Enrich with the actual winner:
     ~/.openclaw/scripts/think-retro.sh enrich <slug> winner_approach "<actual>"
     ~/.openclaw/scripts/think-retro.sh enrich <slug> shape "<class-of-problem>"

   Skill: ~/.claude/skills/think/SKILL.md
   Iron law: DIVERGE → CONNECT → CONVERGE → PROVE.
   Cheat sheet: ~/.openclaw/workspace/INVENTION-PROTOCOL.md (top section)

══════════════════════════════════════════════════════════════════════
5. CALIBRATE non-obvious claims. Don't assert with hidden uncertainty:

     [CONFIDENCE: N/5 ## why: <evidence-or-reasoning> ## would-change-if: <counterfactual>]

   N=1 (guess) … N=5 (verified by probe). The would-change-if clause
   is a Bayesian commitment: if X happens, you'll abandon this claim.

   High-confidence claims (4-5/5) without recent probe = hallucination risk.

══════════════════════════════════════════════════════════════════════
6. CROSS-DOMAIN reference (when DIVERGE phase is stuck):

   - ~/.openclaw/workspace/TRIZ-40-PRINCIPLES.md  (40 inventive principles)
   - ~/.openclaw/workspace/INVENTION-DOMAINS/oauth-auth.md
   - ~/.openclaw/workspace/INVENTION-DOMAINS/data-extraction.md
   - ~/.openclaw/workspace/INVENTION-DOMAINS/performance.md
   - ~/.openclaw/workspace/INVENTION-DOMAINS/integration.md
   - ~/.openclaw/workspace/INVENTION-DOMAINS/distributed-systems.md

   Read the matching domain doc BEFORE generating approaches.

══════════════════════════════════════════════════════════════════════
7. CODE QUALITY (non-negotiable — applies to every edit you make):

   • VERIFY BEFORE DONE. Run `python3 ~/.openclaw/scripts/verify.py` (or
     the project's equivalent) before reporting "done" / [VERIFY_DONE].
     Exit 0 means tests + typecheck + interface-shape checks all passed.
     Tests fail → not done. No exceptions.

   • MINIMAL DIFFS. Fix what's broken; don't refactor neighbors. A bug fix
     doesn't need surrounding cleanup. Three similar lines is better than a
     premature abstraction. No half-finished implementations.

   • ZERO HARDCODED VALUES. No magic numbers, no duplicated constants. If a
     value appears in 2+ places → import from one source of truth. Comments
     must match code values. Fallbacks must match config.

   • FUTURE-N TEST before any hardcoded list-of-cases. "If 5 more instances
     of this exist in 3 months, does my design require code changes per
     instance?" If yes → design the generic primitive BEFORE writing code.
     Two of anything is a list; a list is a primitive.

   • NEVER MODIFY TESTS TO PASS. Fix the code, not the test. Only change a
     test if it is provably wrong.

   • NO COMMENTS UNLESS ASKED. Don't add comments / docstrings / type
     annotations to code you didn't write. Only comment the WHY when
     non-obvious. Never the WHAT — well-named identifiers self-explain.

   • BLAST RADIUS CHECK before non-local edits. Grep all callers of what
     you're changing. If the interface changes → update ALL callers in the
     same change. Python ↔ JS shared constants → update both.

   • 3-STRIKE RULE. Same approach fails 3× → STOP looping. Write down what
     failed and why. Zoom out: is the problem framed wrong? List 3 approaches
     from DIFFERENT categories.

   • BUG-FIX REPORT format (required for [VERIFY_DONE]):
       Root cause:  <one line — the actual cause, not a symptom>
       Evidence:    <what proved the cause>
       Tests:       before <X passing> → after <Y passing>

   • NEVER USE DESTRUCTIVE OPS AS A SHORTCUT. Don't bypass safety checks
     (--no-verify, git reset --hard to silence a problem, deleting a lock
     file instead of finding the process holding it). Identify root causes.

   • NEVER ASSUME A LIBRARY IS AVAILABLE. Verify the import resolves before
     using it.

══════════════════════════════════════════════════════════════════════
Full deep refs:
  - ~/.openclaw/workspace/DEBUG-PROTOCOL.md (Phase 2.7 BLOCKER-VETO + escape hatch)
  - ~/.openclaw/workspace/INVENTION-PROTOCOL.md (cheat sheet + deep guide)
  - ~/.openclaw/workspace/BUILD-PROTOCOL.md (UNDERSTAND → DESIGN → BUILD → VERIFY)
  - ~/.openclaw/docs/AGENT-ORCHESTRATION.md (collab contract)
  - ~/.claude/CLAUDE.md (global operator-level rules — read in full when in doubt)

────── ORIGINAL TASK ──────
EOF
