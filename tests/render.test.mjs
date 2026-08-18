import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBridgeResultBlock,
  buildRunManifest,
  buildTaskStatusLines,
  countChangedFilesForHonesty,
  formatToolCallsLabel,
  formatUsageLine,
  formatUsageTotals,
  formatVerifyRatioLine,
  renderJobStatusReport,
  renderReviewResult,
  renderStoredJobResult,
  renderTaskResult,
  RUN_MANIFEST_SCHEMA_VERSION
} from "../plugins/turbo-build-plugin/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Critique",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Grok returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Grok Build Critique",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Grok Build Critique\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Grok Build Critique/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Grok session ID: thr_123/);
  assert.match(output, /Resume in Grok: turbo -r thr_123/);
  assert.match(output, /===BRIDGE-RESULT===/);
  assert.match(output, /===END-BRIDGE-RESULT===/);
});

test("formatUsageLine renders tokens, turns and cost", () => {
  assert.equal(
    formatUsageLine({
      inputTokens: 22962,
      cachedInputTokens: 33408,
      outputTokens: 163,
      reasoningTokens: 58,
      totalTokens: 56533,
      costUsd: 0.0569244,
      numTurns: 2
    }),
    "Tokens: 22,962 in (33,408 cached) / 163 out · 2 turns · $0.0569"
  );
});

test("formatUsageLine omits turns when absent and never invents \$0.00 for null cost", () => {
  // Tokens without a cost (or flags) used to print nothing for cost; after WP-B4
  // we surface "unavailable" so absence is not read as free.
  assert.equal(
    formatUsageLine({
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 105,
      costUsd: null,
      numTurns: null
    }),
    "Tokens: 100 in / 5 out · cost: unavailable"
  );
  assert.equal(
    formatUsageLine({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      numTurns: null
    }),
    "Tokens: 0 in / 0 out"
  );
});

test("formatUsageLine returns null without usage", () => {
  assert.equal(formatUsageLine(null), null);
});

test("formatUsageTotals sums usage across jobs", () => {
  assert.equal(
    formatUsageTotals([
      {
        usage: {
          inputTokens: 100,
          cachedInputTokens: 10,
          outputTokens: 20,
          costUsd: 0.01
        }
      },
      {
        usage: {
          inputTokens: 50,
          cachedInputTokens: 5,
          outputTokens: 15,
          costUsd: 0.005
        }
      }
    ]),
    "Session totals: 2 runs - 150 in (15 cached) / 35 out - $0.0150"
  );
});

test("formatUsageTotals returns null when no job has usage", () => {
  assert.equal(formatUsageTotals([{ id: "a" }, { id: "b", usage: null }]), null);
  assert.equal(formatUsageTotals([]), null);
  assert.equal(formatUsageTotals(null), null);
});

test("run status shows last activity for an active run", () => {
  const output = renderJobStatusReport({
    id: "run-1",
    status: "running",
    kindLabel: "delegate",
    title: "Grok Build Delegate",
    phase: "writing",
    lastEventAge: "8s ago"
  });
  assert.match(output, /Last activity: 8s ago/);
});

test("runs --wait says so when the wait itself timed out", () => {
  // Regression: waitTimedOut was computed but never reached the renderer -
  // `grep waitTimedOut` matched exactly one line in the whole bridge script.
  // A run that outlived `runs --wait` reported no differently from one merely
  // polled once.
  const job = { id: "run-2", status: "running", kindLabel: "delegate", title: "Grok Build Delegate" };

  const timedOut = renderJobStatusReport(job, { waitTimedOut: true, timeoutMs: 240000 });
  assert.match(timedOut, /wait timed out/i);
  assert.match(timedOut, /--timeout-ms/);
  assert.match(timedOut, /running/);

  const notTimedOut = renderJobStatusReport(job, { waitTimedOut: false, timeoutMs: 240000 });
  assert.doesNotMatch(notTimedOut, /wait timed out/i);

  const noOptions = renderJobStatusReport(job);
  assert.doesNotMatch(noOptions, /wait timed out/i);
});

test("an abandoned run is displayed as abandoned, not running", () => {
  // Regression: enrichJob computed liveness but the renderer read job.status, so
  // a dead run still displayed as running — the exact failure this was built to fix.
  const output = renderJobStatusReport({
    id: "run-dead",
    status: "running",
    displayStatus: "abandoned",
    abandoned: true,
    kindLabel: "delegate",
    title: "Grok Build Delegate"
  });
  assert.match(output, /abandoned/i);
  assert.doesNotMatch(output, /run-dead \| running/);
  assert.match(output, /prune --apply/);
});

