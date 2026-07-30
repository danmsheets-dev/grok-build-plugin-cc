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
  resolveJobLogFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
import { buildSingleJobSnapshot, buildStatusSnapshot, readStoredJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";

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

  const result = run("node", [SCRIPT, "run", "--json", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // rawOutput is now the ANSWER, not the narration: the fake's second turn.
  assert.equal(payload.rawOutput, "Handled the requested task.");
  // Proves the delegate path actually streams. The fake emits two turns; under
  // --output-format plain they would concatenate with no separator, which is the
  // Summary run-together defect. Guards against the bridge reverting to "plain".
  // Retargeted from stdout onto payload.transcript, which is where the whole
  // turn-separated narration lives now that rawOutput prefers the answer -
  // the guard is about the stream shape, not about which field carries it.
  assert.match(
    payload.transcript,
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

test("a delegate run carries the report contract and surfaces the report as the result", () => {
  // The user's reported complaint, end to end: without a contract the run
  // returns narration and the only way to get an answer is to ask for a file.
  const repo = makeTempDir("grok-report-");
  const binDir = makeTempDir("grok-report-bin-");
  const pluginDataDir = makeTempDir("grok-report-data-");
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir, "reporting");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "run", "--json", "rebuild the scene"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);

  // The contract reached the CLI on --rules, not welded onto the user's prompt.
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--rules"), `expected --rules in ${argv.join(" ")}`);
  assert.match(argv[argv.indexOf("--rules") + 1], /===GROK-FINAL-REPORT===/);
  assert.equal(argv[argv.indexOf("-p") + 1], "rebuild the scene", "the prompt must stay the user's");

  // The result is the report, with the delimiters stripped - not the narration
  // that preceded it, and not the raw fence.
  assert.equal(payload.rawOutput, "## Result\nRebuilt the scene.\n## Files changed\nscene.tscn - rebuilt");
  assert.doesNotMatch(payload.rawOutput, /GROK-FINAL-REPORT/);
  assert.doesNotMatch(payload.rawOutput, /Let me look at the project structure/);
  // The narration is still recorded, just not presented as the answer.
  assert.match(payload.transcript, /Let me look at the project structure/);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    // The runs table must not be titled `## Result` for every compliant run.
    assert.doesNotMatch(jobs[0].summary ?? "", /^##/, `summary was: ${jobs[0].summary}`);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("a silent verify fix turn does not erase the original run's answer", () => {
  // The default path for any --verify run that fails once: the fix turn ends on
  // a tool call with no trailing prose, `result` was overwritten wholesale, and
  // a run that did the work and passed verification reported "Grok did not
  // return a final message."
  const repo = makeTempDir("grok-silent-fix-");
  const binDir = makeTempDir("grok-silent-fix-bin-");
  const pluginDataDir = makeTempDir("grok-silent-fix-data-");
  installFakeGrok(binDir, "silent-fix");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Passes at baseline (call 1), fails the first real attempt (call 2), passes
  // the re-check after the fix turn (call 3). Needs no binary beyond node, and
  // no cooperation from the agent - the fake cannot fix anything.
  const verifyCommand =
    `node -e "const fs=require('fs');const p='.gvcount';` +
    `const n=(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1;fs.writeFileSync(p,String(n));` +
    `if(n===2){console.error('AssertionError: marker check failed');process.exit(1)}"`;

  const result = run(
    "node",
    [SCRIPT, "run", "--json", "--verify", verifyCommand, "do something"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);

  // The loop really did run a fix turn and then pass.
  assert.equal(payload.verify.attempts, 1, "expected exactly one fix turn");
  assert.equal(payload.verified, true);

  // ...and the answer survived it.
  assert.equal(payload.rawOutput, "Handled the requested task.");
  assert.match(payload.transcript, /Starting the requested task/);

  // The same run again in text mode, which is what the user actually sees.
  // Resetting the counter puts the fix turn back in the picture.
  fs.rmSync(path.join(repo, ".gvcount"));
  const rendered = run("node", [SCRIPT, "run", "--verify", verifyCommand, "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.doesNotMatch(
    rendered.stdout,
    /Grok did not return a final message/,
    "this is the exact string the reported bug produced"
  );
  assert.match(rendered.stdout, /Handled the requested task/);
  assert.match(rendered.stdout, /Verified: yes/);
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

// D2: SENSITIVE_ENV_KEY_PATTERN must match the sensitive word anywhere in the
// key (delimited by `_` or a boundary), not just as a suffix - the
// Android/Steam signing vocabulary that is --env's headline Godot use case
// (KEYSTORE_PASS, STEAM_PASS, SECRET_KEY_BASE, SIGNING_KEY_ALIAS) all put the
// sensitive word in the middle of the name. It must also stop over-matching
// names that merely end in the same letters (NODEJS_COMPAT, MONKEY).
test("redactEnvForRecord catches signing-credential key spellings without over-matching lookalikes", async () => {
  const { redactEnvForRecord } = await import("../plugins/grok-build/scripts/grok-bridge.mjs");

  const shouldRedact = [
    "KEYSTORE_PASS",
    "ANDROID_KEYSTORE_PASSWORD",
    "SECRET_KEY_BASE",
    "STEAM_PASS",
    "KEY_PASSPHRASE",
    "SIGNING_KEY_ALIAS",
    "SENTRY_DSN",
    "XAI_API_KEY",
    "MY_PAT"
  ];
  const shouldNotRedact = [
    "NODEJS_COMPAT",
    "MONKEY",
    "WRANGLER_COMPAT",
    // `url` is deliberately excluded: redacting it would hide ordinary,
    // non-secret URLs the user would want to see in the run record.
    "DATABASE_URL"
  ];

  const overrides = {};
  for (const key of [...shouldRedact, ...shouldNotRedact]) {
    overrides[key] = `value-for-${key}`;
  }
  const record = redactEnvForRecord(overrides);

  for (const key of shouldRedact) {
    assert.equal(record[key], "[redacted]", `expected ${key} to be redacted`);
  }
  for (const key of shouldNotRedact) {
    assert.equal(record[key], `value-for-${key}`, `expected ${key} to pass through unredacted`);
  }
});

// D1+D2 shared regression test. A background --env value must survive intact
// in the job file the detached worker reads (jobs/<id>.json), and must be
// redacted everywhere the state index is ever displayed back to the user:
// listJobs (state.json), buildStatusSnapshot, and buildSingleJobSnapshot -
// all reachable from `runs --json` / `show --json`, which echo straight back
// into the Claude Code transcript.
test("a signing-credential --env value is redacted in the shared index but intact in the job file", async () => {
  const { enqueueBackgroundJob } = await import("../plugins/grok-build/scripts/grok-bridge.mjs");
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  const SECRET_VALUE = "hunter2-supersecret-signing-password";
  const NON_SECRET_VALUE = "release";

  // buildStatusSnapshot filters its whole job list by session id (so one
  // Claude Code session doesn't see another's runs). Pin both the job and the
  // read side to the same fixed id so the test is deterministic regardless of
  // whether GROK_CC_SESSION_ID happens to be set in the ambient environment.
  const sessionId = "grok-build-test-session";
  const statusOptions = { sessionId };

  try {
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "Grok Build Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "background env redaction",
      write: false,
      sessionId
    };
    const request = {
      kind: "task",
      cwd: repo,
      prompt: "sign the build",
      write: false,
      resumeLast: false,
      jobId: job.id,
      env: { KEYSTORE_PASS: SECRET_VALUE, BUILD_CHANNEL: NON_SECRET_VALUE }
    };

    enqueueBackgroundJob(repo, job, request, {
      spawnWorker() {
        return { pid: 424242 };
      }
    });

    // The job file is the detached worker's actual input (readStoredJob ==
    // resolveJobFile). It must keep the real value.
    const stored = readStoredJob(repo, job.id);
    assert.equal(stored.request.env.KEYSTORE_PASS, SECRET_VALUE, "worker must read the real value from the job file");
    assert.equal(stored.request.env.BUILD_CHANNEL, NON_SECRET_VALUE);

    // The shared index (state.json, via listJobs) must never hold the raw value.
    const indexed = listJobs(repo).find((entry) => entry.id === job.id);
    assert.ok(indexed, "job must be present in the state index");
    assert.equal(indexed.request.env.KEYSTORE_PASS, "[redacted]");
    assert.equal(indexed.request.env.BUILD_CHANNEL, NON_SECRET_VALUE);

    // Nor should the secret ever appear in a `--json`-serializable snapshot.
    const statusJson = JSON.stringify(buildStatusSnapshot(repo, statusOptions));
    assert.ok(!statusJson.includes(SECRET_VALUE), "buildStatusSnapshot leaked the secret value");

    const singleJson = JSON.stringify(buildSingleJobSnapshot(repo, job.id));
    assert.ok(!singleJson.includes(SECRET_VALUE), "buildSingleJobSnapshot leaked the secret value");

    // Defense in depth: enrichJob drops `request` entirely from what these
    // snapshots surface, since nothing downstream reads it off the index.
    const snapshot = buildStatusSnapshot(repo, statusOptions);
    const runningEntry = snapshot.running.find((entry) => entry.id === job.id);
    assert.ok(runningEntry, "job must appear in the running list");
    assert.equal(runningEntry.request, undefined);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

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

test("the verify phase is reported as progress, not inferred from agent chatter", () => {
  // The bridge runs the verify commands itself, so the agent emits no
  // "running command:" line for them and inferLegacyJobPhase has nothing to
  // pattern-match on. A fifteen-minute Godot import used to leave the log
  // completely silent about what the run was doing.
  const repo = makeTempDir("grok-verify-progress-");
  const binDir = makeTempDir("grok-verify-progress-bin-");
  const pluginDataDir = makeTempDir("grok-verify-progress-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "run", "--json", "--verify", "node -e process.exit(0)", "do something"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verified, true);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    const log = fs.readFileSync(resolveJobLogFile(repo, jobs[0].id), "utf8");
    assert.match(log, /Verify baseline:/, "the probe must announce itself before it runs");
    assert.match(log, /Verify attempt 1\//, "each attempt must be logged as it starts");
    assert.match(log, /Verify passed in \d+ms:/, "each attempt must report its outcome");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("--no-verify-baseline skips the probe and makes verification strict", () => {
  // A command that is red before the run and red after is normally NOT the
  // agent's fault, and the run reports verified:true with a note. Opting out
  // of the baseline says "treat every failure as mine", which has to be
  // recorded as a deliberate choice rather than as an unknown baseline.
  const repo = makeTempDir("grok-no-baseline-");
  const binDir = makeTempDir("grok-no-baseline-bin-");
  const pluginDataDir = makeTempDir("grok-no-baseline-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const alwaysRed = "node -e process.exit(1)";

  const withBaseline = run(
    "node",
    [SCRIPT, "run", "--json", "--verify", alwaysRed, "do something"],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );
  assert.equal(withBaseline.status, 0, withBaseline.stderr || withBaseline.stdout);
  const measured = JSON.parse(withBaseline.stdout);
  assert.equal(measured.verified, true, "a pre-existing failure is not this run's");
  assert.equal(measured.verify.results[0].attribution, "baseline-already-failing");
  assert.equal(measured.verify.baselineSkipped, false);

  const withoutBaseline = run(
    "node",
    [SCRIPT, "run", "--json", "--no-verify-baseline", "--verify", alwaysRed, "do something"],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );
  assert.equal(withoutBaseline.status, 0, withoutBaseline.stderr || withoutBaseline.stdout);
  const strict = JSON.parse(withoutBaseline.stdout);
  assert.equal(strict.verified, false, "with nothing measured, every failure counts");
  assert.equal(strict.verify.baselineSkipped, true);
  assert.equal(strict.verify.baselineProbeMs, null, "no probe ran, so there is nothing to report");
  assert.equal(strict.verify.baselines[0].baselineSkipped, true);
  assert.equal(strict.verify.baselines[0].ok, null, "nothing was measured, so ok has no answer");
  assert.equal(strict.verify.results[0].attribution, "baseline-skipped");
  assert.equal(strict.verify.results[0].failureSource, "agent");
});

test("a Godot project's exit-0 SCRIPT ERROR is a verification failure", () => {
  // The headline engine bug end to end: godot --headless --import prints
  // SCRIPT ERROR for an unparseable script and exits 0, so exit-code-only
  // detection reported a broken project as verified. Hermetic - the pattern
  // set is chosen from project.godot, and the "engine" is a node script.
  const repo = makeTempDir("grok-godot-exit0-");
  const binDir = makeTempDir("grok-godot-exit0-bin-");
  const pluginDataDir = makeTempDir("grok-godot-exit0-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    path.join(repo, "project.godot"),
    'config_version=5\n\n[application]\n\nconfig/name="Demo"\n',
    "utf8"
  );
  // Clean on its first (baseline) invocation, broken afterwards - so the
  // failure is genuinely attributable to the run rather than pre-existing.
  fs.writeFileSync(
    path.join(repo, "engine.cjs"),
    [
      "const fs = require('fs');",
      "const marker = '.gvmarker';",
      "if (fs.existsSync(marker)) {",
      "  console.log('SCRIPT ERROR: Parse Error: Identifier not declared');",
      "} else {",
      "  fs.writeFileSync(marker, '1');",
      "}",
      "process.exit(0);",
      ""
    ].join("\n"),
    "utf8"
  );
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "run", "--json", "--verify", "node engine.cjs", "do something"],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.plan.ecosystem, "godot", "project.godot must select the pattern set");
  assert.equal(payload.verified, false, "an exit-0 SCRIPT ERROR can never mean verified");

  const entry = payload.verify.results[0];
  assert.equal(entry.exitCode, 0, "the command really did exit 0 - that is the whole bug");
  assert.equal(entry.ok, false);
  assert.equal(entry.outputFailure, true);
  assert.match(entry.matchedLines[0], /^SCRIPT ERROR:/);
  assert.equal(entry.failureSource, "agent");
});

test("the same exit-0 output passes in a project with no engine ecosystem", () => {
  // The discriminator for the test above: nothing about the output changed,
  // only which ecosystem was detected. A repo with no engine marker gets no
  // output patterns, so exit 0 still means pass - unchanged from 0.3.x.
  const repo = makeTempDir("grok-no-ecosystem-exit0-");
  const binDir = makeTempDir("grok-no-ecosystem-exit0-bin-");
  const pluginDataDir = makeTempDir("grok-no-ecosystem-exit0-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(
    path.join(repo, "engine.cjs"),
    "console.log('SCRIPT ERROR: Parse Error: Identifier not declared');\nprocess.exit(0);\n",
    "utf8"
  );
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "run", "--json", "--verify", "node engine.cjs", "do something"],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.plan.ecosystem, null);
  assert.equal(payload.verified, true);
  assert.equal(payload.verify.results[0].outputFailure, false);
});

test("--verify-ignore applies to detection symmetrically at baseline and after the run", () => {
  // F2's mandatory guard test. The ignore list used to reach summarizeFailures
  // only, leaving detectOutputFailures ungated in BOTH probeBaselines and the
  // post-agent runVerifyCommand call - so an "ignored" engine failure still
  // set ok:false on both sides and then produced an empty, incomparable
  // signature, blaming the agent with a reason nobody could act on.
  //
  // engine.cjs prints the SAME two lines unconditionally, both at baseline and
  // after the run: one that --verify-ignore is asked to drop, and one that is
  // not. If the ignore is applied on only one of the two call sites, the two
  // sides disagree about whether the command ok'd at all, which either
  // produces an "incomparable" verdict or blames the agent outright - the
  // exact asymmetry the fix plan calls out as strictly worse than the bug.
  const repo = makeTempDir("grok-verify-ignore-symmetry-");
  const binDir = makeTempDir("grok-verify-ignore-symmetry-bin-");
  const pluginDataDir = makeTempDir("grok-verify-ignore-symmetry-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    path.join(repo, "project.godot"),
    'config_version=5\n\n[application]\n\nconfig/name="Demo"\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "engine.cjs"),
    [
      "console.log('SCRIPT ERROR: Parse Error: known_issue not declared');",
      "console.log('SCRIPT ERROR: Failed to load script res://always_broken.gd');",
      "process.exit(0);",
      ""
    ].join("\n"),
    "utf8"
  );
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [
      SCRIPT,
      "run",
      "--json",
      "--verify",
      "node engine.cjs",
      "--verify-ignore",
      "known_issue",
      "do something"
    ],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verify.plan.ecosystem, "godot");

  const entry = payload.verify.results[0];
  // The non-ignored line is a genuine failure that was ALSO there at
  // baseline, so it must not be blamed on the agent...
  assert.equal(entry.ok, false, "the non-ignored line still marks the command failed");
  assert.equal(entry.failureSource, "baseline", "unchanged-from-baseline, not the agent");
  assert.equal(entry.attribution, "unchanged-from-baseline");
  // ...and the signature must be a real, non-empty, COMPARABLE one - not the
  // empty "incomparable" signature the pre-fix asymmetry produced.
  assert.ok(Array.isArray(entry.signature) && entry.signature.length > 0, JSON.stringify(entry.signature));
  // The ignored line must never surface as a matched failure marker, at
  // either the baseline probe or the post-agent pass.
  assert.ok(
    entry.matchedLines.every((line) => !line.includes("known_issue")),
    JSON.stringify(entry.matchedLines)
  );
  assert.ok(entry.matchedLines.some((line) => line.includes("Failed to load script")));
  const baselineEntry = payload.verify.baselines[0];
  assert.ok(
    !JSON.stringify(baselineEntry.signature).includes("known_issue"),
    "the ignore list must reach the baseline probe's detection too, not only the post-agent pass"
  );

  // Because nothing was blamed, the run itself is reported verified overall.
  assert.equal(payload.verified, true);
});

test("--verify-ignore reaches the stored request under --background", () => {
  // Compiled RegExps do not survive the JSON round trip into the job file, so
  // the request has to carry the raw pattern strings. A pattern that reached
  // only the foreground path would silently do nothing for exactly the
  // long-running runs it matters most to.
  const repo = makeTempDir("grok-verify-ignore-bg-");
  const binDir = makeTempDir("grok-verify-ignore-bg-bin-");
  const pluginDataDir = makeTempDir("grok-verify-ignore-bg-data-");
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
      "--background",
      "--json",
      "--no-verify-baseline",
      "--verify",
      "node -e process.exit(0)",
      "--verify-ignore",
      "Cannot create RenderingDevice",
      "--verify-ignore",
      "leaked instance",
      "do something"
    ],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const launch = JSON.parse(result.stdout);
  assert.ok(launch.jobId, "a background launch must report its job id");

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, launch.jobId), "utf8"));
    assert.deepEqual(stored.request.verifyIgnorePatterns, [
      "Cannot create RenderingDevice",
      "leaked instance"
    ]);
    assert.equal(stored.request.noVerifyBaseline, true);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("--env reaches the verify command, and the run says which variables it set", () => {
  // Blender is the reason this exists: it has no CLI flag for "use this add-on
  // directory", only BLENDER_USER_SCRIPTS and friends. End to end because the
  // map has to survive handleTask -> the request -> executeTaskRun -> both the
  // baseline probe and the real pass, and each hop is a place it silently
  // becomes undefined. Hermetic: `node` is the only binary involved.
  const repo = makeTempDir("grok-env-e2e-");
  const binDir = makeTempDir("grok-env-e2e-bin-");
  const pluginDataDir = makeTempDir("grok-env-e2e-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Space-free -e script: cmd.exe /d /s /c strips exactly one outer quote pair,
  // and a nested `"` inside a spaced argument is what mangles on win32.
  const probe = "node -e process.exit(process.env.GROK_ENV_PROBE==='bar'?0:3)";
  const args = [SCRIPT, "run", "--json", "--verify", probe];

  const withEnv = run(
    "node",
    [...args, "--env", "GROK_ENV_PROBE=bar", "--env", "MY_PAT=s3cr3t-value", "check the env"],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );
  assert.equal(withEnv.status, 0, withEnv.stderr || withEnv.stdout);
  const passed = JSON.parse(withEnv.stdout);
  assert.equal(passed.verified, true);
  assert.equal(passed.verify.results[0].exitCode, 0);
  // The probe measured the SAME environment, or the baseline comparison would
  // be against a different command.
  assert.equal(passed.verify.baselines[0].ok, true);
  // Which variables a run imposed is diagnostic; their values are the user's
  // secrets, and redaction is by key NAME (a token under MY_PAT is exactly the
  // case a value-shaped regex misses).
  assert.equal(passed.env.GROK_ENV_PROBE, "bar");
  assert.equal(passed.env.MY_PAT, "[redacted]");
  assert.ok(
    !JSON.stringify(passed).includes("s3cr3t-value"),
    "a sensitive value must not survive anywhere in the persisted payload"
  );

  // The discriminator: the identical run without the override.
  const withoutEnv = run("node", [...args, "check the env"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(withoutEnv.status, 0, withoutEnv.stderr || withoutEnv.stdout);
  const bare = JSON.parse(withoutEnv.stdout);
  assert.equal(bare.verify.results[0].exitCode, 3);
  assert.deepEqual(bare.env, {});
});

test("--env and --blender-sandbox reach the stored request under --background", () => {
  // A background worker resolves nothing of its own: whatever did not make it
  // into the request simply does not happen, and --background is the delegate
  // default.
  const repo = makeTempDir("grok-env-bg-");
  const binDir = makeTempDir("grok-env-bg-bin-");
  const pluginDataDir = makeTempDir("grok-env-bg-data-");
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
      "--background",
      "--json",
      "--blender-sandbox",
      "--env",
      "BLENDER_USER_SCRIPTS=/somewhere/scripts",
      "--env",
      String.raw`PATHX=C:\a=b`,
      "do something"
    ],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const launch = JSON.parse(result.stdout);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, launch.jobId), "utf8"));
    // Verbatim, not redacted: this object is the worker's INPUT, and a
    // background run handed "[redacted]" for its token would simply fail.
    assert.deepEqual(stored.request.env, {
      BLENDER_USER_SCRIPTS: "/somewhere/scripts",
      PATHX: String.raw`C:\a=b`
    });
    assert.equal(stored.request.blenderSandbox, true);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("--blender-sandbox verifies against the worktree's add-on, not the developer's checkout", () => {
  // The bug: Blender loads add-ons from a per-user scripts directory, and the
  // standard workflow points scripts/addons/<name> at the SOURCE checkout - so
  // an isolated run verifies pre-agent code, which is exactly the failure
  // isolation exists to prevent. No Blender is involved here; the verify
  // command asserts the same thing Blender would discover.
  const repo = makeTempDir("grok-blender-sandbox-e2e-");
  const binDir = makeTempDir("grok-blender-sandbox-e2e-bin-");
  const pluginDataDir = makeTempDir("grok-blender-sandbox-e2e-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "myaddon"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "myaddon", "__init__.py"),
    'bl_info = {"name": "My Addon", "blender": (4, 2, 0)}\n'
  );
  fs.writeFileSync(path.join(repo, "myaddon", "ops.py"), "MARKER\n");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Resolves the add-on exactly as Blender would: through BLENDER_USER_SCRIPTS.
  // Space-free so cmd.exe's single-outer-quote-pair rule cannot mangle it, and
  // `String(...)` rather than `||`: cmd.exe reads `||` as its own operator and
  // splits the command line in half.
  const probe =
    "node -e process.exit(require('fs').existsSync(require('path').join(String(process.env.BLENDER_USER_SCRIPTS),'addons','myaddon','ops.py'))?0:9)";

  const result = run(
    "node",
    [SCRIPT, "run", "--write", "--json", "--blender-sandbox", "--verify", probe, "edit the addon"],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.verified, true, JSON.stringify(payload.verify?.results?.[0] ?? null));
  assert.equal(
    payload.verify.results[0].exitCode,
    0,
    payload.verify.results[0].output
  );

  // The sandbox is inside the worktree - that is what makes it isolation.
  const scriptsDir = payload.env.BLENDER_USER_SCRIPTS;
  assert.ok(scriptsDir, "BLENDER_USER_SCRIPTS must be reported");
  assert.ok(
    scriptsDir.startsWith(payload.worktree.path),
    `${scriptsDir} must live inside ${payload.worktree.path}`
  );
  // And the link resolves to the WORKTREE's copy of the add-on. The whole bug
  // is that it otherwise resolves to the user's real checkout, where the
  // agent's changes are not.
  const worktreeReal = fs.realpathSync(payload.worktree.path);
  const linkedReal = fs.realpathSync(path.join(scriptsDir, "addons", "myaddon"));
  assert.ok(
    linkedReal.startsWith(worktreeReal),
    `the sandboxed add-on resolved to ${linkedReal}, outside ${worktreeReal}`
  );
  // Cycles' GPU device selection and every add-on preference live in
  // userpref.blend under BLENDER_USER_CONFIG; pointing it at an empty sandbox
  // silently forces CPU rendering and drops the user's preferences.
  assert.equal(payload.env.BLENDER_USER_CONFIG, undefined);
  assert.ok(
    payload.provision.notes.some((note) => note.includes("addon_utils.enable")),
    `a sandboxed add-on is auto-enabled in neither startup mode: ${JSON.stringify(payload.provision.notes)}`
  );
});

test("--blender-sandbox on a non-isolated run says it did nothing", () => {
  // The sandbox is torn down with the worktree. Building one in the user's real
  // checkout would leave a junction behind that nothing cleans up, so the flag
  // declines rather than half-applying - and says so.
  const repo = makeTempDir("grok-blender-noisolate-");
  const binDir = makeTempDir("grok-blender-noisolate-bin-");
  const pluginDataDir = makeTempDir("grok-blender-noisolate-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "myaddon"), { recursive: true });
  fs.writeFileSync(path.join(repo, "myaddon", "__init__.py"), "bl_info = {}\n");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "run", "--write", "--no-isolate", "--json", "--blender-sandbox", "--no-verify", "edit"],
    { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.worktree, null);
  assert.ok(
    payload.provision.notes.some((note) => note.includes("--blender-sandbox needs an isolated")),
    JSON.stringify(payload.provision)
  );
  assert.deepEqual(payload.env, {});
  assert.ok(
    !fs.existsSync(path.join(repo, ".grok-build")),
    "nothing may be created in the user's real checkout"
  );
});

test("a Godot cache that git already checked out is reported, not silently skipped", () => {
  // Isolated default is a private (copy) cache. A repository that TRACKS its
  // `.godot` has seed files already checked out into every new worktree, so
  // each copy lands as "destination already exists" — and that must be visible
  // rather than silent. Explicit shared-link mode still has the same shape for
  // the directory itself.
  const repo = makeTempDir("grok-provision-report-");
  const binDir = makeTempDir("grok-provision-report-bin-");
  const pluginDataDir = makeTempDir("grok-provision-report-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  // Tracked on purpose - that is the precondition the whole case rests on.
  // Deliberately NO project.godot: this exercises provisioning, and a real
  // Godot project would also pull in ecosystem verify commands that need the
  // engine binary.
  fs.mkdirSync(path.join(repo, ".godot"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".godot", "uid_cache.bin"), "cache\n");
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "init with a tracked import cache"], { cwd: repo });

  const result = run("node", [SCRIPT, "run", "--write", "--json", "edit something"], {
    cwd: repo,
    // Force the shared-link path so this test still covers the classic
    // "tracked .godot blocks the junction" report.
    env: pluginDataEnv(pluginDataDir, binDir, { GROK_BUILD_LINK_GODOT_CACHE: "1" })
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.provision, "an isolated run must report what it provisioned");
  const godot = payload.provision.failed.find((entry) => entry.name === ".godot");
  assert.ok(
    godot,
    `.godot must be reported as skipped, got: ${JSON.stringify(payload.provision.failed)}`
  );
  assert.equal(godot.reason, "destination already exists");
  // Basenames only: the payload must not leak the user's filesystem layout.
  for (const entry of [...payload.provision.failed, ...payload.provision.provisioned]) {
    assert.doesNotMatch(entry.name, /[\/]/, `${entry.name} must be a basename`);
  }
  // A cache that could not be linked is not shared, so the editor warning
  // must not fire for it. Other provision notes (runtime plugin, etc.) may.
  assert.ok(
    !payload.provision.notes.some((note) => /close the Godot editor/i.test(String(note))),
    `shared-cache editor warning must not fire when the link failed, got: ${JSON.stringify(payload.provision.notes)}`
  );
  // Load-bearing for land's dirty gate: because provisioning SKIPS a tracked
  // `.godot` rather than replacing it, it can never leave the user's repo with
  // tracked dirt inside an artifact-excluded path - which is the one state
  // land now refuses outright (a conflicting squash merge hard-resets it away).
  assert.equal(
    run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repo }).stdout.trim(),
    "",
    "provisioning must not leave the user's tracked .godot modified"
  );

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    const stored = JSON.parse(fs.readFileSync(resolveJobFile(repo, jobs[0].id), "utf8"));
    assert.match(
      stored.rendered,
      /Provisioning skipped: \.godot \(already present in the worktree - it is tracked in git\)\./
    );
    // The second patchJobIfActive: the first fires before planning even starts,
    // so the summary has nowhere to attach there.
    assert.ok(stored.result.provision.failed.some((entry) => entry.name === ".godot"));
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("a project config can trade the shared Godot cache for a private copy", () => {
  // The per-project form of GROK_BUILD_LINK_GODOT_CACHE=0. End to end because
  // the value has to survive handleTask -> the request -> executeTaskRun ->
  // planWorktreeLinks, and every hop in that chain is a place it silently
  // becomes undefined.
  const repo = makeTempDir("grok-provision-copy-e2e-");
  const binDir = makeTempDir("grok-provision-copy-e2e-bin-");
  const pluginDataDir = makeTempDir("grok-provision-copy-e2e-data-");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".godot/\n.grok-build.json\n");
  fs.writeFileSync(
    path.join(repo, ".grok-build.json"),
    `${JSON.stringify({ version: 1, provision: { copy: true } }, null, 2)}\n`
  );
  fs.mkdirSync(path.join(repo, ".godot", "imported"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".godot", "uid_cache.bin"), "seed\n");
  fs.writeFileSync(path.join(repo, ".godot", "imported", "huge.ctex"), "x".repeat(512));
  run("git", ["add", "-A"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "run", "--write", "--json", "edit something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  const copied = payload.provision.provisioned.filter((entry) => entry.kind === "copy");
  assert.ok(
    copied.some((entry) => entry.name === "uid_cache.bin"),
    `expected a copied uid_cache.bin, got ${JSON.stringify(payload.provision)}`
  );
  assert.ok(
    !payload.provision.provisioned.some((entry) => entry.name === ".godot"),
    "the .godot junction must not have been created at all"
  );

  const worktreeGodot = path.join(payload.worktree.path, ".godot");
  assert.equal(
    fs.lstatSync(worktreeGodot).isSymbolicLink(),
    false,
    "a copied cache must be a real directory, not a junction into the working copy"
  );
  assert.equal(fs.readFileSync(path.join(worktreeGodot, "uid_cache.bin"), "utf8"), "seed\n");
  assert.equal(
    fs.existsSync(path.join(worktreeGodot, "imported")),
    false,
    ".godot/imported is the gigabyte part and is never copied"
  );
});

test("an isolated Godot write run reports what it changed, not just where it went", () => {
  // Item 24 end to end: the payload used to carry a worktree path and nothing
  // about the artifact, which for a Godot project IS the deliverable.
  const repo = makeTempDir("grok-manifest-iso-");
  const binDir = makeTempDir("grok-manifest-iso-bin-");
  const pluginDataDir = makeTempDir("grok-manifest-iso-data-");
  installFakeGrok(binDir, "writes-files");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "project.godot"), "config_version=5\n");
  fs.mkdirSync(path.join(repo, "assets"), { recursive: true });
  fs.writeFileSync(path.join(repo, "assets", "model.glb"), "glTF-v1\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const written = JSON.stringify({
    "scenes/Player.tscn": "[gd_scene load_steps=1 format=3]\n",
    "assets/model.glb": "glTF-v2\n",
    // What running the project produces. Never the deliverable.
    ".godot/imported/model.glb-abc.scn": "cache\n"
  });

  const result = run(
    "node",
    [SCRIPT, "run", "--json", "--write", "--no-verify", "rebuild the player scene"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_WRITE_FILES: written })
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.changedFiles.source, "commit");
  // Scene/resource paths may carry a cheap annotation ("scene edit") after the
  // path — match the status+path prefix, not a bare exact line.
  assert.ok(
    payload.changedFiles.entries.some((entry) => entry.startsWith("A\tscenes/Player.tscn")),
    payload.changedFiles.entries.join(" | ")
  );
  assert.ok(
    payload.changedFiles.entries.some((entry) => entry.startsWith("M\tassets/model.glb")),
    payload.changedFiles.entries.join(" | ")
  );
  assert.ok(
    payload.changedFiles.entries.every((entry) => !entry.includes(".godot/")),
    payload.changedFiles.entries.join(" | ")
  );
  // Mirrored onto the worktree descriptor, which is what land reads back.
  assert.deepEqual(payload.worktree.changedFiles, payload.changedFiles.entries);
  assert.equal(payload.worktree.changedFileCount, 2);

  // And the same run in text mode, which is what the user actually sees.
  const rendered = run(
    "node",
    [SCRIPT, "run", "--write", "--no-verify", "rebuild the player scene"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_WRITE_FILES: written })
    }
  );
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Changed files \(2\):/);
  assert.match(rendered.stdout, /A scenes\/Player\.tscn/);
  assert.doesNotMatch(rendered.stdout, /\.godot\/imported/);
});

test("a write run that produced only build artifacts says so, rather than going quiet", () => {
  // The silent-result complaint in its most confusing form: the agent ran, the
  // worktree has files in it, and the commit is legitimately empty because
  // every one of them was an excluded import cache.
  const repo = makeTempDir("grok-manifest-none-");
  const binDir = makeTempDir("grok-manifest-none-bin-");
  const pluginDataDir = makeTempDir("grok-manifest-none-data-");
  installFakeGrok(binDir, "writes-files");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "project.godot"), "config_version=5\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run(
    "node",
    [SCRIPT, "run", "--write", "--no-verify", "reimport the assets"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, {
        FAKE_GROK_WRITE_FILES: JSON.stringify({ ".godot/imported/blob.ctex": "cache\n" })
      })
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Changed files: none \(run produced only excluded build artifacts\)/);
});

