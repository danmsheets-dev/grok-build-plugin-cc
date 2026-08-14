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
  normalizeUsage,
  parseStreamEventDetailed
} from "./stream-events.mjs";
import { resolveExecutable, resolveSpawnInvocation } from "./which.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

/**
 * Default CLI resolution order when GROK_BINARY is unset.
 *
 * Turbo (the preferred Grok Build fork) is tried first, then the stock
 * `grok` binary. Hyper is intentionally absent — it is never auto-selected;
 * set GROK_BINARY explicitly if you still need it.
 */
export const DEFAULT_BINARY_CANDIDATES = Object.freeze(["turbo", "grok"]);
/** Preferred default name used in error text when nothing is on PATH. */
export const PREFERRED_BINARY = DEFAULT_BINARY_CANDIDATES[0];
const BINARY_ENV = "GROK_BINARY";

/** The HOME value THIS process supplied, when the environment carried none. */
let appliedHomeDefault = null;

// How much raw stdout is shown when the streaming parser recognized nothing at
// all. Enough to carry a final answer and the context around it; small enough
// that a run which streamed megabytes of an unknown format does not push all of
// it into a job record, through redaction, and into the terminal.
const RAW_STDOUT_FALLBACK_LINES = 200;

/**
 * True when `name` resolves to an executable on PATH (or is an absolute file).
 * Does not spawn the binary — only filesystem lookup.
 */
export function binaryOnPath(name, env = process.env, platform = process.platform) {
  const command = String(name ?? "").trim();
  if (!command) {
    return false;
  }
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    try {
      return fs.statSync(command).isFile();
    } catch {
      return false;
    }
  }

  if (platform === "win32") {
    const resolved = resolveExecutable(command, env, platform);
    return resolved !== command && path.isAbsolute(resolved);
  }

  const searchPath = String(env?.PATH ?? env?.Path ?? "");
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile()) {
        return true;
      }
    } catch {
      // keep looking
    }
  }
  return false;
}

/**
 * True when a GROK_BINARY value is Hyper (bare name or path ending in hyper[.exe]).
 * Hyper is no longer a supported auto/default target for this plugin.
 */
export function isHyperBinaryName(binary) {
  const raw = String(binary ?? "").trim();
  if (!raw) {
    return false;
  }
  const base = path.basename(raw).toLowerCase();
  return (
    base === "hyper" ||
    base === "hyper.exe" ||
    base === "hyper.cmd" ||
    base === "hyper.bat" ||
    base === "hyper.ps1"
  );
}

// Per-process cache: agent-CLI identity probes (C1). Tests inject a fresh Map.
const defaultAgentCompatCache = new Map();
// Per-process cache: full `version --json` identity (rc2+). null = probed, no card.
const defaultCliIdentityCache = new Map();
// Per-process cache: permission tool prefixes from `version --json` (rc2+).
// null entry = probed, CLI did not advertise prefixes (use static fallback).
const defaultPermissionPrefixCache = new Map();

/**
 * True when `detail` from `version` / `--version` looks like Vercel Turborepo
 * (or another non-agent turbo), not Turbo Grok Build / stock grok.
 */
export function looksLikeNonAgentTurboVersion(detail) {
  const text = String(detail ?? "").toLowerCase();
  if (!text.trim()) {
    return false;
  }
  if (/\bturborepo\b/.test(text) || /\bturbo run\b/.test(text)) {
    return true;
  }
  // Vercel turbo often prints a short "2.x.x" banner without grok/agent markers.
  if (/the build system that makes/.test(text)) {
    return true;
  }
  if (/^\s*\d+\.\d+(\.\d+)?\s*$/.test(text)) {
    return true;
  }
  return false;
}

/**
 * True when help/version text exposes the headless agent surface this bridge needs.
 * Distinguishes Turbo Grok Build / grok from Vercel `turbo` on PATH (C1).
 *
 * @param {string} binary
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, runCommandImpl?: Function, cache?: Map<string, boolean>, force?: boolean }} [options]
 * @returns {boolean}
 */
/**
 * Parse Turbo/Grok `version --json` identity card (rc2+).
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseCliVersionIdentity(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) {
    return null;
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * One `version --json` probe per binary. Shared by compat, permission
 * prefixes, confine feature, and check/doctor so a spawn does not pay
 * three CLI round-trips.
 *
 * @returns {object|null}
 */
export function probeCliIdentity(binary, options = {}) {
  const name = String(binary ?? "").trim();
  if (!name) {
    return null;
  }
  const cache = options.cache ?? defaultCliIdentityCache;
  if (!options.force && cache.has(name)) {
    return cache.get(name);
  }
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  let identity = null;
  try {
    const result = runCommandImpl(name, ["version", "--json"], {
      env: options.env,
      cwd: options.cwd,
      maxBuffer: 256 * 1024
    });
    if (!result.error && (result.status == null || result.status === 0)) {
      identity = parseCliVersionIdentity(result.stdout);
    }
  } catch {
    identity = null;
  }
  cache.set(name, identity);
  return identity;
}

/** Test seam: clear identity probe cache. */
export function resetCliIdentityCacheForTests(cache = defaultCliIdentityCache) {
  cache.clear();
}

export function cliIdentityFeatures(identity) {
  const features = identity?.features;
  if (!features || typeof features !== "object" || Array.isArray(features)) {
    return {};
  }
  return features;
}

