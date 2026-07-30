import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import {
  artifactExcludePathspecs,
  capChangedFiles,
  CHANGED_FILES_MAX_ENTRIES,
  commitWorktreeChanges,
  createWorktree,
  listCommittedChanges,
  removeWorktree,
  resolveWorktreePath
} from "../plugins/grok-build/scripts/lib/worktree.mjs";
import { planWorktreeLinks, provisionWorktree } from "../plugins/grok-build/scripts/lib/provision.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

/** The link kind provisionWorktree would really use on this platform. */
const LINK_KIND = process.platform === "win32" ? "junction" : "dir";

function committedNames(cwd, ref = "HEAD") {
  const show = run("git", ["show", "--name-only", "--pretty=format:", ref], { cwd });
  assert.equal(show.status, 0, show.stderr || show.stdout);
  return show.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeFileIn(root, relativePath, body) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf8");
  return target;
}

/**
 * A `git` on PATH that forwards to the real git, except that it rejects the
 * artifact-filtered `git add` outright.
 *
 * That branch cannot be provoked with real git — the whole point of the
 * pathspec form is that modern git accepts it — but it is exactly the branch
 * that used to fall back to a bare `add -A` and stage the user's real
 * `.venv`/`.godot` through the provisioned junctions.
 */
function installGitShim(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "git");
  const source = `#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const shimDir = ${JSON.stringify(binDir)};

if (argv[0] === "add" && argv.some((arg) => arg.startsWith(":(exclude"))) {
  process.stderr.write("fatal: pathspec magic is not supported by this git\\n");
  process.exit(128);
}

// Everything else is the real git, found by dropping this shim from PATH.
// Rebuilt key by key rather than spread: on Windows the real key is "Path",
// so a spread plus a "PATH" override would hand the child BOTH.
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.toUpperCase() !== "PATH") {
    env[key] = value;
  }
}
env.PATH = String(process.env.PATH ?? "")
  .split(path.delimiter)
  .filter((entry) => entry && path.resolve(entry) !== path.resolve(shimDir))
  .join(path.delimiter);

const result = spawnSync("git", argv, { env, stdio: "inherit", windowsHide: true });
process.exit(result.status ?? 1);
`;
  writeExecutable(scriptPath, source);
  return scriptPath;
}

