import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import {
  createNdjsonDecoder,
  createStreamTranscript,
  extractFinalReport,
  parseStreamEvent
} from "./stream-events.mjs";
import { resolveSpawnInvocation } from "./which.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

const DEFAULT_BINARY = "grok";
const BINARY_ENV = "GROK_BINARY";

// How much raw stdout is shown when the streaming parser recognized nothing at
// all. Enough to carry a final answer and the context around it; small enough
// that a run which streamed megabytes of an unknown format does not push all of
// it into a job record, through redaction, and into the terminal.
const RAW_STDOUT_FALLBACK_LINES = 200;

export function resolveGrokBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

export function runGrok(args = [], options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  return runCommand(binary, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio
  });
}

export function getGrokAvailability(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const versionStatus = binaryAvailable(binary, ["version"], { cwd, env: options.env });
  if (!versionStatus.available) {
    const alt = binaryAvailable(binary, ["--version"], { cwd, env: options.env });
    if (!alt.available) {
      return {
        available: false,
        detail: versionStatus.detail,
        binary
      };
    }
    return {
      available: true,
      detail: alt.detail,
      binary
    };
  }
  return {
    available: true,
    detail: versionStatus.detail,
    binary
  };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "models-probe",
    authMethod: null,
    verified: null,
    ...fields
  };
}

export function runModelsProbe(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const result = runGrok(["models"], {
    cwd,
    env: options.env,
    binary
  });

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return buildAuthStatus({
      available: false,
      loggedIn: false,
      detail: "grok binary not found",
      source: "availability"
    });
  }

  if (result.error) {
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: result.error.message,
      source: "models-probe"
    });
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: detail || "grok models failed; not logged in or not ready",
      source: "models-probe"
    });
  }

  const stdout = (result.stdout || "").trim();
  const loggedInHint = /logged in|available models|default model/i.test(stdout);
  return buildAuthStatus({
    available: true,
    loggedIn: true,
    detail: loggedInHint
      ? firstLine(stdout) || "grok models succeeded"
      : firstLine(stdout) || "grok models succeeded (treated as logged in)",
    source: "models-probe",
    authMethod: "grok-cli",
    verified: true
  });
}

export function getGrokAuthStatus(cwd, options = {}) {
  const availability = getGrokAvailability(cwd, options);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }
  return runModelsProbe(cwd, { ...options, binary: availability.binary });
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

// Windows does not have one command-line limit, it has two, and both are well
// under what a review diff can reach. Measured on this box: a single 40 000-char
// argv element handed straight to CreateProcess fails outright with
// ENAMETOOLONG; the SAME prompt routed through the `cmd.exe /d /s /c` form that
// which.mjs:155-167 produces for a `.cmd` shim dies at ~8 500 chars with
// `The command line is too long.` on stderr, status 1 and NO `error` field - so
// the user saw nothing but "Grok exited with status 1".
//
// POSIX is not exempt, just later: Linux caps a SINGLE argument at
// MAX_ARG_STRLEN (32 pages = 131 072 bytes) regardless of how much total room
// ARG_MAX allows, so a large enough prompt is E2BIG there too.
export const PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM = 7000;
export const PROMPT_ARGV_BUDGET_WIN32 = 28000;
export const PROMPT_ARGV_BUDGET_POSIX = 120 * 1024;
// Floor, so a pathological pile of other flags cannot resolve the prompt's
// share to zero (or negative) and produce an argument that is nothing but an
// elision marker. Overflowing is still possible in that degenerate case, but a
// prompt is not worth sending at all below this.
const MIN_PROMPT_ARGV_BUDGET = 1024;
// Rough per-argument cost of the separator and quoting the OS adds around each
// argv element. Deliberately pessimistic - the point is to stay under a hard
// limit, not to use every last byte of it.
const ARGV_ELEMENT_OVERHEAD_BYTES = 3;

