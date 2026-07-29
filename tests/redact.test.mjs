import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { redactSecrets, redactSecretsDeep } from "../plugins/grok-build/scripts/lib/redact.mjs";
import {
  appendLogLine,
  runTrackedJob
} from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import {
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
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

test("JSON-style quoted keys are redacted", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";
  const input = `{"apiKey": "${secret}"}`;
  const output = redactSecrets(input);
  assert.ok(output.includes("[redacted]"), `expected redacted marker, got: ${output}`);
  assert.ok(!output.includes(secret), `raw secret leaked: ${output}`);
  assert.ok(output.includes('"apiKey"'), `key name should survive: ${output}`);
  assert.ok(output.startsWith("{") && output.endsWith("}"), `JSON braces should survive: ${output}`);
});

test("JSON quoted keys without sk- prefix are redacted by assignment pattern", () => {
  const secret = "abcdefghijklmnop";
  const input = `{"api_key":"${secret}"}`;
  const output = redactSecrets(input);
  assert.ok(output.includes("[redacted]"), `expected redacted marker, got: ${output}`);
  assert.ok(!output.includes(secret), `raw secret leaked: ${output}`);
  assert.ok(output.includes('"api_key"'), `key name should survive: ${output}`);
});

test("Python KeyError diagnostics are not corrupted", () => {
  // Regression: KeyError used to match the assignment pattern because "key" is a
  // prefix of KeyError, turning KeyError: 'password' into KeyError: '[redacted]'.
  const cases = [
    "KeyError: 'password'",
    'KeyError: "secret_token"',
    "raise KeyError('password')",
    'raise KeyError("secret_token")',
    `Traceback (most recent call last):\n  File "app.py", line 42, in get_user\n    raise KeyError("password")\nKeyError: 'password'`
  ];
  for (const input of cases) {
    const output = redactSecrets(input);
    assert.strictEqual(output, input, `diagnostic corrupted:\n  in:  ${input}\n  out: ${output}`);
  }
});

test("runTrackedJob redacts secrets in result before writing the job file", async () => {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    const workspace = makeTempDir();
    const jobId = "job-redact-result";
    const secret = "xai-abcdefghijklmnopqrstuvwxyz123456";
    const running = {
      id: jobId,
      status: "queued",
      phase: "queued",
      title: "Redact result",
      kind: "run",
      workspaceRoot: workspace
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const execution = await runTrackedJob(
      { ...running, workspaceRoot: workspace },
      async () => ({
        exitStatus: 0,
        threadId: "thread-1",
        turnId: "turn-1",
        summary: `done with ${secret}`,
        payload: { status: "completed", rawOutput: `output has ${secret}`, summary: secret },
        rendered: `rendered ${secret}\n`,
        verify: { output: `verify saw ${secret}` }
      }),
      { startHeartbeatImpl: () => () => {} }
    );

    assert.ok(!JSON.stringify(execution.payload).includes(secret), "returned payload leaked secret");
    assert.ok(!String(execution.summary).includes(secret), "returned summary leaked secret");
    assert.ok(!String(execution.rendered).includes(secret), "returned rendered leaked secret");
    assert.ok(JSON.stringify(execution.payload).includes("[redacted]"), "returned payload not redacted");

    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.id, jobId, "job id must stay literal");
    assert.equal(stored.status, "completed", "status must stay literal");
    assert.equal(stored.threadId, "thread-1", "threadId must stay literal");
    const disk = JSON.stringify(stored);
    assert.ok(!disk.includes(secret), `raw secret leaked to job JSON: ${disk}`);
    assert.ok(disk.includes("[redacted]"), `expected redacted marker on disk: ${disk}`);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
