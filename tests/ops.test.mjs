import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";
import {
  generateJobId,
  listJobs,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "../plugins/turbo-build-plugin/scripts/lib/state.mjs";
import { createWorktree } from "../plugins/turbo-build-plugin/scripts/lib/worktree.mjs";
import {
  buildEcosystemChecks,
  normalizeDoctorCheck,
  renderDoctorReport,
  RUN_PASSTHROUGH_FLAGS,
  TASK_VALUE_OPTIONS
} from "../plugins/turbo-build-plugin/scripts/grok-bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "turbo-build-plugin");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

test("help exits 0 and names every run flag added this release", () => {
  // Regression: printUsage's run line stopped at --resume-last/--model/--effort
  // and never grew past it as --verify, --env, --blender-sandbox and the rest
  // of TASK_VALUE_OPTIONS were added - so `node grok-bridge.mjs help`, the
  // bridge's own advertised interface, silently omitted most of what `run`
  // actually accepts.
  const result = run("node", [SCRIPT, "help"], { env: buildEnv(makeTempDir()) });
  assert.equal(result.status, 0, result.stderr);

  for (const flag of RUN_PASSTHROUGH_FLAGS) {
    assert.match(result.stdout, new RegExp(escapeRegExp(flag)), `help output is missing ${flag}`);
  }
  // The value-taking options not covered by RUN_PASSTHROUGH_FLAGS (it excludes
  // --model/--effort/--cwd/--prompt-file deliberately - see the constant's own
  // doc comment) still have to appear somewhere in the usage line.
  for (const option of TASK_VALUE_OPTIONS) {
    assert.match(result.stdout, new RegExp(`--${escapeRegExp(option)}\\b`), `help output is missing --${option}`);
  }
  assert.match(result.stdout, /-C <dir>/, "the -C alias must be documented");
  assert.match(result.stdout, /completed-unverified/, "help must say what an unverified run reports as");
  assert.match(result.stdout, /verify-plan/);
});

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withPluginData(pluginDataDir, fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("doctor exits 0 and reports the HOME check", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "doctor"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /HOME/);
  assert.match(result.stdout, /Grok Build Doctor|# Grok Build Doctor|Checks:/i);
});

test("doctor --json emits an object with a checks array", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.checks));
  assert.ok(payload.checks.some((check) => /HOME/i.test(check.name)));
});

test("a warn check advises without condemning the whole environment", () => {
  // The level exists so an ecosystem probe can say "your engine binary is not
  // on PATH" without declaring the install broken - a user may legitimately
  // verify via an absolute path or the bpy pip module.
  const report = {
    ok: [{ status: "warn" }].every((check) => check.status !== "fail"),
    checks: [
      normalizeDoctorCheck({
        name: "godot",
        status: "warn",
        detail: "godot: not found",
        fix: "Install Godot or set GROK_BUILD_GODOT_BIN."
      })
    ]
  };

  assert.equal(report.ok, true, "a warn must not flip the overall verdict");
  assert.equal(report.checks[0].ok, true, "warn keeps the legacy boolean green");
  assert.equal(report.checks[0].status, "warn");

  const rendered = renderDoctorReport(report);
  assert.match(rendered, /- \[warn\] godot: godot: not found/);
  // The whole point of a warn is that it is actionable; withholding the fix
  // line (which the pre-levels `!check.ok` gate would have done) leaves the
  // user with a complaint and no remedy.
  assert.match(rendered, /Fix: Install Godot or set GROK_BUILD_GODOT_BIN\./);
  assert.match(rendered, /^Status: ok$/m);
});

test("doctor status levels default from the legacy ok boolean", () => {
  assert.equal(normalizeDoctorCheck({ name: "a", ok: true }).status, "ok");
  assert.equal(normalizeDoctorCheck({ name: "a", ok: false }).status, "fail");
  // A skipped check measured nothing, so it cannot be evidence of a problem.
  const skipped = normalizeDoctorCheck({ name: "a", status: "skipped", detail: "no binary" });
  assert.equal(skipped.ok, true);
  assert.match(renderDoctorReport({ ok: true, checks: [skipped] }), /- \[skip\] a: no binary/);
  // And a fail still renders the loud marker every existing reader expects.
  const failed = normalizeDoctorCheck({ name: "a", ok: false, detail: "broken", fix: "do x" });
  assert.equal(failed.status, "fail");
  const rendered = renderDoctorReport({ ok: false, checks: [failed] });
  assert.match(rendered, /- \[FAIL\] a: broken/);
  assert.match(rendered, /Fix: do x/);
  assert.match(rendered, /^Status: needs-attention$/m);
});