export function isAgentCompatibleBinary(binary, options = {}) {
  const name = String(binary ?? "").trim();
  if (!name) {
    return false;
  }
  const cache = options.cache ?? defaultAgentCompatCache;
  if (!options.force && cache.has(name)) {
    return cache.get(name);
  }
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const runOpts = {
    env: options.env,
    cwd: options.cwd,
    maxBuffer: 256 * 1024
  };
  let ok = false;
  try {
    // Prefer Turbo rc2+ machine-readable identity (distinguishes Vercel Turborepo).
    const identity = probeCliIdentity(name, {
      env: options.env,
      cwd: options.cwd,
      runCommandImpl,
      force: options.force
    });
    if (identity) {
      if (identity.agentCompatible === false) {
        ok = false;
        cache.set(name, ok);
        return ok;
      }
      const product = String(identity.product ?? "").toLowerCase();
      if (product && product !== "turbo-grok-build" && product !== "grok-build") {
        ok = false;
        cache.set(name, ok);
        return ok;
      }
      if (identity.agentCompatible === true || identity.cliFamily === "grok-build") {
        ok = true;
        cache.set(name, ok);
        return ok;
      }
    }

    if (isHyperBinaryName(name)) {
      ok = false;
      cache.set(name, ok);
      return ok;
    }

    let versionResult = runCommandImpl(name, ["version"], runOpts);
    if (versionResult.error || (versionResult.status != null && versionResult.status !== 0)) {
      versionResult = runCommandImpl(name, ["--version"], runOpts);
    }
    const versionText = `${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`;
    if (looksLikeNonAgentTurboVersion(versionText) || /\bhyper\b/i.test(versionText)) {
      ok = false;
    } else if (/\bgrok\b/i.test(versionText) && !/turborepo/i.test(versionText)) {
      // Stock grok banner (not leftover Hyper). Still require this is not a
      // short Vercel-style version-only line — already handled above.
      ok = true;
    } else {
      const help = runCommandImpl(name, ["--help"], runOpts);
      const helpText = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
      // Headless agent surface Turbo Grok / grok expose; Turborepo does not.
      ok =
        /--output-format\b/.test(helpText) &&
        /--always-approve\b/.test(helpText) &&
        (/--prompt-file\b/.test(helpText) || /--single\b/.test(helpText) || /(?:^|[\s,|])-p(?:\s|,|$)/.test(helpText));
    }
  } catch {
    ok = false;
  }
  cache.set(name, ok);
  return ok;
}

/** Test seam: clear agent-compat probe cache. */
export function resetAgentCompatCacheForTests(cache = defaultAgentCompatCache) {
  cache.clear();
}

/**
 * Resolve which CLI binary the bridge should invoke.
 *
 * Order:
 *   1. GROK_BINARY (explicit override — any compatible CLI *except Hyper*)
 *   2. First of DEFAULT_BINARY_CANDIDATES on PATH that passes the agent-CLI
 *      surface probe (`turbo` preferred, then `grok`) — skips Vercel Turborepo
 *   3. First name merely present on PATH (for error text)
 *   4. PREFERRED_BINARY (`turbo`) so missing-binary messages name the right product
 *
 * Hyper is never selected — neither automatically nor via `GROK_BINARY=hyper`.
 * Point GROK_BINARY at `turbo`, `grok`, or an absolute path to another binary.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ platform?: NodeJS.Platform, candidates?: readonly string[], skipAgentProbe?: boolean, runCommandImpl?: Function, cache?: Map<string, boolean> }} [options]
 * @returns {string}
 */
export function resolveGrokBinary(env = process.env, options = {}) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    const value = String(override).trim();
    // Drop Hyper overrides (including .cmd/.bat shims). Any other override
    // must still pass the agent-compat probe unless skipAgentProbe is set.
    if (!isHyperBinaryName(value)) {
      if (
        options.skipAgentProbe ||
        isAgentCompatibleBinary(value, {
          env,
          runCommandImpl: options.runCommandImpl,
          cache: options.cache
        })
      ) {
        return value;
      }
    }
  }
  const candidates = options.candidates ?? DEFAULT_BINARY_CANDIDATES;
  const platform = options.platform ?? process.platform;
  const onPath = [];
  for (const name of candidates) {
    if (binaryOnPath(name, env, platform)) {
      onPath.push(name);
    }
  }
  if (!options.skipAgentProbe) {
    for (const name of onPath) {
      if (
        isAgentCompatibleBinary(name, {
          env,
          runCommandImpl: options.runCommandImpl,
          cache: options.cache
        })
      ) {
        return name;
      }
    }
    // M1: do not fail open to Vercel Turborepo / non-agent turbo when every
    // candidate failed the probe. Prefer PREFERRED_BINARY for error text only.
    return candidates[0] ?? PREFERRED_BINARY;
  }
  if (onPath.length > 0) {
    return onPath[0];
  }
  return candidates[0] ?? PREFERRED_BINARY;
}