test("renderTaskResult renders exactly the raw output when there is nothing extra to report", () => {
  const output = renderTaskResult({ rawOutput: "Handled the task." }, { title: "Grok Build Delegate" });
  assert.equal(output, "Handled the task.\n");
});

test("renderTaskResult surfaces a passing verification", () => {
  // Regression: verified/worktree/budget were all computed by executeTaskRun
  // and then never appended to the rendered output at all - a run's actual
  // terminal text said nothing about whether verification passed.
  // R7-4: prefer `verify passed` / ratio over boolean Verified: yes.
  const output = renderTaskResult(
    { rawOutput: "Fixed the bug." },
    { title: "Grok Build Delegate", verified: true }
  );
  assert.match(output, /verify passed|Verified: yes/);
});

test("renderTaskResult surfaces a failing verification with its note", () => {
  const output = renderTaskResult(
    { rawOutput: "Attempted a fix." },
    { title: "Grok Build Delegate", verified: false, verifyNote: "still failing after 2 attempts" }
  );
  assert.match(output, /Verified: no/);
  assert.match(output, /still failing after 2 attempts/);
});

test("renderTaskResult names the matched engine-failure marker on an exit-0 Verified: no", () => {
  // F1's second half: an exit-0 output-pattern failure used to be explicable
  // only by reading --json's matchedLines field. This is the only place a
  // reader who never opens the JSON learns which line made the bridge
  // disbelieve a clean exit code.
  const output = renderTaskResult(
    { rawOutput: "Ran the import." },
    {
      title: "Grok Build Delegate",
      verified: false,
      verifyNote: "verification did not pass within the attempt budget.",
      verifyMatchedLines: [
        {
          command: "godot --headless --path . --import",
          matchedLines: ["SCRIPT ERROR: Parse Error: Identifier foo not declared"]
        }
      ]
    }
  );
  assert.match(output, /Verified: no/);
  assert.match(output, /SCRIPT ERROR: Parse Error: Identifier foo not declared/);
  assert.match(output, /godot --headless --path \. --import/);
});

test("renderTaskResult says nothing extra about matched markers on a healthy run", () => {
  // Guards against over-applying the render: a verified run must not print
  // this block even if verifyMatchedLines happened to be non-empty (e.g. an
  // exit-0 output failure that turned out unchanged from baseline).
  const output = renderTaskResult(
    { rawOutput: "Ran the import." },
    {
      title: "Grok Build Delegate",
      verified: true,
      verifyMatchedLines: [
        { command: "godot --headless --path . --import", matchedLines: ["SCRIPT ERROR: something"] }
      ]
    }
  );
  assert.doesNotMatch(output, /SCRIPT ERROR/);
});

test("renderTaskResult explains an infrastructure verify failure instead of implying a code fault", () => {
  // Regression: the verified:false branch emitted one fixed sentence and
  // dropped verifyNote entirely, so a run that failed because the verify
  // command timed out or was never runnable told the user only that
  // "verification did not pass" - the computed-and-never-delivered failure
  // this status block exists to prevent.
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      verified: false,
      verifyNote:
        "the verify command could not be started (not found on PATH) - this is not a code failure (godot --headless)"
    }
  );
  assert.match(output, /Verified: no - the verify command could not be started/);
  assert.match(output, /not a code failure/);
  assert.doesNotMatch(output, /within the attempt budget/);
});

test("renderTaskResult still explains a plain verification failure without a note", () => {
  const output = renderTaskResult(
    { rawOutput: "Attempted a fix." },
    { title: "Grok Build Delegate", verified: false }
  );
  assert.match(output, /Verified: no - verification did not pass within the attempt budget/);
});

test("renderTaskResult echoes a verify plan the user never typed, and names its source", () => {
  // Not cosmetic. A run can now verify commands resolved from a detected
  // ecosystem or from .grok-build.json, so the run's own output is the only
  // place a user learns what ran and who chose it.
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      verified: true,
      verifyCommands: ["godot --headless --path . --import", "godot --headless --path . --quit-after 1"],
      verifyPlan: { source: "ecosystem-default", ecosystem: "godot", configWithheld: [] }
    }
  );
  assert.match(output, /Verify plan \(ecosystem default, godot\):/);
  assert.match(output, /godot --headless --path \. --import/);
  assert.match(output, /godot --headless --path \. --quit-after 1/);
});

