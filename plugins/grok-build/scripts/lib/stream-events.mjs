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

/**
 * Pick the model the provider actually served from `modelUsage`.
 * The key with the most modelCalls wins; a sole key wins even without counts.
 * Requested model (e.g. grok-4.5) and served model (e.g. grok-4.5-build) differ
 * on Hyper, and the key is the only place the served id appears.
 */
export function resolveModelFromUsage(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) {
    return null;
  }
  const entries = Object.entries(modelUsage).filter(([key]) => typeof key === "string" && key.trim());
  if (entries.length === 0) {
    return null;
  }
  if (entries.length === 1) {
    return entries[0][0];
  }
  let bestKey = entries[0][0];
  let bestCalls = -1;
  for (const [key, value] of entries) {
    const calls = toFiniteNumber(value?.modelCalls ?? value?.model_calls, 0);
    if (calls > bestCalls) {
      bestCalls = calls;
      bestKey = key;
    }
  }
  return bestKey;
}

/**
 * Event names that mean a tool was invoked (not merely a result arriving).
 * The CLI vocabulary has moved more than once; match both historical and
 * current names, case-insensitively on the hyphen/underscore form.
 */
const TOOL_INVOCATION_TYPES = new Set([
  "tool_use",
  "tool_call",
  "toolcall",
  "tool-call",
  "tool_request",
  "tool-request",
  "function_call",
  "functioncall",
  "mcp_tool_call",
  "mcp_call"
]);

/**
 * Any event that proves this CLI stream speaks a tool vocabulary.
 * Presence of a result/response without a paired invocation still means the
 * bridge can count (and a genuine zero is possible via end-event fields);
 * absence of every tool-shaped type means the count is unknown, not zero.
 */
const TOOL_SIGNAL_TYPES = new Set([
  ...TOOL_INVOCATION_TYPES,
  "tool_result",
  "tool-result",
  "tool_response",
  "tool-response",
  "function_result",
  "function_response",
  "mcp_tool_result",
  "tool"
]);

