import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import {
  createNdjsonDecoder,
  createStreamTranscript,
  extractFinalReport,
  parseStreamEvent
} from "./stream-events.mjs";
import { resolveSpawnInvocation } from "./which.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

const DEFAULT_BINARY = "grok";
const BINARY_ENV = "GROK_BINARY";

/** The HOME value THIS process supplied, when the environment carried none. */
let appliedHomeDefault = null;

// How much raw stdout is shown when the streaming parser recognized nothing at
// all. Enough to carry a final answer and the context around it; small enough
// that a run which streamed megabytes of an unknown format does not push all of
// it into a job record, through redaction, and into the terminal.
const RAW_STDOUT_FALLBACK_LINES = 200;

export function resolveGrokBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

/**
 * Give the CLI a HOME on Windows.
 *
 * The Grok/Hyper CLIs resolve their config, credentials and session store off
 * HOME. Windows does not set it - `%USERPROFILE%` is the equivalent - and
 * whether a shell happens to define one is luck: Git Bash and WSL do, cmd.exe,
 * PowerShell, most CI runners and most agent tool-shells do not.
 *
 * doctor already DETECTED this and printed the right fix. That was the whole
 * problem: it diagnosed a fatal condition and then let `run` queue a job
 * anyway, so the operator got a job id for a run that could not work. Detecting
 * a fixable environment defect and not fixing it is the worst of both.
 *
 * Only ever fills a blank - an explicit HOME or GROK_HOME is the user's choice
 * and is left exactly as it is.
 *
 * @param {NodeJS.ProcessEnv} [env] mutated in place
 * @returns {{ applied: boolean, home: string|null, source: string|null }}
 */
export function ensureHomeEnv(env = process.env, platform = process.platform) {
  const existing = env.HOME ?? env.GROK_HOME;
  if (existing && String(existing).trim()) {
    // Idempotent by design - main() fills HOME once at startup and doctor asks
    // again later to report on it. Without this the second caller would see a
    // set HOME and report the user's environment as healthy, when in fact it
    // was this process that supplied the value and nothing outside it has one.
    if (appliedHomeDefault && appliedHomeDefault === String(existing).trim()) {
      return { applied: false, home: appliedHomeDefault, source: "USERPROFILE", defaulted: true };
    }
    return {
      applied: false,
      home: String(existing).trim(),
      source: env.HOME ? "HOME" : "GROK_HOME",
      defaulted: false
    };
  }
  if (platform !== "win32") {
    // On POSIX an absent HOME is a genuinely broken environment rather than a
    // platform default, and there is no second variable to derive it from.
    return { applied: false, home: null, source: null, defaulted: false };
  }
  const profile = env.USERPROFILE ?? (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : null);
  if (!profile || !String(profile).trim()) {
    return { applied: false, home: null, source: null, defaulted: false };
  }
  const home = String(profile).trim();
  env.HOME = home;
  // GROK_HOME too: the CLI prefers it when set, and leaving it blank while
  // filling HOME would make the two disagree for anything reading either.
  if (!env.GROK_HOME || !String(env.GROK_HOME).trim()) {
    env.GROK_HOME = home;
  }
  appliedHomeDefault = home;
  return { applied: true, home, source: "USERPROFILE", defaulted: true };
}

/** Test seam: forget that this process supplied a HOME default. */
export function resetHomeEnvDefaultForTests() {
  appliedHomeDefault = null;
}

export function runGrok(args = [], options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  return runCommand(binary, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio
  });
}

/**
 * Which CLI is actually behind `GROK_BINARY`.
 *
 * `GROK_BINARY` has always accepted any compatible executable, and community
 * builds of Grok Build ship under their own name (Hyper is the common one:
 * same CLI surface, same `~/.grok` config and auth, different binary). When the
 * bridge is driving one of those, saying "install the Grok Build CLI" on
 * failure sends the user to the wrong product.
 *
 * Detection is on the version banner rather than the binary path, because the
 * path may be a shim, a symlink, or a bare name resolved through PATH.
 * Unknown output falls back to Grok Build, which is the historical behaviour.
 *
 * @param {string | null | undefined} versionDetail Output of `<binary> version`
 * @returns {{ id: string, label: string }}
 */
export function detectCliBrand(versionDetail) {
  const text = String(versionDetail ?? "").trim().toLowerCase();
  if (/\bhyper\b/.test(text)) {
    return { id: "hyper", label: "Hyper" };
  }
  return { id: "grok", label: "Grok Build" };
}

/**
 * Remediation text for "the CLI is not runnable".
 *
 * Branches on whether `GROK_BINARY` is actually overriding the default. Telling
 * someone who deliberately pointed the bridge at `hyper` to "install the Grok
 * Build CLI" is wrong twice over: they did not want that product, and the real
 * fault is almost always a bad path or a binary that is not executable.
 *
 * @param {string} binary The binary the bridge tried to run
 * @returns {string}
 */
export function describeMissingBinary(binary) {
  const name = String(binary ?? "").trim() || DEFAULT_BINARY;
  if (name === DEFAULT_BINARY) {
    return "Install the Grok Build CLI and ensure `grok` is on PATH (or point GROK_BINARY at a compatible CLI, e.g. a Hyper build).";
  }
  return `\`${name}\` (from GROK_BINARY) could not be run. Check the path is correct and executable, or unset GROK_BINARY to fall back to the default \`grok\` CLI.`;
}

