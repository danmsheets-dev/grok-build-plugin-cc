import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  detectImplausiblyShort,
  KNOWN_REASONING_EFFORTS,
  looksLikeUserQuestion,
  normalizeReasoningEffort
} from "../plugins/grok-build/scripts/grok-bridge.mjs";
import {
  buildSessionTotalsByModel,
  buildTaskStatusLines,
  formatUsageLine
} from "../plugins/grok-build/scripts/lib/render.mjs";
import {
  addUsage,
  createStreamTranscript,
  normalizeUsage,
  sumModelCalls
} from "../plugins/grok-build/scripts/lib/stream-events.mjs";
import {
  decideCompletionStatus,
  formatRunLogHeader,
  writeRunLogHeader
} from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import {
  isDebrisPath,
  isGeneratedArtifactPath,
  partitionWorkAndDebris
} from "../plugins/grok-build/scripts/lib/worktree.mjs";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");

// --- BRIDGE-5: modelCalls summation ---

test("sumModelCalls totals per-served-model modelCalls", () => {
  assert.equal(
    sumModelCalls({
      "grok-4.5-build": { modelCalls: 20, costUSD: 1 },
      "other": { modelCalls: 9 }
    }),
    29
  );
  assert.equal(sumModelCalls(null), null);
  assert.equal(sumModelCalls({}), null);
});

test("normalizeUsage surfaces modelCalls from modelUsage breakdown", () => {
  const usage = normalizeUsage({
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110
    },
    total_cost_usd: 0.5,
    num_turns: 1,
    modelUsage: {
      "grok-4.5-build": {
        inputTokens: 100,
        outputTokens: 10,
        modelCalls: 29,
        costUSD: 0.5
      }
    }
  });
  assert.equal(usage.modelCalls, 29);
  assert.equal(usage.resolvedModel, "grok-4.5-build");
});

test("addUsage sums modelCalls across turns without double-counting keys wrongly", () => {
  const turn1 = normalizeUsage({
    usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55 },
    total_cost_usd: 0.1,
    num_turns: 1,
    modelUsage: {
      "m": { inputTokens: 50, outputTokens: 5, modelCalls: 10, costUSD: 0.1 }
    }
  });
  const turn2 = normalizeUsage({
    usage: { input_tokens: 40, output_tokens: 4, total_tokens: 44 },
    total_cost_usd: 0.2,
    num_turns: 1,
    modelUsage: {
      "m": { inputTokens: 40, outputTokens: 4, modelCalls: 19, costUSD: 0.2 }
    }
  });
  const sum = addUsage(turn1, turn2);
  assert.equal(sum.modelCalls, 29);
  assert.equal(sum.numTurns, 2);
  assert.ok(Math.abs(sum.costUsd - 0.3) < 1e-9);
  assert.equal(sum.modelUsage.m.modelCalls, 29);
});

test("createStreamTranscript end event carries modelCalls on usage", () => {
  const transcript = createStreamTranscript();
  transcript.accept({ type: "text", data: "ok" });
  transcript.accept({
    type: "end",
    stopReason: "EndTurn",
    sessionId: "sid-1",
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12
    },
    total_cost_usd: 0.01,
    num_turns: 1,
    modelUsage: {
      "served": { modelCalls: 7, inputTokens: 10, outputTokens: 2, costUSD: 0.01 }
    }
  });
  const result = transcript.finish();
  assert.equal(result.usage.modelCalls, 7);
});

test("formatUsageLine compact form leads with call count", () => {
  const line = formatUsageLine(
    {
      inputTokens: 100,
      outputTokens: 5,
      costUsd: 1.23,
      numTurns: 2,
      modelCalls: 29
    },
    { model: "grok-4.5", resolvedModel: "grok-4.5-build", compact: true }
  );
  assert.match(line, /29 calls/);
  assert.match(line, /2 turns/);
  assert.match(line, /model grok-4\.5 -> grok-4\.5-build/);
});

