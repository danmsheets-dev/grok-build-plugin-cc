#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { isHarnessLandPath, readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  describeWorktreeContext,
  ensureGitRepository,
  getCurrentBranch,
  git,
  gitChecked,
  resolveReviewTarget
} from "./lib/git.mjs";
import {
  assertModelBillingAllowed,
  buildHeadlessPermissionOptions,
  buildReviewPrompt,
  buildWorkspaceRootDenyRules,
  cliSupportsConfine,
  confineFeatureEnabled,
  DEFAULT_CONTINUE_PROMPT,
  describeMissingBinary,
  detectCliBrand,
  ensureHomeEnv,
  getGrokAuthStatus,
  getGrokAvailability,
  listGrokModels,
  normalizePathForPermissionRule,
  parseStructuredOutput,
  readOutputSchema,
  resolveGrokBinary,
  runHeadlessAgent,
  runImport,
  schemaInstructionsFromPath,
  worktreeContainsSegment
} from "./lib/grok.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  classifyJobLiveness,
  filterJobsForSession,
  getSessionRuntimeStatus,
  readStoredJob,
  reconcileAbandonedJob,
  resolveCancelableJob,
  resolveJobKindLabel,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  defaultVerifyPlan,
  detectEcosystems,
  detectPrimaryEcosystem,
  filterEcosystems,
  resolveEcosystemBinary
} from "./lib/ecosystem.mjs";
import {
  acquireGodotCacheLock,
  blenderVersionGuardNote,
  checkUidIntegrity,
  detectBlendLocks,
  parseBlenderVersionOutput,
  snapshotUidFiles
} from "./lib/engine-runtime.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import {
  describeVerifySource,
  isAutoVerifyTrusted,
  loadWorkspaceProjectConfig,
  PROJECT_CONFIG_FILENAME,
  recordProjectConfigTrust,
  resolveIsolateSetting,
  resolveRunSettings,
  revokeProjectConfigTrust
} from "./lib/project-config.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  GODOT_CACHE_DIRS,
  WORKTREE_SCRATCH_DIR,
  diffSharedFingerprints,
  ensureBlenderVerifyShim,
  fingerprintSharedDirs,
  injectRuntimePlugin,
  planBlenderScriptSandbox,
  planWorktreeLinks,
  provisionWorktree,
  shouldAutoBlenderSandbox
} from "./lib/provision.mjs";
import {
  claimJobTerminal,
  generateJobId,
  allTerminalJobStatuses,
  isTerminalJobStatus,
  listJobs,
  mergeChildEntry,
  patchJobIfActive,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  aggregateUsageOwnVsNested,
  applyChildrenToCompletionStatus,
  assertNestConcurrencyAllowed,
  assertNestDepthAllowed,
  buildChildSummary,
  childIsLandable,
  deriveSiblingWorktreePath,
  formatNestedDelegationHeaderLine,
  inheritBudget,
  listNonTerminalChildIds,
  nestedDelegationEnabled,
  parentSpentCostUsd,
  readMaxNestConcurrency,
  readMaxNestDepth,
  readNestDepth,
  readNestDrainSeconds,
  remainingDurationSeconds,
  resolveBridgeScriptPath,
  resolveMcpScriptPath,
  upsertChildEntry,
  writeRuntimeMcpJson,
  NEST_DEPTH_ENV,
  PARENT_RUN_ID_ENV
} from "./lib/nest.mjs";
import { redactSecrets, redactSecretsDeep } from "./lib/redact.mjs";
import { addUsage, MESSAGE_SEPARATOR } from "./lib/stream-events.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  decideCompletionStatus,
  formatRunLogHeader,
  nowIso,
  resolveJobKillTargets,
  resolveJobTreeKillTargets,
  collectJobTreeLeafFirst,
  claimJobTreeDescendantsCancelled,
  runTrackedJob,
  SESSION_ID_ENV,
  writeRunLogHeader
} from "./lib/tracked-jobs.mjs";
import {
  classifyVerifyFailure,
  compileUserPatterns,
  deriveVerifyTimeoutMs,
  dropBaselineFailingAutoCommands,
  probeBaselines,
  resolveOutputFailurePatterns,
  resolveVerifyMaxBufferBytes,
  resolveVerifyTimeoutMs,
  runVerifyCommand,
  summarizeFailures
} from "./lib/verify.mjs";
import { allowNoIsolateFromEnv, detectCaller, resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  artifactExcludePathspecs,
  capChangedFiles,
  commitWorktreeChanges,
  createWorktree,
  isDebrisPath,
  isGeneratedArtifactPath,
  listCommittedChanges,
  partitionWorkAndDebris,
  reconcileOrphanWorktrees,
  removeWorktree,
  resolveWorktreeRoot
} from "./lib/worktree.mjs";
import {
  buildRunManifest,
  buildSessionTotalsByModel,
  buildTaskStatusLines,
  formatUsageLine,
  renderCancelReport,
  renderJobStatusReport,
  renderNativeReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  summarizeSessionUsage
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
// Measured in Hyper (crates/codegen/xai-grok-sampling-types): the real ladder is
// none · minimal · low · medium (default) · high · xhigh · max · ultra.
// The CLI flag is an unvalidated Option<String>, so the bridge must not be the
// authority that refuses a new tier — a plugin release must not be required
// when Hyper adds one. Known values pass cleanly; unknown values warn and pass
// through (HYPER-2).
export const KNOWN_REASONING_EFFORTS = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);
const KNOWN_REASONING_EFFORT_SET = new Set(KNOWN_REASONING_EFFORTS);

/** Default when the user / config does not pick a model. */
export const DEFAULT_MODEL = "grok-4.6";
/** Extra-high reasoning — the Turbo UI "Extra High Effort" tier. */
export const DEFAULT_EFFORT = "xhigh";
export const EFFORT_FLAG_HELP = "<none|minimal|low|medium|high|xhigh|max|ultra>";

export function resolveModelChoice(explicit, configured = null) {
  const fromFlag =
    explicit != null && String(explicit).trim() !== "" ? String(explicit).trim() : null;
  const fromConfig =
    configured != null && String(configured).trim() !== "" ? String(configured).trim() : null;
  return fromFlag ?? fromConfig ?? DEFAULT_MODEL;
}

export function resolveEffortChoice(explicit, configured = null) {
  const effortNorm = normalizeReasoningEffort(explicit ?? configured ?? DEFAULT_EFFORT);
  if (effortNorm.warning) {
    process.stderr.write(`[turbo-build] ${effortNorm.warning}\n`);
  }
  return effortNorm.value ?? DEFAULT_EFFORT;
}

// Floor for the implausible-duration signal on write runs (BRIDGE-1 bonus).
// Overridable via GROK_BUILD_MIN_PLAUSIBLE_WRITE_SECONDS. Signal only — never
// invents a new terminal status.
const DEFAULT_MIN_PLAUSIBLE_WRITE_SECONDS = 90;

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
// not less. completed-truncated / completed-blind may also hold partial work.
// completed-noop is included so an empty isolated worktree is still cleaned
// only by explicit land --discard / prune --include-unlanded, not by accident.
// Verify-shaping flags a NESTED agent may never set. Kept as one list so a new
// flag cannot be added to the CLI and silently miss the guard, which is how
// --verify-ignore stayed open after --verify and --no-verify were closed.
const AGENT_FORBIDDEN_VERIFY_FLAGS = Object.freeze([
  "verify",
  "no-verify",
  "verify-ignore",
  "verify-attempts",
  "no-verify-baseline"
]);

const AWAITING_LAND_STATUSES = new Set([
  "completed",
  "completed-unverified",
  "completed-truncated",
  "completed-noop",
  "completed-blind",
  // A parent whose nested child failed still holds its OWN committed work on
  // its branch. Omitting it here made prune report "nothing awaiting land" and
  // then delete that work — the false all-clear was the dangerous half.
  "completed-with-failed-children",
  "timed-out"
]);

// Broader set used by prune/doctor: cancelled/failed/isolation-breached runs
// routinely hold uncommitted or committed work (stop mid-run, isolation
// leak after a successful commit). Content checks (dirty worktree, unmerged
// commits, unknown git) are the primary gate; these statuses stop doctor
// from recommending prune --apply as the "stale worktree" fix.
// Derived, not hand-listed: every terminal status is protected unless it is
// explicitly named safe to discard. A new status added to state.mjs is then
// protected by default, and the burden falls on the person who wants it
// deletable. The previous hand-written list is what let
// `completed-with-failed-children` fall through to `--apply`.
const SAFE_TO_DISCARD_STATUSES = new Set([]);

const PROTECTED_WORKTREE_STATUSES = new Set(
  allTerminalJobStatuses().filter((status) => !SAFE_TO_DISCARD_STATUSES.has(status))
);

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-bridge.mjs check [--json]",
      "  node scripts/grok-bridge.mjs doctor [--json]",
      "  node scripts/grok-bridge.mjs models [--json]",
      "  node scripts/grok-bridge.mjs verify-plan [--verify <command>]... [--no-verify] [--cwd|-C <dir>] [--json]",
      "  node scripts/grok-bridge.mjs trust-config [--revoke] [--cwd|-C <dir>] [--json]",
      "  node scripts/grok-bridge.mjs prune [--apply] [--include-unlanded] [--json]",
      "  node scripts/grok-bridge.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]",
      "  node scripts/grok-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [focus text]",
      "  node scripts/grok-bridge.mjs run [--background] [--write] [--isolate|--no-isolate] [--resume-last|--resume|--fresh]",
      "      [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--caller <id>]",
      "      [--verify <command>]... [--verify-attempts <n>] [--verify-timeout <seconds>] [--baseline-timeout <seconds>]",
      "      [--verify-max-buffer <megabytes>] [--verify-ignore <regex>]... [--no-verify] [--no-verify-baseline]",
      "      [--env KEY=VALUE]... [--blender-sandbox|--no-blender-sandbox] [--godot-export-smoke]",
      "      [--max-duration <seconds>] [--max-turns <n>] [--max-cost <usd>]",
      "      [--allowed-paths <repo-relative-prefix>]...",
      "      [--prompt-file <path>] [--cwd|-C <dir>] [--json] [prompt]",
      "    Verify commands run in THE BRIDGE, never the agent, so a run cannot claim success without",
      "    having passed. A run whose verification never passes is reported completed-unverified, never",
      "    as success. See `verify-plan` to preview the resolved plan without running it.",
      "    Pay-per-token models (openai/*) require GROK_BUILD_ALLOW_PAY_PER_TOKEN=1.",
      "  node scripts/grok-bridge.mjs nest-run [--background] [--write] [--prompt-file <path>]",
      "      [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [--verify <command>]... [--no-verify]",
      "      [--max-duration <seconds>] [--max-turns <n>] [--max-cost <usd>] [--json] [prompt]",
      "    Nested Hyper-to-Hyper delegation: always isolated, sibling worktree, depth/fan-out bounded.",
      "    Refuses --no-isolate. Intended for the runtime MCP server (delegate_run), not humans.",
      "  node scripts/grok-bridge.mjs import [--source <claude-jsonl>] [--json]",
      "  node scripts/grok-bridge.mjs runs [run-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
      "  node scripts/grok-bridge.mjs show [run-id] [--json]",
      "  node scripts/grok-bridge.mjs wait <run-id> [--timeout <seconds>] [--json]",
      "  node scripts/grok-bridge.mjs stop [run-id] [--json]",
      "  node scripts/grok-bridge.mjs land [run-id] [--preview|--discard] [--force] [--json]",
      "",
      "Every subcommand accepts --help / -h for its own usage."
    ].join("\n")
  );
}

const SUBCOMMAND_HELP = {
  check: ["Usage: node scripts/grok-bridge.mjs check [--json]", "Probe Node + CLI availability and auth."],
  doctor: ["Usage: node scripts/grok-bridge.mjs doctor [--json]", "Deeper diagnostics (HOME, state, stale runs)."],
  models: [
    "Usage: node scripts/grok-bridge.mjs models [--json]",
    "List models from the configured CLI. Hyper may exit non-zero on a successful listing;",
    "output that names models is treated as success. Billing routes are inferred from id prefix."
  ],
  "verify-plan": [
    "Usage: node scripts/grok-bridge.mjs verify-plan [--verify <command>]... [--no-verify] [--cwd|-C <dir>] [--json]",
    "Print the resolved verify plan without running anything."
  ],
  "trust-config": [
    "Usage: node scripts/grok-bridge.mjs trust-config [--revoke] [--cwd|-C <dir>] [--json]",
    "Trust or revoke .grok-build.json executable keys for this workspace."
  ],
  prune: [
    "Usage: node scripts/grok-bridge.mjs prune [--apply] [--include-unlanded] [--json]",
    "Reap abandoned runs and finished worktrees."
  ],
  review: [
    "Usage: node scripts/grok-bridge.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>]",
    "Read-only review of local git state. Defaults: --model grok-4.6 --effort xhigh."
  ],
  critique: [
    "Usage: node scripts/grok-bridge.mjs critique [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <none|minimal|low|medium|high|xhigh|max|ultra>] [focus text]",
    "Structured design/risk critique."
  ],
  run: [
    "Usage: node scripts/grok-bridge.mjs run [options] [prompt]",
    "Delegate a task. Default is read-only; pass --write to allow edits.",
    "Defaults: --model grok-4.6 --effort xhigh.",
    "See `node scripts/grok-bridge.mjs help` for the full flag list."
  ],
  "nest-run": [
    "Usage: node scripts/grok-bridge.mjs nest-run [options] [prompt]",
    "Nested Hyper run for agent-to-agent delegation. Always isolated; --no-isolate is refused.",
    "Depth/fan-out bounded by GROK_BUILD_MAX_NEST_DEPTH / GROK_BUILD_MAX_NEST_CONCURRENCY."
  ],
  import: ["Usage: node scripts/grok-bridge.mjs import [--source <claude-jsonl>] [--json]"],
  runs: [
    "Usage: node scripts/grok-bridge.mjs runs [run-id] [--all] [--wait] [--timeout-ms <ms>] [--json]",
    "`runs --json` emits schemaVersion 2 (with legacy running/latestFinished/recent keys for one minor version)."
  ],
  show: ["Usage: node scripts/grok-bridge.mjs show [run-id] [--json]", "Print a finished run's result plus a BRIDGE-RESULT trailer."],
  stop: ["Usage: node scripts/grok-bridge.mjs stop [run-id] [--json]"],
  wait: [
    "Usage: node scripts/grok-bridge.mjs wait <run-id> [--timeout <seconds>] [--timeout-ms <ms>] [--json]",
    "Block until the run is terminal (or the timeout), then print the same result as show."
  ],
  land: [
    "Usage: node scripts/grok-bridge.mjs land [run-id] [--preview|--discard] [--force] [--into-run <parent-id>] [--json]",
    "Squash-merge a run's branch. --into-run lands a nested child into the parent's worktree. --force bypasses the 50-file safety cap."
  ]
};

function printSubcommandHelp(subcommand) {
  const lines = SUBCOMMAND_HELP[subcommand];
  if (lines) {
    console.log(lines.join("\n"));
    return;
  }
  printUsage();
}

