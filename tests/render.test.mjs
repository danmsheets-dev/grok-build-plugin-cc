import test from "node:test";
import assert from "node:assert/strict";

import { renderReviewResult, renderStoredJobResult } from "../plugins/grok-build/scripts/lib/render.mjs";

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
