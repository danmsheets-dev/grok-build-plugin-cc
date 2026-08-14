import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import { resolveExecutable } from "../plugins/grok-build/scripts/lib/which.mjs";
import {
  resolveMaxOutputBytes,
  runCommand,
  runCommandAsync,
  terminateProcessTree
} from "../plugins/grok-build/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    settleMs: 0,
    // After a clean taskkill the path re-probes liveness; report dead so we
    // do not escalate into PowerShell. killImpl is unused when isAliveImpl is set.
    isAliveImpl: () => false,
    runCommandImpl(command, args) {
      if (command === "taskkill") {
        captured = { command, args };
      }
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped (C24)", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: 'ERROR: The process "1234" not found.',
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  // delivered means observed-dead — already-exited is success, not a tombstone.
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.alreadyExited, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree uses process-group SIGTERM then escalates to SIGKILL on posix", () => {
  const signals = [];
  let alive = true;
  const outcome = terminateProcessTree(4321, {
    platform: "darwin",
    graceMs: 40,
    isAliveImpl: () => alive,
    killImpl(pid, signal) {
      signals.push({ pid, signal });
      if (signal === 0) {
        if (!alive) {
          const error = new Error("no such process");
          error.code = "ESRCH";
          throw error;
        }
        return true;
      }
      if (signal === "SIGKILL") {
        alive = false;
      }
    }
  });

  assert.ok(signals.some((entry) => entry.pid === -4321 && entry.signal === "SIGTERM"));
  assert.ok(signals.some((entry) => entry.signal === "SIGKILL"));
  assert.equal(outcome.delivered, true);
  assert.match(outcome.method, /sigkill|process-group/);
});