test("addUsage null costs stay null across multi-turn (WP-B4 cost integrity)", () => {
  const turn1 = normalizeUsage({
    usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55, usage_is_incomplete: true },
    num_turns: 1
  });
  const turn2 = normalizeUsage({
    usage: { input_tokens: 40, output_tokens: 4, total_tokens: 44, usage_is_incomplete: true },
    num_turns: 1
  });
  const sum = addUsage(turn1, turn2);
  assert.equal(sum.costUsd, null);
  assert.equal(sum.usageIsIncomplete, true);
  // Must not become 0 — that would print as $0.00 and break --max-cost.
  assert.notEqual(sum.costUsd, 0);
});

test("formatRunLogHeader names session id and join fields", () => {
  const header = formatRunLogHeader({
    runId: "run-abc",
    grokSessionId: "019fae7c-fb03-7321-870e-0778e3119399",
    binary: "hyper",
    version: "0.2.114-r5",
    cliLabel: "Hyper",
    modelRequested: "grok-4.5",
    modelServed: "grok-4.5-build",
    isolation: "Isolation: ACTIVE (worktree /tmp/wt)",
    workspaceRoot: "/repo"
  });
  assert.match(header, /===RUN-LOG-HEADER===/);
  assert.match(header, /runId: run-abc/);
  assert.match(header, /grokSessionId: 019fae7c-fb03-7321-870e-0778e3119399/);
  assert.match(header, /modelRequested: grok-4\.5/);
  assert.match(header, /modelServed: grok-4\.5-build/);
  assert.match(header, /workspaceRoot: \/repo/);
  assert.match(header, /===END-RUN-LOG-HEADER===/);
});

test("writeRunLogHeader places the block at the top and can refresh it", () => {
  const dir = makeTempDir();
  const logFile = path.join(dir, "run.log");
  fs.writeFileSync(logFile, "[t] Starting title.\n", "utf8");
  writeRunLogHeader(logFile, {
    runId: "r1",
    grokSessionId: "sid-a",
    modelRequested: "m1",
    workspaceRoot: "/w"
  });
  let text = fs.readFileSync(logFile, "utf8");
  assert.match(text, /^\[t\] Starting title\.\n===RUN-LOG-HEADER===/m);
  assert.match(text, /grokSessionId: sid-a/);
  assert.match(text, /modelServed: pending/);

  writeRunLogHeader(logFile, {
    runId: "r1",
    grokSessionId: "sid-a",
    modelRequested: "m1",
    modelServed: "m1-build",
    workspaceRoot: "/w"
  });
  text = fs.readFileSync(logFile, "utf8");
  assert.match(text, /modelServed: m1-build/);
  assert.equal((text.match(/===RUN-LOG-HEADER===/g) || []).length, 1);
});

test("buildSessionTotalsByModel groups cost and modelCalls", () => {
  const totals = buildSessionTotalsByModel([
    {
      resolvedModel: "terra",
      usage: { costUsd: 1.0, modelCalls: 29, totalTokens: 1000 },
      changedFileCount: 10,
      durationMs: 100000
    },
    {
      resolvedModel: "luna",
      usage: { costUsd: 2.65, modelCalls: 134, totalTokens: 2000 },
      changedFileCount: 10,
      durationMs: 200000
    },
    {
      resolvedModel: "terra",
      usage: { costUsd: 0.5, modelCalls: 5, totalTokens: 100 },
      changedFileCount: 1
    }
  ]);
  assert.equal(totals.runCount, 3);
  assert.equal(totals.byResolvedModel.terra.runs, 2);
  assert.equal(totals.byResolvedModel.terra.modelCalls, 34);
  assert.equal(totals.byResolvedModel.terra.costUsd, 1.5);
  assert.equal(totals.byResolvedModel.luna.modelCalls, 134);
});

