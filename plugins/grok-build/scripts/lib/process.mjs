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
//
// These define the DEFAULT SPLIT between the two halves, not a ceiling on
// either. They used to be applied as `Math.min(OUTPUT_HEAD_BYTES, ...)` and
// `Math.min(OUTPUT_TAIL_BYTES, ...)`, which pinned retention to 320 KiB for
// every budget from 4 KB to 32 MB - so `--verify-max-buffer 64` and
// GROK_VERIFY_MAX_OUTPUT_BYTES were inert above ~1.6 MB and a repo whose
// verify command legitimately prints megabytes had no way to capture it. Only
// the RATIO between them survives; see createOutputRing.
const OUTPUT_HEAD_BYTES = 64 * 1024;
const OUTPUT_TAIL_BYTES = 256 * 1024;
const OUTPUT_HEAD_SHARE = OUTPUT_HEAD_BYTES / (OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES);
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
 * DEFAULT_MAX_OUTPUT_BYTES is applied as a real ceiling on both inputs, which
 * is what makes its "outer bound a caller may raise the retention budget to"
 * comment true: the ring now scales retention UP with the budget, so an
 * unchecked `GROK_VERIFY_MAX_OUTPUT_BYTES=4000000000` would ask the ring to
 * hold four gigabytes of a runaway command in memory.
 *
 * @param {unknown} raw explicit byte count from the caller
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolveMaxOutputBytes(raw, env = undefined) {
  const explicit = Number(raw);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(Math.floor(explicit), DEFAULT_MAX_OUTPUT_BYTES);
  }
  const fromEnv = Number(
    env?.GROK_VERIFY_MAX_OUTPUT_BYTES ?? process.env.GROK_VERIFY_MAX_OUTPUT_BYTES
  );
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.min(Math.floor(fromEnv), DEFAULT_MAX_OUTPUT_BYTES);
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
 * Chunks are kept as Buffers and decoded once, as ONE buffer, at the end.
 * Decoding each chunk as it arrives would corrupt any multi-byte character
 * split across a chunk boundary, and decoding the head and the tail separately
 * corrupted one straddling the head/tail split - which push() creates for
 * every stream over headLimit bytes, elided or not.
 *
 * @param {number} maxBytes total retention budget for this stream
 */