test("terminateProcessTree reports delivered false when process is already gone", () => {
  const outcome = terminateProcessTree(999001, {
    platform: "darwin",
    killImpl() {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
});

test("runCommand maps signalled exits to non-zero status", () => {
  const result = runCommand("unused", [], {
    spawnSyncImpl() {
      return {
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, "SIGTERM");
});

test("runCommand preserves explicit zero status without a signal", () => {
  const result = runCommand("unused", [], {
    spawnSyncImpl() {
      return {
        status: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});

test("runCommand honors an explicit shell override", () => {
  let captured = null;

  runCommand("git", ["status"], {
    shell: false,
    spawnSyncImpl(command, args, options) {
      captured = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    }
  });

  assert.match(String(captured.command), /git/i);
  assert.deepEqual(captured.args, ["status"]);
  assert.equal(captured.options.shell, false);
});

test("runCommand keeps metacharacter args discrete when shell is disabled", () => {
  let captured = null;
  const maliciousRef = "main&probe.cmd";

  runCommand("git", ["merge-base", "HEAD", maliciousRef], {
    shell: false,
    spawnSyncImpl(command, args, options) {
      captured = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: "abc123\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.match(String(captured.command), /git/i);
  assert.deepEqual(captured.args, ["merge-base", "HEAD", maliciousRef]);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.args[2], maliciousRef);
  assert.ok(!captured.args.some((arg) => arg === "probe.cmd"));
});

test("resolveExecutable finds a PATHEXT match on windows", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "widget.cmd"), "@echo off\r\necho hi\r\n");

  const resolved = resolveExecutable("widget", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");
  assert.equal(resolved, path.join(dir, "widget.cmd"));
});

test("resolveExecutable returns the command unchanged when nothing matches", () => {
  const dir = makeTempDir();
  assert.equal(resolveExecutable("nope", { PATH: dir, PATHEXT: ".EXE" }, "win32"), "nope");
});

test("resolveExecutable is a passthrough off windows", () => {
  assert.equal(resolveExecutable("git", { PATH: "/usr/bin" }, "linux"), "git");
});

test("resolveExecutable leaves absolute paths alone", () => {
  const absolute = path.join(makeTempDir(), "tool.exe");
  assert.equal(resolveExecutable(absolute, { PATH: "" }, "win32"), absolute);
});

test("runCommand emits no DEP0190 deprecation warning", () => {
  const result = runCommand(process.execPath, ["--version"]);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /DEP0190/);
});

test("resolveExecutable prefers a PATHEXT match over a sibling extensionless shim", () => {
  // Regression: npm-style bin directories (node_modules/.bin/*, npm's global
  // bin dir) ship an extensionless POSIX shim ALONGSIDE a .cmd wrapper for
  // the same tool. Checking the bare name first resolved to the POSIX shim,
  // which Windows CreateProcess cannot execute, producing ENOENT even though
  // a working .cmd sat right next to it.
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "eslint"), "#!/bin/sh\necho posix shim\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "eslint.cmd"), "@echo off\r\necho windows wrapper\r\n");

  const resolved = resolveExecutable("eslint", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");
  assert.equal(resolved, path.join(dir, "eslint.cmd"));
});

test("resolveExecutable still falls back to a bare match when no PATHEXT sibling exists", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "widget"), "#!/usr/bin/env node\n", { mode: 0o755 });

  const resolved = resolveExecutable("widget", { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");
  assert.equal(resolved, path.join(dir, "widget"));
});

test("runCommand can actually invoke a resolved .cmd file end to end on Windows", () => {
  if (process.platform !== "win32") {
    return;
  }
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "argecho.js"), 'console.log("ARGS:" + JSON.stringify(process.argv.slice(2)));\n');
  fs.writeFileSync(path.join(dir, "argecho.cmd"), '@echo off\r\nnode "%~dp0argecho.js" %*\r\n');
  fs.writeFileSync(path.join(dir, "argecho"), '#!/bin/sh\nexec node "$(dirname "$0")/argecho.js" "$@"\n', {
    mode: 0o755
  });

  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH };
  const args = ["a", "b c", 'has "quotes" inside', "trailing\\"];
  const result = runCommand("argecho", args, { env });

  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim(), "ARGS:" + JSON.stringify(args));
});

test("runCommandAsync reports a real exit code without blocking the event loop", async () => {
  let ticks = 0;
  const ticker = setInterval(() => {
    ticks += 1;
  }, 20);
  try {
    const result = await runCommandAsync(process.execPath, [
      "-e",
      "setTimeout(()=>{process.stdout.write('done');process.exit(3)}, 400)"
    ]);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, "done");
    assert.equal(result.error, null);
  } finally {
    clearInterval(ticker);
  }
  // spawnSync scored exactly 0 here: nothing on the loop could run while a
  // verify command was in flight, which is why the job heartbeat died.
  assert.ok(ticks > 3, `expected the event loop to keep running, got ${ticks} ticks`);
});

test("runCommandAsync bounds output with a head+tail ring instead of an ENOBUFS cliff", async () => {
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "for(let i=0;i<40000;i++){console.log(i+' '+'y'.repeat(200))}"],
    { maxOutputBytes: 64 * 1024 }
  );

  assert.equal(result.status, 0, "the command must still report its real exit code");
  assert.equal(result.error, null, "overflow is no longer an error condition");
  assert.ok(result.elidedBytes > 0);
  assert.ok(result.stdout.length < 96 * 1024, `unbounded capture: ${result.stdout.length} bytes`);
  assert.match(result.stdout, /^0 y{200}/);
  assert.ok(result.stdout.includes(`39999 ${"y".repeat(200)}`), "expected the tail to survive");
  assert.match(result.stdout, /\.\.\.\[elided \d+ bytes of output\]\.\.\./);
});

test("runCommandAsync scales the ring down with a small budget", async () => {
  // A caller that asks for 4 KB must get roughly 4 KB, not the 320 KB the
  // fixed head/tail sizes would keep.
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "for(let i=0;i<2000;i++){console.log(i+' '+'z'.repeat(100))}"],
    { maxOutputBytes: 4096 }
  );

  assert.equal(result.status, 0);
  assert.ok(result.stdout.length < 8192, `expected ~4KB, got ${result.stdout.length} bytes`);
  assert.ok(result.elidedBytes > 0);
});

// A ~600 KB producer of fixed-width lines: 108 bytes each (6-digit counter,
// space, 100 y's, newline), so the emitted byte count is exact arithmetic and
// every retained line is checkable against one regex.
const RING_LINE_BYTES = 108;
const ringProducer = (lines) =>
  `for(let i=0;i<${lines};i++){console.log(String(i).padStart(6,'0')+' '+'y'.repeat(100))}`;

