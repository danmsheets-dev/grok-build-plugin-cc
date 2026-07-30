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
  As of 0.5.0 they keep `--permission-mode plan` and `--sandbox read-only` **and** add
  `--deny Edit(**)` / `Write(**)` / `NotebookEdit(**)`. The sandbox is kernel-enforced
  only on unix (Hyper compiles it out on Windows), so the deny rules are the half that
  holds everywhere — measured, they are evaluated before `--always-approve` and they
  also refuse a shell command that writes to a denied path.
- **A worktree is not a sandbox.** The agent still runs with your permissions and can
  reach anything on the machine outside the repository. Isolation protects your *working
  tree*, not your filesystem.
- **Heavyweight directories are linked, not copied.** `node_modules`, `.venv`, `venv`,
  `target`, `vendor`, `.tox`, `__pypackages__`, `.next`, `.nuxt`, `.svelte-kit`,
  `.turbo`, `.parcel-cache`, and Godot's import cache (`.godot`, `.import`) are
  junctioned (Windows) or symlinked (POSIX) from your repo so the verify command can
  run without redoing work the checkout deliberately reuses. **Writes through those
  links reach your real directories.** For Godot's cache specifically, the run header
  says so: **close the Godot editor before a run verifies**, or the editor and the
  headless run are writing the same cache. To opt out, set `GROK_BUILD_LINK_GODOT_CACHE=0`
  or put `{"provision": {"copy": true}}` in `.grok-build.json` — the worktree then gets a
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

## Blender add-on isolation

Blender loads add-ons from a per-user scripts directory, and the standard workflow
symlinks `scripts/addons/<name>` at your **source checkout**. An isolated run therefore
verifies your real repository, not the worktree — the agent's changes are not what gets
tested, which is the exact failure isolation exists to prevent.

`--blender-sandbox` fixes that for one run: the add-on (a `blender_manifest.toml`, or an
`__init__.py` carrying `bl_info`, at the worktree root or one directory down) is linked
into `.grok-build/blender/scripts/addons/<name>` inside the worktree, and
`BLENDER_USER_SCRIPTS` / `BLENDER_USER_EXTENSIONS` point there for both the verify
commands and the agent.

- **It is opt-in, and it should be.** A private scripts directory hides every *other*
  add-on your verify script may depend on, so applying it automatically would turn
  working verify commands red.
- **`BLENDER_USER_CONFIG` is deliberately left alone.** Cycles' GPU device selection and
  every add-on preference live in `userpref.blend` under that directory; pointing it at
  an empty sandbox silently forces CPU rendering and drops your preferences.
- **Nothing is auto-enabled**, in either startup mode. Your test script must call
  `addon_utils.enable("<module>", default_set=False, persistent=True)`.
- `.grok-build/` is excluded from the run's commit, so the linked copy of the add-on
  can never be committed twice.

### `--env` and secrets

`--env KEY=VALUE` (repeatable) sets a variable for the verify commands **and** the agent —
the only lever Blender gives you for "use this add-on directory", and often the quickest way
to hand a build script a license key or a private registry token. Know where that value
goes before you use it that way:

- A **foreground** run only ever holds the value in that process's own environment.
- A **`--background`** run is different: the whole resolved request — including every
  `--env` value, in plaintext — is written to `<stateDir>/jobs/<run-id>.json` so the
  detached worker can read it back and start the process with it. That file is not
  encrypted. The shared run index (`<stateDir>/state.json`) — which backs `runs --json`
  and `show --json` — only ever gets a redacted copy of that request; a sensitive-looking
  key (one containing `token`, `secret`, `key`, `pass`, `passwd`, `password`, `passphrase`,
  `credential`, `cred`, `pat`, `dsn`, or `auth`, anywhere in the name, delimited by `_` or
  a boundary) is replaced with `[redacted]` before it ever reaches the index or a run's
  own display. From 0.5.0 the index also mirrors usage, stopReason, toolCallCount, and
  related reporting fields so `runs --json` (schemaVersion 2) does not show null for
  values that only lived in `jobs/<id>.json`.
- Do not pass a long-lived credential through `--env` on a `--background` run unless you
  trust the plugin's state directory (and anything that backs it up) as much as you trust
  your shell's own environment.

## Verification

`--verify "<cmd>"` makes a green result mean something.
The command is run **by the bridge**, not by the agent,
so a run cannot claim success without it having passed.

- The command runs once **before** the agent starts, to record which failures were
  already there. Pre-existing failures are never blamed on the agent.
- On new failures the agent is re-invoked to fix them, up to `--verify-attempts`
  (default 2).
