import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Project-ecosystem detection.
 *
 * Pure and fs-injectable on purpose: this runs on the hot path of every task
 * (the bridge resolves a verify plan from it before the agent is even spawned)
 * and it must never spawn a process, never touch the network, and never throw.
 * A detection failure has to degrade to "no ecosystem", which callers already
 * treat as "behave exactly as 0.3.x did".
 *
 * Detection reads the repository root and exactly one directory below it for
 * every ecosystem (Godot, Blender, Python/Django, Node, Rust). Deeper nesting
 * is deliberately out of scope: an unbounded walk over node_modules/ or
 * .godot/ is thousands of stat calls for a guess. Each descriptor records
 * `projectDir` (repo-relative posix, `"."` at root) so verify commands and
 * provision can root themselves at the right place.
 *
 * A repository can be more than one ecosystem. `detectEcosystems` returns all
 * of them in `ECOSYSTEM_PRIORITY` order; `defaultVerifyPlan` unions their
 * verify commands so a Django + React monorepo exercises both stacks.
 */

/** Directory names never descended into. */
const SKIP_DIRS = new Set([
  // Caches and vendored trees. These are the directories that make a walk
  // expensive, and a *.blend or __init__.py inside one of them belongs to a
  // dependency or an import cache, not to the project being detected.
  "node_modules",
  "vendor",
  "target",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out"
]);

const GODOT_PROJECT_FILE = "project.godot";
const BLENDER_MANIFEST_FILE = "blender_manifest.toml";

// Blender add-ons are identified by a `bl_info = {...}` dict at module scope.
// Only the head of the file is inspected so that a large generated __init__.py
// cannot turn detection into a parse.
const BL_INFO_HEAD_BYTES = 4096;
const BL_INFO_PATTERN = /^\s*bl_info\s*=/m;

// Godot writes exactly one `config_version=<int>` line near the top of
// project.godot. Anchored to a line start so a value that merely contains the
// string cannot match.
const GODOT_CONFIG_VERSION_PATTERN = /^\s*config_version\s*=\s*(\d+)\s*$/m;

// Godot 4 writes PackedStringArray, Godot 3 wrote PoolStringArray. The first
// entry is the editor version that last wrote the file ("4.3", "3.5").
const GODOT_FEATURES_PATTERN =
  /^\s*config\/features\s*=\s*(?:Packed|Pool)StringArray\s*\(([^)]*)\)/m;

const VERIFY_TARGET_NAMES = Object.freeze(["test", "check", "verify", "ci"]);
const VERIFY_SCRIPT_NAMES = Object.freeze(["test", "check", "verify"]);

function relativeEntryPath(projectDir, name) {
  return projectDir && projectDir !== "." ? `${projectDir}/${name}` : name;
}

function parseNamedTarget(text, names) {
  const wanted = new Set(names);
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/^\s+/, "");
    if (!line || line.startsWith("#") || line.startsWith(".")) {
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(?:[^=].*)?$/.exec(line);
    if (match && wanted.has(match[1])) {
      return match[1];
    }
  }
  return null;
}

/**
 * Prefer a repository-owned test entry point over a guessed framework command.
 * This is deliberately fs-only: the returned command is later run by the
 * bridge, but detection itself must never execute a cloned repository.
 */
function detectRepositoryVerifyEntryPoint(projectAbs, projectDir, io, packageInfo = null) {
  if (exists(io, path.join(projectAbs, "run_tests.ps1"))) {
    return { kind: "run_tests.ps1", path: relativeEntryPath(projectDir, "run_tests.ps1") };
  }

  if (exists(io, path.join(projectAbs, "Makefile"))) {
    const target = parseNamedTarget(
      readText(io, path.join(projectAbs, "Makefile")),
      VERIFY_TARGET_NAMES
    );
    if (target) {
      return { kind: "make", target };
    }
  }

  if (packageInfo?.scripts) {
    for (const name of VERIFY_SCRIPT_NAMES) {
      const value = packageInfo.scripts[name];
      if (typeof value === "string" && value.trim() && !/no test specified/i.test(value)) {
        return { kind: "npm-script", name };
      }
    }
  }

  if (exists(io, path.join(projectAbs, "justfile"))) {
    const target = parseNamedTarget(
      readText(io, path.join(projectAbs, "justfile")),
      VERIFY_TARGET_NAMES
    );
    if (target) {
      return { kind: "just", target };
    }
  }

  if (exists(io, path.join(projectAbs, "tox.ini"))) {
    return { kind: "tox.ini", path: relativeEntryPath(projectDir, "tox.ini") };
  }

  return null;
}

function verifyEntryPointCommand(entryPoint, descriptor, options = {}) {
  if (!entryPoint) {
    return null;
  }
  const projectDir = descriptor?.projectDir && descriptor.projectDir !== "."
    ? descriptor.projectDir
    : ".";
  const platform = options.platform ?? process.platform;
  switch (entryPoint.kind) {
    case "run_tests.ps1":
      return `${platform === "win32" ? "powershell" : "pwsh"} -NoProfile -ExecutionPolicy Bypass -File ${quoteCommandPath(entryPoint.path)}`;
    case "make":
      return `make ${entryPoint.target}`;
    case "just":
      return `just ${entryPoint.target}`;
    case "tox.ini":
      return projectDir === "." ? "tox" : `tox -c ${quoteCommandPath(entryPoint.path)}`;
    case "npm-script": {
      const pm = descriptor?.packageManager || "npm";
      const prefix = nodePrefixFlag(pm, projectDir);
      if (entryPoint.name === "test") {
        return prefix ? `${pm} ${prefix} test` : `${pm} test`;
      }
      return prefix
        ? `${pm} ${prefix} run ${entryPoint.name}`
        : `${pm} run ${entryPoint.name}`;
    }
    default:
      return null;
  }
}

/**
 * Order used by `detectPrimaryEcosystem`.
 *
 * The engine ecosystems come first because a Godot or Blender project
 * routinely also carries a package.json (tooling) or a pyproject.toml (a
 * Blender add-on *is* Python) - the engine is what a verify command has to
 * drive. The generic ones are then ordered most-specific-marker-first:
 * Cargo.toml only ever means Rust, pyproject.toml/setup.py only ever mean
 * Python, while package.json is the marker most likely to be present in a repo
 * whose real build is something else entirely.
 */
export const ECOSYSTEM_PRIORITY = Object.freeze(["godot", "blender", "rust", "python", "node"]);

/**
 * Env vars consulted for each engine binary, in precedence order. The
 * plugin-specific GROK_BUILD_* name wins over the generic one so that a user
 * who sets it for this plugin is not overridden by whatever another tool
 * exported globally.
 */
const BINARY_ENV_VARS = Object.freeze({
  godot: Object.freeze(["GROK_BUILD_GODOT_BIN", "GODOT_BIN"]),
  blender: Object.freeze(["GROK_BUILD_BLENDER_BIN", "BLENDER_BIN"])
});

const DEFAULT_BINARY_NAMES = Object.freeze({
  godot: "godot",
  blender: "blender"
});

function exists(io, target) {
  try {
    return Boolean(io.existsSync(target));
  } catch {
    return false;
  }
}

function readText(io, target) {
  try {
    const raw = io.readFileSync(target, "utf8");
    return typeof raw === "string" ? raw : String(raw);
  } catch {
    return null;
  }
}

/**
 * Directory entries as `{ name, directory }`. A caller-injected readdirSync
 * that ignores `withFileTypes` and returns plain strings still works - such an
 * entry is treated as a file, which is the safe direction (it can never make
 * detection descend somewhere it should not).
 */
