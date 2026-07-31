/**
 * Runtime helpers for engine verify commands: cross-process cache locks,
 * `.uid` integrity, and `.blend` lock detection.
 *
 * Detection stays in ecosystem.mjs (pure, never spawns). Everything here runs
 * at verify time or after a run, when an engine binary or a post-run walk is
 * already on the table.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** How long a lock may sit untouched before we treat its holder as dead. */
export const GODOT_CACHE_LOCK_STALE_MS = 30 * 60 * 1000;

/** How often a waiter re-checks the lock file while another run holds it. */
const GODOT_CACHE_LOCK_POLL_MS = 500;

/**
 * Lock file living next to the shared cache directory, not inside it.
 *
 * Inside `.godot/` the editor and headless import both rewrite the tree freely;
 * a lock sitting next to the directory is not part of Godot's own layout and
 * survives an import that would otherwise wipe it.
 *
 * @param {string} sharedCachePath absolute path of the shared `.godot` / `.import`
 */
export function godotCacheLockPath(sharedCachePath) {
  return `${String(sharedCachePath ?? "").replace(/[/\\]+$/, "")}.grok-build.lock`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire a cross-process lock around shared-cache engine access.
 *
 * When the cache is private to this run the lock is unnecessary — two private
 * caches never collide — and the caller should skip this entirely (see the
 * note returned by `describeGodotCacheMode`).
 *
 * @param {string} sharedCachePath
 * @param {{
 *   staleMs?: number,
 *   pollMs?: number,
 *   onWaiting?: (message: string) => void,
 *   writeFileSync?: typeof fs.writeFileSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   unlinkSync?: typeof fs.unlinkSync,
 *   existsSync?: typeof fs.existsSync,
 *   mkdirSync?: typeof fs.mkdirSync,
 *   now?: () => number,
 *   pid?: number
 * }} [options]
 * @returns {Promise<{ release: () => void, waited: boolean }>}
 */
export async function acquireGodotCacheLock(sharedCachePath, options = {}) {
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : GODOT_CACHE_LOCK_STALE_MS;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : GODOT_CACHE_LOCK_POLL_MS;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const unlinkSync = options.unlinkSync ?? fs.unlinkSync;
  const existsSync = options.existsSync ?? fs.existsSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;

  const lockPath = godotCacheLockPath(sharedCachePath);
  mkdirSync(path.dirname(lockPath), { recursive: true });

  let waited = false;
  const payload = () =>
    JSON.stringify({
      pid,
      startedAt: new Date(now()).toISOString(),
      purpose: "godot-import-cache"
    });

  // Exclusive create (wx) is the only portable atomic claim that does not need
  // a native flock binding. A stale holder is detected by mtime age, not by
  // probing the pid: the holder may be on another machine sharing the cache
  // over a network mount, and a live local pid with the same number means
  // nothing about that process.
  for (;;) {
    try {
      writeFileSync(lockPath, payload(), { flag: "wx" });
      break;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== "EEXIST") {
        throw error;
      }

      let stale = false;
      try {
        const raw = String(readFileSync(lockPath, "utf8") ?? "");
        const parsed = JSON.parse(raw);
        const started = Date.parse(parsed?.startedAt ?? "");
        if (Number.isFinite(started) && now() - started > staleMs) {
          stale = true;
        }
      } catch {
        // Unreadable / unparseable lock: treat as stale so a crashed run that
        // left garbage cannot wedge every subsequent import forever.
        stale = true;
      }

      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Lost the race to another waiter; loop and try wx again.
        }
        continue;
      }

      if (!waited) {
        waited = true;
        options.onWaiting?.(
          "waiting for another grok-build run to finish importing into the shared Godot cache"
        );
      }
      await sleep(pollMs);
    }
  }

  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      // Only remove a lock we still own. Another run may have taken over after
      // a stale reclaim, and deleting its lock would let a third importer in.
      const raw = String(readFileSync(lockPath, "utf8") ?? "");
      const parsed = JSON.parse(raw);
      if (Number(parsed?.pid) === pid) {
        unlinkSync(lockPath);
      }
    } catch {
      // Best-effort: a missing lock at release is success, not a problem.
    }
  };

  return { release, waited };
}