test("a non-isolated write run separates its own edits from what was already dirty", () => {
  // A bare post-run `git status --porcelain` also lists every edit the user had
  // in flight before the run started, and calling those the agent's work is a
  // lie in the one direction that matters.
  const repo = makeTempDir("grok-manifest-wt-");
  const binDir = makeTempDir("grok-manifest-wt-bin-");
  const pluginDataDir = makeTempDir("grok-manifest-wt-data-");
  installFakeGrok(binDir, "writes-files");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# seed\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "original\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // The user's own uncommitted edit, in flight before the run starts.
  fs.writeFileSync(path.join(repo, "notes.txt"), "half-written thought\n");

  const result = run(
    "node",
    [SCRIPT, "run", "--json", "--write", "--no-isolate", "--no-verify", "add a module"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, {
        FAKE_GROK_WRITE_FILES: JSON.stringify({ "src/new_module.py": "print(1)\n" })
      })
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.changedFiles.source, "working-tree");
  // Per-file, not `A src/`: git collapses a wholly untracked directory into one
  // entry unless it is asked for all of them, and a directory name is not a
  // manifest. This assertion is the guard on that flag.
  assert.deepEqual(payload.changedFiles.entries, ["A\tsrc/new_module.py"]);
  assert.equal(payload.changedFiles.preexistingDirty, 1, "notes.txt was dirty before the run");
  assert.equal(payload.worktree, null, "--no-isolate means no worktree at all");
});

