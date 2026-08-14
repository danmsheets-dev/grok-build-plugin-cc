import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHeadlessArgs,
  buildWorkspaceRootDenyRules,
  cliSupportsConfine,
  confineFeatureEnabled,
  normalizePathForPermissionRule,
  pathIsInsideOrEqual,
  worktreeContainsSegment
} from "../plugins/turbo-build-plugin/scripts/lib/grok.mjs";
import {
  classifyJobLiveness,
  reconcileAbandonedJob,
  shouldReconcileAbandoned
} from "../plugins/turbo-build-plugin/scripts/lib/job-control.mjs";
import { resolveIsolateSetting } from "../plugins/turbo-build-plugin/scripts/lib/project-config.mjs";
import { terminateProcessTree } from "../plugins/turbo-build-plugin/scripts/lib/process.mjs";
import { decideCompletionStatus } from "../plugins/turbo-build-plugin/scripts/lib/tracked-jobs.mjs";
import {
  allowNoIsolateFromEnv,
  detectCaller
} from "../plugins/turbo-build-plugin/scripts/lib/workspace.mjs";
import {
  collectWorktreeReparsePaths,
  createWorktree,
  linkExcludePathspecs,
  reconcileOrphanWorktrees,
  removeDirectoryTree,
  removeWorktree,
  resolveWorktreePath,
  shortWorktreeId,
  toWin32LongPath
} from "../plugins/turbo-build-plugin/scripts/lib/worktree.mjs";
import {
  formatIsolationHeaderLine,
  loadRunRules,
  runHeadlessAgentWithDurationBudget
} from "../plugins/turbo-build-plugin/scripts/grok-bridge.mjs";
import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  claimJobTerminal,
  generateJobId,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/turbo-build-plugin/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "turbo-build-plugin");
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

/* -------------------------------------------------------------------------
 * detectCaller / forced isolation
 * ---------------------------------------------------------------------- */

test("detectCaller recognizes Claude Code env markers and --caller", () => {
  assert.deepEqual(detectCaller({}), { programmatic: false, source: null });
  assert.equal(detectCaller({ CLAUDECODE: "1" }).programmatic, true);
  assert.match(detectCaller({ CLAUDECODE: "1" }).source, /CLAUDECODE/);
  assert.equal(detectCaller({ CLAUDE_CODE_ENTRYPOINT: "cli" }).programmatic, true);
  assert.equal(detectCaller({ CLAUDE_PLUGIN_ROOT: "/plugins/grok" }).programmatic, true);
  assert.equal(detectCaller({ GROK_BUILD_CALLER: "ci" }).programmatic, true);
  assert.equal(detectCaller({}, { caller: "agent-x" }).source, "cli:agent-x");
});

test("allowNoIsolateFromEnv only accepts explicit opt-in values", () => {
  assert.equal(allowNoIsolateFromEnv({}), false);
  assert.equal(allowNoIsolateFromEnv({ GROK_BUILD_ALLOW_NO_ISOLATE: "1" }), true);
  assert.equal(allowNoIsolateFromEnv({ GROK_BUILD_ALLOW_NO_ISOLATE: "true" }), true);
  assert.equal(allowNoIsolateFromEnv({ GROK_BUILD_ALLOW_NO_ISOLATE: "yes" }), false);
});

test("resolveIsolateSetting forced-programmatic refusal path", () => {
  assert.throws(
    () =>
      resolveIsolateSetting({
        write: true,
        programmatic: true,
        cliNoIsolate: true,
        allowNoIsolate: false
      }),
    /require isolation/
  );
});

/* -------------------------------------------------------------------------
 * Deny rules + self-denying guard
 * ---------------------------------------------------------------------- */

test("buildWorkspaceRootDenyRules emits Edit/Write with forward slashes", () => {
  const plan = buildWorkspaceRootDenyRules("C:\\Users\\me\\repo", "C:\\Users\\me\\wt");
  assert.equal(plan.skipped, false);
  assert.deepEqual(plan.rules, [
    "Edit(C:/Users/me/repo/**)",
    "Write(C:/Users/me/repo/**)"
  ]);
});

test("buildWorkspaceRootDenyRules skips when worktree is inside workspace root", () => {
  const plan = buildWorkspaceRootDenyRules("/home/me/repo", "/home/me/repo/.worktrees/run-1");
  assert.equal(plan.skipped, true);
  assert.equal(plan.reason, "worktree-inside-workspace-root");
  assert.deepEqual(plan.rules, []);
});

