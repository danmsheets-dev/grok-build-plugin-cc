# Turbo Build Plugin

Claude Code bridge for review, critique, delegation, and session import. Shells out to **Turbo Grok Build** (`turbo`, preferred) or stock `grok`.

**Current plugin version: `0.7.0`.** Full isolation guarantees, verify semantics, and changelog live in [`plugins/turbo-build-plugin/README.md`](plugins/turbo-build-plugin/README.md).

Run status, results, and stop are owned by the plugin (PID + log files). There is no app-server broker. This is an independent fork of the original xAI Grok Build plugin, rebranded and maintained at [danmsheets-dev/turbo-build-plugin](https://github.com/danmsheets-dev/turbo-build-plugin).

## Requirements

- Node.js `>= 18.18`
- **Turbo Grok Build** (`turbo`, preferred) or stock Grok Build CLI (`grok`) on `PATH`, or set `GROK_BINARY`
  - Prefer **Turbo `1.0.0-rc.1+`**. `1.0.0-rc.2+` adds `turbo version --json` identity (`agentCompatible`, `permissionToolPrefixes`) and Claude-compat deny aliases (`NotebookEdit` / `MultiEdit`)
  - The bridge probes identity and filters unknown `--deny` / `--allow` prefixes so older CLIs do not hard-abort
- A logged-in session (`turbo models` / `grok models` succeeds; some forks exit non-zero on a successful listing — the bridge treats a model list as success)

## Install

### GitHub marketplace (release)

```bash
/plugin marketplace add danmsheets-dev/turbo-build-plugin
/plugin install turbo-build-plugin@turbo-build
/reload-plugins
```

### Local install (from a clone)

From this repository root (path must be absolute):

```bash
# Resolve an absolute path to this clone, then add it as a local marketplace
claude plugin marketplace add "$(pwd)"
# example: claude plugin marketplace add /absolute/path/to/turbo-build-plugin

# Install the plugin from that marketplace
claude plugin install turbo-build-plugin@turbo-build
```

Or, when Claude Code is already open, use `/plugin` and add the local marketplace path, then install `turbo-build-plugin@turbo-build`.

## Check readiness

```text
/turbo-build-plugin:check
```

Ready means: Node is available, `grok` is available, and soft auth via `grok models` succeeds.

## Commands

### `/turbo-build-plugin:check`

Probe Node + Grok CLI availability and authentication.

### `/turbo-build-plugin:review`

Read-only review of local git state:

```text
/turbo-build-plugin:review --wait
/turbo-build-plugin:review --background --scope working-tree
/turbo-build-plugin:review --base main
/turbo-build-plugin:review --wait --model grok-build --effort high
```

Runs (read-only):

```bash
turbo -p <prompt> --agent explore --permission-mode plan --sandbox read-only --deny Edit(*) --cwd <ws> --output-format streaming-json
```

(Write-capable delegate runs use `--always-approve` and, on Windows, `--job-object` so stop can tear down the process tree.)

Optional: pass `--model` / `--effort` (`none|minimal|low|medium|high|xhigh|max|ultra`). If omitted, the CLI chooses defaults.
Pay-per-token models (`openai/*`) require `GROK_BUILD_ALLOW_PAY_PER_TOKEN=1`.

### `/turbo-build-plugin:critique`

Same target selection as review, with a design/risk critique prompt and structured JSON output when possible:

```text
/turbo-build-plugin:critique --wait
/turbo-build-plugin:critique --base main challenge whether this was the right caching and retry design
/turbo-build-plugin:critique --wait --model grok-build --effort high focus on failure modes
```

Optional: same `--model` / `--effort` flags as review.

### `/turbo-build-plugin:delegate`

Delegate investigation or implementation to Grok via the `turbo-build-plugin:turbo-delegate` subagent:

```text
/turbo-build-plugin:delegate investigate the flaky test in auth
/turbo-build-plugin:delegate --resume apply the top fix
/turbo-build-plugin:delegate --model grok-build --effort high fix the race
```

Write policy layering:

| Layer | Default |
| --- | --- |
| Bridge `run` CLI | **Read-only** (`--deny Edit/Write` + plan/sandbox) unless you pass `--write` |
| Delegate agent / skill | Adds `--write` by policy (write-capable delegate) unless the user asks for read-only |

- Direct `node …/grok-bridge.mjs run "…"` is therefore read-only unless `--write` is passed.
- `--resume` / `--resume-last` continues the last stored Grok session id via `<cli> -r <id>` (resolved binary, usually `turbo`).
- Prefer bridge `--background` for long work so runs record both `bridgePid` (Node worker) and `agentPid` (grok child).
- `/turbo-build-plugin:stop` terminates **both** process trees when present (agent then bridge/worker).
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

### `/turbo-build-plugin:import`

Import the current Claude transcript into Grok:

```text
/turbo-build-plugin:import
/turbo-build-plugin:import --source ~/.claude/projects/.../session.jsonl
```

Uses `<cli> import` and prints a resume hint: `<cli> -r <id>` (resolved binary, usually `turbo`).

### `/turbo-build-plugin:runs`

List active and recent plugin-owned runs:

```text
/turbo-build-plugin:runs
/turbo-build-plugin:runs <run-id> --wait
/turbo-build-plugin:runs --json
```

`runs --json` emits **schemaVersion 2** (`runs[]` with usage, isolation, stopReason,
toolCallCount, etc.). The legacy top-level keys `running`, `latestFinished`, and `recent`
are still present for one minor version (also under `compat`); prefer `runs` + `compat`.

### `/turbo-build-plugin:show`

Show stored output for a finished run:

```text
/turbo-build-plugin:show
/turbo-build-plugin:show <run-id>
```

Every show result ends with a machine-readable `===BRIDGE-RESULT===` trailer (status,
isolation, usage, land hint).

### `/turbo-build-plugin:stop`

Stop an active run by terminating tracked process trees:

```text
/turbo-build-plugin:stop
/turbo-build-plugin:stop <run-id>
```

Kills every distinct pid among `agentPid` (detached grok child) and `bridgePid` / legacy `companionPid` / legacy `pid` (bridge or run-worker). Terminal status is claimed under a locked CAS so a finishing worker cannot overwrite `cancelled` with `completed`.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Optional override for the CLI executable (default resolution: `turbo`, then `grok`; Hyper overrides are ignored) |
| `GROK_BUILD_JOB_OBJECT` | Windows: set to `0`/`false` to skip passing `--job-object` on headless spawns (default: on for `win32`) |
| `GROK_BUILD_ALLOW_WEAK_ISOLATE` | Set to `1` to allow isolated write runs when the CLI does not advertise `--confine` (default: refuse) |
| `GROK_BUILD_CONFINE` | Set to `0`/`false` to skip `--confine`. Isolated writes then require `GROK_BUILD_ALLOW_WEAK_ISOLATE=1` |
| `GROK_BUILD_ALLOW_PAY_PER_TOKEN` | Set to `1` to allow `openai/*` pay-per-token models |
| `GROK_CC_SESSION_ID` | Claude session id (set by SessionStart hook) |
| `GROK_CC_TRANSCRIPT_PATH` | Claude transcript path (set by SessionStart hook) |
| `CLAUDE_PLUGIN_ROOT` | Plugin install root (host) |
| `CLAUDE_PLUGIN_DATA` | Plugin data root; state lives under `.../state` |
| `CLAUDE_ENV_FILE` | Host env file for session hooks |
| `CLAUDE_PROJECT_DIR` | Project directory from the host |
| `HOME` / `GROK_HOME` | Where the CLI keeps config, credentials and sessions. On Windows the bridge defaults both to `%USERPROFILE%` when neither is set; an explicit value is never overwritten. |

State fallback when `CLAUDE_PLUGIN_DATA` is unset: `$TMPDIR/grok-cc-runs`.

## Release notes (0.7.0)

Independent rebrand: plugin id `turbo-build-plugin`, marketplace `turbo-build`, commands `/turbo-build-plugin:*`. GitHub repo is [danmsheets-dev/turbo-build-plugin](https://github.com/danmsheets-dev/turbo-build-plugin). Isolated worktree branches are `turbo-build/<run-id>`.

## Release notes (0.6.9)

Plugin temps nest under `%TEMP%/grok/plugin-tests`. Land ignores `.grok-subagent-live` / `.grok/` when `allowed_paths` is set. Git invocations force `shell: false` (Windows ref injection).

## Release notes (0.6.8)

One `turbo version --json` identity probe per process: check/doctor print product + features, confine/job-object/deny prefixes share the card.

## Release notes (0.6.7)

Harness hardening for Turbo Grok Build 1.0:

- Structured critique reads Turbo `structuredOutput` / `structuredOutputError` (not free-form text alone)
- JSON envelope accepts integer `toolCalls`; streaming records malformed NDJSON lines with reasons
- Stop / session-end **claim terminal before kill** so a finishing runner cannot win `completed` over stop
- Max-duration kill uses production PID fallbacks; porcelain isolation is fail-closed when git status is unreadable
- CLI identity via `version --json`; deny/allow prefixes from `permissionToolPrefixes` when advertised
- Windows headless passes `--job-object` by default

See [`plugins/turbo-build-plugin/README.md`](plugins/turbo-build-plugin/README.md) for the full changelog.

## Development

```bash
npm test
npm run check-version
```

Tests use Node's built-in test runner and a fake CLI binary on `PATH`. Runtime code uses Node stdlib only.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
