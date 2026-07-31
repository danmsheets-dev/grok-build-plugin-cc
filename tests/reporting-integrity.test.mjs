import fs from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertModelBillingAllowed,
  buildHeadlessArgs,
  buildHeadlessPermissionOptions,
  inferModelBillingRoute,
  parseModelsOutput,
  READ_ONLY_DENY_RULES
} from "../plugins/grok-build/scripts/lib/grok.mjs";
import {
  buildBridgeResultBlock,
  buildTaskStatusLines,
  formatUsageLine
} from "../plugins/grok-build/scripts/lib/render.mjs";
import { claimJobTerminal, isTerminalJobStatus, listJobs, upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";
import { decideCompletionStatus } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import {
  commitWorktreeChanges,
  listCommittedChanges
} from "../plugins/grok-build/scripts/lib/worktree.mjs";
import { makeTempDir } from "./helpers.mjs";

function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

// --- 1. Honest terminal status decision table ---

test("decideCompletionStatus: timedOut wins", () => {
  assert.equal(
    decideCompletionStatus({ timedOut: true, exitStatus: 0, stopReason: "EndTurn" }),
    "timed-out"
  );
});

test("decideCompletionStatus: non-zero exit is failed", () => {
  assert.equal(decideCompletionStatus({ exitStatus: 1, stopReason: "EndTurn" }), "failed");
  assert.equal(decideCompletionStatus({ exitStatus: null }), "failed");
});

test("decideCompletionStatus: non-clean stopReason is completed-truncated", () => {
  assert.equal(
    decideCompletionStatus({ exitStatus: 0, stopReason: "Cancelled" }),
    "completed-truncated"
  );
  assert.equal(
    decideCompletionStatus({ exitStatus: 0, stopReason: "MaxTurns" }),
    "completed-truncated"
  );
});

test("decideCompletionStatus: write with zero files is completed-noop", () => {
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

test("decideCompletionStatus: genuine zero tool calls is completed-blind", () => {
  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "EndTurn",
      write: false,
      toolCallCount: 0,
      hadWork: true
    }),
    "completed-blind"
  );
});

test("decideCompletionStatus: null toolCallCount is never completed-blind", () => {
  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "EndTurn",
      write: false,
      toolCallCount: null,
      verified: true
    }),
    "completed"
  );
});

test("decideCompletionStatus: verified false is completed-unverified", () => {
  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "EndTurn",
      toolCallCount: 2,
      verified: false
    }),
    "completed-unverified"
  );
});

test("decideCompletionStatus: clean success is completed", () => {
  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "EndTurn",
      toolCallCount: 2,
      verified: true
    }),
    "completed"
  );
  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "StopSequence",
      toolCallCount: 1
    }),
    "completed"
  );
});

test("new terminal statuses are registered with isTerminalJobStatus", () => {
  for (const status of [
    "completed",
    "failed",
    "cancelled",
    "completed-unverified",
    "completed-truncated",
    "completed-noop",
    "completed-blind",
    "timed-out"
  ]) {
    assert.equal(isTerminalJobStatus(status), true, status);
  }
  assert.equal(isTerminalJobStatus("running"), false);
});

// --- 3. deny/allow argv + read-only shape ---

