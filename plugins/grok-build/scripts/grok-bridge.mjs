#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  getCurrentBranch,
  git,
  gitChecked,
  resolveReviewTarget
} from "./lib/git.mjs";
import {
  buildReviewPrompt,
  DEFAULT_CONTINUE_PROMPT,
  getGrokAuthStatus,
  getGrokAvailability,
  parseStructuredOutput,
  readOutputSchema,
  runHeadlessAgent,
  runImport,
  schemaInstructionsFromPath
} from "./lib/grok.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  classifyJobLiveness,
  filterJobsForSession,
  getSessionRuntimeStatus,
  readStoredJob,
  resolveCancelableJob,
  resolveJobKindLabel,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { planWorktreeLinks, provisionWorktree } from "./lib/provision.mjs";
import {
  claimJobTerminal,
  generateJobId,
  isTerminalJobStatus,
  listJobs,
  patchJobIfActive,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { redactSecretsDeep } from "./lib/redact.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  resolveJobKillTargets,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import {
  classifyVerifyFailure,
  deriveVerifyTimeoutMs,
  probeBaselines,
  runVerifyCommand,
  summarizeFailures
} from "./lib/verify.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  commitWorktreeChanges,
  createWorktree,
  removeWorktree
} from "./lib/worktree.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
// Generous on purpose: this is the only chance to learn what already failed
// before the agent ran. A tight cap here silently produced an empty baseline
// on a slow cold build, misattributing every pre-existing failure to the run.
const BASELINE_PROBE_TIMEOUT_MS = 900000;

// Terminal statuses whose worktree may still hold real, unlanded commits
// worth protecting from prune/doctor. Confirmed by direct reproduction: a
// completed-unverified run's worktree - it ran to completion, it just never
// passed verification - had its branch and the agent's real commit deleted
// by prune --apply, because the guard checked only the literal string
// "completed". A run whose verification failed or that hit --max-duration
// is exactly the kind of work most worth reviewing before it is discarded,
// not less. failed/cancelled/abandoned are deliberately excluded: those
// represent a run that did not produce work worth preserving by default.
const AWAITING_LAND_STATUSES = new Set(["completed", "completed-unverified", "timed-out"]);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-bridge.mjs check [--json]",
      "  node scripts/grok-bridge.mjs doctor [--json]",
      "  node scripts/grok-bridge.mjs prune [--apply] [--include-unlanded] [--json]",
      "  node scripts/grok-bridge.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high>]",
      "  node scripts/grok-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <low|medium|high>] [focus text]",
      "  node scripts/grok-bridge.mjs run [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [prompt]",
      "  node scripts/grok-bridge.mjs import [--source <claude-jsonl>] [--json]",
      "  node scripts/grok-bridge.mjs runs [run-id] [--all] [--json]",
      "  node scripts/grok-bridge.mjs show [run-id] [--json]",
      "  node scripts/grok-bridge.mjs stop [run-id] [--json]",
      "  node scripts/grok-bridge.mjs land [run-id] [--preview|--discard] [--json]"
    ].join("\n")
  );
}

