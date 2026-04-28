# Ensemble Plugin Migration Architecture Plan

## Claude Code bin/ Executables Support (v2.1.91+)

**Status**: Draft — NIET IMPLEMENTEREN, wacht op stabilisatie  
**Authors**: claude-2 + codex-1 (collab session), review + correcties door claude-opus  
**Date**: 2026-04-03  
**Priority**: Medium — interessante kans, maar bin/ feature is 1 dag oud en onbewezen  
**Besluit**: Structuur klaarzetten, NIET releasen. Revisit na ~3 CC releases met bin/ track record.

---

## 0. Onderzoeksresultaten (2026-04-03)

### Bevestigd via CC docs, source, en 19 geïnstalleerde plugins

| Vraag | Antwoord | Bron |
|-------|----------|------|
| Plugin manifest locatie | `.claude-plugin/plugin.json` (NIET root) | Alle 19 plugins volgen dit |
| bin/ in manifest? | Nee — `bin/` is een directory conventie, geen manifest veld | CC docs + code |
| `claude plugin install ./` ? | **Bestaat niet.** Gebruik `claude --plugin-dir ./` (dev) of marketplace | CC --help, docs |
| bin/ auto-permissions? | **Nee.** User moet goedkeuren of pre-approven in settings.json | CC docs |
| Bestaande plugins met bin/? | **Nul** van 19 — feature is 1 dag oud (v2.1.91, 2 april 2026) | Filesystem scan |
| Skill registratie | Auto-discovery via `skills/*/SKILL.md` — geen manifest entry nodig | CC docs, superpowers plugin |
| Skill namespace | `/ensemble:collab` (automatisch geprefixed met plugin name) | CC docs |
| Marketplace vereist? | Ja, voor permanente installatie. Of eigen repo als marketplace. | CC docs |

### Kritische correcties op origineel plan

1. **`plugin.json` hoort in `.claude-plugin/`, niet in root** — alle 19 plugins volgen dit patroon
2. **Geen `"bin"` of `"skills"` veld in manifest nodig** — CC auto-discovert `bin/` en `skills/` directories
3. **`claude plugin install ./` bestaat niet** — lokaal testen via `claude --plugin-dir ./`
4. **`plugin-bin/` hernoemd naar `bin/`** — CC zoekt specifiek naar `bin/` directory, niet anders
5. **Maar ensemble heeft al een `bin/` directory** (npm bin) — dit is een naamconflict dat opgelost moet worden

### Naamconflict: bestaande bin/ vs plugin bin/

Ensemble's `bin/` bevat nu npm entrypoints (`ensemble.cjs`, `postinstall.cjs`). CC zoekt plugin executables ook in `bin/`. Dit levert potentieel conflict op:

**Opties:**
- **A)** Plugin wrappers in `bin/` naast npm bestanden → CC pikt alles op, inclusief ensemble.cjs
- **B)** Aparte directory (bijv. `plugin-bin/`) → maar CC ontdekt deze NIET automatisch
- **C)** Plugin-specifieke `bin/` symlinks → verwijzen naar scripts/

**Aanbeveling**: Optie A met expliciete `.cjs` extensie filtering (CC negeert waarschijnlijk non-executable bestanden). Maar dit MOET getest worden voordat we iets releasen.

---

## 1. Context & Problem Statement

### Huidige situatie
Ensemble integreert met Claude Code via een **skill-based** model:

```
scripts/setup-claude-code.sh
  → Kopieert skill/SKILL.md naar ~/.claude/skills/collab/SKILL.md
  → Vervangt __ENSEMBLE_DIR__ placeholder met absolute repo path
  → Merget Bash permissions in ~/.claude/settings.json
```

**Distributie-artefacten vandaag:**

