#!/usr/bin/env bash
# backup-memory — WAL-safe backup of the ensemble SQLite memory DB.
#
# Uses sqlite3 .backup (atomic, WAL-aware) — never `cp`, which can corrupt
# mid-write. Target: ~/.ensemble/backups/memory-YYYY-MM-DD.db
# Retention: keeps the 14 most recent backups, deletes older.
#
# Cron candidate (daily 03:15):
#   15 3 * * *   /Users/you/.../scripts/backup-memory.sh >> ~/.ensemble/logs/backup.log 2>&1
set -euo pipefail

DATA_DIR="${ENSEMBLE_DATA_DIR:-$HOME/.ensemble}"
SRC="$DATA_DIR/memory.db"
BACKUP_DIR="$DATA_DIR/backups"
RETENTION=14

if [ ! -f "$SRC" ]; then
  echo "[backup-memory] no DB at $SRC — nothing to back up" >&2
  exit 0
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "[backup-memory] sqlite3 CLI not found — install it (brew install sqlite)" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TARGET="$BACKUP_DIR/memory-$(date +%Y-%m-%d).db"

# Atomic: write to .tmp, then rename. Survives signal interrupts cleanly.
TMP="${TARGET}.tmp.$$"
sqlite3 "$SRC" ".backup '$TMP'"
mv -f "$TMP" "$TARGET"

SIZE=$(wc -c < "$TARGET" | tr -d ' ')
SIZE_HUMAN=$(awk -v n="$SIZE" 'BEGIN {
  if (n < 1024) printf "%dB", n
  else if (n < 1048576) printf "%.1fKB", n/1024
  else printf "%.1fMB", n/1048576
}')
echo "[backup-memory] wrote $TARGET ($SIZE_HUMAN)"

# Retention: keep N most recent, delete rest
OLD=$(ls -1t "$BACKUP_DIR"/memory-*.db 2>/dev/null | tail -n +$((RETENTION + 1)) || true)
if [ -n "$OLD" ]; then
  echo "$OLD" | while read -r f; do
    [ -n "$f" ] || continue
    rm -f "$f"
    echo "[backup-memory] pruned $(basename "$f")"
  done
fi
