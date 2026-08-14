import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  withStateLock
} from "../plugins/turbo-build-plugin/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  // The temp fallback only applies when CLAUDE_PLUGIN_DATA is unset; clear it so
  // the test is hermetic rather than dependent on the host's plugin data root.
  const previousPluginData = process.env.CLAUDE_PLUGIN_DATA;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, /grok-cc-runs/);
  } finally {
    if (previousPluginData === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginData;
    }
  }
});

test("resolveStateDir uses CLAUDE_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: {},
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: {},
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("a job past the cap survives eviction while its worktree still exists on disk", () => {
  // Confirmed in the field, not hypothetical: a repo with heavy grok-build
  // usage pushed a job with real unmerged commits on its run branch past
  // MAX_JOBS. The old slice(0, MAX_JOBS) deleted its record on the very next
  // save - the job file, the log, and its entry in state.json - while the
  // worktree and branch stayed fully intact in git. From that point doctor,
  // prune, runs, show and land all start from listJobs(), so none of them
  // could ever find that worktree again; it was orphaned permanently, not
  // merely delayed. This test reproduces the eviction moment directly: a job
  // with a real worktree on disk must NOT be deleted just because it is the
  // oldest of 52.
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const worktreeDir = path.join(workspace, "worktree-for-job-0");
  fs.mkdirSync(worktreeDir, { recursive: true });

  // 52 jobs, not 51: job-0 AND job-1 both need to fall past MAX_JOBS (50) so
  // job-1 can serve as the "worktree field alone is not enough" control -
  // with only 51 jobs job-1 would be safely inside the top 50 regardless of
  // its worktree field, proving nothing.
  const jobs = Array.from({ length: 52 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    const record = { id: jobId, status: "completed", updatedAt, createdAt: updatedAt };
    // job-0 is the oldest and would normally be the one and only job pruned
    // (mirrors the test above); giving it a live worktree path is the only
    // difference. job-1 gets a worktree field pointing at a path that does
    // NOT exist, so mere presence of the field is not what protects a job -
    // only an existing directory does.
    if (index === 0) {
      record.worktree = { path: worktreeDir, branch: "turbo-build/job-0" };
    }
    if (index === 1) {
      record.worktree = { path: path.join(workspace, "never-existed"), branch: "turbo-build/job-1" };
    }
    fs.writeFileSync(jobFile, JSON.stringify(record, null, 2), "utf8");
    return { ...record, logFile };
  });

  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs }, null, 2), "utf8");

  saveState(workspace, { version: 1, config: {}, jobs });

  const job0File = resolveJobFile(workspace, "job-0");
  const job0Log = resolveJobLogFile(workspace, "job-0");
  const job1File = resolveJobFile(workspace, "job-1");

  assert.equal(fs.existsSync(job0File), true, "job-0's record must survive while its worktree exists");
  assert.equal(fs.existsSync(job0Log), true, "job-0's log must survive alongside its record");
  assert.equal(
    fs.existsSync(job1File),
    false,
    "job-1 has a worktree FIELD but no worktree on disk, so it is evicted like any other stale job"
  );

  let savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(
    savedState.jobs.some((job) => job.id === "job-0"),
    "job-0 stays in the index, not just its files on disk"
  );
  // The 50 newest (job-51..job-2) plus job-0 (protected past the cap) = 51.
  // job-1 is evicted (no live worktree), so this is additive protection for
  // a real worktree, not a blanket cap increase.
  assert.equal(savedState.jobs.length, 51);

  // Once the worktree is actually removed - exactly what `prune --apply`
  // does today - the job becomes evictable again on the very next save, the
  // same as any other finished run. Protection is not permanent amnesty.
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  saveState(workspace, { version: 1, config: {}, jobs: savedState.jobs });

  assert.equal(
    fs.existsSync(job0File),
    false,
    "job-0 is evicted once its worktree is actually gone, same as any finished job"
  );
  savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(!savedState.jobs.some((job) => job.id === "job-0"));
});

test("loadState quarantines corrupt state and throws instead of wiping", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, "{not-json", "utf8");

  assert.throws(() => loadState(workspace), /corrupt|quarantined/i);

  const dirEntries = fs.readdirSync(path.dirname(stateFile));
  assert.ok(dirEntries.some((name) => name.startsWith("state.json.corrupt-")));
  assert.equal(fs.existsSync(stateFile), false);
});

test("loadState returns default state when the file is missing", () => {
  const workspace = makeTempDir();
  const state = loadState(workspace);
  assert.equal(state.version, 1);
  assert.deepEqual(state.jobs, []);
  assert.deepEqual(state.config, {});
});

import { enrichJob, formatRelativeAge } from "../plugins/turbo-build-plugin/scripts/lib/job-control.mjs";

test("formatRelativeAge renders seconds and minutes", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  assert.equal(formatRelativeAge("2026-07-29T11:59:52.000Z", now), "8s ago");
  assert.equal(formatRelativeAge("2026-07-29T11:56:40.000Z", now), "3m 20s ago");
  assert.equal(formatRelativeAge(null, now), null);
  assert.equal(formatRelativeAge("not a date", now), null);
});

