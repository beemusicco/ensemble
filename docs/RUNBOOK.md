# Collab Runbook

**When something's wrong, read this first.** Ordered by frequency of what actually breaks.

---

## 0. Quick status check

```bash
# List active teams
curl -sf http://localhost:23000/api/ensemble/teams | jq '.teams[] | select(.status=="active") | {id, name, agents: [.agents[].name]}'

# Full health of one team (JSON)
bash scripts/collab-health.sh <team-id>
# exit 0 = healthy/finished, 1 = degraded, 2 = dead

# Top-level: list any zombie procs
ps -ef | grep -E "ensemble-bridge|feed.txt" | grep -v grep
```

---

## 1. "My collab didn't pick up an expert"

**Symptom:** Agents' prompts don't contain `EXPERT MENTAL MODEL:`.

**Most likely cause:** old server running pre-2026-04-22 fix.

**Diagnose:**
```bash
# When did the server start?
ps -ef | grep -E "tsx.*server\.ts" | grep -v grep

# Does a fresh launch produce EXPERT lines?
bash scripts/collab-launch.sh /tmp "implement a test feature" "haiku"
sleep 3
TID=$(cat /tmp/collab-team-id.txt)
grep -l "EXPERT MENTAL MODEL" /tmp/ensemble/$TID/prompts/*.txt
bash scripts/collab-terminate.sh "$TID" --disband
```

**Fix:** restart ensemble server:
```bash
kill $(lsof -iTCP:23000 -sTCP:LISTEN -n -P -t 2>/dev/null)
./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &
```

Also check: did the launcher log show `Template: <name>`? If not, `detect_template` didn't match — task keywords didn't fire. Pass an explicit template: `COLLAB_TEMPLATE=implement ./collab-launch.sh …`.

---

## 2. "Agents keep saying 'Standing by' / 'Ready to assist' but nothing happens"

**Symptom:** message log fills with polite-ack filler, no actual progress.

**Should be auto-handled:** watchdog detects this via `isPoliteAckPhrase` + `isSemanticIdle`. After 3 ack-phrases in last 4 messages, it disbands the team.

**If not disbanding:**
```bash
# Check server log for watchdog output
tail -50 /tmp/ensemble-server.log | grep -i "watchdog\|idle\|disband"

# Force disband
bash scripts/collab-terminate.sh <tid> --disband
```

---

## 3. "Zombie processes after a collab finished"

**Symptom:** `ps -ef | grep ensemble` shows stale bridge supervisors or tail-feed loops from days ago.

**Diagnose:**
```bash
# How many zombies?
ps -ef | grep "feed.txt" | grep -v grep | wc -l
ps -ef | grep "ensemble-bridge-supervisor" | grep -v grep | wc -l
```

**Fix (safe — targets only teams with `.finished` marker):**
```bash
bash scripts/collab-cleanup.sh --force
```

**Root cause check:** did the `.finished` marker get written?
```bash
ls /tmp/ensemble/<tid>/.finished
```
If missing, ensemble-service didn't disband cleanly. Manually write it:
```bash
touch /tmp/ensemble/<tid>/.finished
sleep 6  # poller + supervisor check every few seconds
```

---

## 4. "Server won't start / port 23000 busy"

```bash
# Who owns :23000?
lsof -iTCP:23000 -sTCP:LISTEN -n -P

# Kill it
kill $(lsof -iTCP:23000 -sTCP:LISTEN -n -P -t)
sleep 2
./node_modules/.bin/tsx server.ts > /tmp/ensemble-server.log 2>&1 &
```

---

## 5. "Cross-contamination: my audit collab got crypto-trading task"

**Symptom:** you launch an accounting-helper collab, but the prompts end up containing a different task.

**Root cause (fixed in b3520b9 / 5dfd4a7):** shared `/tmp/collab-team-id.txt` race.

**Verify fix:**
```bash
# Post-fix launcher writes per-launcher-PID id file:
grep "PER_PARENT_FILE\|collab-team-\$PARENT_PID" scripts/collab-launch.sh
```

If cross-contamination still occurs: use the per-PID file from your parent shell:
```bash
MY_PPID=$$
bash scripts/collab-launch.sh /tmp "my task" "haiku"
TID=$(cat "/tmp/collab-team-$MY_PPID.txt")   # MY team, not someone else's
```

---

## 6. "Dispatch invoice failed" (accounting-helper specific)

Not in this repo — see `~/projects/accounting-helper/docs/ARCHITECTURE.md`.

---

## 7. Diagnostic commands you'll use a lot

```bash
# Watch a running collab live
bash scripts/collab-livefeed.sh <tid>

# Replay a finished collab as HTML
open /tmp/ensemble/<tid>/replay.html

# Dump messages
jq -c '[.from, .content[:120]]' /tmp/ensemble/<tid>/messages.jsonl | head -20

# Force-disband all active teams (nuclear)
curl -sf http://localhost:23000/api/ensemble/teams \
  | jq -r '.teams[] | select(.status=="active") | .id' \
  | while read tid; do
      bash scripts/collab-terminate.sh "$tid" --disband
    done
```

---

## 8. Tests you should run when something feels off

```bash
# Unit (polite-ack classifier, isSemanticIdle)
npm run test:unit

# Shell integration (16 invariants: template detect, expert inject, pgid, state, etc.)
npm run test:shell

# Both
npm run test:all
```

All 42 assertions should pass against `main`. A regression means someone landed a patch without running these.

---

## 9. Observability cheatsheet

```bash
# What state is team X in?
cat /tmp/ensemble/<tid>/.state
# → creating | active | finishing | finished

# Process group alive?
PGID=$(cat /tmp/ensemble/<tid>/.pgid)
pgrep -g "$PGID"

# Any agent prompts contain expert mental model?
grep -l "EXPERT MENTAL MODEL" /tmp/ensemble/<tid>/prompts/*.txt

# Full health snapshot
bash scripts/collab-health.sh <tid> | jq
```

---

## 10. When to page someone (or in your case: revisit the code)

- Same zombie count grows across launches → `.finished` isn't firing → check ensemble-service disband code path
- All new teams miss expert injection → `buildPromptPreview` regressed OR template detection broke → run `npm run test:shell`
- Agents stall for >15 min silently → watchdog broken → run `npm run test:unit`
- Cross-tenant contamination under auth-enabled mode → see accounting-helper audit H8 (separate project)