function wantsHelp(argv) {
  return argv.some((token) => token === "--help" || token === "-h");
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
 * agents/turbo-delegate.md and the delegate skill state that twice, for
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
  // Full multi-ecosystem detection, optionally narrowed by non-executable
  // `ecosystems: ["python","node"]` in .grok-build.json.
  const detected = detectEcosystems(workspaceRoot);
  const ecosystems = filterEcosystems(detected, projectConfig.config.ecosystems);
  const ecosystem = ecosystems[0] ?? null;
  // tools.* is an executable key, so it only reaches this call at all when the
  // config file is trusted; loadWorkspaceProjectConfig has already withheld it
  // otherwise. Per-id overrides are applied inside defaultVerifyPlan.
  const toolOverrides = projectConfig.config.tools ?? {};
  const exportSmoke = Boolean(cli.exportSmoke ?? projectConfig.config.exportSmoke);
  const ecosystemVerify = defaultVerifyPlan(ecosystems, {
    toolOverrides,
    exportSmoke
  });

  const settings = resolveRunSettings({
    cli,
    config: projectConfig.config,
    ecosystemDefaults: { verify: ecosystemVerify }
  });
  const autoVerify = settings.sources.verify === "ecosystem-default" && settings.verify.length > 0;
  const autoVerifyTrusted = !autoVerify || isAutoVerifyTrusted(workspaceRoot, settings.verify);

  return {
    projectConfig,
    ecosystem,
    ecosystems,
    settings,
    exportSmoke,
    autoVerify,
    autoVerifyTrusted,
    autoVerifyCommands: ecosystemVerify
  };
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
 *
 * Matched anywhere in the key (delimited by `_` or a string boundary), not
 * just as a suffix: `KEYSTORE_PASS`, `STEAM_PASS`, `SECRET_KEY_BASE`, and
 * `SIGNING_KEY_ALIAS` are exactly the Android/Steam signing vocabulary that
 * is --env's headline Godot use case, and a suffix-only match misses all four.
 * `url` is deliberately left out - it would redact ordinary non-secret URLs.
 */
const SENSITIVE_ENV_KEY_PATTERN = /(^|_)(token|secret|key|pass|passwd|password|passphrase|credential|cred|pat|dsn|auth)(_|$)/i;

/**
 * The override map as it is safe to persist and show: keys verbatim, sensitive
 * values replaced. Which variables a run set is diagnostic information; their
 * values are the user's secrets.
 *
 * @param {Record<string, string>} overrides
 */
export function redactEnvForRecord(overrides) {
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
function buildVerifyPlanPayload({
  projectConfig,
  ecosystem,
  ecosystems,
  settings,
  autoVerify = false,
  autoVerifyTrusted = true
}) {
  const ecosystemList = Array.isArray(ecosystems) ? ecosystems : ecosystem ? [ecosystem] : [];
  return {
    ecosystem: ecosystem
      ? {
          id: ecosystem.id,
          major: ecosystem.major ?? null,
          testRunner: ecosystem.testRunner ?? null,
          projectDir: ecosystem.projectDir ?? "."
        }
      : null,
    // Full multi-ecosystem set that contributed to the default plan.
    ecosystems: ecosystemList.map((entry) => ({
      id: entry.id,
      projectDir: entry.projectDir ?? ".",
      major: entry.major ?? null,
      framework: entry.framework ?? null,
      packageManager: entry.packageManager ?? null
    })),
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
    trustCommand:
      Object.keys(projectConfig.untrusted).length > 0 || (autoVerify && !autoVerifyTrusted)
        ? TRUST_CONFIG_COMMAND
        : null,
    autoVerify,
    autoVerifyTrusted,
    autoVerifyWithheld: autoVerify && !autoVerifyTrusted
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
  // Same reasoning as resolveMaxDurationSeconds: `--max-cost 5usd` must not
  // silently mean "no spend ceiling".
  throw new Error(
    `Invalid --max-cost ${JSON.stringify(String(raw))}: expected a positive number of USD ` +
      "(e.g. --max-cost 5). Currency suffixes are not supported."
  );
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
  // `--max-duration 30m` is NaN. Returning null there disarmed the wall-clock
  // cap entirely, with no warning and no budget line in the header — the exact
  // opposite of what the user asked for. --env already throws on a malformed
  // value in this same file; do the same here.
  throw new Error(
    `Invalid --max-duration ${JSON.stringify(String(raw))}: expected a whole number of seconds ` +
      "(e.g. --max-duration 1800). Units are not supported."
  );
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
 * C23: if agentPid never arrives, still attempts terminate via bridge/worker
 * pid hooks when provided (testOptions.getFallbackPids) or a late agentPid
 * from the settled result.
 */
export async function runHeadlessAgentWithDurationBudget(
  runCwd,
  agentOptions,
  maxDurationSeconds,
  testOptions = {}
) {
  let agentPid = null;
  const originalOnProgress = agentOptions.onProgress;
  const runAgent = testOptions.runAgentImpl ?? runHeadlessAgent;
  const terminate = testOptions.terminateProcessTreeImpl ?? terminateProcessTree;
  const terminationGraceMs = Number.isFinite(Number(testOptions.terminationGraceMs))
    ? Math.max(0, Number(testOptions.terminationGraceMs))
    : 2000;
  const getFallbackPids =
    typeof testOptions.getFallbackPids === "function" ? testOptions.getFallbackPids : null;
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
    const result = await runAgent(runCwd, wrappedOptions);
    return { result, timedOut: false, termination: null };
  }

  const agentPromise = runAgent(runCwd, wrappedOptions);
  let timer = null;
  let termination = { attempted: false, delivered: false, method: null, killTargets: [] };
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      const targets = [];
      if (agentPid != null) {
        targets.push(agentPid);
      }
      // C23: progress may not have carried agentPid yet (race before first
      // emit). Optional fallbacks: bridge worker pid, job record, etc.
      //
      // Only when we have NOTHING else. This block used to run unconditionally,
      // and the fallbacks include the runner's OWN pid (tracked-jobs records
      // bridgePid/pid as process.pid) — so a --max-duration timeout killed the
      // agent and then TerminateProcess'd the bridge mid-handler: no timed-out
      // result, no partial transcript, no commit, no terminal claim. The work
      // sat uncommitted at HEAD == baseSha and land refused it.
      if (targets.length === 0 && getFallbackPids) {
        try {
          for (const pid of getFallbackPids() ?? []) {
            const n = Number(pid);
            if (Number.isFinite(n) && n > 0 && n !== process.pid && !targets.includes(n)) {
              targets.push(n);
            }
          }
        } catch {
          // ignore fallback errors
        }
      }
      // Belt and braces: never terminate ourselves, whatever the source.
      for (let i = targets.length - 1; i >= 0; i -= 1) {
        if (targets[i] === process.pid) {
          targets.splice(i, 1);
        }
      }
      if (targets.length === 0) {
        termination = {
          attempted: false,
          delivered: false,
          method: null,
          killTargets: [],
          reason: "no-agent-pid"
        };
        resolve({ timedOut: true });
        return;
      }
      const results = [];
      let anyDelivered = false;
      for (const pid of targets) {
        try {
          const outcome = terminate(pid) ?? { attempted: true, delivered: false };
          results.push({ pid, ...outcome });
          if (outcome.delivered) {
            anyDelivered = true;
          }
        } catch {
          results.push({ pid, attempted: true, delivered: false });
        }
      }
      termination = {
        attempted: true,
        delivered: anyDelivered,
        method: results.map((r) => r.method).filter(Boolean).join("+") || null,
        killTargets: targets,
        results
      };
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
    // Late agentPid on the promise result: try one more kill if we never fired.
    if ((!termination.attempted || termination.reason === "no-agent-pid") && agentPid == null) {
      try {
        const early = await Promise.race([
          agentPromise.then((r) => r, () => null),
          sleep(50).then(() => null)
        ]);
        const latePid = Number(early?.agentPid);
        if (Number.isFinite(latePid) && latePid > 0) {
          agentPid = latePid;
          try {
            termination = {
              ...(terminate(latePid) ?? { attempted: true, delivered: false }),
              killTargets: [latePid]
            };
          } catch {
            termination = { attempted: true, delivered: false, killTargets: [latePid] };
          }
        }
      } catch {
        // ignore
      }
    }
    // C15: prefer partial stream from the agent promise. Give a longer secondary
    // wait when the kill was not confirmed delivered — inventing an empty shell
    // discards work already parsed on stdout. Keep short graces short so unit
    // tests (and intentional tight budgets) do not stall for 5s.
    const secondaryGraceMs = termination.delivered
      ? terminationGraceMs
      : terminationGraceMs >= 1000
        ? Math.max(terminationGraceMs, 5000)
        : terminationGraceMs;
    let afterKill = await Promise.race([
      agentPromise.then((result) => ({ result, settled: true }), () => ({ settled: true })),
      sleep(secondaryGraceMs).then(() => ({ settled: false }))
    ]);
    if (!afterKill.settled) {
      // One last short wait for a late close after taskkill.
      afterKill = await Promise.race([
        agentPromise.then((result) => ({ result, settled: true }), () => ({ settled: true })),
        sleep(Math.min(2000, secondaryGraceMs)).then(() => ({ settled: false }))
      ]);
    }
    const treeOutlivedKill =
      !termination.attempted ||
      termination.delivered === false ||
      afterKill.settled === false;
    let result = afterKill.settled && afterKill.result ? afterKill.result : null;
    if (!result) {
      result = {
        status: 1,
        stdout: "",
        stderr: "Run exceeded --max-duration.",
        threadId: null,
        sessionId: null,
        agentPid,
        finalMessage: "",
        usage: null,
        stopReason: "max-duration",
        toolVisibility: "unavailable",
        partialTimeout: true
      };
    } else {
      // Keep partial transcript/usage; mark timeout on top (C15).
      result = {
        ...result,
        stopReason: result.stopReason ?? "max-duration",
        partialTimeout: true
      };
    }
    const survivalNote = treeOutlivedKill
      ? " The agent process tree could not be terminated and may still be running."
      : "";
    return {
      result: {
        ...result,
        status: 1,
        stderr: `${result.stderr ?? ""}${result.stderr ? "\n" : ""}Run exceeded --max-duration.${survivalNote}`.trim()
      },
      timedOut: true,
      termination: { ...termination, treeOutlivedKill }
    };
  }

  return { result: raced.result, timedOut: false, termination: null };
}

// configIsolate is the project config's `isolate`, and sits between the two
// explicit flags and the write-implies-isolate default. For a human at a
// terminal, --no-isolate stays an absolute override. For a programmatic write
// caller, isolation is forced and --no-isolate is refused (see
// resolveIsolateSetting).
function resolveIsolateOption(options, write, configIsolate = undefined, extras = {}) {
  return resolveIsolateSetting({
    cliIsolate: Boolean(options.isolate),
    cliNoIsolate: Boolean(options["no-isolate"]),
    configIsolate,
    write,
    programmatic: Boolean(extras.programmatic),
    allowNoIsolate: Boolean(extras.allowNoIsolate)
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

function buildBoundedVerifyFixPrompt(command, output, options = {}) {
  // Verify stdout/stderr can echo real secrets (env dumps, config prints). Scrub
  // before embedding in the next model prompt so a leaked key is not re-sent.
  // Redact BEFORE truncating: truncating first would leave a secret that happens
  // to sit in the discarded head unredacted in the persisted capture, and could
  // split a token so the redactor no longer recognizes it.
  const safeOutput = tailBytesOf(
    redactSecretsDeep(output == null ? "" : String(output)),
    VERIFY_FIX_OUTPUT_TAIL_BYTES
  );

  const matchedLines = Array.isArray(options.matchedLines) ? options.matchedLines : [];
  if (options.outputFailure && matchedLines.length > 0) {
    // Godot and Blender both exit 0 on a broken project, so "exit_code: 0" in
    // the Output block below reads as a pass unless the prompt says
    // otherwise. The matched marker line(s) - the ONLY evidence this command
    // actually failed - go ABOVE the tail-truncated output rather than relying
    // on them surviving inside it: a Godot import prints its SCRIPT ERROR
    // early and then hundreds of `Import: res://...` lines, which is exactly
    // what pushes the real failure out of a tail-only capture. The generic
    // "re-run until it passes" instruction is also wrong here - the command
    // already exits 0 every time, so that sentence is not swapped in.
    const safeMatchedLines = matchedLines.map((line) => redactSecretsDeep(String(line ?? "")));
    return (
      `The verify command \`${command}\` exited 0, but it is treated as FAILED because its output matched a known ` +
      `engine failure marker:\n${safeMatchedLines.map((line) => `  ${line}`).join("\n")}\n\n` +
      `Exit status alone does not mean it passed. Fix the underlying cause so that marker no longer appears - do not ` +
      `just make this command exit non-zero or otherwise game its exit code. Do not investigate unrelated failures, ` +
      `do not run the full test suite, and do not change any test to make it pass.\n\n` +
      `Output:\n${safeOutput}`
    );
  }

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
// /turbo-build-plugin:runs and /turbo-build-plugin:show - contract text pasted there would
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

// Isolation preamble: only for isolated runs, and short — it counts against
// the argv budget on the Windows cmd-shim path. Placeholders are absolute
// paths so the agent does not have to guess which tree is writable.
let isolationRulesCache = null;
function loadIsolationRulesTemplate() {
  if (isolationRulesCache == null) {
    isolationRulesCache = loadPromptTemplate(ROOT_DIR, "isolation").trim();
  }
  return isolationRulesCache;
}

// Headless discipline (HYPER-1): every bridge run is non-interactive. Keep this
// short — it costs argv budget on the Windows cmd-shim path.
let headlessRulesCache = null;
function loadHeadlessRules() {
  if (headlessRulesCache == null) {
    headlessRulesCache = loadPromptTemplate(ROOT_DIR, "headless").trim();
  }
  return headlessRulesCache;
}

// Blender sandbox facts for the agent (module name, env paths). Only composed
// when a sandbox was actually provisioned for this run.
let blenderRulesCache = null;
function loadBlenderRulesTemplate() {
  if (blenderRulesCache == null) {
    try {
      blenderRulesCache = loadPromptTemplate(ROOT_DIR, "blender").trim();
    } catch {
      blenderRulesCache = "";
    }
  }
  return blenderRulesCache;
}

/**
 * System-prompt rules for a run. Always includes the final-report contract and
 * the headless non-interactive rule; isolated runs also get the isolation
 * preamble naming the only writable root. Blender sandbox runs get the
 * concrete module name and BLENDER_USER_* paths so the agent does not guess.
 *
 * @param {{
 *   isolated?: boolean,
 *   worktreePath?: string|null,
 *   workspaceRoot?: string|null,
 *   blenderSandbox?: Record<string, string|boolean|null>|null
 * }} [options]
 * @returns {string}
 */
function loadRunRules(options = {}) {
  const parts = [loadRunReportRules(), loadHeadlessRules()];
  if (options.isolated && options.worktreePath && options.workspaceRoot) {
    parts.push(
      interpolateTemplate(loadIsolationRulesTemplate(), {
        WORKTREE_PATH: String(options.worktreePath),
        WORKSPACE_ROOT: String(options.workspaceRoot)
      })
    );
  }
  if (options.blenderSandbox && typeof options.blenderSandbox === "object") {
    const tpl = loadBlenderRulesTemplate();
    if (tpl) {
      const bs = options.blenderSandbox;
      parts.push(
        interpolateTemplate(tpl, {
          MODULE_NAME: String(bs.moduleName ?? ""),
          ADDON_NAME: String(bs.addonName ?? ""),
          IS_EXTENSION: bs.isExtension ? "yes (4.2+ extension)" : "no (legacy bl_info add-on)",
          BLENDER_USER_SCRIPTS: String(bs.scriptsDir ?? ""),
          BLENDER_USER_EXTENSIONS: String(bs.extensionsDir ?? ""),
          BLENDER_VERSION_MIN: String(bs.blenderVersionMin ?? "unspecified"),
          HAS_WHEELS: bs.hasWheels ? "yes (not auto-installed by the sandbox)" : "no"
        })
      );
    }
  }
  return parts.join("\n\n");
}

/**
 * Progress/log line for isolation state at run start.
 * WP-P1 owns the surrounding header lines (CLI, model, verify plan); this
 * emits only the isolation line so the two branches do not collide.
 *
 * @param {{ active: boolean, worktreePath?: string|null, branch?: string|null, baseSha?: string|null, workspaceRoot?: string|null, source?: string|null }} info
 * @returns {string}
 */
function formatIsolationHeaderLine(info = {}) {
  const source = info.source ? ` [${info.source}]` : "";
  if (info.active) {
    const base = String(info.baseSha ?? "").slice(0, 7);
    return `Isolation: ACTIVE (worktree ${info.worktreePath}, branch ${info.branch}, base ${base})${source}`;
  }
  return `Isolation: INACTIVE (writing directly to ${info.workspaceRoot})${source}`;
}

/**
 * Reconcile abandoned active jobs in this workspace so status stops lying.
 * Called from runs/show/stop/prune/wait before they report.
 */
/**
 * Tail of a background worker's crash stream, or null when it wrote nothing.
 *
 * Bounded: a worker that died screaming can have produced a lot of stderr, and
 * this text is inlined into `runs` output. The tail is the part that carries
 * the actual error - a stack's most specific frame is at the top, but the
 * message that matters is at the end of the stream.
 */
export function readWorkerCrashDetail(workspaceRoot, jobId, options = {}) {
  const maxChars = Number.isFinite(Number(options.maxChars)) ? Number(options.maxChars) : 1200;
  let text = "";
  try {
    text = fs.readFileSync(resolveWorkerCrashLog(workspaceRoot, jobId), "utf8");
  } catch {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > maxChars ? `…${trimmed.slice(-maxChars)}` : trimmed;
}

function reconcileAbandonedInWorkspace(workspaceRoot, options = {}) {
  const jobs = listJobs(workspaceRoot);
  const results = [];
  for (const job of jobs) {
    const result = reconcileAbandonedJob(workspaceRoot, job, {
      claimImpl: claimJobTerminal,
      killImpl: options.killImpl,
      graceMs: options.graceMs,
      now: options.now,
      resolveCrashDetail: readWorkerCrashDetail
    });
    if (result) {
      results.push(result);
    }
  }
  return results;
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

/**
 * Normalise a reasoning-effort flag.
 *
 * Accepts the full Hyper ladder. Values outside it warn and pass through
 * rather than refusing — the CLI is the authority on what it accepts
 * (HYPER-2). Returns `{ value, warning }` so callers can log once.
 *
 * @param {string|null|undefined} effort
 * @param {{ supportedEfforts?: string[]|null }} [options]
 * @returns {{ value: string|null, warning: string|null }}
 */
export function normalizeReasoningEffort(effort, options = {}) {
  if (effort == null) {
    return { value: null, warning: null };
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return { value: null, warning: null };
  }
  let warning = null;
  if (!KNOWN_REASONING_EFFORT_SET.has(normalized)) {
    // Pass through: a new Hyper tier must not require a plugin release.
    warning =
      `Unknown reasoning effort "${effort}" (known: ${KNOWN_REASONING_EFFORTS.join(", ")}). ` +
      `Passing through to the CLI, which is the authority on accepted values.`;
  }
  const supported = options.supportedEfforts;
  if (Array.isArray(supported) && supported.length > 0) {
    const allowed = new Set(supported.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean));
    if (allowed.size > 0 && !allowed.has(normalized)) {
      const mismatch =
        `Reasoning effort "${normalized}" is not in this model's reported support ` +
        `(${[...allowed].join(", ")}). Passing through anyway — never hard-fail on the plugin's opinion.`;
      warning = warning ? `${warning} ${mismatch}` : mismatch;
    }
  }
  return { value: normalized, warning };
}

/**
 * True when the final assistant message looks like a question to the user.
 * HYPER-1: a headless --background run that ends on "Would you like X?" is a
 * failed turn — nobody will answer.
 *
 * @param {string|null|undefined} message
 * @returns {boolean}
 */
export function looksLikeUserQuestion(message) {
  const text = String(message ?? "").trim();
  if (!text) {
    return false;
  }
  // Prefer the trailing prose: long reports can mention "?" mid-body.
  const tail = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-6)
    .join(" ");
  if (/\?\s*$/.test(tail)) {
    return true;
  }
  return /\b(would you like|do you want|should i|shall i|can you confirm|want me to|please confirm|is that ok|is that okay|which (?:one|option) do you|how would you like)\b/i.test(
    tail
  );
}

/**
 * Did the brief itself tell the agent not to change anything?
 *
 * A write run is the only way to ask for an isolated worktree, so operators
 * routinely use `--write` for read-only work - a smoke test, an audit, "list
 * the files matching X and do not edit anything". Such a run changing zero
 * files is the REQUESTED outcome, and flagging it as implausible taught
 * supervisors to distrust the signal on the runs where it matters.
 *
 * Deliberately narrow: it matches explicit prohibitions, not any mention of
 * reading. A brief that says "read the parser, then fix the bug" must still be
 * held to producing an edit.
 *
 * @param {string|null|undefined} prompt
 * @returns {boolean}
 */
export function promptForbidsEdits(prompt) {
  const text = String(prompt ?? "");
  if (!text.trim()) {
    return false;
  }
  // The verb list carries its inflections explicitly ("without editing", "do
  // not modify"), because the prohibition is as often a gerund as an infinitive.
  const verb =
    "(?:edit|edits|editing|modify|modifies|modifying|change|changes|changing|write|writes|writing|touch|touches|touching|alter|alters|altering)";
  return new RegExp(
    `\\b(?:do not|do n't|don't|dont|never|without|refrain from|avoid)\\s+(?:any\\s+)?${verb}\\b` +
      "|\\bno\\s+(?:edits|changes|modifications|file changes)\\b" +
      "|\\bread[- ]only\\b" +
      "|\\bmake no changes\\b",
    "i"
  ).test(text);
}

/**
 * Cheap plausibility signal for write runs that finished impossibly fast with
 * no work (BRIDGE-1 bonus). Signal only — does not invent a terminal status.
 *
 * @param {{
 *   write?: boolean,
 *   durationMs?: number|null,
 *   changedFileCount?: number|null,
 *   toolCallCount?: number|null,
 *   promptForbidsEdits?: boolean,
 *   env?: NodeJS.ProcessEnv
 * }} input
 * @returns {boolean}
 */
export function detectImplausiblyShort(input = {}) {
  if (!input.write) {
    return false;
  }
  // The brief asked for no edits and got none. That is the run succeeding.
  if (input.promptForbidsEdits) {
    return false;
  }
  const env = input.env ?? process.env;
  const floorSec = Number(env.GROK_BUILD_MIN_PLAUSIBLE_WRITE_SECONDS);
  const floorMs =
    (Number.isFinite(floorSec) && floorSec > 0 ? floorSec : DEFAULT_MIN_PLAUSIBLE_WRITE_SECONDS) * 1000;
  const durationMs = Number(input.durationMs);
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs >= floorMs) {
    return false;
  }
  const changed = input.changedFileCount;
  if (changed != null && Number(changed) > 0) {
    return false;
  }
  // Few or no tool calls. null (unknown) still flags when the write finished
  // empty under the floor — that is the blind-hero-kit field case.
  const tools = input.toolCallCount;
  if (tools != null && Number.isFinite(Number(tools)) && Number(tools) > 1) {
    return false;
  }
  return true;
}

const HEADLESS_AUTO_CONTINUE_NUDGE =
  "There is no interactive user. Assume no to any optional feature and carry out the task as given.";

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  // A slash command emitting `review --background "$ARGUMENTS"` hands us
  // `["--background", "--base main --scope branch ..."]`. Splitting only at
  // length===1 left that second token whole, so parseArgs binned every flag in
  // it as one unknown key and the review silently ran against the DEFAULT base,
  // scope and model while reporting that it had started.
  //
  // A token that both starts with `--` and contains whitespace is a squashed
  // flag string; prose never looks like that (and prompts have their own
  // --prompt-file route), so this cannot re-tokenize a user's text.
  return argv.flatMap((token) => {
    const raw = String(token ?? "");
    if (raw.startsWith("--") && /\s/.test(raw.trim())) {
      return splitRawArgumentString(raw);
    }
    return [raw];
  });
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
 * job.summary, i.e. the title of the run in /turbo-build-plugin:runs. Once the contract
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
  const caller = detectCaller(process.env);
  const allowNoIsolate = allowNoIsolateFromEnv(process.env);

  const nextSteps = [];
  const cliName = grokStatus.binary || "grok";
  const cliLabel = grokStatus.brand?.label || "Grok Build";
  if (!grokStatus.available) {
    nextSteps.push(describeMissingBinary(grokStatus.binary));
  }
  if (grokStatus.available && !authStatus.loggedIn) {
    nextSteps.push(`Authenticate the ${cliLabel} CLI (for example by running \`${cliName}\` interactively and completing login).`);
    nextSteps.push(`Verify with \`${cliName} models\` — a successful run means you are logged in.`);
  }

  return {
    ready: nodeStatus.available && grokStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    grok: grokStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    isolation: {
      programmatic: caller.programmatic,
      source: caller.source,
      writeForcesIsolate: caller.programmatic,
      allowNoIsolate
    },
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

/**
 * Renders one line of attacker-influenced text - a withheld or just-trusted
 * config's verify/tools/env command, an unknown JSON key echoed into a
 * warning - for a terminal without letting it act as one.
 *
 * C0 and C1 control bytes (0x00-0x1F, 0x7F-0x9F) are rewritten as visible
 * `\xNN` rather than dropped: the user should see that the file contains
 * them, not have them silently disappear. This specifically defeats ESC
 * (0x1B, which starts every ANSI escape sequence a hostile file could use to
 * repaint the terminal or hide part of the command it wants trusted) and
 * bare CR/LF (which could otherwise fake an extra report line). A hard length
 * cap stops one line from scrolling a whole report off-screen.
 *
 * Render time ONLY. Trust is hashed over the file's exact original bytes
 * (see hashProjectConfig) and those same unmutated bytes are what a verify
 * command hands to sh -c / cmd /c - running either of those through this
 * function first would decouple what was hashed/executed from what this
 * prints, which is a worse bug than the display issue it would "fix".
 */
const DISPLAY_CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f-\x9f]/g;
const DISPLAY_LINE_LIMIT = 400;

function escapeForDisplay(value) {
  const text = String(value ?? "");
  const escaped = text.replace(
    DISPLAY_CONTROL_CHAR_PATTERN,
    (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`
  );
  return escaped.length > DISPLAY_LINE_LIMIT
    ? `${escaped.slice(0, DISPLAY_LINE_LIMIT)}... [truncated, ${escaped.length} chars]`
    : escaped;
}

/**
 * Flattens a config's executable-key values into one display list, in the
 * same shape whether they are still withheld (doctor, before trust) or were
 * just unlocked (trust-config, right after granting it). `tools` and `env`
 * reach a shell exactly like `verify` does - see EXECUTABLE_KEYS's comment in
 * project-config.mjs - so a report that only lists `verify` gives a false
 * all-clear for a config whose only executable keys are `tools`/`env`.
 */
function describeExecutableKeyCommands({ verify, tools, env } = {}) {
  const commands = [...(verify ?? [])];
  for (const [tool, binary] of Object.entries(tools ?? {})) {
    commands.push(`tools.${tool} = ${binary}`);
  }
  for (const [name, value] of Object.entries(env ?? {})) {
    commands.push(`env.${name} = ${value}`);
  }
  return commands;
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
      lines.push(`    ${escapeForDisplay(command)}`);
    }
    // A warn carries `ok: true`, so the fix line has to be selected on the
    // status level. Gating it on `!check.ok` (as this did before levels
    // existed) would print the problem and silently withhold the remedy,
    // which is the least useful half of the two.
    if ((status === "fail" || status === "warn") && check.fix) {
      // Most `fix` strings are static advice this codebase wrote, but the
      // project-config warn branch's fix is `loaded.warnings.join("; ")`,
      // which can contain an attacker-chosen JSON key straight out of an
      // untrusted, repo-tracked file - escape it same as the commands above.
      lines.push(`    Fix: ${escapeForDisplay(check.fix)}`);
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
    // A dropped or unknown key (an invalid maxCostUsd, a typo'd key name)
    // costs the user something real - a spend cap they believe is armed, or
    // a setting they think took effect - even though nothing here is
    // executable. Reporting `ok` unconditionally would be an affirmatively
    // false "no executable keys" all-clear over a file this loader partially
    // rejected.
    if (loaded.warnings.length > 0) {
      return {
        name: "project config",
        status: "warn",
        detail: `${PROJECT_CONFIG_FILENAME} loaded with ${loaded.warnings.length} warning(s) - see verify-plan for detail`,
        fix: loaded.warnings.join("; ")
      };
    }
    const suffix = loaded.trusted ? " (trusted)" : "";
    return {
      name: "project config",
      ok: true,
      detail: `${PROJECT_CONFIG_FILENAME} loaded, no executable keys${suffix}`,
      fix: null
    };
  }

  const commands = describeExecutableKeyCommands(loaded.untrusted);

  return {
    name: "project config",
    ok: false,
    detail: `${withheld.join(", ")} in ${PROJECT_CONFIG_FILENAME} is withheld until you trust this file - it would run:`,
    commands,
    fix: `Read the commands above. If you wrote them (or trust whoever did), run \`${TRUST_CONFIG_COMMAND}\`.`
  };
}

/**
 * Budget for one engine probe.
 *
 * Godot and Blender start in well under a second when they start at all; the
 * cap is here for when they do not. A GUI-subsystem build can pop a window and
 * sit there, and a network-mounted install can stall indefinitely - doctor is
 * run interactively, so a wedged probe would hang the entire report and the
 * user would get no output at all rather than one warn line.
 */
const DOCTOR_PROBE_TIMEOUT_MS = 20_000;

/**
 * Per-engine probe shapes.
 *
 * `headlessArgs` is a function of the descriptor because Godot 3 predates
 * `--headless` (added in 4.0) and rejects it as an unknown option; `--no-window`
 * is its equivalent. An unparsed config_version takes the Godot 4 branch, which
 * is the same choice `defaultVerifyCommands` makes.
 */
const DOCTOR_ENGINE_TOOLS = Object.freeze({
  godot: Object.freeze({
    envVar: "GROK_BUILD_GODOT_BIN",
    versionArgs: Object.freeze(["--version"]),
    headlessArgs: (descriptor) =>
      descriptor?.major === 3 ? ["--no-window", "--version"] : ["--headless", "--version"],
    headlessFix:
      "This build cannot run headless. Godot 3 uses `--no-window` rather than `--headless`; an editor-only or GUI-only build has neither. Point `tools.godot` in .grok-build.json (or GROK_BUILD_GODOT_BIN) at a build that starts without a display."
  }),
  blender: Object.freeze({
    envVar: "GROK_BUILD_BLENDER_BIN",
    versionArgs: Object.freeze(["--version"]),
    // -b plus a trivial expression is the cheapest thing that proves the build
    // can start without a display AND run Python, which is what every Blender
    // verify command depends on. --python-exit-code turns an import failure
    // into a non-zero exit; without it Blender exits 0 and says nothing.
    headlessArgs: () => [
      "--background",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "--python-expr",
      "import bpy"
    ],
    headlessFix:
      "This build cannot run background Python. A `bpy`-less build (or one missing its Python runtime) cannot run any Blender verify command. Point `tools.blender` in .grok-build.json (or GROK_BUILD_BLENDER_BIN) at a full Blender install."
  })
});

/** Only these two get toolchain checks; node/python/rust have none to run. */
const DOCTOR_ENGINE_IDS = Object.freeze(["godot", "blender"]);

/** `Godot 4.3`, `Godot 4`, or `unknown version` - never a wrong number. */
function describeGodotVersion(descriptor) {
  if (!Number.isInteger(descriptor?.major)) {
    return "unknown version";
  }
  return Number.isInteger(descriptor.minor)
    ? `Godot ${descriptor.major}.${descriptor.minor}`
    : `Godot ${descriptor.major}`;
}

/**
 * The gitignore probe for one engine: a path that CANNOT be in the index, plus
 * the pattern a user would add to fix it.
 *
 * The probe path matters. `git check-ignore` reports a tracked path as
 * not-ignored no matter what .gitignore says, so probing `.godot` itself in a
 * repo that has (wrongly) committed it would produce a warn whose fix does not
 * help. A `__grok_probe` leaf can never be tracked, so the answer is purely
 * about the ignore rules. Forward slashes throughout: that is the only
 * separator gitignore syntax knows, on every platform.
 */
function gitignoreProbesFor(descriptor) {
  const projectPrefix =
    typeof descriptor.projectDir === "string" &&
    descriptor.projectDir !== "." &&
    descriptor.projectDir !== ""
      ? `${String(descriptor.projectDir).replace(/\\/g, "/").replace(/\/+$/, "")}/`
      : "";
  if (descriptor.id === "godot") {
    // Probe the cache directory this project actually uses. Warning a Godot 4
    // project about an unignored `.import/` it will never create is noise.
    // Nested monorepos (game/project.godot) probe under projectDir.
    return descriptor.cacheDir === ".import"
      ? [{ path: `${projectPrefix}.import/__grok_probe`, pattern: `${projectPrefix}.import/` }]
      : [
          {
            path: `${projectPrefix}.godot/imported/__grok_probe`,
            pattern: `${projectPrefix}.godot/`
          }
        ];
  }
  if (descriptor.id === "blender") {
    // Blender writes <scene>.blend1, .blend2, ... next to every saved scene.
    return [{ path: `${projectPrefix}__grok_probe.blend1`, pattern: "*.blend[0-9]" }];
  }
  return [];
}

/**
 * Are the engine's generated files ignored?
 *
 * `git check-ignore -q <path>` exits 0 when the path is ignored, 1 when it is
 * not, and 128 on an error (not a repository, unreadable .gitignore, no git).
 * 128 is a SKIP, not a warn: doctor learned nothing, and reporting "your
 * gitignore is wrong" on the strength of a failed measurement is worse than
 * saying nothing.
 */
function buildGitignoreHygieneCheck(root, descriptors, gitImpl) {
  const probes = descriptors.flatMap(gitignoreProbesFor);
  if (probes.length === 0) {
    return null;
  }

  const missing = [];
  let measured = 0;
  for (const probe of probes) {
    const result = gitImpl(root, ["check-ignore", "-q", "--", probe.path], {
      timeout: DOCTOR_PROBE_TIMEOUT_MS
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      continue;
    }
    measured += 1;
    if (result.status === 1) {
      missing.push(probe);
    }
  }

  if (measured === 0) {
    return {
      name: "gitignore hygiene",
      status: "skipped",
      detail: "git check-ignore could not answer here",
      fix: null
    };
  }

  if (missing.length === 0) {
    return {
      name: "gitignore hygiene",
      status: "ok",
      detail: `${probes.map((probe) => probe.pattern).join(", ")} ignored`,
      fix: null
    };
  }

  const patterns = missing.map((probe) => probe.pattern);
  return {
    name: "gitignore hygiene",
    status: "warn",
    detail: `${patterns.join(", ")} is not ignored`,
    // Never written for the user: commands/doctor.md forbids doctor from
    // modifying the repository, and a .gitignore is a file the user's team
    // reviews.
    fix: `Add ${patterns.join(" and ")} to .gitignore. Godot regenerates its import cache continuously, so an unignored cache leaves the tree permanently dirty - and \`land\` refuses to merge into a dirty tree.`
  };
}

/**
 * git-lfs: declared but not installed.
 *
 * A repository whose .gitattributes routes `*.blend` or `*.png` through
 * `filter=lfs` needs the clean filter configured locally, or `git add` commits
 * the raw multi-hundred-megabyte asset instead of a pointer - into a worktree
 * this plugin then squash-merges. Nothing downstream can undo that.
 *
 * Emitted only when LFS is actually declared: a repo that does not use it has
 * nothing to say, and an extra green line in every Godot report is noise.
 * The diff-rewriting half of LFS support is deliberately not checked - a
 * pointer diff is self-describing.
 */
function buildGitLfsCheck(root, gitImpl, readFileImpl) {
  const listed = gitImpl(root, ["ls-files", "-z", "--", "*.gitattributes"], {
    timeout: DOCTOR_PROBE_TIMEOUT_MS
  });
  if (listed.error || listed.status !== 0) {
    return null;
  }

  const declaring = [];
  for (const relative of String(listed.stdout ?? "").split("\0").filter(Boolean)) {
    let contents = "";
    try {
      contents = String(readFileImpl(path.join(root, relative), "utf8"));
    } catch {
      // Tracked but not on disk (a sparse checkout, or deleted and not yet
      // committed). Nothing to read, nothing to claim.
      continue;
    }
    if (/filter\s*=\s*lfs/i.test(contents)) {
      declaring.push(relative);
    }
  }

  if (declaring.length === 0) {
    return null;
  }

  const clean = gitImpl(root, ["config", "--get", "filter.lfs.clean"], {
    timeout: DOCTOR_PROBE_TIMEOUT_MS
  });
  const configured = !clean.error && clean.status === 0 && String(clean.stdout ?? "").trim() !== "";
  if (configured) {
    return {
      name: "git-lfs",
      status: "ok",
      detail: `${declaring.join(", ")} declares filter=lfs, and the clean filter is configured`,
      fix: null
    };
  }

  return {
    name: "git-lfs",
    status: "warn",
    detail: `${declaring.join(", ")} declares filter=lfs but filter.lfs.clean is unset`,
    fix: "Install git-lfs and run `git lfs install` in this repository. Without the clean filter, committing a tracked asset stores the whole binary in the repository instead of a pointer."
  };
}

/**
 * Toolchain checks for the detected engine ecosystems.
 *
 * Returns an EMPTY list when neither Godot nor Blender is detected, so a plain
 * Node or Rust repo's doctor output is byte-identical to what it was before
 * these checks existed.
 *
 * Nothing here is ever a `fail`. A missing engine binary is legitimate: the
 * user may verify through an absolute path this code cannot see, through a
 * `bpy` pip module, or not at all.
 */
function buildEcosystemChecks(root, options = {}) {
  const detect = options.detectEcosystemsImpl ?? detectEcosystems;
  const probe = options.binaryAvailableImpl ?? binaryAvailable;
  const runProbe = options.runCommandImpl ?? runCommand;
  const gitImpl = options.gitImpl ?? git;
  const readFileImpl = options.readFileImpl ?? fs.readFileSync;
  const platform = options.platform ?? process.platform;

  let detected = [];
  try {
    detected = detect(root);
  } catch {
    // detectEcosystems is documented never to throw, but doctor must survive
    // it doing so anyway: a report that crashes tells the user nothing.
    detected = [];
  }
  const engines = detected.filter((descriptor) => DOCTOR_ENGINE_IDS.includes(descriptor?.id));
  if (engines.length === 0) {
    return [];
  }

  const checks = [];

  // What was detected, and - just as important - the limits of the detection,
  // so the ABSENCE of these lines is not read as "this is not a Godot project".
  const summary = engines
    .map((descriptor) =>
      descriptor.id === "godot"
        ? `godot (${describeGodotVersion(descriptor)}, config_version ${descriptor.configVersion ?? "unknown"})`
        : `blender (detected by ${descriptor.detectedBy})`
    )
    .join("; ");
  checks.push({
    name: "ecosystem",
    status: "ok",
    detail: `${summary} - detection reads the repository root and exactly one directory below it for every ecosystem (deeper monorepo layouts need ecosystems[] config or a cwd at the project root)`,
    fix: null
  });

  // tools.* is an executable key, so loadWorkspaceProjectConfig has already
  // withheld it unless the file is trusted. Reading it here means doctor
  // probes the binary a run would ACTUALLY use, not a different one.
  const projectConfig = loadWorkspaceProjectConfig(root);

  for (const descriptor of engines) {
    const tool = DOCTOR_ENGINE_TOOLS[descriptor.id];
    // descriptor.exeHint is the RAW hint (GROK_BUILD_*_BIN, then the generic
    // var, then the bare name). resolveEcosystemBinary is deliberately not
    // used: it returns a shell-quoted, command-string-ready token, and a
    // quoted token handed to runCommand becomes a filename with quotes in it.
    const binary = String(projectConfig.config.tools?.[descriptor.id] ?? descriptor.exeHint ?? "");
    const availability = probe(binary, [...tool.versionArgs], {
      cwd: root,
      timeout: DOCTOR_PROBE_TIMEOUT_MS
    });

    checks.push({
      name: `${descriptor.id} binary`,
      status: availability.available ? "ok" : "warn",
      detail: `${binary}: ${availability.detail}`,
      fix: availability.available
        ? null
        : `Install ${descriptor.id}, or point \`tools.${descriptor.id}\` in ${PROJECT_CONFIG_FILENAME} (or ${tool.envVar}) at the executable. This is only a warning: a verify command that names an absolute path, or one that does not need the binary at all, still works.`
    });

    if (!availability.available) {
      // Everything below needs a working binary. Reporting "cannot run
      // headless" about something that is not installed would be three
      // warnings for one problem.
      checks.push({
        name: `${descriptor.id} headless`,
        status: "skipped",
        detail: `${binary} is not available`,
        fix: null
      });
      continue;
    }

    const headless = probe(binary, tool.headlessArgs(descriptor), {
      cwd: root,
      timeout: DOCTOR_PROBE_TIMEOUT_MS
    });
    checks.push({
      name: `${descriptor.id} headless`,
      status: headless.available ? "ok" : "warn",
      detail: headless.available ? "starts without a display" : headless.detail,
      fix: headless.available ? null : tool.headlessFix
    });

    if (descriptor.id === "godot") {
      checks.push(buildGodotConsoleOutputCheck(binary, root, runProbe, platform));
      checks.push(buildGodotExportTemplatesCheck(descriptor, platform));
    }
  }

  const gitignore = buildGitignoreHygieneCheck(root, engines, gitImpl);
  if (gitignore) {
    checks.push(gitignore);
  }

  const lfs = buildGitLfsCheck(root, gitImpl, readFileImpl);
  if (lfs) {
    checks.push(lfs);
  }

  return checks;
}

/**
 * Does this Godot build write anything to a captured pipe at all?
 *
 * On Windows the official download ships a GUI-subsystem
 * `Godot_v4.x-stable_win64.exe` next to a `Godot_v4.x-stable_win64_console.exe`.
 * Only the second has a console attached, so only the second writes to a pipe.
 * The first exits 0 with both streams empty, which silently defeats every
 * output-pattern check: a verify run that cannot see `SCRIPT ERROR:` reports a
 * broken project as verified, and failure attribution collapses to
 * "incomparable" because there is no output to build a signature from.
 *
 * Detected EMPIRICALLY, never by filename - a user may have renamed either
 * build, and a launcher script or a Flatpak/Steam wrapper can swallow output on
 * any platform. `runCommand` is called directly rather than reading
 * `binaryAvailable`'s `detail`, because that helper substitutes the literal
 * string "ok" when both streams are empty, so an empty detail never occurs.
 */
function buildGodotConsoleOutputCheck(binary, root, runProbe, platform) {
  const result = runProbe(binary, ["--version"], {
    cwd: root,
    timeout: DOCTOR_PROBE_TIMEOUT_MS
  });
  const silent =
    !result.error &&
    result.status === 0 &&
    !String(result.stdout ?? "").trim() &&
    !String(result.stderr ?? "").trim();

  if (!silent) {
    return {
      name: "godot console output",
      status: "ok",
      detail: "writes to a captured pipe",
      fix: null
    };
  }

  const remedy =
    platform === "win32"
      ? "Use the console build - `Godot_v4.x-stable_win64_console.exe`, which ships in the same archive - and point `tools.godot` in .grok-build.json (or GROK_BUILD_GODOT_BIN) at it."
      : "Point `tools.godot` in .grok-build.json (or GROK_BUILD_GODOT_BIN) at the real executable rather than a launcher script that swallows its output.";
  return {
    name: "godot console output",
    status: "warn",
    detail: `${binary} exits 0 but writes nothing to stdout or stderr`,
    fix: `${remedy} Until then, verification can only read the exit code, and Godot exits 0 on a GDScript parse error.`
  };
}

/**
 * Warn before a run when export templates for the detected editor major are
 * missing — export-smoke otherwise exits 0 with no artifact.
 */
function buildGodotExportTemplatesCheck(descriptor, platform) {
  const major = descriptor?.major;
  const versionHint =
    major != null && descriptor?.minor != null
      ? `${major}.${descriptor.minor}`
      : major != null
        ? String(major)
        : null;

  const candidates = [];
  if (platform === "win32") {
    const appdata = process.env.APPDATA || process.env.LOCALAPPDATA;
    if (appdata) {
      candidates.push(path.join(appdata, "Godot", "export_templates"));
    }
  } else if (platform === "darwin") {
    const home = process.env.HOME;
    if (home) {
      candidates.push(path.join(home, "Library", "Application Support", "Godot", "export_templates"));
    }
  } else {
    const home = process.env.HOME;
    if (home) {
      candidates.push(path.join(home, ".local", "share", "godot", "export_templates"));
    }
  }

  let foundRoot = null;
  let versionMatch = null;
  for (const root of candidates) {
    if (!fs.existsSync(root)) {
      continue;
    }
    foundRoot = root;
    try {
      const entries = fs.readdirSync(root);
      if (versionHint) {
        versionMatch = entries.find(
          (name) =>
            String(name).startsWith(versionHint) ||
            String(name).startsWith(`${versionHint}.`)
        );
      } else if (entries.length > 0) {
        versionMatch = entries[0];
      }
    } catch {
      // unreadable dir
    }
    break;
  }

  if (versionMatch) {
    return {
      name: "godot export templates",
      status: "ok",
      detail: `found ${versionMatch} under ${foundRoot}`,
      fix: null
    };
  }

  if (foundRoot) {
    return {
      name: "godot export templates",
      status: "warn",
      detail: `export_templates dir exists at ${foundRoot} but no template matching ${versionHint ?? "this editor"} was found`,
      fix: "Install export templates from the Godot editor (Editor → Manage Export Templates), or disable --godot-export-smoke / exportSmoke until they are present. Without templates, export-smoke exits 0 and writes nothing."
    };
  }

  return {
    name: "godot export templates",
    status: "warn",
    detail: "no Godot export_templates directory found on this machine",
    fix: "Install export templates from the Godot editor before using --godot-export-smoke. Without them the smoke step is a no-op pass."
  };
}

function buildDoctorReport(cwd, options = {}) {
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
    fix: grok.available ? null : describeMissingBinary(grok.binary)
  });

  if (grok.available) {
    const identity = grok.identity;
    const features = grok.features ?? {};
    const featureBits = ["headless", "confine", "jobObject", "jsonSchema"]
      .filter((k) => features[k] === true)
      .join(",");
    checks.push({
      name: "cli identity",
      ok: true,
      status: identity ? "ok" : "warn",
      detail: identity
        ? `${identity.product ?? grok.brand?.id ?? "unknown"} ${identity.currentVersion ?? grok.detail ?? ""} agentCompatible=${identity.agentCompatible === true} features=${featureBits || "(none advertised)"}`
        : `${grok.binary} did not advertise version --json identity (pre-rc2). Confine/deny prefix probes fall back to --help.`,
      fix: identity
        ? null
        : "Upgrade Turbo Grok Build to 1.0.0-rc.2+ for machine-readable identity."
    });
  }

  const auth = getGrokAuthStatus(cwd);
  checks.push({
    name: "auth",
    ok: Boolean(auth.loggedIn),
    detail: auth.detail || (auth.loggedIn ? "authenticated" : "not authenticated"),
    fix: auth.loggedIn
      ? null
      : "Authenticate the Grok CLI (run `grok` interactively), then verify with `grok models`."
  });

  // main() has already run ensureHomeEnv, so by the time doctor reports, a
  // Windows shell that arrived without HOME has one. Say which - reporting a
  // bare "ok" for a value the bridge supplied would hide the fact that nothing
  // in the user's own environment sets it, and the next tool they run by hand
  // will still be missing it.
  const homeFill = ensureHomeEnv(process.env);
  const homeSet = Boolean(process.env.HOME || process.env.GROK_HOME);
  checks.push({
    name: "HOME/GROK_HOME",
    ok: homeSet,
    detail: !homeSet
      ? "neither HOME nor GROK_HOME is set"
      : homeFill.defaulted
        ? `HOME=${process.env.HOME} (defaulted from %USERPROFILE%; nothing in this shell sets HOME)`
        : process.env.GROK_HOME
          ? `GROK_HOME=${process.env.GROK_HOME}`
          : `HOME=${process.env.HOME}`,
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

  // Surface the isolation policy for programmatic callers so doctor/check
  // explain why a Claude-side write run cannot pass --no-isolate.
  const caller = detectCaller(process.env);
  const allowNoIsolate = allowNoIsolateFromEnv(process.env);
  checks.push({
    name: "isolation policy",
    ok: true,
    status: "ok",
    detail: caller.programmatic
      ? `programmatic caller (${caller.source}): write runs force isolation` +
        (allowNoIsolate ? "; GROK_BUILD_ALLOW_NO_ISOLATE=1 escape hatch is set" : "")
      : "interactive: write runs isolate by default; --no-isolate is allowed",
    fix: null
  });

  // Emits nothing at all when neither Godot nor Blender is detected, so a
  // plain Node repo's report is unchanged.
  checks.push(...buildEcosystemChecks(workspaceRoot, options));

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
  // Runs with unlanded commits, uncommitted dirt, or protected terminal
  // statuses are "awaiting land", not prunable staleness — doctor must not
  // recommend prune --apply for them.
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
    const worktreePath = stored.worktree.path;
    const unmerged = countUnmergedCommits(
      workspaceRoot,
      stored.worktree.baseSha,
      stored.worktree.branch
    );
    const hasUncommitted = worktreeHasUncommittedWork(worktreePath);
    const protect =
      hasUncommitted ||
      unmerged === null ||
      (typeof unmerged === "number" && unmerged > 0 && PROTECTED_WORKTREE_STATUSES.has(status));
    if (protect) {
      awaitingLand.push({
        ...job,
        worktree: stored.worktree,
        unmergedCommits: unmerged ?? 0,
        hasUncommitted
      });
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
        : "Run `/turbo-build-plugin:land` to apply or discard unlanded isolated work."
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

/**
 * Commits on branch that are not reachable from baseSha (unlanded work).
 * Returns null when git fails so callers treat unknown as protected rather
 * than "zero commits, safe to delete".
 */
function countUnmergedCommits(repoRoot, baseSha, branchName) {
  if (!baseSha || !branchName) {
    return 0;
  }
  const result = git(repoRoot, ["rev-list", "--count", `${baseSha}..${branchName}`]);
  if (result.status !== 0) {
    return null;
  }
  const count = Number(String(result.stdout ?? "").trim());
  if (!Number.isFinite(count)) {
    return null;
  }
  return count > 0 ? count : 0;
}

/**
 * True when the worktree working tree has non-artifact dirt.
 * On git failure, returns true (safe direction: protect).
 */
function worktreeHasUncommittedWork(worktreePath) {
  if (!worktreePath || typeof worktreePath !== "string") {
    return false;
  }
  if (!fs.existsSync(worktreePath)) {
    return false;
  }
  let status = git(worktreePath, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    ".",
    ...artifactExcludePathspecs()
  ]);
  if (status.status !== 0) {
    status = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  }
  if (status.status !== 0) {
    return true;
  }
  return Boolean(String(status.stdout ?? "").trim());
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
  // not a gate. A non-zero exit would make `/turbo-build-plugin:doctor` look like a
  // failed command in the Claude Code transcript. There used to be an
  // `if (!report.ok) { process.exitCode = 0; }` here, which read as an
  // unfinished thought and invited exactly the wiring this comment forbids.
}

function renderVerifyPlan(payload) {
  const ecoLabel = (() => {
    if (Array.isArray(payload.ecosystems) && payload.ecosystems.length > 1) {
      return payload.ecosystems
        .map((e) => (e.projectDir && e.projectDir !== "." ? `${e.id}@${e.projectDir}` : e.id))
        .join(", ");
    }
    if (payload.ecosystem) {
      const dir =
        payload.ecosystem.projectDir && payload.ecosystem.projectDir !== "."
          ? `@${payload.ecosystem.projectDir}`
          : "";
      return `${payload.ecosystem.id}${dir}`;
    }
    return "none detected";
  })();
  const lines = [
    "# Grok Build Verify Plan",
    "",
    `Ecosystem: ${ecoLabel}`,
    `Source: ${describeVerifySource(payload.source)}`
  ];

  if (payload.disabled) {
    lines.push("Verification is disabled for this run (--no-verify).");
  } else {
    if (payload.autoVerifyWithheld) {
      lines.push(
        "Auto-derived verify commands are withheld until trust-on-first-use; they will not run at baseline.",
        `Review them above, then run: ${payload.trustCommand}`
      );
    }
    if (payload.commands.length === 0) {
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
  }

  for (const message of payload.config.errors) {
    lines.push("", message);
  }
  // Warnings (a dropped/invalid field, an unknown key) were previously
  // recorded on `loadProjectConfig`'s result and never printed anywhere, so a
  // discarded maxCostUsd or a typo'd key name looked identical to a fully
  // honoured config.
  for (const message of payload.config.warnings) {
    lines.push("", escapeForDisplay(message));
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

  const lines = [
    payload.hash
      ? `Trusted ${payload.path} (sha256 ${payload.hash.slice(0, 12)}).`
      : "Trusted the current auto-derived verify plan (recorded outside the repository)."
  ];
  // verify/tools/env are ALL executable keys (EXECUTABLE_KEYS in
  // project-config.mjs) - a config whose only executable keys are `tools`/
  // `env` used to fall through this branch entirely and receive a receipt
  // identical to trusting an inert file.
  const commands = describeExecutableKeyCommands(payload);
  if (commands.length > 0) {
    lines.push("", "Runs in this workspace may now execute:");
    for (const command of commands) {
      lines.push(`  ${escapeForDisplay(command)}`);
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

  const plan = resolveProjectRunPlan(workspaceRoot, {});
  const result = recordProjectConfigTrust(workspaceRoot, {
    verifyCommands: plan.autoVerifyCommands ?? []
  });
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
    // actually unlocked. All three - verify, tools, AND env - are
    // EXECUTABLE_KEYS; omitting any of them here would understate what this
    // grant just unlocked.
    verify: result.loaded.untrusted.verify ?? [],
    tools: result.loaded.untrusted.tools ?? {},
    env: result.loaded.untrusted.env ?? {},
    autoVerify: plan.autoVerifyCommands ?? [],
    errors: result.loaded.errors
  };
  outputCommandResult(payload, renderTrustConfigResult(payload), options.json);
}

function collectPrunePlan(cwd, options = {}) {
  const includeUnlanded = Boolean(options.includeUnlanded);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Status reconciliation first so abandoned runs become terminal and their
  // worktrees fall into the removal plan below rather than sitting forever.
  reconcileAbandonedInWorkspace(workspaceRoot, options);
  const jobs = listJobs(workspaceRoot);
  /** @type {{ type: string, jobId: string, detail: string, apply: () => { removed?: boolean, orphanedPath?: string|null, reason?: string }|void }[]} */
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
            // Keep "abandoned" in the message so existing ops tests and log
            // greps still match; the precise claim text is what status used to lie about.
            errorMessage: "Run abandoned; process exited without a terminal claim.",
            phase: "failed",
            bridgePid: null,
            agentPid: null,
            pid: null
          });
          return { removed: true };
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
    // Always the stored path — never recompute via resolveWorktreePath. Older
    // runs live under the long CLAUDE_PLUGIN_DATA layout; recomputing would
    // miss them and leave orphans.
    const worktreePath = worktree.path;
    const branchName = worktree.branch ?? null;
    const unmerged = countUnmergedCommits(workspaceRoot, worktree.baseSha, branchName);
    const hasUncommitted = worktreeHasUncommittedWork(worktreePath);

    // Prefer quarantine over deletion: anything that still holds work (commits,
    // dirty working tree, or unknown git state) stays until the user opts in
    // with --include-unlanded. Status alone is not enough — a cancelled run can
    // hold 30 uncommitted assets, and isolation-breached can hold real commits.
    if (!includeUnlanded) {
      if (hasUncommitted) {
        awaitingLand.push({
          jobId,
          branch: branchName,
          unmergedCommits: typeof unmerged === "number" ? unmerged : 0,
          detail: `Run ${jobId} has uncommitted work in worktree at ${worktreePath}; use /turbo-build-plugin:land or pass --include-unlanded to prune.`
        });
        continue;
      }
      if (unmerged === null) {
        awaitingLand.push({
          jobId,
          branch: branchName,
          unmergedCommits: 0,
          detail: `Run ${jobId} worktree could not be inspected for unlanded commits; refusing to prune without --include-unlanded.`
        });
        continue;
      }
      if (unmerged > 0 && PROTECTED_WORKTREE_STATUSES.has(status)) {
        awaitingLand.push({
          jobId,
          branch: branchName,
          unmergedCommits: unmerged,
          detail: `Run ${jobId} has unlanded work (${unmerged} commit(s) on ${branchName ?? "branch"}, status=${status}); use /turbo-build-plugin:land or pass --include-unlanded to prune.`
        });
        continue;
      }
    }

    actions.push({
      type: "worktree",
      jobId,
      detail: `Remove worktree for terminal run ${jobId} at ${worktreePath}.`,
      apply: () =>
        removeWorktree({
          repoRoot: workspaceRoot,
          worktreePath,
          branchName,
          deleteBranch: Boolean(branchName)
        })
    });
  }

  // R6-7: directories under the worktree root with no job record. Offer removal
  // only when the tree has no uncommitted work (same preservation rules as
  // job-backed prune).
  const knownPaths = [];
  for (const job of jobs) {
    const stored = readStoredJob(workspaceRoot, job.id) ?? job;
    const p = stored?.worktree?.path ?? stored?.isolation?.worktree;
    if (p) {
      knownPaths.push(p);
    }
  }
  const worktreeRoot = resolveWorktreeRoot({ repoRoot: workspaceRoot, env: process.env });
  const orphanScan = reconcileOrphanWorktrees({
    worktreeRoot,
    knownPaths,
    repoRoot: workspaceRoot
  });
  /** @type {{ path: string, hasUncommittedWork: boolean, ownershipUnverified?: boolean, detail: string }[]} */
  const orphanWorktrees = orphanScan.orphans;
  for (const orphan of orphanWorktrees) {
    if (orphan.hasUncommittedWork && !includeUnlanded) {
      awaitingLand.push({
        jobId: `(orphan)`,
        branch: null,
        unmergedCommits: 0,
        detail: orphan.detail
      });
      continue;
    }
    // The worktree root is shared per volume, so a directory here may belong to
    // a different repository. `reconcileOrphanWorktrees` drops the ones it can
    // prove are foreign; anything it merely cannot vouch for is reported but
    // never auto-removed, not even under --include-unlanded. A stale directory
    // costs disk; deleting another project's live worktree costs their work.
    if (orphan.ownershipUnverified) {
      awaitingLand.push({
        jobId: `(unverified)`,
        branch: null,
        unmergedCommits: 0,
        detail: orphan.detail
      });
      continue;
    }
    actions.push({
      type: "orphan-worktree",
      jobId: `(orphan:${path.basename(orphan.path)})`,
      detail: `Remove orphan worktree directory ${orphan.path} (no job record).`,
      apply: () =>
        removeWorktree({
          repoRoot: workspaceRoot,
          worktreePath: orphan.path,
          branchName: null,
          deleteBranch: false
        })
    });
  }

  return { workspaceRoot, actions, awaitingLand, orphanWorktrees, worktreeRoot };
}

function renderPruneReport(plan, applied) {
  const mode = applied ? "applied" : "dry-run";
  const lines = ["# Grok Build Prune", "", `Mode: ${mode}`, ""];
  const awaiting = plan.awaitingLand ?? [];
  const failed = plan.failedRemovals ?? [];

  if (plan.actions.length === 0 && awaiting.length === 0 && failed.length === 0) {
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

  if (failed.length > 0) {
    lines.push("", `Could not delete (${failed.length}) — directories left on disk:`);
    for (const item of failed) {
      lines.push(`- ${item.jobId}: ${item.orphanedPath ?? item.detail}${item.reason ? ` (${item.reason})` : ""}`);
    }
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

  /** @type {{ jobId: string, orphanedPath?: string|null, reason?: string, detail: string }[]} */
  const failedRemovals = [];
  if (apply) {
    for (const action of plan.actions) {
      const result = action.apply();
      if (result && result.removed === false) {
        failedRemovals.push({
          jobId: action.jobId,
          orphanedPath: result.orphanedPath ?? null,
          reason: result.reason,
          detail: action.detail
        });
      }
    }
  }
  plan.failedRemovals = failedRemovals;

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
    failedRemovals,
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
    // M2: keep the probe's explanatory detail (wrong product / Turborepo) when
    // present; fall back to install/PATH remediation only when detail is empty.
    const detail = String(availability.detail ?? "").trim();
    const install = describeMissingBinary(availability.binary);
    const message = detail
      ? `${detail} ${install} Then rerun \`/turbo-build-plugin:check\`.`
      : `${install} Then rerun \`/turbo-build-plugin:check\`.`;
    throw new Error(message);
  }
  return availability;
}

/**
 * Isolation outcome for runs --json / show. Survives worktree cleanup (R6-2):
 * after land the path is null on `worktree` but `isolation.worktree` still
 * records where the run lived and whether it was isolated.
 */
function projectIsolationFields(record, worktree) {
  const stored =
    record?.isolation && typeof record.isolation === "object" ? record.isolation : null;
  const path =
    stored?.worktree ?? worktree?.path ?? null;
  const active = Boolean(
    stored?.active || path || worktree?.path || record?.isolate === true
  );
  return {
    active,
    worktree: path,
    branch: stored?.branch ?? worktree?.branch ?? null,
    baseSha: stored?.baseSha ?? worktree?.baseSha ?? null,
    headSha: stored?.headSha ?? worktree?.sha ?? worktree?.headSha ?? null,
    breached: Boolean(
      stored?.breached || worktree?.breached || record?.isolationBreached || record?.status === "isolation-breached"
    ),
    source: stored?.source ?? record?.isolateSource ?? null
  };
}

/**
 * Project a job into the runs --json v2 row shape.
 * Hydrates missing fields from jobs/<id>.json when the index never mirrored them.
 */
function projectRunJsonRow(job, storedJob = null) {
  const record = { ...job, ...(storedJob ?? {}) };
  const worktree = record.worktree ?? null;
  const usage = record.usage ?? storedJob?.usage ?? storedJob?.result?.usage ?? null;
  const result = storedJob?.result ?? record.result ?? null;
  return {
    id: record.id,
    status: record.status,
    displayStatus: record.displayStatus ?? record.status,
    alive: Boolean(record.alive),
    abandoned: Boolean(record.abandoned),
    kind: record.kind ?? null,
    kindLabel: record.kindLabel ?? resolveJobKindLabel(record.kind, record.jobClass),
    title: record.title ?? null,
    write: record.write ?? null,
    verified: record.verified ?? storedJob?.verified ?? result?.verified ?? null,
    stopReason: record.stopReason ?? storedJob?.stopReason ?? result?.stopReason ?? null,
    toolCallCount: record.toolCallCount ?? storedJob?.toolCallCount ?? result?.toolCallCount ?? null,
    changedFileCount:
      record.changedFileCount ??
      storedJob?.changedFileCount ??
      result?.changedFiles?.total ??
      worktree?.changedFileCount ??
      null,
    isolation: projectIsolationFields(record, worktree),
    usage,
    model: record.model ?? storedJob?.model ?? null,
    resolvedModel: record.resolvedModel ?? storedJob?.resolvedModel ?? usage?.resolvedModel ?? null,
    elapsed: record.elapsed ?? null,
    duration: record.duration ?? null,
    durationMs: record.durationMs ?? result?.durationMs ?? null,
    implausiblyShort: Boolean(record.implausiblyShort ?? result?.implausiblyShort),
    autoContinued: Boolean(record.autoContinued ?? result?.autoContinued),
    debris: result?.debris ?? record.debris ?? { entries: [], total: 0, truncated: false },
    threadId: record.threadId ?? null,
    logFile: record.logFile ?? null,
    createdAt: record.createdAt ?? null,
    completedAt: record.completedAt ?? null,
    // Nested delegation — additive keys only; older records omit them.
    parentRunId: record.parentRunId ?? storedJob?.parentRunId ?? null,
    nestDepth: record.nestDepth ?? storedJob?.nestDepth ?? null,
    children: record.children ?? storedJob?.children ?? []
  };
}

function hydrateJobFromStored(workspaceRoot, job) {
  if (!job?.id) {
    return job;
  }
  // Index may predate the mirror fields; fill gaps from the job file without
  // overwriting values the index already has.
  const stored = readStoredJob(workspaceRoot, job.id);
  if (!stored) {
    return job;
  }
  const fill = [
    "usage",
    "resolvedModel",
    "stopReason",
    "write",
    "verified",
    "changedFileCount",
    "toolCallCount",
    "worktree",
    "isolation",
    "isolationBreached",
    "isolateSource",
    "grokVersion",
    "model",
    "parentRunId",
    "nestDepth",
    "children"
  ];
  const next = { ...job };
  for (const key of fill) {
    if (next[key] == null && stored[key] != null) {
      next[key] = stored[key];
    }
  }
  if (next.usage == null && stored.result?.usage != null) {
    next.usage = stored.result.usage;
  }
  if (next.stopReason == null && stored.result?.stopReason != null) {
    next.stopReason = stored.result.stopReason;
  }
  if (next.toolCallCount == null && stored.result?.toolCallCount != null) {
    next.toolCallCount = stored.result.toolCallCount;
  }
  if (next.changedFileCount == null && stored.result?.changedFiles?.total != null) {
    next.changedFileCount = stored.result.changedFiles.total;
  }
  if (next.verified == null && stored.result?.verified != null) {
    next.verified = stored.result.verified;
  }
  return next;
}

function renderStatusPayload(report, asJson) {
  if (!asJson) {
    return renderStatusReport(report);
  }
  // schemaVersion 2 is the structured shape. Legacy top-level running /
  // latestFinished / recent keys stay for one minor version (also under compat).
  const workspaceRoot = report.workspaceRoot;
  const running = (report.running ?? []).map((job) =>
    projectRunJsonRow(hydrateJobFromStored(workspaceRoot, job), readStoredJob(workspaceRoot, job.id))
  );
  const latestFinished = report.latestFinished
    ? projectRunJsonRow(
        hydrateJobFromStored(workspaceRoot, report.latestFinished),
        readStoredJob(workspaceRoot, report.latestFinished.id)
      )
    : null;
  const recent = (report.recent ?? []).map((job) =>
    projectRunJsonRow(hydrateJobFromStored(workspaceRoot, job), readStoredJob(workspaceRoot, job.id))
  );
  const runs = [...running, ...(latestFinished ? [latestFinished] : []), ...recent];
  const payload = {
    schemaVersion: 2,
    workspaceRoot,
    sessionRuntime: report.sessionRuntime,
    runs,
    compat: {
      running,
      latestFinished,
      recent
    },
    // Deprecated top-level aliases — remove after one minor version.
    running,
    latestFinished,
    recent
  };
  // BRIDGE-5: session totals grouped by resolvedModel so "which model was
  // cheaper for this job" needs no unified.jsonl join. Present on --all.
  if (report.all) {
    payload.sessionTotals = buildSessionTotalsByModel(runs);
  }
  return payload;
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
  // Treat explicit 0 as "do not wait" — `Number(0) || default` would wrongly
  // fall through to the 240s default and hang every --timeout 0 test/caller.
  const rawTimeout = options.timeoutMs;
  const timeoutMs =
    rawTimeout == null || rawTimeout === ""
      ? DEFAULT_STATUS_WAIT_TIMEOUT_MS
      : Math.max(0, Number(rawTimeout));
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  reconcileAbandonedInWorkspace(workspaceRoot, options);
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  // Wait on liveness, not only the stored status string. A run that was killed
  // externally used to sit at status:running with alive:false forever; the
  // reconciliation above claims it terminal, and the loop also breaks when
  // alive === false even before the claim lands.
  while (Date.now() < deadline) {
    const active = isActiveJobStatus(snapshot.job.status);
    const alive = snapshot.job.alive;
    if (!active || alive === false) {
      break;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    reconcileAbandonedInWorkspace(workspaceRoot, options);
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  const stillActive =
    isActiveJobStatus(snapshot.job.status) && snapshot.job.alive !== false;

  return {
    ...snapshot,
    waitTimedOut: stillActive,
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Delegate run ${activeTask.id} is still running. Use /turbo-build-plugin:runs before continuing it.`);
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

  // Review/critique are always read-only, and take the same permission shape as
  // a read-only delegate run: plan + read-only sandbox for intent and unix
  // enforcement, plus deny rules that also hold on Windows (see
  // buildHeadlessPermissionOptions).
  const result = await runHeadlessAgent(context.repoRoot, {
    prompt,
    agent: "explore",
    ...buildHeadlessPermissionOptions(false),
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
    // H1: Turbo --json-schema puts the validated body on structuredOutput and
    // free-form narration on text. runHeadlessAgent splits those so finalMessage
    // is often just envelope.text — parse that only after structuredOutput.
    let parsed;
    if (result.structuredOutput != null && typeof result.structuredOutput === "object") {
      parsed = {
        parsed: result.structuredOutput,
        parseError: null,
        rawOutput: result.stdout ?? result.finalMessage ?? "",
        envelope: null
      };
    } else if (result.structuredOutputError) {
      parsed = {
        parsed: null,
        parseError: String(result.structuredOutputError),
        rawOutput: result.stdout ?? result.finalMessage ?? "",
        envelope: null
      };
    } else {
      // Prefer raw stdout (full envelope) over finalMessage (text only) so C12 unwrap works.
      const source =
        result.stdout && String(result.stdout).trim().startsWith("{")
          ? result.stdout
          : result.finalMessage;
      parsed = parseStructuredOutput(source, {
        status: result.status,
        failureMessage: result.stderr
      });
    }
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
        stdout: result.finalMessage,
        structuredOutput: result.structuredOutput ?? null,
        structuredOutputError: result.structuredOutputError ?? null,
        toolCallCount: result.toolCallCount ?? null
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
/**
 * Parse `git status --porcelain` into path -> status letter.
 * @param {string} stdout
 * @returns {Map<string, string>}
 */
function parsePorcelainStdout(stdout) {
  const entries = new Map();
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
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
  return parsePorcelainStdout(status.stdout);
}

/**
 * Unfiltered porcelain (includes generated artifacts). Used only to decide
 * whether an empty work-manifest means "wrote nothing" vs "only caches".
 * BRIDGE-3: never render the artifact wording when the tree is truly clean.
 *
 * @param {string} cwd
 * @returns {Map<string, string>|null}
 */
function porcelainChangeEntriesRaw(cwd) {
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0 || status.error) {
    return null;
  }
  return parsePorcelainStdout(status.stdout);
}

/**
 * Classify an empty non-artifact manifest: nothing written at all, or only
 * excluded build caches.
 *
 * @param {string} cwd
 * @param {Set<string>|null} [beforePaths]
 * @returns {"nothing-written"|"excluded-artifacts"|"working-tree-clean"}
 */
function emptyChangeReason(cwd, beforePaths = null) {
  const raw = porcelainChangeEntriesRaw(cwd);
  if (!raw) {
    return "nothing-written";
  }
  let artifactOnly = false;
  for (const filePath of raw.keys()) {
    if (beforePaths && beforePaths.has(filePath)) {
      continue;
    }
    if (isGeneratedArtifactPath(filePath)) {
      artifactOnly = true;
      continue;
    }
    // Something real is dirty but was filtered elsewhere — still not "nothing".
    if (!isDebrisPath(filePath)) {
      return "excluded-artifacts";
    }
    artifactOnly = true;
  }
  return artifactOnly ? "excluded-artifacts" : "nothing-written";
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
  // Split debris out of the work manifest (BRIDGE-12).
  const { work, debris } = partitionWorkAndDebris(fresh);
  const cappedWork = capChangedFiles(work);
  const cappedDebris = capChangedFiles(debris);
  const emptyReason =
    cappedWork.total === 0 ? emptyChangeReason(cwd, before) : null;
  return {
    source: "working-tree",
    ...cappedWork,
    preexistingDirty,
    emptyReason,
    debris: cappedDebris
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);
  // Wall clock for the implausible-duration signal (BRIDGE-1 bonus). Captured
  // before worktree create / baseline probe so a hero kit finishing in 56s is
  // measured honestly, not after the probe already spent minutes.
  const runStartedAtMs = Date.now();

  // Derived rather than plumbed: `meta.logFile` is created in
  // runForegroundCommand AFTER the runner closure that calls this function is
  // built, so it is genuinely not available to be passed in. This is the same
  // path resolveJobLogFile hands tracked-jobs, which appends the complete
  // rendered result to it - the durable artifact of the run, and useless if the
  // user is never told where it is.
  const logFile = request.jobId ? resolveJobLogFile(workspaceRoot, request.jobId) : null;
  // Grok session id is assigned here so the log header can print the join key
  // for ~/.grok/logs/unified.jsonl before the agent starts (BRIDGE-5).
  const assignedSessionId =
    request.resumeLast || request.resumeSessionId
      ? null
      : crypto.randomUUID();

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
  const isolateSource = request.isolateSource ?? (isolate ? "write-default" : "read-only");
  let verifyCommands = normalizeVerifyCommands(request.verifyCommands);
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
  const ecosystemIdsForPatterns = Array.isArray(verifyPlan?.ecosystems)
    ? verifyPlan.ecosystems
    : verifyPlan?.ecosystem
      ? [verifyPlan.ecosystem]
      : [];
  const outputFailurePatterns = resolveOutputFailurePatterns(
    ecosystemIdsForPatterns.length > 0 ? ecosystemIdsForPatterns : verifyPlan?.ecosystem,
    request.verifyFailurePatterns,
    { onWarning: warnAboutPattern }
  );
  const verifyIgnorePatterns = compileUserPatterns(request.verifyIgnorePatterns, {
    onWarning: warnAboutPattern
  });
  // Godot re-prints the same runtime error once per frame, so occurrence
  // counts are noise there and only the deduped signature can be trusted.
  const rawCountComparison = ecosystemIdsForPatterns.includes("godot") ||
    verifyPlan?.ecosystem === "godot"
      ? "ignore"
      : "strict";
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
  /** @type {{ command: string, reason: string }[]} */
  let verifyDropped = [];
  /** @type {Record<string, string>|null} */
  let blenderSandboxEnv = null;
  /** @type {Record<string, string|boolean|null>|null} */
  let blenderSandboxInfo = null;
  /** @type {{ private: boolean, reason: string, cacheLine: string }|null} */
  let godotCacheMode = null;
  /** Shared-cache path for the cross-process import lock; null when private. */
  let sharedGodotCachePath = null;
  /** @type {Record<string, { exists: boolean, entryCount: number, maxMtimeMs: number }>|null} */
  let sharedDirFingerprintsBefore = null;
  /** Env vars provisioned for the worktree (e.g. CARGO_TARGET_DIR). */
  let provisionEnv = null;
  /** @type {Map<string, string>|null} */
  let uidSnapshotBefore = null;
  /** Absolute path used for the .uid snapshot (may be a nested Godot projectDir). */
  let uidSnapshotRoot = null;
  /** @type {{ ok: boolean, notes: string[] }|null} */
  let uidIntegrity = null;
  /** @type {string|null} */
  let blenderVersionNote = null;
  /** @type {string[]|null} */
  let runtimePluginPacks = null;

  // Re-detect in the workspace root (not the worktree) so sandbox/auto-inject
  // decisions match the plan handleTask already resolved. Cheap and pure.
  const runEcosystems = detectEcosystems(workspaceRoot);
  const runEcosystem =
    verifyPlan?.ecosystem != null
      ? runEcosystems.find((entry) => entry.id === verifyPlan.ecosystem) ??
        detectPrimaryEcosystem(workspaceRoot)
      : runEcosystems[0] ?? null;
  const blenderDescriptor =
    runEcosystems.find((entry) => entry.id === "blender") ??
    (runEcosystem?.id === "blender" ? runEcosystem : null);
  const godotDescriptor =
    runEcosystems.find((entry) => entry.id === "godot") ??
    (runEcosystem?.id === "godot" ? runEcosystem : null);
  const nodeDescriptor = runEcosystems.find((entry) => entry.id === "node") ?? null;

  const wantBlenderSandbox = shouldAutoBlenderSandbox(blenderDescriptor ?? runEcosystem, {
    isolate,
    write,
    explicit: request.blenderSandbox ? true : request.noBlenderSandbox ? false : null,
    noSandbox: Boolean(request.noBlenderSandbox)
  });

  if (isolate) {
    // Isolated for write AND read-only (R6-1). Read-only gets a worktree with
    // no live-state provisioning — cheap, and the previous "run in main with
    // unrestricted shell" path was the weakest surface once write isolation
    // landed. Nested children: sibling of the parent worktree, never inside it.
    let nestedWorktreePath = null;
    if (request.parentWorktree && request.jobId) {
      nestedWorktreePath = deriveSiblingWorktreePath(request.parentWorktree, request.jobId);
    }
    created = createWorktree({
      cwd: workspaceRoot,
      runId: request.jobId,
      // Child starts from the parent's base commit (not the parent's HEAD with
      // partial agent edits) so each nested run is a clean sibling branch.
      baseRef: request.baseRef || "HEAD",
      worktreePath: nestedWorktreePath ?? undefined,
      ecosystems: runEcosystems
    });
    // Persist worktree descriptor immediately so cancel/crash cannot orphan it
    // from land/prune/doctor (descriptor must not wait until the run returns).
    if (request.jobId) {
      patchJobIfActive(workspaceRoot, request.jobId, {
        parentRunId: request.parentRunId ?? null,
        nestDepth: request.nestDepth ?? 0,
        isolateSource,
        isolation: {
          active: true,
          worktree: created.worktreePath,
          branch: created.branchName,
          baseSha: created.baseSha,
          breached: false,
          source: isolateSource
        },
        worktree: {
          path: created.worktreePath,
          branch: created.branchName,
          baseSha: created.baseSha
        }
      });
    }

    // Live-state provisioning is for write runs only. Read-only isolation is a
    // clean checkout so the agent cannot mutate caches through junctions.
    if (write) {
      const nestedProjectDirs = runEcosystems
        .map((entry) => entry.projectDir)
        .filter((d) => typeof d === "string" && d !== "." && d !== "");
      const plan = planWorktreeLinks(created.repoRoot, created.worktreePath, {
        // Only ever true/false when the project config said so; undefined lets
        // resolveGodotCacheMode fall through to env / the isolated private default.
        copyGodotCache: request.provisionCopy,
        provisionFiles: request.provisionFiles,
        dirPolicy: request.provisionLink,
        linkDirs: request.linkDirs,
        env: { ...process.env, ...envOverrides },
        nestedProjectDirs,
        isWorkspace: Boolean(nodeDescriptor?.isWorkspace)
      });
      godotCacheMode = plan.godotCache ?? null;
      if (plan.env && Object.keys(plan.env).length > 0) {
        provisionEnv = { ...plan.env };
      }
      // Fingerprint read-mostly SHARED dirs in the main checkout BEFORE the agent
      // runs. Post-run comparison detects junction write-through that git status
      // cannot see (gitignored caches).
      if (Array.isArray(plan.sharedDirs) && plan.sharedDirs.length > 0) {
        sharedDirFingerprintsBefore = fingerprintSharedDirs(created.repoRoot, plan.sharedDirs);
      }
      // The result used to be discarded outright, so a link that failed - the
      // commonest being a `.godot` that is tracked in git and therefore already
      // checked out into the worktree - was invisible, and the run just got
      // mysteriously slower.
      provisionSummary = summarizeProvisionResult(provisionWorktree(plan));

      // Progress channel FIRST — the shared-cache warning must reach the user
      // before a long agent turn, not only in the final report after a corrupted
      // import has already burned the run.
      for (const note of provisionSummary.notes ?? []) {
        request.onProgress?.({
          phase: "starting",
          message: `Provisioning: ${note}`
        });
      }

      if (godotCacheMode && !godotCacheMode.private) {
        // Shared with the main checkout: lock around engine access. The linked
        // path in the worktree is a junction/symlink to the real cache. Honour
        // projectDir so game/.godot monorepos lock the right tree.
        const godotRoot =
          godotDescriptor?.projectDir && godotDescriptor.projectDir !== "."
            ? path.join(created.repoRoot, ...String(godotDescriptor.projectDir).split("/"))
            : created.repoRoot;
        for (const name of GODOT_CACHE_DIRS) {
          const candidate = path.join(godotRoot, name);
          if (fs.existsSync(candidate)) {
            sharedGodotCachePath = candidate;
            break;
          }
        }
      }

      if (wantBlenderSandbox) {
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
        for (const note of sandboxResult.notes ?? []) {
          request.onProgress?.({ phase: "starting", message: `Provisioning: ${note}` });
        }
        // Only claim the sandbox when the link actually landed. Setting
        // BLENDER_USER_SCRIPTS at an add-on directory that does not exist is
        // strictly worse than not sandboxing at all: Blender would then find NO
        // add-ons, and the verify command fails for a reason that has nothing to
        // do with the code.
        if (Object.keys(sandboxPlan.env).length > 0 && sandboxResult.failed.length === 0) {
          blenderSandboxEnv = sandboxPlan.env;
          blenderSandboxInfo = sandboxPlan.blenderSandbox ?? {
            moduleName: sandboxPlan.moduleName,
            addonName: sandboxPlan.addonName,
            isExtension: sandboxPlan.isExtension,
            scriptsDir: sandboxPlan.scriptsDir,
            extensionsDir: sandboxPlan.extensionsDir
          };
        } else if (sandboxResult.failed.length > 0) {
          provisionSummary.notes.push(
            "--blender-sandbox: the add-on could not be linked, so BLENDER_USER_SCRIPTS was left alone and Blender will use your real add-on directory."
          );
        }
      }
    } else {
      provisionSummary = {
        provisioned: [],
        failed: [],
        notes: ["read-only isolation: worktree created without live-state provisioning"]
      };
    }

    // Inject ecosystem skills into the worktree so the agent (not only the
    // bridge) sees Godot/Blender facts. Copy, never link; `.grok/` is excluded
    // from the commit.
    const ecosystemIds = detectEcosystems(created.worktreePath).map((entry) => entry.id);
    if (ecosystemIds.length === 0 && runEcosystem?.id) {
      ecosystemIds.push(runEcosystem.id);
    }
    for (const id of ecosystemIdsForPatterns) {
      if (id && !ecosystemIds.includes(id)) {
        ecosystemIds.push(id);
      }
    }
    const injected = injectRuntimePlugin(created.worktreePath, ecosystemIds, {
      pluginRoot: ROOT_DIR
    });
    runtimePluginPacks = injected.packs;
    provisionSummary = {
      ...provisionSummary,
      notes: [...provisionSummary.notes, ...injected.notes],
      runtimePlugin: {
        injected: injected.injected,
        packs: injected.packs,
        target: injected.target
      },
      blenderSandbox: blenderSandboxInfo
    };
    for (const note of injected.notes) {
      request.onProgress?.({ phase: "starting", message: note });
    }

    // Nested-delegation MCP surface. Owns only `.mcp.json` in the runtime
    // plugin directory; WP-P3 owns agents/skills beside it. Creates the
    // directory if injectRuntimePlugin was disabled or failed.
    const nestOffered = nestedDelegationEnabled(process.env);
    const nestDepthForHeader = Number.isFinite(Number(request.nestDepth))
      ? Number(request.nestDepth)
      : readNestDepth(process.env);
    if (nestOffered && request.jobId) {
      const mcpWrite = writeRuntimeMcpJson(created.worktreePath, {
        mcpScriptPath: resolveMcpScriptPath(ROOT_DIR),
        bridgePath: resolveBridgeScriptPath(ROOT_DIR),
        pluginRoot: ROOT_DIR,
        workspaceRoot,
        parentRunId: request.jobId,
        nestDepth: nestDepthForHeader,
        parentBaseSha: created.baseSha,
        parentWorktree: created.worktreePath,
        parentMaxCostUsd: maxCostUsd,
        parentMaxDurationSeconds: maxDurationSeconds,
        parentMaxTurns: maxTurns,
        // Bridge-side nest-run re-reads the live parent record for spend; this
        // env snapshot is a best-effort hint at MCP launch (always 0 here).
        parentSpentCostUsd: 0
      });
      provisionSummary = {
        ...provisionSummary,
        notes: [...provisionSummary.notes, ...mcpWrite.notes],
        nestedDelegation: {
          offered: mcpWrite.written,
          mcpJson: mcpWrite.path,
          nestDepth: nestDepthForHeader,
          maxNestDepth: readMaxNestDepth(process.env)
        }
      };
      for (const note of mcpWrite.notes) {
        request.onProgress?.({ phase: "starting", message: note });
      }
    } else if (!nestOffered) {
      const offNote = formatNestedDelegationHeaderLine({ offered: false });
      provisionSummary = {
        ...provisionSummary,
        notes: [...provisionSummary.notes, offNote],
        nestedDelegation: { offered: false }
      };
      request.onProgress?.({ phase: "starting", message: offNote });
    }

    // Snapshot *.uid before the agent so a regenerated companion is reported
    // as the silent reference-break it is. Root at the Godot projectDir.
    // Write runs only — read-only isolation does not expect uid mutations.
    if (write && (runEcosystem?.id === "godot" || ecosystemIds.includes("godot") || godotDescriptor)) {
      uidSnapshotRoot =
        godotDescriptor?.projectDir && godotDescriptor.projectDir !== "."
          ? path.join(created.worktreePath, ...String(godotDescriptor.projectDir).split("/"))
          : created.worktreePath;
      uidSnapshotBefore = snapshotUidFiles(uidSnapshotRoot);
    }

    // A SECOND patch: the one above fires before planning even starts, so the
    // summary has nowhere to attach there.
    if (request.jobId) {
      patchJobIfActive(workspaceRoot, request.jobId, {
        provision: provisionSummary,
        blenderSandbox: blenderSandboxInfo
      });
    }
    runCwd = created.worktreePath;
  } else if (wantBlenderSandbox || request.blenderSandbox) {
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

  // Layered so the sandbox / cargo target dir are DERIVED defaults and an
  // explicit --env still wins: a user who typed BLENDER_USER_SCRIPTS or
  // CARGO_TARGET_DIR themselves gets the value they typed.
  const runEnv = buildRunEnvironment({
    ...(provisionEnv ?? {}),
    ...(blenderSandboxEnv ?? {}),
    ...envOverrides
  });

  // Blender pre-flight: locked .blend files and version_min vs binary.
  const blenderRunDescriptor = blenderDescriptor ?? (runEcosystem?.id === "blender" ? runEcosystem : null);
  if (blenderRunDescriptor && verifyCommands.length > 0) {
    const blendLock = detectBlendLocks(runCwd);
    if (blendLock.locked && blendLock.note) {
      provisionSummary = provisionSummary ?? { provisioned: [], failed: [], notes: [] };
      provisionSummary.notes.push(blendLock.note);
      request.onProgress?.({ phase: "verifying", message: blendLock.note });
    }

    const blenderExe = resolveEcosystemBinary(blenderRunDescriptor, {
      env: runEnv,
      override: undefined
    });
    // Version probe is best-effort and bounded. Failure here must not abort
    // the run — doctor already covers a missing binary.
    try {
      const versionResult = runCommand(
        process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
        process.platform === "win32"
          ? ["/d", "/s", "/c", `"${blenderExe} --background --version"`]
          : ["-c", `${blenderExe} --background --version`],
        {
          cwd: runCwd,
          env: runEnv,
          timeout: 20_000,
          windowsVerbatimArguments: process.platform === "win32" ? true : undefined
        }
      );
      const versionText = `${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`;
      const parsed = parseBlenderVersionOutput(versionText);
      if (parsed) {
        blenderVersionNote = `Blender version: ${parsed.raw}`;
        request.onProgress?.({ phase: "verifying", message: blenderVersionNote });
        const guard = blenderVersionGuardNote(parsed, blenderRunDescriptor.blenderVersionMin);
        if (guard) {
          provisionSummary = provisionSummary ?? { provisioned: [], failed: [], notes: [] };
          provisionSummary.notes.push(guard);
          request.onProgress?.({ phase: "verifying", message: guard });
        }
      }
    } catch {
      // Probe failure is non-fatal.
    }
  }

  /** @type {Awaited<ReturnType<typeof probeBaselines>>} */
  let baselines = [];
  let baselineProbeMs = null;
  // Read-only runs deny Edit/Write. A run that cannot write cannot
  // break a test, so baseline + verify-agent verify are pure dead wall-clock
  // (FIELD-3: measured 15+ minutes wasted on audit runs). Skip entirely.
  const verifySkippedReadOnly = write === false && verifyCommands.length > 0;
  // The probe used to be gated on `created`, i.e. on an isolated write run
  // only. Under --no-isolate there was no baseline at all: baselines.find()
  // returned undefined, compareFailureSignatures compared against an empty
  // set, and every pre-existing failure came back as "new-failures". It now
  // runs for write runs whenever there is anything to attribute, in runCwd.
  //
  // --no-verify-baseline is the one way to opt out of paying for it. It does
  // NOT mean "we don't know what was already broken" - it means the user chose
  // not to look, which makes verification strict: every failure, pre-existing
  // or not, is treated as this run's. Recorded explicitly rather than by
  // leaving `baselines` empty, so classifyVerifyFailure can tell that case
  // apart from a probe that never ran.
  const baselineSkipped = Boolean(request.noVerifyBaseline);
  const shouldProbeBaselines =
    verifyCommands.length > 0 && !baselineSkipped && write !== false;
  // Only ever raised, never lowered: the generous default below is the floor
  // for the one measurement the whole attribution story rests on, and a user
  // who asked for more time for their engine's cold import meant the probe
  // too.
  const baselineTimeoutMs = Math.max(
    BASELINE_PROBE_TIMEOUT_MS,
    verifyTiming.baselineTimeoutMs ?? 0
  );
  if (verifySkippedReadOnly) {
    request.onProgress?.({
      phase: "verifying",
      message: "Verify: skipped (read-only run)"
    });
  } else if (baselineSkipped && verifyCommands.length > 0) {
    baselines = verifyCommands.map((command) => ({
      command,
      // null, not false: nothing was measured, so "did it pass?" has no answer.
      ok: null,
      ms: null,
      signature: [],
      rawCount: 0,
      timedOut: false,
      bufferExceeded: false,
      elidedBytes: 0,
      commandNotFound: false,
      outputFailure: false,
      baselineSkipped: true
    }));
    request.onProgress?.({
      phase: "verifying",
      message: `Verify baseline: skipped (--no-verify-baseline); every failure counts as this run's`
    });
  }

  // Before any verify command: materialise scratch dirs and the Blender shim.
  // Export-smoke writes under .grok-build/; Godot exits 0 with no artifact when
  // the parent directory is missing. The Blender shim must exist for default
  // plans that invoke it.
  if (write && verifyCommands.length > 0 && !verifySkippedReadOnly) {
    try {
      fs.mkdirSync(path.join(runCwd, WORKTREE_SCRATCH_DIR), { recursive: true });
    } catch {
      // Non-fatal; individual commands may still fail honestly.
    }
    if (verifyCommands.some((command) => String(command).includes("grok_verify_shim.py"))) {
      try {
        ensureBlenderVerifyShim(runCwd);
      } catch {
        // Command will fail with a clear missing-script error.
      }
    }
    // Ensure Godot whole-project check script is on disk (isolated inject may
    // already have done this; non-isolated write runs still need tools/).
    if (verifyCommands.some((command) => String(command).includes("grok_check.gd"))) {
      try {
        injectRuntimePlugin(runCwd, ["godot"], { pluginRoot: ROOT_DIR });
      } catch {
        // Command will fail if the script is still missing.
      }
    }
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
      message:
        `Verify baseline: measuring ${verifyCommands.length} command${verifyCommands.length === 1 ? "" : "s"} before the agent starts ` +
        `(the agent has not launched yet; pass --no-verify-baseline to skip when the tree is already known green)`,
      // The commands themselves, once, as a block rather than a line: on a
      // Godot plan these are long and the operator needs to know WHICH of the
      // four is the cold import they are waiting on.
      logTitle: "Verify baseline plan",
      logBody: verifyCommands.map((command, position) => `${position + 1}. ${command}`).join("\n")
    });
    // A generous cap, not the derived per-attempt timeout: this is the ONLY
    // chance to learn what was already broken before the agent touched
    // anything, and a cold-build ecosystem (Godot's first asset import,
    // a fresh cargo build) can legitimately take minutes. A tight cap here
    // used to discard the timeout result silently, so any command that ran
    // long got recorded as an empty baseline signature - and every one of
    // its real, pre-existing failures then looked "new" once the agent's
    // run finished, blaming it for something it never touched.
    // Shared-cache lock also covers the baseline probe: it runs the same
    // import commands and is just as capable of clobbering a concurrent run.
    let baselineLock = null;
    if (sharedGodotCachePath && verifyCommands.some((command) => /\bgodot\b/i.test(command))) {
      baselineLock = await acquireGodotCacheLock(sharedGodotCachePath, {
        onWaiting: (message) => request.onProgress?.({ phase: "verifying", message })
      });
    }
    try {
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
        ignorePatterns: verifyIgnorePatterns,
        // Per-command narration. Without it the whole probe is one log line and
        // then nothing for however long the slowest engine command takes.
        onProgress: (event) => request.onProgress?.(event)
      });
    } finally {
      baselineLock?.release();
    }
    baselineProbeMs = Date.now() - probeStarted;
    request.onProgress?.({
      phase: "verifying",
      message: `Verify baseline: measured in ${baselineProbeMs}ms (${baselines.filter((entry) => entry.ok).length}/${baselines.length} already passing)`
    });

    const dropped = dropBaselineFailingAutoCommands(verifyCommands, baselines, {
      source: verifyPlan?.source
    });
    if (dropped.dropped.length > 0) {
      verifyDropped = dropped.dropped;
      verifyCommands = dropped.commands;
      request.onProgress?.({
        phase: "verifying",
        message:
          `Verify baseline: dropped ${verifyDropped.length} auto-derived command${verifyDropped.length === 1 ? "" : "s"} already failing at baseline (pre-existing noise):\n` +
          verifyDropped.map((entry) => `  ${entry.command} — ${entry.reason}`).join("\n")
      });
    }
  }

  // Snapshotted BEFORE the agent runs, and only where it is needed: an isolated
  // run gets its manifest from the commit range, which cannot contain anything
  // that was already there. Taken after the baseline probe on purpose - a verify
  // command that writes build output would otherwise show up as the agent's work.
  const dirtyBeforeRun = write && !created ? porcelainChangeEntries(runCwd) : null;
  const dirtyBeforeRunPaths = dirtyBeforeRun ? new Set(dirtyBeforeRun.keys()) : null;

  // Isolated runs (write or read-only): snapshot the MAIN checkout
  // (workspaceRoot), not the worktree. Newly dirty paths there after the agent
  // finishes are an isolation breach — the agent obeyed an absolute path in the
  // brief. Same post-baseline timing as the non-isolated snapshot above.
  // H5: null porcelain is fail-closed (cannot prove main stayed clean).
  const mainDirtyBeforeRun = created ? porcelainChangeEntries(workspaceRoot) : null;
  const mainDirtyBeforeRunPaths = mainDirtyBeforeRun ? new Set(mainDirtyBeforeRun.keys()) : null;
  let mainPorcelainUnreliable = Boolean(created && !mainDirtyBeforeRun);
  if (mainPorcelainUnreliable) {
    request.onProgress?.({
      message:
        "Warning: could not snapshot main-checkout git status before the run; isolation breach detection will fail closed if status remains unreadable.",
      phase: "starting"
    });
  }

  // Isolation header line only on this branch (WP-P1 owns CLI/model/verify plan
  // lines). Emitted through the existing progress channel so it lands in the
  // log and the live preview, not only the final report.
  const isolationHeader = formatIsolationHeaderLine({
    active: Boolean(created),
    worktreePath: created?.worktreePath ?? null,
    branch: created?.branchName ?? null,
    baseSha: created?.baseSha ?? null,
    workspaceRoot,
    source: isolateSource
  });
  request.onProgress?.({
    message: isolationHeader,
    phase: "starting"
  });

  // Surrounding header lines (CLI, model, verify plan) — leave structure as-is
  // so WP-P1 merges cleanly; do not rewrite their wording here.
  const availability = getGrokAvailability(request.cwd);
  const cliBrand = availability.brand ?? detectCliBrand(availability.detail);
  const headerLines = [
    `CLI: ${cliBrand.label} ${availability.detail ?? "unknown"} (${availability.binary ?? "grok"})`,
    `Model: ${request.model ? String(request.model) : "default"}`
  ];
  for (const line of headerLines) {
    request.onProgress?.({ message: line, phase: "starting" });
  }

  // Structured log header with the Grok session join key (BRIDGE-5). Re-written
  // later when the served model is known.
  const initialSessionId = resumeSessionId || assignedSessionId;
  writeRunLogHeader(logFile, {
    runId: request.jobId ?? null,
    grokSessionId: initialSessionId,
    binary: availability.binary ?? resolveGrokBinary(),
    version: availability.detail ?? null,
    cliLabel: cliBrand.label,
    modelRequested: request.model ?? null,
    modelServed: null,
    isolation: isolationHeader,
    workspaceRoot
  });
  if (initialSessionId) {
    request.onProgress?.({
      message: `Grok session ID: ${initialSessionId}`,
      phase: "starting",
      threadId: initialSessionId
    });
  }
  if (verifyPlan || verifyCommands.length > 0) {
    const planLines = [];
    // Reuse the same wording the status trailer prints.
    if (verifyCommands.length > 0) {
      const label = verifyPlan?.source ?? "unknown";
      planLines.push(`Verify plan (${label}):`);
      for (const command of verifyCommands) {
        planLines.push(`  ${command}`);
      }
    } else if (verifyPlan?.disabled) {
      planLines.push("Verify plan: disabled for this run (--no-verify).");
    }
    for (const line of planLines) {
      request.onProgress?.({ message: line, phase: "starting" });
    }
  }
  const budgetBits = [];
  if (maxDurationSeconds != null) {
    budgetBits.push(`max-duration=${maxDurationSeconds}s`);
  }
  if (maxTurns != null) {
    budgetBits.push(`max-turns=${maxTurns}`);
  }
  if (maxCostUsd != null) {
    budgetBits.push(`max-cost=$${maxCostUsd}`);
  }
  if (budgetBits.length > 0) {
    request.onProgress?.({ message: `Budgets: ${budgetBits.join(", ")}`, phase: "starting" });
  }

  // Nested delegation offer (also recorded in provision for isolated runs).
  // Non-isolated write runs never get a runtime plugin, so say so plainly.
  {
    const nestDepthForHeader = Number.isFinite(Number(request.nestDepth))
      ? Number(request.nestDepth)
      : readNestDepth(process.env);
    const nestOffered = nestedDelegationEnabled(process.env) && Boolean(created);
    request.onProgress?.({
      message: formatNestedDelegationHeaderLine({
        offered: nestOffered,
        nestDepth: nestDepthForHeader,
        maxNestDepth: readMaxNestDepth(process.env),
        maxConcurrency: readMaxNestConcurrency(process.env)
      }),
      phase: "starting"
    });
  }

  // Permission shape: write runs approve every tool; read-only runs get plan +
  // read-only sandbox AND deny rules on Edit/Write, because the sandbox is
  // inert on Windows (see buildHeadlessPermissionOptions). NotebookEdit is
  // intentionally omitted: Turbo 1.0 rejects it as an unsupported --deny
  // prefix and aborts the whole run; Edit already covers that tool family.
  //
  // Isolated runs ADD deny rules on the main checkout so absolute paths in the
  // task brief cannot edit it (write: even under --always-approve; read-only:
  // defence in depth beyond the plan sandbox). Measured: deny beats
  // always-approve and covers the shell too.
  const permissionOptions = buildHeadlessPermissionOptions(write);
  if (created) {
    // The segment-anchored deny rule is what closes a `../` traversal into the
    // main checkout, but it must not fire when the repository's own directory
    // name also occurs inside the worktree — `**/src/**` on a repo called `src`
    // would deny the run's writable root.
    const rootSegment = normalizePathForPermissionRule(workspaceRoot).split("/").filter(Boolean).at(-1) ?? "";
    const segmentSafe = rootSegment
      ? !worktreeContainsSegment(created.worktreePath, rootSegment)
      : false;
    const denyPlan = buildWorkspaceRootDenyRules(workspaceRoot, created.worktreePath, {
      segmentSafe
    });
    if (!denyPlan.skipped && !denyPlan.segmentRuleApplied && rootSegment) {
      request.onProgress?.({
        message: `Isolation: path-segment deny rule omitted ("${rootSegment}" also occurs inside the worktree); a "../" traversal into the main checkout would only be caught after the run.`,
        phase: "starting"
      });
    }
    // C19: worktree under main root cannot apply main-checkout deny rules.
    // Fail closed unless the operator opts into weak isolation.
    if (denyPlan.skipped) {
      const allowWeak =
        String(process.env.GROK_BUILD_ALLOW_WEAK_ISOLATE ?? "").trim() === "1" ||
        String(process.env.GROK_BUILD_ALLOW_WEAK_ISOLATE ?? "")
          .trim()
          .toLowerCase() === "true";
      const message =
        `Isolation deny rules skipped (${denyPlan.reason}): worktree sits inside the main checkout path, ` +
        "so Edit/Write main-root denials cannot be applied safely.";
      if (!allowWeak) {
        throw new Error(
          `${message} Move GROK_BUILD_WORKTREE_ROOT / worktree data outside the repo, ` +
            "or set GROK_BUILD_ALLOW_WEAK_ISOLATE=1 to proceed with weaker isolation."
        );
      }
      request.onProgress?.({
        message: `Warning: ${message} Continuing because GROK_BUILD_ALLOW_WEAK_ISOLATE=1.`,
        phase: "starting"
      });
    } else {
      permissionOptions.denyRules = [
        ...(permissionOptions.denyRules ?? []),
        ...denyPlan.rules
      ];
    }
    // Isolated writes require --confine unless the operator opts into weak isolate.
    // GROK_BUILD_CONFINE=0 is not a silent skip — it needs ALLOW_WEAK_ISOLATE=1.
    const confineWanted = confineFeatureEnabled(process.env);
    const allowWeakConfine =
      String(process.env.GROK_BUILD_ALLOW_WEAK_ISOLATE ?? "").trim() === "1" ||
      String(process.env.GROK_BUILD_ALLOW_WEAK_ISOLATE ?? "")
        .trim()
        .toLowerCase() === "true";
    if (!confineWanted) {
      const message =
        "GROK_BUILD_CONFINE=0 disables --confine on an isolated write; MCP/HTTP and Edit/Bash are not path-jailed.";
      if (!allowWeakConfine) {
        throw new Error(
          `Isolated run requires --confine. ${message} ` +
            "Unset GROK_BUILD_CONFINE, or set GROK_BUILD_ALLOW_WEAK_ISOLATE=1."
        );
      }
      request.onProgress?.({
        message: `Warning: ${message} Continuing because GROK_BUILD_ALLOW_WEAK_ISOLATE=1.`,
        phase: "starting"
      });
    } else {
      const binary = resolveGrokBinary(process.env);
      if (cliSupportsConfine(binary, { env: process.env })) {
        permissionOptions.confine = created.worktreePath;
      } else {
        const message =
          `--confine not applied (CLI probe did not advertise --confine on \`${binary}\`); ` +
          "MCP path writes would not be path-jailed.";
        if (!allowWeakConfine) {
          throw new Error(
            `Isolated run requires --confine. ${message} ` +
              "Use a Turbo/Grok agent CLI that supports --confine, or set GROK_BUILD_ALLOW_WEAK_ISOLATE=1."
          );
        }
        request.onProgress?.({
          message: `Warning: ${message} Continuing because GROK_BUILD_ALLOW_WEAK_ISOLATE=1.`,
          phase: "starting"
        });
      }
    }
  }

  // H4: production max-duration kill fallbacks — bridge/worker/job pids when
  // progress never carried agentPid.
  const durationKillOptions = {
    getFallbackPids: () => {
      const pids = [];
      try {
        const stored = request.jobId ? readStoredJob(workspaceRoot, request.jobId) : null;
        for (const value of [
          stored?.agentPid,
          stored?.bridgePid,
          stored?.companionPid,
          stored?.pid,
          request.bridgePid,
          request.agentPid
        ]) {
          const n = Number(value);
          // `bridgePid`/`pid` on the job record are the RUNNER's own pid, so a
          // fallback kill would terminate this process before it could record
          // the timeout, commit the worktree, or claim a terminal status.
          if (Number.isFinite(n) && n > 0 && n !== process.pid && !pids.includes(n)) {
            pids.push(n);
          }
        }
      } catch {
        // ignore
      }
      return pids;
    }
  };

  const firstAgent = await runHeadlessAgentWithDurationBudget(
    runCwd,
    {
      prompt,
      resumeSessionId,
      // Pre-assigned so the log header and job record share the same sid that
      // ~/.grok/logs/unified.jsonl keys on (BRIDGE-5).
      sessionId: resumeSessionId ? undefined : assignedSessionId ?? undefined,
      model: request.model,
      effort: request.effort,
      ...permissionOptions,
      maxTurns,
      // Report contract always; isolation preamble only when we actually have a
      // worktree. Only on the FIRST turn: a fix turn given the same contract
      // emits a report about the fix, and the newest non-empty report wins
      // below - which would discard the main run's answer.
      rules: loadRunRules({
        isolated: Boolean(created),
        worktreePath: created?.worktreePath ?? null,
        workspaceRoot,
        blenderSandbox: blenderSandboxInfo
      }),
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
    maxDurationSeconds,
    durationKillOptions
  );
  let result = firstAgent.result;
  if (created && permissionOptions.confine) {
    const start = result?.start;
    // Only fail-closed when Turbo actually emitted a start card (schemaVersion
    // set) with confineRoot omitted. Fake/pre-rc2 streams have no start event.
    if (start && start.schemaVersion != null && !start.confineRoot) {
      const allowWeak =
        String(process.env.GROK_BUILD_ALLOW_WEAK_ISOLATE ?? "").trim() === "1" ||
        String(process.env.GROK_BUILD_ALLOW_WEAK_ISOLATE ?? "")
          .trim()
          .toLowerCase() === "true";
      const message =
        "Isolated run advertised --confine but Turbo start.confineRoot is missing; the process is not path-jailed.";
      if (!allowWeak) {
        throw new Error(`${message} Set GROK_BUILD_ALLOW_WEAK_ISOLATE=1 to accept weaker isolation.`);
      }
      request.onProgress?.({
        phase: "starting",
        message: `Warning: ${message} Continuing because GROK_BUILD_ALLOW_WEAK_ISOLATE=1.`
      });
    }
  }
  if (firstAgent.termination?.treeOutlivedKill) {
    request.onProgress?.({
      phase: "finalizing",
      message: "Max duration expired; the agent process tree outlived the kill attempt and may still be running."
    });
  }
  // Every agent turn this run makes, in order. `result` keeps tracking only the
  // LAST one, because status, threadId, stopReason and the stop condition all
  // belong to it - but the text channel must accumulate, which is what this is
  // for. Declared out here rather than inside the verify loop so a run with no
  // verify commands takes exactly the same path.
  const agentResults = [firstAgent.result];
  let timedOut = firstAgent.timedOut;
  let durationTermination = firstAgent.termination ?? null;
  let cumulativeUsage = result.usage ? { ...result.usage } : null;
  // HYPER-1: one auto-continue when the agent spent its turn asking a question
  // nobody will answer. Bound to exactly one retry — never loop.
  let autoContinued = false;
  if (
    !timedOut &&
    result.status === 0 &&
    result.threadId &&
    result.toolCallCount === 0 &&
    looksLikeUserQuestion(result.lastMessage || result.finalMessage || result.finalReport)
  ) {
    request.onProgress?.({
      phase: "running",
      message:
        "First turn ended on a user-facing question with zero tool calls; auto-continuing once (non-interactive)."
    });
    const continueAgent = await runHeadlessAgentWithDurationBudget(
      runCwd,
      {
        prompt: HEADLESS_AUTO_CONTINUE_NUDGE,
        resumeSessionId: result.threadId,
        model: request.model,
        effort: request.effort,
        ...permissionOptions,
        maxTurns,
        // No report/isolation rules on the nudge turn — it is an internal
        // continuation, and a second final-report would overwrite the real one.
        outputFormat: "streaming-json",
        onProgress: request.onProgress,
        env: runEnv,
        promptFileDir: resolveStateDir(workspaceRoot),
        cwd: runCwd
      },
      maxDurationSeconds,
      durationKillOptions
    );
    autoContinued = true;
    result = continueAgent.result;
    agentResults.push(continueAgent.result);
    cumulativeUsage = addUsage(cumulativeUsage, continueAgent.result.usage);
    if (continueAgent.timedOut) {
      timedOut = true;
      durationTermination = continueAgent.termination ?? durationTermination;
    }
  }

  // Cost is only known when a turn ends (from the end event's total_cost_usd),
  // so max-cost is a post-hoc stop — not a pre-emptive cap. The run stops before
  // the *next* turn / verify re-invoke rather than mid-turn. Checked against the
  // running total across every call this run has made so far, not just the
  // latest one — otherwise N calls each individually under budget could
  // together spend well past maxCostUsd without ever tripping the stop.
  // Unknown/partial cost is never treated as $0: if a cap was requested but
  // cost is unmeasurable, record that the budget could not be enforced.
  let budgetStopped = null;
  if (
    !timedOut &&
    maxCostUsd != null &&
    cumulativeUsage?.costUsd != null &&
    Number.isFinite(Number(cumulativeUsage.costUsd)) &&
    Number(cumulativeUsage.costUsd) > maxCostUsd
  ) {
    budgetStopped = "max-cost";
  } else if (
    !timedOut &&
    maxCostUsd != null &&
    cumulativeUsage &&
    (cumulativeUsage.usageIsIncomplete ||
      cumulativeUsage.costIsPartial ||
      (cumulativeUsage.costUsd == null &&
        (Number(cumulativeUsage.inputTokens) > 0 ||
          Number(cumulativeUsage.outputTokens) > 0 ||
          Number(cumulativeUsage.modelCalls) > 0)))
  ) {
    budgetStopped = "max-cost-unenforceable";
  }

  let verified = null;
  let verifyNote = null;
  /** @type {object[]} */
  let verifyResults = [];
  /** @type {object[]} */
  let verifyFixAttempts = [];
  let attempt = 0;

  // FIELD-2: the task-turn deliverable must survive the fix loop. Capture the
  // primary answer NOW (after auto-continue, before any fix turn) so a fix
  // turn's ===GROK-FINAL-REPORT=== cannot replace the work the user asked for.
  const primaryTaskDeliverable = {
    finalReport:
      agentResults
        .map((entry) => (typeof entry?.finalReport === "string" ? entry.finalReport : ""))
        .filter(Boolean)[0] ?? "",
    lastMessage:
      agentResults
        .map((entry) => (typeof entry?.lastMessage === "string" ? entry.lastMessage : ""))
        .filter(Boolean)[0] ?? "",
    threadId: result.threadId ?? null,
    status: result.status
  };

  if (verifyDropped.length > 0 && verifyCommands.length === 0) {
    verified = true;
    verifyNote = "all auto-derived verify commands were already failing at baseline and were dropped as pre-existing-failure";
  } else if (verifySkippedReadOnly) {
    verified = null;
    verifyNote = "skipped (read-only run)";
  } else if (!timedOut && verifyCommands.length > 0) {
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
        // Shared Godot cache: hold the cross-process lock for the whole command
        // so two concurrent grok-build imports cannot clobber
        // global_script_class_cache.cfg. Private caches skip the lock entirely.
        let godotLock = null;
        if (sharedGodotCachePath && /\bgodot\b/i.test(command)) {
          godotLock = await acquireGodotCacheLock(sharedGodotCachePath, {
            onWaiting: (message) => request.onProgress?.({ phase: "verifying", message })
          });
        }
        let outcome;
        try {
          outcome = await runVerifyCommand(command, runCwd, {
            env: runEnv,
            timeoutMs,
            maxOutputBytes: verifyTiming.maxOutputBytes ?? undefined,
            outputFailurePatterns,
            // Must mirror the baseline probe above: passing this to
            // summarizeFailures alone (as shipped) left detectOutputFailures
            // ungated, so an "ignored" line still set outcome.ok:false and then
            // produced an empty, incomparable signature - a diagnosis strictly
            // worse than not ignoring the line at all.
            ignorePatterns: verifyIgnorePatterns
          });
        } finally {
          godotLock?.release();
        }
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
          // A non-zero exit with two empty streams. Recorded, never merged
          // into `output` - see runVerifyCommand. Without it a silent Godot
          // build produces a run record in which the only evidence is an
          // absence, which nobody reading the JSON afterwards can interpret.
          ...(outcome.noOutput ? { noOutput: true, advisory: outcome.advisory } : {}),
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
          // A truncated capture is a sample of the failures, not the set of
          // them, so it carries the same "no comparable verdict" weight as the
          // legacy buffer overflow above. Recorded on the entry already; this
          // is what makes the classifier act on it.
          elidedBytes: outcome.elidedBytes,
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
          const preExisting = iterationResults.filter(
            (entry) =>
              !entry.ok &&
              (entry.attribution === "pre-existing-failure" ||
                entry.attribution === "baseline-already-failing" ||
                entry.attribution === "unchanged-from-baseline" ||
                entry.failureSource === "baseline")
          );
          if (preExisting.length > 0 && preExisting.length === iterationResults.filter((e) => !e.ok).length) {
            verifyNote =
              "pre-existing-failure: command(s) already failed at baseline; not this run's responsibility (no fix turn, status not downgraded)";
          } else {
            verifyNote =
              "remaining failures are unchanged from baseline or could not be attributed to this run";
          }
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
          prompt: buildBoundedVerifyFixPrompt(firstBlamed.command, firstBlamed.output, {
            outputFailure: firstBlamed.outputFailure,
            matchedLines: firstBlamed.matchedLines
          }),
          resumeSessionId: result.threadId,
          model: request.model,
          effort: request.effort,
          // Mirror the ORIGINAL run's write policy AND isolation deny/confine
          // exactly. Escalating a read-only verify fix to a write run used to
          // edit the real tree; dropping deny rules on a fix turn would re-open
          // the main checkout hole the first turn closed.
          ...permissionOptions,
          maxTurns,
          cwd: runCwd,
          outputFormat: "streaming-json",
          promptFileDir: resolveStateDir(workspaceRoot),
          // Same overrides as the first turn: the fix turn re-runs the very
          // command that just failed.
          env: runEnv,
          onProgress: request.onProgress
        },
        maxDurationSeconds,
        durationKillOptions
      );
      // FIELD-2: accumulate, do not replace. Keep the task-turn deliverable on
      // `result`; record the fix turn separately so show renders the real
      // answer first and the fix history after.
      verifyFixAttempts.push({
        attempt: attempt + 1,
        command: firstBlamed.command,
        finalReport:
          typeof fixAgent.result?.finalReport === "string" ? fixAgent.result.finalReport : "",
        lastMessage:
          typeof fixAgent.result?.lastMessage === "string" ? fixAgent.result.lastMessage : "",
        status: fixAgent.result?.status ?? null,
        stopReason: fixAgent.result?.stopReason ?? null,
        threadId: fixAgent.result?.threadId ?? null
      });
      agentResults.push(fixAgent.result);
      // Advance session/status plumbing only — never finalReport / lastMessage.
      result = {
        ...result,
        threadId: fixAgent.result?.threadId ?? result.threadId,
        status: fixAgent.result?.status ?? result.status,
        stopReason: fixAgent.result?.stopReason ?? result.stopReason,
        stderr: fixAgent.result?.stderr ?? result.stderr,
        // Preserve the primary task deliverable explicitly.
        finalReport: primaryTaskDeliverable.finalReport || result.finalReport,
        lastMessage: primaryTaskDeliverable.lastMessage || result.lastMessage
      };
      cumulativeUsage = addUsage(cumulativeUsage, fixAgent.result.usage);
      if (fixAgent.timedOut) {
        timedOut = true;
        durationTermination = fixAgent.termination ?? durationTermination;
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
  /** @type {object|null} */
  let changedFiles = null;
  /** @type {{entries: string[], total: number, truncated: boolean}|null} */
  let isolationLeak = null;
  let isolationBreached = false;
  /** @type {{entries: string[], total: number, truncated: boolean}|null} */
  let debris = null;

  // Early collect: needed for the progress line before the full stream aggregate.
  const earlyConfineViolations = agentResults.flatMap((entry) =>
    Array.isArray(entry?.confineViolations) ? entry.confineViolations : []
  );
  // WP-B7-FIX rule (do not re-merge these):
  // - Blocked confine attempts alone (CLI reported confine_violation, main tree
  //   clean) → NOT a breach. The defence worked; the write never dirtied main.
  //   Surface the signal; leave isolationBreached false so the run stays
  //   landable and can still be verified.
  // - Main checkout actually changed (dirty-set diff below, or shared-dir
  //   fingerprint) → BREACH on that strength alone, whether or not the CLI
  //   also reported blocked attempts.
  // Hyper already caught escape attempts on the wire — report them clearly
  // even when the dirty-set diff cannot (blocked writes never dirty main).
  if (earlyConfineViolations.length > 0) {
    const n = earlyConfineViolations.length;
    request.onProgress?.({
      message:
        `${n} confine attempt${n === 1 ? "" : "s"} blocked by the CLI (isolation held).`,
      phase: "finalizing"
    });
  }

  // Breach detection: any path newly dirty in the MAIN checkout after an
  // isolated run means the agent wrote outside the worktree. artifact excludes
  // are applied by porcelainChangeEntries. Separately, shared (junctioned)
  // read-mostly dirs are fingerprinted because git status never lists them.
  // H5: if baseline or post porcelain is null, treat isolation as unreliable
  // (fail closed) rather than silently non-breached.
  let mainTreeSide = null;
  let isolationStatusUnreliable = false;
  if (created) {
    if (!mainDirtyBeforeRunPaths) {
      isolationStatusUnreliable = true;
      isolationBreached = true;
      isolationLeak = {
        entries: ["? git-status-unavailable-before-run"],
        total: 1,
        truncated: false
      };
      request.onProgress?.({
        message:
          "Isolation BREACHED (fail-closed): main-checkout git status was unreadable before the run; cannot prove the agent stayed in the worktree.",
        phase: "finalizing"
      });
    } else {
      const mainAfter = porcelainChangeEntries(workspaceRoot);
      if (!mainAfter) {
        isolationStatusUnreliable = true;
        isolationBreached = true;
        isolationLeak = {
          entries: ["? git-status-unavailable-after-run"],
          total: 1,
          truncated: false
        };
        request.onProgress?.({
          message:
            "Isolation BREACHED (fail-closed): main-checkout git status was unreadable after the run; cannot prove the agent stayed in the worktree.",
          phase: "finalizing"
        });
      } else {
        const leaked = [];
        for (const [filePath, letter] of mainAfter) {
          if (mainDirtyBeforeRunPaths.has(filePath)) {
            continue;
          }
          leaked.push(`${letter}\t${filePath}`);
        }
        const { work: mainWork, debris: mainDebris } = partitionWorkAndDebris(leaked);
        if (mainDebris.length > 0) {
          debris = capChangedFiles(mainDebris);
        }
        if (mainWork.length > 0) {
          isolationBreached = true;
          isolationLeak = capChangedFiles(mainWork);
          mainTreeSide = {
            ...isolationLeak,
            emptyReason: null
          };
          request.onProgress?.({
            message: `Isolation BREACHED: ${isolationLeak.total} path(s) changed in the main checkout during this run (agent escape, or a concurrent edit of your own).`,
            phase: "finalizing"
          });
        } else {
          mainTreeSide = {
            entries: [],
            total: 0,
            truncated: false,
            emptyReason: emptyChangeReason(workspaceRoot, mainDirtyBeforeRunPaths)
          };
        }
      }
    }
  }
  void isolationStatusUnreliable;

  // Post-run assertion on SHARED (read-mostly) provision dirs in the main
  // checkout. A mutation here is an isolation leak that git porcelain cannot
  // see — fail the run loudly with the paths that changed.
  if (created && sharedDirFingerprintsBefore) {
    const sharedNames = Object.keys(sharedDirFingerprintsBefore);
    const afterFp = fingerprintSharedDirs(workspaceRoot, sharedNames);
    const changedShared = diffSharedFingerprints(sharedDirFingerprintsBefore, afterFp);
    if (changedShared.length > 0) {
      isolationBreached = true;
      const sharedEntries = changedShared.map((name) => `M\t${name}/ (shared provision dir mutated in main checkout)`);
      if (isolationLeak) {
        isolationLeak = capChangedFiles([
          ...(isolationLeak.entries ?? []),
          ...sharedEntries
        ]);
      } else {
        isolationLeak = capChangedFiles(sharedEntries);
      }
      if (!mainTreeSide || mainTreeSide.total === 0) {
        mainTreeSide = {
          ...isolationLeak,
          emptyReason: null
        };
      }
      const leakNote = `Isolation BREACHED: shared provision dir(s) mutated in the main checkout: ${changedShared.join(", ")}`;
      request.onProgress?.({
        message: leakNote,
        phase: "finalizing"
      });
      provisionSummary = provisionSummary ?? { provisioned: [], failed: [], notes: [] };
      provisionSummary.notes.push(leakNote);
    }
  }

  if (created && uidSnapshotBefore) {
    // Post-run .uid integrity: deleted/rewritten companions or dangling
    // uid:// refs. Prominence matters — this is the most damaging silent
    // Godot failure and looks like a normal file change in the manifest.
    // Must use the same root as the pre-run snapshot (nested projectDir).
    uidIntegrity = checkUidIntegrity(
      uidSnapshotBefore,
      uidSnapshotRoot ?? created.worktreePath
    );
    if (!uidIntegrity.ok) {
      for (const note of uidIntegrity.notes) {
        request.onProgress?.({ phase: "finalizing", message: note });
        provisionSummary = provisionSummary ?? { provisioned: [], failed: [], notes: [] };
        provisionSummary.notes.push(note);
      }
    }
  }

  if (created) {
    const committed = commitWorktreeChanges(
      created.worktreePath,
      `grok-build ${request.jobId}`
    );
    // The manifest is `baseSha..HEAD`, NOT "what the bridge just committed".
    //
    // This used to be gated on `committed.committed`, which quietly reported an
    // empty change set for the one case that matters most: an agent that commits
    // its own work inside the worktree. commitWorktreeChanges then finds a clean
    // tree and returns {committed:false, sha:HEAD} - indistinguishable, under the
    // old gate, from a run that produced nothing. Observed live on a run that
    // made three commits and 17 file changes and was recorded as `total: 0`;
    // under the completed-noop rule that would now downgrade a perfectly good
    // run to a no-op. Compare the SHAs instead: HEAD moving off the base is the
    // only reliable evidence that this run produced commits, whoever made them.
    //
    // A commit that FAILED is left as null (unknown), never as an empty set:
    // the work is still on disk in the worktree and "changed nothing" would be a
    // lie about it.
    let worktreeSide = null;
    if (committed.sha && committed.sha !== created.baseSha) {
      const listed = listCommittedChanges(created.worktreePath, created.baseSha, committed.sha);
      // A diff that failed is NOT an empty change set - reporting "none" for it
      // would claim the run produced nothing when nobody managed to look.
      if (!listed.error) {
        const { work, debris: commitDebris } = partitionWorkAndDebris(listed.entries ?? []);
        // Debris is not in the commit by definition; residual uncommitted debris
        // is collected from the worktree working tree below.
        //
        // `listed` was ALREADY capped by listCommittedChanges, so re-capping
        // its entries recomputed `total` from the sample: a 250-file run
        // reported "files changed: 200" and persisted `truncated: false` — a
        // truncated sample presented as the exact count. Carry the upstream
        // total and truncation forward instead. When the upstream cap fired we
        // cannot know the work/debris split beyond the sample, so the honest
        // report is the upper bound plus `truncated: true`.
        const cappedWorkSide = capChangedFiles(work);
        worktreeSide = {
          ...cappedWorkSide,
          total: listed.truncated ? listed.total : cappedWorkSide.total,
          truncated: cappedWorkSide.truncated || Boolean(listed.truncated),
          emptyReason: null
        };
        void commitDebris;
      }
    } else if (!committed.error) {
      worktreeSide = {
        entries: [],
        total: 0,
        truncated: false,
        emptyReason: emptyChangeReason(created.worktreePath)
      };
    }

    // Uncommitted residue left in the worktree after the commit attempt
    // (BRIDGE-12). Debris is tracked separately; real work that never made it
    // into a commit (failed commit, mid-run stop) becomes the measured
    // worktreeSide so we never claim "nothing written" for files still on disk.
    const residual = porcelainChangeEntries(created.worktreePath);
    if (residual) {
      const residualEntries = [];
      for (const [filePath, letter] of residual) {
        residualEntries.push(`${letter}\t${filePath}`);
      }
      const { work: residualWork, debris: residualDebris } =
        partitionWorkAndDebris(residualEntries);
      if (residualDebris.length > 0) {
        const capped = capChangedFiles(residualDebris);
        debris = debris
          ? capChangedFiles([...(debris.entries ?? []), ...capped.entries])
          : capped;
      }
      if (worktreeSide == null && residualWork.length > 0) {
        worktreeSide = { ...capChangedFiles(residualWork), emptyReason: null };
      }
    }

    // Dual accounting (BRIDGE-3): never conflate worktree and main-tree counts.
    // Status uses the SUM so a main-only write is never completed-noop.
    //
    // CRITICAL: never substitute 0 for an unknown side. When commit fails,
    // worktreeSide stays null; mainTreeSide is often a measured empty map from
    // breach detection. Summing (null→0) + 0 produced total:0 and completed-noop
    // / "nothing-written" while real work sat uncommitted in the worktree.
    // Unknown worktree side ⇒ unknown combined total (null), never a sum.
    const combinedTotal =
      worktreeSide == null
        ? null
        : mainTreeSide == null
          ? Number(worktreeSide.total ?? 0)
          : Number(worktreeSide.total ?? 0) + Number(mainTreeSide.total ?? 0);
    changedFiles = {
      source: "dual",
      worktree: worktreeSide,
      mainTree: mainTreeSide,
      // Legacy flat fields for older consumers / decideCompletionStatus.
      entries: worktreeSide?.entries ?? [],
      total: combinedTotal,
      truncated: Boolean(worktreeSide?.truncated || mainTreeSide?.truncated),
      commitError: committed.error ?? null,
      emptyReason:
        combinedTotal === 0
          ? worktreeSide?.emptyReason ?? mainTreeSide?.emptyReason ?? "nothing-written"
          : null
    };

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
      changedFiles: worktreeSide?.entries ?? null,
      changedFileCount: combinedTotal,
      breached: isolationBreached,
      isolationLeak,
      // Dual lists for operator recovery on a split write (R7-1).
      worktreeFiles: worktreeSide?.entries ?? [],
      mainTreeFiles: mainTreeSide?.entries ?? isolationLeak?.entries ?? []
    };

    // R7-1: any work outside the worktree fails the run. Name BOTH file lists
    // so recovery is possible — a split state is worse than no isolation.
    if (isolationBreached) {
      const wtList = worktreeSide?.entries ?? [];
      const mainList = mainTreeSide?.entries ?? isolationLeak?.entries ?? [];
      const formatList = (entries) =>
        entries.length === 0
          ? "(none)"
          : entries
              .slice(0, 40)
              .map((e) => `    ${e}`)
              .join("\n") +
            (entries.length > 40 ? `\n    … ${entries.length - 40} more` : "");
      const recovery =
        `Recovery:\n` +
        `  1. Inspect both trees before touching either.\n` +
        `  2. Main-tree leaks (if still wanted): copy or re-apply them into the worktree at ${created.worktreePath}, then commit there.\n` +
        `  3. Do NOT run land on this job — land refuses a breached run so a partial worktree (e.g. deletions only) cannot destroy the main tree.\n` +
        `  4. After reconciling: land ${request.jobId ?? "<run-id>"} --discard to drop the worktree, or manually merge the complete change set.\n` +
        `  5. If the main-tree changes were concurrent human edits, re-check with git status and keep them; only the agent half is untrustworthy.`;
      request.onProgress?.({
        message:
          `Isolation BREACHED (split write): worktree has ${wtList.length} path(s); main checkout leaked ${mainList.length} path(s).\n` +
          `  In the worktree:\n${formatList(wtList)}\n` +
          `  Leaked to main checkout:\n${formatList(mainList)}\n` +
          recovery,
        phase: "finalizing"
      });
    }
  } else if (write) {
    const collected = collectWorkingTreeChanges(runCwd, dirtyBeforeRunPaths);
    if (collected) {
      debris = collected.debris?.total ? collected.debris : null;
      changedFiles = {
        source: "working-tree",
        worktree: null,
        mainTree: {
          entries: collected.entries,
          total: collected.total,
          truncated: collected.truncated,
          emptyReason: collected.emptyReason
        },
        entries: collected.entries,
        total: collected.total,
        truncated: collected.truncated,
        preexistingDirty: collected.preexistingDirty,
        emptyReason: collected.emptyReason
      };
    }
  }

  // FIELD-2: the run result must ACCUMULATE, not replace. Keep the first
  // task-turn report as the run's `result`. Fix-turn reports live in
  // verifyFixAttempts only — picking newestNonEmpty used to hand the caller a
  // note about `cargo test` instead of the 26 KB deliverable they asked for.
  const firstNonEmpty = (field) =>
    agentResults
      .map((entry) => (typeof entry?.[field] === "string" ? entry[field] : ""))
      .filter(Boolean)[0] ?? "";
  const finalReport =
    (primaryTaskDeliverable.finalReport && String(primaryTaskDeliverable.finalReport)) ||
    firstNonEmpty("finalReport");
  const lastMessage =
    (primaryTaskDeliverable.lastMessage && String(primaryTaskDeliverable.lastMessage)) ||
    firstNonEmpty("lastMessage");
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
  // Stream-channel aggregates — error / confine_violation / denials must not
  // die in the parser. Flatten across main + auto-continue + verify-fix turns.
  const streamErrors = agentResults.flatMap((entry) =>
    Array.isArray(entry?.streamErrors) ? entry.streamErrors : []
  );
  const confineViolations = agentResults.flatMap((entry) =>
    Array.isArray(entry?.confineViolations) ? entry.confineViolations : []
  );
  const toolDenials = agentResults.flatMap((entry) =>
    Array.isArray(entry?.toolDenials) ? entry.toolDenials : []
  );
  const compaction = agentResults.flatMap((entry) =>
    Array.isArray(entry?.compaction) ? entry.compaction : []
  );
  const toolActivity = agentResults.flatMap((entry) =>
    Array.isArray(entry?.toolActivity) ? entry.toolActivity : []
  );
  const maxTurnsReached = agentResults.some((entry) => entry?.maxTurnsReached);
  const streamStart = agentResults.map((entry) => entry?.start).find(Boolean) ?? null;
  const streamSchemaVersion =
    agentResults.map((entry) => entry?.streamSchemaVersion).find((v) => v != null) ??
    streamStart?.schemaVersion ??
    null;
  const agentFilesChanged =
    agentResults.map((entry) => entry?.filesChangedFromStream).filter(Boolean).at(-1) ?? null;
  // Sum tool calls across turns when every turn reported a number; if any turn
  // left the count unknown (null), the aggregate is unknown rather than a
  // partial sum that under-counts.
  let toolCallCount = null;
  if (agentResults.every((entry) => entry?.toolCallCount == null)) {
    toolCallCount = null;
  } else if (agentResults.some((entry) => entry?.toolCallCount == null)) {
    // At least one turn counted; treat missing turns as 0 only when siblings
    // had a real count (same session, same CLI vocabulary).
    toolCallCount = agentResults.reduce(
      (sum, entry) => sum + (Number.isFinite(Number(entry?.toolCallCount)) ? Number(entry.toolCallCount) : 0),
      0
    );
  } else {
    toolCallCount = agentResults.reduce((sum, entry) => sum + Number(entry.toolCallCount), 0);
  }
  // Visibility: unavailable when no turn reported a count and none saw tool events.
  let toolVisibility = "unavailable";
  if (agentResults.some((entry) => entry?.toolVisibility === "explicit")) {
    toolVisibility = "explicit";
  } else if (agentResults.some((entry) => entry?.toolVisibility === "observed" || entry?.toolCallCount != null)) {
    toolVisibility = "observed";
  }
  let toolCallCountFloor = null;
  for (const entry of agentResults) {
    const floor = entry?.toolCallCountFloor;
    if (floor != null && Number.isFinite(Number(floor))) {
      toolCallCountFloor = Math.max(toolCallCountFloor ?? 0, Number(floor));
    }
  }
  if (toolCallCountFloor == null && agentFilesChanged?.count != null && Number(agentFilesChanged.count) > 0) {
    toolCallCountFloor = Number(agentFilesChanged.count);
  }
  const stopReason = timedOut ? "max-duration" : (result.stopReason ?? null);
  const resolvedModel =
    cumulativeUsage?.resolvedModel ??
    agentResults.map((entry) => entry?.resolvedModel ?? entry?.usage?.resolvedModel).filter(Boolean).at(-1) ??
    null;
  // Once known, surface the served model on the header path via a late progress
  // line so logs show "requested -> served" without rewriting the opening lines.
  if (resolvedModel && request.model && String(resolvedModel) !== String(request.model)) {
    request.onProgress?.({
      message: `Model: ${request.model} -> ${resolvedModel}`,
      phase: "finalizing"
    });
  } else if (resolvedModel && !request.model) {
    request.onProgress?.({
      message: `Model: default -> ${resolvedModel}`,
      phase: "finalizing"
    });
  }
  // Total across BOTH trees feeds decideCompletionStatus (BRIDGE-3): a run that
  // wrote only into the main checkout is never completed-noop.
  const changedFileCount =
    changedFiles?.total != null
      ? Number(changedFiles.total)
      : worktree?.changedFileCount != null
        ? Number(worktree.changedFileCount)
        : write
          ? null
          : null;
  const failureMessage = timedOut
    ? `Run timed out after ${maxDurationSeconds}s (--max-duration).${result.stderr ? ` ${result.stderr}` : ""}`
    : result.status === 0
      ? ""
      : result.stderr || "";
  // Pre-compute the honest status so Verified: n/a lines can reference it in
  // the same rendered trailer the user sees at the end of a foreground run.
  // Only a measured 0 trips completed-noop; a failed/absent manifest stays null
  // so we do not invent "changed nothing" for a run we could not inspect.
  // `Number(null) === 0`, so the old `Number.isFinite(Number(total))` test was
  // TRUE for `total: null` and turned "we could not measure" into a measured
  // zero — the run reported "files changed: 0 / changed nothing", status
  // completed-noop, and the user's next move was land --discard on real work.
  // The null check has to come before the numeric one.
  const effectiveChangedFileCount =
    changedFileCount != null
      ? changedFileCount
      : changedFiles && changedFiles.total != null && Number.isFinite(Number(changedFiles.total))
        ? Number(changedFiles.total)
        : null;
  const durationMs = Date.now() - runStartedAtMs;
  const implausiblyShort = detectImplausiblyShort({
    write,
    durationMs,
    changedFileCount: effectiveChangedFileCount,
    toolCallCount,
    promptForbidsEdits: promptForbidsEdits(request.prompt),
    env: process.env
  });
  // Refresh the log header now that session id + served model are known.
  writeRunLogHeader(logFile, {
    runId: request.jobId ?? null,
    grokSessionId: result.threadId ?? initialSessionId,
    binary: availability.binary ?? resolveGrokBinary(),
    version: availability.detail ?? null,
    cliLabel: cliBrand.label,
    modelRequested: request.model ?? null,
    modelServed: resolvedModel,
    isolation: isolationHeader,
    workspaceRoot
  });
  let terminalStatus = decideCompletionStatus({
    timedOut,
    exitStatus: timedOut ? 1 : result.status,
    stopReason,
    toolCallCount,
    changedFileCount: effectiveChangedFileCount,
    write,
    // A breach never reports Verified: yes, even if the worktree verify loop
    // passed — that verify only saw the worktree, not the leaked paths.
    verified: isolationBreached ? false : verified,
    hadWork: Boolean(prompt),
    isolationBreached
  });

  // Pull any children the agent started mid-run (MCP nest-run patches the
  // parent job). Re-read rather than trusting an empty in-memory list.
  let children = [];
  if (request.jobId) {
    try {
      const jobFile = resolveJobFile(workspaceRoot, request.jobId);
      if (fs.existsSync(jobFile)) {
        const live = readJobFile(jobFile);
        if (Array.isArray(live?.children)) {
          children = live.children;
        }
      }
    } catch {
      children = Array.isArray(request.children) ? request.children : [];
    }
  }

  // End-of-run children policy: drain live nested runs up to a bound, then
  // cancel survivors so the parent's terminal record is not frozen with
  // "running" children that nobody will ever reap (platform-symmetric).
  if (request.jobId && children.length > 0) {
    children = await drainNestedChildrenAtParentEnd(workspaceRoot, request.jobId, children, {
      onProgress: request.onProgress
    });
  }
  // A parent with failed/abandoned children cannot claim plain completed.
  terminalStatus = applyChildrenToCompletionStatus(terminalStatus, children);

  const usageBreakdown = aggregateUsageOwnVsNested(cumulativeUsage, children);

  // Aggregate stream-only fields from agent turns (WP-B8 schemaVersion 2).
  const streamWarnings = agentResults.flatMap((entry) =>
    Array.isArray(entry?.streamWarnings) ? entry.streamWarnings : []
  );
  const questionsSuppressed = agentResults.flatMap((entry) =>
    Array.isArray(entry?.questionsSuppressed) ? entry.questionsSuppressed : []
  );
  const subagentsFromStream = agentResults.flatMap((entry) =>
    Array.isArray(entry?.subagents) ? entry.subagents : []
  );
  const subagentsRollup =
    agentResults.map((entry) => entry?.subagentsRollup).filter(Boolean).at(-1) ?? null;

  const statusMeta = {
    title: taskMetadata.title,
    jobId: request.jobId ?? null,
    logFile,
    streamParsed,
    unknownEventTypes,
    streamErrors,
    errors: streamErrors,
    confineViolations,
    toolDenials,
    streamWarnings,
    questionsSuppressed,
    subagents: subagentsFromStream,
    subagentsRollup,
    compaction,
    maxTurnsReached,
    changedFiles,
    // Scalar for R7-4 honesty header (files changed: N).
    changedFileCount: effectiveChangedFileCount,
    debris,
    write,
    verified: isolationBreached ? false : verified,
    verifyNote: isolationBreached
      ? "isolation breached — work is in the main checkout, not the worktree"
      : verifyNote,
    status: terminalStatus,
    stopReason,
    usage: cumulativeUsage ?? null,
    model: request.model ?? null,
    resolvedModel,
    isolationBreached,
    isolationLeak,
    implausiblyShort,
    durationMs,
    durationSeconds: durationMs / 1000,
    toolCallCount,
    toolCallCountFloor,
    toolVisibility,
    autoContinued,
    // Which command(s) tripped an exit-0 output-failure marker, and what
    // matched - the only evidence available without reading --json for
    // a command whose exit code alone says it passed. Computed here
    // rather than filtered inside buildTaskStatusLines so a render-only
    // caller (e.g. a stored job re-rendered later) sees the same list a
    // live run would have.
    verifyMatchedLines: verifyResults
      .filter((entry) => Array.isArray(entry.matchedLines) && entry.matchedLines.length > 0)
      .map((entry) => ({ command: entry.command, matchedLines: entry.matchedLines })),
    // R7-3: commands the ecosystem default proposed and then dropped because
    // they were already failing at baseline. Reported so a dropped command is
    // visible rather than silently absent.
    verifyDropped,
    // R7-4: per-command results + baselines so the status line can say
    // `verify 2/3 (baseline 2/3)` instead of a boolean Verified: yes.
    verifyResults,
    baselines,
    // The visibility half of the item-4 trust story: a run that verifies
    // commands the user never typed has to say which commands, and where
    // they came from, in the same block that reports the verdict.
    verifyCommands,
    verifyPlan,
    verifyTrustCommand: TRUST_CONFIG_COMMAND,
    baselineProbeMs,
    baselineProbeCommands: baselines.length,
    blenderVersion: blenderVersionNote,
    runtimePlugin: runtimePluginPacks ? { packs: runtimePluginPacks } : null,
    worktree,
    provision: provisionSummary,
    budgetStopped,
    durationTermination,
    children,
    usageBreakdown
  };
  // Persist status lines separately so `show` can re-emit the trailer without
  // string-surgery on the full rendered body (and without losing it when the
  // answer is preferred over rendered).
  const statusLines = buildTaskStatusLines(statusMeta, rawOutput);
  if (verifyDropped.length > 0) {
    statusLines.push(
      `Verify baseline: dropped ${verifyDropped.length} auto-derived command${verifyDropped.length === 1 ? "" : "s"} already failing at baseline (pre-existing noise).`
    );
  }

  const rendered = timedOut
    ? `${failureMessage}\n${rawOutput ? `\n${rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`}` : ""}${
        statusLines.length ? `\n${statusLines.join("\n")}\n` : ""
      }`
    : renderTaskResult(
        {
          rawOutput,
          failureMessage,
          // Only ever shown when there is no answer at all: a truncated or
          // rate-limited response exits 0 with empty text and puts the only
          // explanation on the channel that used to be dropped.
          stderr: result.stderr ?? ""
        },
        statusMeta
      );

  const verify = {
    commands: verifyCommands,
    // Where the command list came from - cli, the project config, an ecosystem
    // default, or nothing. Persisted because "why did this run verify that?"
    // is otherwise unanswerable after the fact.
    plan: verifyPlan,
    attempts: attempt,
    note: verifyNote,
    dropped: verifyDropped,
    // Read-only runs skip baseline + verify entirely (FIELD-3).
    skippedReadOnly: Boolean(verifySkippedReadOnly),
    // Fix-turn reports only — never the task deliverable (FIELD-2).
    fixAttempts: verifyFixAttempts,
    // The probe is now unconditional on write runs, so on a non-isolated write
    // it doubles the verify wall clock. That cost has to be visible.
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
    results: verifyResults,
    // Blender binary the verify actually ran against (when probed).
    blenderVersion: blenderVersionNote,
    // Isolated Godot: .uid integrity after the agent finished.
    uidIntegrity: uidIntegrity
      ? {
          ok: uidIntegrity.ok,
          deleted: uidIntegrity.deleted,
          rewritten: uidIntegrity.rewritten,
          danglingRefs: uidIntegrity.danglingRefs,
          notes: uidIntegrity.notes
        }
      : null,
    // Which capability pack was copied into the worktree for the agent.
    runtimePlugin: runtimePluginPacks
      ? { packs: runtimePluginPacks }
      : null
  };

  const budget = {
    maxDurationSeconds,
    maxTurns,
    maxCostUsd,
    timedOut,
    budgetStopped,
    durationTermination
  };

  const exitStatus = timedOut ? 1 : result.status;

  const payload = {
    status: exitStatus,
    threadId: result.threadId,
    usage: cumulativeUsage ?? null,
    usageBreakdown,
    children,
    parentRunId: request.parentRunId ?? null,
    nestDepth: request.nestDepth ?? 0,
    stopReason,
    toolCallCount,
    toolCallCountFloor,
    toolVisibility,
    toolActivity,
    changedFileCount: effectiveChangedFileCount,
    model: request.model ?? null,
    resolvedModel,
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
    // Status trailer facts as an array so show re-emits without string surgery.
    statusLines,
    // Kept even on a zero exit. "Exited 0, said nothing, warned on stderr" is
    // the exact shape of a truncated response, and dropping the warning left
    // the run inexplicable.
    stderr: result.stderr ?? "",
    // Did the streaming parser understand the CLI, and what did it not
    // understand? Both were computed and had no consumer at all, so a grok
    // release that renames an event type degraded output silently.
    streamParsed,
    unknownEventTypes,
    streamErrors,
    confineViolations,
    toolDenials,
    streamWarnings,
    questionsSuppressed,
    subagents: subagentsFromStream,
    subagentsRollup,
    compaction,
    maxTurnsReached,
    start: streamStart,
    streamSchemaVersion,
    agentFilesChanged,
    // Where the durable copy of this run's rendered result lives.
    logFile,
    // What the run changed on disk - the deliverable itself for an engine
    // project. Null when there was nothing to measure (a read-only run) or
    // nobody could measure it (a failed commit or diff). Dual-tree shape when
    // isolated (BRIDGE-3).
    changedFiles,
    // Unaccounted debris left on disk and not committed (BRIDGE-12).
    debris: debris ?? { entries: [], total: 0, truncated: false },
    implausiblyShort,
    durationMs,
    autoContinued,
    verified: isolationBreached ? false : verified,
    worktree,
    isolationBreached,
    isolationLeak,
    isolateSource,
    isolation: {
      active: Boolean(created),
      worktree: created?.worktreePath ?? worktree?.path ?? null,
      branch: created?.branchName ?? worktree?.branch ?? null,
      baseSha: created?.baseSha ?? worktree?.baseSha ?? null,
      headSha: worktree?.sha ?? null,
      breached: isolationBreached,
      source: isolateSource
    },
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

  // Nested child: mirror final summary onto the parent's children[] so the
  // parent's report can list status/usage/report without re-scanning every
  // job file. A child failure never fails the parent process — only updates
  // the linkage (parent terminal status is adjusted separately at parent end).
  if (request.parentRunId && request.jobId) {
    try {
      linkChildOutcomeToParent(workspaceRoot, request.parentRunId, {
        id: request.jobId,
        status: terminalStatus,
        verified: isolationBreached ? false : verified,
        changedFileCount: effectiveChangedFileCount,
        changedFiles,
        usage: cumulativeUsage ?? null,
        worktree,
        finalReport: typeof finalReport === "string" ? finalReport : null
      });
    } catch {
      // Parent may already be terminal/pruned; never fail the child over it.
    }
  }

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
      // /turbo-build-plugin:runs. rawOutput stays as the fallback for a run that
      // produced no trailing prose at all.
      : summarizeFinalReport(finalReport) ||
        firstMeaningfulLine(
          lastMessage || rawOutput,
          firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)
        ),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write,
    verified: isolationBreached ? false : verified,
    worktree,
    isolationBreached,
    isolationLeak,
    isolateSource,
    isolation: {
      active: Boolean(created),
      worktree: created?.worktreePath ?? worktree?.path ?? null,
      branch: created?.branchName ?? worktree?.branch ?? null,
      baseSha: created?.baseSha ?? worktree?.baseSha ?? null,
      headSha: worktree?.sha ?? null,
      breached: isolationBreached,
      source: isolateSource
    },
    grokVersion,
    verify,
    usage: cumulativeUsage ?? null,
    usageBreakdown,
    children,
    parentRunId: request.parentRunId ?? null,
    nestDepth: request.nestDepth ?? 0,
    stopReason,
    toolCallCount,
    changedFileCount: effectiveChangedFileCount,
    model: request.model ?? null,
    resolvedModel,
    implausiblyShort,
    durationMs,
    autoContinued,
    debris: debris ?? { entries: [], total: 0, truncated: false },
    hadWork: Boolean(prompt)
  };
}

/**
 * At parent end-of-run: wait for live nested children up to
 * GROK_BUILD_NEST_DRAIN_SECONDS, then cancel any survivors and re-read the
 * children[] snapshot for the terminal report.
 */
async function drainNestedChildrenAtParentEnd(workspaceRoot, parentRunId, children, options = {}) {
  let live = Array.isArray(children) ? [...children] : [];
  const drainSeconds = readNestDrainSeconds(process.env);
  const pollMs = 500;
  const deadline = Date.now() + drainSeconds * 1000;

  const refresh = () => {
    try {
      const stored = readStoredJob(workspaceRoot, parentRunId);
      if (Array.isArray(stored?.children)) {
        live = stored.children;
      }
    } catch {
      // keep last snapshot
    }
    // Also refresh each non-terminal child from its job file so status/usage
    // are current even if linkChildOutcomeToParent has not run yet.
    live = live.map((entry) => {
      const id = entry?.runId ?? entry?.id;
      if (!id || (entry?.status && isTerminalJobStatus(entry.status))) {
        return entry;
      }
      const childStored = readStoredJob(workspaceRoot, id);
      if (!childStored) {
        return entry;
      }
      return buildChildSummary(childStored);
    });
    return listNonTerminalChildIds(live);
  };

  let pending = refresh();
  if (pending.length === 0) {
    return live;
  }

  options.onProgress?.({
    phase: "finalizing",
    message: `Waiting for ${pending.length} nested child run(s) (drain ${drainSeconds}s)…`
  });

  while (pending.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    pending = refresh();
  }

  if (pending.length > 0) {
    options.onProgress?.({
      phase: "finalizing",
      message: `Cancelling ${pending.length} nested child run(s) still live after drain…`
    });
    for (const childId of pending) {
      try {
        const childStored = readStoredJob(workspaceRoot, childId);
        const record = childStored ?? { id: childId, status: "running" };
        if (isTerminalJobStatus(record.status)) {
          continue;
        }
        // C22: snapshot the full nested tree PIDs (grandchildren included), claim
        // descendants cancelled, then kill — same order as cancelJobTree (C21).
        // terminateJobProcessTrees(record) alone only killed the direct child's
        // own PIDs and left deeper nest agents running.
        const treeCancel = claimJobTreeDescendantsCancelled(workspaceRoot, record, {
          childErrorMessage: "Cancelled by parent end-of-run drain (nested descendant)."
        });
        const ownPids = resolveJobKillTargets(record);
        const killPids = [...new Set([...treeCancel.pids, ...ownPids])];
        claimJobTerminal(workspaceRoot, childId, "cancelled", {
          errorMessage: "Cancelled by parent end-of-run drain.",
          phase: "cancelled",
          pid: null,
          agentPid: null,
          bridgePid: null
        });
        terminateJobProcessTrees(record, { pids: killPids });
        linkChildOutcomeToParent(workspaceRoot, parentRunId, {
          id: childId,
          status: "cancelled",
          changedFileCount: record.changedFileCount ?? null,
          usage: record.usage ?? null,
          worktree: record.worktree ?? null,
          finalReport: null
        });
      } catch {
        // Best-effort; continue other children.
      }
    }
    refresh();
  }

  // Persist the refreshed children list on the parent while it is still active.
  try {
    patchJobIfActive(workspaceRoot, parentRunId, { children: live });
  } catch {
    // ignore
  }
  return live;
}

/**
 * Record or refresh a child entry on the parent job (file + index).
 * Best-effort: a missing parent is ignored. Prefer patchJobIfActive while the
 * parent is still running; fall back to a terminal-safe write when it is not.
 */
function linkChildOutcomeToParent(workspaceRoot, parentRunId, childJob) {
  if (!workspaceRoot || !parentRunId || !childJob?.id) {
    return;
  }
  const parentFile = resolveJobFile(workspaceRoot, parentRunId);
  if (!fs.existsSync(parentFile)) {
    return;
  }
  // Read-merge-write inside ONE lock. Reading `parent.children` outside the
  // lock and passing the whole array to patchJobIfActive meant two concurrent
  // children each merged into the same snapshot and the last write erased the
  // other — a live child then existed that the parent's drain and /stop could
  // not see. mergeChildEntry also persists for a terminal parent, so `show
  // <parent>` still lists the child after both finished.
  mergeChildEntry(workspaceRoot, parentRunId, (children) =>
    upsertChildEntry(children, buildChildSummary(childJob))
  );
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
  const lines = [
    `${payload.title} started in the background as ${payload.jobId}. Check /turbo-build-plugin:runs ${payload.jobId} for progress.`
  ];
  // Same disclosure as the JSON payload's verify.baseline: a queued run that
  // spends its first minutes in a pre-agent baseline should say so while the
  // operator is still looking at the launch output, not leave them to infer it
  // from a stalled phase column later.
  const baseline = payload.verify?.baseline;
  if (baseline?.willRunBeforeAgent) {
    lines.push(
      `Before the agent starts, ${baseline.commandCount} verify command${baseline.commandCount === 1 ? "" : "s"} run as a baseline; on a cold engine cache this can take several minutes. Re-run with ${baseline.skipFlag} to skip it when the tree is already green.`
    );
  }
  return `${lines.join("\n")}\n`;
}

function createBridgeJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  write = false,
  allowedPaths = null
}) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: resolveJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    // Persisted so land's containment gate has something to gate against.
    // Without a producer the gate was unreachable and README's promise that
    // "land refuses paths outside allowed_paths" could never hold.
    ...(allowedPaths && allowedPaths.length > 0 ? { allowedPaths } : {})
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

/**
 * Repo-relative path prefixes a run may land, from repeatable `--allowed-paths`.
 *
 * Normalised to forward slashes and stripped of any escape attempt: an entry
 * that is absolute or climbs out with `..` would widen the gate rather than
 * narrow it, which is the opposite of the flag's purpose.
 *
 * @param {unknown} raw
 * @returns {string[]|null} null when the flag was not passed (gate stays off)
 */
function normalizeAllowedPaths(raw) {
  const list = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  if (list.length === 0) {
    return null;
  }
  const cleaned = [];
  for (const entry of list) {
    const value = String(entry ?? "")
      .trim()
      .split("\\")
      .join("/")
      .replace(/^\.\//, "");
    if (!value) {
      continue;
    }
    if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) {
      throw new Error(
        `Invalid --allowed-paths ${JSON.stringify(String(entry))}: expected a repository-relative ` +
          `path prefix (no leading slash, no drive letter, no "..").`
      );
    }
    cleaned.push(value.replace(/\/+$/, ""));
  }
  return cleaned.length > 0 ? cleaned : null;
}

function buildTaskJob(workspaceRoot, taskMetadata, write, allowedPaths = null) {
  return createBridgeJob({
    prefix: "run",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    allowedPaths
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
  isolateSource = null,
  verifyCommands = [],
  verifyPlan = null,
  verifyTiming = null,
  verifyAttempts = 2,
  verifyFailurePatterns = [],
  verifyIgnorePatterns = [],
  noVerifyBaseline = false,
  provisionCopy = undefined,
  provisionFiles = undefined,
  provisionLink = undefined,
  linkDirs = undefined,
  blenderSandbox = false,
  noBlenderSandbox = false,
  exportSmoke = false,
  env = {},
  maxDurationSeconds = null,
  maxTurns = null,
  maxCostUsd = null,
  parentRunId = null,
  nestDepth = 0,
  baseRef = null,
  parentWorktree = null
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
    // Why isolation was on/off — printed on the run header so a forced
    // programmatic decision is not a mystery when reading the log later.
    isolateSource,
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
    // still fall back to GROK_BUILD_LINK_GODOT_CACHE (and the isolated default
    // of a private cache).
    provisionCopy,
    // Optional overrides for untracked runtime file copies and per-dir link
    // policy (provision.files / provision.link / linkDirs in .grok-build.json).
    provisionFiles,
    provisionLink,
    linkDirs,
    // Blender sandbox: explicit opt-in, explicit opt-out, or auto for isolated
    // add-on runs (resolved again in executeTaskRun against the descriptor).
    blenderSandbox,
    noBlenderSandbox,
    exportSmoke,
    // Environment overrides, VERBATIM. This object is the detached worker's
    // input, not a report: redacting here would hand the background run a
    // literal "[redacted]" for its API token. The redacted copy is what reaches
    // the payload. It lands in the same job file the prompt already does, under
    // the plugin's state directory.
    env,
    maxDurationSeconds,
    maxTurns,
    maxCostUsd,
    // Nested-delegation linkage. Null/0 for top-level runs.
    parentRunId,
    nestDepth,
    baseRef,
    parentWorktree
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Imported the Claude session into a Grok session.",
    payload.threadId ? `Grok session ID: ${payload.threadId}` : "Grok session ID: (not detected in import output)",
    payload.resumeCommand
      ? `Resume in Grok: ${payload.resumeCommand}`
      : `Resume with: ${resolveGrokBinary()} -r <session-id>`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  ensureGrokAvailable(cwd);
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = runImport(cwd, { sourcePath });
  const cliBinary = resolveGrokBinary();
  const payload = {
    threadId: result.threadId,
    resumeCommand:
      result.resumeCommand ?? (result.threadId ? `${cliBinary} -r ${result.threadId}` : null),
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

/**
 * Where a background worker's own stdout/stderr go.
 *
 * `stdio: "ignore"` routed the worker's last words to the null device, so any
 * failure that escaped runTrackedJob - a module-load error, an uncaught
 * exception in a stream handler, an OOM - left a two-line log, no terminal
 * claim, and literally nothing to debug from. Two identical 117-byte logs, one
 * with HOME set and one without, is exactly what that looks like from the
 * operator's seat.
 *
 * The stream is separate from the run log on purpose: it carries raw
 * interpreter output (stack traces, native warnings) and must not be mistaken
 * for the structured progress log that `runs` renders.
 */
export function resolveWorkerCrashLog(workspaceRoot, jobId) {
  return path.join(path.dirname(resolveJobLogFile(workspaceRoot, jobId)), `${jobId}.worker.err`);
}

function spawnDetachedRunWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-bridge.mjs");
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let crashStdio = "ignore";
  try {
    // Opened here, in the parent, so the child never has to succeed at
    // anything before its output has somewhere to land. If even this fails,
    // fall back to the old behaviour rather than refusing to launch.
    const fd = fs.openSync(resolveWorkerCrashLog(workspaceRoot, jobId), "a");
    crashStdio = ["ignore", fd, fd];
  } catch {
    crashStdio = "ignore";
  }

  const child = spawn(process.execPath, [scriptPath, "run-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: crashStdio,
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
  // The job FILE keeps `request` verbatim - the detached worker is re-spawned
  // FROM this file (readStoredJob), so the real env values must survive the
  // handoff. The shared index (state.json) is a different surface: it backs
  // `runs --json` / `show --json`, which echo straight back into the Claude
  // Code transcript, so only a redacted copy of `request` ever lands there.
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, {
    ...queuedRecord,
    request: { ...request, env: redactEnvForRecord(request.env ?? {}) }
  });

  const spawnWorker = options.spawnWorker ?? spawnDetachedRunWorker;
  const child = spawnWorker(cwd, job.id);
  const workerPid = child?.pid ?? null;
  if (workerPid != null) {
    // `request` here stays verbatim, unlike the upsertJob call above: this
    // patch only reaches the job FILE (patchJobIfActive's index projection in
    // state.mjs never carries a `request` key), so redacting it here would
    // just overwrite the job file's real values with "[redacted]" and starve
    // the detached worker of the env it needs to run.
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

  // What the caller actually queued, answered at queue time.
  //
  // A background launch used to return an id and nothing about the work: a
  // supervisor that queued a Godot write run had no way to know it had also
  // queued a four-command pre-agent baseline that can run for minutes before
  // the agent starts. The first sign was a run sitting in phase "verifying"
  // with agentPid: null, which reads as a hang. Say so up front instead.
  const verifyCommands = Array.isArray(request?.verifyCommands) ? request.verifyCommands : [];
  const baselineSkipped = Boolean(request?.noVerifyBaseline);
  const runsBaseline = verifyCommands.length > 0 && !baselineSkipped && request?.write !== false;

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      bridgePid: workerPid,
      pid: workerPid,
      verify: {
        commandCount: verifyCommands.length,
        commands: verifyCommands,
        planSource: request?.verifyPlan?.source ?? null,
        baseline: {
          // True means: the agent does not start until these finish.
          willRunBeforeAgent: runsBaseline,
          commandCount: runsBaseline ? verifyCommands.length : 0,
          skipped: baselineSkipped,
          skipFlag: "--no-verify-baseline"
        }
      }
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd", "focus"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    },
    // Fail loudly on an unrecognised flag rather than warning and continuing.
    // A dropped `--base` silently reviewed the DEFAULT ref while telling the
    // user the run had started against theirs; for a review, quietly answering
    // a different question than the one asked is the worst outcome.
    unknownMode: "error"
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = resolveModelChoice(options.model);
  const effort = resolveEffortChoice(options.effort);
  const billingGate = assertModelBillingAllowed(model, process.env);
  if (!billingGate.allowed) {
    throw new Error(billingGate.message);
  }
  // `--focus` is the unambiguous route for prose. A single argv token gets
  // re-split by normalizeArgv, so a focus like "focus on the --base of the
  // refactor" used to bind `base="of"` and silently diff against a bogus ref;
  // positionals remain supported for the common flag-free case.
  const focusText = String(options.focus ?? positionals.join(" ")).trim();
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
  "max-cost",
  // Explicit programmatic caller id (also auto-detected from CLAUDECODE etc.).
  "caller",
  // Repeatable. Repo-relative path prefixes this run is allowed to land.
  // README has always promised that land refuses paths outside allowed_paths,
  // but nothing ever WROTE the field, so the gate was unreachable and the
  // promise was false. This is that producer.
  "allowed-paths"
]);

/**
 * Bridge flags a user may type directly into `/turbo-build-plugin:delegate` that MUST
 * reach the forwarded `run` invocation unchanged - never folded into the
 * natural-language task text as prose, the same way `--model`/`--effort` are
 * already stripped out before the remainder becomes the prompt. This is the
 * single source of truth for that contract: `tests/commands.test.mjs` walks
 * every entry here against all three delegate surfaces
 * (`commands/delegate.md`, `agents/turbo-delegate.md`,
 * `skills/turbo-delegate-runtime/SKILL.md`) and fails if one goes undocumented,
 * so a flag added to `TASK_VALUE_OPTIONS`/`handleTask`'s `booleanOptions` and
 * forgotten here is caught before it ships as a flag the delegate path
 * silently swallows.
 *
 * Deliberately excluded:
 * - `--model` / `--effort` / `--cwd` - already documented and handled as
 *   runtime-selection flags in the delegate surfaces, not part of this list.
 * - `--prompt-file` - the SUBAGENT's own prompt-delivery mechanism
 *   (agents/turbo-delegate.md), never a flag a user types.
 * - `--isolate` - a no-op on the delegate path, which always forces `--write`;
 *   only `--no-isolate` is meaningful there.
 */
export const RUN_PASSTHROUGH_FLAGS = Object.freeze([
  "--verify",
  "--verify-attempts",
  "--verify-ignore",
  "--verify-timeout",
  "--baseline-timeout",
  "--verify-max-buffer",
  "--no-verify",
  "--no-verify-baseline",
  "--env",
  "--blender-sandbox",
  "--no-blender-sandbox",
  "--godot-export-smoke",
  "--no-isolate",
  "--max-duration",
  "--max-turns",
  "--max-cost"
]);

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [...TASK_VALUE_OPTIONS],
    repeatableOptions: ["verify", "verify-ignore", "env", "allowed-paths"],
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
      // Explicit opt-in. Isolated add-on runs also auto-enable the sandbox
      // unless --no-blender-sandbox is set (see shouldAutoBlenderSandbox).
      "blender-sandbox",
      "no-blender-sandbox",
      // Opt-in Godot headless export smoke when export_presets.cfg exists.
      "godot-export-smoke",
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
  const allowedPaths = normalizeAllowedPaths(options["allowed-paths"]);

  // Resolved from the workspace root, and BEFORE any worktree exists, so that
  // buildTaskRequest serialises a concrete command list into a background
  // job's record: the detached worker resolves nothing of its own, and a
  // worktree (which has no .grok-build.json of its own until the commit lands)
  // cannot change the plan half way through.
  const cliSettings = cliSettingsFromTaskOptions(options);
  // exportSmoke is resolved inside resolveProjectRunPlan (CLI flag or config).
  cliSettings.exportSmoke = Boolean(options["godot-export-smoke"]);
  const {
    projectConfig,
    ecosystem,
    ecosystems,
    settings,
    exportSmoke,
    autoVerify,
    autoVerifyTrusted
  } = resolveProjectRunPlan(workspaceRoot, cliSettings);

  // Effort: full Hyper ladder accepted; unknown values warn and pass through
  // (HYPER-2). The config value is already schema-checked when present.
  const model = resolveModelChoice(options.model, settings.model);
  const effort = resolveEffortChoice(options.effort, settings.effort);
  // Pay-per-token models (openai/*) require an explicit opt-in so a typo does
  // not silently burn metered budget.
  const billingGate = assertModelBillingAllowed(model, process.env);
  if (!billingGate.allowed) {
    throw new Error(billingGate.message);
  }
  const caller = detectCaller(process.env, { caller: options.caller });
  const isolateDecision = resolveIsolateOption(options, write, settings.isolate, {
    programmatic: caller.programmatic,
    allowNoIsolate: allowNoIsolateFromEnv(process.env)
  });
  const isolate = isolateDecision.isolate;
  const isolateSource = isolateDecision.source;
  const verifyCommands = autoVerify && !autoVerifyTrusted ? [] : settings.verify;
  const verifyPlan = {
    source: settings.sources.verify,
    disabled: Boolean(settings.verifyDisabled),
    ecosystem: ecosystem?.id ?? null,
    ecosystems: Array.isArray(ecosystems) ? ecosystems.map((e) => e.id) : ecosystem ? [ecosystem.id] : [],
    configPresent: projectConfig.present,
    configTrusted: projectConfig.trusted,
    configWithheld: Object.keys(projectConfig.untrusted),
    autoVerify,
    autoVerifyTrusted,
    autoVerifyWithheld: autoVerify && !autoVerifyTrusted
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
  // falls back to GROK_BUILD_LINK_GODOT_CACHE / the isolated private default
  // only when the option is absent, so a default of false would silently
  // shadow the environment variable.
  const provisionCopy = settings.provision?.copy;
  const provisionFiles = settings.provision?.files;
  const provisionLink = settings.provision?.link;
  const linkDirs = settings.linkDirs;
  const blenderSandbox = Boolean(options["blender-sandbox"]);
  const noBlenderSandbox = Boolean(options["no-blender-sandbox"]);
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

    const job = buildTaskJob(workspaceRoot, taskMetadata, write, allowedPaths);
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
        isolateSource,
        verifyCommands,
        verifyPlan,
        verifyTiming,
        verifyAttempts,
        verifyFailurePatterns,
        verifyIgnorePatterns,
        noVerifyBaseline,
        provisionCopy,
        provisionFiles,
        provisionLink,
        linkDirs,
        blenderSandbox,
        noBlenderSandbox,
        exportSmoke,
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

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, allowedPaths);
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
        isolateSource,
        verifyCommands,
        verifyPlan,
        verifyTiming,
        verifyAttempts,
        verifyFailurePatterns,
        verifyIgnorePatterns,
        noVerifyBaseline,
        provisionCopy,
        provisionFiles,
        provisionLink,
        linkDirs,
        blenderSandbox,
        noBlenderSandbox,
        exportSmoke,
        env: envOverrides,
        maxDurationSeconds,
        maxTurns,
        maxCostUsd,
        onProgress: progress
      }),
    { json: options.json }
  );
}

/**
 * Nested Hyper-to-Hyper run. Reuses executeTaskRun; the differences are the
 * gate checks (depth, fan-out, always-isolate, budget inheritance) and the
 * parent/child record linkage. Intended for the runtime MCP server.
 */
async function handleNestRun(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: [...TASK_VALUE_OPTIONS, "parent-run-id"],
    repeatableOptions: ["verify", "verify-ignore", "env"],
    booleanOptions: [
      "json",
      "write",
      "background",
      "no-verify",
      "no-verify-baseline",
      "no-isolate",
      "isolate",
      "blender-sandbox",
      "no-blender-sandbox",
      "godot-export-smoke"
    ],
    aliasMap: { m: "model" }
  });

  // Nested write runs are isolated unconditionally — --no-isolate is refused
  // even when GROK_BUILD_ALLOW_NO_ISOLATE=1, because a nested child that edits
  // the parent worktree (or the main checkout) destroys the isolation story.
  if (options["no-isolate"]) {
    throw new Error(
      "nest-run refuses --no-isolate: a nested write run is always isolated in a sibling worktree."
    );
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  // Depth: the incoming env value is the PARENT's depth; the child is +1.
  // Refuse when the parent is already at the max (leaf run).
  const incomingDepth = readNestDepth(process.env);
  const maxDepth = readMaxNestDepth(process.env);
  const { childDepth } = assertNestDepthAllowed(incomingDepth, maxDepth);

  const parentRunId =
    (options["parent-run-id"] && String(options["parent-run-id"]).trim()) ||
    (process.env[PARENT_RUN_ID_ENV] && String(process.env[PARENT_RUN_ID_ENV]).trim()) ||
    null;
  if (!parentRunId) {
    throw new Error(
      `nest-run requires a parent run id (${PARENT_RUN_ID_ENV} or --parent-run-id). ` +
        "Top-level work should use `run`, not `nest-run`."
    );
  }

  // Fan-out: at most N live children of this parent.
  const parentStored = readStoredJob(workspaceRoot, parentRunId);
  if (!parentStored) {
    throw new Error(`nest-run: parent run ${parentRunId} was not found in this workspace.`);
  }
  assertNestConcurrencyAllowed(parentStored.children, readMaxNestConcurrency(process.env));

  const prompt = readTaskPrompt(cwd, options, positionals);
  requireTaskRequest(prompt, false);

  // Same default as `run`: read-only unless --write. The MCP delegate_run tool
  // always passes --write for the common nested-edit case.
  const write = Boolean(options.write);

  const cliSettings = cliSettingsFromTaskOptions(options);
  cliSettings.exportSmoke = Boolean(options["godot-export-smoke"]);
  const {
    projectConfig,
    ecosystem,
    ecosystems,
    settings,
    exportSmoke,
    autoVerify,
    autoVerifyTrusted
  } = resolveProjectRunPlan(workspaceRoot, cliSettings);

  const model = resolveModelChoice(options.model, settings.model);
  const effort = resolveEffortChoice(options.effort, settings.effort);
  const billingGate = assertModelBillingAllowed(model, process.env);
  if (!billingGate.allowed) {
    throw new Error(billingGate.message);
  }

  // Nested agents must not smuggle free-form --verify through nest-run: the
  // bridge executes those strings outside Hyper confinement. Humans invoking
  // nest-run from a shell (no PARENT_RUN_ID) may still pass CLI verify.
  const nestedAgentCaller = Boolean(
    process.env[PARENT_RUN_ID_ENV] && String(process.env[PARENT_RUN_ID_ENV]).trim()
  );
  if (nestedAgentCaller) {
    if (Array.isArray(options.verify) && options.verify.length > 0) {
      throw new Error(
        "nest-run refuses --verify when called from a nested agent: verify commands " +
          "run outside Hyper confinement. The child uses project/ecosystem verify only."
      );
    }
    // One list, checked in a loop. The guard used to name exactly --verify and
    // --no-verify, so --verify-ignore passed straight through to
    // runVerifyCommand's ignorePatterns: a nested child could send
    // `--verify-ignore ".*"` and make detectOutputFailures return [] for a
    // project whose tools exit 0 while printing SCRIPT ERROR, so the grandchild
    // reported "Verified: yes". It also bypassed the config-file trust gate.
    for (const flag of AGENT_FORBIDDEN_VERIFY_FLAGS) {
      if (options[flag] !== undefined) {
        throw new Error(
          `nest-run refuses --${flag} when called from a nested agent: verify behaviour ` +
            "is the parent's to decide, and these flags can suppress real failures."
        );
      }
    }
    if (options["no-verify"]) {
      throw new Error(
        "nest-run refuses --no-verify when called from a nested agent; " +
          "the child resolves verify from project config and ecosystem defaults."
      );
    }
  }

  // Budget inheritance: parent ceilings + remaining cost (including reserved
  // grants for live siblings) + remaining wall-clock. Child may ask for less.
  const parentBudget = parentStored.budget ?? parentStored.request?.budget ?? {};
  const parentMaxCost =
    parentBudget.maxCostUsd ??
    parentStored.request?.maxCostUsd ??
    (process.env.GROK_BUILD_PARENT_MAX_COST != null
      ? Number(process.env.GROK_BUILD_PARENT_MAX_COST)
      : null);
  const parentMaxDuration =
    parentBudget.maxDurationSeconds ??
    parentStored.request?.maxDurationSeconds ??
    (process.env.GROK_BUILD_PARENT_MAX_DURATION != null
      ? Number(process.env.GROK_BUILD_PARENT_MAX_DURATION)
      : null);
  const parentMaxTurns =
    parentBudget.maxTurns ??
    parentStored.request?.maxTurns ??
    (process.env.GROK_BUILD_PARENT_MAX_TURNS != null
      ? Number(process.env.GROK_BUILD_PARENT_MAX_TURNS)
      : null);
  // Re-read parent so concurrent nest-run registrations see each other's
  // reservedCostUsd entries before launch.
  const parentFresh = readStoredJob(workspaceRoot, parentRunId) ?? parentStored;
  const spent = parentSpentCostUsd(parentFresh);
  const parentRemainingDuration = remainingDurationSeconds(
    parentMaxDuration,
    parentFresh.startedAt ?? parentFresh.createdAt ?? null
  );

  const childRequested = {
    maxCostUsd: resolveMaxCostUsd(options["max-cost"] ?? settings.maxCostUsd),
    maxDurationSeconds: resolveMaxDurationSeconds(
      options["max-duration"] ?? settings.maxDurationSeconds
    ),
    maxTurns: resolveMaxTurns(options["max-turns"] ?? settings.maxTurns)
  };
  const inherited = inheritBudget({
    parentMaxCostUsd: parentMaxCost,
    parentSpentCostUsd: spent,
    parentMaxDurationSeconds: parentMaxDuration,
    parentRemainingDurationSeconds: parentRemainingDuration,
    parentMaxTurns,
    childMaxCostUsd: childRequested.maxCostUsd,
    childMaxDurationSeconds: childRequested.maxDurationSeconds,
    childMaxTurns: childRequested.maxTurns
  });

  // Agent-originated nest-run: never honour CLI verify overrides.
  const trustedVerifyCommands = autoVerify && !autoVerifyTrusted ? [] : settings.verify;
  const verifyCommands = nestedAgentCaller
    ? (settings.verifyDisabled ? [] : trustedVerifyCommands)
    : trustedVerifyCommands;
  const verifyPlan = {
    source: settings.sources.verify,
    disabled: Boolean(settings.verifyDisabled),
    ecosystem: ecosystem?.id ?? null,
    ecosystems: Array.isArray(ecosystems) ? ecosystems.map((e) => e.id) : ecosystem ? [ecosystem.id] : [],
    configPresent: projectConfig.present,
    configTrusted: projectConfig.trusted,
    configWithheld: Object.keys(projectConfig.untrusted),
    autoVerify,
    autoVerifyTrusted,
    autoVerifyWithheld: autoVerify && !autoVerifyTrusted
  };
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

  const parentWorktree =
    parentStored.worktree?.path ??
    (process.env.GROK_BUILD_PARENT_WORKTREE
      ? String(process.env.GROK_BUILD_PARENT_WORKTREE)
      : null);
  const baseRef =
    parentStored.worktree?.baseSha ??
    (process.env.GROK_BUILD_PARENT_BASE_SHA
      ? String(process.env.GROK_BUILD_PARENT_BASE_SHA)
      : null);

  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast: false });
  // Deliberately null: a nested agent may not set its own containment. The
  // parent's land gate is the one that matters.
  const job = buildTaskJob(workspaceRoot, taskMetadata, write, null);
  // Stamp parent linkage on the job record before enqueue so runs can group.
  job.parentRunId = parentRunId;
  job.nestDepth = childDepth;
  job.children = [];

  const request = {
    kind: "task",
    ...buildTaskRequest({
      cwd: workspaceRoot,
      model,
      effort,
      prompt,
      write,
      resumeLast: false,
      jobId: job.id,
      isolate: true,
      isolateSource: "nest-run",
      verifyCommands,
      verifyPlan,
      verifyTiming,
      verifyAttempts: resolveVerifyAttempts(settings.verifyAttempts),
      verifyFailurePatterns: settings.verifyFailurePatterns ?? [],
      verifyIgnorePatterns: settings.verifyIgnorePatterns ?? [],
      noVerifyBaseline: Boolean(options["no-verify-baseline"]),
      provisionCopy: settings.provision?.copy,
      provisionFiles: settings.provision?.files,
      provisionLink: settings.provision?.link,
      linkDirs: settings.linkDirs,
      blenderSandbox: Boolean(options["blender-sandbox"]),
      noBlenderSandbox: Boolean(options["no-blender-sandbox"]),
      exportSmoke,
      env: { ...(settings.env ?? {}), ...parseEnvAssignments(options.env) },
      maxDurationSeconds: inherited.maxDurationSeconds,
      maxTurns: inherited.maxTurns,
      maxCostUsd: inherited.maxCostUsd,
      parentRunId,
      nestDepth: childDepth,
      baseRef,
      parentWorktree
    })
  };

  // Register the child on the parent before the worker starts so fan-out
  // accounting sees it immediately. reservedCostUsd debits the parent's
  // remaining budget for concurrent siblings (refunded implicitly when the
  // child terminals with actual usage).
  linkChildOutcomeToParent(workspaceRoot, parentRunId, {
    id: job.id,
    status: "queued",
    changedFileCount: null,
    usage: null,
    worktree: null,
    reservedCostUsd: inherited.maxCostUsd
  });

  // Child process must see its own depth so a grandchild refuses correctly.
  const childEnv = {
    ...process.env,
    [NEST_DEPTH_ENV]: String(childDepth),
    [PARENT_RUN_ID_ENV]: parentRunId
  };
  // Sibling worktree is outside the parent confine root. Inherited
  // GROK_CONFINE would refuse to widen and deny every child write.
  delete childEnv.GROK_CONFINE;
  delete childEnv.GROK_CONFINE_INHERIT;

  if (options.background) {
    ensureGrokAvailable(cwd);
    const { payload, logFile } = enqueueBackgroundJob(cwd, job, request, {
      spawnWorker: (workerCwd, jobId) => {
        const scriptPath = path.join(ROOT_DIR, "scripts", "grok-bridge.mjs");
        const child = spawn(process.execPath, [scriptPath, "run-worker", "--cwd", workerCwd, "--job-id", jobId], {
          cwd: workerCwd,
          env: childEnv,
          detached: true,
          stdio: "ignore",
          windowsHide: true
        });
        child.unref();
        return child;
      }
    });
    // Background nest-run returns immediately with the ids the MCP tool needs.
    // worktree is null until the worker creates it; status polling fills it in.
    const out = {
      jobId: payload.jobId,
      runId: payload.jobId,
      status: payload.status,
      logFile: logFile ?? payload.logFile,
      worktree: null,
      branch: null,
      parentRunId,
      nestDepth: childDepth
    };
    outputCommandResult(out, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  // Foreground nest-run: rare (MCP always backgrounds) but supported for tests.
  const previousDepth = process.env[NEST_DEPTH_ENV];
  process.env[NEST_DEPTH_ENV] = String(childDepth);
  try {
    await runForegroundCommand(
      job,
      (progress) =>
        executeTaskRun({
          ...request,
          onProgress: progress
        }),
      { json: options.json }
    );
  } finally {
    if (previousDepth === undefined) {
      delete process.env[NEST_DEPTH_ENV];
    } else {
      process.env[NEST_DEPTH_ENV] = previousDepth;
    }
  }
}

/**
 * Porcelain lines split into their two-character status code and their path.
 *
 * The status code is what distinguishes tracked dirt from untracked dirt - `??`
 * is untracked, everything else names a tracked file - and land now has to make
 * that distinction, so the parse cannot throw it away.
 *
 * @param {string} statusOutput
 * @returns {{status: string, path: string}[]}
 */
function porcelainEntries(statusOutput) {
  return String(statusOutput ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      // Porcelain: "XY path" or "XY origin -> path"
      const body = line.length >= 3 ? line.slice(3) : line;
      const arrow = body.indexOf(" -> ");
      return {
        status: line.slice(0, 2),
        path: (arrow === -1 ? body : body.slice(arrow + 4)).trim()
      };
    })
    .filter((entry) => entry.path);
}

function porcelainDirtyPaths(statusOutput) {
  return porcelainEntries(statusOutput).map((entry) => entry.path);
}

/**
 * Split the dirty paths the artifact-filtered dirty gate overlooked into the
 * ones it is safe to overlook and the ones it is not.
 *
 * `artifactExcludePathspecs()` is a PATH filter: it has no idea whether a path
 * is tracked. That is exactly right for the case it was added for - `?? .godot/`
 * is permanently untracked in a Godot repo that does not gitignore it - and
 * actively dangerous for anything tracked, because `recoverFromFailedLandMerge`
 * runs `git reset --hard HEAD` on the conflict path. A hard reset cannot touch
 * an untracked file, but it destroys uncommitted changes to a TRACKED one, with
 * no reflog and no object to recover from. Every artifact pathspec is recursive
 * (leading double-star), so routinely-tracked paths like
 * `test/fixtures/node_modules/pkg/index.js` or `assets/obj/hero.obj` fall
 * inside them.
 *
 * Costs one extra git call, so callers only reach it once the filtered status
 * came back clean.
 *
 * @param {string} repoRoot
 * @param {string[]} filteredDirtyFiles - paths the filtered status still flagged
 * @returns {{untracked: string[], tracked: string[]}}
 */
function classifyIgnoredDirtyArtifacts(repoRoot, filteredDirtyFiles) {
  const unfiltered = git(repoRoot, ["status", "--porcelain"]);
  if (unfiltered.status !== 0) {
    return { untracked: [], tracked: [] };
  }
  const kept = new Set(filteredDirtyFiles);
  const untracked = [];
  const tracked = [];
  for (const entry of porcelainEntries(unfiltered.stdout)) {
    if (kept.has(entry.path)) {
      continue;
    }
    (entry.status === "??" ? untracked : tracked).push(entry.path);
  }
  return { untracked, tracked };
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
 * above already refused to run against uncommitted work in any TRACKED file.
 * That qualifier is load-bearing: the gate exempts generated-artifact paths,
 * and for a while it exempted them by path alone, which let a tracked-and-dirty
 * `test/fixtures/node_modules/...` through to be silently destroyed here. The
 * gate now blocks on exempted-but-tracked dirt, so everything this reset can
 * still reach is either committed or untracked - and a hard reset cannot touch
 * an untracked file. It also clears SQUASH_MSG, MERGE_MSG and AUTO_MERGE on its
 * own (verified), so nothing needs to be hand-deleted from inside .git.
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
    `Either drop the run with /turbo-build-plugin:land ${jobId} --discard, ` +
    `or check out ${branchName} and pick a side per file with git checkout --ours/--theirs before merging by hand.`
  );
}

/**
 * Nested land failure recovery. Mirrors top-level recoverFromFailedLandMerge
 * messaging but MUST NOT run `git reset --hard` or `git clean -fd` on the
 * parent worktree — that tree belongs to a still-running parent agent.
 */
function recoverFromFailedNestedLand(parentWorktreePath, childJobId, parentRunId, branchName, merge) {
  const combined = `${merge.stderr || ""}\n${merge.stdout || ""}`;
  const conflicted = new Set(
    [...combined.matchAll(/CONFLICT \([^)]*\): Merge conflict in (.+)/g)].map((match) =>
      match[1].trim()
    )
  );
  const listed = [...conflicted];
  const payload = {
    landed: false,
    reason: listed.length > 0 ? "merge-conflict" : "merge-failed",
    jobId: childJobId,
    parentRunId,
    parentWorktree: parentWorktreePath,
    branch: branchName,
    conflictingFiles: listed,
    gitStatus: merge.status,
    gitStderr: (merge.stderr || "").trim() || null,
    gitStdout: (merge.stdout || "").trim() || null
  };
  const detail = combined.trim().split(/\r?\n/).filter(Boolean).slice(0, 8).join("; ");
  const message =
    listed.length > 0
      ? `Nested land of ${childJobId} into parent ${parentRunId} hit merge conflicts in: ${listed.join(", ")}. ` +
        `Parent worktree was restored without hard-reset/clean (parent agent work preserved). ` +
        `Child worktree retained for inspection. Options: resolve conflicts by hand in the parent worktree, ` +
        `or discard the child with land ${childJobId} --discard.`
      : `Nested land of ${childJobId} into parent ${parentRunId} failed: ${detail || `git exited ${merge.status}`}. ` +
        `Parent worktree was not hard-reset or cleaned; child worktree retained for inspection.`;
  return { payload, message };
}

