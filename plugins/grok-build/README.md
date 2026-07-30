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
- A command that outlives its budget has its **whole process tree** killed, not just the
  shell wrapping it — an orphaned `godot.exe` would otherwise keep the import lock. Raise the
  budget with `--verify-timeout <seconds>` or `verifyTimeoutMs` in `.grok-build.json`.
- A command that prints more than the output budget is **not** a failure: the first 64 KB and
  the last 256 KB are kept, the middle is replaced by an `...[elided N bytes of output]...`
  marker, and the command's real exit code is what counts.

### Where the verify plan comes from

You no longer have to pass `--verify` for a run to be verified. The bridge resolves the plan
itself, in this order, and prints the resolved list and its source in the run's output:

1. `--verify` flags you typed (these win outright)
2. `verify` in the project's `.grok-build.json` — **only once you have trusted that file**
3. defaults for the detected ecosystem (Godot, Blender, Rust, Python, Node)

`--no-verify` opts out entirely. `node scripts/grok-bridge.mjs verify-plan` prints what would run
without running any of it.

### `.grok-build.json` and the trust gate

A `.grok-build.json` at the repo root can set `verify`, `verifyAttempts`, `isolate`, `model`,
`effort`, budget limits, and timeouts. Everything that cannot execute code is honoured
immediately.

`verify`, `tools`, and `env` are different: those strings are handed to `cmd.exe` / `sh`, and the
file is tracked in the repository. Honouring them straight out of a clone would mean that cloning
someone's repo and running `/grok-build:delegate` executes commands they chose. So they are
**withheld until you trust the file**:

    node scripts/grok-bridge.mjs trust-config

`/grok-build:doctor` prints the withheld commands verbatim so you can read them first. Trust is
recorded against the file's sha256 in the plugin's state directory — outside the repository, so a
clone cannot ship its own trust record, and any later edit to the file withdraws it automatically.
`trust-config --revoke` withdraws it by hand.

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
| `--no-verify` | Run nothing, even when a config or ecosystem plan exists |
| `--verify-timeout <seconds>` | Budget for each verify command. Used verbatim; without it the budget is derived from the measured baseline (4x, floored at 120s, capped at 900s) |
| `--baseline-timeout <seconds>` | Budget for the pre-run baseline probe. Only ever raises the 900s default |
| `--verify-max-buffer <megabytes>` | How much verify output to keep. Output over the budget is not an error: the head and tail are kept and the middle is elided |
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