function readEntries(io, dir) {
  let entries;
  try {
    entries = io.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) =>
    typeof entry === "string"
      ? { name: entry, directory: false }
      : {
          name: String(entry?.name ?? ""),
          directory: typeof entry?.isDirectory === "function" ? entry.isDirectory() : false
        }
  );
}

/** Repo-relative paths are emitted with forward slashes: they end up inside
 * command strings, where every toolchain here (Godot, Blender, git) accepts
 * them on Windows too, and a backslash would need escaping through cmd.exe. */
function relPosix(...parts) {
  return parts.filter(Boolean).join("/");
}

function childDirs(root, io) {
  const dirs = [];
  for (const entry of readEntries(io, root)) {
    if (!entry.directory) {
      continue;
    }
    // Dot-directories (.git, .github, .godot, .venv) are tooling or caches;
    // no project marker that matters lives one level inside one of them.
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {
      continue;
    }
    dirs.push({ dir: path.join(root, entry.name), rel: entry.name });
  }
  return dirs;
}

function parseGodotConfigVersion(text) {
  const match = GODOT_CONFIG_VERSION_PATTERN.exec(text ?? "");
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) ? value : null;
}

/**
 * config_version -> engine major.
 *
 *   5 (or anything newer) -> 4    a future editor bumping the number is far
 *                                 likelier to keep Godot 4's CLI surface than
 *                                 to revert to Godot 3's, so forward values
 *                                 resolve to 4 rather than to null.
 *   4                     -> 3    Godot 3.1 - 3.5
 *   3                     -> 3    Godot 3.0
 *   anything lower        -> null Godot 2.x era; its CLI is not modelled here.
 */
function godotMajorFromConfigVersion(configVersion) {
  if (!Number.isInteger(configVersion)) {
    return null;
  }
  if (configVersion >= 5) {
    return 4;
  }
  if (configVersion >= 3) {
    return 3;
  }
  return null;
}

/**
 * `config/features` carries the editor version string. config_version cannot
 * distinguish 4.0 from 4.4 - it is 5 for all of them - and the GUT / gdUnit4
 * argument shapes do differ across those releases, so the minor is worth
 * keeping even though nothing branches on it yet.
 */
function parseGodotFeatures(text) {
  const match = GODOT_FEATURES_PATTERN.exec(text ?? "");
  if (!match) {
    return { features: [], minor: null };
  }
  const features = [];
  const quoted = /"([^"]*)"/g;
  let entry;
  while ((entry = quoted.exec(match[1])) !== null) {
    features.push(entry[1]);
  }
  let minor = null;
  for (const value of features) {
    const version = /^(\d+)\.(\d+)/.exec(value);
    if (version) {
      minor = Number.parseInt(version[2], 10);
      break;
    }
  }
  return { features, minor: Number.isInteger(minor) ? minor : null };
}

/**
 * First named export preset in export_presets.cfg, with its platform when set.
 *
 * Credentials live in the sibling export_credentials.cfg (never committed,
 * never read here). Platform drives the binary extension for export-smoke:
 * a Windows Desktop preset that writes `.zip` always produces nothing useful.
 *
 * @returns {{ name: string, platform: string|null }|null}
 */
function parseFirstExportPreset(text) {
  const raw = String(text ?? "");
  // Prefer the first [preset.N] block so a later preset cannot steal the name.
  const block = /\[preset\.\d+\]([\s\S]*?)(?=\n\[preset\.\d+\]|\n\[|$)/.exec(raw);
  const scope = block ? block[1] : raw;
  const nameMatch = /^\s*name\s*=\s*"([^"]+)"/m.exec(scope);
  if (!nameMatch) {
    // Fall back to the historical first-name-anywhere behaviour when blocks
    // are missing or malformed.
    const loose = /^\s*name\s*=\s*"([^"]+)"/m.exec(raw);
    return loose ? { name: loose[1], platform: null } : null;
  }
  const platformMatch = /^\s*platform\s*=\s*"([^"]+)"/m.exec(scope);
  return {
    name: nameMatch[1],
    platform: platformMatch ? platformMatch[1] : null
  };
}

/** @deprecated use parseFirstExportPreset; kept for any external caller tests */
function parseFirstExportPresetName(text) {
  return parseFirstExportPreset(text)?.name ?? null;
}

/**
 * Binary extension for a Godot export preset platform string.
 * Default `.zip` only for Web/macOS-style pack outputs.
 */
export function exportSmokeExtensionForPlatform(platform) {
  const p = String(platform ?? "").trim().toLowerCase();
  if (!p) {
    return ".zip";
  }
  if (p.includes("windows")) {
    return ".exe";
  }
  if (p.includes("linux") || p.includes("x11") || p.includes("bsd")) {
    return ".x86_64";
  }
  if (p.includes("mac") || p.includes("osx") || p === "macos") {
    return ".zip";
  }
  if (p.includes("web") || p.includes("html")) {
    return ".html";
  }
  if (p.includes("android")) {
    return ".apk";
  }
  if (p.includes("ios")) {
    return ".ipa";
  }
  return ".zip";
}

/**
 * Locate a marker at the repo root or exactly one directory below it.
 * Returns `{ abs, projectDir }` where projectDir is repo-relative posix (`"."`
 * at root), or null when the marker is absent.
 */
function findMarkerAtDepth1(root, io, markerName) {
  const atRoot = path.join(root, markerName);
  if (exists(io, atRoot)) {
    return { abs: atRoot, projectDir: ".", projectAbs: root };
  }
  for (const child of childDirs(root, io)) {
    const candidate = path.join(child.dir, markerName);
    if (exists(io, candidate)) {
      return { abs: candidate, projectDir: child.rel, projectAbs: child.dir };
    }
  }
  return null;
}

/**
 * First marker name present at root or depth 1. Prefer root when any marker
 * lives there so a monorepo root with its own pyproject is not shadowed by a
 * nested package.
 */
function findAnyMarkerAtDepth1(root, io, markerNames) {
  for (const marker of markerNames) {
    if (exists(io, path.join(root, marker))) {
      return { marker, projectDir: ".", projectAbs: root };
    }
  }
  for (const child of childDirs(root, io)) {
    for (const marker of markerNames) {
      if (exists(io, path.join(child.dir, marker))) {
        return { marker, projectDir: child.rel, projectAbs: child.dir };
      }
    }
  }
  return null;
}

