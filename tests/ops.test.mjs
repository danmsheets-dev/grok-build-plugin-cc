import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  generateJobId,
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
import { createWorktree } from "../plugins/grok-build/scripts/lib/worktree.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

function withPluginData(pluginDataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
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

test("doctor exits 0 and reports the HOME check", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "doctor"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HOME/);
  assert.match(result.stdout, /Grok Build Doctor|# Grok Build Doctor|Checks:/i);
});

test("doctor --json emits an object with a checks array", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.checks));
  assert.ok(payload.checks.some((check) => /HOME/i.test(check.name)));
});

test("prune with no runs reports nothing to do", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "prune", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.count, 0);
  assert.equal(payload.mode, "dry-run");
  assert.deepEqual(payload.items, []);
});

test("prune is a dry run by default and does not reclaim abandoned runs", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const jobId = generateJobId("run");
  withPluginData(pluginDataDir, () => {
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      kind: "task",
      kindLabel: "delegate",
      title: "Abandoned seed",
      jobClass: "task",
      bridgePid: 999999,
      agentPid: 999999,
      pid: 999999
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  });

  const result = run("node", [SCRIPT, "prune", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.applied, false);
  assert.ok(payload.count >= 1, `expected at least one prune item, got ${payload.count}`);
  assert.ok(payload.items.some((item) => item.jobId === jobId && item.type === "abandon"));

  withPluginData(pluginDataDir, () => {
    const stored = readJobFile(resolveJobFile(repo, jobId));
    assert.equal(stored.status, "running", "dry-run prune must not change job status");
  });
});

test("prune --apply marks a seeded abandoned job terminal", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const jobId = generateJobId("run");
  withPluginData(pluginDataDir, () => {
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      kind: "task",
      kindLabel: "delegate",
      title: "Abandoned seed apply",
      jobClass: "task",
      bridgePid: 999999,
      agentPid: 999999,
      pid: 999999
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  });

  const result = run("node", [SCRIPT, "prune", "--apply", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "apply");
  assert.equal(payload.applied, true);
  assert.ok(payload.items.some((item) => item.jobId === jobId && item.applied === true));

  withPluginData(pluginDataDir, () => {
    const stored = readJobFile(resolveJobFile(repo, jobId));
    assert.equal(stored.status, "failed");
    assert.match(stored.errorMessage ?? "", /abandoned/i);
    const jobs = listJobs(repo);
    const index = jobs.find((job) => job.id === jobId);
    assert.ok(index);
    assert.equal(index.status, "failed");
  });
});

