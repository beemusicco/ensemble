#!/usr/bin/env bash
set -euo pipefail

LABEL="co.openclaw.ensemble"
PLIST_NAME="${LABEL}.plist"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENSEMBLE_ROOT="${ENSEMBLE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
TEMPLATE="${ENSEMBLE_ROOT}/launchd/${PLIST_NAME}.template"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
TARGET_PLIST="${LAUNCH_AGENTS_DIR}/${PLIST_NAME}"
DATA_DIR="${ENSEMBLE_DATA_DIR:-${HOME}/.ensemble}"
LOG_DIR="${DATA_DIR}/logs"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
ENSEMBLE_HOST="${ENSEMBLE_HOST:-127.0.0.1}"
ENSEMBLE_PORT="${ENSEMBLE_PORT:-23000}"

plist_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

render_template() {
  local node_bin root host port data_dir log_dir line
  node_bin="$(plist_escape "$NODE_BIN")"
  root="$(plist_escape "$ENSEMBLE_ROOT")"
  host="$(plist_escape "$ENSEMBLE_HOST")"
  port="$(plist_escape "$ENSEMBLE_PORT")"
  data_dir="$(plist_escape "$DATA_DIR")"
  log_dir="$(plist_escape "$LOG_DIR")"

  while IFS= read -r line; do
    if [ "$line" = "__OPTIONAL_AUTH_TOKEN__" ]; then
      if [ -n "${ENSEMBLE_AUTH_TOKEN:-}" ]; then
        printf '    <key>ENSEMBLE_AUTH_TOKEN</key>\n'
        printf '    <string>%s</string>\n' "$(plist_escape "$ENSEMBLE_AUTH_TOKEN")"
      fi
      continue
    fi
    line="${line//__NODE_BIN__/$node_bin}"
    line="${line//__ENSEMBLE_ROOT__/$root}"
    line="${line//__ENSEMBLE_HOST__/$host}"
    line="${line//__ENSEMBLE_PORT__/$port}"
    line="${line//__ENSEMBLE_DATA_DIR__/$data_dir}"
    line="${line//__LOG_DIR__/$log_dir}"
    printf '%s\n' "$line"
  done < "$TEMPLATE"
}

install_service() {
  if [ ! -r "$TEMPLATE" ]; then
    echo "Template not found: $TEMPLATE" >&2
    exit 1
  fi

  mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"
  render_template > "$TARGET_PLIST"
  chmod 600 "$TARGET_PLIST"

  launchctl unload "$TARGET_PLIST" >/dev/null 2>&1 || true
  launchctl load "$TARGET_PLIST"
  echo "Installed and loaded ${TARGET_PLIST}"
}

uninstall_service() {
  if [ -e "$TARGET_PLIST" ]; then
    launchctl unload "$TARGET_PLIST" >/dev/null 2>&1 || true
    rm -f "$TARGET_PLIST"
    echo "Uninstalled ${TARGET_PLIST}"
  else
    echo "No launchd plist found at ${TARGET_PLIST}"
  fi
}

case "${1:-install}" in
  install)
    install_service
    ;;
  uninstall)
    uninstall_service
    ;;
  *)
    echo "Usage: $0 [install|uninstall]" >&2
    exit 2
    ;;
esac
