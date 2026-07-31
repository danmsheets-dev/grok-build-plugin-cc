import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGitCommonDir, resolveMainWorktreeRoot } from "./git.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "grok-cc-runs");
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.json.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_MAX_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;

function nowIso() {
  return new Date().toISOString();
}

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

function resolveBridgePidField(existing = {}, patch = {}) {
  if (patch.bridgePid !== undefined) {
    return patch.bridgePid;
  }
  if (patch.companionPid !== undefined) {
    return patch.companionPid;
  }
  return existing.bridgePid ?? existing.companionPid ?? null;
}

/**
 * Build a state directory path under the plugin data / temp root for a given
 * identity key and slug source path.
 *
 * @param {string} identityKey - stable string hashed into the directory name
 * @param {string} slugSource - human-readable basename source
 * @returns {string}
 */
function stateDirForIdentity(identityKey, slugSource) {
  const slug =
    String(slugSource || "workspace")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(String(identityKey)).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

/**
 * Canonical state directory for a workspace.
 *
 * Keyed on `git rev-parse --git-common-dir` when available so a run launched
 * from inside a linked worktree records into the SAME state dir as one launched
 * from the main checkout. Nested Hyper children started from a parent's
 * worktree otherwise wrote history the top-level caller never listed.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function resolveStateDir(cwd) {
  const commonDir = resolveGitCommonDir(cwd);
  if (commonDir) {
    const mainRoot = resolveMainWorktreeRoot(cwd);
    const slugSource = path.basename(mainRoot) || "workspace";
    return stateDirForIdentity(commonDir, slugSource);
  }

  // Non-git cwd (or git unavailable): historical show-toplevel / path identity.
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  return stateDirForIdentity(canonical, path.basename(workspaceRoot) || "workspace");
}

/**
 * Pre-common-dir state directory (keyed on show-toplevel / worktree path).
 *
 * Runs launched from inside a worktree before R6-3 recorded here. Readers
 * still consult this path so land/prune/runs do not strand those records.
 *
 * @param {string} cwd
 * @returns {string|null} null when it coincides with the canonical dir
 */
export function resolveLegacyStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonical = workspaceRoot;
  }
  const legacy = stateDirForIdentity(canonical, path.basename(workspaceRoot) || "workspace");
  const primary = resolveStateDir(cwd);
  if (path.resolve(legacy) === path.resolve(primary)) {
    return null;
  }
  return legacy;
}

