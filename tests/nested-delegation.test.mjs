import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  aggregateUsageOwnVsNested,
  applyChildrenToCompletionStatus,
  assertNestConcurrencyAllowed,
  assertNestDepthAllowed,
  buildChildSummary,
  buildMcpJsonConfig,
  childIsLandable,
  deriveSiblingWorktreePath,
  formatNestedDelegationHeaderLine,
  inheritBudget,
  nestedDelegationEnabled,
  parentSpentCostUsd,
  remainingCostBudget,
  remainingDurationSeconds,
  remainingNestDepth,
  upsertChildEntry,
  writeRuntimeMcpJson,
  DEFAULT_MAX_NEST_CONCURRENCY,
  DEFAULT_MAX_NEST_DEPTH,
  NEST_MCP_SERVER_NAME,
  NESTED_DELEGATION_ENV
} from "../plugins/turbo-build-plugin/scripts/lib/nest.mjs";
import {
  collectJobTreeLeafFirst,
  resolveJobKillTargets,
  resolveJobTreeKillTargets,
  claimJobTreeDescendantsCancelled
} from "../plugins/turbo-build-plugin/scripts/lib/tracked-jobs.mjs";
import {
  generateJobId,
  isTerminalJobStatus,
  upsertJob,
  writeJobFile
} from "../plugins/turbo-build-plugin/scripts/lib/state.mjs";
import {
  artifactExcludePathspecs,
  createWorktree,
  shortWorktreeId
} from "../plugins/turbo-build-plugin/scripts/lib/worktree.mjs";
import { buildTaskStatusLines } from "../plugins/turbo-build-plugin/scripts/lib/render.mjs";
import {
  buildDelegateRunBridgeArgs,
  handleJsonRpcMessage,
  parseJsonRpcLine,
  shapeDelegateResult
} from "../plugins/turbo-build-plugin/mcp/grok-build-mcp.mjs";
import { normalizeReasoningEffort } from "../plugins/turbo-build-plugin/scripts/grok-bridge.mjs";
import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "turbo-build-plugin");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs");

/* -------------------------------------------------------------------------
 * Depth / fan-out bounds
 * ---------------------------------------------------------------------- */

test("assertNestDepthAllowed refuses when incoming depth is already at max", () => {
  assert.throws(
    () => assertNestDepthAllowed(2, 2),
    /nest depth 2 is already at the maximum/
  );
  assert.throws(
    () => assertNestDepthAllowed(3, 2),
    /GROK_BUILD_MAX_NEST_DEPTH/
  );
  const ok = assertNestDepthAllowed(0, 2);
  assert.equal(ok.childDepth, 1);
  assert.equal(ok.depth, 0);
});

test("remainingNestDepth is max minus current", () => {
  assert.equal(remainingNestDepth(0, 2), 2);
  assert.equal(remainingNestDepth(1, 2), 1);
  assert.equal(remainingNestDepth(2, 2), 0);
  assert.equal(remainingNestDepth(5, 2), 0);
});

test("assertNestConcurrencyAllowed refuses when live children hit the limit", () => {
  const children = [
    { runId: "run-a", status: "running" },
    { runId: "run-b", status: "queued" }
  ];
  assert.throws(
    () => assertNestConcurrencyAllowed(children, 2),
    /already 2 live child/
  );
  assert.match(
    (() => {
      try {
        assertNestConcurrencyAllowed(children, 2);
      } catch (error) {
        return error.message;
      }
      return "";
    })(),
    /run-a/
  );
  // Terminal children free a slot.
  const withDone = [
    { runId: "run-a", status: "completed" },
    { runId: "run-b", status: "running" }
  ];
  const ok = assertNestConcurrencyAllowed(withDone, 2);
  assert.equal(ok.liveCount, 1);
  assert.equal(ok.maxConcurrency, DEFAULT_MAX_NEST_CONCURRENCY);
});

/* -------------------------------------------------------------------------
 * Sibling worktree path derivation
 * ---------------------------------------------------------------------- */

