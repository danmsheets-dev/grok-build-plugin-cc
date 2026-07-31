import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getConfig, setConfig } from "./state.mjs";

/**
 * `.grok-build.json` - the per-project settings file.
 *
 * Two hard rules govern this module.
 *
 * 1. It never throws. The file is repo-tracked user input that arrives on the
 *    hot path of every run; a stray comma in it must cost the *settings*, never
 *    the run. Malformed input comes back as `{ present: true, config: {},
 *    errors: [...] }`, the same ethos as provision.mjs' "a failed link must
 *    cost a slower verify, never a failed run".
 *
 * 2. Executable keys are gated behind trust-on-first-use. `verify` strings are
 *    handed to cmd.exe / sh verbatim, so honouring them straight out of a
 *    repo-tracked file would mean that cloning a hostile repository and running
 *    /grok-build:delegate executes whatever that repository's author chose.
 *    Echoing the command right before running it is not a gate - by then it has
 *    already been decided. So the executable keys are withheld until the user
 *    has explicitly recorded trust for the exact bytes of the file, and the
 *    record lives in the plugin's state dir (outside the repo), where a clone
 *    cannot pre-seed it.
 *
 * Everything else - timeouts, budgets, model choice - is honoured
 * unconditionally: the worst a hostile value there can do is make the run
 * short, slow, or expensive, which is visible and reversible.
 */

export const PROJECT_CONFIG_FILENAME = ".grok-build.json";

/** Schema version this module understands. */
export const PROJECT_CONFIG_VERSION = 1;

/** state.mjs config key holding the sha256 of the trusted config file. */
export const TRUST_STATE_KEY = "verifyTrustHash";

/**
 * Keys withheld until the file's hash is trusted.
 *
 * `verify` and `tools` are named by the design: both end up inside a command
 * string that a shell executes. `env` is here for the same reason even though
 * it looks inert - a config that sets PATH (or LD_PRELOAD, or NODE_OPTIONS)
 * chooses which binary every subsequent verify command actually runs, which is
 * arbitrary code execution by a longer route. `env` is consumed by
 * grok-bridge.mjs, which layers `settings.env` (the trust-gated block) under
 * `--env` before building the run's environment - see the comment on
 * `envOverrides` there.
 */
export const EXECUTABLE_KEYS = Object.freeze(["verify", "tools", "env"]);

// Full Hyper ladder (HYPER-2). Keep in sync with KNOWN_REASONING_EFFORTS in
// grok-bridge.mjs — the CLI is still the authority at runtime, but the config
// schema should not reject a valid tier the bridge accepts.
const VALID_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
]);

function fieldError(key, expected) {
  return `${key}: expected ${expected}`;
}

/* --------------------------------------------------------------------------
 * Field normalizers.
 *
 * Each returns the normalized value, or `undefined` when the input cannot be
 * used. `undefined` is meaningful: in resolveRunSettings it means "this source
 * has nothing usable for this key", so the next source down the precedence
 * chain gets its turn instead of the run inheriting a bogus value.
 * ----------------------------------------------------------------------- */

function normalizeString(raw) {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  return value ? value : undefined;
}

function normalizeBoolean(raw) {
  return typeof raw === "boolean" ? raw : undefined;
}

function normalizePositiveNumber(raw) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizePositiveInteger(raw) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function normalizeStringArray(raw) {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const values = raw
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values;
}

function normalizeEffort(raw) {
  const value = normalizeString(raw);
  if (!value) {
    return undefined;
  }
  return VALID_EFFORTS.has(value.toLowerCase()) ? value.toLowerCase() : undefined;
}

function normalizeStringMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = normalizeString(value);
    if (normalized !== undefined) {
      out[key] = normalized;
    }
  }
  return out;
}

/** `tools` only carries engine binary overrides today. */
function normalizeTools(raw) {
  const map = normalizeStringMap(raw);
  if (map === undefined) {
    return undefined;
  }
  const out = {};
  for (const id of ["godot", "blender"]) {
    if (map[id] !== undefined) {
      out[id] = map[id];
    }
  }
  return out;
}

