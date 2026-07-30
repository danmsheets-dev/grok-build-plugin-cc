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

test("land --preview errors on a stale branch ref instead of silently claiming no changes", () => {
  // Regression found by a second-round audit: the diff computation used the
  // unchecked git() wrapper, so a branch that no longer exists (e.g. a job
  // already landed once, or manually cleaned up) made `git diff` fail
  // non-zero with empty stdout - and empty stdout was indistinguishable
  // from a genuinely empty diff, printing "No changes between base and run
  // branch" with total confidence for a run whose branch does not exist.
  const repo = makeTempDir("grok-land-stale-ref-");
  const binDir = makeTempDir("grok-land-stale-ref-bin-");
  const pluginDataDir = makeTempDir("grok-land-stale-ref-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const baseSha = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();
    seedFinishedJob(repo, pluginDataDir, {
      id: jobId,
      worktree: {
        path: path.join(pluginDataDir, "worktrees", "does-not-exist"),
        branch: "grok-build/does-not-exist",
        baseSha
      }
    });

    const result = run("node", [SCRIPT, "land", jobId, "--preview"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.notEqual(result.status, 0, "must fail rather than silently succeed");
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}`,
      /No changes between base and run branch/,
      "must not report false confidence for a branch that does not exist"
    );
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("an untracked Godot import cache does not block land", () => {
  // A Godot repo that does not gitignore .godot/ is permanently `?? .godot/`,
  // and this plugin's own provisioning junction is one of the reasons it gets
  // there - so a bare `git status --porcelain` gate made land impossible
  // forever in the plugin's primary ecosystem.
  const repo = makeTempDir("grok-land-artifact-");
  const binDir = makeTempDir("grok-land-artifact-bin-");
  const pluginDataDir = makeTempDir("grok-land-artifact-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const created = createWorktree({ cwd: repo, runId: jobId, dataDir: pluginDataDir });
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

    // Neither tracked nor gitignored - the state a real Godot checkout is in.
    fs.mkdirSync(path.join(repo, ".godot", "imported"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".godot", "imported", "x.ctex"), "cache\n");
    const bareStatus = run("git", ["status", "--porcelain"], { cwd: repo });
    assert.match(bareStatus.stdout, /\.godot/, "the fixture must actually look dirty to plain git");

    const result = run("node", [SCRIPT, "land", jobId, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.action, "apply");
    assert.ok(
      payload.ignoredDirtyArtifacts.some((entry) => entry.includes(".godot")),
      `the overlooked artifact must be reported, got: ${JSON.stringify(payload.ignoredDirtyArtifacts)}`
    );

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

test("real untracked source still blocks land after the artifact filter", () => {
  // The discriminator for the test above: the filter must narrow the gate to
  // generated artifacts, not disable it.
  const repo = makeTempDir("grok-land-realdirt-");
  const binDir = makeTempDir("grok-land-realdirt-bin-");
  const pluginDataDir = makeTempDir("grok-land-realdirt-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const created = createWorktree({ cwd: repo, runId: jobId, dataDir: pluginDataDir });
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

    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "real_change.gd"), "extends Node\n");

    const result = run("node", [SCRIPT, "land", jobId], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.notEqual(result.status, 0, result.stdout);
    const combined = `${result.stderr}\n${result.stdout}`;
    assert.match(combined, /Refusing to land into a dirty working tree/);
    assert.match(combined, /real_change\.gd|src\//);
    assert.equal(fs.existsSync(created.worktreePath), true);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("landing a job twice gives a clean error on the second call, not a raw git error", () => {
  // Regression found by a second-round audit: land never cleared the job's
  // worktree field after a successful apply or discard, so a second
  // /grok-build:land call on the same job id fell through past the
  // "no worktree to land" guard and hit a git diff against a branch
  // removeWorktree had already deleted - a raw, unfriendly git error
  // instead of a clear "already landed" message. It also left the
  // render.mjs land-hint pointing at a job with nothing left to land.
  const repo = makeTempDir("grok-land-twice-");
  const binDir = makeTempDir("grok-land-twice-bin-");
  const pluginDataDir = makeTempDir("grok-land-twice-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const created = createWorktree({ cwd: repo, runId: jobId, dataDir: pluginDataDir });
    fs.writeFileSync(path.join(created.worktreePath, "agent.txt"), "from agent\n");
    run("git", ["add", "agent.txt"], { cwd: created.worktreePath });
    run("git", ["commit", "-m", "agent change"], { cwd: created.worktreePath });

    seedFinishedJob(repo, pluginDataDir, {
      id: jobId,
      worktree: { path: created.worktreePath, branch: created.branchName, baseSha: created.baseSha }
    });

    const first = run("node", [SCRIPT, "land", jobId], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(first.status, 0, first.stderr);
    run("git", ["commit", "-am", "keep landed work"], { cwd: repo });

    const second = run("node", [SCRIPT, "land", jobId], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.notEqual(second.status, 0);
    assert.match(`${second.stdout}${second.stderr}`, /has no worktree to land/i);
    assert.doesNotMatch(`${second.stdout}${second.stderr}`, /fatal:|unknown revision/i);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