test("buildHeadlessArgs emits repeated --deny and --allow rules", () => {
  const args = buildHeadlessArgs("hi", {
    denyRules: ["Edit(**)", "Write(**)"],
    allowRules: ["Read(**)"],
    alwaysApprove: true
  });
  assert.ok(args.includes("--always-approve"));
  const denyIndexes = args
    .map((value, index) => (value === "--deny" ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(denyIndexes.length, 2);
  assert.equal(args[denyIndexes[0] + 1], "Edit(**)");
  assert.equal(args[denyIndexes[1] + 1], "Write(**)");
  assert.equal(args[args.indexOf("--allow") + 1], "Read(**)");
});

test("read-only permission options keep plan/sandbox and add the deny rules", () => {
  const readOnly = buildHeadlessPermissionOptions(false);
  // plan + read-only carry the intent and are kernel-enforced on unix; the deny
  // rules are the half that is enforced on Windows too, where the sandbox crate
  // is compiled out. Never approve tools on a read-only run.
  assert.equal(readOnly.permissionMode, "plan");
  assert.equal(readOnly.sandbox, "read-only");
  assert.equal(readOnly.alwaysApprove, undefined);
  assert.deepEqual(readOnly.denyRules, [...READ_ONLY_DENY_RULES]);

  const write = buildHeadlessPermissionOptions(true);
  assert.equal(write.alwaysApprove, true);
  assert.equal(write.denyRules, undefined);

  const args = buildHeadlessArgs("probe", { ...readOnly, platform: "linux" });
  assert.ok(!args.includes("--always-approve"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  for (const rule of READ_ONLY_DENY_RULES) {
    assert.ok(args.includes(rule), `missing deny rule ${rule}`);
  }
});

// --- 4. Index usage mirroring ---

test("claimJobTerminal mirrors usage/stopReason/counts into the index", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-usage-mirror";
    const running = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Mirror",
      bridgePid: 11
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const usage = {
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.01,
      numTurns: 1,
      resolvedModel: "grok-4.5-build"
    };
    const claim = claimJobTerminal(workspace, jobId, "completed-truncated", {
      usage,
      resolvedModel: "grok-4.5-build",
      stopReason: "Cancelled",
      toolCallCount: 0,
      changedFileCount: 0,
      write: false,
      verified: null,
      model: "grok-4.5",
      grokVersion: "0.2.114-r5",
      worktree: null
    });
    assert.equal(claim.claimed, true);

    const indexed = listJobs(workspace).find((job) => job.id === jobId);
    assert.ok(indexed);
    assert.deepEqual(indexed.usage, usage);
    assert.equal(indexed.resolvedModel, "grok-4.5-build");
    assert.equal(indexed.stopReason, "Cancelled");
    assert.equal(indexed.toolCallCount, 0);
    assert.equal(indexed.changedFileCount, 0);
    assert.equal(indexed.model, "grok-4.5");
    assert.equal(indexed.grokVersion, "0.2.114-r5");
  });
});

// --- render: Verified n/a + usage line model ---

test("completed-noop/blind/truncated never render Verified: yes", () => {
  assert.match(
    buildTaskStatusLines({ status: "completed-noop", verified: true }).join("\n"),
    /Verified: n\/a - the run changed no files/
  );
  assert.match(
    buildTaskStatusLines({
      status: "completed-blind",
      verified: true,
      toolCallCount: 0,
      toolVisibility: "explicit"
    }).join("\n"),
    /Verified: n\/a - the stream reported zero tool calls/
  );
  assert.match(
    buildTaskStatusLines({ status: "completed-truncated", stopReason: "Cancelled", verified: true }).join(
      "\n"
    ),
    /Verified: n\/a - the run stopped early \(Cancelled\)/
  );
});

test("formatUsageLine includes requested -> served model", () => {
  const line = formatUsageLine(
    {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 5,
      costUsd: 0.01,
      numTurns: 1
    },
    { model: "grok-4.5", resolvedModel: "grok-4.5-build" }
  );
  assert.match(line, /model grok-4\.5 -> grok-4\.5-build/);
});

// --- show BRIDGE-RESULT block ---

test("buildBridgeResultBlock emits the structured trailer", () => {
  const block = buildBridgeResultBlock(
    {
      id: "run-1",
      status: "completed-truncated",
      stopReason: "Cancelled",
      verified: null,
      toolCallCount: 0,
      changedFileCount: 0,
      model: "grok-4.5",
      resolvedModel: "grok-4.5-build",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        costUsd: 0.001,
        numTurns: 1,
        resolvedModel: "grok-4.5-build"
      },
      logFile: "/tmp/run-1.log",
      worktree: { path: "/tmp/wt", branch: "grok-build/run-1" }
    },
    null
  );
  assert.match(block, /===BRIDGE-RESULT===/);
  assert.match(block, /status: completed-truncated/);
  assert.match(block, /stopReason: Cancelled/);
  assert.match(block, /verified: n\/a/);
  assert.match(block, /isolation: ACTIVE \(worktree \/tmp\/wt, branch grok-build\/run-1\)/);
  assert.match(block, /changed files: none/);
  assert.match(block, /tool calls: 0/);
  assert.match(block, /land: \/grok-build:land run-1/);
  assert.match(block, /===END-BRIDGE-RESULT===/);
});