/**
 * `provision` controls how heavyweight dirs/files land in an isolated worktree.
 *
 * `copy: true` is the opt-out from sharing Godot's `.godot`/`.import` with the
 * working copy - the same switch as GROK_BUILD_LINK_GODOT_CACHE=0, expressed
 * per project.
 *
 * `files` is an optional list of untracked runtime file basenames to copy
 * (never link) into the worktree; when omitted the built-in PROVISION_COPY_FILES
 * list is used. `link` is an optional per-directory map of
 * `"share" | "copy" | "env" | "none"` overrides for PROVISION_DIR_POLICY.
 *
 * Deliberately NOT an executable key: it changes which files are copied into a
 * worktree, and executes nothing.
 */
function normalizeProvision(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const out = {};
  const copy = normalizeBoolean(raw.copy);
  if (copy !== undefined) {
    out.copy = copy;
  }
  const files = normalizeStringArray(raw.files);
  if (files !== undefined) {
    out.files = files;
  }
  if (raw.link && typeof raw.link === "object" && !Array.isArray(raw.link)) {
    /** @type {Record<string, string>} */
    const link = {};
    for (const [key, value] of Object.entries(raw.link)) {
      const name = String(key ?? "").trim();
      const tier = String(value ?? "")
        .trim()
        .toLowerCase();
      if (!name) {
        continue;
      }
      if (tier === "share" || tier === "copy" || tier === "env" || tier === "none") {
        link[name] = tier;
      }
    }
    if (Object.keys(link).length > 0) {
      out.link = link;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Schema v1. Every key is optional; `executable` marks the ones the trust gate
 * withholds. The `expected` text is what a user sees when their value is the
 * wrong shape, so it names the shape, not the type name.
 */
/**
 * Known ecosystem ids a project may list in `ecosystems` to narrow the
 * multi-ecosystem verify plan. Non-executable: it only filters detection.
 */
const KNOWN_ECOSYSTEM_IDS = new Set(["godot", "blender", "rust", "python", "node"]);

function normalizeEcosystems(raw) {
  const values = normalizeStringArray(raw);
  if (values === undefined) {
    return undefined;
  }
  const out = [];
  for (const entry of values) {
    const id = entry.toLowerCase();
    if (KNOWN_ECOSYSTEM_IDS.has(id) && !out.includes(id)) {
      out.push(id);
    }
  }
  return out.length > 0 ? out : undefined;
}

const SCHEMA = Object.freeze({
  version: { normalize: normalizePositiveInteger, expected: "a positive integer" },
  // Singular legacy key (informational). Prefer `ecosystems` for multi-stack.
  ecosystem: { normalize: normalizeString, expected: "a non-empty string" },
  // Non-executable allowlist: narrow detectEcosystems results for verify plan.
  ecosystems: {
    normalize: normalizeEcosystems,
    expected: 'an array of ecosystem ids (e.g. ["python","node"])'
  },
  verify: { normalize: normalizeStringArray, expected: "an array of command strings", executable: true },
  // >= 1, not >= 0: the bridge's resolveVerifyAttempts coerces anything below 1
  // to its built-in 2, so accepting 0 here would silently mean something other
  // than what the file says.
  verifyAttempts: { normalize: normalizePositiveInteger, expected: "an integer >= 1" },
  verifyTimeoutMs: { normalize: normalizePositiveNumber, expected: "a positive number of milliseconds" },
  verifyTimeoutMultiplier: { normalize: normalizePositiveNumber, expected: "a positive number" },
  baselineTimeoutMs: { normalize: normalizePositiveNumber, expected: "a positive number of milliseconds" },
  verifyMaxOutputBytes: { normalize: normalizePositiveNumber, expected: "a positive number of bytes" },
  verifyFailurePatterns: { normalize: normalizeStringArray, expected: "an array of regex strings" },
  verifyIgnorePatterns: { normalize: normalizeStringArray, expected: "an array of regex strings" },
  isolate: { normalize: normalizeBoolean, expected: "true or false" },
  linkDirs: { normalize: normalizeStringArray, expected: "an array of directory names" },
  provision: {
    normalize: normalizeProvision,
    expected: "an object with optional copy (boolean), files (string[]), link (per-dir share|copy|env|none)"
  },
  // Opt-in Godot headless export smoke when export_presets.cfg exists. Never
  // an executable key: it only adds a default verify command shape, and the
  // bridge still resolves the binary literally.
  exportSmoke: { normalize: normalizeBoolean, expected: "true or false" },
  artifactExcludes: { normalize: normalizeStringArray, expected: "an array of pathspec strings" },
  maxDurationSeconds: { normalize: normalizePositiveNumber, expected: "a positive number of seconds" },
  maxTurns: { normalize: normalizePositiveInteger, expected: "an integer >= 1" },
  maxCostUsd: { normalize: normalizePositiveNumber, expected: "a positive number of dollars" },
  model: { normalize: normalizeString, expected: "a non-empty string" },
  effort: { normalize: normalizeEffort, expected: "none, minimal, low, medium, high, xhigh, max, or ultra" },
  env: { normalize: normalizeStringMap, expected: "an object of string values", executable: true },
  tools: { normalize: normalizeTools, expected: "an object with godot / blender paths", executable: true }
});

export const PROJECT_CONFIG_KEYS = Object.freeze(Object.keys(SCHEMA));

/** Absolute path of the config file for a workspace root. */
export function resolveProjectConfigPath(root) {
  return path.join(String(root ?? ""), PROJECT_CONFIG_FILENAME);
}

/**
 * Trust identity of a config file: sha256 over its exact contents. Any edit -
 * including one that only adds whitespace - invalidates the record, which is
 * the point: trust is granted to bytes a human read, not to a filename.
 */
export function hashProjectConfig(raw) {
  return createHash("sha256").update(String(raw ?? ""), "utf8").digest("hex");
}

function emptyResult(filePath) {
  return {
    present: false,
    path: filePath,
    hash: null,
    config: {},
    untrusted: {},
    trusted: false,
    errors: [],
    warnings: []
  };
}

/**
 * Read and validate `.grok-build.json` at `root`.
 *
 * Never throws. `config` holds only the settings the caller may honour: when
 * the file's hash does not match `trustedHash`, the executable keys are moved
 * to `untrusted` and a warning is recorded, so a caller that simply reads
 * `config` cannot accidentally execute them.
 *
 * @param {string} root workspace root
 * @param {{
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   trustedHash?: string|null
 * }} [options]
 */
export function loadProjectConfig(root, options = {}) {
  const existsSync = options.existsSync ?? fs.existsSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const filePath = resolveProjectConfigPath(root);

  if (!root) {
    return emptyResult(filePath);
  }

  let exists = false;
  try {
    exists = Boolean(existsSync(filePath));
  } catch {
    exists = false;
  }
  if (!exists) {
    return emptyResult(filePath);
  }

  const result = emptyResult(filePath);
  result.present = true;

  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    result.errors.push(
      `${PROJECT_CONFIG_FILENAME} could not be read (${error instanceof Error ? error.message : String(error)})`
    );
    return result;
  }

  result.hash = hashProjectConfig(raw);

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    // Naming the file matters: this message is surfaced by doctor and by the
    // run header, and "Unexpected token }" on its own tells a user nothing
    // about which of their files is broken.
    result.errors.push(
      `${PROJECT_CONFIG_FILENAME} is not valid JSON (${error instanceof Error ? error.message : String(error)})`
    );
    return result;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    result.errors.push(`${PROJECT_CONFIG_FILENAME} must contain a JSON object`);
    return result;
  }

  const trusted = Boolean(result.hash && options.trustedHash && result.hash === options.trustedHash);
  result.trusted = trusted;

  for (const [key, value] of Object.entries(parsed)) {
    const field = SCHEMA[key];
    if (!field) {
      // Unknown keys are warnings, never fatals: a config written for a newer
      // plugin version must still work on an older one.
      result.warnings.push(`${PROJECT_CONFIG_FILENAME}: unknown key "${key}" (ignored)`);
      continue;
    }
    if (value === null || value === undefined) {
      continue;
    }
    const normalized = field.normalize(value);
    if (normalized === undefined) {
      result.warnings.push(`${PROJECT_CONFIG_FILENAME}: ${fieldError(key, field.expected)} (ignored)`);
      continue;
    }
    if (field.executable && !trusted) {
      result.untrusted[key] = normalized;
      continue;
    }
    result.config[key] = normalized;
  }

  if (Object.keys(result.untrusted).length > 0) {
    result.warnings.push(
      `${PROJECT_CONFIG_FILENAME}: ${Object.keys(result.untrusted).join(", ")} withheld until this file is trusted`
    );
  }

  if (result.config.version !== undefined && result.config.version > PROJECT_CONFIG_VERSION) {
    result.warnings.push(
      `${PROJECT_CONFIG_FILENAME}: version ${result.config.version} is newer than this plugin understands (v${PROJECT_CONFIG_VERSION})`
    );
  }

  return result;
}

/**
 * The hash the user has recorded trust for, or null. Reading state must not be
 * able to fail a run either - an unwritable or corrupt state dir simply means
 * "nothing is trusted yet", which is the safe direction.
 */
export function readProjectConfigTrust(workspaceRoot, options = {}) {
  const getConfigImpl = options.getConfigImpl ?? getConfig;
  try {
    const stored = getConfigImpl(workspaceRoot);
    const hash = stored?.[TRUST_STATE_KEY];
    return typeof hash === "string" && hash ? hash : null;
  } catch {
    return null;
  }
}

/**
 * Load the config for a workspace with its trust record already applied. This
 * is what the bridge calls; `loadProjectConfig` stays pure for tests.
 */
export function loadWorkspaceProjectConfig(workspaceRoot, options = {}) {
  return loadProjectConfig(workspaceRoot, {
    ...options,
    trustedHash: options.trustedHash ?? readProjectConfigTrust(workspaceRoot, options)
  });
}

/**
 * Record trust for the config file exactly as it is on disk right now.
 *
 * Deliberately takes the workspace root rather than a hash: trust must be
 * granted to bytes that were just read, not to a value a caller passed in.
 * The record lives in the plugin state dir - keyed by workspace root, outside
 * the repository - so a hostile clone cannot ship its own trust record.
 */
export function recordProjectConfigTrust(workspaceRoot, options = {}) {
  const setConfigImpl = options.setConfigImpl ?? setConfig;
  const loaded = loadProjectConfig(workspaceRoot, options);
  if (!loaded.present) {
    return { recorded: false, reason: "no-config", loaded };
  }
  if (!loaded.hash) {
    return { recorded: false, reason: "unreadable", loaded };
  }
  setConfigImpl(workspaceRoot, TRUST_STATE_KEY, loaded.hash);
  return { recorded: true, hash: loaded.hash, loaded };
}

/** Forget the recorded trust, so the executable keys are withheld again. */
export function revokeProjectConfigTrust(workspaceRoot, options = {}) {
  const setConfigImpl = options.setConfigImpl ?? setConfig;
  setConfigImpl(workspaceRoot, TRUST_STATE_KEY, null);
  return { revoked: true };
}

/* --------------------------------------------------------------------------
 * Settings resolution
 * ----------------------------------------------------------------------- */

const SOURCE_ORDER = Object.freeze(["cli", "config", "ecosystem-default"]);

/**
 * Resolve the verify command list and say where it came from.
 *
 * "CLI wins outright when non-empty" is the whole rule. An empty CLI list is
 * NOT an opt-out: normalizeVerifyCommands in the bridge maps both an absent
 * --verify and `--verify ""` to the same `[]`, so treating `[]` as "the user
 * asked for no verification" would silently disable the config and ecosystem
 * plans for everyone who did not pass the flag. The explicit opt-out is
 * `--no-verify`, which arrives here as `disabled`.
 *
 * @param {{
 *   cli?: string[]|null,
 *   config?: string[]|null,
 *   ecosystemDefaults?: string[]|null,
 *   disabled?: boolean
 * }} [input]
 * @returns {{ commands: string[], source: "cli"|"config"|"ecosystem-default"|"none", disabled: boolean }}
 */
export function resolveVerifyCommands(input = {}) {
  const disabled = Boolean(input.disabled);
  if (disabled) {
    return { commands: [], source: "none", disabled: true };
  }

  const candidates = [
    ["cli", input.cli],
    ["config", input.config],
    ["ecosystem-default", input.ecosystemDefaults]
  ];

  for (const [source, raw] of candidates) {
    const commands = normalizeStringArray(Array.isArray(raw) ? raw : raw == null ? [] : [raw]) ?? [];
    if (commands.length > 0) {
      return { commands, source, disabled: false };
    }
  }

  return { commands: [], source: "none", disabled: false };
}

/**
 * Resolve every run setting from the three sources, in precedence order:
 * explicit CLI > config file > ecosystem defaults > built-ins.
 *
 * Pure and total. Each key is normalized per source, and a source that carries
 * an unusable value for a key is skipped for that key rather than poisoning it
 * - which is the fix for the two normalizer traps in the bridge:
 * `resolveVerifyAttempts` coerces anything bogus to 2, and
 * `normalizeVerifyCommands` maps "absent" and "empty" to the same `[]`. Both
 * would otherwise make a broken CLI value indistinguishable from an absent
 * one, so the config could never win.
 *
 * Keys resolve to `undefined` when no source supplies a usable value; the
 * caller's own built-in default then applies, unchanged from 0.3.x.
 *
 * @param {{ cli?: object, config?: object, ecosystemDefaults?: object }} [input]
 */
export function resolveRunSettings(input = {}) {
  const bags = {
    cli: input.cli ?? {},
    config: input.config ?? {},
    "ecosystem-default": input.ecosystemDefaults ?? {}
  };

  const settings = {};
  const sources = {};

  for (const [key, field] of Object.entries(SCHEMA)) {
    if (key === "verify") {
      continue;
    }
    for (const source of SOURCE_ORDER) {
      const bag = bags[source];
      if (!bag || typeof bag !== "object") {
        continue;
      }
      const raw = bag[key];
      if (raw === undefined || raw === null || raw === "") {
        continue;
      }
      const value = field.normalize(raw);
      if (value === undefined) {
        continue;
      }
      settings[key] = value;
      sources[key] = source;
      break;
    }
  }

  const verify = resolveVerifyCommands({
    cli: bags.cli?.verify,
    config: bags.config?.verify,
    ecosystemDefaults: bags["ecosystem-default"]?.verify,
    disabled: Boolean(bags.cli?.noVerify)
  });
  settings.verify = verify.commands;
  sources.verify = verify.source;

  return { ...settings, verifyDisabled: verify.disabled, sources };
}

/**
 * Isolation is resolved separately from resolveRunSettings.
 *
 * For a human at a terminal, `--no-isolate` stays an absolute override rather
 * than a precedence winner: a user who typed it must get a non-isolated run
 * even if the repo's config asks for isolation.
 *
 * For a programmatic caller (Claude Code, another bridge, `--caller`), a write
 * run ALWAYS isolates. `--no-isolate` and `isolate: false` in config are
 * refused with a clear error rather than silently downgraded, unless
 * `allowNoIsolate` is set (GROK_BUILD_ALLOW_NO_ISOLATE=1). That is deliberate:
 * silent downgrade is how concurrent programmatic runs shared one dirty tree.
 *
 * Pure and injectable — every input is a parameter so tests do not need to
 * poke process.env.
 *
 * @returns {{ isolate: boolean, source: "forced-programmatic"|"cli"|"config"|"write-default"|"read-only-default"|"read-only" }}
 */
export function resolveIsolateSetting({
  cliIsolate,
  cliNoIsolate,
  configIsolate,
  write,
  programmatic = false,
  allowNoIsolate = false
} = {}) {
  // Programmatic write: isolation is mandatory. Refuse every opt-out path
  // unless the operator set the escape hatch.
  if (write && programmatic) {
    const wantsOut = Boolean(cliNoIsolate) || configIsolate === false;
    if (wantsOut && !allowNoIsolate) {
      throw new Error(
        "Programmatic write runs require isolation (a worktree). " +
          "`--no-isolate` and `isolate: false` are refused for Claude Code / bridge callers " +
          "because absolute paths in the task brief otherwise write into the main checkout. " +
          "Unset those, or set GROK_BUILD_ALLOW_NO_ISOLATE=1 only if you deliberately accept that risk."
      );
    }
    if (wantsOut && allowNoIsolate) {
      // Escape hatch honoured: keep the same source labels a human would get.
      if (cliNoIsolate) {
        return { isolate: false, source: "cli" };
      }
      return { isolate: false, source: "config" };
    }
    return { isolate: true, source: "forced-programmatic" };
  }

  // Human (or non-write programmatic) path.
  if (cliNoIsolate) {
    return { isolate: false, source: "cli" };
  }
  if (cliIsolate) {
    return { isolate: true, source: "cli" };
  }
  if (typeof configIsolate === "boolean") {
    return { isolate: configIsolate, source: "config" };
  }
  if (write) {
    return { isolate: true, source: "write-default" };
  }
  // Read-only runs isolate by default too (R6-1). A worktree with no live-state
  // provisioning is cheap, and the previous "share main checkout + unrestricted
  // shell" path was the weakest surface once write isolation landed.
  return { isolate: true, source: "read-only-default" };
}

/** Human-readable label for a verify-plan source, used in the run header. */
export function describeVerifySource(source) {
  switch (source) {
    case "cli":
      return "--verify";
    case "config":
      return PROJECT_CONFIG_FILENAME;
    case "ecosystem-default":
      return "ecosystem default";
    default:
      return "none";
  }
}