/**
 * Give the CLI a HOME on Windows.
 *
 * The Grok/Turbo CLIs resolve their config, credentials and session store off
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
 * Which CLI is actually behind the resolved binary / GROK_BINARY.
 *
 * Compatible Grok Build forks ship under their own name (Turbo is preferred;
 * same CLI surface, same `~/.grok` config and auth). When the bridge is driving
 * one of those, saying "install the Grok Build CLI" on failure sends the user
 * to the wrong product.
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
  // Turbo before Hyper: Turbo's banner may still mention shared lineage, but a
  // clear "turbo" token is the preferred brand for the local fork.
  if (/\bturbo\b/.test(text)) {
    return { id: "turbo", label: "Turbo" };
  }
  if (/\bhyper\b/.test(text)) {
    return { id: "hyper", label: "Hyper" };
  }
  return { id: "grok", label: "Grok Build" };
}

/**
 * Remediation text for "the CLI is not runnable".
 *
 * Branches on whether the name is one of the auto-resolved defaults or an
 * explicit GROK_BINARY override. Telling someone who pointed the bridge at a
 * custom path to "install Grok Build" is wrong: the real fault is almost always
 * a bad path or a binary that is not executable.
 *
 * @param {string} binary The binary the bridge tried to run
 * @returns {string}
 */
export function describeMissingBinary(binary) {
  const name = String(binary ?? "").trim() || PREFERRED_BINARY;
  if (DEFAULT_BINARY_CANDIDATES.includes(name)) {
    return (
      "Install Turbo (preferred) or the Grok Build CLI and ensure `turbo` or `grok` is on PATH " +
      "(or point GROK_BINARY at a compatible executable)."
    );
  }
  return (
    `\`${name}\` (from GROK_BINARY) could not be run. Check the path is correct and executable, ` +
    `or unset GROK_BINARY to fall back to \`turbo\` / \`grok\`.`
  );
}

/**
 * Pick the clearer of two availability failure details (C4).
 * Prefer concrete ENOENT / "not found" signals and longer diagnostic text
 * over monorepo-task noise from a wrong `turbo version` subcommand.
 *
 * @param {string|null|undefined} versionDetail  From `binary version`
 * @param {string|null|undefined} versionFlagDetail  From `binary --version`
 * @returns {string}
 */
export function pickAvailabilityFailureDetail(versionDetail, versionFlagDetail) {
  const a = String(versionDetail ?? "").trim();
  const b = String(versionFlagDetail ?? "").trim();
  if (!a && !b) {
    return "not found";
  }
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  if (a === b) {
    return a;
  }

  const looksMissing = (text) =>
    /^not found$/i.test(text) || /enoent|cannot find|is not recognized|no such file/i.test(text);
  const looksWrongProduct = (text) =>
    /\bpipeline\b|turborepo|unknown command|unexpected argument|no such subcommand/i.test(text);

  // Prefer a clear missing-binary signal over monorepo/wrong-CLI noise.
  if (looksMissing(b) && looksWrongProduct(a)) {
    return b;
  }
  if (looksMissing(a) && looksWrongProduct(b)) {
    return a;
  }
  if (looksMissing(b) && !looksMissing(a) && a.length < 80) {
    return b;
  }
  if (looksMissing(a) && !looksMissing(b) && b.length < 80) {
    return a;
  }

  const score = (text) => {
    let n = text.length;
    if (looksMissing(text)) {
      n += 40;
    }
    if (looksWrongProduct(text)) {
      n -= 40;
    }
    if (/usage:|error:/i.test(text)) {
      n += 10;
    }
    return n;
  };

  return score(b) >= score(a) ? b : a;
}

/**
 * Build the ordered list of CLI names to probe for availability (C3).
 * Explicit binary / GROK_BINARY is a single-item list; otherwise walk candidates on PATH.
 */
export function listGrokBinaryCandidates(env = process.env, options = {}) {
  if (options.binary && String(options.binary).trim()) {
    return [String(options.binary).trim()];
  }
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim() && !isHyperBinaryName(override)) {
    return [String(override).trim()];
  }
  const candidates = options.candidates ?? DEFAULT_BINARY_CANDIDATES;
  const platform = options.platform ?? process.platform;
  const onPath = [];
  for (const name of candidates) {
    if (binaryOnPath(name, env, platform)) {
      onPath.push(name);
    }
  }
  return onPath.length > 0 ? onPath : [candidates[0] ?? PREFERRED_BINARY];
}