/**
 * Ordered state directories to consult for reads: primary first, then legacy
 * when it differs and still exists on disk.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function resolveStateDirCandidates(cwd) {
  const primary = resolveStateDir(cwd);
  const legacy = resolveLegacyStateDir(cwd);
  const out = [primary];
  if (legacy && fs.existsSync(legacy)) {
    out.push(legacy);
  }
  return out;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

// Windows only ever lets ONE handle rename over an existing file, and every
// concurrent reader holds one. Measured directly on Win10 with four reader
// processes doing plain readFileSync in a loop against one writer doing
// write-temp-then-rename: 43 renames succeeded and 15,802 failed with EPERM.
// The readers never failed - the WRITER is the victim.
//
// That is not a theoretical race, it is the documented `run --background` +
// poll `runs` workflow: the supervisor's poll loop is the reader, the detached
// worker is the writer, and every job-file write the worker attempts while a
// poll is in flight throws. The throw escaped through the progress updater
// (called from a child-process 'close' handler, so an uncaught exception rather
// than a rejected promise) and killed the worker silently, mid-run, with no
// terminal claim and a log frozen at whatever line was appended last.
//
// Retry the rename rather than the whole write: the temp file is already on
// disk and correct, only the publish step is contended. The sharing conflict
// clears as soon as the reader closes its handle, which is microseconds.
const RENAME_MAX_ATTEMPTS = 60;
const RENAME_RETRY_MS = 5;
const RENAME_CONTENTION_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tempPath, content, "utf8");

  let lastError = null;
  for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      if (!RENAME_CONTENTION_CODES.has(error?.code)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Best effort; the real error below is what matters.
        }
        throw error;
      }
      lastError = error;
      sleepMs(RENAME_RETRY_MS);
    }
  }

  // Every retry lost the race. Publishing the content matters more than
  // publishing it atomically: a reader that catches a torn read retries (see
  // readJobFileIfPresent / loadState), but a run whose terminal claim never
  // lands is lost forever. Write in place as the last resort.
  try {
    fs.writeFileSync(filePath, content, "utf8");
  } catch {
    throw lastError;
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Leftover temp files are swept by prune; never fail a write over one.
    }
  }
}

// Confirmed directly: a lock file left behind by a crashed process (no PID,
// no timestamp, just an empty file) permanently blocked every future
// withStateLock call for that workspace - every run, /stop, doctor, and
// prune - with no way to recover except a human manually deleting the file.
const STALE_LOCK_TTL_MS = 5 * 60 * 1000;

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function reclaimLockIfStale(lockPath) {
  // Confirmed by direct reproduction: a lock file is created via
  // openSync(path, "wx") and only THEN has its {pid, createdAt} payload
  // written by a separate write - there is an observable window where the
  // file exists but is empty. The original version of this function treated
  // ANY unparseable content as instantly stale regardless of age, so a
  // contender that happened to check during that window reclaimed a
  // brand-new lock after ~90ms and entered the critical section alongside
  // its rightful owner - the exact two-writer race this lock exists to
  // prevent. The fix: when content cannot establish an age, fall back to the
  // lock FILE's own mtime (set at creation, available even before any
  // content is written) rather than assuming zero information means "dead".
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return;
  }

  let content = "";
  try {
    content = fs.readFileSync(lockPath, "utf8");
  } catch {
    return;
  }

  let holder = null;
  try {
    holder = JSON.parse(content);
  } catch {
    // Empty or unparseable: could be an old-format lock, a crash mid-write,
    // or - the case that matters - a legitimate acquisition still in
    // progress. Age is judged by mtime below rather than assumed.
  }

  const pid = Number(holder?.pid);
  const recordedCreatedAt = Number(holder?.createdAt);
  const referenceTime = Number.isFinite(recordedCreatedAt) ? recordedCreatedAt : stat.mtimeMs;

  const pidKnownDead = Number.isFinite(pid) && !isPidAlive(pid);
  const tooOld = Date.now() - referenceTime > STALE_LOCK_TTL_MS;

  if (pidKnownDead || tooOld) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Another process may have already reclaimed or released it - fine,
      // the normal wx-exclusive retry loop below is what actually decides
      // who wins the next attempt.
    }
  }
}

export function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockPath = path.join(resolveStateDir(cwd), LOCK_FILE_NAME);

  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code === "EEXIST") {
        reclaimLockIfStale(lockPath);
        sleepMs(LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }

    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    } catch {
      // Metadata is an aid to staleness detection, not a correctness
      // requirement - an unparseable/empty lock is itself treated as stale.
    }

    try {
      return fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
      }
    }
  }

  throw new Error(`Timed out acquiring state lock at ${lockPath}`);
}

// Terminal statuses beyond plain completed/failed/cancelled. The honest ladder
// in decideCompletionStatus (tracked-jobs.mjs) can land on any of these; each
// must be recognized by claimJobTerminal, runs/show filters, and land/prune
// guards. cancelled still wins over everything, so a run the user stopped is
// never reported as finished by a worker that lands moments later.
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "completed-unverified",
  "completed-truncated",
  "completed-noop",
  "completed-blind",
  // Parent agent finished but one or more nested children failed, cancelled,
  // timed out, or were still live when the parent drain cancelled them.
  "completed-with-failed-children",
  "timed-out",
  // Agent wrote into the main checkout during an isolated run. Terminal and
  // never success — decideCompletionStatus and the report contract both treat
  // it as a hard failure of the isolation guarantee.
  "isolation-breached"
]);

export function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

/** Fields the shared index must mirror so `runs --json` does not show null for values that only live in jobs/<id>.json. */
const INDEX_TERMINAL_MIRROR_FIELDS = [
  "usage",
  "resolvedModel",
  "stopReason",
  "write",
  "verified",
  "changedFileCount",
  "toolCallCount",
  "worktree",
  // Isolation outcome that survives worktree cleanup (R6-2).
  "isolation",
  "isolationBreached",
  "isolateSource",
  "grokVersion",
  "model",
  // Nested delegation linkage: runs groups children under parents when these
  // are on the index. Additive only — older records simply omit them.
  "parentRunId",
  "nestDepth",
  "children"
];

function pickIndexMirrorFields(source = {}) {
  const picked = {};
  for (const key of INDEX_TERMINAL_MIRROR_FIELDS) {
    if (source[key] !== undefined) {
      picked[key] = source[key];
    }
  }
  return picked;
}

function readJobFileIfPresent(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function writeJobFileUnlocked(cwd, jobId, payload) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveJobFile(cwd, jobId), `${JSON.stringify(payload, null, 2)}\n`);
}

