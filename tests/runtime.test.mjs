import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  generateJobId,
  listJobs,
  resolveJobFile,
  resolveStateDir,
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

test("check reports ready when fake grok is installed and authenticated", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.grok.available, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.sessionRuntime.mode, "plugin-owned");
  assert.equal(payload.reviewGateEnabled, undefined);
});

test("check reports not ready when models probe fails", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir, "not-logged-in");

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.ok(payload.nextSteps.length > 0);
});

test("check ignores legacy review-gate flags as unknown options", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);

  const result = run("node", [SCRIPT, "check", "--enable-review-gate", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.reviewGateEnabled, undefined);
  assert.match(result.stderr, /ignoring unknown option/);
});

test("review renders a no-findings style result from fake grok", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed uncommitted changes|No material issues found/i);
  assert.match(result.stdout, /Grok Build Review|Target:/);
});

test("critique returns structured findings payload path", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

  const result = run("node", [SCRIPT, "critique", "--json", "focus on docs"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Critique");
  assert.equal(payload.result?.verdict, "approve");
  assert.ok(Array.isArray(payload.result?.findings));
});

function setupReviewableRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return { repo, binDir, pluginDataDir, fakeGrokLog };
}

function lastFakeGrokArgv(logPath) {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const printRun = [...lines].reverse().find((entry) => entry.argv?.includes("-p"));
  assert.ok(printRun, "expected a headless grok -p invocation");
  return printRun.argv;
}

