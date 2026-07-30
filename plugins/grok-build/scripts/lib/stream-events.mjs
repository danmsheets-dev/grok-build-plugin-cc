/** Incremental NDJSON line decoder. Chunk boundaries may split a JSON line. */
export function createNdjsonDecoder() {
  let buffer = "";

  return {
    push(chunk) {
      buffer += String(chunk ?? "");
      const segments = buffer.split("\n");
      buffer = segments.pop() ?? "";
      return segments.map((segment) => segment.trim()).filter(Boolean);
    },
    flush() {
      const remainder = buffer.trim();
      buffer = "";
      return remainder ? [remainder] : [];
    }
  };
}

/** Parse one NDJSON line. Returns null for anything that is not a JSON object. */
export function parseStreamEvent(line) {
  const text = String(line ?? "").trim();
  if (!text) {
    return null;
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export const MESSAGE_SEPARATOR = "\n\n";

// Delimiters of the run-report contract (prompts/run-report.md). Plain ASCII
// on purpose: on Windows an npm-installed grok resolves to `grok.cmd`, which
// which.mjs routes through `cmd.exe /d /s /c`, and cmd re-interprets `<`, `>`,
// `&`, `^` and `%` even inside the quoted command line. Angle-bracket tags -
// the shape prompts/critique.md uses, because that prompt never travels through
// argv on the cmd shim path - would come back mangled.
export const FINAL_REPORT_OPEN = "===GROK-FINAL-REPORT===";
export const FINAL_REPORT_CLOSE = "===END-GROK-FINAL-REPORT===";

/**
 * Pull the delimited final report out of an agent's messages.
 *
 * Returns the LAST complete block: a long agentic run can echo the contract
 * mid-flight (quoting it back while planning, or reporting on a sub-task), and
 * the one that matters is the one it finished on. Returns "" when the model did
 * not comply, which every caller treats as "fall back to the plain text".
 *
 * @param {string[]|string} messages
 * @returns {string}
 */
export function extractFinalReport(messages) {
  const joined = Array.isArray(messages)
    ? messages.filter((message) => typeof message === "string").join(MESSAGE_SEPARATOR)
    : String(messages ?? "");
  if (!joined) {
    return "";
  }
  // Built per call rather than hoisted: a module-scope /g regex carries
  // lastIndex, and one stray .test()/.exec() added later would make this
  // function's result depend on call order.
  const pattern = new RegExp(`${FINAL_REPORT_OPEN}([\\s\\S]*?)${FINAL_REPORT_CLOSE}`, "g");
  let report = "";
  for (const match of joined.matchAll(pattern)) {
    report = match[1].trim();
  }
  return report;
}

const PHASE_BY_TYPE = {
  thought: "thinking",
  text: "writing"
};

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeUsage(event) {
  const usage = event?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  return {
    inputTokens: toFiniteNumber(usage.input_tokens),
    cachedInputTokens: toFiniteNumber(usage.cache_read_input_tokens),
    outputTokens: toFiniteNumber(usage.output_tokens),
    reasoningTokens: toFiniteNumber(usage.reasoning_tokens),
    totalTokens: toFiniteNumber(usage.total_tokens),
    costUsd: Number.isFinite(Number(event.total_cost_usd)) ? Number(event.total_cost_usd) : null,
    numTurns: Number.isFinite(Number(event.num_turns)) ? Number(event.num_turns) : null
  };
}

/**
 * Accumulates a grok streaming-json transcript.
 * Turn boundary rule: a `text` event arriving after a non-`text` event starts a new message.
 */
export function createStreamTranscript() {
  const messages = [];
  const unknownTypes = new Set();
  let current = "";
  let lastType = null;
  // How many events this parser actually understood. The ONLY safe signal for
  // "the stream was in a format we do not speak": `messages.length` is not, and
  // gating a raw-stdout fallback on it would dump the whole NDJSON at the user
  // for a legitimate tool-only run that never emitted a line of prose.
  let recognizedEvents = 0;
  let sessionId = null;
  let stopReason = null;
  let usage = null;

  function closeCurrentMessage() {
    const completed = current.trim();
    current = "";
    if (!completed) {
      return null;
    }
    messages.push(completed);
    return completed;
  }

  return {
    accept(event) {
      const type = typeof event?.type === "string" ? event.type : "";
      const result = { phase: PHASE_BY_TYPE[type] ?? null, textDelta: "", messageCompleted: null };

      // Counted before the branch below, so a `thought`-only turn (a run that
      // did all its work through tools) still counts as understood.
      if (type === "text" || type === "thought" || type === "end") {
        recognizedEvents += 1;
      }

      if (type === "text") {
        if (lastType !== "text") {
          result.messageCompleted = closeCurrentMessage();
        }
        const delta = String(event.data ?? "");
        current += delta;
        result.textDelta = delta;
      } else {
        result.messageCompleted = closeCurrentMessage();
        if (type === "end") {
          sessionId = typeof event.sessionId === "string" ? event.sessionId : sessionId;
          stopReason = typeof event.stopReason === "string" ? event.stopReason : stopReason;
          usage = normalizeUsage(event) ?? usage;
        } else if (type && type !== "thought") {
          unknownTypes.add(type);
        }
      }

      lastType = type;
      return result;
    },

    finish() {
      closeCurrentMessage();
      const joined = messages.join(MESSAGE_SEPARATOR);
      return {
        messages: [...messages],
        // The whole narration. Every `text` run that followed a `thought` is a
        // separate message (the CLI emits no turn markers), so on a 40-turn run
        // this is a wall of "Let me check X" with the answer buried at the end.
        // Keep it: it is the log, and the only thing that survives when the
        // model ends mid-thought.
        transcript: joined,
        // The text after the final `thought` - the streaming analogue of
        // `--output-format json`'s `text` field, i.e. the answer.
        lastMessage: messages.at(-1) ?? "",
        // The answer the run-report contract asked for, when the model complied.
        finalReport: extractFinalReport(messages),
        // UNCHANGED, and deliberately still the joined transcript. Narrowing it
        // to the last message would be a silent contract change for every
        // existing consumer (the review paths want the full text), and until the
        // report contract is actually honoured `lastMessage` on its own is often
        // a mid-flight line - strictly less information than this.
        finalMessage: joined,
        sessionId,
        stopReason,
        usage,
        unknownTypes: [...unknownTypes],
        // Zero means the CLI emitted a stream this parser understood nothing
        // of - a renamed event vocabulary, or not NDJSON at all. Callers use it
        // to decide whether the transcript above is empty because the run was
        // quiet, or because it was never read.
        recognizedEvents
      };
    }
  };
}
