#!/usr/bin/env bash
# team-stats-telegram — push weekly calibration digest to operator's Telegram.
# Usage:
#   team-stats-telegram                # 7-day window, default
#   team-stats-telegram --window=30    # 30-day window
#
# Designed to run from launchd weekly cron. See:
#   launchd/co.openclaw.ensemble-stats-telegram.plist.template
set -euo pipefail

WINDOW="${1:---window=7}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Render scoreboard text, prefix with a small header so it's clear where it came from
{
  echo "📈 Weekly ensemble calibration digest"
  echo
  "$SCRIPT_DIR/team-stats.sh" "$WINDOW"
} | (cd "$ROOT_DIR" && exec npx tsx cli/telegram-send.ts)