test("runCommandAsync scales the ring UP with a large budget, not just down", async () => {
  // The regression this guards: headLimit and tailLimit were applied as
  // `Math.min(OUTPUT_HEAD_BYTES, ...)` / `Math.min(OUTPUT_TAIL_BYTES, ...)`,
  // i.e. as CEILINGS. Retention was therefore pinned at 320 KiB for every
  // budget from 4 KB to 32 MB, which made `--verify-max-buffer 64` and
  // GROK_VERIFY_MAX_OUTPUT_BYTES inert above ~1.6 MB - measured: the same
  // 590 KB stream reported `retained 327719 / elided 262326` at budgets of
  // 1 MB, 8 MB and 64 MB alike. Only the scale-DOWN direction was asserted,
  // which is why it shipped.
  const lines = 5600;
  const emitted = lines * RING_LINE_BYTES;

  const tight = await runCommandAsync(process.execPath, ["-e", ringProducer(lines)], {
    maxOutputBytes: 320 * 1024
  });
  const roomy = await runCommandAsync(process.execPath, ["-e", ringProducer(lines)], {
    maxOutputBytes: 1024 * 1024
  });

  assert.ok(tight.elidedBytes > 0, "a 320 KiB budget must still elide a 600 KB stream");
  assert.equal(
    roomy.elidedBytes,
    0,
    `a 1 MiB budget must capture a ${emitted}-byte stream whole, elided ${roomy.elidedBytes}`
  );
  assert.equal(Buffer.byteLength(roomy.stdout), emitted);
  assert.ok(
    Buffer.byteLength(roomy.stdout) > Buffer.byteLength(tight.stdout),
    "raising the budget has to retain strictly more"
  );
});

test("the ring's byte accounting is exact: retained + elided === emitted", async () => {
  // The newline snap discards bytes to move each cut onto a line boundary, and
  // the classifier now READS elidedBytes to decide whether a capture is
  // comparable at all - so an undercount would silently restore the phantom
  // "new-failures" verdict for a truncated run. Checked at several budgets and
  // several cut positions.
  for (const [budget, lines] of [
    [4096, 200],
    [64 * 1024, 4000],
    [320 * 1024, 8000],
    [1024 * 1024, 8000]
  ]) {
    const result = await runCommandAsync(process.execPath, ["-e", ringProducer(lines)], {
      maxOutputBytes: budget
    });
    const emitted = lines * RING_LINE_BYTES;
    const retained = Buffer.byteLength(
      result.stdout.replace(/\n\.\.\.\[elided \d+ bytes of output\]\.\.\.\n/, "")
    );
    assert.equal(
      retained + result.elidedBytes,
      emitted,
      `budget ${budget}: retained ${retained} + elided ${result.elidedBytes} !== emitted ${emitted}`
    );
  }
});

test("the ring cuts on line boundaries so truncation cannot manufacture a failure line", async () => {
  // Both cuts used to land on exact byte offsets, so the last line of the head
  // and the first line of the tail were FRAGMENTS. summarizeFailures turns each
  // fragment into a failure signature, and where the tail cut lands moves with
  // the stream's total byte count - which is how a 12-byte banner difference
  // between the baseline probe and the post-agent run produced two different
  // signatures for a byte-identical failure set.
  const result = await runCommandAsync(process.execPath, ["-e", ringProducer(8000)], {
    maxOutputBytes: 64 * 1024
  });

  assert.ok(result.elidedBytes > 0, "this producer has to overflow the budget");
  const lines = result.stdout.split("\n");
  const marker = lines.filter((line) => line.startsWith("...[elided "));
  assert.equal(marker.length, 1, "expected exactly one elision marker");
  // The marker is worded with no error/fail/assert token in it precisely so it
  // cannot itself become a failure signature.
  assert.doesNotMatch(marker[0], /\b(fail|error|assert)\b/i);

  for (const line of lines) {
    if (line === "" || line.startsWith("...[elided ")) {
      continue;
    }
    assert.match(
      line,
      /^\d{6} y{100}$/,
      `truncation left a partial line in the capture: ${JSON.stringify(line.slice(0, 60))}`
    );
  }
});

test("the ring does not corrupt a multi-byte character at the head/tail split", async () => {
  // push() fills the head to EXACTLY headLimit for every stream over that many
  // bytes, and text() used to decode the head and the tail as two independent
  // buffers - so a character straddling the split was replaced with U+FFFD even
  // when elidedBytes was 0 and nothing needed to be dropped at all. A Godot
  // resource path, an accented filename, or a pytest tick is enough to hit it.
  const headLimit = Math.floor(65536 / 5);
  const result = await runCommandAsync(process.execPath, [
    "-e",
    `process.stdout.write('a'.repeat(${headLimit - 1}));process.stdout.write('\\u00e9 FAIL: assertion caf\\u00e9 failed\\n')`
  ], { maxOutputBytes: 64 * 1024 });

  assert.equal(result.status, 0);
  assert.equal(result.elidedBytes, 0, "the whole stream fits in the budget; nothing may be elided");
  assert.ok(!result.stdout.includes("�"), "the split corrupted a multi-byte character");
  assert.ok(
    result.stdout.includes("é FAIL: assertion café failed"),
    "the failure line has to survive the split intact"
  );
});