test("doctor reports a failing check but still exits 0", () => {
  // doctor is a report, not a gate: a non-zero exit would render
  // /turbo-build-plugin:doctor as a failed command in the Claude Code transcript.
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const jobId = generateJobId("run");
  withPluginData(pluginDataDir, () => {
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      kind: "task",
      kindLabel: "delegate",
      title: "Abandoned seed for doctor",
      jobClass: "task",
      bridgePid: 999999,
      agentPid: 999999,
      pid: 999999
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  });

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false, "an abandoned run is a real fail");
  const abandoned = payload.checks.find((check) => /abandoned/i.test(check.name));
  assert.ok(abandoned, "doctor must include an abandoned runs check");
  assert.equal(abandoned.ok, false);
  assert.equal(abandoned.status, "fail");
  // Every check carries both fields, so a reader written against either one
  // sees the same verdict.
  for (const check of payload.checks) {
    assert.ok(
      ["ok", "fail", "warn", "skipped"].includes(check.status),
      `unknown status on ${check.name}: ${check.status}`
    );
    assert.equal(check.ok, check.status !== "fail", `${check.name}: ok must mirror status`);
  }
});

/**
 * A stand-in engine binary.
 *
 * Doctor's toolchain checks are empirical on purpose - they read what the
 * process actually writes and what it exits with - so the fixture has to be a
 * real process. There is no filename convention to fake: a GUI-subsystem Godot
 * build and a console one are told apart only by whether anything comes back
 * down the pipe.
 */
function installFakeEngine(binDir, name, scenario = "version") {
  fs.mkdirSync(binDir, { recursive: true });
  const source = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};

// A GUI-subsystem build: exits 0 with nothing on either stream, whatever it
// was asked to do.
if (scenario === "silent") {
  process.exit(0);
}

if (
  scenario === "headless-fails" &&
  (argv.includes("--headless") || argv.includes("--no-window") || argv.includes("--background"))
) {
  process.stderr.write("Unknown option --headless\\n");
  process.exit(1);
}

