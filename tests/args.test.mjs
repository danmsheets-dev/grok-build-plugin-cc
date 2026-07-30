import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/grok-build/scripts/lib/args.mjs";

test("parseArgs handles value, boolean, and alias options", () => {
  const result = parseArgs(["--cwd", "/tmp", "--json", "-m", "model-x", "remaining"], {
    valueOptions: ["cwd", "model"],
    booleanOptions: ["json"],
    aliasMap: { m: "model" }
  });

  assert.deepEqual(result.options, {
    cwd: "/tmp",
    json: true,
    model: "model-x"
  });
  assert.deepEqual(result.positionals, ["remaining"]);
});

test("splitRawArgumentString respects quotes and escapes", () => {
  const tokens = splitRawArgumentString(`review --base main "focus on auth" keep\\ going`);
  assert.deepEqual(tokens, ["review", "--base", "main", "focus on auth", "keep going"]);
});

test("parseArgs throws when a value option is missing its value", () => {
  assert.throws(
    () =>
      parseArgs(["--model"], {
        valueOptions: ["model"]
      }),
    /Missing value for --model/
  );
});

test("parseArgs can warn on unknown long options without treating them as positionals", () => {
  const result = parseArgs(["--scpoe", "working-tree", "focus text"], {
    valueOptions: ["scope"],
    unknownMode: "warn"
  });
  assert.deepEqual(result.unknown, ["--scpoe"]);
  assert.deepEqual(result.positionals, ["working-tree", "focus text"]);
  assert.equal(result.options.scope, undefined);
});

test("splitRawArgumentString does not corrupt backslashes in a Windows path", () => {
  // Regression: every backslash was treated as an escape character
  // unconditionally, silently deleting every backslash in a path like
  // C:\Users\me\file.txt, mangling it to C:Usersmefile.txt. A delegate
  // prompt or --verify command mentioning a Windows path hit this on
  // every single invocation. String.raw is used throughout this test so
  // the JS parser never touches the backslashes under test.
  const input = "fix the bug in " + String.raw`C:\Users\me\project\file.txt`;
  const tokens = splitRawArgumentString(input);
  assert.deepEqual(tokens, [
    "fix",
    "the",
    "bug",
    "in",
    String.raw`C:\Users\me\project\file.txt`
  ]);
});

test("splitRawArgumentString still supports backslash-space and backslash-quote escapes", () => {
  assert.deepEqual(splitRawArgumentString(String.raw`keep\ going`), ["keep going"]);
  assert.deepEqual(
    splitRawArgumentString(String.raw`say \"hi\" there`),
    ["say", '"hi"', "there"]
  );
});

test("splitRawArgumentString leaves a trailing lone backslash literal", () => {
  // "\\" is JS's own recognized escape for a single literal backslash - unlike
  // "\U" or "\f" this one is never dropped, so a plain string literal is safe.
  assert.deepEqual(splitRawArgumentString("weird\\"), ["weird\\"]);
});

test("parseArgs accumulates a repeatable option across multiple occurrences", () => {
  // Regression: --verify "cargo test" --verify "cargo clippy" silently kept
  // only the last value. Every earlier --verify command was dropped with
  // no warning at all.
  const result = parseArgs(["--verify", "cargo test", "--verify", "cargo clippy"], {
    valueOptions: ["verify"],
    repeatableOptions: ["verify"]
  });
  assert.deepEqual(result.options.verify, ["cargo test", "cargo clippy"]);
});

test("parseArgs still overwrites a non-repeatable value option on repeat", () => {
  const result = parseArgs(["--model", "a", "--model", "b"], {
    valueOptions: ["model"]
  });
  assert.equal(result.options.model, "b");
});

test("parseArgs keeps a single occurrence of a repeatable option as an array", () => {
  const result = parseArgs(["--verify", "cargo test"], {
    valueOptions: ["verify"],
    repeatableOptions: ["verify"]
  });
  assert.deepEqual(result.options.verify, ["cargo test"]);
});

test("splitRawArgumentString correctly closes a quote after a trailing path backslash", () => {
  // Regression found by a second-round audit of the earlier backslash fix:
  // a quoted Windows path ending in a backslash (--cwd "C:\repo\", exactly
  // what Explorer's address bar shows) had its closing quote treated as an
  // ESCAPED quote instead of the closing delimiter, so the parser kept
  // consuming everything after it - including a following --verify flag -
  // into one corrupted token.
  //
  // Note: a plain double-quoted JS string is used for the expected path
  // rather than a template literal, because a template literal ending in a
  // single trailing backslash escapes its own closing backtick and fails
  // to parse. "\\" (double backslash) is required for each literal
  // backslash - a single "\r" here would be a carriage return, not "r".
  const tokens = splitRawArgumentString('--cwd "C:\\repo\\" --verify "npm test"');
  assert.deepEqual(tokens, ["--cwd", "C:\\repo\\", "--verify", "npm test"]);
});

test("splitRawArgumentString closes a quote whose content ends in a backslash with nothing after it", () => {
  const tokens = splitRawArgumentString('--cwd "C:\\repo\\"');
  assert.deepEqual(tokens, ["--cwd", "C:\\repo\\"]);
});

test("the run command's real option table accepts the verify timing flags", async () => {
  // Parsed through the EXACT array handleTask uses, not a copy: a flag that is
  // documented but missing from that table is silently swallowed as a
  // positional and folded into the agent's prompt, which is how a value flag
  // fails least visibly.
  const { TASK_VALUE_OPTIONS } = await import(
    "../plugins/grok-build/scripts/grok-bridge.mjs"
  );

  const result = parseArgs(
    [
      "--verify-timeout",
      "1800",
      "--baseline-timeout",
      "1200",
      "--verify-max-buffer",
      "32",
      "fix the importer"
    ],
    { valueOptions: [...TASK_VALUE_OPTIONS], repeatableOptions: ["verify"] }
  );

  assert.equal(result.options["verify-timeout"], "1800");
  assert.equal(result.options["baseline-timeout"], "1200");
  assert.equal(result.options["verify-max-buffer"], "32");
  assert.deepEqual(result.positionals, ["fix the importer"]);
});