- A run whose verification never passes is reported **`completed-unverified`**, never as
  success. Other honest terminals (0.5.0+): `completed-truncated` (early stopReason),
  `completed-noop` (write run, zero files), `completed-blind` (zero tool calls),
  `timed-out`.
- A command that outlives its budget has its **whole process tree** killed, not just the
  shell wrapping it — an orphaned `godot.exe` would otherwise keep the import lock. Raise the
  budget with `--verify-timeout <seconds>` or `verifyTimeoutMs` in `.grok-build.json`.
- A command that prints more than the output budget is **not** a failure: a fifth of the
  budget is kept from the head and the rest from the tail, both cut on line boundaries, the
  middle is replaced by an `...[elided N bytes of output]...` marker, and the command's real
  exit code is what counts. A capture whose middle was dropped is only a *sample* of the
  failures, so it is reported as `verify-output-truncated` and never blamed on the agent —
  raise `--verify-max-buffer` to get an attributed verdict back.
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

### Ecosystem recipes

These are the exact commands the bridge runs by default once it detects your project's
ecosystem — useful if you want to type your own `--verify` instead, or just to know what a
bare `/grok-build:delegate` in a Godot or Blender repo actually verifies.

| Ecosystem | Default verify commands |
| --- | --- |
| Godot 4 | `godot --headless --path . --import` then `godot --headless --path . --quit-after 1` |
| Godot 3 | `godot --no-window --path . --editor --quit` — Godot 3 predates both `--headless` and `--quit-after` |
| Blender, with a `blender_manifest.toml` | `blender --command extension validate <manifest>` (4.2+ only, which is exactly where the subcommand exists) |
| Blender, with a test script | `blender --background --factory-startup --python-exit-code 1 --python <script>` |
| Blender, neither of the above | a background smoke start, enough to catch a broken install or a GUI-only build that cannot start headless |

A detected GUT suite adds `godot --headless --path . -s addons/gut/gut_cmdln.gd -gexit`; a
detected gdUnit4 suite adds the equivalent `GdUnitCmdTool.gd` invocation. None of this
requires you to write anything: the ecosystem is detected from `project.godot`,
`blender_manifest.toml`, an `__init__.py` carrying `bl_info`, or a root/depth-1 `*.blend`,
and your own `--verify` or a trusted `.grok-build.json`'s `verify` always wins over these
defaults (see below).

### Windows: use the console build

A GUI-subsystem Godot or Blender build writes nothing to a captured pipe on Windows, which
silently defeats every output-pattern check above — a `SCRIPT ERROR:` on screen and an exit-0
result look, to the bridge, identical to a clean run. `/grok-build:doctor` catches this
**empirically** (it runs the binary and checks whether anything came back on stdout or
stderr at all) rather than by filename, and the fix is the same either way: use the console
build that ships in the same archive — `Godot_v4.x-stable_win64_console.exe` — and point
`tools.godot` in `.grok-build.json`, or `GROK_BUILD_GODOT_BIN`, at it. The bridge also
prefers a `*_console.exe` next to whatever binary it resolves, automatically, whenever one
exists on disk.

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

## What a delegate run returns

`grok --output-format streaming-json` emits only `text`, `thought` and `end` events — no tool
events at all — and a `text` event arriving after a `thought` opens a new message. A 40-turn run is
therefore dozens of narration fragments in which the conclusion is the last few lines, and a run
that ends on a tool call ends on *"Let me check X"*. That is why a delegate run used to look like
it returned nothing unless you told Grok to write the answer to a file.

Three things changed:

- **Delegate runs carry an output contract**, delivered on the CLI's `--rules` flag so it lands in
  the system prompt rather than in your prompt (your prompt is also the run's title in
  `/grok-build:runs`). It asks for a `===GROK-FINAL-REPORT===` block with `## Result`,
  `## Files changed`, `## Artifacts`, `## Verification` and `## Follow-ups`, emitted as prose in the
  final message — **not** only into a file — and emitted even when the run failed or ran out of
  turns. See `prompts/run-report.md`.
- **The result is the answer, the transcript is kept separately.** The run reports the final report
  if there is one, otherwise the last assistant message, otherwise the whole narration — so a model
  that ignores the contract still prints exactly what it always did. `payload.transcript` (via
  `--json`) always holds the full turn-separated narration.
- **A verify fix turn cannot erase the answer.** When `--verify` fails once, the fix turn usually
  ends on a tool call with no prose. Its empty result used to replace the original run's, so a run
  that did the work and then passed verification reported *"Grok did not return a final message."*
  The text channel now accumulates across turns; the newest non-empty answer wins.

A run also reports what it did to the disk and how it was captured:

