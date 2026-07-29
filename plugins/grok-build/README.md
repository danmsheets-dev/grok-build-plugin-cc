# Grok Build ↔ Claude Code

Delegate coding work, reviews, and critiques to the real `grok` CLI from inside Claude Code.

## What isolation does and does not guarantee

**As of 0.3.0 there is no isolation.** A delegate run started with `--write` **edits your working tree directly**, in place, while it runs. There is no worktree, no staging area, and no gate between "the agent finished" and "the changes are in your repo".

What this means in practice:

- Keep your tree committed-clean before delegating, and use `git diff` as your own review gate.
- A confused run can overwrite uncommitted work. Git cannot recover what was never committed.
- Concurrent delegate runs in the same repository will collide.

The bridge is read-only by default. `--write` is opt-in at the CLI, but the `grok-build:grok-delegate` subagent adds `--write` by policy, so `/grok-build:delegate` is write-capable unless you ask for read-only.

Worktree isolation and a `/grok-build:land` diff gate are planned for 0.4.0.

## Requirements

- Node.js >= 18.18
- The `grok` CLI on `PATH`, or `GROK_BINARY` pointing at it
- A logged-in Grok session — `grok models` must succeed
- `HOME` or `GROK_HOME` must be set. On Windows neither is set by default; the bridge's core paths work without it, but `grok` subcommands such as `grok worktree` fail with `neither $GROK_HOME nor $HOME is set`.

## Commands

| Command | What it does |
| --- | --- |
| `/grok-build:check` | Probes Node, the `grok` CLI, and authentication |
| `/grok-build:delegate` | Hands a task to Grok (write-capable by default) |
| `/grok-build:review` | Read-only review of local git state |
| `/grok-build:critique` | Adversarial design and risk pass, structured JSON output |
| `/grok-build:import` | Imports the current Claude transcript into a Grok session |
| `/grok-build:runs` | Lists active and recent runs |
| `/grok-build:show` | Shows stored output for a finished run |
| `/grok-build:stop` | Stops an active run and terminates its process trees |

## Run lifecycle

Runs are owned by the plugin, tracked by PID and log file. There is no app-server broker.

Phases progress `queued → starting → thinking → writing → finalizing → done`, and each run records a `Last activity` age. **Use the age, not the phase, to tell a working run from a hung one** — a phase can be stale while a timestamp cannot.

Finished runs report token usage and cost, for example:

    Tokens: 22,962 in (33,408 cached) / 163 out · 2 turns · $0.0569

Every run surfaces its Grok session id and a `grok -r <id>` resume line, so a run is never a dead end.

Terminal status is claimed under a lock, and `cancelled` always wins: a run you stopped can never be reported as completed by a worker that finishes moments later.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Override the `grok` executable |
| `GROK_CC_SESSION_ID` | Claude session id, set by the SessionStart hook |
| `GROK_CC_TRANSCRIPT_PATH` | Claude transcript path, set by the SessionStart hook |
| `CLAUDE_PLUGIN_DATA` | Plugin data root; run state lives under `.../state` |
| `HOME` / `GROK_HOME` | Required by `grok` subcommands |

State falls back to `$TMPDIR/grok-cc-runs` when `CLAUDE_PLUGIN_DATA` is unset.
