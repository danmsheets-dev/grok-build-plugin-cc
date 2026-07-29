import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveExecutable } from "../plugins/grok-build/scripts/lib/which.mjs";
import { runCommand, terminateProcessTree } from "../plugins/grok-build/scripts/lib/process.mjs";

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