test("deriveSiblingWorktreePath places the child next to the parent, never inside it", () => {
  const parent = path.join("C:", "Users", "tmp", "gb", "w", "aabbccdd");
  const childId = "run-child-xyz";
  const sibling = deriveSiblingWorktreePath(parent, childId);
  assert.equal(path.dirname(sibling), path.dirname(parent));
  assert.equal(path.basename(sibling), shortWorktreeId(childId));
  assert.notEqual(sibling, parent);
  // Must not be nested under the parent directory.
  const rel = path.relative(parent, sibling);
  assert.ok(rel.startsWith("..") || path.isAbsolute(rel), `expected sibling outside parent, got rel=${rel}`);
});

test("deriveSiblingWorktreePath requires both arguments", () => {
  assert.throws(() => deriveSiblingWorktreePath("", "id"), /parentWorktreePath/);
  assert.throws(() => deriveSiblingWorktreePath("/tmp/p", ""), /childRunId/);
});

/* -------------------------------------------------------------------------
 * Budget inheritance arithmetic
 * ---------------------------------------------------------------------- */

test("inheritBudget clamps child requests to parent ceilings and remaining cost", () => {
  const result = inheritBudget({
    parentMaxCostUsd: 1.0,
    parentSpentCostUsd: 0.4,
    parentMaxDurationSeconds: 600,
    parentMaxTurns: 20,
    childMaxCostUsd: 0.9,
    childMaxDurationSeconds: 900,
    childMaxTurns: 50
  });
  // Remaining cost is 0.6; child asked for 0.9 → 0.6
  assert.equal(result.maxCostUsd, 0.6);
  assert.equal(result.maxDurationSeconds, 600);
  assert.equal(result.maxTurns, 20);
  assert.equal(result.parentRemainingCostUsd, 0.6);
});

test("inheritBudget allows child to ask for less than the parent ceiling", () => {
  const result = inheritBudget({
    parentMaxCostUsd: 2,
    parentSpentCostUsd: 0,
    parentMaxDurationSeconds: 1000,
    parentMaxTurns: 40,
    childMaxCostUsd: 0.25,
    childMaxDurationSeconds: 100,
    childMaxTurns: 5
  });
  assert.equal(result.maxCostUsd, 0.25);
  assert.equal(result.maxDurationSeconds, 100);
  assert.equal(result.maxTurns, 5);
});

test("remainingCostBudget collapses spent-out parents to zero", () => {
  assert.equal(remainingCostBudget(1, 1.5), 0);
  assert.equal(remainingCostBudget(null, 5), null);
  assert.equal(remainingCostBudget(2, 0.5), 1.5);
});

test("parentSpentCostUsd sums own + children without double-counting", () => {
  const parent = {
    usage: { costUsd: 0.3, inputTokens: 100, outputTokens: 50 },
    children: [
      { runId: "c1", usage: { costUsd: 0.2, inputTokens: 40, outputTokens: 10 } },
      { runId: "c2", usage: { costUsd: 0.1, inputTokens: 20, outputTokens: 5 } }
    ]
  };
  assert.ok(Math.abs(parentSpentCostUsd(parent) - 0.6) < 1e-9);
});

/* -------------------------------------------------------------------------
 * Usage aggregation (own vs including nested)
 * ---------------------------------------------------------------------- */

test("aggregateUsageOwnVsNested keeps own separate from includingNested", () => {
  const own = { inputTokens: 100, outputTokens: 20, costUsd: 0.5, numTurns: 3 };
  const children = [
    { usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.2, numTurns: 1 } },
    { usage: { inputTokens: 25, outputTokens: 5, costUsd: 0.1, numTurns: 1 } }
  ];
  const agg = aggregateUsageOwnVsNested(own, children);
  assert.equal(agg.own.inputTokens, 100);
  assert.equal(agg.own.costUsd, 0.5);
  assert.equal(agg.nested.inputTokens, 75);
  assert.ok(Math.abs(agg.nested.costUsd - 0.3) < 1e-9);
  assert.equal(agg.includingNested.inputTokens, 175);
  assert.ok(Math.abs(agg.includingNested.costUsd - 0.8) < 1e-9);
  // own is not mutated into the sum
  assert.equal(own.inputTokens, 100);
});