test("renderTaskResult labels a plan the user typed as --verify", () => {
  // Guards the label map in render.mjs against drift from describeVerifySource
  // in project-config.mjs, which it deliberately mirrors rather than imports.
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      verifyCommands: ["npm test"],
      verifyPlan: { source: "cli", ecosystem: "node", configWithheld: [] }
    }
  );
  assert.match(output, /Verify plan \(--verify\):/);
});

test("renderTaskResult names .grok-build.json when the plan came from the config file", () => {
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      verified: true,
      verifyCommands: ["cargo test"],
      verifyPlan: { source: "config", ecosystem: "rust", configWithheld: [] }
    }
  );
  assert.match(output, /Verify plan \(\.grok-build\.json\):/);
  assert.doesNotMatch(output, /Verify plan \(\.grok-build\.json, rust\)/);
});

test("renderTaskResult says when a config's verify list was withheld for want of trust", () => {
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      verifyCommands: [],
      verifyPlan: { source: "none", ecosystem: null, configWithheld: ["verify", "tools"] },
      verifyTrustCommand: "node scripts/grok-bridge.mjs trust-config"
    }
  );
  assert.match(output, /verify, tools in \.grok-build\.json was NOT used/);
  assert.match(output, /not trusted yet/);
  assert.match(output, /trust-config/);
});

test("renderTaskResult reports an explicit --no-verify rather than staying silent", () => {
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      verifyCommands: [],
      verifyPlan: { source: "none", disabled: true, ecosystem: "godot", configWithheld: [] }
    }
  );
  assert.match(output, /Verify plan: disabled for this run \(--no-verify\)\./);
});

test("renderTaskResult says nothing about a verify plan when there is none", () => {
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      verified: true,
      verifyCommands: [],
      verifyPlan: { source: "none", disabled: false, ecosystem: null, configWithheld: [] }
    }
  );
  assert.doesNotMatch(output, /Verify plan/);
});

test("renderTaskResult reports what the baseline probe cost", () => {
  // The probe is unconditional now, so on a non-isolated run it doubles the
  // verify wall clock. An unexplained doubling is how a safeguard gets
  // switched off; the cost has to be visible.
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      verified: true,
      baselineProbeMs: 4200,
      baselineProbeCommands: 2
    }
  );
  assert.match(output, /Baseline probe: 4\.2s across 2 verify commands \(measured before the agent ran\)\./);
});

test("renderTaskResult omits the baseline probe line when no probe ran", () => {
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    { title: "Grok Build Delegate", verified: true, baselineProbeMs: null }
  );
  assert.doesNotMatch(output, /Baseline probe/);
});

test("renderTaskResult surfaces the worktree and a land hint", () => {
  const output = renderTaskResult(
    { rawOutput: "Created a file." },
    {
      title: "Grok Build Delegate",
      jobId: "run-abc123",
      worktree: { path: "/tmp/worktrees/run-abc123", branch: "turbo-build/run-abc123" }
    }
  );
  assert.match(output, /Worktree: \/tmp\/worktrees\/run-abc123 \(branch turbo-build\/run-abc123\)/);
  assert.match(output, /\/turbo-build-plugin:land run-abc123/);
});

test("renderTaskResult explains a failed worktree commit and points at the directory", () => {
  // commitWorktreeChanges used to throw here, and tracked-jobs flattens a
  // thrown error to an errorMessage - losing rawOutput, threadId, usage and
  // verify.results for a run that had actually completed. The run now finishes
  // and says what went wrong, because the branch does NOT contain the work and
  // /turbo-build-plugin:land would therefore land nothing.
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      jobId: "run-commitfail",
      worktree: {
        path: "/tmp/wt/run-commitfail",
        branch: "turbo-build/run-commitfail",
        commitError: "git add failed (exit=128): fatal: pathspec magic is not supported by this git"
      }
    }
  );
  assert.match(output, /could not commit agent changes/);
  assert.match(output, /pathspec magic is not supported/);
  assert.match(output, /work is still on disk at \/tmp\/wt\/run-commitfail/);
  assert.match(output, /Did the work\./, "the completed run's own output must survive");
});

test("renderTaskResult stays quiet about the commit when there was no commit error", () => {
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      jobId: "run-ok",
      worktree: { path: "/tmp/wt/run-ok", branch: "turbo-build/run-ok", commitError: null }
    }
  );
  assert.doesNotMatch(output, /could not commit/);
});

