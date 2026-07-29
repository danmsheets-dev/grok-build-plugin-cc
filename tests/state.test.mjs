import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../plugins/grok-build/scripts/lib/state.mjs";

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

import { enrichJob, formatRelativeAge } from "../plugins/grok-build/scripts/lib/job-control.mjs";

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
  const { resolveResultJob } = await import("../plugins/grok-build/scripts/lib/job-control.mjs");
  const {
    generateJobId,
    upsertJob,
    writeJobFile
  } = await import("../plugins/grok-build/scripts/lib/state.mjs");

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

import { classifyJobLiveness, isJobProcessAlive } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { startHeartbeat } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";

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
