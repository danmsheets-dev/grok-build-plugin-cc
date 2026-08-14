/**
 * WP-B6: ecosystem breadth — subdirectory detection, multi-ecosystem verify
 * plans, Blender extension sandbox facts, nested node_modules discovery.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultVerifyCommands,
  defaultVerifyPlan,
  detectEcosystems,
  detectPrimaryEcosystem,
  filterEcosystems,
  sanitizePythonModuleName
} from "../plugins/turbo-build-plugin/scripts/lib/ecosystem.mjs";
import {
  discoverNestedNodeModules,
  planBlenderScriptSandbox,
  planWorktreeLinks
} from "../plugins/turbo-build-plugin/scripts/lib/provision.mjs";
import { resolveOutputFailurePatterns } from "../plugins/turbo-build-plugin/scripts/lib/verify.mjs";
import { makeTempDir } from "./helpers.mjs";

const BRIDGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "turbo-build-plugin",
  "scripts",
  "grok-bridge.mjs"
);

function makeProject(files = {}) {
  const root = makeTempDir("grok-build-wp-b6-");
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

// ─── Subdirectory detection ────────────────────────────────────────────────

test("Godot project in game/ is detected with projectDir", () => {
  const root = makeProject({
    "game/project.godot": "config_version=5\n",
    "server/README.md": "# api\n"
  });
  const godot = detectPrimaryEcosystem(root, { env: {} });
  assert.ok(godot);
  assert.equal(godot.id, "godot");
  assert.equal(godot.projectDir, "game");
  const commands = defaultVerifyCommands(godot, { env: {}, platform: "linux" });
  assert.ok(commands.every((c) => c.includes("--path game")), commands.join("\n"));
  assert.ok(commands.some((c) => c.includes("grok_check.gd")), commands.join("\n"));
});

test("Django manage.py in backend/ is detected with projectDir", () => {
  const root = makeProject({
    "backend/manage.py": "#!/usr/bin/env python\n",
    "backend/myproject/settings.py": "SECRET_KEY='x'\n",
    "backend/requirements.txt": "Django>=4.2\n",
    "frontend/package.json": '{"name":"web","scripts":{"test":"node --test"}}'
  });
  const ecosystems = detectEcosystems(root, { env: {} });
  const ids = ecosystems.map((e) => e.id);
  assert.ok(ids.includes("python"), ids.join(","));
  assert.ok(ids.includes("node"), ids.join(","));
  const py = ecosystems.find((e) => e.id === "python");
  assert.equal(py.projectDir, "backend");
  assert.equal(py.framework, "django");
  assert.equal(py.managePy, "backend/manage.py");
  assert.equal(py.settingsModule, "myproject.settings");
  const commands = defaultVerifyCommands(py, { platform: "linux", env: {} });
  assert.ok(commands.some((c) => c.includes("backend/manage.py check")), commands.join("\n"));
});

test("package.json in frontend/ is detected with projectDir", () => {
  const root = makeProject({
    "frontend/package.json": '{"name":"web","scripts":{"test":"node --test"}}',
    "frontend/package-lock.json": "{}\n"
  });
  const node = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(node.id, "node");
  assert.equal(node.projectDir, "frontend");
  const commands = defaultVerifyCommands(node, { env: {} });
  assert.ok(commands.some((c) => c.includes("--prefix frontend") || c.includes("frontend")), commands.join("\n"));
});

test("root project.godot is preferred over nested when both exist", () => {
  const root = makeProject({
    "project.godot": "config_version=5\n",
    "demos/project.godot": "config_version=5\n"
  });
  const godot = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(godot.projectDir, ".");
});

// ─── Multi-ecosystem verify plan ───────────────────────────────────────────

test("Django + React monorepo gets python AND node verify commands", () => {
  const root = makeProject({
    "manage.py": "#!/usr/bin/env python\n",
    "myproject/settings.py": "SECRET_KEY='x'\n",
    "requirements.txt": "Django>=4.2\n",
    "package.json": '{"name":"web","scripts":{"test":"node --test"}}'
  });
  const ecosystems = detectEcosystems(root, { env: {} });
  assert.deepEqual(
    ecosystems.map((e) => e.id),
    ["python", "node"]
  );
  const plan = defaultVerifyPlan(ecosystems, { platform: "linux", env: {} });
  assert.ok(plan.some((c) => c.includes("manage.py check")), plan.join("\n"));
  assert.ok(plan.some((c) => c === "npm test" || c.endsWith(" test")), plan.join("\n"));
});

test("Blender add-on with pyproject gets blender AND python verify commands", () => {
  const root = makeProject({
    "myaddon/__init__.py": 'bl_info = {"name": "Demo"}\n',
    "pyproject.toml": "[project]\nname='addon'\n[tool.ruff]\n[tool.pytest.ini_options]\n",
    "tests/test_geometry.py": "def test_ok():\n    assert True\n",
    "pytest.ini": "[pytest]\n"
  });
  const ecosystems = detectEcosystems(root, { env: {} });
  const ids = ecosystems.map((e) => e.id);
  assert.ok(ids[0] === "blender", ids.join(","));
  assert.ok(ids.includes("python"), ids.join(","));
  const plan = defaultVerifyPlan(ecosystems, { platform: "linux", env: {} });
  assert.ok(
    plan.some((c) => c.includes("blender") || c.includes("grok_verify_shim")),
    plan.join("\n")
  );
  assert.ok(plan.some((c) => c.includes("pytest") || c.includes("ruff")), plan.join("\n"));
});

test("filterEcosystems narrows the multi-ecosystem plan", () => {
  const root = makeProject({
    "manage.py": "#!/usr/bin/env python\n",
    "settings.py": "SECRET_KEY='x'\n",
    "requirements.txt": "Django>=4.2\n",
    "package.json": '{"name":"web","scripts":{"test":"node --test"}}'
  });
  const all = detectEcosystems(root, { env: {} });
  const onlyPy = filterEcosystems(all, ["python"]);
  assert.deepEqual(
    onlyPy.map((e) => e.id),
    ["python"]
  );
  const plan = defaultVerifyPlan(onlyPy, { platform: "linux", env: {} });
  assert.ok(plan.every((c) => !c.includes("npm")), plan.join("\n"));
});

test("resolveOutputFailurePatterns unions godot + blender markers", () => {
  const patterns = resolveOutputFailurePatterns(["godot", "blender"], []);
  const ids = patterns.map((p) => p.id);
  assert.ok(ids.includes("godot-script-error"), ids.join(","));
  assert.ok(ids.includes("blender-python-script-failed"), ids.join(","));
  assert.ok(ids.includes("godot-grok-check-failed"), ids.join(","));
});

// ─── Blender extension / module sanitisation ───────────────────────────────

test("sanitizePythonModuleName turns mesh-tools into mesh_tools", () => {
  assert.equal(sanitizePythonModuleName("mesh-tools"), "mesh_tools");
  assert.equal(sanitizePythonModuleName("9bad"), "_9bad");
  assert.equal(sanitizePythonModuleName(""), "addon");
});

test("extension descriptor records extensionId and bl_ext moduleName", () => {
  const root = makeProject({
    "src/blender_manifest.toml":
      'schema_version = "1.0.0"\nid = "mesh_tools"\ntype = "add-on"\nblender_version_min = "4.2.0"\n'
  });
  const blender = detectPrimaryEcosystem(root, { env: {} });
  assert.equal(blender.id, "blender");
  assert.equal(blender.isExtension, true);
  assert.equal(blender.extensionId, "mesh_tools");
  assert.equal(blender.moduleName, "bl_ext.user_default.mesh_tools");
  const commands = defaultVerifyCommands(blender, { env: {}, platform: "linux" });
  assert.ok(
    commands.some((c) => c.includes("--enable bl_ext.user_default.mesh_tools")),
    commands.join("\n")
  );
});

// ─── Nested node_modules discovery ─────────────────────────────────────────

test("discoverNestedNodeModules finds packages/*/node_modules", () => {
  const root = makeProject({
    "package.json": '{"name":"mono","private":true,"workspaces":["packages/*"]}',
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "node_modules/.keep": "",
    "packages/a/node_modules/left-pad/index.js": "module.exports=1\n",
    "packages/b/node_modules/x/index.js": "module.exports=2\n"
  });
  const found = discoverNestedNodeModules(root);
  assert.ok(found.includes("packages/a/node_modules"), found.join(","));
  assert.ok(found.includes("packages/b/node_modules"), found.join(","));
  assert.ok(!found.includes("node_modules"), "root node_modules must not be listed as nested");
});

