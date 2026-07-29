# Grok Build plugin — safety and observability, 0.3.0 → 0.5.0

Date: 2026-07-29
Status: approved design, ready for implementation planning

## Context

Grok Build 0.2.0 shells out to the real `grok` CLI rather than implementing its own
agent loop. Field use (10 sequential `delegate` runs authoring ~400-line HTML pages
against a documented contract with two build gates) produced 10 successes, 0 failures,
0 retries, and 2 minor defects. Output quality is not the problem.

The problems are that the runtime provides no structural guarantees and no visibility:

- Gate compliance rests on the agent choosing to comply, not on the runtime.
- `run --write` edits the live working tree with no gate between "agent finished" and
  "changes are in your repo".
- Every run sits at `Phase: starting` for its entire duration with a 165-byte log, so a
  working run is indistinguishable from a hung one.
- No token or cost reporting anywhere, so no budget decisions are possible.

### Audit claims that are already implemented in 0.2.0

Verified present; no work required:

- Terminal-status CAS under lock — `claimJobTerminal`, `state.mjs:122`
- SessionStart / SessionEnd hooks — `hooks/hooks.json`
- Untracked file contents in review context with directory, binary, size and broken
  symlink guards — `git.mjs:196`
- Lightweight `includeDiff: false` context mode, auto-selected by file count and diff
  bytes — `git.mjs:318`
- Review size estimation with a wait-vs-background prompt — `commands/review.md:21`
- `bump-version.mjs` with `--check`
- `line_start`, `line_end` and `confidence` on findings — `schemas/review-output.schema.json`
- A repository-root README

Command surface is 8, not 9: check, critique, delegate, import, review, runs, show, stop.

### Findings from probing the installed `grok` CLI (0.2.112)

These change the design relative to the original audit.

1. **`--output-format streaming-json` exists** and emits NDJSON. Observed event types:
   `thought`, `text`, and a terminal `end` carrying `sessionId`, `stopReason`,
   `usage` (`input_tokens`, `cache_read_input_tokens`, `output_tokens`,
   `reasoning_tokens`, `total_tokens`), `num_turns`, `total_cost_usd` and `modelUsage`.
   No tool-call events were observed even on a run that created a file.
2. **`-w` / `--worktree` is silently ignored in headless `-p` mode.** A probe run with
   `-w ccprobe --worktree-ref HEAD` created no worktree and no branch, and wrote its
   output file directly into the source working tree. The flag is scoped to interactive
   sessions. Native worktree isolation is therefore unavailable to the bridge.
3. **Spawning `grok` with a plain `cwd` controls where it writes.** Plugin-managed
   worktrees need no dependence on `--cwd` semantics.
4. **`grok` subcommands require `HOME` or `GROK_HOME`.** `grok worktree ls` fails with
   `neither $GROK_HOME nor $HOME is set` on Windows, where neither is set by default.
   The bridge forwards `process.env` unchanged.
5. **`--max-turns <N>` exists** and can back a turn budget.

## Decisions

| Decision | Choice |
| --- | --- |
| Isolation mechanism | Plugin-managed `git worktree` + a `/land` gate |
| Isolation default | On for `--write` runs; `--no-isolate` opts out |
| Verify failure behaviour | Fix-and-recheck up to a cap, then `completed-unverified` |
| Release packaging | Three releases: 0.3.0 fixes, 0.4.0 safety, 0.5.0 ops |

## 0.3.0 — Observability and honesty

### Streaming rework

`runHeadlessAgent` (`lib/grok.mjs:203`) switches the task path and the plain-review path
from `--output-format plain` to `streaming-json`. Stdout is parsed line-by-line through a
buffer, because chunk boundaries split lines.

Event handling:

- `thought` — sets phase `thinking`. Job-file writes are throttled to at most one per
  2 seconds so a token stream does not hammer state.
- `text` — accumulates into the current message. **A `text` event arriving after a
  non-`text` event begins a new message.** Messages join with `\n\n`.
- `end` — supplies the authoritative `sessionId`, replacing the UUID the bridge currently
  generates and assumes (`grok.mjs:212`). Also captures `usage`, `total_cost_usd`,
  `num_turns` and `stopReason`.
- Unrecognised types are tolerated and logged rather than treated as errors, because the
  event vocabulary is undocumented and may change.

The critique path keeps `--output-format json`, since `--json-schema` implies it.
Known limitation: critique has no live phases.

### The `Summary:` concatenation fix

The defect is two assistant turns arriving as adjacent `text` runs with no separator. It
reproduces under `streaming-json`, so switching format alone does not fix it. The
turn-boundary rule above is the fix: a `text` event following a non-`text` event starts a
new message, and messages are joined with a blank line.

### Phase model

Phase vocabulary becomes `queued → starting → thinking → writing → finalizing →
done | failed | cancelled`. The log file is appended as each message completes, so it grows
during a run instead of staying at 165 bytes until the end.