test("renderTaskResult warns that a linked .godot is shared with the working copy", () => {
  // The README promises writes reach the real directories; nothing said it at
  // the moment it matters, which is when a Godot editor is open on the same
  // import cache a headless verify run is about to reimport into.
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      provision: {
        provisioned: [{ name: ".godot", kind: "junction" }],
        failed: [],
        notes: [".godot is shared with your working copy; close the Godot editor before running verify."]
      }
    }
  );
  assert.match(output, /Provisioning: \.godot is shared with your working copy/);
  assert.match(output, /close the Godot editor/);
});

test("renderTaskResult names a provisioning failure and words the tracked-cache case correctly", () => {
  // "destination already exists" is fs's wording for a directory that is
  // TRACKED IN GIT and was therefore already checked out - stale but present,
  // not absent, so "the first verify runs a cold import" would be wrong.
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      provision: {
        provisioned: [],
        failed: [
          { name: ".godot", reason: "destination already exists" },
          { name: ".venv", reason: "EPERM: operation not permitted, symlink" }
        ],
        notes: []
      }
    }
  );
  assert.match(output, /Provisioning skipped: \.godot \(already present in the worktree - it is tracked in git\)\./);
  assert.doesNotMatch(output, /cold import/);
  // A reason that is a genuine failure is reported verbatim.
  assert.match(output, /Provisioning skipped: \.venv \(EPERM: operation not permitted, symlink\)\./);
});

test("renderTaskResult says nothing about provisioning when there is nothing to say", () => {
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    {
      title: "Grok Build Delegate",
      provision: { provisioned: [{ name: "node_modules", kind: "junction" }], failed: [], notes: [] }
    }
  );
  assert.doesNotMatch(output, /Provisioning/);
});

test("renderTaskResult surfaces a budget stop", () => {
  const output = renderTaskResult(
    { rawOutput: "Partial work done." },
    { title: "Grok Build Delegate", budgetStopped: "max-cost" }
  );
  assert.match(output, /Budget: run stopped early \(max-cost\)/);
});

test("renderTaskResult can surface all three at once", () => {
  const output = renderTaskResult(
    { rawOutput: "Did some work." },
    {
      title: "Grok Build Delegate",
      jobId: "run-xyz",
      verified: true,
      verifyNote: "failures unchanged from baseline",
      worktree: { path: "/tmp/wt", branch: "turbo-build/run-xyz" },
      budgetStopped: null
    }
  );
  // R7-4: honesty line carries the note; boolean Verified: yes is no longer required.
  assert.match(output, /verify passed \(failures unchanged from baseline\)|Verified: yes \(failures unchanged from baseline\)/);
  assert.match(output, /Worktree: \/tmp\/wt/);
  assert.doesNotMatch(output, /Budget:/, "no budget line when budgetStopped is null");
});

test("an isolated write run's follow-up hint points at land, not review", () => {
  // Regression: the hint suggested /turbo-build-plugin:review --wait for EVERY write
  // run, but an isolated run never touches the working tree at all - review
  // would look at the wrong thing entirely and find nothing, since the real
  // changes sit unlanded in the worktree.
  const output = renderJobStatusReport({
    id: "run-iso",
    status: "completed",
    jobClass: "task",
    write: true,
    kindLabel: "delegate",
    title: "Grok Build Delegate",
    worktree: { path: "/tmp/wt/run-iso", branch: "turbo-build/run-iso" }
  });
  assert.match(output, /Review and land: \/turbo-build-plugin:land run-iso/);
  assert.doesNotMatch(output, /\/turbo-build-plugin:review --wait/);
});

test("a non-isolated write run keeps the review/critique hint", () => {
  const output = renderJobStatusReport({
    id: "run-direct",
    status: "completed",
    jobClass: "task",
    write: true,
    kindLabel: "delegate",
    title: "Grok Build Delegate"
  });
  assert.match(output, /\/turbo-build-plugin:review --wait/);
  assert.match(output, /\/turbo-build-plugin:critique --wait/);
});

test("renderTaskResult surfaces stderr and the log path when the run said nothing", () => {
  // stderr was dropped entirely whenever the process exited 0, which is exactly
  // the shape a truncated or rate-limited response takes: status 0, no text,
  // and the only explanation on the channel nobody read.
  const output = renderTaskResult(
    { rawOutput: "", stderr: "warning: response truncated" },
    { title: "Grok Build Delegate", logFile: "C:/x/run.log" }
  );

  assert.match(output, /Grok did not return a final message/);
  assert.match(output, /warning: response truncated/);
  assert.match(output, /Log: C:\/x\/run\.log/);
});

