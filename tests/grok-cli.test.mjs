import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveExecutable } from "../plugins/turbo-build-plugin/scripts/lib/which.mjs";

import { FAKE_GROK_LONG_TURN_TEXT, buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir, run, writeExecutable } from "./helpers.mjs";
import {
  DEFAULT_BINARY_CANDIDATES,
  PREFERRED_BINARY,
  PROMPT_ARGV_BUDGET_POSIX,
  PROMPT_ARGV_BUDGET_WIN32,
  PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM,
  binaryOnPath,
  buildHeadlessArgs,
  buildReviewPrompt,
  detectCliBrand,
  describeMissingBinary,
  filterPermissionRulesForCli,
  getGrokAuthStatus,
  getGrokAvailability,
  isAgentCompatibleBinary,
  listGrokBinaryCandidates,
  looksLikeNonAgentTurboVersion,
  parseJsonAgentEnvelope,
  parsePermissionRulePrefix,
  parseStructuredOutput,
  pickAvailabilityFailureDetail,
  probeCliIdentity,
  probePermissionToolPrefixes,
  resetCliIdentityCacheForTests,
  READ_ONLY_DENY_RULES,
  resetAgentCompatCacheForTests,
  resetPermissionPrefixCacheForTests,
  resolveGrokBinary,
  resolvePromptArgvBudget,
  resolveSupportedPermissionPrefixes,
  runHeadlessAgent,
  runImport
} from "../plugins/turbo-build-plugin/scripts/lib/grok.mjs";
import { runCommand } from "../plugins/turbo-build-plugin/scripts/lib/process.mjs";

test("resolveGrokBinary prefers GROK_BINARY override", () => {
  const skip = { skipAgentProbe: true };
  assert.equal(resolveGrokBinary({ GROK_BINARY: "/custom/grok" }, skip), "/custom/grok");
  assert.equal(resolveGrokBinary({ GROK_BINARY: "turbo" }, skip), "turbo");
});