/**
 * Snapshot every `*.uid` under `root` (depth-bounded) as path → contents.
 *
 * Cheap: uid files are a few dozen bytes each. Used as the before-image of an
 * isolated Godot run so a regenerated uid (new random id) can be reported as
 * the silent reference-break it is, rather than as a normal file change.
 *
 * @param {string} root
 * @param {{
 *   readdirSync?: typeof fs.readdirSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   maxDepth?: number
 * }} [options]
 * @returns {Map<string, string>} repo-relative posix path → file body
 */
export function snapshotUidFiles(root, options = {}) {
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 12;
  /** @type {Map<string, string>} */
  const out = new Map();

  const skip = new Set([
    ".godot",
    ".import",
    ".git",
    "node_modules",
    ".grok-build",
    ".grok",
    "addons/gut",
    "addons/gdUnit4"
  ]);

  function walk(dir, rel, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : String(entry?.name ?? "");
      if (!name || name === "." || name === "..") {
        continue;
      }
      const childRel = rel ? `${rel}/${name}` : name;
      const childPath = path.join(dir, name);
      const isDir =
        typeof entry !== "string" && typeof entry?.isDirectory === "function"
          ? entry.isDirectory()
          : false;
      const isFile =
        typeof entry !== "string" && typeof entry?.isFile === "function"
          ? entry.isFile()
          : !isDir;

      if (isDir) {
        if (name.startsWith(".") || skip.has(name) || skip.has(childRel)) {
          continue;
        }
        walk(childPath, childRel, depth + 1);
        continue;
      }
      if (isFile && name.endsWith(".uid")) {
        try {
          out.set(childRel, String(readFileSync(childPath, "utf8") ?? ""));
        } catch {
          // Unreadable uid: skip; the integrity check will not invent a false
          // rewrite for a file it never saw.
        }
      }
    }
  }

  if (root) {
    walk(path.resolve(String(root)), "", 0);
  }
  return out;
}

/**
 * Parse a `uid://...` token out of a `.uid` file body.
 *
 * Godot 4 writes a single line `uid://xxxxxxxx`. Anything else is treated as
 * opaque content equality for the rewrite check.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function parseUidToken(body) {
  const match = /^\s*(uid:\/\/[A-Za-z0-9_]+)\s*$/m.exec(String(body ?? ""));
  return match ? match[1] : null;
}

/**
 * Collect every `uid://` reference appearing in text resources under `root`.
 *
 * Bounded walk: only `.tscn`, `.tres`, `.gd`, `.cs` at modest depth. The goal
 * is a cheap integrity signal, not a full asset graph.
 *
 * @param {string} root
 * @param {{
 *   readdirSync?: typeof fs.readdirSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   maxDepth?: number
 * }} [options]
 * @returns {Set<string>}
 */
export function collectUidReferences(root, options = {}) {
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 12;
  const refs = new Set();
  // Include shaders so uid:// references embedded in .gdshader / .gdshaderinc
  // are seen by integrity checks (dissolve effects etc. routinely use them).
  const textExt = new Set([".tscn", ".tres", ".gd", ".cs", ".godot", ".gdshader", ".gdshaderinc"]);
  const skip = new Set([".godot", ".import", ".git", "node_modules", ".grok-build", ".grok"]);

  function walk(dir, rel, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : String(entry?.name ?? "");
      if (!name) {
        continue;
      }
      const childRel = rel ? `${rel}/${name}` : name;
      const childPath = path.join(dir, name);
      const isDir =
        typeof entry !== "string" && typeof entry?.isDirectory === "function"
          ? entry.isDirectory()
          : false;
      if (isDir) {
        if (name.startsWith(".") || skip.has(name)) {
          continue;
        }
        walk(childPath, childRel, depth + 1);
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      if (!textExt.has(ext) && name !== "project.godot") {
        continue;
      }
      let text;
      try {
        text = String(readFileSync(childPath, "utf8") ?? "");
      } catch {
        continue;
      }
      // Cap the scan so a multi-megabyte generated scene cannot blow the
      // integrity check into a multi-second walk.
      const slice = text.length > 512 * 1024 ? text.slice(0, 512 * 1024) : text;
      const re = /uid:\/\/[A-Za-z0-9_]+/g;
      let match;
      while ((match = re.exec(slice)) !== null) {
        refs.add(match[0]);
      }
    }
  }

  if (root) {
    walk(path.resolve(String(root)), "", 0);
  }
  return refs;
}

