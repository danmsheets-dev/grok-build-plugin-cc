# Grok Build field notes — building 0.3.0 with Grok Build itself

Date: 2026-07-29
Context: implementing the 0.3.0 plan using `/grok-build:delegate`, six delegations,
on Windows 10, Node 24.14.1, `grok` CLI 0.2.112 → 0.2.114.

This is dogfooding data. The plugin built its own fixes, so every defect below was
hit in real use rather than inferred from reading the code.

## Delegation log

| # | Task | Wall clock | Outcome |
| --- | --- | --- | --- |
| 1 | Task 1 — NDJSON decoder | 2m 50s | Clean. Verbatim to plan. |
| 2 | Task 7 — PATHEXT resolution | ~40m, then died | Work landed on disk; run never reported. |
| 3 | Task 2 — transcript accumulator | 2m 14s | Clean. Flagged a plan deviation honestly. |
| 4 | Tasks 3+4 — fixture + streaming wiring | 3m 22s | Clean. Preserved a constraint it was warned about. |
| 5 | Tasks 5+6 — tracking + rendering | 3m 06s | Clean. Caught a real bug in the plan. |
| 6 | Task 9 — plugin README | 1m 53s | Clean. |

Five of six delegations were clean and averaged **2m 41s**. The one failure is
analysed below.

## What worked well

**Instruction adherence was excellent.** Every delegation respected "do not run
git commit", "only modify these files", and "do not weaken assertions". Not once
did a run touch a file outside its allowlist, and the constraint that mattered
most — do not revert `resolveSpawnInvocation`, because doing so makes the suite
spend real money — was honoured exactly.

**It reports failure honestly.** The run that found a red baseline said so
plainly rather than claiming a green suite. In delegation 3 it volunteered that
the pre-implementation failure arrived as an ESM module-resolution error rather
than the `is not a function` TypeError the plan predicted — a difference in
mechanism, not outcome, that it had no incentive to mention. This matters
directly: the entire argument for `--verify` is that self-reported success cannot
be trusted, and in this sample the self-reports were accurate.

**It improved on the plan twice, correctly.**
1. Task 7: the plan's `resolveExecutable` would have broken every fixture-based
   test, because Windows `CreateProcess` cannot execute the extensionless
   `#!/usr/bin/env node` shebang script that `installFakeGrok` writes. Grok added
   `resolveSpawnInvocation` to rewrite those to run under `process.execPath`. The
   plan was wrong; Grok was right.
2. Tasks 5+6: the plan's cost guard used `Number.isFinite(Number(usage.costUsd))`.
   `Number(null)` is `0`, so a null cost would have rendered as `$0.0000`. Grok
   guarded with an explicit null check instead.

Neither was requested. Both were correct.

**Constraining the verify loop fixed the runaway.** Delegation 2 ran ~40 minutes
because the prompt asked it to "investigate whether remaining failures share the
same root cause", which it did by re-running the full suite repeatedly. Every
later prompt said: iterate on the single relevant test file, run `npm test`
exactly once at the end. Wall clock dropped to ~2-3 minutes with no loss of
quality. **This is a prompt-shape lesson, not a model limitation.**

## Defects found in the plugin

Ordered by severity. Items 1-3 are fixed in 0.3.0; items 4-6 are not.

### 1. The test suite invoked the real Grok CLI and spent real money — FIXED

`runHeadlessAgent` spawned `binary` with no PATH resolution. On Windows,
`CreateProcess` skipped the extensionless fake `grok` fixture that tests place
first on `PATH` and found the real `grok.exe` instead. Every `npm test` run made
live API calls — visible as a 109-second unit test. Suite runtime dropped from
minutes to ~30s once fixed.

This was invisible from code review and is the single most valuable find of the
session. Neither the audit nor the user feedback mentioned it.

### 2. Any repository path containing a space broke everything — FIXED