export function getGrokAvailability(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const versionStatus = binaryAvailable(binary, ["version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    const alt = binaryAvailable(binary, ["--version"], { cwd, env: options.env });
    if (!alt.available) {
      return {
        available: false,
        detail: versionStatus.detail,
        binary,
        brand: detectCliBrand(null)
      };
    }
    return {
      available: true,
      detail: alt.detail,
      binary,
      brand: detectCliBrand(alt.detail)
    };
  }
  return {
    available: true,
    detail: versionStatus.detail,
    binary,
    brand: detectCliBrand(versionStatus.detail)
  };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "models-probe",
    authMethod: null,
    verified: null,
    ...fields
  };
}

/**
 * Infer how a model id is billed from its provider prefix.
 * openai-codex/* is ChatGPT-subscription routing; openai/* is metered;
 * nvidia/* needs a provider key; bare xAI ids (and xai-direct/*) are default.
 */
export function inferModelBillingRoute(modelId) {
  const id = String(modelId ?? "").trim();
  if (!id) {
    return { route: "default", billing: "default" };
  }
  if (id.startsWith("openai-codex/")) {
    return { route: "openai-codex", billing: "subscription" };
  }
  if (id.startsWith("openai/")) {
    return { route: "openai", billing: "pay-per-token" };
  }
  if (id.startsWith("nvidia/")) {
    return { route: "nvidia", billing: "provider-key" };
  }
  if (id.startsWith("xai-direct/")) {
    return { route: "xai-direct", billing: "default" };
  }
  return { route: "default", billing: "default" };
}

/**
 * Parse `<binary> models` stdout into structured model rows.
 * Hyper exits 255 on a successful listing; callers must not require status 0.
 *
 * @param {string} stdout
 * @returns {{ defaultModel: string|null, models: Array<{id: string, route: string, billing: string, default: boolean}> }}
 */
export function parseModelsOutput(stdout) {
  const text = String(stdout ?? "");
  const lines = text.split(/\r?\n/);
  let defaultModel = null;
  const ids = [];
  const seen = new Set();

  for (const line of lines) {
    const defaultMatch = line.match(/^\s*Default model:\s*(.+?)\s*$/i);
    if (defaultMatch) {
      defaultModel = defaultMatch[1].trim();
      continue;
    }
    // Bullet / dashed list lines under "Available models:"
    const bullet = line.match(/^\s*[-*•]\s+(\S+)\s*$/);
    if (bullet) {
      const id = bullet[1].trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
      continue;
    }
    // Indented bare id (some CLIs print two-space indented names without a dash)
    const indented = line.match(/^\s{2,}(\S+)\s*$/);
    if (indented && /available models/i.test(text)) {
      const id = indented[1].trim();
      if (id && !seen.has(id) && id !== defaultModel) {
        // Avoid grabbing section headers
        if (/^(available|default|you are|logged)/i.test(id)) {
          continue;
        }
        seen.add(id);
        ids.push(id);
      }
    }
  }

  if (defaultModel && !seen.has(defaultModel)) {
    ids.unshift(defaultModel);
    seen.add(defaultModel);
  }

  const models = ids.map((id) => {
    const { route, billing } = inferModelBillingRoute(id);
    return {
      id,
      route,
      billing,
      default: Boolean(defaultModel && id === defaultModel)
    };
  });

  return { defaultModel, models };
}

/**
 * True when stdout looks like a successful models listing even if exit != 0.
 * Hyper returns 255 with a full list; treating that as auth-failure made every
 * Hyper user look logged out.
 */
export function modelsOutputLooksSuccessful(stdout) {
  const text = String(stdout ?? "");
  if (!text.trim()) {
    return false;
  }
  return /available models|default model|logged in/i.test(text);
}

export function runModelsProbe(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const result = runGrok(["models"], {
    cwd,
    env: options.env,
    binary
  });

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return buildAuthStatus({
      available: false,
      loggedIn: false,
      detail: "grok binary not found",
      source: "availability"
    });
  }

  if (result.error) {
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: result.error.message,
      source: "models-probe"
    });
  }

  const stdout = (result.stdout || "").trim();
  // Hyper exits 255 on a successful listing. Status alone is not auth signal.
  if (result.status !== 0 && !modelsOutputLooksSuccessful(stdout)) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: detail || "grok models failed; not logged in or not ready",
      source: "models-probe"
    });
  }

  if (!stdout && result.status !== 0) {
    const detail = (result.stderr || `exit ${result.status}`).trim();
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: detail || "grok models failed; not logged in or not ready",
      source: "models-probe"
    });
  }

  const loggedInHint = /logged in|available models|default model/i.test(stdout);
  return buildAuthStatus({
    available: true,
    loggedIn: true,
    detail: loggedInHint
      ? firstLine(stdout) || "grok models succeeded"
      : firstLine(stdout) || "grok models succeeded (treated as logged in)",
    source: "models-probe",
    authMethod: "grok-cli",
    verified: true
  });
}

/**
 * Run `<binary> models` and return structured rows.
 * Non-zero exit is success when the listing body is present (Hyper exits 255).
 */
