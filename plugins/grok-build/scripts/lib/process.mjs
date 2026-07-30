import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import { resolveSpawnInvocation } from "./which.mjs";

// Ceiling on how much of one stream is *retained*, not on how much the command
// may emit: the ring below reads and discards the middle, so a command that
// prints a gigabyte still runs to completion and still reports its real exit
// code. 32 MB is the outer bound a caller may raise the retention budget to.
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
// Head and tail sizes for the ring. The head carries the compile/summary
// banner a tool prints first; the tail carries the failure list and exit
// summary. Everything between them is where 20 MB of per-frame Godot spam or
// per-test pytest chatter lives, and none of it survives.
const OUTPUT_HEAD_BYTES = 64 * 1024;
const OUTPUT_TAIL_BYTES = 256 * 1024;
// How long to wait for `close` after the tree kill before giving up on the
// child's own stdio and resolving anyway. Without it a grandchild holding the
// inherited pipe open could keep the promise pending past the timeout it was
// supposed to enforce.
const TERMINATE_GRACE_MS = 2000;

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const invocation = resolveSpawnInvocation(command, args, env, platform);
  const result = spawnSyncImpl(invocation.executable, invocation.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    // The key is only present when the caller actually supplied a budget.
    // spawnSync applies its 1 MiB default by SPREADING the caller's options
    // over it, so an explicit `maxBuffer: undefined` overrides the default with
    // undefined and the size check (`length > maxBuffer`) then compares against
    // undefined and is never true - measured: 6 MiB of git stdout captured with
    // no ENOBUFS at all. Every unbounded git call in the plugin was silently
    // uncapped because of that one key.
    ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    stdio: options.stdio ?? "pipe",
    windowsHide: true,
    // Confirmed dead without this: a 300ms timeout let a 4-second command run
    // to completion, timedOut:false. Any verify command that hangs - a stuck
    // cargo test, pytest, npm test, or Godot headless check - wedged the
    // bridge worker forever with no way to notice.
    timeout: options.timeout,
    killSignal: options.killSignal,
    // The resolver may itself require verbatim args (routing a .cmd/.bat
    // target through cmd.exe with an already-quoted command line); an
    // explicit option from the caller (verify.mjs's own cmd.exe wrapping)
    // takes precedence if set.
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? invocation.windowsVerbatimArguments
  });

  const status = result.status == null ? (result.signal ? 1 : null) : result.status;

  return {
    command,
    args,
    status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

/**
 * Resolve the per-call output retention budget.
 *
 * Deliberately resolved per call rather than frozen into a module constant:
 * one repo's verify command legitimately prints more than another's, and the
 * old fixed 5 MB cliff was not something a user could move without editing the
 * plugin. `process.env` is consulted as well as the (possibly narrowed) env
 * handed to the child, so exporting the variable in a shell still works when
 * the caller passes an explicit env of its own.
 *
 * @param {unknown} raw explicit byte count from the caller
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveMaxOutputBytes(raw, env = undefined) {
  const explicit = Number(raw);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const fromEnv = Number(
    env?.GROK_VERIFY_MAX_OUTPUT_BYTES ?? process.env.GROK_VERIFY_MAX_OUTPUT_BYTES
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_MAX_OUTPUT_BYTES;
}

/**
 * Bounded head+tail capture for one stream.
 *
 * Replaces spawnSync's maxBuffer, which is a cliff rather than a bound: libuv
 * kills the process the moment the limit is crossed and hands back nothing at
 * all, so a command that was one line from passing reports no exit code and no
 * output. Here the whole stream is read (the child never blocks on a full
 * pipe) and only the middle is dropped, with the elided byte count recorded so
 * the gap is visible rather than silent.
 *
 * Chunks are kept as Buffers and decoded once at the end. Decoding each chunk
 * as it arrives would corrupt any multi-byte character split across a chunk
 * boundary; only the two cut points can still land mid-character, and a single
 * replacement char either side of the elision marker is acceptable.
 *
 * @param {number} maxBytes total retention budget for this stream
 */
function createOutputRing(maxBytes) {
  const budget = Math.max(2048, Math.floor(Number(maxBytes) || DEFAULT_MAX_OUTPUT_BYTES));
  // Both halves scale down with a small budget, so a caller that asks for 4 KB
  // gets roughly 4 KB rather than the 320 KB the fixed sizes would keep.
  const headLimit = Math.min(OUTPUT_HEAD_BYTES, Math.max(1024, Math.floor(budget / 5)));
  const tailLimit = Math.max(1024, Math.min(OUTPUT_TAIL_BYTES, budget - headLimit));

  /** @type {Buffer[]} */
  const head = [];
  let headBytes = 0;
  /** @type {Buffer[]} */
  const tail = [];
  let tailBytes = 0;
  let elidedBytes = 0;

  return {
    push(chunk) {
      let rest = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (headBytes < headLimit) {
        const take = Math.min(headLimit - headBytes, rest.length);
        head.push(rest.subarray(0, take));
        headBytes += take;
        rest = rest.subarray(take);
      }
      if (rest.length === 0) {
        return;
      }
      tail.push(rest);
      tailBytes += rest.length;
      while (tailBytes > tailLimit && tail.length > 0) {
        const excess = tailBytes - tailLimit;
        const first = tail[0];
        if (first.length <= excess) {
          tail.shift();
          tailBytes -= first.length;
          elidedBytes += first.length;
        } else {
          tail[0] = first.subarray(excess);
          tailBytes -= excess;
          elidedBytes += excess;
        }
      }
    },
    get elidedBytes() {
      return elidedBytes;
    },
    text() {
      const headText = Buffer.concat(head, headBytes).toString("utf8");
      const tailText = Buffer.concat(tail, tailBytes).toString("utf8");
      if (elidedBytes === 0) {
        return `${headText}${tailText}`;
      }
      return `${headText}\n...[elided ${elidedBytes} bytes of output]...\n${tailText}`;
    }
  };
}

/**
 * Async sibling of runCommand, for the verify path only.
 *
 * Three things spawnSync cannot do, each of which was a live bug:
 *  - it blocks the event loop, so startHeartbeat's interval could not fire for
 *    the entire length of a verify command and a working run looked dead;
 *  - its `timeout` kills only the direct child, and since every verify command
 *    is wrapped in `cmd /d /s /c` (win32) or `/bin/sh -c` (posix), killing the
 *    shell orphaned the godot.exe / blender.exe underneath it;
 *  - `maxBuffer` is a cliff with no partial capture (see createOutputRing).
 *
 * The sync contract of runCommand is relied on by git.mjs, worktree.mjs and
 * which.mjs, so this is additive rather than a replacement.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   input?: string,
 *   timeout?: number,
 *   maxOutputBytes?: number,
 *   platform?: string,
 *   windowsVerbatimArguments?: boolean,
 *   spawnImpl?: typeof spawn,
 *   terminateProcessTreeImpl?: typeof terminateProcessTree
 * }} [options]
 */
export async function runCommandAsync(command, args = [], options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const terminate = options.terminateProcessTreeImpl ?? terminateProcessTree;
  const invocation = resolveSpawnInvocation(command, args, env, platform);
  const maxOutputBytes = resolveMaxOutputBytes(options.maxOutputBytes, options.env);
  const timeoutMs = Number(options.timeout);
  const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;

  return await new Promise((resolve) => {
    const stdoutRing = createOutputRing(maxOutputBytes);
    const stderrRing = createOutputRing(maxOutputBytes);

    let settled = false;
    let timedOut = false;
    /** @type {NodeJS.Timeout|null} */
    let timeoutTimer = null;
    /** @type {NodeJS.Timeout|null} */
    let graceTimer = null;

    const finish = (status, signal, error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      resolve({
        command,
        args,
        status,
        signal: signal ?? null,
        stdout: stdoutRing.text(),
        stderr: stderrRing.text(),
        elidedBytes: stdoutRing.elidedBytes + stderrRing.elidedBytes,
        timedOut,
        error: error ?? null
      });
    };

    let child;
    try {
      child = spawnImpl(invocation.executable, invocation.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: "pipe",
        windowsHide: true,
        // Deliberately NOT Node's own `timeout`: it signals the direct child
        // first, and once the wrapping shell is gone taskkill /T has no tree
        // left to walk and the real engine process is orphaned. The timer
        // below kills the tree while the shell is still alive.
        //
        // detached only off win32: it makes the child lead its own process
        // group, which is the only way terminateProcessTree's kill(-pid) can
        // reach a grandchild. On win32 a detached spawn pops a console window
        // and taskkill /T is the tree mechanism anyway. Never unref'd - the
        // promise still waits for close.
        detached: platform !== "win32",
        windowsVerbatimArguments:
          options.windowsVerbatimArguments ?? invocation.windowsVerbatimArguments
      });
    } catch (error) {
      finish(null, null, error);
      return;
    }

    // spawnSync hands the child an already-closed stdin unless `input` is
    // given; spawn leaves the pipe open, so a command that reads stdin (an
    // interactive prompt a verify script did not expect to hit) would hang
    // until the timeout instead of failing immediately.
    if (child.stdin) {
      child.stdin.on("error", () => {
        // EPIPE when the child exits without reading; not this call's problem.
      });
      child.stdin.end(options.input ?? undefined);
    }

    child.stdout?.on("data", (chunk) => stdoutRing.push(chunk));
    child.stderr?.on("data", (chunk) => stderrRing.push(chunk));

    child.on("error", (error) => {
      finish(null, null, error);
    });

    child.on("close", (code, signal) => {
      const status = code == null ? (signal ? 1 : null) : code;
      if (timedOut) {
        const error = new Error(`command timed out after ${timeoutMs}ms`);
        /** @type {NodeJS.ErrnoException} */ (error).code = "ETIMEDOUT";
        finish(status, signal, error);
        return;
      }
      finish(status, signal, null);
    });

    if (!hasTimeout) {
      return;
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try {
        terminate(child.pid, { platform, cwd: options.cwd, env: options.env });
      } catch {
        // A kill that could not be delivered must not turn into an unhandled
        // rejection: fall back to the direct child and let the grace timer
        // resolve either way.
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      graceTimer = setTimeout(() => {
        const error = new Error(`command timed out after ${timeoutMs}ms`);
        /** @type {NodeJS.ErrnoException} */ (error).code = "ETIMEDOUT";
        finish(null, null, error);
      }, TERMINATE_GRACE_MS);
      graceTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();
  });
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.signal || result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.signal || result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function isZombieProcess(pid) {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      return true;
    }
    const stat = String(result.stdout ?? "").trim();
    if (!stat) {
      return true;
    }
    return /\bZ\b|^Z/i.test(stat) || stat.toUpperCase().includes("Z");
  } catch {
    return false;
  }
}

function processIsAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return !isZombieProcess(pid);
    }
    throw error;
  }
  return !isZombieProcess(pid);
}