// --- BRIDGE-3: dual accounting + status ---

test("decideCompletionStatus uses total across both trees (main-only is not noop)", () => {
  // A write that only leaked into the main tree: total=5, isolation breached.
  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "EndTurn",
      write: true,
      changedFileCount: 5,
      toolCallCount: 3,
      isolationBreached: true
    }),
    "isolation-breached"
  );
  // Zero total still noop when not breached.
  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "EndTurn",
      write: true,
      changedFileCount: 0,
      toolCallCount: 3
    }),
    "completed-noop"
  );
});

test("buildTaskStatusLines dual sides never conflate and empty reason is honest", () => {
  const dual = buildTaskStatusLines({
    changedFiles: {
      source: "dual",
      worktree: { entries: [], total: 0, emptyReason: "nothing-written" },
      mainTree: {
        entries: ["A\tsrc/x.ts"],
        total: 1
      }
    }
  }).join("\n");
  assert.match(dual, /Changed files \(worktree\): none \(nothing was written\)/);
  assert.match(dual, /Changed files \(main tree\): 1/);
  assert.match(dual, /src\/x\.ts/);
  assert.doesNotMatch(dual, /only excluded build artifacts/);

  const artifactOnly = buildTaskStatusLines({
    changedFiles: {
      source: "dual",
      worktree: { entries: [], total: 0, emptyReason: "excluded-artifacts" },
      mainTree: { entries: [], total: 0, emptyReason: "nothing-written" }
    }
  }).join("\n");
  assert.match(artifactOnly, /only excluded build artifacts/);
});

// --- BRIDGE-1: implausible duration ---

test("detectImplausiblyShort flags short empty write runs", () => {
  assert.equal(
    detectImplausiblyShort({
      write: true,
      durationMs: 56_000,
      changedFileCount: 0,
      toolCallCount: 0,
      env: {}
    }),
    true
  );
  // Long enough → not flagged.
  assert.equal(
    detectImplausiblyShort({
      write: true,
      durationMs: 120_000,
      changedFileCount: 0,
      toolCallCount: 0,
      env: {}
    }),
    false
  );
  // Changed files → not flagged.
  assert.equal(
    detectImplausiblyShort({
      write: true,
      durationMs: 30_000,
      changedFileCount: 4,
      toolCallCount: 0,
      env: {}
    }),
    false
  );
  // Many tools → not flagged.
  assert.equal(
    detectImplausiblyShort({
      write: true,
      durationMs: 30_000,
      changedFileCount: 0,
      toolCallCount: 12,
      env: {}
    }),
    false
  );
  // Read-only never flagged.
  assert.equal(
    detectImplausiblyShort({
      write: false,
      durationMs: 1_000,
      changedFileCount: 0,
      toolCallCount: 0,
      env: {}
    }),
    false
  );
  // Configurable floor.
  assert.equal(
    detectImplausiblyShort({
      write: true,
      durationMs: 50_000,
      changedFileCount: 0,
      toolCallCount: 0,
      env: { GROK_BUILD_MIN_PLAUSIBLE_WRITE_SECONDS: "30" }
    }),
    false
  );
});

test("buildTaskStatusLines renders implausibly short signal", () => {
  const lines = buildTaskStatusLines({
    write: true,
    implausiblyShort: true,
    durationSeconds: 56,
    toolCallCount: 0,
    changedFiles: { entries: [], total: 0, emptyReason: "nothing-written" }
  }).join("\n");
  assert.match(lines, /Implausibly short:.*56s.*0 tool calls/);
});

// --- HYPER-2: effort ladder ---

test("KNOWN_REASONING_EFFORTS is the full Hyper ladder", () => {
  assert.deepEqual([...KNOWN_REASONING_EFFORTS], [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra"
  ]);
});

