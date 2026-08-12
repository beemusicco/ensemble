# One answer to "which python runs a hook's gate". Sourced, never executed.
#
# `python3` on PATH is not always an interpreter: the modern-python plugin
# installs a shim at security-tools/installed/trailofbits-skills/.../shims/python3
# that refuses a bare invocation and prints "Use `uv run python3` instead".
# A hook that calls bare python3 therefore does not degrade — it exits non-zero,
# and because the secret gate runs first and fails closed, every commit in every
# guarded repo is refused with an error about python rather than about secrets.
# That is how it presented on 2026-08-12: a clean commit rejected by the gate
# that never got to scan anything.
#
# Three call sites across pre-commit and pre-push had the same line, so the fix
# is one function rather than three edits. Override with HOOK_PYTHON=/path/to/python.
hook_python() {
  if [ -n "${HOOK_PYTHON:-}" ]; then
    "$HOOK_PYTHON" "$@"
  elif command -v uv >/dev/null 2>&1; then
    uv run --no-project python3 "$@"
  else
    python3 "$@"
  fi
}
