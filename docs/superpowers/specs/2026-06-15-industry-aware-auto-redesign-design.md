# Industry-Aware Auto-Redesign Skill — Design Spec

**Slug**: `redesign-industry-aware`
**Author**: Claude (ensemble) + samo@beemusic.co
**Date**: 2026-06-15
**Status**: Design approved, ready for implementation plan
**Discovery receipt**: `[DISCOVERY_RECEIPT domain=redesign tools=find,rg,find-skills,git-log,mdfind,security ... result=found ts=1781474537]`

## 1. Problem

Operator runs ~15 wildly different projects spanning roughly 8 distinct industries (adult e-commerce, B2B industrial expo equipment, restaurant, crypto trading, fintech, luxury fashion, agency/portfolio, blog/content) and wants a single command — `/redesign <url>` — that figures out the appropriate design language for the industry of that site (its industry, NOT operator's tier-default), then redesigns the target page accordingly.

Today's failures the design must fix:

- The existing `redesign-existing-projects` skill (`~/.claude/skills/design-redesign/`) ships a SaaS-Linear-Vercel aesthetic (Geist fonts, spring physics, cool palette) and applies it uniformly. Wrong for adult, wrong for B2B industrial, wrong for restaurant.
- Commercial tools (v0.dev, Lovable, Bolt.new, Stitch, Replit Agent, Magic Patterns, Same.new) collapse every input into the same shadcn/Tailwind output regardless of industry — verified across multiple primary-source audits.
- Hardcoded "if industry X → palette Y" tables fail FUTURE-N: adding the 6th industry forces a code change.

## 2. Goals

1. **Zero hardcoded industry → design mappings.** All design intelligence comes from external authorities resolved at runtime.
2. **Industry inferred from the site itself**, not asked of the operator.
3. **Single-URL scope V1**: `/redesign <url>` redesigns one page; full-site is a future composition.
4. **Full creative depth**: tokens, layout, content, IA are all in scope.
5. **PR-as-deliverable**: every successful run opens a PR with embedded screenshots, judge scores, gate results, and a one-line revert.
6. **Bulletproof gates**: no merge-ready PR ships if compile/flow/lighthouse/visual-regression/WCAG fail.
7. **Composable primitives**: every stage is callable standalone (`/dna-extract <url>`, `/industry-classify <url>`, …).
8. **Operator-stack-aware**: respects 5 recurring memory preferences (exact hex via PIL, lucide-react named imports, placeholder divs, no external image URLs, brand-locked tokens).

## 3. Non-Goals (V1)

- Full-site redesign (multi-page coherent IA). Future V1.1.
- Non-React/Next.js stacks. Future plugin model.
- Mobile-app redesign (Mobbin is mobile-biased, but generator targets web pages first).
- Manual variant pick UI (operator gets PR with auto-picked winner; PR comment shows runners-up).
- Cron-scheduled redesign-suggest across all projects. Future V1.1.

## 4. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  /redesign <url> [--variants=3] [--no-cache] [--resume <ts>]       │
│      ↓                                                             │
│  ~/.claude/skills/redesign-industry-aware/SKILL.md                 │
│      (orchestrator markdown, ~300 lines, NO logic — orchestration) │
│      ↓                                                             │
│  ~/.openclaw/scripts/redesign/                                     │
│  ├── lib/                                                          │
│  │   ├── schemas/v1/                  # contract JSON schemas      │
│  │   │   ├── classify.input.json                                   │
│  │   │   ├── classify.output.json                                  │
│  │   │   ├── refs.output.json                                      │
│  │   │   ├── dna.output.json                                       │
│  │   │   ├── variant.output.json                                   │
│  │   │   └── judge.output.json                                     │
│  │   ├── cache.py                # SHA-256 idempotency, TTLs       │
│  │   ├── telemetry.py            # structured emit + dashboard     │
│  │   ├── budgets.py              # time + cost guards per stage    │
│  │   ├── worktree.py             # git worktree create/cleanup     │
│  │   ├── degrade.py              # graceful fallback chain helper  │
│  │   └── taxonomy.py             # IAB v3.1 TSV loader+normalizer  │
│  ├── classify.py                 # STAGE 1                         │
│  ├── fetch_refs.py               # STAGE 2                         │
│  ├── dna_extract.py              # STAGE 3                         │
│  ├── generate.py                 # STAGE 4                         │
│  ├── judge.py                    # STAGE 5                         │
│  ├── gates.py                    # STAGE 6                         │
│  ├── pr.py                       # STAGE 7                         │
│  └── canary.py                   # weekly production canary        │
│      ↓                                                             │
│  data + cache layer                                                │
│  ├── ~/.openclaw/cache/redesign/                                   │
│  │   ├── classify/<sha>.json              # 30d TTL                │
│  │   ├── refs/<iab-t1>/<ref-id>.json      # 7d TTL                 │
│  │   ├── dna/<ref-id>.json                # 7d TTL                 │
│  │   └── industry-taxonomy/iab-v3.1.tsv   # pinned, refreshed cron │
│  └── <project>/.redesign/                                          │
│      ├── .redesign.yaml             # per-project overrides        │
│      └── <run-timestamp>/                                          │
│          ├── run.json               # full reproducibility artifact│
│          ├── CHECKPOINT.json        # crash-resume marker          │
│          ├── before-after.png       # PR screenshot embed          │
│          ├── revert.sh              # one-liner git revert         │
│          ├── stage-logs/            # per-stage structured log     │
│          └── FAILED.md              # only present on abort        │
│      ↓                                                             │
│  external authorities (zero hardcoded mappings)                    │
│  ├── IAB v3.1 TSV         github.com/InteractiveAdvertisingBureau  │
│  ├── Mobbin Official MCP  operator's paid access                   │
│  ├── Playwright stealth   Awwwards/Land-book/SiteInspire by-cat    │
│  ├── dembrandt            vendored npm, URL → design tokens        │
│  ├── projectwallace       CSS analyzer (Tier-3 DNA fallback)       │
│  └── Anthropic SDK        classify / generate / judge              │
└────────────────────────────────────────────────────────────────────┘
```

**Stage boundaries (each script):**

- Single responsibility: 1 verb (classify | fetch | extract | generate | judge | gate | pr).
- Stdin: JSON validated against `<stage>.input.json`.
- Stdout: JSON validated against `<stage>.output.json`.
- Side-effects: writes to cache + `<project>/.redesign/<ts>/stage-logs/<stage>.log`. Never modifies the project tree outside its dedicated worktree.
- Telemetry: emits `<redesign-stage stage=… result=… latency_ms=… degraded?=…/>` blocks to stderr.
- Standalone CLI: `python3 ~/.openclaw/scripts/redesign/<stage>.py --in <file>` → JSON on stdout.

## 5. Data Flow

Concrete trace of `/redesign https://viagoshop.com/sl/proizvodi`:

| T      | Stage          | Behavior                                                                                                                                      | Cache           | Out                                                                                              |
| ------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| 0s     | skill prep     | discover-tools receipt; create worktree `.worktrees/redesign-viagoshop-<ts>`; merge `.redesign.yaml`; init checkpoint                         | —               | —                                                                                                |
| 1s     | classify       | fetch URL HTML; parse JSON-LD `@type`; Claude zero-shot w/ IAB v3.1 TSV in prompt; +0.15 confidence boost if schema.org matches               | MISS, write 30d | `{iab_t1, iab_t2, confidence, schema_org_type}`                                                  |
| 1.5s   | fetch_refs     | Tier-1 Mobbin → Tier-2 Playwright Land-book → Tier-3 LLM synth; emit per-tier telemetry                                                       | 6 HIT, 2 STALE  | `{refs:[…], degraded:[…]}`                                                                       |
| 8s     | dna_extract ×8 | parallel dembrandt per ref → tokens; skill aggregates → industry-DNA bundle                                                                   | per-ref 7d      | `{palette_family, type_voice, motion_register, grid_register, layout_signatures, anti_patterns}` |
| 12s    | site recon     | screenshot operator's URL (1440 + 375); read target React files; extract current tokens                                                       | —               | `context_pack`                                                                                   |
| 15s    | generate ×3    | 3 parallel Claude code-agents, each its own worktree subdir, distinct angle (safe-evolution / bold-restructure / maximalist-creative)         | —               | 3× `{variant_id, files_changed, diff_path, screenshot_path}`                                     |
| 3.5min | judge ×3×3     | 9 parallel vision-LLM calls; 3 lenses (industry-fit, design-quality, craft); per-variant weighted; if top-1 < 7.0 → ONE critique round (+90s) | —               | `{scores, winner}`                                                                               |
| 5min   | gates          | g1 tsc+eslint, g2 flow-verify, g3 lighthouse Δ vs baseline, g4 Playwright visual-regression, g5 axe WCAG, g6 judge score floor (comment-only) | —               | `{gates_table, all_pass?}`                                                                       |
| 8min   | pr             | commit worktree, push, `gh pr create` w/ rich body, Telegram bridge ping, coverage-ledger verify                                              | —               | `{pr_url, artifact_path}`                                                                        |

**Total wallclock**: ~8 min typical (cached ~5 min). **Cost**: ~$3-5 Anthropic per run.

## 6. Error Handling

Three levels:

- **A — Recoverable**: retry once with backoff, then degrade.
- **B — Degraded**: continue with `<degraded …/>` tag surfaced in PR body.
- **C — Abort**: no PR; `FAILED.md` + Telegram alert + revert artifact written.

| Stage       | Failure                                   | Level                                   |
| ----------- | ----------------------------------------- | --------------------------------------- |
| classify    | Claude 429/timeout                        | A                                       |
| classify    | confidence 0.30-0.54                      | B (warn in PR)                          |
| classify    | confidence < 0.30                         | C (abort, garbage in/out)               |
| fetch_refs  | one tier fails                            | A → next tier                           |
| fetch_refs  | all 3 tiers fail                          | C                                       |
| fetch_refs  | 1-2 refs after Tier-3                     | B (judge lens-1 weight lowered)         |
| dna_extract | ≤3 of 8 refs fail                         | A (continue if ≥5)                      |
| dna_extract | ≥4 of 8 refs fail                         | C                                       |
| generate    | 1/3 variants fail                         | A (continue with rest)                  |
| generate    | 3/3 variants fail                         | C                                       |
| judge       | any lens API limit                        | A → comment-only (not blocking)         |
| gates       | g1 tsc/eslint fail                        | C (never PR broken code)                |
| gates       | g2 flow-verify fail                       | C (broken user flow)                    |
| gates       | g3 lighthouse Δ-3 to Δ-5                  | B (PR shows score table)                |
| gates       | g3 lighthouse Δ<-5                        | C                                       |
| gates       | g4 visual >30% w/o `--allow-visual-break` | C                                       |
| gates       | g5 axe new violations                     | C                                       |
| pr          | gh CLI 4xx/5xx                            | A; persists → artifact + manual gh hint |

**Telemetry shape** (stderr, parsed by skill orchestrator + dashboard):

```
<redesign-stage stage='fetch-refs' tier=1 result='failed'
                reason='mobbin-timeout-15s' fallback='tier-2'/>
<redesign-stage stage='fetch-refs' tier=2 result='partial'
                got=4 wanted=8 fallback='tier-3'/>
<redesign-stage stage='fetch-refs' result='degraded'
                degraded_reasons='mobbin-unavailable,scraper-partial'/>
```

**Budget guard** (orchestrator-enforced):

```python
TURN_BUDGET = {
    "wallclock_max_s": 900,
    "anthropic_input_tokens": 500_000,
    "anthropic_output_tokens": 200_000,
    "playwright_pages_max": 50,
}
```

**Per-project YAML override** (`<project>/.redesign.yaml`):

```yaml
brand_locks: # frozen — generator MUST preserve
  colors: ["#1E8E73"]
  fonts: ["Geist"]
forbidden_patterns: # judge auto-fails any variant containing
  - "purple-blue gradient"
  - "rocketship icon for 'launch'"
allowed_section_types: # whitelist
  - hero
  - features
  - footer
overrides:
  industry_pin: "adult-ecommerce" # bypass classifier
  variants: 5 # override default 3
  visual_break_threshold: 0.50 # higher tolerance
```

The YAML is the FUTURE-N escape hatch: per-project knob without code change.

## 7. Operator Preferences (Mandatory Constraints in Generator)

Promoted from auto-memory (recurred across ≥3 sessions). Hardcoded verbatim in `generate.py` system prompt AND verified by `tests/test_generate.py` grep assertions:

1. **Exact hex via DNA tokens, NEVER Tailwind named colors** (`bg-[#1E8E73]` not `bg-emerald-500`). PIL-style hex extraction from refs.
2. **Lucide-react named imports for icons. NEVER inline SVG paths.**
3. **Placeholder divs with exact bg-[#hex] + aspect-\* class. NEVER picsum/unsplash/placeholder.com.**
4. **Use existing project font stack. NEVER add font imports without checking config.**
5. **Brand-locked tokens from `.redesign.yaml` are immutable in every variant.**

## 8. Testing Strategy

### Level 1 — Per-stage unit tests

- 8 classify fixtures (one per operator industry: adult, B2B-industrial, restaurant, crypto, fintech, luxury, agency, blog).
- Recorded Mobbin response + Land-book HTML for fetch_refs degradation tests.
- Known-good ref → expected DNA tokens for dna_extract.
- Mocked Claude → schema-valid variant for generate.
- Known good/bad screenshot fixtures → expected judge ranking.
- Broken-build fixture → expected gates FAILED.
- `pytest scripts/redesign/tests/` runs in <30s cold.

### Level 2 — End-to-end smoke (mocked LLM)

- 4 operator URLs (viagoshop, octanorm-adria, libro, sejemskaoprema) — subset of the 8 unit-test industries chosen for live-stack coverage.
- `REDESIGN_MOCK_LLM=1` env → cached generations.
- Shape assertions: PR body contains `Industry: IAB-…`, judge ≥5, no axe violations.
- Runs daily 04:00 via launchd → catches drift (Mobbin API change, IAB v3.2 release).

### Level 3 — Production canary

- `~/.openclaw/config/launchd-agents/co.openclaw.redesign-canary.plist`
- Mon 03:30, picks 1 page from rotating list, runs full live pipeline.
- PR tagged `[canary]`, Telegram ping.
- `score-trend.json` per week: judge P50/P10, gates pass rate, degraded rate.
- Drift alert if P50 score delta < -0.5 week-over-week.

### Coverage ledger

Target before V1 done-claim: 8/8 industries with classify fixtures.

```bash
bash ~/.openclaw/scripts/coverage-ledger.sh target redesign-v1 \
  --cmd 'jq -r ".operator_industries[]" ~/.openclaw/config/operator-industries.json | wc -l'
bash ~/.openclaw/scripts/coverage-ledger.sh verify redesign-v1 \
  --cmd 'ls tests/fixtures/classify/*_expected.json | wc -l'
```

## 9. PR Format

PR body sections (rendered by `pr.py` from `run.json`):

````markdown
# /redesign — viagoshop.com/sl/proizvodi

## TL;DR

- Industry: **IAB-3 Style & Fashion** (conf 0.94) ← classifier
- Variant winner: **B "bold-restructure"** (score 8.4/10)
- Gates: 5/5 ✅ | Visual diff: 22% | Lighthouse Δ: +2

## Before / After

![before](.redesign/<ts>/before.png) ![after](.redesign/<ts>/after.png)

## Judge Breakdown

| Variant                | Industry-Fit | Design-Quality | Craft   | Total   |
| ---------------------- | ------------ | -------------- | ------- | ------- |
| A safe-evolution       | 7.2          | 7.0            | 8.0     | 7.4     |
| **B bold-restructure** | **8.6**      | **8.2**        | **8.1** | **8.4** |
| C maximalist           | 8.0          | 7.5            | 6.8     | 7.6     |

## Industry References Used

- mobbin.com/apps/lounge-fashion-app (source: mobbin)
- land-book.com/sites/fashion-brand-X (source: scraper)
- … 6 more

## Gates

| Gate         | Result | Detail                       |
| ------------ | ------ | ---------------------------- |
| tsc + eslint | ✅     | 0 errors                     |
| flow-verify  | ✅     | login + cart + checkout pass |
| lighthouse   | ✅     | perf +2, seo 0, a11y +1      |
| visual diff  | ✅     | 22% (threshold 30%)          |
| axe WCAG     | ✅     | 0 new violations             |

## Degradation Report

None.

## Revert

```bash
bash .redesign/<ts>/revert.sh
```
````

## Artifact

`.redesign/<ts>/run.json` (full reproducibility — re-run yields identical diff)

```

## 10. Integration with Existing Ensemble

- **discover-tools.py** — emit receipt before each PR (BLOCKER-VETO compliance).
- **coverage-ledger.sh** — denominator tracking for target=8 industries.
- **flow-verify** — invoked from `gates.py` as g2.
- **dashboard MCP** — telemetry feed via `get_metrics` consumer.
- **Telegram bridge** — PR open + canary alert + abort notification.
- **Superpowers** — wraps each stage in worktree, uses `using-git-worktrees` skill.
- **Existing skills not replaced**: `redesign-existing-projects` becomes "SaaS-tier preset" fallback when classifier confidence < 0.55 AND `.redesign.yaml` has no `industry_pin`. `responsive-modernize`, `impeccable-design`, `ui-ux-pro-max` remain callable composables — `/redesign` can chain `/responsive-modernize` after gates as an optional polish stage (flagged behind `--polish`).

## 11. Versioning

Schema versions are pinned in each JSON contract (`schema_version: "v1"`). Breaking changes bump major:
- v1.x: backwards-compatible additions (new optional fields in output).
- v2.0: re-record fixtures, migrate cached classify entries (drop+re-fill).

`iab-v3.1.tsv` is pinned by SHA in `lib/taxonomy.py`. Updated by cron `co.openclaw.iab-taxonomy-refresh.plist` weekly; bumps require re-running `tests/test_classify.py` and updating any drift.

## 12. Cost & Performance Envelope

| Metric | Cold (no cache) | Warm (refs cached) |
|---|---|---|
| Wallclock | ~8 min | ~5 min |
| Anthropic input tokens | ~250k | ~120k |
| Anthropic output tokens | ~80k | ~50k |
| Mobbin API calls | 1-3 | 0 |
| Playwright pages | ~12 | ~4 |
| Cost (Opus 4.8 rates) | ~$4-5 | ~$2-3 |

Budget guard aborts before stage if remaining < estimated cost.

## 13. Open Questions Resolved

| # | Decision | Picked |
|---|---|---|
| 1 | Scope V1 | Single URL/page |
| 2 | Depth | Full creative (nothing sacred) |
| 3 | Output flow | PR + screenshots + judge verdict |
| 4 | References | Hybrid: scraper + Mobbin Official + LLM fallback |
| 5 | Generator | Claude direct (no Stitch hop) |
| 6 | Variants | 3 parallel + 1 critique round if top-1 < 7.0 |
| 7 | Gates | Bulletproof: compile + flow + lighthouse + visual + WCAG + judge |
| 8 | Classifier | IAB v3.1 zero-shot + Schema.org JSON-LD signal, cache 30d / refs 7d |

## 14. Out-of-scope risks acknowledged

- **Mobbin ToS**: official MCP usage is within ToS; unofficial reverse-engineered (`pdcolandrea/mobbin-mcp`) NOT used since operator has paid access.
- **Cloudflare cat-and-mouse**: Land-book/Awwwards scraper will break periodically; degradation chain absorbs (Tier-3 LLM synth keeps pipeline alive); maintenance is operational not architectural.
- **IAB v3.x bumps**: pinning SHA + weekly refresh cron + classify fixtures catch drift; major bump triggers schema_version bump.
- **Adult content + commercial LLM TOS**: Anthropic policy permits redesigning legitimate adult e-commerce content (not generating explicit imagery). Judge lens-3 (craft) does NOT score adult content; lens-1 (industry-fit vs Mobbin) handles aesthetic match.

## 15. Glossary

- **DNA bundle**: aggregate of design tokens extracted from multiple industry references — what makes "adult e-commerce feel adult e-commerce" beyond any single site.
- **IAB T1/T2**: Tier 1 (37 broad) and Tier 2 (~250 narrow) categories of IAB Content Taxonomy v3.1.
- **Judge lens**: one of three independent vision-LLM evaluations (industry-fit, design-quality, craft) per variant.
- **Gate**: pass/fail check on a variant; some are hard-fail (g1, g2, g5), some soft-fail (g3 Δ-3 to Δ-5).
- **Degraded run**: completed run where one or more stages used a lower-quality fallback path.
```