function withPathPrefix(binDir, fn) {
  const previous = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previous ?? ""}`;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previous;
    }
  }
}

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

test("createWorktree refuses to start a checkout onto a full volume", () => {
  // Without the precheck, git gets partway through the checkout and dies with
  // its own disk-full stderr wrapped in "Failed to create worktree: ...",
  // leaving a half-populated directory behind. The point of the seam is that
  // this is provable without actually filling a disk.
  const cwd = makeTempDir("grok-wt-space-");
  const dataDir = makeTempDir("grok-wt-space-data-");
  seedRepo(cwd);

  let gitCalls = 0;
  assert.throws(
    () =>
      createWorktree({
        cwd,
        runId: "space-1",
        dataDir,
        // 4096-byte blocks, 16 of them free: 64 KB on a volume asked for 512 MB.
        statfsImpl: () => ({ bsize: 4096, bavail: 16, blocks: 1024, bfree: 16 }),
        gitImpl: () => {
          gitCalls += 1;
          return { status: 0, stdout: "", stderr: "" };
        }
      }),
    (error) => {
      assert.match(error.message, /free space/i);
      assert.match(error.message, /need ~512\.0 MB/);
      assert.match(error.message, /have 64\.0 KB/);
      return true;
    }
  );

  assert.equal(gitCalls, 0, "git must never be asked to write onto a full volume");
  assert.equal(
    fs.existsSync(resolveWorktreePath("space-1", { dataDir })),
    false,
    "no partial worktree directory may be left behind"
  );
});

test("createWorktree proceeds when the volume has room, and when it cannot be measured", () => {
  // The discriminator for the test above, plus the degradation path: statfs is
  // unsupported on some network and virtualised filesystems, and refusing to
  // run there would be a far worse regression than the opaque git error the
  // precheck replaces.
  const cwd = makeTempDir("grok-wt-space-ok-");
  const dataDir = makeTempDir("grok-wt-space-ok-data-");
  seedRepo(cwd);

  const roomy = createWorktree({
    cwd,
    runId: "space-ok",
    dataDir,
    statfsImpl: () => ({ bsize: 4096, bavail: 10_000_000, blocks: 10_000_000, bfree: 10_000_000 })
  });
  assert.ok(fs.existsSync(path.join(roomy.worktreePath, "README.md")));
  removeWorktree({
    repoRoot: roomy.repoRoot,
    worktreePath: roomy.worktreePath,
    branchName: roomy.branchName
  });

  const unmeasurable = createWorktree({
    cwd,
    runId: "space-unknown",
    dataDir,
    statfsImpl: () => {
      throw Object.assign(new Error("ENOSYS: function not implemented, statfs"), {
        code: "ENOSYS"
      });
    }
  });
  assert.ok(fs.existsSync(path.join(unmeasurable.worktreePath, "README.md")));
  removeWorktree({
    repoRoot: unmeasurable.repoRoot,
    worktreePath: unmeasurable.worktreePath,
    branchName: unmeasurable.branchName
  });
});

test("GROK_BUILD_MIN_FREE_BYTES moves the floor, and 0 disables the check", () => {
  const cwd = makeTempDir("grok-wt-space-env-");
  const dataDir = makeTempDir("grok-wt-space-env-data-");
  seedRepo(cwd);

  // 64 KB free is plenty when the floor is 1 KB.
  const tight = () => ({ bsize: 4096, bavail: 16, blocks: 1024, bfree: 16 });
  const lowered = createWorktree({
    cwd,
    runId: "space-env",
    dataDir,
    env: { GROK_BUILD_MIN_FREE_BYTES: "1024" },
    statfsImpl: tight
  });
  assert.ok(fs.existsSync(lowered.worktreePath));
  removeWorktree({
    repoRoot: lowered.repoRoot,
    worktreePath: lowered.worktreePath,
    branchName: lowered.branchName
  });

  let measured = false;
  const disabled = createWorktree({
    cwd,
    runId: "space-off",
    dataDir,
    env: { GROK_BUILD_MIN_FREE_BYTES: "0" },
    statfsImpl: () => {
      measured = true;
      return tight();
    }
  });
  assert.equal(measured, false, "a zero floor must not even call statfs");
  removeWorktree({
    repoRoot: disabled.repoRoot,
    worktreePath: disabled.worktreePath,
    branchName: disabled.branchName
  });
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

test("removeWorktree reports removed:false when the branch cannot be deleted", () => {
  const cwd = makeTempDir("grok-wt-remove-fail-");
  const dataDir = makeTempDir("grok-wt-remove-fail-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "remove-fail-1", dataDir });
  // Ask to delete the currently checked-out branch (main) — git refuses, so
  // the function must report failure rather than silently claiming success.
  const currentBranch = run("git", ["branch", "--show-current"], { cwd }).stdout.trim() || "main";

  const removed = removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: currentBranch,
    deleteBranch: true
  });

  assert.equal(removed.removed, false);
  assert.match(removed.reason ?? "", /still exists/i);
  assert.match(removed.reason ?? "", new RegExp(currentBranch));

  // Real agent branch must still be cleaned up by the test.
  run("git", ["branch", "-D", created.branchName], { cwd });
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

test("a Godot import cache is linked in, excluded from commits, and survives teardown", () => {
  // End-to-end for the Godot ecosystem specifically: .godot (Godot 4's asset
  // import cache) must be linked into a fresh worktree so a headless import
  // does not start from scratch, must never be committed onto the run
  // branch (it is regenerated, not source), and - per the junction-safety
  // fix - the real cache must survive worktree teardown even though a NEW
  // cache entry was written into it during the run.
  const cwd = makeTempDir();
  seedRepo(cwd);

  const realImportDir = path.join(cwd, ".godot", "imported");
  fs.mkdirSync(realImportDir, { recursive: true });
  const markerFile = path.join(realImportDir, "marker.txt");
  fs.writeFileSync(markerFile, "REAL IMPORT CACHE\n", "utf8");

  const dataDir = makeTempDir();
  const created = createWorktree({ cwd, runId: "godot-e2e", dataDir });
  const plan = planWorktreeLinks(created.repoRoot, created.worktreePath);
  assert.ok(
    plan.links.some((link) => path.basename(link.from) === ".godot"),
    ".godot must be planned for linking"
  );
  provisionWorktree(plan);

  const linkedMarker = path.join(created.worktreePath, ".godot", "imported", "marker.txt");
  assert.equal(fs.existsSync(linkedMarker), true, "the import cache must be visible through the link");

  // The "agent" adds a real scene file, and a headless Godot import writes a
  // new cache entry into the linked .godot directory.
  fs.writeFileSync(path.join(created.worktreePath, "new_scene.tscn"), "[gd_scene]\n", "utf8");
  fs.mkdirSync(path.join(created.worktreePath, ".godot", "imported"), { recursive: true });
  fs.writeFileSync(
    path.join(created.worktreePath, ".godot", "imported", "new_cache_entry.import"),
    "cache data\n",
    "utf8"
  );

  const committed = commitWorktreeChanges(created.worktreePath, "grok-build godot test");
  assert.equal(committed.committed, true);

  const shown = run("git", ["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: created.worktreePath });
  assert.match(shown.stdout, /new_scene\.tscn/);
  assert.doesNotMatch(shown.stdout, /\.godot/, ".godot must never be committed onto the run branch");

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName,
    deleteBranch: true
  });

  assert.equal(fs.existsSync(markerFile), true, "the real import cache must survive worktree teardown");
});

test("artifactExcludePathspecs emits both the bare and the recursive form for a directory", () => {
  const specs = artifactExcludePathspecs();

  // The recursive form alone requires a path component AFTER the directory
  // name, so it cannot match an index entry whose path is exactly ".godot" -
  // which is what git records on POSIX, where the provisioned cache is a
  // symlink blob rather than a junction.
  assert.ok(specs.includes(":(exclude,glob)**/.godot"));
  assert.ok(specs.includes(":(exclude,glob)**/.godot/**"));
  assert.ok(specs.includes(":(exclude,glob)**/.import"));
  assert.ok(specs.includes(":(exclude,glob)**/.import/**"));

  // A file pattern is not a directory and must not sprout a phantom subtree.
  assert.deepEqual(
    specs.filter((spec) => spec.includes("tsbuildinfo")),
    [":(exclude,glob)**/*.tsbuildinfo"]
  );

  // Locked in both directions: Godot's per-asset sidecars are SOURCE. Widening
  // ".import/" to "*.import" or adding "*.uid" silently breaks every uid://
  // reference in every .tscn/.tres in the project.
  assert.ok(
    specs.every((spec) => !spec.includes("*.import") && !spec.includes("*.uid")),
    "sidecar globs must never appear in the exclude list"
  );

  // Blender save backups and crashed-save leftovers, but never *.blend itself.
  assert.ok(specs.includes(":(exclude,glob)**/*.blend[0-9]"));
  assert.ok(specs.includes(":(exclude,glob)**/*.blend[0-9][0-9]"));
  assert.ok(specs.includes(":(exclude,glob)**/*.blend@"));
  assert.ok(
    specs.every((spec) => spec !== ":(exclude,glob)**/*.blend"),
    "the scene file is the source of a Blender project"
  );

  // Machine-local credentials, and Godot 3's C# output directory.
  assert.ok(specs.includes(":(exclude,glob)**/export_credentials.cfg"));
  assert.ok(specs.includes(":(exclude,glob)**/.mono"));
  assert.ok(specs.includes(":(exclude,glob)**/.mono/**"));
  assert.ok(
    specs.every((spec) => !spec.includes("export_presets.cfg")),
    "export_presets.cfg is ordinary tracked project source"
  );
});

test("a provisioned .godot link is never staged, as a directory or as a symlink blob", () => {
  // Precondition that makes this guard non-vacuous: .godot is neither tracked
  // nor gitignored in the fixture repo. Do NOT "simplify" this by adding a
  // .gitignore - git would then skip the path for reasons that have nothing to
  // do with the pathspec list under test, and the guard would pass forever.
  //
  // On win32 the link is a junction and git sees a directory, so the recursive
  // exclude was enough. On POSIX provisionWorktree calls symlinkSync(from, to,
  // "dir") and git stages a mode-120000 blob at path ".godot" whose CONTENT is
  // the absolute path of the user's real cache - which land then squash-merges
  // into their repository.
  const cwd = makeTempDir("grok-wt-linkspec-");
  const dataDir = makeTempDir("grok-wt-linkspec-data-");
  seedRepo(cwd);

  fs.mkdirSync(path.join(cwd, ".godot", "imported"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".godot", "imported", "blob.ctex"), "cache\n", "utf8");

  const created = createWorktree({ cwd, runId: "linkspec-1", dataDir });
  fs.symlinkSync(path.join(cwd, ".godot"), path.join(created.worktreePath, ".godot"), LINK_KIND);
  fs.writeFileSync(path.join(created.worktreePath, "src.txt"), "fix\n", "utf8");

  const committed = commitWorktreeChanges(created.worktreePath, "linked cache nearby");
  assert.equal(committed.committed, true);
  assert.equal(committed.error, undefined);

  const names = committedNames(created.worktreePath);
  assert.ok(names.includes("src.txt"));
  assert.ok(
    !names.some((name) => name === ".godot" || name.startsWith(".godot/")),
    `nothing named .godot may be committed, got: ${names.join(", ")}`
  );

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("Godot sidecars are committed as source while the import caches are not", () => {
  const cwd = makeTempDir("grok-wt-sidecar-");
  const dataDir = makeTempDir("grok-wt-sidecar-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "sidecar-1", dataDir });
  const wt = created.worktreePath;

  writeFileIn(wt, "assets/icon.png", "PNG\n");
  writeFileIn(wt, "assets/icon.png.import", '[remap]\nuid="uid://abc123"\n');
  writeFileIn(wt, "scripts/player.gd", "extends Node\n");
  writeFileIn(wt, "scripts/player.gd.uid", "uid://def456\n");
  writeFileIn(wt, ".import/cache/blob.md5", "deadbeef\n");
  writeFileIn(wt, ".godot/imported/blob.ctex", "cache\n");

  const committed = commitWorktreeChanges(wt, "godot sidecar matrix");
  assert.equal(committed.committed, true);

  const names = committedNames(wt);
  // The sidecars carry the uid:// every ext_resource in the project resolves
  // through; Godot 4.4 regenerates a missing .uid with a NEW random uid, so
  // losing them is not self-healing.
  assert.ok(names.includes("assets/icon.png.import"), names.join(", "));
  assert.ok(names.includes("scripts/player.gd.uid"), names.join(", "));
  assert.ok(names.includes("assets/icon.png"));
  assert.ok(names.includes("scripts/player.gd"));
  assert.ok(!names.some((name) => name.startsWith(".import/")), names.join(", "));
  assert.ok(!names.some((name) => name.startsWith(".godot/")), names.join(", "));

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("Blender save backups are excluded but the .blend scene itself is committed", () => {
  const cwd = makeTempDir("grok-wt-blend-");
  const dataDir = makeTempDir("grok-wt-blend-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "blend-1", dataDir });
  const wt = created.worktreePath;

  writeFileIn(wt, "scene.blend", "BLENDER\n");
  writeFileIn(wt, "scene.blend1", "prev\n");
  writeFileIn(wt, "scene.blend2", "prev-prev\n");
  // Save Versions goes to 32, so a two-digit backup is a normal state.
  writeFileIn(wt, "scene.blend17", "older\n");
  writeFileIn(wt, "addon.py", "import bpy\n");

  const committed = commitWorktreeChanges(wt, "blender backups nearby");
  assert.equal(committed.committed, true);

  const names = committedNames(wt);
  assert.ok(names.includes("addon.py"));
  assert.ok(names.includes("scene.blend"), "the scene file is source, not an artifact");
  assert.ok(
    names.every((name) => !/\.blend\d/.test(name)),
    `no numbered backup may be committed, got: ${names.join(", ")}`
  );

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("the run's own .grok-build scratch directory never reaches a commit", () => {
  // --blender-sandbox links the add-on to a path INSIDE the worktree. On win32
  // git walks a junction as an ordinary directory, so without the exclude the
  // commit would carry a second copy of the whole add-on; the real link is
  // exercised below, and a plain file covers the POSIX shape.
  const cwd = makeTempDir("grok-wt-scratch-");
  const dataDir = makeTempDir("grok-wt-scratch-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "scratch-1", dataDir });
  const wt = created.worktreePath;

  writeFileIn(wt, "myaddon/__init__.py", "bl_info = {}\n");
  writeFileIn(wt, ".grok-build/blender/scripts/marker", "sandbox\n");
  fs.mkdirSync(path.join(wt, ".grok-build", "blender", "scripts", "addons"), { recursive: true });
  fs.symlinkSync(
    path.join(wt, "myaddon"),
    path.join(wt, ".grok-build", "blender", "scripts", "addons", "myaddon"),
    LINK_KIND
  );
  // The project config file is a SIBLING with a longer name and is ordinary
  // tracked source: `**/.grok-build` must not match it.
  writeFileIn(wt, ".grok-build.json", '{"version": 1}\n');

  const committed = commitWorktreeChanges(wt, "sandbox nearby");
  assert.equal(committed.committed, true);

  const names = committedNames(wt);
  assert.ok(names.includes("myaddon/__init__.py"), names.join(", "));
  assert.ok(names.includes(".grok-build.json"), `the config file is source: ${names.join(", ")}`);
  assert.ok(
    !names.some((name) => name.startsWith(".grok-build/")),
    `nothing under the scratch directory may be committed, got: ${names.join(", ")}`
  );

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("machine-local Godot credentials never reach a commit", () => {
  const cwd = makeTempDir("grok-wt-creds-");
  const dataDir = makeTempDir("grok-wt-creds-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "creds-1", dataDir });
  const wt = created.worktreePath;

  // Godot 4.2+ moved keystore passwords and notarization credentials out of
  // export_presets.cfg into this machine-local sibling; a headless
  // --export-release run can generate one inside the worktree.
  writeFileIn(wt, "export_credentials.cfg", "[preset.0]\nkeystore/release_password=\"hunter2\"\n");
  writeFileIn(wt, ".mono/metadata.cfg", "mono build output\n");
  writeFileIn(wt, "scenes/main.tscn", "[gd_scene]\n");

  const committed = commitWorktreeChanges(wt, "credentials nearby");
  assert.equal(committed.committed, true);

  const names = committedNames(wt);
  assert.ok(names.includes("scenes/main.tscn"));
  assert.ok(!names.includes("export_credentials.cfg"), names.join(", "));
  assert.ok(!names.some((name) => name.startsWith(".mono/")), names.join(", "));

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("provisioned links are excluded by observation, not by name", () => {
  // .venv, venv and vendor are linked into every worktree by provision.mjs but
  // are deliberately absent from GENERATED_ARTIFACT_PATTERNS (Go projects
  // commit vendor/ on purpose). Without the symlink-derived excludes, the
  // pathspec add walked straight through the junction and staged the user's
  // entire real .venv on every isolated Python run.
  const cwd = makeTempDir("grok-wt-linkobs-");
  const dataDir = makeTempDir("grok-wt-linkobs-data-");
  seedRepo(cwd);

  fs.mkdirSync(path.join(cwd, ".venv", "Lib"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".venv", "Lib", "marker.txt"), "REAL VENV\n", "utf8");

  const created = createWorktree({ cwd, runId: "linkobs-1", dataDir });
  fs.symlinkSync(path.join(cwd, ".venv"), path.join(created.worktreePath, ".venv"), LINK_KIND);
  assert.equal(
    fs.existsSync(path.join(created.worktreePath, ".venv", "Lib", "marker.txt")),
    true,
    "the link must actually expose the real tree before the real test begins"
  );
  fs.writeFileSync(path.join(created.worktreePath, "src.txt"), "fix\n", "utf8");

  const committed = commitWorktreeChanges(created.worktreePath, "linked venv nearby");
  assert.equal(committed.committed, true);

  const names = committedNames(created.worktreePath);
  assert.ok(names.includes("src.txt"));
  assert.ok(
    !names.some((name) => name === ".venv" || name.startsWith(".venv/")),
    `nothing from the linked venv may be committed, got: ${names.join(", ")}`
  );

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("a rejected artifact-filtered add reports an error instead of staging everything", () => {
  // The old fallback was an unguarded `git add -A`, which stages precisely the
  // caches and linked-in real directories the pathspec list exists to keep
  // out - and land then squash-merges them into the user's repository. There
  // is no older-git retry available either: `:!` is just shorthand for
  // `:(exclude)` and needs the same pathspec magic.
  const cwd = makeTempDir("grok-wt-addfail-");
  const dataDir = makeTempDir("grok-wt-addfail-data-");
  const binDir = makeTempDir("grok-wt-addfail-bin-");
  seedRepo(cwd);

  fs.mkdirSync(path.join(cwd, ".godot", "imported"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".godot", "imported", "blob.ctex"), "cache\n", "utf8");
  fs.mkdirSync(path.join(cwd, ".venv", "Lib"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".venv", "Lib", "marker.txt"), "REAL VENV\n", "utf8");

  const created = createWorktree({ cwd, runId: "addfail-1", dataDir });
  fs.symlinkSync(path.join(cwd, ".godot"), path.join(created.worktreePath, ".godot"), LINK_KIND);
  fs.symlinkSync(path.join(cwd, ".venv"), path.join(created.worktreePath, ".venv"), LINK_KIND);
  fs.writeFileSync(path.join(created.worktreePath, "src.txt"), "fix\n", "utf8");

  const headBefore = run("git", ["rev-parse", "HEAD"], { cwd: created.worktreePath }).stdout.trim();

  installGitShim(binDir);
  let result;
  withPathPrefix(binDir, () => {
    assert.doesNotThrow(() => {
      result = commitWorktreeChanges(created.worktreePath, "add is going to fail");
    }, "a failed commit must never discard an otherwise complete run");
  });

  assert.equal(result.committed, false);
  assert.equal(typeof result.error, "string");
  assert.match(result.error, /git add failed/);
  assert.equal(result.sha, headBefore, "HEAD must not have moved");

  // Nothing anywhere in the branch's history mentions the linked directories.
  const log = run("git", ["log", "--name-only", "--pretty=format:"], { cwd: created.worktreePath });
  assert.equal(log.status, 0, log.stderr);
  assert.doesNotMatch(log.stdout, /\.godot/);
  assert.doesNotMatch(log.stdout, /\.venv/);

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("a Godot write run's manifest names the scene it changed and nothing from the cache", () => {
  // For a Godot or Blender project the artifact IS the deliverable, and the run
  // used to report only a worktree path - a user could not tell a run that
  // rebuilt a scene from one that produced nothing but an import cache.
  const cwd = makeTempDir("grok-wt-manifest-");
  const dataDir = makeTempDir("grok-wt-manifest-data-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "project.godot"), 'config_version=5\n');
  fs.mkdirSync(path.join(cwd, "assets"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "assets", "model.glb"), "glTF-v1\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const created = createWorktree({ cwd, runId: "manifest-1", dataDir });
  const wt = created.worktreePath;

  // What the agent did...
  writeFileIn(wt, "scenes/Player.tscn", '[gd_scene load_steps=1 format=3]\n');
  writeFileIn(wt, "assets/model.glb", "glTF-v2\n");
  // ...and what running the project did.
  writeFileIn(wt, ".godot/imported/model.glb-abc.scn", "cache\n");
  writeFileIn(wt, ".godot/uid_cache.bin", "uids\n");

  const committed = commitWorktreeChanges(wt, "godot manifest");
  assert.equal(committed.committed, true);

  const manifest = listCommittedChanges(wt, created.baseSha, committed.sha);
  assert.equal(manifest.error, undefined);
  assert.ok(manifest.entries.includes("A\tscenes/Player.tscn"), manifest.entries.join(" | "));
  assert.ok(manifest.entries.includes("M\tassets/model.glb"), manifest.entries.join(" | "));
  assert.ok(
    manifest.entries.every((entry) => !entry.includes(".godot/")),
    `the import cache is not the deliverable, got: ${manifest.entries.join(" | ")}`
  );
  assert.equal(manifest.total, 2);
  assert.equal(manifest.truncated, false);

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("listCommittedChanges is empty, not wrong, when there is no range to diff", () => {
  const cwd = makeTempDir("grok-wt-manifest-empty-");
  const dataDir = makeTempDir("grok-wt-manifest-empty-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "manifest-empty-1", dataDir });
  // The clean-tree case: commitWorktreeChanges returns {committed:false,
  // sha:HEAD}, so base and head are the same commit.
  const manifest = listCommittedChanges(created.worktreePath, created.baseSha, created.baseSha);
  assert.deepEqual(manifest, { entries: [], total: 0, truncated: false });

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("listCommittedChanges reports a diff failure rather than claiming nothing changed", () => {
  const cwd = makeTempDir("grok-wt-manifest-fail-");
  const dataDir = makeTempDir("grok-wt-manifest-fail-data-");
  seedRepo(cwd);

  const created = createWorktree({ cwd, runId: "manifest-fail-1", dataDir });
  // A sha that does not exist. An empty manifest here would be a claim about
  // the run; the error is a claim about the measurement.
  const manifest = listCommittedChanges(created.worktreePath, created.baseSha, "0".repeat(40));
  assert.deepEqual(manifest.entries, []);
  assert.match(manifest.error ?? "", /git diff failed/);

  removeWorktree({
    repoRoot: created.repoRoot,
    worktreePath: created.worktreePath,
    branchName: created.branchName
  });
});

test("capChangedFiles caps by entry count and, independently, by bytes", () => {
  // Both caps are needed: a Godot re-import trips the entry count, and a
  // handful of deeply nested Blender asset paths trips the byte budget first.
  const many = Array.from({ length: 500 }, (_, index) => `A\tsrc/file_${index}.gd`);
  const byCount = capChangedFiles(many);
  assert.equal(byCount.entries.length, CHANGED_FILES_MAX_ENTRIES);
  assert.equal(byCount.total, 500);
  assert.equal(byCount.truncated, true);

  const long = Array.from({ length: 50 }, (_, index) => `M\t${"collections/".repeat(40)}asset_${index}.blend`);
  const byBytes = capChangedFiles(long, { maxBytes: 2048 });
  assert.ok(byBytes.entries.length < 50, `expected a byte-capped list, got ${byBytes.entries.length}`);
  assert.ok(byBytes.entries.length > 0, "the byte cap must never produce an empty manifest from a non-empty one");
  assert.equal(byBytes.total, 50);
  assert.equal(byBytes.truncated, true);

  // A single entry larger than the whole budget is still reported: an empty
  // manifest would read as "nothing changed".
  const huge = capChangedFiles([`A\t${"x".repeat(5000)}.blend`], { maxBytes: 128 });
  assert.equal(huge.entries.length, 1);
  assert.equal(huge.truncated, false);

  assert.deepEqual(capChangedFiles([]), { entries: [], total: 0, truncated: false });
});

test("a gitignored provisioned link gets no exclude pathspec, so git add succeeds", () => {
  // Regression: `git add -A -- . :(exclude,glob)target` exits 1 with
  // "The following paths are ignored by one of your .gitignore files: target"
  // whenever a pathspec names an ignored path - even an exclude one. Every
  // provisioned link is exactly such a path (target, node_modules, .venv), so
  // the commit died on any isolated run that had work to stage. Measured: 22
  // files of finished work reported as `changed files: none`.
  const repo = makeTempDir("ignored-link");
  const g = (args, cwd = repo) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  g(["init", "-q"]);
  g(["config", "user.email", "t@example.test"]);
  g(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(repo, ".gitignore"), "target/\n");
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "base"]);
  const baseSha = g(["rev-parse", "HEAD"]);

  // The link the provisioner would create, pointing at a real directory.
  const linkTarget = makeTempDir("real-target");
  fs.writeFileSync(path.join(linkTarget, "artifact.bin"), "built\n");
  try {
    fs.symlinkSync(linkTarget, path.join(repo, "target"), "junction");
  } catch {
    // Symlink creation can be denied on an unprivileged Windows box without
    // developer mode. The bug needs a link to reproduce, so skip rather than
    // assert something the environment cannot show.
    return;
  }

  // The agent's work, alongside the link.
  fs.writeFileSync(path.join(repo, "work.txt"), "real work\n");

  const committed = commitWorktreeChanges(repo, "run under test");
  assert.equal(committed.committed, true, `commit failed: ${committed.error ?? "(no error)"}`);
  assert.equal(committed.error, undefined);

  const listed = listCommittedChanges(repo, baseSha, committed.sha);
  assert.equal(listed.total, 1);
  assert.ok(listed.entries[0].endsWith("work.txt"));

  // The link's contents must never reach the commit.
  const names = spawnSync("git", ["show", "--name-only", "--format=", committed.sha], {
    cwd: repo,
    encoding: "utf8"
  }).stdout;
  assert.doesNotMatch(names, /artifact\.bin/);
});
