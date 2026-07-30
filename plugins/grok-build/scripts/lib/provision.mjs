import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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

/**
 * The warning that has to reach the run header whenever `.godot` is linked.
 *
 * The README already promises that writes reach the real directories; nothing
 * said it at the moment it matters, which is when a Godot editor is open on the
 * same cache a headless verify run is about to reimport into.
 */
export const GODOT_SHARED_CACHE_NOTE =
  ".godot is shared with your working copy; close the Godot editor before running verify.";

function godotCacheIsCopied(options, env) {
  if (options.copyGodotCache !== undefined) {
    return Boolean(options.copyGodotCache);
  }
  const raw = env?.[LINK_GODOT_CACHE_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return false;
  }
  const normalized = String(raw).trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no";
}

export function planWorktreeLinks(repoRoot, worktreePath, options = {}) {
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;
  const statSync = options.statSync ?? fs.statSync;
  // The sole production caller passes no options at all, so the default has to
  // be the real environment rather than an empty object.
  const env = options.env ?? process.env;
  const kind = platform === "win32" ? "junction" : "symlink";
  const copyGodotCache = godotCacheIsCopied(options, env);

  const root = path.resolve(String(repoRoot ?? ""));
  const wt = path.resolve(String(worktreePath ?? ""));

  const links = [];
  const notes = [];

  if (!repoRoot || !worktreePath) {
    notes.push("planWorktreeLinks: repoRoot and worktreePath are required");
    return { links, notes };
  }

  let linkedGodotCache = false;

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

  if (copyGodotCache) {
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
    notes.push(
      copied.length > 0
        ? `Godot import cache is copied, not shared (${LINK_GODOT_CACHE_ENV}=0): seeded ${copied.join(", ")}. The first verify may re-import assets.`
        : `Godot import cache is copied, not shared (${LINK_GODOT_CACHE_ENV}=0): nothing to seed, so the first verify runs a cold import.`
    );
  } else if (linkedGodotCache) {
    notes.push(GODOT_SHARED_CACHE_NOTE);
  }

  return { links, notes };
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