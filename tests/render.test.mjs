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

import { formatUsageLine, renderJobStatusReport } from "../plugins/grok-build/scripts/lib/render.mjs";

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