/**
 * Compare a before-snapshot of `*.uid` files to the tree after an isolated run.
 *
 * A deleted or rewritten `.uid` is the single most damaging silent failure in
 * a Godot repo: Godot 4.4 regenerates a missing one with a NEW RANDOM id, and
 * every `ext_resource uid=` that pointed at the old one silently breaks. A
 * reference with no matching `.uid` on disk is the same class of problem when
 * the companion was never committed.
 *
 * @param {Map<string, string>|Record<string, string>} before
 * @param {string} root worktree path after the run
 * @param {{
 *   readdirSync?: typeof fs.readdirSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   snapshotUidFilesImpl?: typeof snapshotUidFiles,
 *   collectUidReferencesImpl?: typeof collectUidReferences
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   deleted: string[],
 *   rewritten: Array<{ path: string, before: string|null, after: string|null }>,
 *   danglingRefs: string[],
 *   notes: string[]
 * }}
 */
export function checkUidIntegrity(before, root, options = {}) {
  const snapshot = options.snapshotUidFilesImpl ?? snapshotUidFiles;
  const collectRefs = options.collectUidReferencesImpl ?? collectUidReferences;
  const beforeMap =
    before instanceof Map
      ? before
      : new Map(Object.entries(before && typeof before === "object" ? before : {}));

  const after = snapshot(root, options);
  const deleted = [];
  const rewritten = [];

  for (const [rel, body] of beforeMap) {
    if (!after.has(rel)) {
      deleted.push(rel);
      continue;
    }
    const afterBody = after.get(rel);
    if (afterBody !== body) {
      rewritten.push({
        path: rel,
        before: parseUidToken(body),
        after: parseUidToken(afterBody)
      });
    }
  }

  const knownTokens = new Set();
  for (const body of after.values()) {
    const token = parseUidToken(body);
    if (token) {
      knownTokens.add(token);
    }
  }
  // A uid that only exists in the before-image still counts as known for the
  // dangling check if it was rewritten rather than deleted — the rewrite
  // branch already reports that damage. Dangling means "referenced and no
  // .uid on disk carries it".
  const danglingRefs = [];
  for (const ref of collectRefs(root, options)) {
    if (!knownTokens.has(ref)) {
      danglingRefs.push(ref);
    }
  }
  danglingRefs.sort();

  const notes = [];
  if (deleted.length > 0) {
    notes.push(
      `UID integrity: ${deleted.length} *.uid file(s) deleted during the run (${deleted.slice(0, 5).join(", ")}${deleted.length > 5 ? ", …" : ""}). Godot will regenerate each with a NEW RANDOM uid on next open, silently breaking every ext_resource that pointed at the old id.`
    );
  }
  if (rewritten.length > 0) {
    notes.push(
      `UID integrity: ${rewritten.length} *.uid file(s) rewrote their uid:// token (${rewritten
        .slice(0, 3)
        .map((entry) => `${entry.path}: ${entry.before ?? "?"} → ${entry.after ?? "?"}`)
        .join("; ")}${rewritten.length > 3 ? "; …" : ""}). Every ext_resource uid= for the old token is now dangling.`
    );
  }
  if (danglingRefs.length > 0) {
    notes.push(
      `UID integrity: ${danglingRefs.length} uid:// reference(s) have no matching *.uid companion (${danglingRefs.slice(0, 5).join(", ")}${danglingRefs.length > 5 ? ", …" : ""}).`
    );
  }

  return {
    ok: deleted.length === 0 && rewritten.length === 0 && danglingRefs.length === 0,
    deleted,
    rewritten,
    danglingRefs,
    notes
  };
}

