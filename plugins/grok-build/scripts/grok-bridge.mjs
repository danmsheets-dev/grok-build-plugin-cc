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
import { defaultVerifyCommands, detectPrimaryEcosystem } from "./lib/ecosystem.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import {
  describeVerifySource,
  loadWorkspaceProjectConfig,
  PROJECT_CONFIG_FILENAME,
  recordProjectConfigTrust,
  resolveIsolateSetting,
  resolveRunSettings,
  revokeProjectConfigTrust
} from "./lib/project-config.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  planBlenderScriptSandbox,
  planWorktreeLinks,
  provisionWorktree
} from "./lib/provision.mjs";
import {
  claimJobTerminal,
  generateJobId,
  isTerminalJobStatus,
  listJobs,
  patchJobIfActive,
  resolveJobLogFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import { redactSecrets, redactSecretsDeep } from "./lib/redact.mjs";
import { MESSAGE_SEPARATOR } from "./lib/stream-events.mjs";
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
  compileUserPatterns,
  deriveVerifyTimeoutMs,
  probeBaselines,
  resolveOutputFailurePatterns,
  resolveVerifyMaxBufferBytes,
  resolveVerifyTimeoutMs,
  runVerifyCommand,
  summarizeFailures
} from "./lib/verify.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  artifactExcludePathspecs,
  capChangedFiles,
  commitWorktreeChanges,
  createWorktree,
  listCommittedChanges,
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

// `land --preview` materialises the whole diff into a string, into a JSON
// payload, and then into a terminal. 128 KB is already more than anyone reads;
// past that the useful artefact is `diffStat` plus the command to run. The
// worktree's own diff is not bounded by anything else - a single re-imported
// Godot texture or a re-saved .blend is megabytes on its own.
const PREVIEW_DIFF_MAX_BYTES = 128 * 1024;
// `--stat` output is one short line per changed file, so this is only a guard
// against a pathological change set (thousands of Godot sidecars), not a
// budget anyone should hit. Explicit because runCommand no longer leaves the
// key unset - see the maxBuffer note in process.mjs.
const DIFF_STAT_MAX_BYTES = 1024 * 1024;

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
      "  node scripts/grok-bridge.mjs verify-plan [--verify <command>] [--no-verify] [--json]",
      "  node scripts/grok-bridge.mjs trust-config [--revoke] [--json]",
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

// The one command that grants a project config's executable keys. Printed
// verbatim by doctor and by the run header, so it must stay copy-pasteable and
// must stay in one place - a hint the user cannot run is not a trust gate, it
// is a dead end.
const TRUST_CONFIG_COMMAND = "node scripts/grok-bridge.mjs trust-config";

/**
 * Everything a run needs to know about this project before it starts: the
 * config file (with its trust verdict already applied), the detected
 * ecosystem, and the resolved settings.
 *
 * Resolution happens HERE - server-side, in the bridge - rather than in the
 * delegate subagent. The subagent makes exactly one Bash call by design (both
 * agents/grok-delegate.md and the delegate skill state that twice, for
 * prompt-injection reasons), so a second "ask the bridge for a plan, then
 * re-serialise N --verify flags" round trip is not available to it, and would
 * put an LLM in charge of re-quoting command strings. Resolving here covers
 * foreground runs, --background, and a bare `run` from the CLI at once.
 *
 * @param {string} workspaceRoot
 * @param {object} [cli] already-shaped CLI settings (see cliSettingsFromTaskOptions)
 */
function resolveProjectRunPlan(workspaceRoot, cli = {}) {
  const projectConfig = loadWorkspaceProjectConfig(workspaceRoot);
  const ecosystem = detectPrimaryEcosystem(workspaceRoot);
  // tools.* is an executable key, so it only reaches this call at all when the
  // config file is trusted; loadWorkspaceProjectConfig has already withheld it
  // otherwise.
  const toolOverride = ecosystem ? projectConfig.config.tools?.[ecosystem.id] : undefined;
  const ecosystemVerify = defaultVerifyCommands(ecosystem, { override: toolOverride });

  const settings = resolveRunSettings({
    cli,
    config: projectConfig.config,
    ecosystemDefaults: { verify: ecosystemVerify }
  });

  return { projectConfig, ecosystem, settings };
}

/**
 * The CLI half of the precedence chain, in the shape resolveRunSettings wants.
 *
 * `verify` is passed as `undefined` when the flag was absent rather than as
 * the `[]` normalizeVerifyCommands would produce, because those two are not
 * the same thing here: `[]` from an absent flag must let the config and the
 * ecosystem defaults through, while a value the user actually typed must win.
 */
function cliSettingsFromTaskOptions(options = {}) {
  // Same "absent is not empty" rule as --verify, and for the same reason: an
  // empty array is a usable value as far as resolveRunSettings is concerned,
  // so it would beat the config's list rather than deferring to it.
  const cliIgnore =
    options["verify-ignore"] === undefined
      ? undefined
      : normalizeVerifyCommands(options["verify-ignore"]);

  return {
    verify: options.verify === undefined ? undefined : normalizeVerifyCommands(options.verify),
    noVerify: Boolean(options["no-verify"]),
    verifyAttempts: options["verify-attempts"],
    verifyIgnorePatterns: cliIgnore && cliIgnore.length > 0 ? cliIgnore : undefined,
    // The three CLI flags are typed in the units a human thinks in (seconds,
    // megabytes) while the config keys they share a precedence chain with are
    // stored in the units the runner uses. Converting here - rather than
    // anywhere downstream - is what lets resolveRunSettings compare a CLI
    // value against a config value at all, and an unusable value resolves to
    // null so it falls through to the config instead of overriding it with
    // nonsense.
    verifyTimeoutMs: resolveVerifyTimeoutMs(options["verify-timeout"]),
    baselineTimeoutMs: resolveVerifyTimeoutMs(options["baseline-timeout"]),
    verifyMaxOutputBytes: resolveVerifyMaxBufferBytes(options["verify-max-buffer"]),
    maxDurationSeconds: options["max-duration"],
    maxTurns: options["max-turns"],
    maxCostUsd: options["max-cost"],
    model: options.model,
    effort: options.effort
  };
}

/**
 * Parse repeatable `--env KEY=VALUE` into an override map.
 *
 * Split on the FIRST `=` only: a Windows PATH-shaped value
 * (`--env PATHX=C:\a=b`) and a base64 token both legitimately contain more.
 * An empty key, or a token with no `=` at all, throws rather than being
 * silently dropped - a typo'd override that quietly does nothing produces a
 * verify failure with no visible cause, and parseCommandInput already fails
 * loudly for a malformed option.
 *
 * Exported for tests; the CLI reaches it through handleTask.
 *
 * @param {string|string[]|undefined|null} raw
 * @returns {Record<string, string>}
 */
export function parseEnvAssignments(raw) {
  const tokens = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  /** @type {Record<string, string>} */
  const overrides = {};
  for (const token of tokens) {
    const text = String(token ?? "");
    const separator = text.indexOf("=");
    const key = separator === -1 ? "" : text.slice(0, separator).trim();
    if (separator === -1 || !key) {
      throw new Error(`Invalid --env ${JSON.stringify(text)}. Use --env KEY=VALUE.`);
    }
    // The value is NOT trimmed: trailing whitespace can be meaningful, and a
    // value of "" is a legitimate way to blank an inherited variable.
    overrides[key] = text.slice(separator + 1);
  }
  return overrides;
}

/**
 * A JSON round trip (the background job record) can hand back anything, so the
 * override map is re-validated on the way out rather than trusted.
 *
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function normalizeEnvOverrides(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  /** @type {Record<string, string>} */
  const overrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      overrides[key] = String(value);
    }
  }
  return overrides;
}

/**
 * The environment a verify command and the agent actually run with.
 *
 * ALWAYS a full copy of process.env with the overrides layered on top, never
 * the bare override map: `runVerifyCommand` hands `options.env` straight to the
 * spawn, so a bare object would strip PATH and SystemRoot and break every
 * command on Windows. Returns undefined when there is nothing to override, so a
 * run without --env spawns with exactly the environment it always did.
 *
 * @param {Record<string, string>} overrides
 * @returns {NodeJS.ProcessEnv|undefined}
 */
function buildRunEnvironment(overrides) {
  return Object.keys(overrides).length > 0 ? { ...process.env, ...overrides } : undefined;
}

/**
 * Keys whose VALUE never reaches a persisted record.
 *
 * Redaction is by key NAME rather than by running the values through
 * redactSecretsDeep: that function rewrites `KEY=value`-shaped strings, which
 * is the wrong shape here (these are already split into a map), and it would
 * both mangle innocent paths and miss a token stored under a key like MY_PAT.
 */
const SENSITIVE_ENV_KEY_PATTERN = /(token|secret|key|password|passwd|credential|pat)$/i;

/**
 * The override map as it is safe to persist and show: keys verbatim, sensitive
 * values replaced. Which variables a run set is diagnostic information; their
 * values are the user's secrets.
 *
 * @param {Record<string, string>} overrides
 */
