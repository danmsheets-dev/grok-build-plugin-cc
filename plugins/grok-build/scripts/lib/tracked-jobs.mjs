import fs from "node:fs";
import process from "node:process";

import { redactSecrets, redactSecretsDeep } from "./redact.mjs";
import {
  claimJobTerminal,
  isTerminalJobStatus,
  patchJobIfActive,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

/**
 * Redact text-bearing terminal fields before they hit disk or --json stdout.
 * Structural control fields (ids, status, phase, timestamps, pids, paths) stay
 * literal; only result/payload/summary/rendered/verify/error text is scrubbed.
 */
function redactTerminalClaimPatch(patch = {}) {
  const next = { ...patch };
  if (next.result !== undefined) {
    next.result = redactSecretsDeep(next.result);
  }
  if (next.partialResult !== undefined) {
    next.partialResult = redactSecretsDeep(next.partialResult);
  }
  if (next.verify !== undefined) {
    next.verify = redactSecretsDeep(next.verify);
  }
  if (typeof next.summary === "string") {
    next.summary = redactSecrets(next.summary);
  }
  if (typeof next.rendered === "string") {
    next.rendered = redactSecrets(next.rendered);
  }
  if (typeof next.errorMessage === "string") {
    next.errorMessage = redactSecrets(next.errorMessage);
  }
  return next;
}

/**
 * Persist isolation outcome on the terminal job record so it survives worktree
 * cleanup (R6-2). `worktree` may later be nulled by land; `isolation` remains.
 */
function buildIsolationRecord(execution, job = {}) {
  const wt = execution.worktree ?? job.worktree ?? null;
  const prev =
    execution.isolation ?? job.isolation ?? execution.payload?.isolation ?? null;
  const breached = Boolean(
    execution.isolationBreached ||
      execution.payload?.isolationBreached ||
      wt?.breached ||
      prev?.breached
  );
  const path = wt?.path ?? prev?.worktree ?? null;
  const source =
    execution.isolateSource ??
    job.isolateSource ??
    execution.payload?.isolateSource ??
    prev?.source ??
    null;
  return {
    active: Boolean(path || prev?.active || execution.isolate || job.isolate),
    worktree: path,
    branch: wt?.branch ?? prev?.branch ?? null,
    baseSha: wt?.baseSha ?? prev?.baseSha ?? null,
    headSha: wt?.sha ?? wt?.headSha ?? prev?.headSha ?? null,
    breached,
    source
  };
}

export const SESSION_ID_ENV = "GROK_CC_SESSION_ID";

/** stopReasons that mean a clean, full completion rather than an early exit. */
const CLEAN_STOP_REASONS = new Set(["EndTurn", "StopSequence"]);

/**
 * Decide the terminal status from the full outcome tuple.
 *
 * First match wins. The old ladder (exit 0 → completed, else failed) stored a
 * Cancelled/max-duration run with zero tool calls as "completed", which is how
 * blind and truncated runs reached the user as success.
 *
 * @param {{
 *   timedOut?: boolean,
 *   exitStatus?: number|null,
 *   stopReason?: string|null,
 *   toolCallCount?: number|null,
 *   changedFileCount?: number|null,
 *   write?: boolean,
 *   verified?: boolean|null,
 *   hadWork?: boolean
 * }} outcome
 * @returns {string}
 */
export function decideCompletionStatus(outcome = {}) {
  const timedOut = Boolean(outcome.timedOut);
  const exitStatus = outcome.exitStatus;
  const stopReason = typeof outcome.stopReason === "string" ? outcome.stopReason.trim() : "";
  const toolCallCount =
    outcome.toolCallCount == null || !Number.isFinite(Number(outcome.toolCallCount))
      ? null
      : Number(outcome.toolCallCount);
  const changedFileCount =
    outcome.changedFileCount == null || !Number.isFinite(Number(outcome.changedFileCount))
      ? null
      : Number(outcome.changedFileCount);
  const write = Boolean(outcome.write);
  const verified = outcome.verified;
  // "Had any work to do": a prompt-only idle resume with nothing to act on is
  // not "blind". Default true so ordinary runs still trip completed-blind when
  // the agent made zero tool calls.
  const hadWork = outcome.hadWork !== false;

  // Isolation breach beats every success path: work in the wrong tree is never
  // "completed" and never "Verified: yes", even if the agent exited 0 and
  // verify inside the worktree passed.
  if (outcome.isolationBreached) {
    return "isolation-breached";
  }

  if (timedOut) {
    return "timed-out";
  }
  // Missing exitStatus is treated as failure only when the runner never set it
  // after a real process close - callers pass 0 on success. null/undefined here
  // means "unknown/failed process" rather than success.
  if (exitStatus == null || exitStatus !== 0) {
    return "failed";
  }
  if (stopReason && !CLEAN_STOP_REASONS.has(stopReason)) {
    return "completed-truncated";
  }
  if (write === true && changedFileCount === 0) {
    return "completed-noop";
  }
  // Genuine 0 only - never null (unknown). A CLI that does not emit tool
  // events must not mark every prose-only run as blind.
  if (toolCallCount === 0 && hadWork) {
    return "completed-blind";
  }
  if (verified === false) {
    return "completed-unverified";
  }
  return "completed";
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const agentPidRaw = value.agentPid ?? null;
    const agentPid = Number.isFinite(Number(agentPidRaw)) ? Number(agentPidRaw) : null;
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      agentPid,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd(),
      usage: value.usage && typeof value.usage === "object" ? value.usage : null
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    agentPid: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null,
    usage: null
  };
}