test("resolveGrokBinary prefers turbo over grok and never selects hyper", () => {
  assert.deepEqual([...DEFAULT_BINARY_CANDIDATES], ["turbo", "grok"]);
  assert.equal(PREFERRED_BINARY, "turbo");
  assert.ok(!DEFAULT_BINARY_CANDIDATES.includes("hyper"));

  // PATH-order preference without spawning agent probes (unit-level).
  const pathOpts = { skipAgentProbe: true };

  const emptyPathEnv = { PATH: "", Path: "" };
  assert.equal(resolveGrokBinary(emptyPathEnv, pathOpts), "turbo");

  const binDir = makeTempDir();
  // Only grok present → fall back to grok, not hyper.
  writeExecutable(path.join(binDir, "grok"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  const grokOnly = { PATH: binDir, Path: binDir };
  assert.equal(resolveGrokBinary(grokOnly, pathOpts), "grok");
  assert.equal(binaryOnPath("hyper", grokOnly), false);

  // turbo present → preferred even if grok is also there.
  writeExecutable(path.join(binDir, "turbo"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  assert.equal(resolveGrokBinary({ PATH: binDir, Path: binDir }, pathOpts), "turbo");

  // hyper on PATH alone must not win auto-resolution.
  const hyperDir = makeTempDir();
  writeExecutable(path.join(hyperDir, "hyper"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  assert.equal(resolveGrokBinary({ PATH: hyperDir, Path: hyperDir }, pathOpts), "turbo");

  // Stale GROK_BINARY=hyper (bare or path) is ignored so turbo wins.
  assert.equal(
    resolveGrokBinary({ GROK_BINARY: "hyper", PATH: binDir, Path: binDir }, pathOpts),
    "turbo"
  );
  assert.equal(
    resolveGrokBinary(
      {
        GROK_BINARY: "C:\\Users\\me\\.hyper\\bin\\hyper.exe",
        PATH: binDir,
        Path: binDir
      },
      pathOpts
    ),
    "turbo"
  );
});

test("isAgentCompatibleBinary rejects turborepo-shaped version banners (C1)", () => {
  assert.equal(looksLikeNonAgentTurboVersion("turborepo 2.5.4"), true);
  assert.equal(looksLikeNonAgentTurboVersion("2.5.4"), true);
  assert.equal(looksLikeNonAgentTurboVersion("grok 0.2.83"), false);
  assert.equal(looksLikeNonAgentTurboVersion("turbo 1.0.0-rc.1 (abc)"), false);

  const cache = new Map();
  resetAgentCompatCacheForTests(cache);
  const turboRepo = (bin, args) => {
    if (args[0] === "version" && args[1] === "--json") {
      return { status: 1, stdout: "", stderr: "unknown", error: null };
    }
    if (args[0] === "version" || args[0] === "--version") {
      return { status: 0, stdout: "2.5.4\n", stderr: "", error: null };
    }
    return {
      status: 0,
      stdout: "Usage: turbo run <task>\n  --filter\n  --cache\n",
      stderr: "",
      error: null
    };
  };
  assert.equal(
    isAgentCompatibleBinary("turbo", { runCommandImpl: turboRepo, cache, force: true }),
    false
  );

  // rc2 identity card is authoritative when present.
  assert.equal(
    isAgentCompatibleBinary("turbo", {
      runCommandImpl: (bin, args) => {
        if (args[0] === "version" && args[1] === "--json") {
          return {
            status: 0,
            stdout: JSON.stringify({
              currentVersion: "1.0.0-rc.2",
              cliFamily: "grok-build",
              agentCompatible: true,
              product: "turbo-grok-build"
            }),
            stderr: "",
            error: null
          };
        }
        return { status: 0, stdout: "", stderr: "", error: null };
      },
      cache: new Map(),
      force: true
    }),
    true
  );

  const agentTurbo = (bin, args) => {
    if (args[0] === "version" && args[1] === "--json") {
      return { status: 1, stdout: "", stderr: "", error: null };
    }
    if (args[0] === "version" || args[0] === "--version") {
      return { status: 0, stdout: "turbo 1.0.0-rc.1 (deadbeef)\n", stderr: "", error: null };
    }
    return {
      status: 0,
      stdout:
        "Usage: turbo\n  -p, --single\n  --prompt-file\n  --output-format\n  --always-approve\n  --confine\n",
      stderr: "",
      error: null
    };
  };
  assert.equal(
    isAgentCompatibleBinary("turbo", { runCommandImpl: agentTurbo, cache: new Map(), force: true }),
    true
  );

  assert.equal(
    isAgentCompatibleBinary("grok", {
      runCommandImpl: (bin, args) => {
        if (args[0] === "version" && args[1] === "--json") {
          return { status: 1, stdout: "", stderr: "", error: null };
        }
        return { status: 0, stdout: "grok 0.2.83-fake\n", stderr: "", error: null };
      },
      cache: new Map(),
      force: true
    }),
    true
  );
});

test("buildHeadlessArgs emits --job-object on win32 by default (rc2)", () => {
  const win = buildHeadlessArgs("hi", { platform: "win32", argvBudget: 100_000 });
  assert.ok(win.includes("--job-object"));
  const off = buildHeadlessArgs("hi", {
    platform: "win32",
    argvBudget: 100_000,
    env: { GROK_BUILD_JOB_OBJECT: "0" }
  });
  assert.ok(!off.includes("--job-object"));
  const posix = buildHeadlessArgs("hi", { platform: "linux", argvBudget: 100_000 });
  assert.ok(!posix.includes("--job-object"));
});

test("detectCliBrand recognizes Turbo first", () => {
  assert.deepEqual(detectCliBrand("turbo 0.2.119-r2"), { id: "turbo", label: "Turbo" });
  assert.deepEqual(detectCliBrand("hyper 0.2.114-r5"), { id: "hyper", label: "Hyper" });
  assert.deepEqual(detectCliBrand("grok 0.2.83"), { id: "grok", label: "Grok Build" });
});

test("describeMissingBinary names turbo for defaults and the override path for GROK_BINARY", () => {
  assert.match(describeMissingBinary("turbo"), /Turbo/);
  assert.match(describeMissingBinary("grok"), /turbo|Turbo/i);
  assert.match(describeMissingBinary("C:\\\\custom\\\\hyper.exe"), /GROK_BINARY/);
  assert.doesNotMatch(describeMissingBinary("turbo"), /Hyper build/i);
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
  // Preferred default is turbo when the fixture installs both names on PATH.
  assert.equal(result.resumeCommand, "turbo -r 11111111-2222-4333-8444-555555555555");
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

test("parseStructuredOutput unwraps Turbo JSON envelope structuredOutput (C12)", () => {
  const envelope = {
    text: "Review complete.",
    stopReason: "end_turn",
    sessionId: "019ff0aa-0000-7000-8000-000000000001",
    requestId: "req-1",
    structuredOutput: {
      verdict: "needs-attention",
      summary: "One real issue.",
      findings: [{ severity: "high", title: "Race", body: "…", file: "a.ts" }],
      next_steps: ["Fix the race"]
    },
    usage: { input_tokens: 10, output_tokens: 5 }
  };
  const parsed = parseStructuredOutput(JSON.stringify(envelope));
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "needs-attention");
  assert.equal(parsed.parsed.summary, "One real issue.");
  assert.equal(parsed.envelope?.sessionId, "019ff0aa-0000-7000-8000-000000000001");
  // Must not treat the outer envelope as the schema body.
  assert.equal(parsed.parsed.sessionId, undefined);
  assert.equal(parsed.parsed.stopReason, undefined);
});

test("parseStructuredOutput surfaces structuredOutputError from Turbo envelope (C12)", () => {
  const envelope = {
    text: "Could not satisfy schema.",
    stopReason: "end_turn",
    sessionId: "019ff0aa-0000-7000-8000-000000000002",
    structuredOutput: null,
    structuredOutputError: "JSON schema validation failed: missing verdict"
  };
  const parsed = parseStructuredOutput(JSON.stringify(envelope));
  assert.equal(parsed.parsed, null);
  assert.match(String(parsed.parseError), /JSON schema validation failed/);
  assert.equal(parsed.envelope?.sessionId, "019ff0aa-0000-7000-8000-000000000002");
});

test("parseStructuredOutput still accepts bare review schema without envelope", () => {
  const bare = {
    verdict: "approve",
    summary: "LGTM",
    findings: [],
    next_steps: []
  };
  const parsed = parseStructuredOutput(JSON.stringify(bare));
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.envelope, null);
});

test("parseJsonAgentEnvelope extracts usage and toolCalls from Turbo json (C14)", () => {
  const envelope = {
    text: "Done.",
    stopReason: "end_turn",
    sessionId: "sess-json-1",
    toolCalls: [{ name: "read_file" }, { name: "write" }],
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      total_cost_usd: 0.01
    },
    structuredOutput: { verdict: "approve", summary: "ok", findings: [], next_steps: [] }
  };
  const parsed = parseJsonAgentEnvelope(JSON.stringify(envelope));
  assert.ok(parsed);
  assert.equal(parsed.sessionId, "sess-json-1");
  assert.equal(parsed.toolCallCount, 2);
  assert.equal(parsed.toolVisibility, "explicit");
  assert.equal(parsed.usage?.outputTokens, 4);
  assert.equal(parsed.structuredOutput?.verdict, "approve");
  assert.equal(parsed.text, "Done.");
});

test("parseJsonAgentEnvelope accepts integer toolCalls from Turbo json (H2)", () => {
  const envelope = {
    text: "Done.",
    stopReason: "end_turn",
    sessionId: "sess-json-int",
    toolCalls: 7,
    usage: { input_tokens: 1, output_tokens: 2 }
  };
  const parsed = parseJsonAgentEnvelope(JSON.stringify(envelope));
  assert.ok(parsed);
  assert.equal(parsed.toolCallCount, 7);
  assert.equal(parsed.toolVisibility, "explicit");

  const zero = parseJsonAgentEnvelope(
    JSON.stringify({ text: "noop", toolCalls: 0, sessionId: "s0" })
  );
  assert.equal(zero?.toolCallCount, 0);
  assert.equal(zero?.toolVisibility, "explicit");
});

test("READ_ONLY_DENY_RULES use tool-wide Edit(*) (C8)", () => {
  assert.deepEqual([...READ_ONLY_DENY_RULES], ["Edit(*)"]);
});

test("listGrokBinaryCandidates walks PATH order without override (C3)", () => {
  const binDir = makeTempDir();
  writeExecutable(path.join(binDir, "turbo"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  writeExecutable(path.join(binDir, "grok"), "#!/usr/bin/env node\nprocess.exit(0);\n");
  const list = listGrokBinaryCandidates({ PATH: binDir, Path: binDir });
  assert.deepEqual(list, ["turbo", "grok"]);
});

test("pickAvailabilityFailureDetail prefers clearer --version text (C4)", () => {
  assert.equal(
    pickAvailabilityFailureDetail("Unknown command: version", "not found"),
    "not found"
  );
  assert.equal(
    pickAvailabilityFailureDetail(
      "error: unexpected argument 'version' for turborepo pipeline",
      "ENOENT: no such file or directory"
    ),
    "ENOENT: no such file or directory"
  );
  assert.equal(pickAvailabilityFailureDetail("same", "same"), "same");
  assert.equal(pickAvailabilityFailureDetail("", "alt only"), "alt only");
});

test("describeMissingBinary names the tried binary (C5)", () => {
  assert.match(describeMissingBinary("turbo"), /Turbo|turbo/);
  assert.match(describeMissingBinary("C:\\custom\\agent.exe"), /C:\\custom\\agent\.exe|GROK_BINARY/);
});

test("filterPermissionRulesForCli keeps NotebookEdit/MultiEdit aliases and drops unknown (C10/rc2)", () => {
  assert.equal(parsePermissionRulePrefix("Edit(*)"), "Edit");
  assert.equal(parsePermissionRulePrefix("NotebookEdit(**)"), "NotebookEdit");
  assert.equal(parsePermissionRulePrefix("MultiEdit(**)"), "MultiEdit");
  const filtered = filterPermissionRulesForCli([
    "Edit(*)",
    "Write(C:/repo/**)",
    "NotebookEdit(**)",
    "MultiEdit(**)",
    "search_replace(**)"
  ]);
  // rc2 Turbo maps NotebookEdit/MultiEdit → Edit; bridge keeps aliases.
  assert.deepEqual(filtered.rules, [
    "Edit(*)",
    "Write(C:/repo/**)",
    "NotebookEdit(**)",
    "MultiEdit(**)"
  ]);
  assert.equal(filtered.dropped.length, 1);
  assert.ok(filtered.dropped.some((d) => d.rule.includes("search_replace")));

  const args = buildHeadlessArgs("hi", {
    denyRules: ["Edit(*)", "NotebookEdit(**)", "MultiEdit(**)", "search_replace(**)"],
    platform: "linux",
    argvBudget: 100_000
  });
  assert.ok(args.includes("Edit(*)"));
  assert.ok(args.includes("NotebookEdit(**)"));
  assert.ok(args.includes("MultiEdit(**)"));
  assert.ok(!args.includes("search_replace(**)"));
});

test("probeCliIdentity caches version --json", () => {
  resetCliIdentityCacheForTests();
  const identityCache = new Map();
  let calls = 0;
  const runCommandImpl = (bin, args) => {
    calls += 1;
    assert.equal(bin, "fake-turbo");
    assert.deepEqual(args, ["version", "--json"]);
    return {
      status: 0,
      stdout: JSON.stringify({
        currentVersion: "1.0.0-rc.2",
        product: "turbo-grok-build",
        agentCompatible: true,
        features: { confine: true, jobObject: true },
        permissionToolPrefixes: ["Edit", "Write", "Bash"]
      }),
      stderr: "",
      error: null
    };
  };
  const identity = probeCliIdentity("fake-turbo", { cache: identityCache, runCommandImpl });
  assert.equal(identity.product, "turbo-grok-build");
  assert.equal(identity.agentCompatible, true);
  const again = probeCliIdentity("fake-turbo", {
    cache: identityCache,
    runCommandImpl: () => {
      throw new Error("should use identity cache");
    }
  });
  assert.equal(again.currentVersion, "1.0.0-rc.2");
  assert.equal(calls, 1);
});

test("probePermissionToolPrefixes reads version --json permissionToolPrefixes", () => {
  const cache = new Map();
  const prefixes = probePermissionToolPrefixes("fake-turbo", {
    force: true,
    cache,
    runCommandImpl: (bin, args) => {
      assert.equal(bin, "fake-turbo");
      assert.deepEqual(args, ["version", "--json"]);
      return {
        status: 0,
        stdout: JSON.stringify({
          currentVersion: "1.0.0-rc.2",
          agentCompatible: true,
          permissionToolPrefixes: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]
        }),
        stderr: "",
        error: null
      };
    }
  });
  assert.deepEqual(prefixes, ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
  // Cache hit must not re-run.
  const again = probePermissionToolPrefixes("fake-turbo", {
    cache,
    runCommandImpl: () => {
      throw new Error("should use cache");
    }
  });
  assert.deepEqual(again, prefixes);

  const empty = probePermissionToolPrefixes("old-cli", {
    force: true,
    cache: new Map(),
    runCommandImpl: () => ({
      status: 0,
      stdout: JSON.stringify({ currentVersion: "1.0.0-rc.1", channel: "stable" }),
      stderr: "",
      error: null
    })
  });
  assert.equal(empty, null);

  resetPermissionPrefixCacheForTests(cache);
  assert.equal(cache.size, 0);
});

test("resolveSupportedPermissionPrefixes prefers override then probe then static", () => {
  assert.deepEqual(
    [...resolveSupportedPermissionPrefixes("x", { supportedPermissionPrefixes: ["Edit"] })],
    ["Edit"]
  );
  const probed = resolveSupportedPermissionPrefixes("probed-cli", {
    cache: new Map(),
    runCommandImpl: () => ({
      status: 0,
      stdout: JSON.stringify({ permissionToolPrefixes: ["Bash", "Edit"] }),
      stderr: "",
      error: null
    })
  });
  assert.deepEqual([...probed], ["Bash", "Edit"]);
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

test("a long assistant message is shortened in progress but kept whole in the log", async () => {
  // Regression: the full body of a completed message went out as the progress
  // `message` itself, which a foreground run prints to stderr as it streams -
  // and the same text then reappeared verbatim as the run's own stdout result
  // a moment later. One terminal, the whole transcript printed twice.
  const binDir = makeTempDir();
  installFakeGrok(binDir, "long-turn");
  const env = buildEnv(binDir);
  const cwd = makeTempDir();
  const events = [];

  const result = await runHeadlessAgent(cwd, {
    prompt: "do the long task",
    env,
    onProgress: (event) => events.push(event)
  });

  assert.equal(result.status, 0);
  // The transcript/log channel is unaffected: the full body still comes back
  // as the run's answer.
  assert.equal(result.finalMessage, FAKE_GROK_LONG_TURN_TEXT);

  for (const event of events) {
    const message = typeof event === "string" ? event : event?.message;
    if (message) {
      assert.ok(
        message.length <= 200,
        `progress message exceeded the 200-char preview budget: ${message.length} chars`
      );
    }
  }

  const logged = events.find(
    (event) => event && typeof event === "object" && event.logTitle === "Assistant message"
  );
  assert.ok(logged, "expected one progress event carrying the full body as a log block");
  assert.equal(logged.logBody, FAKE_GROK_LONG_TURN_TEXT);
  assert.ok(logged.message.length < FAKE_GROK_LONG_TURN_TEXT.length, "the preview must be shorter than the full body");
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

function promptArgOf(args) {
  const index = args.indexOf("-p");
  assert.notEqual(index, -1, "expected the prompt to travel in argv");
  return args[index + 1];
}

test("an oversized prompt is bounded to what the command line can carry", () => {
  const args = buildHeadlessArgs("x".repeat(500000), {});
  const prompt = promptArgOf(args);
  const budget = resolvePromptArgvBudget({});

  assert.ok(
    Buffer.byteLength(prompt, "utf8") <= budget,
    `prompt was ${Buffer.byteLength(prompt, "utf8")} bytes against a ${budget} byte budget`
  );
  // Not merely "small": the whole budget minus the other flags should be used.
  assert.ok(Buffer.byteLength(prompt, "utf8") > budget - 500, "the budget should be nearly filled, not thrown away");
  assert.match(prompt, /\[\.\.\. \d+ bytes elided: prompt exceeded the platform command-line limit \.\.\.\]/);
  // Middle-truncated: both ends of the original survive.
  assert.ok(prompt.startsWith("x"), "the head of the prompt must survive");
  assert.ok(prompt.endsWith("x"), "the tail of the prompt must survive");
});

test("the argv budgets cannot drift out of their platform limits", () => {
  // 32767 is the documented Windows CreateProcess command-line ceiling; the
  // cmd.exe shim form measured far lower still, hence the second, smaller cap.
  assert.ok(PROMPT_ARGV_BUDGET_WIN32 < 32767);
  assert.ok(PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM < PROMPT_ARGV_BUDGET_WIN32);
  // Linux MAX_ARG_STRLEN is 32 pages for a SINGLE argument, whatever ARG_MAX says.
  assert.ok(PROMPT_ARGV_BUDGET_POSIX < 32 * 4096);

  assert.equal(resolvePromptArgvBudget({ platform: "win32" }), PROMPT_ARGV_BUDGET_WIN32);
  assert.equal(
    resolvePromptArgvBudget({ platform: "win32", cmdShim: true }),
    PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM
  );
  assert.equal(resolvePromptArgvBudget({ platform: "linux" }), PROMPT_ARGV_BUDGET_POSIX);
  assert.equal(resolvePromptArgvBudget({ platform: "win32", otherArgvBytes: 1000 }), PROMPT_ARGV_BUDGET_WIN32 - 1000);
});

test("the cmd.exe shim form gets the smaller budget, not the CreateProcess one", () => {
  const shimmed = buildHeadlessArgs("x".repeat(500000), { platform: "win32", cmdShim: true });
  const direct = buildHeadlessArgs("x".repeat(500000), { platform: "win32", cmdShim: false });

  assert.ok(Buffer.byteLength(promptArgOf(shimmed), "utf8") <= PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM);
  assert.ok(Buffer.byteLength(promptArgOf(direct), "utf8") > PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM);
  assert.ok(Buffer.byteLength(promptArgOf(direct), "utf8") <= PROMPT_ARGV_BUDGET_WIN32);
});

test("a serialized --json-schema comes out of the prompt's share of the budget", () => {
  // The critique path passes both. Budgeting the prompt alone against the
  // platform limit would still overflow the command line by the schema's size.
  const jsonSchema = { type: "object", description: "d".repeat(8000) };
  const args = buildHeadlessArgs("x".repeat(500000), { platform: "win32", jsonSchema });

  const totalBytes = args.reduce((sum, arg) => sum + Buffer.byteLength(String(arg), "utf8") + 3, 0);
  assert.ok(totalBytes <= PROMPT_ARGV_BUDGET_WIN32, `whole argv was ${totalBytes} bytes`);
  assert.ok(Buffer.byteLength(promptArgOf(args), "utf8") < PROMPT_ARGV_BUDGET_WIN32 - 8000);
});

test("a prompt that fits is passed through byte for byte", () => {
  const prompt = "review the diff\n\nwith a couple of lines";
  const args = buildHeadlessArgs(prompt, { platform: "win32", cmdShim: true });

  assert.equal(promptArgOf(args), prompt);
  assert.doesNotMatch(args.join(" "), /elided/);
  assert.ok(!args.includes("--prompt-file"), "a normal prompt must not spill to disk");
});

test("an oversized prompt travels intact via --prompt-file when a spill dir exists", async () => {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);
  const spillDir = path.join(dir, "state");
  const logPath = path.join(dir, "invocations.log");
  const prompt = `Reviewing a huge diff.\n${"x".repeat(500000)}`;

  const result = await runHeadlessAgent(dir, {
    prompt,
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir, { FAKE_GROK_LOG: logPath }),
    promptFileDir: spillDir,
    outputFormat: "plain"
  });

  assert.equal(result.status, 0);
  assert.ok(!result.args.includes("-p"), "the prompt must not also be in argv");
  const promptFile = result.args[result.args.indexOf("--prompt-file") + 1];
  assert.equal(fs.readFileSync(promptFile, "utf8"), prompt, "the spilled prompt must be lossless");
  assert.equal(result.promptTransport.mode, "prompt-file");
  assert.equal(result.promptTransport.elidedBytes, 0);
  // The fake reads --prompt-file, so this proves the CLI really saw the prompt.
  assert.match(result.finalMessage, /Reviewed uncommitted changes/);
});

test("without a spill dir the prompt is truncated and the user is told", async () => {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);
  const messages = [];

  const result = await runHeadlessAgent(dir, {
    prompt: "y".repeat(500000),
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir),
    outputFormat: "plain",
    onProgress: (event) => messages.push(typeof event === "string" ? event : event?.message)
  });

  assert.equal(result.status, 0);
  assert.equal(result.promptTransport.mode, "truncated");
  assert.ok(result.promptTransport.elidedBytes > 400000);
  assert.ok(
    messages.some((message) => /bytes were elided from the middle/.test(String(message))),
    `expected an elision notice, saw: ${messages.join(" | ")}`
  );
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
    "--effort",
    // The transport for the run-report contract. Everything else in this list
    // was already load-bearing; this one is newly so.
    "--rules"
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

test("a streaming run reports the transcript and the answer as separate fields", async () => {
  // The reported complaint: there was one text channel out of runHeadlessAgent,
  // so every consumer that wanted "the answer" was handed the narration.
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);

  const result = await runHeadlessAgent(dir, {
    prompt: "do the task",
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir)
  });

  assert.equal(result.transcript, "Starting the requested task.\n\nHandled the requested task.");
  assert.equal(result.lastMessage, "Handled the requested task.");
  assert.equal(result.finalReport, "", "the default fake emits no report fence");
  assert.equal(result.finalMessage, result.transcript, "finalMessage is unchanged");
});

test("the run-report contract travels on --rules, and is charged to the argv budget", () => {
  const rules = "Emit ===GROK-FINAL-REPORT=== ... ===END-GROK-FINAL-REPORT=== last.";
  const args = buildHeadlessArgs("small prompt", { rules });

  assert.ok(args.includes("--rules"));
  assert.equal(args[args.indexOf("--rules") + 1], rules);
  // Not glued onto the prompt: the prompt is also the job summary.
  assert.equal(promptArgOf(args), "small prompt");

  // The platform limit is on the WHOLE command line, so a big rules block has
  // to shrink the prompt's share rather than silently overflow it.
  const withoutRules = buildHeadlessArgs("x".repeat(500000), { platform: "win32", cmdShim: true });
  const withRules = buildHeadlessArgs("x".repeat(500000), {
    platform: "win32",
    cmdShim: true,
    rules: "r".repeat(2000)
  });
  const total = withRules.reduce((sum, arg) => sum + Buffer.byteLength(String(arg), "utf8") + 3, 0);
  assert.ok(total <= PROMPT_ARGV_BUDGET_WIN32_CMD_SHIM, `whole argv was ${total} bytes`);
  assert.ok(
    Buffer.byteLength(promptArgOf(withRules), "utf8") <
      Buffer.byteLength(promptArgOf(withoutRules), "utf8") - 1900
  );
});

test("no --rules flag is emitted when the caller passes none", () => {
  // The review paths must keep their exact argv: they have their own contracts.
  assert.ok(!buildHeadlessArgs("review this", {}).includes("--rules"));
  assert.ok(!buildHeadlessArgs("review this", { rules: "" }).includes("--rules"));
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
  // Non-streaming has one body of text, so the four text fields collapse onto
  // it rather than going undefined and tripping the fallback chain.
  assert.equal(result.transcript, "Handled the requested task.");
  assert.equal(result.lastMessage, "Handled the requested task.");
  assert.equal(result.finalReport, "");
});

test("no test ever resolves grok to a binary outside its own bin dir", () => {
  // Guard against the 0.3.0 money leak: runHeadlessAgent spawned `grok` with no
  // PATH resolution, so Windows CreateProcess skipped the extensionless fake
  // fixture and ran the real grok.exe — billing the user on every npm test.
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);

  const resolved = resolveExecutable("grok", buildEnv(binDir), "win32");
  assert.ok(
    resolved.startsWith(binDir),
    `grok must resolve inside the test bin dir, got: ${resolved}`
  );
});

test("a headless run with the fake on PATH never touches the real CLI", async () => {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);
  const logPath = path.join(dir, "invocations.log");

  const result = await runHeadlessAgent(dir, {
    prompt: "do the task",
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir, { FAKE_GROK_LOG: logPath })
  });

  assert.equal(result.status, 0);
  // The fake logs every invocation. If the real CLI had run, this file would be absent.
  assert.ok(fs.existsSync(logPath), "the fake grok must be the binary that ran");
});

test("a stream in an unknown vocabulary falls back to raw stdout instead of nothing", async () => {
  // A grok release that renames its event types. Every field the bridge reads
  // comes back empty while stdout carries the answer, and the user is told
  // "Grok did not return a final message." for a run that said plenty.
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir, "streaming-alien");

  const result = await runHeadlessAgent(dir, {
    prompt: "do the task",
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir)
  });

  assert.equal(result.streamParsed, false);
  assert.deepEqual([...result.unknownEventTypes].sort(), ["assistant_message", "done"]);
  assert.match(result.finalMessage, /Rebuilt the scene\./);
  // Every text field collapses onto the same fallback - there is no parsed
  // transcript to distinguish them with.
  assert.equal(result.transcript, result.finalMessage);
  assert.equal(result.lastMessage, result.finalMessage);
});

test("the raw-stdout fallback is bounded to the tail of the stream", async () => {
  // Unparsed stdout is the WHOLE run. On a long agentic session that is
  // megabytes of machine output, and it would go into the job record, through
  // redaction, and into the terminal.
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir, "streaming-alien");

  const result = await runHeadlessAgent(dir, {
    prompt: "do the task",
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir, { FAKE_GROK_ALIEN_LINES: "500" })
  });

  const lines = result.finalMessage.split("\n");
  assert.equal(lines.length, 200, "the fallback keeps exactly the last 200 lines");
  assert.match(lines.at(-1), /"done"/, "the tail is what survives");
  assert.ok(
    !result.finalMessage.includes("filler line 0\""),
    "the head of a 502-line stream must have been dropped"
  );
  assert.equal(result.streamParsed, false);
});