function normalizeToolType(type) {
  return String(type ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function isToolInvocationType(type) {
  const normalized = normalizeToolType(type);
  if (!normalized) {
    return false;
  }
  if (TOOL_INVOCATION_TYPES.has(normalized) || TOOL_INVOCATION_TYPES.has(String(type ?? "").trim().toLowerCase())) {
    return true;
  }
  // Hyphen forms land here after normalize; also catch function_call-style names.
  return (
    (normalized.includes("tool") && (normalized.includes("call") || normalized.includes("use") || normalized.includes("request"))) ||
    normalized === "function_call" ||
    normalized === "functioncall" ||
    normalized === "mcp_call" ||
    normalized === "mcp_tool_call"
  ) && !normalized.includes("result") && !normalized.includes("response") && !normalized.includes("output");
}

function isToolSignalType(type) {
  const normalized = normalizeToolType(type);
  if (!normalized) {
    return false;
  }
  if (TOOL_SIGNAL_TYPES.has(normalized) || TOOL_SIGNAL_TYPES.has(String(type ?? "").trim().toLowerCase())) {
    return true;
  }
  if (isToolInvocationType(type)) {
    return true;
  }
  return (
    normalized.includes("tool") ||
    normalized.startsWith("function_") ||
    normalized.startsWith("mcp_")
  ) && normalized !== "thought";
}

function readExplicitToolCallCount(event) {
  const candidates = [
    event?.toolCallCount,
    event?.tool_call_count,
    event?.num_tool_calls,
    event?.numToolCalls,
    event?.toolCalls
  ];
  for (const value of candidates) {
    if (value == null) {
      continue;
    }
    if (Array.isArray(value)) {
      return value.length;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

/**
 * Sum modelCalls across Hyper's per-served-model breakdown.
 * Field-report BRIDGE-5: rate-card comparison alone picked the wrong model
 * because Luna made 134 inference calls to Terra's 29; that count lived only
 * inside modelUsage and was never surfaced.
 */
export function sumModelCalls(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) {
    return null;
  }
  let total = 0;
  let saw = false;
  for (const value of Object.values(modelUsage)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const raw = value.modelCalls ?? value.model_calls;
    if (raw == null) {
      continue;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) {
      total += n;
      saw = true;
    }
  }
  return saw ? total : null;
}

/**
 * Merge two modelUsage maps by summing numeric fields per served-model key.
 * Used by addUsage so multi-turn runs do not keep only the last turn's map.
 */
export function mergeModelUsage(a, b) {
  if (!b) {
    return a && typeof a === "object" ? { ...a } : undefined;
  }
  if (!a) {
    return b && typeof b === "object" ? { ...b } : undefined;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = {};
  for (const key of keys) {
    const left = a[key] && typeof a[key] === "object" ? a[key] : {};
    const right = b[key] && typeof b[key] === "object" ? b[key] : {};
    const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    out[key] = {
      ...left,
      ...right,
      inputTokens: numeric(left.inputTokens ?? left.input_tokens) + numeric(right.inputTokens ?? right.input_tokens),
      outputTokens:
        numeric(left.outputTokens ?? left.output_tokens) + numeric(right.outputTokens ?? right.output_tokens),
      cacheReadInputTokens:
        numeric(left.cacheReadInputTokens ?? left.cache_read_input_tokens) +
        numeric(right.cacheReadInputTokens ?? right.cache_read_input_tokens),
      modelCalls: numeric(left.modelCalls ?? left.model_calls) + numeric(right.modelCalls ?? right.model_calls),
      costUSD: numeric(left.costUSD ?? left.costUsd) + numeric(right.costUSD ?? right.costUsd)
    };
  }
  return out;
}

/**
 * Sum two usage objects across turns. The verify-fix loop can invoke the agent
 * multiple times; reporting only the last call silently discarded earlier
 * tokens, cost, and modelCalls — which is how a multi-turn run under-reported
 * cost and hid the inference-call count the rate-card comparison needs.
 */
export function addUsage(a, b) {
  if (!b) {
    return a;
  }
  if (!a) {
    return { ...b };
  }
  const numeric = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const modelUsage = mergeModelUsage(a.modelUsage, b.modelUsage);
  const modelCallsFromMap = sumModelCalls(modelUsage);
  let modelCalls = modelCallsFromMap;
  if (modelCalls == null) {
    const left = a.modelCalls;
    const right = b.modelCalls;
    if (left != null || right != null) {
      modelCalls = numeric(left) + numeric(right);
    }
  }
  const resolvedModel = b.resolvedModel ?? a.resolvedModel ?? resolveModelFromUsage(modelUsage);
  return {
    inputTokens: numeric(a.inputTokens) + numeric(b.inputTokens),
    cachedInputTokens: numeric(a.cachedInputTokens) + numeric(b.cachedInputTokens),
    outputTokens: numeric(a.outputTokens) + numeric(b.outputTokens),
    reasoningTokens: numeric(a.reasoningTokens) + numeric(b.reasoningTokens),
    totalTokens: numeric(a.totalTokens) + numeric(b.totalTokens),
    costUsd: numeric(a.costUsd) + numeric(b.costUsd),
    numTurns: numeric(a.numTurns) + numeric(b.numTurns),
    // Summed modelCalls — do not take max or last-turn only (BRIDGE-5).
    ...(modelCalls != null ? { modelCalls } : {}),
    // Served model from the latest turn wins - provider can remap mid-run.
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(modelUsage ? { modelUsage } : {})
  };
}

export function normalizeUsage(event) {
  const usage = event?.usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const modelUsage =
    event?.modelUsage && typeof event.modelUsage === "object" && !Array.isArray(event.modelUsage)
      ? event.modelUsage
      : usage.modelUsage && typeof usage.modelUsage === "object" && !Array.isArray(usage.modelUsage)
        ? usage.modelUsage
        : null;
  const resolvedModel = resolveModelFromUsage(modelUsage);
  // Prefer an explicit top-level count, else sum the per-model breakdown.
  // modelCalls is the inference-call count the rate card alone cannot provide.
  const explicitCalls = usage.modelCalls ?? usage.model_calls ?? event?.modelCalls ?? event?.model_calls;
  const summedCalls = sumModelCalls(modelUsage);
  const modelCalls =
    explicitCalls != null && Number.isFinite(Number(explicitCalls))
      ? Number(explicitCalls)
      : summedCalls;
  return {
    inputTokens: toFiniteNumber(usage.input_tokens ?? usage.inputTokens),
    cachedInputTokens: toFiniteNumber(usage.cache_read_input_tokens ?? usage.cachedInputTokens),
    outputTokens: toFiniteNumber(usage.output_tokens ?? usage.outputTokens),
    reasoningTokens: toFiniteNumber(usage.reasoning_tokens ?? usage.reasoningTokens),
    totalTokens: toFiniteNumber(usage.total_tokens ?? usage.totalTokens),
    costUsd: Number.isFinite(Number(event.total_cost_usd ?? event.totalCostUsd ?? usage.costUsd))
      ? Number(event.total_cost_usd ?? event.totalCostUsd ?? usage.costUsd)
      : null,
    numTurns: Number.isFinite(Number(event.num_turns ?? event.numTurns ?? usage.numTurns))
      ? Number(event.num_turns ?? event.numTurns ?? usage.numTurns)
      : null,
    ...(modelCalls != null ? { modelCalls } : {}),
    ...(modelUsage ? { modelUsage } : {}),
    ...(resolvedModel ? { resolvedModel } : {})
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
  // null until the stream proves it speaks a tool vocabulary. A CLI that never
  // emits tool events would otherwise look like "zero tools" and mark every
  // healthy prose-only run completed-blind. Only a genuine 0 (signal present,
  // invocations absent, or an explicit end-event count) may be reported as 0.
  let toolVocabularySeen = false;
  let toolInvocationCount = 0;
  let explicitToolCallCount = null;

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
      } else if (type && isToolSignalType(type)) {
        // Tool traffic is recognized even when it is not prose: a tool-only
        // turn still proves the stream format is one we speak.
        recognizedEvents += 1;
        toolVocabularySeen = true;
        if (isToolInvocationType(type)) {
          toolInvocationCount += 1;
        }
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
          // Surface cumulative usage on the accept result so the progress path
          // can patch the live job record mid-run (nested budget inheritance).
          if (usage) {
            result.usage = usage;
          }
          const explicit = readExplicitToolCallCount(event);
          if (explicit != null) {
            // An explicit end-event count is the only way a run with no tool
            // events in the stream can still report a genuine 0 rather than
            // null - Hyper/Grok may start shipping this without per-call events.
            toolVocabularySeen = true;
            explicitToolCallCount = explicit;
          }
        } else if (type && type !== "thought" && !isToolSignalType(type)) {
          unknownTypes.add(type);
        }
      }

      lastType = type;
      return result;
    },

    finish() {
      closeCurrentMessage();
      const joined = messages.join(MESSAGE_SEPARATOR);
      // Explicit end-event count wins when present: it is the provider's own
      // total. Otherwise the live invocation count, but only once the stream
      // has shown it speaks tools at all.
      let toolCallCount = null;
      if (explicitToolCallCount != null) {
        toolCallCount = explicitToolCallCount;
      } else if (toolVocabularySeen) {
        toolCallCount = toolInvocationCount;
      }
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
        toolCallCount,
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