/* -------------------------------------------------------------------------
 * Parent/child record linkage
 * ---------------------------------------------------------------------- */

test("upsertChildEntry and buildChildSummary link by runId", () => {
  const entry = buildChildSummary({
    id: "run-child-1",
    status: "completed",
    changedFileCount: 3,
    usage: { costUsd: 0.1, inputTokens: 10, outputTokens: 2 },
    worktree: { path: "/tmp/w", branch: "turbo-build/run-child-1" }
  });
  assert.equal(entry.runId, "run-child-1");
  assert.equal(entry.branch, "turbo-build/run-child-1");

  let children = upsertChildEntry([], entry);
  assert.equal(children.length, 1);
  children = upsertChildEntry(children, {
    runId: "run-child-1",
    status: "failed",
    changedFileCount: 0
  });
  assert.equal(children.length, 1);
  assert.equal(children[0].status, "failed");
  children = upsertChildEntry(children, { runId: "run-child-2", status: "running" });
  assert.equal(children.length, 2);
});

test("childIsLandable accepts completed-family only", () => {
  assert.equal(childIsLandable("completed"), true);
  assert.equal(childIsLandable("completed-unverified"), true);
  assert.equal(childIsLandable("failed"), false);
  assert.equal(childIsLandable("cancelled"), false);
  assert.equal(childIsLandable("running"), false);
});

/* -------------------------------------------------------------------------
 * .mcp.json emission and exclusion from commit
 * ---------------------------------------------------------------------- */

test("writeRuntimeMcpJson emits .mcp.json under the runtime plugin directory", () => {
  const dir = makeTempDir("nest-mcp-");
  const worktree = path.join(dir, "wt");
  fs.mkdirSync(worktree, { recursive: true });
  const result = writeRuntimeMcpJson(worktree, {
    mcpScriptPath: path.join(PLUGIN_ROOT, "mcp", "grok-build-mcp.mjs"),
    bridgePath: path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs"),
    workspaceRoot: dir,
    parentRunId: "run-parent-1",
    nestDepth: 0,
    parentBaseSha: "abc123",
    parentWorktree: worktree,
    parentMaxCostUsd: 1.5,
    parentMaxDurationSeconds: 300,
    parentMaxTurns: 10
  });
  assert.equal(result.written, true);
  assert.ok(result.path);
  assert.ok(fs.existsSync(result.path));
  const config = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.ok(config.mcpServers[NEST_MCP_SERVER_NAME]);
  const server = config.mcpServers[NEST_MCP_SERVER_NAME];
  assert.equal(server.command, process.execPath);
  assert.ok(server.args[0].endsWith("grok-build-mcp.mjs") || server.args[0].includes("grok-build-mcp"));
  assert.equal(server.env.GROK_BUILD_PARENT_RUN_ID, "run-parent-1");
  assert.equal(server.env.GROK_BUILD_NEST_DEPTH, "0");
  assert.equal(server.env.GROK_BUILD_WORKSPACE_ROOT, path.resolve(dir));
});

test("writeRuntimeMcpJson is a no-op when nested delegation is disabled", () => {
  const dir = makeTempDir("nest-mcp-off-");
  const worktree = path.join(dir, "wt");
  fs.mkdirSync(worktree, { recursive: true });
  const result = writeRuntimeMcpJson(worktree, {
    env: { [NESTED_DELEGATION_ENV]: "0" },
    mcpScriptPath: path.join(PLUGIN_ROOT, "mcp", "grok-build-mcp.mjs"),
    bridgePath: path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs"),
    workspaceRoot: dir,
    parentRunId: "run-parent-1",
    nestDepth: 0
  });
  assert.equal(result.written, false);
  assert.equal(
    fs.existsSync(path.join(worktree, ".grok", "plugins", "turbo-build-runtime", ".mcp.json")),
    false
  );
});

test(".grok/ is in artifact exclude pathspecs so .mcp.json is never committed", () => {
  const specs = artifactExcludePathspecs();
  assert.ok(
    specs.some((s) => s.includes(".grok")),
    `expected .grok exclude, got ${specs.join(", ")}`
  );
});