test("renderTaskResult keeps a healthy run's stderr out of the way", () => {
  const output = renderTaskResult(
    { rawOutput: "Rebuilt the scene.", stderr: "npm notice a new version is available" },
    { title: "Grok Build Delegate" }
  );
  assert.doesNotMatch(output, /npm notice/);
});

test("renderTaskResult shows only the tail of a long stderr", () => {
  const stderr = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
  const output = renderTaskResult({ rawOutput: "", stderr }, { title: "Grok Build Delegate" });

  assert.match(output, /line 59/);
  assert.match(output, /line 40/);
  assert.doesNotMatch(output, /line 39\b/);
});

test("renderTaskResult always names the log file, even on a healthy run", () => {
  // tracked-jobs appends the complete rendered result there, which makes it the
  // durable artifact of the run - and useless if nobody is told where it is.
  const output = renderTaskResult(
    { rawOutput: "Did the work." },
    { title: "Grok Build Delegate", logFile: "/var/data/jobs/run-1.log" }
  );
  assert.match(output, /Log: \/var\/data\/jobs\/run-1\.log/);
});

test("renderTaskResult admits when its output is raw stdout rather than a transcript", () => {
  const output = renderTaskResult(
    { rawOutput: '{"type":"assistant_message","content":"Rebuilt the scene."}' },
    {
      title: "Grok Build Delegate",
      streamParsed: false,
      unknownEventTypes: ["assistant_message", "done"]
    }
  );

  assert.match(output, /no recognized assistant messages; showing raw stdout/);
  assert.match(output, /Rebuilt the scene/);
  assert.match(output, /unrecognized event types.*assistant_message, done/);
  assert.match(output, /newer than the bridge/);
});

test("buildTaskStatusLines names an unrecognized event type that produced no answer", () => {
  // The `!streamParsed`-only gate would hide the diagnostic for a build that
  // emits recognized AND unknown types and still returns nothing useful.
  const lines = buildTaskStatusLines({ unknownEventTypes: ["assistant_message"], streamParsed: true }, "");
  assert.ok(lines.some((line) => line.includes("assistant_message")), lines.join("\n"));
});

test("buildTaskStatusLines stays silent about unknown events on a healthy run", () => {
  const lines = buildTaskStatusLines(
    { unknownEventTypes: ["tool_call"], streamParsed: true },
    "Rebuilt the scene."
  );
  assert.ok(!lines.some((line) => line.startsWith("Stream:")), lines.join("\n"));
});

test("buildTaskStatusLines lists what changed before it says where the worktree is", () => {
  // For a Godot or Blender run the artifact IS the deliverable, and the status
  // block used to report only Verified/Worktree/Budget.
  const lines = buildTaskStatusLines({
    jobId: "run-godot",
    worktree: {
      path: "/tmp/wt/run-godot",
      branch: "turbo-build/run-godot",
      changedFiles: ["A\tscenes/Player.tscn", "M\tassets/model.glb"]
    },
    changedFiles: {
      source: "commit",
      entries: ["A\tscenes/Player.tscn", "M\tassets/model.glb"],
      total: 2,
      truncated: false
    }
  });

  const manifestIndex = lines.findIndex((line) =>
    line.startsWith("Changed files (worktree): 2") || line.startsWith("Changed files (2)")
  );
  const worktreeIndex = lines.findIndex((line) => line.startsWith("Worktree:"));
  assert.ok(manifestIndex >= 0, lines.join("\n"));
  assert.ok(worktreeIndex > manifestIndex, "the manifest comes before the path to it");
  assert.ok(lines.includes("  A scenes/Player.tscn"));
  assert.ok(lines.includes("  M assets/model.glb"));
});

test("buildTaskStatusLines caps the rendered manifest and counts the remainder", () => {
  const entries = Array.from({ length: 120 }, (_, index) => `A\tassets/mesh_${index}.glb`);
  const lines = buildTaskStatusLines({
    changedFiles: { source: "commit", entries, total: 137, truncated: true }
  });

  const rendered = lines.filter((line) => line.startsWith("  A assets/"));
  assert.equal(rendered.length, 40);
  assert.ok(lines.includes("  ... 97 more"), lines.join("\n"));
});

test("an empty manifest is reported as none, never omitted", () => {
  // Omitting the block is how the silent-result complaint reappears in exactly
  // the Godot import-cache case: a run whose every output was excluded.
  const lines = buildTaskStatusLines({
    changedFiles: {
      source: "commit",
      entries: [],
      total: 0,
      truncated: false,
      emptyReason: "excluded-artifacts"
    }
  });
  assert.ok(
    lines.some((line) => /Changed files \(worktree\): none \(run produced only excluded build artifacts\)/.test(line)),
    lines.join("\n")
  );
});

