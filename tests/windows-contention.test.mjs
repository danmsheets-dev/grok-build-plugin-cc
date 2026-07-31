// Field report (Powder & Plunder, 0.5.0, Windows/Hyper/Godot): every
// `--background` run died with a 117-byte log, no terminal claim, and the
// generic "Run abandoned; process exited without a terminal claim."
//
// Root cause: Windows refuses a rename over a file any other process has open,
// and the documented workflow is `run --background` + poll `runs`. The poll
// loop IS that other process. Every job-file write the detached worker
// attempted while a poll was in flight threw EPERM; the throw surfaced inside a
// child-process stream handler, so it was an uncaught exception rather than a
// rejected promise, and it killed the worker without running a single catch.
//
// Measured on the reporter's platform before the fix: 43 renames succeeded and
// 15,802 failed with EPERM under four concurrent readers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  createJobProgressUpdater,
  createProgressReporter
} from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobFile, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

const STATE_MODULE = pathToFileURL(
  path.resolve("plugins/grok-build/scripts/lib/state.mjs")
).href;

/**
 * Spawn N processes that read `target` in a tight loop for `durationMs`.
 * Returns a stop function that resolves once they have all exited.
 */
function startReaderStorm(target, count, durationMs, dataDir) {
  const readerPath = path.join(dataDir, "storm-reader.mjs");
  fs.writeFileSync(
    readerPath,
    `import fs from "node:fs";
const end = Date.now() + ${durationMs};
while (Date.now() < end) {
  try { fs.readFileSync(process.argv[2], "utf8"); } catch {}
}
`,
    "utf8"
  );
  const children = [];
  for (let i = 0; i < count; i += 1) {
    children.push(spawn(process.execPath, [readerPath, target], { stdio: "ignore" }));
  }
  return () =>
    Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode != null) {
              resolve();
              return;
            }
            child.on("exit", resolve);
            child.kill();
          })
      )
    );
}