test("buildMcpJsonConfig requires required fields", () => {
  assert.throws(() => buildMcpJsonConfig({}), /requires/);
});

test("nestedDelegationEnabled defaults on", () => {
  assert.equal(nestedDelegationEnabled({}), true);
  assert.equal(nestedDelegationEnabled({ [NESTED_DELEGATION_ENV]: "0" }), false);
  assert.equal(nestedDelegationEnabled({ [NESTED_DELEGATION_ENV]: "false" }), false);
  assert.equal(nestedDelegationEnabled({ [NESTED_DELEGATION_ENV]: "1" }), true);
});

test("formatNestedDelegationHeaderLine reports remaining depth", () => {
  const on = formatNestedDelegationHeaderLine({
    offered: true,
    nestDepth: 0,
    maxNestDepth: DEFAULT_MAX_NEST_DEPTH,
    maxConcurrency: DEFAULT_MAX_NEST_CONCURRENCY
  });
  assert.match(on, /Nested delegation: on/);
  assert.match(on, /depth 0\/2/);
  assert.match(on, /2 child levels remaining/);
  const off = formatNestedDelegationHeaderLine({ offered: false });
  assert.match(off, /off/);
});

/* -------------------------------------------------------------------------
 * MCP JSON-RPC framing and tool contracts
 * ---------------------------------------------------------------------- */

test("MCP parseJsonRpcLine and initialize handshake", () => {
  const msg = parseJsonRpcLine(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  );
  const { response } = handleJsonRpcMessage(msg);
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.equal(response.result.serverInfo.name, "grok-build-delegate");
  assert.ok(response.result.capabilities.tools);
});

test("MCP tools/list exposes all six delegate_* tools", () => {
  const { response } = handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list"
  });
  const names = response.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "delegate_land",
    "delegate_result",
    "delegate_run",
    "delegate_status",
    "delegate_stop",
    "delegate_wait"
  ]);
  for (const tool of response.result.tools) {
    assert.ok(tool.inputSchema, `${tool.name} needs inputSchema`);
    assert.ok(tool.description, `${tool.name} needs description`);
  }
});

test("MCP notifications produce no response", () => {
  const { response } = handleJsonRpcMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized"
  });
  assert.equal(response, null);
});

test("MCP tools/call unknown tool returns JSON-RPC error", () => {
  const { response } = handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "not_a_tool", arguments: {} }
  });
  assert.equal(response.error.code, -32601);
});

test("MCP delegate_run without prompt returns tool error payload", () => {
  const { response } = handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "delegate_run", arguments: { prompt: "" } }
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /prompt/i);
});

test("shapeDelegateResult normalises show/wait payloads", () => {
  const shaped = shapeDelegateResult(
    {
      id: "run-x",
      status: "completed",
      stopReason: "EndTurn",
      verified: true,
      usage: { costUsd: 0.05, inputTokens: 1, outputTokens: 2 },
      worktree: { path: "/wt", branch: "turbo-build/run-x", changedFileCount: 2 },
      result: {
        finalReport: "## Result\nDone.",
        changedFiles: { total: 2, entries: ["M\tfoo.js"] }
      }
    },
    "run-x"
  );
  assert.equal(shaped.runId, "run-x");
  assert.equal(shaped.status, "completed");
  assert.equal(shaped.verified, true);
  assert.equal(shaped.branch, "turbo-build/run-x");
  assert.equal(shaped.cost, 0.05);
  assert.match(shaped.finalReport, /Done/);
});

