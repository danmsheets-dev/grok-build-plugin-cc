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
 * Detection reads the repo root and exactly one directory below it. Deeper is
 * deliberately out of scope: a Godot project three levels down is a monorepo
 * layout the user should point the run at directly, and an unbounded walk over
 * a tree that contains node_modules/ or .godot/ is thousands of stat calls for
 * a guess.
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

function detectGodot(root, io) {
  const projectFile = path.join(root, GODOT_PROJECT_FILE);
  // project.godot is the only marker that means "this is a Godot project". A
  // bare .godot/ or .import/ directory must NOT imply Godot: both are caches
  // that outlive the project that produced them (a moved or deleted project
  // leaves them behind), and both are already linked/excluded unconditionally
  // by provision.mjs / worktree.mjs, which is where they belong.
  if (!exists(io, projectFile)) {
    return null;
  }

  const text = readText(io, projectFile) ?? "";
  const configVersion = parseGodotConfigVersion(text);
  const major = godotMajorFromConfigVersion(configVersion);
  const { features, minor } = parseGodotFeatures(text);

  const hasGut = exists(io, path.join(root, "addons", "gut", "gut_cmdln.gd"));
  const hasGdUnit4 = exists(io, path.join(root, "addons", "gdUnit4"));

  // First existing conventional test directory. gdUnit4's CLI runner takes an
  // explicit -a <dir> and errors out when it is missing, so a default verify
  // command for it is only emitted when there is somewhere to point it.
  let testDir = null;
  for (const candidate of ["test", "tests"]) {
    if (exists(io, path.join(root, candidate))) {
      testDir = candidate;
      break;
    }
  }

  return {
    id: "godot",
    root,
    projectFile: GODOT_PROJECT_FILE,
    configVersion,
    major,
    minor,
    features,
    testRunner: hasGut ? "gut" : hasGdUnit4 ? "gdunit4" : null,
    testDir,
    // Godot 3 imports into .import, Godot 4 into .godot. Unknown major gets
    // the modern one - the same default the version branches below use.
    cacheDir: major === 3 ? ".import" : ".godot",
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

  return {
    id: "blender",
    root,
    detectedBy: hit.detectedBy,
    manifestPath: hit.manifestPath,
    addonInitPath: hit.addonInitPath,
    testScript,
    exeHint: resolveBinaryHint("blender", io.env)
  };
}

function detectNode(root, io) {
  const packageJson = path.join(root, "package.json");
  if (!exists(io, packageJson)) {
    return null;
  }

  let scripts = {};
  try {
    const parsed = JSON.parse(readText(io, packageJson) ?? "{}");
    scripts = parsed && typeof parsed.scripts === "object" && parsed.scripts ? parsed.scripts : {};
  } catch {
    // A malformed package.json still identifies a Node project; it just cannot
    // contribute a verify command.
    scripts = {};
  }

  const testScript = typeof scripts.test === "string" ? scripts.test : "";
  return {
    id: "node",
    root,
    // `npm init` writes a placeholder test script that exits 1 on purpose.
    // Emitting `npm test` for it would fail every run of a project that has
    // simply never added tests.
    hasTestScript: Boolean(testScript) && !/no test specified/i.test(testScript)
  };
}

function detectPython(root, io) {
  const markers = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"];
  if (!markers.some((marker) => exists(io, path.join(root, marker)))) {
    return null;
  }

  const pyproject = readText(io, path.join(root, "pyproject.toml")) ?? "";
  return {
    id: "python",
    root,
    hasTests:
      exists(io, path.join(root, "tests")) ||
      exists(io, path.join(root, "pytest.ini")) ||
      /^\s*\[tool\.pytest/m.test(pyproject)
  };
}

function detectRust(root, io) {
  if (!exists(io, path.join(root, "Cargo.toml"))) {
    return null;
  }
  return { id: "rust", root };
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

function godotVerifyCommands(exe, descriptor) {
  const commands = [];
  const major = descriptor.major;
  // Unknown major takes the Godot 4 branch: 4.x is what a project detected
  // today is overwhelmingly likely to be, and its flags are the ones a
  // config_version we failed to parse would most likely accept.
  const headless = major === 3 ? "--no-window" : "--headless";

  if (major === 3) {
    // Godot 3 has neither --headless (4.0) nor --quit-after. Editor mode plus
    // --quit is the documented way to import assets and surface parse errors;
    // without -e/--editor the import never runs.
    commands.push(`${exe} --no-window --path . --editor --quit`);
  } else {
    // --import imports assets without opening the editor; --quit-after 1 then
    // runs the main scene for a single frame, which is what surfaces GDScript
    // parse and load errors that --import alone never reaches.
    commands.push(`${exe} --headless --path . --import`);
    commands.push(`${exe} --headless --path . --quit-after 1`);
  }

  if (descriptor.testRunner === "gut") {
    commands.push(`${exe} ${headless} --path . -s addons/gut/gut_cmdln.gd -gexit`);
  } else if (descriptor.testRunner === "gdunit4" && descriptor.testDir) {
    commands.push(
      `${exe} ${headless} --path . -s addons/gdUnit4/bin/GdUnitCmdTool.gd -a ${descriptor.testDir}`
    );
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
const SAFE_COMMAND_PATH_PATTERN = /^[A-Za-z0-9 ._\/-]+$/;

/**
 * Quote a path token for a command string. Same rule as
 * `resolveEcosystemBinary`: quote only when whitespace makes it necessary, so
 * an ordinary `myaddon/blender_manifest.toml` renders unchanged. Callers must
 * have passed the value through `SAFE_COMMAND_PATH_PATTERN` first - a `"` can
 * never reach this.
 */
function quoteCommandPath(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function blenderVerifyCommands(exe, descriptor) {
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
    commands.push(`${exe} --command extension validate ${quoteCommandPath(manifestPath)}`);
  }

  // testScript needs no such guard: `detectBlender` only ever assigns it one of
  // two hardcoded candidates, so no repo-controlled bytes reach it.
  if (descriptor.testScript) {
    // --python-exit-code turns an exception in the script into a non-zero
    // exit; without it Blender exits 0 and the failure is invisible to
    // exit-code checking. --factory-startup disables every installed add-on
    // INCLUDING the one under test, so the script has to enable it itself with
    // addon_utils.enable("<module>", default_set=False, persistent=True).
    commands.push(
      `${exe} --background --factory-startup --python-exit-code 1 --python ${descriptor.testScript}`
    );
  } else if (!manifestPath) {
    // Nothing better to run than a smoke check: it still catches a broken
    // install or a GUI-only build that cannot start headless, and it is the
    // only thing that can be asserted about an arbitrary .blend repo.
    commands.push(
      `${exe} --background --factory-startup --python-exit-code 1 --python-expr "import bpy"`
    );
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
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, existsSync?: typeof fs.existsSync, override?: string}} [options]
 * @returns {string[]}
 */
export function defaultVerifyCommands(descriptor, options = {}) {
  if (!descriptor || typeof descriptor !== "object") {
    return [];
  }
  const platform = options.platform ?? process.platform;

  switch (descriptor.id) {
    case "godot":
      return godotVerifyCommands(resolveEcosystemBinary(descriptor, options), descriptor);
    case "blender":
      return blenderVerifyCommands(resolveEcosystemBinary(descriptor, options), descriptor);
    case "node":
      return descriptor.hasTestScript ? ["npm test"] : [];
    case "python":
      // `python` is the launcher name on Windows; `python3` is the one that is
      // reliably present on POSIX, where a bare `python` is frequently absent.
      return descriptor.hasTests ? [`${platform === "win32" ? "python" : "python3"} -m pytest -q`] : [];
    case "rust":
      return ["cargo test"];
    default:
      return [];
  }
}