test("runCommandAsync lets the process exit when the tree kill never lands", async () => {
  // TERMINATE_GRACE_MS resolves the promise, but the child's inherited pipes
  // are ref'd libuv handles: without destroying them and unref'ing the child,
  // the event loop cannot drain and the bridge worker sits alive until the
  // orphan exits on its own - minutes, for a wedged headless Godot. The bridge
  // only ever sets process.exitCode and returns, so nothing else forces it out.
  //
  // Asserted from a real child process, because "the promise settled" is not
  // the property under test - "node exited" is. The existing timeout test
  // injects an impl that actually kills, so the non-delivered branch had no
  // coverage at all.
  const dir = makeTempDir();
  const moduleUrl = pathToFileURL(
    path.join(process.cwd(), "plugins/grok-build/scripts/lib/process.mjs")
  ).href;
  const scriptPath = path.join(dir, "orphan.mjs");
  fs.writeFileSync(
    scriptPath,
    [
      `import { runCommandAsync } from ${JSON.stringify(moduleUrl)};`,
      "const result = await runCommandAsync(process.execPath, ['-e', 'setTimeout(()=>{},8000)'], {",
      "  timeout: 300,",
      "  terminateProcessTreeImpl: () => ({ attempted: true, delivered: false, method: 'test' })",
      "});",
      "console.log(JSON.stringify({ code: result.error?.code, terminate: result.terminate }));"
    ].join("\n")
  );

  const started = Date.now();
  const outer = await runCommandAsync(process.execPath, [scriptPath]);
  const elapsed = Date.now() - started;

  const reported = JSON.parse(outer.stdout.trim());
  assert.equal(reported.code, "ETIMEDOUT");
  // terminateProcessTree already computed {delivered:false}; runCommandAsync
  // used to throw that verdict away, so the run record reported a clean finish
  // for a command it had left running.
  assert.deepEqual(reported.terminate, { attempted: true, delivered: false, method: "test" });
  assert.ok(
    elapsed < 5000,
    `the orphan's pipes kept the process alive for ${elapsed}ms (child sleeps 8s)`
  );
});

test("runCommandAsync kills the tree on timeout and reports ETIMEDOUT", async () => {
  // Hermetic: terminateProcessTree is injected, so nothing is actually killed
  // by taskkill here - the contract under test is that the runner reaches for
  // the TREE (while the shell is still alive) rather than for Node's own
  // spawn timeout, which signals only the direct child.
  let killedPid = null;
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "setTimeout(()=>{}, 5000)"],
    {
      timeout: 300,
      terminateProcessTreeImpl(pid, options) {
        killedPid = pid;
        assert.ok(options.platform, "the platform has to reach terminateProcessTree");
        // Stand in for what taskkill /T or kill(-pid) would do to the tree.
        process.kill(pid, "SIGKILL");
        return { attempted: true, delivered: true, method: "test" };
      }
    }
  );

  assert.equal(result.timedOut, true);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.ok(Number.isFinite(killedPid), "the tree kill never ran");
});

test("runCommandAsync surfaces a missing binary as ENOENT rather than hanging", async () => {
  const result = await runCommandAsync("grok-build-nonexistent-binary-xyz", ["--version"]);
  assert.equal(result.status, null);
  assert.equal(/** @type {NodeJS.ErrnoException} */ (result.error)?.code, "ENOENT");
});

