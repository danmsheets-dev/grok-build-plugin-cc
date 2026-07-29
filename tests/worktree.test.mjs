import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  commitWorktreeChanges,
  createWorktree,
  removeWorktree,
  resolveWorktreePath
} from "../plugins/grok-build/scripts/lib/worktree.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function seedRepo(cwd) {
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "README.md"), "# seed\n");
  run("git", ["add", "README.md"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
}

function worktreeListLines(cwd) {
  const result = run("git", ["worktree", "list"], { cwd });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Git prints worktree paths with forward slashes on Windows. */
function normalizePath(p) {
  return path.resolve(p).replace(/\\/g, "/").toLowerCase();
}

function listMentionsPath(listLines, targetPath) {
  const normalized = normalizePath(targetPath);
  return listLines.some((line) => normalizePath(line.split(/\s+/)[0]).includes(normalized) || line.replace(/\\/g, "/").toLowerCase().includes(normalized));
}

test("resolveWorktreePath uses dataDir, CLAUDE_PLUGIN_DATA, or tmpdir fallback", () => {
  const dataDir = makeTempDir("grok-wt-data-");
  assert.equal(
    resolveWorktreePath("run-a", { dataDir }),
    path.join(dataDir, "worktrees", "run-a")
  );

  const pluginData = makeTempDir("grok-wt-plugin-");
  assert.equal(
    resolveWorktreePath("run-b", { env: { CLAUDE_PLUGIN_DATA: pluginData } }),
    path.join(pluginData, "worktrees", "run-b")
  );

  const fallback = resolveWorktreePath("run-c", { env: {} });
  assert.match(fallback, /grok-cc-worktrees/);
  assert.ok(fallback.endsWith(path.join("grok-cc-worktrees", "run-c")));
});

test("createWorktree makes a real worktree directory and grok-build branch", () => {
  const cwd = makeTempDir("grok-wt-create-");
  const dataDir = makeTempDir("grok-wt-create-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "create-1", dataDir });

  assert.equal(created.branchName, "grok-build/create-1");
  assert.equal(created.runId, "create-1");
  assert.equal(created.baseRef, "HEAD");
  assert.ok(created.baseSha);
  assert.ok(fs.existsSync(created.worktreePath));
  assert.ok(fs.existsSync(path.join(created.worktreePath, "README.md")));

  const list = worktreeListLines(cwd);
  assert.equal(list.length, 2);
  assert.ok(listMentionsPath(list, created.worktreePath));

  const branches = run("git", ["branch", "--list", "grok-build/create-1"], { cwd });
  assert.match(branches.stdout, /grok-build\/create-1/);

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("createWorktree throws when the worktree path already exists", () => {
  const cwd = makeTempDir("grok-wt-exists-");
  const dataDir = makeTempDir("grok-wt-exists-data-");
  seedRepo(cwd);

  const worktreePath = resolveWorktreePath("exists-1", { dataDir });
  fs.mkdirSync(worktreePath, { recursive: true });

  assert.throws(
    () => createWorktree({ cwd, runId: "exists-1", dataDir }),
    /Worktree path already exists/
  );
});

test("removeWorktree deletes the directory and the branch", () => {
  const cwd = makeTempDir("grok-wt-remove-");
  const dataDir = makeTempDir("grok-wt-remove-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "remove-1", dataDir });
  assert.equal(worktreeListLines(cwd).length, 2);

  const removed = removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });

  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(created.worktreePath), false);
  assert.equal(worktreeListLines(cwd).length, 1);

  const branches = run("git", ["branch", "--list", "grok-build/remove-1"], { cwd });
  assert.equal(branches.stdout.trim(), "");
});

test("commitWorktreeChanges commits a new file and returns committed:true with a sha", () => {
  const cwd = makeTempDir("grok-wt-commit-");
  const dataDir = makeTempDir("grok-wt-commit-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "commit-1", dataDir });
  fs.writeFileSync(path.join(created.worktreePath, "agent.txt"), "hello from agent\n");

  const result = commitWorktreeChanges(created.worktreePath, "agent wrote a file");
  assert.equal(result.committed, true);
  assert.match(result.sha, /^[0-9a-f]{40}$/i);

  const show = run("git", ["show", "--name-only", "--pretty=format:", "HEAD"], {
    cwd: created.worktreePath
  });
  assert.match(show.stdout, /agent\.txt/);

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("commitWorktreeChanges returns committed:false when the worktree is clean", () => {
  const cwd = makeTempDir("grok-wt-clean-");
  const dataDir = makeTempDir("grok-wt-clean-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "clean-1", dataDir });
  const headBefore = run("git", ["rev-parse", "HEAD"], { cwd: created.worktreePath }).stdout.trim();

  const result = commitWorktreeChanges(created.worktreePath);
  assert.equal(result.committed, false);
  assert.equal(result.sha, headBefore);

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("commitWorktreeChanges excludes build artifacts in a linked worktree", () => {
  // CRITICAL: must use a real linked worktree created by createWorktree.
  // git reads excludes from the common git dir; a plain-repo test would pass
  // while the real case failed (Nemotron's lesson).
  const cwd = makeTempDir("grok-wt-artifacts-");
  const dataDir = makeTempDir("grok-wt-artifacts-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "artifacts-1", dataDir });
  const wt = created.worktreePath;

  fs.writeFileSync(path.join(wt, "src.txt"), "fix\n");
  fs.mkdirSync(path.join(wt, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(wt, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

  const result = commitWorktreeChanges(wt, "agent fix with artifacts nearby");
  assert.equal(result.committed, true);

  const show = run("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: wt });
  assert.match(show.stdout, /src\.txt/);
  assert.doesNotMatch(show.stdout, /node_modules/);

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("removing a worktree never destroys a junction/symlink's real target", () => {
  // Regression for a confirmed data-destroying defect: git worktree remove --force
  // followed a Windows junction while deleting the worktree tree and wiped the
  // CONTENTS of the real directory it pointed at (the empty directory itself
  // survived; the file inside it did not). Reproduced against un-patched code
  // before this fix. Every real-world isolated run links node_modules/.venv/
  // target this way, so this is not an edge case — it is the normal path.
  const cwd = makeTempDir();
  seedRepo(cwd);

  const realDepDir = path.join(cwd, "node_modules", "pkg");
  fs.mkdirSync(realDepDir, { recursive: true });
  const markerFile = path.join(realDepDir, "marker.txt");
  fs.writeFileSync(markerFile, "REAL DEPENDENCY - MUST SURVIVE\n", "utf8");

  const dataDir = makeTempDir();
  const created = createWorktree({ cwd, runId: "junction-safety", dataDir });

  const linkedPath = path.join(created.worktreePath, "node_modules");
  const kind = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(path.join(cwd, "node_modules"), linkedPath, kind);
  assert.equal(
    fs.existsSync(path.join(linkedPath, "pkg", "marker.txt")),
    true,
    "the link must actually expose the real file before the real test begins"
  );

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName,
    deleteBranch: true
  });

  assert.equal(
    fs.existsSync(markerFile),
    true,
    "the real repo's file must survive worktree teardown"
  );
  assert.equal(
    fs.readFileSync(markerFile, "utf8"),
    "REAL DEPENDENCY - MUST SURVIVE\n",
    "content must be byte-identical, not merely present"
  );
});
