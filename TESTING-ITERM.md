# Testing: iTerm Native Monitor

Branch: `feat/iterm-monitor`
Worktree: `~/ensemble/worktrees/iterm-monitor`

## What changed

Before: collab monitor always ran inside tmux (split pane if `$TMUX` was set, otherwise a detached `ensemble-<ID>` session you had to `tmux attach` to).

After: on macOS + iTerm2 without tmux, `collab-launch.sh` now opens the monitor in a **native iTerm2 split pane** via `osascript`. No tmux involvement at all.

## Files touched

- `scripts/open-iterm-monitor.sh` (new) — AppleScript launcher. Modes: `split` (default), `tab`, `window`.
- `scripts/collab-launch.sh` — detection + fallback chain.
- `skill/SKILL.md` — bumped to `6.1.0`, documents `ITERM_NATIVE` mode and env vars.

## Monitor selection logic

1. `COLLAB_MONITOR=none` → no monitor
2. Inside tmux (`$TMUX` set) and `COLLAB_MONITOR != iterm` → tmux split pane (unchanged)
3. macOS + `TERM_PROGRAM=iTerm.app` + not in tmux → iTerm native split
4. Forced `COLLAB_MONITOR=iterm` → iTerm native split (errors out if not macOS/iTerm)
5. Otherwise → detached tmux session (legacy fallback)

Env vars:
- `COLLAB_MONITOR=tmux|iterm|none` — force a mode
- `COLLAB_ITERM_MODE=split|tab|window` — iTerm layout (default `split`)

## How to test

Open a fresh Claude Code session **inside this worktree**:

```bash
cd ~/ensemble/worktrees/iterm-monitor
claude
```

Then ask Claude:

> Test the collab skill in iTerm native mode. Launch a small collab task ("Say hi to each other and disband") and check that the monitor opens as an iTerm split pane, not a tmux session.

Claude should:
1. Detect `ITERM_NATIVE` in step 0
2. Run `collab-launch` (which calls `scripts/collab-launch.sh` from *this* worktree — verify by checking the output says `Monitor opened (iTerm split)`)
3. A new vertical split should appear in your current iTerm window showing the TUI monitor
4. Wait in the background for `.finished`
5. Show the summary when done

## Manual smoke test (without Claude)

```bash
cd ~/ensemble/worktrees/iterm-monitor
./scripts/open-iterm-monitor.sh "$(pwd)" test-fake-id split
# Should open a new iTerm split. It will error on the monitor command
# because team 'test-fake-id' does not exist — that is expected.
```

## Known caveats

- The worktree uses the **same** `/usr/local/bin/collab-launch` shim, which still points at `~/ensemble/scripts/collab-launch.sh` (main checkout). To actually exercise the new logic via the shim, either:
  - (a) Run the worktree's script directly: `./scripts/collab-launch.sh "$(pwd)" "task"`, OR
  - (b) Temporarily repoint the shim: `echo 'exec ~/ensemble/worktrees/iterm-monitor/scripts/collab-launch.sh "$@"' | sudo tee /usr/local/bin/collab-launch`
- The installed collab skill at `~/.claude/skills/collab/SKILL.md` is **not** from this worktree. To test the updated skill text, copy it: `cp skill/SKILL.md ~/.claude/skills/collab/SKILL.md` (reversible — `git checkout main -- skill/SKILL.md` in main worktree to restore).
- `osascript` will fail silently if iTerm2 is not the frontmost app when invoked; the script guards against iTerm not running at all but not against backgrounded state. If the split appears in the wrong window, that's why.
- The iTerm pane is not tracked by any PID file. Cleanup on `disband` does not close it — user closes it manually (`q` in the monitor, or Cmd+W).

## Rollback

```bash
cd ~/ensemble
git worktree remove worktrees/iterm-monitor
git branch -D feat/iterm-monitor
```