test("a run that narrated nothing is not mistaken for an unparseable stream", async () => {
  // The false positive the recognizedEvents counter exists to prevent: a turn
  // that did all its work through tools emits a thought and an end and no
  // prose at all. Its transcript is legitimately empty, and dumping raw NDJSON
  // over it would be strictly worse than the silence.
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir, "silent-fix");

  const result = await runHeadlessAgent(dir, {
    prompt: "The verify command `npm test` failed. Fix it.",
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir)
  });

  assert.equal(result.streamParsed, true);
  assert.equal(result.finalMessage, "");
  assert.ok(result.stdout.includes('"thought"'), "there really was unparsed-looking stdout to fall back to");
});

test("a plain non-streaming run is never reported as an unparsed stream", async () => {
  const dir = makeTempDir();
  const binDir = path.join(dir, "bin");
  installFakeGrok(binDir);

  const result = await runHeadlessAgent(dir, {
    prompt: "do the task",
    outputFormat: "plain",
    binary: path.join(binDir, "grok"),
    env: buildEnv(binDir)
  });

  assert.equal(result.streamParsed, true, "there was no stream to fail at parsing");
  assert.equal(result.finalMessage, "Handled the requested task.");
});

// Audit finding 15: runHeadlessAgent settled only on 'close', which fires when
// every inherited pipe is closed. An agent that leaves ANY background process
// holding stdout/stderr exits 0 while close never arrives — the run never
// settled, the heartbeat kept it from being reconciled as abandoned, and the
// worker leaked while holding the worktree.
test("a pipe-holding grandchild cannot wedge the run forever", async (t) => {
  const dir = makeTempDir("grok-wedge-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });

  // Only the real run leaves the grandchild; capability probes must stay clean
  // or they hang before the code under test is even reached.
  writeExecutable(
    path.join(bin, "wedgeagent"),
    `#!/usr/bin/env node
// CommonJS on purpose: an extensionless shebang script is run as \`node <file>\`,
// which defaults to CJS, so \`import\` would be a syntax error and the fixture
// would exit 1 before ever spawning the grandchild.
const { spawn } = require("node:child_process");
const argv = process.argv.slice(2);
if (argv.includes("-p") || argv.includes("--prompt-file")) {
  spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "inherit", detached: true }).unref();
  console.log(JSON.stringify({ type: "end", subtype: "success" }));
} else {
  console.log("--prompt-file -p --output-format --permission-mode");
}
process.exit(0);
`
  );

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const started = Date.now();
  const result = await runHeadlessAgent(dir, { binary: "wedgeagent", prompt: "hi", env });
  const elapsed = Date.now() - started;

  assert.equal(result.status, 0);
  assert.ok(
    elapsed < 15000,
    `must settle via the exit + drain path, not hang on close (took ${elapsed}ms)`
  );
});