test("normalizeReasoningEffort accepts full ladder and warns on unknown pass-through", () => {
  for (const effort of KNOWN_REASONING_EFFORTS) {
    const result = normalizeReasoningEffort(effort);
    assert.equal(result.value, effort);
    assert.equal(result.warning, null);
  }
  const unknown = normalizeReasoningEffort("hyperdrive");
  assert.equal(unknown.value, "hyperdrive");
  assert.match(unknown.warning, /Unknown reasoning effort/);
  assert.match(unknown.warning, /Passing through/);

  const mismatch = normalizeReasoningEffort("max", {
    supportedEfforts: ["low", "medium", "high"]
  });
  assert.equal(mismatch.value, "max");
  assert.match(mismatch.warning, /not in this model's reported support/);
});

// --- BRIDGE-12: debris vs caches ---

test("isGeneratedArtifactPath recognizes build caches", () => {
  assert.equal(isGeneratedArtifactPath(".godot/imported/x"), true);
  assert.equal(isGeneratedArtifactPath("node_modules/pkg/index.js"), true);
  assert.equal(isGeneratedArtifactPath("src/main.ts"), false);
});

test("isDebrisPath catches loose logs and temps, not caches or source", () => {
  assert.equal(isDebrisPath("build_wreck_headless.log"), true);
  assert.equal(isDebrisPath("verify_wreck_gate.log"), true);
  assert.equal(isDebrisPath("scratch.tmp"), true);
  assert.equal(isDebrisPath("core.12345"), true);
  assert.equal(isDebrisPath("src/app.ts"), false);
  assert.equal(isDebrisPath(".godot/global_script_class_cache.cfg"), false);
});

test("partitionWorkAndDebris splits entries and drops caches", () => {
  const { work, debris } = partitionWorkAndDebris([
    "A\tsrc/main.ts",
    "A\tbuild_wreck_headless.log",
    "A\tverify_wreck_gate.log",
    "A\t.node_modules/x" // not a cache path form we match; path is wrong
  ]);
  assert.ok(work.some((e) => e.includes("src/main.ts")));
  assert.equal(debris.length, 2);
  assert.ok(debris.every((e) => e.includes(".log")));
});

test("buildTaskStatusLines reports debris explicitly", () => {
  const lines = buildTaskStatusLines({
    debris: {
      entries: ["A\tbuild_wreck_headless.log", "A\tverify_wreck_gate.log"],
      total: 2
    }
  }).join("\n");
  assert.match(lines, /Debris: 2 files the run left behind and did not commit/);
  assert.match(lines, /build_wreck_headless\.log/);
  assert.match(lines, /verify_wreck_gate\.log/);
});

// --- HYPER-1: question detector + one-retry bound (shape) ---

test("looksLikeUserQuestion detects trailing questions and offers", () => {
  assert.equal(looksLikeUserQuestion("Would you like me to enable feature X?"), true);
  assert.equal(looksLikeUserQuestion("Done.\n\nShall I also add tests?"), true);
  assert.equal(looksLikeUserQuestion("Do you want the optional cache layer?"), true);
  assert.equal(looksLikeUserQuestion("Implemented the fix and verified."), false);
  assert.equal(looksLikeUserQuestion(""), false);
  // Mid-body question mark in a path should not trip if tail is declarative.
  assert.equal(
    looksLikeUserQuestion("Read foo?bar=1 from config.\nAll set."),
    false
  );
});

test("headless prompt template exists and is short ASCII", () => {
  const text = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "headless.md"), "utf8");
  assert.match(text, /non-interactive/i);
  assert.match(text, /never ask a question/i);
  assert.ok(text.length < 600, "headless rules must stay short for argv budget");
  assert.doesNotMatch(text, /[<>&%^]/);
});

test("autoContinued line is rendered once in the status block", () => {
  const lines = buildTaskStatusLines({ autoContinued: true }).join("\n");
  assert.match(lines, /Auto-continued once/);
  assert.equal((lines.match(/Auto-continued once/g) || []).length, 1);
});
