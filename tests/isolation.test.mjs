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
} from "../plugins/grok-build/scripts/lib/grok.mjs";
import {
  classifyJobLiveness,
  reconcileAbandonedJob,
  shouldReconcileAbandoned
} from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { resolveIsolateSetting } from "../plugins/grok-build/scripts/lib/project-config.mjs";
import { terminateProcessTree } from "../plugins/grok-build/scripts/lib/process.mjs";
import { decideCompletionStatus } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import {
  allowNoIsolateFromEnv,
  detectCaller
} from "../plugins/grok-build/scripts/lib/workspace.mjs";
import {
  removeDirectoryTree,
  removeWorktree,
  resolveWorktreePath,
  shortWorktreeId,
  toWin32LongPath
} from "../plugins/grok-build/scripts/lib/worktree.mjs";
import {
  formatIsolationHeaderLine,
  loadRunRules
} from "../plugins/grok-build/scripts/grok-bridge.mjs";
import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  claimJobTerminal,
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

test("buildWorkspaceRootDenyRules emits Edit/Write/NotebookEdit with forward slashes", () => {
  const plan = buildWorkspaceRootDenyRules("C:\\Users\\me\\repo", "C:\\Users\\me\\wt");
  assert.equal(plan.skipped, false);
  assert.deepEqual(plan.rules, [
    "Edit(C:/Users/me/repo/**)",
    "Write(C:/Users/me/repo/**)",
    "NotebookEdit(C:/Users/me/repo/**)"
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
  assert.equal(calls, 1);
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
      branch: "grok-build/r1",
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

test("resolveWorktreePath uses short TEMP path on win32", () => {
  const short = resolveWorktreePath("run-ms7longid-abc", {
    platform: "win32",
    env: { TEMP: "C:\\Users\\me\\AppData\\Local\\Temp" }
  });
  assert.equal(
    short,
    path.join("C:\\Users\\me\\AppData\\Local\\Temp", "gb", "w", shortWorktreeId("run-ms7longid-abc"))
  );
  assert.equal(shortWorktreeId("run-ms7longid-abc").length, 8);
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
 * terminateProcessTree never throws; win32 escalation
 * ---------------------------------------------------------------------- */

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
      if (command === "powershell") {
        // Second step kills it.
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
  for (const tool of ["Edit", "Write", "NotebookEdit"]) {
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
  assert.equal(plan.rules.length, 3);
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
  assert.deepEqual(calls[0].args, ["ls-files", "-z", "--", "src/*", "**/src/*"]);
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
