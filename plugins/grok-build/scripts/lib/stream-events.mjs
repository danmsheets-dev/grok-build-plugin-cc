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
    const leftCost = left.costUSD ?? left.costUsd;
    const rightCost = right.costUSD ?? right.costUsd;
    const hasCost =
      (leftCost != null && Number.isFinite(Number(leftCost))) ||
      (rightCost != null && Number.isFinite(Number(rightCost)));
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
      // Preserve null cost when neither side reported one (absence ≠ free).
      ...(hasCost
        ? {
            costUSD:
              (leftCost != null && Number.isFinite(Number(leftCost)) ? Number(leftCost) : 0) +
              (rightCost != null && Number.isFinite(Number(rightCost)) ? Number(rightCost) : 0)
          }
        : { costUSD: null })
    };
  }
  return out;
}

function finiteOrNull(value) {
  if (value == null) {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive a display cost from integer ticks when present (avoids float drift).
 * Hyper emits total_cost_usd_ticks as micro-dollars × 100? — treat as 1e6 ticks
 * per dollar when the float is absent; when both exist prefer ticks/1e6 only if
 * the float is missing, else keep the float Hyper already computed.
 */
export function costUsdFromTicks(ticks) {
  const n = finiteOrNull(ticks);
  if (n == null) {
    return null;
  }
  return n / 1_000_000;
}

/**
 * Sum two usage objects across turns. The verify-fix loop can invoke the agent
 * multiple times; reporting only the last call silently discarded earlier
 * tokens, cost, and modelCalls — which is how a multi-turn run under-reported
 * cost and hid the inference-call count the rate-card comparison needs.
 *
 * Cost integrity: null + null stays null (unknown is not free). When some turns
 * report a number and others withhold it, costIsPartial is set. Flags OR across
 * turns. Prefer costUsdTicks for accumulation when present.
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

  const leftTicks = finiteOrNull(a.costUsdTicks);
  const rightTicks = finiteOrNull(b.costUsdTicks);
  let costUsdTicks = null;
  if (leftTicks != null || rightTicks != null) {
    costUsdTicks = (leftTicks ?? 0) + (rightTicks ?? 0);
  }

  const leftCost = finiteOrNull(a.costUsd);
  const rightCost = finiteOrNull(b.costUsd);
  let costUsd = null;
  let mixedCostReporting = false;
  if (leftCost != null && rightCost != null) {
    costUsd = leftCost + rightCost;
  } else if (leftCost != null || rightCost != null) {
    // One turn reported cost and the other withheld it.
    costUsd = (leftCost ?? 0) + (rightCost ?? 0);
    mixedCostReporting = true;
  } else if (costUsdTicks != null) {
    costUsd = costUsdFromTicks(costUsdTicks);
  }

  const usageIsIncomplete = Boolean(a.usageIsIncomplete || b.usageIsIncomplete);
  const costIsPartial = Boolean(a.costIsPartial || b.costIsPartial || mixedCostReporting);

  return {
    inputTokens: numeric(a.inputTokens) + numeric(b.inputTokens),
    cachedInputTokens: numeric(a.cachedInputTokens) + numeric(b.cachedInputTokens),
    outputTokens: numeric(a.outputTokens) + numeric(b.outputTokens),
    reasoningTokens: numeric(a.reasoningTokens) + numeric(b.reasoningTokens),
    totalTokens: numeric(a.totalTokens) + numeric(b.totalTokens),
    // null when every contributing turn withheld cost — never coerce to 0.
    costUsd,
    ...(costUsdTicks != null ? { costUsdTicks } : {}),
    numTurns: numeric(a.numTurns) + numeric(b.numTurns),
    usageIsIncomplete,
    costIsPartial,
    // Summed modelCalls — do not take max or last-turn only (BRIDGE-5).
    ...(modelCalls != null ? { modelCalls } : {}),
    // Served model from the latest turn wins - provider can remap mid-run.
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(modelUsage ? { modelUsage } : {})
  };
}

function readBoolFlag(...candidates) {
  for (const value of candidates) {
    if (value === true || value === 1 || value === "true" || value === "1") {
      return true;
    }
    if (value === false || value === 0 || value === "false" || value === "0") {
      return false;
    }
  }
  return null;
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

  // Hyper withholds total_cost_usd when untrustworthy and sets these flags.
  // Absence of a cost must not look free (notification.rs fail-closed attach).
  const usageIsIncomplete =
    readBoolFlag(
      event?.usage_is_incomplete,
      event?.usageIsIncomplete,
      usage.usage_is_incomplete,
      usage.usageIsIncomplete
    ) === true;
  const costIsPartial =
    readBoolFlag(
      event?.cost_is_partial,
      event?.costIsPartial,
      usage.cost_is_partial,
      usage.costIsPartial
    ) === true;

  const ticksRaw =
    event?.total_cost_usd_ticks ??
    event?.totalCostUsdTicks ??
    usage.total_cost_usd_ticks ??
    usage.costUsdTicks ??
    usage.cost_usd_ticks;
  const costUsdTicks = finiteOrNull(ticksRaw);

  // When Hyper hides costs (partial/incomplete), do not invent a float from
  // stale fields — keep costUsd null so renderers say "unavailable".
  const hideCost = usageIsIncomplete || costIsPartial;
  let costUsd = null;
  if (!hideCost) {
    const floatCost = event.total_cost_usd ?? event.totalCostUsd ?? usage.costUsd ?? usage.total_cost_usd;
    if (Number.isFinite(Number(floatCost))) {
      costUsd = Number(floatCost);
    } else if (costUsdTicks != null) {
      costUsd = costUsdFromTicks(costUsdTicks);
    }
  }

  return {
    inputTokens: toFiniteNumber(usage.input_tokens ?? usage.inputTokens),
    cachedInputTokens: toFiniteNumber(usage.cache_read_input_tokens ?? usage.cachedInputTokens),
    outputTokens: toFiniteNumber(usage.output_tokens ?? usage.outputTokens),
    reasoningTokens: toFiniteNumber(usage.reasoning_tokens ?? usage.reasoningTokens),
    totalTokens: toFiniteNumber(usage.total_tokens ?? usage.totalTokens),
    costUsd,
    ...(costUsdTicks != null ? { costUsdTicks } : {}),
    usageIsIncomplete,
    costIsPartial,
    numTurns: Number.isFinite(Number(event.num_turns ?? event.numTurns ?? usage.numTurns))
      ? Number(event.num_turns ?? event.numTurns ?? usage.numTurns)
      : null,
    ...(modelCalls != null ? { modelCalls } : {}),
    ...(modelUsage ? { modelUsage } : {}),
    ...(resolvedModel ? { resolvedModel } : {})
  };
}

/**
 * Hyper streaming-json event types the bridge explicitly understands.
 * Anything else is counted in unknownTypes so vocabulary drift is visible.
 * Source: Hyper headless emitter + confine_violation from tools/resources.
 */
export const HYPER_STREAM_EVENT_TYPES = Object.freeze([
  "start",
  "text",
  "thought",
  "tool_denied",
  "auto_continue",
  "model_resolved",
  "end",
  "error",
  "max_turns_reached",
  "auto_compact_started",
  "auto_compact_completed",
  "auto_compact_failed",
  "auto_compact_cancelled",
  "auto_continue_completed",
  "image_compressed",
  "confine_violation"
]);

const HYPER_STREAM_EVENT_SET = new Set(HYPER_STREAM_EVENT_TYPES);

/**
 * Whether a stream type is part of the Hyper vocabulary or a known tool signal.
 * Used so genuinely new names still land in unknownTypes.
 */
export function isKnownStreamEventType(type) {
  const raw = String(type ?? "").trim();
  if (!raw) {
    return false;
  }
  if (HYPER_STREAM_EVENT_SET.has(raw)) {
    return true;
  }
  // Historical / future tool shapes already accepted by the count path.
  return isToolSignalType(raw);
}

/**
 * How the bridge learned about tool calls for this run.
 * - observed: per-call tool events were on the stream
 * - explicit: end event carried toolCallCount / toolCalls
 * - unavailable: stream carries no tool vocabulary (Hyper today) — not the same as 0
 */
export function describeToolVisibility(toolCallCount, options = {}) {
  if (options.toolVocabularySeen || options.explicitToolCallCount != null) {
    if (options.explicitToolCallCount != null) {
      return "explicit";
    }
    return "observed";
  }
  if (toolCallCount == null) {
    return "unavailable";
  }
  return "observed";
}

/**
 * Accumulates a grok streaming-json transcript.
 * Turn boundary rule: a `text` event arriving after a non-`text` event starts a new message.
 *
 * Handles the full Hyper event vocabulary (see HYPER_STREAM_EVENT_TYPES). Unknown
 * types are counted, never silently dropped — vocabulary drift must be visible.
 */
export function createStreamTranscript() {
  const messages = [];
  const unknownTypes = new Set();
  const errors = [];
  const confineViolations = [];
  const toolDenials = [];
  const compaction = [];
  const toolActivity = [];
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
  // null until the stream proves it speaks a tool *invocation* vocabulary.
  // tool_denied alone is a signal Hyper emits without per-call events, and
  // must not convert "unknown" into a genuine 0 (completed-blind).
  let toolVocabularySeen = false;
  let toolInvocationCount = 0;
  let explicitToolCallCount = null;
  let maxTurnsReached = false;
  let startMeta = null;
  let modelResolved = null;
  let filesChanged = null;
  let autoContinueCount = 0;
  let streamSchemaVersion = null;

  function closeCurrentMessage() {
    const completed = current.trim();
    current = "";
    if (!completed) {
      return null;
    }
    messages.push(completed);
    return completed;
  }

  function markRecognized() {
    recognizedEvents += 1;
  }

  function acceptStart(event, result) {
    markRecognized();
    startMeta = {
      schemaVersion: event.schemaVersion ?? event.schema_version ?? null,
      confineRoot: event.confineRoot ?? event.confine_root ?? null,
      servedModel: event.servedModel ?? event.served_model ?? event.model ?? null,
      permissionMode: event.permissionMode ?? event.permission_mode ?? null,
      sandbox: event.sandbox ?? null,
      alwaysApprove: event.alwaysApprove ?? event.always_approve ?? null,
      binary: event.binary ?? null,
      version: event.version ?? null
    };
    if (startMeta.schemaVersion != null) {
      streamSchemaVersion = startMeta.schemaVersion;
    }
    if (startMeta.servedModel) {
      modelResolved = startMeta.servedModel;
    }
    result.phase = "starting";
    result.start = startMeta;
  }

  function acceptEnd(event, result) {
    markRecognized();
    sessionId = typeof event.sessionId === "string" ? event.sessionId : sessionId;
    stopReason = typeof event.stopReason === "string" ? event.stopReason : stopReason;
    if (event.schemaVersion != null) {
      streamSchemaVersion = event.schemaVersion;
    }
    usage = normalizeUsage(event) ?? usage;
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
    // Agent-reported filesChanged on the end event (Hyper: filesChanged.count).
    const fc = event.filesChanged ?? event.files_changed;
    if (fc && typeof fc === "object") {
      const count = finiteOrNull(fc.count ?? fc.total);
      const paths = Array.isArray(fc.paths)
        ? fc.paths.map(String)
        : Array.isArray(fc.entries)
          ? fc.entries.map((e) => (typeof e === "string" ? e : e?.path)).filter(Boolean)
          : [];
      filesChanged = {
        count: count ?? paths.length,
        paths,
        truncated: Boolean(fc.truncated)
      };
      result.filesChanged = filesChanged;
    }
  }

  function acceptError(event) {
    markRecognized();
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : event.error && typeof event.error === "object" && typeof event.error.message === "string"
            ? event.error.message
            : JSON.stringify(event.message ?? event.error ?? event);
    errors.push({
      message: String(message ?? "unknown error"),
      code: event.code ?? event.errorCode ?? null
    });
  }

  function acceptConfineViolation(event) {
    markRecognized();
    confineViolations.push({
      tool: event.tool ?? event.toolName ?? null,
      path: event.path ?? null,
      resolvedPath: event.resolvedPath ?? event.resolved_path ?? null,
      root: event.root ?? event.confineRoot ?? null
    });
  }

  function acceptToolDenied(event) {
    markRecognized();
    // Denial proves the stream speaks tools, but is not an invocation success.
    // Do not set toolVocabularySeen here — that would report toolCallCount=0
    // for every Hyper run that only ever denied (or never emitted calls).
    toolDenials.push({
      tool: event.tool ?? event.name ?? event.toolName ?? null,
      reason: event.reason ?? event.message ?? null
    });
  }

  function acceptCompaction(event, type) {
    markRecognized();
    const kind = type.replace(/^auto_compact_/, "");
    compaction.push({
      phase: kind,
      type,
      message: typeof event.message === "string" ? event.message : null
    });
  }

  function acceptToolInvocation(event, type) {
    markRecognized();
    toolVocabularySeen = true;
    if (isToolInvocationType(type)) {
      toolInvocationCount += 1;
      toolActivity.push({
        id: event.id ?? event.toolCallId ?? null,
        name: event.name ?? event.tool ?? event.title ?? null,
        kind: event.kind ?? null,
        title: event.title ?? null,
        type
      });
    }
  }

  return {
    accept(event) {
      const type = typeof event?.type === "string" ? event.type : "";
      const result = { phase: PHASE_BY_TYPE[type] ?? null, textDelta: "", messageCompleted: null };

      if (type === "text") {
        markRecognized();
        if (lastType !== "text") {
          result.messageCompleted = closeCurrentMessage();
        }
        const delta = String(event.data ?? "");
        current += delta;
        result.textDelta = delta;
        lastType = type;
        return result;
      }

      // Non-text events close the current message (turn boundary).
      result.messageCompleted = closeCurrentMessage();

      switch (type) {
        case "thought":
          markRecognized();
          break;
        case "start":
          acceptStart(event, result);
          break;
        case "end":
          acceptEnd(event, result);
          break;
        case "error":
          acceptError(event);
          result.phase = "error";
          break;
        case "confine_violation":
          acceptConfineViolation(event);
          result.phase = "confine_violation";
          break;
        case "tool_denied":
          acceptToolDenied(event);
          break;
        case "max_turns_reached":
          markRecognized();
          maxTurnsReached = true;
          if (typeof event.stopReason === "string") {
            stopReason = event.stopReason;
          } else if (!stopReason) {
            stopReason = "max_turns_reached";
          }
          break;
        case "auto_continue":
        case "auto_continue_completed":
          markRecognized();
          autoContinueCount += 1;
          break;
        case "model_resolved":
          markRecognized();
          modelResolved =
            event.servedModel ?? event.served_model ?? event.model ?? event.modelId ?? modelResolved;
          result.modelResolved = modelResolved;
          break;
        case "auto_compact_started":
        case "auto_compact_completed":
        case "auto_compact_failed":
        case "auto_compact_cancelled":
          acceptCompaction(event, type);
          break;
        case "image_compressed":
          markRecognized();
          break;
        default: {
          if (type && isToolSignalType(type)) {
            acceptToolInvocation(event, type);
          } else if (type && !isKnownStreamEventType(type)) {
            // Genuinely unknown — surface so vocabulary drift is never silent.
            unknownTypes.add(type);
          } else if (type) {
            markRecognized();
          }
          break;
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
      // has shown it speaks tool invocations at all.
      let toolCallCount = null;
      if (explicitToolCallCount != null) {
        toolCallCount = explicitToolCallCount;
      } else if (toolVocabularySeen) {
        toolCallCount = toolInvocationCount;
      }
      // Floor from end.filesChanged when the stream still reports no tool count:
      // an agent that edited N files made at least N tool calls. Display-only
      // floor — do not invent a precise count for completed-blind.
      let toolCallCountFloor = null;
      if (toolCallCount == null && filesChanged?.count != null && filesChanged.count > 0) {
        toolCallCountFloor = filesChanged.count;
      }

      const toolVisibility = describeToolVisibility(toolCallCount, {
        toolVocabularySeen,
        explicitToolCallCount
      });

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
        toolCallCountFloor,
        toolVisibility,
        toolActivity: [...toolActivity],
        unknownTypes: [...unknownTypes],
        errors: [...errors],
        confineViolations: [...confineViolations],
        toolDenials: [...toolDenials],
        compaction: [...compaction],
        maxTurnsReached,
        start: startMeta,
        modelResolved,
        filesChanged,
        autoContinueCount,
        streamSchemaVersion,
        // Zero means the CLI emitted a stream this parser understood nothing
        // of - a renamed event vocabulary, or not NDJSON at all. Callers use it
        // to decide whether the transcript above is empty because the run was
        // quiet, or because it was never read.
        recognizedEvents
      };
    }
  };
}
