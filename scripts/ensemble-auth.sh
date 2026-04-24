#!/usr/bin/env bash
# ensemble-auth.sh — Sourced helper for API auth.
# Exposes `ensemble_auth_header` which echoes "Authorization: Bearer <token>"
# reading from $ENSEMBLE_AUTH_TOKEN or ~/.ensemble/auth-token.

ensemble_auth_token() {
  if [ -n "${ENSEMBLE_AUTH_TOKEN:-}" ]; then
    printf '%s' "$ENSEMBLE_AUTH_TOKEN"
    return 0
  fi
  local data_dir="${ENSEMBLE_DATA_DIR:-$HOME/.ensemble}"
  local token_file="$data_dir/auth-token"
  if [ -r "$token_file" ]; then
    tr -d ' \n' < "$token_file"
    return 0
  fi
  return 1
}

ensemble_auth_header() {
  local token
  if ! token=$(ensemble_auth_token) || [ -z "$token" ]; then
    echo "[ensemble-auth] WARNING: no auth token found (set ENSEMBLE_AUTH_TOKEN or start server once)" >&2
    printf 'Authorization: Bearer MISSING'
    return 1
  fi
  printf 'Authorization: Bearer %s' "$token"
}