/**
 * Detect that a `.blend` in the project is locked/open on Windows.
 *
 * Blender writes through a transient `scene.blend@` sibling and holds the real
 * file open; either condition means a headless verify will fail for an
 * environment reason ("close Blender") that must not look like the agent's
 * fault.
 *
 * @param {string} root
 * @param {{
 *   platform?: string,
 *   readdirSync?: typeof fs.readdirSync,
 *   openSync?: typeof fs.openSync,
 *   closeSync?: typeof fs.closeSync,
 *   maxDepth?: number
 * }} [options]
 * @returns {{ locked: boolean, paths: string[], note: string|null }}
 */
export function detectBlendLocks(root, options = {}) {
  const platform = options.platform ?? process.platform;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const openSync = options.openSync ?? fs.openSync;
  const closeSync = options.closeSync ?? fs.closeSync;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 4;
  const lockedPaths = [];
  const skip = new Set([".git", "node_modules", ".grok-build", ".grok", "__pycache__"]);

  function walk(dir, rel, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = typeof entry === "string" ? entry : String(entry?.name ?? "");
      if (!name) {
        continue;
      }
      const childRel = rel ? `${rel}/${name}` : name;
      const childPath = path.join(dir, name);
      const isDir =
        typeof entry !== "string" && typeof entry?.isDirectory === "function"
          ? entry.isDirectory()
          : false;
      if (isDir) {
        if (name.startsWith(".") || skip.has(name)) {
          continue;
        }
        walk(childPath, childRel, depth + 1);
        continue;
      }
      // `.blend@` is Blender's transient write target. Its presence means a
      // save is in flight or crashed mid-write — either way the real .blend
      // is not safe to open headless.
      if (/\.blend@$/i.test(name) || /\.blend[0-9]+@$/i.test(name)) {
        lockedPaths.push(childRel);
        continue;
      }
      if (!/\.blend$/i.test(name)) {
        continue;
      }
      // Exclusive open is the Windows signal that another process holds the
      // file. On POSIX the same open usually succeeds (advisory locks), so we
      // only attempt it on win32 — a false negative there is preferable to a
      // false positive that blocks every Linux CI run.
      if (platform === "win32") {
        try {
          const fd = openSync(childPath, "r+");
          try {
            closeSync(fd);
          } catch {
            // ignore close errors
          }
        } catch (error) {
          const code = /** @type {NodeJS.ErrnoException} */ (error).code;
          if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
            lockedPaths.push(childRel);
          }
        }
      }
    }
  }

  if (root) {
    walk(path.resolve(String(root)), "", 0);
  }

  if (lockedPaths.length === 0) {
    return { locked: false, paths: [], note: null };
  }

  return {
    locked: true,
    paths: lockedPaths,
    note: `close Blender before verifying: locked .blend file(s) detected (${lockedPaths.slice(0, 5).join(", ")}${lockedPaths.length > 5 ? ", …" : ""}). A headless verify against an open scene fails for an environment reason, not an agent code change.`
  };
}

/**
 * Parse `blender_version_min` from a blender_manifest.toml body.
 *
 * Only the string form (`"4.2.0"`) is accepted; the field is always a string
 * in the official schema. Returns null when absent or unparseable — never
 * throws, because this feeds a pre-flight note rather than a hard gate on
 * detection.
 *
 * @param {string} text
 * @returns {{ major: number, minor: number, patch: number, raw: string }|null}
 */
export function parseBlenderVersionMin(text) {
  const match = /^\s*blender_version_min\s*=\s*"(\d+)\.(\d+)(?:\.(\d+))?"/m.exec(String(text ?? ""));
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
    raw: match[0].includes('"') ? `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ""}` : match[1]
  };
}

