import { test, describe, beforeEach, assert, mock } from "node:test";
import assertModule from "node:assert";
import path from "node:path";
import fs from "node:fs";

import { PROVISION_LINK_DIRS, planWorktreeLinks, provisionWorktree } from "../plugins/grok-build/scripts/lib/provision.mjs";

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
