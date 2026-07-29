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
      return {
        messages: [...messages],
        finalMessage: messages.join(MESSAGE_SEPARATOR),
        sessionId,
        stopReason,
        usage,
        unknownTypes: [...unknownTypes]
      };
    }
  };
}
