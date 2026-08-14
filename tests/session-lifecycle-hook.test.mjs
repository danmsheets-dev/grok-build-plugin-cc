import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";
import {
  generateJobId,
  listJobs,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "../plugins/turbo-build-plugin/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_SCRIPT = path.join(ROOT, "plugins", "turbo-build-plugin", "scripts", "session-lifecycle-hook.mjs");

function runSessionEnd(cwd, pluginDataDir, sessionId) {
  const input = JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, cwd });
  return run("node", [HOOK_SCRIPT, "SessionEnd"], {
    cwd,
    env: { ...process.env, CLAUDE_PLUGIN_DATA: pluginDataDir },
    input
  });
}

function seedJob(workspaceRoot, id, sessionId, status = "running") {
  const record = { id, sessionId, status, kind: "task", jobClass: "task" };
  writeJobFile(workspaceRoot, id, record);
  upsertJob(workspaceRoot, record);
  fs.writeFileSync(resolveJobLogFile(workspaceRoot, id), "log\n", "utf8");
  return record;
}

/**
 * Run fn with CLAUDE_PLUGIN_DATA set to pluginDataDir, restoring it
 * afterward. Every path resolution that depends on it (resolveJobFile,
 * resolveJobLogFile, the hook's own state lookups) must happen INSIDE fn -
 * resolving a path after this restores the env var recomputes it against
 * the wrong state directory entirely.
 */
function withPluginData(pluginDataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("SessionEnd cancels and removes only jobs belonging to the ending session", () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  const outcome = withPluginData(pluginDataDir, () => {
    const endingJobId = generateJobId("run");
    const otherJobId = generateJobId("run");
    seedJob(workspaceRoot, endingJobId, "session-ending", "running");
    seedJob(workspaceRoot, otherJobId, "session-other", "running");

    const result = runSessionEnd(workspaceRoot, pluginDataDir, "session-ending");

    // Resolve every path and read every file NOW, while CLAUDE_PLUGIN_DATA
    // still points at pluginDataDir - resolving these after withPluginData
    // returns would recompute them against the restored (wrong) directory.
    const otherJobFile = resolveJobFile(workspaceRoot, otherJobId);
    const otherLogFile = resolveJobLogFile(workspaceRoot, otherJobId);
    return {
      result,
      endingJobStillIndexed: listJobs(workspaceRoot).some((job) => job.id === endingJobId),
      otherJobExists: fs.existsSync(otherJobFile),
      otherLogExists: fs.existsSync(otherLogFile),
      otherRecord: fs.existsSync(otherJobFile) ? JSON.parse(fs.readFileSync(otherJobFile, "utf8")) : null
    };
  });

  assert.equal(outcome.result.status, 0, outcome.result.stderr);

  // The ending session's job is removed from the index entirely - it was
  // cancelled and its session has ended, so saveState's own pruning (a job
  // present before the write but absent from the retained set has its files
  // reclaimed) correctly cleans it up. That reclaiming is pre-existing,
  // intentional behaviour, not the bug this test guards against.
  assert.equal(outcome.endingJobStillIndexed, false);

  // The other session's job must be completely untouched: both its state
  // index entry AND its files on disk.
  //
  // Regression: cleanupSessionJobs used to read state, then separately call
  // saveState with that snapshot once the cancel loop finished - a plain
  // read-modify-write outside any lock. If another process (a different
  // session, or this session's own background worker) wrote a new job in
  // that window, saveState's own pruning logic saw it as "dropped" relative
  // to the stale snapshot and deleted its files from disk. Reproduced
  // directly: an unrelated session's job file was deleted by this exact
  // sequence. The fix routes the whole read+filter+write through
  // updateState, which holds one lock across the entire operation, so no
  // externally-written job can ever look "dropped" by comparison to a
  // snapshot that predates it.
  assert.equal(outcome.otherJobExists, true, "other session's job file must survive");
  assert.equal(outcome.otherLogExists, true, "other session's log file must survive");
  assert.equal(outcome.otherRecord?.status, "running", "other session's job must be untouched, not cancelled");
});

test("SessionEnd is a no-op when no jobs belong to the ending session", () => {
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();

  const outcome = withPluginData(pluginDataDir, () => {
    const otherJobId = generateJobId("run");
    seedJob(workspaceRoot, otherJobId, "session-other", "running");
    const result = runSessionEnd(workspaceRoot, pluginDataDir, "session-with-no-jobs");
    const otherJobFile = resolveJobFile(workspaceRoot, otherJobId);
    return { result, otherJobExists: fs.existsSync(otherJobFile) };
  });

  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.equal(outcome.otherJobExists, true);
});

test("SessionEnd retains completed write runs whose worktree still holds unlanded work", () => {
  // Regression: cleanupSessionJobs filtered every job of the ending session
  // by sessionId alone, then saveState reclaimed the job file and log. The
  // worktree directory survived on disk but became permanently invisible to
  // land / prune / runs / doctor.
  const workspaceRoot = makeTempDir();
  const pluginDataDir = makeTempDir();
  const worktreePath = path.join(workspaceRoot, "wt-unlanded");
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "REAL-WORK.txt"), "keep me\n", "utf8");

  const outcome = withPluginData(pluginDataDir, () => {
    const jobId = generateJobId("run");
    const record = {
      id: jobId,
      sessionId: "session-ending",
      status: "completed",
      kind: "task",
      jobClass: "task",
      write: true,
      worktree: {
        path: worktreePath,
        branch: `turbo-build/${jobId}`,
        baseSha: "abc123"
      }
    };
    writeJobFile(workspaceRoot, jobId, record);
    upsertJob(workspaceRoot, record);
    fs.writeFileSync(resolveJobLogFile(workspaceRoot, jobId), "log\n", "utf8");

    const result = runSessionEnd(workspaceRoot, pluginDataDir, "session-ending");
    const jobs = listJobs(workspaceRoot);
    const jobFile = resolveJobFile(workspaceRoot, jobId);
    const logFile = resolveJobLogFile(workspaceRoot, jobId);
    return {
      result,
      stillIndexed: jobs.some((job) => job.id === jobId),
      indexed: jobs.find((job) => job.id === jobId) ?? null,
      jobFileExists: fs.existsSync(jobFile),
      logFileExists: fs.existsSync(logFile),
      worktreeExists: fs.existsSync(worktreePath),
      realWorkExists: fs.existsSync(path.join(worktreePath, "REAL-WORK.txt"))
    };
  });

  assert.equal(outcome.result.status, 0, outcome.result.stderr);
  assert.equal(outcome.stillIndexed, true, "completed unlanded run must stay in the index");
  assert.equal(outcome.jobFileExists, true, "job file must survive SessionEnd");
  assert.equal(outcome.logFileExists, true, "log file must survive SessionEnd");
  assert.equal(outcome.worktreeExists, true);
  assert.equal(outcome.realWorkExists, true);
  assert.equal(
    outcome.indexed?.sessionId,
    null,
    "retained run is re-keyed off the ended session so a later SessionEnd does not re-process it"
  );
  assert.equal(outcome.indexed?.sessionEnded, true);
});