function redactEnvForRecord(overrides) {
  /** @type {Record<string, string>} */
  const record = {};
  for (const [key, value] of Object.entries(overrides)) {
    record[key] = SENSITIVE_ENV_KEY_PATTERN.test(key) ? "[redacted]" : String(value);
  }
  return record;
}

/**
 * The resolved verify plan, as reported by `verify-plan` and echoed in the run
 * header. Spawns nothing and reads nothing but the project's own files.
 */
function buildVerifyPlanPayload({ projectConfig, ecosystem, settings }) {
  return {
    ecosystem: ecosystem
      ? {
          id: ecosystem.id,
          major: ecosystem.major ?? null,
          testRunner: ecosystem.testRunner ?? null
        }
      : null,
    commands: settings.verify,
    source: settings.sources.verify,
    disabled: Boolean(settings.verifyDisabled),
    // An explicit --verify-timeout / config verifyTimeoutMs is used verbatim;
    // otherwise this is the no-baseline floor, which is what a command gets
    // when the probe has nothing to say about it. The two are reported
    // distinctly because "we will allow 40 minutes because you asked" and "we
    // will allow 2 minutes until we have measured something" are different
    // answers to the same question.
    timeoutSeconds: Math.round(
      (settings.verifyTimeoutMs ??
        deriveVerifyTimeoutMs(null, { multiplier: settings.verifyTimeoutMultiplier })) / 1000
    ),
    timeoutSource: settings.verifyTimeoutMs != null ? (settings.sources.verifyTimeoutMs ?? "explicit") : "derived",
    trusted: projectConfig.present ? projectConfig.trusted : null,
    config: {
      present: projectConfig.present,
      path: projectConfig.path,
      trusted: projectConfig.trusted,
      withheld: Object.keys(projectConfig.untrusted),
      errors: projectConfig.errors,
      warnings: projectConfig.warnings
    },
    trustCommand: Object.keys(projectConfig.untrusted).length > 0 ? TRUST_CONFIG_COMMAND : null
  };
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

/**
 * The resolved verify timing budget, as it travels through a task request.
 *
 * Re-validated on the way out of the request rather than trusted, because a
 * background run reads it back from a JSON file another process wrote: a
 * corrupted or hand-edited record must degrade to the derived defaults, not
 * hand a NaN to setTimeout (which fires immediately and would kill every
 * verify command the instant it started).
 *
 * @param {unknown} raw
 */
function normalizeVerifyTiming(raw) {
  const positive = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  return {
    timeoutMs: positive(raw?.timeoutMs),
    multiplier: positive(raw?.multiplier),
    baselineTimeoutMs: positive(raw?.baselineTimeoutMs),
    maxOutputBytes: positive(raw?.maxOutputBytes),
    sources: raw?.sources && typeof raw.sources === "object" ? raw.sources : {}
  };
}

/**
 * The per-attempt timeout for one verify command.
 *
 * An explicit budget is an explicit branch rather than a floor===cap trick, so
 * the run record can say whether the number came from the user or from the
 * measured baseline - and so an explicit value is honoured verbatim, above the
 * 15-minute derived cap (raising that cap is the entire point of the flag) and
 * below the 2-minute derived floor if that is genuinely what was asked for.
 *
 * @param {{ ms?: number }|undefined|null} baselineEntry
 * @param {ReturnType<typeof normalizeVerifyTiming>} timing
 * @returns {{ timeoutMs: number, source: "explicit"|"derived" }}
 */
function resolveVerifyAttemptTimeout(baselineEntry, timing) {
  if (timing.timeoutMs != null) {
    return { timeoutMs: timing.timeoutMs, source: "explicit" };
  }
  // No hardcoded fallback duration here: deriveVerifyTimeoutMs already returns
  // its floor for a null/unmeasured baseline, and duplicating that number in
  // the bridge is how the two drifted apart in the first place.
  const baselineMs =
    baselineEntry && Number.isFinite(baselineEntry.ms) ? baselineEntry.ms : null;
  return {
    timeoutMs: deriveVerifyTimeoutMs(baselineMs, { multiplier: timing.multiplier ?? undefined }),
    source: "derived"
  };
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

// configIsolate is the project config's `isolate`, and sits between the two
// explicit flags and the write-implies-isolate default. --no-isolate stays an
// absolute override rather than just the top of a precedence chain: a user who
// typed it must get a non-isolated run even when the repo asks for isolation.
function resolveIsolateOption(options, write, configIsolate = undefined) {
  return resolveIsolateSetting({
    cliIsolate: Boolean(options.isolate),
    cliNoIsolate: Boolean(options["no-isolate"]),
    configIsolate,
    write
  });
}

// How much of a failing command's output the fix prompt carries. The function
// has claimed to be "bounded" since it was written but embedded the whole
// capture, which after item 6's head+tail ring can still be ~320 KB - enough on
// its own to blow the Windows command line. The TAIL is kept because that is
// where the failure summary, the assertion and the exit line live; a compiler's
// opening banner is not what the fix turn needs.
const VERIFY_FIX_OUTPUT_TAIL_BYTES = 4 * 1024;

function tailBytesOf(text, maxBytes) {
  const buffer = Buffer.from(String(text ?? ""), "utf8");
  if (buffer.length <= maxBytes) {
    return String(text ?? "");
  }
  // Decoded once at the end, so only the single cut point can land mid-character.
  const tail = buffer.subarray(buffer.length - maxBytes).toString("utf8");
  return `[... ${buffer.length - maxBytes} earlier bytes elided; showing the last ${maxBytes} bytes ...]\n${tail}`;
}

function buildBoundedVerifyFixPrompt(command, output) {
  // Verify stdout/stderr can echo real secrets (env dumps, config prints). Scrub
  // before embedding in the next model prompt so a leaked key is not re-sent.
  // Redact BEFORE truncating: truncating first would leave a secret that happens
  // to sit in the discarded head unredacted in the persisted capture, and could
  // split a token so the redactor no longer recognizes it.
  const safeOutput = tailBytesOf(
    redactSecretsDeep(output == null ? "" : String(output)),
    VERIFY_FIX_OUTPUT_TAIL_BYTES
  );
  return (
    `The verify command \`${command}\` failed. Fix the cause, then re-run only that exact command until it passes. ` +
    `Do not investigate unrelated failures, do not run the full test suite, and do not change any test to make it pass.\n\n` +
    `Output:\n${safeOutput}`
  );
}

// The run-report contract, delivered through `--rules` so the CLI appends it to
// the SYSTEM prompt.
//
// Not appended to the user's prompt, for two reasons. The prompt is what
// buildTaskRunMetadata shortens into `job.summary`, which is the title shown in
// /grok-build:runs and /grok-build:show - contract text pasted there would
// become the visible name of every run. And under --resume-last the prompt is
// DEFAULT_CONTINUE_PROMPT, which doubles as the fallback summary, so the leak
// would be worse there, not better.
//
// Read once per process. A background worker is its own process, so nothing is
// stale across runs.
let runReportRulesCache = null;
function loadRunReportRules() {
  if (runReportRulesCache == null) {
    runReportRulesCache = loadPromptTemplate(ROOT_DIR, "run-report").trim();
  }
  return runReportRulesCache;
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

/**
 * Reduce a provisionWorktree result to something safe to persist in a job file.
 *
 * Paths are collapsed to basenames on purpose: the full `from`/`to` pair leaks
 * the user's filesystem layout into a JSON file the delegate subagent reads
 * back, and the basename is the only part that identifies WHICH dependency
 * directory this was. `failed[].reason` is a raw `error.message` straight out
 * of fs (provision.mjs), so it can carry an absolute path or, on a networked
 * mount, a credentialed URL - redact and shorten it before it lands anywhere.
 *
 * @param {{provisioned: Array<object>, failed: Array<object>, notes: string[]}} result
 */
function summarizeProvisionResult(result) {
  const nameOf = (entry) => path.basename(String(entry?.to || entry?.from || "")) || "unknown";
  return {
    provisioned: (result?.provisioned ?? []).map((entry) => ({
      name: nameOf(entry),
      kind: entry.kind ?? null
    })),
    failed: (result?.failed ?? []).map((entry) => ({
      name: nameOf(entry),
      reason: shorten(redactSecrets(String(entry?.reason ?? "unknown")), 160)
    })),
    notes: (result?.notes ?? []).map((note) => String(note))
  };
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

/**
 * One-line summary of a run, taken from the `## Result` section of the report
 * the run-report contract asks for (prompts/run-report.md).
 *
 * `firstMeaningfulLine` on its own returns the first sentence the model ever
 * emitted - "Let me look at the project structure." - and that string becomes
 * job.summary, i.e. the title of the run in /grok-build:runs. Once the contract
 * is honoured its first line is worse still: the literal heading `## Result`.
 *
 * Returns "" when there is no such section, which every caller treats as
 * "fall back to the plain text".
 *
 * @param {string} report
 * @returns {string}
 */
export function summarizeFinalReport(report) {
  // JS has no \Z; (?![\s\S]) is the end-of-input assertion that does exist, and
  // it is what stops the last section from being greedy past the end.
  const match = String(report ?? "").match(/^##[ \t]*Result[ \t]*\r?\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/mi);
  return match ? shorten(match[1]) : "";
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

/**
 * How each doctor status level is marked in the rendered report.
 *
 * `skipped` renders as `skip` so every marker stays four characters or fewer
 * and the check names line up when a report mixes levels.
 */
const DOCTOR_STATUS_MARKS = Object.freeze({
  ok: "ok",
  fail: "FAIL",
  warn: "warn",
  skipped: "skip"
});

/**
 * The status of one check, for readers that were written before `status`
 * existed (or for a check literal that only set `ok`).
 */
function doctorCheckStatus(check) {
  return check?.status ?? (check?.ok ? "ok" : "fail");
}

/**
 * Normalize one doctor check to carry BOTH a `status` level and the legacy
 * `ok` boolean.
 *
 * `ok` is kept deliberately: every existing consumer - `tests/ops.test.mjs`,
 * `commands/doctor.md`'s "return the report verbatim" contract, and any script
 * a user has already written against `--json` - reads it. Adding a level
 * without keeping the boolean would be a silent breaking change to a payload
 * whose whole job is to be machine-read.
 *
 * `warn` and `skipped` resolve to `ok: true` so an unmigrated reader stays
 * green: a warning is advice, not a defect, and a skipped check measured
 * nothing at all. Only `fail` is false.
 */
function normalizeDoctorCheck(check) {
  const status = doctorCheckStatus(check);
  return { ...check, status, ok: status !== "fail" };
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
    const status = doctorCheckStatus(check);
    const mark = DOCTOR_STATUS_MARKS[status] ?? status;
    lines.push(`- [${mark}] ${check.name}: ${check.detail}`);
    // Verbatim, one per line, unwrapped and unshortened. This is the only
    // place a user gets to read what a repo-tracked config would have this
    // machine execute, so paraphrasing or truncating it would defeat the
    // whole trust gate.
    for (const command of check.commands ?? []) {
      lines.push(`    ${command}`);
    }
    // A warn carries `ok: true`, so the fix line has to be selected on the
    // status level. Gating it on `!check.ok` (as this did before levels
    // existed) would print the problem and silently withhold the remedy,
    // which is the least useful half of the two.
    if ((status === "fail" || status === "warn") && check.fix) {
      lines.push(`    Fix: ${check.fix}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The project-config check. This is the visibility half of the trust gate:
 * a config file that wants to run commands is reported as needing attention,
 * its commands are printed verbatim, and the exact command that grants them is
 * named. Without this, "your verify was silently ignored" is indistinguishable
 * from "you have no config".
 */
function buildProjectConfigCheck(workspaceRoot) {
  const loaded = loadWorkspaceProjectConfig(workspaceRoot);

  if (!loaded.present) {
    return {
      name: "project config",
      ok: true,
      detail: `no ${PROJECT_CONFIG_FILENAME}`,
      fix: null
    };
  }

  if (loaded.errors.length > 0) {
    return {
      name: "project config",
      ok: false,
      detail: loaded.errors.join("; "),
      fix: `Fix ${loaded.path} - until it parses, none of its settings apply.`
    };
  }

  const withheld = Object.keys(loaded.untrusted);
  if (withheld.length === 0) {
    const suffix = loaded.trusted ? " (trusted)" : "";
    return {
      name: "project config",
      ok: true,
      detail: `${PROJECT_CONFIG_FILENAME} loaded, no executable keys${suffix}`,
      fix: null
    };
  }

  const commands = [...(loaded.untrusted.verify ?? [])];
  for (const [tool, binary] of Object.entries(loaded.untrusted.tools ?? {})) {
    commands.push(`tools.${tool} = ${binary}`);
  }
  for (const [name, value] of Object.entries(loaded.untrusted.env ?? {})) {
    commands.push(`env.${name} = ${value}`);
  }

  return {
    name: "project config",
    ok: false,
    detail: `${withheld.join(", ")} in ${PROJECT_CONFIG_FILENAME} is withheld until you trust this file - it would run:`,
    commands,
    fix: `Read the commands above. If you wrote them (or trust whoever did), run \`${TRUST_CONFIG_COMMAND}\`.`
  };
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

  checks.push(buildProjectConfigCheck(workspaceRoot));

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

  const normalized = checks.map(normalizeDoctorCheck);
  return {
    // Only a `fail` moves the overall verdict. A warn is advice the user may
    // legitimately have already decided against (verifying via an absolute
    // path, or with no engine binary installed at all), and a skip measured
    // nothing - neither is grounds for calling the whole environment broken.
    ok: normalized.every((check) => check.status !== "fail"),
    checks: normalized
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
  // doctor always exits 0, including for warn and fail checks: it is a report,
  // not a gate. A non-zero exit would make `/grok-build:doctor` look like a
  // failed command in the Claude Code transcript. There used to be an
  // `if (!report.ok) { process.exitCode = 0; }` here, which read as an
  // unfinished thought and invited exactly the wiring this comment forbids.
}

function renderVerifyPlan(payload) {
  const lines = [
    "# Grok Build Verify Plan",
    "",
    `Ecosystem: ${payload.ecosystem ? payload.ecosystem.id : "none detected"}`,
    `Source: ${describeVerifySource(payload.source)}`
  ];

  if (payload.disabled) {
    lines.push("Verification is disabled for this run (--no-verify).");
  } else if (payload.commands.length === 0) {
    lines.push("No verify commands resolved; a run would not verify anything.");
  } else {
    // describeVerifySource is deliberately not reused here: its "cli" label is
    // the string "--verify", which is the wrong flag to name for a timeout.
    const timeoutOrigin =
      payload.timeoutSource === "config"
        ? ` (set by ${PROJECT_CONFIG_FILENAME})`
        : payload.timeoutSource === "derived"
          ? " (no baseline)"
          : " (set by --verify-timeout)";
    lines.push(`Timeout per command${timeoutOrigin}: ${payload.timeoutSeconds}s`, "", "Commands:");
    for (const command of payload.commands) {
      lines.push(`  ${command}`);
    }
  }

  for (const message of payload.config.errors) {
    lines.push("", message);
  }
  if (payload.config.withheld.length > 0) {
    lines.push(
      "",
      `${payload.config.withheld.join(", ")} in ${PROJECT_CONFIG_FILENAME} is withheld until you trust that file.`,
      `Trust it with: ${payload.trustCommand}`
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * `verify-plan` - read-only. It resolves what a run WOULD verify and why, and
 * that is all: it spawns nothing, runs no verify command, and touches no
 * network. It exists for doctor/debug visibility. It is deliberately NOT a
 * step the delegate subagent performs (see resolveProjectRunPlan).
 */
async function handleVerifyPlan(argv) {
  const { options } = parseCommandInput(argv, {
    // --verify-timeout is accepted here too so the reported timeoutSeconds can
    // answer "what would THIS command line do", not just "what does the
    // project default to".
    valueOptions: ["cwd", "verify", "verify-timeout"],
    repeatableOptions: ["verify"],
    booleanOptions: ["json", "no-verify"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const plan = resolveProjectRunPlan(workspaceRoot, cliSettingsFromTaskOptions(options));
  const payload = buildVerifyPlanPayload(plan);
  outputResult(options.json ? payload : renderVerifyPlan(payload), options.json);
}

function renderTrustConfigResult(payload) {
  if (payload.revoked) {
    return `Trust for ${payload.path} revoked. Its verify/tools/env keys are withheld again.\n`;
  }
  if (!payload.recorded) {
    return `Nothing to trust: ${payload.detail}\n`;
  }

  const lines = [`Trusted ${payload.path} (sha256 ${payload.hash.slice(0, 12)}).`];
  if (payload.verify.length > 0) {
    lines.push("", "Runs in this workspace may now execute:");
    for (const command of payload.verify) {
      lines.push(`  ${command}`);
    }
  }
  lines.push(
    "",
    "Editing the file revokes this automatically - trust is recorded for its exact contents."
  );
  return `${lines.join("\n")}\n`;
}

/**
 * `trust-config` - the one action that grants a project config's executable
 * keys. Trust is recorded against the file's sha256, in the plugin's state dir
 * (keyed by workspace root, outside the repository), so it cannot be shipped
 * inside a clone and any later edit to the file silently withdraws it.
 */
async function handleTrustConfig(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "revoke"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);

  if (options.revoke) {
    revokeProjectConfigTrust(workspaceRoot);
    const payload = {
      revoked: true,
      recorded: false,
      path: path.join(workspaceRoot, PROJECT_CONFIG_FILENAME)
    };
    outputCommandResult(payload, renderTrustConfigResult(payload), options.json);
    return;
  }

  const result = recordProjectConfigTrust(workspaceRoot);
  const payload = {
    revoked: false,
    recorded: result.recorded,
    path: result.loaded.path,
    hash: result.hash ?? null,
    detail: result.recorded
      ? "trusted"
      : result.reason === "no-config"
        ? `there is no ${PROJECT_CONFIG_FILENAME} in this workspace`
        : `${PROJECT_CONFIG_FILENAME} could not be read`,
    // Reported from the pre-trust view, which is the set of keys this call
    // actually unlocked.
    verify: result.loaded.untrusted.verify ?? [],
    tools: result.loaded.untrusted.tools ?? {},
    errors: result.loaded.errors
  };
  outputCommandResult(payload, renderTrustConfigResult(payload), options.json);
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
    // Review prompts are the ones that actually reach the command-line limit:
    // they carry a whole diff, and the critique path adds a serialized schema on
    // top. Handing over a spill directory lets an oversized prompt travel via
    // --prompt-file intact instead of being truncated.
    promptFileDir: resolveStateDir(request.cwd),
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
    // A native review has no JSON summary to read, so the report contract's
    // `## Result` section is the best one-liner available; the first line of
    // the transcript is the model clearing its throat. Deliberately NOT applied
    // to the structured branch above, where parsed.summary already wins and
    // firstMeaningfulLine is only the unparsable-output fallback.
    summary:
      summarizeFinalReport(result.finalReport) ||
      firstMeaningfulLine(result.finalMessage, `${reviewName} completed.`),
    jobTitle: `Grok Build ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

/**
 * Working-tree changes as a `path -> status letter` map, with the SAME artifact
 * filter the commit path applies inside a worktree.
 *
 * Filtered rather than raw so a non-isolated Godot run does not report five
 * hundred `.godot/` cache files as its deliverable - the manifest has to mean
 * the same thing on both paths, or the isolated and non-isolated forms of the
 * same run would describe themselves differently.
 *
 * Returns null when git cannot be asked at all, which callers treat as "no
 * manifest", never as "nothing changed".
 *
 * @param {string} cwd
 * @returns {Map<string, string>|null}
 */
function porcelainChangeEntries(cwd) {
  // -uall because git otherwise collapses a wholly untracked directory to a
  // single `src/` entry, and "the agent created src/" is not a manifest. The
  // extra walk is bounded by the same artifact excludes as the commit path, so
  // the heavyweight directories (node_modules, target, .godot) are not
  // enumerated, and this only runs on a --write --no-isolate run.
  const args = ["status", "--porcelain", "--untracked-files=all"];
  let status = git(cwd, [...args, "--", ".", ...artifactExcludePathspecs()]);
  if (status.status !== 0) {
    // Mirror the land gate's fallback: an ancient git that rejects pathspec
    // magic degrades to an unfiltered listing rather than losing the manifest.
    status = git(cwd, args);
  }
  if (status.status !== 0 || status.error) {
    return null;
  }

  const entries = new Map();
  for (const line of String(status.stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      continue;
    }
    const code = trimmed.slice(0, 2);
    const body = trimmed.length >= 3 ? trimmed.slice(3) : trimmed;
    const arrow = body.indexOf(" -> ");
    const filePath = (arrow === -1 ? body : body.slice(arrow + 4)).trim();
    if (!filePath) {
      continue;
    }
    // Normalized to git's own --name-status vocabulary so both manifest paths
    // render identically. An untracked file is an addition from the user's
    // point of view, whatever the index thinks.
    const letter = code.trim() === "??" ? "A" : (code.trim()[0] ?? "M");
    entries.set(filePath, letter);
  }
  return entries;
}

/**
 * What a NON-isolated write run changed, relative to what was already dirty.
 *
 * A bare post-run `git status --porcelain` also lists every edit the user had
 * in flight before the run started, and presenting those as the agent's work is
 * a lie in the one direction that matters. Paths dirty at both ends are dropped
 * and counted instead: the agent may well have touched them too, and there is
 * no way to tell from status alone.
 *
 * @param {string} cwd
 * @param {Set<string>|null} before - paths dirty before the agent started
 * @returns {{source: string, entries: string[], total: number, truncated: boolean, preexistingDirty: number}|null}
 */
function collectWorkingTreeChanges(cwd, before) {
  const after = porcelainChangeEntries(cwd);
  if (!after || !before) {
    return null;
  }
  const fresh = [];
  let preexistingDirty = 0;
  for (const [filePath, letter] of after) {
    if (before.has(filePath)) {
      preexistingDirty += 1;
      continue;
    }
    fresh.push(`${letter}\t${filePath}`);
  }
  return { source: "working-tree", ...capChangedFiles(fresh), preexistingDirty };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);

  // Derived rather than plumbed: `meta.logFile` is created in
  // runForegroundCommand AFTER the runner closure that calls this function is
  // built, so it is genuinely not available to be passed in. This is the same
  // path resolveJobLogFile hands tracked-jobs, which appends the complete
  // rendered result to it - the durable artifact of the run, and useless if the
  // user is never told where it is.
  const logFile = request.jobId ? resolveJobLogFile(workspaceRoot, request.jobId) : null;

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
  // Resolved by handleTask (or absent, for a caller that passed an explicit
  // command list of its own). Purely descriptive - the plan is already baked
  // into verifyCommands by the time it gets here.
  const verifyPlan = request.verifyPlan ?? null;
  // Resolved by handleTask from --verify-timeout / --baseline-timeout /
  // --verify-max-buffer and the project config. Threaded through BOTH request
  // shapes on purpose: a value that reached only the foreground path would
  // silently do nothing under --background, which is exactly the long import
  // the flags exist for.
  const verifyTiming = normalizeVerifyTiming(request.verifyTiming);
  // Compiled HERE rather than in handleTask, from raw strings carried in the
  // request. A background run reads its request back out of a JSON file, and a
  // RegExp serialises to `{}` - patterns compiled before the write would
  // silently become no-ops for exactly the long-running runs they matter most
  // to. Invalid patterns warn and drop, the same treatment an unknown option
  // gets, because one bad character in a config regex must cost the pattern
  // and not the run.
  const warnAboutPattern = (message) => {
    process.stderr.write(`Warning: ${message}\n`);
    request.onProgress?.({ message: `Warning: ${message}` });
  };
  const outputFailurePatterns = resolveOutputFailurePatterns(
    verifyPlan?.ecosystem,
    request.verifyFailurePatterns,
    { onWarning: warnAboutPattern }
  );
  const verifyIgnorePatterns = compileUserPatterns(request.verifyIgnorePatterns, {
    onWarning: warnAboutPattern
  });
  // Godot re-prints the same runtime error once per frame, so occurrence
  // counts are noise there and only the deduped signature can be trusted.
  const rawCountComparison = verifyPlan?.ecosystem === "godot" ? "ignore" : "strict";
  const maxDurationSeconds = resolveMaxDurationSeconds(request.maxDurationSeconds);
  const maxTurns = resolveMaxTurns(request.maxTurns);
  const maxCostUsd = resolveMaxCostUsd(request.maxCostUsd);
  // Already merged by handleTask (--env over a trusted config's `env`), and
  // re-validated here because a background worker reads this map back out of a
  // JSON file. Blender is the reason it exists: it has no CLI flag for "use
  // this add-on directory", only BLENDER_USER_SCRIPTS and friends.
  const envOverrides = normalizeEnvOverrides(request.env);

  const grokVersion = getGrokAvailability(request.cwd).detail ?? null;

  let created = null;
  let runCwd = workspaceRoot;
  /** @type {{provisioned: Array<{name: string, kind: string}>, failed: Array<{name: string, reason: string}>, notes: string[]}|null} */
  let provisionSummary = null;
  /** @type {Record<string, string>|null} */
  let blenderSandboxEnv = null;
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
    const plan = planWorktreeLinks(created.repoRoot, created.worktreePath, {
      // Only ever true/false when the project config said so; undefined lets
      // GROK_BUILD_LINK_GODOT_CACHE decide, which is the documented default
      // path and the one a background worker inherits through its environment.
      copyGodotCache: request.provisionCopy
    });
    // The result used to be discarded outright, so a link that failed - the
    // commonest being a `.godot` that is tracked in git and therefore already
    // checked out into the worktree - was invisible, and the run just got
    // mysteriously slower.
    provisionSummary = summarizeProvisionResult(provisionWorktree(plan));
    if (request.blenderSandbox) {
      // Inside the worktree, so unlinkReparsePointsSync already tears the
      // junction down with the rest of the run, and `.grok-build/` is excluded
      // from the commit so the linked add-on cannot be committed twice.
      const sandboxPlan = planBlenderScriptSandbox(created.worktreePath, {
        repoRoot: created.repoRoot
      });
      const sandboxResult = summarizeProvisionResult(provisionWorktree(sandboxPlan));
      provisionSummary = {
        provisioned: [...provisionSummary.provisioned, ...sandboxResult.provisioned],
        failed: [...provisionSummary.failed, ...sandboxResult.failed],
        notes: [...provisionSummary.notes, ...sandboxResult.notes]
      };
      // Only claim the sandbox when the link actually landed. Setting
      // BLENDER_USER_SCRIPTS at an add-on directory that does not exist is
      // strictly worse than not sandboxing at all: Blender would then find NO
      // add-ons, and the verify command fails for a reason that has nothing to
      // do with the code.
      if (Object.keys(sandboxPlan.env).length > 0 && sandboxResult.failed.length === 0) {
        blenderSandboxEnv = sandboxPlan.env;
      } else if (sandboxResult.failed.length > 0) {
        provisionSummary.notes.push(
          "--blender-sandbox: the add-on could not be linked, so BLENDER_USER_SCRIPTS was left alone and Blender will use your real add-on directory."
        );
      }
    }
    // A SECOND patch: the one above fires before planning even starts, so the
    // summary has nowhere to attach there.
    if (request.jobId) {
      patchJobIfActive(workspaceRoot, request.jobId, { provision: provisionSummary });
    }
    runCwd = created.worktreePath;
  } else if (request.blenderSandbox) {
    // The sandbox lives inside a worktree and is torn down with it. Building one
    // in the user's real checkout would leave a junction behind in their
    // repository, which nothing cleans up.
    provisionSummary = {
      provisioned: [],
      failed: [],
      notes: [
        "--blender-sandbox needs an isolated write run (--write, without --no-isolate); nothing was sandboxed."
      ]
    };
  }

  // Layered so the sandbox is a DERIVED default and an explicit --env still
  // wins: a user who typed BLENDER_USER_SCRIPTS themselves gets the value they
  // typed.
  const runEnv = buildRunEnvironment({ ...(blenderSandboxEnv ?? {}), ...envOverrides });

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
  //
  // --no-verify-baseline is the one way to opt out of paying for it. It does
  // NOT mean "we don't know what was already broken" - it means the user chose
  // not to look, which makes verification strict: every failure, pre-existing
  // or not, is treated as this run's. Recorded explicitly rather than by
  // leaving `baselines` empty, so classifyVerifyFailure can tell that case
  // apart from a probe that never ran.
  const baselineSkipped = Boolean(request.noVerifyBaseline);
  const shouldProbeBaselines =
    verifyCommands.length > 0 && !baselineSkipped && !(write === false && verifyAttempts === 0);
  // Only ever raised, never lowered: the generous default below is the floor
  // for the one measurement the whole attribution story rests on, and a user
  // who asked for more time for their engine's cold import meant the probe
  // too.
  const baselineTimeoutMs = Math.max(
    BASELINE_PROBE_TIMEOUT_MS,
    verifyTiming.baselineTimeoutMs ?? 0
  );
  if (baselineSkipped && verifyCommands.length > 0) {
    baselines = verifyCommands.map((command) => ({
      command,
      // null, not false: nothing was measured, so "did it pass?" has no answer.
      ok: null,
      ms: null,
      signature: [],
      rawCount: 0,
      timedOut: false,
      bufferExceeded: false,
      commandNotFound: false,
      outputFailure: false,
      baselineSkipped: true
    }));
    request.onProgress?.({
      phase: "verifying",
      message: `Verify baseline: skipped (--no-verify-baseline); every failure counts as this run's`
    });
  }

  if (shouldProbeBaselines) {
    const probeStarted = Date.now();
    // Emitted before the probe rather than after, so a run that spends fifteen
    // minutes in a cold Godot import has a log line and a phase explaining what
    // it is doing. Without this the phase column could only be guessed at by
    // pattern-matching agent-emitted "running command:" lines, and the probe
    // emits none of those - it is the bridge running the command, not the agent.
    request.onProgress?.({
      phase: "verifying",
      message: `Verify baseline: measuring ${verifyCommands.length} command${verifyCommands.length === 1 ? "" : "s"} before the agent starts`
    });
    // A generous cap, not the derived per-attempt timeout: this is the ONLY
    // chance to learn what was already broken before the agent touched
    // anything, and a cold-build ecosystem (Godot's first asset import,
    // a fresh cargo build) can legitimately take minutes. A tight cap here
    // used to discard the timeout result silently, so any command that ran
    // long got recorded as an empty baseline signature - and every one of
    // its real, pre-existing failures then looked "new" once the agent's
    // run finished, blaming it for something it never touched.
    baselines = await probeBaselines(verifyCommands, runCwd, {
      timeoutMs: baselineTimeoutMs,
      // Same environment the post-agent pass gets, for the same reason as the
      // output budget below: a baseline measured without the run's overrides
      // can be running a different binary, and every difference it then finds
      // is attributed to the agent.
      env: runEnv,
      // Must match what the post-agent pass gets: a baseline captured under a
      // tighter output budget records a shorter signature, and every failure
      // the fuller capture then finds looks new. Same reasoning for the
      // pattern sets - a baseline measured WITHOUT the exit-0 output patterns
      // would record a Godot project that was already printing SCRIPT ERROR as
      // passing, and blame the agent for it the moment the real pass ran.
      maxOutputBytes: verifyTiming.maxOutputBytes ?? undefined,
      outputFailurePatterns,
      ignorePatterns: verifyIgnorePatterns
    });
    baselineProbeMs = Date.now() - probeStarted;
    request.onProgress?.({
      phase: "verifying",
      message: `Verify baseline: measured in ${baselineProbeMs}ms (${baselines.filter((entry) => entry.ok).length}/${baselines.length} already passing)`
    });
  }

  // Snapshotted BEFORE the agent runs, and only where it is needed: an isolated
  // run gets its manifest from the commit range, which cannot contain anything
  // that was already there. Taken after the baseline probe on purpose - a verify
  // command that writes build output would otherwise show up as the agent's work.
  const dirtyBeforeRun = write && !created ? porcelainChangeEntries(runCwd) : null;
  const dirtyBeforeRunPaths = dirtyBeforeRun ? new Set(dirtyBeforeRun.keys()) : null;

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
      // The one thing that makes a delegate run return an answer rather than a
      // narration transcript. Only on the FIRST turn: a fix turn given the same
      // contract emits a report about the fix, and the newest non-empty report
      // wins below - which would discard the main run's answer, the exact bug
      // the accumulation there exists to prevent.
      rules: loadRunReportRules(),
      outputFormat: "streaming-json",
      onProgress: request.onProgress,
      // The agent runs the project's own tooling by hand as well as the bridge
      // does, so it needs the same environment - otherwise a Blender add-on
      // that verifies green from the bridge fails the moment the agent runs the
      // same command itself. undefined when there is nothing to override.
      env: runEnv,
      // Spill target for a prompt too large for argv. Anchored on the workspace
      // state dir, not runCwd: an isolated run's cwd is a throwaway worktree
      // that land or cleanup will delete out from under the record.
      promptFileDir: resolveStateDir(workspaceRoot),
      cwd: runCwd
    },
    maxDurationSeconds
  );
  let result = firstAgent.result;
  // Every agent turn this run makes, in order. `result` keeps tracking only the
  // LAST one, because status, threadId, stopReason and the stop condition all
  // belong to it - but the text channel must accumulate, which is what this is
  // for. Declared out here rather than inside the verify loop so a run with no
  // verify commands takes exactly the same path.
  const agentResults = [firstAgent.result];
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
        const { timeoutMs, source: timeoutSource } = resolveVerifyAttemptTimeout(
          baselineEntry,
          verifyTiming
        );
        // attempt is 0-based and the loop runs verifyAttempts+1 times (one
        // initial check plus that many fix-and-recheck cycles), so the number
        // a user sees is 1-based over the real total.
        request.onProgress?.({
          phase: "verifying",
          message: `Verify attempt ${attempt + 1}/${verifyAttempts + 1}: ${command}`
        });
        const commandStarted = Date.now();
        const outcome = await runVerifyCommand(command, runCwd, {
          env: runEnv,
          timeoutMs,
          maxOutputBytes: verifyTiming.maxOutputBytes ?? undefined,
          outputFailurePatterns
        });
        const commandMs = Date.now() - commandStarted;
        request.onProgress?.({
          phase: "verifying",
          message: `Verify ${outcome.ok ? "passed" : "failed"} in ${commandMs}ms: ${command}`
        });
        const summary = summarizeFailures(outcome.output, { ignorePatterns: verifyIgnorePatterns });
        const entryResult = {
          command,
          ok: outcome.ok,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
          // What this command was actually given, and whether that number was
          // asked for or measured. A run that reports "timed out" is otherwise
          // unanswerable after the fact: nothing recorded the budget.
          timeoutMs,
          timeoutSource,
          elidedBytes: Number(outcome.elidedBytes) || 0,
          // These two used to be dropped on the floor by this fixed field
          // list, so a run that only failed because the command was killed
          // for output volume, or was never runnable, looked exactly like a
          // plain non-zero exit in the persisted record.
          bufferExceeded: Boolean(outcome.bufferExceeded),
          commandNotFound: Boolean(outcome.commandNotFound),
          // Godot and Blender both exit 0 while broken, so a failure detected
          // from the OUTPUT has to survive into the record - otherwise a
          // `verified: false` on an exit-0 command is inexplicable after the
          // fact. Kept separate from `failureSource` below, which answers a
          // different question (who is to blame), not this one (how did we
          // notice).
          outputFailure: outcome.failureSource === "output-pattern",
          matchedLines: outcome.matchedLines ?? [],
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
          commandNotFound: outcome.commandNotFound,
          rawCountComparison
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

      // The one phase the log could never show before: an agent turn spent
      // fixing a verify failure looks exactly like the original turn from the
      // outside, and inferLegacyJobPhase has nothing to pattern-match on.
      request.onProgress?.({
        phase: "fixing",
        message: `Verify fix turn ${attempt + 1}/${verifyAttempts}: ${firstBlamed.command}`
      });

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
          promptFileDir: resolveStateDir(workspaceRoot),
          // Same overrides as the first turn: the fix turn re-runs the very
          // command that just failed.
          env: runEnv,
          onProgress: request.onProgress
        },
        maxDurationSeconds
      );
      result = fixAgent.result;
      agentResults.push(fixAgent.result);
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
  /** @type {{source: string, entries: string[], total: number, truncated: boolean, preexistingDirty?: number}|null} */
  let changedFiles = null;
  if (created) {
    const committed = commitWorktreeChanges(
      created.worktreePath,
      `grok-build ${request.jobId}`
    );
    // Guarded on the commit actually happening. commitWorktreeChanges returns
    // {committed:false, sha:HEAD} both when the tree was clean and when
    // everything staged was an excluded artifact, and diffing HEAD..HEAD in
    // that state would be a wasted git call - but the EMPTY manifest is still
    // the answer, and is rendered as such rather than omitted.
    if (committed.committed) {
      const listed = listCommittedChanges(created.worktreePath, created.baseSha, committed.sha);
      // A diff that failed is NOT an empty change set - reporting "none" for it
      // would claim the run produced nothing when nobody managed to look.
      changedFiles = listed.error ? null : { source: "commit", ...listed };
    } else if (!committed.error) {
      changedFiles = { source: "commit", entries: [], total: 0, truncated: false };
    }
    worktree = {
      path: created.worktreePath,
      branch: created.branchName,
      baseSha: created.baseSha,
      sha: committed.sha,
      // commitWorktreeChanges no longer throws on a git-level failure, because
      // throwing here discarded an otherwise complete run: tracked-jobs flattens
      // a thrown error to an errorMessage, losing rawOutput/threadId/usage/
      // verify.results. Carry the reason instead and let the run finish.
      commitError: committed.error ?? null,
      // The deliverable, named. For a Godot or Blender run this is the whole
      // point of the run, and the payload used to carry only a path.
      changedFiles: changedFiles?.entries ?? null,
      changedFileCount: changedFiles?.total ?? null
    };
  } else if (write) {
    changedFiles = collectWorkingTreeChanges(runCwd, dirtyBeforeRunPaths);
  }

  // The text channel is the ONE thing that accumulates across turns. `result`
  // used to be overwritten wholesale by the verify fix loop, so a fix turn that
  // ended on a tool call with no trailing prose (the common shape - the fix
  // prompt asks for an edit and a re-run, not an essay) threw away the original
  // run's answer entirely, and the user got "Grok did not return a final
  // message." for a run that did the work and passed verification.
  //
  // Newest non-empty wins per field, so a silent fix turn falls back to the main
  // run's answer while a talkative one still gets the last word.
  const newestNonEmpty = (field) =>
    agentResults
      .map((entry) => (typeof entry?.[field] === "string" ? entry[field] : ""))
      .filter(Boolean)
      .at(-1) ?? "";
  const finalReport = newestNonEmpty("finalReport");
  const lastMessage = newestNonEmpty("lastMessage");
  // Concatenated rather than picked: the transcript is the log, and every turn's
  // narration belongs in it.
  const transcript = agentResults
    .map((entry) => (typeof entry?.transcript === "string" ? entry.transcript : ""))
    .filter(Boolean)
    .join(MESSAGE_SEPARATOR);
  // The delimited report first (what the run-report contract asked for), then
  // the final assistant message, then the whole narration. The last fallback is
  // what today's behaviour was, so a model that ignores the contract still
  // prints exactly what it used to rather than nothing.
  const rawOutput = finalReport || lastMessage || transcript;
  // Diagnostics about the machinery, aggregated the pessimistic way across
  // turns: one unparseable turn means the text channel is not wholly a parsed
  // transcript, and an event type that confused any turn confused the bridge.
  const streamParsed = agentResults.every((entry) => entry?.streamParsed !== false);
  const unknownEventTypes = [
    ...new Set(agentResults.flatMap((entry) => entry?.unknownEventTypes ?? []))
  ].sort();
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
          failureMessage,
          // Only ever shown when there is no answer at all: a truncated or
          // rate-limited response exits 0 with empty text and puts the only
          // explanation on the channel that used to be dropped.
          stderr: result.stderr ?? ""
        },
        {
          title: taskMetadata.title,
          jobId: request.jobId ?? null,
          logFile,
          streamParsed,
          unknownEventTypes,
          changedFiles,
          write,
          verified,
          verifyNote,
          // The visibility half of the item-4 trust story: a run that verifies
          // commands the user never typed has to say which commands, and where
          // they came from, in the same block that reports the verdict.
          verifyCommands,
          verifyPlan,
          verifyTrustCommand: TRUST_CONFIG_COMMAND,
          baselineProbeMs,
          baselineProbeCommands: baselines.length,
          worktree,
          provision: provisionSummary,
          budgetStopped
        }
      );

  const verify = {
    commands: verifyCommands,
    // Where the command list came from - cli, the project config, an ecosystem
    // default, or nothing. Persisted because "why did this run verify that?"
    // is otherwise unanswerable after the fact.
    plan: verifyPlan,
    attempts: attempt,
    note: verifyNote,
    // The probe is now unconditional, so on a non-isolated run it doubles the
    // verify wall clock. That cost has to be visible rather than showing up as
    // an unexplained delay.
    baselineProbeMs,
    baselines,
    // Whether the user opted out of measuring the baseline at all, which is
    // what makes every recorded attribution in `results` strict rather than
    // differential.
    baselineSkipped,
    // The effective budget and where each half of it came from. `timeoutMs`
    // null means every command derived its own from its baseline, which is
    // recorded per result rather than here.
    timeouts: {
      verifyTimeoutMs: verifyTiming.timeoutMs,
      verifyTimeoutMultiplier: verifyTiming.multiplier,
      baselineTimeoutMs,
      maxOutputBytes: verifyTiming.maxOutputBytes,
      source: verifyTiming.timeoutMs != null ? "explicit" : "derived",
      sources: verifyTiming.sources
    },
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
    // The full narration across every turn, kept alongside the answer so
    // nothing is lost by rawOutput now preferring the answer. This is what a
    // caller reads when it wants to know what the agent actually did.
    transcript,
    // Scalars only. `messages` is deliberately NOT persisted: it duplicates the
    // transcript into jobs/<id>.json and pushes an unbounded array through
    // redactSecretsDeep on every terminal claim.
    finalReport,
    lastMessage,
    // Kept even on a zero exit. "Exited 0, said nothing, warned on stderr" is
    // the exact shape of a truncated response, and dropping the warning left
    // the run inexplicable.
    stderr: result.stderr ?? "",
    // Did the streaming parser understand the CLI, and what did it not
    // understand? Both were computed and had no consumer at all, so a grok
    // release that renames an event type degraded output silently.
    streamParsed,
    unknownEventTypes,
    // Where the durable copy of this run's rendered result lives.
    logFile,
    // What the run changed on disk - the deliverable itself for an engine
    // project. Null when there was nothing to measure (a read-only run) or
    // nobody could measure it (a failed commit or diff).
    changedFiles,
    verified,
    worktree,
    // Which environment variables this run imposed on the verify commands and
    // the agent, with sensitive VALUES withheld by key name. Recorded because
    // "why did this pass here and fail for me?" is otherwise unanswerable, and
    // includes anything --blender-sandbox derived.
    env: redactEnvForRecord({ ...(blenderSandboxEnv ?? {}), ...envOverrides }),
    // What the worktree was seeded with, and what could not be. Null on a
    // non-isolated run, where there is nothing to provision.
    provision: provisionSummary,
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
      // The report's own `## Result` section first - that is the run saying
      // what it did. Then lastMessage rather than rawOutput: rawOutput prefers
      // the final report, whose first line is the literal heading `## Result`,
      // and that would become the title of every compliant run in
      // /grok-build:runs. rawOutput stays as the fallback for a run that
      // produced no trailing prose at all.
      : summarizeFinalReport(finalReport) ||
        firstMeaningfulLine(
          lastMessage || rawOutput,
          firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)
        ),
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
  verifyPlan = null,
  verifyTiming = null,
  verifyAttempts = 2,
  verifyFailurePatterns = [],
  verifyIgnorePatterns = [],
  noVerifyBaseline = false,
  provisionCopy = undefined,
  blenderSandbox = false,
  env = {},
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
    // Carried through so a background run's header can say where its plan came
    // from. The commands themselves are already concrete by this point - the
    // worker resolves nothing.
    verifyPlan,
    // Same reason, with teeth: --verify-timeout that reached only the
    // foreground path would silently do nothing under --background, and
    // --background is the delegate default for exactly the long-running
    // imports the flag exists to survive.
    verifyTiming,
    verifyAttempts,
    // Raw pattern STRINGS, never compiled RegExps: this object is
    // JSON-serialized into the job file for a background run, and a RegExp
    // serializes to `{}`. executeTaskRun compiles them on the way back out.
    verifyFailurePatterns,
    verifyIgnorePatterns,
    noVerifyBaseline,
    // The Godot import-cache tier, from `provision.copy` in .grok-build.json.
    // Left undefined when the project said nothing, so planWorktreeLinks can
    // still fall back to GROK_BUILD_LINK_GODOT_CACHE.
    provisionCopy,
    // Opt-in, and only meaningful for an isolated write run.
    blenderSandbox,
    // Environment overrides, VERBATIM. This object is the detached worker's
    // input, not a report: redacting here would hand the background run a
    // literal "[redacted]" for its API token. The redacted copy is what reaches
    // the payload. It lands in the same job file the prompt already does, under
    // the plugin's state directory.
    env,
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

/**
 * Exported so a test can parse a `run` command line through the REAL option
 * table rather than a hand-copied one: a flag added here and forgotten there
 * would be silently swallowed as a positional and folded into the prompt.
 * parseCommandInput itself stays private.
 */
export const TASK_VALUE_OPTIONS = Object.freeze([
  "model",
  "effort",
  "cwd",
  "prompt-file",
  "verify",
  "verify-attempts",
  // Repeatable. A regex whose matching output lines are dropped before they
  // can count as failures at all - the escape hatch for a tool whose benign
  // chatter says "error". No ecosystem ships a preset: a wrong ignore pattern
  // hides real regressions silently, so this stays something a human types.
  "verify-ignore",
  // Seconds / seconds / megabytes, in the units a user types. The verify
  // ceiling used to be a hardcoded 15 minutes with no way to move it, which is
  // well under a cold Godot import on a large project.
  "verify-timeout",
  "baseline-timeout",
  "verify-max-buffer",
  // Repeatable KEY=VALUE. Blender has no CLI flag for "use this add-on
  // directory" - BLENDER_USER_SCRIPTS and friends are the only lever - and an
  // engine build routinely needs one or two variables set to run headless at
  // all.
  "env",
  "max-duration",
  "max-turns",
  "max-cost"
]);

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [...TASK_VALUE_OPTIONS],
    repeatableOptions: ["verify", "verify-ignore", "env"],
    booleanOptions: [
      "json",
      "write",
      "resume-last",
      "resume",
      "fresh",
      "background",
      "isolate",
      // The opt-out from an auto-resolved plan. Without it, a user in a Godot
      // or Blender repo has no way to say "run nothing" now that a plan is
      // resolved from the project rather than only from the flags they typed.
      "no-verify",
      // Skip the pre-run probe and pay nothing for it - at the cost of making
      // verification strict, since with nothing measured every failure is
      // treated as this run's.
      "no-verify-baseline",
      // Opt-in, never automatic: a private Blender scripts directory hides
      // every other add-on the user's verify script may depend on.
      "blender-sandbox",
      "no-isolate"
    ],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);

  // Resolved from the workspace root, and BEFORE any worktree exists, so that
  // buildTaskRequest serialises a concrete command list into a background
  // job's record: the detached worker resolves nothing of its own, and a
  // worktree (which has no .grok-build.json of its own until the commit lands)
  // cannot change the plan half way through.
  const { projectConfig, ecosystem, settings } = resolveProjectRunPlan(
    workspaceRoot,
    cliSettingsFromTaskOptions(options)
  );

  // normalizeReasoningEffort still runs on the CLI value first so an
  // unsupported --effort keeps failing loudly; the config's value has already
  // been validated by the schema.
  const model = options.model ? String(options.model).trim() : (settings.model ?? null);
  const effort = normalizeReasoningEffort(options.effort) ?? settings.effort ?? null;
  const isolate = resolveIsolateOption(options, write, settings.isolate);
  const verifyCommands = settings.verify;
  const verifyPlan = {
    source: settings.sources.verify,
    disabled: Boolean(settings.verifyDisabled),
    ecosystem: ecosystem?.id ?? null,
    configPresent: projectConfig.present,
    configTrusted: projectConfig.trusted,
    configWithheld: Object.keys(projectConfig.untrusted)
  };
  // Already precedence-resolved (CLI flag > .grok-build.json), in the runner's
  // units. `sources` is carried so the run record can say which layer set each
  // one - "why did this get 40 minutes?" is otherwise unanswerable.
  const verifyTiming = {
    timeoutMs: settings.verifyTimeoutMs ?? null,
    multiplier: settings.verifyTimeoutMultiplier ?? null,
    baselineTimeoutMs: settings.baselineTimeoutMs ?? null,
    maxOutputBytes: settings.verifyMaxOutputBytes ?? null,
    sources: {
      timeoutMs: settings.sources.verifyTimeoutMs ?? null,
      multiplier: settings.sources.verifyTimeoutMultiplier ?? null,
      baselineTimeoutMs: settings.sources.baselineTimeoutMs ?? null,
      maxOutputBytes: settings.sources.verifyMaxOutputBytes ?? null
    }
  };
  const verifyAttempts = resolveVerifyAttempts(settings.verifyAttempts);
  // Carried as strings and compiled inside the run - see buildTaskRequest.
  // verifyFailurePatterns has no CLI flag: it only ever EXTENDS the detected
  // ecosystem's built-in set (with, for instance, Godot's deliberately-excluded
  // bare `^ERROR:`), which is a per-project decision, not a per-invocation one.
  const verifyFailurePatterns = settings.verifyFailurePatterns ?? [];
  const verifyIgnorePatterns = settings.verifyIgnorePatterns ?? [];
  const noVerifyBaseline = Boolean(options["no-verify-baseline"]);
  // undefined, not false, when the project said nothing: planWorktreeLinks
  // falls back to GROK_BUILD_LINK_GODOT_CACHE only when the option is absent,
  // so a default of false would silently shadow the environment variable.
  const provisionCopy = settings.provision?.copy;
  const blenderSandbox = Boolean(options["blender-sandbox"]);
  // Merged key by key rather than resolved through resolveRunSettings, whose
  // precedence is whole-value: one `--env FOO=bar` would otherwise shadow the
  // project's entire env block. `settings.env` is already trust-gated - an
  // untrusted .grok-build.json cannot set PATH (or LD_PRELOAD, or NODE_OPTIONS)
  // and thereby choose which binary every verify command runs.
  const envOverrides = { ...(settings.env ?? {}), ...parseEnvAssignments(options.env) };
  const maxDurationSeconds = resolveMaxDurationSeconds(settings.maxDurationSeconds);
  const maxTurns = resolveMaxTurns(settings.maxTurns);
  const maxCostUsd = resolveMaxCostUsd(settings.maxCostUsd);
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
        verifyPlan,
        verifyTiming,
        verifyAttempts,
        verifyFailurePatterns,
        verifyIgnorePatterns,
        noVerifyBaseline,
        provisionCopy,
        blenderSandbox,
        env: envOverrides,
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
        verifyPlan,
        verifyTiming,
        verifyAttempts,
        verifyFailurePatterns,
        verifyIgnorePatterns,
        noVerifyBaseline,
        provisionCopy,
        blenderSandbox,
        env: envOverrides,
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
 * Which dirty paths the artifact-filtered dirty gate chose to overlook.
 *
 * Reported so a land that proceeds over a visibly dirty `git status` says why,
 * rather than looking like the gate silently stopped working. Costs one extra
 * git call, so callers only reach it once the filtered status came back clean.
 *
 * @param {string} repoRoot
 * @param {string[]} filteredDirtyFiles - paths the filtered status still flagged
 * @returns {string[]}
 */
function describeIgnoredDirtyArtifacts(repoRoot, filteredDirtyFiles) {
  const unfiltered = git(repoRoot, ["status", "--porcelain"]);
  if (unfiltered.status !== 0) {
    return [];
  }
  const kept = new Set(filteredDirtyFiles);
  return porcelainDirtyPaths(unfiltered.stdout).filter((entry) => !kept.has(entry));
}

/**
 * How many files in a range are binary, per git's own judgement.
 *
 * `--numstat` prints "-\t-\t<path>" for anything it will not line-count, which
 * is exactly the set that cannot be content-merged. Best-effort: a failure here
 * costs one informational line, never the land.
 *
 * @param {string} repoRoot
 * @param {string} diffRange
 * @returns {number}
 */
function countBinaryDiffFiles(repoRoot, diffRange) {
  const numstat = git(repoRoot, ["diff", "--numstat", diffRange], {
    maxBuffer: DIFF_STAT_MAX_BYTES
  });
  if (numstat.status !== 0 || numstat.error) {
    return 0;
  }
  return String(numstat.stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => /^-\t-\t/.test(line)).length;
}

/**
 * The `--preview` diff body, bounded.
 *
 * ENOBUFS is spawnSync's cliff - the process is killed and NOTHING is returned,
 * not even a truncated prefix - so an oversized diff is reported as omitted
 * rather than half-shown. That is the right trade here: a 300 KB diff is not
 * something anyone reads out of a terminal, and `diffStat` plus the exact git
 * command is strictly more useful than a truncation.
 *
 * @param {string} repoRoot
 * @param {string} diffRange
 * @returns {{diff: string|null, omitted: string|null}}
 */
function readPreviewDiff(repoRoot, diffRange) {
  const result = git(repoRoot, ["diff", diffRange], {
    // +1 so a diff of exactly the limit still fits.
    maxBuffer: PREVIEW_DIFF_MAX_BYTES + 1
  });

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return {
      diff: null,
      omitted: `(diff omitted: exceeds ${Math.round(PREVIEW_DIFF_MAX_BYTES / 1024)} KB - inspect with git diff ${diffRange})`
    };
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    // Same reasoning as the gitChecked on diffStat above: an empty stdout from
    // a failed diff is indistinguishable from a genuinely empty diff.
    throw new Error(
      `git diff ${diffRange} failed (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}`
    );
  }
  return { diff: result.stdout, omitted: null };
}

/**
 * Undo a failed squash merge and explain what to do about it.
 *
 * Binary assets conflict deterministically - there is no content merge for a
 * .blend or a .png - so any asset touched on both sides lands here every time.
 * Left alone, git has already written conflict markers into the index and the
 * working tree, and the usual escape hatch does not exist: `--squash` never
 * writes MERGE_HEAD, so `git merge --abort` exits 128 with "There is no merge
 * to abort". Never suggest it.
 *
 * `reset --hard HEAD` is safe HERE AND ONLY HERE because the dirty-tree gate
 * above already refused to run against uncommitted work. It also clears
 * SQUASH_MSG, MERGE_MSG and AUTO_MERGE on its own (verified), so nothing needs
 * to be hand-deleted from inside .git.
 *
 * @param {string} repoRoot
 * @param {string} jobId
 * @param {string} branchName
 * @param {{stdout: string, stderr: string, status: number|null}} merge
 * @returns {string} message for the thrown error
 */
function recoverFromFailedLandMerge(repoRoot, jobId, branchName, merge) {
  const combined = `${merge.stdout ?? ""}\n${merge.stderr ?? ""}`;

  // git's own words for each case. Deliberately NOT `git diff --numstat
  // --diff-filter=U`: measured, it emits "0\t0\tasset.bin" for a conflicted
  // binary, not the "-\t-\t" row, so every conflict would read as text.
  const binary = new Set(
    [...combined.matchAll(/Cannot merge binary files: (.+?) \(/g)].map((match) => match[1].trim())
  );
  const conflicted = new Set(
    [...combined.matchAll(/CONFLICT \([^)]*\): Merge conflict in (.+)/g)].map((match) =>
      match[1].trim()
    )
  );
  for (const file of binary) {
    conflicted.add(file);
  }

  const rollback = git(repoRoot, ["reset", "--hard", "HEAD"]);
  const rollbackFailed =
    rollback.status !== 0
      ? ` The rollback itself failed (${(rollback.stderr || rollback.stdout || "").trim()}); inspect the repository by hand before doing anything else.`
      : "";

  if (conflicted.size === 0) {
    // Not a conflict at all - a missing branch, a hook, an unborn HEAD. Report
    // git verbatim rather than inventing a conflict story.
    const detail = combined.trim().split(/\r?\n/).filter(Boolean).slice(0, 5).join("; ");
    return (
      `Could not squash-merge ${branchName}: ${detail || `git exited ${merge.status}`}. ` +
      `The working tree was restored to HEAD, so nothing was applied.${rollbackFailed}`
    );
  }

  const listed = [...conflicted]
    .map((file) => (binary.has(file) ? `${file} (binary - cannot be content-merged)` : file))
    .join(", ");

  return (
    `Landing ${jobId} hit merge conflicts in: ${listed}. ` +
    `The working tree was restored to HEAD, so nothing was applied and the run is still safe on ${branchName}.${rollbackFailed} ` +
    `Do NOT run git merge --abort - a squash merge writes no MERGE_HEAD, so it fails with "There is no merge to abort". ` +
    `Either drop the run with /grok-build:land ${jobId} --discard, ` +
    `or check out ${branchName} and pick a side per file with git checkout --ours/--theirs before merging by hand.`
  );
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
  const diffStat = gitChecked(repoRoot, ["diff", "--stat", diffRange], {
    maxBuffer: DIFF_STAT_MAX_BYTES
  }).stdout.trim();
  // Cheap and useful on both paths: `--stat` prints "Bin 0 -> 1234 bytes" per
  // binary file but nothing aggregate, and "did this run rewrite 40 textures?"
  // is the single most load-bearing question before landing an engine project.
  // Deliberately no cat-file/LFS size accounting: an LFS pointer's own
  // `version`/`oid`/`size` lines are already printed verbatim in the diff body.
  const totalBinaryFiles = countBinaryDiffFiles(repoRoot, diffRange);

  // Preview is read-only: show what would land without merging or removing.
  if (options.preview) {
    // Only materialised HERE. It used to be computed before this branch and
    // then thrown away on the apply path, and with no cap at all: runCommand
    // passed maxBuffer straight through, and an explicitly-undefined maxBuffer
    // disables spawnSync's own 1 MiB default rather than falling back to it.
    const { diff: diffBody, omitted: diffOmitted } = readPreviewDiff(repoRoot, diffRange);
    const payload = {
      jobId: job.id,
      action: "preview",
      worktree,
      diffStat,
      totalBinaryFiles,
      diff: diffBody,
      diffOmitted
    };
    const text =
      (diffStat ? `${diffStat}\n\n` : "No changes between base and run branch.\n\n") +
      (totalBinaryFiles > 0 ? `Total: ${totalBinaryFiles} binary file(s)\n\n` : "") +
      (diffBody ? `${diffBody.endsWith("\n") ? diffBody : `${diffBody}\n`}` : "") +
      (diffOmitted ? `${diffOmitted}\n` : "") +
      `\nPreview only for ${job.id}: nothing was merged or removed. Re-run without --preview to apply, or with --discard to drop.\n`;
    outputCommandResult(payload, text, options.json);
    return;
  }

  // The dirty gate has to consult the same artifact list as the commit path.
  // A Godot repo that does not gitignore `.godot/` is permanently `?? .godot/`
  // — and this plugin's own provisioning junction is one of the reasons it
  // gets there — so a bare `git status --porcelain` made land impossible
  // forever in the plugin's primary ecosystem.
  let dirty = git(repoRoot, ["status", "--porcelain", "--", ".", ...artifactExcludePathspecs()]);
  if (dirty.status !== 0) {
    // Mirror the worktree.mjs fallback: an ancient git that rejects pathspec
    // magic should degrade to the old behaviour, not hard-fail land.
    dirty = git(repoRoot, ["status", "--porcelain"]);
  }
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

  // Only worth a second git call once the filtered result came back clean:
  // this is the line that tells the user land proceeded despite visible dirt.
  const ignoredDirtyArtifacts = describeIgnoredDirtyArtifacts(repoRoot, dirtyFiles);

  // Unchecked on purpose: gitChecked would throw with git's raw stderr and
  // leave the repository sitting in a half-merged state with conflict markers
  // in the index, the worktree still present, and the job still unlanded - and
  // the recovery every user reaches for, `git merge --abort`, fails with
  // "There is no merge to abort" because --squash never writes MERGE_HEAD.
  const merge = git(repoRoot, ["merge", "--squash", branchName]);
  if (merge.status !== 0) {
    throw new Error(recoverFromFailedLandMerge(repoRoot, job.id, branchName, merge));
  }

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
    diffStat,
    totalBinaryFiles,
    ignoredDirtyArtifacts
  };
  const text =
    (diffStat ? `${diffStat}\n\n` : "") +
    (totalBinaryFiles > 0 ? `Total: ${totalBinaryFiles} binary file(s)\n\n` : "") +
    (ignoredDirtyArtifacts.length > 0
      ? `Ignored ${ignoredDirtyArtifacts.length} dirty generated artifact path(s) in the dirty-tree check: ${ignoredDirtyArtifacts.slice(0, 5).join(", ")}\n\n`
      : "") +
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
    case "verify-plan":
      await handleVerifyPlan(argv);
      break;
    case "trust-config":
      await handleTrustConfig(argv);
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

export {
  buildBoundedVerifyFixPrompt,
  buildDoctorReport,
  main,
  normalizeDoctorCheck,
  readStoredJobWithRetry,
  renderDoctorReport
};