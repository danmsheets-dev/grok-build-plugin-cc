import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { detectEcosystems } from "./ecosystem.mjs";

// Heavyweight directories that may be provisioned into a fresh worktree so the
// first verify command does not fail for lack of dependencies. Covers the five
// target ecosystems: Godot's import cache (.godot for Godot 4, .import for
// Godot 3), Rust (target), Python (.venv/venv, .tox, __pypackages__), JS/web
// (node_modules + framework build caches), and generic vendor dirs.
//
// Classification into *share* vs *live-state* is PROVISION_DIR_POLICY below.
// Live-state dirs are private to the worktree (hardlink-seeded when possible);
// only read-mostly caches are junctioned/symlinked into the main checkout.
export const PROVISION_LINK_DIRS = Object.freeze([
  "node_modules",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".godot",
  ".import",
  ".tox",
  "__pypackages__",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache"
]);

/**
 * Per-directory isolation policy.
 *
 * - `share` — read-mostly; junction (win32) / symlink (posix) from main checkout.
 *   Post-run fingerprint assertion detects mutation of the main tree.
 * - `copy` — live state; private worktree directory, seeded by hardlink (same
 *   volume) or file copy (cross-volume / hardlink failure).
 * - `env` — do not materialise the main tree's dir; set an env var instead
 *   (CARGO_TARGET_DIR for `target`).
 * - `none` — skip entirely.
 *
 * Godot caches are `copy` by default under isolation; resolveGodotCacheMode can
 * flip them back to `share` via env / project config.
 */
export const PROVISION_DIR_POLICY = Object.freeze({
  // Live state: installers, build systems, and editable envs mutate these and
  // embed absolute paths. Junctioning them was observed to corrupt the main
  // cargo target/ and rewrite the user's real venv (see WP-B2).
  node_modules: "copy",
  ".venv": "copy",
  venv: "copy",
  target: "env",
  ".godot": "copy",
  ".import": "copy",
  ".tox": "copy",
  __pypackages__: "copy",
  ".next": "copy",
  ".nuxt": "copy",
  ".svelte-kit": "copy",
  ".turbo": "copy",
  ".parcel-cache": "copy",
  // Read-mostly vendored dependencies (e.g. Go vendor/). Still fingerprinted
  // after the run so a write-through cannot stay invisible.
  vendor: "share"
});

/**
 * Godot's asset import caches — LIVE STATE. Kept as a named set so the
 * private/share mode switch (resolveGodotCacheMode) and partial seed paths
 * (PROVISION_COPY_PATHS) stay explicit.
 */
export const GODOT_CACHE_DIRS = Object.freeze([".godot", ".import"]);

/**
 * What gets seeded into a COLD Godot cache when the link is opted out of.
 *
 * Only the small state files, and deliberately not `.godot/imported`: that is
 * the multi-gigabyte part, and copying it synchronously on every run costs more
 * than the cold import the copy was supposed to avoid. `.import` is Godot 3's
 * whole cache directory and has no such split, so it is copied entire - the
 * accepted cost of the opt-out on a Godot 3 project with heavy assets.
 */
export const PROVISION_COPY_PATHS = Object.freeze([
  ".godot/uid_cache.bin",
  ".godot/global_script_class_cache.cfg",
  ".godot/extension_list.cfg",
  ".import"
]);

/**
 * Untracked runtime files copied (never linked) into the worktree so verify
 * can actually run. `git worktree add` only materialises tracked content, so
 * `.env`, registry auth, and local Django settings are otherwise absent —
 * producing baseline-red → post-agent-red → false "verified".
 *
 * Values are never written into the run record; only the file *names* appear
 * in provision notes. Each name is also in NEVER_COMMIT_PATTERNS so a commit
 * cannot pick them up.
 */
export const PROVISION_COPY_FILES = Object.freeze([
  ".env",
  ".env.local",
  ".env.development",
  ".env.test",
  ".npmrc",
  ".yarnrc.yml",
  "local_settings.py",
  "settings_local.py",
  "secrets.json"
]);

/** Relative path of the per-worktree cargo target dir (under WORKTREE_SCRATCH_DIR). */
export const CARGO_TARGET_DIR_RELATIVE = ".grok-build/cargo-target";

const LINK_GODOT_CACHE_ENV = "GROK_BUILD_LINK_GODOT_CACHE";
const INJECT_RUNTIME_ENV = "GROK_BUILD_INJECT_RUNTIME";

/**
 * The warning that has to reach the run header whenever `.godot` is linked.
 *
 * Concurrent Godot access clobbers `.godot/global_script_class_cache.cfg` and
 * then produces parse errors against files git reports as unmodified — a single
 * `--import` repairs it, but the failure is indistinguishable from real broken
 * code. Emit this at provisioning time (progress channel) AND in the final
 * report; "at the end only" is how a field session burned a full run fighting
 * the editor.
 */
export const GODOT_SHARED_CACHE_NOTE =
  ".godot is shared with your working copy; close the Godot editor before running verify.";

/**
 * Resolve whether an isolated run should use a private Godot cache.
 *
 * Default under isolation is PRIVATE. Sharing the user's `.godot` with a
 * headless import is the corruption vector above; a cold first import is slow
 * but honest. Explicit opt-in still works:
 *
 *   - `GROK_BUILD_LINK_GODOT_CACHE=1` / `true` / `yes` → shared link
 *   - `GROK_BUILD_LINK_GODOT_CACHE=0` / `false` / `no` → private (same as default)
 *   - `provision.copy: true` in `.grok-build.json` → private
 *   - `provision.copy: false` → shared
 *   - `options.copyGodotCache` boolean from the bridge (project config) wins
 *     over the env var when set
 *
 * @returns {{ private: boolean, reason: string, cacheLine: string }}
 */