function upsertJobInState(state, jobPatch) {
  const timestamp = nowIso();
  const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
  if (existingIndex === -1) {
    state.jobs.unshift({
      createdAt: timestamp,
      updatedAt: timestamp,
      ...jobPatch
    });
    return;
  }
  state.jobs[existingIndex] = {
    ...state.jobs[existingIndex],
    ...jobPatch,
    updatedAt: timestamp
  };
}

/** Claim terminal status for job file + index under one lock. cancelled wins. */
export function claimJobTerminal(cwd, jobId, nextStatus, patch = {}) {
  if (!isTerminalJobStatus(nextStatus)) {
    throw new Error(`claimJobTerminal requires a terminal status, got: ${nextStatus}`);
  }

  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;

    if (!existing) {
      return { claimed: false, status: null, job: null, reason: "missing" };
    }

    const currentStatus = existing.status;
    if (isTerminalJobStatus(currentStatus)) {
      if (currentStatus === "cancelled" && nextStatus !== "cancelled") {
        return { claimed: false, status: "cancelled", job: existing, reason: "cancelled-wins" };
      }
      if (nextStatus === "cancelled" && currentStatus !== "cancelled") {
        return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
      }
      if (currentStatus === "cancelled" && nextStatus === "cancelled") {
        const merged = {
          ...existing,
          ...patch,
          id: jobId,
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          agentPid: null,
          updatedAt: nowIso()
        };
        writeJobFileUnlocked(cwd, jobId, merged);
        upsertJobInState(state, {
          id: jobId,
          status: "cancelled",
          phase: "cancelled",
          summary: merged.summary ?? existing.summary,
          threadId: merged.threadId ?? existing.threadId ?? null,
          pid: null,
          agentPid: null,
          errorMessage: merged.errorMessage ?? existing.errorMessage,
          // Usage/model/counts can arrive on a late cancel merge after the
          // worker finished streaming; keep them on the index so runs still
          // shows what the cancelled run spent.
          ...pickIndexMirrorFields({ ...existing, ...merged })
        });
        saveStateUnlocked(cwd, state);
        return { claimed: false, status: "cancelled", job: merged, reason: "cancelled-merge" };
      }
      return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
    }

    const completedAt = patch.completedAt ?? nowIso();
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      status: nextStatus,
      phase: patch.phase ?? (nextStatus === "completed" ? "done" : nextStatus),
      pid: patch.pid === undefined ? null : patch.pid,
      agentPid: patch.agentPid === undefined ? null : patch.agentPid,
      bridgePid: resolveBridgePidField(existing, patch),
      completedAt,
      updatedAt: nowIso()
    };
    if (nextStatus === "cancelled") {
      nextJob.cancelledAt = patch.cancelledAt ?? completedAt;
    }

    writeJobFileUnlocked(cwd, jobId, nextJob);
    upsertJobInState(state, {
      id: jobId,
      status: nextStatus,
      phase: nextJob.phase,
      summary: nextJob.summary ?? existing.summary,
      threadId: nextJob.threadId ?? existing.threadId ?? null,
      turnId: nextJob.turnId ?? existing.turnId ?? null,
      pid: null,
      agentPid: null,
      bridgePid: nextJob.bridgePid ?? null,
      errorMessage: nextJob.errorMessage,
      completedAt,
      logFile: nextJob.logFile ?? existing.logFile ?? null,
      sessionId: nextJob.sessionId ?? existing.sessionId,
      kind: nextJob.kind ?? existing.kind,
      kindLabel: nextJob.kindLabel ?? existing.kindLabel,
      title: nextJob.title ?? existing.title,
      jobClass: nextJob.jobClass ?? existing.jobClass,
      write: nextJob.write ?? existing.write,
      parentRunId: nextJob.parentRunId ?? existing.parentRunId ?? null,
      nestDepth: nextJob.nestDepth ?? existing.nestDepth ?? null,
      children: nextJob.children ?? existing.children,
      // jobs/<id>.json already holds the full record; the index used to drop
      // usage/stopReason/counts, so runs --json showed null for every finished
      // run even when the job file had them. Mirror the fields that runs/show
      // need without re-reading every job file on list.
      ...pickIndexMirrorFields(nextJob)
    });
    saveStateUnlocked(cwd, state);
    return { claimed: true, status: nextStatus, job: nextJob, reason: "claimed" };
  });
}