function createOutputRing(maxBytes) {
  const budget = Math.max(2048, Math.floor(Number(maxBytes) || DEFAULT_MAX_OUTPUT_BYTES));
  // Both halves scale WITH the budget, in both directions: a caller that asks
  // for 4 KB gets roughly 4 KB, and one that asks for 8 MB gets roughly 8 MB.
  // 1024 is a floor for the head so a tiny budget still keeps the banner, and
  // the head is never allowed to eat the whole budget.
  const headLimit = Math.min(
    budget - 1024,
    Math.max(1024, Math.floor(budget * OUTPUT_HEAD_SHARE))
  );
  const tailLimit = budget - headLimit;

  /** @type {Buffer[]} */
  const head = [];
  let headBytes = 0;
  /** @type {Buffer[]} */
  const tail = [];
  let tailBytes = 0;
  let elidedBytes = 0;
  let snapped = false;

  // Move both cut points onto line boundaries, once, when the capture is read.
  //
  // Only reachable once the ring has actually dropped something: while
  // elidedBytes is 0 the head and tail are CONTIGUOUS - the split is internal
  // bookkeeping, not a cut - and trimming either of them would destroy output
  // that fit inside the budget the caller asked for.
  //
  // Why this is load-bearing rather than cosmetic: the cuts landed on exact
  // byte offsets, so the head ended mid-line and the tail began mid-line.
  // summarizeFailures turns each of those fragments into a failure signature,
  // and where the tail cut lands moves with the TOTAL byte count of the
  // stream - so a baseline probe and a post-agent run whose failure set was
  // byte-for-byte identical produced DIFFERENT signatures, and the run blamed
  // the agent for a regression that did not exist.
  const snapToLines = () => {
    if (snapped || elidedBytes === 0) {
      return;
    }
    snapped = true;
    // Head: back up to the last newline it contains. A head with no newline at
    // all is one enormous line; dropping all of it would cost more than the
    // fragment does, so it is left as it is.
    const headBuf = Buffer.concat(head, headBytes);
    const lastNewline = headBuf.lastIndexOf(0x0a);
    head.length = 0;
    if (lastNewline >= 0) {
      head.push(headBuf.subarray(0, lastNewline + 1));
      elidedBytes += headBytes - (lastNewline + 1);
      headBytes = lastNewline + 1;
    } else {
      head.push(headBuf);
    }
    // Tail: skip forward past its first newline, so it starts at the beginning
    // of a line rather than mid-token. Same "no newline at all" exemption.
    const tailBuf = Buffer.concat(tail, tailBytes);
    const firstNewline = tailBuf.indexOf(0x0a);
    tail.length = 0;
    if (firstNewline >= 0) {
      tail.push(tailBuf.subarray(firstNewline + 1));
      elidedBytes += firstNewline + 1;
      tailBytes -= firstNewline + 1;
    } else {
      tail.push(tailBuf);
    }
  };

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
      // Snapping to line boundaries discards bytes, and they are elided bytes
      // like any other - the invariant callers rely on is
      // `retained + elided === emitted`, so the count has to be read after the
      // snap no matter which of the two accessors is touched first.
      snapToLines();
      return elidedBytes;
    },
    text() {
      snapToLines();
      /** @type {Buffer[]} */
      const parts = [...head];
      if (elidedBytes > 0) {
        // Deliberately kept on its own line, and worded with no
        // error/fail/assert token in it, so summarizeFailures cannot mistake
        // the marker itself for a failure line.
        parts.push(Buffer.from(`\n...[elided ${elidedBytes} bytes of output]...\n`, "utf8"));
      }
      parts.push(...tail);
      // ONE decode over the whole retained capture. Two independent
      // toString("utf8") calls put a decode boundary at exactly headLimit,
      // which corrupted any multi-byte character straddling it even when
      // nothing was elided - a Godot resource path, an accented filename, a
      // pytest tick. grok.mjs's boundPromptForArgv reserves argv slack for
      // exactly that U+FFFD expansion; the two elisions now agree it does not
      // happen here.
      return Buffer.concat(parts).toString("utf8");
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
    // terminateProcessTree already reports whether the signal landed; the
    // result used to be discarded, so a run whose engine survived taskkill
    // ("Access is denied" for an elevated process) reported a clean timeout and
    // said nothing at all about the process it left running.
    /** @type {{attempted: boolean, delivered: boolean, method: string|null}|null} */
    let terminateOutcome = null;

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
        // null when no kill was attempted, which is every non-timeout call.
        terminate: terminateOutcome,
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
        terminateOutcome = terminate(child.pid, { platform, cwd: options.cwd, env: options.env }) ?? null;
      } catch {
        // A kill that could not be delivered must not turn into an unhandled
        // rejection: fall back to the direct child and let the grace timer
        // resolve either way.
        terminateOutcome = { attempted: true, delivered: false, method: null };
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
      graceTimer = setTimeout(() => {
        // Reaching here means `close` never fired: something in the tree
        // survived the kill and is still holding the inherited pipes. Those
        // are ref'd libuv handles, so without letting go of them the event
        // loop cannot drain and the bridge worker sits alive long after the
        // run reported that it finished - measured at 5.7s of pure hang for an
        // 8-second orphan, and minutes-to-indefinitely for a wedged headless
        // Godot. The ring text is already captured, so nothing is lost by
        // detaching here.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
        child.unref?.();
        const orphaned = terminateOutcome?.delivered === false;
        const error = new Error(
          orphaned
            ? `command timed out after ${timeoutMs}ms and its process tree could not be terminated${terminateOutcome?.method ? ` (${terminateOutcome.method})` : ""}; the command may still be running`
            : `command timed out after ${timeoutMs}ms`
        );
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