export function resolveGodotCacheMode(options = {}, env = process.env) {
  let privateCache;
  let reason;

  if (options.copyGodotCache !== undefined) {
    privateCache = Boolean(options.copyGodotCache);
    reason = privateCache
      ? "provision.copy=true in project config"
      : "provision.copy=false in project config";
  } else {
    const raw = env?.[LINK_GODOT_CACHE_ENV];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      const normalized = String(raw).trim().toLowerCase();
      if (normalized === "0" || normalized === "false" || normalized === "no") {
        privateCache = true;
        reason = `${LINK_GODOT_CACHE_ENV}=${String(raw).trim()}`;
      } else if (normalized === "1" || normalized === "true" || normalized === "yes") {
        privateCache = false;
        reason = `${LINK_GODOT_CACHE_ENV}=${String(raw).trim()}`;
      } else {
        // Unrecognised value: fail safe to private rather than share.
        privateCache = true;
        reason = `${LINK_GODOT_CACHE_ENV} unrecognised (${String(raw).trim()}); defaulting to private`;
      }
    } else {
      // Isolated-run default. planWorktreeLinks is only called for isolated
      // write runs, so "default private" is the isolation default.
      privateCache = true;
      reason = "default for isolated runs";
    }
  }

  const cacheLine = privateCache
    ? `Godot cache: private to this run (${reason}; first import into a cold cache is slow)`
    : `Godot cache: shared with your working copy (${reason})`;

  return { private: privateCache, reason, cacheLine };
}

/**
 * Resolve the effective policy for one provision directory name.
 *
 * @param {string} name
 * @param {{
 *   copyGodotCache?: boolean,
 *   dirPolicy?: Record<string, string>,
 *   env?: NodeJS.ProcessEnv
 * }} [options]
 * @returns {"share"|"copy"|"env"|"none"}
 */
export function resolveDirPolicy(name, options = {}) {
  const overrides = options.dirPolicy && typeof options.dirPolicy === "object" ? options.dirPolicy : {};
  if (Object.prototype.hasOwnProperty.call(overrides, name)) {
    const raw = String(overrides[name] ?? "")
      .trim()
      .toLowerCase();
    if (raw === "share" || raw === "copy" || raw === "env" || raw === "none") {
      return raw;
    }
  }

  if (GODOT_CACHE_DIRS.includes(name)) {
    // Godot keeps its private/share switch; the generic table says "copy" but
    // an explicit shared-cache opt-in must still produce a junction/symlink.
    return resolveGodotCacheMode(options, options.env ?? process.env).private ? "copy" : "share";
  }

  const defaultPolicy = PROVISION_DIR_POLICY[name] ?? "share";
  return defaultPolicy;
}

/**
 * True when two absolute paths live on the same volume (hardlink-capable).
 *
 * Windows: compare drive roots (`C:\` vs `D:\`). POSIX: compare `stat.st_dev`.
 * When the check itself fails, return false so callers fall back to copy rather
 * than attempting a cross-device hardlink that throws EXDEV.
 *
 * @param {string} a
 * @param {string} b
 * @param {{
 *   platform?: string,
 *   statSync?: typeof fs.statSync
 * }} [options]
 */
export function sameVolume(a, b, options = {}) {
  const platform = options.platform ?? process.platform;
  const statSync = options.statSync ?? fs.statSync;
  const left = path.resolve(String(a ?? ""));
  const right = path.resolve(String(b ?? ""));
  if (!left || !right) {
    return false;
  }

  if (platform === "win32") {
    const rootA = path.parse(left).root.toLowerCase();
    const rootB = path.parse(right).root.toLowerCase();
    return Boolean(rootA) && rootA === rootB;
  }

  try {
    const sa = statSync(left);
    const sb = statSync(right);
    if (typeof sa.dev === "number" && typeof sb.dev === "number") {
      return sa.dev === sb.dev;
    }
  } catch {
    return false;
  }
  // Parent of `to` may not exist yet; compare against dirname chain of `from`.
  try {
    const sa = statSync(left);
    let probe = path.dirname(right);
    for (let i = 0; i < 8; i += 1) {
      try {
        const sb = statSync(probe);
        if (typeof sa.dev === "number" && typeof sb.dev === "number") {
          return sa.dev === sb.dev;
        }
      } catch {
        // walk up
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        break;
      }
      probe = parent;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Fingerprint a shared (junctioned) directory in the MAIN checkout so a
 * post-run assertion can detect mutation that git status cannot see
 * (gitignored build caches).
 *
 * Shape: top-level entry count + max mtimeMs of those entries. Cheap, and
 * enough to catch `npm install` / `cargo build` / editor writes.
 *
 * @param {string} dirPath absolute path in the main checkout
 * @param {{
 *   existsSync?: typeof fs.existsSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   statSync?: typeof fs.statSync
 * }} [options]
 * @returns {{ exists: boolean, entryCount: number, maxMtimeMs: number }}
 */
export function fingerprintDir(dirPath, options = {}) {
  const existsSync = options.existsSync ?? fs.existsSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const statSync = options.statSync ?? fs.statSync;

  if (!dirPath || !existsSync(dirPath)) {
    return { exists: false, entryCount: 0, maxMtimeMs: 0 };
  }

  let names;
  try {
    names = readdirSync(dirPath);
  } catch {
    return { exists: true, entryCount: -1, maxMtimeMs: 0 };
  }

  let maxMtimeMs = 0;
  try {
    const self = statSync(dirPath);
    if (Number.isFinite(self.mtimeMs)) {
      maxMtimeMs = self.mtimeMs;
    }
  } catch {
    // ignore
  }

  for (const name of names) {
    try {
      const st = statSync(path.join(dirPath, name));
      if (Number.isFinite(st.mtimeMs) && st.mtimeMs > maxMtimeMs) {
        maxMtimeMs = st.mtimeMs;
      }
    } catch {
      // skip unreadable entries
    }
  }

  return { exists: true, entryCount: names.length, maxMtimeMs };
}

/**
 * Snapshot fingerprints for every shared directory name under repoRoot.
 *
 * @param {string} repoRoot
 * @param {string[]} sharedNames basenames (e.g. ["vendor"])
 * @param {object} [options] passed to fingerprintDir
 * @returns {Record<string, { exists: boolean, entryCount: number, maxMtimeMs: number }>}
 */
export function fingerprintSharedDirs(repoRoot, sharedNames, options = {}) {
  const root = path.resolve(String(repoRoot ?? ""));
  const out = {};
  for (const name of sharedNames ?? []) {
    if (!name) {
      continue;
    }
    out[name] = fingerprintDir(path.join(root, name), options);
  }
  return out;
}

/**
 * Compare before/after fingerprints of shared dirs in the main checkout.
 *
 * @param {Record<string, { exists: boolean, entryCount: number, maxMtimeMs: number }>} before
 * @param {Record<string, { exists: boolean, entryCount: number, maxMtimeMs: number }>} after
 * @returns {string[]} basenames that changed
 */
export function diffSharedFingerprints(before, after) {
  const names = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {})
  ]);
  const changed = [];
  for (const name of names) {
    const a = before?.[name];
    const b = after?.[name];
    if (!a && !b) {
      continue;
    }
    if (!a || !b) {
      changed.push(name);
      continue;
    }
    if (
      a.exists !== b.exists ||
      a.entryCount !== b.entryCount ||
      a.maxMtimeMs !== b.maxMtimeMs
    ) {
      changed.push(name);
    }
  }
  return changed;
}