function normalizeVerifyCommands(raw) {
  if (raw == null || raw === "") {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

function resolveVerifyAttempts(raw) {
  const parsed = Number(raw);
  const verifyAttempts =
    Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1 ? parsed : 2;
  return verifyAttempts;
}

// Wording matters here: this text is the only explanation the user gets for a
// run that reports "Verified: no" without any failing code, so each one has to
// name the infrastructure cause and say plainly that it is not a code failure.
const VERIFY_INFRASTRUCTURE_NOTES = {
  "verify-command-not-runnable":
    "the verify command could not be started (not found on PATH) - this is not a code failure",
  "verify-timed-out":
    "the verify command timed out - this is an infrastructure limit, not a code failure",
  "verify-output-truncated":
    "the verify command produced more output than could be captured and was killed - this is not a code failure",
  "baseline-unknown":
    "the baseline probe for this command never produced a comparable result, so its failures cannot be attributed to this run",
  "baseline-missing":
    "no baseline was measured for this command, so its failures cannot be attributed to this run"
};

function describeVerifyInfrastructureStop(entry) {
  const detail = VERIFY_INFRASTRUCTURE_NOTES[entry.attribution] ?? entry.attribution;
  return `${detail} (${entry.command})`;
}

function resolveMaxDurationSeconds(raw) {
  if (raw == null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

function resolveMaxTurns(raw) {
  if (raw == null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 1) {
    return parsed;
  }
  // Accept whole numbers that arrive as floats from string parsing (e.g. "3.0").
  if (Number.isFinite(parsed) && parsed >= 1 && Math.floor(parsed) === parsed) {
    return parsed;
  }
  return null;
}

function resolveMaxCostUsd(raw) {
  if (raw == null || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

/**
 * Run the headless agent, optionally racing a wall-clock duration budget.
 * Captures agentPid from onProgress so the watchdog can terminate the tree.
 */
async function runHeadlessAgentWithDurationBudget(runCwd, agentOptions, maxDurationSeconds) {
  let agentPid = null;
  const originalOnProgress = agentOptions.onProgress;
  const wrappedOptions = {
    ...agentOptions,
    onProgress: (event) => {
      if (event && typeof event === "object") {
        const pid = Number(event.agentPid);
        if (Number.isFinite(pid) && pid > 0) {
          agentPid = pid;
        }
      }
      originalOnProgress?.(event);
    }
  };

  if (maxDurationSeconds == null) {
    const result = await runHeadlessAgent(runCwd, wrappedOptions);
    return { result, timedOut: false };
  }

  const agentPromise = runHeadlessAgent(runCwd, wrappedOptions);
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (agentPid != null) {
        terminateProcessTree(agentPid);
      }
      resolve({ timedOut: true });
    }, Math.max(1, Math.round(maxDurationSeconds * 1000)));
    timer.unref?.();
  });

  const raced = await Promise.race([
    agentPromise.then((result) => ({ result, timedOut: false })),
    timeoutPromise
  ]);

  if (timer) {
    clearTimeout(timer);
  }

  if (raced.timedOut) {
    let result;
    try {
      result = await agentPromise;
    } catch {
      result = {
        status: 1,
        stdout: "",
        stderr: "Run exceeded --max-duration.",
        threadId: null,
        sessionId: null,
        agentPid,
        finalMessage: "",
        usage: null,
        stopReason: "max-duration"
      };
    }
    return {
      result: {
        ...result,
        status: 1
      },
      timedOut: true
    };
  }

  return { result: raced.result, timedOut: false };
}

function resolveIsolateOption(options, write) {
  if (options["no-isolate"]) {
    return false;
  }
  if (options.isolate) {
    return true;
  }
  return Boolean(write);
}

function buildBoundedVerifyFixPrompt(command, output) {
  // Verify stdout/stderr can echo real secrets (env dumps, config prints). Scrub
  // before embedding in the next model prompt so a leaked key is not re-sent.
  const safeOutput = redactSecretsDeep(output == null ? "" : String(output));
  return (
    `The verify command \`${command}\` failed. Fix the cause, then re-run only that exact command until it passes. ` +
    `Do not investigate unrelated failures, do not run the full test suite, and do not change any test to make it pass.\n\n` +
    `Output:\n${safeOutput}`
  );
}

/**
 * Sum two usage objects. The verify-fix loop can invoke the agent multiple
 * times (initial run plus one per fix attempt); reporting only the last
 * call's usage silently discarded every earlier turn's tokens and cost, and
 * checking --max-cost against a single call's cost rather than the running
 * total meant N calls each under budget could together blow well past it.
 */
function addUsage(a, b) {
  if (!b) {
    return a;
  }
  if (!a) {
    return { ...b };
  }
  const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    inputTokens: numeric(a.inputTokens) + numeric(b.inputTokens),
    cachedInputTokens: numeric(a.cachedInputTokens) + numeric(b.cachedInputTokens),
    outputTokens: numeric(a.outputTokens) + numeric(b.outputTokens),
    reasoningTokens: numeric(a.reasoningTokens) + numeric(b.reasoningTokens),
    totalTokens: numeric(a.totalTokens) + numeric(b.totalTokens),
    costUsd: numeric(a.costUsd) + numeric(b.costUsd),
    numTurns: numeric(a.numTurns) + numeric(b.numTurns)
  };
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: low, medium, high.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  const parsed = parseArgs(normalizeArgv(argv), {
    ...config,
    unknownMode: config.unknownMode ?? "warn",
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
  if (parsed.unknown?.length) {
    for (const token of parsed.unknown) {
      process.stderr.write(`Warning: ignoring unknown option ${token}\n`);
    }
  }
  return parsed;
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildCheckReport(cwd, actionsTaken = []) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const grokStatus = getGrokAvailability(cwd);
  const authStatus = getGrokAuthStatus(cwd);

  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push("Install the Grok Build CLI and ensure `grok` is on PATH (or set GROK_BINARY).");
  }
  if (grokStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Authenticate the Grok CLI (for example by running `grok` interactively and completing login).");
    nextSteps.push("Verify with `grok models` — a successful run means you are logged in.");
  }

  return {
    ready: nodeStatus.available && grokStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    actionsTaken,
    nextSteps
  };
}

async function handleCheck(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const finalReport = await buildCheckReport(cwd, []);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function renderDoctorReport(report) {
  const lines = [
    "# Grok Build Doctor",
    "",
    `Status: ${report.ok ? "ok" : "needs-attention"}`,
    "",
    "Checks:"
  ];

  for (const check of report.checks) {
    const mark = check.ok ? "ok" : "FAIL";
    lines.push(`- [${mark}] ${check.name}: ${check.detail}`);
    if (!check.ok && check.fix) {
      lines.push(`    Fix: ${check.fix}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function buildDoctorReport(cwd) {
  const checks = [];

  checks.push({
    name: "node",
    ok: true,
    detail: process.version,
    fix: null
  });

  const grok = getGrokAvailability(cwd);
  checks.push({
    name: "grok",
    ok: Boolean(grok.available),
    detail: grok.available
      ? (grok.detail || "available")
      : (grok.detail || "not available"),
    fix: grok.available
      ? null
      : "Install the Grok CLI and ensure `grok` is on PATH (or set GROK_BINARY)."
  });

  const auth = getGrokAuthStatus(cwd);
  checks.push({
    name: "auth",
    ok: Boolean(auth.loggedIn),
    detail: auth.detail || (auth.loggedIn ? "authenticated" : "not authenticated"),
    fix: auth.loggedIn
      ? null
      : "Authenticate the Grok CLI (run `grok` interactively), then verify with `grok models`."
  });

  const homeSet = Boolean(process.env.HOME || process.env.GROK_HOME);
  checks.push({
    name: "HOME/GROK_HOME",
    ok: homeSet,
    detail: homeSet
      ? (process.env.GROK_HOME
        ? `GROK_HOME=${process.env.GROK_HOME}`
        : `HOME=${process.env.HOME}`)
      : "neither HOME nor GROK_HOME is set",
    fix: homeSet
      ? null
      : "Set HOME (on Windows, to %USERPROFILE%) because grok subcommands fail without it."
  });

  const stateDir = resolveStateDir(cwd);
  let stateOk = false;
  let stateDetail = stateDir;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.accessSync(stateDir, fs.constants.W_OK);
    stateOk = true;
    stateDetail = `${stateDir} (writable)`;
  } catch (error) {
    stateDetail = `${stateDir} (${error instanceof Error ? error.message : String(error)})`;
  }
  checks.push({
    name: "state dir",
    ok: stateOk,
    detail: stateDetail,
    fix: stateOk
      ? null
      : "Ensure CLAUDE_PLUGIN_DATA (or the fallback state root) is writable."
  });

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  const abandoned = jobs.filter((job) => classifyJobLiveness(job).abandoned);
  checks.push({
    name: "abandoned runs",
    ok: abandoned.length === 0,
    detail:
      abandoned.length === 0
        ? "none"
        : `${abandoned.length} abandoned (${abandoned.map((job) => job.id).join(", ")})`,
    fix: abandoned.length === 0 ? null : "Run `node scripts/grok-bridge.mjs prune --apply` to reclaim abandoned runs."
  });

  // Prefer reading the full job file for worktree when the index is sparse.
  // Completed runs with unlanded commits are "awaiting land", not prunable staleness.
  const staleWithPaths = [];
  const awaitingLand = [];
  for (const job of jobs) {
    if (!isTerminalJobStatus(job.status)) {
      continue;
    }
    const stored = readStoredJob(workspaceRoot, job.id) ?? job;
    if (!(stored.worktree?.path && fs.existsSync(stored.worktree.path))) {
      continue;
    }
    const status = stored.status ?? job.status;
    const unmerged = countUnmergedCommits(
      workspaceRoot,
      stored.worktree.baseSha,
      stored.worktree.branch
    );
    if (unmerged > 0 && AWAITING_LAND_STATUSES.has(status)) {
      awaitingLand.push({ ...job, worktree: stored.worktree, unmergedCommits: unmerged });
    } else {
      staleWithPaths.push({ ...job, worktree: stored.worktree });
    }
  }
  checks.push({
    name: "stale worktrees",
    ok: staleWithPaths.length === 0,
    detail:
      staleWithPaths.length === 0
        ? "none"
        : `${staleWithPaths.length} worktree(s) still on disk for terminal runs`,
    fix:
      staleWithPaths.length === 0
        ? null
        : "Run `node scripts/grok-bridge.mjs prune --apply` to remove finished worktrees with no unlanded work."
  });
  checks.push({
    name: "awaiting land",
    ok: awaitingLand.length === 0,
    detail:
      awaitingLand.length === 0
        ? "none"
        : `${awaitingLand.length} run(s) awaiting land`,
    fix:
      awaitingLand.length === 0
        ? null
        : "Run `/grok-build:land` to apply or discard unlanded isolated work."
  });

  return {
    ok: checks.every((check) => check.ok),
    checks
  };
}

/** Commits on branch that are not reachable from baseSha (unlanded work). */
function countUnmergedCommits(repoRoot, baseSha, branchName) {
  if (!baseSha || !branchName) {
    return 0;
  }
  const result = git(repoRoot, ["rev-list", "--count", `${baseSha}..${branchName}`]);
  if (result.status !== 0) {
    return 0;
  }
  const count = Number(String(result.stdout ?? "").trim());
  return Number.isFinite(count) && count > 0 ? count : 0;
}

async function handleDoctor(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const report = buildDoctorReport(cwd);
  outputResult(options.json ? report : renderDoctorReport(report), options.json);
  if (!report.ok) {
    process.exitCode = 0;
  }
}

function collectPrunePlan(cwd, options = {}) {
  const includeUnlanded = Boolean(options.includeUnlanded);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  /** @type {{ type: string, jobId: string, detail: string, apply: () => void }[]} */
  const actions = [];
  /** @type {{ jobId: string, branch: string|null, unmergedCommits: number, detail: string }[]} */
  const awaitingLand = [];

  for (const job of jobs) {
    if (classifyJobLiveness(job).abandoned) {
      const jobId = job.id;
      actions.push({
        type: "abandon",
        jobId,
        detail: `Claim abandoned run ${jobId} as failed (process tree is gone).`,
        apply: () => {
          claimJobTerminal(workspaceRoot, jobId, "failed", {
            errorMessage: "Run abandoned; process tree is gone.",
            phase: "failed",
            bridgePid: null,
            agentPid: null,
            pid: null
          });
        }
      });
    }
  }

  for (const job of jobs) {
    const stored = readStoredJob(workspaceRoot, job.id) ?? job;
    const status = stored.status ?? job.status;
    if (!isTerminalJobStatus(status)) {
      continue;
    }
    const worktree = stored.worktree;
    if (!worktree || typeof worktree !== "object" || !worktree.path) {
      continue;
    }
    if (!fs.existsSync(worktree.path)) {
      continue;
    }
    const jobId = job.id;
    const worktreePath = worktree.path;
    const branchName = worktree.branch ?? null;
    const unmerged = countUnmergedCommits(workspaceRoot, worktree.baseSha, branchName);

    // Successful completed runs with commits still on the branch are awaiting
    // land — never delete that branch unless the user opts in explicitly.
    if (unmerged > 0 && AWAITING_LAND_STATUSES.has(status) && !includeUnlanded) {
      awaitingLand.push({
        jobId,
        branch: branchName,
        unmergedCommits: unmerged,
        detail: `Run ${jobId} has unlanded work (${unmerged} commit(s) on ${branchName ?? "branch"}); use /grok-build:land or pass --include-unlanded to prune.`
      });
      continue;
    }

    actions.push({
      type: "worktree",
      jobId,
      detail: `Remove worktree for terminal run ${jobId} at ${worktreePath}.`,
      apply: () => {
        removeWorktree({
          repoRoot: workspaceRoot,
          worktreePath,
          branchName,
          deleteBranch: Boolean(branchName)
        });
      }
    });
  }

  return { workspaceRoot, actions, awaitingLand };
}

function renderPruneReport(plan, applied) {
  const mode = applied ? "applied" : "dry-run";
  const lines = ["# Grok Build Prune", "", `Mode: ${mode}`, ""];
  const awaiting = plan.awaitingLand ?? [];

  if (plan.actions.length === 0 && awaiting.length === 0) {
    lines.push("Nothing to prune.");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (plan.actions.length > 0) {
    lines.push(`Items (${plan.actions.length}):`);
    for (const action of plan.actions) {
      lines.push(`- [${mode}] ${action.detail}`);
    }
  } else {
    lines.push("No prunable items in the default plan.");
  }

  if (awaiting.length > 0) {
    lines.push("", `Awaiting land (${awaiting.length}) — not pruned without --include-unlanded:`);
    for (const item of awaiting) {
      lines.push(`- ${item.detail}`);
    }
  }

  if (!applied && plan.actions.length > 0) {
    lines.push("", "Re-run with --apply to perform these actions.");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function handlePrune(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "apply", "include-unlanded"]
  });

  const cwd = resolveCommandCwd(options);
  const apply = Boolean(options.apply);
  const plan = collectPrunePlan(cwd, { includeUnlanded: options["include-unlanded"] });

  if (apply) {
    for (const action of plan.actions) {
      action.apply();
    }
  }

  const payload = {
    mode: apply ? "apply" : "dry-run",
    applied: apply,
    count: plan.actions.length,
    items: plan.actions.map((action) => ({
      type: action.type,
      jobId: action.jobId,
      detail: action.detail,
      applied: apply
    })),
    awaitingLand: (plan.awaitingLand ?? []).map((item) => ({
      jobId: item.jobId,
      branch: item.branch,
      unmergedCommits: item.unmergedCommits,
      detail: item.detail
    }))
  };

  outputCommandResult(payload, renderPruneReport(plan, apply), options.json);
}

function buildCritiquePrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "critique");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Critique",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureGrokAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error(
      "Grok CLI is not installed or not on PATH. Install it, set GROK_BINARY if needed, then rerun `/grok-build:check`."
    );
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  return filterJobsForSession(jobs, { sessionId: getCurrentClaudeSessionId() });
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Delegate run ${activeTask.id} is still running. Use /grok-build:runs before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  return null;
}

async function executeReviewRun(request) {
  ensureGrokAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  const context = collectReviewContext(request.cwd, target);

  let prompt;
  let structured = false;
  if (reviewName === "Critique") {
    prompt = buildCritiquePrompt(context, focusText);
    const schemaHint = schemaInstructionsFromPath(REVIEW_SCHEMA);
    if (schemaHint) {
      prompt = `${prompt}\n\n${schemaHint}`;
    }
    structured = true;
  } else {
    prompt = buildReviewPrompt({
      targetLabel: context.target.label,
      focusText,
      collectionGuidance: context.collectionGuidance,
      reviewInput: context.content
    });
  }

  const result = await runHeadlessAgent(context.repoRoot, {
    prompt,
    agent: "explore",
    permissionMode: "plan",
    sandbox: "read-only",
    model: request.model,
    effort: request.effort,
    // Structured critique must stay "json": --json-schema implies it. The plain
    // review path streams so it reports live phases and usage like delegate runs.
    outputFormat: structured ? "json" : "streaming-json",
    jsonSchema: structured ? readOutputSchema(REVIEW_SCHEMA) : undefined,
    onProgress: request.onProgress
  });

  if (structured) {
    const parsed = parseStructuredOutput(result.finalMessage, {
      status: result.status,
      failureMessage: result.stderr
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      context: {
        repoRoot: context.repoRoot,
        branch: context.branch,
        summary: context.summary
      },
      grok: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.finalMessage
      },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError
    };

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: null,
      payload,
      rendered: renderReviewResult(parsed, {
        reviewLabel: reviewName,
        targetLabel: context.target.label
      }),
      summary:
        parsed.parsed?.summary ??
        parsed.parseError ??
        firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
      jobTitle: `Grok Build ${reviewName}`,
      jobClass: "review",
      targetLabel: context.target.label
    };
  }

  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    grok: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage
    }
  };
  const rendered = renderNativeReviewResult(
    {
      status: result.status,
      stdout: result.finalMessage,
      stderr: result.stderr
    },
    { reviewLabel: reviewName, targetLabel: target.label }
  );

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: null,
    payload,
    rendered,
    summary: firstMeaningfulLine(result.finalMessage, `${reviewName} completed.`),
    jobTitle: `Grok Build ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeSessionId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Grok Build delegate session was found for this repository.");
    }
    resumeSessionId = latestThread.id;
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const prompt = String(request.prompt ?? "").trim() || (resumeSessionId ? DEFAULT_CONTINUE_PROMPT : "");
  const write = Boolean(request.write);
  const isolate = Boolean(request.isolate);
  const verifyCommands = normalizeVerifyCommands(request.verifyCommands);
  const verifyAttempts = resolveVerifyAttempts(request.verifyAttempts);
  const maxDurationSeconds = resolveMaxDurationSeconds(request.maxDurationSeconds);
  const maxTurns = resolveMaxTurns(request.maxTurns);
  const maxCostUsd = resolveMaxCostUsd(request.maxCostUsd);

  const grokVersion = getGrokAvailability(request.cwd).detail ?? null;

  let created = null;
  let runCwd = workspaceRoot;
  if (isolate && write) {
    created = createWorktree({ cwd: workspaceRoot, runId: request.jobId });
    // Persist worktree descriptor immediately so cancel/crash cannot orphan it
    // from land/prune/doctor (descriptor must not wait until the run returns).
    if (request.jobId) {
      patchJobIfActive(workspaceRoot, request.jobId, {
        worktree: {
          path: created.worktreePath,
          branch: created.branchName,
          baseSha: created.baseSha
        }
      });
    }
    const plan = planWorktreeLinks(created.repoRoot, created.worktreePath);
    provisionWorktree(plan);
    runCwd = created.worktreePath;
  }

  /** @type {Awaited<ReturnType<typeof probeBaselines>>} */
  let baselines = [];
  let baselineProbeMs = null;
  // The probe used to be gated on `created`, i.e. on an isolated write run
  // only. Under --no-isolate, or read-only, there was no baseline at all:
  // baselines.find() returned undefined, compareFailureSignatures compared
  // against an empty set, and every failure that was already there before the
  // run started came back as "new-failures" attributed to the agent. It now
  // runs whenever there is anything to attribute, in runCwd - the same
  // directory the post-agent pass below uses, so the comparison stays
  // apples-to-apples whether or not a worktree exists.
  //
  // The skip is deliberate and narrow: a read-only run with no verify attempts
  // has nothing it could possibly be blamed for, so the extra pass is pure
  // wall-clock cost. Everywhere else the cost is real (a full extra verify
  // pass) and is reported in the run's status block rather than hidden.
  const shouldProbeBaselines =
    verifyCommands.length > 0 && !(write === false && verifyAttempts === 0);
  if (shouldProbeBaselines) {
    const probeStarted = Date.now();
    // A generous cap, not the derived per-attempt timeout: this is the ONLY
    // chance to learn what was already broken before the agent touched
    // anything, and a cold-build ecosystem (Godot's first asset import,
    // a fresh cargo build) can legitimately take minutes. A tight cap here
    // used to discard the timeout result silently, so any command that ran
    // long got recorded as an empty baseline signature - and every one of
    // its real, pre-existing failures then looked "new" once the agent's
    // run finished, blaming it for something it never touched.
    baselines = await probeBaselines(verifyCommands, runCwd, {
      timeoutMs: BASELINE_PROBE_TIMEOUT_MS
    });
    baselineProbeMs = Date.now() - probeStarted;
  }

  const firstAgent = await runHeadlessAgentWithDurationBudget(
    runCwd,
    {
      prompt,
      resumeSessionId,
      model: request.model,
      effort: request.effort,
      alwaysApprove: write,
      permissionMode: write ? undefined : "plan",
      sandbox: write ? undefined : "read-only",
      maxTurns,
      outputFormat: "streaming-json",
      onProgress: request.onProgress,
      cwd: runCwd
    },
    maxDurationSeconds
  );
  let result = firstAgent.result;
  let timedOut = firstAgent.timedOut;
  let cumulativeUsage = result.usage ? { ...result.usage } : null;

  // Cost is only known when a turn ends (from the end event's total_cost_usd),
  // so max-cost is a post-hoc stop — not a pre-emptive cap. The run stops before
  // the *next* turn / verify re-invoke rather than mid-turn. Checked against the
  // running total across every call this run has made so far, not just the
  // latest one — otherwise N calls each individually under budget could
  // together spend well past maxCostUsd without ever tripping the stop.
  let budgetStopped = null;
  if (
    !timedOut &&
    maxCostUsd != null &&
    cumulativeUsage?.costUsd != null &&
    Number.isFinite(Number(cumulativeUsage.costUsd)) &&
    Number(cumulativeUsage.costUsd) > maxCostUsd
  ) {
    budgetStopped = "max-cost";
  }

  let verified = null;
  let verifyNote = null;
  /** @type {object[]} */
  let verifyResults = [];
  let attempt = 0;

  if (!timedOut && verifyCommands.length > 0) {
    while (attempt <= verifyAttempts) {
      const iterationResults = [];
      // The first failure genuinely attributable to THIS run - as opposed to
      // one that matches (or cannot be distinguished from) the pre-existing
      // baseline. Every failing command used to be compared against baseline
      // ONLY if it happened to be the first one iterated; a regression in a
      // second --verify command was collected into iterationResults but never
      // actually checked, so the run could report success while a real
      // regression sat right there in the results array.
      let firstBlamed = null;
      // The first outcome that says nothing about the agent's work at all:
      // the verify command timed out, drowned its own output buffer, or could
      // not be started. Tracked separately from firstBlamed because it must
      // stop the run rather than trigger a fix turn.
      let firstInfrastructure = null;

      for (const command of verifyCommands) {
        const baselineEntry = baselines.find((entry) => entry.command === command);
        const baselineMs =
          baselineEntry && Number.isFinite(baselineEntry.ms) ? baselineEntry.ms : 120000;
        const timeoutMs = deriveVerifyTimeoutMs(baselineMs);
        const outcome = runVerifyCommand(command, runCwd, { timeoutMs });
        const summary = summarizeFailures(outcome.output);
        const entryResult = {
          command,
          ok: outcome.ok,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          // These two used to be dropped on the floor by this fixed field
          // list, so a run that only failed because the command was killed
          // for output volume, or was never runnable, looked exactly like a
          // plain non-zero exit in the persisted record.
          bufferExceeded: Boolean(outcome.bufferExceeded),
          commandNotFound: Boolean(outcome.commandNotFound),
          failureSource: null,
          output: outcome.output,
          signature: summary.signature
        };
        iterationResults.push(entryResult);

        if (outcome.ok) {
          continue;
        }

        const classification = classifyVerifyFailure(summary, baselineEntry, {
          timedOut: outcome.timedOut,
          bufferExceeded: outcome.bufferExceeded,
          commandNotFound: outcome.commandNotFound
        });
        entryResult.attribution = classification.reason;
        if (classification.comparison) {
          entryResult.comparison = classification.comparison;
        }

        const isInfrastructure =
          Boolean(classification.fatal) ||
          Boolean(classification.infrastructure) ||
          classification.reason === "baseline-unknown" ||
          classification.reason === "baseline-missing";
        entryResult.failureSource = classification.blamed
          ? "agent"
          : isInfrastructure
            ? "infrastructure"
            : "baseline";

        if (isInfrastructure && !firstInfrastructure) {
          firstInfrastructure = entryResult;
        }

        if (!classification.blamed) {
          continue;
        }

        if (!firstBlamed) {
          firstBlamed = entryResult;
        }
      }

      verifyResults = iterationResults;

      // An infrastructure outcome is not evidence either way, so the run must
      // not claim success and must not spend a turn asking the agent to "fix"
      // it. Sending it back used to be actively harmful: handed a timeout or
      // a truncated-output message, the model goes looking for a code bug
      // that does not exist and edits something that was never broken.
      if (firstInfrastructure) {
        verified = false;
        verifyNote = describeVerifyInfrastructureStop(firstInfrastructure);
        break;
      }

      if (!firstBlamed) {
        verified = true;
        if (iterationResults.some((entry) => !entry.ok)) {
          verifyNote = "remaining failures are unchanged from baseline or could not be attributed to this run";
        }
        break;
      }

      if (attempt === verifyAttempts) {
        verified = false;
        break;
      }

      // Post-hoc cost stop: do not start another model turn once over budget.
      if (budgetStopped === "max-cost") {
        verified = false;
        verifyNote = "stopped by max-cost budget before verify re-invoke";
        break;
      }

      const fixAgent = await runHeadlessAgentWithDurationBudget(
        runCwd,
        {
          prompt: buildBoundedVerifyFixPrompt(firstBlamed.command, firstBlamed.output),
          resumeSessionId: result.threadId,
          model: request.model,
          effort: request.effort,
          // Mirror the ORIGINAL run's write policy exactly. This used to be
          // alwaysApprove:true unconditionally with no permissionMode/sandbox
          // at all, so a run started read-only (permissionMode:"plan",
          // sandbox:"read-only") got escalated to full write approval on its
          // very first verify failure - and since isolation only applies to
          // write runs, that write happened directly in the user's real
          // working tree, not a worktree, despite the user asking for
          // read-only. A read-only run with --verify still specified simply
          // cannot fix anything (sandboxed), so it correctly re-fails and the
          // run reports completed-unverified instead.
          alwaysApprove: write,
          permissionMode: write ? undefined : "plan",
          sandbox: write ? undefined : "read-only",
          maxTurns,
          cwd: runCwd,
          outputFormat: "streaming-json",
          onProgress: request.onProgress
        },
        maxDurationSeconds
      );
      result = fixAgent.result;
      cumulativeUsage = addUsage(cumulativeUsage, fixAgent.result.usage);
      if (fixAgent.timedOut) {
        timedOut = true;
        break;
      }
      if (
        maxCostUsd != null &&
        cumulativeUsage?.costUsd != null &&
        Number.isFinite(Number(cumulativeUsage.costUsd)) &&
        Number(cumulativeUsage.costUsd) > maxCostUsd
      ) {
        budgetStopped = "max-cost";
      }
      attempt += 1;
    }

    // Never leave verified null when verify commands ran: null is treated as
    // success by completion status (completed vs completed-unverified).
    if (verified == null) {
      verified = false;
    }
  }

  let worktree = null;
  if (created) {
    const committed = commitWorktreeChanges(
      created.worktreePath,
      `grok-build ${request.jobId}`
    );
    worktree = {
      path: created.worktreePath,
      branch: created.branchName,
      baseSha: created.baseSha,
      sha: committed.sha
    };
  }

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = timedOut
    ? `Run timed out after ${maxDurationSeconds}s (--max-duration).`
    : result.status === 0
      ? ""
      : result.stderr || "";
  const rendered = timedOut
    ? `${failureMessage}\n${rawOutput ? `\n${rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`}` : ""}`
    : renderTaskResult(
        {
          rawOutput,
          failureMessage
        },
        {
          title: taskMetadata.title,
          jobId: request.jobId ?? null,
          write,
          verified,
          verifyNote,
          baselineProbeMs,
          baselineProbeCommands: baselines.length,
          worktree,
          budgetStopped
        }
      );

  const verify = {
    commands: verifyCommands,
    attempts: attempt,
    note: verifyNote,
    // The probe is now unconditional, so on a non-isolated run it doubles the
    // verify wall clock. That cost has to be visible rather than showing up as
    // an unexplained delay.
    baselineProbeMs,
    baselines,
    results: verifyResults
  };

  const budget = {
    maxDurationSeconds,
    maxTurns,
    maxCostUsd,
    timedOut,
    budgetStopped
  };

  const exitStatus = timedOut ? 1 : result.status;

  const payload = {
    status: exitStatus,
    threadId: result.threadId,
    usage: cumulativeUsage ?? null,
    stopReason: timedOut ? "max-duration" : (result.stopReason ?? null),
    rawOutput,
    verified,
    worktree,
    grokVersion,
    verify,
    budget,
    timedOut
  };

  return {
    exitStatus,
    timedOut,
    budget,
    threadId: result.threadId,
    turnId: null,
    payload,
    rendered,
    summary: timedOut
      ? failureMessage
      : firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write,
    verified,
    worktree,
    grokVersion,
    verify,
    usage: cumulativeUsage ?? null
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Critique" ? "critique" : "review",
    title: reviewName === "Review" ? "Grok Build Review" : `Grok Build ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Grok Build Resume" : "Grok Build Delegate";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Delegate";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /grok-build:runs ${payload.jobId} for progress.\n`;
}

function createBridgeJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: resolveJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createBridgeJob({
    prefix: "run",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({
  cwd,
  model,
  effort,
  prompt,
  write,
  resumeLast,
  jobId,
  isolate = false,
  verifyCommands = [],
  verifyAttempts = 2,
  maxDurationSeconds = null,
  maxTurns = null,
  maxCostUsd = null
}) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId,
    isolate,
    verifyCommands,
    verifyAttempts,
    maxDurationSeconds,
    maxTurns,
    maxCostUsd
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Imported the Claude session into a Grok session.",
    payload.threadId ? `Grok session ID: ${payload.threadId}` : "Grok session ID: (not detected in import output)",
    payload.resumeCommand ? `Resume in Grok: ${payload.resumeCommand}` : "Resume with: grok -r <session-id>"
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  ensureGrokAvailable(cwd);
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = runImport(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: result.resumeCommand ?? (result.threadId ? `grok -r ${result.threadId}` : null),
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl"),
    stdout: result.stdout
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedRunWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-bridge.mjs");
  const child = spawn(process.execPath, [scriptPath, "run-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

export function enqueueBackgroundJob(cwd, job, request, options = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    agentPid: null,
    bridgePid: null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  const spawnWorker = options.spawnWorker ?? spawnDetachedRunWorker;
  const child = spawnWorker(cwd, job.id);
  const workerPid = child?.pid ?? null;
  if (workerPid != null) {
    patchJobIfActive(job.workspaceRoot, job.id, {
      status: "queued",
      phase: "queued",
      pid: workerPid,
      bridgePid: workerPid,
      agentPid: null,
      logFile,
      request
    });
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      bridgePid: workerPid,
      pid: workerPid
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ? String(options.model).trim() : null;
  const effort = normalizeReasoningEffort(options.effort);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createBridgeJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });

  const request = {
    kind: "review",
    cwd,
    base: options.base,
    scope: options.scope,
    model,
    effort,
    focusText,
    reviewName: config.reviewName
  };

  if (options.background && !options.wait) {
    ensureGrokAvailable(cwd);
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  await runForegroundCommand(job, (progress) => executeReviewRun({ ...request, onProgress: progress }), {
    json: options.json
  });
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review"
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [
      "model",
      "effort",
      "cwd",
      "prompt-file",
      "verify",
      "verify-attempts",
      "max-duration",
      "max-turns",
      "max-cost"
    ],
    repeatableOptions: ["verify"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background", "isolate", "no-isolate"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ? String(options.model).trim() : null;
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const isolate = resolveIsolateOption(options, write);
  const verifyCommands = normalizeVerifyCommands(options.verify);
  const verifyAttempts = resolveVerifyAttempts(options["verify-attempts"]);
  const maxDurationSeconds = resolveMaxDurationSeconds(options["max-duration"]);
  const maxTurns = resolveMaxTurns(options["max-turns"]);
  const maxCostUsd = resolveMaxCostUsd(options["max-cost"]);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureGrokAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = {
      kind: "task",
      ...buildTaskRequest({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        isolate,
        verifyCommands,
        verifyAttempts,
        maxDurationSeconds,
        maxTurns,
        maxCostUsd
      })
    };
    const { payload } = enqueueBackgroundJob(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        isolate,
        verifyCommands,
        verifyAttempts,
        maxDurationSeconds,
        maxTurns,
        maxCostUsd,
        onProgress: progress
      }),
    { json: options.json }
  );
}

function porcelainDirtyPaths(statusOutput) {
  return String(statusOutput ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      // Porcelain: "XY path" or "XY origin -> path"
      const body = line.length >= 3 ? line.slice(3) : line;
      const arrow = body.indexOf(" -> ");
      return (arrow === -1 ? body : body.slice(arrow + 4)).trim();
    })
    .filter(Boolean);
}

/**
 * Clear a job's worktree field after it has been successfully landed or
 * discarded. Reuses the existing "no worktree to land" guard at the top of
 * handleLand: without this, a second `land` call against the same job id
 * fell through to the git-diff computation against a branch that
 * removeWorktree had already deleted, surfacing a raw git error instead of
 * a clear "already landed" message. Also keeps the render.mjs land-hint
 * from suggesting `/grok-build:land <id>` forever for a job with nothing
 * left to land.
 */
function markJobLanded(workspaceRoot, jobId, storedJob, action) {
  writeJobFile(workspaceRoot, jobId, {
    ...storedJob,
    worktree: null,
    landedAt: nowIso(),
    landAction: action
  });
}

async function handleLand(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "discard", "preview"]
  });

  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? "");
  const storedJob = readStoredJob(workspaceRoot, job.id) ?? job;
  const worktree = storedJob.worktree;

  if (!worktree || typeof worktree !== "object" || !worktree.path) {
    throw new Error(`Run ${job.id} has no worktree to land. It ran without isolation.`);
  }

  const repoRoot = ensureGitRepository(workspaceRoot);
  const branchName = worktree.branch;
  const worktreePath = worktree.path;
  const baseSha = worktree.baseSha;

  if (options.discard) {
    removeWorktree({
      repoRoot,
      worktreePath,
      branchName,
      deleteBranch: true
    });
    markJobLanded(workspaceRoot, job.id, storedJob, "discard");
    const payload = {
      jobId: job.id,
      action: "discard",
      worktree,
      diffStat: null
    };
    const rendered = `Discarded ${job.id}: worktree and branch removed.\n`;
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  if (!branchName) {
    throw new Error(`Run ${job.id} worktree is missing a branch name.`);
  }
  if (!baseSha) {
    throw new Error(`Run ${job.id} worktree is missing baseSha.`);
  }

  const diffRange = `${baseSha}..${branchName}`;
  // gitChecked, not the unchecked git() wrapper: confirmed directly that a
  // stale ref (e.g. a branch already deleted by a prior land or discard)
  // makes `git diff` fail non-zero with empty stdout, and the unchecked
  // wrapper's empty-string result was indistinguishable from a genuinely
  // empty diff - "No changes between base and run branch" printed with
  // total confidence for a run whose branch does not exist at all.
  const diffStat = gitChecked(repoRoot, ["diff", "--stat", diffRange]).stdout.trim();
  const diffBody = gitChecked(repoRoot, ["diff", diffRange]).stdout;

  // Preview is read-only: show what would land without merging or removing.
  if (options.preview) {
    const payload = {
      jobId: job.id,
      action: "preview",
      worktree,
      diffStat,
      diff: diffBody
    };
    const text =
      (diffStat ? `${diffStat}\n\n` : "No changes between base and run branch.\n\n") +
      (diffBody ? `${diffBody.endsWith("\n") ? diffBody : `${diffBody}\n`}` : "") +
      `\nPreview only for ${job.id}: nothing was merged or removed. Re-run without --preview to apply, or with --discard to drop.\n`;
    outputCommandResult(payload, text, options.json);
    return;
  }

  const dirty = git(repoRoot, ["status", "--porcelain"]);
  if (dirty.status !== 0) {
    throw new Error(
      `Unable to inspect working tree before land: ${(dirty.stderr || dirty.stdout || "").trim()}`
    );
  }
  const dirtyFiles = porcelainDirtyPaths(dirty.stdout);
  if (dirtyFiles.length > 0) {
    const named = dirtyFiles.slice(0, 5).join(", ");
    throw new Error(
      `Refusing to land into a dirty working tree. Commit or stash first. Dirty files: ${named}`
    );
  }

  gitChecked(repoRoot, ["merge", "--squash", branchName]);

  removeWorktree({
    repoRoot,
    worktreePath,
    branchName,
    deleteBranch: true
  });
  markJobLanded(workspaceRoot, job.id, storedJob, "apply");

  const currentBranch = getCurrentBranch(repoRoot);
  const payload = {
    jobId: job.id,
    action: "apply",
    worktree,
    diffStat
  };
  const text =
    (diffStat ? `${diffStat}\n\n` : "") +
    `Landed ${job.id} onto ${currentBranch}. Changes are staged; review with git diff --cached and commit when ready.\n`;
  outputCommandResult(payload, text, options.json);
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function readStoredJobWithRetry(workspaceRoot, jobId, options = {}) {
  const attempts = options.attempts ?? 10;
  const delayMs = options.delayMs ?? 25;
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = readStoredJob(workspaceRoot, jobId);
    if (last) {
      return last;
    }
    await sleep(delayMs);
  }
  return last;
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for run-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = await readStoredJobWithRetry(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its run request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );

  const runner =
    request.kind === "review" || storedJob.jobClass === "review"
      ? () => executeReviewRun({ ...request, onProgress: progress })
      : () => executeTaskRun({ ...request, onProgress: progress });

  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    runner,
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`runs --wait` requires a run id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable delegate run found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable delegate run found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

function terminateJobProcessTrees(job) {
  const targets = resolveJobKillTargets(job);
  const results = [];
  for (const pid of targets) {
    results.push({ pid, ...terminateProcessTree(pid) });
  }
  if (results.length === 0) {
    return { attempted: false, delivered: false, method: null, results: [] };
  }
  return {
    attempted: results.some((entry) => entry.attempted),
    delivered: results.some((entry) => entry.delivered),
    method: results.map((entry) => entry.method).filter(Boolean).join("+") || null,
    results
  };
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? job;
  const preClaimRecord = { ...job, ...existing };
  const killTargets = resolveJobKillTargets(preClaimRecord);

  const claim = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: "Stopped by user.",
    phase: "cancelled",
    pid: null,
    agentPid: null,
    bridgePid: null,
    logFile: existing.logFile ?? job.logFile ?? null
  });

  const killResult = terminateJobProcessTrees(preClaimRecord);

  if (!claim.claimed && claim.status && claim.status !== "cancelled") {
    const payload = {
      jobId: job.id,
      status: claim.status,
      title: claim.job?.title ?? job.title,
      killAttempted: killResult.attempted,
      killDelivered: killResult.delivered,
      alreadyTerminal: true,
      claimOrder: "claim-before-kill",
      killTargets
    };
    outputCommandResult(
      payload,
      `Job ${job.id} is already ${claim.status}; not overwritten by stop.\n`,
      options.json
    );
    return;
  }

  appendLogLine(
    existing.logFile ?? job.logFile,
    killResult.delivered
      ? "Stopped by user (claim-before-kill)."
      : `Stop claimed; process tree kill delivered=${killResult.delivered} method=${killResult.method ?? "none"}.`
  );

  const merged = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: killResult.delivered
      ? "Stopped by user."
      : "Stop claimed but process may still be running (kill not delivered).",
    cancelKill: killResult,
    logFile: existing.logFile ?? job.logFile ?? null
  });

  const nextJob = merged.job ?? claim.job ?? {
    ...existing,
    status: "cancelled",
    phase: "cancelled",
    title: job.title
  };
  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    killAttempted: killResult.attempted,
    killDelivered: killResult.delivered,
    killMethod: killResult.method,
    killTargets,
    claimOrder: "claim-before-kill",
    claimed: claim.claimed
  };

  outputCommandResult(payload, renderCancelReport({ ...nextJob, ...payload }), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "check":
      await handleCheck(argv);
      break;
    case "doctor":
      await handleDoctor(argv);
      break;
    case "prune":
      await handlePrune(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "critique":
      await handleReviewCommand(argv, {
        reviewName: "Critique"
      });
      break;
    case "run":
      await handleTask(argv);
      break;
    case "import":
      await handleTransfer(argv);
      break;
    case "run-worker":
      await handleTaskWorker(argv);
      break;
    case "runs":
      await handleStatus(argv);
      break;
    case "show":
      handleResult(argv);
      break;
    case "run-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "stop":
      await handleCancel(argv);
      break;
    case "land":
      await handleLand(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { main, readStoredJobWithRetry };