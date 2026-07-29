import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run } from "./helpers.mjs";
import {
  buildReviewPrompt,
  getGrokAuthStatus,
  getGrokAvailability,
  parseStructuredOutput,
  resolveGrokBinary,
  runHeadlessAgent,
  runImport
} from "../plugins/grok-build/scripts/lib/grok.mjs";
import { runCommand } from "../plugins/grok-build/scripts/lib/process.mjs";

test("resolveGrokBinary prefers GROK_BINARY override", () => {
  assert.equal(resolveGrokBinary({ GROK_BINARY: "/custom/grok" }), "/custom/grok");
  assert.equal(resolveGrokBinary({}), "grok");
});

test("getGrokAvailability reports available with fake grok on PATH", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const status = getGrokAvailability(process.cwd(), { env });
  assert.equal(status.available, true);
  assert.match(status.detail, /0\.2\.83-fake|ok/i);
});

test("getGrokAuthStatus uses models probe success as logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.source, "models-probe");
});

test("getGrokAuthStatus treats failed models as not logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "not-logged-in");
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, false);
  assert.match(auth.detail, /Not logged in|not logged in|failed/i);
});

test("runHeadlessAgent captures stdout and session id from fake grok", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "check the thing",
    env,
    permissionMode: "plan",
    sandbox: "read-only"
  });

  assert.equal(result.status, 0);
  assert.match(result.finalMessage, /Handled the requested task/);
  assert.equal(typeof result.threadId, "string");
  assert.ok(result.threadId.length > 0);
  assert.ok(result.args.includes("-p"));
  assert.ok(result.args.includes("--permission-mode"));
  assert.ok(result.args.includes("plan"));
});

test("runImport parses session id from fake grok json output", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const sourcePath = path.join(makeTempDir(), "sess.jsonl");

  const result = runImport(process.cwd(), {
    sourcePath,
    env
  });

  assert.equal(result.sessionId, "11111111-2222-4333-8444-555555555555");
  assert.equal(result.resumeCommand, "grok -r 11111111-2222-4333-8444-555555555555");
});

test("parseStructuredOutput extracts fenced JSON", () => {
  const raw = 'Here you go:\n```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```\n';
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput does not let fallback clobber canonical fields", () => {
  const parsed = parseStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}', {
    parsed: { verdict: "needs-attention" },
    parseError: "stale",
    rawOutput: "stale",
    status: 7
  });
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.status, 7);
});

test("runHeadlessAgent reports agentPid from the spawned child", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();
  const progressEvents = [];

  const result = await runHeadlessAgent(cwd, {
    prompt: "pid check",
    env,
    onProgress: (event) => progressEvents.push(event)
  });

  assert.equal(typeof result.agentPid, "number");
  assert.ok(result.agentPid > 0);
  assert.ok(progressEvents.some((event) => event?.agentPid === result.agentPid));
});

test("buildReviewPrompt includes target and focus", () => {
  const prompt = buildReviewPrompt({
    targetLabel: "working tree diff",
    focusText: "auth boundaries",
    collectionGuidance: "Use the repository context below as primary evidence.",
    reviewInput: "## Git Status\n M app.js"
  });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /auth boundaries/);
  assert.match(prompt, /Git Status/);
});

test("live grok --help advertises headless flags when grok is on PATH", () => {
  const help = runCommand("grok", ["--help"], { cwd: process.cwd() });
  if (help.error?.code === "ENOENT" || help.status !== 0) {
    // Optional smoke only when a real grok binary is available.
    return;
  }
  const text = `${help.stdout}\n${help.stderr}`;
  for (const flag of [
    "-p",
    "--single",
    "-r",
    "--resume",
    "--session-id",
    "--always-approve",
    "--agent",
    "--permission-mode",
    "--sandbox",
    "--output-format",
    "--json-schema",
    "--effort"
  ]) {
    assert.match(text, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("fake grok emits a two-turn streaming-json transcript", () => {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);

  const result = run(path.join(binDir, "grok"), [
    "-p",
    "do the task",
    "--output-format",
    "streaming-json"
  ], { env: buildEnv(binDir), cwd: dir });

  assert.equal(result.status, 0);
  const events = result.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const types = events.map((event) => event.type);

  assert.ok(types.includes("thought"), "expected thought events");
  assert.equal(types.filter((type) => type === "text").length >= 2, true);
  assert.equal(types.at(-1), "end");

  const end = events.at(-1);
  assert.ok(end.sessionId, "end event must carry a sessionId");
  assert.equal(typeof end.usage.input_tokens, "number");
  assert.equal(typeof end.total_cost_usd, "number");

  const textIndexes = types.map((type, index) => (type === "text" ? index : -1)).filter((i) => i !== -1);
  const hasNonTextGap = textIndexes.some((index, i) => i > 0 && index !== textIndexes[i - 1] + 1);
  assert.ok(hasNonTextGap, "the two text runs must be separated by a non-text event");
});

test("runHeadlessAgent parses streaming output, separates turns and reports usage", async () => {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);

  const phases = [];
  const result = await runHeadlessAgent(dir, {
    prompt: "do the task",
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir),
    onProgress: (event) => {
      if (event && typeof event === "object" && event.phase) {
        phases.push(event.phase);
      }
    }
  });

  assert.equal(result.status, 0);
  assert.equal(
    result.finalMessage,
    "Starting the requested task.\n\nHandled the requested task.",
    "turns must be separated by a blank line"
  );
  assert.equal(result.threadId, "99999999-8888-4777-8666-555555555555", "session id comes from the end event");
  assert.equal(result.usage.inputTokens, 1200);
  assert.equal(result.usage.costUsd, 0.0123);
  assert.equal(result.usage.numTurns, 2);
  assert.ok(phases.includes("thinking"), `expected a thinking phase, saw ${phases.join(",")}`);
  assert.ok(phases.includes("writing"), `expected a writing phase, saw ${phases.join(",")}`);
});

test("runHeadlessAgent still returns plain output verbatim when asked", async () => {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);

  const result = await runHeadlessAgent(dir, {
    prompt: "do the task",
    outputFormat: "plain",
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "Handled the requested task.");
  assert.equal(result.usage, null);
});