test("shapeDelegateResult reads finalReport from production {job, storedJob} shape", () => {
  // Literal payload shape handleResult / wait emit: job is an index row
  // without result; storedJob carries result.finalReport and changedFiles.
  const productionPayload = {
    job: {
      id: "run-child-prod",
      status: "completed",
      stopReason: "EndTurn",
      verified: true,
      changedFileCount: 4,
      usage: { costUsd: 0.12, inputTokens: 10, outputTokens: 4 },
      worktree: {
        path: "/tmp/wt-child",
        branch: "turbo-build/run-child-prod",
        changedFileCount: 4
      },
      logFile: "/tmp/logs/run-child-prod.log"
      // deliberately no result
    },
    storedJob: {
      id: "run-child-prod",
      status: "completed",
      stopReason: "EndTurn",
      verified: true,
      changedFileCount: 4,
      usage: { costUsd: 0.12, inputTokens: 10, outputTokens: 4 },
      worktree: {
        path: "/tmp/wt-child",
        branch: "turbo-build/run-child-prod",
        changedFileCount: 4
      },
      logFile: "/tmp/logs/run-child-prod.log",
      rendered: "## Result\nRendered fallback only.",
      result: {
        finalReport: "## Result\nChild decided to port the inventory API.",
        changedFiles: {
          total: 4,
          entries: ["M\tsrc/a.js", "M\tsrc/b.js", "A\tsrc/c.js", "M\tsrc/d.js"]
        },
        usage: { costUsd: 0.12, inputTokens: 10, outputTokens: 4 },
        verified: true,
        stopReason: "EndTurn"
      }
    }
  };
  const shaped = shapeDelegateResult(productionPayload, "run-child-prod");
  assert.equal(shaped.runId, "run-child-prod");
  assert.equal(shaped.status, "completed");
  assert.equal(shaped.verified, true);
  assert.equal(shaped.changedFileCount, 4);
  assert.ok(shaped.changedFiles);
  assert.equal(shaped.changedFiles.total, 4);
  assert.match(shaped.finalReport, /port the inventory API/);
  assert.equal(shaped.cost, 0.12);
  assert.equal(shaped.branch, "turbo-build/run-child-prod");
});

test("shapeDelegateResult falls back to storedJob.rendered when result has no report", () => {
  const shaped = shapeDelegateResult(
    {
      job: { id: "run-y", status: "completed" },
      storedJob: {
        id: "run-y",
        status: "completed",
        rendered: "## Result\nOnly rendered text.",
        result: { changedFiles: { total: 1, entries: ["M\tz.js"] } }
      }
    },
    "run-y"
  );
  assert.match(shaped.finalReport, /Only rendered text/);
  assert.equal(shaped.changedFiles.total, 1);
});

test("delegate_run bridge args never include --verify even if args sneak verify keys", () => {
  const args = buildDelegateRunBridgeArgs(
    {
      prompt: "noop",
      write: true,
      verify: ["powershell -c whoami"],
      no_verify: true,
      max_cost: 0.5
    },
    "prompt.txt"
  );
  assert.equal(args.includes("--verify"), false);
  assert.equal(args.includes("--no-verify"), false);
  assert.ok(args.includes("--max-cost"));
  assert.ok(args.includes("nest-run"));
});

test("MCP tools/list does not advertise verify on delegate_run", () => {
  const { response } = handleJsonRpcMessage({
    jsonrpc: "2.0",
    id: 99,
    method: "tools/list"
  });
  const runTool = response.result.tools.find((t) => t.name === "delegate_run");
  assert.ok(runTool);
  assert.equal(runTool.inputSchema.properties.verify, undefined);
  assert.equal(runTool.inputSchema.properties.no_verify, undefined);
});

/* -------------------------------------------------------------------------
 * Budget reservation / remaining wall-clock
 * ---------------------------------------------------------------------- */

test("parentSpentCostUsd counts reserved grants on live children", () => {
  const parent = {
    usage: { costUsd: 0.5 },
    children: [
      { runId: "c1", status: "running", reservedCostUsd: 1.0, usage: null },
      { runId: "c2", status: "queued", reservedCostUsd: 0.75, usage: null }
    ]
  };
  // 0.5 own + 1.0 + 0.75 reserved = 2.25
  assert.ok(Math.abs(parentSpentCostUsd(parent) - 2.25) < 1e-9);
});