test("a job-file write survives concurrent readers holding the target open", async () => {
  // The exact shape that killed background runs: one writer, several readers.
  // Before the retry loop in writeFileAtomic this failed on the first contended
  // write with EPERM on Windows. On POSIX it passes trivially, which is why the
  // bug was invisible everywhere except the platform that reported it.
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const dataDir = makeTempDir("contention-data-");
  const repo = makeTempDir("contention-repo-");
  process.env.CLAUDE_PLUGIN_DATA = dataDir;

  try {
    const jobId = "run-contention";
    writeJobFile(repo, jobId, { id: jobId, status: "queued" });
    const target = resolveJobFile(repo, jobId);

    const stopReaders = startReaderStorm(target, 4, 6000, dataDir);
    try {
      const deadline = Date.now() + 3000;
      let writes = 0;
      while (Date.now() < deadline) {
        // A throw here is the bug: it is what reached the worker's stream
        // handler and terminated the process.
        writeJobFile(repo, jobId, { id: jobId, status: "running", n: writes });
        writes += 1;
      }
      assert.ok(writes > 0, "the writer must make progress under reader contention");
      const final = readJobFile(target);
      assert.equal(final.status, "running");
      assert.equal(final.n, writes - 1, "the last write must be the one readable on disk");
    } finally {
      await stopReaders();
    }
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

/**
 * Have ANOTHER process tear `target`, then restore `content` a beat later.
 *
 * It has to be another process. The retry loops under test block the thread
 * (they are called from synchronous paths deep inside a run), so a same-process
 * timer could never fire while a read is retrying - and would prove nothing
 * about the real case, which is always a second process finishing its write.
 *
 * The parent waits for the child's "torn" line before reading. Without that
 * handshake the test would be racing Node's cold start against the retry
 * window, which fails under parallel-suite load for reasons that have nothing
 * to do with the behaviour being tested.
 *
 * @returns {Promise<void>} resolves once the tear has landed
 */
function tearAndRestoreFromAnotherProcess(target, torn, content, restoreDelayMs, dataDir, name) {
  const scriptPath = path.join(dataDir, name);
  fs.writeFileSync(
    scriptPath,
    `import fs from "node:fs";
const [target, torn, content, delay] = process.argv.slice(2);
fs.writeFileSync(target, torn, "utf8");
process.stdout.write("torn\\n");
const buffer = new SharedArrayBuffer(4);
Atomics.wait(new Int32Array(buffer), 0, 0, Number(delay));
fs.writeFileSync(target, content, "utf8");
`,
    "utf8"
  );
  const child = spawn(
    process.execPath,
    [scriptPath, target, torn, content, String(restoreDelayMs)],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  return new Promise((resolve, reject) => {
    let seen = "";
    child.stdout.on("data", (chunk) => {
      seen += chunk;
      if (seen.includes("torn")) {
        resolve();
      }
    });
    child.on("exit", () => (seen.includes("torn") ? resolve() : reject(new Error("child never tore the file"))));
  });
}

test("readJobFile rides out a torn read left by another process", async () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const dataDir = makeTempDir("torn-data-");
  const repo = makeTempDir("torn-repo-");
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const jobId = "run-torn";
    writeJobFile(repo, jobId, { id: jobId, status: "completed" });
    const target = resolveJobFile(repo, jobId);
    // Truncated JSON is what an in-place fallback write looks like to a reader
    // that arrives mid-write. It must not be mistaken for corruption.
    await tearAndRestoreFromAnotherProcess(
      target,
      '{"id":"run-torn","stat',
      JSON.stringify({ id: jobId, status: "completed" }),
      30,
      dataDir,
      "restore-job.mjs"
    );
    const record = readJobFile(target);
    assert.equal(record.status, "completed");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("a failing status patch never propagates out of the progress updater", () => {
  // Defence in depth for the actual kill mechanism. This updater is invoked
  // from the CLI child's stdout/'close' handlers; anything it throws is an
  // uncaught exception that walks past runTrackedJob's catch and past main()'s,
  // and in a detached worker (stdio: "ignore") that exit is completely silent.
  const update = createJobProgressUpdater("/workspace", "run-x", {
    patchImpl: () => {
      throw new Error("EPERM: operation not permitted, rename");
    }
  });
  assert.doesNotThrow(() => update({ phase: "verifying", message: "baseline" }));
});

test("a failing log write never propagates out of the progress reporter", () => {
  const reporter = createProgressReporter({
    logFile: null,
    onEvent: () => {
      throw new Error("EBUSY: resource busy or locked");
    }
  });
  assert.doesNotThrow(() => reporter({ message: "Grok finished." }));
});

test("loadState retries before quarantining, so a torn read cannot destroy the index", async () => {
  // The failure branch here RENAMES the state file away. A torn read caught
  // mid-write would therefore not merely fail one command - it would move every
  // run record in the workspace aside and declare the state corrupt.
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const dataDir = makeTempDir("quarantine-data-");
  const repo = makeTempDir("quarantine-repo-");
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  try {
    const { loadState, resolveStateFile, saveState } = await import(STATE_MODULE);
    saveState(repo, { version: 1, config: {}, jobs: [{ id: "run-keep", status: "completed" }] });
    const stateFile = resolveStateFile(repo);

    const good = fs.readFileSync(stateFile, "utf8");
    await tearAndRestoreFromAnotherProcess(
      stateFile,
      '{"version":1,"jobs":[{"id":"run-k',
      good,
      30,
      dataDir,
      "restore-state.mjs"
    );

    const state = loadState(repo);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].id, "run-keep");
    const quarantined = fs
      .readdirSync(path.dirname(stateFile))
      .filter((name) => name.includes(".corrupt-"));
    assert.deepEqual(quarantined, [], "a recoverable read must not quarantine the state file");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("os tmpdir is available for the storm fixtures", () => {
  // Guards the fixture itself: makeTempDir is the only reason these tests can
  // run hermetically, and a broken tmpdir would make the storm silently no-op.
  assert.ok(fs.existsSync(os.tmpdir()));
});