/**
 * Plan provision links/copies/env for an isolated worktree.
 *
 * @returns {{
 *   links: Array<{from: string, to: string, kind: string, name?: string}>,
 *   notes: string[],
 *   godotCache: { private: boolean, reason: string, cacheLine: string },
 *   env: Record<string, string>,
 *   sharedDirs: string[],
 *   privateDirs: string[],
 *   policy: Record<string, string>
 * }}
 */
export function planWorktreeLinks(repoRoot, worktreePath, options = {}) {
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;
  const statSync = options.statSync ?? fs.statSync;
  // The sole production caller passes no options at all, so the default has to
  // be the real environment rather than an empty object.
  const env = options.env ?? process.env;
  const shareKind = platform === "win32" ? "junction" : "symlink";
  const cacheMode = resolveGodotCacheMode(options, env);

  const root = path.resolve(String(repoRoot ?? ""));
  const wt = path.resolve(String(worktreePath ?? ""));

  const links = [];
  const notes = [];
  /** @type {Record<string, string>} */
  const planEnv = {};
  const sharedDirs = [];
  const privateDirs = [];
  /** @type {Record<string, string>} */
  const policy = {};

  if (!repoRoot || !worktreePath) {
    notes.push("planWorktreeLinks: repoRoot and worktreePath are required");
    return {
      links,
      notes,
      godotCache: cacheMode,
      env: planEnv,
      sharedDirs,
      privateDirs,
      policy
    };
  }

  // Extra dirs from project config (`linkDirs`) are treated as share-tier
  // additions when not already in the built-in list.
  const extraLinkDirs = Array.isArray(options.linkDirs)
    ? options.linkDirs.map((d) => String(d ?? "").trim()).filter(Boolean)
    : [];
  const dirNames = [...PROVISION_LINK_DIRS];
  for (const name of extraLinkDirs) {
    if (!dirNames.includes(name)) {
      dirNames.push(name);
    }
  }

  let linkedGodotCache = false;
  let sawGodotCacheSource = false;
  let sharedNonGodot = [];

  for (const name of dirNames) {
    const from = path.join(root, name);
    const to = path.join(wt, name);
    const tier = resolveDirPolicy(name, { ...options, env });
    policy[name] = tier;

    if (tier === "none") {
      continue;
    }

    if (tier === "env" && name === "target") {
      // Idiomatic cargo isolation: point CARGO_TARGET_DIR at a worktree-private
      // directory rather than copying multi-GB target/ trees (and rather than
      // junctioning, which was observed to leave absolute worktree paths in the
      // main checkout's build-script output after the worktree was deleted).
      // Only emit when the project looks like Rust (target/ or Cargo.toml), so
      // non-Rust repos do not get a spurious cargo-target note.
      const hasCargoToml = existsSync(path.join(root, "Cargo.toml"));
      if (!existsSync(from) && !hasCargoToml) {
        continue;
      }
      const cargoTarget = path.join(wt, ...CARGO_TARGET_DIR_RELATIVE.split("/"));
      planEnv.CARGO_TARGET_DIR = cargoTarget;
      privateDirs.push(name);
      notes.push(
        `target: private via CARGO_TARGET_DIR=${CARGO_TARGET_DIR_RELATIVE} (main checkout target/ is not linked)`
      );
      // Materialise an empty dir so cargo never has to create the parent alone;
      // kind "mkdir" is handled by provisionWorktree without reading a source.
      links.push({ from: cargoTarget, to: cargoTarget, kind: "mkdir", name: "cargo-target" });
      continue;
    }

    if (!existsSync(from)) {
      continue;
    }

    let stat;
    try {
      stat = statSync(from);
    } catch {
      notes.push(`skip ${name}: cannot stat source`);
      continue;
    }

    if (!stat.isDirectory()) {
      notes.push(`skip ${name}: source is not a directory`);
      continue;
    }

    if (GODOT_CACHE_DIRS.includes(name)) {
      sawGodotCacheSource = true;
    }

    if (tier === "share") {
      links.push({ from, to, kind: shareKind, name });
      sharedDirs.push(name);
      if (GODOT_CACHE_DIRS.includes(name)) {
        linkedGodotCache = true;
      } else {
        sharedNonGodot.push(name);
      }
      continue;
    }

    // tier === "copy" (private). Godot keeps its partial seed; everything else
    // hardlink-seeds the whole tree.
    if (GODOT_CACHE_DIRS.includes(name)) {
      // No entry for the directory itself — partial seed via PROVISION_COPY_PATHS.
      privateDirs.push(name);
      continue;
    }

    links.push({ from, to, kind: "hardlink-seed", name });
    privateDirs.push(name);
  }

  if (cacheMode.private && sawGodotCacheSource) {
    const copied = [];
    for (const relativePath of PROVISION_COPY_PATHS) {
      const segments = relativePath.split("/");
      const from = path.join(root, ...segments);
      const to = path.join(wt, ...segments);
      if (!existsSync(from)) {
        continue;
      }
      // Godot seed: hardlink-seed when same volume, else plain copy. Marked
      // "hardlink-seed" so provisionWorktree uses the volume-aware path; for
      // single files EXDEV falls back to copyFileSync automatically.
      links.push({ from, to, kind: "hardlink-seed", name: path.basename(relativePath) });
      copied.push(relativePath);
    }
    notes.push(cacheMode.cacheLine);
    notes.push(
      copied.length > 0
        ? `Godot import cache seeded (not shared): ${copied.join(", ")}. Shared-cache lock skipped (private to this run).`
        : "Godot import cache is empty in the worktree; first verify runs a cold import. Shared-cache lock skipped (private to this run)."
    );
  } else if (linkedGodotCache) {
    notes.push(cacheMode.cacheLine);
    notes.push(GODOT_SHARED_CACHE_NOTE);
  }

  if (sharedNonGodot.length > 0) {
    notes.push(
      `Shared (read-mostly) directories — writes reach your working copy: ${sharedNonGodot.join(", ")}`
    );
  }
  if (privateDirs.filter((d) => !GODOT_CACHE_DIRS.includes(d) && d !== "target").length > 0) {
    const seeded = privateDirs.filter((d) => !GODOT_CACHE_DIRS.includes(d) && d !== "target");
    notes.push(
      `Private (live-state) directories — hardlink-seeded into this worktree: ${seeded.join(", ")}`
    );
  }

  // Runtime files: copy, never link. When the project supplies provision.files,
  // that list is authoritative; otherwise use the built-in PROVISION_COPY_FILES.
  const fileNames = Array.isArray(options.provisionFiles)
    ? options.provisionFiles.map((f) => String(f ?? "").trim()).filter(Boolean)
    : [...PROVISION_COPY_FILES];

  const copiedFiles = [];
  for (const name of fileNames) {
    const from = path.join(root, name);
    const to = path.join(wt, name);
    if (!existsSync(from)) {
      continue;
    }
    let stat;
    try {
      stat = statSync(from);
    } catch {
      notes.push(`skip file ${name}: cannot stat source`);
      continue;
    }
    if (typeof stat.isFile !== "function" || !stat.isFile()) {
      notes.push(`skip file ${name}: source is not a file`);
      continue;
    }
    links.push({ from, to, kind: "copy", name });
    copiedFiles.push(name);
  }
  if (copiedFiles.length > 0) {
    notes.push(`Runtime files copied into worktree (never linked): ${copiedFiles.join(", ")}`);
  }

  return {
    links,
    notes,
    godotCache: cacheMode,
    env: planEnv,
    sharedDirs,
    privateDirs,
    policy
  };
}