function detectGodot(root, io) {
  // project.godot is the only marker that means "this is a Godot project". A
  // bare .godot/ or .import/ directory must NOT imply Godot: both are caches
  // that outlive the project that produced them (a moved or deleted project
  // leaves them behind), and both are already linked/excluded unconditionally
  // by provision.mjs / worktree.mjs, which is where they belong.
  const hit = findMarkerAtDepth1(root, io, GODOT_PROJECT_FILE);
  if (!hit) {
    return null;
  }

  const projectAbs = hit.projectAbs;
  const projectDir = hit.projectDir;
  const text = readText(io, hit.abs) ?? "";
  const configVersion = parseGodotConfigVersion(text);
  const major = godotMajorFromConfigVersion(configVersion);
  const { features, minor } = parseGodotFeatures(text);

  const hasGut = exists(io, path.join(projectAbs, "addons", "gut", "gut_cmdln.gd"));
  const hasGdUnit4 = exists(io, path.join(projectAbs, "addons", "gdUnit4"));

  // First existing conventional test directory. gdUnit4's CLI runner takes an
  // explicit -a <dir> and errors out when it is missing, so a default verify
  // command for it is only emitted when there is somewhere to point it.
  let testDir = null;
  for (const candidate of ["test", "tests"]) {
    if (exists(io, path.join(projectAbs, candidate))) {
      testDir = candidate;
      break;
    }
  }

  // export_presets.cfg is normal tracked source; export_credentials.cfg is the
  // machine-local sibling that must never be read or staged. Presence of the
  // presets file only enables an OPT-IN smoke export (see exportSmoke option
  // on defaultVerifyCommands) — never an automatic one, because a headless
  // export needs a configured template and can take minutes.
  const exportPresetsPath = path.join(projectAbs, "export_presets.cfg");
  const hasExportPresets = exists(io, exportPresetsPath);
  const exportPreset = hasExportPresets
    ? parseFirstExportPreset(readText(io, exportPresetsPath) ?? "")
    : null;
  const exportPresetName = exportPreset?.name ?? null;
  const exportPresetPlatform = exportPreset?.platform ?? null;
  const verifyEntryPoint = detectRepositoryVerifyEntryPoint(projectAbs, projectDir, io);

  return {
    id: "godot",
    root,
    // Repo-relative project root (posix). Verify uses `--path ${projectDir}`.
    projectDir,
    projectFile:
      projectDir === "." ? GODOT_PROJECT_FILE : relPosix(projectDir, GODOT_PROJECT_FILE),
    configVersion,
    major,
    minor,
    features,
    testRunner: hasGut ? "gut" : hasGdUnit4 ? "gdunit4" : null,
    testDir,
    // Godot 3 imports into .import, Godot 4 into .godot. Unknown major gets
    // the modern one - the same default the version branches below use.
    cacheDir: major === 3 ? ".import" : ".godot",
    hasExportPresets,
    exportPresetName,
    exportPresetPlatform,
    verifyEntryPoint,
    // Historical flag: bare `--check-only` without `--script` never exits on
    // Godot 4 (it boots main_scene forever). The default plan no longer emits
    // that form; whole-project check uses runtime-plugin/tools/grok_check.gd.
    // Kept on the descriptor so older callers/tests can still branch on major.
    supportsCheckOnly: major !== 3,
    exeHint: resolveBinaryHint("godot", io.env)
  };
}

/**
 * Blender markers in one directory, most authoritative first. A 4.2+ extension
 * has both a manifest and an __init__.py, so the manifest has to win or the
 * `extension validate` default is never emitted.
 */
function inspectBlenderDir(dir, rel, io) {
  if (exists(io, path.join(dir, BLENDER_MANIFEST_FILE))) {
    return {
      detectedBy: "manifest",
      manifestPath: relPosix(rel, BLENDER_MANIFEST_FILE),
      addonInitPath: null
    };
  }

  const initPath = path.join(dir, "__init__.py");
  if (exists(io, initPath)) {
    // Read-then-slice rather than an fd read of the first 4 KB: it keeps the
    // injectable io surface at three plain fs functions, and an __init__.py
    // large enough for the difference to matter does not exist in practice.
    const head = (readText(io, initPath) ?? "").slice(0, BL_INFO_HEAD_BYTES);
    if (BL_INFO_PATTERN.test(head)) {
      return {
        detectedBy: "bl-info",
        manifestPath: null,
        addonInitPath: relPosix(rel, "__init__.py")
      };
    }
  }

  for (const entry of readEntries(io, dir)) {
    if (!entry.directory && /\.blend$/i.test(entry.name)) {
      return { detectedBy: "blend-file", manifestPath: null, addonInitPath: null };
    }
  }

  return null;
}

/**
 * blender_version_min from blender_manifest.toml — recorded on the descriptor
 * so a pre-flight guard can refuse (or at least warn) before a verify that
 * would only fail with a version error after Blender starts.
 */