test("a non-isolated run labels its manifest as main tree and counts pre-existing edits", () => {
  const lines = buildTaskStatusLines({
    changedFiles: {
      source: "working-tree",
      entries: ["A\tsrc/new.py"],
      total: 1,
      truncated: false,
      preexistingDirty: 2
    }
  });

  assert.ok(lines.some((line) => line.startsWith("Changed files (main tree): 1")), lines.join("\n"));
  assert.ok(
    lines.some((line) => /2 paths were already modified before the run/.test(line)),
    lines.join("\n")
  );
});

test("buildTaskStatusLines says nothing about changed files when nothing measured them", () => {
  const lines = buildTaskStatusLines({ verified: true });
  assert.ok(!lines.some((line) => /Changed files|Working tree changes/.test(line)), lines.join("\n"));
});

test("renderStoredJobResult prefers the final report over the stored narration", () => {
  const output = renderStoredJobResult(
    { id: "run-1", status: "completed", title: "Grok Build Delegate" },
    {
      result: {
        finalReport: "## Result\nRebuilt the scene.",
        rawOutput: "Let me look at the project structure.",
        transcript: "Let me look at the project structure."
      }
    }
  );

  assert.match(output, /Rebuilt the scene\./);
  assert.doesNotMatch(output, /Let me look at/);
});

test("renderStoredJobResult shows task report first and labels verify fix history after", () => {
  const output = renderStoredJobResult(
    { id: "run-fix", status: "completed-unverified", title: "Grok Build Delegate" },
    {
      result: {
        finalReport: "## Result\n24 findings about architecture.",
        rawOutput: "## Result\n24 findings about architecture.",
        verify: {
          fixAttempts: [
            {
              attempt: 1,
              command: "cargo test",
              finalReport: "## Result\nI fixed cargo test."
            }
          ]
        }
      }
    }
  );

  assert.match(output, /24 findings about architecture/);
  assert.match(output, /Verify fix history \(not the task deliverable\)/);
  assert.match(output, /I fixed cargo test/);
  // Task deliverable appears before fix history.
  const taskIdx = output.indexOf("24 findings");
  const fixIdx = output.indexOf("Verify fix history");
  assert.ok(taskIdx >= 0 && fixIdx > taskIdx);
});

test("renderStoredJobResult still falls back to rawOutput, then to a review's stdout", () => {
  // lastMessage is deliberately absent from that chain: preferring a bare
  // trailing line over the stored output would make show print LESS than today.
  const noReport = renderStoredJobResult(
    { id: "run-2", status: "completed", title: "Grok Build Delegate" },
    { result: { finalReport: "", rawOutput: "Handled the requested task.", lastMessage: "ok" } }
  );
  assert.match(noReport, /Handled the requested task\./);

  const review = renderStoredJobResult(
    { id: "run-3", status: "completed", title: "Grok Build Review" },
    { result: { grok: { stdout: "Reviewed uncommitted changes." } } }
  );
  assert.match(review, /Reviewed uncommitted changes\./);
});

test("renderStoredJobResult composes answer with stored status trailer", () => {
  const output = renderStoredJobResult(
    { id: "run-trailer", status: "completed-unverified", title: "Grok Build Delegate" },
    {
      result: {
        finalReport: "## Result\nFixed the scene.",
        statusLines: [
          "Verified: no - verification did not pass within the attempt budget.",
          "  Output matched a known failure marker in `godot --headless`: SCRIPT ERROR",
          "Changed files: 2",
          "Isolation BREACHED: the main checkout changed while this run was in flight."
        ],
        toolCallCount: null,
        toolVisibility: "unavailable"
      },
      status: "completed-unverified",
      verified: false
    }
  );

  assert.match(output, /Fixed the scene/);
  assert.match(output, /Verified: no/);
  assert.match(output, /SCRIPT ERROR/);
  assert.match(output, /Isolation BREACHED/);
  assert.match(output, /===BRIDGE-RESULT===/);
});

