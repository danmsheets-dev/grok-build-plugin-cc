import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult, renderTaskResult } from "../plugins/grok-build/scripts/lib/render.mjs";

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
  assert.match(output, /Resume in Grok: grok -r thr_123/);
});

import { formatUsageLine, formatUsageTotals, renderJobStatusReport } from "../plugins/grok-build/scripts/lib/render.mjs";

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

test("formatUsageLine omits cost and turns when absent", () => {
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
    "Tokens: 100 in / 5 out"
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
  const output = renderTaskResult(
    { rawOutput: "Fixed the bug." },
    { title: "Grok Build Delegate", verified: true }
  );
  assert.match(output, /Verified: yes/);
});

test("renderTaskResult surfaces a failing verification with its note", () => {
  const output = renderTaskResult(
    { rawOutput: "Attempted a fix." },
    { title: "Grok Build Delegate", verified: false, verifyNote: "still failing after 2 attempts" }
  );
  assert.match(output, /Verified: no/);
  assert.match(output, /still failing after 2 attempts/);
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
      worktree: { path: "/tmp/worktrees/run-abc123", branch: "grok-build/run-abc123" }
    }
  );
  assert.match(output, /Worktree: \/tmp\/worktrees\/run-abc123 \(branch grok-build\/run-abc123\)/);
  assert.match(output, /\/grok-build:land run-abc123/);
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
      worktree: { path: "/tmp/wt", branch: "grok-build/run-xyz" },
      budgetStopped: null
    }
  );
  assert.match(output, /Verified: yes \(failures unchanged from baseline\)/);
  assert.match(output, /Worktree: \/tmp\/wt/);
  assert.doesNotMatch(output, /Budget:/, "no budget line when budgetStopped is null");
});

test("an isolated write run's follow-up hint points at land, not review", () => {
  // Regression: the hint suggested /grok-build:review --wait for EVERY write
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
    worktree: { path: "/tmp/wt/run-iso", branch: "grok-build/run-iso" }
  });
  assert.match(output, /Review and land: \/grok-build:land run-iso/);
  assert.doesNotMatch(output, /\/grok-build:review --wait/);
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
  assert.match(output, /\/grok-build:review --wait/);
  assert.match(output, /\/grok-build:critique --wait/);
});
