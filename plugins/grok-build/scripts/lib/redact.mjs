// Key names that mark whatever follows them as a secret. `passwd` and
// `credential` are here for Godot export presets and CI configs, which use
// both spellings.
//
// `/` is allowed inside the key so a Godot preset key reads as ONE key:
// `keystore/release_password` and `notarization/apple_id_password` are the
// real spellings in export_presets.cfg. Without it the match would still fire
// (on the bare `password` tail), but the reported key name would be wrong.
// It can never run away: the class stops at the first character that is not a
// key character, and `=`/`:`/quote/space are all outside it.
const SECRET_KEY = "[A-Za-z0-9_/]*(?:token|secret|key|password|passwd|credential)";

// Value classes. These are the whole reason the assignment rule is split in
// two.
//
// QUOTED: the closing quote is the terminator, so the value may contain any
// punctuation at all. `keystore/release_password="P@ssw0rd!2024"` and
// `="Tr0ub4dor&3"` used to pass through BYTE-IDENTICAL under the narrow class
// below - exactly the passwords a user is most likely to have chosen. A value
// containing the *other* quote character (`"don't"`) is still missed; widening
// to `[^\n]` with a backreference terminator would let a single line's match
// run past several key/value pairs, which is the worse failure.
//
// UNQUOTED: deliberately NOT widened. With no closing quote the only
// terminator is the character class itself, so anything broader swallows the
// prose after the value - `token: abc123 was rejected by the server` would
// redact the sentence, not the token.
const QUOTED_SECRET_VALUE = `(["'])([^"'\\n]{8,})\\3`;
const UNQUOTED_SECRET_VALUE = `(["']?)([A-Za-z0-9._/+\\-]{8,})\\3`;

const SECRET_ASSIGNMENT_QUOTED = new RegExp(
  `\\b(${SECRET_KEY})\\b(\\s*[=:]\\s*)${QUOTED_SECRET_VALUE}`,
  "gi"
);
const SECRET_ASSIGNMENT_UNQUOTED = new RegExp(
  `\\b(${SECRET_KEY})\\b(\\s*[=:]\\s*)${UNQUOTED_SECRET_VALUE}`,
  "gi"
);
const SECRET_JSON_KEY_QUOTED = new RegExp(
  `"(${SECRET_KEY})"(\\s*:\\s*)${QUOTED_SECRET_VALUE}`,
  "gi"
);
const SECRET_JSON_KEY_UNQUOTED = new RegExp(
  `"(${SECRET_KEY})"(\\s*:\\s*)${UNQUOTED_SECRET_VALUE}`,
  "gi"
);

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
  // The key must END at the keyword (word boundary after the SECRET_KEY tail).
  // A trailing [A-Za-z0-9_]* used to let KeyError match as a "key…" assignment and
  // mangle Python tracebacks like KeyError: 'password' into KeyError: '[redacted]'.
  // The prefix remains optional so bare password= / token= still match.
  //
  // Quoted first: it is the stricter of the two (a quote is required on both
  // sides) and it accepts values the unquoted rule cannot express, so running
  // it first means the unquoted rule only ever sees what is genuinely bare.
  result = result.replace(
    SECRET_ASSIGNMENT_QUOTED,
    (_match, key, separator, quote) => `${key}${separator}${quote}[redacted]${quote}`
  );
  result = result.replace(
    SECRET_ASSIGNMENT_UNQUOTED,
    (_match, key, separator, quote) => `${key}${separator}${quote}[redacted]${quote}`
  );

  // JSON-style quoted keys: "apiKey": "value" / "api_key":"value". The bare-key
  // patterns above stop at the closing quote before the colon, so they never see
  // the assignment. Keep the key name and surrounding structure intact. Split
  // the same way and in the same order as the bare rules - if the two pairs
  // disagreed, whether a secret survived would depend on which syntax the tool
  // that printed it happened to use.
  result = result.replace(
    SECRET_JSON_KEY_QUOTED,
    (_match, key, separator, quote) => `"${key}"${separator}${quote}[redacted]${quote}`
  );
  result = result.replace(
    SECRET_JSON_KEY_UNQUOTED,
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