test("buildTaskStatusLines surfaces stream errors and blocked confine attempts", () => {
  // WP-B7-FIX: blocked confine attempts alone are NOT a breach.
  const blockedOnly = buildTaskStatusLines({
    streamErrors: [{ message: "Connection closed unexpectedly" }],
    confineViolations: [
      { tool: "Write", path: "x", resolvedPath: "/repo/x", root: "/tmp/wt" }
    ],
    isolationBreached: false,
    status: "completed"
  });
  const blockedText = blockedOnly.join("\n");
  assert.match(blockedText, /Stream error: Connection closed unexpectedly/);
  assert.match(blockedText, /1 confine attempt blocked by the CLI \(isolation held\)/);
  assert.match(blockedText, /tool=Write/);
  assert.doesNotMatch(blockedText, /Isolation BREACHED/);

  // Real breach still names BREACHED; blocked attempts remain a separate line.
  const both = buildTaskStatusLines({
    confineViolations: [
      { tool: "Write", path: "x", resolvedPath: "/repo/x", root: "/tmp/wt" }
    ],
    isolationBreached: true,
    status: "isolation-breached",
    isolationLeak: { entries: ["A\tleaked.txt"], total: 1, truncated: false }
  });
  const bothText = both.join("\n");
  assert.match(bothText, /confine attempt blocked by the CLI \(isolation held\)/);
  assert.match(bothText, /Isolation BREACHED: the main checkout changed/);
  assert.doesNotMatch(bothText, /CLI reported confine violation\(s\) and\/or/);
});

test("formatUsageLine prints unavailable for partial cost, never \$0.00", () => {
  const partial = formatUsageLine(
    {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 5,
      costUsd: null,
      costIsPartial: true,
      usageIsIncomplete: true,
      numTurns: 2
    },
    { compact: true }
  );
  assert.match(partial, /cost: unavailable \(partial\)/);
  assert.doesNotMatch(partial, /\$0\.00/);

  const zeroFromBug = formatUsageLine(
    {
      inputTokens: 100,
      outputTokens: 5,
      costUsd: 0,
      usageIsIncomplete: true,
      numTurns: 1
    },
    { compact: true }
  );
  assert.match(zeroFromBug, /unavailable/);
  assert.doesNotMatch(zeroFromBug, /\$0\.00/);
});

test("buildBridgeResultBlock says tool calls not reported by this CLI when null", () => {
  const block = buildBridgeResultBlock(
    {
      id: "run-null-tools",
      status: "completed",
      toolCallCount: null,
      toolVisibility: "unavailable",
      usage: { inputTokens: 10, outputTokens: 2, costUsd: null, usageIsIncomplete: true }
    },
    null
  );
  assert.match(block, /tool calls: not reported by this CLI/);
  assert.doesNotMatch(block, /tool calls: unknown/);
});

test("formatToolCallsLabel distinguishes unavailable from zero", () => {
  assert.equal(formatToolCallsLabel(0), "0");
  assert.equal(formatToolCallsLabel(null), "not reported by this CLI");
  assert.match(formatToolCallsLabel(null, { toolCallCountFloor: 4 }), /≥4/);
});

test("buildRunManifest emits schemaVersion and stream channel fields", () => {
  const manifest = buildRunManifest(
    {
      id: "run-m1",
      status: "completed",
      model: "grok-4.5",
      resolvedModel: "grok-4.5-build",
      toolCallCount: null,
      verified: true
    },
    {
      result: {
        finalReport: "## Result\nDone.\n\n## Assumptions\n- assumed X\n\n## Follow-ups\n- do Y",
        statusLines: ["Verified: yes"],
        streamErrors: [{ message: "rate limited" }],
        confineViolations: [{ tool: "Write", resolvedPath: "/x", root: "/wt" }],
        unknownEventTypes: ["widget_ping"],
        toolVisibility: "unavailable",
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          costUsd: null,
          costIsPartial: true,
          usageIsIncomplete: true
        },
        verify: {
          plan: { source: "cli" },
          results: [{ command: "npm test", ok: true, exitCode: 0, matchedLines: [] }]
        },
        children: [{ id: "child-1", status: "completed", usage: { costUsd: 0.1 } }]
      },
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        costUsd: null,
        costIsPartial: true,
        usageIsIncomplete: true
      }
    }
  );

  assert.equal(manifest.schemaVersion, RUN_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.runId, "run-m1");
  assert.equal(manifest.agent.toolVisibility, "unavailable");
  assert.equal(manifest.usage.costIsPartial, true);
  assert.equal(manifest.usage.costUsd, null);
  assert.equal(manifest.agent.errors[0].message, "rate limited");
  // WP-B7-FIX: confineViolations are their own key; they do not set breached.
  assert.equal(manifest.isolation.confineViolations.length, 1);
  assert.equal(manifest.isolation.breached, false);
  assert.ok(manifest.report.contractHonoured);
  assert.ok(manifest.assumptions.some((a) => /assumed X/.test(a)));
  assert.ok(manifest.followUps.some((f) => /do Y/.test(f)));
  assert.equal(manifest.children.length, 1);
  assert.ok(manifest.compat.job);
  assert.ok(manifest.compat.storedJob);
});