test("runCommandAsync closes stdin so a command that reads it cannot hang", async () => {
  const result = await runCommandAsync(process.execPath, [
    "-e",
    "process.stdin.on('end',()=>{process.stdout.write('eof');process.exit(0)});process.stdin.resume()"
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "eof");
});

test("resolveMaxOutputBytes prefers the caller, then the env, then the 32MB default", () => {
  assert.equal(resolveMaxOutputBytes(1024, {}), 1024);
  assert.equal(resolveMaxOutputBytes(null, { GROK_VERIFY_MAX_OUTPUT_BYTES: "2048" }), 2048);
  assert.equal(resolveMaxOutputBytes("0", { GROK_VERIFY_MAX_OUTPUT_BYTES: "2048" }), 2048);
  assert.equal(resolveMaxOutputBytes(undefined, { GROK_VERIFY_MAX_OUTPUT_BYTES: "junk" }), 32 * 1024 * 1024);
});

test("runCommand restores spawnSync's own 1 MiB default when no budget is given", () => {
  // The key used to be set unconditionally, so an absent `maxBuffer` reached
  // spawnSync as an explicit `undefined` - which OVERRIDES the 1 MiB default
  // rather than falling back to it, and the size check then compares against
  // undefined and never fires. Every unbounded git call in the plugin was
  // silently uncapped because of that one key; `land`'s diff was the one that
  // materialized megabytes of it into a JSON payload.
  const producer = "process.stdout.write('x'.repeat(2 * 1024 * 1024))";

  const unbounded = runCommand("node", ["-e", producer]);
  assert.equal(
    /** @type {NodeJS.ErrnoException|null} */ (unbounded.error)?.code,
    "ENOBUFS",
    "2 MiB must not sail past an unspecified budget"
  );

  const explicit = runCommand("node", ["-e", producer], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(explicit.error, null);
  assert.equal(explicit.status, 0);
  assert.equal(explicit.stdout.length, 2 * 1024 * 1024);
});

test("terminateProcessTree confirms a kill that lands after the first probe", () => {
  // Regression: the final verdict sampled liveness once, ~250ms after the last
  // kill. A Rust binary with MCP children and a tool shell takes longer than
  // that to unwind, so `stop` reported "process kill was not confirmed" for two
  // PIDs that were already gone by the time anyone looked. Polling only ever
  // turns a false negative into the truth.
  let probes = 0;
  const outcome = terminateProcessTree(4242, {
    platform: "win32",
    settleMs: 0,
    confirmStepMs: 0,
    confirmTimeoutMs: 50,
    runCommandImpl: () => ({
      status: 1,
      stdout: "",
      stderr: "ERROR: The process with PID 4242 could not be terminated.\nReason: The operation attempted is not supported.",
      error: null
    }),
    // Alive for the first few asks, gone afterwards - a process in teardown.
    isAliveImpl: () => {
      probes += 1;
      return probes < 4;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true, "a process that exits during the poll counts as killed");
  assert.deepEqual(outcome.survivors, []);
});

test("terminateProcessTree still reports a genuine survivor", () => {
  const outcome = terminateProcessTree(4243, {
    platform: "win32",
    settleMs: 0,
    confirmStepMs: 0,
    confirmTimeoutMs: 20,
    runCommandImpl: () => ({
      status: 1,
      stdout: "",
      stderr: "ERROR: could not be terminated.",
      error: null
    }),
    isAliveImpl: () => true
  });

  assert.equal(outcome.delivered, false);
  assert.deepEqual(outcome.survivors, [4243]);
});

test("terminateProcessTree real liveness probe reports survivor when kill is a no-op", () => {
  // Regression: on Windows every liveness probe returned "dead" because
  // isZombieProcess gated on POSIX-only `ps` and treated ENOENT/status≠0 as
  // zombie. terminateProcessTree then short-circuited with delivered:true after
  // taskkill, so the escalation ladder and survivors list were unreachable.
  // This test uses the REAL processIsAlive (no isAliveImpl) against a live
  // child with a no-op runCommandImpl — the repro inverted.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    windowsHide: true,
    detached: false
  });
  assert.ok(Number.isFinite(child.pid) && child.pid > 0, "child must have a pid");

  try {
    // Prove the process is alive via Node's own signal-0 probe.
    assert.doesNotThrow(() => process.kill(child.pid, 0));

    const outcome = terminateProcessTree(child.pid, {
      platform: process.platform,
      settleMs: 0,
      confirmTimeoutMs: 80,
      confirmStepMs: 10,
      // Pretend every kill tool succeeded without actually killing.
      runCommandImpl: () => ({
        status: 0,
        stdout: "",
        stderr: "",
        error: null
      }),
      // Do not inject isAliveImpl — that is the whole point of this test.
      killImpl: (pid, signal) => {
        if (signal === 0) {
          return process.kill(pid, 0);
        }
        // Swallow real kill signals so the child stays up for the verdict.
        return true;
      }
    });

    assert.equal(outcome.attempted, true, "must attempt a kill");
    assert.equal(
      outcome.delivered,
      false,
      "a still-alive child must not be reported delivered (probe must observe live)"
    );
    assert.ok(Array.isArray(outcome.survivors), "survivors must be listed");
    assert.equal(outcome.survivors.length, 1);
    assert.equal(outcome.survivors[0], child.pid);
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(child.pid, 0);
      // Still alive — force via taskkill/SIGKILL path the OS understands.
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
      } else {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      // already dead
    }
  }
});
