import { test, describe, beforeEach, assert, mock } from "node:test";
import assertModule from "node:assert";
import path from "node:path";
import fs from "node:fs";

import {
  BLENDER_SANDBOX_SCRIPTS_RELATIVE,
  CARGO_TARGET_DIR_RELATIVE,
  GODOT_CACHE_DIRS,
  GODOT_SHARED_CACHE_NOTE,
  PROVISION_COPY_FILES,
  PROVISION_COPY_PATHS,
  PROVISION_DIR_POLICY,
  PROVISION_LINK_DIRS,
  diffSharedFingerprints,
  fingerprintDir,
  fingerprintSharedDirs,
  hardlinkSeedPathSync,
  injectRuntimePlugin,
  planBlenderScriptSandbox,
  planWorktreeLinks,
  provisionWorktree,
  resolveDirPolicy,
  sameVolume,
  shouldAutoBlenderSandbox
} from "../plugins/grok-build/scripts/lib/provision.mjs";
import { artifactExcludePathspecs } from "../plugins/grok-build/scripts/lib/worktree.mjs";
import { makeTempDir } from "./helpers.mjs";

/**
 * The genuine fs implementations, captured before any hook has run.
 *
 * `mock` in this file is node:test's GLOBAL MockTracker, and the beforeEach
 * hooks below re-mock the same fs methods for every test, stacking one mock on
 * top of another. `mock.restoreAll()` unwinds them in registration order, so
 * the last restore reinstates the PREVIOUS MOCK rather than the real function
 * and fs never actually comes back. Any test that needs a real filesystem has
 * to hold its own references from module load time.
 */
const realFs = {
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  mkdirSync: fs.mkdirSync,
  readdirSync: fs.readdirSync,
  copyFileSync: fs.copyFileSync,
  symlinkSync: fs.symlinkSync,
  linkSync: fs.linkSync,
  writeFileSync: fs.writeFileSync,
  readFileSync: fs.readFileSync,
  rmSync: fs.rmSync
};

describe("PROVISION_LINK_DIRS", () => {
  test("contains node_modules and is frozen", () => {
    assertModule.ok(Array.isArray(PROVISION_LINK_DIRS));
    assertModule.ok(PROVISION_LINK_DIRS.includes("node_modules"));
    assertModule.ok(Object.isFrozen(PROVISION_LINK_DIRS));
  });
});

