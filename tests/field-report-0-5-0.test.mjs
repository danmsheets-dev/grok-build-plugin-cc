// Regressions for the Powder & Plunder field report against bridge 0.5.0
// (Windows / Hyper / Godot). One test per reported failure mode, named after
// what the operator actually saw rather than after the code that was wrong.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  detectImplausiblyShort,
  promptForbidsEdits,
  readWorkerCrashDetail,
  resolveWorkerCrashLog
} from "../plugins/grok-build/scripts/grok-bridge.mjs";
import { ensureHomeEnv, resetHomeEnvDefaultForTests } from "../plugins/grok-build/scripts/lib/grok.mjs";
import { reconcileAbandonedJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { probeBaselines } from "../plugins/grok-build/scripts/lib/verify.mjs";
import {
  checkUidIntegrity,
  collectImportedUidTokens,
  snapshotUidFiles
} from "../plugins/grok-build/scripts/lib/engine-runtime.mjs";

// ---------------------------------------------------------------------------
// B: "HOME not set on Windows tool shells"
// ---------------------------------------------------------------------------

test("Windows without HOME gets one from %USERPROFILE% instead of a doomed run", () => {
  resetHomeEnvDefaultForTests();
  const env = { USERPROFILE: "C:\\Users\\dan_m" };
  const result = ensureHomeEnv(env, "win32");
  assert.equal(result.applied, true);
  assert.equal(env.HOME, "C:\\Users\\dan_m");
  assert.equal(env.GROK_HOME, "C:\\Users\\dan_m");
});

test("an explicit HOME is never overwritten", () => {
  resetHomeEnvDefaultForTests();
  const env = { HOME: "D:\\custom", USERPROFILE: "C:\\Users\\dan_m" };
  const result = ensureHomeEnv(env, "win32");
  assert.equal(result.applied, false);
  assert.equal(env.HOME, "D:\\custom");
});

test("a second call still reports that this process supplied the default", () => {
  // doctor asks again after main() has already filled it. Reporting a plain
  // "ok" there would tell the user their shell is fine when nothing in it sets
  // HOME - the next command they run by hand would still be missing one.
  resetHomeEnvDefaultForTests();
  const env = { USERPROFILE: "C:\\Users\\dan_m" };
  ensureHomeEnv(env, "win32");
  const second = ensureHomeEnv(env, "win32");
  assert.equal(second.applied, false);
  assert.equal(second.defaulted, true);
  assert.equal(second.source, "USERPROFILE");
});

test("POSIX without HOME is left alone", () => {
  resetHomeEnvDefaultForTests();
  const env = {};
  const result = ensureHomeEnv(env, "linux");
  assert.equal(result.applied, false);
  assert.equal(env.HOME, undefined);
});

// ---------------------------------------------------------------------------
// C: "pre-agent baseline verify blocks agent start with no progress UX"
// ---------------------------------------------------------------------------

test("the baseline reports each command as it starts and as it lands", async () => {
  // The report: four Godot commands, one log line, then several minutes of
  // silence with agentPid null - indistinguishable from a hang.
  const events = [];
  const commands = ["godot --check-only", "godot --import", "gut -gexit"];
  const outcomes = { "godot --check-only": true, "godot --import": true, "gut -gexit": false };

  await probeBaselines(commands, "/repo", {
    onProgress: (event) => events.push(event.message),
    runVerifyCommandImpl: async (command) => ({ ok: outcomes[command], output: "" })
  });

  assert.equal(events.length, 6, "each command reports a start and an end");
  assert.match(events[0], /^Verify baseline 1\/3: running godot --check-only$/);
  assert.match(events[1], /^Verify baseline 1\/3: already passing in /);
  assert.match(events[4], /^Verify baseline 3\/3: running gut -gexit$/);
  assert.match(events[5], /^Verify baseline 3\/3: already failing in /);
  for (const message of events) {
    // Position in the plan on every line: the operator needs to know which of
    // the four Godot commands the silence belongs to, not just that one is running.
    assert.ok(message.includes("/3"), `expected a position marker in: ${message}`);
  }
});

test("the baseline still probes correctly with no progress sink attached", async () => {
  const baselines = await probeBaselines(["cmd-a"], "/repo", {
    runVerifyCommandImpl: async () => ({ ok: true, output: "" })
  });
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].ok, true);
});

// ---------------------------------------------------------------------------
// D: "diagnostics gap when processes die"
// ---------------------------------------------------------------------------