/**
 * The worktree-private scratch directory. Anything under it belongs to the run,
 * never to the project, which is why `.grok-build/` is in worktree.mjs's
 * GENERATED_ARTIFACT_PATTERNS: on win32 `git add` walks a junction (Windows
 * reports one as a directory), and the Blender sandbox below points a junction
 * at a directory that is ITSELF inside the worktree, so without the exclude a
 * commit would carry a second copy of the whole add-on.
 *
 * Note the trailing-less name: the project config file is `.grok-build.json`,
 * a sibling, and neither the exclude pathspec nor anything here touches it.
 */
export const WORKTREE_SCRATCH_DIR = ".grok-build";

/** Where a sandboxed Blender looks for add-ons, relative to the worktree. */
export const BLENDER_SANDBOX_SCRIPTS_RELATIVE = `${WORKTREE_SCRATCH_DIR}/blender/scripts`;
export const BLENDER_SANDBOX_EXTENSIONS_RELATIVE = `${WORKTREE_SCRATCH_DIR}/blender/extensions`;

/**
 * The one thing a user MUST know when they turn the sandbox on: with a private
 * scripts directory nothing is enabled for them, in either startup mode.
 */
export const BLENDER_SANDBOX_ENABLE_NOTE =
  "a sandboxed add-on is auto-enabled in neither startup mode - the test script must enable it AND check the return: `mod = addon_utils.enable(\"<module>\", default_set=False, persistent=True);` then `if mod is None: sys.exit(\"enable() returned None: register() raised, see traceback above\")`. addon_utils.enable swallows register() exceptions and returns None.";

/**
 * Bridge-owned Blender verify shim. Written under WORKTREE_SCRATCH_DIR so it is
 * never committed. Wraps user test scripts so a unittest suite that prints
 * FAILED without sys.exit(1) still fails verification, and performs a checked
 * addon_utils.enable for registration smoke.
 */
export const BLENDER_VERIFY_SHIM_SOURCE = `# grok-build Blender verify shim — do not edit; rewritten each run
import json
import runpy
import sys
import traceback
import unittest

def _emit_result(tests=0, failures=0, errors=0, skipped=0, extra=None):
    payload = {
        "tests": int(tests),
        "failures": int(failures),
        "errors": int(errors),
        "skipped": int(skipped),
    }
    if extra:
        payload.update(extra)
    print("GROK_BUILD_BLENDER_RESULT: " + json.dumps(payload, separators=(",", ":")))

def _enable_checked(module_name):
    import addon_utils
    mod = addon_utils.enable(module_name, default_set=False, persistent=True)
    if mod is None:
        _emit_result(errors=1, extra={"enable": module_name, "ok": False})
        sys.exit(
            "enable() returned None: register() raised or module missing, see traceback above"
        )
    return mod

def _run_unittest_path(target):
    # Discover/run via the user's script under runpy. Patch TextTestRunner.run so
    # a non-successful TestResult exits 1 even when the script forgets sys.exit.
    original_run = unittest.TextTestRunner.run

    def patched_run(self, test):
        result = original_run(self, test)
        failures = len(getattr(result, "failures", []) or [])
        errors = len(getattr(result, "errors", []) or [])
        tests_run = int(getattr(result, "testsRun", 0) or 0)
        skipped = len(getattr(result, "skipped", []) or [])
        _emit_result(tests=tests_run, failures=failures, errors=errors, skipped=skipped)
        if not result.wasSuccessful():
            sys.exit(1)
        return result

    unittest.TextTestRunner.run = patched_run
    try:
        runpy.run_path(target, run_name="__main__")
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        _emit_result(errors=1, extra={"script": target})
        sys.exit(1)

def main(argv):
    args = list(argv)
    if args and args[0] == "--":
        args = args[1:]
    if not args:
        print("grok_verify_shim: expected -- <script> or -- --enable <module>", file=sys.stderr)
        sys.exit(2)
    if args[0] == "--enable":
        if len(args) < 2 or not args[1].strip():
            print("grok_verify_shim: --enable requires a module name", file=sys.stderr)
            sys.exit(2)
        module_name = args[1].strip()
        _enable_checked(module_name)
        try:
            import addon_utils
            addon_utils.disable(module_name, default_set=False)
        except Exception:
            pass
        _emit_result(tests=1, failures=0, errors=0, extra={"enable": module_name, "ok": True})
        return
    target = args[0]
    _run_unittest_path(target)

if __name__ == "__main__":
    main(sys.argv[1:])
`;

