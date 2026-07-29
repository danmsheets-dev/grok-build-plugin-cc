import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { redactSecrets, redactSecretsDeep } from "../plugins/grok-build/scripts/lib/redact.mjs";
import { appendLogLine } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import { makeTempDir } from "./helpers.mjs";

const xaiSecret = "xai-abcdefghijklmnopqrstuvwxyz123456";
const nvidiaSecret = "nvapi-abcdefghijklmnopqrstuvwxyz123456";
const openaiSecret = "sk-abcdefghijklmnopqrstuvwxyz123456";
const githubSecret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
const bearerSecret = "Bearer abcdefghijklmnopqrstuvwxyz123456";
const assignmentSecret = "API_TOKEN=abcdefghijklmnop";

test("pattern 1: xAI keys are redacted", () => {
  const result = redactSecrets(xaiSecret);
  assert.ok(result.includes("[redacted]"), "should contain [redacted]");
  assert.ok(!result.includes(xaiSecret), "should not contain the secret");
});

test("pattern 2: NVIDIA keys are redacted", () => {
  const result = redactSecrets(nvidiaSecret);
  assert.ok(result.includes("[redacted]"), "should contain [redacted]");
  assert.ok(!result.includes(nvidiaSecret), "should not contain the secret");
});

test("pattern 3: OpenAI-style keys are redacted", () => {
  const result = redactSecrets(openaiSecret);
  assert.ok(result.includes("[redacted]"), "should contain [redacted]");
  assert.ok(!result.includes(openaiSecret), "should not contain the secret");
});

test("pattern 4: GitHub tokens are redacted", () => {
  const result = redactSecrets(githubSecret);
  assert.ok(result.includes("[redacted]"), "should contain [redacted]");
  assert.ok(!result.includes(githubSecret), "should not contain the secret");
});

test("pattern 5: Bearer tokens are redacted", () => {
  const result = redactSecrets(bearerSecret);
  assert.ok(result.includes("[redacted]"), "should contain [redacted]");
  assert.ok(!result.includes("abcdefghijklmnopqrstuvwxyz123456"), "should not contain the token value");
  assert.ok(result.includes("Bearer"), "should still contain 'Bearer'");
});

test("pattern 6: assignments are redacted", () => {
  const result = redactSecrets(assignmentSecret);
  assert.ok(result.includes("[redacted]"), "should contain [redacted]");
  assert.ok(!result.includes("abcdefghijklmnop"), "should not contain the secret value");
  assert.ok(result.includes("API_TOKEN"), "should still contain API_TOKEN");
});

test("ordinary text is untouched", () => {
  const input = "just a normal sentence with no secrets";
  const result = redactSecrets(input);
  assert.strictEqual(result, input);
});

test("empty and nullish input returns empty string", () => {
  assert.strictEqual(redactSecrets(""), "");
  assert.strictEqual(redactSecrets(null), "");
  assert.strictEqual(redactSecrets(undefined), "");
});

test("redactSecretsDeep handles nested structure", () => {
  const input = {
    a: "xai-abcdefghijklmnopqrstuvwxyz123456",
    b: ["nvapi-abcdefghijklmnopqrstuvwxyz123456", 42],
    c: { d: true, e: "safe text" }
  };
  const result = redactSecretsDeep(input);
  
  assert.ok(result.a.includes("[redacted]"), "xai secret should be redacted");
  assert.ok(!result.a.includes("xai-abcdefghijklmnopqrstuvwxyz123456"), "xai secret should not appear");
  
  assert.ok(result.b[0].includes("[redacted]"), "nvidia secret should be redacted");
  assert.ok(!result.b[0].includes("nvapi-abcdefghijklmnopqrstuvwxyz123456"), "nvidia secret should not appear");
  
  assert.strictEqual(result.b[1], 42, "number 42 should survive unchanged");
  assert.strictEqual(result.c.d, true, "boolean true should survive unchanged");
  assert.strictEqual(result.c.e, "safe text", "safe text should survive unchanged");
});

test("redactSecretsDeep does not mutate input", () => {
  const input = {
    a: "xai-abcdefghijklmnopqrstuvwxyz123456",
    b: ["nvapi-abcdefghijklmnopqrstuvwxyz123456", 42],
    c: { d: true, e: "safe text" }
  };
  const originalCopy = structuredClone(input);
  redactSecretsDeep(input);
  assert.deepStrictEqual(input, originalCopy, "original input should not be mutated");
});
test("bare keyword assignments are redacted, not just prefixed ones", () => {
  // Regression: the key pattern once required a leading character, so API_TOKEN=
  // matched but a bare password= did not — the most common form of all.
  for (const key of ["password", "token", "secret", "key"]) {
    const line = `${key}='abcdefghijklmnop'`;
    const output = redactSecrets(line);
    assert.match(output, /\[redacted\]/, `${key} should be redacted, got: ${output}`);
    assert.doesNotMatch(output, /abcdefghijklmnop/, `${key} value leaked: ${output}`);
    assert.ok(output.includes(key), `${key} name should survive: ${output}`);
  }
});

test("a quote elsewhere on the line does not corrupt the redaction", () => {
  const output = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" trailing');
  assert.match(output, /Bearer \[redacted\]" trailing/);
});

test("appendLogLine redacts secrets before writing to disk", () => {
  const dir = makeTempDir();
  const file = path.join(dir, "run.log");
  const secret = "xai-abcdefghijklmnopqrstuvwxyz123456";
  appendLogLine(file, `key is ${secret}`);
  const written = fs.readFileSync(file, "utf8");
  assert.ok(written.includes("[redacted]"), `expected redacted marker, got: ${written}`);
  assert.ok(!written.includes(secret), `raw secret leaked to log: ${written}`);
});