| Laag | Bestanden | Functie |
|------|-----------|---------|
| npm bin | `bin/ensemble.cjs` → `cli/ensemble.ts` via tsx | CLI entrypoint (`ensemble` command) |
| postinstall | `bin/postinstall.cjs` | chmod +x op scripts/*.sh en *.py |
| skill | `skill/SKILL.md` | Claude Code /collab slash command |
| scripts | 13 files in `scripts/` (11 .sh, 2 .py) | Collab lifecycle management |
| server | `server.ts` + `lib/` (10 modules) | Ensemble API (localhost:23000) |

### Probleem: Command-name mismatch
`SKILL.md` verwijst naar bare command names (`collab-launch`, `collab-poll`), maar:
- `setup-claude-code.sh` installeert geen PATH shims
- `package.json` exposeert alleen `bin.ensemble`
- Werkende installaties leunen op repo-local absolute paden in de `__ENSEMBLE_DIR__` placeholder

### Kans: CC v2.1.91 bin/ executables
Claude Code v2.1.91 introduceert **plugin-managed bin/ executables** — plugins kunnen shell commands in `bin/` plaatsen die CC automatisch op het PATH zet. Dit kan de command-name mismatch oplossen EN de distributie vereenvoudigen.

**Let op**: Deze feature is 1 dag oud (released 2 april 2026), geen enkele bestaande plugin gebruikt het, en er zijn potentieel onontdekte edge cases.

---

## 2. Design Principes

### P1: Additive, niet vervanging
De plugin laag is een **extra distributie-surface** bovenop de bestaande skill/scripts flow. Geen runtime versie-detectie in skill code. Twee parallelle install paden die dezelfde `scripts/` aanroepen.

### P2: scripts/ blijft source of truth
Alle logica blijft in `scripts/`. Plugin bin wrappers zijn dunne dispatchers, geen duplicatie. Eén bron van waarheid.

### P3: Geen fragiele versie-detectie
Geen `if CC_VERSION >= 2.1.91` conditionals in skill of setup. De juiste install path wordt bepaald door de installer, niet door runtime code.

### P4: Fail-open, niet fail-closed
Als plugin bin niet beschikbaar is, valt het systeem terug op de werkende skill + absolute pad flow. Nooit een crash door een ontbrekende plugin feature.

### P5: Legacy blijft primary (NIEUW)
`setup-claude-code.sh` is en blijft het primaire installatiemechanisme. Plugin path is experimenteel totdat bin/ feature bewezen stabiel is.

---

## 3. Doelarchitectuur: Dual-Entrypoint Model

```
┌─────────────────────────────────────────────────┐
│                    User                          │
│              /collab "task"                      │
└──────────────┬──────────────────────────────────┘
               │
       ┌───────▼───────┐
       │  SKILL.md      │  ← Altijd aanwezig (beide paden)
       │  /collab       │
       └───────┬───────┘
               │
    ┌──────────┴──────────┐
    │                     │
    ▼                     ▼
┌─────────┐        ┌──────────────┐
│ LEGACY  │        │   MODERN     │
│ PRIMARY │        │ EXPERIMENTEEL│
├─────────┤        ├──────────────┤
│ Absolute│        │ Plugin bin/  │
│ paths   │        │ wrappers on  │
│ in skill│        │ PATH         │
└────┬────┘        └──────┬───────┘
     │                    │
     └────────┬───────────┘
              │
              ▼
    ┌──────────────────┐
    │    scripts/       │  ← Source of truth
    │  collab-launch.sh │
    │  collab-poll.sh   │
    │  team-say.sh      │
    │  team-read.sh     │
    │  ...              │
    └──────────────────┘
```

---

## 4. Nieuwe bestanden & Wijzigingen

### 4.1 Plugin Manifest: `.claude-plugin/plugin.json` (nieuw)

**Let op**: Manifest gaat in `.claude-plugin/` subdirectory, niet in root.
Skills en bin/ worden auto-discovered — geen manifest entries nodig.

```json
{
  "name": "ensemble",
  "version": "1.0.0",
  "description": "Multi-agent collaboration engine — AI agents that work as one",
  "author": {
    "name": "Michel Helsdingen"
  },
  "homepage": "https://github.com/michelhelsdingen/ensemble",
  "repository": "https://github.com/michelhelsdingen/ensemble",
  "license": "MIT",
  "keywords": ["collaboration", "multi-agent", "teams", "codex", "collab"]
}
```

### 4.2 Plugin bin wrappers in `bin/` (naast bestaande npm bestanden)

CC auto-discovert executables in `bin/`. Elke wrapper is een dunne shell dispatcher:

```bash
#!/usr/bin/env bash
# bin/collab-launch — Thin wrapper for plugin bin distribution
# Dispatches to the actual script in scripts/
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$PLUGIN_DIR/scripts/collab-launch.sh" "$@"
```

Identiek patroon voor alle 8 commands. Geen logica, alleen dispatch.

**Naamconflict met npm bin**: `bin/` bevat nu ook `ensemble.cjs` en `postinstall.cjs`. Moet getest worden of CC deze als executables oppikt (ze zijn .cjs, niet chmod +x → waarschijnlijk genegeerd, maar NIET gegarandeerd).

### 4.3 SKILL.md Strategie: Twee Bestanden

**Beslissing**: Twee aparte SKILL.md bestanden, elk geoptimaliseerd voor hun distributiepad.

#### `skill/SKILL.md` (legacy — ongewijzigd)
- Behoudt `__ENSEMBLE_DIR__` placeholder patroon
- `setup-claude-code.sh` vervangt placeholder met absolute repo pad
- Commands worden aangeroepen als `__ENSEMBLE_DIR__/scripts/collab-launch.sh`
- **Geen wijzigingen nodig** — dit bestand blijft exact zoals het is

#### `skills/collab/SKILL.md` (nieuw — plugin distributie)
- **Let op**: Moet in `skills/collab/` voor auto-discovery (niet `skill/`)
- Gebruikt bare command names: `collab-launch`, `collab-poll`, etc.
- Plugin bin/ zet deze commands op PATH → bare names werken direct
- Geen `__ENSEMBLE_DIR__` placeholder nodig
- Wordt `/ensemble:collab` slash command (auto-namespaced)

**Rationale**: Eén bestand voor twee paden vereist ofwel runtime detectie (fragiel) ofwel een compromis dat voor geen van beide optimaal is. Twee bestanden zijn explicieter, makkelijker te testen, en elimineren ambiguïteit.

### 4.4 setup-claude-code.sh wijzigingen

**Geen wijzigingen in deze fase.** Legacy setup blijft primary path en wordt niet aangeraakt totdat plugin path bewezen stabiel is.

Wanneer we wel wijzigen (fase 3+):
- Detectie of ensemble als CC plugin geïnstalleerd is
- Als ja: waarschuwing tonen, maar NIET afbreken
- `--force` flag voor expliciet overschrijven
- Rationale: legacy setup is het recovery pad

### 4.5 package.json wijzigingen

```jsonc
{
  // Bestaand (ongewijzigd):
  "bin": { "ensemble": "bin/ensemble.cjs" },
  
  // Nieuw in files[]:
  "files": [
    // ... bestaande entries ...
    ".claude-plugin/",
    "skills/"
  ]
}
```

---

## 5. Installatie-matrix

| Methode | CC Versie | Wat gebeurt er | Status |
|---------|-----------|----------------|--------|
| `git clone` + `setup-claude-code.sh` | Alle | Skill + permissions geïnstalleerd, absolute paden | **PRIMARY** |
| `npm install -g @ensemble-ai/cli` | Alle | `ensemble` command beschikbaar, setup nodig voor /collab | **PRIMARY** |
| `claude --plugin-dir ./ensemble` | ≥2.1.91 | Plugin geladen voor sessie, bin/ op PATH, skill als /ensemble:collab | **EXPERIMENTEEL** |
| `claude plugin install ensemble@<marketplace>` | ≥2.1.91 | Permanent geïnstalleerd via marketplace | **TOEKOMST** |

### Lokaal testen (ontwikkelaars)
```bash
# Clone repo
git clone https://github.com/michelhelsdingen/ensemble.git
cd ensemble && npm install

# Primair (altijd werkend):
./scripts/setup-claude-code.sh

# Experimenteel testen (v2.1.91+):
claude --plugin-dir ./
# → /ensemble:collab zou beschikbaar moeten zijn
# → bin/ commands op PATH
```

---

## 6. Migratiepad

### Fase 0: Onderzoek & Validatie (HUIDIGE FASE)
1. ~~Onderzoek CC plugin docs~~ ✅ Afgerond 2026-04-03
2. ~~Bevestig plugin.json schema, bin/ mechanisme~~ ✅ Gecorrigeerd
3. **TODO**: Test `claude --plugin-dir ./` met ensemble
4. **TODO**: Verifieer bin/ naamconflict (ensemble.cjs + postinstall.cjs)
5. **TODO**: Test of permissions auto-granted zijn of handmatig moeten

**Risico**: Feature is 1 dag oud, geen referentie-implementaties.

### Fase 1: Plugin-ready maken (non-breaking)
1. Maak `.claude-plugin/plugin.json`
2. Maak `skills/collab/SKILL.md` (plugin variant met bare commands)
3. Voeg bin wrappers toe aan `bin/` (collab-launch, collab-poll, etc.)
4. Update `package.json` files array
5. Update `.npmignore` om plugin bestanden mee te nemen
6. **Test**: Bestaande `setup-claude-code.sh` flow werkt nog identiek
7. **Test**: `claude --plugin-dir ./` laadt plugin correct

**Risico**: Geen voor bestaande installaties — alleen toevoegingen.
**Blocker**: Fase 0 TODO's moeten afgerond zijn.

### Fase 2: Soak period
1. Gebruik zelf dagelijks via `--plugin-dir`
2. Monitor CC releases voor bin/ bugfixes of breaking changes
3. Documenteer bevindingen en edge cases
4. **Minimaal 2-3 CC releases afwachten** met bin/ stabiliteit

**Risico**: Laag — alleen eigen gebruik.

### Fase 3: Marketplace distributie
1. Maak eigen marketplace repo (of voeg toe aan bestaande)
2. `claude plugin install ensemble@<marketplace>`
3. Update README met plugin installatie als optie
4. Update setup-claude-code.sh met plugin-detectie
5. Publiceer naar npm met plugin bestanden

**Risico**: Marketplace setup, dubbele skill registratie.

### Fase 4: (Toekomst) Plugin-first
1. Plugin wordt primary installatiemethode
2. setup-claude-code.sh wordt fallback-only
3. Overweeg deprecation van manual setup

**Risico**: Marketplace afhankelijkheid.

---

## 7. Permissiemodel

### Legacy (ongewijzigd, primary)
```json
// ~/.claude/settings.json — beheerd door setup-claude-code.sh
{
  "permissions": {
    "allow": [
      "Bash(/absolute/path/to/ensemble/scripts/collab-launch.sh:*)",
      "Bash(/absolute/path/to/ensemble/scripts/collab-poll.sh:*)",
      "Bash(/absolute/path/to/ensemble/scripts/collab-status.sh:*)",
      "Bash(/absolute/path/to/ensemble/scripts/collab-cleanup.sh:*)",
      "Bash(/absolute/path/to/ensemble/scripts/collab-replay.sh:*)",
      "Bash(/absolute/path/to/ensemble/scripts/ensemble-bridge.sh:*)"
    ]
  }
}
```

### Modern (plugin-managed) — ONBEVESTIGD
Uit onderzoek: bin/ executables worden op PATH gezet maar zijn **NIET auto-allowed**. User moet:
- Handmatig goedkeuren bij eerste gebruik, OF
- Pre-approven: `"Bash(collab-launch:*)"` in settings.json

**TODO**: Testen of CC hooks of plugin config een manier bieden om permissions te declareren. Zo niet, dan moet de skill of README de user instrueren om permissions goed te keuren.

**Kritiek punt**: `team-say.sh` en `team-read.sh` worden door **agent subprocessen** aangeroepen (niet door CC zelf). Deze scripts moeten uitvoerbaar zijn ongeacht het CC permission model. Agents draaien in tmux met eigen sandbox → plugin bin/ permissions zijn irrelevant voor agent messaging.

---

## 8. Failure Modes & Mitigaties

| Failure Mode | Impact | Mitigatie |
|---|---|---|
| Plugin bin niet op PATH | /collab faalt als SKILL.md bare commands verwacht | Legacy SKILL.md met absolute paden blijft primary |
| bin/ naamconflict (ensemble.cjs) | CC pikt .cjs op als executable | Test of CC .cjs negeert; anders wrapper extensieloos houden |
| Plugin manifest format wijzigt | Plugin laadt niet | Versioned manifest; monitor CC changelog |
| Dubbele skill registratie | /collab en /ensemble:collab bestaan allebei | Acceptabel — verschillende namespaces, geen conflict |
| npm global install in sandboxed env | scripts/ niet executable | postinstall.cjs chmod fix (bestaand) |
| CC downgrade na --plugin-dir gebruik | Geen impact — plugin niet permanent geïnstalleerd | N/A |
| bin/ feature bugs in vroege CC versies | Commands falen | Wacht op stabilisatie (fase 2 soak period) |
| Agent subprocess kan plugin-bin niet vinden | team-say/team-read falen in tmux | Niet relevant: agents gebruiken absolute scriptpaden |
| Permission prompt bij elke collab-launch | Slechte UX | Documenteer pre-approve stap of onderzoek plugin permissions |

---

## 9. Directory Structuur Na Migratie

```
ensemble/
├── .claude-plugin/                 # NIEUW: CC plugin manifest
│   └── plugin.json
├── bin/                            # npm bin + plugin bin wrappers
│   ├── ensemble.cjs                # Bestaand: npm CLI wrapper
│   ├── postinstall.cjs             # Bestaand: chmod scripts
│   ├── collab-launch               # NIEUW: → scripts/collab-launch.sh
│   ├── collab-poll                 # NIEUW: → scripts/collab-poll.sh
│   ├── collab-status               # NIEUW: → scripts/collab-status.sh
│   ├── collab-cleanup              # NIEUW: → scripts/collab-cleanup.sh
│   ├── collab-replay               # NIEUW: → scripts/collab-replay.sh
│   ├── ensemble-bridge             # NIEUW: → scripts/ensemble-bridge.sh
│   ├── team-say                    # NIEUW: → scripts/team-say.sh
│   └── team-read                   # NIEUW: → scripts/team-read.sh
├── skill/
│   └── SKILL.md                    # Ongewijzigd — legacy template
├── skills/                         # NIEUW: plugin skill directory
│   └── collab/
│       └── SKILL.md                # Plugin variant met bare commands
├── scripts/                        # Ongewijzigd — source of truth
│   ├── collab-launch.sh
│   ├── collab-poll.sh
│   ├── collab-paths.sh
│   ├── collab-status.sh
│   ├── collab-cleanup.sh
│   ├── collab-replay.sh
│   ├── collab-livefeed.sh
│   ├── ensemble-bridge.sh
│   ├── team-say.sh
│   ├── team-read.sh
│   ├── setup-claude-code.sh        # Ongewijzigd in fase 0-2
│   ├── generate-replay.py
│   └── parse-messages.py
├── cli/                            # Ongewijzigd
├── lib/                            # Ongewijzigd
├── server.ts                       # Ongewijzigd
├── package.json                    # Gewijzigd: files[] + .claude-plugin/ + skills/
└── ...
```

---

## 10. Beantwoorde Vragen

| # | Vraag | Antwoord | Status |
|---|-------|----------|--------|
| 1 | Plugin manifest spec | `.claude-plugin/plugin.json`, alleen `name` verplicht | ✅ Beantwoord |
| 2 | bin/ PATH mechanisme | Auto-added to Bash tool PATH, niet gesymlinkt | ✅ Beantwoord |
| 3 | Plugin skill registratie | Auto-discovery via `skills/*/SKILL.md`, namespace = `/ensemble:collab` | ✅ Beantwoord |
| 4 | Marketplace publicatie | Eigen repo als marketplace of toevoeging aan bestaande | ✅ Beantwoord |
| 5 | Multi-platform | Buiten scope — ensemble is tmux-based, macOS/Linux only | ✅ Beantwoord |

## 11. Open Vragen (moeten getest worden)

1. **bin/ naamconflict**: Pikt CC `ensemble.cjs` en `postinstall.cjs` op als plugin executables?
2. **Permissions**: Hoe werkt permission granting voor plugin bin commands exact in praktijk?
3. **--plugin-dir + setup-claude-code**: Kunnen beide tegelijk actief zijn zonder conflicten?
4. **Marketplace eigen repo**: Wat is het minimale format voor een eigen marketplace?
5. **Stabiliteit bin/ feature**: Tracking van CC releases met bin/-gerelateerde fixes

---

## 12. Aanbevolen Volgende Stappen

1. **Test lokaal** — `claude --plugin-dir ./ensemble` na toevoegen `.claude-plugin/plugin.json`
2. **Verifieer bin/ conflict** — Controleer of .cjs bestanden problemen geven
3. **Test permissions** — Worden bin/ commands geprompt of geblokt?
4. **Wacht 2-3 CC releases** — Monitor v2.1.92+ voor bin/ fixes
5. **Dan pas implementeer Fase 1** — Plugin-ready maken
6. **Soak period** — Zelf dagelijks gebruiken voordat anderen het krijgen