function argvBytes(values, initial = 0) {
  return values.reduce(
    (total, value) => total + Buffer.byteLength(String(value ?? ""), "utf8") + ARGV_ELEMENT_OVERHEAD_BYTES,
    initial
  );
}

/**
 * How many bytes the prompt argument may occupy.
 *
 * Derived from the invocation SHAPE, not just the platform: the cmd.exe shim
 * form has roughly a quarter of the direct form's headroom. `otherArgvBytes`
 * is subtracted because the limit is on the whole command line - the critique
 * path alone also carries a serialized `--json-schema`, which is far from free.
 */
export function resolvePromptArgvBudget(options = {}) {
  const platform = options.platform ?? process.platform;
  const explicit = Number(options.argvBudget);
  const total =
    Number.isFinite(explicit) && explicit > 0
      ? Math.floor(explicit)
      : platform === "win32"
        ? options.cmdShim
          ? PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM
          : PROMPT_ARGV_BUDGET_WIN32
        : PROMPT_ARGV_BUDGET_POSIX;

  const other = Number(options.otherArgvBytes);
  const reserved = Number.isFinite(other) && other > 0 ? Math.floor(other) : 0;
  return Math.max(MIN_PROMPT_ARGV_BUDGET, total - reserved);
}

/**
 * Middle-truncate a prompt to fit a byte budget.
 *
 * The middle is what goes: the head carries the task framing and the tail
 * carries the newest hunks, the untracked section and any schema instructions -
 * i.e. both ends are load-bearing and the interior of a huge diff is the part a
 * reviewer can re-read from disk.
 *
 * @returns {{prompt: string, elidedBytes: number, originalBytes: number}}
 */
export function boundPromptForArgv(prompt, budgetBytes) {
  const raw = String(prompt ?? "");
  const buffer = Buffer.from(raw, "utf8");
  if (buffer.length <= budgetBytes) {
    return { prompt: raw, elidedBytes: 0, originalBytes: buffer.length };
  }

  const markerFor = (bytes) =>
    `\n\n[... ${bytes} bytes elided: prompt exceeded the platform command-line limit ...]\n\n`;
  // Reserve against the LONGEST marker this can produce - the elided count can
  // never exceed the whole prompt - plus slack for the two cut points: slicing a
  // Buffer mid-character turns each stray byte into a 3-byte U+FFFD, so the
  // decoded string can come back slightly longer than the slices were.
  const reserved = Buffer.byteLength(markerFor(buffer.length), "utf8") + 32;
  const available = Math.max(0, budgetBytes - reserved);
  const headBytes = Math.floor(available * 0.35);
  const tailBytes = available - headBytes;
  const elidedBytes = buffer.length - headBytes - tailBytes;

  return {
    prompt:
      buffer.subarray(0, headBytes).toString("utf8") +
      markerFor(elidedBytes) +
      buffer.subarray(buffer.length - tailBytes).toString("utf8"),
    elidedBytes,
    originalBytes: buffer.length
  };
}

/**
 * Spill an oversized prompt to disk so `--prompt-file` can carry it verbatim.
 * The file is kept rather than deleted: it is the exact input of a run that is
 * about to be logged, and a few tens of KB next to the job records it belongs
 * with is cheaper than not being able to reproduce the run.
 */