test("enrichJob exposes idleSeconds for an active run", () => {
  const now = Date.now();
  const enriched = enrichJob({
    id: "run-1",
    status: "running",
    kind: "task",
    jobClass: "task",
    startedAt: new Date(now - 60000).toISOString(),
    lastEventAt: new Date(now - 5000).toISOString()
  });
  assert.ok(enriched.idleSeconds >= 4 && enriched.idleSeconds <= 7, `got ${enriched.idleSeconds}`);
});

test("enrichJob leaves idleSeconds null for a finished run", () => {
  const enriched = enrichJob({
    id: "run-2",
    status: "completed",
    kind: "task",
    jobClass: "task",
    lastEventAt: new Date().toISOString()
  });
  assert.equal(enriched.idleSeconds, null);
});

test("enrichJob computes duration for completed-unverified and timed-out", () => {
  const startedAt = "2026-07-29T12:00:00.000Z";
  const completedAt = "2026-07-29T12:05:30.000Z";

  for (const status of ["completed-unverified", "timed-out"]) {
    const enriched = enrichJob({
      id: `run-${status}`,
      status,
      kind: "task",
      jobClass: "task",
      startedAt,
      completedAt
    });
    assert.equal(
      enriched.duration,
      "5m 30s",
      `duration missing for terminal status ${status}`
    );
  }
});