`shell: true` on Windows plus unquoted arguments meant `H:\Apps\Grok Build Plugin`
split at the space, producing `Cannot find module 'H:\Apps\Grok'`. This failed
**18 of 58 tests**, a 31% red baseline that was present before any of our work.
It never surfaced upstream because the reference clone lives at a path with no
space.

The DEP0190 warning users see is the *same defect*. It is not cosmetic — it is a
live argument-splitting bug, and the arguments are model-authored.

### 3. The streaming work was nearly shipped inert — FIXED

After wiring `streaming-json` through `runHeadlessAgent`, both bridge call sites
still passed `outputFormat: "plain"` explicitly, so delegate runs would have
streamed nothing: no live phases, no usage, no turn separation. The plan
explicitly told Grok not to touch one of those lines and never mentioned the
other. Caught only by asking "does this actually reach the delegate path?"

Now guarded by a regression test asserting delegate output is turn-separated.

### 4. Orphaned runs are never reclaimed — NOT FIXED

When delegation 2 died, both `bridgePid` and `agentPid` were gone, yet the run
record still read `status: running, phase: starting` **38 minutes later**. Nothing
reaps it. `/grok-build:runs` reports a dead run as live indefinitely.

There is no liveness check anywhere: no `process.kill(pid, 0)` probe in
`enrichJob`, and the SessionEnd hook only cancels runs belonging to the ending
session. Recommend a liveness probe in `enrichJob` that marks a run `abandoned`
when its tracked PIDs are gone, plus `/grok-build:prune`. **Add to 0.5.0.**

### 5. Diagnosing a stalled run is genuinely hard — PARTLY FIXED

While delegation 2 hung I inspected the global process table and concluded the
run was alive and working. It was dead. The `grok.exe` and `node.exe` processes I
counted belonged to the user's other projects. The correct check — the run's own
recorded `bridgePid` / `agentPid` — showed both gone immediately.

0.3.0's `Last activity` age helps a lot, but only for runs that stream. A run that
dies before its first event still shows nothing. Defect 4 is the real fix.

### 6. The delegate seam, confirmed and fixed mid-session

Before the fix, `Agent(run_in_background: false)` returned instantly with a run
id, because the subagent chose `--background` itself from perceived task
complexity. After the 0.3.0-dev install and restart, all four subsequent
delegations blocked correctly. **The fix is verified in real use, not just by test.**

Note the deployment constraint: agent and skill markdown is loaded from the
installed cache copy at startup, so a fix to delegation behaviour cannot take
effect in the session that makes it. It requires bump → install → restart.

## Recommendations

**Promote to 0.4.0** (currently 0.5.0 or unplanned):
- Orphaned-run reaping and a PID liveness probe (defect 4). A tool that reports
  dead runs as live undermines trust in every other status it reports.

**Keep in 0.5.0:**
- `--max-duration`. Delegation 2 ran 40 minutes unbounded; only a manual decision
  stopped it.
- `/grok-build:doctor` and `/grok-build:prune`. The stale `0.2.0` cache directory
  is still on disk after upgrading.

**Add to the 0.4.0 `--verify` design:**
- The verify command should run with a per-attempt timeout. Grok's own iteration
  showed how easily a repeated full-suite run consumes wall clock.
- Prompt shape matters: a verify loop instructed to "investigate" will re-run the
  world. Bound it explicitly.

**Testing hygiene, unplanned:**
- Add a guard test asserting no test process ever spawns the real `grok` binary.
  Defect 1 cost real money silently and would recur unnoticed.
- Repo paths with spaces should be part of CI, since the reference checkout path
  has none and that is exactly why defect 2 survived.

## Verdict

Grok Build is a genuinely good implementation engine. Six delegations produced
code that was verbatim-correct where the plan was right and better than the plan
where it was wrong, with honest reporting throughout. The output quality claim in
the original user feedback holds up.

The gap remains scaffolding, exactly as that feedback argued. Of the six defects
above, five are runtime and observability problems rather than code-generation
problems. Nothing here suggests Grok needs closer supervision of *what it writes*;
it suggests the runtime needs to be more honest about *what it is doing*.
