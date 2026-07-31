import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ECOSYSTEM_PRIORITY,
  defaultVerifyCommands,
  detectEcosystems,
  detectPrimaryEcosystem,
  resolveEcosystemBinary
} from "../plugins/grok-build/scripts/lib/ecosystem.mjs";
import { makeTempDir } from "./helpers.mjs";

/**
 * Write a fixture project. Keys are repo-relative POSIX paths; a key ending in
 * "/" creates an empty directory. No engine binary is involved anywhere in
 * this file - detection never spawns.
 */
function makeProject(files = {}) {
  const root = makeTempDir("grok-build-eco-");
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

function findDescriptor(root, id, io) {
  return detectEcosystems(root, io).find((entry) => entry.id === id) ?? null;
}

test("godot config_version 5 is Godot 4 and caches into .godot", () => {
  const root = makeProject({ "project.godot": "config_version=5\n\n[application]\n" });
  const godot = findDescriptor(root, "godot", { env: {} });
  assert.ok(godot);
  assert.equal(godot.configVersion, 5);
  assert.equal(godot.major, 4);
  assert.equal(godot.cacheDir, ".godot");
});

test("godot config_version 4 is Godot 3 and caches into .import", () => {
  const root = makeProject({ "project.godot": "config_version=4\n" });
  const godot = findDescriptor(root, "godot", { env: {} });
  assert.equal(godot.major, 3);
  assert.equal(godot.cacheDir, ".import");
});

test("godot config_version 3 is Godot 3.0", () => {
  const root = makeProject({ "project.godot": "config_version=3\n" });
  assert.equal(findDescriptor(root, "godot", { env: {} }).major, 3);
});

test("an unknown future config_version resolves forward to Godot 4", () => {
  // A newer editor bumping the number is far likelier to keep Godot 4's CLI
  // surface than to revert to Godot 3's --no-window world.
  const root = makeProject({ "project.godot": "config_version=6\n" });
  const godot = findDescriptor(root, "godot", { env: {} });
  assert.equal(godot.configVersion, 6);
  assert.equal(godot.major, 4);
});

test("a project.godot without config_version reports a null major", () => {
  const root = makeProject({ "project.godot": "[application]\nconfig/name=\"demo\"\n" });
  const godot = findDescriptor(root, "godot", { env: {} });
  assert.ok(godot);
  assert.equal(godot.configVersion, null);
  assert.equal(godot.major, null);
});

test("a bare .godot cache directory is not a Godot project", () => {
  // The cache outlives the project that produced it (a moved or deleted
  // project leaves it behind), so only project.godot may imply Godot.
  const root = makeProject({ ".godot/imported/blob.ctex": "x", ".import/cache.md5": "x" });
  assert.equal(findDescriptor(root, "godot", { env: {} }), null);
});

test("config/features supplies the minor that config_version cannot", () => {
  const root = makeProject({
    "project.godot": 'config_version=5\nconfig/features=PackedStringArray("4.3", "Forward Plus")\n'
  });
  const godot = findDescriptor(root, "godot", { env: {} });
  assert.equal(godot.minor, 3);
  assert.deepEqual(godot.features, ["4.3", "Forward Plus"]);
});

test("Godot 3's PoolStringArray features are parsed too", () => {
  const root = makeProject({
    "project.godot": 'config_version=4\nconfig/features=PoolStringArray( "3.5" )\n'
  });
  const godot = findDescriptor(root, "godot", { env: {} });
  assert.equal(godot.major, 3);
  assert.equal(godot.minor, 5);
});

test("GUT is detected from addons/gut/gut_cmdln.gd", () => {
  const root = makeProject({
    "project.godot": "config_version=5\n",
    "addons/gut/gut_cmdln.gd": "extends SceneTree\n"
  });
  assert.equal(findDescriptor(root, "godot", { env: {} }).testRunner, "gut");
});

test("gdUnit4 is detected from the addons/gdUnit4 directory", () => {
  const root = makeProject({
    "project.godot": "config_version=5\n",
    "addons/gdUnit4/plugin.cfg": "[plugin]\nname=\"gdUnit4\"\n"
  });
  assert.equal(findDescriptor(root, "godot", { env: {} }).testRunner, "gdunit4");
});

test("a Godot project with no test addon reports no test runner", () => {
  const root = makeProject({ "project.godot": "config_version=5\n" });
  const godot = findDescriptor(root, "godot", { env: {} });
  assert.equal(godot.testRunner, null);
  assert.equal(godot.testDir, null);
});

test("blender_manifest.toml at the root detects blender", () => {
  const root = makeProject({ "blender_manifest.toml": 'schema_version = "1.0.0"\nid = "demo"\n' });
  const blender = findDescriptor(root, "blender", { env: {} });
  assert.ok(blender);
  assert.equal(blender.detectedBy, "manifest");
  assert.equal(blender.manifestPath, "blender_manifest.toml");
});

test("a depth-1 blender_manifest.toml detects blender with a relative path", () => {
  const root = makeProject({ "myaddon/blender_manifest.toml": 'id = "demo"\n' });
  const blender = findDescriptor(root, "blender", { env: {} });
  assert.ok(blender);
  assert.equal(blender.manifestPath, "myaddon/blender_manifest.toml");
});

test("a depth-1 __init__.py carrying bl_info detects blender", () => {
  const root = makeProject({
    "myaddon/__init__.py": 'bl_info = {\n    "name": "Demo",\n    "blender": (4, 2, 0),\n}\n'
  });
  const blender = findDescriptor(root, "blender", { env: {} });
  assert.ok(blender);
  assert.equal(blender.detectedBy, "bl-info");
  assert.equal(blender.addonInitPath, "myaddon/__init__.py");
});

test("a plain Python package is not a Blender add-on", () => {
  const root = makeProject({
    "setup.py": "from setuptools import setup\nsetup(name='demo')\n",
    "mypkg/__init__.py": "import os\n\n\ndef register():\n    pass\n"
  });
  assert.equal(findDescriptor(root, "blender", { env: {} }), null);
  assert.equal(detectPrimaryEcosystem(root, { env: {} }).id, "python");
});

test("a .blend file at the root detects blender", () => {
  const root = makeProject({ "scene.blend": "BLENDER-v403" });
  assert.equal(findDescriptor(root, "blender", { env: {} }).detectedBy, "blend-file");
});

test("detection never recurses past depth 1", () => {
  // assets/scenes/ is depth 2. Detecting it would mean an unbounded walk over
  // repos that contain node_modules/ or .godot/.
  const root = makeProject({ "assets/scenes/scene.blend": "BLENDER-v403" });
  assert.equal(findDescriptor(root, "blender", { env: {} }), null);
});

test("a package.json-only project yields no godot or blender descriptor", () => {
  const root = makeProject({ "package.json": '{"name":"demo","scripts":{"test":"node --test"}}' });
  const ids = detectEcosystems(root, { env: {} }).map((entry) => entry.id);
  assert.deepEqual(ids, ["node"]);
});

test("an empty directory detects nothing at all", () => {
  const root = makeProject({});
  assert.deepEqual(detectEcosystems(root, { env: {} }), []);
  assert.equal(detectPrimaryEcosystem(root, { env: {} }), null);
});

test("the engine ecosystem outranks the tooling ecosystem it sits next to", () => {
  const root = makeProject({
    "project.godot": "config_version=5\n",
    "package.json": '{"name":"tooling","scripts":{"test":"node --test"}}'
  });
  assert.equal(detectPrimaryEcosystem(root, { env: {} }).id, "godot");
  assert.ok(ECOSYSTEM_PRIORITY.indexOf("godot") < ECOSYSTEM_PRIORITY.indexOf("node"));
});

test("detectEcosystems is fully fs-injectable and touches no real path", () => {
  const root = path.resolve("/nonexistent-grok-build-virtual-root");
  const files = new Map([["project.godot", 'config_version=5\nconfig/features=PackedStringArray("4.4")\n']]);
  const rel = (p) => path.relative(root, String(p)).split(path.sep).join("/");
  const io = {
    existsSync: (p) => files.has(rel(p)),
    readdirSync: () => [],
    readFileSync: (p) => {
      const value = files.get(rel(p));
      if (value === undefined) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return value;
    },
    env: {}
  };
  const godot = detectPrimaryEcosystem(root, io);
  assert.equal(godot.id, "godot");
  assert.equal(godot.major, 4);
  assert.equal(godot.minor, 4);
});

test("detection degrades to no ecosystem when the filesystem throws", () => {
  // Advisory detection must never cost the run - a permission-denied
  // directory or a race with the agent deleting a file is not fatal.
  const boom = () => {
    throw new Error("EACCES: permission denied");
  };
  assert.deepEqual(
    detectEcosystems("/some/root", { existsSync: boom, readdirSync: boom, readFileSync: boom, env: {} }),
    []
  );
});

test("defaultVerifyCommands for Godot 4 with GUT uses grok_check.gd and never bare --check-only", () => {
  const commands = defaultVerifyCommands(
    { id: "godot", major: 4, testRunner: "gut", supportsCheckOnly: true },
    { env: {}, platform: "linux" }
  );
  // Bare --check-only without --script never exits on Godot 4.
  assert.ok(commands.every((command) => !/(?:^|\s)--check-only(?:\s|$)/.test(command)), commands.join("\n"));
  assert.ok(
    commands.some((command) => command.includes("grok_check.gd")),
    commands.join("\n")
  );
  assert.ok(commands.some((command) => command.includes("--import")), commands.join("\n"));
  assert.ok(
    commands.some((command) => command.includes("gut_cmdln.gd -gexit")),
    commands.join("\n")
  );
  assert.ok(commands.every((command) => command.startsWith("godot ")));
  // Whole-project check must precede the slow import so a parse error fails fast.
  const checkIdx = commands.findIndex((command) => command.includes("grok_check.gd"));
  const importIdx = commands.findIndex((command) => command.includes("--import"));
  assert.ok(checkIdx >= 0 && importIdx > checkIdx, commands.join("\n"));
});

test("defaultVerifyCommands for Godot 3 uses --no-window and never --check-only or --quit-after", () => {
  const commands = defaultVerifyCommands(
    { id: "godot", major: 3, testRunner: "gut", supportsCheckOnly: false },
    { env: {}, platform: "linux" }
  );
  assert.ok(commands.every((command) => command.includes("--no-window")), commands.join("\n"));
  assert.ok(commands.every((command) => !command.includes("--check-only")), commands.join("\n"));
  assert.ok(commands.every((command) => !command.includes("grok_check.gd")), commands.join("\n"));
  assert.ok(commands.every((command) => !command.includes("--quit-after")), commands.join("\n"));
  assert.ok(commands.some((command) => command.includes("gut_cmdln.gd -gexit")));
});

test("gdUnit4 only gets a command when there is a test directory to point it at", () => {
  const withDir = defaultVerifyCommands(
    { id: "godot", major: 4, testRunner: "gdunit4", testDir: "test" },
    { env: {}, platform: "linux" }
  );
  assert.ok(withDir.some((command) => command.includes("GdUnitCmdTool.gd -a test")));

  const withoutDir = defaultVerifyCommands(
    { id: "godot", major: 4, testRunner: "gdunit4", testDir: null },
    { env: {}, platform: "linux" }
  );
  assert.ok(withoutDir.every((command) => !command.includes("GdUnitCmdTool")));
});

test("no default verify command ever emits shell parameter expansion", () => {
  // ${GODOT_BIN:-godot} is POSIX sh, and verify.mjs routes every command
  // through `cmd /d /s /c` on win32, where it arrives verbatim as a filename.
  const descriptors = [
    { id: "godot", major: 4, testRunner: "gut", testDir: "test" },
    { id: "godot", major: 3, testRunner: "gdunit4", testDir: "test" },
    { id: "blender", manifestPath: "blender_manifest.toml", testScript: "tests/run_tests.py" },
    { id: "blender", manifestPath: null, testScript: null },
    { id: "node", hasTestScript: true },
    { id: "python", hasTests: true },
    { id: "rust" }
  ];
  for (const platform of ["win32", "linux"]) {
    for (const descriptor of descriptors) {
      for (const command of defaultVerifyCommands(descriptor, {
        env: { GODOT_BIN: "godot", BLENDER_BIN: "blender" },
        platform,
        existsSync: () => false
      })) {
        assert.ok(!command.includes("${"), `${platform}: ${command}`);
      }
    }
  }
});

test("defaultVerifyCommands for Blender validates the manifest and runs tests via the bridge shim", () => {
  const commands = defaultVerifyCommands(
    {
      id: "blender",
      manifestPath: "myaddon/blender_manifest.toml",
      testScript: "tests/run_tests.py",
      moduleName: "myaddon"
    },
    { env: {}, platform: "linux" }
  );
  assert.ok(commands.some((command) => command.includes("--command extension validate myaddon/blender_manifest.toml")));
  // Tests go through the shim so FAILED without sys.exit(1) still fails verify.
  const script = commands.find(
    (command) => command.includes("grok_verify_shim.py") && command.includes("tests/run_tests.py")
  );
  assert.ok(script, commands.join("\n"));
  assert.match(script, /--background --factory-startup --python-exit-code 1/);
  // Registration smoke is unconditional so a manifest-only plan cannot skip Python.
  assert.ok(
    commands.some((command) => command.includes("grok_verify_shim.py") && command.includes("--enable myaddon")),
    commands.join("\n")
  );
});

test("a manifest path carrying a shell metacharacter emits no validate command", () => {
  // A depth-1 directory name is repo-controlled and the verify command is run
  // through `cmd /d /s /c` / `/bin/sh -c` by the baseline probe, before the
  // agent spawns and before anything echoes the plan - so `addon & whoami/`
  // used to mean command execution from merely cloning a repository.
  const root = makeProject({ "addon & whoami/blender_manifest.toml": 'id = "demo"\n' });
  const blender = findDescriptor(root, "blender", { env: {} });
  // The descriptor keeps the raw path: provision.mjs consumes it as a real
  // filesystem path, so the refusal belongs at command construction, not here.
  assert.equal(blender.manifestPath, "addon & whoami/blender_manifest.toml");

  for (const platform of ["win32", "linux"]) {
    const commands = defaultVerifyCommands(blender, { env: {}, platform, existsSync: () => false });
    assert.ok(
      commands.every((command) => !command.includes("extension validate")),
      `${platform}: ${commands.join("\n")}`
    );
    assert.ok(
      commands.every((command) => !command.includes("whoami")),
      `${platform}: ${commands.join("\n")}`
    );
    // Refusing must not leave the project unverified: the smoke check stands in.
    assert.ok(commands.length >= 1, commands.join("\n"));
    assert.ok(
      commands.some((command) => /--python-expr "import bpy"/.test(command) || command.includes("grok_verify_shim")),
      commands.join("\n")
    );
  }
});

test("every shell metacharacter that reaches a manifest path is refused", () => {
  for (const name of ["a&b", "a|b", "a>b", "a$b", "a`b", 'a"b', "a^b", "a%PATH%b", "a;b", "a\nb"]) {
    const commands = defaultVerifyCommands(
      { id: "blender", manifestPath: `${name}/blender_manifest.toml`, testScript: null },
      { env: {}, platform: "linux" }
    );
    assert.ok(
      commands.every((command) => !command.includes("extension validate")),
      `${JSON.stringify(name)}: ${commands.join("\n")}`
    );
  }
});

test("a manifest path with a space is still validated, as a single quoted token", () => {
  // The reject half alone would silently drop the manifest check for a
  // perfectly legitimate add-on directory, so the quote half has to stay: this
  // is what proves the fix did not just delete the feature.
  const root = makeProject({ "My Addon/blender_manifest.toml": 'id = "demo"\n' });
  const blender = findDescriptor(root, "blender", { env: {} });
  assert.equal(blender.manifestPath, "My Addon/blender_manifest.toml");

  for (const platform of ["win32", "linux"]) {
    const commands = defaultVerifyCommands(blender, { env: {}, platform, existsSync: () => false });
    const validate = commands.find((command) => command.includes("extension validate"));
    assert.ok(validate, `${platform}: ${commands.join("\n")}`);
    assert.ok(validate.endsWith('--command extension validate "My Addon/blender_manifest.toml"'), validate);
  }
});

test("a Blender project with neither manifest nor test script still gets a smoke check", () => {
  const commands = defaultVerifyCommands(
    { id: "blender", manifestPath: null, testScript: null },
    { env: {}, platform: "linux" }
  );
  assert.equal(commands.length, 1);
  assert.match(commands[0], /--background --factory-startup --python-exit-code 1 --python-expr/);
});

test("a Blender extension with only a manifest still gets registration smoke (not validate-only)", () => {
  // extension validate is a TOML schema check; without import/register smoke a
  // syntax error in __init__.py verifies green.
  const root = makeProject({
    "myext/blender_manifest.toml": 'schema_version = "1.0.0"\nid = "myext"\n',
    "myext/__init__.py": "bl_info = {}\n"
  });
  const blender = findDescriptor(root, "blender", { env: {} });
  assert.equal(blender.moduleName, "myext");
  const commands = defaultVerifyCommands(blender, { env: {}, platform: "linux" });
  assert.ok(commands.some((c) => c.includes("extension validate")), commands.join("\n"));
  assert.ok(
    commands.some((c) => c.includes("grok_verify_shim.py") && c.includes("--enable myext")),
    commands.join("\n")
  );
});

test("node defaults skip npm's placeholder test script", () => {
  const withTests = makeProject({
    "package.json": '{"name":"demo","scripts":{"test":"node --test"}}'
  });
  const placeholder = makeProject({
    "package.json": '{"name":"demo","scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}'
  });
  assert.deepEqual(
    defaultVerifyCommands(detectPrimaryEcosystem(withTests, { env: {} }), { env: {}, platform: "linux" }),
    ["npm test"]
  );
  assert.deepEqual(
    defaultVerifyCommands(detectPrimaryEcosystem(placeholder, { env: {} }), { env: {}, platform: "linux" }),
    []
  );
});

test("a malformed package.json still identifies node without inventing a command", () => {
  const root = makeProject({ "package.json": "{ not json" });
  const node = findDescriptor(root, "node", { env: {} });
  assert.ok(node);
  assert.equal(node.hasTestScript, false);
});

test("the plugin-specific binary env var outranks the generic one", () => {
  const root = makeProject({ "project.godot": "config_version=5\n" });
  const godot = findDescriptor(root, "godot", {
    env: { GODOT_BIN: "/opt/generic/godot", GROK_BUILD_GODOT_BIN: "/opt/plugin/godot" }
  });
  assert.equal(godot.exeHint, "/opt/plugin/godot");
  const commands = defaultVerifyCommands(godot, { env: {}, platform: "linux" });
  assert.ok(commands.every((command) => command.startsWith("/opt/plugin/godot ")));
});

test("GODOT_BIN is honoured when the plugin-specific var is unset", () => {
  const root = makeProject({ "project.godot": "config_version=5\n" });
  assert.equal(findDescriptor(root, "godot", { env: { GODOT_BIN: "/opt/generic/godot" } }).exeHint, "/opt/generic/godot");
});

test("a config override outranks every env var", () => {
  const resolved = resolveEcosystemBinary(
    { id: "godot", exeHint: "/from/env/godot" },
    { env: { GROK_BUILD_GODOT_BIN: "/from/env/godot" }, platform: "linux", override: "/from/config/godot" }
  );
  assert.equal(resolved, "/from/config/godot");
});

test("win32 binaries are backslash-normalised and quoted only when needed", () => {
  const spaced = resolveEcosystemBinary(
    { id: "godot", exeHint: "C:/Program Files/Godot/godot.exe" },
    { platform: "win32", env: {}, existsSync: () => false }
  );
  assert.equal(spaced, '"C:\\Program Files\\Godot\\godot.exe"');

  const bare = resolveEcosystemBinary(
    { id: "godot", exeHint: "godot" },
    { platform: "win32", env: {}, existsSync: () => false }
  );
  assert.equal(bare, "godot");
});

test("win32 prefers the console build, which is the only one that writes to a pipe", () => {
  // A GUI-subsystem Godot writes nothing to captured stdout/stderr, which
  // silently defeats every output-based failure check downstream.
  const seen = [];
  const resolved = resolveEcosystemBinary(
    { id: "godot", exeHint: "C:\\Godot\\Godot_v4.3-stable_win64.exe" },
    {
      platform: "win32",
      env: {},
      existsSync: (candidate) => {
        seen.push(candidate);
        return String(candidate).endsWith("_console.exe");
      }
    }
  );
  assert.equal(resolved, "C:\\Godot\\Godot_v4.3-stable_win64_console.exe");
  assert.ok(seen.some((candidate) => candidate.endsWith("_console.exe")));

  // Already a console build: no second _console suffix, and no probe needed.
  assert.equal(
    resolveEcosystemBinary(
      { id: "godot", exeHint: "C:\\Godot\\Godot_v4.3-stable_win64_console.exe" },
      { platform: "win32", env: {}, existsSync: () => true }
    ),
    "C:\\Godot\\Godot_v4.3-stable_win64_console.exe"
  );
});

test("win32 keeps the GUI exe when no console build sits next to it", () => {
  assert.equal(
    resolveEcosystemBinary(
      { id: "godot", exeHint: "C:\\Godot\\godot.exe" },
      { platform: "win32", env: {}, existsSync: () => false }
    ),
    "C:\\Godot\\godot.exe"
  );
});

test("python defaults use python3 off win32 and only when there is something to run", () => {
  assert.deepEqual(
    defaultVerifyCommands(
      { id: "python", hasTests: true, interpreter: { kind: "system", python: "python3", prefix: [] } },
      { platform: "linux", env: {} }
    ),
    ["python3 -m pytest -q"]
  );
  assert.deepEqual(
    defaultVerifyCommands(
      { id: "python", hasTests: true, interpreter: { kind: "system", python: "python", prefix: [] } },
      { platform: "win32", env: {} }
    ),
    ["python -m pytest -q"]
  );
  assert.deepEqual(defaultVerifyCommands({ id: "python", hasTests: false }, { platform: "linux", env: {} }), []);
});

test("defaultVerifyCommands returns an empty list for no descriptor", () => {
  assert.deepEqual(defaultVerifyCommands(null), []);
  assert.deepEqual(defaultVerifyCommands(undefined), []);
  assert.deepEqual(defaultVerifyCommands({ id: "unknown-ecosystem" }), []);
});
