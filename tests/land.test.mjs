import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  generateJobId,
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

test("a binary merge conflict rolls the repository back instead of leaving it mid-merge", () => {
  // Binary files cannot be content-merged, so any asset touched on both sides
  // conflicts deterministically. Without the rollback, git leaves conflict
  // markers in the index, the worktree and branch are never cleaned up, the job
  // is never marked landed - and the recovery every user reaches for fails:
  // `--squash` writes no MERGE_HEAD, so `git merge --abort` exits 128 with
  // "There is no merge to abort".
  const repo = makeTempDir("grok-land-conflict-");
  const binDir = makeTempDir("grok-land-conflict-bin-");
  const pluginDataDir = makeTempDir("grok-land-conflict-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    // NUL bytes are what make git treat it as binary; nothing else here does.
    const asset = (marker) => Buffer.from(`${marker}\u0000\u0001\u0002 payload\n`, "binary");
    fs.writeFileSync(path.join(repo, "asset.bin"), asset("BASE"));
    run("git", ["add", "asset.bin"], { cwd: repo });
    run("git", ["commit", "-m", "add binary asset"], { cwd: repo });

    const jobId = generateJobId("run");
    const created = createWorktree({ cwd: repo, runId: jobId, dataDir: pluginDataDir });
    fs.writeFileSync(path.join(created.worktreePath, "asset.bin"), asset("AGENT"));
    run("git", ["commit", "-am", "agent rewrote the asset"], { cwd: created.worktreePath });

    seedFinishedJob(repo, pluginDataDir, {
      id: jobId,
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      }
    });

    // The other side of the conflict: the same asset, rewritten on main.
    fs.writeFileSync(path.join(repo, "asset.bin"), asset("HUMAN"));
    run("git", ["commit", "-am", "human rewrote the asset"], { cwd: repo });
    const headBefore = run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim();

    const result = run("node", [SCRIPT, "land", jobId], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    const combined = `${result.stderr}\n${result.stdout}`;
    assert.notEqual(result.status, 0, combined);
    assert.match(combined, /asset\.bin/);
    assert.match(combined, /binary/i, "a binary conflict must be labelled as one");
    // `git merge --abort` is the recovery every user reaches for and it fails
    // here (exit 128, "There is no merge to abort"), so the message warns
    // against it rather than staying silent - but it must never appear as an
    // instruction. Every occurrence has to be the negated one.
    assert.match(combined, /Do NOT run git merge --abort/);
    assert.equal(
      (combined.match(/merge --abort/g) ?? []).length,
      (combined.match(/Do NOT run git merge --abort/g) ?? []).length,
      "every mention of merge --abort must be the warning, never a suggestion"
    );
    assert.match(combined, new RegExp(`land ${jobId} --discard`));
    assert.match(combined, /--ours|--theirs/);

    // (b) the repository is back exactly where it was, with nothing staged.
    assert.equal(run("git", ["status", "--porcelain"], { cwd: repo }).stdout.trim(), "");
    assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: repo }).stdout.trim(), headBefore);
    // (c) reset --hard clears the squash state on its own - nothing inside
    // .git is hand-deleted.
    for (const leftover of ["SQUASH_MSG", "MERGE_MSG", "AUTO_MERGE"]) {
      assert.equal(
        fs.existsSync(path.join(repo, ".git", leftover)),
        false,
        `.git/${leftover} must not survive the rollback`
      );
    }

    // (d) + (e): the run is still recoverable, so --discard still has something
    // to discard.
    assert.equal(fs.existsSync(created.worktreePath), true);
    assert.match(
      run("git", ["branch", "--list", created.branchName], { cwd: repo }).stdout,
      /grok-build\//
    );
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobId), "utf8"));
    assert.ok(stored.worktree, "the job must still carry its worktree descriptor");
    assert.equal(stored.worktree.branch, created.branchName);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("land bounds the preview diff and never materializes it on the apply path", () => {
  // The diff used to be read before the --preview branch, so the apply path
  // paid for a string it discarded - and with no cap at all, because passing
  // maxBuffer:undefined to spawnSync overrides its 1 MiB default rather than
  // falling back to it.
  const repo = makeTempDir("grok-land-bigdiff-");
  const binDir = makeTempDir("grok-land-bigdiff-bin-");
  const pluginDataDir = makeTempDir("grok-land-bigdiff-data-");
  installFakeGrok(binDir);
  seedRepo(repo);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const created = createWorktree({ cwd: repo, runId: jobId, dataDir: pluginDataDir });
    // ~300 KB of added text: comfortably past the 128 KB preview budget.
    const body = Array.from({ length: 6000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    fs.writeFileSync(path.join(created.worktreePath, "big.txt"), `${body}\n`);
    // One binary file alongside it, for the aggregate count.
    fs.writeFileSync(
      path.join(created.worktreePath, "tex.bin"),
      Buffer.from("\u0000\u0001\u0002binary texture\n", "binary")
    );
    run("git", ["add", "-A"], { cwd: created.worktreePath });
    run("git", ["commit", "-m", "agent wrote a lot"], { cwd: created.worktreePath });

    seedFinishedJob(repo, pluginDataDir, {
      id: jobId,
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      }
    });

    const preview = run("node", [SCRIPT, "land", jobId, "--preview", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    const previewPayload = JSON.parse(preview.stdout);
    assert.equal(previewPayload.diff, null, "an oversized diff must not be materialized");
    assert.match(previewPayload.diffOmitted, /diff omitted: exceeds 128 KB/);
    assert.match(previewPayload.diffOmitted, new RegExp(`git diff ${created.baseSha}\.\.`));
    assert.match(previewPayload.diffStat, /big\.txt/, "the stat is what survives the cap");
    assert.equal(previewPayload.totalBinaryFiles, 1);

    const applied = run("node", [SCRIPT, "land", jobId, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const applyPayload = JSON.parse(applied.stdout);
    assert.equal(applyPayload.action, "apply");
    assert.equal(
      applyPayload.diff,
      undefined,
      "the apply path must not compute a diff body at all"
    );
    assert.equal(applyPayload.totalBinaryFiles, 1);
    assert.match(applyPayload.diffStat, /big\.txt/);
    const staged = run("git", ["diff", "--cached", "--name-only"], { cwd: repo });
    assert.match(staged.stdout, /big\.txt/);
    assert.match(staged.stdout, /tex\.bin/);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
