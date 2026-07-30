import process from "node:process";

import { resolveMaxOutputBytes, runCommandAsync } from "./process.mjs";

const DEFAULT_FLOOR_MS = 120_000;
const DEFAULT_CAP_MS = 900_000;
const DEFAULT_MULTIPLIER = 4;

// A verify command that cannot even be started is an infrastructure fault, not
// a code failure - but the exit code cannot tell us that. Every command is
// wrapped in `cmd /d /s /c` on win32 (see below), and cmd.exe reports its own
// "not recognized" failure as exit **1**, not the 9009 a bare shell would use;
// two independent measurements confirmed the 1. So the detection has to read
// the message. The patterns are anchored to a line start on purpose so that a
// compiler diagnostic like `error TS2307: Cannot find module 'x'` or a test
// line containing "command not found" as prose cannot false-positive. 127 is
// kept only as a POSIX assist (dash/ash word the message differently enough
// that anchoring alone would miss them).
const NOT_RUNNABLE = [
  /^'[^']+' is not recognized as an internal or external command/m,
  /^The system cannot find the path specified\.$/m,
  /^(?:[^\s:]*sh): (?:line \d+: )?[^:]+: (?:command )?not found$/m
];

/**
 * Run a verify command string without shell:true so paths with spaces stay intact.
 * On win32 uses ComSpec/cmd.exe with /d /s /c; elsewhere /bin/sh -c.
 *
 * Async because the runner underneath is: a blocking spawnSync froze the job
 * heartbeat for the whole length of the command (a 15-minute Godot import made
 * a healthy run look dead), and killing only the direct child left the engine
 * process orphaned behind its shell. See runCommandAsync.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number,
 *   runCommandImpl?: typeof runCommandAsync,
 *   platform?: string
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   exitCode: number|null,
 *   timedOut: boolean,
 *   bufferExceeded?: boolean,
 *   commandNotFound?: boolean,
 *   elidedBytes?: number,
 *   output: string
 * }>}
 */
export async function runVerifyCommand(command, cwd, options = {}) {
  const run = options.runCommandImpl ?? runCommandAsync;
  const platform = options.platform ?? process.platform;
  const shell = platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";

  // On win32, passing `command` as a plain argv element lets Node apply its own
  // cmd.exe-aware escaping on top of whatever quotes the command string already
  // contains, corrupting anything with an embedded double quote (confirmed:
  // `node -e "console.log('x')"` arrived at node truncated mid-string). The fix
  // wraps the whole command line in exactly one extra pair of quotes and passes
  // windowsVerbatimArguments so Node does not re-escape it; cmd.exe's own rule
  // for `/c "..."` strips only that one outer pair, regardless of quotes inside.
  const shellArgs =
    platform === "win32" ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command];

  // Resolved per call, never as a module constant: the old fixed 5 MB was not
  // something a user could move, and it is echoed in the overflow message
  // below so the number a run reports is the number it actually used.
  const maxOutputBytes = resolveMaxOutputBytes(options.maxOutputBytes, options.env);

  const result = await run(shell, shellArgs, {
    cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxOutputBytes,
    windowsVerbatimArguments: platform === "win32" ? true : undefined
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      exitCode: null,
      timedOut: true,
      commandNotFound: false,
      output: `command timed out after ${options.timeoutMs}ms`
    };
  }

  if (result.error?.code === "ENOBUFS") {
    // Legacy path. The async runner reads every byte and elides the middle, so
    // it never reports ENOBUFS at all - overflow has stopped being a failure
    // mode. Kept because a caller may still inject the synchronous runCommand
    // (whose maxBuffer IS a cliff: libuv kills the process the moment the
    // limit is crossed, so there is no exit code and the command may well have
    // been about to pass), and because reporting a bare generic failure here
    // used to send the agent hunting for a code bug that does not exist.
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      bufferExceeded: true,
      commandNotFound: false,
      output: `command output exceeded the ${maxOutputBytes} byte limit and was killed before it could finish. This is not a code failure - the command produced too much stdout/stderr to capture. Re-run it with a quieter or more targeted flag (e.g. a specific test file, --silent, or piping through a summary) rather than changing any source file.`
    };
  }

  if (result.error) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      // ENOENT here means the *shell* is missing, which is exactly as
      // un-runnable as a missing verify binary and equally not the agent's
      // fault - blaming a code change for it sent runs chasing a phantom bug.
      commandNotFound: /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT",
      output: `Failed to run command: ${result.error.message}`
    };
  }

  const status = result.status;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  // Gated on a non-zero status so that a command which merely *prints* one of
  // these messages - a test asserting on cmd.exe's wording, a build log that
  // recovered from a missing optional tool - and then succeeds is still a
  // pass. Nothing that failed to start can exit 0.
  const commandNotFound =
    status !== 0 &&
    (status === 127 || NOT_RUNNABLE.some((re) => re.test(`${stdout}\n${stderr}`)));
  const parts = [`exit_code: ${status}`];
  if (stdout) {
    parts.push(`stdout:\n${stdout}`);
  }
  if (stderr) {
    parts.push(`stderr:\n${stderr}`);
  }
  if (!stdout && !stderr) {
    parts.push("(no output)");
  }

  return {
    ok: status === 0,
    exitCode: status,
    timedOut: false,
    commandNotFound,
    // How much of the middle the ring dropped, so a truncated capture is a
    // number in the run record rather than something only a reader of the
    // elision marker would notice. Zero for any command that stayed under the
    // budget, which is nearly all of them.
    elidedBytes: Number(result.elidedBytes) || 0,
    output: parts.join("\n")
  };
}

