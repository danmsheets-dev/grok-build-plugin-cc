import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { detectEcosystems } from "./ecosystem.mjs";

// Heavyweight directories linked from the source repo into a fresh worktree
// so the first verify command does not fail for lack of dependencies. Covers
// the five target ecosystems: Godot's import cache (.godot for Godot 4,
// .import for Godot 3 - without this, a fresh worktree re-imports every
// asset from scratch on the first headless run), Rust (target), Python
// (.venv/venv, plus .tox for tox environments and __pypackages__ for PDM),
// JS/web (node_modules, plus framework build caches that speed up or are
// required for a working dev/build command), and generic vendor dirs.
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
 * Godot's asset import caches, the two entries in PROVISION_LINK_DIRS that are
 * LIVE STATE rather than read-mostly dependencies: an editor open on the user's
 * working copy writes into them while a headless verify run reads through the
 * junction.
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

function godotCacheIsCopied(options, env) {
  return resolveGodotCacheMode(options, env).private;
}

export function planWorktreeLinks(repoRoot, worktreePath, options = {}) {
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;
  const statSync = options.statSync ?? fs.statSync;
  // The sole production caller passes no options at all, so the default has to
  // be the real environment rather than an empty object.
  const env = options.env ?? process.env;
  const kind = platform === "win32" ? "junction" : "symlink";
  const cacheMode = resolveGodotCacheMode(options, env);
  const copyGodotCache = cacheMode.private;

  const root = path.resolve(String(repoRoot ?? ""));
  const wt = path.resolve(String(worktreePath ?? ""));

  const links = [];
  const notes = [];

  if (!repoRoot || !worktreePath) {
    notes.push("planWorktreeLinks: repoRoot and worktreePath are required");
    return { links, notes, godotCache: cacheMode };
  }

  let linkedGodotCache = false;
  let sawGodotCacheSource = false;

  for (const name of PROVISION_LINK_DIRS) {
    const from = path.join(root, name);
    const to = path.join(wt, name);

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

    if (copyGodotCache && GODOT_CACHE_DIRS.includes(name)) {
      // No entry in `links` for the directory itself. A `kind` provisionWorktree
      // does not recognise lands in its `unknown kind:` failure branch and would
      // be reported as a provisioning FAILURE, so a deliberate skip has to be
      // absent from links entirely and explained in notes instead.
      continue;
    }

    links.push({ from, to, kind });
    if (GODOT_CACHE_DIRS.includes(name)) {
      linkedGodotCache = true;
    }
  }

  if (copyGodotCache && sawGodotCacheSource) {
    const copied = [];
    for (const relativePath of PROVISION_COPY_PATHS) {
      const segments = relativePath.split("/");
      const from = path.join(root, ...segments);
      const to = path.join(wt, ...segments);
      if (!existsSync(from)) {
        continue;
      }
      links.push({ from, to, kind: "copy" });
      copied.push(relativePath);
    }
    // Visible, single-line choice. The cold-import warning is part of the same
    // sentence so wall-clock on the first verify is explained up front.
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

  return { links, notes, godotCache: cacheMode };
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
  "a sandboxed add-on is auto-enabled in neither startup mode - the test script must call addon_utils.enable(\"<module>\", default_set=False, persistent=True).";

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

export function provisionWorktree(plan, options = {}) {
  const symlinkSync = options.symlinkSync ?? fs.symlinkSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const copyIo = {
    statSync: options.statSync ?? fs.statSync,
    readdirSync: options.readdirSync ?? fs.readdirSync,
    copyFileSync: options.copyFileSync ?? fs.copyFileSync,
    mkdirSync
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
      } else if (link.kind === "symlink") {
        symlinkSync(link.from, link.to, "dir");
      } else if (link.kind === "copy") {
        // A copied entry is a private, cold cache: nothing the run writes into
        // it reaches the user's working copy, which is the entire point of the
        // opt-out.
        copyPathSync(link.from, link.to, copyIo);
      } else {
        failed.push({ ...link, reason: `unknown kind: ${link.kind}` });
        continue;
      }
      provisioned.push({ from: link.from, to: link.to, kind: link.kind });
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
    notes: godotLinked ? notes : notes.filter((note) => note !== GODOT_SHARED_CACHE_NOTE)
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