export function getGrokAvailability(cwd, options = {}) {
  const env = options.env ?? process.env;
  const binaries = listGrokBinaryCandidates(env, options);
  let lastFailure = null;

  for (const binary of binaries) {
    const versionStatus = binaryAvailable(binary, ["version"], { cwd, env });
    let detail = versionStatus.detail;
    let available = versionStatus.available;
    if (!available) {
      const alt = binaryAvailable(binary, ["--version"], { cwd, env });
      if (alt.available) {
        available = true;
        detail = alt.detail;
      } else {
        lastFailure = {
          available: false,
          // C4: prefer the clearer of version vs --version (do not always keep `version`).
          detail: pickAvailabilityFailureDetail(versionStatus.detail, alt.detail),
          binary,
          brand: detectCliBrand(null)
        };
        // C3: try next candidate when this name is broken / not runnable.
        continue;
      }
    }
    if (
      !options.skipAgentProbe &&
      !isAgentCompatibleBinary(binary, {
        env,
        cwd,
        runCommandImpl: options.runCommandImpl,
        cache: options.cache
      })
    ) {
      lastFailure = {
        available: false,
        detail:
          `${binary} is on PATH but does not look like Turbo Grok Build / Grok Build ` +
          `(missing headless agent surface). If this is Vercel Turborepo, install Turbo Grok ` +
          `or set GROK_BINARY to the agent CLI.`,
        binary,
        brand: detectCliBrand(detail)
      };
      // C3: try next candidate (e.g. grok after a Turborepo turbo).
      continue;
    }
    const identity = probeCliIdentity(binary, {
      env,
      cwd,
      runCommandImpl: options.runCommandImpl
    });
    return {
      available: true,
      detail,
      binary,
      brand: detectCliBrand(detail),
      identity,
      features: cliIdentityFeatures(identity)
    };
  }

  return (
    lastFailure ?? {
      available: false,
      detail: "not found",
      binary: binaries[0] ?? PREFERRED_BINARY,
      brand: detectCliBrand(null)
    }
  );
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
    // C5: name the binary that was actually tried (turbo / GROK_BINARY path).
    return buildAuthStatus({
      available: false,
      loggedIn: false,
      detail: `${binary}: not found. ${describeMissingBinary(binary)}`,
      source: "availability",
      binary
    });
  }

  if (result.error) {
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: result.error.message,
      source: "models-probe",
      binary
    });
  }

  const stdout = (result.stdout || "").trim();
  // Hyper exits 255 on a successful listing. Status alone is not auth signal.
  if (result.status !== 0 && !modelsOutputLooksSuccessful(stdout)) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: detail || `${binary} models failed; not logged in or not ready`,
      source: "models-probe",
      binary
    });
  }

  if (!stdout && result.status !== 0) {
    const detail = (result.stderr || `exit ${result.status}`).trim();
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: detail || `${binary} models failed; not logged in or not ready`,
      source: "models-probe",
      binary
    });
  }

  const loggedInHint = /logged in|available models|default model/i.test(stdout);
  return buildAuthStatus({
    available: true,
    loggedIn: true,
    detail: loggedInHint
      ? firstLine(stdout) || `${binary} models succeeded`
      : firstLine(stdout) || `${binary} models succeeded (treated as logged in)`,
    source: "models-probe",
    authMethod: "grok-cli",
    verified: true,
    binary
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
      // C5: remediation text names turbo/GROK_BINARY, not a hard-coded "grok".
      error: `${binary}: not found. ${describeMissingBinary(binary)}`,
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
 *
/**
 * Read-only denials (C8).
 *
 * Turbo treats `Edit` / `Edit(*)` as tool-wide (no path pattern). `Edit(**)` is
 * only a path glob and can miss exotic path spellings. `Write` maps to the same
 * Edit filter on Turbo, so a single tool-wide Edit rule is enough.
 */
export const READ_ONLY_DENY_RULES = Object.freeze(["Edit(*)"]);

/**
 * Claude-compat tool prefixes Turbo/Grok accept on `--deny` / `--allow` (C10).
 * Turbo 1.0.0-rc.2+ accepts NotebookEdit/MultiEdit/NotebookRead as Edit/Read
 * aliases; pre-rc2 rejected NotebookEdit. Prefer live prefixes from
 * `probePermissionToolPrefixes` (`version --json` → permissionToolPrefixes).
 * Unknown prefixes are still dropped so headless start does not hard-abort.
 */
export const SUPPORTED_PERMISSION_TOOL_PREFIXES = Object.freeze([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "NotebookRead",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Mcp",
  "MCP",
  "MCPTool",
  "Any"
]);

/**
 * Probe `binary version --json` for `permissionToolPrefixes` (Turbo rc2+).
 * Returns the advertised list, or null when the CLI is older / probe fails.
 * Results are cached per binary name (including null = "no list advertised").
 *
 * @param {string} binary
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, runCommandImpl?: Function, cache?: Map<string, string[]|null>, force?: boolean }} [options]
 * @returns {string[]|null}
 */
export function probePermissionToolPrefixes(binary, options = {}) {
  const name = String(binary ?? "").trim();
  if (!name) {
    return null;
  }
  const cache = options.cache ?? defaultPermissionPrefixCache;
  if (!options.force && cache.has(name)) {
    return cache.get(name);
  }
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  let prefixes = null;
  try {
    const identity = probeCliIdentity(name, {
      env: options.env,
      cwd: options.cwd,
      runCommandImpl,
      force: options.force
    });
    const raw =
      identity?.permissionToolPrefixes ?? identity?.permission_tool_prefixes ?? null;
    if (Array.isArray(raw) && raw.length > 0) {
      const cleaned = raw.map((p) => String(p ?? "").trim()).filter(Boolean);
      if (cleaned.length > 0) {
        prefixes = cleaned;
      }
    }
  } catch {
    prefixes = null;
  }
  cache.set(name, prefixes);
  return prefixes;
}

/** Test seam: clear permission-prefix probe cache. */
export function resetPermissionPrefixCacheForTests(cache = defaultPermissionPrefixCache) {
  cache.clear();
}

/**
 * Resolve the deny/allow prefix allow-list for a headless spawn.
 * Prefer caller override, then live `version --json` prefixes, then static fallback.
 *
 * @param {string} [binary]
 * @param {{ supportedPermissionPrefixes?: readonly string[]|null, env?: NodeJS.ProcessEnv, runCommandImpl?: Function, cache?: Map<string, string[]|null> }} [options]
 * @returns {readonly string[]}
 */
export function resolveSupportedPermissionPrefixes(binary, options = {}) {
  if (Array.isArray(options.supportedPermissionPrefixes) && options.supportedPermissionPrefixes.length > 0) {
    return options.supportedPermissionPrefixes;
  }
  if (binary) {
    const probed = probePermissionToolPrefixes(binary, options);
    if (probed && probed.length > 0) {
      return probed;
    }
  }
  return SUPPORTED_PERMISSION_TOOL_PREFIXES;
}

/**
 * Extract the tool prefix from a permission rule string (`Edit(**)`, `Bash(rm *)`, `Edit`).
 * @param {string} rule
 * @returns {string|null}
 */
export function parsePermissionRulePrefix(rule) {
  const text = String(rule ?? "").trim();
  if (!text) {
    return null;
  }
  const match = text.match(/^([A-Za-z][A-Za-z0-9_]*)\s*(?:\(|$)/);
  return match ? match[1] : null;
}

/**
 * Drop deny/allow rules whose tool prefix the CLI will reject (C10).
 * Prevents NotebookEdit-style hard aborts on headless start.
 *
 * @param {string[]|string|null|undefined} rules
 * @param {{ supportedPrefixes?: readonly string[] }} [options]
 * @returns {{ rules: string[], dropped: Array<{ rule: string, reason: string }> }}
 */
export function filterPermissionRulesForCli(rules, options = {}) {
  const supported = options.supportedPrefixes ?? SUPPORTED_PERMISSION_TOOL_PREFIXES;
  const allowed = new Set([...supported].map((p) => String(p).toLowerCase()));
  const kept = [];
  const dropped = [];
  const list = Array.isArray(rules) ? rules : rules == null ? [] : [rules];
  for (const entry of list) {
    const rule = String(entry ?? "").trim();
    if (!rule) {
      continue;
    }
    const prefix = parsePermissionRulePrefix(rule);
    if (!prefix) {
      dropped.push({ rule, reason: "unparseable permission rule" });
      continue;
    }
    if (!allowed.has(prefix.toLowerCase())) {
      dropped.push({
        rule,
        reason: `unsupported tool prefix: ${prefix}`
      });
      continue;
    }
    kept.push(rule);
  }
  return { rules: kept, dropped };
}

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

  // Edit + Write cover the write tool family. Turbo rc2+ also accepts
  // NotebookEdit/MultiEdit as Edit aliases; we do not emit those extras here
  // because Edit(*) already denies the whole family, and path-scoped Edit/Write
  // is enough for workspace-root isolation.
  const rules = [`Edit(${root}/**)`, `Write(${root}/**)`];

  // Last path segment, e.g. "Main Repo" from "C:/…/isotest/Main Repo".
  const segment = root.split("/").filter(Boolean).at(-1) ?? "";
  // A drive root ("C:") has no meaningful segment, and a one-character name is
  // too likely to collide with something inside the tree.
  const segmentUsable = segment.length > 1 && !segment.endsWith(":");
  const segmentRuleApplied = segmentUsable && options.segmentSafe === true;
  if (segmentRuleApplied) {
    rules.push(
      `Edit(**/${segment}/**)`,
      `Write(**/${segment}/**)`
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
  // :(glob) is required for recursive ** (C7/C17). Without it, git treats
  // `**/name/*` as a shallow pathspec and misses deep nested basenames like
  // packages/foo/src/ — which then incorrectly enables self-denying segment rules.
  const result = runner(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      `${name}/*`,
      `**/${name}/*`,
      `:(glob)${name}/**`,
      `:(glob)**/${name}/**`
    ],
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
 * Probe whether the CLI binary advertises `--confine`.
 *
 * Cache policy (C6): only cache a **positive** result forever. A failed/empty
 * probe must not permanently disable confine for the process (one bad --help
 * under load used to omit the path jail for every later isolated run).
 *
 * Turbo 1.0 always implements --confine; when the binary is already known to be
 * agent-compatible (Turbo/Grok), a failed help parse still defaults to true so
 * isolation stays fail-closed.
 *
 * @param {string} binary
 * @param {{ env?: NodeJS.ProcessEnv, runCommandImpl?: typeof runCommand, cache?: Map<string, boolean>, assumeSupportedIfAgent?: boolean }} [options]
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
  let probed = false;
  try {
    const identity = probeCliIdentity(binary, {
      env: options.env,
      runCommandImpl
    });
    const features = cliIdentityFeatures(identity);
    if (features.confine === true) {
      cache.set(key, true);
      return true;
    }
    const result = runCommandImpl(binary, ["--help"], {
      env: options.env,
      maxBuffer: 256 * 1024
    });
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    probed = Boolean(text.trim());
    // Do not use a leading \b: `--` is non-word so \b-- never matches after a
    // space. Look for the flag token anywhere in --help output.
    supported = /(?:^|[\s,|])--confine(?:\b|=|\s|$)/.test(text);
  } catch {
    supported = false;
    probed = false;
  }
  if (supported) {
    cache.set(key, true);
    return true;
  }
  // Agent CLIs (Turbo 1.0+) always have --confine. Prefer enabling over a
  // permanent false cache when help was empty/failed (C6).
  const assumeAgent =
    options.assumeSupportedIfAgent !== false &&
    isAgentCompatibleBinary(binary, {
      env: options.env,
      runCommandImpl,
      cache: options.agentCache
    });
  if (assumeAgent) {
    // Do not cache false; cache true so we do not re-probe forever.
    cache.set(key, true);
    return true;
  }
  // Negative results are not cached when the probe did not clearly run — next
  // call may succeed. Clear miss only when help text was present and lacked the flag.
  if (probed) {
    cache.set(key, false);
  }
  return false;
}

/** Test seam: clear confine probe cache. */
export function resetConfineSupportCacheForTests(cache = defaultConfineSupportCache) {
  cache.clear();
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
  // Windows: put the agent process tree in a Job Object so stop/kill can tear
  // down descendants by closing the job (Turbo `--job-object` / TURBO_JOB_OBJECT).
  // Opt out with GROK_BUILD_JOB_OBJECT=0. No-op on non-Windows CLIs.
  const jobObjectEnv = String(options.env?.GROK_BUILD_JOB_OBJECT ?? process.env.GROK_BUILD_JOB_OBJECT ?? "")
    .trim()
    .toLowerCase();
  const jobObjectOff = jobObjectEnv === "0" || jobObjectEnv === "false" || jobObjectEnv === "off" || jobObjectEnv === "no";
  const jobObjectOn =
    options.jobObject === true ||
    (!jobObjectOff &&
      (options.jobObject === undefined
        ? (options.platform ?? process.platform) === "win32"
        : Boolean(options.jobObject)));
  if (jobObjectOn) {
    const identity = options.binary
      ? probeCliIdentity(options.binary, {
          env: options.env,
          runCommandImpl: options.runCommandImpl
        })
      : null;
    const features = cliIdentityFeatures(identity);
    if (features.jobObject !== false) {
      trailing.push("--job-object");
    }
  }
  // Repeated --deny / --allow. Order does not matter for Hyper - a deny is
  // evaluated before --always-approve either way - but each rule is its own
  // argv pair and must be counted in the budget like every other flag.
  // C10: filter unknown prefixes so Turbo does not abort the whole headless start.
  // Prefer caller override, then version --json permissionToolPrefixes (rc2+).
  const supportedPrefixes =
    options.supportedPermissionPrefixes ??
    (options.binary
      ? resolveSupportedPermissionPrefixes(options.binary, {
          env: options.env,
          runCommandImpl: options.runCommandImpl,
          cache: options.permissionPrefixCache
        })
      : SUPPORTED_PERMISSION_TOOL_PREFIXES);
  const denyFiltered = filterPermissionRulesForCli(options.denyRules, {
    supportedPrefixes
  });
  const allowFiltered = filterPermissionRulesForCli(options.allowRules, {
    supportedPrefixes
  });
  const droppedPermissionRules = [...denyFiltered.dropped, ...allowFiltered.dropped];
  if (droppedPermissionRules.length > 0) {
    options.onPermissionRulesFiltered?.({
      deny: denyFiltered,
      allow: allowFiltered,
      dropped: droppedPermissionRules
    });
  }
  for (const rule of denyFiltered.rules) {
    trailing.push("--deny", rule);
  }
  for (const rule of allowFiltered.rules) {
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

  // Prefer live prefixes from version --json when the caller did not override.
  const supportedPermissionPrefixes = resolveSupportedPermissionPrefixes(binary, {
    supportedPermissionPrefixes: options.supportedPermissionPrefixes,
    env: spawnEnv,
    runCommandImpl: options.runCommandImpl,
    cache: options.permissionPrefixCache
  });

  const args = buildHeadlessArgs(prompt, {
    ...options,
    binary,
    supportedPermissionPrefixes,
    cwd: options.cwd ?? cwd,
    sessionId: options.resumeSessionId || options.continueLast ? undefined : sessionId,
    platform,
    cmdShim: invocationShape.windowsVerbatimArguments === true,
    argvOverheadBytes: argvBytes([invocationShape.executable, ...invocationShape.args]),
    onPromptBounded: (info) => {
      promptTransport = info;
    },
    // C10: surface dropped deny/allow prefixes so operators see why a rule vanished.
    onPermissionRulesFiltered: (info) => {
      options.onPermissionRulesFiltered?.(info);
      const dropped = info?.dropped ?? [];
      if (dropped.length === 0) {
        return;
      }
      const sample = dropped
        .slice(0, 3)
        .map((d) => `${d.rule} (${d.reason})`)
        .join("; ");
      const more = dropped.length > 3 ? ` (+${dropped.length - 3} more)` : "";
      emitProgress(
        options.onProgress,
        `Warning: dropped ${dropped.length} permission rule(s) unsupported by the CLI: ${sample}${more}`,
        "starting"
      );
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
      windowsHide: true,
      // Required when resolveSpawnInvocation routes a .cmd/.bat through
      // cmd.exe /d /s /c with a pre-quoted command line (C2). process.mjs
      // already forwards this; dropping it here mangles argv on Windows shims.
      windowsVerbatimArguments: invocation.windowsVerbatimArguments === true
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
      // C13: use detailed parse so malformed/truncated lines keep a reason
      // (json-parse-failed vs not-a-json-object) instead of a silent drop.
      const detailed = parseStreamEventDetailed(line);
      if (!detailed) {
        return;
      }
      if (!detailed.ok) {
        transcript.noteMalformedLine?.(detailed.line, detailed.reason);
        return;
      }
      const event = detailed.event;
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
        // Tool progress phases already name the tool+target ("Bash: cargo test");
        // wrap only the generic thinking/writing labels so the operator sees
        // what the agent is doing instead of "Grok is thinking" for 34 minutes.
        const phaseMessage =
          outcome.phase === "thinking" || outcome.phase === "writing" || outcome.phase === "starting"
            ? `Grok is ${outcome.phase}.`
            : outcome.phase === "error"
              ? "Grok reported an error."
              : outcome.phase === "confine_violation"
                ? "Confine blocked a write outside the worktree."
                : outcome.phase === "question_suppressed"
                  ? "Headless question suppressed."
                  : `Grok: ${outcome.phase}`;
        emitProgress(options.onProgress, phaseMessage, outcome.phase, {
          threadId: sessionId,
          agentPid,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
          ...(outcome.toolProgress ? { toolProgress: outcome.toolProgress } : {})
        });
      } else if (outcome.usage) {
        // Turn-end / mid-run usage without a phase change still patches the live
        // job so runs --json and nest-run budget inheritance can see spend.
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

      // Non-streaming (`--output-format json`, or plain) has exactly one body of
      // text, so all four text fields collapse onto it. Only `finalReport` can
      // still differ, because the fence may or may not be in there.
      const plainText = stdout.trimEnd();

      // C14: extract usage/toolCalls/sessionId from Turbo JSON envelope.
      let jsonEnvelope = null;
      if (!streaming && (outputFormat === "json" || plainText.startsWith("{"))) {
        jsonEnvelope = parseJsonAgentEnvelope(plainText);
      }

      const resolvedThreadId =
        result?.sessionId || jsonEnvelope?.sessionId || sessionId;

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
      let collapsedText = streamFallback || (result ? null : plainText);
      if (!streaming && jsonEnvelope && typeof jsonEnvelope.text === "string") {
        // Prefer envelope.text (model answer) over raw envelope JSON for
        // finalMessage-style fields; raw stdout stays on `stdout`.
        collapsedText = jsonEnvelope.text;
      }
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
        usage: result?.usage ?? jsonEnvelope?.usage ?? null,
        stopReason: result?.stopReason ?? jsonEnvelope?.stopReason ?? null,
        // null when the stream never proved it speaks tools - not the same as 0.
        toolCallCount: result?.toolCallCount ?? jsonEnvelope?.toolCallCount ?? null,
        toolCallCountFloor: result?.toolCallCountFloor ?? null,
        toolVisibility: result?.toolVisibility ?? jsonEnvelope?.toolVisibility ?? null,
        toolActivity: result?.toolActivity ?? [],
        resolvedModel:
          result?.usage?.resolvedModel ??
          result?.modelResolved ??
          jsonEnvelope?.usage?.resolvedModel ??
          null,
        unknownEventTypes: result?.unknownTypes ?? [],
        // Stream-channel honesty: error / confine / denials must reach the run
        // record rather than being dropped after unrecognized-type counting.
        streamErrors: result?.errors ?? [],
        confineViolations: result?.confineViolations ?? [],
        toolDenials: result?.toolDenials ?? [],
        streamWarnings: result?.warnings ?? [],
        questionsSuppressed: result?.questionsSuppressed ?? [],
        subagents: result?.subagents ?? [],
        subagentsRollup: result?.subagentsRollup ?? null,
        compaction: result?.compaction ?? [],
        autoContinueCount: result?.autoContinueCount ?? 0,
        autoContinues: result?.autoContinues ?? [],
        thoughts: result?.thoughts ?? [],
        maxTurnsReached: Boolean(result?.maxTurnsReached),
        start: result?.start ?? null,
        streamSchemaVersion: result?.streamSchemaVersion ?? null,
        filesChangedFromStream: result?.filesChanged ?? jsonEnvelope?.filesChanged ?? null,
        // Turbo --json-schema on streaming-json end (C11) or json envelope (C14).
        structuredOutput: result?.structuredOutput ?? jsonEnvelope?.structuredOutput ?? null,
        structuredOutputError:
          result?.structuredOutputError ?? jsonEnvelope?.structuredOutputError ?? null,
        malformedStreamLines: result?.malformedLines ?? [],
        malformedStreamLineCount: result?.malformedLineCount ?? 0,
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
    resumeCommand: sessionId ? `${binary} -r ${sessionId}` : null
  };
}

/**
 * True when `value` looks like a Turbo/Grok headless `--output-format json`
 * envelope (`build_json_result`) rather than the review/critique schema body.
 *
 * Real CLIs nest the schema under `structuredOutput` and put failures on
 * `structuredOutputError`. Treating the envelope itself as the schema loses
 * both (C12).
 */
export function isCliJsonEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if ("structuredOutput" in value || "structuredOutputError" in value) {
    return true;
  }
  // Envelope without a schema attachment still carries session/result keys.
  const hasSession = typeof value.sessionId === "string" && value.sessionId.length > 0;
  const hasResultShape =
    "stopReason" in value || "text" in value || "usage" in value || "requestId" in value;
  // Bare review objects also have string fields — do not treat a top-level
  // `verdict` payload (fixtures / older bare JSON) as an envelope.
  if (typeof value.verdict === "string") {
    return false;
  }
  return hasSession && hasResultShape;
}

/**
 * Prefer Turbo's nested structuredOutput body; surface structuredOutputError.
 * Non-envelope objects (bare schema, fixtures) pass through unchanged.
 *
 * @param {unknown} value
 * @returns {{ parsed: object|null, parseError: string|null, envelope: object|null }}
 */
export function unwrapCliStructuredBody(value) {
  if (!isCliJsonEnvelope(value)) {
    return { parsed: value, parseError: null, envelope: null };
  }
  const envelope = value;
  const schemaErrorRaw = envelope.structuredOutputError;
  const schemaError =
    schemaErrorRaw != null && String(schemaErrorRaw).trim() ? String(schemaErrorRaw).trim() : null;

  let body = envelope.structuredOutput;
  if (body === undefined || body === null) {
    if (schemaError) {
      return { parsed: null, parseError: schemaError, envelope };
    }
    return {
      parsed: null,
      parseError: "CLI JSON envelope had no structuredOutput body.",
      envelope
    };
  }
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (error) {
      return {
        parsed: null,
        parseError: schemaError ?? (error instanceof Error ? error.message : String(error)),
        envelope
      };
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      parsed: null,
      parseError: schemaError ?? "CLI structuredOutput was not a JSON object.",
      envelope
    };
  }
  return { parsed: body, parseError: null, envelope };
}

function finishStructuredParse(value, fallback, rawOutput) {
  const unwrapped = unwrapCliStructuredBody(value);
  return {
    ...fallback,
    parsed: unwrapped.parsed,
    parseError: unwrapped.parseError,
    rawOutput,
    // Optional for diagnostics / future consumers; harmless if ignored.
    envelope: unwrapped.envelope
  };
}

/**
 * Parse a Turbo/Grok non-streaming `--output-format json` envelope (C14).
 * Extracts usage, toolCalls, sessionId, structuredOutput, and primary text.
 *
 * @param {string} raw
 * @returns {{
 *   envelope: object|null,
 *   text: string,
 *   sessionId: string|null,
 *   stopReason: string|null,
 *   usage: object|null,
 *   toolCallCount: number|null,
 *   toolVisibility: string|null,
 *   structuredOutput: unknown,
 *   structuredOutputError: string|null,
 *   filesChanged: object|null
 * }|null}
 */
export function parseJsonAgentEnvelope(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  // Bare review schema (fixture) is not an agent envelope for tool/usage.
  if (typeof value.verdict === "string" && !("sessionId" in value) && !("usage" in value)) {
    return null;
  }

  const usage = normalizeUsage(value);
  let toolCallCount = null;
  // Turbo emits toolCalls as a u32 integer on --output-format json (H2).
  // Streaming path uses the same shape on end.toolCalls. Also accept arrays
  // (fixtures / older shapes) and explicit toolCallCount fields.
  if (typeof value.toolCalls === "number" && Number.isFinite(value.toolCalls)) {
    toolCallCount = Number(value.toolCalls);
  } else if (typeof value.tool_calls === "number" && Number.isFinite(value.tool_calls)) {
    toolCallCount = Number(value.tool_calls);
  } else if (Array.isArray(value.toolCalls)) {
    toolCallCount = value.toolCalls.length;
  } else if (Array.isArray(value.tool_calls)) {
    toolCallCount = value.tool_calls.length;
  } else if (value.toolCallCount != null && Number.isFinite(Number(value.toolCallCount))) {
    toolCallCount = Number(value.toolCallCount);
  } else if (value.tool_call_count != null && Number.isFinite(Number(value.tool_call_count))) {
    toolCallCount = Number(value.tool_call_count);
  }

  let toolVisibility = null;
  if (toolCallCount != null) {
    toolVisibility = "explicit";
  }

  const fc = value.filesChanged ?? value.files_changed;
  let filesChanged = null;
  if (fc && typeof fc === "object") {
    const paths = Array.isArray(fc.paths)
      ? fc.paths.map(String)
      : Array.isArray(fc.entries)
        ? fc.entries.map((e) => (typeof e === "string" ? e : e?.path)).filter(Boolean)
        : [];
    const count = Number.isFinite(Number(fc.count ?? fc.total))
      ? Number(fc.count ?? fc.total)
      : paths.length;
    filesChanged = { count, paths, truncated: Boolean(fc.truncated) };
  }

  const bodyText =
    typeof value.text === "string"
      ? value.text
      : typeof value.finalMessage === "string"
        ? value.finalMessage
        : text;

  const schemaErr = value.structuredOutputError ?? value.structured_output_error;
  return {
    envelope: value,
    text: bodyText,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
    stopReason: typeof value.stopReason === "string" ? value.stopReason : null,
    usage,
    toolCallCount,
    toolVisibility,
    structuredOutput: value.structuredOutput ?? value.structured_output ?? null,
    structuredOutputError:
      schemaErr == null || schemaErr === ""
        ? null
        : typeof schemaErr === "string"
          ? schemaErr
          : JSON.stringify(schemaErr),
    filesChanged
  };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      envelope: null
    };
  }

  const text = String(rawOutput).trim();

  try {
    return finishStructuredParse(JSON.parse(text), fallback, text);
  } catch {
    // try fenced / sliced forms below
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return finishStructuredParse(JSON.parse(fenced[1].trim()), fallback, text);
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text,
        envelope: null
      };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return finishStructuredParse(JSON.parse(text.slice(start, end + 1)), fallback, text);
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text,
        envelope: null
      };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from Grok output.",
    rawOutput: text,
    envelope: null
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
