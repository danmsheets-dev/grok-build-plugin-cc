import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { resolveMaxOutputBytes, runCommandAsync } from "./process.mjs";

/**
 * Relative path of the Godot whole-project check script after runtime-plugin
 * injection (see injectRuntimePlugin + runtime-plugin/tools/grok_check.gd).
 * Bare `--check-only` without `--script` never exits on Godot 4 — this is the
 * only honest whole-project parse that does.
 */
export const GODOT_CHECK_SCRIPT_RES =
  "res://.grok/plugins/turbo-build-runtime/tools/grok_check.gd";

/**
 * Detect the export-smoke output path embedded in a verify command, if any.
 * @param {string} command
 * @returns {string|null} workspace-relative posix-ish path
 */
export function expectedExportSmokeArtifact(command) {
  const match = /(\.grok-build\/export-smoke\.[A-Za-z0-9_]+)/.exec(String(command ?? ""));
  return match ? match[1] : null;
}

/**
 * After a Godot export-smoke command returns, require a non-empty artifact on
 * disk. Godot often exits 0 and writes nothing when templates are missing or
 * the parent directory did not exist.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {{ existsSync?: typeof fs.existsSync, statSync?: typeof fs.statSync }} [io]
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function assertExportSmokeArtifact(command, cwd, io = {}) {
  const rel = expectedExportSmokeArtifact(command);
  if (!rel) {
    return { ok: true };
  }
  const existsSync = io.existsSync ?? fs.existsSync;
  const statSync = io.statSync ?? fs.statSync;
  const abs = path.join(cwd, ...rel.split("/"));
  try {
    if (!existsSync(abs)) {
      return {
        ok: false,
        message: `export produced no artifact: expected ${rel} after export-smoke (missing file)`
      };
    }
    const st = statSync(abs);
    const size = Number(st?.size) || 0;
    if (size <= 0) {
      return {
        ok: false,
        message: `export produced no artifact: expected ${rel} after export-smoke (zero bytes)`
      };
    }
  } catch {
    return {
      ok: false,
      message: `export produced no artifact: expected ${rel} after export-smoke (stat failed)`
    };
  }
  return { ok: true };
}

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
 * Game engines report a broken project on stdout and still exit 0.
 *
 * `godot --headless --import` prints `SCRIPT ERROR:` for a GDScript that does
 * not parse and exits 0 anyway; `blender -b --python x.py` exits 0 when the
 * script raises unless `--python-exit-code` is passed. Exit-code-only success
 * detection therefore reports a broken project as verified, which is the exact
 * lie the whole verification story exists to prevent.
 *
 * The sets below are deliberately NARROW. Two Godot markers that look obvious
 * are excluded on purpose and are available as `verifyFailurePatterns` opt-ins
 * in `.grok-build.json` instead:
 *
 *   - a bare `/^\s*ERROR:/m` — Godot 4 emits `ERROR:` for benign driver,
 *     plugin, and leaked-ObjectDB conditions on plenty of machines, so
 *     shipping it as a default turns healthy runs red;
 *   - `Cannot open file '` — fires for an optional `override.cfg`.
 *
 * Turning a green run red is the same class of bug as reporting a red run
 * green, so anything that is not unambiguously a failure stays out.
 *
 * `WARNING:` and `SCRIPT WARNING:` must never match: every pattern here is
 * either anchored to a line start before the word ERROR or names a phrase that
 * only appears on a failure line.
 *
 * Blender ships exactly ONE marker, anchored and versioned. A bare
 * `/^Traceback/` was rejected: a suite that deliberately prints tracebacks
 * while passing would start failing. One reviewer measured that even this
 * string does not appear on their Blender 5.2 install, which is fine — a
 * pattern that never fires costs nothing, and config carries the rest.
 */