- **Changed files.** A write run lists what it changed — `A`/`M`/`D` plus the path, first 40 in the
  terminal and up to 200 in `payload.changedFiles`. An isolated run reads them out of the agent's
  commit, so build artifacts are already excluded; a `--no-isolate` run diffs the working tree
  against a snapshot taken before the agent started, and reports separately how many paths were
  already dirty at that point. **A run that changed nothing says so**:
  `Changed files: none (run produced only excluded build artifacts)` is the honest answer for a
  Godot run whose entire output was an import cache.
- **The log path.** Every run prints `Log: <path>`. That file holds the run's progress lines and the
  complete rendered result, and it outlives the terminal.
- **stderr and unrecognized events.** When a run produces no answer at all, the last 20 lines of the
  CLI's stderr are shown — an exit-0 run with empty output and a warning on stderr is what a
  truncated response looks like. If the CLI streams event types this bridge does not know, they are
  named, and if *nothing* in the stream was recognized the raw stdout is shown (last 200 lines)
  under an explicit `showing raw stdout` note rather than being silently discarded.

## Changelog (0.5.0)

- Honest terminal statuses: `completed-truncated`, `completed-noop`, `completed-blind`, plus existing `completed-unverified` / `timed-out`.
- Read-only runs add `--deny Edit/Write/NotebookEdit` on top of plan + read-only sandbox, so writes are refused on Windows too.
- Usage, served model, stopReason, and tool/file counts mirrored into the run index; `runs --json` is schemaVersion 2.
- `show` always appends `===BRIDGE-RESULT===`; run header prints CLI, model, isolation, verify plan.
- New `models [--json]` subcommand; pay-per-token models need `GROK_BUILD_ALLOW_PAY_PER_TOKEN=1`.
- Every subcommand accepts `--help` / `-h`.

## Requirements

