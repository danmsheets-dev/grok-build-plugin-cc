import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

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
    runCommandImpl(command, args) {
      captured = { command, args };
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

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
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