/**
 * Clear a job's worktree field after it has been successfully landed or
 * discarded. Reuses the existing "no worktree to land" guard at the top of
 * handleLand: without this, a second `land` call against the same job id
 * fell through to the git-diff computation against a branch that
 * removeWorktree had already deleted, surfacing a raw git error instead of
 * a clear "already landed" message. Also keeps the render.mjs land-hint
 * from suggesting `/turbo-build-plugin:land <id>` forever for a job with nothing
 * left to land.
 */
function markJobLanded(workspaceRoot, jobId, storedJob, action) {
  // R6-2: worktree path is cleared after land/discard, but the isolation
  // outcome must survive so `runs --all --json` can still answer "was this
  // run isolated?" after cleanup.
  const prevWt = storedJob.worktree && typeof storedJob.worktree === "object" ? storedJob.worktree : null;
  const prevIso =
    storedJob.isolation && typeof storedJob.isolation === "object" ? storedJob.isolation : null;
  const isolation = {
    active: Boolean(prevWt?.path || prevIso?.active || prevIso?.worktree),
    worktree: prevIso?.worktree ?? prevWt?.path ?? null,
    branch: prevIso?.branch ?? prevWt?.branch ?? null,
    baseSha: prevIso?.baseSha ?? prevWt?.baseSha ?? null,
    headSha: prevIso?.headSha ?? prevWt?.sha ?? prevWt?.headSha ?? null,
    breached: Boolean(
      prevWt?.breached || storedJob.isolationBreached || prevIso?.breached || storedJob.status === "isolation-breached"
    ),
    source: prevIso?.source ?? storedJob.isolateSource ?? null
  };
  const next = {
    ...storedJob,
    worktree: null,
    isolation,
    isolationBreached: isolation.breached,
    isolateSource: isolation.source,
    landedAt: nowIso(),
    landAction: action
  };
  writeJobFile(workspaceRoot, jobId, next);
  upsertJob(workspaceRoot, {
    id: jobId,
    worktree: null,
    isolation,
    isolationBreached: isolation.breached,
    isolateSource: isolation.source,
    landedAt: next.landedAt,
    landAction: action,
    status: storedJob.status
  });
}

