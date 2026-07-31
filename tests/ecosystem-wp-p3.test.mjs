/**
 * WP-P3 coverage: Django/Python/JS plans, interpreter matrix, Godot
 * --check-only gating, .uid integrity, Blender auto-sandbox + version guard,
 * runtime plugin injection + commit exclude.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultVerifyCommands,
  detectEcosystems,
  detectPrimaryEcosystem,
  resolvePythonInterpreter
} from "../plugins/grok-build/scripts/lib/ecosystem.mjs";
import {
  blenderVersionGuardNote,
  checkUidIntegrity,
  detectBlendLocks,
  parseBlenderVersionMin,
  parseBlenderVersionOutput,
  snapshotUidFiles
} from "../plugins/grok-build/scripts/lib/engine-runtime.mjs";
import {
  injectRuntimePlugin,
  resolveGodotCacheMode,
  shouldAutoBlenderSandbox
} from "../plugins/grok-build/scripts/lib/provision.mjs";
import { artifactExcludePathspecs } from "../plugins/grok-build/scripts/lib/worktree.mjs";
import { makeTempDir } from "./helpers.mjs";

const PLUGIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "grok-build"
);

function makeProject(files = {}) {
  const root = makeTempDir("grok-build-wp-p3-");
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(root, ...rel.split("/"));
    if (rel.endsWith("/")) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
  }
  return root;
}

// ─── Godot whole-project check (never bare --check-only) ───────────────────

test("Godot 4 verify plan emits grok_check.gd ahead of --import, never bare --check-only", () => {
  const root = makeProject({ "project.godot": "config_version=5\n" });
  const godot = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(godot.supportsCheckOnly, true);
  const commands = defaultVerifyCommands(godot, { env: {}, platform: "linux" });
  assert.ok(commands[0].includes("grok_check.gd"), commands.join("\n"));
  assert.ok(commands.every((c) => !/(?:^|\s)--check-only(?:\s|$)/.test(c)), commands.join("\n"));
  assert.ok(commands.some((c) => c.includes("--import")));
});

test("Godot 3 verify plan never emits --check-only or grok_check.gd", () => {
  const root = makeProject({ "project.godot": "config_version=4\n" });
  const godot = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(godot.supportsCheckOnly, false);
  const commands = defaultVerifyCommands(godot, { env: {}, platform: "linux" });
  assert.ok(commands.every((c) => !c.includes("--check-only")), commands.join("\n"));
  assert.ok(commands.every((c) => !c.includes("grok_check.gd")), commands.join("\n"));
});

test("Godot export smoke is opt-in and uses platform-correct extension on Godot 4", () => {
  const root = makeProject({
    "project.godot": "config_version=5\n",
    "export_presets.cfg": '[preset.0]\nname="Windows Desktop"\nplatform="Windows Desktop"\n'
  });
  const godot = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(godot.hasExportPresets, true);
  assert.equal(godot.exportPresetName, "Windows Desktop");
  assert.equal(godot.exportPresetPlatform, "Windows Desktop");
  const off = defaultVerifyCommands(godot, { env: {}, platform: "linux" });
  assert.ok(off.every((c) => !c.includes("export-release")), off.join("\n"));
  const on = defaultVerifyCommands(godot, { env: {}, platform: "linux", exportSmoke: true });
  assert.ok(on.some((c) => c.includes("--export-release") && c.includes("Windows Desktop")), on.join("\n"));
  assert.ok(on.some((c) => c.includes("export-smoke.exe")), on.join("\n"));
  assert.ok(on.every((c) => !c.includes("export_credentials")), on.join("\n"));
});

// ─── Godot cache mode ──────────────────────────────────────────────────────

test("resolveGodotCacheMode defaults private; env=1 shares", () => {
  const def = resolveGodotCacheMode({}, {});
  assert.equal(def.private, true);
  assert.match(def.cacheLine, /private to this run/i);

  const shared = resolveGodotCacheMode({}, { GROK_BUILD_LINK_GODOT_CACHE: "1" });
  assert.equal(shared.private, false);
  assert.match(shared.cacheLine, /shared with your working copy/i);

  const copyOpt = resolveGodotCacheMode({ copyGodotCache: false }, {});
  assert.equal(copyOpt.private, false);
});

// ─── .uid integrity ────────────────────────────────────────────────────────

test("checkUidIntegrity reports deleted and rewritten companions", () => {
  const root = makeTempDir("grok-uid-");
  fs.writeFileSync(path.join(root, "player.gd.uid"), "uid://oldtoken\n", "utf8");
  fs.writeFileSync(path.join(root, "enemy.gd.uid"), "uid://enemy1\n", "utf8");
  fs.writeFileSync(
    path.join(root, "main.tscn"),
    '[gd_scene]\n[ext_resource type="Script" uid="uid://oldtoken" path="res://player.gd"]\n',
    "utf8"
  );

  const before = snapshotUidFiles(root);
  // Delete one, rewrite another
  fs.unlinkSync(path.join(root, "enemy.gd.uid"));
  fs.writeFileSync(path.join(root, "player.gd.uid"), "uid://NEWtoken\n", "utf8");

  const result = checkUidIntegrity(before, root);
  assert.equal(result.ok, false);
  assert.ok(result.deleted.some((p) => p.includes("enemy.gd.uid")));
  assert.ok(result.rewritten.some((e) => e.path.includes("player.gd.uid")));
  assert.ok(result.notes.length >= 1);
  assert.ok(result.notes.some((n) => /NEW RANDOM|rewrote|deleted/i.test(n)));
});

test("checkUidIntegrity is green when nothing moved", () => {
  const root = makeTempDir("grok-uid-ok-");
  fs.writeFileSync(path.join(root, "a.gd.uid"), "uid://abc\n", "utf8");
  const before = snapshotUidFiles(root);
  const result = checkUidIntegrity(before, root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.rewritten, []);
});

// ─── Blender auto-sandbox + version guard ──────────────────────────────────

test("shouldAutoBlenderSandbox defaults on for isolated write add-ons", () => {
  assert.equal(
    shouldAutoBlenderSandbox(
      { id: "blender", isAddon: true, manifestPath: "blender_manifest.toml" },
      { isolate: true, write: true }
    ),
    true
  );
  assert.equal(
    shouldAutoBlenderSandbox(
      { id: "blender", isAddon: false, detectedBy: "blend-file" },
      { isolate: true, write: true }
    ),
    false
  );
  assert.equal(
    shouldAutoBlenderSandbox(
      { id: "blender", isAddon: true },
      { isolate: true, write: true, noSandbox: true }
    ),
    false
  );
  assert.equal(
    shouldAutoBlenderSandbox({ id: "godot" }, { isolate: true, write: true }),
    false
  );
});

test("blender_version_min is recorded on the descriptor and guards older binaries", () => {
  const root = makeProject({
    "blender_manifest.toml":
      'schema_version = "1.0.0"\nid = "demo"\nblender_version_min = "4.2.0"\n'
  });
  const blender = detectPrimaryEcosystem(root, { env: {} });
  assert.ok(blender.blenderVersionMin);
  assert.equal(blender.blenderVersionMin.major, 4);
  assert.equal(blender.blenderVersionMin.minor, 2);

  const tooOld = parseBlenderVersionOutput("Blender 4.1.0");
  const note = blenderVersionGuardNote(tooOld, blender.blenderVersionMin);
  assert.ok(note);
  assert.match(note, /older than blender_version_min/i);

  const ok = parseBlenderVersionOutput("Blender 4.2.1");
  assert.equal(blenderVersionGuardNote(ok, blender.blenderVersionMin), null);
});

test("detectBlendLocks reports .blend@ siblings", () => {
  const root = makeTempDir("grok-blend-lock-");
  fs.writeFileSync(path.join(root, "scene.blend"), "BLENDER", "utf8");
  fs.writeFileSync(path.join(root, "scene.blend@"), "tmp", "utf8");
  const result = detectBlendLocks(root, { platform: "linux" });
  assert.equal(result.locked, true);
  assert.ok(result.note);
  assert.match(result.note, /close Blender/i);
});

// ─── Django / Python ───────────────────────────────────────────────────────

test("Django project is detected as python with framework django", () => {
  const root = makeProject({
    "manage.py": "#!/usr/bin/env python\n",
    "myproject/settings.py": "SECRET_KEY = 'x'\n",
    "requirements.txt": "Django>=4.2\n"
  });
  const py = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(py.id, "python");
  assert.equal(py.framework, "django");
  const commands = defaultVerifyCommands(py, { platform: "linux", env: {} });
  assert.ok(commands.some((c) => c.includes("manage.py check")), commands.join("\n"));
  assert.ok(commands.some((c) => c.includes("makemigrations --check --dry-run")), commands.join("\n"));
  assert.ok(commands.some((c) => c.includes("manage.py test")), commands.join("\n"));
});

test("Django prefers pytest when configured", () => {
  const root = makeProject({
    "manage.py": "#!/usr/bin/env python\n",
    "settings.py": "SECRET_KEY='x'\n",
    "pytest.ini": "[pytest]\n",
    "pyproject.toml": '[project]\nname="d"\n'
  });
  const py = detectPrimaryEcosystem(root, { env: {} });
  const commands = defaultVerifyCommands(py, { platform: "linux", env: {} });
  assert.ok(commands.some((c) => c.includes("pytest")), commands.join("\n"));
  assert.ok(commands.every((c) => !c.endsWith("manage.py test")), commands.join("\n"));
});

test("Python interpreter matrix: uv, poetry, pdm, venv", () => {
  const uvRoot = makeProject({ "uv.lock": "", "pyproject.toml": "[project]\nname='x'\n" });
  assert.equal(resolvePythonInterpreter(uvRoot, { platform: "linux" }).kind, "uv");

  const poetryRoot = makeProject({ "poetry.lock": "", "pyproject.toml": "[tool.poetry]\nname='x'\n" });
  assert.equal(resolvePythonInterpreter(poetryRoot, { platform: "linux" }).kind, "poetry");

  const pdmRoot = makeProject({ "pdm.lock": "", "pyproject.toml": "[project]\nname='x'\n" });
  assert.equal(resolvePythonInterpreter(pdmRoot, { platform: "linux" }).kind, "pdm");

  const venvRoot = makeTempDir("grok-venv-");
  fs.mkdirSync(path.join(venvRoot, ".venv", "bin"), { recursive: true });
  fs.writeFileSync(path.join(venvRoot, ".venv", "bin", "python"), "", "utf8");
  fs.writeFileSync(path.join(venvRoot, "pyproject.toml"), "[project]\nname='x'\n", "utf8");
  const venv = resolvePythonInterpreter(venvRoot, { platform: "linux" });
  assert.equal(venv.kind, "venv");
  assert.ok(venv.python.includes(`${path.sep}.venv${path.sep}`));
});

test("ruff and mypy only appear when configured", () => {
  const bare = makeProject({
    "pyproject.toml": "[project]\nname='x'\n",
    "tests/test_a.py": "def test_ok():\n    assert True\n"
  });
  const bareCmds = defaultVerifyCommands(detectPrimaryEcosystem(bare, { env: {} }), {
    platform: "linux",
    env: {}
  });
  assert.ok(bareCmds.every((c) => !c.includes("ruff") && !c.includes("mypy")), bareCmds.join("\n"));

  const linted = makeProject({
    "pyproject.toml": "[project]\nname='x'\n[tool.ruff]\n[tool.mypy]\n",
    "tests/test_a.py": "def test_ok():\n    assert True\n",
    "uv.lock": ""
  });
  const lintCmds = defaultVerifyCommands(detectPrimaryEcosystem(linted, { env: {} }), {
    platform: "linux",
    env: {}
  });
  assert.ok(lintCmds.some((c) => c.includes("ruff check")), lintCmds.join("\n"));
  assert.ok(lintCmds.some((c) => c.includes("mypy")), lintCmds.join("\n"));
  assert.ok(lintCmds.every((c) => c.startsWith("uv run") || c.includes("pytest")), lintCmds.join("\n"));
});

// ─── JavaScript / TypeScript ───────────────────────────────────────────────

test("Node package manager follows the lockfile", () => {
  const pnpm = makeProject({
    "package.json": '{"name":"x","scripts":{"test":"node --test"}}',
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n"
  });
  const d = detectPrimaryEcosystem(pnpm, { env: {} });
  assert.equal(d.packageManager, "pnpm");
  assert.deepEqual(defaultVerifyCommands(d, { env: {} }), ["pnpm test"]);

  const yarn = makeProject({
    "package.json": '{"name":"x","scripts":{"test":"node --test"}}',
    "yarn.lock": "# yarn\n"
  });
  assert.equal(detectPrimaryEcosystem(yarn, { env: {} }).packageManager, "yarn");
});

test("vitest is called directly when scripts.test is absent but config exists", () => {
  const root = makeProject({
    "package.json": '{"name":"x","devDependencies":{"vitest":"^2.0.0"}}',
    "vitest.config.ts": "export default {}\n"
  });
  const d = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(d.directTestRunner, "vitest");
  const cmds = defaultVerifyCommands(d, { env: {} });
  assert.ok(cmds.some((c) => c.includes("vitest run")), cmds.join("\n"));
});

test("tsc --noEmit is added when TypeScript is a dependency with tsconfig", () => {
  const root = makeProject({
    "package.json":
      '{"name":"x","scripts":{"test":"node --test"},"devDependencies":{"typescript":"^5.0.0"}}',
    "tsconfig.json": '{"compilerOptions":{}}\n'
  });
  const d = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(d.hasTypeScript, true);
  const cmds = defaultVerifyCommands(d, { env: {} });
  assert.ok(cmds.includes("npm test"));
  assert.ok(cmds.some((c) => c.includes("tsc --noEmit")), cmds.join("\n"));
});

test("workspace detection does not change root-only verify", () => {
  const root = makeProject({
    "package.json":
      '{"name":"mono","private":true,"workspaces":["packages/*"],"scripts":{"test":"node --test"}}',
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/a/package.json": '{"name":"a"}\n'
  });
  const d = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(d.isWorkspace, true);
  const cmds = defaultVerifyCommands(d, { env: {} });
  // Still a single root command — never pnpm -r or per-package descent.
  assert.ok(cmds.every((c) => !c.includes("-r ") && !c.includes("packages/")), cmds.join("\n"));
});

// ─── Runtime plugin injection ──────────────────────────────────────────────

test("injectRuntimePlugin copies ecosystem packs and is excluded from commit pathspecs", () => {
  const wt = makeTempDir("grok-runtime-inject-");
  const result = injectRuntimePlugin(wt, ["godot", "blender"], {
    pluginRoot: PLUGIN_ROOT,
    env: {}
  });
  assert.equal(result.injected, true);
  assert.ok(result.packs.includes("godot-engine"));
  assert.ok(result.packs.includes("blender-addon"));
  assert.ok(result.packs.includes("runtime-core"));
  assert.ok(fs.existsSync(path.join(wt, ".grok", "plugins", "grok-build-runtime", "plugin.json")));
  assert.ok(
    fs.existsSync(
      path.join(wt, ".grok", "plugins", "grok-build-runtime", "skills", "godot-engine", "SKILL.md")
    )
  );
  // tools/ holds grok_check.gd — required for the Godot 4 default plan.
  assert.ok(
    fs.existsSync(
      path.join(wt, ".grok", "plugins", "grok-build-runtime", "tools", "grok_check.gd")
    )
  );

  const specs = artifactExcludePathspecs();
  assert.ok(specs.some((s) => s.includes(".grok")), specs.join("\n"));

  const disabled = injectRuntimePlugin(wt, ["godot"], {
    pluginRoot: PLUGIN_ROOT,
    env: { GROK_BUILD_INJECT_RUNTIME: "0" }
  });
  assert.equal(disabled.injected, false);
  assert.ok(disabled.notes.some((n) => /disabled/i.test(n)));
});

test("detectEcosystems still never throws and remains pure", () => {
  assert.deepEqual(
    detectEcosystems("/nope", {
      existsSync: () => {
        throw new Error("boom");
      },
      readdirSync: () => {
        throw new Error("boom");
      },
      readFileSync: () => {
        throw new Error("boom");
      },
      env: {}
    }),
    []
  );
});

test("parseBlenderVersionMin rejects garbage without throwing", () => {
  assert.equal(parseBlenderVersionMin("not a manifest"), null);
  assert.deepEqual(parseBlenderVersionMin('blender_version_min = "5.0"').major, 5);
});