// --- models parsing + pay-per-token gate ---

test("parseModelsOutput extracts default and billing routes", () => {
  const stdout = [
    "You are logged in with grok.com.",
    "",
    "Default model: grok-4.5",
    "",
    "Available models:",
    "  - grok-4.5",
    "  - openai/gpt-5",
    "  - openai-codex/gpt-5",
    "  - nvidia/llama-3",
    "  - xai-direct/grok-4"
  ].join("\n");
  const parsed = parseModelsOutput(stdout);
  assert.equal(parsed.defaultModel, "grok-4.5");
  const byId = Object.fromEntries(parsed.models.map((row) => [row.id, row]));
  assert.equal(byId["grok-4.5"].billing, "default");
  assert.equal(byId["grok-4.5"].default, true);
  assert.equal(byId["openai/gpt-5"].billing, "pay-per-token");
  assert.equal(byId["openai-codex/gpt-5"].billing, "subscription");
  assert.equal(byId["nvidia/llama-3"].billing, "provider-key");
  assert.equal(byId["xai-direct/grok-4"].billing, "default");
});

test("inferModelBillingRoute covers prefix table", () => {
  assert.equal(inferModelBillingRoute("openai/gpt-4").billing, "pay-per-token");
  assert.equal(inferModelBillingRoute("openai-codex/x").billing, "subscription");
  assert.equal(inferModelBillingRoute("nvidia/y").billing, "provider-key");
  assert.equal(inferModelBillingRoute("grok-4.5").billing, "default");
});

test("assertModelBillingAllowed gates pay-per-token without opt-in", () => {
  const denied = assertModelBillingAllowed("openai/gpt-5", {});
  assert.equal(denied.allowed, false);
  assert.match(denied.message, /GROK_BUILD_ALLOW_PAY_PER_TOKEN=1/);

  const allowed = assertModelBillingAllowed("openai/gpt-5", { GROK_BUILD_ALLOW_PAY_PER_TOKEN: "1" });
  assert.equal(allowed.allowed, true);

  const defaultOk = assertModelBillingAllowed("grok-4.5", {});
  assert.equal(defaultOk.allowed, true);
});

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");

