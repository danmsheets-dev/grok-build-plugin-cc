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