function seedCompletedUnlandedWorktree(repo, pluginDataDir, status = "completed") {
  fs.writeFileSync(path.join(repo, "README.md"), "# seed\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const jobId = generateJobId("run");
  const created = createWorktree({
    cwd: repo,
    runId: jobId,
    dataDir: pluginDataDir
  });
  fs.writeFileSync(path.join(created.worktreePath, "unlanded.txt"), "keep me\n");
  run("git", ["add", "unlanded.txt"], { cwd: created.worktreePath });
  run("git", ["commit", "-m", "agent work"], { cwd: created.worktreePath });

  withPluginData(pluginDataDir, () => {
    const job = {
      id: jobId,
      status,
      phase: "done",
      kind: "task",
      kindLabel: "delegate",
      title: "Unlanded completed",
      jobClass: "task",
      summary: "successful isolate run",
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  });

  return { jobId, created };
}

test("prune plan excludes completed unlanded work by default", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const { jobId, created } = withPluginData(pluginDataDir, () =>
    seedCompletedUnlandedWorktree(repo, pluginDataDir)
  );

  const result = run("node", [SCRIPT, "prune", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.awaitingLand));
  assert.ok(
    payload.awaitingLand.some((item) => item.jobId === jobId && item.unmergedCommits > 0),
    "completed unlanded run must appear under awaitingLand"
  );
  assert.equal(
    payload.items.some((item) => item.jobId === jobId && item.type === "worktree"),
    false,
    "default prune plan must not schedule worktree removal for unlanded completed work"
  );
  assert.equal(fs.existsSync(created.worktreePath), true);

  const branchList = run("git", ["branch", "--list", created.branchName], { cwd: repo });
  assert.match(branchList.stdout, /grok-build\//);
});

test("doctor reports completed unlanded work as awaiting land, not prunable staleness", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  withPluginData(pluginDataDir, () => seedCompletedUnlandedWorktree(repo, pluginDataDir));

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const awaiting = payload.checks.find((check) => /awaiting land/i.test(check.name));
  assert.ok(awaiting, "doctor must include an awaiting land check");
  assert.equal(awaiting.ok, false);
  assert.match(awaiting.detail, /1 run\(s\) awaiting land/);
  assert.match(awaiting.fix ?? "", /\/grok-build:land/);
  assert.doesNotMatch(awaiting.fix ?? "", /prune/i);

  const stale = payload.checks.find((check) => /stale worktrees/i.test(check.name));
  assert.ok(stale);
  assert.equal(stale.ok, true, "unlanded completed work must not count as prunable staleness");
});

test("prune plan also excludes completed-unverified and timed-out unlanded work", () => {
  // Regression found by a second-round audit: the awaiting-land guard only
  // recognized the literal string "completed", so a completed-unverified
  // run (it ran to completion, it just never passed verification) or a
  // timed-out run had its branch and real, unlanded commit destroyed by
  // prune --apply - and doctor's own recommended fix for exactly this case
  // was to run prune --apply, making the tool's own advice destructive.
  for (const status of ["completed-unverified", "timed-out"]) {
    const binDir = makeTempDir();
    const pluginDataDir = makeTempDir();
    const repo = makeTempDir();
    installFakeGrok(binDir);
    initGitRepo(repo);

    const { jobId, created } = withPluginData(pluginDataDir, () =>
      seedCompletedUnlandedWorktree(repo, pluginDataDir, status)
    );

    const dryRun = run("node", [SCRIPT, "prune", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.ok(
      dryPayload.awaitingLand.some((item) => item.jobId === jobId),
      `${status}: must appear under awaitingLand`
    );

    const applied = run("node", [SCRIPT, "prune", "--apply", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(applied.status, 0, applied.stderr);

    assert.equal(fs.existsSync(created.worktreePath), true, `${status}: worktree must survive --apply`);
    const branchList = run("git", ["branch", "--list", created.branchName], { cwd: repo });
    assert.match(branchList.stdout, /grok-build\//, `${status}: branch must survive --apply`);
  }
});

test("doctor reports completed-unverified unlanded work as awaiting land, not prunable staleness", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  withPluginData(pluginDataDir, () =>
    seedCompletedUnlandedWorktree(repo, pluginDataDir, "completed-unverified")
  );

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const stale = payload.checks.find((check) => /stale worktree/i.test(check.name));
  assert.equal(stale?.ok, true, "must NOT be reported as stale worktree staleness");
  const awaiting = payload.checks.find((check) => /awaiting land/i.test(check.name));
  assert.ok(awaiting, "doctor must include an awaiting land check");
  assert.equal(awaiting.ok, false);
  assert.doesNotMatch(awaiting.fix ?? "", /prune/i, "must not recommend the destructive prune remedy");
});

test("a trusted project config drives verification end to end", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  // Passes unconditionally and needs no binary beyond node, so the assertion
  // is about WHERE the command came from, not about what it does.
  const verifyCommand = 'node -e "process.exit(0)"';
  fs.writeFileSync(
    path.join(repo, ".grok-build.json"),
    `${JSON.stringify({ verify: [verifyCommand] }, null, 2)}\n`,
    "utf8"
  );

  // Untrusted first: the run must NOT execute a command the user has not
  // vouched for, even though the file is right there in the repo.
  const untrusted = run("node", [SCRIPT, "run", "--json", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(untrusted.status, 0, untrusted.stderr || untrusted.stdout);
  const untrustedPayload = JSON.parse(untrusted.stdout);
  assert.deepEqual(untrustedPayload.verify.commands, []);
  assert.deepEqual(untrustedPayload.verify.plan.configWithheld, ["verify"]);

  const trust = run("node", [SCRIPT, "trust-config", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(trust.status, 0, trust.stderr);
  assert.equal(JSON.parse(trust.stdout).recorded, true);

  const result = run("node", [SCRIPT, "run", "--json", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.verify.commands, [verifyCommand]);
  assert.equal(payload.verify.plan.source, "config");
  assert.equal(payload.verify.plan.configTrusted, true);
  assert.equal(payload.verified, true, "the config's verify command passes");
  assert.equal(payload.verify.baselines.length, 1, "the baseline probe covered the resolved command");
});

test("--no-verify opts out of a trusted config's plan", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    path.join(repo, ".grok-build.json"),
    `${JSON.stringify({ verify: ['node -e "process.exit(1)"'] }, null, 2)}\n`,
    "utf8"
  );
  run("node", [SCRIPT, "trust-config"], { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) });

  const result = run("node", [SCRIPT, "run", "--json", "--no-verify", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.verify.commands, []);
  assert.equal(payload.verify.plan.disabled, true);
  // A failing command that never ran must not be able to report a verdict.
  assert.equal(payload.verified, null);
});