process.stdout.write("4.3.stable.official\\n");
process.exit(0);
`;
  writeExecutable(path.join(binDir, name), source);
}

function writeGodotProject(repo, { configVersion = 5, features = '"4.3", "Forward Plus"' } = {}) {
  fs.writeFileSync(
    path.join(repo, "project.godot"),
    `config_version=${configVersion}\n\n[application]\n\nconfig/name="Doctor Fixture"\nconfig/features=PackedStringArray(${features})\n`,
    "utf8"
  );
}

function doctorJson(repo, pluginDataDir, binDir, extraEnv = {}) {
  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, extraEnv)
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function findCheck(payload, name) {
  return payload.checks.find((check) => check.name === name);
}

/**
 * A path that cannot exist. Used instead of "leave it off PATH": buildEnv only
 * PREPENDS binDir, so the developer's own Godot install would leak in and the
 * absent-binary assertion would pass or fail depending on the machine.
 */
function nowhereBinary() {
  return path.join(makeTempDir(), "definitely-not-installed", "godot");
}

test("doctor probes the detected Godot toolchain", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  installFakeEngine(binDir, "godot");
  initGitRepo(repo);
  writeGodotProject(repo);

  const payload = doctorJson(repo, pluginDataDir, binDir);

  const ecosystem = findCheck(payload, "ecosystem");
  assert.ok(ecosystem, "an engine repo must say which engine was detected");
  assert.match(ecosystem.detail, /godot \(Godot 4\.3, config_version 5\)/);
  // Depth-1 scan is explicit so nested monorepos are not silently out of scope.
  assert.match(ecosystem.detail, /exactly one directory below it for every ecosystem/);

  const binary = findCheck(payload, "godot binary");
  assert.equal(binary?.status, "ok", JSON.stringify(binary));
  assert.match(binary.detail, /4\.3\.stable\.official/);

  assert.equal(findCheck(payload, "godot headless")?.status, "ok");
  assert.equal(findCheck(payload, "godot console output")?.status, "ok");
  assert.equal(payload.ok, true, "a healthy Godot toolchain is not needs-attention");
});

test("a missing engine binary is a warning, never a failure", () => {
  // A user may legitimately verify through an absolute path this code cannot
  // see, through the bpy pip module, or not at all. Calling that a broken
  // environment would make doctor cry wolf on every such repo.
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  writeGodotProject(repo);

  const payload = doctorJson(repo, pluginDataDir, binDir, {
    GROK_BUILD_GODOT_BIN: nowhereBinary()
  });

  const binary = findCheck(payload, "godot binary");
  assert.equal(binary?.status, "warn", JSON.stringify(binary));
  assert.equal(binary.ok, true, "a warn keeps the legacy boolean green");
  assert.match(binary.fix ?? "", /GROK_BUILD_GODOT_BIN/);
  assert.equal(payload.ok, true, "an absent engine must not fail the whole report");

  // No binary means nothing downstream was measured. Three warnings for one
  // problem is worse than one warning and two honest skips.
  assert.equal(findCheck(payload, "godot headless")?.status, "skipped");
  assert.equal(findCheck(payload, "godot console output"), undefined);
});

test("a build that cannot start headless is reported without condemning the install", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  installFakeEngine(binDir, "godot", "headless-fails");
  initGitRepo(repo);
  writeGodotProject(repo);

  const payload = doctorJson(repo, pluginDataDir, binDir);

  assert.equal(findCheck(payload, "godot binary")?.status, "ok", "the binary itself runs");
  const headless = findCheck(payload, "godot headless");
  assert.equal(headless?.status, "warn", JSON.stringify(headless));
  assert.match(headless.fix ?? "", /--no-window/, "Godot 3 guidance must be named");
  assert.equal(payload.ok, true);
});

test("a Godot build that writes nothing to a pipe is caught empirically", () => {
  // The GUI-subsystem win64 build exits 0 with both streams empty, which
  // silently defeats every output-pattern check: a verify run that cannot see
  // SCRIPT ERROR reports a broken project as verified.
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  installFakeEngine(binDir, "godot", "silent");
  initGitRepo(repo);
  writeGodotProject(repo);

  const payload = doctorJson(repo, pluginDataDir, binDir);

  // binaryAvailable substitutes the literal string "ok" for an empty detail,
  // so the silence is invisible to it - which is exactly why this check calls
  // runCommand directly instead of reading that detail.
  assert.equal(findCheck(payload, "godot binary")?.status, "ok");
  const console = findCheck(payload, "godot console output");
  assert.equal(console?.status, "warn", JSON.stringify(console));
  assert.match(console.detail, /writes nothing to stdout or stderr/);
  assert.match(console.fix ?? "", /tools\.godot/);
  assert.equal(payload.ok, true);
});

test("an unignored Godot import cache is a gitignore warning", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  writeGodotProject(repo);

  const missing = doctorJson(repo, pluginDataDir, binDir, {
    GROK_BUILD_GODOT_BIN: nowhereBinary()
  });
  const warned = findCheck(missing, "gitignore hygiene");
  assert.equal(warned?.status, "warn", JSON.stringify(warned));
  assert.match(warned.detail, /\.godot\/ is not ignored/);
  assert.match(warned.fix ?? "", /land/);

  fs.writeFileSync(path.join(repo, ".gitignore"), ".godot/\n", "utf8");
  const fixed = doctorJson(repo, pluginDataDir, binDir, {
    GROK_BUILD_GODOT_BIN: nowhereBinary()
  });
  assert.equal(findCheck(fixed, "gitignore hygiene")?.status, "ok");
});

test("a Godot 3 project is probed for .import, not .godot", () => {
  // Warning a Godot 4 project about an unignored .import/ it will never create
  // (or the reverse) is noise the user cannot act on.
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  writeGodotProject(repo, { configVersion: 4, features: '"3.5"' });
  fs.writeFileSync(path.join(repo, ".gitignore"), ".godot/\n", "utf8");

  const payload = doctorJson(repo, pluginDataDir, binDir, {
    GROK_BUILD_GODOT_BIN: nowhereBinary()
  });

  assert.match(findCheck(payload, "ecosystem").detail, /Godot 3\.5/);
  const hygiene = findCheck(payload, "gitignore hygiene");
  assert.equal(hygiene?.status, "warn", "a .godot/ rule does nothing for a Godot 3 project");
  assert.match(hygiene.detail, /\.import\//);
  // And the Godot 4 pattern must not be mentioned at all.
  assert.doesNotMatch(hygiene.detail, /\.godot\//);
});

test("a declared LFS filter that is not installed is a warning", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  writeGodotProject(repo);
  fs.writeFileSync(
    path.join(repo, ".gitattributes"),
    "*.blend filter=lfs diff=lfs merge=lfs -text\n",
    "utf8"
  );

  // git-lfs may well be installed on the machine running this suite, and its
  // `git lfs install` writes filter.lfs.* into the GLOBAL config - which would
  // make the warn case unreachable here. Point git at an empty global config
  // and disable the system one so the only config in play is this repo's.
  const emptyGlobal = path.join(makeTempDir(), "gitconfig");
  fs.writeFileSync(emptyGlobal, "", "utf8");
  const isolated = {
    GIT_CONFIG_GLOBAL: emptyGlobal,
    GIT_CONFIG_NOSYSTEM: "1",
    GROK_BUILD_GODOT_BIN: nowhereBinary()
  };
  const gitEnv = pluginDataEnv(pluginDataDir, binDir, isolated);
  run("git", ["config", "--unset-all", "filter.lfs.clean"], { cwd: repo, env: gitEnv });
  // Tracked, because the check reads `git ls-files`: an untracked
  // .gitattributes applies to nothing git does on another machine.
  run("git", ["add", ".gitattributes"], { cwd: repo, env: gitEnv });

  const warned = doctorJson(repo, pluginDataDir, binDir, isolated);
  const lfs = findCheck(warned, "git-lfs");
  assert.equal(lfs?.status, "warn", JSON.stringify(lfs));
  assert.match(lfs.detail, /\.gitattributes declares filter=lfs/);
  assert.match(lfs.fix ?? "", /git lfs install/);
  assert.equal(warned.ok, true);

  run("git", ["config", "filter.lfs.clean", "git-lfs clean -- %f"], { cwd: repo, env: gitEnv });
  assert.equal(findCheck(doctorJson(repo, pluginDataDir, binDir, isolated), "git-lfs")?.status, "ok");
});

test("a repo that declares no LFS filter gets no git-lfs line at all", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  writeGodotProject(repo);

  const payload = doctorJson(repo, pluginDataDir, binDir, {
    GROK_BUILD_GODOT_BIN: nowhereBinary()
  });
  assert.equal(findCheck(payload, "git-lfs"), undefined, "a green line nobody needs is noise");
});

test("a Blender add-on is probed with a background Python start", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  installFakeEngine(binDir, "blender");
  initGitRepo(repo);
  fs.writeFileSync(
    path.join(repo, "blender_manifest.toml"),
    'schema_version = "1.0.0"\nid = "fixture"\n',
    "utf8"
  );

  const payload = doctorJson(repo, pluginDataDir, binDir);

  assert.match(findCheck(payload, "ecosystem").detail, /blender \(detected by manifest\)/);
  assert.equal(findCheck(payload, "blender binary")?.status, "ok");
  assert.equal(findCheck(payload, "blender headless")?.status, "ok");
  // The console-exe probe is a Godot problem; Blender must not grow a line for
  // it just because the loop runs for both.
  assert.equal(findCheck(payload, "blender console output"), undefined);
  const hygiene = findCheck(payload, "gitignore hygiene");
  assert.equal(hygiene?.status, "warn");
  assert.match(hygiene.detail, /\*\.blend\[0-9\]/);
});

test("a repository with no engine emits no ecosystem checks at all", () => {
  // The gate exists so a plain Node repo's doctor output stays byte-identical
  // to what it was before these checks were written.
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"plain","version":"1.0.0"}\n', "utf8");

  const payload = doctorJson(repo, pluginDataDir, binDir);

  for (const name of ["ecosystem", "gitignore hygiene", "git-lfs"]) {
    assert.equal(findCheck(payload, name), undefined, `${name} must not be emitted`);
  }
  assert.equal(
    payload.checks.some((check) => /godot|blender/i.test(check.name)),
    false,
    "no engine checks for a repo with no engine"
  );
});

test("the ecosystem probes are fully injectable and spawn nothing", () => {
  // The hermetic seam: every process the ecosystem checks would start is an
  // option, so a test can describe an engine install that is not on this
  // machine without shipping one.
  const calls = [];
  const checks = buildEcosystemChecks("/fake/repo", {
    detectEcosystemsImpl: () => [
      { id: "godot", major: 4, minor: 2, configVersion: 5, cacheDir: ".godot", exeHint: "godot" }
    ],
    binaryAvailableImpl: (command, args) => {
      calls.push(["binaryAvailable", command, args.join(" ")]);
      return { available: true, detail: "4.2.stable" };
    },
    runCommandImpl: (command, args) => {
      calls.push(["runCommand", command, args.join(" ")]);
      return { status: 0, stdout: "4.2.stable", stderr: "", error: null };
    },
    gitImpl: (_root, args) => {
      calls.push(["git", args.join(" ")]);
      return { status: 0, stdout: "", stderr: "", error: null };
    },
    readFileImpl: () => "",
    platform: "win32"
  });

  const names = checks.map((check) => check.name);
  assert.deepEqual(names, [
    "ecosystem",
    "godot binary",
    "godot headless",
    "godot console output",
    "godot export templates",
    "gitignore hygiene"
  ]);
  assert.ok(
    calls.some(([kind, , args]) => kind === "binaryAvailable" && args === "--headless --version"),
    `Godot 4 must be probed with --headless: ${JSON.stringify(calls)}`
  );
  assert.ok(
    calls.some(([kind, args]) => kind === "git" && args.includes("check-ignore")),
    `gitignore hygiene must actually ask git: ${JSON.stringify(calls)}`
  );
  // ls-files returned nothing, so no .gitattributes declares LFS and the check
  // is correctly absent.
  assert.equal(names.includes("git-lfs"), false);
});

test("Godot 3 is probed with --no-window, which is the only flag it has", () => {
  const probed = [];
  buildEcosystemChecks("/fake/repo", {
    detectEcosystemsImpl: () => [
      { id: "godot", major: 3, minor: 5, configVersion: 4, cacheDir: ".import", exeHint: "godot" }
    ],
    binaryAvailableImpl: (_command, args) => {
      probed.push(args.join(" "));
      return { available: true, detail: "3.5.stable" };
    },
    runCommandImpl: () => ({ status: 0, stdout: "3.5.stable", stderr: "", error: null }),
    gitImpl: () => ({ status: 0, stdout: "", stderr: "", error: null }),
    readFileImpl: () => "",
    platform: "linux"
  });

  assert.deepEqual(probed, ["--version", "--no-window --version"]);
});

test("a gitignore probe that git cannot answer is skipped, not warned", () => {
  // Exit 128 means git failed (not a repository, unreadable .gitignore, no git
  // at all). Doctor learned nothing; claiming the gitignore is wrong on the
  // strength of a failed measurement is worse than saying nothing.
  const checks = buildEcosystemChecks("/fake/repo", {
    detectEcosystemsImpl: () => [
      { id: "godot", major: 4, minor: null, configVersion: 5, cacheDir: ".godot", exeHint: "godot" }
    ],
    binaryAvailableImpl: () => ({ available: false, detail: "not found" }),
    runCommandImpl: () => ({ status: 0, stdout: "", stderr: "", error: null }),
    gitImpl: (_root, args) =>
      args[0] === "check-ignore"
        ? { status: 128, stdout: "", stderr: "fatal: not a git repository", error: null }
        : { status: 0, stdout: "", stderr: "", error: null },
    readFileImpl: () => "",
    platform: "linux"
  });

  const hygiene = checks.find((check) => check.name === "gitignore hygiene");
  assert.equal(hygiene?.status, "skipped", JSON.stringify(hygiene));
  assert.equal(hygiene.fix, null, "a skip has nothing to fix");
});

test("prune with no runs reports nothing to do", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "prune", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.count, 0);
  assert.equal(payload.mode, "dry-run");
  assert.deepEqual(payload.items, []);
});

test("prune is a dry run by default and does not reclaim abandoned runs", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const jobId = generateJobId("run");
  withPluginData(pluginDataDir, () => {
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      kind: "task",
      kindLabel: "delegate",
      title: "Abandoned seed",
      jobClass: "task",
      bridgePid: 999999,
      agentPid: 999999,
      pid: 999999
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  });

  const result = run("node", [SCRIPT, "prune", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.applied, false);
  assert.ok(payload.count >= 1, `expected at least one prune item, got ${payload.count}`);
  assert.ok(payload.items.some((item) => item.jobId === jobId && item.type === "abandon"));

  withPluginData(pluginDataDir, () => {
    const stored = readJobFile(resolveJobFile(repo, jobId));
    assert.equal(stored.status, "running", "dry-run prune must not change job status");
  });
});

test("prune --apply marks a seeded abandoned job terminal", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const jobId = generateJobId("run");
  withPluginData(pluginDataDir, () => {
    const job = {
      id: jobId,
      status: "running",
      phase: "running",
      kind: "task",
      kindLabel: "delegate",
      title: "Abandoned seed apply",
      jobClass: "task",
      bridgePid: 999999,
      agentPid: 999999,
      pid: 999999
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  });

  const result = run("node", [SCRIPT, "prune", "--apply", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "apply");
  assert.equal(payload.applied, true);
  assert.ok(payload.items.some((item) => item.jobId === jobId && item.applied === true));

  withPluginData(pluginDataDir, () => {
    const stored = readJobFile(resolveJobFile(repo, jobId));
    assert.equal(stored.status, "failed");
    assert.match(stored.errorMessage ?? "", /abandoned/i);
    const jobs = listJobs(repo);
    const index = jobs.find((job) => job.id === jobId);
    assert.ok(index);
    assert.equal(index.status, "failed");
  });
});

function seedCompletedUnlandedWorktree(repo, pluginDataDir, status = "completed") {
  fs.writeFileSync(path.join(repo, "README.md"), "# seed\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const jobId = generateJobId("run");
  const created = createWorktree({
    cwd: repo,
    runId: jobId,
    dataDir: pluginDataDir
  });
  fs.writeFileSync(path.join(created.worktreePath, "unlanded.txt"), "keep me\n");
  run("git", ["add", "unlanded.txt"], { cwd: created.worktreePath });
  run("git", ["commit", "-m", "agent work"], { cwd: created.worktreePath });

  withPluginData(pluginDataDir, () => {
    const job = {
      id: jobId,
      status,
      phase: "done",
      kind: "task",
      kindLabel: "delegate",
      title: "Unlanded completed",
      jobClass: "task",
      summary: "successful isolate run",
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  });

  return { jobId, created };
}

test("prune plan excludes completed unlanded work by default", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const { jobId, created } = withPluginData(pluginDataDir, () =>
    seedCompletedUnlandedWorktree(repo, pluginDataDir)
  );

  const result = run("node", [SCRIPT, "prune", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.awaitingLand));
  assert.ok(
    payload.awaitingLand.some((item) => item.jobId === jobId && item.unmergedCommits > 0),
    "completed unlanded run must appear under awaitingLand"
  );
  assert.equal(
    payload.items.some((item) => item.jobId === jobId && item.type === "worktree"),
    false,
    "default prune plan must not schedule worktree removal for unlanded completed work"
  );
  assert.equal(fs.existsSync(created.worktreePath), true);

  const branchList = run("git", ["branch", "--list", created.branchName], { cwd: repo });
  assert.match(branchList.stdout, /grok-build\//);
});

test("doctor reports completed unlanded work as awaiting land, not prunable staleness", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  withPluginData(pluginDataDir, () => seedCompletedUnlandedWorktree(repo, pluginDataDir));

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const awaiting = payload.checks.find((check) => /awaiting land/i.test(check.name));
  assert.ok(awaiting, "doctor must include an awaiting land check");
  assert.equal(awaiting.ok, false);
  assert.match(awaiting.detail, /1 run\(s\) awaiting land/);
  assert.match(awaiting.fix ?? "", /\/turbo-build-plugin:land/);
  assert.doesNotMatch(awaiting.fix ?? "", /prune/i);

  const stale = payload.checks.find((check) => /stale worktrees/i.test(check.name));
  assert.ok(stale);
  assert.equal(stale.ok, true, "unlanded completed work must not count as prunable staleness");
});

test("prune plan also excludes completed-unverified and timed-out unlanded work", () => {
  // Regression found by a second-round audit: the awaiting-land guard only
  // recognized the literal string "completed", so a completed-unverified
  // run (it ran to completion, it just never passed verification) or a
  // timed-out run had its branch and real, unlanded commit destroyed by
  // prune --apply - and doctor's own recommended fix for exactly this case
  // was to run prune --apply, making the tool's own advice destructive.
  for (const status of ["completed-unverified", "timed-out"]) {
    const binDir = makeTempDir();
    const pluginDataDir = makeTempDir();
    const repo = makeTempDir();
    installFakeGrok(binDir);
    initGitRepo(repo);

    const { jobId, created } = withPluginData(pluginDataDir, () =>
      seedCompletedUnlandedWorktree(repo, pluginDataDir, status)
    );

    const dryRun = run("node", [SCRIPT, "prune", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryPayload = JSON.parse(dryRun.stdout);
    assert.ok(
      dryPayload.awaitingLand.some((item) => item.jobId === jobId),
      `${status}: must appear under awaitingLand`
    );

    const applied = run("node", [SCRIPT, "prune", "--apply", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.equal(applied.status, 0, applied.stderr);

    assert.equal(fs.existsSync(created.worktreePath), true, `${status}: worktree must survive --apply`);
    const branchList = run("git", ["branch", "--list", created.branchName], { cwd: repo });
    assert.match(branchList.stdout, /grok-build\//, `${status}: branch must survive --apply`);
  }
});

test("doctor reports completed-unverified unlanded work as awaiting land, not prunable staleness", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  withPluginData(pluginDataDir, () =>
    seedCompletedUnlandedWorktree(repo, pluginDataDir, "completed-unverified")
  );

  const result = run("node", [SCRIPT, "doctor", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const stale = payload.checks.find((check) => /stale worktree/i.test(check.name));
  assert.equal(stale?.ok, true, "must NOT be reported as stale worktree staleness");
  const awaiting = payload.checks.find((check) => /awaiting land/i.test(check.name));
  assert.ok(awaiting, "doctor must include an awaiting land check");
  assert.equal(awaiting.ok, false);
  assert.doesNotMatch(awaiting.fix ?? "", /prune/i, "must not recommend the destructive prune remedy");
});

function seedTerminalWorktree(repo, pluginDataDir, status, { commitWork = false, dirty = false } = {}) {
  fs.writeFileSync(path.join(repo, "README.md"), "# seed\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const jobId = generateJobId("run");
  const created = createWorktree({
    cwd: repo,
    runId: jobId,
    dataDir: pluginDataDir
  });
  if (commitWork) {
    fs.writeFileSync(path.join(created.worktreePath, "committed.txt"), "on branch\n");
    run("git", ["add", "committed.txt"], { cwd: created.worktreePath });
    run("git", ["commit", "-m", "agent work"], { cwd: created.worktreePath });
  }
  if (dirty) {
    fs.writeFileSync(path.join(created.worktreePath, "DIRTY.txt"), "uncommitted assets\n");
  }

  withPluginData(pluginDataDir, () => {
    const job = {
      id: jobId,
      status,
      phase: "done",
      kind: "task",
      kindLabel: "delegate",
      title: `Seeded ${status}`,
      jobClass: "task",
      summary: status,
      worktree: {
        path: created.worktreePath,
        branch: created.branchName,
        baseSha: created.baseSha
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJobFile(repo, jobId, job);
    upsertJob(repo, job);
  });

  return { jobId, created };
}

test("prune protects a cancelled job with a dirty worktree from --apply", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const { jobId, created } = withPluginData(pluginDataDir, () =>
    seedTerminalWorktree(repo, pluginDataDir, "cancelled", { dirty: true })
  );

  const dryRun = run("node", [SCRIPT, "prune", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.ok(
    dryPayload.awaitingLand.some((item) => item.jobId === jobId),
    "cancelled dirty worktree must appear under awaitingLand"
  );
  assert.equal(
    dryPayload.items.some((item) => item.jobId === jobId && item.type === "worktree"),
    false,
    "default prune plan must not schedule removal of dirty cancelled worktree"
  );

  const applied = run("node", [SCRIPT, "prune", "--apply", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.existsSync(created.worktreePath), true, "dirty cancelled worktree must survive --apply");
  assert.equal(
    fs.existsSync(path.join(created.worktreePath, "DIRTY.txt")),
    true,
    "uncommitted work must not be force-deleted"
  );
  const branchList = run("git", ["branch", "--list", created.branchName], { cwd: repo });
  assert.match(branchList.stdout, /grok-build\//, "branch must survive");
});

test("prune protects an isolation-breached job with commits from --apply", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const { jobId, created } = withPluginData(pluginDataDir, () =>
    seedTerminalWorktree(repo, pluginDataDir, "isolation-breached", { commitWork: true })
  );

  const dryRun = run("node", [SCRIPT, "prune", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryPayload = JSON.parse(dryRun.stdout);
  assert.ok(
    dryPayload.awaitingLand.some((item) => item.jobId === jobId && item.unmergedCommits > 0),
    "isolation-breached with commits must appear under awaitingLand"
  );

  const applied = run("node", [SCRIPT, "prune", "--apply", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.existsSync(created.worktreePath), true, "isolation-breached worktree must survive");
  const branchList = run("git", ["branch", "--list", created.branchName], { cwd: repo });
  assert.match(branchList.stdout, /grok-build\//, "isolation-breached branch must survive");
});

test("a trusted project config drives verification end to end", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  // Passes unconditionally and needs no binary beyond node, so the assertion
  // is about WHERE the command came from, not about what it does.
  const verifyCommand = 'node -e "process.exit(0)"';
  fs.writeFileSync(
    path.join(repo, ".grok-build.json"),
    `${JSON.stringify({ verify: [verifyCommand] }, null, 2)}\n`,
    "utf8"
  );
  // Isolated --write needs a HEAD commit to create the worktree against.
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md", ".grok-build.json"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  // Untrusted first: the run must NOT execute a command the user has not
  // vouched for, even though the file is right there in the repo.
  // Read-only on purpose — trust gating is independent of write/verify skip.
  const untrusted = run("node", [SCRIPT, "run", "--json", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(untrusted.status, 0, untrusted.stderr || untrusted.stdout);
  const untrustedPayload = JSON.parse(untrusted.stdout);
  assert.deepEqual(untrustedPayload.verify.commands, []);
  assert.deepEqual(untrustedPayload.verify.plan.configWithheld, ["verify"]);

  const trust = run("node", [SCRIPT, "trust-config", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(trust.status, 0, trust.stderr);
  assert.equal(JSON.parse(trust.stdout).recorded, true);

  // FIELD-3: read-only runs skip baseline + verify entirely, so verified is
  // null even when a trusted config would otherwise drive them. Assert that
  // skip here, then prove the real end-to-end path on a --write run below.
  const readOnly = run("node", [SCRIPT, "run", "--json", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(readOnly.status, 0, readOnly.stderr || readOnly.stdout);
  const readOnlyPayload = JSON.parse(readOnly.stdout);
  assert.deepEqual(readOnlyPayload.verify.commands, [verifyCommand]);
  assert.equal(readOnlyPayload.verify.plan.source, "config");
  assert.equal(readOnlyPayload.verify.plan.configTrusted, true);
  assert.equal(readOnlyPayload.verified, null, "read-only runs skip verify (FIELD-3)");
  assert.equal(readOnlyPayload.verify.baselines.length, 0, "read-only runs skip baseline too");

  // Write run is what actually executes the trusted config's verify plan.
  const result = run("node", [SCRIPT, "run", "--write", "--json", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.verify.commands, [verifyCommand]);
  assert.equal(payload.verify.plan.source, "config");
  assert.equal(payload.verify.plan.configTrusted, true);
  assert.equal(payload.verified, true, "the config's verify command passes");
  assert.equal(payload.verify.baselines.length, 1, "the baseline probe covered the resolved command");
});

test("--no-verify opts out of a trusted config's plan", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const repo = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  // Read-only runs isolate by default (R6-1) and need a commit for worktree add.
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  run("git", ["add", "seed.txt"], { cwd: repo });
  run("git", ["commit", "-m", "seed"], { cwd: repo });

  fs.writeFileSync(
    path.join(repo, ".grok-build.json"),
    `${JSON.stringify({ verify: ['node -e "process.exit(1)"'] }, null, 2)}\n`,
    "utf8"
  );
  run("node", [SCRIPT, "trust-config"], { cwd: repo, env: pluginDataEnv(pluginDataDir, binDir) });

  const result = run("node", [SCRIPT, "run", "--json", "--no-verify", "do something"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.verify.commands, []);
  assert.equal(payload.verify.plan.disabled, true);
  // A failing command that never ran must not be able to report a verdict.
  assert.equal(payload.verified, null);
});