test("planWorktreeLinks plans nested node_modules for workspaces", () => {
  const repo = makeProject({
    "package.json": '{"name":"mono","private":true}',
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "node_modules/x.js": "1\n",
    "packages/a/node_modules/y.js": "2\n"
  });
  // planWorktreeLinks needs real dirs; makeProject already created them.
  const wt = makeTempDir("grok-wt-nm-");
  const plan = planWorktreeLinks(repo, wt, { platform: "linux", isWorkspace: true });
  const nested = plan.links.filter((l) => String(l.name || "").includes("packages/"));
  assert.ok(nested.length >= 1, JSON.stringify(plan.links.map((l) => l.name)));
  assert.ok(
    plan.notes.some((n) => /nested node_modules/i.test(n) || /workspace/i.test(n)),
    plan.notes.join("\n")
  );
});

// ─── verify-plan multi-ecosystem (bridge) ──────────────────────────────────

test("verify-plan reports ecosystems array for a dual stack", async () => {
  const { main } = await import(pathToFileUrl(BRIDGE));
  const root = makeProject({
    "manage.py": "#!/usr/bin/env python\n",
    "settings.py": "SECRET_KEY='x'\n",
    "requirements.txt": "Django>=4.2\n",
    "package.json": '{"name":"web","scripts":{"test":"node --test"}}'
  });
  const originalArgv = process.argv;
  const chunks = [];
  const originalLog = console.log;
  process.argv = [process.execPath, BRIDGE, "verify-plan", "--cwd", root, "--json"];
  console.log = (...parts) => {
    chunks.push(parts.join(" "));
  };
  try {
    await main();
  } finally {
    process.argv = originalArgv;
    console.log = originalLog;
  }
  const payload = JSON.parse(chunks.join("\n"));
  assert.ok(Array.isArray(payload.ecosystems));
  assert.ok(payload.ecosystems.some((e) => e.id === "python"));
  assert.ok(payload.ecosystems.some((e) => e.id === "node"));
  assert.ok(payload.commands.some((c) => c.includes("manage.py")));
  assert.ok(payload.commands.some((c) => /npm test|pnpm test|yarn test/.test(c)));
});

function pathToFileUrl(p) {
  const resolved = path.resolve(p);
  let u = resolved.replace(/\\/g, "/");
  if (!u.startsWith("/")) {
    u = `/${u}`;
  }
  return `file://${u}`;
}
