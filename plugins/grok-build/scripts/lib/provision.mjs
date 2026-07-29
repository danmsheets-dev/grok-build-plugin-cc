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

export function planWorktreeLinks(repoRoot, worktreePath, options = {}) {
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;
  const statSync = options.statSync ?? fs.statSync;
  const kind = platform === "win32" ? "junction" : "symlink";

  const root = path.resolve(String(repoRoot ?? ""));
  const wt = path.resolve(String(worktreePath ?? ""));

  const links = [];
  const notes = [];

  if (!repoRoot || !worktreePath) {
    notes.push("planWorktreeLinks: repoRoot and worktreePath are required");
    return { links, notes };
  }

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

    links.push({ from, to, kind });
  }

  return { links, notes };
}

export function provisionWorktree(plan, options = {}) {
  const symlinkSync = options.symlinkSync ?? fs.symlinkSync;
  const mkdirSync = options.mkdirSync ?? fs.mkdirSync;
  const existsSync = options.existsSync ?? fs.existsSync;

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
      } else {
        failed.push({ ...link, reason: `unknown kind: ${link.kind}` });
        continue;
      }
      provisioned.push({ from: link.from, to: link.to, kind: link.kind });
    } catch (error) {
      failed.push({ from: link.from, to: link.to, kind: link.kind, reason: error.message });
    }
  }

  return { provisioned, failed, notes };
}