test("a stream the bridge cannot parse still reaches the user, labelled as raw stdout", () => {
  // The end-to-end shape of a grok release that renames its event vocabulary:
  // every text field empty, stdout full of the answer, and the run reported as
  // "Grok did not return a final message."
  const repo = makeTempDir("grok-alien-");
  const binDir = makeTempDir("grok-alien-bin-");
  const pluginDataDir = makeTempDir("grok-alien-data-");
  installFakeGrok(binDir, "streaming-alien");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "run", "--json", "--no-verify", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.streamParsed, false);
  assert.deepEqual(payload.unknownEventTypes, ["assistant_message", "done"]);
  assert.match(payload.rawOutput, /Rebuilt the scene\./);
  assert.equal(payload.stderr, "");
  // The log path is computed rather than plumbed - meta.logFile does not exist
  // yet where executeTaskRun runs - so assert it is both present and real.
  assert.ok(payload.logFile, "the run must name its own log file");
  assert.ok(fs.existsSync(payload.logFile), `${payload.logFile} should exist`);

  const rendered = run("node", [SCRIPT, "run", "--no-verify", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /no recognized assistant messages; showing raw stdout/);
  assert.match(rendered.stdout, /unrecognized event type/);
  assert.doesNotMatch(rendered.stdout, /Grok did not return a final message/);
});

test("the runs table titles a compliant run by its report, not by its first thought", () => {
  // firstMeaningfulLine used to hand job.summary the first sentence the model
  // ever emitted; once the report contract shipped, the first line of that
  // report became the literal heading `## Result`. Neither is a title.
  const repo = makeTempDir("grok-summary-");
  const binDir = makeTempDir("grok-summary-bin-");
  const pluginDataDir = makeTempDir("grok-summary-data-");
  installFakeGrok(binDir, "reporting");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const task = run("node", [SCRIPT, "run", "--json", "--no-verify", "rebuild the scene"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(task.status, 0, task.stderr || task.stdout);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].summary, "Rebuilt the scene.");
    assert.ok(!jobs[0].summary.startsWith("##"), "the heading is not a summary");
    assert.ok(!/Let me look at/.test(jobs[0].summary), "nor is the model clearing its throat");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
