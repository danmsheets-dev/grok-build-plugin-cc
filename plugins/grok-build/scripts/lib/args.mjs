export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  // A value option named here accumulates every occurrence into an array
  // instead of the default last-wins overwrite. Without this, --verify "cargo
  // test" --verify "cargo clippy" silently kept only "cargo clippy" - every
  // earlier --verify value was dropped with no warning.
  const repeatableOptions = new Set(config.repeatableOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const unknownMode = config.unknownMode ?? "positional";
  const options = {};
  const positionals = [];
  const unknown = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        if (repeatableOptions.has(key)) {
          options[key] = Array.isArray(options[key]) ? [...options[key], nextValue] : [nextValue];
        } else {
          options[key] = nextValue;
        }
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      if (unknownMode === "error") {
        throw new Error(`Unknown option --${rawKey}`);
      }
      if (unknownMode === "warn") {
        unknown.push(token);
        continue;
      }
      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      if (repeatableOptions.has(key)) {
        options[key] = Array.isArray(options[key]) ? [...options[key], nextValue] : [nextValue];
      } else {
        options[key] = nextValue;
      }
      index += 1;
      continue;
    }

    if (unknownMode === "error") {
      throw new Error(`Unknown option -${shortKey}`);
    }
    if (unknownMode === "warn") {
      unknown.push(token);
      continue;
    }
    positionals.push(token);
  }

  return { options, positionals, unknown };
}

const ESCAPABLE_NEXT = /[\s'"\\]/;

export function splitRawArgumentString(raw) {
  const tokens = [];
  const chars = Array.from(raw);
  let current = "";
  let quote = null;

  for (let index = 0; index < chars.length; index += 1) {
    const character = chars[index];

    // Backslash only escapes whitespace, a quote, or another backslash - the
    // minimal set this parser actually needs (embedding a space in an
    // unquoted token, or a literal quote/backslash inside one). Treating
    // EVERY backslash as an escape character, as this used to do
    // unconditionally, silently deleted every backslash in a Windows path
    // passed through a delegate prompt or --verify command:
    // C:\Users\me\file.txt became C:Usersmefile.txt.
    //
    // Excludes one case: a backslash immediately followed by the CURRENTLY
    // OPEN quote character. A quoted Windows path ending in a backslash
    // (--cwd "C:\repo\", the trailing backslash is what Explorer's address
    // bar always shows) has that backslash-quote pair right where the
    // string is meant to close. Treating it as an escape instead swallowed
    // the closing quote, so the parser kept consuming every token after it
    // - including a following --verify flag - into one corrupted value.
    // This does mean \" can no longer embed a literal quote of the SAME
    // type the string is already using; wrap in the OTHER quote character
    // for that (a single-quoted string can embed a literal " freely).
    const next = chars[index + 1];
    const escapingOwnClosingQuote = Boolean(quote) && next === quote;
    if (character === "\\" && next !== undefined && ESCAPABLE_NEXT.test(next) && !escapingOwnClosingQuote) {
      current += next;
      index += 1;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
