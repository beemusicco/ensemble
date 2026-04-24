# Ensemble Benchmark Harness

Measure whether `/collab` adds value over running a single Claude Code session. The harness seeds a throwaway workspace from a task JSON, runs the agent in either **solo** (one `claude` CLI) or **collab** (ensemble team) mode, then runs deterministic verify steps (shell commands with expected stdout / exit codes).

## Run a single task

```bash
# Solo baseline
tsx bench/runner.ts --task add-cli-flag --mode solo

# Collab
tsx bench/runner.ts --task add-cli-flag --mode collab

# Head-to-head
tsx bench/runner.ts --task add-cli-flag --mode both
```

## Run everything

```bash
tsx bench/runner.ts --all
```

Results are written to `bench/results/run-<ts>.json`. The console report shows per-trial pass/fail + duration plus a per-mode rollup (avg seconds, pass rate).

## Adding a task

Drop a new JSON into `bench/tasks/`. Required fields:
- `id`: filename without `.json`
- `description`: agent prompt (use `BENCH_WORKSPACE` for the temp dir path)
- `workspaceSeed`: filename → file contents
- `verify`: array of steps. Each step is one of:
  - `cmd` + `expectStdoutContains` and/or `expectExitCode`
  - `startBackground` + optional `waitForPort` — kept alive until step array finishes
- `timeoutSeconds`: cap total trial duration (default 600)

## What to look for

The question is: **does collab add value for its latency cost?** Expect collab to take 3-10x longer than solo. If pass rates match, collab is pure overhead for the task class. If collab's pass rate is materially higher, the multi-agent architecture earns its keep.

Scaffolding gap research (April 2026) suggests differences of 5-15 percentage points are plausible; smaller deltas are probably noise on small task counts.