export function listGrokModels(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const availability = getGrokAvailability(cwd, { ...options, binary });
  const result = runGrok(["models"], {
    cwd,
    env: options.env,
    binary
  });

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return {
      ok: false,
      binary,
      brand: availability.brand,
      error: "binary not found",
      status: result.status,
      defaultModel: null,
      models: []
    };
  }
  if (result.error) {
    return {
      ok: false,
      binary,
      brand: availability.brand,
      error: result.error.message,
      status: result.status,
      defaultModel: null,
      models: []
    };
  }

  const stdout = result.stdout || "";
  const parsed = parseModelsOutput(stdout);
  const ok = result.status === 0 || modelsOutputLooksSuccessful(stdout) || parsed.models.length > 0;
  if (!ok) {
    return {
      ok: false,
      binary,
      brand: availability.brand,
      error: (result.stderr || stdout || `exit ${result.status}`).trim() || "models failed",
      status: result.status,
      defaultModel: parsed.defaultModel,
      models: parsed.models,
      raw: stdout
    };
  }

  return {
    ok: true,
    binary,
    brand: availability.brand,
    status: result.status,
    defaultModel: parsed.defaultModel,
    models: parsed.models,
    raw: stdout
  };
}

/**
 * Refuse a run that targets a pay-per-token model unless the user opted in.
 * Subscription / default / provider-key routes are not gated.
 *
 * @param {string|null|undefined} modelId
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ allowed: boolean, billing: string, message?: string }}
 */
export function assertModelBillingAllowed(modelId, env = process.env) {
  if (modelId == null || !String(modelId).trim()) {
    return { allowed: true, billing: "default" };
  }
  const { billing, route } = inferModelBillingRoute(modelId);
  if (billing !== "pay-per-token") {
    return { allowed: true, billing, route };
  }
  if (String(env?.GROK_BUILD_ALLOW_PAY_PER_TOKEN ?? "") === "1") {
    return { allowed: true, billing, route };
  }
  return {
    allowed: false,
    billing,
    route,
    message:
      `Model \`${String(modelId).trim()}\` is billed pay-per-token (${route}). ` +
      `Set GROK_BUILD_ALLOW_PAY_PER_TOKEN=1 to allow it, or pick a subscription/default model.`
  };
}

export function getGrokAuthStatus(cwd, options = {}) {
  const availability = getGrokAvailability(cwd, options);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }
  return runModelsProbe(cwd, { ...options, binary: availability.binary });
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

/**
 * A completed assistant message can be arbitrarily long - a single turn of a
 * long agentic run routinely runs to several KB of narration. That full body
 * used to travel as the progress `message` itself, which a foreground run
 * writes to stderr as the run streams (see createProgressReporter in
 * tracked-jobs.mjs) - and the SAME text then reappears verbatim as the run's
 * own stdout result a moment later. One foreground terminal, the whole
 * transcript printed twice. Only this short preview goes out as `message` now;
 * the full body still reaches the durable log file, in full, exactly once,
 * via the `logTitle`/`logBody` progress fields consumeLine sets alongside it.
 */
