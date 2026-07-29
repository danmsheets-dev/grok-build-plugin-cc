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