/**
 * Ensure the Blender verify shim exists under cwd (worktree or main).
 *
 * @param {string} cwd
 * @param {{ mkdirSync?: typeof fs.mkdirSync, writeFileSync?: typeof fs.writeFileSync }} [io]
 * @returns {string} absolute path of the shim
 */
export function ensureBlenderVerifyShim(cwd, io = {}) {
  const mkdirSync = io.mkdirSync ?? fs.mkdirSync;
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const dir = path.join(path.resolve(String(cwd)), WORKTREE_SCRATCH_DIR, "blender");
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, "grok_verify_shim.py");
  writeFileSync(target, BLENDER_VERIFY_SHIM_SOURCE, "utf8");
  return target;
}

/**
 * Whether an isolated write run should auto-enable the Blender sandbox.
 *
 * Default ON for a detected add-on/extension under isolation: without it the
 * headless verify loads the add-on from the user's real scripts/addons symlink
 * and exercises pre-agent code. Still skip for bare `.blend` projects (no
 * module to link). `--no-blender-sandbox` is the escape hatch; `--blender-sandbox`
 * remains the explicit opt-in for older call paths.
 *
 * @param {{ id?: string, isAddon?: boolean, manifestPath?: string|null, addonInitPath?: string|null }|null|undefined} descriptor
 * @param {{ isolate?: boolean, write?: boolean, explicit?: boolean|null, noSandbox?: boolean }} [flags]
 */
export function shouldAutoBlenderSandbox(descriptor, flags = {}) {
  if (flags.noSandbox) {
    return false;
  }
  if (flags.explicit === true) {
    return true;
  }
  if (flags.explicit === false) {
    return false;
  }
  if (!flags.isolate || !flags.write) {
    return false;
  }
  if (!descriptor || descriptor.id !== "blender") {
    return false;
  }
  // Prefer the explicit isAddon flag; fall back to the path fields for older
  // descriptors serialised without it.
  if (descriptor.isAddon === false) {
    return false;
  }
  return Boolean(
    descriptor.isAddon || descriptor.manifestPath || descriptor.addonInitPath
  );
}

/**
 * Plan an in-worktree Blender add-on scripts directory.
 *
 * The standard Blender add-on workflow symlinks the per-user
 * `scripts/addons/<name>` at the developer's source checkout, so a headless
 * verify run inside an isolated worktree loads the add-on from their REAL
 * repository - it exercises pre-agent code, which is exactly the failure
 * isolation exists to prevent. Blender has no CLI flag for "use this add-on
 * directory"; the only lever is the BLENDER_USER_* environment, which is why
 * this returns an `env` rather than command arguments (see item 25's --env).
 *
 * Auto-enabled for isolated write runs on a detected add-on/extension
 * (`shouldAutoBlenderSandbox`). `--no-blender-sandbox` opts out; a failed link
 * still refuses to claim the sandbox env (see the bridge).
 *
 * Only BLENDER_USER_SCRIPTS and BLENDER_USER_EXTENSIONS are set.
 * BLENDER_USER_CONFIG is deliberately NOT set: Cycles' GPU device selection and
 * every add-on preference live in `userpref.blend` under that directory, so
 * pointing it at an empty sandbox silently forces CPU rendering and drops the
 * user's preferences.
 *
 * @param {string} worktreePath
 * @param {{
 *   platform?: string,
 *   repoRoot?: string,
 *   addonName?: string,
 *   existsSync?: typeof fs.existsSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   env?: NodeJS.ProcessEnv
 * }} [options]
 * @returns {{scriptsDir: string|null, extensionsDir: string|null, addonName: string|null, addonSource: string|null, links: Array<{from: string, to: string, kind: string}>, env: Record<string, string>, notes: string[]}}
 */