function shortenForProgress(text, limit = 200) {
  const first = String(text ?? "")
    .split(/\r?\n/)
    .find(Boolean) ?? "";
  return first.length <= limit ? first : `${first.slice(0, limit - 3)}...`;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

// Windows does not have one command-line limit, it has two, and both are well
// under what a review diff can reach. Measured on this box: a single 40 000-char
// argv element handed straight to CreateProcess fails outright with
// ENAMETOOLONG; the SAME prompt routed through the `cmd.exe /d /s /c` form that
// which.mjs:155-167 produces for a `.cmd` shim dies at ~8 500 chars with
// `The command line is too long.` on stderr, status 1 and NO `error` field - so
// the user saw nothing but "Grok exited with status 1".
//
// POSIX is not exempt, just later: Linux caps a SINGLE argument at
// MAX_ARG_STRLEN (32 pages = 131 072 bytes) regardless of how much total room
// ARG_MAX allows, so a large enough prompt is E2BIG there too.
export const PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM = 7000;
export const PROMPT_ARGV_BUDGET_WIN32 = 28000;
export const PROMPT_ARGV_BUDGET_POSIX = 120 * 1024;
// Floor, so a pathological pile of other flags cannot resolve the prompt's
// share to zero (or negative) and produce an argument that is nothing but an
// elision marker. Overflowing is still possible in that degenerate case, but a
// prompt is not worth sending at all below this.
const MIN_PROMPT_ARGV_BUDGET = 1024;
// Rough per-argument cost of the separator and quoting the OS adds around each
// argv element. Deliberately pessimistic - the point is to stay under a hard
// limit, not to use every last byte of it.
const ARGV_ELEMENT_OVERHEAD_BYTES = 3;

function argvBytes(values, initial = 0) {
  return values.reduce(
    (total, value) => total + Buffer.byteLength(String(value ?? ""), "utf8") + ARGV_ELEMENT_OVERHEAD_BYTES,
    initial
  );
}

/**
 * How many bytes the prompt argument may occupy.
 *
 * Derived from the invocation SHAPE, not just the platform: the cmd.exe shim
 * form has roughly a quarter of the direct form's headroom. `otherArgvBytes`
 * is subtracted because the limit is on the whole command line - the critique
 * path alone also carries a serialized `--json-schema`, which is far from free.
 */
export function resolvePromptArgvBudget(options = {}) {
  const platform = options.platform ?? process.platform;
  const explicit = Number(options.argvBudget);
  const total =
    Number.isFinite(explicit) && explicit > 0
      ? Math.floor(explicit)
      : platform === "win32"
        ? options.cmdShim
          ? PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM
          : PROMPT_ARGV_BUDGET_WIN32
        : PROMPT_ARGV_BUDGET_POSIX;

  const other = Number(options.otherArgvBytes);
  const reserved = Number.isFinite(other) && other > 0 ? Math.floor(other) : 0;
  return Math.max(MIN_PROMPT_ARGV_BUDGET, total - reserved);
}

/**
 * Middle-truncate a prompt to fit a byte budget.
 *
 * The middle is what goes: the head carries the task framing and the tail
 * carries the newest hunks, the untracked section and any schema instructions -
 * i.e. both ends are load-bearing and the interior of a huge diff is the part a
 * reviewer can re-read from disk.
 *
 * @returns {{prompt: string, elidedBytes: number, originalBytes: number}}
 */
export function boundPromptForArgv(prompt, budgetBytes) {
  const raw = String(prompt ?? "");
  const buffer = Buffer.from(raw, "utf8");
  if (buffer.length <= budgetBytes) {
    return { prompt: raw, elidedBytes: 0, originalBytes: buffer.length };
  }

  const markerFor = (bytes) =>
    `\n\n[... ${bytes} bytes elided: prompt exceeded the platform command-line limit ...]\n\n`;
  // Reserve against the LONGEST marker this can produce - the elided count can
  // never exceed the whole prompt - plus slack for the two cut points: slicing a
  // Buffer mid-character turns each stray byte into a 3-byte U+FFFD, so the
  // decoded string can come back slightly longer than the slices were.
  const reserved = Buffer.byteLength(markerFor(buffer.length), "utf8") + 32;
  const available = Math.max(0, budgetBytes - reserved);
  const headBytes = Math.floor(available * 0.35);
  const tailBytes = available - headBytes;
  const elidedBytes = buffer.length - headBytes - tailBytes;

  return {
    prompt:
      buffer.subarray(0, headBytes).toString("utf8") +
      markerFor(elidedBytes) +
      buffer.subarray(buffer.length - tailBytes).toString("utf8"),
    elidedBytes,
    originalBytes: buffer.length
  };
}

/**
 * Spill an oversized prompt to disk so `--prompt-file` can carry it verbatim.
 * The file is kept rather than deleted: it is the exact input of a run that is
 * about to be logged, and a few tens of KB next to the job records it belongs
 * with is cheaper than not being able to reproduce the run.
 */
function writePromptFile(directory, prompt) {
  const promptsDir = path.join(String(directory), "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  const filePath = path.join(promptsDir, `prompt-${Date.now()}-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(filePath, prompt, "utf8");
  return filePath;
}

/**
 * Deny rules applied to a read-only headless run.
 *
 * These are belt and braces over `--permission-mode plan`, not a replacement for
 * it. Measured on Hyper 0.2.114-r5: a deny rule is evaluated BEFORE
 * `--always-approve`, and it covers the shell as well as the edit tools - a
 * `run_terminal_command` that redirects into a denied path is refused with
 * `Denied by permission policy: deny rule on edit matching "<glob>"`. That makes
 * deny the only write-blocking mechanism that actually holds on Windows, where
 * the OS sandbox is compiled out entirely
 * (`xai-grok-sandbox`: `#[cfg(all(feature = "enforce", unix))]`).
 */
export const READ_ONLY_DENY_RULES = Object.freeze([
  "Edit(**)",
  "Write(**)",
  "NotebookEdit(**)"
]);

/**
 * Normalise a filesystem path for Hyper deny/allow globs.
 *
 * Forward slashes, no trailing slash. Measured on Windows: Hyper accepts
 * `C:/Users/…/main/**` and evaluates it against absolute tool targets. A
 * trailing slash would double up with the `/**` suffix.
 *
 * @param {string} targetPath
 * @returns {string}
 */
export function normalizePathForPermissionRule(targetPath) {
  return String(targetPath ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

/**
 * True when `inner` is the same as or nested under `outer` after normalisation.
 * Used to refuse a self-denying rule that would block the run's own worktree.
 *
 * @param {string} outer
 * @param {string} inner
 * @returns {boolean}
 */
export function pathIsInsideOrEqual(outer, inner) {
  const a = normalizePathForPermissionRule(outer).toLowerCase();
  const b = normalizePathForPermissionRule(inner).toLowerCase();
  if (!a || !b) {
    return false;
  }
  return b === a || b.startsWith(`${a}/`);
}

/**
 * Deny rules that keep an isolated write run out of the main checkout.
 *
 * Measured: `--deny` beats `--always-approve` and covers the shell too
 * (Hyper permission/manager.rs evaluates deny first). Skip the rules entirely
 * when the worktree sits inside `workspaceRoot` — that would self-deny the
 * only writable root. Callers should log a warning in that case.
 *
 * TWO rule shapes, because one is not enough. Hyper matches a deny glob against
 * the path string the model supplied, WITHOUT canonicalising it, so an absolute
 * rule alone is evadable. Both evasions below were reproduced against
 * hyper 0.2.114-r5 on Windows and confirmed on disk, not from the agent's own
 * account of what happened:
 *
 *   `<worktree>/../Main Repo/x.txt`  -> WROTE into the main checkout.
 *   `<parent>/MAINRE~1/x.txt`        -> WROTE into the main checkout (8.3 short
 *                                       name; `fsutil 8dot3name` is enabled on a
 *                                       default Windows install).
 *
 * The segment-anchored form (`**\/<basename>/**`) closes the `..` traversal,
 * because the literal string still contains the directory name. It cannot close
 * the short-name evasion — every ancestor has a short form — and no glob can.
 * That needs canonicalisation inside Hyper (`--confine`), which is why the
 * post-run breach detector remains the backstop rather than an afterthought.
 *
 * The segment rule is only safe when that name cannot also appear INSIDE the
 * worktree: a repository called `src` would otherwise deny `<worktree>/src/**`
 * and break the run outright. `segmentSafe` is the caller's answer to that
 * question (see worktreeContainsSegment); absent, the rule is left out.
 *
 * @param {string} workspaceRoot
 * @param {string} [worktreePath]
 * @param {{ segmentSafe?: boolean }} [options]
 * @returns {{ rules: string[], skipped: boolean, reason: string|null, segmentRuleApplied: boolean }}
 */
export function buildWorkspaceRootDenyRules(workspaceRoot, worktreePath = null, options = {}) {
  const root = normalizePathForPermissionRule(workspaceRoot);
  if (!root) {
    return { rules: [], skipped: true, reason: "empty-workspace-root", segmentRuleApplied: false };
  }
  if (worktreePath && pathIsInsideOrEqual(root, worktreePath)) {
    return {
      rules: [],
      skipped: true,
      reason: "worktree-inside-workspace-root",
      segmentRuleApplied: false
    };
  }

  const rules = [`Edit(${root}/**)`, `Write(${root}/**)`, `NotebookEdit(${root}/**)`];

  // Last path segment, e.g. "Main Repo" from "C:/…/isotest/Main Repo".
  const segment = root.split("/").filter(Boolean).at(-1) ?? "";
  // A drive root ("C:") has no meaningful segment, and a one-character name is
  // too likely to collide with something inside the tree.
  const segmentUsable = segment.length > 1 && !segment.endsWith(":");
  const segmentRuleApplied = segmentUsable && options.segmentSafe === true;
  if (segmentRuleApplied) {
    rules.push(
      `Edit(**/${segment}/**)`,
      `Write(**/${segment}/**)`,
      `NotebookEdit(**/${segment}/**)`
    );
  }

  return { rules, skipped: false, reason: null, segmentRuleApplied };
}

/**
 * Does any tracked path in the worktree contain `segment` as a directory
 * component? Answers whether a `**\/<segment>/**` deny rule would also deny the
 * run's own writable root.
 *
 * `git ls-files` with the pathspecs does the filtering, so the output is empty
 * (not "every file in the repo") in the safe case — this stays cheap on a large
 * checkout. A git failure returns false: refusing to add the extra rule is the
 * safe direction, since the absolute rules still apply and the breach detector
 * still runs.
 *
 * @param {string} worktreePath
 * @param {string} segment
 * @param {{ gitImpl?: typeof runCommand }} [options]
 * @returns {boolean}
 */
export function worktreeContainsSegment(worktreePath, segment, options = {}) {
  const name = String(segment ?? "").trim();
  if (!worktreePath || !name) {
    return false;
  }
  const runner = options.gitImpl ?? runCommand;
  const result = runner(
    "git",
    ["ls-files", "-z", "--", `${name}/*`, `**/${name}/*`],
    { cwd: worktreePath }
  );
  if (result.error || result.status !== 0) {
    return true;
  }
  return Boolean(String(result.stdout ?? "").trim());
}

// Per-process cache: probing `--help` once is enough. Tests inject a fresh
// Map via options.cache when they need isolation between cases.
const defaultConfineSupportCache = new Map();

/**
 * Whether `GROK_BUILD_CONFINE` wants the confine flag (default: on).
 * Only "0" / "false" disable it — absence means try when the CLI supports it.
 */
export function confineFeatureEnabled(env = process.env) {
  const raw = String(env?.GROK_BUILD_CONFINE ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return false;
  }
  return true;
}

/**
 * Probe whether the CLI binary advertises `--confine`. Cached per binary path
 * for the lifetime of the process so a long-running bridge does not pay the
 * cost on every run.
 *
 * @param {string} binary
 * @param {{ env?: NodeJS.ProcessEnv, runCommandImpl?: typeof runCommand, cache?: Map<string, boolean> }} [options]
 * @returns {boolean}
 */
export function cliSupportsConfine(binary, options = {}) {
  const cache = options.cache ?? defaultConfineSupportCache;
  const key = String(binary ?? "");
  if (cache.has(key)) {
    return cache.get(key);
  }
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  let supported = false;
  try {
    const result = runCommandImpl(binary, ["--help"], {
      env: options.env,
      maxBuffer: 256 * 1024
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    // Do not use a leading \b: `--` is non-word so \b-- never matches after a
    // space. Look for the flag token anywhere in --help output.
    supported = /(?:^|[\s,|])--confine(?:\b|=|\s|$)/.test(text);
  } catch {
    supported = false;
  }
  cache.set(key, supported);
  return supported;
}

/**
 * Permission flags for a headless run.
 *
 * Read-only keeps `--permission-mode plan` (portable intent) and
 * `--sandbox read-only` (kernel-enforced on unix, inert on Windows) and ADDS the
 * deny rules above, which are the half that is enforced everywhere.
 *
 * Measured, so that the next reader does not have to re-derive it:
 * - Read/Glob/Bash all work fine under bare `--permission-mode plan` and under
 *   `--sandbox read-only` with no `--always-approve`. An unapproved headless
 *   tool call is NOT silently swallowed, which an earlier revision of this
 *   comment claimed.
 * - Hyper's `grep` tool, however, returns an EMPTY body for a pattern that is
 *   present, on Windows, under every permission combination including
 *   `--always-approve`. The tool result comes back ~2ms after dispatch, i.e.
 *   before ripgrep could have run, while the same bundled ripgrep finds the
 *   match when invoked directly. That is a Hyper defect, not a permission
 *   problem, and no flag here can work around it - do not try.
 *
 * @param {boolean} write
 * @returns {{ alwaysApprove?: boolean, denyRules?: string[], allowRules?: string[], permissionMode?: string, sandbox?: string }}
 */
export function buildHeadlessPermissionOptions(write) {
  if (write) {
    return { alwaysApprove: true };
  }
  return {
    permissionMode: "plan",
    sandbox: "read-only",
    denyRules: [...READ_ONLY_DENY_RULES]
  };
}

function normalizeRuleList(value) {
  if (value == null) {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => String(entry).trim()).filter(Boolean);
}

export function buildHeadlessArgs(prompt, options = {}) {
  const leading = [];

  if (options.resumeSessionId) {
    leading.push("-r", options.resumeSessionId);
  } else if (options.continueLast) {
    leading.push("-c");
  } else if (options.sessionId) {
    leading.push("--session-id", options.sessionId);
  }

  const trailing = [];

  if (options.cwd) {
    trailing.push("--cwd", options.cwd);
  }
  if (options.agent) {
    trailing.push("--agent", options.agent);
  }
  if (options.permissionMode) {
    trailing.push("--permission-mode", options.permissionMode);
  }
  if (options.sandbox) {
    trailing.push("--sandbox", options.sandbox);
  }
  if (options.alwaysApprove) {
    trailing.push("--always-approve");
  }
  // Repeated --deny / --allow. Order does not matter for Hyper - a deny is
  // evaluated before --always-approve either way - but each rule is its own
  // argv pair and must be counted in the budget like every other flag.
  for (const rule of normalizeRuleList(options.denyRules)) {
    trailing.push("--deny", rule);
  }
  for (const rule of normalizeRuleList(options.allowRules)) {
    trailing.push("--allow", rule);
  }
  // Future Hyper flag: confine the agent to a single writable root. Only
  // emitted when the caller confirmed the CLI advertises it (probe is cached
  // once per process). Silently omit on a CLI that lacks it so the bridge
  // does not break on an older binary.
  if (options.confine) {
    trailing.push("--confine", String(options.confine));
  }
  if (options.model) {
    trailing.push("--model", options.model);
  }
  if (options.effort != null && options.effort !== "") {
    // Guard: nest-run once passed the normalizeReasoningEffort wrapper object
    // and Hyper saw --effort "[object Object]". Only strings reach argv.
    if (typeof options.effort !== "string") {
      throw new Error(
        `buildHeadlessArgs: options.effort must be a string (got ${typeof options.effort})`
      );
    }
    trailing.push("--effort", options.effort);
  }
  // Extra rules appended to the SYSTEM prompt. The output contract belongs here
  // rather than glued onto the user's prompt: the prompt is also what the bridge
  // shortens into a job summary and the /grok-build:runs table, so contract text
  // pasted there becomes the visible title of every run. Counted in the argv
  // budget below like any other flag - it is a few hundred bytes off a 7 000
  // byte allowance on the Windows cmd-shim path.
  if (options.rules) {
    trailing.push("--rules", String(options.rules));
  }
  if (options.outputFormat) {
    trailing.push("--output-format", options.outputFormat);
  } else {
    trailing.push("--output-format", "streaming-json");
  }
  if (options.maxTurns != null && Number.isFinite(Number(options.maxTurns)) && Number(options.maxTurns) >= 1) {
    trailing.push("--max-turns", String(options.maxTurns));
  }
  if (options.jsonSchema) {
    const schemaText =
      typeof options.jsonSchema === "string" ? options.jsonSchema : JSON.stringify(options.jsonSchema);
    trailing.push("--json-schema", schemaText);
  }

  // Everything but the prompt is measured first: the platform limit applies to
  // the whole command line, and `argvOverheadBytes` lets the caller add what the
  // resolver prepends (node + a script path, or cmd.exe /d /s /c).
  const otherArgvBytes = argvBytes(
    [...leading, ...trailing, "-p"],
    Number.isFinite(Number(options.argvOverheadBytes)) ? Number(options.argvOverheadBytes) : 0
  );
  const budgetBytes = resolvePromptArgvBudget({
    platform: options.platform,
    cmdShim: options.cmdShim,
    argvBudget: options.argvBudget,
    otherArgvBytes
  });

  const raw = String(prompt ?? "");
  const promptBytes = Buffer.byteLength(raw, "utf8");
  let promptArgs = null;
  const transport = { mode: "inline", promptBytes, budgetBytes, elidedBytes: 0, promptFile: null };

  if (promptBytes <= budgetBytes) {
    promptArgs = ["-p", raw];
  } else if (options.promptFileDir) {
    // Preferred over truncating: `--prompt-file` takes the prompt out of argv
    // entirely, so nothing is lost. Falls through to truncation if the spill
    // cannot be written - a full or read-only state dir must not fail the run.
    try {
      const promptFile = writePromptFile(options.promptFileDir, raw);
      promptArgs = ["--prompt-file", promptFile];
      transport.mode = "prompt-file";
      transport.promptFile = promptFile;
    } catch {
      promptArgs = null;
    }
  }

  if (!promptArgs) {
    const bounded = boundPromptForArgv(raw, budgetBytes);
    promptArgs = ["-p", bounded.prompt];
    transport.mode = "truncated";
    transport.elidedBytes = bounded.elidedBytes;
  }

  options.onPromptBounded?.(transport);

  return [...leading, ...promptArgs, ...trailing];
}

export function runHeadlessAgent(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!prompt) {
    return Promise.reject(new Error("A prompt is required for this Grok run."));
  }

  const sessionId = options.resumeSessionId
    ? options.resumeSessionId
    : options.sessionId || (options.assignSessionId === false ? null : crypto.randomUUID());

  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== "win32";
  const spawnEnv = options.env ?? process.env;

  // The prompt's argv budget depends on HOW the binary gets launched, so the
  // invocation shape has to be known before the args are built. Resolving with
  // an empty arg list is enough to learn that and to measure the prefix the
  // resolver prepends (cmd.exe /d /s /c, or node + a script path).
  const invocationShape = resolveSpawnInvocation(binary, [], spawnEnv, platform);
  let promptTransport = null;

  const args = buildHeadlessArgs(prompt, {
    ...options,
    cwd: options.cwd ?? cwd,
    sessionId: options.resumeSessionId || options.continueLast ? undefined : sessionId,
    platform,
    cmdShim: invocationShape.windowsVerbatimArguments === true,
    argvOverheadBytes: argvBytes([invocationShape.executable, ...invocationShape.args]),
    onPromptBounded: (info) => {
      promptTransport = info;
    }
  });

  // Resolve through PATH/PATHEXT so an extensionless shebang script on PATH is
  // honoured. Without this, Windows CreateProcess skips it and silently runs a
  // real `grok.exe` from elsewhere on PATH instead.
  const invocation = resolveSpawnInvocation(binary, args, spawnEnv, platform);

  const outputFormat = options.outputFormat ?? "streaming-json";
  const streaming = outputFormat === "streaming-json";

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      windowsHide: true
    });

    const agentPid = child.pid ?? null;
    emitProgress(options.onProgress, `Running grok (${binary}).`, "starting", {
      threadId: sessionId,
      agentPid,
      pid: agentPid
    });

    // An elided prompt changes what the model was asked, so it must never be
    // silent. The prompt-file case is non-lossy but still worth saying, because
    // the path is the only way to see what was actually sent.
    if (promptTransport?.mode === "prompt-file") {
      emitProgress(
        options.onProgress,
        `Prompt was ${promptTransport.promptBytes} bytes, over the ${promptTransport.budgetBytes} byte command-line budget; sent via --prompt-file ${promptTransport.promptFile}.`,
        "starting",
        { threadId: sessionId, agentPid }
      );
    } else if (promptTransport?.mode === "truncated") {
      emitProgress(
        options.onProgress,
        `Prompt was ${promptTransport.promptBytes} bytes, over the ${promptTransport.budgetBytes} byte command-line budget; ${promptTransport.elidedBytes} bytes were elided from the middle.`,
        "starting",
        { threadId: sessionId, agentPid }
      );
    }

    let stdout = "";
    let stderr = "";
    const decoder = streaming ? createNdjsonDecoder() : null;
    const transcript = streaming ? createStreamTranscript() : null;
    let lastPhase = null;

    function consumeLine(line) {
      const event = parseStreamEvent(line);
      if (!event) {
        return;
      }
      const outcome = transcript.accept(event);
      if (outcome.messageCompleted) {
        emitProgress(
          options.onProgress,
          shortenForProgress(outcome.messageCompleted),
          outcome.phase ?? lastPhase,
          {
            threadId: sessionId,
            agentPid,
            logTitle: "Assistant message",
            logBody: outcome.messageCompleted,
            ...(outcome.usage ? { usage: outcome.usage } : {})
          }
        );
      }
      if (outcome.phase && outcome.phase !== lastPhase) {
        lastPhase = outcome.phase;
        emitProgress(options.onProgress, `Grok is ${outcome.phase}.`, outcome.phase, {
          threadId: sessionId,
          agentPid,
          ...(outcome.usage ? { usage: outcome.usage } : {})
        });
      } else if (outcome.usage) {
        // Turn-end usage without a phase change still patches the live job so
        // nest-run budget inheritance can see parent spend mid-run.
        emitProgress(options.onProgress, "Usage updated.", lastPhase ?? "running", {
          threadId: sessionId,
          agentPid,
          usage: outcome.usage
        });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (streaming) {
        for (const line of decoder.push(chunk)) {
          consumeLine(line);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      const status = code ?? (signal ? 1 : 0);
      let result = null;
      if (streaming) {
        for (const line of decoder.flush()) {
          consumeLine(line);
        }
        result = transcript.finish();
      }

      const resolvedThreadId = result?.sessionId || sessionId;
      // Non-streaming (`--output-format json`, or plain) has exactly one body of
      // text, so all four text fields collapse onto it. Only `finalReport` can
      // still differ, because the fence may or may not be in there.
      const plainText = stdout.trimEnd();

      // Did the streaming parser understand ANY of what came back? A CLI update
      // that renames the event vocabulary turns every text field empty while
      // stdout is full of the answer, and the user gets "Grok did not return a
      // final message." for a run that said plenty. Gate on "nothing was
      // recognized at all" rather than on an empty transcript: a tool-only run
      // legitimately produces no messages, and dumping raw NDJSON at it would
      // be strictly worse than the silence.
      const streamParsed = streaming ? result.recognizedEvents > 0 : true;
      const streamFallback =
        streaming && result.recognizedEvents === 0 && stdout.trim()
          ? // Bounded: unparsed stdout is the whole run, which on a long agentic
            // session is megabytes of machine output. The tail is the part that
            // carries the answer.
            plainText.split(/\r?\n/).slice(-RAW_STDOUT_FALLBACK_LINES).join("\n")
          : "";
      // One body of text that every text field collapses onto, or null when a
      // parsed transcript is available and should be used instead.
      const collapsedText = streamFallback || (result ? null : plainText);
      emitProgress(
        options.onProgress,
        status === 0 ? "Grok finished." : `Grok exited with status ${status}.`,
        status === 0 ? "finalizing" : "failed",
        { threadId: resolvedThreadId, agentPid }
      );

      resolve({
        status,
        signal,
        stdout,
        stderr,
        sessionId: resolvedThreadId,
        threadId: resolvedThreadId,
        agentPid,
        finalMessage: collapsedText ?? result.finalMessage,
        // Additive companions to finalMessage: the whole narration, the final
        // assistant message, and the delimited report when the model emitted
        // one. finalMessage keeps meaning "the joined transcript" so no existing
        // consumer changes meaning under it.
        transcript: collapsedText ?? result.transcript,
        lastMessage: collapsedText ?? result.lastMessage,
        finalReport:
          collapsedText == null ? result.finalReport : extractFinalReport(collapsedText),
        messages: result ? result.messages : null,
        usage: result?.usage ?? null,
        stopReason: result?.stopReason ?? null,
        // null when the stream never proved it speaks tools - not the same as 0.
        toolCallCount: result?.toolCallCount ?? null,
        toolCallCountFloor: result?.toolCallCountFloor ?? null,
        toolVisibility: result?.toolVisibility ?? null,
        toolActivity: result?.toolActivity ?? [],
        resolvedModel: result?.usage?.resolvedModel ?? result?.modelResolved ?? null,
        unknownEventTypes: result?.unknownTypes ?? [],
        // Stream-channel honesty: error / confine / denials must reach the run
        // record rather than being dropped after unrecognized-type counting.
        streamErrors: result?.errors ?? [],
        confineViolations: result?.confineViolations ?? [],
        toolDenials: result?.toolDenials ?? [],
        compaction: result?.compaction ?? [],
        maxTurnsReached: Boolean(result?.maxTurnsReached),
        start: result?.start ?? null,
        streamSchemaVersion: result?.streamSchemaVersion ?? null,
        filesChangedFromStream: result?.filesChanged ?? null,
        // False only when a streaming run's events were all unrecognized, i.e.
        // when the four text fields above are raw stdout rather than a parsed
        // transcript. The renderer says so out loud rather than passing off
        // machine output as the model's answer.
        streamParsed,
        args,
        binary,
        promptTransport
      });
    });
  });
}

export function runImport(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const args = ["import"];
  if (options.list) {
    args.push("--list");
  }
  if (options.sourcePath) {
    args.push(options.sourcePath);
  }
  if (options.json !== false) {
    args.push("--json");
  }

  emitProgress(options.onProgress, "Importing Claude session into Grok.", "transferring");

  const result = runGrok(args, {
    cwd,
    env: options.env,
    binary
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(detail || "grok import failed");
  }

  const raw = (result.stdout || "").trim();
  let parsed = null;
  let sessionId = null;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      parsed = obj;
      sessionId =
        obj.sessionId ??
        obj.session_id ??
        obj.id ??
        obj.importedSessionId ??
        obj.threadId ??
        sessionId;
    } catch {
    }
  }

  if (!sessionId) {
    const match = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
    if (match) {
      sessionId = match[0];
    }
  }

  emitProgress(options.onProgress, sessionId ? `Imported session ${sessionId}.` : "Import completed.", "completed", {
    threadId: sessionId
  });

  return {
    status: 0,
    stdout: raw,
    stderr: result.stderr,
    sessionId,
    threadId: sessionId,
    parsed,
    resumeCommand: sessionId ? `grok -r ${sessionId}` : null
  };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  const text = String(rawOutput).trim();

  try {
    return {
      ...fallback,
      parsed: JSON.parse(text),
      parseError: null,
      rawOutput: text
    };
  } catch {
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(fenced[1].trim()),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(text.slice(start, end + 1)),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from Grok output.",
    rawOutput: text
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return [
    "Return only valid JSON matching this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput, schemaInstructions = "" }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only inspection.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)",
    schemaInstructions ? `\n${schemaInstructions}` : ""
  ];
  return parts.filter((line) => line !== undefined).join("\n");
}
