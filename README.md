# Grok Build ↔ Claude Code Bridge

Bridge [Grok Build](https://x.ai) / **Turbo Grok Build** into Claude Code for review, critique, delegation, and session import.

**Current plugin version: `0.6.7`.** Full isolation guarantees, verify semantics, and changelog live in [`plugins/grok-build/README.md`](plugins/grok-build/README.md).

This repository is a Claude Code marketplace plugin that shells out to a real agent CLI (`turbo` preferred, then `grok`). Run status, results, and stop are owned by the plugin (PID + log files). There is no app-server broker.

## Requirements

- Node.js `>= 18.18`
- **Turbo Grok Build** (`turbo`, preferred) or stock Grok Build CLI (`grok`) on `PATH`, or set `GROK_BINARY`
  - Prefer **Turbo `1.0.0-rc.1+`**. `1.0.0-rc.2+` adds `turbo version --json` identity (`agentCompatible`, `permissionToolPrefixes`) and Claude-compat deny aliases (`NotebookEdit` / `MultiEdit`)
  - The bridge probes identity and filters unknown `--deny` / `--allow` prefixes so older CLIs do not hard-abort
- A logged-in session (`turbo models` / `grok models` succeeds; some forks exit non-zero on a successful listing — the bridge treats a model list as success)

## Local install

From this repository root (path must be absolute):

```bash
# Resolve an absolute path to this clone, then add it as a local marketplace
claude plugin marketplace add "$(pwd)"
# example: claude plugin marketplace add /absolute/path/to/grok-build-plugin-cc

# Install the plugin from that marketplace
claude plugin install grok-build@xai-grok-build
```

Or, when Claude Code is already open, use `/plugin` and add the local marketplace path, then install `grok-build@xai-grok-build`.

## Check readiness

```text
/grok-build:check
```

Ready means: Node is available, `grok` is available, and soft auth via `grok models` succeeds.

## Commands

### `/grok-build:check`

Probe Node + Grok CLI availability and authentication.

### `/grok-build:review`

Read-only review of local git state:

```text
/grok-build:review --wait
/grok-build:review --background --scope working-tree
/grok-build:review --base main
/grok-build:review --wait --model grok-build --effort high
```

Runs (read-only):

```bash
turbo -p <prompt> --agent explore --permission-mode plan --sandbox read-only --deny Edit(*) --cwd <ws> --output-format streaming-json
```

(Write-capable delegate runs use `--always-approve` and, on Windows, `--job-object` so stop can tear down the process tree.)

Optional: pass `--model` / `--effort` (`none|minimal|low|medium|high|xhigh|max|ultra`). If omitted, the CLI chooses defaults.
Pay-per-token models (`openai/*`) require `GROK_BUILD_ALLOW_PAY_PER_TOKEN=1`.

### `/grok-build:critique`

Same target selection as review, with a design/risk critique prompt and structured JSON output when possible:

```text
/grok-build:critique --wait
/grok-build:critique --base main challenge whether this was the right caching and retry design
/grok-build:critique --wait --model grok-build --effort high focus on failure modes
```

Optional: same `--model` / `--effort` flags as review.

### `/grok-build:delegate`

Delegate investigation or implementation to Grok via the `grok-build:grok-delegate` subagent:

```text
/grok-build:delegate investigate the flaky test in auth
/grok-build:delegate --resume apply the top fix
/grok-build:delegate --model grok-build --effort high fix the race
```

Write policy layering:

| Layer | Default |
| --- | --- |
| Bridge `run` CLI | **Read-only** (`--deny Edit/Write` + plan/sandbox) unless you pass `--write` |
| Delegate agent / skill | Adds `--write` by policy (write-capable delegate) unless the user asks for read-only |

- Direct `node …/grok-bridge.mjs run "…"` is therefore read-only unless `--write` is passed.
- `--resume` / `--resume-last` continues the last stored Grok session id via `<cli> -r <id>` (resolved binary, usually `turbo`).
- Prefer bridge `--background` for long work so runs record both `bridgePid` (Node worker) and `agentPid` (grok child).
- `/grok-build:stop` terminates **both** process trees when present (agent then bridge/worker).
- If you do not pass `--model` or `--effort`, Grok chooses its own defaults.

#### Pre-agent verify baseline

A **write** run with a verify plan measures that plan once *before* the agent starts, so
failures that were already present are never blamed on the run. On an engine project with a
cold cache (Godot's first `--import`, a fresh `cargo build`) that baseline can run for
minutes while `agentPid` is still `null`.

- The launch output and `run --json` both report it up front, under `verify.baseline`.
- Each command is logged as it starts and as it finishes, with its duration and whether it
  was already passing.
- Pass `--no-verify-baseline` to skip it when you have just verified the tree yourself.
  Verification then becomes strict: with no baseline to compare against, **every** failure
  counts as this run's.

#### Background runs and concurrent polling

The `run --background` + poll `runs` loop is safe to drive as fast as you like. Job records
are written with a contended-rename retry and read with a torn-read retry, because Windows
refuses a rename over any file another process has open — and the poller is that process.

If a background worker ever does die, it now says why: its interpreter output is captured to
`<state-dir>/jobs/<run-id>.worker.err`, and the run's `errorMessage` carries the tail of it
rather than only "Run abandoned; process exited without a terminal claim."

### `/grok-build:import`

Import the current Claude transcript into Grok:

```text
/grok-build:import
/grok-build:import --source ~/.claude/projects/.../session.jsonl
```

Uses `<cli> import` and prints a resume hint: `<cli> -r <id>` (resolved binary, usually `turbo`).

### `/grok-build:runs`

List active and recent plugin-owned runs:

```text
/grok-build:runs
/grok-build:runs <run-id> --wait
/grok-build:runs --json
```

`runs --json` emits **schemaVersion 2** (`runs[]` with usage, isolation, stopReason,
toolCallCount, etc.). The legacy top-level keys `running`, `latestFinished`, and `recent`
are still present for one minor version (also under `compat`); prefer `runs` + `compat`.

### `/grok-build:show`

Show stored output for a finished run:

```text
/grok-build:show
/grok-build:show <run-id>
```

Every show result ends with a machine-readable `===BRIDGE-RESULT===` trailer (status,
isolation, usage, land hint).

### `/grok-build:stop`

Stop an active run by terminating tracked process trees:

```text
/grok-build:stop
/grok-build:stop <run-id>
```

Kills every distinct pid among `agentPid` (detached grok child) and `bridgePid` / legacy `companionPid` / legacy `pid` (bridge or run-worker). Terminal status is claimed under a locked CAS so a finishing worker cannot overwrite `cancelled` with `completed`.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Optional override for the CLI executable (default resolution: `turbo`, then `grok`; Hyper overrides are ignored) |
| `GROK_BUILD_JOB_OBJECT` | Windows: set to `0`/`false` to skip passing `--job-object` on headless spawns (default: on for `win32`) |
| `GROK_BUILD_ALLOW_WEAK_ISOLATE` | Set to `1` to allow isolated write runs when the CLI does not advertise `--confine` (default: refuse) |
| `GROK_BUILD_ALLOW_PAY_PER_TOKEN` | Set to `1` to allow `openai/*` pay-per-token models |
| `GROK_CC_SESSION_ID` | Claude session id (set by SessionStart hook) |
| `GROK_CC_TRANSCRIPT_PATH` | Claude transcript path (set by SessionStart hook) |
| `CLAUDE_PLUGIN_ROOT` | Plugin install root (host) |
| `CLAUDE_PLUGIN_DATA` | Plugin data root; state lives under `.../state` |
| `CLAUDE_ENV_FILE` | Host env file for session hooks |
| `CLAUDE_PROJECT_DIR` | Project directory from the host |
| `HOME` / `GROK_HOME` | Where the CLI keeps config, credentials and sessions. On Windows the bridge defaults both to `%USERPROFILE%` when neither is set; an explicit value is never overwritten. |

State fallback when `CLAUDE_PLUGIN_DATA` is unset: `$TMPDIR/grok-cc-runs`.

## Release notes (0.6.7)

Harness hardening for Turbo Grok Build 1.0:

- Structured critique reads Turbo `structuredOutput` / `structuredOutputError` (not free-form text alone)
- JSON envelope accepts integer `toolCalls`; streaming records malformed NDJSON lines with reasons
- Stop / session-end **claim terminal before kill** so a finishing runner cannot win `completed` over stop
- Max-duration kill uses production PID fallbacks; porcelain isolation is fail-closed when git status is unreadable
- CLI identity via `version --json`; deny/allow prefixes from `permissionToolPrefixes` when advertised
- Windows headless passes `--job-object` by default

See [`plugins/grok-build/README.md`](plugins/grok-build/README.md) for the full changelog.

## Development

```bash
npm test
npm run check-version
```

Tests use Node's built-in test runner and a fake CLI binary on `PATH`. Runtime code uses Node stdlib only.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