- Node.js >= 18.18
- The `grok` CLI on `PATH`, or `GROK_BINARY` pointing at a compatible CLI (see [Alternate CLIs](#alternate-clis))
- A logged-in Grok session — `grok models` must succeed (Hyper may exit non-zero on a successful listing; the bridge treats a model list as success)
- `HOME` or `GROK_HOME` must be set. On Windows neither is set by default; the bridge's core paths work without it, but `grok` subcommands such as `grok worktree` fail with `neither $GROK_HOME nor $HOME is set`.

## Commands

| Command | What it does |
| --- | --- |
| `/grok-build:check` | Probes Node, the `grok` CLI, and authentication |
| `/grok-build:delegate` | Hands a task to Grok (write-capable by default) |
| `/grok-build:review` | Read-only review of local git state |
| `/grok-build:critique` | Adversarial design and risk pass, structured JSON output |
| `/grok-build:import` | Imports the current Claude transcript into a Grok session |
| `/grok-build:runs` | Lists active and recent runs (`--json` schemaVersion 2; legacy keys kept one minor version) |
| `/grok-build:show` | Shows stored output plus a `===BRIDGE-RESULT===` trailer |
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
| `--env KEY=VALUE` | Set a variable for the verify commands **and** the agent (repeatable). Split on the first `=` only, so a value may contain more. The full process environment is inherited; these are overrides on top of it |
| `--blender-sandbox` | Give the run a private Blender add-on directory inside the worktree (see below). Auto-enabled for isolated add-on/extension runs; this flag forces it on |
| `--no-blender-sandbox` | Disable the Blender sandbox even when auto-enabled |
| `--godot-export-smoke` | When `export_presets.cfg` exists, add a headless export smoke step (never touches `export_credentials.cfg`) |
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

## Alternate CLIs

`GROK_BINARY` accepts any CLI that speaks the Grok Build command surface, not
just the first-party `grok`. The bridge only ever calls `version` / `--version`,
`models`, and the headless flags (`-p`, `-c`, `-r`, `--session-id`), so
community builds work unmodified.

The common case is [Hyper](https://github.com/DaviRain-Su/hyper-grok-build), a
multi-provider community build that keeps the same `~/.grok` config, auth, and
session state — so credentials and sessions are shared with an existing `grok`
install rather than duplicated.

```bash
# per shell
export GROK_BINARY=hyper

# or, for every Claude Code session, in ~/.claude/settings.json:
#   "env": { "GROK_BINARY": "hyper" }
```

`/grok-build:check` reports which CLI it resolved and adds a `brand` field, so
the `grok` entry reading `hyper <version>` is expected and correct rather than a
misconfiguration. When the configured binary cannot be run, the failure hint
names *that* binary instead of telling you to install Grok Build.

The test suite clears `GROK_BINARY` for fixture-backed runs, so having it
exported does not silently point the suite at your real CLI.

**Layer boundary.** This plugin is the Claude Code → CLI bridge. Anything that
shapes how the *CLI agent itself* behaves — its system prompt, subagents,
hooks, LSP servers, MCP servers — lives in `~/.grok` and is configured there,
independent of this plugin. Ecosystem support in this repo (Godot, Blender)
concerns how the bridge *verifies* a run, not how the agent writes code.

## Nested delegation (Hyper → Hyper)

A Hyper agent inside an isolated write run can hand a **sub-task** to another
Hyper instance — its own sibling worktree, bridge-side verify, tracked run,
structured result, and an explicit land into the parent worktree.

This is **not** Hyper's in-process subagents. Those share the parent's
filesystem and default to max nesting depth 1; they fan out work, they do not
isolate it. Nested delegation uses MCP (`delegate_run` / `delegate_status` /
`delegate_wait` / `delegate_result` / `delegate_land` / `delegate_stop`) and the
bridge subcommand `nest-run`.

### Enable / disable

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROK_BUILD_NESTED_DELEGATION` | on | Set to `0` / `false` / `no` to stop offering the MCP server to agents |
| `GROK_BUILD_MAX_NEST_DEPTH` | `2` | Maximum nest depth (incoming depth ≥ max is refused) |
| `GROK_BUILD_MAX_NEST_CONCURRENCY` | `2` | Max live children per parent; further requests are refused, not queued |
| `GROK_BUILD_NEST_DEPTH` | `0` | Set by the bridge for child processes; do not set by hand |

The run header reports whether nested delegation was offered and how much depth
budget remains.

### Sibling worktrees, never nested

A child's worktree is created **next to** the parent's under the same parent
directory (e.g. `%TEMP%\gb\w\<short-id>` on Windows), off the **parent's base
commit**, never as a directory inside the parent worktree. A worktree inside a
worktree breaks `git worktree remove`, doubles path length on Windows, and makes
artifact excludes and the land graph incoherent.

### Budget inheritance

The parent's `--max-cost`, `--max-duration`, and `--max-turns` are ceilings for
the child. The child may ask for less, never more. Cost uses the parent's
**remaining** budget (cap minus spend so far, including earlier children).

### Landing nested work

1. Wait for the child (`delegate_wait` or `runs` / `wait`).
2. Read the structured result — a failed child is listed on the parent report
   and is **never** summarised as success; it does not fail the parent by itself.
3. Call `delegate_land` (or `land <child> --into-run <parent>`) to squash-merge
   the child branch into the **parent worktree**. Nothing auto-lands.
4. Land the parent into the main checkout as usual with `/grok-build:land`.

`.grok/` (including the injected runtime plugin and its `.mcp.json`) is excluded
from the run commit the same way `.grok-build/` is.

## Environment

| Variable | Purpose |
| --- | --- |
| `GROK_BINARY` | Override the `grok` executable — see [Alternate CLIs](#alternate-clis) |
| `GROK_CC_SESSION_ID` | Claude session id, set by the SessionStart hook |
| `GROK_CC_TRANSCRIPT_PATH` | Claude transcript path, set by the SessionStart hook |
| `CLAUDE_PLUGIN_DATA` | Plugin data root; run state lives under `.../state` |
| `HOME` / `GROK_HOME` | Required by `grok` subcommands |
| `GROK_BUILD_GODOT_BIN` / `GODOT_BIN` | Override the resolved `godot` executable. `tools.godot` in `.grok-build.json` outranks both (once trusted) |
| `GROK_BUILD_BLENDER_BIN` / `BLENDER_BIN` | Override the resolved `blender` executable, same precedence as above |
| `GROK_BUILD_LINK_GODOT_CACHE=0` | Copy Godot's small cache state files into the worktree instead of linking `.godot`/`.import` — see "What isolation does and does not guarantee" |
| `GROK_BUILD_MIN_FREE_BYTES` | Moves the 512 MB free-space floor a checkout refuses to start under; `0` disables the check |
| `GROK_VERIFY_MAX_OUTPUT_BYTES` | Overrides the default 32 MB verify-output ring (see `--verify-max-buffer`, which is the per-run form of this) |
| `GROK_BUILD_NESTED_DELEGATION` | Nested Hyper→Hyper MCP offer; default on, `0` disables — see [Nested delegation](#nested-delegation-hyper--hyper) |
| `GROK_BUILD_MAX_NEST_DEPTH` | Max nest depth (default 2) |
| `GROK_BUILD_MAX_NEST_CONCURRENCY` | Max live children per parent (default 2) |

State falls back to `$TMPDIR/grok-cc-runs` when `CLAUDE_PLUGIN_DATA` is unset.