test("buildRunManifest sets breached only from isolation flags, not confineViolations", () => {
  const clean = buildRunManifest(
    { id: "run-block-only", status: "completed", isolationBreached: false },
    {
      result: {
        confineViolations: [{ tool: "run_terminal_command", path: "cd /wt", root: "/wt" }]
      }
    }
  );
  assert.equal(clean.isolation.breached, false);
  assert.equal(clean.isolation.confineViolations.length, 1);

  const breached = buildRunManifest(
    {
      id: "run-real-breach",
      status: "isolation-breached",
      isolationBreached: true,
      isolationLeak: { entries: ["A\tleaked.txt"] }
    },
    {
      result: {
        confineViolations: [{ tool: "Write", resolvedPath: "/x", root: "/wt" }]
      }
    }
  );
  assert.equal(breached.isolation.breached, true);
  assert.equal(breached.isolation.confineViolations.length, 1);
  assert.deepEqual(breached.isolation.leakedPaths, ["A\tleaked.txt"]);
});

// --- R7-4: report honesty at the top ---

test("R7-4 honesty header: files changed first, zero-write flagged, verify ratio", () => {
  const lines = buildTaskStatusLines({
    write: true,
    changedFileCount: 0,
    verified: true,
    status: "completed-noop",
    verifyResults: [
      { command: "npm test", ok: true },
      { command: "lint", ok: true },
      { command: "typecheck", ok: false }
    ],
    baselines: [
      { command: "npm test", ok: true },
      { command: "lint", ok: true },
      { command: "typecheck", ok: true }
    ]
  });
  // files changed is the first honesty line
  assert.equal(lines[0], "files changed: 0  ⚠ --write run changed nothing");
  // completed-noop suppresses verify ratio (verified n/a) — files still first
  assert.match(lines.join("\n"), /Verified: n\/a - the run changed no files/);
});

test("R7-4 verify ratio replaces boolean Verified: yes when results exist", () => {
  const lines = buildTaskStatusLines({
    write: true,
    changedFileCount: 3,
    verified: true,
    status: "completed",
    verifyResults: [
      { command: "a", ok: true },
      { command: "b", ok: true },
      { command: "c", ok: false }
    ],
    baselines: [
      { command: "a", ok: true },
      { command: "b", ok: true },
      { command: "c", ok: true }
    ],
    verifyNote: "failures unchanged from baseline"
  });
  assert.equal(lines[0], "files changed: 3");
  assert.equal(lines[1], "verify 2/3 (baseline 3/3)");
  // Boolean Verified: yes must not appear when ratio is present
  assert.doesNotMatch(lines.join("\n"), /^Verified: yes/m);
  assert.match(lines.join("\n"), /Verify note: failures unchanged from baseline/);
});

test("formatVerifyRatioLine and countChangedFilesForHonesty helpers", () => {
  assert.equal(
    formatVerifyRatioLine({
      status: "completed",
      verifyResults: [{ ok: true }, { ok: true }],
      baselines: [{ ok: true }, { ok: false }]
    }),
    "verify 2/2 (baseline 1/2)"
  );
  assert.equal(
    countChangedFilesForHonesty({
      changedFiles: {
        worktree: { total: 2, entries: ["a", "b"] },
        mainTree: { total: 1, entries: ["c"] }
      }
    }),
    3
  );
});

test("stream channel lines surface question_suppressed and subagent rollup", () => {
  const lines = buildTaskStatusLines({
    questionsSuppressed: [{ reason: "headless" }],
    streamWarnings: [{ code: "folder_trust_untrusted", message: "dropped MCP" }],
    subagentsRollup: { spawned: 2, completed: 1, failed: 1, cancelled: 0 },
    confineViolations: [{ tool: "write", resolvedPath: "/x", root: "/wt" }]
  });
  const text = lines.join("\n");
  assert.match(text, /Question suppressed: 1/);
  assert.match(text, /Stream warning: folder_trust_untrusted: dropped MCP/);
  assert.match(text, /Subagents: 2 spawned/);
  assert.match(text, /1 confine attempt.*blocked by the CLI \(isolation held\)/);
});