test("two concurrent children share one cost ceiling via reservation", () => {
  const parentCap = 5;
  // First child registers with full remaining.
  let parent = {
    usage: { costUsd: 0 },
    children: []
  };
  const firstGrant = inheritBudget({
    parentMaxCostUsd: parentCap,
    parentSpentCostUsd: parentSpentCostUsd(parent),
    childMaxCostUsd: 5
  }).maxCostUsd;
  assert.equal(firstGrant, 5);
  parent = {
    ...parent,
    children: upsertChildEntry(parent.children, {
      runId: "c1",
      status: "running",
      reservedCostUsd: firstGrant
    })
  };
  const secondGrant = inheritBudget({
    parentMaxCostUsd: parentCap,
    parentSpentCostUsd: parentSpentCostUsd(parent),
    childMaxCostUsd: 5
  }).maxCostUsd;
  // Second child must see spent=5 and get 0 remaining — not another full 5.
  assert.equal(secondGrant, 0);
});

test("inheritBudget uses remaining wall-clock when provided", () => {
  const result = inheritBudget({
    parentMaxDurationSeconds: 600,
    parentRemainingDurationSeconds: 45,
    childMaxDurationSeconds: 300
  });
  assert.equal(result.maxDurationSeconds, 45);
});

test("remainingDurationSeconds subtracts elapsed from parent start", () => {
  const start = new Date(Date.now() - 90_000).toISOString();
  const remaining = remainingDurationSeconds(120, start, Date.now());
  assert.ok(remaining <= 35 && remaining >= 25, `expected ~30s left, got ${remaining}`);
});

test("applyChildrenToCompletionStatus demotes completed when a child failed", () => {
  assert.equal(
    applyChildrenToCompletionStatus("completed", [{ runId: "c", status: "failed" }]),
    "completed-with-failed-children"
  );
  assert.equal(
    applyChildrenToCompletionStatus("completed", [{ runId: "c", status: "completed" }]),
    "completed"
  );
  assert.equal(
    applyChildrenToCompletionStatus("failed", [{ runId: "c", status: "failed" }]),
    "failed"
  );
  assert.equal(isTerminalJobStatus("completed-with-failed-children"), true);
});

test("buildChildSummary carries structured fan-in fields including finalReport", () => {
  const summary = buildChildSummary({
    id: "run-c",
    status: "completed",
    verified: true,
    usage: { costUsd: 0.2 },
    result: {
      finalReport: "## Result\nNested work done.",
      changedFiles: { total: 2, entries: ["M\ta.js"] }
    },
    worktree: { path: "/wt", branch: "turbo-build/run-c" },
    reservedCostUsd: 0.5
  });
  assert.equal(summary.runId, "run-c");
  assert.equal(summary.verified, true);
  assert.equal(summary.cost, 0.2);
  assert.equal(summary.reservedCostUsd, 0.5);
  assert.match(summary.finalReport, /Nested work done/);
  assert.equal(summary.changedFiles.total, 2);
});

test("normalizeReasoningEffort value is a string or null, never a wrapper object", () => {
  const a = normalizeReasoningEffort(null);
  assert.equal(a.value, null);
  assert.equal(typeof a, "object");
  const b = normalizeReasoningEffort("high");
  assert.equal(b.value, "high");
  // The bug was `const effort = normalizeReasoningEffort(...) ?? settings` — always object.
  assert.notEqual(typeof b, "string");
  assert.equal(typeof b.value, "string");
});