test("review forwards --model and --effort to grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupReviewableRepo();

  const result = run(
    "node",
    [SCRIPT, "review", "--model", "grok-build", "--effort", "high"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--model"));
  assert.equal(argv[argv.indexOf("--model") + 1], "grok-build");
  assert.ok(argv.includes("--effort"));
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
});

test("critique forwards --model and --effort to grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupReviewableRepo();

  const result = run(
    "node",
    [SCRIPT, "critique", "--model", "grok-build", "--effort", "medium", "focus on race conditions"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--model"));
  assert.equal(argv[argv.indexOf("--model") + 1], "grok-build");
  assert.ok(argv.includes("--effort"));
  assert.equal(argv[argv.indexOf("--effort") + 1], "medium");
});

test("review rejects unsupported --effort values", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();

  for (const effort of ["extreme", "xhigh", "max"]) {
    const result = run("node", [SCRIPT, "review", "--effort", effort], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.notEqual(result.status, 0, `expected rejection for --effort ${effort}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported reasoning effort/i);
  }
});

test("run delegates through fake grok and stores a finished job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "run", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  // Proves the delegate path actually streams. The fake emits two turns; under
  // --output-format plain they would concatenate with no separator, which is the
  // Summary run-together defect. Guards against the bridge reverting to "plain".
  assert.match(
    result.stdout,
    /Starting the requested task\.\s*\n\s*\nHandled the requested task\./,
    "delegate output must be turn-separated, proving streaming-json is in use"
  );

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].jobClass, "task");
    assert.equal(jobs[0].status, "completed");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("runs and show surface the latest finished run", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const task = run("node", [SCRIPT, "run", "--json", "do a small thing"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(task.status, 0, task.stderr);

  const status = run("node", [SCRIPT, "runs", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.ok(statusPayload.latestFinished);
  assert.equal(statusPayload.latestFinished.status, "completed");
  assert.equal(statusPayload.needsReview, undefined);

  const result = run("node", [SCRIPT, "show"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task|Grok session ID|Run:/);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  // Zombies still accept kill(0); treat them as not running.
  const ps = run("ps", ["-p", String(pid), "-o", "stat="]);
  const stat = String(ps.stdout ?? "").trim().toUpperCase();
  if (!stat || stat.includes("Z")) {
    return false;
  }
  return true;
}

test("stop terminates a tracked sleeper process and marks run cancelled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const agent = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    cwd: repo,
    stdio: "ignore",
    detached: true
  });
  agent.unref();
  const bridge = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    cwd: repo,
    stdio: "ignore",
    detached: true
  });
  bridge.unref();
  const agentPid = agent.pid;
  const bridgePid = bridge.pid;

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobId = generateJobId("run");
    const jobsDir = path.join(resolveStateDir(repo), "jobs");
    fs.mkdirSync(jobsDir, { recursive: true });
    const logFile = path.join(jobsDir, `${jobId}.log`);
    fs.writeFileSync(logFile, "", "utf8");
    const job = {
      id: jobId,
      kind: "task",
      kindLabel: "delegate",
      title: "Grok Build Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "fake running",
      status: "running",
      phase: "running",
      bridgePid,
      pid: bridgePid,
      agentPid,
      logFile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);

    const result = run("node", [SCRIPT, "stop", jobId, "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "cancelled");
    assert.equal(payload.jobId, jobId);
    assert.equal(payload.killDelivered, true);
    assert.ok(payload.killTargets?.includes(agentPid));
    assert.ok(payload.killTargets?.includes(bridgePid));

    const jobs = listJobs(repo);
    const cancelled = jobs.find((entry) => entry.id === jobId);
    assert.equal(cancelled?.status, "cancelled");

    // Both process trees must actually be dead.
    assert.equal(processAlive(agentPid), false);
    assert.equal(processAlive(bridgePid), false);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  }
});

test("enqueueBackgroundJob writes the job file before spawning the worker", async () => {
  const { enqueueBackgroundJob } = await import("../plugins/grok-build/scripts/grok-bridge.mjs");
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const events = [];
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "Grok Build Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "bg order",
      write: false
    };

    const result = enqueueBackgroundJob(
      repo,
      job,
      { kind: "task", cwd: repo, prompt: "hello", write: false, resumeLast: false, jobId: job.id },
      {
        spawnWorker(cwd, jobId) {
          events.push("spawn");
          const stored = readStoredJobFromDisk(repo, jobId);
          events.push(stored ? "job-present-at-spawn" : "job-missing-at-spawn");
          assert.ok(stored, "job file must exist before worker spawn");
          assert.equal(stored.status, "queued");
          assert.equal(stored.pid, null);
          return { pid: 424242 };
        }
      }
    );

    assert.deepEqual(events, ["spawn", "job-present-at-spawn"]);
    assert.equal(result.payload.status, "queued");
    assert.equal(result.payload.pid, 424242);
    assert.equal(result.payload.bridgePid, 424242);
    const jobs = listJobs(repo);
    assert.equal(jobs[0].pid, 424242);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

function readStoredJobFromDisk(workspaceRoot, jobId) {
  const jobFile = path.join(resolveStateDir(workspaceRoot), "jobs", `${jobId}.json`);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

test("isolated write run patches worktree onto the job before the agent finishes", async () => {
  const repo = makeTempDir("grok-wt-early-");
  const binDir = makeTempDir("grok-wt-early-bin-");
  const pluginDataDir = makeTempDir("grok-wt-early-data-");

  // Slow fake so we can observe the job mid-run after createWorktree patches.
  fs.mkdirSync(binDir, { recursive: true });
  const fakePath = path.join(binDir, "grok");
  fs.writeFileSync(
    fakePath,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-V") {
  process.stdout.write("grok 0.2.83-fake\\n");
  process.exit(0);
}
if (argv[0] === "models") {
  process.stdout.write("You are logged in with grok.com.\\n");
  process.exit(0);
}
const isPrint = argv.includes("-p") || argv.includes("--print");
if (isPrint) {
  // Stay alive long enough for the bridge to create + patch the worktree.
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    // busy-wait: no ESM top-level await required
  }
  const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  emit({ type: "text", data: "slow agent done" });
  emit({
    type: "end",
    stopReason: "EndTurn",
    sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    num_turns: 1,
    total_cost_usd: 0.001
  });
  process.exit(0);
}
process.stderr.write("fake grok unknown\\n");
process.exit(1);
`,
    { encoding: "utf8", mode: 0o755 }
  );

  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  const child = spawn(
    process.execPath,
    [SCRIPT, "run", "--write", "--json", "edit something in isolation"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  let jobId = null;
  try {
    const deadline = Date.now() + 15000;
    let found = null;
    while (Date.now() < deadline) {
      const jobs = listJobs(repo);
      const active = jobs.find((job) => job.status === "running" || job.status === "queued");
      if (active) {
        jobId = active.id;
        const stored = readStoredJobFromDisk(repo, jobId);
        if (stored?.worktree?.path && stored?.worktree?.branch && stored?.worktree?.baseSha) {
          found = stored;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.ok(jobId, "expected a tracked job while the slow agent was running");
    assert.ok(
      found?.worktree?.path,
      "worktree descriptor must be patched onto the job before the agent finishes"
    );
    assert.ok(fs.existsSync(found.worktree.path), "worktree path must exist on disk");
    assert.match(found.worktree.branch, /^grok-build\//);
    assert.ok(found.worktree.baseSha);
  } finally {
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
    // Ensure we do not leave the process hanging the test runner.
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("bogus --verify-attempts still yields a definite verified boolean", () => {
  const repo = makeTempDir("grok-verify-attempts-");
  const binDir = makeTempDir("grok-verify-attempts-bin-");
  const pluginDataDir = makeTempDir("grok-verify-attempts-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Non-integer attempts used to leave verified null → reported as plain completed.
  //
  // The verify command has to PASS at baseline and fail afterwards. A command
  // that fails unconditionally used to work here only because the baseline
  // probe was skipped on a non-isolated run; now that the probe always runs,
  // an always-red command is correctly classified as already-failing and is
  // no longer blamed on the run. This marker-file command is red only from
  // its second invocation onward, which is exactly the "the run broke it"
  // shape the attempts path is meant to exercise - and it needs no binary
  // beyond node.
  const verifyCommand =
    `node -e "const fs=require('fs');const p='.gvmarker';if(fs.existsSync(p)){process.exit(1)}fs.writeFileSync(p,'1')"`;
  const result = run(
    "node",
    [
      SCRIPT,
      "run",
      "--json",
      "--verify",
      verifyCommand,
      "--verify-attempts",
      "2.5",
      "do something"
    ],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(typeof payload.verified, "boolean");
  assert.notEqual(payload.verified, null);
  assert.notEqual(payload.verified, undefined);
  assert.equal(payload.verified, false);

  // The probe used to be gated on an isolated write run, so a run like this
  // one had no baseline at all and blamed whatever it found. It now runs here
  // too - and its cost is reported.
  assert.ok(
    Number.isFinite(payload.verify.baselineProbeMs),
    "expected a measured baseline probe duration"
  );
  assert.equal(payload.verify.baselines.length, 1);
  assert.equal(payload.verify.baselines[0].ok, true, "the marker command passes at baseline");
  assert.equal(payload.verify.results[0].failureSource, "agent");

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].status, "completed-unverified");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("an unrunnable verify command is reported as infrastructure, never blamed on the agent", () => {
  // Regression: a verify command that could not be started at all looked
  // exactly like a failing test suite - non-zero exit, no recognisable
  // failure lines - so it was attributed to the run, fed back to the agent as
  // something to "fix", and could still end up reported as verified. None of
  // those three are honest. Hermetic: the binary genuinely does not exist, so
  // nothing is installed or spawned beyond the fake grok.
  const repo = makeTempDir("grok-verify-unrunnable-");
  const binDir = makeTempDir("grok-verify-unrunnable-bin-");
  const pluginDataDir = makeTempDir("grok-verify-unrunnable-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "run", "--json", "--verify", "grok-build-nonexistent-binary-xyz --headless", "do something"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verified, false, "an unrunnable verify command can never mean verified");
  assert.equal(payload.verify.results[0].commandNotFound, true);
  assert.equal(payload.verify.results[0].failureSource, "infrastructure");
  assert.equal(payload.verify.results[0].attribution, "verify-command-not-runnable");
  assert.match(payload.verify.note, /not a code failure/i);
  // Breaks out without spending a fix turn on a command that never ran.
  assert.equal(payload.verify.attempts, 0);
});

test("import uses grok import and prints resume hint", () => {
  const home = makeTempDir();
  const projects = path.join(home, ".claude", "projects", "demo");
  fs.mkdirSync(projects, { recursive: true });
  const sessionPath = path.join(projects, "sess-transfer.jsonl");
  fs.writeFileSync(sessionPath, '{"type":"user","text":"hi"}\n', "utf8");

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "import", "--source", sessionPath, "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      HOME: home,
      USERPROFILE: home
    })
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.threadId, "11111111-2222-4333-8444-555555555555");
  assert.equal(payload.resumeCommand, "grok -r 11111111-2222-4333-8444-555555555555");
});

test("run-resume-candidate reports available after a completed run with thread id", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const sessionId = "claude-session-1";
  const task = run("node", [SCRIPT, "run", "first task"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_CC_SESSION_ID: sessionId
    })
  });
  assert.equal(task.status, 0, task.stderr);

  const candidate = run("node", [SCRIPT, "run-resume-candidate", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_CC_SESSION_ID: sessionId
    })
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, true);
  assert.ok(payload.candidate?.threadId);
});

test("--verify-timeout reaches the stored request under --background", () => {
  // The background branch builds its own request object, so a value threaded
  // only through the foreground path would silently do nothing here - and
  // --background is exactly the mode a long Godot/Blender import runs in, i.e.
  // the one the flag exists for.
  const repo = makeTempDir("grok-verify-timeout-bg-");
  const binDir = makeTempDir("grok-verify-timeout-bg-bin-");
  const pluginDataDir = makeTempDir("grok-verify-timeout-bg-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [
      SCRIPT,
      "run",
      "--json",
      "--background",
      "--verify-timeout",
      "1800",
      "--baseline-timeout",
      "1200",
      "--verify-max-buffer",
      "8",
      "do something long"
    ],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const launch = JSON.parse(result.stdout);
  assert.ok(launch.jobId, "a background launch must report its job id");

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const record = JSON.parse(fs.readFileSync(resolveJobFile(repo, launch.jobId), "utf8"));
    assert.equal(record.request.verifyTiming.timeoutMs, 1_800_000);
    assert.equal(record.request.verifyTiming.baselineTimeoutMs, 1_200_000);
    assert.equal(record.request.verifyTiming.maxOutputBytes, 8 * 1024 * 1024);
    assert.equal(record.request.verifyTiming.sources.timeoutMs, "cli");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("an explicit --verify-timeout is what each verify command actually gets", () => {
  // Not just plumbed into the request: read back out of it, applied per
  // command in place of the derived baseline*4, and recorded so the run can
  // later answer "what budget did this get, and who chose it?".
  const repo = makeTempDir("grok-verify-timeout-fg-");
  const binDir = makeTempDir("grok-verify-timeout-fg-bin-");
  const pluginDataDir = makeTempDir("grok-verify-timeout-fg-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [
      SCRIPT,
      "run",
      "--json",
      "--verify",
      "node -e process.exit(0)",
      "--verify-timeout",
      "1800",
      "--verify-max-buffer",
      "2",
      "do something"
    ],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verified, true);
  assert.equal(payload.verify.timeouts.verifyTimeoutMs, 1_800_000);
  assert.equal(payload.verify.timeouts.maxOutputBytes, 2 * 1024 * 1024);
  assert.equal(payload.verify.timeouts.source, "explicit");
  // Never lowered: the baseline probe is the one measurement the whole
  // attribution story rests on.
  assert.ok(payload.verify.timeouts.baselineTimeoutMs >= 900000);
  assert.equal(payload.verify.results[0].timeoutMs, 1_800_000);
  assert.equal(payload.verify.results[0].timeoutSource, "explicit");
});