/**
 * Measure what each verify command already reports BEFORE the agent runs, so a
 * suite that was red on arrival is never blamed on the run.
 *
 * Extracted from the bridge so it can be exercised without spawning anything.
 *
 * @param {string[]} commands
 * @param {string} cwd
 * @param {{
 *   runVerifyCommandImpl?: typeof runVerifyCommand,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number
 * }} [options]
 * @returns {Promise<{
 *   command: string,
 *   ok: boolean,
 *   ms: number,
 *   signature: string[],
 *   rawCount: number,
 *   timedOut: boolean,
 *   bufferExceeded: boolean,
 *   commandNotFound: boolean
 * }[]>}
 */
export async function probeBaselines(commands, cwd, options = {}) {
  const runVerifyCommandImpl = options.runVerifyCommandImpl ?? runVerifyCommand;
  const baselines = [];

  for (const command of commands ?? []) {
    const started = Date.now();
    // The output budget has to match the post-agent pass. A baseline captured
    // under a tighter bound records a shorter signature, and every failure the
    // fuller capture then finds looks new.
    const probe = await runVerifyCommandImpl(command, cwd, {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes
    });
    const ms = Date.now() - started;
    const summary = summarizeFailures(probe?.output);
    baselines.push({
      command,
      ok: Boolean(probe?.ok),
      ms,
      signature: summary.signature,
      rawCount: summary.rawCount,
      // Every infrastructure flag the post-agent pass can raise has to be
      // mirrored here too. A baseline that timed out / overflowed its buffer /
      // never started is an unknown baseline, and classifyVerifyFailure can
      // only say so if the flag survived the probe.
      timedOut: Boolean(probe?.timedOut),
      bufferExceeded: Boolean(probe?.bufferExceeded),
      commandNotFound: Boolean(probe?.commandNotFound)
    });
  }

  return baselines;
}

/**
 * Lowercase and strip run-to-run noise so the same logical failure compares equal.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeFailureText(text) {
  let s = String(text ?? "");

  // Windows absolute paths → last two path segments joined by "/"
  s = s.replace(
    /[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g,
    (m) => m.split(/[\\/]/).filter(Boolean).slice(-2).join("/")
  );

  // POSIX absolute paths → last two segments
  s = s.replace(
    /(^|[\s"'=(])(\/(?:[^/\s:)"']+\/)+[^/\s:)"']+)/g,
    (_full, pre, p) => `${pre}${p.split("/").filter(Boolean).slice(-2).join("/")}`
  );

  // Timings: 123ms, 1.2s, 4 seconds
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m)\b/gi, "");

  // Hex addresses 0x... (4+ hex digits)
  s = s.replace(/0x[0-9a-f]{4,}/gi, "");

  // pid 1234
  s = s.replace(/\b(?:pid|PID)[\s:=]*\d+/g, "");

  // MSBuild-style (line,col)
  s = s.replace(/\(\d+\s*,\s*\d+\)/g, "");

  // :line:col: and :line: diagnostics
  s = s.replace(/:(\d+):(\d+)(?=\s|:|$)/g, "");
  s = s.replace(/:(\d+)(?=\s|:|$)/g, (match, _n, offset, str) => {
    if (offset > 0 && str[offset - 1] === ":") {
      return match;
    }
    return "";
  });

  s = s.replace(/\\/g, "/");
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s;
}

/**
 * Extract a comparable failure signature from verify command output.
 *
 * @param {string} output
 * @returns {{ signature: string[], failureCount: number }}
 */