function writePromptFile(directory, prompt) {
  const promptsDir = path.join(String(directory), "prompts");
  fs.mkdirSync(promptsDir, { recursive: true });
  const filePath = path.join(promptsDir, `prompt-${Date.now()}-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(filePath, prompt, "utf8");
  return filePath;
}

export function buildHeadlessArgs(prompt, options = {}) {
  const leading = [];

  if (options.resumeSessionId) {
    leading.push("-r", options.resumeSessionId);
  } else if (options.continueLast) {
    leading.push("-c");
  } else if (options.sessionId) {
    leading.push("--session-id", options.sessionId);
  }

  const trailing = [];

  if (options.cwd) {
    trailing.push("--cwd", options.cwd);
  }
  if (options.agent) {
    trailing.push("--agent", options.agent);
  }
  if (options.permissionMode) {
    trailing.push("--permission-mode", options.permissionMode);
  }
  if (options.sandbox) {
    trailing.push("--sandbox", options.sandbox);
  }
  if (options.alwaysApprove) {
    trailing.push("--always-approve");
  }
  if (options.model) {
    trailing.push("--model", options.model);
  }
  if (options.effort) {
    trailing.push("--effort", options.effort);
  }
  // Extra rules appended to the SYSTEM prompt. The output contract belongs here
  // rather than glued onto the user's prompt: the prompt is also what the bridge
  // shortens into a job summary and the /grok-build:runs table, so contract text
  // pasted there becomes the visible title of every run. Counted in the argv
  // budget below like any other flag - it is a few hundred bytes off a 7 000
  // byte allowance on the Windows cmd-shim path.
  if (options.rules) {
    trailing.push("--rules", String(options.rules));
  }
  if (options.outputFormat) {
    trailing.push("--output-format", options.outputFormat);
  } else {
    trailing.push("--output-format", "streaming-json");
  }
  if (options.maxTurns != null && Number.isFinite(Number(options.maxTurns)) && Number(options.maxTurns) >= 1) {
    trailing.push("--max-turns", String(options.maxTurns));
  }
  if (options.jsonSchema) {
    const schemaText =
      typeof options.jsonSchema === "string" ? options.jsonSchema : JSON.stringify(options.jsonSchema);
    trailing.push("--json-schema", schemaText);
  }

  // Everything but the prompt is measured first: the platform limit applies to
  // the whole command line, and `argvOverheadBytes` lets the caller add what the
  // resolver prepends (node + a script path, or cmd.exe /d /s /c).
  const otherArgvBytes = argvBytes(
    [...leading, ...trailing, "-p"],
    Number.isFinite(Number(options.argvOverheadBytes)) ? Number(options.argvOverheadBytes) : 0
  );
  const budgetBytes = resolvePromptArgvBudget({
    platform: options.platform,
    cmdShim: options.cmdShim,
    argvBudget: options.argvBudget,
    otherArgvBytes
  });

  const raw = String(prompt ?? "");
  const promptBytes = Buffer.byteLength(raw, "utf8");
  let promptArgs = null;
  const transport = { mode: "inline", promptBytes, budgetBytes, elidedBytes: 0, promptFile: null };

  if (promptBytes <= budgetBytes) {
    promptArgs = ["-p", raw];
  } else if (options.promptFileDir) {
    // Preferred over truncating: `--prompt-file` takes the prompt out of argv
    // entirely, so nothing is lost. Falls through to truncation if the spill
    // cannot be written - a full or read-only state dir must not fail the run.
    try {
      const promptFile = writePromptFile(options.promptFileDir, raw);
      promptArgs = ["--prompt-file", promptFile];
      transport.mode = "prompt-file";
      transport.promptFile = promptFile;
    } catch {
      promptArgs = null;
    }
  }

  if (!promptArgs) {
    const bounded = boundPromptForArgv(raw, budgetBytes);
    promptArgs = ["-p", bounded.prompt];
    transport.mode = "truncated";
    transport.elidedBytes = bounded.elidedBytes;
  }

  options.onPromptBounded?.(transport);

  return [...leading, ...promptArgs, ...trailing];
}

export function runHeadlessAgent(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!prompt) {
    return Promise.reject(new Error("A prompt is required for this Grok run."));
  }

  const sessionId = options.resumeSessionId
    ? options.resumeSessionId
    : options.sessionId || (options.assignSessionId === false ? null : crypto.randomUUID());

  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== "win32";
  const spawnEnv = options.env ?? process.env;

  // The prompt's argv budget depends on HOW the binary gets launched, so the
  // invocation shape has to be known before the args are built. Resolving with
  // an empty arg list is enough to learn that and to measure the prefix the
  // resolver prepends (cmd.exe /d /s /c, or node + a script path).
  const invocationShape = resolveSpawnInvocation(binary, [], spawnEnv, platform);
  let promptTransport = null;

  const args = buildHeadlessArgs(prompt, {
    ...options,
    cwd: options.cwd ?? cwd,
    sessionId: options.resumeSessionId || options.continueLast ? undefined : sessionId,
    platform,
    cmdShim: invocationShape.windowsVerbatimArguments === true,
    argvOverheadBytes: argvBytes([invocationShape.executable, ...invocationShape.args]),
    onPromptBounded: (info) => {
      promptTransport = info;
    }
  });

  // Resolve through PATH/PATHEXT so an extensionless shebang script on PATH is
  // honoured. Without this, Windows CreateProcess skips it and silently runs a
  // real `grok.exe` from elsewhere on PATH instead.
  const invocation = resolveSpawnInvocation(binary, args, spawnEnv, platform);

  const outputFormat = options.outputFormat ?? "streaming-json";
  const streaming = outputFormat === "streaming-json";

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: spawnEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      windowsHide: true
    });

    const agentPid = child.pid ?? null;
    emitProgress(options.onProgress, `Running grok (${binary}).`, "starting", {
      threadId: sessionId,
      agentPid,
      pid: agentPid
    });

    // An elided prompt changes what the model was asked, so it must never be
    // silent. The prompt-file case is non-lossy but still worth saying, because
    // the path is the only way to see what was actually sent.
    if (promptTransport?.mode === "prompt-file") {
      emitProgress(
        options.onProgress,
        `Prompt was ${promptTransport.promptBytes} bytes, over the ${promptTransport.budgetBytes} byte command-line budget; sent via --prompt-file ${promptTransport.promptFile}.`,
        "starting",
        { threadId: sessionId, agentPid }
      );
    } else if (promptTransport?.mode === "truncated") {
      emitProgress(
        options.onProgress,
        `Prompt was ${promptTransport.promptBytes} bytes, over the ${promptTransport.budgetBytes} byte command-line budget; ${promptTransport.elidedBytes} bytes were elided from the middle.`,
        "starting",
        { threadId: sessionId, agentPid }
      );
    }

    let stdout = "";
    let stderr = "";
    const decoder = streaming ? createNdjsonDecoder() : null;
    const transcript = streaming ? createStreamTranscript() : null;
    let lastPhase = null;

    function consumeLine(line) {
      const event = parseStreamEvent(line);
      if (!event) {
        return;
      }
      const outcome = transcript.accept(event);
      if (outcome.messageCompleted) {
        emitProgress(options.onProgress, outcome.messageCompleted, outcome.phase ?? lastPhase, {
          threadId: sessionId,
          agentPid
        });
      }
      if (outcome.phase && outcome.phase !== lastPhase) {
        lastPhase = outcome.phase;
        emitProgress(options.onProgress, `Grok is ${outcome.phase}.`, outcome.phase, {
          threadId: sessionId,
          agentPid
        });
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (streaming) {
        for (const line of decoder.push(chunk)) {
          consumeLine(line);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      const status = code ?? (signal ? 1 : 0);
      let result = null;
      if (streaming) {
        for (const line of decoder.flush()) {
          consumeLine(line);
        }
        result = transcript.finish();
      }

      const resolvedThreadId = result?.sessionId || sessionId;
      // Non-streaming (`--output-format json`, or plain) has exactly one body of
      // text, so all four text fields collapse onto it. Only `finalReport` can
      // still differ, because the fence may or may not be in there.
      const plainText = stdout.trimEnd();

      // Did the streaming parser understand ANY of what came back? A CLI update
      // that renames the event vocabulary turns every text field empty while
      // stdout is full of the answer, and the user gets "Grok did not return a
      // final message." for a run that said plenty. Gate on "nothing was
      // recognized at all" rather than on an empty transcript: a tool-only run
      // legitimately produces no messages, and dumping raw NDJSON at it would
      // be strictly worse than the silence.
      const streamParsed = streaming ? result.recognizedEvents > 0 : true;
      const streamFallback =
        streaming && result.recognizedEvents === 0 && stdout.trim()
          ? // Bounded: unparsed stdout is the whole run, which on a long agentic
            // session is megabytes of machine output. The tail is the part that
            // carries the answer.
            plainText.split(/\r?\n/).slice(-RAW_STDOUT_FALLBACK_LINES).join("\n")
          : "";
      // One body of text that every text field collapses onto, or null when a
      // parsed transcript is available and should be used instead.
      const collapsedText = streamFallback || (result ? null : plainText);
      emitProgress(
        options.onProgress,
        status === 0 ? "Grok finished." : `Grok exited with status ${status}.`,
        status === 0 ? "finalizing" : "failed",
        { threadId: resolvedThreadId, agentPid }
      );

      resolve({
        status,
        signal,
        stdout,
        stderr,
        sessionId: resolvedThreadId,
        threadId: resolvedThreadId,
        agentPid,
        finalMessage: collapsedText ?? result.finalMessage,
        // Additive companions to finalMessage: the whole narration, the final
        // assistant message, and the delimited report when the model emitted
        // one. finalMessage keeps meaning "the joined transcript" so no existing
        // consumer changes meaning under it.
        transcript: collapsedText ?? result.transcript,
        lastMessage: collapsedText ?? result.lastMessage,
        finalReport:
          collapsedText == null ? result.finalReport : extractFinalReport(collapsedText),
        messages: result ? result.messages : null,
        usage: result?.usage ?? null,
        stopReason: result?.stopReason ?? null,
        unknownEventTypes: result?.unknownTypes ?? [],
        // False only when a streaming run's events were all unrecognized, i.e.
        // when the four text fields above are raw stdout rather than a parsed
        // transcript. The renderer says so out loud rather than passing off
        // machine output as the model's answer.
        streamParsed,
        args,
        binary,
        promptTransport
      });
    });
  });
}

export function runImport(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const args = ["import"];
  if (options.list) {
    args.push("--list");
  }
  if (options.sourcePath) {
    args.push(options.sourcePath);
  }
  if (options.json !== false) {
    args.push("--json");
  }

  emitProgress(options.onProgress, "Importing Claude session into Grok.", "transferring");

  const result = runGrok(args, {
    cwd,
    env: options.env,
    binary
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(detail || "grok import failed");
  }

  const raw = (result.stdout || "").trim();
  let parsed = null;
  let sessionId = null;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      parsed = obj;
      sessionId =
        obj.sessionId ??
        obj.session_id ??
        obj.id ??
        obj.importedSessionId ??
        obj.threadId ??
        sessionId;
    } catch {
    }
  }

  if (!sessionId) {
    const match = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
    if (match) {
      sessionId = match[0];
    }
  }

  emitProgress(options.onProgress, sessionId ? `Imported session ${sessionId}.` : "Import completed.", "completed", {
    threadId: sessionId
  });

  return {
    status: 0,
    stdout: raw,
    stderr: result.stderr,
    sessionId,
    threadId: sessionId,
    parsed,
    resumeCommand: sessionId ? `grok -r ${sessionId}` : null
  };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  const text = String(rawOutput).trim();

  try {
    return {
      ...fallback,
      parsed: JSON.parse(text),
      parseError: null,
      rawOutput: text
    };
  } catch {
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(fenced[1].trim()),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(text.slice(start, end + 1)),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from Grok output.",
    rawOutput: text
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return [
    "Return only valid JSON matching this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput, schemaInstructions = "" }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only inspection.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)",
    schemaInstructions ? `\n${schemaInstructions}` : ""
  ];
  return parts.filter((line) => line !== undefined).join("\n");
}
