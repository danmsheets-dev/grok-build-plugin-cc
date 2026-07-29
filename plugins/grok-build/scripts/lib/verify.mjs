import process from "node:process";

import { runCommand } from "./process.mjs";

const DEFAULT_FLOOR_MS = 120_000;
const DEFAULT_CAP_MS = 900_000;
const DEFAULT_MULTIPLIER = 4;
const MAX_BUFFER = 5 * 1024 * 1024;

/**
 * Run a verify command string without shell:true so paths with spaces stay intact.
 * On win32 uses ComSpec/cmd.exe with /d /s /c; elsewhere /bin/sh -c.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   runCommandImpl?: typeof runCommand,
 *   platform?: string
 * }} [options]
 * @returns {{
 *   ok: boolean,
 *   exitCode: number|null,
 *   timedOut: boolean,
 *   output: string
 * }}
 */
export function runVerifyCommand(command, cwd, options = {}) {
  const run = options.runCommandImpl ?? runCommand;
  const platform = options.platform ?? process.platform;
  const shell = platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const shellArgs =
    platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];

  const result = run(shell, shellArgs, {
    cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: MAX_BUFFER
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      exitCode: null,
      timedOut: true,
      output: `command timed out after ${options.timeoutMs}ms`
    };
  }

  if (result.error) {
    return {
      ok: false,
      exitCode: null,
      timedOut: false,
      output: `Failed to run command: ${result.error.message}`
    };
  }

  const status = result.status;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
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
    output: parts.join("\n")
  };
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
    failureCount: signature.length
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
export function compareFailureSignatures(current, baseline) {
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

  return {
    outcome: "unchanged-from-baseline",
    newFailures: [],
    remainingCount,
    baselineCount: base.length
  };
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