test("an abandoned run carries the worker's own crash output, not just 'abandoned'", () => {
  // Before: two runs, one with HOME set and one without, produced byte-identical
  // 117-byte logs and the same generic sentence. Nothing distinguished them.
  const claims = [];
  const job = {
    id: "run-dead",
    status: "running",
    pid: 999999,
    lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString()
  };

  reconcileAbandonedJob("/workspace", job, {
    claimImpl: (root, id, status, patch) => {
      claims.push({ id, status, patch });
      return { claimed: true };
    },
    killImpl: () => {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    },
    resolveCrashDetail: () => "EPERM: operation not permitted, rename '...tmp' -> 'state.json'"
  });

  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, "failed");
  assert.match(claims[0].patch.errorMessage, /Run abandoned/);
  assert.match(claims[0].patch.errorMessage, /EPERM: operation not permitted/);
});

test("no crash output still yields the plain abandoned claim", () => {
  const claims = [];
  reconcileAbandonedJob(
    "/workspace",
    { id: "run-dead", status: "running", pid: 999999, lastHeartbeatAt: new Date(0).toISOString() },
    {
      claimImpl: (root, id, status, patch) => claims.push({ status, patch }) && { claimed: true },
      killImpl: () => {
        const error = new Error("no such process");
        error.code = "ESRCH";
        throw error;
      },
      resolveCrashDetail: () => null
    }
  );
  assert.equal(claims[0].patch.errorMessage, "Run abandoned; process exited without a terminal claim.");
});

test("a crash-detail lookup that throws cannot break reconciliation", () => {
  const claims = [];
  assert.doesNotThrow(() =>
    reconcileAbandonedJob(
      "/workspace",
      { id: "run-dead", status: "running", pid: 999999, lastHeartbeatAt: new Date(0).toISOString() },
      {
        claimImpl: (root, id, status, patch) => claims.push({ patch }) && { claimed: true },
        killImpl: () => {
          const error = new Error("no such process");
          error.code = "ESRCH";
          throw error;
        },
        resolveCrashDetail: () => {
          throw new Error("unreadable");
        }
      }
    )
  );
  assert.equal(claims.length, 1);
});

test("the worker crash log is read back tail-first and bounded", () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const dataDir = makeTempDir("crashlog-data-");
  const repo = makeTempDir("crashlog-repo-");
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const jobId = "run-crash";
    const crashLog = resolveWorkerCrashLog(repo, jobId);
    assert.equal(readWorkerCrashDetail(repo, jobId), null, "no file means no detail, not a throw");

    fs.writeFileSync(crashLog, `${"x".repeat(5000)}\nTypeError: boom\n`, "utf8");
    const detail = readWorkerCrashDetail(repo, jobId, { maxChars: 100 });
    assert.ok(detail.startsWith("…"), "an over-long crash stream is elided from the front");
    assert.ok(detail.endsWith("TypeError: boom"), "the tail carries the error that matters");
    assert.ok(detail.length <= 101);

    fs.writeFileSync(crashLog, "   \n  \n", "utf8");
    assert.equal(readWorkerCrashDetail(repo, jobId), null, "whitespace is not a crash");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

// ---------------------------------------------------------------------------
// E1: "implausiblyShort: true on a deliberate no-edit ping"
// ---------------------------------------------------------------------------

test("a brief that forbids edits is not called implausibly short for making none", () => {
  // Verbatim from the field report's successful smoke run.
  const prompt =
    "Reply with exactly: PING_OK and list files matching scripts/core/scatter_rules.gd. Do not edit anything.";
  assert.equal(promptForbidsEdits(prompt), true);
  assert.equal(
    detectImplausiblyShort({
      write: true,
      durationMs: 19_000,
      changedFileCount: 0,
      toolCallCount: null,
      promptForbidsEdits: true
    }),
    false
  );
});

test("a real write brief that changed nothing is still flagged", () => {
  assert.equal(promptForbidsEdits("Implement the scatter-density ladder."), false);
  assert.equal(
    detectImplausiblyShort({
      write: true,
      durationMs: 19_000,
      changedFileCount: 0,
      toolCallCount: null,
      promptForbidsEdits: false
    }),
    true
  );
});

test("promptForbidsEdits matches prohibitions, not any mention of reading", () => {
  for (const yes of [
    "Audit the parser. Read-only, no changes.",
    "Don't modify any files; just report findings.",
    "Review this and do not change anything",
    "Investigate without editing the tree",
    "Make no changes to the repo."
  ]) {
    assert.equal(promptForbidsEdits(yes), true, yes);
  }
  for (const no of [
    "Read the parser, then fix the off-by-one bug.",
    "Edit the scatter rules to add a density ladder.",
    "Change nothing about the public API, but implement the ladder internally."
  ]) {
    assert.equal(promptForbidsEdits(no), false, no);
  }
});

// ---------------------------------------------------------------------------
// E2: "55 dangling uid:// refs on a clean project"
// ---------------------------------------------------------------------------

function buildGodotProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uid-project-"));
  const write = (rel, body) => {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  };

  // Imported assets: uid lives in the .import sidecar, never in a .uid file.
  write("art/ship.png", "fake");
  write("art/ship.png.import", '[remap]\nuid="uid://bimportedtex01"\n');
  write("audio/cannon.wav", "fake");
  write("audio/cannon.wav.import", '[remap]\nuid="uid://bimportedwav02"\n');

  // Hand-authored script with a real .uid companion.
  write("scripts/core/scatter_rules.gd", "extends Node\n");
  write("scripts/core/scatter_rules.gd.uid", "uid://bscript0003\n");

  // Vendored GUT add-on: snapshotUidFiles skips addons/gut for change
  // attribution, but its scenes are read by the reference collector.
  write("addons/gut/gut_cmdln.gd", "extends SceneTree\n");
  write("addons/gut/gut_cmdln.gd.uid", "uid://bgutscript04\n");
  write(
    "addons/gut/gut_scene.tscn",
    '[ext_resource type="Script" uid="uid://bgutscript04" path="res://addons/gut/gut_cmdln.gd" id="1"]\n'
  );

  write(
    "scenes/main.tscn",
    '[ext_resource type="Texture2D" uid="uid://bimportedtex01" path="res://art/ship.png" id="1"]\n' +
      '[ext_resource type="AudioStream" uid="uid://bimportedwav02" path="res://audio/cannon.wav" id="2"]\n' +
      '[ext_resource type="Script" uid="uid://bscript0003" path="res://scripts/core/scatter_rules.gd" id="3"]\n' +
      '[ext_resource type="Script" uid="uid://bgutscript04" path="res://addons/gut/gut_cmdln.gd" id="4"]\n'
  );
  return root;
}