test("path helpers normalise and nest-check", () => {
  assert.equal(normalizePathForPermissionRule("C:\\a\\b\\"), "C:/a/b");
  assert.equal(pathIsInsideOrEqual("/a/b", "/a/b/c"), true);
  assert.equal(pathIsInsideOrEqual("/a/b", "/a/other"), false);
});

test("buildHeadlessArgs repeats --deny and optional --confine", () => {
  const args = buildHeadlessArgs("hi", {
    alwaysApprove: true,
    denyRules: ["Edit(/main/**)", "Write(/main/**)"],
    confine: "/wt/path",
    platform: "linux",
    argvBudget: 100_000
  });
  assert.ok(args.includes("--always-approve"));
  const denyIdx = args.indexOf("--deny");
  assert.ok(denyIdx !== -1);
  assert.equal(args[denyIdx + 1], "Edit(/main/**)");
  assert.ok(args.includes("--confine"));
  assert.ok(args.includes("/wt/path"));
});

test("cliSupportsConfine probes --help once and caches", () => {
  const cache = new Map();
  let calls = 0;
  const runCommandImpl = () => {
    calls += 1;
    return { status: 0, stdout: "Usage: grok --confine <path>\n", stderr: "", error: null };
  };
  assert.equal(cliSupportsConfine("fake-grok", { runCommandImpl, cache }), true);
  assert.equal(cliSupportsConfine("fake-grok", { runCommandImpl, cache }), true);
  // Identity probe (version --json) then --help; the pair is cached.
  assert.ok(calls >= 1 && calls <= 2);
  assert.equal(confineFeatureEnabled({}), true);
  assert.equal(confineFeatureEnabled({ GROK_BUILD_CONFINE: "0" }), false);
});

/* -------------------------------------------------------------------------
 * Isolation prompt + header
 * ---------------------------------------------------------------------- */

test("loadRunRules appends isolation preamble only for isolated runs", () => {
  const plain = loadRunRules({ isolated: false });
  assert.match(plain, /GROK-FINAL-REPORT/);
  // HYPER-1: headless discipline is on every run, not only isolated ones.
  assert.match(plain, /non-interactive/i);
  assert.doesNotMatch(plain, /only writable root/);

  const isolated = loadRunRules({
    isolated: true,
    worktreePath: "/tmp/wt/run-1",
    workspaceRoot: "/home/me/repo"
  });
  assert.match(isolated, /GROK-FINAL-REPORT/);
  assert.match(isolated, /non-interactive/i);
  assert.match(isolated, /only writable root/);
  assert.match(isolated, /\/tmp\/wt\/run-1/);
  assert.match(isolated, /\/home\/me\/repo/);
});

test("formatIsolationHeaderLine names ACTIVE/INACTIVE and source", () => {
  assert.match(
    formatIsolationHeaderLine({
      active: true,
      worktreePath: "/wt",
      branch: "turbo-build/r1",
      baseSha: "abcdef123456",
      source: "forced-programmatic"
    }),
    /Isolation: ACTIVE \(worktree \/wt, branch grok-build\/r1, base abcdef1\) \[forced-programmatic\]/
  );
  assert.match(
    formatIsolationHeaderLine({
      active: false,
      workspaceRoot: "/repo",
      source: "cli"
    }),
    /Isolation: INACTIVE \(writing directly to \/repo\) \[cli\]/
  );
});

/* -------------------------------------------------------------------------
 * Breach status
 * ---------------------------------------------------------------------- */

test("decideCompletionStatus returns isolation-breached ahead of completed", () => {
  assert.equal(
    decideCompletionStatus({
      exitStatus: 0,
      stopReason: "EndTurn",
      toolCallCount: 3,
      changedFileCount: 2,
      write: true,
      verified: true,
      isolationBreached: true
    }),
    "isolation-breached"
  );
});

