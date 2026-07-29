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