test("a healthy Godot project reports no dangling uid references", () => {
  const root = buildGodotProject();
  const result = checkUidIntegrity(snapshotUidFiles(root), root);
  assert.deepEqual(result.danglingRefs, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.notes, []);
});

test("imported-asset uids are harvested from .import sidecars", () => {
  const root = buildGodotProject();
  const tokens = collectImportedUidTokens(root);
  assert.ok(tokens.has("uid://bimportedtex01"));
  assert.ok(tokens.has("uid://bimportedwav02"));
});

test("a genuinely deleted .uid is still caught", () => {
  // The check exists for real damage: Godot regenerates a missing .uid with a
  // NEW random id and silently breaks every ext_resource pointing at the old
  // one. Suppressing false positives must not suppress this.
  const root = buildGodotProject();
  const before = snapshotUidFiles(root);
  fs.unlinkSync(path.join(root, "scripts/core/scatter_rules.gd.uid"));
  const result = checkUidIntegrity(before, root);
  assert.equal(result.ok, false);
  assert.deepEqual(result.deleted, ["scripts/core/scatter_rules.gd.uid"]);
  assert.deepEqual(result.danglingRefs, ["uid://bscript0003"]);
});

test("a rewritten .uid token is still caught", () => {
  const root = buildGodotProject();
  const before = snapshotUidFiles(root);
  fs.writeFileSync(path.join(root, "scripts/core/scatter_rules.gd.uid"), "uid://bREWRITTEN99\n", "utf8");
  const result = checkUidIntegrity(before, root);
  assert.equal(result.ok, false);
  assert.equal(result.rewritten.length, 1);
  assert.equal(result.rewritten[0].before, "uid://bscript0003");
  assert.equal(result.rewritten[0].after, "uid://bREWRITTEN99");
});

test("a reference to a uid nothing declares is still dangling", () => {
  const root = buildGodotProject();
  fs.writeFileSync(
    path.join(root, "scenes", "broken.tscn"),
    '[ext_resource type="Texture2D" uid="uid://bnothingdeclares" path="res://art/missing.png" id="1"]\n',
    "utf8"
  );
  const result = checkUidIntegrity(snapshotUidFiles(root), root);
  assert.deepEqual(result.danglingRefs, ["uid://bnothingdeclares"]);
});