test("isolated run that writes into the main checkout is isolation-breached", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir, "writes-files");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  const leakPath = path.join(repo, "leaked-from-agent.txt");
  const result = withPluginData(pluginDataDir, () =>
    run("node", [SCRIPT, "run", "--write", "--no-verify", "--json", "touch a file"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, {
        // Force programmatic so isolation is on; write relative files into the
        // worktree AND leak an absolute path into the main checkout.
        CLAUDECODE: "1",
        FAKE_GROK_WRITE_FILES: JSON.stringify({ "inside-worktree.txt": "ok\n" }),
        FAKE_GROK_WRITE_ABSOLUTE: JSON.stringify({ [leakPath]: "leaked\n" })
      }),
      timeout: 60_000
    })
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  // Job record should be isolation-breached
  const jobs = withPluginData(pluginDataDir, () => listJobs(repo));
  assert.ok(jobs.length >= 1, "expected a job record");
  const job = jobs[0];
  assert.equal(job.status, "isolation-breached", JSON.stringify(job, null, 2));
  assert.ok(fs.existsSync(leakPath), "leak file should exist in main tree");
  assert.match(result.stdout + result.stderr, /[Bb]reach|wrong tree|main checkout/i);
});

test("isolated clean write run is not a breach", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir, "writes-files");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  const result = withPluginData(pluginDataDir, () =>
    run("node", [SCRIPT, "run", "--write", "--no-verify", "--json", "edit inside worktree only"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, {
        CLAUDECODE: "1",
        FAKE_GROK_WRITE_FILES: JSON.stringify({ "only-in-worktree.txt": "ok\n" })
      }),
      timeout: 60_000
    })
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jobs = withPluginData(pluginDataDir, () => listJobs(repo));
  assert.ok(jobs.length >= 1);
  assert.notEqual(jobs[0].status, "isolation-breached");
});

/* -------------------------------------------------------------------------
 * WP-B7-FIX: blocked confine attempt ≠ isolation breach
 * ---------------------------------------------------------------------- */

test("blocked confine attempts alone are not a breach and remain landable (WP-B7-FIX)", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir, "writes-files");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  // Shape seen on a real run: path holds a compound shell line whose cd target
  // is the confine root itself — CLI blocked it, main tree stayed clean.
  const confineViolations = [
    {
      tool: "run_terminal_command",
      path: 'cd "H:\\\\gb-work\\\\gb\\\\w\\\\d52412a3" ; git show HEAD --stat',
      resolvedPath: 'cd "H:\\\\gb-work\\\\gb\\\\w\\\\d52412a3" ; git show HEAD --stat',
      root: "H:\\\\gb-work\\\\gb\\\\w\\\\d52412a3"
    }
  ];

  const result = withPluginData(pluginDataDir, () =>
    run("node", [SCRIPT, "run", "--write", "--no-verify", "--json", "edit inside worktree only"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, {
        CLAUDECODE: "1",
        FAKE_GROK_WRITE_FILES: JSON.stringify({ "only-in-worktree.txt": "ok\n" }),
        FAKE_GROK_CONFINE_VIOLATIONS: JSON.stringify(confineViolations)
      }),
      timeout: 60_000
    })
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(combined, /confine attempt(?:s)? blocked by the CLI \(isolation held\)/i);
  assert.doesNotMatch(combined, /Isolation BREACHED/i);

  const jobs = withPluginData(pluginDataDir, () => listJobs(repo));
  assert.ok(jobs.length >= 1, "expected a job record");
  const job = jobs[0];
  assert.notEqual(job.status, "isolation-breached", JSON.stringify(job, null, 2));
  assert.ok(!job.isolationBreached, "index must not mark blocked attempts as breached");
  assert.ok(!job.isolation?.breached);

  // Full job file (index omits result.*) must record the blocked attempts.
  const stored = withPluginData(pluginDataDir, () =>
    readJobFile(resolveJobFile(repo, job.id))
  );
  assert.ok(!stored.isolationBreached);
  assert.ok(!stored.isolation?.breached);
  const violations = stored.result?.confineViolations ?? stored.confineViolations ?? [];
  assert.ok(Array.isArray(violations) && violations.length >= 1, "blocked attempts must be recorded");
  assert.equal(violations[0].tool, "run_terminal_command");

  // Land must accept a clean main tree even when the CLI blocked attempts.
  const land = withPluginData(pluginDataDir, () =>
    run("node", [SCRIPT, "land", job.id, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir),
      timeout: 60_000
    })
  );
  assert.equal(land.status, 0, land.stderr || land.stdout);
  assert.doesNotMatch(`${land.stderr}\n${land.stdout}`, /Refusing to land|isolation was breached/i);
});

