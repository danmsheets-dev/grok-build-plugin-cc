function redactSecrets(text) {
  const str = String(text ?? "");
  if (str === "") return "";

  let result = str;

  result = result.replace(/xai-[A-Za-z0-9_-]{20,}/g, "[redacted]");

  result = result.replace(/nvapi-[A-Za-z0-9_-]{20,}/g, "[redacted]");

  result = result.replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted]");

  result = result.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]");

  result = result.replace(/(?<=Bearer\s)[A-Za-z0-9._-]{20,}/gi, "[redacted]");

  // Capture the separator and quote explicitly rather than reconstructing the key
  // by length arithmetic. An earlier version inferred quoting with
  // match.includes('"'), which misreads any line that happens to contain a quote
  // elsewhere, such as: Authorization: Bearer abc" trailing
  //
  // The key must END at the keyword (word boundary after token/secret/key/password).
  // A trailing [A-Za-z0-9_]* used to let KeyError match as a "key…" assignment and
  // mangle Python tracebacks like KeyError: 'password' into KeyError: '[redacted]'.
  // The prefix remains optional so bare password= / token= still match.
  result = result.replace(
    /\b([A-Za-z0-9_]*(?:token|secret|key|password))\b(\s*[=:]\s*)(["']?)([A-Za-z0-9._/+\-]{8,})\3/gi,
    (_match, key, separator, quote) => `${key}${separator}${quote}[redacted]${quote}`
  );

  // JSON-style quoted keys: "apiKey": "value" / "api_key":"value". The bare-key
  // pattern above stops at the closing quote before the colon, so it never sees
  // the assignment. Keep the key name and surrounding structure intact.
  result = result.replace(
    /"([A-Za-z0-9_]*(?:token|secret|key|password))"(\s*:\s*)(["']?)([A-Za-z0-9._/+\-]{8,})\3/gi,
    (_match, key, separator, quote) => `"${key}"${separator}${quote}[redacted]${quote}`
  );

  return result;
}

function redactSecretsDeep(value) {
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactSecretsDeep);
  }
  if (value !== null && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) {
      result[key] = redactSecretsDeep(value[key]);
    }
    return result;
  }
  return value;
}

export { redactSecrets, redactSecretsDeep };