function tryKill(killImpl, pid, signal) {
  try {
    killImpl(pid, signal);
    return { ok: true, missing: false, denied: false };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { ok: false, missing: true, denied: false };
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return { ok: false, missing: false, denied: true };
    }
    throw error;
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const isAliveImpl =
    options.isAliveImpl ?? ((candidatePid) => processIsAlive(candidatePid, killImpl));
  const graceMs = options.graceMs ?? 200;

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      const direct = tryKill(killImpl, pid, "SIGTERM");
      if (direct.missing) {
        return { attempted: true, delivered: false, method: "kill" };
      }
      return { attempted: true, delivered: true, method: "kill" };
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  const methods = [];
  let signaledLiveProcess = false;

  const groupKill = tryKill(killImpl, -pid, "SIGTERM");
  if (groupKill.ok) {
    methods.push("process-group");
    signaledLiveProcess = true;
  } else if (groupKill.denied) {
    methods.push("process-group-denied");
  }

  if (isAliveImpl(pid)) {
    const directKill = tryKill(killImpl, pid, "SIGTERM");
    if (directKill.ok) {
      methods.push("process");
      signaledLiveProcess = true;
    } else if (directKill.missing) {
      return {
        attempted: true,
        delivered: signaledLiveProcess,
        method: methods.join("+") || "process"
      };
    } else if (directKill.denied) {
      methods.push("process-denied");
    }
  } else if (!signaledLiveProcess) {
    return {
      attempted: true,
      delivered: false,
      method: methods.join("+") || "process-group"
    };
  } else {
    return {
      attempted: true,
      delivered: true,
      method: methods.join("+") || "process-group"
    };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAliveImpl(pid)) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process" };
    }
    sleepMs(20);
  }

  if (!isAliveImpl(pid)) {
    return { attempted: true, delivered: true, method: methods.join("+") || "process" };
  }

  const groupKillHard = tryKill(killImpl, -pid, "SIGKILL");
  if (groupKillHard.ok) {
    methods.push("process-group-sigkill");
  }
  if (isAliveImpl(pid)) {
    const directKillHard = tryKill(killImpl, pid, "SIGKILL");
    if (directKillHard.ok) {
      methods.push("process-sigkill");
    } else if (directKillHard.missing) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process-sigkill" };
    }
  } else {
    return { attempted: true, delivered: true, method: methods.join("+") || "process-group-sigkill" };
  }

  sleepMs(40);
  const stillAlive = isAliveImpl(pid);
  return {
    attempted: true,
    delivered: !stillAlive,
    method: methods.join("+") || "process-sigkill"
  };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