test("blocked confine attempts plus dirty main checkout is still a breach (WP-B7-FIX)", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir, "writes-files");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  const leakPath = path.join(repo, "leaked-with-block.txt");
  const result = withPluginData(pluginDataDir, () =>
    run("node", [SCRIPT, "run", "--write", "--no-verify", "--json", "touch a file"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, {
        CLAUDECODE: "1",
        FAKE_GROK_WRITE_FILES: JSON.stringify({ "inside-worktree.txt": "ok\n" }),
        FAKE_GROK_WRITE_ABSOLUTE: JSON.stringify({ [leakPath]: "leaked\n" }),
        FAKE_GROK_CONFINE_VIOLATIONS: JSON.stringify([
          { tool: "Write", path: "escape.txt", resolvedPath: leakPath, root: "/wt" }
        ])
      }),
      timeout: 60_000
    })
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jobs = withPluginData(pluginDataDir, () => listJobs(repo));
  assert.ok(jobs.length >= 1);
  const job = jobs[0];
  assert.equal(job.status, "isolation-breached", JSON.stringify(job, null, 2));
  assert.equal(job.isolationBreached, true);
  assert.match(`${result.stdout}\n${result.stderr}`, /Isolation BREACHED|main checkout/i);

  // Land still refuses on the strength of the dirty main tree.
  const land = withPluginData(pluginDataDir, () =>
    run("node", [SCRIPT, "land", job.id, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir),
      timeout: 60_000
    })
  );
  assert.notEqual(land.status, 0, land.stdout);
  assert.match(`${land.stderr}\n${land.stdout}`, /Refusing to land|isolation was breached/i);
});

test("programmatic --no-isolate is refused without escape hatch", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run(
    "node",
    [SCRIPT, "run", "--write", "--no-isolate", "--no-verify", "should fail"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { CLAUDECODE: "1" })
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /require isolation|Programmatic write/i);
});

/* -------------------------------------------------------------------------
 * Short worktree paths + long-path removal
 * ---------------------------------------------------------------------- */

test("resolveWorktreePath uses same volume as repo on win32 (not TEMP)", () => {
  const short = resolveWorktreePath("run-ms7longid-abc", {
    platform: "win32",
    env: { TEMP: "C:\\Users\\me\\AppData\\Local\\Temp" },
    repoRoot: "H:\\Apps\\MyRepo"
  });
  assert.equal(
    short,
    path.join("H:\\", "gb", "w", shortWorktreeId("run-ms7longid-abc"))
  );
  assert.equal(shortWorktreeId("run-ms7longid-abc").length, 8);
});

test("resolveWorktreePath honours GROK_BUILD_WORKTREE_ROOT", () => {
  const root = "D:\\custom\\wt-root";
  const resolved = resolveWorktreePath("run-y", {
    platform: "win32",
    env: { GROK_BUILD_WORKTREE_ROOT: root, TEMP: "C:\\Temp" },
    repoRoot: "H:\\repo"
  });
  assert.equal(resolved, path.join(root, shortWorktreeId("run-y")));
});

test("resolveWorktreePath still honours explicit dataDir", () => {
  const dataDir = makeTempDir();
  assert.equal(
    resolveWorktreePath("run-x", { dataDir, platform: "win32" }),
    path.join(dataDir, "worktrees", "run-x")
  );
});

test("toWin32LongPath prefixes extended length form", () => {
  if (process.platform !== "win32") {
    assert.equal(toWin32LongPath("/tmp/a"), path.resolve("/tmp/a"));
    return;
  }
  const p = path.resolve("C:\\temp\\deep");
  assert.ok(toWin32LongPath(p).startsWith("\\\\?\\"));
});

test("removeDirectoryTree reports failure when still present", () => {
  const dir = makeTempDir();
  const nested = path.join(dir, "keep");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, "f.txt"), "x");

  let attempts = 0;
  const result = removeDirectoryTree(nested, {
    platform: "win32",
    rmSyncImpl: () => {
      attempts += 1;
      throw new Error("Filename too long");
    },
    existsImpl: () => true
  });
  assert.equal(result.deleted, false);
  assert.match(result.errorText, /Filename too long/);
  assert.ok(attempts >= 2, "should retry via long-path form on win32");
});

