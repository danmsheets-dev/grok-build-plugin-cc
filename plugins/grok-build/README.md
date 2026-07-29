# Grok Build ↔ Claude Code

Delegate coding work, reviews, and critiques to the real `grok` CLI from inside Claude Code.

## What isolation does and does not guarantee

**As of 0.3.2, write runs are isolated.** A delegate run started with `--write` executes
in its own git worktree on a `grok-build/<run-id>` branch, outside your repository.
Nothing reaches your working tree until you run `/grok-build:land`, which shows you the
diff first and refuses to merge into a dirty tree.

What isolation **does** guarantee:

- Your working tree is untouched while the agent runs.
- You see the diff before anything lands.
- Concurrent delegate runs no longer collide — each gets its own worktree.
- `/grok-build:land --discard` throws the work away cleanly.

What isolation **does not** guarantee:

- **`--no-isolate` turns it off**, and then the agent edits your tree directly, as before.
- **Read-only runs are not isolated** and do not need to be — they cannot write.
- **A worktree is not a sandbox.** The agent still runs with your permissions and can
  reach anything on the machine outside the repository. Isolation protects your *working
  tree*, not your filesystem. `grok --sandbox` owns that, not this plugin.
- **Heavyweight directories are linked, not copied.** `node_modules`, `.venv`, `venv`,
  `target` and `vendor` are junctioned (Windows) or symlinked (POSIX) from your repo so
  the verify command can run. **Writes through those links reach your real directories.**
- **A worktree holds the only copy of unlanded work.** `/grok-build:prune` removes
  worktrees for finished runs. Land before you prune.

The bridge is read-only by default. `--write` is opt-in at the CLI, but the
`grok-build:grok-delegate` subagent adds `--write` by policy, so `/grok-build:delegate`
is write-capable unless you ask for read-only.

## Verification

`--verify "<cmd>"` makes a green result mean something.
The command is run **by the bridge**, not by the agent,
so a run cannot claim success without it having passed.

- The command runs once **before** the agent starts, to record which failures were
  already there. Pre-existing failures are never blamed on the agent.
- On new failures the agent is re-invoked to fix them, up to `--verify-attempts`
  (default 2).
- A run whose verification never passes is reported **`completed-unverified`**, never as
  success.

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
| `/grok-build:land` | Reviews an isolated run's diff, then merges or discards it |
| `/grok-build:doctor` | Diagnoses environment and run state, with a fix for each problem |
| `/grok-build:prune` | Reclaims abandoned runs and stale worktrees (dry run by default) |

## Common flags on `delegate`

| Flag | Meaning |
| --- | --- |
| `--verify <cmd>` | Command that must pass before the run counts as done (repeatable) |
| `--verify-attempts <n>` | Fix-and-recheck cycles allowed (default 2) |
| `--no-isolate` | Edit the working tree directly instead of using a worktree |
| `--max-duration <seconds>` | Stop the run after a wall-clock limit |
| `--max-turns <n>` | Cap agent turns (passed through to the CLI) |
| `--max-cost <usd>` | Stop once spend exceeds this. **Post-hoc**: cost is only known when a turn ends, so the run stops before the *next* turn rather than mid-turn |
| `--background` | Detached run; poll with `/grok-build:runs` |

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
