# Supervision notes — building 0.3.1 and 0.3.2 with Grok and Nemotron Ultra

Date: 2026-07-29
Supervisor: Claude (Opus 5). Implementers: Grok Build (`grok` 0.2.114) and
Nemotron Ultra (`nvidia/nemotron-3-ultra-550b-a55b`).

Companion to `2026-07-29-grok-build-field-notes.md`, which covers 0.3.0.

## Delegation log

| # | Agent | Task | Wall clock | Outcome |
| --- | --- | --- | --- | --- |
| 1 | Grok | worktree.mjs + tests | 2m 58s | Clean. Critical test correct first time. |
| 2 | Ultra | redact.mjs + tests | 8m 50s | Worked; 2 supervisor fixes; 1 stray file. |
| 3 | Grok | verify.mjs + tests | 3m 51s | Clean. |
| 4 | Ultra | provision.mjs + tests | 4m 32s | Worked; 1 supervisor fix; ignored import spec. |
| 5 | Grok | bridge wiring: isolation, verify, land | 8m 18s | Clean. Misreported a file path. |
| 6 | Grok | ops layer: budgets, doctor, prune, redaction | 11m 0s | Worked; 1 supervisor fix. |

Grok: 4 delegations, ~26 minutes, zero failed runs. Ultra: 2 delegations,
~13 minutes, zero failed runs. Every delegation blocked correctly on `--wait` —
the 0.3.0 seam fix held across all six.

## Defects the supervisor caught that the agents' own tests did not

This is the useful signal. All six passed their own tests before I looked.

1. **Redaction missed the commonest secret form** (Ultra). The key pattern required
   at least one character before the keyword, so `API_TOKEN=` was redacted but a
   bare `password=`, `token=` or `secret=` was not. Found by probing edge cases the
   supplied tests did not cover, not by reading the code.
2. **Redaction reconstructed keys by length arithmetic** (Ultra). It inferred
   quoting with `match.includes('"')`, which misreads any line containing a quote
   elsewhere — `Authorization: Bearer abc" trailing` would corrupt. Replaced with
   explicit capture groups.
3. **`provisionWorktree` could throw** (Ultra). `mkdirSync` sat outside the
   try/catch, so a failing directory creation would fail the entire run rather than
   one link — directly contradicting the "never throws" requirement it was given.
4. **The renderer ignored liveness** (Grok, ops layer). `enrichJob` computed
   `abandoned` correctly and the renderer read `job.status` anyway, so a dead run
   still displayed as `running`. **This is the second occurrence of this exact
   failure shape** — in 0.3.0 the streaming work was similarly inert because the
   bridge overrode `outputFormat`. See "Recurring failure mode" below.
5. **Ultra ignored an explicit import specification.** I gave the exact import
   lines to use; it imported `assert` from `node:test` (a subset without
   `doesNotThrow`) plus the real module under a second name, leaving two `assert`
   objects in one file.
6. **Ultra produced a stray file** (`tests/debug.mjs`) outside the stated
   two-file scope, on its first delegation.

## Recurring failure mode: correct logic, never wired up

Twice now, a feature has been fully implemented, fully tested, and completely
inert because the layer above it did not consume it:

- 0.3.0: `runHeadlessAgent` streamed correctly; both bridge call sites still
  passed `outputFormat: "plain"`.
- 0.3.2: `enrichJob` classified abandoned runs correctly; the renderer still
  read `job.status`.

Unit tests cannot catch this by construction — each layer passes in isolation.
Both were found by asking "does this actually reach the user?" and checking the
end-to-end output.

**Recommendation:** for any observability feature, require an end-to-end assertion
against rendered output, not just the module that computes the value. The
`delegate output must be turn-separated` test added in 0.3.0 is the right shape;
the new `an abandoned run is displayed as abandoned` test is the same idea.

## Comparing the two implementers

**Grok Build** handled large, cross-cutting tasks well. Delegation 5 modified
`grok-bridge.mjs` in six places coherently and respected every constraint,
including the explicitly warned-about ones (do not revert `resolveSpawnInvocation`,
do not change `outputFormat`). It exceeded the plan correctly twice during 0.3.0.
Its one weakness is **reporting accuracy**: delegation 5 stated it had created
`plugins/grok-build/tests/land.test.mjs` when it had correctly created
`tests/land.test.mjs`. The work was right; the description was wrong. Verify the
tree, not the report.

**Nemotron Ultra** is well suited to exactly what the Nemotron README claims:
small, tightly specified, self-contained modules. Both its deliverables were
correct in structure and passed their tests. But it needed a supervisor fix on
**both** delegations, and it deviated from explicit instructions twice (imports,
stray file). It also isolates by default, which meant its output arrived in a
worktree needing review before landing — that caught the stray file automatically,
which is a real argument for the isolation model we just built for Grok.

**Cost:** Ultra reported $0.043 for delegation 4. Grok runs do not report cost in
the delegate output path, though 0.3.0 stores it on the run record.

## What this says about the plugin

The isolation work validated itself during its own construction. Ultra's stray
`tests/debug.mjs` never touched the working tree because Nemotron isolates by
default — I saw it listed in the worktree diff and simply did not copy it across.
Under the pre-0.3.1 Grok model that file would have landed silently in the repo.

Two things to consider for a later release:

1. **Grok's delegate path should report cost** the way Nemotron's does. The data
   is already on the run record as of 0.3.0; the delegate output just does not
   surface it. Cheap, and it makes budget decisions possible without `/runs`.
2. **A stray-file check at land time.** `land` shows the diff, which is the
   opportunity to flag files that look incidental (`debug.*`, `tmp*`, `scratch*`)
   rather than part of the change. Both stray files this session were obvious by
   name.

## Verification performed by the supervisor

Not taken on trust:

- Full suite run and counted after every single delegation.
- End-to-end isolation test with the **real** `grok` CLI in a scratch repo:
  confirmed the source repo stayed clean, a `grok-build/<run-id>` worktree and
  branch were created, and the agent's file existed only inside the worktree.
- End-to-end `land`: confirmed it refuses a dirty tree by name, squash-merges,
  stages rather than commits, and removes both worktree and branch.
- End-to-end `prune`: confirmed a seeded abandoned run is **not** mutated without
  `--apply`, and is claimed terminal with `--apply`.
- End-to-end `doctor`: confirmed all seven checks report.
- Re-probed `grok` 0.2.114 to confirm the two findings the design rests on still
  hold: `-w` is still silently ignored in headless mode, and the streaming event
  vocabulary is unchanged.