describe("planWorktreeLinks", () => {
  let fsMock;
  let existsSyncMock;
  let statSyncMock;

  beforeEach(() => {
    fsMock = {};
    existsSyncMock = mock.method(fs, "existsSync", () => false);
    statSyncMock = mock.method(fs, "statSync", () => ({ isDirectory: () => true }));
  });

  test("returns notes when repoRoot or worktreePath missing", () => {
    const result = planWorktreeLinks("", "");
    assertModule.ok(result.notes.some(n => n.includes("required")));
    assertModule.deepStrictEqual(result.links, []);
  });

  test("skips missing source directories", () => {
    const plan = planWorktreeLinks("/repo", "/wt", { platform: "linux", existsSync: () => false });
    assertModule.deepStrictEqual(plan.links, []);
  });

  test("skips non-directory sources", () => {
    const statSync = mock.method(fs, "statSync", () => ({ isDirectory: () => false, isFile: () => false }));
    // existsSync true for every path also makes Cargo.toml look present, so the
    // cargo-target mkdir may still be planned; the assert is that no real dir
    // was linked/seeded from a non-directory source.
    const plan = planWorktreeLinks("/repo", "/wt", { platform: "linux", existsSync: () => true, statSync });
    assertModule.ok(plan.notes.some(n => n.includes("not a directory")));
    assertModule.ok(
      !plan.links.some((l) => ["junction", "symlink", "hardlink-seed", "copy"].includes(l.kind)),
      `non-directory sources must not be linked/seeded, got ${JSON.stringify(plan.links)}`
    );
  });

  test("uses junction on windows, symlink on linux for share-tier dirs only", () => {
    // vendor is the only default share-tier entry; live-state dirs are private.
    const existsSync = mock.method(fs, "existsSync", (p) => String(p).endsWith("vendor"));
    const statSync = mock.method(fs, "statSync", () => ({ isDirectory: () => true }));
    const win = planWorktreeLinks("/repo", "/wt", { platform: "win32", existsSync, statSync });
    const lin = planWorktreeLinks("/repo", "/wt", { platform: "linux", existsSync, statSync });
    assertModule.ok(win.links.length > 0);
    for (const link of win.links) {
      assertModule.strictEqual(link.kind, "junction");
    }
    for (const link of lin.links) {
      assertModule.strictEqual(link.kind, "symlink");
    }
  });

  test("live-state dirs are private (hardlink-seed / env), not shared junctions", () => {
    const existsSync = mock.method(fs, "existsSync", (p) => {
      const s = String(p);
      return s.endsWith("node_modules") || s.endsWith("target") || s.endsWith(".venv");
    });
    const statSync = mock.method(fs, "statSync", () => ({ isDirectory: () => true }));
    const plan = planWorktreeLinks("/repo", "/wt", { platform: "linux", existsSync, statSync });
    const nm = plan.links.find((l) => path.basename(l.from) === "node_modules");
    assertModule.ok(nm, "node_modules must be planned");
    assertModule.strictEqual(nm.kind, "hardlink-seed");
    assertModule.ok(!plan.links.some((l) => path.basename(l.from) === ".venv" && (l.kind === "symlink" || l.kind === "junction")));
    const venv = plan.links.find((l) => path.basename(l.from) === ".venv");
    assertModule.ok(venv);
    assertModule.strictEqual(venv.kind, "hardlink-seed");
    // target uses CARGO_TARGET_DIR, not a link into main target/
    assertModule.ok(plan.env.CARGO_TARGET_DIR);
    assertModule.ok(String(plan.env.CARGO_TARGET_DIR).includes(CARGO_TARGET_DIR_RELATIVE.replace(/\//g, path.sep)) ||
      String(plan.env.CARGO_TARGET_DIR).includes("cargo-target"));
    assertModule.ok(plan.privateDirs.includes("target"));
    assertModule.ok(plan.privateDirs.includes("node_modules"));
    assertModule.ok(!plan.sharedDirs.includes("node_modules"));
  });

  test("includes PROVISION_LINK_DIRS entries when they exist as directories", () => {
    const existsSync = mock.method(fs, "existsSync", (p) => p.endsWith("node_modules") || p.endsWith("vendor"));
    const statSync = mock.method(fs, "statSync", () => ({ isDirectory: () => true }));
    const plan = planWorktreeLinks("/repo", "/wt", { platform: "linux", existsSync, statSync });
    const names = plan.links.map((l) => path.basename(l.from === l.to ? l.to : l.from));
    assertModule.ok(names.includes("node_modules"));
    assertModule.ok(names.includes("vendor"));
  });
});

describe("provisionWorktree", () => {
  let existsSyncMock;
  let mkdirSyncMock;
  let symlinkSyncMock;

  beforeEach(() => {
    existsSyncMock = mock.method(fs, "existsSync", (p) => p.includes("target"));
    mkdirSyncMock = mock.method(fs, "mkdirSync", () => {});
    symlinkSyncMock = mock.method(fs, "symlinkSync", () => {});
  });

  test("records destination already exists when existsSync returns true for both", () => {
    const plan = { links: [{ from: "/repo/node_modules", to: "/wt/node_modules", kind: "symlink" }], notes: [] };
    const existsSync = mock.method(fs, "existsSync", () => true);
    const result = provisionWorktree(plan, { existsSync, mkdirSync: () => {}, symlinkSync: () => {} });
    assertModule.ok(result.failed.some(f => f.reason === "destination already exists"));
    assertModule.ok(!symlinkSyncMock.mock.calls.length);
  });

  test("symlinkSync called with junction on windows", () => {
    const plan = { links: [{ from: "/repo/node_modules", to: "/wt/node_modules", kind: "junction" }], notes: [] };
    const symlinkSync = mock.method(fs, "symlinkSync", () => {});
    const existsSync = mock.method(fs, "existsSync", (p) => p.includes("repo"));
    const result = provisionWorktree(plan, { symlinkSync, existsSync, mkdirSync: () => {} });
    assertModule.strictEqual(result.provisioned.length, 1);
    const call = symlinkSync.mock.calls[0];
    assertModule.ok(call);
    assertModule.strictEqual(call.arguments[2], "junction");
  });

  test("does not throw when symlinkSync throws", () => {
    const plan = { links: [{ from: "/repo/node_modules", to: "/wt/node_modules", kind: "symlink" }], notes: [] };
    const symlinkSync = mock.method(fs, "symlinkSync", () => { throw new Error("EPERM"); });
    const existsSync = mock.method(fs, "existsSync", (p) => p.includes("repo"));
    const result = provisionWorktree(plan, { symlinkSync, existsSync, mkdirSync: () => {} });
    assertModule.strictEqual(result.provisioned.length, 0);
    assertModule.strictEqual(result.failed.length, 1);
    assertModule.ok(result.failed[0].reason.includes("EPERM"));
  });

  test("records failed with reason when source missing", () => {
    const plan = { links: [{ from: "/repo/missing", to: "/wt/missing", kind: "symlink" }], notes: [] };
    const result = provisionWorktree(plan, { existsSync: () => false, mkdirSync: () => {}, symlinkSync: () => {} });
    assertModule.strictEqual(result.failed.length, 1);
    assertModule.ok(result.failed[0].reason.includes("source missing"));
  });

  test("creates parent directories before linking", () => {
    const mkdirSync = mock.method(fs, "mkdirSync", () => {});
    const plan = { links: [{ from: "/repo/node_modules", to: "/wt/node_modules", kind: "symlink" }], notes: [] };
    const existsSync = mock.method(fs, "existsSync", (p) => p.includes("repo"));
    provisionWorktree(plan, { mkdirSync, existsSync, symlinkSync: () => {} });
    assertModule.ok(mkdirSync.mock.calls.length > 0);
  });

  test("preserves plan notes in result", () => {
    const plan = { links: [], notes: ["note1", "note2"] };
    const result = provisionWorktree(plan, { existsSync: () => false, mkdirSync: () => {}, symlinkSync: () => {} });
    assertModule.deepStrictEqual(result.notes, ["note1", "note2"]);
  });
});
test("provisionWorktree does not throw when mkdirSync fails", () => {
  // Regression: mkdirSync sat outside the try/catch, so a failing directory
  // creation propagated and failed the entire run rather than one link.
  const plan = { links: [{ from: "/src/node_modules", to: "/wt/node_modules", kind: "junction" }] };
  let result;
  // node:test's bundled assert is a subset and has no doesNotThrow; this file
  // imports the full module as assertModule.
  assertModule.doesNotThrow(() => {
    result = provisionWorktree(plan, {
      existsSync: (p) => String(p).includes("/src/"),
      mkdirSync: () => {
        throw new Error("EPERM: operation not permitted");
      },
      symlinkSync: () => {}
    });
  });
  assertModule.equal(result.provisioned.length, 0);
  assertModule.equal(result.failed.length, 1);
  assertModule.match(result.failed[0].reason, /EPERM/);
});

describe("Godot import cache tier", () => {
  const godotOnly = (p) => String(p).endsWith(".godot") || String(p).includes(".godot" + path.sep);
  const dirStat = () => ({ isDirectory: () => true });

  test("the isolated default is a private cache, not a shared link", () => {
    // Field session: concurrent editor + headless import clobbered
    // global_script_class_cache.cfg and produced bogus parse errors. Private
    // by default under isolation; GROK_BUILD_LINK_GODOT_CACHE=1 opts back in.
    const plan = planWorktreeLinks("/repo", "/wt", {
      platform: "linux",
      existsSync: (p) => String(p).endsWith(".godot") || String(p).includes(".godot" + path.sep),
      statSync: dirStat,
      env: {}
    });

    assertModule.ok(!plan.links.some((link) => path.basename(link.from) === ".godot"));
    assertModule.ok(
      plan.notes.some((note) => /Godot cache: private to this run/i.test(note)),
      `expected private-cache line, got: ${JSON.stringify(plan.notes)}`
    );
    assertModule.ok(
      plan.notes.some((note) => /Shared-cache lock skipped/i.test(note)),
      `private cache must say the lock is skipped, got: ${JSON.stringify(plan.notes)}`
    );
    assertModule.ok(!plan.notes.includes(GODOT_SHARED_CACHE_NOTE));
  });

  test("GROK_BUILD_LINK_GODOT_CACHE=1 restores the shared link and warning", () => {
    const plan = planWorktreeLinks("/repo", "/wt", {
      platform: "linux",
      existsSync: (p) => String(p).endsWith(".godot"),
      statSync: dirStat,
      env: { GROK_BUILD_LINK_GODOT_CACHE: "1" }
    });

    const godot = plan.links.find((link) => path.basename(link.from) === ".godot");
    assertModule.ok(godot, "explicit link opt-in must still link .godot");
    assertModule.strictEqual(godot.kind, "symlink");
    assertModule.ok(
      plan.notes.includes(GODOT_SHARED_CACHE_NOTE),
      `the shared-cache warning is mandatory when shared, got: ${JSON.stringify(plan.notes)}`
    );
    assertModule.match(GODOT_SHARED_CACHE_NOTE, /close the Godot editor/i);
    assertModule.ok(plan.notes.some((note) => /shared with your working copy/i.test(note)));
  });

  test("a linked repo with no Godot cache gets no warning", () => {
    // The discriminator: the warning must be about a cache that is actually
    // shared, not boilerplate on every isolated run.
    const plan = planWorktreeLinks("/repo", "/wt", {
      platform: "linux",
      existsSync: (p) => String(p).endsWith("node_modules"),
      statSync: dirStat,
      env: {}
    });
    assertModule.ok(plan.links.length > 0);
    assertModule.ok(!plan.notes.includes(GODOT_SHARED_CACHE_NOTE));
  });

  test("GROK_BUILD_LINK_GODOT_CACHE=0 swaps the link for a seeded cold cache", () => {
    const plan = planWorktreeLinks("/repo", "/wt", {
      platform: "win32",
      existsSync: godotOnly,
      statSync: dirStat,
      env: { GROK_BUILD_LINK_GODOT_CACHE: "0" }
    });

    const names = plan.links.map((link) => path.basename(link.from));
    assertModule.ok(!plan.links.some((link) => link.kind === "junction"), "no .godot junction");
    assertModule.ok(names.includes("uid_cache.bin"), `expected a seeded uid_cache.bin, got ${names}`);
    for (const link of plan.links) {
      // Private seed uses hardlink-seed (falls back to copy on EXDEV).
      assertModule.ok(
        link.kind === "hardlink-seed" || link.kind === "copy",
        `unexpected kind ${link.kind}`
      );
    }
    assertModule.ok(
      plan.notes.some((note) => /private to this run|not shared|seeded/i.test(note)),
      `the opt-out has to explain itself, got: ${JSON.stringify(plan.notes)}`
    );
    // The warning is about a SHARED cache; a copied one is not shared.
    assertModule.ok(!plan.notes.includes(GODOT_SHARED_CACHE_NOTE));
  });

  test("the copy tier never seeds .godot/imported, which is the gigabyte part", () => {
    // Copying it synchronously per run costs more than the cold import the
    // link exists to avoid, which is the whole reason the default stays a link.
    for (const entry of PROVISION_COPY_PATHS) {
      assertModule.ok(
        !entry.startsWith(".godot/imported"),
        `${entry} must not be in the copy set`
      );
    }
    assertModule.deepStrictEqual([...GODOT_CACHE_DIRS], [".godot", ".import"]);
  });

  test("a skipped .godot is absent from links, never a link with an unknown kind", () => {
    // provisionWorktree routes any kind it does not recognise into its
    // `unknown kind:` FAILURE branch, so a deliberate skip expressed as a
    // pseudo-kind would be reported to the user as a provisioning failure.
    const plan = planWorktreeLinks("/repo", "/wt", {
      platform: "linux",
      existsSync: godotOnly,
      statSync: dirStat,
      copyGodotCache: true
    });
    const result = provisionWorktree(plan, {
      existsSync: (p) => String(p).startsWith("/repo"),
      mkdirSync: () => {},
      symlinkSync: () => {},
      statSync: () => ({ isDirectory: () => false }),
      copyFileSync: () => {},
      readdirSync: () => []
    });
    assertModule.ok(
      !result.failed.some((entry) => String(entry.reason).includes("unknown kind")),
      `got: ${JSON.stringify(result.failed)}`
    );
  });

  test("a copied cache is private: writes in the worktree never reach the repo", () => {
    // The entire point of the opt-out. Real filesystem via `realFs` (see the
    // note at the top of this file) - a mock cannot demonstrate the absence of
    // a write-through.
    const repo = makeTempDir("grok-provision-copy-repo-");
    const wt = makeTempDir("grok-provision-copy-wt-");
    realFs.mkdirSync(path.join(repo, ".godot", "imported"), { recursive: true });
    realFs.writeFileSync(path.join(repo, ".godot", "uid_cache.bin"), "seed");
    realFs.writeFileSync(path.join(repo, ".godot", "imported", "huge.ctex"), "x".repeat(64));

    const plan = planWorktreeLinks(repo, wt, {
      env: { GROK_BUILD_LINK_GODOT_CACHE: "0" },
      existsSync: realFs.existsSync,
      statSync: realFs.statSync
    });
    const result = provisionWorktree(plan, realFs);

    assertModule.deepStrictEqual(result.failed, []);
    assertModule.strictEqual(
      realFs.readFileSync(path.join(wt, ".godot", "uid_cache.bin"), "utf8"),
      "seed"
    );
    assertModule.ok(
      !realFs.existsSync(path.join(wt, ".godot", "imported")),
      ".godot/imported must not be copied"
    );

    realFs.writeFileSync(path.join(wt, ".godot", "written_by_the_run.bin"), "new");
    assertModule.ok(
      !realFs.existsSync(path.join(repo, ".godot", "written_by_the_run.bin")),
      "a copied cache must not write through to the user's working copy"
    );
  });
});

describe("planBlenderScriptSandbox", () => {
  // Every call passes the REAL fs explicitly (see the realFs note at the top of
  // this file: the describes above leave node:test's global MockTracker holding
  // fs). Nothing here starts Blender - the plan is pure filesystem reading.
  const io = {
    existsSync: realFs.existsSync,
    readdirSync: realFs.readdirSync,
    readFileSync: realFs.readFileSync,
    env: {}
  };

  function seedAddon(prefix, files) {
    const wt = makeTempDir(prefix);
    for (const [relative, body] of Object.entries(files)) {
      const target = path.join(wt, ...relative.split("/"));
      realFs.mkdirSync(path.dirname(target), { recursive: true });
      realFs.writeFileSync(target, body, "utf8");
    }
    return wt;
  }

  test("a depth-1 bl_info add-on is linked into the worktree's own scripts directory", () => {
    const wt = seedAddon("grok-blender-sandbox-", {
      "myaddon/__init__.py": 'bl_info = {"name": "My Addon", "blender": (4, 2, 0)}\n',
      "myaddon/ops.py": "import bpy\n"
    });

    const plan = planBlenderScriptSandbox(wt, { ...io, platform: "win32" });

    assertModule.strictEqual(plan.links.length, 1);
    assertModule.strictEqual(plan.addonName, "myaddon");
    assertModule.strictEqual(plan.links[0].from, path.join(wt, "myaddon"));
    assertModule.strictEqual(
      plan.links[0].to,
      path.join(wt, ".grok-build", "blender", "scripts", "addons", "myaddon")
    );
    // Windows has no symlink privilege by default; a junction needs none.
    assertModule.strictEqual(plan.links[0].kind, "junction");
    assertModule.strictEqual(
      plan.env.BLENDER_USER_SCRIPTS,
      path.join(wt, ...BLENDER_SANDBOX_SCRIPTS_RELATIVE.split("/"))
    );
    assertModule.ok(
      plan.env.BLENDER_USER_SCRIPTS.startsWith(wt),
      "the sandbox must live inside the worktree, or it is not isolation"
    );
    assertModule.ok(plan.env.BLENDER_USER_EXTENSIONS.startsWith(wt));
  });

  test("BLENDER_USER_CONFIG is never set, whatever the layout", () => {
    // Cycles' GPU device selection and every add-on preference live in
    // userpref.blend under that directory. Pointing it at an empty sandbox
    // silently forces CPU rendering and drops the user's preferences, which is
    // a far worse trade than the one the sandbox is making.
    const layouts = [
      { "myaddon/__init__.py": "bl_info = {}\n" },
      { "blender_manifest.toml": 'id = "my_ext"\n' },
      { "addon/blender_manifest.toml": 'id = "my_ext"\n' }
    ];
    for (const files of layouts) {
      const wt = seedAddon("grok-blender-config-", files);
      const plan = planBlenderScriptSandbox(wt, { ...io, platform: "linux" });
      assertModule.ok(plan.links.length === 1, JSON.stringify(files));
      assertModule.deepStrictEqual(
        Object.keys(plan.env).sort(),
        ["BLENDER_USER_EXTENSIONS", "BLENDER_USER_SCRIPTS"],
        `only these two may be set, got ${Object.keys(plan.env)}`
      );
    }
  });

  test("off win32 the link is a symlink, not a junction", () => {
    const wt = seedAddon("grok-blender-symlink-", {
      "myaddon/__init__.py": "bl_info = {}\n"
    });
    const plan = planBlenderScriptSandbox(wt, { ...io, platform: "linux" });
    assertModule.strictEqual(plan.links[0].kind, "symlink");
  });

  test("a 4.2+ extension manifest is detected as well as bl_info", () => {
    const wt = seedAddon("grok-blender-manifest-", {
      "myext/blender_manifest.toml": 'schema_version = "1.0.0"\nid = "myext"\n'
    });
    const plan = planBlenderScriptSandbox(wt, { ...io, platform: "linux" });
    assertModule.strictEqual(plan.addonName, "myext");
    assertModule.strictEqual(plan.links[0].from, path.join(wt, "myext"));
  });

  test("a plain Python package is not an add-on and is left alone", () => {
    // The discriminator for the whole feature: sandboxing a non-add-on would
    // hide the user's real add-ons and buy nothing.
    const wt = seedAddon("grok-blender-plain-", {
      "mypkg/__init__.py": "from .core import main\n",
      "mypkg/core.py": "def main():\n    pass\n"
    });

    const plan = planBlenderScriptSandbox(wt, { ...io, platform: "linux" });

    assertModule.deepStrictEqual(plan.links, []);
    assertModule.deepStrictEqual(plan.env, {});
    assertModule.strictEqual(plan.scriptsDir, null);
    assertModule.ok(
      plan.notes.some((note) => note.includes("no add-on")),
      `the user has to be told nothing was sandboxed, got: ${JSON.stringify(plan.notes)}`
    );
  });

  test("a .blend scene with no add-on is a Blender project, not something to sandbox", () => {
    const wt = seedAddon("grok-blender-scene-", { "scene.blend": "BLENDER\n" });
    const plan = planBlenderScriptSandbox(wt, { ...io, platform: "linux" });
    assertModule.deepStrictEqual(plan.links, []);
    assertModule.deepStrictEqual(plan.env, {});
  });

  test("a root-level add-on is linked under the repository's name, never the run id", () => {
    // The worktree's basename is a run id ("run-20260101-abcd"), which is not a
    // Python module name and not what the developer's own symlink was called.
    const wt = seedAddon("grok-blender-root-", {
      "__init__.py": 'bl_info = {"name": "Root Addon"}\n'
    });
    const plan = planBlenderScriptSandbox(wt, {
      ...io,
      platform: "linux",
      repoRoot: path.join(path.dirname(wt), "my_real_addon")
    });
    assertModule.strictEqual(plan.addonName, "my_real_addon");
    assertModule.strictEqual(plan.links[0].from, wt);
  });

  test("the plan says out loud that a sandboxed add-on is not auto-enabled", () => {
    const wt = seedAddon("grok-blender-enable-", {
      "myaddon/__init__.py": "bl_info = {}\n"
    });
    const plan = planBlenderScriptSandbox(wt, { ...io, platform: "linux" });
    assertModule.ok(
      plan.notes.some((note) => note.includes("addon_utils.enable")),
      `got: ${JSON.stringify(plan.notes)}`
    );
  });

  test("provisionWorktree materialises the sandbox and the add-on is reachable through it", () => {
    // Real filesystem, real link. On win32 that is a junction, which needs no
    // elevation; elsewhere a directory symlink.
    const wt = seedAddon("grok-blender-provision-", {
      "myaddon/__init__.py": "bl_info = {}\n",
      "myaddon/ops.py": "MARKER\n"
    });

    const plan = planBlenderScriptSandbox(wt, io);
    const result = provisionWorktree(plan, realFs);

    assertModule.deepStrictEqual(result.failed, []);
    assertModule.strictEqual(result.provisioned.length, 1);
    assertModule.strictEqual(
      realFs.readFileSync(
        path.join(plan.env.BLENDER_USER_SCRIPTS, "addons", "myaddon", "ops.py"),
        "utf8"
      ),
      "MARKER\n"
    );
    // The extensions sandbox is deliberately NOT created: an absent directory
    // is how "this run sees none of your installed extensions" is expressed.
    assertModule.ok(!realFs.existsSync(plan.env.BLENDER_USER_EXTENSIONS));
  });
});

describe("PROVISION_LINK_DIRS ecosystem coverage", () => {
  test("includes Godot's asset import caches for both Godot 3 and 4", () => {
    assertModule.ok(PROVISION_LINK_DIRS.includes(".godot"), "Godot 4 import cache");
    assertModule.ok(PROVISION_LINK_DIRS.includes(".import"), "Godot 3 import cache");
  });

  test("includes Python tox and PDM environments", () => {
    assertModule.ok(PROVISION_LINK_DIRS.includes(".tox"));
    assertModule.ok(PROVISION_LINK_DIRS.includes("__pypackages__"));
  });

  test("includes common JS/web framework build caches", () => {
    for (const dir of [".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache"]) {
      assertModule.ok(PROVISION_LINK_DIRS.includes(dir), `missing ${dir}`);
    }
  });
});

describe("PROVISION_DIR_POLICY classification", () => {
  test("classifies live-state dirs as copy/env and vendor as share", () => {
    assertModule.strictEqual(PROVISION_DIR_POLICY.node_modules, "copy");
    assertModule.strictEqual(PROVISION_DIR_POLICY[".venv"], "copy");
    assertModule.strictEqual(PROVISION_DIR_POLICY.venv, "copy");
    assertModule.strictEqual(PROVISION_DIR_POLICY.target, "env");
    assertModule.strictEqual(PROVISION_DIR_POLICY[".godot"], "copy");
    assertModule.strictEqual(PROVISION_DIR_POLICY[".import"], "copy");
    assertModule.strictEqual(PROVISION_DIR_POLICY.vendor, "share");
    for (const name of PROVISION_LINK_DIRS) {
      assertModule.ok(
        Object.prototype.hasOwnProperty.call(PROVISION_DIR_POLICY, name),
        `missing policy for ${name}`
      );
    }
  });

  test("resolveDirPolicy honours overrides and Godot share opt-in", () => {
    assertModule.strictEqual(resolveDirPolicy("node_modules", { env: {} }), "copy");
    assertModule.strictEqual(
      resolveDirPolicy("node_modules", { dirPolicy: { node_modules: "share" }, env: {} }),
      "share"
    );
    assertModule.strictEqual(resolveDirPolicy(".godot", { env: {} }), "copy");
    assertModule.strictEqual(
      resolveDirPolicy(".godot", { env: { GROK_BUILD_LINK_GODOT_CACHE: "1" } }),
      "share"
    );
  });
});

describe("sameVolume and hardlink-seed fallback", () => {
  test("sameVolume is true for two paths on the same root", () => {
    const a = path.join(process.cwd(), "a");
    const b = path.join(process.cwd(), "b");
    assertModule.equal(sameVolume(a, b, { platform: process.platform, statSync: realFs.statSync }), true);
  });

  test("sameVolume is false across Windows drive letters", () => {
    assertModule.equal(
      sameVolume("C:\\repo\\node_modules", "D:\\wt\\node_modules", { platform: "win32" }),
      false
    );
  });

  test("hardlinkSeedPathSync hardlinks on same volume and isolates writes", () => {
    const repo = makeTempDir("grok-seed-repo-");
    const wt = makeTempDir("grok-seed-wt-");
    const from = path.join(repo, "node_modules");
    const to = path.join(wt, "node_modules");
    realFs.mkdirSync(path.join(from, "pkg"), { recursive: true });
    realFs.writeFileSync(path.join(from, "pkg", "index.js"), "module.exports=1\n");

    const seed = hardlinkSeedPathSync(from, to, realFs);
    assertModule.ok(seed.mode === "hardlink" || seed.mode === "copy", seed.detail);
    assertModule.equal(realFs.readFileSync(path.join(to, "pkg", "index.js"), "utf8"), "module.exports=1\n");

    // New file in the worktree must not appear in the main checkout when we
    // seeded (hardlink shares file content but not directory entries).
    realFs.writeFileSync(path.join(to, "pkg", "new-from-run.js"), "x\n");
    assertModule.ok(
      !realFs.existsSync(path.join(from, "pkg", "new-from-run.js")),
      "new files in a private seed must not appear in the main tree"
    );
  });

  test("hardlinkSeedPathSync falls back to copy when linkSync throws EXDEV", () => {
    const repo = makeTempDir("grok-exdev-repo-");
    const wt = makeTempDir("grok-exdev-wt-");
    const from = path.join(repo, "file.txt");
    const to = path.join(wt, "file.txt");
    realFs.writeFileSync(from, "payload\n");

    const result = hardlinkSeedPathSync(from, to, {
      ...realFs,
      linkSync: () => {
        const err = new Error("cross-device link not permitted");
        /** @type {NodeJS.ErrnoException} */ (err).code = "EXDEV";
        throw err;
      }
    });
    assertModule.strictEqual(result.mode, "copy");
    assertModule.match(String(result.detail), /EXDEV|cross-volume|copied/i);
    assertModule.equal(realFs.readFileSync(to, "utf8"), "payload\n");
  });
});

describe("runtime file provisioning", () => {
  test("PROVISION_COPY_FILES lists dotenv and local settings", () => {
    for (const name of [".env", ".env.local", ".npmrc", "local_settings.py", "secrets.json"]) {
      assertModule.ok(PROVISION_COPY_FILES.includes(name), `missing ${name}`);
    }
  });

  test("planWorktreeLinks copies runtime files that exist at the repo root", () => {
    const existsSync = (p) => {
      const s = String(p).replace(/\\/g, "/");
      return s.endsWith("/.env") || s.endsWith("/local_settings.py");
    };
    const statSync = () => ({ isDirectory: () => false, isFile: () => true });
    const plan = planWorktreeLinks("/repo", "/wt", {
      platform: "linux",
      existsSync,
      statSync,
      env: {}
    });
    const envLink = plan.links.find((l) => path.basename(l.from) === ".env");
    assertModule.ok(envLink, `expected .env copy, got ${JSON.stringify(plan.links)}`);
    assertModule.strictEqual(envLink.kind, "copy");
    assertModule.ok(plan.notes.some((n) => /Runtime files copied/i.test(n) && n.includes(".env")));
  });

  test("provisionWorktree materialises a copied .env without linking", () => {
    const repo = makeTempDir("grok-dotenv-repo-");
    const wt = makeTempDir("grok-dotenv-wt-");
    realFs.writeFileSync(path.join(repo, ".env"), "SECRET=do-not-leak\n");
    realFs.writeFileSync(path.join(repo, ".npmrc"), "//registry.npmjs.org/:_authToken=x\n");

    const plan = planWorktreeLinks(repo, wt, {
      existsSync: realFs.existsSync,
      statSync: realFs.statSync,
      env: {}
    });
    const result = provisionWorktree(plan, realFs);
    assertModule.deepStrictEqual(result.failed, []);
    assertModule.equal(realFs.readFileSync(path.join(wt, ".env"), "utf8"), "SECRET=do-not-leak\n");
    assertModule.equal(
      realFs.readFileSync(path.join(wt, ".npmrc"), "utf8"),
      "//registry.npmjs.org/:_authToken=x\n"
    );
    // Mutating the worktree copy must not touch main.
    realFs.writeFileSync(path.join(wt, ".env"), "SECRET=mutated\n");
    assertModule.equal(realFs.readFileSync(path.join(repo, ".env"), "utf8"), "SECRET=do-not-leak\n");
  });

  test("artifact excludes cover provisioned runtime files", () => {
    const specs = artifactExcludePathspecs();
    for (const name of PROVISION_COPY_FILES) {
      assertModule.ok(
        specs.some((s) => s.includes(name)),
        `exclude list missing ${name}: ${specs.filter((s) => s.includes("env") || s.includes("npmrc")).join(",")}`
      );
    }
  });
});

describe("shared-dir fingerprint post-run assertion", () => {
  test("fingerprintDir reports entry count and max mtime", () => {
    const dir = makeTempDir("grok-fp-");
    realFs.writeFileSync(path.join(dir, "a.txt"), "a");
    realFs.writeFileSync(path.join(dir, "b.txt"), "b");
    const fp = fingerprintDir(dir, realFs);
    assertModule.equal(fp.exists, true);
    assertModule.equal(fp.entryCount, 2);
    assertModule.ok(fp.maxMtimeMs > 0);
  });

  test("diffSharedFingerprints detects mutation of a shared dir", () => {
    const repo = makeTempDir("grok-fp-repo-");
    const vendor = path.join(repo, "vendor");
    realFs.mkdirSync(vendor, { recursive: true });
    realFs.writeFileSync(path.join(vendor, "pkg.go"), "package pkg\n");

    const before = fingerprintSharedDirs(repo, ["vendor"], realFs);
    realFs.writeFileSync(path.join(vendor, "new.go"), "package pkg\n");
    // Ensure mtime advances on filesystems with coarse resolution.
    const afterStat = realFs.statSync(path.join(vendor, "new.go"));
    assertModule.ok(afterStat);
    const after = fingerprintSharedDirs(repo, ["vendor"], realFs);
    const changed = diffSharedFingerprints(before, after);
    assertModule.deepStrictEqual(changed, ["vendor"]);
  });

  test("diffSharedFingerprints is empty when nothing changed", () => {
    const before = { vendor: { exists: true, entryCount: 1, maxMtimeMs: 100 } };
    const after = { vendor: { exists: true, entryCount: 1, maxMtimeMs: 100 } };
    assertModule.deepStrictEqual(diffSharedFingerprints(before, after), []);
  });

  test("planWorktreeLinks records vendor as shared and notes it", () => {
    const existsSync = (p) => String(p).endsWith("vendor");
    const plan = planWorktreeLinks("/repo", "/wt", {
      platform: "linux",
      existsSync,
      statSync: () => ({ isDirectory: () => true }),
      env: {}
    });
    assertModule.deepStrictEqual(plan.sharedDirs, ["vendor"]);
    assertModule.ok(plan.notes.some((n) => /Shared \(read-mostly\)/i.test(n) && n.includes("vendor")));
  });
});

describe("private node_modules does not write through", () => {
  test("hardlink-seeded node_modules keeps main checkout untouched by new files", () => {
    const repo = makeTempDir("grok-nm-repo-");
    const wt = makeTempDir("grok-nm-wt-");
    realFs.mkdirSync(path.join(repo, "node_modules", "left-pad"), { recursive: true });
    realFs.writeFileSync(path.join(repo, "node_modules", "left-pad", "index.js"), "module.exports=0\n");

    const plan = planWorktreeLinks(repo, wt, {
      existsSync: realFs.existsSync,
      statSync: realFs.statSync,
      env: {}
    });
    const result = provisionWorktree(plan, realFs);
    assertModule.ok(
      result.provisioned.some((e) => path.basename(e.to) === "node_modules"),
      JSON.stringify(result)
    );
    assertModule.ok(!result.provisioned.some((e) => e.kind === "junction" || e.kind === "symlink"));

    realFs.mkdirSync(path.join(wt, "node_modules", "evil"), { recursive: true });
    realFs.writeFileSync(path.join(wt, "node_modules", "evil", "pwn.js"), "owned\n");
    assertModule.ok(
      !realFs.existsSync(path.join(repo, "node_modules", "evil")),
      "install into private node_modules must not create packages in the main checkout"
    );
  });
});