/**
 * Report a worktree that survived its own removal instead of claiming success.
 *
 * `removeWorktree` documents that the caller must surface anything it could not
 * delete, and prune honours that — but land/discard consumed only
 * `privateTarget`. On the routine Windows case (an editor, AV scanner, or a
 * process whose cwd is the worktree) the directory stays, `markJobLanded` nulls
 * `job.worktree`, and the path is then invisible to every command: prune's
 * job-backed loop skips it and its orphan scan treats the path as known.
 * `--discard` was worse — it printed "worktree and branch removed" when neither
 * was.
 *
 * @param {{removed?: boolean, reason?: string|null, orphanedPath?: string|null}} removed
 * @param {string} jobId
 * @returns {{ orphaned: true, reason: string|null, path: string|null }|null}
 */
function noteWorktreeSurvivedRemoval(removed, jobId) {
  if (!removed || removed.removed !== false) {
    return null;
  }
  const orphanedPath = removed.orphanedPath ?? null;
  const reason = removed.reason ?? null;
  process.stderr.write(
    `[turbo-build] Warning: could not remove the worktree for ${jobId}.
` +
      `  path: ${orphanedPath ?? "(unknown)"}
` +
      `  reason: ${reason ?? "(unknown)"}
` +
      `  The merge itself succeeded; the directory is still on disk. Close anything ` +
      `holding it and run \`prune --apply\` to reclaim it.
`
  );
  return { orphaned: true, reason, path: orphanedPath };
}

