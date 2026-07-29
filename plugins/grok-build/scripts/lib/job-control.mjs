import fs from "node:fs";

import { getConfig, listJobs, readJobFile, resolveJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function getCurrentSessionId(options = {}) {
  if (options.sessionId) {
    return options.sessionId;
  }
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

export function filterJobsForSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function filterJobsForCurrentSession(jobs, options = {}) {
  return filterJobsForSession(jobs, options);
}

/** Internal kind/jobClass "task" surfaces as user-facing "delegate". */
export function resolveJobKindLabel(kind, jobClass = null) {
  if (kind === "critique" || kind === "adversarial-review") {
    return "critique";
  }
  if (kind === "review" || jobClass === "review") {
    return "review";
  }
  if (kind === "task" || kind === "run" || jobClass === "task") {
    return "delegate";
  }
  return "run";
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  return resolveJobKindLabel(job.kind, job.jobClass);
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function formatRelativeAge(isoValue, now = Date.now()) {
  const parsed = Date.parse(isoValue ?? "");
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const totalSeconds = Math.max(0, Math.round((now - parsed) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s ago` : `${seconds}s ago`;
}

/**
 * Is any tracked pid for this run still alive?
 *
 * kill(pid, 0) delivers no signal; it only asks whether the process exists.
 * EPERM means it exists but belongs to another user, which still counts as alive.
 * Returns null when the run records no pids at all, so "unknown" is never
 * mistaken for "dead".
 */
export function isJobProcessAlive(job = {}, options = {}) {
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const pids = [job.agentPid, job.bridgePid, job.companionPid, job.pid]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (pids.length === 0) {
    return null;
  }

  for (const pid of new Set(pids)) {
    try {
      killImpl(pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        return true;
      }
    }
  }
  return false;
}

/**
 * A run whose tracked processes are all gone but whose status still says active.
 * Reported at read time rather than written to state; reaping it is /prune.
 */
export function classifyJobLiveness(job = {}, options = {}) {
  const active = job.status === "queued" || job.status === "running";
  if (!active) {
    return { abandoned: false, alive: null };
  }
  const alive = isJobProcessAlive(job, options);
  return { abandoned: alive === false, alive };
}

function computeIdleSeconds(job, now = Date.now()) {
  if (job.status !== "queued" && job.status !== "running") {
    return null;
  }
  const parsed = Date.parse(job.lastEventAt ?? "");
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.round((now - parsed) / 1000));
}

function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting grok") || line.startsWith("session ready") || line.startsWith("running grok")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("grok error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

export function getSessionRuntimeStatus() {
  return {
    mode: "plugin-owned",
    label: "plugin-owned runs",
    detail: "Runs are tracked by the Grok Build ↔ Claude Code bridge (PID + log files). There is no shared app-server broker.",
    endpoint: null
  };
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null,
    idleSeconds: computeIdleSeconds(job),
    lastEventAge: formatRelativeAge(job.lastEventAt),
    lastHeartbeatAge: formatRelativeAge(job.lastHeartbeatAt)
  };

  const liveness = classifyJobLiveness(job, options);

  return {
    ...enriched,
    alive: liveness.alive,
    abandoned: liveness.abandoned,
    // An abandoned run's stored status still says running. Report what is true
    // rather than what was last written; reaping it into state is /prune.
    displayStatus: liveness.abandoned ? "abandoned" : enriched.status,
    phase: liveness.abandoned
      ? "abandoned"
      : (enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview))
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Run reference "${reference}" is ambiguous. Use a longer run id.`);
  }

  throw new Error(`No run found for "${reference}". Run /grok-build:runs to list known runs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(),
    running,
    latestFinished,
    recent
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const selected = matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No run found for "${reference}". Run /grok-build:runs to inspect known runs.`);
  }

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

export function resolveResultJob(cwd, reference) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reference ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Run ${active.id} is still ${active.status}. Check /grok-build:runs and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished run found for "${reference}". Run /grok-build:runs to inspect active runs.`);
  }

  throw new Error("No finished Grok Build runs found for this repository yet.");
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active run found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  const sessionScopedActiveJobs = filterJobsForCurrentSession(activeJobs, options);

  if (sessionScopedActiveJobs.length === 1) {
    return { workspaceRoot, job: sessionScopedActiveJobs[0] };
  }
  if (sessionScopedActiveJobs.length > 1) {
    throw new Error("Multiple Grok Build runs are active. Pass a run id to /grok-build:stop.");
  }

  if (getCurrentSessionId(options)) {
    throw new Error("No active Grok Build runs to stop for this session.");
  }

  throw new Error("No active Grok Build runs to stop.");
}