/**
 * Parse a version tuple out of `blender --background --version` (or similar)
 * stdout. Blender prints `Blender 4.2.0` on the first line of most builds.
 *
 * @param {string} text
 * @returns {{ major: number, minor: number, patch: number, raw: string }|null}
 */
export function parseBlenderVersionOutput(text) {
  const match = /\bBlender\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(text ?? ""));
  if (!match) {
    return null;
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3] ?? "0", 10);
  return {
    major,
    minor,
    patch,
    raw: match[3] ? `${major}.${minor}.${patch}` : `${major}.${minor}`
  };
}

/**
 * Compare two version tuples. Negative when `a < b`.
 *
 * @param {{ major: number, minor: number, patch: number }} a
 * @param {{ major: number, minor: number, patch: number }} b
 */
export function compareVersionTuples(a, b) {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return (a.patch ?? 0) - (b.patch ?? 0);
}

/**
 * Pre-flight: the detected binary is older than blender_version_min.
 *
 * @param {{ major: number, minor: number, patch: number, raw?: string }|null} binaryVersion
 * @param {{ major: number, minor: number, patch: number, raw?: string }|null} minVersion
 * @returns {string|null} a note when the binary is too old, else null
 */
export function blenderVersionGuardNote(binaryVersion, minVersion) {
  if (!binaryVersion || !minVersion) {
    return null;
  }
  if (compareVersionTuples(binaryVersion, minVersion) < 0) {
    const have = binaryVersion.raw ?? `${binaryVersion.major}.${binaryVersion.minor}.${binaryVersion.patch}`;
    const need = minVersion.raw ?? `${minVersion.major}.${minVersion.minor}.${minVersion.patch}`;
    return `Blender ${have} is older than blender_version_min ${need} declared in blender_manifest.toml; verify is likely to fail before any project code runs. Point tools.blender (or GROK_BUILD_BLENDER_BIN) at a newer install.`;
  }
  return null;
}

/**
 * Cheap summary of a `.tscn` / `.tres` change for the changed-files manifest.
 *
 * Only inspects `ext_resource` lines — the set of external resource paths and
 * uid tokens — because that is the difference that usually matters to a
 * reviewer and stays bounded under a few hundred characters.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @param {string} relPath
 * @returns {string|null} a short annotation, or null when nothing useful to say
 */
export function summarizeSceneResourceChange(beforeText, afterText, relPath) {
  const extract = (text) => {
    const paths = new Set();
    const uids = new Set();
    for (const line of String(text ?? "").split(/\r?\n/)) {
      if (!line.includes("ext_resource")) {
        continue;
      }
      const pathMatch = /\bpath="([^"]+)"/.exec(line);
      if (pathMatch) {
        paths.add(pathMatch[1]);
      }
      const uidMatch = /\buid="(uid:\/\/[^"]+)"/.exec(line);
      if (uidMatch) {
        uids.add(uidMatch[1]);
      }
    }
    return { paths, uids };
  };

  const before = extract(beforeText);
  const after = extract(afterText);
  const addedPaths = [...after.paths].filter((value) => !before.paths.has(value));
  const removedPaths = [...before.paths].filter((value) => !after.paths.has(value));
  const addedUids = [...after.uids].filter((value) => !before.uids.has(value));
  const removedUids = [...before.uids].filter((value) => !after.uids.has(value));

  if (
    addedPaths.length === 0 &&
    removedPaths.length === 0 &&
    addedUids.length === 0 &&
    removedUids.length === 0
  ) {
    return null;
  }

  const bits = [];
  if (addedPaths.length || removedPaths.length) {
    bits.push(
      `ext_resource paths +${addedPaths.length}/-${removedPaths.length}` +
        (addedPaths[0] ? ` (e.g. +${addedPaths[0]})` : removedPaths[0] ? ` (e.g. -${removedPaths[0]})` : "")
    );
  }
  if (addedUids.length || removedUids.length) {
    bits.push(`uids +${addedUids.length}/-${removedUids.length}`);
  }
  const kind = /\.tscn$/i.test(relPath) ? "scene" : "resource";
  return `${kind} edit: ${bits.join(", ")}`;
}