test("resolveResultJob finds completed-unverified and timed-out runs", async () => {
  const { resolveResultJob } = await import("../plugins/turbo-build-plugin/scripts/lib/job-control.mjs");
  const {
    generateJobId,
    upsertJob,
    writeJobFile
  } = await import("../plugins/turbo-build-plugin/scripts/lib/state.mjs");

  const workspace = makeTempDir("grok-result-job-");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const pluginDataDir = makeTempDir("grok-result-data-");
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    for (const status of ["completed-unverified", "timed-out"]) {
      const jobId = generateJobId("run");
      const job = {
        id: jobId,
        status,
        kind: "task",
        kindLabel: "delegate",
        title: "Grok Build Delegate",
        jobClass: "task",
        summary: status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeJobFile(workspace, jobId, job);
      upsertJob(workspace, job);

      const resolved = resolveResultJob(workspace, jobId);
      assert.equal(resolved.job.id, jobId);
      assert.equal(resolved.job.status, status);
    }
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

import { classifyJobLiveness, isJobProcessAlive } from "../plugins/turbo-build-plugin/scripts/lib/job-control.mjs";
import { startHeartbeat } from "../plugins/turbo-build-plugin/scripts/lib/tracked-jobs.mjs";

test("isJobProcessAlive returns null when a run records no pids", () => {
  assert.equal(isJobProcessAlive({}), null);
});

test("isJobProcessAlive treats EPERM as alive", () => {
  const alive = isJobProcessAlive({ agentPid: 42 }, {
    killImpl: () => {
      const error = new Error("denied");
      error.code = "EPERM";
      throw error;
    }
  });
  assert.equal(alive, true);
});

test("a running job whose pids are all dead is classified abandoned", () => {
  // The exact failure seen in the field: the process tree died and the record
  // still read running/starting 38 minutes later.
  const result = classifyJobLiveness(
    { status: "running", bridgePid: 11908, agentPid: 10860 },
    {
      killImpl: () => {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    }
  );
  assert.equal(result.abandoned, true);
  assert.equal(result.alive, false);
});

test("a finished job is never classified abandoned", () => {
  const result = classifyJobLiveness(
    { status: "completed", bridgePid: 11908 },
    { killImpl: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }
  );
  assert.equal(result.abandoned, false);
});

test("startHeartbeat patches immediately and returns a stopper", () => {
  const patches = [];
  const stop = startHeartbeat("/ws", "run-1", {
    intervalMs: 1000,
    patchImpl: (_ws, _id, patch) => patches.push(patch)
  });
  stop();
  assert.equal(patches.length, 1, "should beat once immediately, not only after the interval");
  assert.ok(patches[0].lastHeartbeatAt, "beat must carry a timestamp");
});

test("a heartbeat failure never propagates", () => {
  const stop = startHeartbeat("/ws", "run-1", {
    intervalMs: 1000,
    patchImpl: () => { throw new Error("state locked"); }
  });
  stop();
});

test("withStateLock reclaims a stale lock left by a crashed process", () => {
  // Regression: a lock file left behind with no owner information (an empty
  // file, matching what a crash mid-acquisition would leave) permanently
  // blocked every future withStateLock call for that workspace - confirmed
  // directly, it failed after ~3s and every retry after that failed
  // identically forever, with no way to recover except deleting the file
  // by hand.
  //
  // The lock's mtime is backdated here to represent what a REAL crashed
  // lock looks like: old. A fresh empty lock is a different, narrower case
  // (see "does NOT reclaim a brand-new, momentarily-empty lock" below) -
  // treating a momentarily-empty lock as instantly stale is exactly the
  // race a later fix had to close, so this test must not conflate the two.
  const workspace = makeTempDir();
  fs.mkdirSync(resolveStateDir(workspace), { recursive: true });
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, "");
  const oldTime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, oldTime, oldTime);

  const start = Date.now();
  let ran = false;
  withStateLock(workspace, () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.ok(Date.now() - start < 2000, "should reclaim quickly, not exhaust the full retry budget");
});

test("withStateLock reclaims a lock whose recorded pid is no longer alive", () => {
  const workspace = makeTempDir();
  fs.mkdirSync(resolveStateDir(workspace), { recursive: true });
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAt: Date.now() }));

  let ran = false;
  withStateLock(workspace, () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("withStateLock reclaims a lock older than the staleness window even with a live pid", () => {
  const workspace = makeTempDir();
  fs.mkdirSync(resolveStateDir(workspace), { recursive: true });
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 10 * 60 * 1000 }));

  let ran = false;
  withStateLock(workspace, () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test("withStateLock does NOT reclaim a genuinely live, recent lock", async () => {
  // The critical safety property: real contention must still be respected.
  // A second real process holding the lock must make withStateLock wait,
  // not treat it as stale just because someone else got there first.
  const workspace = makeTempDir();
  const holderScript = path.join(workspace, "holder.mjs");
  fs.writeFileSync(
    holderScript,
    `import { withStateLock } from ${JSON.stringify(
      pathToFileURL(path.resolve("plugins/turbo-build-plugin/scripts/lib/state.mjs")).href
    )};\n` +
      `withStateLock(${JSON.stringify(workspace)}, () => {\n` +
      `  const end = Date.now() + 1200;\n` +
      `  while (Date.now() < end) {}\n` +
      `});\n`
  );

  const child = spawn(process.execPath, [holderScript], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const start = Date.now();
  let ran = false;
  withStateLock(workspace, () => {
    ran = true;
  });
  const elapsed = Date.now() - start;

  await new Promise((resolve) => child.on("exit", resolve));

  assert.equal(ran, true);
  assert.ok(elapsed > 700, `expected to wait for real contention, only waited ${elapsed}ms`);
});

test("saveState survives an unlink failure on a pruned job artifact", () => {
  // Regression: removeFileIfExists/removeJobFile did existsSync-then-unlinkSync
  // with no error handling at all. A prune target that unlinkSync cannot
  // remove for any reason (a Windows AV scanner transiently holding a
  // just-written log file is the real-world trigger; a directory reproduces
  // the same EPERM deterministically here) aborted the ENTIRE saveState call
  // - which runs inside claimJobTerminal - so a run that finished cleanly
  // could get stuck reporting "running" forever because pruning some
  // UNRELATED old job's leftovers threw partway through the save.
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }), "utf8");
    return { id: jobId, status: "completed", logFile, updatedAt, createdAt: updatedAt };
  });
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, config: {}, jobs }), "utf8");

  // job-0 falls outside the retained MAX_JOBS window, so it is exactly what
  // gets pruned. Make its job file a directory so unlinkSync deterministically
  // throws EPERM rather than actually deleting it.
  const prunedJobFile = resolveJobFile(workspace, "job-0");
  fs.rmSync(prunedJobFile, { force: true });
  fs.mkdirSync(prunedJobFile);

  assert.doesNotThrow(() => {
    saveState(workspace, { version: 1, config: {}, jobs });
  });

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50, "pruning must still complete for every OTHER job");
});

test("withStateLock does NOT reclaim a brand-new, momentarily-empty lock", () => {
  // Regression found by a second-round audit of the earlier stale-lock fix:
  // the lock file is created via openSync(path, "wx") and only THEN has its
  // {pid, createdAt} payload written by a separate write, leaving an
  // observable window where the file exists but is empty. The original fix
  // treated ANY unparseable content as instantly stale regardless of age,
  // so a contender checking during that window reclaimed a brand-new lock
  // after ~90ms - confirmed directly - letting two processes into the
  // critical section simultaneously, exactly the race this lock exists to
  // prevent. The fix falls back to the lock file's own mtime rather than
  // assuming "no parseable content" means "dead".
  const workspace = makeTempDir();
  fs.mkdirSync(resolveStateDir(workspace), { recursive: true });
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, "");

  assert.throws(
    () => withStateLock(workspace, () => {}),
    /Timed out acquiring state lock/,
    "a fresh empty lock must be respected like real contention, not reclaimed instantly"
  );
});

test("withStateLock reclaims empty/unparseable lock content once it is genuinely old", () => {
  const workspace = makeTempDir();
  fs.mkdirSync(resolveStateDir(workspace), { recursive: true });
  const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lockPath, "");
  const oldTime = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, oldTime, oldTime);

  let ran = false;
  withStateLock(workspace, () => {
    ran = true;
  });
  assert.equal(ran, true);
});