export function planBlenderScriptSandbox(worktreePath, options = {}) {
  const platform = options.platform ?? process.platform;
  const kind = platform === "win32" ? "junction" : "symlink";
  // The same injectable trio detectEcosystems wants. Detection is reused rather
  // than reimplemented so "what counts as a Blender add-on" has exactly one
  // definition (blender_manifest.toml, or an __init__.py whose first 4 KB
  // carries `bl_info =`), at the root or one directory down.
  const io = {
    existsSync: options.existsSync ?? fs.existsSync,
    readdirSync: options.readdirSync ?? fs.readdirSync,
    readFileSync: options.readFileSync ?? fs.readFileSync,
    env: options.env ?? process.env
  };

  const nothing = (note) => ({
    scriptsDir: null,
    extensionsDir: null,
    addonName: null,
    addonSource: null,
    links: [],
    env: {},
    notes: note ? [note] : []
  });

  if (!worktreePath) {
    return nothing("--blender-sandbox: a worktree path is required, so nothing was sandboxed.");
  }

  const wt = path.resolve(String(worktreePath));
  const descriptor = detectEcosystems(wt, io).find((entry) => entry.id === "blender");
  // `detectedBy: "blend-file"` is a Blender PROJECT (a .blend scene), not an
  // add-on. There is no module to link, and pointing BLENDER_USER_SCRIPTS at an
  // empty directory would only cost the user their other add-ons.
  const addonRelative = descriptor?.manifestPath ?? descriptor?.addonInitPath ?? null;
  if (!addonRelative) {
    return nothing(
      "--blender-sandbox: no add-on (blender_manifest.toml or a bl_info __init__.py) was found at the worktree root or one level down, so nothing was sandboxed."
    );
  }

  // detectEcosystems reports forward-slash relative paths; "." is the root.
  const addonDirRelative = path.posix.dirname(addonRelative);
  const atRoot = addonDirRelative === "." || addonDirRelative === "";
  const addonSource = atRoot ? wt : path.join(wt, ...addonDirRelative.split("/"));
  // Blender imports an add-on under its DIRECTORY name, so the link has to keep
  // it. A repo whose root is itself the add-on has no such directory inside the
  // worktree - and the worktree's own basename is a run id, not a module name -
  // so the repository name is used, which is what the developer's own manual
  // symlink into scripts/addons would have been called.
  const addonName =
    options.addonName ??
    (atRoot ? path.basename(path.resolve(String(options.repoRoot ?? wt))) : addonDirRelative);

  const scriptsDir = path.join(wt, ...BLENDER_SANDBOX_SCRIPTS_RELATIVE.split("/"));
  const extensionsDir = path.join(wt, ...BLENDER_SANDBOX_EXTENSIONS_RELATIVE.split("/"));

  return {
    scriptsDir,
    extensionsDir,
    addonName,
    addonSource,
    links: [{ from: addonSource, to: path.join(scriptsDir, "addons", addonName), kind }],
    env: {
      BLENDER_USER_SCRIPTS: scriptsDir,
      // Pointed at a sandbox directory that is never created. An absent
      // extensions directory is how "this run sees none of your installed
      // extensions" is expressed; Blender creates its user directories on
      // demand and needs no help here.
      BLENDER_USER_EXTENSIONS: extensionsDir
    },
    notes: [
      `--blender-sandbox: ${addonName} is linked into ${BLENDER_SANDBOX_SCRIPTS_RELATIVE}/addons and BLENDER_USER_SCRIPTS points there, so this run sees only this add-on (your Blender preferences are untouched).`,
      BLENDER_SANDBOX_ENABLE_NOTE
    ]
  };
}

/**
 * Recursive copy with every fs call injectable.
 *
 * Deliberately NOT `fs.cpSync`: package.json pins node>=18.18.0, where cpSync
 * is still experimental and prints an ExperimentalWarning to stderr - which
 * would be captured into the tracked job's stderr and shown to the user as if
 * the run had gone wrong.
 */
function copyPathSync(from, to, io) {
  let stat;
  try {
    stat = io.statSync(from);
  } catch {
    // Caller reports it; a missing source is not exceptional here.
    return;
  }

  if (!stat.isDirectory()) {
    io.mkdirSync(path.dirname(to), { recursive: true });
    io.copyFileSync(from, to);
    return;
  }

  io.mkdirSync(to, { recursive: true });
  // Plain names, not Dirents: every fs call here is injectable, and a test
  // double returning `["a.bin"]` is a far smaller thing to fake than a Dirent.
  for (const name of io.readdirSync(from)) {
    copyPathSync(path.join(from, name), path.join(to, name), io);
  }
}

/**
 * Seed `to` from `from` using hardlinks when both paths are on the same volume,
 * falling back to ordinary copy on EXDEV / cross-volume / link failure.
 *
 * Never silent: returns a mode string the caller can put in notes.
 *
 * @returns {{ mode: "hardlink"|"copy"|"empty"|"failed", detail?: string }}
 */