export const OUTPUT_FAILURE_PATTERNS = Object.freeze({
  godot: Object.freeze([
    { id: "godot-script-error", re: /^\s*SCRIPT ERROR:/ },
    { id: "godot-user-script-error", re: /^\s*USER SCRIPT ERROR:/ },
    { id: "godot-user-error", re: /^\s*USER ERROR:/ },
    { id: "godot-shader-error", re: /^\s*(?:USER )?SHADER ERROR:/ },
    { id: "godot-shader-compile-failed", re: /^\s*ERROR: Shader compilation failed/ },
    { id: "godot-parse-error", re: /\bParse Error\b/ },
    { id: "godot-script-load-failed", re: /Failed to load script / },
    { id: "godot-import-failed", re: /Error importing '/ },
    { id: "godot-scene-instantiate-failed", re: /Failed to instantiate scene/ },
    // Export-smoke honesty: Godot often exits 0 with no artifact when templates
    // are missing or the output path cannot be created.
    { id: "godot-export-no-template", re: /No export template found/i },
    { id: "godot-export-templates-missing", re: /Export templates for this platform are missing/i },
    { id: "godot-export-template-file-missing", re: /Template file not found/i },
    { id: "godot-export-cannot-create", re: /Cannot create file/i },
    { id: "godot-export-no-artifact", re: /export produced no artifact/i },
    // Whole-project check (grok_check.gd) summary when failures > 0.
    { id: "godot-grok-check-failed", re: /^GROK_CHECK: failures=[1-9]/ }
  ]),
  blender: Object.freeze([
    {
      id: "blender-python-script-failed",
      re: /^Error: Python script failed(?:, look above for details| - exiting)/
    },
    // unittest.TextTestRunner prints this summary and returns normally; without
    // a marker, --python-exit-code never fires and a red suite verifies green.
    { id: "blender-unittest-failed", re: /^FAILED \((?:failures|errors)=/ },
    // pytest short test summary line (e.g. "===== 2 failed, 3 passed in 0.1s =====").
    { id: "blender-pytest-failed", re: /^=+ .* (?:failed|error)/ },
    // Exact literal addon_utils.enable prints before handle_error when
    // register() raises — enable() then returns None without re-raising.
    { id: "blender-register-exception", re: /^Exception in module register\(\):/ },
    // Bridge-owned shim result line when failures or errors are non-zero.
    {
      id: "blender-shim-result-failed",
      re: /^GROK_BUILD_BLENDER_RESULT: .*"(?:failures|errors)":[1-9]/
    }
  ])
});

/**
 * A warning is never a failure, whatever else the line happens to say.
 *
 * Enforced here rather than left to each pattern because the phrase-shaped
 * markers (`Parse Error`, `Failed to load script `) are unanchored by
 * necessity — Godot prints them behind several different prefixes — and Godot
 * cheerfully emits lines like `WARNING: Parse Error recovered, continuing.`
 * A single guard is both easier to reason about and impossible for a later
 * pattern addition to forget. Includes SHADER WARNING so phrase-shaped
 * patterns never promote a shader warning to a failure.
 */
const OUTPUT_WARNING_LINE = /^(?:SCRIPT |USER |USER SCRIPT |SHADER |USER SHADER )?WARNING\b/;

/**
 * Which output lines trip a failure pattern.
 *
 * Applied line by line rather than to the whole blob so the caller learns
 * WHICH line failed, not merely that something did — and so a `/m`-anchored
 * pattern and an unanchored one behave the same way. A line that trips more
 * than one pattern is reported once: a single `SCRIPT ERROR: Parse Error: ...`
 * is one failure, not two.
 *
 * @param {string} output
 * @param {{id: string, re: RegExp}[]|null|undefined} patterns
 * @param {RegExp[]|null|undefined} ignorePatterns `--verify-ignore` /
 *   `verifyIgnorePatterns` — dropped BEFORE a failure pattern is tested, next
 *   to the WARNING guard above, so an ignored line cannot set `ok:false` in
 *   the first place. Threading this only into summarizeFailures (as shipped)
 *   left detection itself ungated: the command still came back failed, just
 *   with an empty signature, which classifies as the unreadable
 *   `incomparable` verdict instead of not failing at all.
 * @returns {{ id: string, line: string }[]}
 */
export function detectOutputFailures(output, patterns, ignorePatterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  if (list.length === 0) {
    return [];
  }
  const ignore = Array.isArray(ignorePatterns) ? ignorePatterns : [];

  const matched = [];
  const seen = new Set();
  // Same \r-tolerant split as summarizeFailures: a tool that reports progress
  // with carriage returns would otherwise present its whole run as one line.
  for (const raw of String(output ?? "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line || OUTPUT_WARNING_LINE.test(line) || ignore.some((re) => re.test(line))) {
      continue;
    }
    for (const entry of list) {
      if (!entry?.re || !entry.re.test(line)) {
        continue;
      }
      if (!seen.has(line)) {
        seen.add(line);
        matched.push({ id: String(entry.id ?? "custom"), line });
      }
      break;
    }
  }

  return matched;
}

/**
 * Compile user-supplied regex strings, warning-and-dropping the unusable ones.
 *
 * Never throws: these come from `--verify-ignore` and from `.grok-build.json`,
 * i.e. from a human typing a regex, and one bad character must cost the
 * pattern rather than the run. Mirrors the bridge's unknown-option handling.
 *
 * @param {Iterable<string>|null|undefined} rawPatterns
 * @param {{ onWarning?: (message: string) => void, flags?: string }} [options]
 * @returns {RegExp[]}
 */
export function compileUserPatterns(rawPatterns, options = {}) {
  const compiled = [];
  for (const raw of rawPatterns ?? []) {
    const source = String(raw ?? "").trim();
    if (!source) {
      continue;
    }
    try {
      compiled.push(new RegExp(source, options.flags ?? ""));
    } catch (error) {
      options.onWarning?.(
        `ignoring invalid verify pattern ${JSON.stringify(source)}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return compiled;
}

/**
 * The output-failure pattern set for one run: the union of every detected
 * ecosystem's defaults, extended by whatever `verifyFailurePatterns` the
 * project config adds (which is how the deliberately-excluded broad Godot
 * markers are opted into).
 *
 * Accepts a single ecosystem id string **or** an array of ids so a multi-
 * ecosystem verify plan (Django + React, Blender + Python) gets every relevant
 * marker. Takes ids rather than descriptors because this is resolved inside
 * the run, and a background run reads its request back out of a JSON file —
 * a RegExp does not survive that trip.
 *
 * @param {string|string[]|null|undefined} ecosystemIdOrIds
 * @param {string[]|null|undefined} extraPatterns
 * @param {{ onWarning?: (message: string) => void }} [options]
 */
export function resolveOutputFailurePatterns(ecosystemIdOrIds, extraPatterns, options = {}) {
  const ids = Array.isArray(ecosystemIdOrIds)
    ? ecosystemIdOrIds
    : ecosystemIdOrIds != null && String(ecosystemIdOrIds).trim() !== ""
      ? [ecosystemIdOrIds]
      : [];
  const seen = new Set();
  const base = [];
  for (const id of ids) {
    const key = String(id ?? "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    for (const pattern of OUTPUT_FAILURE_PATTERNS[key] ?? []) {
      if (seen.has(pattern.id)) {
        continue;
      }
      seen.add(pattern.id);
      base.push(pattern);
    }
  }
  const extra = compileUserPatterns(extraPatterns, { ...options, flags: "m" }).map((re, index) => ({
    id: `config-pattern-${index + 1}`,
    re
  }));
  return [...base, ...extra];
}

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
 *   outputFailurePatterns?: {id: string, re: RegExp}[],
 *   ignorePatterns?: RegExp[],
 *   runCommandImpl?: typeof runCommandAsync,
 *   platform?: string
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   exitCode: number|null,
 *   timedOut: boolean,
 *   bufferExceeded?: boolean,
 *   commandNotFound?: boolean,
 *   failureSource?: "output-pattern",
 *   matchedLines?: string[],
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
    // A tree kill that did not land means the engine is still running after
    // this run has said it finished. runCommandAsync now surfaces that verdict
    // instead of discarding it, and the record is the only place a reader would
    // ever learn of the process left behind.
    const orphanNote =
      result.terminate?.delivered === false
        ? " Its process tree could not be terminated, so the command may still be running."
        : "";
    return {
      ok: false,
      exitCode: null,
      timedOut: true,
      commandNotFound: false,
      output: `command timed out after ${options.timeoutMs}ms${orphanNote}`
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

  // Only consulted on a zero exit: a non-zero status is already a failure, and
  // re-labelling its source would overwrite the more specific attribution the
  // classifier derives from the baseline comparison.
  const outputFailures =
    status === 0
      ? detectOutputFailures(`${stdout}\n${stderr}`, options.outputFailurePatterns, options.ignorePatterns)
      : [];

  // A command that failed and said nothing about it. On Windows this is the
  // signature of a GUI-subsystem Godot build: it has no console attached, so
  // it writes to no pipe at all, and every failure it reports is invisible.
  // The same shape occurs for a launcher script that swallows output.
  //
  // Carried as its own field rather than spliced into `output`, deliberately:
  // `output` feeds summarizeFailures (where an advisory sentence would become
  // a fake failure signature) and is pasted VERBATIM into the verify-fix
  // prompt, where it would read as an instruction to the agent on every silent
  // failure. Doctor is where a user is told to install the console build; this
  // field is only how a run RECORDS that it hit the condition.
  const noOutput = status !== 0 && !stdout.trim() && !stderr.trim();

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

  // Judge export-smoke by the filesystem, not Godot's exit code: --export-release
  // frequently exits 0, prints "[ DONE ] savepack", and writes nothing when
  // templates are missing or the output directory did not exist.
  let artifactFailure = null;
  if (status === 0 && outputFailures.length === 0) {
    const artifact = assertExportSmokeArtifact(command, cwd);
    if (!artifact.ok) {
      artifactFailure = artifact.message;
      parts.push(artifactFailure);
    }
  }

  const ok = status === 0 && outputFailures.length === 0 && !artifactFailure;

  return {
    ok,
    ...(noOutput
      ? {
          noOutput: true,
          advisory: `The command exited ${status} and wrote nothing to stdout or stderr, so there is no diagnostic to read. On Windows a GUI-subsystem Godot build (Godot_v4.x-stable_win64.exe) has no console attached and writes to no pipe; the _console.exe build in the same archive does. Run \`doctor\` for the full check.`
        }
      : {}),
    exitCode: status,
    timedOut: false,
    commandNotFound,
    // Deliberately NOT appended to `output`: the matched lines are already in
    // it, and they already match summarizeFailures' \berror\b heuristic, so
    // echoing them a second time would double-count rawCount and needlessly
    // trip the more-failures-same-signature branch.
    ...(outputFailures.length > 0 || artifactFailure
      ? {
          failureSource: "output-pattern",
          matchedLines: [
            ...outputFailures.map((entry) => entry.line),
            ...(artifactFailure ? [artifactFailure] : [])
          ]
        }
      : {}),
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
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number,
 *   outputFailurePatterns?: {id: string, re: RegExp}[],
 *   ignorePatterns?: RegExp[]
 * }} [options]
 * @returns {Promise<{
 *   command: string,
 *   ok: boolean,
 *   ms: number,
 *   signature: string[],
 *   rawCount: number,
 *   timedOut: boolean,
 *   bufferExceeded: boolean,
 *   elidedBytes: number,
 *   commandNotFound: boolean,
 *   outputFailure: boolean
 * }[]>}
 */
export async function probeBaselines(commands, cwd, options = {}) {
  const runVerifyCommandImpl = options.runVerifyCommandImpl ?? runVerifyCommand;
  const baselines = [];
  // The baseline runs BEFORE the agent, in the bridge, and emits none of the
  // agent's own progress events. On a Godot repo the default plan is four
  // commands, one of which is a cold `--import` against a private cache: from
  // the operator's seat that was one log line followed by several minutes of
  // total silence with `agentPid: null`, which is indistinguishable from a
  // hang. Report each command as it starts and as it lands, with its duration
  // and verdict, so the silence is accounted for while it is happening.
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const total = (commands ?? []).length;
  let index = 0;

  for (const command of commands ?? []) {
    index += 1;
    const started = Date.now();
    onProgress?.({
      phase: "verifying",
      message: `Verify baseline ${index}/${total}: running ${command}`
    });
    // The output budget, the failure patterns, the ignore list and the
    // ENVIRONMENT all have to match the post-agent pass. A baseline captured
    // under a tighter bound (or without the pattern set that makes an exit-0
    // Godot import count as a failure) records a shorter signature, and every
    // failure the fuller capture then finds looks new. The env is the same
    // argument with a bigger blast radius: a baseline measured without the
    // run's --env overrides can be running a different binary entirely.
    const probe = await runVerifyCommandImpl(command, cwd, {
      env: options.env,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      outputFailurePatterns: options.outputFailurePatterns,
      // Must match the post-agent pass: this used to be threaded into
      // summarizeFailures only (below), leaving detection itself ungated. A
      // baseline probed WITHOUT the ignore list can come back `ok:false` on a
      // line the user asked to ignore, and every downstream comparison then
      // treats "ignored at baseline" and "ignored after the run" as two
      // different runs of two different commands.
      ignorePatterns: options.ignorePatterns
    });
    const ms = Date.now() - started;
    const summary = summarizeFailures(probe?.output, { ignorePatterns: options.ignorePatterns });
    baselines.push({
      command,
      ok: Boolean(probe?.ok),
      ms,
      signature: summary.signature,
      rawCount: summary.rawCount,
      // A project that was ALREADY printing SCRIPT ERROR before the agent
      // started must be recorded as such, or the first post-agent run blames
      // the agent for it. This is the flag that makes item 8 safe under
      // --no-isolate.
      outputFailure: probe?.failureSource === "output-pattern",
      // Every infrastructure flag the post-agent pass can raise has to be
      // mirrored here too. A baseline that timed out / overflowed its buffer /
      // never started is an unknown baseline, and classifyVerifyFailure can
      // only say so if the flag survived the probe.
      timedOut: Boolean(probe?.timedOut),
      bufferExceeded: Boolean(probe?.bufferExceeded),
      // The ring's own truncation flag, and the one the async runner can
      // actually raise: a probe that overflowed the retention budget captured
      // a head+tail SAMPLE of the failures, and where its cuts landed depends
      // on the probe's total byte count. Comparing that against a differently
      // cut sample is what manufactured phantom "new-failures" verdicts.
      elidedBytes: Number(probe?.elidedBytes) || 0,
      commandNotFound: Boolean(probe?.commandNotFound)
    });

    // Verdict included, not just timing: "already failing" is the single most
    // useful thing to know while the baseline is still running, because it
    // tells the operator up front which post-agent failures will be attributed
    // to the run and which were already there.
    const verdict = probe?.timedOut
      ? "timed out"
      : probe?.commandNotFound
        ? "command not found"
        : probe?.ok
          ? "already passing"
          : "already failing";
    onProgress?.({
      phase: "verifying",
      message: `Verify baseline ${index}/${total}: ${verdict} in ${formatDurationMs(ms)}`
    });
  }

  return baselines;
}

/**
 * Remove only auto-derived commands that were already red before the agent.
 * Explicit --verify and trusted project-config commands are never passed here:
 * the operator asked for those commands and their baseline failure remains a
 * useful pre-existing-failure result rather than standing noise to hide.
 */
export function dropBaselineFailingAutoCommands(commands, baselines, options = {}) {
  if (options.source !== "ecosystem-default") {
    return { commands: [...(commands ?? [])], dropped: [] };
  }
  const byCommand = new Map((baselines ?? []).map((entry) => [entry.command, entry]));
  const kept = [];
  const dropped = [];
  for (const command of commands ?? []) {
    const baseline = byCommand.get(command);
    if (baseline && baseline.ok === false) {
      dropped.push({
        command,
        reason: baseline.timedOut
          ? "baseline timed out"
          : baseline.commandNotFound
            ? "command was not found at baseline"
            : "command failed at baseline"
      });
    } else {
      kept.push(command);
    }
  }
  return { commands: kept, dropped };
}

/** Human duration for progress lines: ms under a second, else seconds. */
function formatDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) {
    return "unknown time";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
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
 * The longest a single signature id may be, applied AFTER normalizeFailureText.
 *
 * A pathological line (a minified bundle, a 10 000-character assertion diff)
 * would otherwise be carried whole into the persisted run record, once for the
 * baseline and once for every attempt. Truncating the RAW line instead would
 * be wrong: the path rules above rewrite Windows and POSIX paths in place, and
 * a pre-normalization slice can cut a path mid-token and defeat them entirely.
 *
 * Truncation can collapse two long failures that share a 512-character prefix
 * onto one id. That is already guarded: rawCount counts occurrences before
 * dedup, and compareFailureSignatures' more-failures-same-signature branch is
 * exactly the case this creates.
 */
const MAX_SIGNATURE_ID_CHARS = 512;

/**
 * Extract a comparable failure signature from verify command output.
 *
 * @param {string} output
 * @param {{ ignorePatterns?: RegExp[] }} [options] `ignorePatterns` drops a
 *   line before it is ever considered a failure — the escape hatch for a tool
 *   whose benign chatter contains the word "error".
 * @returns {{ signature: string[], failureCount: number, rawCount: number }}
 */
export function summarizeFailures(output, options = {}) {
  // \r on its own is a line break here, not content. Defensive hardening
  // rather than a fix for any one tool: anything that draws a progress
  // indicator by rewriting the current line emits bare CRs, and a \r?\n split
  // folds that entire run into ONE enormous "line" whose normalized form
  // differs on every invocation - so the signature never compares equal to its
  // own baseline. (Measured: Blender 5.2 background renders are 100% LF with
  // zero CRs, so this is not a Blender fix.)
  const lines = String(output ?? "").split(/\r\n|\r|\n/);
  const ignorePatterns = Array.isArray(options.ignorePatterns) ? options.ignorePatterns : [];
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

    // Before looksLikeFailure, not after: the point of an ignore pattern is
    // that the line never counts as a failure at all, so it must not reach
    // rawCount either.
    if (ignorePatterns.some((re) => re.test(t))) {
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
      ids.push(n.length > MAX_SIGNATURE_ID_CHARS ? n.slice(0, MAX_SIGNATURE_ID_CHARS) : n);
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
 * @param {{
 *   currentRawCount?: number,
 *   baselineRawCount?: number,
 *   rawCountComparison?: "strict"|"ignore"
 * }} [options] `rawCountComparison: "ignore"` disables the occurrence-count
 *   check below. Godot re-prints the same runtime error once PER FRAME, so a
 *   run that merely idles a few frames longer than the baseline reports
 *   hundreds more occurrences of an identical error set - a regression that
 *   never happened. The deduped-signature comparison still catches genuinely
 *   new errors; only the count heuristic is surrendered.
 * @returns {{
 *   outcome: "new-failures"|"partial-progress"|"unchanged-from-baseline"|"more-failures-same-signature"|"incomparable",
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
    options.rawCountComparison !== "ignore" &&
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
 *   elidedBytes?: number,
 *   commandNotFound?: boolean,
 *   baselineSkipped?: boolean
 * }|undefined|null} baselineEntry
 * @param {{
 *   timedOut?: boolean,
 *   bufferExceeded?: boolean,
 *   elidedBytes?: number,
 *   commandNotFound?: boolean,
 *   rawCountComparison?: "strict"|"ignore"
 * }} [options]
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

  // Two ways the same thing happens. `bufferExceeded` is the legacy synchronous
  // runner's cliff (the process was killed the moment maxBuffer was crossed);
  // `elidedBytes > 0` is the async ring having dropped the middle of the
  // stream. Either way what survived is a SAMPLE of the failures, not the set
  // of them, and where the sample's cuts land moves with the total byte count -
  // so comparing it line-for-line against a baseline sample cut somewhere else
  // reported "new-failures" for a byte-identical failure set and spent a model
  // turn chasing a failure that did not exist.
  //
  // Deliberately an ESCAPABLE state rather than a permanent one for a chatty
  // repo: the retention budget genuinely scales now (see createOutputRing), so
  // `--verify-max-buffer` / GROK_VERIFY_MAX_OUTPUT_BYTES buy back a comparable
  // capture and with it an attributed verdict. That was not true when the ring
  // capped retention at 320 KiB no matter what the user asked for.
  if (options.bufferExceeded || Number(options.elidedBytes) > 0) {
    return { blamed: false, reason: "verify-output-truncated", infrastructure: true };
  }

  if (baselineEntry?.bufferExceeded || Number(baselineEntry?.elidedBytes) > 0) {
    // Symmetric to the timeout guard below: the probe was killed mid-output or
    // had its middle elided, so whatever signature it did capture is a partial
    // sample, not a baseline anything can be compared against.
    return { blamed: false, reason: "baseline-unknown" };
  }

  if (baselineEntry?.baselineSkipped) {
    // The user passed --no-verify-baseline: they chose not to measure what was
    // already broken, which makes verification STRICT rather than unknown.
    // Deliberately not folded into baseline-unknown / timedOut: "we could not
    // look" and "we chose not to look" have opposite correct behaviours, and
    // reusing timedOut:true to mean the second would make the run record lie
    // about what happened.
    return { blamed: true, reason: "baseline-skipped" };
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
    baselineRawCount: baselineEntry?.rawCount,
    rawCountComparison: options.rawCountComparison
  });

  if (comparison.outcome === "unchanged-from-baseline") {
    return { blamed: false, reason: "unchanged-from-baseline", comparison: comparison.outcome };
  }

  // Partition by baseline result (FIELD-1). A command that was already red
  // before the agent started is NEVER the agent's responsibility: it must not
  // trigger a fix turn and must not downgrade the run. Signature drift on a
  // pre-broken suite (cargo test reordering, different panic text after an
  // unrelated edit) used to look like "new-failures" and burn the whole
  // remaining budget demanding a fix of something the agent never owned.
  if (baselineEntry?.ok === false) {
    // Preserve the older label when neither side had extractable signatures so
    // existing records stay readable; everything else is pre-existing-failure.
    if (comparison.outcome === "incomparable") {
      return { blamed: false, reason: "baseline-already-failing", comparison: comparison.outcome };
    }
    return { blamed: false, reason: "pre-existing-failure", comparison: comparison.outcome };
  }

  return { blamed: true, reason: comparison.outcome, comparison: comparison.outcome };
}