/** Patch non-terminal job under lock; no-op if missing/terminal. */
export function patchJobIfActive(cwd, jobId, patch = {}) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;
    if (!existing) {
      return { patched: false, status: null, job: null, reason: "missing" };
    }
    if (isTerminalJobStatus(existing.status)) {
      return { patched: false, status: existing.status, job: existing, reason: "terminal" };
    }

    const bridgePid = resolveBridgePidField(existing, patch);
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      bridgePid,
      agentPid: patch.agentPid !== undefined ? patch.agentPid : (existing.agentPid ?? null),
      pid:
        patch.pid !== undefined
          ? patch.pid
          : (bridgePid ?? existing.pid ?? null),
      updatedAt: nowIso()
    };

    writeJobFileUnlocked(cwd, jobId, nextJob);
    // R7-5: mirror usage/resolvedModel onto the index for ACTIVE runs too.
    // Finished runs already get these via claimJobTerminal; without this,
    // runs --json showed null cost/tokens mid-run even when the job file
    // had live usage from stream progress events.
    upsertJobInState(state, {
      id: jobId,
      status: nextJob.status,
      phase: nextJob.phase,
      summary: nextJob.summary,
      threadId: nextJob.threadId,
      turnId: nextJob.turnId,
      pid: nextJob.pid,
      agentPid: nextJob.agentPid,
      bridgePid: nextJob.bridgePid,
      logFile: nextJob.logFile,
      errorMessage: nextJob.errorMessage,
      ...(nextJob.usage !== undefined ? { usage: nextJob.usage } : {}),
      ...(nextJob.resolvedModel !== undefined ? { resolvedModel: nextJob.resolvedModel } : {}),
      ...(nextJob.toolCallCount !== undefined ? { toolCallCount: nextJob.toolCallCount } : {})
    });
    saveStateUnlocked(cwd, state);
    return { patched: true, status: nextJob.status, job: nextJob, reason: "patched" };
  });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  // Same publish race as readJobFile, with a sharper edge: the failure branch
  // below QUARANTINES the file (renames it out of the way). A torn read caught
  // mid-write would therefore not just fail one command, it would move every
  // run record in the workspace aside and report the state as corrupt. So the
  // read is exhausted first, and only content that stays unparseable for the
  // whole window is treated as genuinely corrupt.
  let raw = "";
  let readError = null;
  let parseError = null;
  for (let attempt = 0; attempt < READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      raw = fs.readFileSync(stateFile, "utf8");
      readError = null;
    } catch (error) {
      if (!READ_CONTENTION_CODES.has(error?.code)) {
        throw new Error(`Failed to read bridge state file ${stateFile}: ${error.message}`);
      }
      readError = error;
      sleepMs(READ_RETRY_MS);
      continue;
    }

    if (!raw.trim()) {
      return defaultState();
    }

    try {
      const parsed = JSON.parse(raw);
      return {
        ...defaultState(),
        ...parsed,
        config: {
          ...defaultState().config,
          ...(parsed.config ?? {})
        },
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
      };
    } catch (error) {
      parseError = error;
      sleepMs(READ_RETRY_MS);
    }
  }

  if (readError) {
    throw new Error(`Failed to read bridge state file ${stateFile}: ${readError.message}`);
  }

  const quarantinePath = `${stateFile}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(stateFile, quarantinePath);
  } catch {
  }
  throw new Error(
    `Bridge state file is corrupt and was quarantined${quarantinePath ? ` to ${quarantinePath}` : ""}: ${parseError?.message ?? "unparseable"}`
  );
}

// Confirmed in the field: a repo with heavy grok-build usage (dozens of write
// runs across a session) pushes old jobs past MAX_JOBS while their worktree
// still exists, sometimes with real unmerged commits on the run branch. The
// plain slice(0, MAX_JOBS) below used to delete that job's record - the ONLY
// thing every other command (doctor, prune, runs, show, land) uses to find
// the worktree - unconditionally. From that point on the worktree and its
// branch are still sitting on disk, fully intact in git, but PERMANENTLY
// invisible to every one of those commands: prune's own collectPrunePlan and
// doctor's stale-worktree/awaiting-land checks both start from listJobs(),
// so a job that never makes it into that list can never be found, landed, or
// even reported as stale again. This is the same "never silently destroy
// unlanded work" invariant land's dirty-tree gate protects - the eviction
// path here just never knew about it.
//
// The fix does not require a git call (which would pull worktree.mjs into a
// module that is otherwise fs/os/path/crypto only): a job whose recorded
// worktree directory is still present on disk stays in the index, however
// far past MAX_JOBS it falls, until prune/land/discard actually removes that
// directory - at which point it becomes evictable again on the next save,
// exactly like any other finished job. MAX_JOBS therefore caps the ordinary,
// already-cleaned-up case; it was never meant to be the thing deciding
// whether a live worktree's bookkeeping survives.
/**
 * True when the job's recorded worktree directory still exists on disk.
 *
 * Used by MAX_JOBS eviction and SessionEnd cleanup so a finished write run
 * with unlanded work is never dropped from the index (which would make the
 * worktree permanently invisible to land/prune/runs/doctor).
 */
export function jobHasLiveWorktree(job) {
  const worktreePath = job?.worktree?.path;
  if (!worktreePath || typeof worktreePath !== "string") {
    return false;
  }
  try {
    return fs.existsSync(worktreePath);
  } catch {
    return false;
  }
}

function pruneJobs(jobs) {
  const sorted = [...jobs].sort(
    (left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
  return sorted.filter((job, index) => index < MAX_JOBS || jobHasLiveWorktree(job));
}

function removeFileIfExists(filePath) {
  if (!filePath) {
    return;
  }
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort. This runs during job-artifact pruning inside
    // claimJobTerminal, which must not fail because an UNRELATED old job's
    // leftover log file happens to be transiently locked (a Windows AV
    // scanner opening a just-written file is a common, real cause) - a run
    // that finished cleanly would otherwise report stuck as "running"
    // forever because pruning some other job's leftovers threw partway
    // through the save.
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

/**
 * Load state.json from an explicit state directory (not via resolveStateDir).
 * @param {string} stateDir
 */
function loadStateFromDir(stateDir) {
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  let raw = "";
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch {
    return defaultState();
  }
  if (!raw.trim()) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

/**
 * Jobs from the canonical state dir, plus any jobs that only exist under a
 * legacy per-worktree state dir (pre-R6-3). Primary wins on id collision.
 *
 * @param {string} cwd
 * @returns {object[]}
 */
export function listJobs(cwd) {
  const primary = loadState(cwd).jobs;
  const byId = new Map(primary.map((job) => [job.id, job]));
  const legacy = resolveLegacyStateDir(cwd);
  if (legacy && fs.existsSync(legacy)) {
    for (const job of loadStateFromDir(legacy).jobs) {
      if (job?.id && !byId.has(job.id)) {
        byId.set(job.id, job);
      }
    }
  }
  return [...byId.values()];
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

// The other half of the Windows publish race. A reader can arrive in the
// instant between unlink and rename (ENOENT), while the target handle is being
// swapped (EPERM/EBUSY), or - when writeFileAtomic fell back to an in-place
// write - part-way through the new bytes (JSON.parse SyntaxError). None of
// those mean the record is gone or corrupt; they mean "come back in a
// millisecond". Only a read that keeps failing for the whole window is real.
// ~200ms of patience. The contended window is normally microseconds (a reader
// closing its handle), but a loaded machine can stretch a writer's fallback
// write well past that, and the cost of waiting is paid only on the path that
// would otherwise have failed outright.
const READ_MAX_ATTEMPTS = 40;
const READ_RETRY_MS = 5;
const READ_CONTENTION_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);

export function readJobFile(jobFile) {
  let lastError = null;
  for (let attempt = 0; attempt < READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(jobFile, "utf8"));
    } catch (error) {
      const retryable = READ_CONTENTION_CODES.has(error?.code) || error instanceof SyntaxError;
      if (!retryable) {
        throw error;
      }
      lastError = error;
      sleepMs(READ_RETRY_MS);
    }
  }
  throw lastError;
}

function removeJobFile(jobFile) {
  try {
    fs.unlinkSync(jobFile);
  } catch {
    // Best-effort; see removeFileIfExists.
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  // Prefer an existing log under primary or legacy; new writes go to primary.
  for (const dir of resolveStateDirCandidates(cwd)) {
    const candidate = path.join(dir, JOBS_DIR_NAME, `${jobId}.log`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

/**
 * Path of a job's JSON record. Reads check legacy state dirs so pre-R6-3
 * records remain landable; new writes always target the canonical dir.
 *
 * @param {string} cwd
 * @param {string} jobId
 * @returns {string}
 */
export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  for (const dir of resolveStateDirCandidates(cwd)) {
    const candidate = path.join(dir, JOBS_DIR_NAME, `${jobId}.json`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