/**
 * Append to a run log, surviving Windows sharing conflicts.
 *
 * The job log is read live by `runs`/`show` and tailed by operators, and on
 * Windows an open reader can make appendFileSync fail with EPERM/EBUSY. A
 * dropped log line is a nuisance; an exception here is fatal, because most
 * callers are inside child-process stream handlers where a throw is uncaught.
 * Retry briefly, then give up quietly.
 */
function appendLogRaw(logFile, text) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.appendFileSync(logFile, text, "utf8");
      return;
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES" && error?.code !== "EBUSY") {
        return;
      }
      const buffer = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buffer), 0, 0, 5);
    }
  }
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  appendLogRaw(logFile, `[${nowIso()}] ${redactSecrets(normalized)}\n`);
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  appendLogRaw(logFile, `\n[${nowIso()}] ${title}\n${redactSecrets(String(body).trimEnd())}\n`);
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

/**
 * Structured header every run log starts with so a log file is independently
 * interpretable without the job JSON. Field-report BRIDGE-5: tokens/cost live
 * in ~/.grok/logs/unified.jsonl keyed by session id (sid), but the human .log
 * never carried that join key — concurrent runs were un-attributable.
 *
 * Written at the top (or immediately after "Starting …") and may be re-written
 * once the served model is known; later progress lines append below.
 *
 * @param {{
 *   runId?: string|null,
 *   grokSessionId?: string|null,
 *   threadId?: string|null,
 *   binary?: string|null,
 *   version?: string|null,
 *   cliLabel?: string|null,
 *   modelRequested?: string|null,
 *   modelServed?: string|null,
 *   isolation?: string|null,
 *   workspaceRoot?: string|null
 * }} fields
 * @returns {string}
 */
export function formatRunLogHeader(fields = {}) {
  const sessionId = fields.grokSessionId ?? fields.threadId ?? null;
  const cliParts = [fields.cliLabel, fields.version, fields.binary ? `(${fields.binary})` : null]
    .filter(Boolean)
    .join(" ");
  const lines = [
    "===RUN-LOG-HEADER===",
    `runId: ${fields.runId ?? "unknown"}`,
    // Join key for ~/.grok/logs/unified.jsonl (sid) — print even when still
    // pending so the field is always present for grepping.
    `grokSessionId: ${sessionId && String(sessionId).trim() ? sessionId : "pending"}`,
    `cli: ${cliParts || "unknown"}`,
    `modelRequested: ${fields.modelRequested && String(fields.modelRequested).trim() ? fields.modelRequested : "default"}`,
    `modelServed: ${fields.modelServed && String(fields.modelServed).trim() ? fields.modelServed : "pending"}`,
    `isolation: ${fields.isolation && String(fields.isolation).trim() ? fields.isolation : "unknown"}`,
    `workspaceRoot: ${fields.workspaceRoot ?? "unknown"}`,
    "===END-RUN-LOG-HEADER==="
  ];
  return lines.join("\n");
}