test("removeWorktree returns orphanedPath when directory survives", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "a"], { cwd: repo });

  // Fake a leftover directory that git cannot remove.
  const orphan = path.join(makeTempDir(), "orphan-wt");
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "x.txt"), "x");

  const outcome = removeWorktree({
    repoRoot: repo,
    worktreePath: orphan,
    branchName: null,
    deleteBranch: false,
    platform: "win32",
    rmSyncImpl: () => {
      throw new Error("Filename too long");
    },
    existsImpl: (p) => p === orphan || fs.existsSync(p)
  });
  // existsImpl always true for orphan → removed false
  assert.equal(outcome.removed, false);
  assert.equal(outcome.orphanedPath, orphan);
  assert.match(outcome.reason, /still exists/i);
});

/* -------------------------------------------------------------------------
 * R7-1: land refuses a breached run
 * R6-1: read-only runs are isolated
 * R6-2: isolation survives terminal cleanup
 * R6-3: state dir resolves to root repo from a worktree
 * R6-7: orphan reconciler
 * ---------------------------------------------------------------------- */

test("land refuses a breached isolation-breached run (R7-1)", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const dataDir = path.join(pluginDataDir, "wt-data");
    const created = createWorktree({ cwd: repo, runId: jobId, dataDir });
    fs.writeFileSync(path.join(created.worktreePath, "only-wt.txt"), "half\n");
    run("git", ["add", "only-wt.txt"], { cwd: created.worktreePath });
    run("git", ["commit", "-m", "partial"], { cwd: created.worktreePath });

    const job = {
      id: jobId,
      kind: "task",
      status: "isolation-breached",
      phase: "isolation-breached",
      write: true,
      isolationBreached: true,
      isolation: {
        active: true,
        worktree: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha,
        breached: true,
        source: "forced-programmatic"
      },
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha,
        breached: true,
        worktreeFiles: ["A\tonly-wt.txt"],
        mainTreeFiles: ["A\tleaked.txt"]
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);

    const result = run("node", [SCRIPT, "land", jobId, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.notEqual(result.status, 0, result.stdout);
    const combined = `${result.stderr}\n${result.stdout}`;
    assert.match(combined, /Refusing to land|isolation was breached|split/i);
    assert.match(combined, /only-wt|In the worktree/i);
    assert.match(combined, /leaked|main checkout/i);
    assert.match(combined, /--discard/i);
    // Worktree must still exist — refuse means do not land or destroy.
    assert.equal(fs.existsSync(created.worktreePath), true);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("read-only run is isolated in a worktree (R6-1)", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  const result = withPluginData(pluginDataDir, () =>
    run("node", [SCRIPT, "run", "--no-verify", "--json", "review the code"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir),
      timeout: 60_000
    })
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const jobs = withPluginData(pluginDataDir, () => listJobs(repo));
  assert.ok(jobs.length >= 1, "expected a job record");
  const job = jobs[0];
  const stored = withPluginData(pluginDataDir, () => readJobFile(resolveJobFile(repo, job.id)));
  // Isolation active: worktree path was recorded (may still exist or be cleaned).
  const iso = stored.isolation ?? job.isolation;
  assert.ok(iso?.active || stored.worktree?.path || job.worktree?.path, JSON.stringify(stored, null, 2));
  assert.ok(
    iso?.source === "read-only-default" || iso?.source === "cli" || iso?.source === "config",
    `unexpected isolate source: ${iso?.source}`
  );
});

test("isolation fact survives in a terminal record after land discard (R6-2)", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const dataDir = path.join(pluginDataDir, "wt-data");
    const created = createWorktree({ cwd: repo, runId: jobId, dataDir });
    const job = {
      id: jobId,
      kind: "task",
      status: "completed",
      phase: "done",
      write: true,
      isolateSource: "forced-programmatic",
      isolation: {
        active: true,
        worktree: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha,
        breached: false,
        source: "forced-programmatic"
      },
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

    const result = run("node", [SCRIPT, "land", jobId, "--discard", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const stored = readJobFile(resolveJobFile(repo, jobId));
    assert.equal(stored.worktree, null, "worktree path cleared after discard");
    assert.ok(stored.isolation, "isolation object must survive");
    assert.equal(stored.isolation.active, true);
    assert.equal(stored.isolation.worktree, created.worktreePath);
    assert.equal(stored.isolation.branch, created.branchName);
    assert.equal(stored.isolation.source, "forced-programmatic");
    assert.equal(stored.isolation.breached, false);

    // show --json / runs surface must keep the isolation fact after cleanup.
    const show = run("node", [SCRIPT, "show", jobId, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(show.status, 0, show.stderr || show.stdout);
    const payload = JSON.parse(show.stdout);
    const isolation = payload.isolation ?? payload.job?.isolation ?? payload.manifest?.isolation;
    assert.ok(isolation, `expected isolation on show payload: ${JSON.stringify(payload).slice(0, 500)}`);
    assert.equal(isolation.active, true);
    assert.equal(isolation.worktree, created.worktreePath);
    assert.equal(isolation.source, "forced-programmatic");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("state dir resolves to root repo from inside a worktree (R6-3)", () => {
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const dataDir = path.join(pluginDataDir, "wt-data");
    const created = createWorktree({ cwd: repo, runId: "state-dir-1", dataDir });

    const fromMain = resolveStateDir(repo);
    const fromWorktree = resolveStateDir(created.worktreePath);
    assert.equal(
      fromMain,
      fromWorktree,
      `state dir must be identical from main (${fromMain}) and worktree (${fromWorktree})`
    );

    // Write a job from the worktree cwd and list it from main.
    const jobId = generateJobId("run");
    writeJobFile(created.worktreePath, jobId, {
      id: jobId,
      status: "completed",
      summary: "from-worktree"
    });
    upsertJob(created.worktreePath, { id: jobId, status: "completed", summary: "from-worktree" });

    const jobs = listJobs(repo);
    assert.ok(
      jobs.some((j) => j.id === jobId),
      `main listJobs must see job written from worktree: ${jobs.map((j) => j.id).join(",")}`
    );
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("orphan reconciler finds a directory with no job record (R6-7)", () => {
  const root = makeTempDir("grok-orphan-root-");
  const known = path.join(root, "known-wt");
  const orphan = path.join(root, "orphan-wt");
  fs.mkdirSync(known, { recursive: true });
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "leftover.txt"), "x\n");

  const result = reconcileOrphanWorktrees({
    worktreeRoot: root,
    knownPaths: [known],
    repoRoot: null,
    // Avoid git status on non-repos: treat as no uncommitted work for this unit test.
    gitImpl: () => ({ status: 0, stdout: "", stderr: "", error: null })
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.orphans.length, 1);
  assert.equal(path.resolve(result.orphans[0].path), path.resolve(orphan));
  assert.equal(result.orphans[0].hasUncommittedWork, false);
  assert.match(result.orphans[0].detail, /no job record/i);
});

/* -------------------------------------------------------------------------
 * terminateProcessTree never throws; win32 escalation
 * ---------------------------------------------------------------------- */

test("max-duration returns after a bounded kill wait and reports a surviving tree", async () => {
  let terminated = false;
  const started = Date.now();
  const outcome = await runHeadlessAgentWithDurationBudget(
    "/tmp/worktree",
    { onProgress() {} },
    0.01,
    {
      runAgentImpl: (_cwd, options) => {
        options.onProgress?.({ agentPid: 12345 });
        return new Promise(() => {});
      },
      terminateProcessTreeImpl: () => {
        terminated = true;
        return { attempted: true, delivered: false, method: "test-kill" };
      },
      terminationGraceMs: 25
    }
  );
  assert.equal(outcome.timedOut, true);
  assert.equal(terminated, true);
  assert.equal(outcome.termination.treeOutlivedKill, true);
  assert.ok(Date.now() - started < 1000, "duration watchdog must not await the agent forever");
  assert.match(outcome.result.stderr, /could not be terminated|still running/i);
});

test("max-duration uses fallback pids when agentPid never arrives (C23)", async () => {
  const killed = [];
  const outcome = await runHeadlessAgentWithDurationBudget(
    "/tmp/worktree",
    { onProgress() {} },
    0.01,
    {
      runAgentImpl: () => new Promise(() => {}),
      getFallbackPids: () => [4242],
      terminateProcessTreeImpl: (pid) => {
        killed.push(pid);
        return { attempted: true, delivered: true, method: "test-kill" };
      },
      terminationGraceMs: 25
    }
  );
  assert.equal(outcome.timedOut, true);
  assert.deepEqual(killed, [4242]);
  assert.ok(outcome.termination.attempted);
});

test("terminateProcessTree never throws on taskkill failure", () => {
  const calls = [];
  let alive = true;
  const outcome = terminateProcessTree(33740, {
    platform: "win32",
    settleMs: 0,
    isAliveImpl: () => alive,
    runCommandImpl(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "taskkill") {
        return {
          command,
          args,
          status: 1,
          signal: null,
          stdout: "",
          stderr:
            "ERROR: The process with PID 33740 (child process of PID 27808) could not be terminated.\nReason: The operation attempted is not supported.",
          error: null
        };
      }
      if (command === "powershell" && String(args ?? "").includes("Stop-Process")) {
        // Escalation kill — not the pre-taskkill CIM snapshot.
        alive = false;
        return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
      }
      return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true);
  assert.match(outcome.method, /taskkill/);
  assert.match(outcome.method, /stop-process/);
  assert.ok(calls.some((c) => c.command === "taskkill"));
  assert.ok(calls.some((c) => c.command === "powershell"));
});

test("terminateProcessTree reports survivors when process stays alive", () => {
  const outcome = terminateProcessTree(42, {
    platform: "win32",
    settleMs: 0,
    isAliveImpl: () => true,
    runCommandImpl(command, args) {
      if (command === "taskkill") {
        return {
          command,
          args,
          status: 1,
          signal: null,
          stdout: "",
          stderr: "could not be terminated",
          error: null
        };
      }
      if (command === "powershell" && String(args).includes("Get-CimInstance")) {
        return { command, args, status: 0, signal: null, stdout: "99,88", stderr: "", error: null };
      }
      return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    }
  });

  assert.equal(outcome.delivered, false);
  assert.deepEqual(outcome.survivors, [42]);
  assert.ok(outcome.errorText);
});

/* -------------------------------------------------------------------------
 * Status reconciliation
 * ---------------------------------------------------------------------- */

test("shouldReconcileAbandoned requires dead process past grace", () => {
  const job = {
    status: "running",
    agentPid: 999001,
    lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString()
  };
  assert.equal(
    shouldReconcileAbandoned(job, {
      graceMs: 15_000,
      killImpl: () => {
        const err = new Error("gone");
        err.code = "ESRCH";
        throw err;
      }
    }),
    true
  );
  assert.equal(
    shouldReconcileAbandoned(
      { ...job, lastHeartbeatAt: new Date().toISOString() },
      {
        graceMs: 15_000,
        killImpl: () => {
          const err = new Error("gone");
          err.code = "ESRCH";
          throw err;
        }
      }
    ),
    false
  );
});

test("reconcileAbandonedJob claims failed with the fixed error message", () => {
  const pluginDataDir = makeTempDir();
  const workspace = makeTempDir();
  withPluginData(pluginDataDir, () => {
    const jobId = generateJobId("rec");
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "abandoned",
      agentPid: 999002,
      bridgePid: 999003,
      lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString()
    };
    writeJobFile(workspace, jobId, job);
    upsertJob(workspace, job);

    const result = reconcileAbandonedJob(workspace, job, {
      claimImpl: claimJobTerminal,
      killImpl: () => {
        const err = new Error("gone");
        err.code = "ESRCH";
        throw err;
      },
      graceMs: 1000
    });
    assert.ok(result);
    assert.equal(result.claimed, true);
    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.status, "failed");
    assert.match(stored.errorMessage, /process exited without a terminal claim|abandoned/i);
  });
});

/* -------------------------------------------------------------------------
 * wait subcommand
 * ---------------------------------------------------------------------- */

test("wait subcommand times out on a still-running job", async () => {
  const pluginDataDir = makeTempDir();
  const binDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  await withPluginData(pluginDataDir, async () => {
    const jobId = generateJobId("wait");
    // Alive PID = this process, so reconciliation will not claim it dead.
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "still going",
      jobClass: "task",
      agentPid: process.pid,
      bridgePid: process.pid,
      lastHeartbeatAt: new Date().toISOString(),
      startedAt: new Date().toISOString()
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);

    const result = run("node", [SCRIPT, "wait", jobId, "--timeout", "0", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    // timeout 0 → immediate timeout
    assert.notEqual(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.waitTimedOut ?? payload.timedOut, true);
  });
});

test("classifyJobLiveness marks dead active jobs abandoned", () => {
  const liveness = classifyJobLiveness(
    { status: "running", agentPid: 1 },
    {
      killImpl: () => {
        const err = new Error("gone");
        err.code = "ESRCH";
        throw err;
      }
    }
  );
  assert.equal(liveness.abandoned, true);
  assert.equal(liveness.alive, false);
});

// --- Segment-anchored deny rules: the `../` traversal escape ---
//
// Reproduced against hyper 0.2.114-r5 on Windows and confirmed with `ls`:
// `<worktree>/../Main Repo/x.txt` WROTE into the protected checkout, because a
// deny glob is matched against the model's literal path string with no
// canonicalisation. The segment-anchored rule closes that specific form; the
// 8.3 short-name form (`MAINRE~1`) is NOT closable by any glob and needs the
// Hyper-side canonicalisation fix, which is why the breach detector stays.

test("segment-anchored deny rules are added when the repo name is safe", () => {
  const plan = buildWorkspaceRootDenyRules("C:/work/Main Repo", "C:/tmp/gb/w/abc123", {
    segmentSafe: true
  });
  assert.equal(plan.skipped, false);
  assert.equal(plan.segmentRuleApplied, true);
  for (const tool of ["Edit", "Write"]) {
    assert.ok(plan.rules.includes(`${tool}(C:/work/Main Repo/**)`), `absolute ${tool}`);
    assert.ok(plan.rules.includes(`${tool}(**/Main Repo/**)`), `segment ${tool}`);
  }
});

test("segment-anchored deny rules are omitted when the name occurs in the worktree", () => {
  // A repository called `src` would otherwise deny <worktree>/src/** and break
  // the run's own writable root.
  const plan = buildWorkspaceRootDenyRules("C:/work/src", "C:/tmp/gb/w/abc123", {
    segmentSafe: false
  });
  assert.equal(plan.segmentRuleApplied, false);
  assert.equal(plan.rules.length, 2);
  assert.ok(plan.rules.every((rule) => !rule.includes("**/src/**")));
});

test("segment-anchored rules are skipped for a drive root or a one-character name", () => {
  assert.equal(
    buildWorkspaceRootDenyRules("C:", "C:/tmp/wt", { segmentSafe: true }).segmentRuleApplied,
    false
  );
  assert.equal(
    buildWorkspaceRootDenyRules("C:/work/x", "C:/tmp/wt", { segmentSafe: true }).segmentRuleApplied,
    false
  );
});

test("collectWorktreeReparsePaths finds nested junctions (C18)", () => {
  const root = makeTempDir("reparse-root-");
  const nested = path.join(root, "game");
  fs.mkdirSync(nested, { recursive: true });
  const target = makeTempDir("reparse-target-");
  // Prefer symlink; on win32 without privilege this may fail — skip then.
  try {
    fs.symlinkSync(target, path.join(nested, "vendor"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    // Junctions need privileges on some Windows setups.
    return;
  }
  const found = collectWorktreeReparsePaths(root);
  assert.ok(
    found.some((p) => p === "game/vendor" || p.endsWith("game/vendor")),
    `expected nested reparse, got ${JSON.stringify(found)}`
  );
  const excludes = linkExcludePathspecs(root);
  assert.ok(
    excludes.some((p) => p.includes("game/vendor")),
    `expected exclude pathspec for nested link, got ${JSON.stringify(excludes)}`
  );
});

test("worktreeContainsSegment reports a collision, and fails closed on a git error", () => {
  const calls = [];
  const hit = worktreeContainsSegment("C:/tmp/wt", "src", {
    gitImpl: (bin, args, options) => {
      calls.push({ bin, args, cwd: options?.cwd });
      return { status: 0, stdout: "src/main.rs\u0000", stderr: "", error: null };
    }
  });
  assert.equal(hit, true);
  assert.equal(calls[0].bin, "git");
  assert.deepEqual(calls[0].args, [
    "ls-files",
    "-z",
    "--",
    "src/*",
    "**/src/*",
    ":(glob)src/**",
    ":(glob)**/src/**"
  ]);
  assert.equal(calls[0].cwd, "C:/tmp/wt");

  const clean = worktreeContainsSegment("C:/tmp/wt", "Main Repo", {
    gitImpl: () => ({ status: 0, stdout: "", stderr: "", error: null })
  });
  assert.equal(clean, false);

  // A git failure must NOT be read as "no collision" - omitting the rule is the
  // safe direction, so the collision answer is true.
  const failed = worktreeContainsSegment("C:/tmp/wt", "Main Repo", {
    gitImpl: () => ({ status: 128, stdout: "", stderr: "not a repository", error: null })
  });
  assert.equal(failed, true);
});
