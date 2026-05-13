#!/usr/bin/env python3
"""collab-slot-parser — reads new messages.jsonl lines from stdin, looks for
[SLOT_TABLE_v1] block from the LEAD agent, validates, and writes
slot-table.json atomically. Companion to collab-slot-watcher.sh.

Args:
  team_id           the team UUID
  slot_table_path   /tmp/ensemble/<team>/slot-table.json
  runtime_dir       /tmp/ensemble/<team>/

Exits:
  0  success (table written OR no SLOT_TABLE_v1 in input)
  1  invalid SLOT_TABLE detected (errored to .slot-table-error)
"""

import json, sys, re
from pathlib import Path

if len(sys.argv) < 4:
    sys.exit(0)

team_id = sys.argv[1]
slot_table_path = Path(sys.argv[2])
runtime_dir = Path(sys.argv[3])

# Skip if already accepted
if slot_table_path.exists():
    sys.exit(0)

SLOT_BLOCK_RE = re.compile(
    r"\[SLOT_TABLE_v1\]\s*\n(.*?)\n\s*\[END_SLOT_TABLE\]",
    re.DOTALL,
)


def prefix(glob: str) -> str:
    """Strip glob suffixes to leave a literal-prefix for overlap checks."""
    g = glob.strip()
    for suffix in ("/**/*", "/**", "/*", "/"):
        if g.endswith(suffix):
            g = g[: -len(suffix)]
            break
    return g.rstrip("/")


def overlaps(a: str, b: str) -> bool:
    """Crude overlap: same prefix OR one prefix-of-other (with / boundary)."""
    pa, pb = prefix(a), prefix(b)
    if pa == pb:
        return True
    if pa and pb and (pa.startswith(pb + "/") or pb.startswith(pa + "/")):
        return True
    return False


for line in sys.stdin:
    try:
        msg = json.loads(line)
    except Exception:
        continue
    content = msg.get("content", "") or ""
    if "[SLOT_TABLE_v1]" not in content:
        continue
    sender = msg.get("from", "?")

    m = SLOT_BLOCK_RE.search(content)
    if not m:
        continue
    body = m.group(1)

    # Parse body
    slots = {}
    parse_err = None
    for ln in body.strip().splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        if ":" not in ln:
            parse_err = f"line lacks ':' separator: {ln[:80]}"
            break
        agent, globs_str = ln.split(":", 1)
        agent = agent.strip()
        globs = [g.strip() for g in re.split(r"[,\s]+", globs_str) if g.strip()]
        if not agent or not globs:
            parse_err = f"empty agent or globs: {ln[:80]}"
            break
        slots[agent] = globs

    if parse_err:
        (runtime_dir / ".slot-table-error").write_text(
            f"INVALID_PARSE: {parse_err}\nsender: {sender}"
        )
        sys.exit(1)

    if len(slots) < 2:
        (runtime_dir / ".slot-table-error").write_text(
            f"INVALID: need >=2 agents, got {len(slots)}\nsender: {sender}"
        )
        sys.exit(1)

    # Cross-agent overlap check
    agent_names = list(slots.keys())
    for i, a in enumerate(agent_names):
        for b in agent_names[i + 1 :]:
            for ga in slots[a]:
                for gb in slots[b]:
                    if overlaps(ga, gb):
                        msg_err = f"OVERLAP: {a}:{ga} and {b}:{gb}"
                        (runtime_dir / ".slot-table-error").write_text(
                            msg_err + f"\nsender: {sender}"
                        )
                        sys.exit(1)

    # Valid — atomic write
    tmp = slot_table_path.with_suffix(".tmp")
    with tmp.open("w") as f:
        json.dump(
            {
                "team_id": team_id,
                "published_by": sender,
                "published_at": msg.get("timestamp"),
                "slots": slots,
            },
            f,
            indent=2,
        )
    tmp.rename(slot_table_path)
    print(f"ACCEPTED: {len(slots)} agents, published by {sender}", file=sys.stderr)
    sys.exit(0)

sys.exit(0)