function parseBlenderManifestVersionMin(text) {
  const match = /^\s*blender_version_min\s*=\s*"(\d+)\.(\d+)(?:\.(\d+))?"/m.exec(String(text ?? ""));
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
    raw: match[3] ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}`
  };
}

/**
 * Parse id / type / wheels from blender_manifest.toml (4.2+ extensions).
 * `id` is what `addon_utils.enable` and `bl_ext.user_default.<id>` use; the
 * directory name is not authoritative.
 */
function parseBlenderManifestMeta(text) {
  const raw = String(text ?? "");
  const idMatch = /^\s*id\s*=\s*"([^"]+)"/m.exec(raw);
  const typeMatch = /^\s*type\s*=\s*"([^"]+)"/m.exec(raw);
  const hasWheels = /^\s*\[\[wheels\]\]/m.test(raw) || /^\s*wheels\s*=/m.test(raw);
  return {
    extensionId: idMatch ? idMatch[1].trim() : null,
    extensionType: typeMatch ? typeMatch[1].trim() : null,
    hasWheels
  };
}

/**
 * Turn a repo/directory name into a legal Python identifier for
 * `addon_utils.enable`. `mesh-tools` must become `mesh_tools`, never left as a
 * name that cannot be imported.
 *
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function sanitizePythonModuleName(name) {
  let s = String(name ?? "")
    .trim()
    .replace(/[-.\s]+/g, "_")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) {
    return "addon";
  }
  if (!/^[A-Za-z_]/.test(s)) {
    s = `_${s}`;
  }
  return s;
}

function detectBlender(root, io) {
  let hit = inspectBlenderDir(root, "", io);
  if (!hit) {
    for (const child of childDirs(root, io)) {
      hit = inspectBlenderDir(child.dir, child.rel, io);
      if (hit) {
        break;
      }
    }
  }
  if (!hit) {
    return null;
  }

  // A test entry point is what makes a Blender verify command worth running;
  // without one the default is only a smoke check. Both spellings are common.
  let testScript = null;
  for (const candidate of ["tests/run_tests.py", "tests/run.py"]) {
    if (exists(io, path.join(root, ...candidate.split("/")))) {
      testScript = candidate;
      break;
    }
  }

  let blenderVersionMin = null;
  let extensionId = null;
  let extensionType = null;
  let hasWheels = false;
  if (hit.manifestPath) {
    const manifestText = readText(io, path.join(root, ...hit.manifestPath.split("/"))) ?? "";
    blenderVersionMin = parseBlenderManifestVersionMin(manifestText);
    const meta = parseBlenderManifestMeta(manifestText);
    extensionId = meta.extensionId;
    extensionType = meta.extensionType;
    hasWheels = meta.hasWheels;
  }

  // Blender imports an add-on under its directory name (legacy) or extension
  // id (4.2+). Root-level add-ons use the repository basename. Always sanitise
  // so a repo named `mesh-tools` does not produce an unimportable link name.
  const addonRelative = hit.manifestPath ?? hit.addonInitPath ?? null;
  let rawDirName = null;
  if (addonRelative) {
    const dir = path.posix.dirname(addonRelative.replace(/\\/g, "/"));
    rawDirName =
      dir === "." || dir === ""
        ? path.basename(root)
        : dir.split("/").filter(Boolean)[0] ?? null;
  }

  const isExtension = Boolean(hit.manifestPath);
  const safeDirName = rawDirName ? sanitizePythonModuleName(rawDirName) : null;
  const safeExtensionId = extensionId
    ? sanitizePythonModuleName(extensionId)
    : safeDirName;
  // What addon_utils.enable / the verify shim must pass. Extensions live under
  // the bl_ext.user_default namespace when sandboxed into BLENDER_USER_EXTENSIONS.
  const moduleName = isExtension && safeExtensionId
    ? `bl_ext.user_default.${safeExtensionId}`
    : safeDirName;

  // projectDir for the add-on package itself (directory containing the marker).
  let projectDir = ".";
  if (addonRelative) {
    const dir = path.posix.dirname(addonRelative.replace(/\\/g, "/"));
    if (dir && dir !== ".") {
      projectDir = dir.split("/")[0] ?? ".";
    }
  }

  const verifyEntryPoint = detectRepositoryVerifyEntryPoint(root, ".", io);

  return {
    id: "blender",
    root,
    projectDir,
    verifyEntryPoint,
    detectedBy: hit.detectedBy,
    manifestPath: hit.manifestPath,
    addonInitPath: hit.addonInitPath,
    moduleName,
    extensionId: safeExtensionId,
    extensionType,
    hasWheels,
    // Directory-link basename for legacy add-ons (sanitised).
    addonName: isExtension ? safeExtensionId : safeDirName,
    // True when there is a module to sandbox (extension or legacy add-on). A
    // bare .blend project is NOT an add-on — auto-sandbox must not claim it.
    isAddon: Boolean(hit.manifestPath || hit.addonInitPath),
    isExtension,
    testScript,
    blenderVersionMin,
    exeHint: resolveBinaryHint("blender", io.env)
  };
}

/**
 * Package manager for a Node project: lockfile first, then packageManager field.
 *
 * Workspaces are detected so the verify plan stays at the root rather than
 * descending into every package — `pnpm -r test` would re-run the same suite
 * N times and is never what a default plan should do.
 */
function detectPackageManager(root, io, packageManagerField) {
  if (exists(io, path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (exists(io, path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  if (exists(io, path.join(root, "bun.lockb")) || exists(io, path.join(root, "bun.lock"))) {
    return "bun";
  }
  if (exists(io, path.join(root, "package-lock.json"))) {
    return "npm";
  }
  const field = typeof packageManagerField === "string" ? packageManagerField.trim() : "";
  if (field) {
    const name = field.split("@")[0].trim().toLowerCase();
    if (name === "pnpm" || name === "yarn" || name === "npm" || name === "bun") {
      return name;
    }
  }
  return "npm";
}

function detectNode(root, io) {
  const hit = findMarkerAtDepth1(root, io, "package.json");
  if (!hit) {
    return null;
  }

  const projectAbs = hit.projectAbs;
  const projectDir = hit.projectDir;
  const packageJson = hit.abs;

  let scripts = {};
  let dependencies = {};
  let devDependencies = {};
  let packageManagerField = null;
  let workspaces = null;
  try {
    const parsed = JSON.parse(readText(io, packageJson) ?? "{}");
    scripts = parsed && typeof parsed.scripts === "object" && parsed.scripts ? parsed.scripts : {};
    dependencies =
      parsed && typeof parsed.dependencies === "object" && parsed.dependencies
        ? parsed.dependencies
        : {};
    devDependencies =
      parsed && typeof parsed.devDependencies === "object" && parsed.devDependencies
        ? parsed.devDependencies
        : {};
    packageManagerField = typeof parsed.packageManager === "string" ? parsed.packageManager : null;
    workspaces = parsed.workspaces ?? null;
  } catch {
    // A malformed package.json still identifies a Node project; it just cannot
    // contribute a verify command.
    scripts = {};
  }

  const testScript = typeof scripts.test === "string" ? scripts.test : "";
  const hasTestScript = Boolean(testScript) && !/no test specified/i.test(testScript);
  // Lockfiles are usually at the monorepo root even when package.json lives in
  // a child; check both project dir and repo root.
  const packageManager = detectPackageManager(projectAbs, io, packageManagerField);
  const packageManagerAtRoot =
    projectDir !== "." ? detectPackageManager(root, io, packageManagerField) : packageManager;
  const resolvedPm =
    packageManager !== "npm" || projectDir === "."
      ? packageManager
      : packageManagerAtRoot;
  const verifyEntryPoint = detectRepositoryVerifyEntryPoint(projectAbs, projectDir, io, { scripts });

  // When scripts.test is absent, call the runner directly only when a real
  // config file says the project uses it. Guessing `npx jest` on every repo
  // with a jest dependency that is only used for one package would fail most
  // workspace roots.
  let directTestRunner = null;
  if (!hasTestScript) {
    if (
      exists(io, path.join(projectAbs, "vitest.config.ts")) ||
      exists(io, path.join(projectAbs, "vitest.config.js")) ||
      exists(io, path.join(projectAbs, "vitest.config.mjs")) ||
      exists(io, path.join(projectAbs, "vite.config.ts")) ||
      exists(io, path.join(projectAbs, "vite.config.js"))
    ) {
      // vite.config alone is not enough to prove vitest — only when vitest is
      // also a dependency, so a plain Vite app does not get a bogus plan.
      if (dependencies.vitest || devDependencies.vitest) {
        directTestRunner = "vitest";
      }
    } else if (
      exists(io, path.join(projectAbs, "jest.config.js")) ||
      exists(io, path.join(projectAbs, "jest.config.ts")) ||
      exists(io, path.join(projectAbs, "jest.config.mjs")) ||
      exists(io, path.join(projectAbs, "jest.config.cjs"))
    ) {
      directTestRunner = "jest";
    }
  }

  const hasTypeScript =
    Boolean(dependencies.typescript || devDependencies.typescript) &&
    exists(io, path.join(projectAbs, "tsconfig.json"));

  const isWorkspace =
    workspaces != null ||
    exists(io, path.join(projectAbs, "pnpm-workspace.yaml")) ||
    exists(io, path.join(root, "pnpm-workspace.yaml")) ||
    exists(io, path.join(projectAbs, "lerna.json")) ||
    exists(io, path.join(root, "lerna.json"));

  return {
    id: "node",
    root,
    projectDir,
    // `npm init` writes a placeholder test script that exits 1 on purpose.
    // Emitting `npm test` for it would fail every run of a project that has
    // simply never added tests.
    hasTestScript,
    packageManager: resolvedPm,
    verifyEntryPoint,
    directTestRunner,
    hasTypeScript,
    isWorkspace
  };
}

/**
 * Resolve how Python commands should be prefixed for this project.
 *
 * Prefer project-local runners (uv / Poetry / PDM / .venv) over a bare
 * `python` on PATH: the latter is frequently the wrong interpreter on a
 * machine with several toolchains, and on Windows it may be the Store stub.
 *
 * Pure and fs-only — never probes the binary.
 *
 * @param {string} root
 * @param {{ existsSync: Function, platform?: string }} io
 * @returns {{ kind: string, python: string, prefix: string[] }}
 */
export function resolvePythonInterpreter(root, io = {}) {
  // Default to real fs.existsSync: callers that only pass `platform` (tests,
  // verify-plan previews) still need to see lockfiles and venvs on disk. The
  // injectable override remains for fully virtual fixtures.
  const existsSync = io.existsSync ?? fs.existsSync;
  const platform = io.platform ?? process.platform;
  const join = (...parts) => path.join(root, ...parts);

  if (existsSync(join("uv.lock"))) {
    return { kind: "uv", python: "python", prefix: ["uv", "run"] };
  }
  if (existsSync(join("poetry.lock"))) {
    return { kind: "poetry", python: "python", prefix: ["poetry", "run"] };
  }
  if (existsSync(join("pdm.lock"))) {
    return { kind: "pdm", python: "python", prefix: ["pdm", "run"] };
  }

  for (const venvName of [".venv", "venv"]) {
    const winPy = join(venvName, "Scripts", "python.exe");
    const posixPy = join(venvName, "bin", "python");
    if (platform === "win32" && existsSync(winPy)) {
      // Quoted later only when needed; store the absolute path as the token.
      return { kind: "venv", python: winPy, prefix: [] };
    }
    if (platform !== "win32" && existsSync(posixPy)) {
      return { kind: "venv", python: posixPy, prefix: [] };
    }
    // Cross-platform fixtures and unusual layouts: accept either shape.
    if (existsSync(winPy)) {
      return { kind: "venv", python: winPy, prefix: [] };
    }
    if (existsSync(posixPy)) {
      return { kind: "venv", python: posixPy, prefix: [] };
    }
  }

  return {
    kind: "system",
    python: platform === "win32" ? "python" : "python3",
    prefix: []
  };
}

function formatPythonCommand(interpreter, args) {
  const tokens = [];
  for (const part of interpreter.prefix ?? []) {
    tokens.push(part);
  }
  let python = String(interpreter.python ?? "python");
  if (/\s/.test(python) && !/^".*"$/.test(python)) {
    python = `"${python}"`;
  }
  tokens.push(python, ...args);
  return tokens.join(" ");
}

/**
 * Django is a Python subtype: same ecosystem id so priority and tooling stay
 * coherent, with `framework: "django"` selecting the manage.py verify plan.
 *
 * @param {string} projectAbs absolute path of the Python/Django project root
 * @param {string} projectDir repo-relative posix project dir
 */
function detectDjangoSignals(projectAbs, projectDir, io, pyproject, requirements) {
  if (!exists(io, path.join(projectAbs, "manage.py"))) {
    return null;
  }

  const hasSettingsFile = exists(io, path.join(projectAbs, "settings.py"));
  let settingsModule = hasSettingsFile ? "settings" : null;
  const hasSettingsPkg =
    exists(io, path.join(projectAbs, "settings", "__init__.py")) ||
    // Common layout: <project>/settings.py one level down from manage.py.
    childDirs(projectAbs, io).some((child) => {
      if (exists(io, path.join(child.dir, "settings.py"))) {
        if (!settingsModule) {
          settingsModule = `${child.rel}.settings`;
        }
        return true;
      }
      if (exists(io, path.join(child.dir, "settings", "__init__.py"))) {
        if (!settingsModule) {
          settingsModule = `${child.rel}.settings`;
        }
        return true;
      }
      return false;
    });

  if (exists(io, path.join(projectAbs, "settings", "__init__.py")) && !settingsModule) {
    settingsModule = "settings";
  }

  const depText = `${pyproject}\n${requirements}`;
  const hasDjangoDep =
    /^\s*django\s*[>=<\[]/im.test(depText) ||
    /^\s*["']Django["']\s*[>=,<]/im.test(depText) ||
    /["']django["']\s*[>=,<]/i.test(depText) ||
    /^\s*django\s*$/im.test(requirements);

  if (!hasSettingsFile && !hasSettingsPkg && !hasDjangoDep) {
    return null;
  }

  const managePy =
    projectDir === "." ? "manage.py" : relPosix(projectDir, "manage.py");

  return {
    framework: "django",
    managePy,
    settingsModule
  };
}

function detectPython(root, io) {
  const markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "manage.py"];
  // Prefer manage.py over a bare pyproject when both exist at different depths
  // so a monorepo with tools/pyproject.toml + backend/manage.py still finds Django.
  const manageHit = findMarkerAtDepth1(root, io, "manage.py");
  const anyHit = findAnyMarkerAtDepth1(root, io, markers);
  if (!anyHit && !manageHit) {
    return null;
  }

  // Prefer the manage.py location when present (Django monorepo), else first marker.
  const projectDir = manageHit?.projectDir ?? anyHit.projectDir;
  const projectAbs = manageHit?.projectAbs ?? anyHit.projectAbs;

  const pyproject = readText(io, path.join(projectAbs, "pyproject.toml")) ?? "";
  const requirements = readText(io, path.join(projectAbs, "requirements.txt")) ?? "";
  // Also read root requirements when the project is nested (common monorepo).
  const rootRequirements =
    projectDir !== "." ? readText(io, path.join(root, "requirements.txt")) ?? "" : "";
  const platform = io.env?.GROK_BUILD_DETECT_PLATFORM || process.platform;
  const interpreter = resolvePythonInterpreter(projectAbs, {
    existsSync: (target) => exists(io, target),
    platform
  });

  const hasPytest =
    exists(io, path.join(projectAbs, "pytest.ini")) ||
    exists(io, path.join(projectAbs, "conftest.py")) ||
    /^\s*\[tool\.pytest/m.test(pyproject);
  const hasTestsDir =
    exists(io, path.join(projectAbs, "tests")) || exists(io, path.join(projectAbs, "test"));
  const hasRuff =
    /^\s*\[tool\.ruff/m.test(pyproject) ||
    exists(io, path.join(projectAbs, "ruff.toml")) ||
    exists(io, path.join(projectAbs, ".ruff.toml"));
  const hasMypy =
    /^\s*\[tool\.mypy/m.test(pyproject) ||
    exists(io, path.join(projectAbs, "mypy.ini")) ||
    exists(io, path.join(projectAbs, ".mypy.ini"));

  const django = detectDjangoSignals(
    projectAbs,
    projectDir,
    io,
    pyproject,
    `${requirements}\n${rootRequirements}`
  );
  const verifyEntryPoint = detectRepositoryVerifyEntryPoint(projectAbs, projectDir, io);

  return {
    id: "python",
    verifyEntryPoint,
    root,
    projectDir,
    framework: django?.framework ?? null,
    managePy: django?.managePy ?? null,
    settingsModule: django?.settingsModule ?? null,
    interpreter,
    hasTests: hasPytest || hasTestsDir,
    hasPytest,
    hasRuff,
    hasMypy
  };
}

function detectRust(root, io) {
  const hit = findMarkerAtDepth1(root, io, "Cargo.toml");
  if (!hit) {
    return null;
  }
  return {
    id: "rust",
    root,
    projectDir: hit.projectDir,
    verifyEntryPoint: detectRepositoryVerifyEntryPoint(hit.projectAbs, hit.projectDir, io)
  };
}

const DETECTORS = Object.freeze({
  godot: detectGodot,
  blender: detectBlender,
  rust: detectRust,
  python: detectPython,
  node: detectNode
});

/**
 * Detect every ecosystem present at `root`, in `ECOSYSTEM_PRIORITY` order.
 *
 * @param {string} root repo/workspace root
 * @param {{
 *   existsSync?: typeof fs.existsSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   env?: NodeJS.ProcessEnv
 * }} [io]
 * @returns {Array<Record<string, any>>} descriptors, possibly empty; never throws
 */
export function detectEcosystems(
  root,
  {
    existsSync = fs.existsSync,
    readdirSync = fs.readdirSync,
    readFileSync = fs.readFileSync,
    env = process.env
  } = {}
) {
  if (!root) {
    return [];
  }
  const io = { existsSync, readdirSync, readFileSync, env: env ?? {} };
  const resolved = path.resolve(String(root));

  const found = [];
  for (const id of ECOSYSTEM_PRIORITY) {
    let descriptor = null;
    try {
      descriptor = DETECTORS[id](resolved, io);
    } catch {
      // Detection is advisory. A surprising fs error (a permission-denied
      // subdirectory, a race with the agent deleting a file) must cost the
      // guess, never the run.
      descriptor = null;
    }
    if (descriptor) {
      found.push(descriptor);
    }
  }
  return found;
}

/**
 * The single ecosystem a verify plan should be built for, or null.
 *
 * @param {string} root
 * @param {Parameters<typeof detectEcosystems>[1]} [io]
 */
export function detectPrimaryEcosystem(root, io) {
  return detectEcosystems(root, io)[0] ?? null;
}

function resolveBinaryHint(id, env) {
  for (const name of BINARY_ENV_VARS[id] ?? []) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return DEFAULT_BINARY_NAMES[id] ?? null;
}

/**
 * Turn an executable hint into a token that can be pasted into a verify
 * command string.
 *
 * The hard rule: this resolves in JS and returns a literal. It must never emit
 * shell parameter expansion. `${GODOT_BIN:-godot}` is POSIX sh syntax and
 * verify.mjs wraps every command in `cmd /d /s /c` on win32, where cmd.exe
 * passes it through verbatim and Godot is invoked as a file named
 * `${GODOT_BIN:-godot}`.
 *
 * @param {{id?: string, exeHint?: string}|null} descriptor
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: string,
 *   existsSync?: typeof fs.existsSync,
 *   override?: string
 * }} [options] `override` is the hook for a project config's `tools.godot` /
 *   `tools.blender`, which outranks both env vars.
 * @returns {string} a quoted, platform-normalised command token
 */
export function resolveEcosystemBinary(descriptor, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;
  const id = descriptor?.id ?? "";

  const override = typeof options.override === "string" ? options.override.trim() : "";
  const hint =
    override ||
    (typeof descriptor?.exeHint === "string" && descriptor.exeHint.trim()
      ? descriptor.exeHint.trim()
      : resolveBinaryHint(id, env)) ||
    id;

  let value = String(hint);

  if (platform === "win32") {
    if (value.includes("/")) {
      // cmd.exe accepts forward slashes in a path argument but not as the
      // leading token of a command line, where it reads them as switches.
      value = value.replace(/\//g, "\\");
    }
    value = preferWindowsConsoleExe(value, existsSync);
  }

  // Quote only when needed: an unnecessary pair around a bare `godot` would
  // survive into every rendered command and read as a path.
  if (/\s/.test(value) && !/^".*"$/.test(value)) {
    value = `"${value}"`;
  }
  return value;
}

/**
 * Windows Godot/Blender ships a GUI-subsystem exe that writes nothing to a
 * captured pipe, which silently defeats every output-based failure check. The
 * *_console.exe build next to it writes to stdout/stderr normally, so prefer
 * it when it is actually on disk.
 */
function preferWindowsConsoleExe(value, existsSync) {
  if (!/\.exe$/i.test(value) || /_console\.exe$/i.test(value)) {
    return value;
  }
  const candidate = `${value.slice(0, -4)}_console.exe`;
  try {
    return existsSync(candidate) ? candidate : value;
  } catch {
    return value;
  }
}

/** res:// path of the whole-project check after injectRuntimePlugin copies tools/. */
export const GODOT_CHECK_SCRIPT_RES =
  "res://.grok/plugins/grok-build-runtime/tools/grok_check.gd";

/**
 * Characters a repo-derived path may contain before it is allowed into a
 * command string. See the long comment on SAFE_COMMAND_PATH_PATTERN below.
 */
const SAFE_COMMAND_PATH_PATTERN = /^[A-Za-z0-9 ._\/-]+$/;

/**
 * Quote a path token for a command string. Same rule as
 * `resolveEcosystemBinary`: quote only when whitespace makes it necessary.
 * Callers must have passed the value through `SAFE_COMMAND_PATH_PATTERN` first.
 */
function quoteCommandPath(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * Safe `--path` / cwd token from descriptor.projectDir. Falls back to `"."`
 * when missing or unsafe (never emits an injectable path).
 */
function safeProjectPathArg(descriptor) {
  const raw =
    typeof descriptor?.projectDir === "string" && descriptor.projectDir.trim()
      ? descriptor.projectDir.trim().replace(/\\/g, "/")
      : ".";
  if (raw === "." || raw === "") {
    return ".";
  }
  if (!SAFE_COMMAND_PATH_PATTERN.test(raw)) {
    return ".";
  }
  return quoteCommandPath(raw);
}

function godotVerifyCommands(exe, descriptor, options = {}) {
  const commands = [];
  const major = descriptor.major;
  const pathArg = safeProjectPathArg(descriptor);
  // Unknown major takes the Godot 4 branch: 4.x is what a project detected
  // today is overwhelmingly likely to be, and its flags are the ones a
  // config_version we failed to parse would most likely accept.
  const headless = major === 3 ? "--no-window" : "--headless";

  // NEVER emit bare `--check-only` without `--script`. Godot's own docs say
  // `--check-only` only works with `--script`; without it the flag is inert
  // and Godot boots run/main_scene headlessly forever. Measured on 4.7: 15 min
  // baseline hang, then infrastructure timeout, so a Godot project could never
  // report verified:true on the default plan.
  //
  // Whole-project check: runtime-plugin/tools/grok_check.gd walks res:// and
  // ResourceLoader.load()s every .gd/.gdshader/.tscn/.tres, then quits with a
  // real exit code. injectRuntimePlugin copies tools/ into the worktree.
  if (major !== 3) {
    commands.push(
      `${exe} --headless --path ${pathArg} --script ${GODOT_CHECK_SCRIPT_RES} --quit`
    );
  }

  if (major === 3) {
    // Godot 3 has neither --headless (4.0) nor --quit-after. Editor mode plus
    // --quit is the documented way to import assets and surface parse errors;
    // without -e/--editor the import never runs.
    commands.push(`${exe} --no-window --path ${pathArg} --editor --quit`);
  } else {
    // --import imports assets without opening the editor; --quit-after 1 then
    // runs the main scene for a single frame. Whole-project coverage of other
    // scenes is provided by grok_check.gd above.
    commands.push(`${exe} --headless --path ${pathArg} --import`);
    commands.push(`${exe} --headless --path ${pathArg} --quit-after 1`);
  }

  const repositoryEntryPoint = verifyEntryPointCommand(descriptor.verifyEntryPoint, descriptor, options);
  if (repositoryEntryPoint) {
    commands.push(repositoryEntryPoint);
  } else if (descriptor.testRunner === "gut") {
    commands.push(`${exe} ${headless} --path ${pathArg} -s addons/gut/gut_cmdln.gd -gexit`);
  } else if (descriptor.testRunner === "gdunit4" && descriptor.testDir) {
    const testDir =
      typeof descriptor.testDir === "string" && SAFE_COMMAND_PATH_PATTERN.test(descriptor.testDir)
        ? quoteCommandPath(descriptor.testDir)
        : null;
    if (testDir) {
      commands.push(
        `${exe} ${headless} --path ${pathArg} -s addons/gdUnit4/bin/GdUnitCmdTool.gd -a ${testDir}`
      );
    }
  }

  // Opt-in export smoke. Never touches export_credentials.cfg — that file is
  // machine-local secrets and already in worktree.mjs's never-commit list.
  // Output lands under the run scratch dir so a successful smoke cannot stage
  // a binary into the commit. Extension follows the preset platform; the
  // bridge mkdir's .grok-build/ and runVerifyCommand stats the artifact.
  if (options.exportSmoke && descriptor.hasExportPresets && descriptor.exportPresetName) {
    const preset = descriptor.exportPresetName;
    const safePreset = SAFE_COMMAND_PATH_PATTERN.test(preset) ? preset : null;
    if (safePreset) {
      const quoted = quoteCommandPath(safePreset);
      const ext = exportSmokeExtensionForPlatform(
        descriptor.exportPresetPlatform ?? options.exportPresetPlatform
      );
      const out = `.grok-build/export-smoke${ext}`;
      if (major === 3) {
        commands.push(`${exe} --no-window --path ${pathArg} --export ${quoted} ${out}`);
      } else {
        commands.push(`${exe} --headless --path ${pathArg} --export-release ${quoted} ${out}`);
      }
    }
  }

  return commands;
}

/**
 * Characters a repo-derived path may contain before it is allowed into a
 * command string.
 *
 * `descriptor.manifestPath` is the one token in a default verify command built
 * from repo content: `inspectBlenderDir` derives it from a depth-1 directory
 * NAME read straight off disk. It is executed through `cmd /d /s /c` on win32
 * and `/bin/sh -c` elsewhere (verify.mjs), and by a route with no gate in front
 * of it - an ecosystem default is not config-sourced, so `.grok-build.json`'s
 * trust-on-first-use gate never covers it, and the baseline probe runs the
 * command BEFORE the agent spawns, so the echoed plan is not a gate either.
 * A directory named `addon & whoami` therefore used to mean arbitrary command
 * execution from merely cloning a repository.
 *
 * Anything outside this set is refused rather than escaped, because quoting is
 * not sufficient on its own: cmd.exe still expands `%VAR%` and honours `^`
 * inside double quotes, and the same string also has to survive sh, where `$`
 * and a backtick are live. Space IS inside the set on purpose - a legitimate
 * `My Addon/` must still get its validate command, which is what the quoting
 * at the call site is for.
 *
 * The check lives here and not in `relPosix`/`inspectBlenderDir`: the
 * descriptor field is also consumed as a real filesystem path (provision.mjs
 * links the add-on directory from it), where the raw name is what is wanted.
 */
// SAFE_COMMAND_PATH_PATTERN and quoteCommandPath are defined above godotVerifyCommands.

/** Relative path of the bridge-owned Blender verify shim (written by provision). */
export const BLENDER_VERIFY_SHIM_RELATIVE = ".grok-build/blender/grok_verify_shim.py";

function blenderVerifyCommands(exe, descriptor, options = {}) {
  const commands = [];

  // Refuse outright rather than emit an injectable command. Falling through
  // costs the manifest check on a repo with an exotic directory name; the
  // branches below still produce the test-script or smoke-check command, so
  // the run is verified, just less specifically.
  const manifestPath =
    typeof descriptor.manifestPath === "string" &&
    SAFE_COMMAND_PATH_PATTERN.test(descriptor.manifestPath)
      ? descriptor.manifestPath
      : null;

  if (manifestPath) {
    // `--command extension validate` is a real manifest schema check that
    // loads no scene. A blender_manifest.toml can only exist for 4.2+, which
    // is exactly where the subcommand exists, so it is safe to assume here.
    // It does NOT import Python — registration smoke below covers that.
    commands.push(`${exe} --command extension validate ${quoteCommandPath(manifestPath)}`);
  }

  const shim = BLENDER_VERIFY_SHIM_RELATIVE;
  const moduleName =
    typeof descriptor.moduleName === "string" &&
    SAFE_COMMAND_PATH_PATTERN.test(descriptor.moduleName)
      ? descriptor.moduleName
      : null;

  const repositoryEntryPoint = verifyEntryPointCommand(descriptor.verifyEntryPoint, descriptor, options);
  // A repository-owned runner is authoritative. Do not also guess at a second
  // framework invocation when it exists; the real runner may select a suite,
  // environment, or wrapper that the bridge cannot safely infer.
  if (repositoryEntryPoint) {
    commands.push(repositoryEntryPoint);
  }

  // testScript needs no such guard: `detectBlender` only ever assigns it one of
  // two hardcoded candidates, so no repo-controlled bytes reach it.
  // Run through the bridge shim so a unittest suite that reports FAILED
  // without sys.exit(1) still fails verification (false-green fix).
  if (descriptor.testScript && !repositoryEntryPoint) {
    commands.push(
      `${exe} --background --factory-startup --python-exit-code 1 --python ${shim} -- ${descriptor.testScript}`
    );
  }

  // Registration / import smoke is unconditional whenever we know a module
  // name: `extension validate` alone never imports __init__.py, so a syntax
  // error in the add-on used to verify green on a manifest-only plan.
  if (moduleName) {
    commands.push(
      `${exe} --background --factory-startup --python-exit-code 1 --python ${shim} -- --enable ${moduleName}`
    );
  } else if (!descriptor.testScript && !manifestPath) {
    // Bare .blend project: only assert the binary can start headless.
    commands.push(
      `${exe} --background --factory-startup --python-exit-code 1 --python-expr "import bpy"`
    );
  } else if (!descriptor.testScript && manifestPath && !moduleName) {
    // Manifest present but module name could not be derived safely — still
    // smoke-import bpy so the plan is never validate-only.
    commands.push(
      `${exe} --background --factory-startup --python-exit-code 1 --python-expr "import bpy"`
    );
  }

  return commands;
}

/**
 * Package-manager flag that scopes a command to a subdirectory without `cd`.
 * Returns null when projectDir is root or unsafe.
 */
function nodePrefixFlag(pm, projectDir) {
  if (!projectDir || projectDir === "." || projectDir === "") {
    return null;
  }
  if (!SAFE_COMMAND_PATH_PATTERN.test(projectDir)) {
    return null;
  }
  const dir = quoteCommandPath(projectDir);
  if (pm === "pnpm") {
    return `--dir ${dir}`;
  }
  if (pm === "yarn") {
    return `--cwd ${dir}`;
  }
  if (pm === "bun") {
    return `--cwd ${dir}`;
  }
  // npm (default)
  return `--prefix ${dir}`;
}

function nodeVerifyCommands(descriptor, options = {}) {
  const commands = [];
  const pm = descriptor.packageManager || "npm";
  const prefix = nodePrefixFlag(pm, descriptor.projectDir);
  const repositoryEntryPoint = verifyEntryPointCommand(descriptor.verifyEntryPoint, descriptor, options);

  if (repositoryEntryPoint) {
    commands.push(repositoryEntryPoint);
  } else if (descriptor.hasTestScript) {
    // Always at the project (or workspace) root. `pnpm -r test` / per-package
    // descent is never the default: it multiplies wall-clock by the package
    // count and is not what a monorepo's root scripts.test is for.
    if (prefix) {
      // `npm --prefix frontend test` / `pnpm --dir frontend test`
      commands.push(`${pm} ${prefix} test`);
    } else {
      commands.push(`${pm} test`);
    }
  } else if (descriptor.directTestRunner === "vitest") {
    if (prefix) {
      commands.push(
        pm === "npm"
          ? `npx --prefix ${quoteCommandPath(descriptor.projectDir)} vitest run`
          : `${pm} ${prefix} exec vitest run`
      );
    } else {
      commands.push(pm === "npm" ? "npx vitest run" : `${pm} exec vitest run`);
    }
  } else if (descriptor.directTestRunner === "jest") {
    if (prefix) {
      commands.push(
        pm === "npm"
          ? `npx --prefix ${quoteCommandPath(descriptor.projectDir)} jest`
          : `${pm} ${prefix} exec jest`
      );
    } else {
      commands.push(pm === "npm" ? "npx jest" : `${pm} exec jest`);
    }
  }

  // A repository-owned test entry point replaces guessed test runners, but a
  // configured TypeScript typecheck is an independent safety signal and still
  // belongs in the default plan.
  if (descriptor.hasTypeScript) {
    // tsc --noEmit is the cheap typecheck; only when TypeScript is actually a
    // dependency AND tsconfig.json exists (both gated at detection time).
    if (prefix) {
      commands.push(
        pm === "npm"
          ? `npx --prefix ${quoteCommandPath(descriptor.projectDir)} tsc --noEmit`
          : `${pm} ${prefix} exec tsc --noEmit`
      );
    } else {
      commands.push(pm === "npm" ? "npx tsc --noEmit" : `${pm} exec tsc --noEmit`);
    }
  }

  return commands;
}

function pythonVerifyCommands(descriptor, options = {}) {
  const platform = options.platform ?? process.platform;
  const projectAbs =
    descriptor.projectDir && descriptor.projectDir !== "." && descriptor.root
      ? path.join(descriptor.root, ...String(descriptor.projectDir).split("/"))
      : (descriptor.root ?? "");
  const interpreter =
    descriptor.interpreter && typeof descriptor.interpreter === "object"
      ? descriptor.interpreter
      : resolvePythonInterpreter(projectAbs || descriptor.root || "", {
          existsSync: options.existsSync ?? fs.existsSync,
          platform
        });

  const commands = [];
  const lintTarget =
    typeof descriptor.projectDir === "string" &&
    descriptor.projectDir !== "." &&
    SAFE_COMMAND_PATH_PATTERN.test(descriptor.projectDir)
      ? quoteCommandPath(descriptor.projectDir)
      : ".";

  // manage.py path is already repo-relative when nested (e.g. backend/manage.py).
  const managePy =
    typeof descriptor.managePy === "string" && SAFE_COMMAND_PATH_PATTERN.test(descriptor.managePy)
      ? descriptor.managePy
      : descriptor.managePy && descriptor.managePy === "manage.py"
        ? "manage.py"
        : null;
  const repositoryEntryPoint = verifyEntryPointCommand(descriptor.verifyEntryPoint, descriptor, options);
  if (repositoryEntryPoint) {
    return [repositoryEntryPoint];
  }

  if (descriptor.framework === "django" && managePy) {
    // Order matters: `check` is seconds, `makemigrations --check` is the
    // classic silent breakage (model changed, migration not committed), then
    // the project's tests. DJANGO_SETTINGS_MODULE is recorded on the descriptor
    // (settingsModule); the bridge may surface it but does not invent env here.
    commands.push(formatPythonCommand(interpreter, [managePy, "check"]));
    commands.push(
      formatPythonCommand(interpreter, [managePy, "makemigrations", "--check", "--dry-run"])
    );
    if (descriptor.hasPytest) {
      const pytestArgs = ["-m", "pytest", "-q"];
      if (lintTarget !== ".") {
        pytestArgs.push(lintTarget);
      }
      commands.push(formatPythonCommand(interpreter, pytestArgs));
    } else {
      commands.push(formatPythonCommand(interpreter, [managePy, "test"]));
    }
  } else if (descriptor.hasTests) {
    const pytestArgs = ["-m", "pytest", "-q"];
    if (lintTarget !== ".") {
      pytestArgs.push(lintTarget);
    }
    commands.push(formatPythonCommand(interpreter, pytestArgs));
  }

  // Linters only when the project configures them — emitting ruff/mypy on a
  // repo that never opted in turns a healthy run red for style noise.
  if (descriptor.hasRuff) {
    if ((interpreter.prefix ?? [])[0] === "uv") {
      commands.push(`uv run ruff check ${lintTarget}`);
    } else if ((interpreter.prefix ?? [])[0] === "poetry") {
      commands.push(`poetry run ruff check ${lintTarget}`);
    } else if ((interpreter.prefix ?? [])[0] === "pdm") {
      commands.push(`pdm run ruff check ${lintTarget}`);
    } else {
      commands.push(formatPythonCommand(interpreter, ["-m", "ruff", "check", lintTarget]));
    }
  }
  if (descriptor.hasMypy) {
    if ((interpreter.prefix ?? [])[0] === "uv") {
      commands.push(`uv run mypy ${lintTarget}`);
    } else if ((interpreter.prefix ?? [])[0] === "poetry") {
      commands.push(`poetry run mypy ${lintTarget}`);
    } else if ((interpreter.prefix ?? [])[0] === "pdm") {
      commands.push(`pdm run mypy ${lintTarget}`);
    } else {
      commands.push(formatPythonCommand(interpreter, ["-m", "mypy", lintTarget]));
    }
  }

  return commands;
}

/**
 * Default verify commands for a descriptor, as ready-to-run command strings.
 *
 * Every binary is resolved to a literal here (see `resolveEcosystemBinary`).
 * The stronger claim this comment used to make - that no returned string ever
 * contains shell parameter expansion - reasoned about the binary token only and
 * was false for the one argument built from repo content: the Blender manifest
 * path. That token is now allowlisted and quoted at construction time (see
 * `SAFE_COMMAND_PATH_PATTERN`), which is what makes the claim true of the whole
 * string rather than of its first word. Every other interpolated argument comes
 * from a hardcoded candidate list in this module.
 *
 * Commands are conservative on purpose - item 5 wires this into runs that
 * previously did no verification at all, so a default that fails on a healthy
 * project would be a regression, not a feature.
 *
 * @param {{id?: string}|null|undefined} descriptor
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: string,
 *   existsSync?: typeof fs.existsSync,
 *   override?: string,
 *   exportSmoke?: boolean
 * }} [options]
 * @returns {string[]}
 */
export function defaultVerifyCommands(descriptor, options = {}) {
  if (!descriptor || typeof descriptor !== "object") {
    return [];
  }

  // Per-ecosystem tool override (tools.godot / tools.blender) when building a
  // multi-ecosystem plan; falls back to the single `override` string.
  const perId =
    options.toolOverrides && typeof options.toolOverrides === "object"
      ? options.toolOverrides[descriptor.id]
      : undefined;
  const resolvedOptions =
    perId !== undefined ? { ...options, override: perId } : options;

  switch (descriptor.id) {
    case "godot":
      return godotVerifyCommands(
        resolveEcosystemBinary(descriptor, resolvedOptions),
        descriptor,
        resolvedOptions
      );
    case "blender":
      return blenderVerifyCommands(
        resolveEcosystemBinary(descriptor, resolvedOptions),
        descriptor,
        resolvedOptions
      );
    case "node":
      return nodeVerifyCommands(descriptor, resolvedOptions);
    case "python":
      return pythonVerifyCommands(descriptor, resolvedOptions);
    case "rust": {
      const repositoryEntryPoint = verifyEntryPointCommand(descriptor.verifyEntryPoint, descriptor, options);
      if (repositoryEntryPoint) {
        return [repositoryEntryPoint];
      }
      if (
        descriptor.projectDir &&
        descriptor.projectDir !== "." &&
        SAFE_COMMAND_PATH_PATTERN.test(descriptor.projectDir)
      ) {
        return [`cargo test --manifest-path ${quoteCommandPath(relPosix(descriptor.projectDir, "Cargo.toml"))}`];
      }
      return ["cargo test"];
    }
    default:
      return [];
  }
}

/**
 * Union verify plan across every detected ecosystem, de-duplicated, in
 * ECOSYSTEM_PRIORITY order (engine-first, then language). Each ecosystem's own
 * commands stay cheapest-first so a fast failure still reports fast.
 *
 * This is what makes a Django + React monorepo run both `manage.py check` and
 * `npm test`, and a Blender add-on with pytest run both the Blender smoke and
 * the Python suite.
 *
 * @param {Array<Record<string, any>>|null|undefined} descriptors
 * @param {Parameters<typeof defaultVerifyCommands>[1]} [options]
 * @returns {string[]}
 */
export function defaultVerifyPlan(descriptors, options = {}) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    return [];
  }
  const seen = new Set();
  const commands = [];
  for (const descriptor of descriptors) {
    for (const command of defaultVerifyCommands(descriptor, options)) {
      if (seen.has(command)) {
        continue;
      }
      seen.add(command);
      commands.push(command);
    }
  }
  return commands;
}

/**
 * Filter detected ecosystems by an optional project-config allowlist.
 * Unknown / empty filter returns the full list unchanged.
 *
 * @param {Array<Record<string, any>>} descriptors
 * @param {string[]|null|undefined} allowlist
 */
export function filterEcosystems(descriptors, allowlist) {
  if (!Array.isArray(descriptors) || descriptors.length === 0) {
    return [];
  }
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return descriptors;
  }
  const allowed = new Set(
    allowlist.map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean)
  );
  if (allowed.size === 0) {
    return descriptors;
  }
  return descriptors.filter((entry) => allowed.has(String(entry?.id ?? "").toLowerCase()));
}