export function summarizeFailures(output) {
  const lines = String(output ?? "").split(/\r?\n/);
  /** @type {string[]} */
  const ids = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    if (/^exit_code:/i.test(t)) {
      continue;
    }
    if (/^(stdout|stderr):$/i.test(t)) {
      continue;
    }
    if (/^\(no output\)$/i.test(t)) {
      continue;
    }

    const looksLikeFailure =
      /\b(fail|error|assert|not ok|failed|exception|panic)\b/i.test(t) ||
      /^[A-Z][a-zA-Z]*Error\b/.test(t) ||
      /[✗×✖]|FAIL/.test(t);

    if (!looksLikeFailure) {
      continue;
    }

    const n = normalizeFailureText(t);
    if (n) {
      ids.push(n);
    }
  }

  const signature = [...new Set(ids)].sort();
  return {
    signature,
    failureCount: signature.length,
    // Pre-dedup count. Two DIFFERENT failures can normalize to the identical
    // string after this function's own aggressive stripping (paths cut to
    // two segments, timings and line numbers removed) - if that string also
    // happens to match one baseline entry, a bare set comparison reports
    // "unchanged" even though there are genuinely more distinct failures now
    // than at baseline. rawCount lets compareFailureSignatures catch that.
    rawCount: ids.length
  };
}

/**
 * Classify a post-agent failure set relative to a baseline signature.
 *
 * @param {string[]|Iterable<string>|null|undefined} current
 * @param {string[]|Iterable<string>|null|undefined} baseline
 * @returns {{
 *   outcome: "new-failures"|"partial-progress"|"unchanged-from-baseline"|"incomparable",
 *   newFailures: string[],
 *   remainingCount: number,
 *   baselineCount: number,
 *   reason?: string
 * }}
 */
export function compareFailureSignatures(current, baseline, options = {}) {
  const cur = [
    ...new Set(
      [...(current ?? [])]
        .map((s) => String(s ?? "").trim())
        .filter(Boolean)
    )
  ].sort();
  const base = [
    ...new Set(
      [...(baseline ?? [])]
        .map((s) => String(s ?? "").trim())
        .filter(Boolean)
    )
  ].sort();

  if (cur.length === 0) {
    return {
      outcome: "incomparable",
      newFailures: [],
      remainingCount: 0,
      baselineCount: base.length,
      reason:
        "the verify command failed but no comparable failures could be extracted from its output"
    };
  }

  const baseSet = new Set(base);
  const curSet = new Set(cur);
  const newFailures = cur.filter((id) => !baseSet.has(id));
  const remainingCount = base.filter((id) => curSet.has(id)).length;

  if (newFailures.length > 0) {
    return {
      outcome: "new-failures",
      newFailures,
      remainingCount,
      baselineCount: base.length
    };
  }

  if (remainingCount < base.length) {
    return {
      outcome: "partial-progress",
      newFailures: [],
      remainingCount,
      baselineCount: base.length
    };
  }

  // The deduped id sets match exactly, but more distinct failure lines fired
  // this time than at baseline: two different failures collapsed onto the
  // same normalized string as one baseline entry. Reporting "unchanged" here
  // would hide a real regression the agent introduced.
  const { currentRawCount, baselineRawCount } = options;
  if (
    Number.isFinite(Number(currentRawCount)) &&
    Number.isFinite(Number(baselineRawCount)) &&
    Number(currentRawCount) > Number(baselineRawCount)
  ) {
    return {
      outcome: "more-failures-same-signature",
      newFailures: [],
      remainingCount,
      baselineCount: base.length,
      reason: `${currentRawCount} failure occurrences now vs ${baselineRawCount} at baseline, despite an identical normalized id set`
    };
  }

  return {
    outcome: "unchanged-from-baseline",
    newFailures: [],
    remainingCount,
    baselineCount: base.length
  };
}

/**
 * Parse a `--verify-timeout` / `--baseline-timeout` value (whole seconds, as a
 * user types them) into milliseconds. Mirrors the bridge's
 * resolveMaxDurationSeconds contract exactly: finite and > 0, else null, so an
 * unusable value falls through to the next source in the precedence chain
 * rather than silently becoming zero.
 *
 * @param {unknown} rawSeconds
 * @returns {number|null}
 */
export function resolveVerifyTimeoutMs(rawSeconds) {
  if (rawSeconds == null || rawSeconds === "") {
    return null;
  }
  const parsed = Number(rawSeconds);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed * 1000);
  }
  return null;
}

/**
 * Parse a `--verify-max-buffer` value (megabytes) into bytes.
 *
 * @param {unknown} rawMegabytes
 * @returns {number|null}
 */
export function resolveVerifyMaxBufferBytes(rawMegabytes) {
  if (rawMegabytes == null || rawMegabytes === "") {
    return null;
  }
  const parsed = Number(rawMegabytes);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed * 1024 * 1024);
  }
  return null;
}