async function handleLand(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "into-run"],
    booleanOptions: ["json", "discard", "preview", "force"]
  });

  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? "");
  const storedJob = readStoredJob(workspaceRoot, job.id) ?? job;
  const worktree = storedJob.worktree;

  if (!worktree || typeof worktree !== "object" || !worktree.path) {
    throw new Error(`Run ${job.id} has no worktree to land. It ran without isolation.`);
  }

  // R7-1: refuse to land a breached (split) run. Landing would apply only the
  // worktree half — field report: deletions in the worktree, creates/modifies
  // in main, and land would have destroyed a menu with no replacement.
  const isBreached =
    storedJob.status === "isolation-breached" ||
    Boolean(storedJob.isolationBreached) ||
    Boolean(worktree.breached) ||
    Boolean(storedJob.isolation?.breached);
  if (isBreached && !options.discard) {
    const wtFiles =
      worktree.worktreeFiles ??
      worktree.changedFiles ??
      storedJob.result?.changedFiles?.worktree?.entries ??
      [];
    const mainFiles =
      worktree.mainTreeFiles ??
      storedJob.isolationLeak?.entries ??
      storedJob.result?.changedFiles?.mainTree?.entries ??
      storedJob.result?.isolationLeak?.entries ??
      [];
    const fmt = (list) =>
      Array.isArray(list) && list.length > 0
        ? list
            .slice(0, 30)
            .map((e) => `  ${e}`)
            .join("\n")
        : "  (none recorded)";
    throw new Error(
      `Refusing to land ${job.id}: isolation was breached (split write). ` +
        `Landing would apply only the worktree half and can destroy the main checkout.\n` +
        `In the worktree:\n${fmt(wtFiles)}\n` +
        `Leaked to main checkout:\n${fmt(mainFiles)}\n` +
        `Recovery: inspect both trees; copy wanted main-tree files into the worktree (or re-apply the full change set by hand); ` +
        `then \`land ${job.id} --discard\` to drop the incomplete worktree. Do not land a partial change.`
    );
  }

  const branchName = worktree.branch;
  const worktreePath = worktree.path;
  const baseSha = worktree.baseSha;
  const intoRunId = options["into-run"] ? String(options["into-run"]).trim() : "";

  // Jobs resolve through --git-common-dir, which every linked worktree shares,
  // so `land <B>` from inside run A's worktree used to find B and then merge it
  // into A via the local --show-toplevel. A was then landed or discarded and
  // B's only copy went with it. Merge into the MAIN checkout, and refuse
  // outright when the caller is standing in a linked worktree — the correct
  // target is genuinely ambiguous there, and --into-run is the explicit way to
  // say "yes, into this run's branch".
  const worktreeContext = describeWorktreeContext(workspaceRoot);
  if (worktreeContext.linked && !intoRunId) {
    throw new Error(
      `Refusing to land from inside a linked worktree.\n` +
        `  cwd worktree: ${worktreeContext.localRoot}\n` +
        `  main checkout: ${worktreeContext.mainRoot}\n` +
        `Landing here would merge into the worktree and then delete the source run.\n` +
        `Run land from ${worktreeContext.mainRoot}, or pass --into-run <parent-id> to ` +
        `deliberately merge into a run branch.`
    );
  }
  const repoRoot = intoRunId
    ? ensureGitRepository(workspaceRoot)
    : worktreeContext.mainRoot;

  // Nested land: merge the child branch into the PARENT worktree branch, not
  // the main checkout. Refuses non-landable terminal statuses.
  if (intoRunId) {
    if (options.discard) {
      throw new Error("land --into-run cannot be combined with --discard; discard the child alone.");
    }
    if (!childIsLandable(storedJob.status)) {
      throw new Error(
        `Refusing to land nested run ${job.id} into ${intoRunId}: status is "${storedJob.status}" ` +
          "(need a completed-family terminal status)."
      );
    }
    const parentJob = readStoredJob(workspaceRoot, intoRunId);
    if (!parentJob?.worktree?.path) {
      throw new Error(
        `land --into-run ${intoRunId}: parent has no worktree path (is it still running, or already landed?).`
      );
    }
    if (!branchName) {
      throw new Error(`Run ${job.id} worktree is missing a branch name.`);
    }

    const parentWorktreePath = parentJob.worktree.path;

    // Dirty gate (mirrors top-level land, rooted at the parent worktree):
    // never squash-merge over parent dirt that the child also touches. Other
    // parent dirt is allowed (mid-run land is the design), but overlapping
    // paths are refused so we never need a destructive recovery.
    let parentDirty = git(parentWorktreePath, [
      "status",
      "--porcelain",
      "--",
      ".",
      ...artifactExcludePathspecs()
    ]);
    if (parentDirty.status !== 0) {
      parentDirty = git(parentWorktreePath, ["status", "--porcelain"]);
    }
    if (parentDirty.status !== 0) {
      throw new Error(
        `Unable to inspect parent worktree before nested land: ${(parentDirty.stderr || parentDirty.stdout || "").trim()}`
      );
    }
    const parentDirtyFiles = porcelainDirtyPaths(parentDirty.stdout);
    const childFilesRaw = git(parentWorktreePath, [
      "diff",
      "--name-only",
      `${baseSha || "HEAD"}...${branchName}`
    ]);
    if (childFilesRaw.status !== 0) {
      throw new Error(
        `land refused: cannot enumerate child files for ${job.id}: ${(childFilesRaw.stderr || childFilesRaw.stdout || "").trim()}`
      );
    }
    const childFiles = new Set(
      String(childFilesRaw.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    );
    const fold = process.platform === "win32"
      ? (p) => String(p).replace(/\\/g, "/").toLowerCase()
      : (p) => String(p).replace(/\\/g, "/");
    const childFolded = new Set([...childFiles].map(fold));
    const overlapping = parentDirtyFiles.filter((file) => childFolded.has(fold(file)));
    const allowed = storedJob.allowedPaths ?? storedJob.allowed_paths ?? worktree.allowedPaths ?? null;
    if (Array.isArray(allowed) && allowed.length > 0) {
      const prefixes = allowed.map((p) => fold(String(p).replace(/\/+$/, "")));
      const outside = [...childFiles].filter((file) => {
        if (isHarnessLandPath(file)) {
          return false;
        }
        const n = fold(file);
        return !prefixes.some((pre) => n === pre || n.startsWith(`${pre}/`));
      });
      if (outside.length > 0) {
        throw new Error(
          `land refused: ${outside.length} path(s) outside allowed_paths (${outside.slice(0, 8).join(", ")}).`
        );
      }
    }
    if (childFiles.size > 50 && !options.force) {
      throw new Error(
        `land refused: ${childFiles.size} files exceeds the 50-file safety limit. Pass --force to land anyway.`
      );
    }
    if (options.preview) {
      const payload = {
        landed: false,
        preview: true,
        jobId: job.id,
        parentRunId: intoRunId,
        childFiles: [...childFiles],
        parentDirtyFiles
      };
      outputCommandResult(payload, `Preview only: ${childFiles.size} file(s) would land into ${intoRunId}.\n`, options.json);
      return;
    }
    if (overlapping.length > 0) {
      const payload = {
        landed: false,
        reason: "parent-dirty-overlap",
        jobId: job.id,
        parentRunId: intoRunId,
        conflictingFiles: overlapping,
        parentDirtyFiles,
        childFiles: [...childFiles]
      };
      const message =
        `Refusing nested land of ${job.id} into parent ${intoRunId}: parent worktree has ` +
        `uncommitted changes that overlap the child's files (${overlapping.slice(0, 8).join(", ")}). ` +
        `Parent worktree was not modified. Resolve the overlap, then retry.`;
      if (options.json) {
        outputCommandResult(payload, `${message}\n`, true);
        process.exitCode = 1;
        return;
      }
      throw new Error(message);
    }

    // Squash-merge inside the parent worktree so changes land on the parent's
    // branch. On failure: restore like top-level land — never hard-reset +
    // clean -fd (that destroys the parent agent's uncommitted work).
    const merge = git(parentWorktreePath, ["merge", "--squash", branchName]);
    if (merge.status !== 0) {
      // Prefer reset --merge: restores conflicted paths to HEAD while keeping
      // unrelated local modifications. Never clean -fd. Never claim the parent
      // tree was "left clean at HEAD".
      const soft = git(parentWorktreePath, ["reset", "--merge"]);
      if (soft.status !== 0) {
        // Last resort for squash (no MERGE_HEAD): mixed reset unstages without
        // wiping the working tree of parent edits.
        git(parentWorktreePath, ["reset", "HEAD"]);
      }
      const recovery = recoverFromFailedNestedLand(
        parentWorktreePath,
        job.id,
        intoRunId,
        branchName,
        merge
      );
      if (options.json) {
        outputCommandResult(recovery.payload, `${recovery.message}\n`, true);
        process.exitCode = 1;
        return;
      }
      throw new Error(recovery.message);
    }

    const removedIntoParent = removeWorktree({
      repoRoot,
      worktreePath,
      branchName,
      deleteBranch: true
    });
    const orphanIntoParent = noteWorktreeSurvivedRemoval(removedIntoParent, job.id);
    markJobLanded(workspaceRoot, job.id, storedJob, "apply-into-parent");
    linkChildOutcomeToParent(workspaceRoot, intoRunId, {
      id: job.id,
      status: storedJob.status,
      changedFileCount: storedJob.changedFileCount ?? null,
      usage: storedJob.usage ?? null,
      worktree: { path: null, branch: branchName, landedInto: intoRunId },
      landedInto: intoRunId
    });

    const payload = {
      landed: true,
      jobId: job.id,
      action: "apply-into-parent",
      parentRunId: intoRunId,
      parentWorktree: parentWorktreePath,
      worktree,
      branch: branchName,
      worktreeOrphaned: orphanIntoParent
    };
    const text =
      `Landed nested run ${job.id} into parent ${intoRunId} worktree (${parentWorktreePath}).\n` +
      `Changes are staged in the parent worktree; the parent agent should review before its own land.\n`;
    outputCommandResult(payload, text, options.json);
    return;
  }

  if (options.discard) {
    // Surface what is about to be destroyed so discard is never a silent wipe.
    let discardDirty = [];
    try {
      let status = git(worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".",
        ...artifactExcludePathspecs()
      ]);
      if (status.status !== 0) {
        status = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
      }
      if (status.status === 0) {
        discardDirty = porcelainDirtyPaths(status.stdout);
      }
    } catch {
      // Best-effort listing; discard still proceeds (user asked explicitly).
    }
    const removed = removeWorktree({
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
      diffStat: null,
      discardedUncommitted: discardDirty,
      privateTarget: removed.privateTarget ?? null,
      worktreeOrphaned: noteWorktreeSurvivedRemoval(removed, job.id)
    };
    const dirtyNote =
      discardDirty.length > 0
        ? ` Discarded uncommitted paths: ${discardDirty.slice(0, 8).join(", ")}${discardDirty.length > 8 ? ", …" : ""}.`
        : "";
    const targetNote = removed.privateTarget
      ? ` Freed ${removed.privateTarget.label}.`
      : "";
    const rendered = `Discarded ${job.id}: worktree and branch removed.${dirtyNote}${targetNote}\n`;
    outputCommandResult(payload, rendered, options.json);
    return;
  }

  if (!branchName) {
    throw new Error(`Run ${job.id} worktree is missing a branch name.`);
  }
  if (!baseSha) {
    throw new Error(`Run ${job.id} worktree is missing baseSha.`);
  }

  // Parent landing its own branch: surface unlanded nested children so the
  // caller knows land will not merge their work.
  const parentChildren = Array.isArray(storedJob.children) ? storedJob.children : [];
  const unlandedChildren = parentChildren.filter((child) => {
    if (!childIsLandable(child?.status)) {
      return false;
    }
    if (child?.landedInto) {
      return false;
    }
    // worktree null + landedInto set is the post-land marker; a still-landable
    // child with a branch/worktree path is unlanded.
    return Boolean(child?.branch || child?.worktree);
  });
  if (unlandedChildren.length > 0 && !options.discard && !options.preview) {
    const lines = unlandedChildren.map((child) => {
      const id = child.runId ?? child.id;
      return `  land ${id} --into-run ${job.id}`;
    });
    process.stderr.write(
      `[grok-build] Warning: ${unlandedChildren.length} nested child run(s) completed but were never ` +
        `landed into this worktree. Landing the parent will not include their branches.\n` +
        `${lines.join("\n")}\n`
    );
  }

  // Three-dot, matching what `git merge --squash` will actually stage.
  //
  // Two-dot compares baseSha directly to the branch tip, but the apply is a
  // merge-base squash. If HEAD moved off baseSha since the run started (the
  // user checked out a release branch, or reset), those disagree: the preview
  // said "1 file changed", the >50-file refusal never fired, and the merge
  // staged 61 files. `commands/land.md` makes that preview the approval gate,
  // so the gate was exactly as wrong as the apply.
  const diffRange = `${baseSha}...${branchName}`;
  // The preview is only meaningful if baseSha is still reachable from HEAD.
  const baseIsAncestor =
    git(repoRoot, ["merge-base", "--is-ancestor", baseSha, "HEAD"]).status === 0;
  if (!baseIsAncestor) {
    process.stderr.write(
      `[turbo-build] Warning: this run's base commit (${baseSha.slice(0, 8)}) is no longer an ` +
        `ancestor of HEAD — the branch was moved or reset since the run started. The squash ` +
        `will use the merge-base, so it may bring in commits this preview does not list. ` +
        `Verify with: git diff --cached --name-only (after landing) or land --discard.\n`
    );
  }
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
  const landNames = gitChecked(repoRoot, ["diff", "--name-only", diffRange])
    .stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const allowedTop = storedJob.allowedPaths ?? storedJob.allowed_paths ?? worktree.allowedPaths ?? null;
  if (Array.isArray(allowedTop) && allowedTop.length > 0) {
    const fold = process.platform === "win32"
      ? (p) => String(p).replace(/\\/g, "/").toLowerCase()
      : (p) => String(p).replace(/\\/g, "/");
    const prefixes = allowedTop.map((p) => fold(String(p).replace(/\/+$/, "")));
    const outside = landNames.filter((file) => {
      if (isHarnessLandPath(file)) {
        return false;
      }
      const n = fold(file);
      return !prefixes.some((pre) => n === pre || n.startsWith(`${pre}/`));
    });
    if (outside.length > 0) {
      throw new Error(
        `land refused: ${outside.length} path(s) outside allowed_paths (${outside.slice(0, 8).join(", ")}).`
      );
    }
  }
  if (landNames.length > 50 && !options.force && !options.discard) {
    throw new Error(
      `land refused: ${landNames.length} files exceeds the 50-file safety limit. Pass --force to land anyway.`
    );
  }

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

  // Only worth a second git call once the filtered result came back clean. It
  // does two jobs: it tells the user land proceeded despite visible dirt, and
  // it re-checks the half of that dirt the pathspec filter should never have
  // waved through.
  const { untracked: ignoredDirtyArtifacts, tracked: exemptedTrackedDirt } =
    classifyIgnoredDirtyArtifacts(repoRoot, dirtyFiles);

  // Deliberately BEFORE the merge. The pathspec filter above exempts by path,
  // never by tracked state, so it also waves through an uncommitted edit to a
  // TRACKED file that happens to sit under `node_modules/`, `obj/`, `.godot/`
  // and friends - and if the squash merge then conflicts,
  // recoverFromFailedLandMerge's `git reset --hard HEAD` destroys exactly that
  // edit, unrecoverably and without mentioning it. Only the untracked half of
  // what the filter dropped is safe to land over; a hard reset cannot touch an
  // untracked file, so `?? .godot/` stays exempt.
  if (exemptedTrackedDirt.length > 0) {
    const named = exemptedTrackedDirt.slice(0, 5).join(", ");
    throw new Error(
      `Refusing to land: ${named} has uncommitted changes and land may have to hard-reset ` +
        `to recover from a merge conflict. Commit or stash it first.`
    );
  }

  // Empty branch range: git merge --squash exits 0 with "Already up to date"
  // and stages nothing. If we then force-delete the worktree, any uncommitted
  // files that were the run's only copy are destroyed under a success message.
  if (!diffStat) {
    let wtStatus = git(worktreePath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".",
      ...artifactExcludePathspecs()
    ]);
    if (wtStatus.status !== 0) {
      wtStatus = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
    }
    if (wtStatus.status !== 0) {
      throw new Error(
        `Refusing to land ${job.id}: branch has no commits beyond base, and the worktree could not be inspected (${(wtStatus.stderr || wtStatus.stdout || "").trim() || "git status failed"}). Resolve the worktree or use land --discard to drop it explicitly.`
      );
    }
    const wtDirty = porcelainDirtyPaths(wtStatus.stdout);
    if (wtDirty.length > 0) {
      const named = wtDirty.slice(0, 8).join(", ");
      throw new Error(
        `Refusing to land ${job.id}: branch ${branchName} has no commits beyond base, but the worktree has uncommitted work (${named}${wtDirty.length > 8 ? ", …" : ""}). ` +
          `Commit inside the worktree first, or use land --discard to drop it explicitly.`
      );
    }
    // Empty branch + clean worktree: nothing to stage. Remove the empty
    // worktree but do not claim a successful land of staged changes.
    const removedEmpty = removeWorktree({
      repoRoot,
      worktreePath,
      branchName,
      deleteBranch: true
    });
    const orphanEmpty = noteWorktreeSurvivedRemoval(removedEmpty, job.id);
    markJobLanded(workspaceRoot, job.id, storedJob, "apply-empty");
    const currentBranch = getCurrentBranch(repoRoot);
    const payload = {
      jobId: job.id,
      action: "apply-empty",
      landed: false,
      worktree,
      diffStat: "",
      totalBinaryFiles: 0,
      ignoredDirtyArtifacts,
      worktreeOrphaned: orphanEmpty
    };
    const text =
      `Nothing to land: ${branchName} has no commits beyond base (and the worktree is clean). ` +
      `Removed empty worktree for ${job.id}. Current branch: ${currentBranch}.\n`;
    outputCommandResult(payload, text, options.json);
    return;
  }

  // Unchecked on purpose: gitChecked would throw with git's raw stderr and
  // leave the repository sitting in a half-merged state with conflict markers
  // in the index, the worktree still present, and the job still unlanded - and
  // the recovery every user reaches for, `git merge --abort`, fails with
  // "There is no merge to abort" because --squash never writes MERGE_HEAD.
  const merge = git(repoRoot, ["merge", "--squash", branchName]);
  if (merge.status !== 0) {
    throw new Error(recoverFromFailedLandMerge(repoRoot, job.id, branchName, merge));
  }

  const removed = removeWorktree({
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
    ignoredDirtyArtifacts,
    privateTarget: removed.privateTarget ?? null,
    worktreeOrphaned: noteWorktreeSurvivedRemoval(removed, job.id)
  };
  const text =
    (diffStat ? `${diffStat}\n\n` : "") +
    (totalBinaryFiles > 0 ? `Total: ${totalBinaryFiles} binary file(s)\n\n` : "") +
    (ignoredDirtyArtifacts.length > 0
      ? `Ignored ${ignoredDirtyArtifacts.length} dirty generated artifact path(s) in the dirty-tree check: ${ignoredDirtyArtifacts.slice(0, 5).join(", ")}\n\n`
      : "") +
    (removed.privateTarget ? `Removed ${removed.privateTarget.label}.\n\n` : "") +
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

/**
 * Guarantee that a background worker's death is always explained.
 *
 * Every previous exit path out of this process except runTrackedJob's own
 * try/catch was silent: the job file stayed "running" with a dead pid, and only
 * the reconciler's generic "Run abandoned; process exited without a terminal
 * claim." ever reached the user - a sentence that says a process died without
 * saying why, which is what made two different failures indistinguishable in
 * the field.
 *
 * Three nets, in the order they can fire:
 *  - unhandledRejection / uncaughtException: the real error, with its stack,
 *    into the run log AND the terminal claim.
 *  - exit: a last-chance sweep for any other way out (an explicit exit deep in
 *    a library, a fatal signal Node still runs handlers for). Synchronous by
 *    necessity, which is why every write it performs is a *Sync call.
 *
 * All of it is best-effort: a failure to explain the failure must not itself
 * throw, or the worker dies silently again for a new reason.
 *
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {string|null} logFile
 * @returns {() => void} disarm, called once the run claimed its own outcome
 */
function installWorkerCrashGuards(workspaceRoot, jobId, logFile) {
  let armed = true;

  const claimCrash = (label, error) => {
    if (!armed) {
      return;
    }
    armed = false;
    const detail =
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}`.trim()
        : String(error ?? "unknown");
    try {
      appendLogBlock(logFile, `Background worker ${label}`, detail);
    } catch {
      // Nothing left to log with.
    }
    try {
      claimJobTerminal(workspaceRoot, jobId, "failed", {
        // The actual reason, not "abandoned". Truncated because errorMessage is
        // rendered inline by `runs`; the full stack is in the log block above.
        errorMessage: `Background worker ${label}: ${
          error instanceof Error ? error.message : String(error ?? "unknown")
        }`.slice(0, 2000),
        phase: "failed",
        bridgePid: null,
        agentPid: null,
        pid: null,
        logFile
      });
    } catch {
      // The reconciler remains the backstop.
    }
  };

  const onUncaught = (error) => {
    claimCrash("crashed", error);
    process.exit(1);
  };
  const onRejection = (reason) => {
    claimCrash("crashed", reason);
    process.exit(1);
  };
  const onExit = (code) => {
    if (!armed) {
      return;
    }
    claimCrash(
      "exited without completing",
      new Error(`process exited with code ${code} before the run claimed an outcome`)
    );
  };

  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  process.on("exit", onExit);

  return () => {
    armed = false;
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
    process.off("exit", onExit);
  };
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for run-worker.");
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const jobId = String(options["job-id"]);
  // Armed BEFORE the stored job is read: "the job file never appeared" and
  // "the request payload was malformed" are themselves failures a background
  // caller could previously only see as an empty log.
  const disarmGuards = installWorkerCrashGuards(
    workspaceRoot,
    jobId,
    resolveJobLogFile(workspaceRoot, jobId)
  );

  try {
    return await runTaskWorker(workspaceRoot, jobId);
  } finally {
    disarmGuards();
  }
}

async function runTaskWorker(workspaceRoot, jobId) {
  const storedJob = await readStoredJobWithRetry(workspaceRoot, jobId);
  if (!storedJob) {
    throw new Error(`No stored job found for ${jobId}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${jobId} is missing its run request payload.`);
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
  const workspaceRoot = resolveCommandWorkspace(options);
  reconcileAbandonedInWorkspace(workspaceRoot);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    // waitForSingleJobSnapshot already computes waitTimedOut/timeoutMs (grep
    // finds exactly one other reference to waitTimedOut in this file, the
    // assignment) - only buildSingleJobSnapshot's plain path never wanted
    // them. Passing snapshot.job alone here dropped both silently, so
    // `runs --wait` on a run that outlived the wait reported nothing
    // different from a run still merely queued.
    outputCommandResult(
      snapshot,
      renderJobStatusReport(snapshot.job, {
        waitTimedOut: snapshot.waitTimedOut,
        timeoutMs: snapshot.timeoutMs
      }),
      options.json
    );
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
  const workspaceRootPre = resolveCommandWorkspace(options);
  reconcileAbandonedInWorkspace(workspaceRootPre);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  // Hydrate index gaps from the job file so show never prints null for usage
  // that was only stored on jobs/<id>.json.
  const hydrated = hydrateJobFromStored(workspaceRoot, job);
  // Human form: answer + status trailer + BRIDGE-RESULT.
  // JSON form: versioned run manifest (schema under plugins/turbo-build-plugin/schemas/).
  // compat.job / compat.storedJob preserve the pre-manifest shape for one minor.
  if (options.json) {
    outputResult(buildRunManifest(hydrated, storedJob), true);
    return;
  }
  outputCommandResult(
    { job: hydrated, storedJob },
    renderStoredJobResult(hydrated, storedJob),
    false
  );
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

function terminateJobProcessTrees(job, options = {}) {
  const targets =
    options.pids != null
      ? options.pids
      : options.workspaceRoot
        ? resolveJobTreeKillTargets(options.workspaceRoot, job).pids
        : resolveJobKillTargets(job);
  const results = [];
  const survivors = [];
  for (const pid of targets) {
    const outcome = terminateProcessTree(pid);
    results.push({ pid, ...outcome });
    // Only trust the explicit survivors list from the kill path. A process that
    // was already gone returns delivered:false with no survivors — that is a
    // clean "nothing to kill", not a survivor to report.
    if (Array.isArray(outcome.survivors) && outcome.survivors.length > 0) {
      survivors.push(...outcome.survivors);
    }
  }
  if (results.length === 0) {
    return {
      attempted: false,
      delivered: false,
      method: null,
      errorText: null,
      survivors: [],
      results: [],
      killTargets: targets
    };
  }
  const uniqueSurvivors = [...new Set(survivors)];
  const anyDelivered = results.some((entry) => entry.delivered);
  return {
    attempted: results.some((entry) => entry.attempted),
    // Never claim a clean stop when any process is known still alive.
    delivered: anyDelivered && uniqueSurvivors.length === 0,
    method: results.map((entry) => entry.method).filter(Boolean).join("+") || null,
    errorText: results.map((entry) => entry.errorText).filter(Boolean).join("; ") || null,
    survivors: uniqueSurvivors,
    results,
    killTargets: targets
  };
}

/**
 * Snapshot tree kill PIDs, claim every nested descendant cancelled (leaf-first),
 * optionally claim the root cancelled, then kill the whole tree.
 * PIDs must be resolved *before* claims null them on disk (C21).
 * Root claim before kill is load-bearing (H3): otherwise a finishing runner can
 * claim completed first and stop loses (cancelled-wins cannot overwrite).
 */
function cancelJobTree(workspaceRoot, rootJob, options = {}) {
  // Snapshot + claim non-root descendants first (C21). PID snapshot is taken
  // inside claimJobTreeDescendantsCancelled *before* any claim nulls fields.
  const { pids, childClaims, treeJobIds } = claimJobTreeDescendantsCancelled(
    workspaceRoot,
    rootJob,
    {
      childErrorMessage: options.childErrorMessage ?? "Stopped because parent run was cancelled.",
      onChildClaimed: (node) => {
        if (rootJob.id && node.parentRunId === rootJob.id) {
          linkChildOutcomeToParent(workspaceRoot, rootJob.id, {
            id: node.id,
            status: "cancelled",
            changedFileCount: node.changedFileCount ?? null,
            usage: node.usage ?? null,
            worktree: node.worktree ?? null
          });
        }
      }
    }
  );

  // H3: claim root cancelled *before* kill so a finishing runner cannot win
  // completed over stop (cancelled-wins only blocks later completed if we claim first).
  let rootClaim = null;
  if (options.claimRoot !== false && rootJob?.id) {
    try {
      rootClaim = claimJobTerminal(workspaceRoot, rootJob.id, "cancelled", {
        errorMessage: options.rootErrorMessage ?? "Stopped by user.",
        phase: "cancelled",
        pid: null,
        agentPid: null,
        bridgePid: null,
        logFile: rootJob.logFile ?? null
      });
    } catch (error) {
      rootClaim = {
        claimed: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // Kill uses pre-claim snapshot (includes root + descendant PIDs).
  const killResult = terminateJobProcessTrees(rootJob, { pids });
  return { childClaims, killResult, treeJobIds, rootClaim, pids };
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRootPre = resolveCommandWorkspace(options);
  reconcileAbandonedInWorkspace(workspaceRootPre);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? job;
  const preClaimRecord = { ...job, ...existing };
  // H3: claim descendants + root first (with pre-claim PID snapshot), then kill.
  const treeCancel = cancelJobTree(workspaceRoot, preClaimRecord, {
    childErrorMessage: "Stopped because parent run was cancelled by user.",
    rootErrorMessage: "Stopped by user.",
    claimRoot: true
  });
  const killTargets = treeCancel.killResult.killTargets ?? treeCancel.pids ?? [];
  const claim = treeCancel.rootClaim ?? {
    claimed: false,
    status: existing.status,
    job: existing
  };

  const killResult = treeCancel.killResult;

  if (!claim.claimed && claim.status && claim.status !== "cancelled") {
    const payload = {
      jobId: job.id,
      status: claim.status,
      title: claim.job?.title ?? job.title,
      killAttempted: killResult.attempted,
      killDelivered: killResult.delivered,
      killMethod: killResult.method,
      killSurvivors: killResult.survivors,
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
      : `Stop claimed; process tree kill delivered=${killResult.delivered} method=${killResult.method ?? "none"} survivors=${(killResult.survivors ?? []).join(",") || "unknown"}.`
  );

  const merged = claimJobTerminal(workspaceRoot, job.id, "cancelled", {
    errorMessage: killResult.delivered
      ? "Stopped by user."
      : "Stop claimed but process may still be running (kill not delivered).",
    cancelKill: killResult,
    // Tombstone when kill could not be confirmed — stop must never pretend
    // the tree is gone if survivors remain.
    killTombstone:
      killResult.delivered
        ? null
        : {
            at: nowIso(),
            survivors: killResult.survivors ?? [],
            method: killResult.method,
            errorText: killResult.errorText
          },
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
    killSurvivors: killResult.survivors,
    killErrorText: killResult.errorText,
    killTargets,
    childClaims: treeCancel.childClaims,
    cascadedChildren: treeCancel.treeJobIds.filter((id) => id !== job.id),
    claimOrder: "claim-before-kill",
    claimed: claim.claimed
  };

  outputCommandResult(
    payload,
    renderCancelReport({ ...nextJob, ...payload, cancelKill: killResult }),
    options.json
  );
}

/**
 * Block until a run reaches a terminal state (or timeout), then print the same
 * result `show` would. Reuses `runs --wait` machinery so there is one wait path.
 */
async function handleWait(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    // --timeout is seconds (user-facing); --timeout-ms is the runs-compatible form.
    valueOptions: ["cwd", "timeout", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (!reference) {
    throw new Error("`wait` requires a run id.");
  }

  let timeoutMs = options["timeout-ms"];
  if (timeoutMs == null && options.timeout != null) {
    const seconds = Number(options.timeout);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`--timeout must be a non-negative number of seconds, got ${options.timeout}`);
    }
    timeoutMs = seconds * 1000;
  }

  const snapshot = await waitForSingleJobSnapshot(cwd, reference, {
    timeoutMs,
    pollIntervalMs: options["poll-interval-ms"]
  });

  if (snapshot.waitTimedOut) {
    const payload = {
      ...snapshot,
      timedOut: true
    };
    outputCommandResult(
      payload,
      renderJobStatusReport(snapshot.job, {
        waitTimedOut: true,
        timeoutMs: snapshot.timeoutMs
      }),
      options.json
    );
    process.exitCode = 1;
    return;
  }

  // Terminal: print the same shape as show (manifest when --json).
  const storedJob = readStoredJob(snapshot.workspaceRoot, snapshot.job.id);
  const hydrated = hydrateJobFromStored(snapshot.workspaceRoot, snapshot.job);
  if (options.json) {
    const manifest = buildRunManifest(hydrated, storedJob);
    manifest.waitTimedOut = false;
    manifest.timeoutMs = snapshot.timeoutMs ?? null;
    outputResult(manifest, true);
    return;
  }
  outputCommandResult(
    {
      job: hydrated,
      storedJob,
      waitTimedOut: false,
      timeoutMs: snapshot.timeoutMs
    },
    renderStoredJobResult(hydrated, storedJob),
    false
  );
}

function handleModels(argv) {
  if (wantsHelp(argv)) {
    printSubcommandHelp("models");
    return;
  }
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const listed = listGrokModels(cwd);
  if (!listed.ok) {
    const message = listed.error || "models failed";
    if (options.json) {
      outputResult(
        {
          schemaVersion: 1,
          ok: false,
          binary: listed.binary,
          brand: listed.brand,
          error: message,
          defaultModel: listed.defaultModel,
          models: listed.models
        },
        true
      );
    } else {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const payload = {
    schemaVersion: 1,
    binary: listed.binary,
    brand: listed.brand,
    defaultModel: listed.defaultModel,
    models: listed.models
  };

  if (options.json) {
    outputResult(payload, true);
    return;
  }

  const lines = [
    `CLI: ${listed.brand?.label ?? "Grok Build"} (${listed.binary})`,
    listed.defaultModel ? `Default model: ${listed.defaultModel}` : "Default model: (none reported)",
    "",
    "Available models:"
  ];
  for (const model of listed.models) {
    const mark = model.default ? " (default)" : "";
    lines.push(`  - ${model.id}  [${model.billing}]${mark}`);
  }
  console.log(lines.join("\n"));
}

async function main() {
  // Before any subcommand, including the detached worker: the CLI cannot read
  // its own credentials or session store without HOME, and Windows shells do
  // not set one. Doing it here rather than per-command means the value is also
  // inherited by every process this one spawns - the agent CLI, verify
  // commands, git - which is the point.
  ensureHomeEnv(process.env);

  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }

  // Subcommand --help short-circuits before any argument validation so
  // `run --help` does not warn about unknown --help then error on a missing prompt.
  if (wantsHelp(argv)) {
    printSubcommandHelp(subcommand);
    return;
  }

  switch (subcommand) {
    case "check":
      await handleCheck(argv);
      break;
    case "doctor":
      await handleDoctor(argv);
      break;
    case "models":
      handleModels(argv);
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
    case "nest-run":
      await handleNestRun(argv);
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
    case "wait":
      await handleWait(argv);
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
  AWAITING_LAND_STATUSES,
  buildBoundedVerifyFixPrompt,
  buildDoctorReport,
  buildEcosystemChecks,
  formatIsolationHeaderLine,
  // detectImplausiblyShort, looksLikeUserQuestion, normalizeReasoningEffort,
  // and KNOWN_REASONING_EFFORTS are already exported at definition.
  loadRunRules,
  main,
  normalizeDoctorCheck,
  PROTECTED_WORKTREE_STATUSES,
  readStoredJobWithRetry,
  renderDoctorReport,
  SAFE_TO_DISCARD_STATUSES
};