test("run --help short-circuits without validation errors", () => {
  const result = run("node", [SCRIPT, "run", "--help"], { env: buildEnv(makeTempDir()) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:.*run/i);
  assert.doesNotMatch(result.stderr, /ignoring unknown option --help/);
  assert.doesNotMatch(result.stderr, /Provide a prompt/);
});

test("models --json returns schemaVersion 1 with billing routes", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const result = run("node", [SCRIPT, "models", "--json"], { env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.ok(payload.binary);
  assert.ok(Array.isArray(payload.models));
  assert.ok(payload.models.length > 0);
  assert.ok(payload.models.every((row) => row.id && row.billing && row.route != null));
});

test("runs --json emits schemaVersion 2 with compat aliases", () => {
  withPluginData(() => {
    const binDir = makeTempDir();
    installFakeGrok(binDir);
    const pluginData = process.env.CLAUDE_PLUGIN_DATA;
    const workspace = makeTempDir();
    // Clear session filter so a job without sessionId is still visible. Ambient
    // GROK_CC_SESSION_ID from the host Claude session would otherwise hide it.
    const env = buildEnv(binDir, {
      CLAUDE_PLUGIN_DATA: pluginData,
      GROK_CC_SESSION_ID: ""
    });
    delete env.GROK_CC_SESSION_ID;

    // Seed a finished job so the runs list is non-empty.
    const jobId = "run-schema-v2";
    const seed = {
      id: jobId,
      status: "completed",
      phase: "done",
      title: "Schema v2",
      kind: "task",
      jobClass: "task",
      write: false,
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001, numTurns: 1 },
      stopReason: "EndTurn",
      toolCallCount: 1,
      changedFileCount: 0,
      model: "fake-model",
      resolvedModel: "fake-model",
      completedAt: new Date().toISOString()
    };
    writeJobFile(workspace, jobId, seed);
    upsertJob(workspace, seed);

    const result = run("node", [SCRIPT, "runs", "--json", "--cwd", workspace, "--all"], { env });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schemaVersion, 2);
    assert.ok(payload.workspaceRoot);
    assert.ok(payload.sessionRuntime);
    assert.ok(Array.isArray(payload.runs));
    assert.ok(payload.compat);
    assert.ok(Array.isArray(payload.compat.running));
    assert.ok(Array.isArray(payload.running), "legacy running key kept for one minor version");
    assert.ok("latestFinished" in payload, "legacy latestFinished key kept");
    assert.ok(Array.isArray(payload.recent), "legacy recent key kept");

    const row =
      payload.runs.find((entry) => entry.id === jobId) ??
      (payload.latestFinished?.id === jobId ? payload.latestFinished : null);
    assert.ok(row, `seeded job should appear; got ${JSON.stringify(payload.runs)}`);
    assert.equal(row.status, "completed");
    assert.ok(row.usage);
    assert.equal(row.stopReason, "EndTurn");
    assert.equal(row.toolCallCount, 1);
    assert.ok(row.isolation);
    assert.equal(typeof row.isolation.active, "boolean");
  });
});

test("pay-per-token model is refused without GROK_BUILD_ALLOW_PAY_PER_TOKEN", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const workspace = makeTempDir();
  const result = run(
    "node",
    [SCRIPT, "run", "--cwd", workspace, "--model", "openai/gpt-5", "hello"],
    { env }
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /GROK_BUILD_ALLOW_PAY_PER_TOKEN=1/);
});


// --- 12. Agent-committed worktrees are not no-ops ---

test("an agent that commits inside the worktree is not reported as a no-op", () => {
  // Regression: the manifest used to be gated on the BRIDGE making the commit.
  // An agent that ran `git commit` itself left a clean tree, commitWorktreeChanges
  // returned {committed:false, sha:HEAD}, and the run was recorded as changing
  // nothing - which decideCompletionStatus now turns into completed-noop.
  const dir = makeTempDir("agent-commit");
  const run = (args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  run(["init", "-q"]);
  run(["config", "user.email", "t@example.test"]);
  run(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "base"]);
  const baseSha = run(["rev-parse", "HEAD"]);

  // The agent's own commit, exactly as a real run leaves it.
  fs.writeFileSync(path.join(dir, "added.txt"), "work\n");
  run(["add", "-A"]);
  run(["commit", "-qm", "agent work"]);
  const headSha = run(["rev-parse", "HEAD"]);

  // The bridge finds nothing left to stage...
  const committed = commitWorktreeChanges(dir, "bridge sweep");
  assert.equal(committed.committed, false);
  assert.equal(committed.sha, headSha);

  // ...but the range still names the work, and that is what the manifest uses.
  const listed = listCommittedChanges(dir, baseSha, committed.sha);
  assert.equal(listed.total, 1);
  assert.ok(listed.entries[0].endsWith("added.txt"));

  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "EndTurn",
      write: true,
      changedFileCount: listed.total,
      toolCallCount: 4,
      verified: true
    }),
    "completed"
  );
});
