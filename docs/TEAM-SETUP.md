# Team Setup

How to onboard a teammate onto a shared ensemble server.

## Topology options

### Option A — one shared server, many clients (recommended for small teams)

One machine (say yours) runs `ensemble start`. Everyone else's CLI points at it and authenticates with the shared token.

Good for: billing collab sessions against one subscription, keeping memory/traces centralised, letting teammates resume each other's teams.

### Option B — everyone runs their own server

Each teammate has `ensemble start` on their own machine. They share tasks by topic, not by runtime. Each person's agents burn their own subscription quota.

Good for: independent experimentation, no shared state.

This document covers Option A. Option B is just "everyone installs the package" — no extra setup.

---

## Server owner (once)

1. **Start the server** on a reachable host. Defaults to `127.0.0.1` — change if teammates need LAN/VPN reach:
   ```bash
   # Local only (your own use)
   ensemble start

   # Listen on all interfaces (behind Tailscale, VPN, or reverse proxy)
   ENSEMBLE_HOST=0.0.0.0 ensemble start
   ```
   Do NOT expose `0.0.0.0` directly to the public internet. Tailscale or SSH tunnel is the safe pattern.

2. **Generate the onboarding snippet**:
   ```bash
   ensemble auth share
   ```
   Output:
   ```
   Team onboarding snippet — paste this into your teammate's shell:

     export ENSEMBLE_URL=http://100.x.y.z:23000
     export ENSEMBLE_AUTH_TOKEN=<64-hex-token>

   ⚠  Share this via 1Password / Bitwarden / Keychain, NOT email or chat.
   ```

3. **Send it securely** — 1Password vault, Bitwarden send, in-person. Never email or Slack.

---

## Teammate (once)

1. Install the CLI (same package as the server owner).
2. Paste the two `export` lines into your shell profile (`~/.zshrc` or `~/.bashrc`).
3. Test connectivity:
   ```bash
   ensemble status
   ```
   Should show `Server healthy` + list of active teams.
4. Start using it:
   ```bash
   ensemble run "audit the auth module for race conditions"
   ensemble teams
   ensemble monitor --latest
   ```

---

## Rotating the token

If the token leaks, or a teammate leaves:

```bash
# On the server owner's box:
ensemble auth rotate

# Restart the server so in-flight checks use the new token:
pkill -f "tsx server.ts" && ensemble start &

# Re-share with remaining team members:
ensemble auth share
```

Old token is dead the moment the server restarts with the new one.

---

## What team members share

| Resource | Scope |
|----------|-------|
| Active teams (`ensemble teams`) | All — anyone can see/steer/disband any team |
| Memory (`team-remember` / `team-recall`, scope=global) | All — shared knowledge base |
| Traces (`~/.ensemble/logs/traces-*.jsonl`) | Server-local — only the host sees |
| Structured logs (`~/.ensemble/logs/ensemble-*.jsonl`) | Server-local — only the host sees |
| Expert profiles (`~/.openclaw/context-profiles/experts/*.md`) | Per-machine — the server host's profiles win |

If you add a new expert profile on the server machine, it's immediately available to every teammate's collab session.

---

## Remote agents across machines

Ensemble supports spawning agents on *other* hosts via `lib/hosts-config.ts`. Populate `~/.ensemble/hosts.json` on the server with each machine's URL. Then in a team create request:

```json
{
  "agents": [
    { "program": "codex", "role": "lead", "hostId": "mac-studio-01" },
    { "program": "claude", "role": "worker", "hostId": "mac-mini-02" }
  ]
}
```

Each machine runs its own tmux / codex / claude CLI; the server orchestrates and messages flow through HTTP. This is not needed for most teams — single-host is simpler.

---

## Production checklist for team use

- [x] Bearer auth required on all `/api/ensemble/*`
- [x] Health endpoint unauthenticated (for liveness checks)
- [x] Rate limiting (500/min per IP)
- [x] CORS allow-list (localhost by default; configure via `ENSEMBLE_CORS_ORIGIN`)
- [x] Persistent SQLite memory survives server restarts
- [x] Traces + structured logs for postmortem debugging
- [x] Deterministic close via `team-done.sh` (no stuck teams)
- [x] 97/97 unit tests + 16/16 shell assertions passing

Not covered here (public-npm territory, not team-use):
- Per-user tokens (revocation granularity)
- Public OpenAPI schema
- Multi-tenant isolation

For a small trusted team, single-token + shared server is the right balance.
