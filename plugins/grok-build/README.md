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
  Godot's import cache (`.godot`, `.import`) is linked too, so the run header says so:
  **close the Godot editor before a run verifies**, or the editor and the headless run
  are writing the same cache. To opt out, set `GROK_BUILD_LINK_GODOT_CACHE=0` or put
  `{"provision": {"copy": true}}` in `.grok-build.json` — the worktree then gets a
  private cold cache seeded with only the small state files, and the first verify
  re-imports. `.godot/imported` is never copied; it is the multi-gigabyte part.
- **A worktree holds the only copy of unlanded work.** `/grok-build:prune` removes
  worktrees for finished runs. Land before you prune.
- **A checkout needs room.** An isolated run refuses to start when the volume holding
  the worktree has less than 512 MB free, rather than failing halfway through the
  checkout. `GROK_BUILD_MIN_FREE_BYTES` moves the floor; `0` disables the check.

`/grok-build:land <id>` squash-merges the run's branch into your current branch.
Conflicts are expected on binary assets — a `.blend`, a `.png` or a `.tscn` touched on
both sides cannot be content-merged. When that happens, land **rolls the repository
back to HEAD** and names the conflicting files rather than leaving you in a half-merged
state. Note that `git merge --abort` does not work here: a squash merge writes no
`MERGE_HEAD`. Either `/grok-build:land <id> --discard`, or check out `grok-build/<id>`
and pick a side per file.

`/grok-build:land <id> --preview` prints the stat, a `Total: N binary file(s)` count,
and the diff itself — up to 128 KB. Past that the diff is omitted with the exact
`git diff` command to run, because a 300 KB diff in a terminal is not a review.

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
- `--no-verify-baseline` skips the pre-run measurement. That makes verification **strict**:
  with nothing measured, every failure — pre-existing or not — is treated as this run's.

### Exit code 0 does not mean the project works

Godot and Blender both report a broken project on stdout and exit **0** anyway.
`godot --headless --import` prints `SCRIPT ERROR:` for a GDScript that does not parse and still
exits 0; `blender -b --python x.py` exits 0 when the script raises. So the bridge also scans
verify output for a small set of failure markers, chosen per detected ecosystem:

| Ecosystem | Matched by default |
| --- | --- |
| Godot | `SCRIPT ERROR:`, `USER SCRIPT ERROR:`, `USER ERROR:`, `Parse Error`, `Failed to load script `, `Error importing '`, `Failed to instantiate scene` |
| Blender | `Error: Python script failed` (anchored at line start) |

`WARNING:` and `SCRIPT WARNING:` never match. A bare `ERROR:` and `Cannot open file '` are
deliberately **not** defaults — Godot 4 emits both for entirely benign conditions, and turning a
healthy run red is the same class of bug as reporting a broken one green. Add them yourself with
`verifyFailurePatterns` in `.grok-build.json` if your project is clean enough to afford it.

The same measurement runs at baseline, so a project that was already printing `SCRIPT ERROR`
before the run started is not blamed on the agent.

Two more knobs for noisy engines:

- `--verify-ignore <regex>` (repeatable, or `verifyIgnorePatterns` in the config) drops matching
  output lines before they can count as failures at all.
- Godot re-prints the same runtime error **once per frame**, so for Godot projects the occurrence
  *count* is ignored and only the deduped set of distinct errors is compared. A genuinely new
  error is still caught; a run that simply idled a few frames longer is not reported as a
  regression.

#### Blender: make the exit code honest too

For a Blender test script, pass `--python-exit-code` so a raising script also fails the process:

```
blender --background --factory-startup --python-exit-code 1 --python tests/run_tests.py
```

`--factory-startup` disables **every** installed add-on, including the one you are testing, so
`run_tests.py` has to enable it itself:

```python
import addon_utils
addon_utils.enable("my_addon", default_set=False, persistent=True)
```

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

## What a review sends, and how big it can get

`/grok-build:review` and `/grok-build:critique` build their context from git, so a binary-heavy
project used to pay for it twice — once in tokens, once in a prompt too long for the OS to accept.

- **Binary files are described, never inlined.** The diff carries git's own
  `Binary files a/tex.png and b/tex.png differ`, plus a `## Binary Assets` section giving each
  side's size in bytes. Embedding the base85 patch inflated a 100 KB texture to ~145 KB of
  characters the model cannot decode, and it inflated the *measurement* too, so one re-exported
  texture silently demoted a whole review to "go read the diff yourself".
- **Untracked files are capped** at 40 files and 64 KB in total, and bare path listings at 200
  paths. A Godot import cache or a Blender bake directory holds thousands of untracked sidecars;
  whatever is dropped is named in an omission line.
- **An oversized prompt is not silently mangled.** Windows rejects a long command line — ~32767
  characters via `CreateProcess`, far less through a `.cmd` shim — and Linux caps any single
  argument at 128 KB. A prompt over the budget is written to the plugin's state directory and
  passed with `--prompt-file`, so nothing is lost. If that spill cannot be written, the middle is
  elided with a marker saying how many bytes went, and the run reports it.
- **Verify output reaching a fix turn is tail-truncated** to the last 4 KB — the end is where the
  assertion and the exit line are. It is redacted first, then truncated.

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
| `--no-verify-baseline` | Skip the pre-run baseline probe. Makes verification strict: every failure counts as this run's |
| `--verify-ignore <regex>` | Drop matching output lines before they count as failures (repeatable) |
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