A `lastEventAt` timestamp is recorded and rendered as relative age ("last activity 8s
ago"). This, not the phase, is the real hung-versus-working signal: a phase can be stale
while a timestamp cannot.

### Usage and cost

`usage`, `costUsd` and `numTurns` are stored on the run record and rendered in `runs`,
`show` and completion output:

```
Tokens: 22,962 in (33,408 cached) / 163 out · 2 turns · $0.0569
```

They are also added to every `--json` payload.

### DEP0190

`lib/process.mjs:22` passes `shell: process.env.SHELL || true` on Windows, which emits
`DEP0190` on every invocation and pollutes stderr for `--json` consumers. `shell` is
dropped and Windows executables are resolved explicitly by probing `PATHEXT`.
`runHeadlessAgent` already spawns `grok` shell-free and works, so the shell option is only
carrying `git` and `taskkill`. This removes both the warning and the argument-injection
surface the warning describes — which matters here because the arguments are
model-authored.

### Delegate execution seam

Invoking the `grok-build:grok-delegate` subagent with `run_in_background: false` returns
immediately, because the subagent decides `--background` on its own
(`agents/grok-delegate.md:23`) and the harness signal cannot reach it.

The subagent loses that autonomy: it runs in the foreground unless the user explicitly
passed `--background`. The harness signal and the bridge then agree. Long foreground runs
block until `--max-duration` arrives in 0.5.0; this is documented in the interim.

Applies to `agents/grok-delegate.md`, `skills/grok-delegate-runtime/SKILL.md` and
`commands/delegate.md`.

### Plugin-root README

`plugins/grok-build/README.md`, leading with what isolation does and does not guarantee,
then the write-policy table, command surface, run lifecycle, environment variables and
the `HOME` requirement. The repository-root README links to it.

## 0.4.0 — Verify and isolation

### Worktree isolation

New `lib/worktree.mjs`:

- `git worktree add -b grok-build/<run-id> <path> HEAD`
- Path: `${CLAUDE_PLUGIN_DATA}/worktrees/<repo-hash>/<run-id>`, deliberately outside the
  repository so it never appears in `git status`.
- `grok` is spawned with `cwd` set to the worktree path.
- The run record gains `worktree: { path, branch, baseCommit }`.

Isolation is on by default for `--write` runs. `--no-isolate` opts out; `--isolate` is
accepted explicitly for read-only runs.

### The land gate

`/grok-build:land [run-id]` shows the diffstat, then the diff, then asks apply or discard,
then squash-merges the run branch onto the live tree. `--discard` removes the worktree and
branch without applying. SessionEnd reaps abandoned worktrees past a retention window.

### The verify loop

`--verify "<cmd>"` is repeatable; `--verify-attempts <n>` defaults to 2.

After `grok` exits, each verify command runs in the worktree. On failure the bridge
re-invokes `grok -r <session-id>` with the failing output and re-runs the checks. If the
checks still fail after the attempt cap, the run ends as `completed-unverified` — never
as success.

`completed-unverified` joins `TERMINAL_STATUSES`. Terminal precedence in the existing CAS
becomes `cancelled > failed > completed-unverified > completed`, preserving the current
guarantee that a cancelled run is never overwritten by a finishing worker.

### Dependency seeding

A fresh worktree contains no untracked or ignored files, so `node_modules`, `.env` and
build caches are absent. For most repositories this means the first verify attempt fails
for reasons unrelated to the agent's work.

The worktree therefore supports seeding: a configurable list of ignored paths copied or
junction-linked into the new worktree before the run starts, defaulting to `node_modules`
when a `package.json` is present. Repositories with no ignored build inputs, such as a
zero-dependency static generator, are unaffected.

## 0.5.0 — Operations

- `--max-duration <seconds>`: a bridge-side watchdog that calls `terminateProcessTree` and
  records a `timed-out` status.
- `--max-turns <n>`: passthrough to the CLI flag.
- `--max-cost <usd>`: evaluated against the `end` event.
- `/grok-build:doctor`: CLI version, auth, `HOME`/`GROK_HOME` presence, state directory
  health, orphaned runs, stale worktrees and installed-versus-source version drift.
- `/grok-build:prune`: reaps terminal runs past a retention window, orphaned worktrees and
  dead PIDs.
- `secret-scan.mjs`: redaction applied to log lines and stored stdout before they are
  written.

## Testing

Node's built-in test runner, as today. The fake `grok` fixture
(`tests/fake-grok-fixture.mjs`) must be extended to emit `streaming-json` NDJSON,
including a two-turn transcript that reproduces the message-boundary case and an `end`
event carrying usage and cost.

Per release:

- 0.3.0 — NDJSON line-buffer parsing across split chunks; message-boundary joining; usage
  and cost capture and rendering; unknown event types tolerated; phase transitions;
  `lastEventAt`; no `DEP0190` on stderr for any subcommand.
- 0.4.0 — worktree create, land, discard and reap; verify pass, verify fail-then-fix,
  verify exhausted-attempts; `completed-unverified` precedence against a concurrent stop.
- 0.5.0 — duration, turn and cost caps; doctor and prune against seeded state; redaction
  of known secret shapes.

## Risks

1. **Worktrees carry no untracked or ignored files.** Mitigated by dependency seeding, but
   seeding is heuristic and will not fit every repository. The README must state the
   limitation plainly rather than implying isolation is free.
2. **`HOME` must be injected** for any `grok` subcommand the bridge adds on Windows.
3. **The streaming event vocabulary is undocumented.** Only `thought`, `text` and `end`
   were observed, with no tool-call events, so phases derive from narration rather than
   tool activity. An xAI CLI update could add or rename types. Mitigated by tolerating
   unknown types and adding a debug capture mode.
4. **Isolated-by-default changes a workflow that currently works.** Results no longer
   appear in the working tree until `/land`. The 0.4.0 release notes must lead with this.

## Distribution

The plugin is plain JavaScript; there is no build step. Three layers exist today:

| Layer | Path |
| --- | --- |
| Development repository | `H:\Apps\Grok Build Plugin` |
| Marketplace source | `C:\Users\dan_m\.claude\grok-build-plugin-cc` |
| Installed plugin | `…\plugins\cache\xai-grok-build\grok-build\0.2.0\` |

The marketplace points at a second clone, so edits to the development repository do not
reach the running plugin. The marketplace will be repointed at the development repository
so there is a single source of truth.

The install cache is version-keyed, which is why `claude plugin update` silently no-ops
when `plugin.json` is not bumped. Each release therefore runs `npm run bump-version`,
creating a new versioned cache directory, followed by `claude plugin update`.