/**
 * Write (or refresh) the structured run-log header at the top of the log file.
 * Progress lines that already exist below the previous header are preserved.
 *
 * @param {string|null} logFile
 * @param {Parameters<typeof formatRunLogHeader>[0]} fields
 */
export function writeRunLogHeader(logFile, fields = {}) {
  if (!logFile) {
    return;
  }
  const block = `${formatRunLogHeader(fields)}\n`;
  let existing = "";
  try {
    existing = fs.readFileSync(logFile, "utf8");
  } catch {
    existing = "";
  }
  const open = "===RUN-LOG-HEADER===";
  const close = "===END-RUN-LOG-HEADER===";
  const start = existing.indexOf(open);
  const end = existing.indexOf(close);
  let next;
  if (start >= 0 && end > start) {
    const afterClose = end + close.length;
    const rest = existing.slice(afterClose).replace(/^\r?\n/, "");
    const prefix = existing.slice(0, start);
    next = `${prefix}${block}${rest}`;
  } else {
    // Prefer header after the first "Starting …" line when present.
    const firstNl = existing.indexOf("\n");
    if (firstNl >= 0 && /^\[.*?\] Starting /m.test(existing.slice(0, firstNl + 1))) {
      next = `${existing.slice(0, firstNl + 1)}${block}${existing.slice(firstNl + 1)}`;
    } else if (existing) {
      next = `${block}${existing}`;
    } else {
      next = block;
    }
  }
  fs.writeFileSync(logFile, next, "utf8");
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

/**
 * Fold a progress event into the job record.
 *
 * Two jobs, not one. Transition fields (phase, threadId, turnId, agentPid,
 * usage) are patched only when they actually change - patching an unchanged
 * phase on every streamed token would rewrite the job file hundreds of times a
 * minute. But `lastEventAt` is not a transition: it is the "this run is still
 * alive" clock the status renderer and the stale-run sweeper read, and it used
 * to be reachable ONLY through a transition patch. A long, healthy, single-
 * phase stretch - a fifteen-minute Godot import, a chatty agent turn that never
 * changes phase - therefore aged without bound while producing events the whole
 * time. So a no-transition event still refreshes it, throttled to at most once
 * per `minRefreshMs`.
 *
 * `nowImpl` / `patchImpl` are injected rather than faked with timers because
 * node:test's t.mock.timers needs Node >= 20.4 and package.json pins >= 18.18.
 *
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {{
 *   minRefreshMs?: number,
 *   nowImpl?: () => number,
 *   patchImpl?: typeof patchJobIfActive
 * }} [options]
 */
export function createJobProgressUpdater(workspaceRoot, jobId, options = {}) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastAgentPid = null;
  const minRefreshMs = Number.isFinite(Number(options.minRefreshMs))
    ? Math.max(0, Number(options.minRefreshMs))
    : 5000;
  const nowImpl = options.nowImpl ?? Date.now;
  const patchImpl = options.patchImpl ?? patchJobIfActive;
  // -Infinity, not 0: the very first event of a run must refresh, whatever
  // the clock happens to read.
  let lastRefreshAt = -Infinity;

  const readNow = () => {
    const value = Number(nowImpl());
    return Number.isFinite(value) ? value : lastRefreshAt;
  };

  // Bookkeeping must never be able to kill the run it is reporting on.
  //
  // This updater is called from inside the CLI child's stdout/'close' handlers,
  // so a throw here is an UNCAUGHT EXCEPTION, not a rejected promise: it walks
  // straight past runTrackedJob's catch, past main()'s catch, and terminates
  // the process. In a detached background worker (stdio: "ignore") that exit is
  // completely silent - no terminal claim, no error line, a log frozen at
  // whatever was appended just before. That is precisely the "abandoned; process
  // exited without a terminal claim" report, and its trigger was a Windows
  // rename losing to a concurrent `runs` poll. writeFileAtomic no longer loses
  // that race, but the invariant is worth enforcing where it is cheap: a failed
  // status patch costs a stale field, never the run.
  const safePatch = (root, id, value) => {
    try {
      patchImpl(root, id, value);
    } catch {
      // Intentionally swallowed. The next event patches again; the heartbeat
      // and the terminal claim are independent of this call.
    }
  };

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = {};
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.agentPid && normalized.agentPid !== lastAgentPid) {
      lastAgentPid = normalized.agentPid;
      patch.agentPid = normalized.agentPid;
      changed = true;
    }

    if (normalized.usage) {
      patch.usage = normalized.usage;
      changed = true;
    }

    const now = readNow();

    if (!changed) {
      if (now - lastRefreshAt < minRefreshMs) {
        return;
      }
      lastRefreshAt = now;
      safePatch(workspaceRoot, jobId, { lastEventAt: nowIso() });
      return;
    }

    lastRefreshAt = now;
    patch.lastEventAt = nowIso();
    safePatch(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  // Same reasoning as createJobProgressUpdater's safePatch: this reporter runs
  // inside child-process stream handlers, so anything it throws is an uncaught
  // exception that kills the run. Logging and status are observability; losing
  // a line is a nuisance, losing the run is a lost hour of agent work. Note
  // process.stderr.write is in here too - a detached worker's stderr is a
  // closed/ignored handle, and writing to one can raise EPIPE/EBADF.
  return (eventOrMessage) => {
    try {
      const event = normalizeProgressEvent(eventOrMessage);
      const stderrMessage = event.stderrMessage ?? event.message;
      if (stderr && stderrMessage) {
        process.stderr.write(`[grok-cc] ${stderrMessage}\n`);
      }
      appendLogLine(logFile, event.message);
      appendLogBlock(logFile, event.logTitle, event.logBody);
      onEvent?.(event);
    } catch {
      // See above: progress reporting never fails a run.
    }
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export function resolveJobKillTargets(job = {}) {
  const targets = [];
  const seen = new Set();
  // Prefer bridgePid; accept legacy companionPid for older run records.
  for (const value of [job.agentPid, job.bridgePid, job.companionPid, job.pid]) {
    if (value == null || value === "") {
      continue;
    }
    const pid = Number(value);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    targets.push(pid);
  }
  return targets;
}

/**
 * Collect this job and every nested descendant (via children[] / parentRunId
 * linkage on stored job files), leaf-first. Used by stop so cancelling a
 * parent also claims and kills its nested Hyper children on every platform.
 *
 * @param {string} workspaceRoot
 * @param {object} job
 * @param {{ readStoredJob?: (root: string, id: string) => object|null }} [options]
 * @returns {object[]} leaf-first job records (descendants before ancestors)
 */
export function collectJobTreeLeafFirst(workspaceRoot, job, options = {}) {
  const readStored =
    options.readStoredJob ??
    ((root, id) => {
      try {
        return readStoredJobOrNull(root, id);
      } catch {
        return null;
      }
    });
  const root = job && typeof job === "object" ? job : null;
  if (!root?.id) {
    return [];
  }

  const ordered = [];
  const visited = new Set();

  function walk(node) {
    if (!node?.id || visited.has(node.id)) {
      return;
    }
    visited.add(node.id);
    const stored = readStored(workspaceRoot, node.id) ?? node;
    const children = Array.isArray(stored.children) ? stored.children : [];
    for (const entry of children) {
      const childId = entry?.runId ?? entry?.id;
      if (!childId || visited.has(childId)) {
        continue;
      }
      const childStored = readStored(workspaceRoot, childId);
      if (childStored) {
        walk(childStored);
      } else {
        // Still visit a stub so kill targets from the entry are attempted.
        walk({ id: childId, ...entry, status: entry.status ?? "running" });
      }
    }
    ordered.push(stored);
  }

  walk(root);
  return ordered;
}

/**
 * Kill targets for a job and every nested descendant (leaf-first PIDs).
 * Dedupes PIDs across the tree.
 *
 * @param {string} workspaceRoot
 * @param {object} job
 * @param {{ readStoredJob?: Function }} [options]
 * @returns {{ pids: number[], jobs: object[] }}
 */
export function resolveJobTreeKillTargets(workspaceRoot, job, options = {}) {
  const jobs = collectJobTreeLeafFirst(workspaceRoot, job, options);
  const pids = [];
  const seen = new Set();
  for (const node of jobs) {
    for (const pid of resolveJobKillTargets(node)) {
      if (seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      pids.push(pid);
    }
  }
  return { pids, jobs };
}

export const HEARTBEAT_INTERVAL_MS = 15000;

/**
 * Patch lastHeartbeatAt on a fixed interval for the life of a run.
 *
 * Independent of the event stream on purpose: lastEventAt only advances when Grok
 * emits something, so a run that dies before its first event would otherwise look
 * untouched rather than dead.
 */
export function startHeartbeat(workspaceRoot, jobId, options = {}) {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const patch = options.patchImpl ?? patchJobIfActive;
  const beat = () => {
    try {
      patch(workspaceRoot, jobId, { lastHeartbeatAt: nowIso() });
    } catch {
      // A heartbeat must never take down the run it is reporting on.
    }
  };

  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runTrackedJob(job, runner, options = {}) {
  const bridgePid = process.pid;
  const logFile = options.logFile ?? job.logFile ?? null;
  const runningPatch = {
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    lastHeartbeatAt: nowIso(),
    bridgePid,
    pid: bridgePid,
    agentPid: job.agentPid ?? null,
    logFile
  };

  const activated = patchJobIfActive(job.workspaceRoot, job.id, runningPatch);
  if (!activated.patched) {
    if (activated.reason === "missing") {
      writeJobFile(job.workspaceRoot, job.id, {
        ...job,
        ...runningPatch,
        id: job.id
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        ...runningPatch,
        kind: job.kind,
        kindLabel: job.kindLabel,
        title: job.title,
        jobClass: job.jobClass,
        summary: job.summary,
        write: job.write,
        sessionId: job.sessionId
      });
      const recheck = patchJobIfActive(job.workspaceRoot, job.id, runningPatch);
      if (!recheck.patched && isTerminalJobStatus(recheck.status)) {
        return {
          exitStatus: 1,
          threadId: recheck.job?.threadId ?? null,
          turnId: null,
          payload: recheck.job?.result ?? { status: recheck.status },
          rendered: recheck.job?.rendered ?? `Run ${job.id} is already ${recheck.status}.\n`,
          summary: recheck.job?.summary ?? recheck.status,
          cancelled: recheck.status === "cancelled",
          pruned: false,
          alreadyTerminal: true
        };
      }
    } else if (isTerminalJobStatus(activated.status)) {
      return {
        exitStatus: 1,
        threadId: activated.job?.threadId ?? null,
        turnId: null,
        payload: activated.job?.result ?? { status: activated.status },
        rendered: activated.job?.rendered ?? `Run ${job.id} is already ${activated.status}.\n`,
        summary: activated.job?.summary ?? activated.status,
        cancelled: activated.status === "cancelled",
        pruned: false,
        alreadyTerminal: true
      };
    }
  }

  const stopHeartbeat = options.startHeartbeatImpl
    ? options.startHeartbeatImpl(job.workspaceRoot, job.id)
    : startHeartbeat(job.workspaceRoot, job.id);

  try {
    const execution = await runner();
    // Full-tuple decision: exit 0 alone is not success (Cancelled stopReason,
    // zero tools, zero files, failed verify all used to store as "completed").
    const completionStatus = decideCompletionStatus({
      timedOut: execution.timedOut,
      exitStatus: execution.exitStatus,
      stopReason: execution.stopReason ?? execution.payload?.stopReason ?? null,
      toolCallCount: execution.toolCallCount ?? execution.payload?.toolCallCount ?? null,
      changedFileCount:
        execution.changedFileCount ??
        execution.payload?.changedFiles?.total ??
        execution.worktree?.changedFileCount ??
        null,
      write: execution.write ?? job.write,
      verified: execution.verified,
      hadWork: execution.hadWork,
      isolationBreached:
        Boolean(execution.isolationBreached) || Boolean(execution.payload?.isolationBreached)
    });
    // Redact once, centrally, before anything text-bearing reaches disk or the
    // --json CLI path (which serializes the same payload we return here).
    const redactedPayload = redactSecretsDeep(execution.payload);
    const redactedSummary =
      typeof execution.summary === "string" ? redactSecrets(execution.summary) : execution.summary;
    const redactedRendered =
      typeof execution.rendered === "string" ? redactSecrets(execution.rendered) : execution.rendered;
    const redactedVerify =
      execution.verify === undefined ? undefined : redactSecretsDeep(execution.verify);
    const redactedExecution = {
      ...execution,
      payload: redactedPayload,
      summary: redactedSummary,
      rendered: redactedRendered,
      ...(redactedVerify !== undefined ? { verify: redactedVerify } : {})
    };

    const resolvedModel =
      execution.resolvedModel ??
      execution.usage?.resolvedModel ??
      redactedPayload?.usage?.resolvedModel ??
      null;
    const stopReason = execution.stopReason ?? redactedPayload?.stopReason ?? null;
    const toolCallCount = execution.toolCallCount ?? redactedPayload?.toolCallCount ?? null;
    const changedFileCount =
      execution.changedFileCount ??
      redactedPayload?.changedFiles?.total ??
      execution.worktree?.changedFileCount ??
      null;

    const claim = claimJobTerminal(
      job.workspaceRoot,
      job.id,
      completionStatus,
      redactTerminalClaimPatch({
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: redactedSummary,
        result: redactedPayload,
        usage: execution.usage ?? null,
        resolvedModel,
        stopReason,
        toolCallCount,
        changedFileCount,
        write: execution.write ?? job.write,
        verified: execution.verified ?? null,
        model: execution.model ?? job.model ?? null,
        grokVersion: execution.grokVersion ?? null,
        verify: redactedVerify ?? null,
        worktree: execution.worktree ?? job.worktree ?? null,
        isolationBreached:
          Boolean(execution.isolationBreached) || Boolean(execution.payload?.isolationBreached),
        isolationLeak: execution.isolationLeak ?? execution.payload?.isolationLeak ?? null,
        isolateSource:
          execution.isolateSource ?? job.isolateSource ?? execution.payload?.isolateSource ?? null,
        isolation: buildIsolationRecord(execution, job),
        budget: execution.budget ?? null,
        rendered: redactedRendered,
        // Nested delegation linkage — additive; older runners leave them null.
        parentRunId: execution.parentRunId ?? job.parentRunId ?? redactedPayload?.parentRunId ?? null,
        nestDepth: execution.nestDepth ?? job.nestDepth ?? redactedPayload?.nestDepth ?? 0,
        children: execution.children ?? job.children ?? redactedPayload?.children ?? [],
        usageBreakdown: execution.usageBreakdown ?? redactedPayload?.usageBreakdown ?? null,
        bridgePid,
        agentPid: null,
        pid: null,
        phase: completionStatus === "completed" ? "done" : completionStatus,
        logFile: options.logFile ?? job.logFile ?? null
      })
    );

    if (!claim.claimed && claim.status === "cancelled") {
      claimJobTerminal(
        job.workspaceRoot,
        job.id,
        "cancelled",
        redactTerminalClaimPatch({
          threadId: execution.threadId ?? claim.job?.threadId ?? null,
          turnId: execution.turnId ?? claim.job?.turnId ?? null,
          summary: claim.job?.summary ?? redactedSummary,
          result: claim.job?.result ?? redactedPayload,
          rendered: claim.job?.rendered ?? redactedRendered,
          partialResult: redactedPayload,
          bridgePid: null,
          agentPid: null,
          pid: null,
          logFile: options.logFile ?? job.logFile ?? null
        })
      );
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output (after cancel)", redactedRendered);
      return {
        ...redactedExecution,
        cancelled: true
      };
    }

    if (!claim.claimed && claim.reason === "missing") {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output (run missing)", redactedRendered);
      return {
        ...redactedExecution,
        pruned: true
      };
    }

    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", redactedRendered);
    return redactedExecution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const claim = claimJobTerminal(
      job.workspaceRoot,
      job.id,
      "failed",
      redactTerminalClaimPatch({
        errorMessage,
        bridgePid: null,
        agentPid: null,
        pid: null,
        phase: "failed",
        logFile: options.logFile ?? job.logFile ?? null
      })
    );

    if (!claim.claimed && claim.status === "cancelled") {
      throw error;
    }
    if (!claim.claimed && claim.reason === "missing") {
      throw error;
    }
    throw error;
  } finally {
    // Every exit path, or the interval keeps the worker process alive.
    stopHeartbeat();
  }
}

export { isTerminalJobStatus, claimJobTerminal, patchJobIfActive };