export function hardlinkSeedPathSync(from, to, options = {}) {
  const platform = options.platform ?? process.platform;
  const io = {
    statSync: options.statSync ?? fs.statSync,
    readdirSync: options.readdirSync ?? fs.readdirSync,
    copyFileSync: options.copyFileSync ?? fs.copyFileSync,
    mkdirSync: options.mkdirSync ?? fs.mkdirSync,
    linkSync: options.linkSync ?? fs.linkSync,
    existsSync: options.existsSync ?? fs.existsSync
  };

  let stat;
  try {
    stat = io.statSync(from);
  } catch (error) {
    return {
      mode: "failed",
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  const preferHardlink =
    options.forceCopy === true
      ? false
      : sameVolume(from, path.dirname(to), { platform, statSync: io.statSync }) ||
        sameVolume(from, to, { platform, statSync: io.statSync });

  if (!stat.isDirectory()) {
    io.mkdirSync(path.dirname(to), { recursive: true });
    if (preferHardlink) {
      try {
        io.linkSync(from, to);
        return { mode: "hardlink" };
      } catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        // EXDEV = cross-device; EPERM/EACCES often mean the FS disallows hardlinks.
        // Fall through to copy and report.
        try {
          io.copyFileSync(from, to);
          return {
            mode: "copy",
            detail:
              code === "EXDEV"
                ? "cross-volume hardlink failed (EXDEV); copied instead"
                : `hardlink failed (${code ?? (error instanceof Error ? error.message : String(error))}); copied instead`
          };
        } catch (copyError) {
          return {
            mode: "failed",
            detail: copyError instanceof Error ? copyError.message : String(copyError)
          };
        }
      }
    }
    try {
      io.copyFileSync(from, to);
      return {
        mode: "copy",
        detail: preferHardlink ? undefined : "cross-volume or hardlink unavailable; copied"
      };
    } catch (copyError) {
      return {
        mode: "failed",
        detail: copyError instanceof Error ? copyError.message : String(copyError)
      };
    }
  }

  // Directory: create root, recurse.
  try {
    io.mkdirSync(to, { recursive: true });
  } catch (error) {
    return {
      mode: "failed",
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  let names;
  try {
    names = io.readdirSync(from);
  } catch (error) {
    return {
      mode: "failed",
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  let usedHardlink = false;
  let usedCopy = false;
  let lastDetail;

  for (const name of names) {
    const child = hardlinkSeedPathSync(path.join(from, name), path.join(to, name), {
      ...options,
      forceCopy: !preferHardlink
    });
    if (child.mode === "hardlink") {
      usedHardlink = true;
    } else if (child.mode === "copy") {
      usedCopy = true;
      if (child.detail) {
        lastDetail = child.detail;
      }
    } else if (child.mode === "failed") {
      return child;
    }
  }

  if (usedHardlink && !usedCopy) {
    return { mode: "hardlink" };
  }
  if (usedCopy || usedHardlink) {
    return { mode: usedHardlink ? "hardlink" : "copy", detail: lastDetail };
  }
  // Empty source directory.
  return { mode: "hardlink" };
}

export function provisionWorktree(plan, options = {}) {
  const symlinkSync = options.symlinkSync ?? fs.symlinkSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const linkSync = options.linkSync ?? fs.linkSync;
  const platform = options.platform ?? process.platform;
  const copyIo = {
    statSync: options.statSync ?? fs.statSync,
    readdirSync: options.readdirSync ?? fs.readdirSync,
    copyFileSync: options.copyFileSync ?? fs.copyFileSync,
    mkdirSync,
    linkSync,
    existsSync
  };

  const provisioned = [];
  const failed = [];
  const notes = Array.isArray(plan?.notes) ? [...plan.notes] : [];

  const links = Array.isArray(plan?.links) ? plan.links : [];

  for (const link of links) {
    if (!link.from || !link.to) {
      failed.push({ ...link, reason: "missing from/to" });
      continue;
    }

    if (link.kind === "mkdir") {
      try {
        mkdirSync(link.to, { recursive: true });
        provisioned.push({ from: link.from, to: link.to, kind: "mkdir", name: link.name });
      } catch (error) {
        failed.push({
          from: link.from,
          to: link.to,
          kind: link.kind,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
      continue;
    }

    if (!existsSync(link.from)) {
      failed.push({ from: link.from, to: link.to, kind: link.kind, reason: "source missing" });
      continue;
    }

    if (existsSync(link.to)) {
      failed.push({ from: link.from, to: link.to, kind: link.kind, reason: "destination already exists" });
      continue;
    }

    try {
      // Inside the try: a throwing mkdirSync would otherwise propagate and fail the
      // whole run. Provisioning is an optimisation — a failed link must cost a
      // slower verify, never a failed run.
      mkdirSync(path.dirname(link.to), { recursive: true });

      if (link.kind === "junction") {
        symlinkSync(link.from, link.to, "junction");
        provisioned.push({ from: link.from, to: link.to, kind: link.kind, name: link.name });
      } else if (link.kind === "symlink") {
        symlinkSync(link.from, link.to, "dir");
        provisioned.push({ from: link.from, to: link.to, kind: link.kind, name: link.name });
      } else if (link.kind === "copy") {
        // A copied entry is a private, cold cache / runtime file: nothing the
        // run writes into it reaches the user's working copy.
        copyPathSync(link.from, link.to, copyIo);
        provisioned.push({ from: link.from, to: link.to, kind: link.kind, name: link.name });
      } else if (link.kind === "hardlink-seed") {
        const seed = hardlinkSeedPathSync(link.from, link.to, {
          platform,
          ...copyIo
        });
        if (seed.mode === "failed") {
          // Never silently degrade: empty dir + loud note so the run header
          // shows the seed failed and cold-install is expected.
          try {
            mkdirSync(link.to, { recursive: true });
          } catch {
            // ignore
          }
          const label = link.name || path.basename(link.to);
          notes.push(
            `Seed FAILED for ${label}: ${seed.detail ?? "unknown error"}; worktree has an empty private directory (cold install expected)`
          );
          failed.push({
            from: link.from,
            to: link.to,
            kind: link.kind,
            reason: seed.detail ?? "seed failed"
          });
          continue;
        }
        if (seed.mode === "copy" && seed.detail) {
          notes.push(`Seed for ${link.name || path.basename(link.to)}: ${seed.detail}`);
        }
        provisioned.push({
          from: link.from,
          to: link.to,
          kind: seed.mode === "hardlink" ? "hardlink-seed" : "copy",
          name: link.name,
          seedMode: seed.mode
        });
      } else {
        failed.push({ ...link, reason: `unknown kind: ${link.kind}` });
        continue;
      }
    } catch (error) {
      failed.push({ from: link.from, to: link.to, kind: link.kind, reason: error.message });
    }
  }

  // Never warn about a shared cache that is not actually shared. The commonest
  // reason the link fails is that `.godot` is tracked in git, so `git worktree
  // add` already checked a copy of it out - in which case the worktree has its
  // own directory and "close the Godot editor" would be a lie.
  const godotLinked = provisioned.some((entry) =>
    GODOT_CACHE_DIRS.includes(path.basename(entry.to))
  );

  return {
    provisioned,
    failed,
    notes: godotLinked ? notes : notes.filter((note) => note !== GODOT_SHARED_CACHE_NOTE),
    env: plan?.env && typeof plan.env === "object" ? { ...plan.env } : {},
    sharedDirs: Array.isArray(plan?.sharedDirs) ? [...plan.sharedDirs] : [],
    privateDirs: Array.isArray(plan?.privateDirs) ? [...plan.privateDirs] : []
  };
}

// Runtime capability packs shipped with the plugin and injected into an
// isolated worktree so the agent (not just the bridge) knows Godot/Blender
// facts that otherwise only live in this repo's comments.
//
// Hyper discovers project plugins under .grok/plugins/<name>/ (see
// xai-grok-agent plugins/discovery.rs). Layout is a normal project plugin:
// plugin.json + skills/ (+ agents/ when needed). Never create .mcp.json
// here — nested-delegation owns that file.
//
// Line comments on purpose: a block comment cannot mention the path pattern
// ".grok/plugins/*/" because the "/*" sequence would close the comment early.
export const RUNTIME_PLUGIN_DIRNAME = "grok-build-runtime";
export const RUNTIME_PLUGIN_RELATIVE = ".grok/plugins/" + RUNTIME_PLUGIN_DIRNAME;

/** Map ecosystem id → skill directory names under runtime-plugin/skills/. */
export const RUNTIME_SKILL_PACKS = Object.freeze({
  godot: Object.freeze(["godot-engine"]),
  blender: Object.freeze(["blender-addon"]),
  python: Object.freeze(["python-django"]),
  node: Object.freeze(["node-workspace"]),
  rust: Object.freeze(["rust-cargo"])
});

/**
 * Absolute path of the shipped runtime-plugin templates.
 *
 * @param {{ pluginRoot?: string }} [options]
 */
export function resolveRuntimePluginSource(options = {}) {
  if (options.pluginRoot) {
    return path.join(options.pluginRoot, "runtime-plugin");
  }
  // provision.mjs lives at plugins/grok-build/scripts/lib/ — two levels up is
  // the plugin root. Tests inject pluginRoot / sourceDir rather than relying
  // on this default.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime-plugin");
}

function runtimeInjectionEnabled(env) {
  const raw = env?.[INJECT_RUNTIME_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return true;
  }
  const normalized = String(raw).trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "no");
}

/**
 * Copy (never link) the ecosystem-relevant runtime skills into the worktree.
 *
 * Linking would make agent edits to the injected skill write back into the
 * plugin install; copy keeps the pack a pure run artefact, and `.grok/` is
 * excluded from the commit (worktree.mjs GENERATED_ARTIFACT_PATTERNS) so it
 * never becomes the user's work.
 *
 * @param {string} worktreePath
 * @param {string[]|string|null} ecosystemIds
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   pluginRoot?: string,
 *   sourceDir?: string,
 *   existsSync?: typeof fs.existsSync,
 *   mkdirSync?: typeof fs.mkdirSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   statSync?: typeof fs.statSync,
 *   copyFileSync?: typeof fs.copyFileSync,
 *   writeFileSync?: typeof fs.writeFileSync,
 *   readFileSync?: typeof fs.readFileSync
 * }} [options]
 * @returns {{ injected: boolean, packs: string[], target: string|null, notes: string[] }}
 */
export function injectRuntimePlugin(worktreePath, ecosystemIds, options = {}) {
  const env = options.env ?? process.env;
  const notes = [];

  if (!runtimeInjectionEnabled(env)) {
    return {
      injected: false,
      packs: [],
      target: null,
      notes: [`Runtime plugin: disabled (${INJECT_RUNTIME_ENV}=0)`]
    };
  }

  if (!worktreePath) {
    return { injected: false, packs: [], target: null, notes: ["Runtime plugin: no worktree"] };
  }

  const ids = (Array.isArray(ecosystemIds) ? ecosystemIds : [ecosystemIds])
    .map((id) => String(id ?? "").trim().toLowerCase())
    .filter(Boolean);
  const packs = [];
  for (const id of ids) {
    for (const pack of RUNTIME_SKILL_PACKS[id] ?? []) {
      if (!packs.includes(pack)) {
        packs.push(pack);
      }
    }
  }
  // Always include a tiny core skill so the agent knows the pack exists even
  // when detection returned nothing useful.
  if (!packs.includes("runtime-core")) {
    packs.unshift("runtime-core");
  }

  const existsSync = options.existsSync ?? fs.existsSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const statSync = options.statSync ?? fs.statSync;
  const copyFileSync = options.copyFileSync ?? fs.copyFileSync;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;

  const source = path.resolve(
    options.sourceDir ?? resolveRuntimePluginSource({ pluginRoot: options.pluginRoot })
  );

  if (!existsSync(source)) {
    notes.push(`Runtime plugin: source missing at ${source}`);
    return { injected: false, packs, target: null, notes };
  }

  const target = path.join(path.resolve(String(worktreePath)), ...RUNTIME_PLUGIN_RELATIVE.split("/"));
  const io = { existsSync, mkdirSync, readdirSync, statSync, copyFileSync };

  try {
    mkdirSync(target, { recursive: true });
    // Manifest first so discovery sees a complete plugin even if a later skill
    // copy fails mid-way.
    const manifestSrc = path.join(source, "plugin.json");
    if (existsSync(manifestSrc)) {
      copyFileSync(manifestSrc, path.join(target, "plugin.json"));
    } else {
      writeFileSync(
        path.join(target, "plugin.json"),
        JSON.stringify(
          {
            name: RUNTIME_PLUGIN_DIRNAME,
            version: "0.1.0",
            description: "Per-run ecosystem capability pack injected by grok-build."
          },
          null,
          2
        ),
        "utf8"
      );
    }

    const skillsSrc = path.join(source, "skills");
    const skillsDst = path.join(target, "skills");
    mkdirSync(skillsDst, { recursive: true });

    for (const pack of packs) {
      const from = path.join(skillsSrc, pack);
      if (!existsSync(from)) {
        notes.push(`Runtime plugin: pack "${pack}" not found in source, skipped`);
        continue;
      }
      copyPathSync(from, path.join(skillsDst, pack), io);
    }

    // agents/ is optional; copy whole tree when present.
    const agentsSrc = path.join(source, "agents");
    if (existsSync(agentsSrc)) {
      copyPathSync(agentsSrc, path.join(target, "agents"), io);
    }

    // tools/ holds engine helper scripts (e.g. Godot grok_check.gd). Always
    // copy when present so verify commands that reference
    // res://.grok/plugins/grok-build-runtime/tools/... resolve after inject.
    const toolsSrc = path.join(source, "tools");
    if (existsSync(toolsSrc)) {
      copyPathSync(toolsSrc, path.join(target, "tools"), io);
    }
  } catch (error) {
    notes.push(
      `Runtime plugin: injection failed (${error instanceof Error ? error.message : String(error)})`
    );
    return { injected: false, packs, target: null, notes };
  }

  notes.push(`Runtime plugin: injected capability pack(s) [${packs.join(", ")}] into ${RUNTIME_PLUGIN_RELATIVE}`);
  // Silence unused readFileSync when no future caller needs it; kept in the
  // options surface for symmetry with other injectable helpers.
  void readFileSync;
  return { injected: true, packs, target, notes };
}
