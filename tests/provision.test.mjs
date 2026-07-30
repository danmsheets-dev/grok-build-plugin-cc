import { test, describe, beforeEach, assert, mock } from "node:test";
import assertModule from "node:assert";
import path from "node:path";
import fs from "node:fs";

import {
  GODOT_CACHE_DIRS,
  GODOT_SHARED_CACHE_NOTE,
  PROVISION_COPY_PATHS,
  PROVISION_LINK_DIRS,
  planWorktreeLinks,
  provisionWorktree
} from "../plugins/grok-build/scripts/lib/provision.mjs";
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
  writeFileSync: fs.writeFileSync,
  readFileSync: fs.readFileSync
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
    const statSync = mock.method(fs, "statSync", () => ({ isDirectory: () => false }));
    const plan = planWorktreeLinks("/repo", "/wt", { platform: "linux", existsSync: () => true, statSync });
    assertModule.ok(plan.notes.some(n => n.includes("not a directory")));
    assertModule.deepStrictEqual(plan.links, []);
  });

  test("uses junction on windows, symlink on linux", () => {
    const existsSync = mock.method(fs, "existsSync", () => true);
    const statSync = mock.method(fs, "statSync", () => ({ isDirectory: () => true }));
    const win = planWorktreeLinks("/repo", "/wt", { platform: "win32", existsSync, statSync });
    const lin = planWorktreeLinks("/repo", "/wt", { platform: "linux", existsSync, statSync });
    for (const link of win.links) {
      assertModule.strictEqual(link.kind, "junction");
    }
    for (const link of lin.links) {
      assertModule.strictEqual(link.kind, "symlink");
    }
  });

  test("includes PROVISION_LINK_DIRS entries when they exist as directories", () => {
    const existsSync = mock.method(fs, "existsSync", (p) => p.endsWith("node_modules") || p.endsWith("target"));
    const statSync = mock.method(fs, "statSync", () => ({ isDirectory: () => true }));
    const plan = planWorktreeLinks("/repo", "/wt", { platform: "linux", existsSync, statSync });
    const names = plan.links.map(l => path.basename(l.from));
    assertModule.ok(names.includes("node_modules"));
    assertModule.ok(names.includes("target"));
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

  test("the default is still a link, and it carries the shared-cache warning", () => {
    // The default must not move. Two other suites assert `.godot` is linked
    // (tests/provision.test.mjs PROVISION_LINK_DIRS coverage and
    // tests/worktree.test.mjs), and dropping the link reverses a deliberate,
    // documented optimisation for the plugin's primary ecosystem.
    const plan = planWorktreeLinks("/repo", "/wt", {
      platform: "linux",
      existsSync: (p) => String(p).endsWith(".godot"),
      statSync: dirStat,
      env: {}
    });

    const godot = plan.links.find((link) => path.basename(link.from) === ".godot");
    assertModule.ok(godot, "the default must still link .godot");
    assertModule.strictEqual(godot.kind, "symlink");
    assertModule.ok(
      plan.notes.includes(GODOT_SHARED_CACHE_NOTE),
      `the shared-cache warning is mandatory, got: ${JSON.stringify(plan.notes)}`
    );
    assertModule.match(GODOT_SHARED_CACHE_NOTE, /close the Godot editor/i);
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
      assertModule.strictEqual(link.kind, "copy");
    }
    assertModule.ok(
      plan.notes.some((note) => note.includes("copied, not shared")),
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
