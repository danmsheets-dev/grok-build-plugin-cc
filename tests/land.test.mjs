import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  generateJobId,
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

function seedRepo(cwd) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "# seed\n");
  run("git", ["add", "README.md"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
}

function seedFinishedJob(repo, pluginDataDir, jobPatch = {}) {
  const jobId = jobPatch.id ?? generateJobId("run");
  const job = {
    id: jobId,
    kind: "task",
    kindLabel: "delegate",
    title: "Grok Build Delegate",
    workspaceRoot: repo,
    jobClass: "task",
    summary: "seeded land test",
    status: "completed",
    phase: "done",
    write: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...jobPatch,
    id: jobId
  };
  writeJobFile(repo, jobId, job);
  upsertJob(repo, job);
  return job;
}

test("land refuses when the resolved run has no worktree", () => {
  const repo = makeTempDir("grok-land-no-wt-");
  const binDir = makeTempDir("grok-land-bin-");
  const pluginDataDir = makeTempDir("grok-land-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const job = seedFinishedJob(repo, pluginDataDir);

    const result = run("node", [SCRIPT, "land", job.id, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /has no worktree to land/i
    );
    assert.match(`${result.stderr}\n${result.stdout}`, new RegExp(job.id));
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("land --discard removes the worktree directory and the branch", () => {
  const repo = makeTempDir("grok-land-discard-");
  const binDir = makeTempDir("grok-land-bin-");
  const pluginDataDir = makeTempDir("grok-land-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const created = createWorktree({
      cwd: repo,
      runId: jobId,
      dataDir: pluginDataDir
    });
    fs.writeFileSync(path.join(created.worktreePath, "agent.txt"), "from agent\n");
    run("git", ["add", "agent.txt"], { cwd: created.worktreePath });
    run("git", ["commit", "-m", "agent change"], { cwd: created.worktreePath });

    seedFinishedJob(repo, pluginDataDir, {
      id: jobId,
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      }
    });

    assert.equal(fs.existsSync(created.worktreePath), true);
    const branchBefore = run("git", ["branch", "--list", created.branchName], { cwd: repo });
    assert.match(branchBefore.stdout, /grok-build\//);

    const result = run("node", [SCRIPT, "land", jobId, "--discard", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.action, "discard");
    assert.equal(fs.existsSync(created.worktreePath), false);

    const branchAfter = run("git", ["branch", "--list", created.branchName], { cwd: repo });
    assert.equal(branchAfter.stdout.trim(), "");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("land refuses to apply when the live working tree is dirty", () => {
  const repo = makeTempDir("grok-land-dirty-");
  const binDir = makeTempDir("grok-land-bin-");
  const pluginDataDir = makeTempDir("grok-land-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const created = createWorktree({
      cwd: repo,
      runId: jobId,
      dataDir: pluginDataDir
    });
    fs.writeFileSync(path.join(created.worktreePath, "agent.txt"), "from agent\n");
    run("git", ["add", "agent.txt"], { cwd: created.worktreePath });
    run("git", ["commit", "-m", "agent change"], { cwd: created.worktreePath });

    seedFinishedJob(repo, pluginDataDir, {
      id: jobId,
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      }
    });

    const dirtyFile = "uncommitted-wip.txt";
    fs.writeFileSync(path.join(repo, dirtyFile), "live tree dirt\n");

    const result = run("node", [SCRIPT, "land", jobId], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.notEqual(result.status, 0, result.stdout);
    const combined = `${result.stderr}\n${result.stdout}`;
    assert.match(combined, /dirty/i);
    assert.match(combined, /commit or stash/i);
    assert.match(combined, new RegExp(dirtyFile));
    // Worktree must still exist — refuse means do not land or discard.
    assert.equal(fs.existsSync(created.worktreePath), true);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("land --preview returns diff without merging or removing the worktree", () => {
  const repo = makeTempDir("grok-land-preview-");
  const binDir = makeTempDir("grok-land-bin-");
  const pluginDataDir = makeTempDir("grok-land-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const created = createWorktree({
      cwd: repo,
      runId: jobId,
      dataDir: pluginDataDir
    });
    fs.writeFileSync(path.join(created.worktreePath, "agent.txt"), "from agent\n");
    run("git", ["add", "agent.txt"], { cwd: created.worktreePath });
    run("git", ["commit", "-m", "agent change"], { cwd: created.worktreePath });

    seedFinishedJob(repo, pluginDataDir, {
      id: jobId,
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      }
    });

    const headBefore = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
    const stagedBefore = run("git", ["diff", "--cached", "--name-only"], { cwd: repo }).stdout.trim();

    const result = run("node", [SCRIPT, "land", jobId, "--preview", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.action, "preview");
    assert.ok(typeof payload.diffStat === "string");
    assert.match(payload.diffStat, /agent\.txt/);
    assert.ok(typeof payload.diff === "string");
    assert.match(payload.diff, /from agent/);

    // No mutation: worktree, branch, HEAD, and index must be unchanged.
    assert.equal(fs.existsSync(created.worktreePath), true);
    const branchAfter = run("git", ["branch", "--list", created.branchName], { cwd: repo });
    assert.match(branchAfter.stdout, /grok-build\//);
    const headAfter = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
    assert.equal(headAfter, headBefore);
    const stagedAfter = run("git", ["diff", "--cached", "--name-only"], { cwd: repo }).stdout.trim();
    assert.equal(stagedAfter, stagedBefore);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("land without --preview still squash-merges (apply path unchanged)", () => {
  const repo = makeTempDir("grok-land-apply-");
  const binDir = makeTempDir("grok-land-bin-");
  const pluginDataDir = makeTempDir("grok-land-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const created = createWorktree({
      cwd: repo,
      runId: jobId,
      dataDir: pluginDataDir
    });
    fs.writeFileSync(path.join(created.worktreePath, "landed.txt"), "landed body\n");
    run("git", ["add", "landed.txt"], { cwd: created.worktreePath });
    run("git", ["commit", "-m", "agent change"], { cwd: created.worktreePath });

    seedFinishedJob(repo, pluginDataDir, {
      id: jobId,
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      }
    });

    const result = run("node", [SCRIPT, "land", jobId, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, "apply");
    assert.equal(fs.existsSync(created.worktreePath), false);
    const staged = run("git", ["diff", "--cached", "--name-only"], { cwd: repo });
    assert.match(staged.stdout, /landed\.txt/);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