test("resolveJobTreeKillTargets walks children leaf-first", () => {
  const dir = makeTempDir("nest-kill-tree-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    const parentId = generateJobId("run");
    const childId = generateJobId("run");
    const grandId = generateJobId("run");
    writeJobFile(dir, grandId, {
      id: grandId,
      status: "running",
      agentPid: 3001,
      bridgePid: 3002,
      children: []
    });
    writeJobFile(dir, childId, {
      id: childId,
      status: "running",
      agentPid: 2001,
      bridgePid: 2002,
      children: [{ runId: grandId, status: "running" }]
    });
    writeJobFile(dir, parentId, {
      id: parentId,
      status: "running",
      agentPid: 1001,
      bridgePid: 1002,
      children: [{ runId: childId, status: "running" }]
    });
    upsertJob(dir, { id: parentId, status: "running" });
    upsertJob(dir, { id: childId, status: "running" });
    upsertJob(dir, { id: grandId, status: "running" });

    const parent = {
      id: parentId,
      status: "running",
      agentPid: 1001,
      bridgePid: 1002,
      children: [{ runId: childId, status: "running" }]
    };
    const tree = collectJobTreeLeafFirst(dir, parent);
    assert.equal(tree[0].id, grandId);
    assert.equal(tree[tree.length - 1].id, parentId);
    const { pids } = resolveJobTreeKillTargets(dir, parent);
    assert.ok(pids.includes(3001));
    assert.ok(pids.includes(2001));
    assert.ok(pids.includes(1001));
    // Own-only targets omit the descendants.
    const own = resolveJobKillTargets(parent);
    assert.equal(own.includes(3001), false);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("claimJobTreeDescendantsCancelled snapshots PIDs before claim nulls them (C21)", () => {
  const dir = makeTempDir("nest-cancel-snapshot-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    const parentId = generateJobId("run");
    const childId = generateJobId("run");
    const grandId = generateJobId("run");
    writeJobFile(dir, grandId, {
      id: grandId,
      status: "running",
      parentRunId: childId,
      agentPid: 3001,
      bridgePid: 3002,
      children: []
    });
    writeJobFile(dir, childId, {
      id: childId,
      status: "running",
      parentRunId: parentId,
      agentPid: 2001,
      bridgePid: 2002,
      children: [{ runId: grandId, status: "running" }]
    });
    writeJobFile(dir, parentId, {
      id: parentId,
      status: "running",
      agentPid: 1001,
      bridgePid: 1002,
      children: [{ runId: childId, status: "running" }]
    });
    upsertJob(dir, { id: parentId, status: "running" });
    upsertJob(dir, { id: childId, status: "running" });
    upsertJob(dir, { id: grandId, status: "running" });

    const parent = {
      id: parentId,
      status: "running",
      agentPid: 1001,
      bridgePid: 1002,
      children: [{ runId: childId, status: "running" }]
    };

    const result = claimJobTreeDescendantsCancelled(dir, parent, {
      childErrorMessage: "Stopped because parent run was cancelled."
    });

    // Pre-claim snapshot must still include descendant agent/bridge PIDs.
    for (const pid of [1001, 1002, 2001, 2002, 3001, 3002]) {
      assert.ok(result.pids.includes(pid), `missing kill target ${pid}`);
    }

    // Descendants are cancelled; stored pid fields are nulled (as stop does).
    const childClaims = result.childClaims.filter((entry) => !entry.alreadyTerminal);
    assert.ok(childClaims.some((entry) => entry.jobId === childId && entry.claimed));
    assert.ok(childClaims.some((entry) => entry.jobId === grandId && entry.claimed));
    assert.equal(isTerminalJobStatus("cancelled"), true);

    // Re-resolving after claim must NOT be used for kill — descendants are empty.
    const after = resolveJobTreeKillTargets(dir, parent);
    assert.equal(after.pids.includes(2001), false);
    assert.equal(after.pids.includes(3001), false);
    // Parent was not claimed by this helper; its pids remain on disk.
    assert.ok(after.pids.includes(1001));
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("land --into-run on merge conflict does not wipe parent worktree dirt", () => {
  const repo = makeTempDir("nest-land-into-");
  const binDir = makeTempDir("nest-land-bin-");
  const pluginDataDir = makeTempDir("nest-land-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "parent-only.txt"), "parent seed\n");
  run("git", ["add", "shared.txt", "parent-only.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const parentId = generateJobId("run");
    const childId = generateJobId("run");
    const parentWt = createWorktree({
      cwd: repo,
      runId: parentId,
      dataDir: pluginDataDir
    });
    const childWt = createWorktree({
      cwd: repo,
      runId: childId,
      dataDir: pluginDataDir
    });

    // Parent agent mid-run dirt (uncommitted).
    fs.writeFileSync(path.join(parentWt.worktreePath, "parent-wip.txt"), "parent uncommitted work\n");
    fs.writeFileSync(path.join(parentWt.worktreePath, "shared.txt"), "parent edit of shared\n");

    // Child committed conflicting change to shared.txt on its branch.
    fs.writeFileSync(path.join(childWt.worktreePath, "shared.txt"), "child edit of shared\n");
    run("git", ["add", "shared.txt"], { cwd: childWt.worktreePath });
    run("git", ["commit", "-m", "child change"], { cwd: childWt.worktreePath });

    writeJobFile(repo, parentId, {
      id: parentId,
      status: "running",
      kind: "task",
      worktree: {
        path: parentWt.worktreePath,
        branch: parentWt.branchName,
        baseSha: parentWt.baseSha
      },
      children: [{ runId: childId, status: "completed", branch: childWt.branchName }]
    });
    upsertJob(repo, {
      id: parentId,
      status: "running",
      worktree: {
        path: parentWt.worktreePath,
        branch: parentWt.branchName,
        baseSha: parentWt.baseSha
      }
    });
    writeJobFile(repo, childId, {
      id: childId,
      status: "completed",
      kind: "task",
      parentRunId: parentId,
      worktree: {
        path: childWt.worktreePath,
        branch: childWt.branchName,
        baseSha: childWt.baseSha
      }
    });
    upsertJob(repo, {
      id: childId,
      status: "completed",
      worktree: {
        path: childWt.worktreePath,
        branch: childWt.branchName,
        baseSha: childWt.baseSha
      }
    });

    const env = buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir });
    const result = run("node", [SCRIPT, "land", childId, "--into-run", parentId, "--json"], {
      cwd: repo,
      env
    });

    assert.notEqual(result.status, 0, result.stdout);
    const combined = `${result.stderr}\n${result.stdout}`;
    // Must refuse overlap or report merge failure — never claim hard-reset clean.
    assert.doesNotMatch(combined, /left clean at HEAD/i);
    assert.doesNotMatch(combined, /reset --hard/i);

    // Parent uncommitted work must survive.
    assert.equal(
      fs.readFileSync(path.join(parentWt.worktreePath, "parent-wip.txt"), "utf8"),
      "parent uncommitted work\n"
    );
    assert.equal(
      fs.readFileSync(path.join(parentWt.worktreePath, "shared.txt"), "utf8"),
      "parent edit of shared\n"
    );
    // Child worktree retained for inspection.
    assert.equal(fs.existsSync(childWt.worktreePath), true);

    // Structured failure when --json.
    if (result.stdout.trim()) {
      try {
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.landed, false);
        assert.ok(payload.reason);
      } catch {
        // stderr-only error path is also acceptable
      }
    }
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

/* -------------------------------------------------------------------------
 * Parent report: Nested runs section + usage split
 * ---------------------------------------------------------------------- */

test("buildTaskStatusLines includes Nested runs section and own vs nested usage", () => {
  const lines = buildTaskStatusLines({
    jobId: "run-parent",
    usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
    usageBreakdown: {
      own: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
      nested: { inputTokens: 50, outputTokens: 10, costUsd: 0.2 },
      includingNested: { inputTokens: 150, outputTokens: 30, costUsd: 0.7 }
    },
    children: [
      {
        runId: "run-child",
        status: "failed",
        changedFileCount: 0,
        usage: { costUsd: 0.2, inputTokens: 50, outputTokens: 10 },
        branch: "turbo-build/run-child"
      }
    ]
  });
  const text = lines.join("\n");
  assert.match(text, /## Nested runs/);
  assert.match(text, /run-child: failed/);
  assert.match(text, /did not fully succeed/);
  assert.match(text, /Usage \(own\)/);
  assert.match(text, /Usage \(including nested\)/);
  assert.match(text, /into-run run-parent/);
});

test("skill and MCP server files exist where Hyper discovery expects them", () => {
  assert.ok(
    fs.existsSync(path.join(PLUGIN_ROOT, "mcp", "grok-build-mcp.mjs")),
    "mcp server missing"
  );
  assert.ok(
    fs.existsSync(
      path.join(PLUGIN_ROOT, "runtime-plugin", "skills", "nested-delegation", "SKILL.md")
    ),
    "nested-delegation skill missing"
  );
});