/**
 * Derive the per-attempt verify timeout from a measured baseline duration.
 * Rule: baselineMs * multiplier, floor 120000, cap 900000.
 *
 * @param {number} baselineMs
 * @param {{
 *   floorMs?: number,
 *   capMs?: number,
 *   multiplier?: number
 * }} [options]
 * @returns {number}
 */
export function deriveVerifyTimeoutMs(baselineMs, options = {}) {
  const floor = Number.isFinite(Number(options.floorMs))
    ? Math.max(0, Number(options.floorMs))
    : DEFAULT_FLOOR_MS;
  const cap = Number.isFinite(Number(options.capMs))
    ? Math.max(floor, Number(options.capMs))
    : DEFAULT_CAP_MS;
  const multiplier = Number.isFinite(Number(options.multiplier))
    ? Math.max(0, Number(options.multiplier))
    : DEFAULT_MULTIPLIER;

  if (!Number.isFinite(baselineMs) || baselineMs <= 0) {
    return floor;
  }

  return Math.min(cap, Math.max(floor, Math.round(baselineMs * multiplier)));
}

/**
 * Decide whether one command's post-agent failure is attributable to the
 * agent, given what the baseline probe saw for that same command.
 *
 * Extracted so this can be unit tested directly and applied independently to
 * EVERY failing --verify command, rather than only the first one a run
 * happens to iterate — checking just the first command let a genuine
 * regression in a second command go unnoticed.
 *
 * The infrastructure flags arrive as an explicit third argument rather than
 * riding along on `current`: `current` is a summarizeFailures() result, and
 * smuggling runVerifyCommand fields into that shape would make two unrelated
 * producers responsible for the same object.
 *
 * @param {{ signature: string[], rawCount: number }} current
 * @param {{
 *   ok: boolean,
 *   signature: string[],
 *   rawCount: number,
 *   timedOut: boolean,
 *   bufferExceeded?: boolean,
 *   commandNotFound?: boolean
 * }|undefined|null} baselineEntry
 * @param {{ timedOut?: boolean, bufferExceeded?: boolean, commandNotFound?: boolean }} [options]
 * @returns {{
 *   blamed: boolean,
 *   reason: string,
 *   comparison?: string,
 *   fatal?: boolean,
 *   infrastructure?: boolean
 * }}
 */
export function classifyVerifyFailure(current, baselineEntry, options = {}) {
  // Everything above the baseline guards is an infrastructure outcome: the
  // command never produced a comparable verdict at all. These used to fall
  // straight through to compareFailureSignatures, which saw an empty current
  // signature, called it "incomparable", and blamed the run for a timeout or
  // an output overflow it had nothing to do with.
  if (options.commandNotFound || baselineEntry?.commandNotFound) {
    return { blamed: false, reason: "verify-command-not-runnable", fatal: true };
  }

  if (options.timedOut) {
    return { blamed: false, reason: "verify-timed-out", infrastructure: true };
  }

  if (options.bufferExceeded) {
    return { blamed: false, reason: "verify-output-truncated", infrastructure: true };
  }

  if (baselineEntry?.bufferExceeded) {
    // Symmetric to the timeout guard below: the probe was killed mid-output,
    // so whatever signature it did capture is a truncated prefix, not a
    // baseline anything can be compared against.
    return { blamed: false, reason: "baseline-unknown" };
  }

  if (baselineEntry == null) {
    // No probe ran for this command (or it was not in the probed list). That
    // is honestly "we don't know", not "the agent broke it" - the old code
    // compared against an empty baseline and reported new-failures for every
    // pre-existing one. Deliberately NOT faked as a timed-out baseline: the
    // run record has to say which of the two actually happened.
    return { blamed: false, reason: "baseline-missing" };
  }

  if (baselineEntry?.timedOut) {
    // The baseline probe itself never finished, so there is no comparable
    // pre-existing state - reporting a confident regression here would be a
    // guess dressed up as fact.
    return { blamed: false, reason: "baseline-unknown" };
  }

  const comparison = compareFailureSignatures(current.signature, baselineEntry?.signature ?? [], {
    currentRawCount: current.rawCount,
    baselineRawCount: baselineEntry?.rawCount
  });

  if (comparison.outcome === "unchanged-from-baseline") {
    return { blamed: false, reason: "unchanged-from-baseline", comparison: comparison.outcome };
  }

  if (comparison.outcome === "incomparable" && baselineEntry?.ok === false) {
    // Neither run's output matched a recognisable failure pattern, but this
    // command was ALREADY failing before the agent started.
    return { blamed: false, reason: "baseline-already-failing", comparison: comparison.outcome };
  }

  return { blamed: true, reason: comparison.outcome, comparison: comparison.outcome };
}
