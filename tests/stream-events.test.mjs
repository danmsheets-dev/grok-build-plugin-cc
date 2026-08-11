import assert from "node:assert/strict";
import test from "node:test";

import {
  createNdjsonDecoder,
  parseStreamEvent,
  parseStreamEventDetailed
} from "../plugins/grok-build/scripts/lib/stream-events.mjs";

test("decoder returns only complete lines and retains the partial tail", () => {
  const decoder = createNdjsonDecoder();
  assert.deepEqual(decoder.push('{"a":1}\n{"b":'), ['{"a":1}']);
  assert.deepEqual(decoder.push('2}\n'), ['{"b":2}']);
  assert.deepEqual(decoder.flush(), []);
});

test("decoder handles a JSON object split across three chunks", () => {
  const decoder = createNdjsonDecoder();
  assert.deepEqual(decoder.push('{"type":"te'), []);
  assert.deepEqual(decoder.push('xt","data":"o'), []);
  assert.deepEqual(decoder.push('k"}\n'), ['{"type":"text","data":"ok"}']);
});

test("decoder tolerates CRLF and blank lines", () => {
  const decoder = createNdjsonDecoder();
  assert.deepEqual(decoder.push('{"a":1}\r\n\r\n{"b":2}\r\n'), ['{"a":1}', '{"b":2}']);
});

test("decoder flush emits an unterminated final line", () => {
  const decoder = createNdjsonDecoder();
  assert.deepEqual(decoder.push('{"a":1}'), []);
  assert.deepEqual(decoder.flush(), ['{"a":1}']);
  assert.deepEqual(decoder.flush(), []);
});

test("parseStreamEvent returns objects and rejects everything else", () => {
  assert.deepEqual(parseStreamEvent('{"type":"text","data":"hi"}'), { type: "text", data: "hi" });
  assert.equal(parseStreamEvent("not json"), null);
  assert.equal(parseStreamEvent("[1,2]"), null);
  assert.equal(parseStreamEvent("42"), null);
  assert.equal(parseStreamEvent(""), null);
});

import {
  addUsage,
  createStreamTranscript,
  extractFinalReport,
  FINAL_REPORT_CLOSE,
  FINAL_REPORT_OPEN,
  MESSAGE_SEPARATOR,
  normalizeUsage
} from "../plugins/grok-build/scripts/lib/stream-events.mjs";

function feed(transcript, events) {
  return events.map((event) => transcript.accept(event));
}

test("adjacent text runs separated by a thought become distinct messages", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "thought", data: "planning" },
    { type: "text", data: "Creating " },
    { type: "text", data: "`probe.txt`." },
    { type: "thought", data: "verifying" },
    { type: "text", data: "Created " },
    { type: "text", data: "`probe.txt`." }
  ]);
  const result = transcript.finish();

  assert.deepEqual(result.messages, ["Creating `probe.txt`.", "Created `probe.txt`."]);
  assert.equal(result.finalMessage, `Creating \`probe.txt\`.${MESSAGE_SEPARATOR}Created \`probe.txt\`.`);
  assert.ok(!result.finalMessage.includes("`.Created"), "turns must not run together");
});

test("a single uninterrupted text run stays one message", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "text", data: "all " },
    { type: "text", data: "one" }
  ]);
  assert.deepEqual(transcript.finish().messages, ["all one"]);
});

test("accept reports phases and completed messages", () => {
  const transcript = createStreamTranscript();
  assert.equal(transcript.accept({ type: "thought", data: "x" }).phase, "thinking");
  assert.equal(transcript.accept({ type: "text", data: "hello" }).phase, "writing");
  const boundary = transcript.accept({ type: "thought", data: "y" });
  assert.equal(boundary.messageCompleted, "hello");
});

test("the end event supplies session id, usage and cost", () => {
  const transcript = createStreamTranscript();
  transcript.accept({ type: "text", data: "ok" });
  transcript.accept({
    type: "end",
    stopReason: "EndTurn",
    sessionId: "019fae7c-fb03-7321-870e-0778e3119399",
    usage: {
      input_tokens: 22648,
      cache_read_input_tokens: 5376,
      output_tokens: 29,
      reasoning_tokens: 24,
      total_tokens: 28053
    },
    num_turns: 1,
    total_cost_usd: 0.0470828,
    modelUsage: {
      "grok-4.5-build": {
        inputTokens: 22648,
        outputTokens: 29,
        cacheReadInputTokens: 5376,
        modelCalls: 1,
        costUSD: 0.0470828
      }
    }
  });
  const result = transcript.finish();

  assert.equal(result.sessionId, "019fae7c-fb03-7321-870e-0778e3119399");
  assert.equal(result.stopReason, "EndTurn");
  assert.equal(result.usage.inputTokens, 22648);
  assert.equal(result.usage.cachedInputTokens, 5376);
  assert.equal(result.usage.outputTokens, 29);
  assert.equal(result.usage.reasoningTokens, 24);
  assert.equal(result.usage.totalTokens, 28053);
  assert.equal(result.usage.costUsd, 0.0470828);
  assert.equal(result.usage.numTurns, 1);
  assert.equal(result.usage.resolvedModel, "grok-4.5-build");
  assert.ok(result.usage.modelUsage["grok-4.5-build"]);
});

test("tool events are counted and do not land in unknownTypes", () => {
  const transcript = createStreamTranscript();
  transcript.accept({ type: "text", data: "a" });
  // WP-B8: tool invocations surface as progress phases (tool name / target).
  assert.equal(transcript.accept({ type: "tool_use", name: "write" }).phase, "write");
  transcript.accept({ type: "tool_result", content: "ok" });
  transcript.accept({ type: "text", data: "b" });
  const result = transcript.finish();

  assert.deepEqual(result.unknownTypes, []);
  assert.equal(result.toolCallCount, 1);
  assert.deepEqual(result.messages, ["a", "b"], "a tool event still ends the current message");
});

test("toolCallCount is null when the stream has no tool vocabulary", () => {
  // A prose-only stream must not be reported as zero tools - that would mark
  // every healthy answer as completed-blind when the CLI simply does not emit
  // tool events.
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "thought", data: "planning" },
    { type: "text", data: "done" },
    { type: "end", stopReason: "EndTurn" }
  ]);
  assert.equal(transcript.finish().toolCallCount, null);
});

test("toolCallCount is a genuine 0 when the end event reports zero tool calls", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "text", data: "nothing to do" },
    { type: "end", stopReason: "EndTurn", toolCallCount: 0 }
  ]);
  assert.equal(transcript.finish().toolCallCount, 0);
});

test("streaming end captures structuredOutput and structuredOutputError (C11)", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "text", data: "review done" },
    {
      type: "end",
      stopReason: "EndTurn",
      sessionId: "sess-1",
      structuredOutput: { verdict: "approve", summary: "ok", findings: [], next_steps: [] },
      structuredOutputError: null
    }
  ]);
  const result = transcript.finish();
  assert.equal(result.structuredOutput?.verdict, "approve");
  assert.equal(result.structuredOutputError, null);

  const failed = createStreamTranscript();
  feed(failed, [
    { type: "end", structuredOutput: null, structuredOutputError: "schema failed" }
  ]);
  assert.equal(failed.finish().structuredOutputError, "schema failed");
});

test("malformed NDJSON lines are recorded with reasons (C13)", () => {
  const transcript = createStreamTranscript();
  transcript.noteMalformedLine("{not json", "json-parse-failed");
  transcript.noteMalformedLine('["array"]', "not-a-json-object");
  const result = transcript.finish();
  assert.equal(result.malformedLineCount, 2);
  assert.equal(result.malformedLines.length, 2);
  assert.equal(result.malformedLines[0].reason, "json-parse-failed");
  assert.equal(result.malformedLines[1].reason, "not-a-json-object");
});

test("parseStreamEventDetailed reports reasons for bad lines (C13)", () => {
  assert.equal(parseStreamEventDetailed(""), null);
  assert.equal(parseStreamEventDetailed("   "), null);
  const badJson = parseStreamEventDetailed("{not json");
  assert.equal(badJson.ok, false);
  assert.match(String(badJson.reason), /JSON|json|Unexpected|position|token/i);
  const arr = parseStreamEventDetailed("[1,2]");
  assert.deepEqual(arr, { ok: false, reason: "not-a-json-object", line: "[1,2]" });
  const good = parseStreamEventDetailed('{"type":"text","data":"x"}');
  assert.equal(good.ok, true);
  assert.equal(good.event.type, "text");
});

test("toolCallCount counts multiple invocations", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "tool_use", name: "Grep" },
    { type: "tool_result", content: "x" },
    { type: "tool_call", name: "Read" },
    { type: "tool_result", content: "y" },
    { type: "end", stopReason: "EndTurn" }
  ]);
  assert.equal(transcript.finish().toolCallCount, 2);
});

test("unknown non-tool event types are still recorded", () => {
  const transcript = createStreamTranscript();
  transcript.accept({ type: "text", data: "a" });
  assert.equal(transcript.accept({ type: "widget_ping", name: "x" }).phase, null);
  transcript.accept({ type: "text", data: "b" });
  const result = transcript.finish();

  assert.deepEqual(result.unknownTypes, ["widget_ping"]);
  assert.deepEqual(result.messages, ["a", "b"]);
});

test("the transcript and the answer are separate fields, and finalMessage still means the transcript", () => {
  // The reported bug in one fixture: three text runs, of which only the last is
  // the answer. Every consumer used to get all three glued together.
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "text", data: "turn one" },
    { type: "thought", data: "thinking" },
    { type: "text", data: "preamble" },
    { type: "thought", data: "thinking again" },
    { type: "text", data: "Final answer." },
    { type: "end", stopReason: "EndTurn" }
  ]);
  const result = transcript.finish();

  assert.equal(result.lastMessage, "Final answer.", "the answer is the text after the last thought");
  assert.equal(result.transcript.split(MESSAGE_SEPARATOR).length, 3);
  assert.equal(result.transcript, "turn one\n\npreamble\n\nFinal answer.");
  // Conflict 5: additive only. Narrowing this is what breaks every existing
  // consumer, and the review paths genuinely want the whole text.
  assert.equal(result.finalMessage, result.transcript, "finalMessage must still be the joined transcript");
  assert.equal(result.finalReport, "", "no fence emitted means no report");
});

test("a transcript that ends mid-thought still reports an empty answer, not a stale one", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "thought", data: "planning" },
    { type: "end", stopReason: "EndTurn" }
  ]);
  const result = transcript.finish();

  assert.equal(result.lastMessage, "");
  assert.equal(result.transcript, "");
  assert.equal(result.finalMessage, "");
});

test("extractFinalReport pulls the delimited block out of surrounding chatter", () => {
  assert.equal(
    extractFinalReport([
      "noise",
      `chatter ${FINAL_REPORT_OPEN}\n## Result\nDone.\n${FINAL_REPORT_CLOSE} trailing`
    ]),
    "## Result\nDone."
  );
});

test("extractFinalReport returns the LAST block when a run echoes the contract mid-flight", () => {
  // A long agentic run quotes the contract back while planning, or reports on a
  // sub-task. The block it finished on is the one that describes the run.
  const messages = [
    `${FINAL_REPORT_OPEN}\n## Result\nFirst pass.\n${FINAL_REPORT_CLOSE}`,
    "more work",
    `${FINAL_REPORT_OPEN}\n## Result\nSecond pass.\n${FINAL_REPORT_CLOSE}`
  ];
  assert.equal(extractFinalReport(messages), "## Result\nSecond pass.");
});

test("extractFinalReport is empty for a non-compliant run, and total for junk input", () => {
  assert.equal(extractFinalReport(["just narration", "no fence here"]), "");
  // An unterminated block is not a block: half a report is worse than none,
  // because the fallback chain would then never reach the plain text.
  assert.equal(extractFinalReport([`${FINAL_REPORT_OPEN}\n## Result\ntruncated`]), "");
  assert.equal(extractFinalReport([]), "");
  assert.equal(extractFinalReport(null), "");
  assert.equal(extractFinalReport(undefined), "");
  assert.equal(extractFinalReport([null, 42, { a: 1 }]), "");
  // Accepts an already-joined string too, which is what the non-streaming
  // output formats hand it.
  assert.equal(extractFinalReport(`${FINAL_REPORT_OPEN}\nok\n${FINAL_REPORT_CLOSE}`), "ok");
});

test("a report split across streamed text deltas is still extracted whole", () => {
  // The fence never arrives in one event: grok streams it in fragments, and a
  // thought in the middle would split it across two messages.
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "thought", data: "planning" },
    { type: "text", data: "Working on it." },
    { type: "thought", data: "writing the report" },
    { type: "text", data: `${FINAL_REPORT_OPEN}\n## Result\n` },
    { type: "text", data: `Rebuilt the scene.\n${FINAL_REPORT_CLOSE}` }
  ]);
  const result = transcript.finish();

  assert.equal(result.finalReport, "## Result\nRebuilt the scene.");
  assert.match(result.lastMessage, /GROK-FINAL-REPORT/, "the raw fence stays in the message text");
});

test("a transcript with no end event yields null usage", () => {
  const transcript = createStreamTranscript();
  transcript.accept({ type: "text", data: "a" });
  const result = transcript.finish();
  assert.equal(result.usage, null);
  assert.equal(result.sessionId, null);
});

test("a stream of nothing but unknown events recognizes none of them", () => {
  // The whole point of the counter: an empty transcript here means the parser
  // never understood a word, not that the run was quiet.
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "assistant_message", content: "Rebuilt the scene." },
    { type: "done" }
  ]);
  const result = transcript.finish();

  assert.equal(result.recognizedEvents, 0);
  assert.deepEqual(result.unknownTypes.sort(), ["assistant_message", "done"]);
  assert.deepEqual(result.messages, []);
});

test("a tool-only turn is recognized even though it produced no message", () => {
  // The discriminator for the raw-stdout fallback. Gating that fallback on
  // `messages.length` instead of this counter would dump the entire NDJSON
  // stream at the user for a perfectly healthy run that just did not narrate.
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "thought", data: "running the command" },
    { type: "end", stopReason: "EndTurn" }
  ]);
  const result = transcript.finish();

  assert.equal(result.recognizedEvents, 2);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.unknownTypes, []);
});

test("a mixed stream counts the events it knows and names the ones it does not", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "text", data: "Working." },
    { type: "tool_call", name: "edit" },
    { type: "widget_ping", name: "x" },
    { type: "end", stopReason: "EndTurn" }
  ]);
  const result = transcript.finish();

  // text + tool_call + end are recognized; widget_ping is unknown.
  assert.equal(result.recognizedEvents, 3);
  assert.deepEqual(result.unknownTypes, ["widget_ping"]);
  assert.equal(result.toolCallCount, 1);
  assert.deepEqual(result.messages, ["Working."]);
});

test("Hyper start/error/confine_violation events are recognized and recorded", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    {
      type: "start",
      schemaVersion: 1,
      confineRoot: "/tmp/wt",
      servedModel: "grok-4.5-build",
      permissionMode: "default",
      sandbox: "workspace-write",
      alwaysApprove: true,
      binary: "hyper",
      version: "0.2.120"
    },
    { type: "text", data: "working" },
    {
      type: "error",
      message: "Connection closed unexpectedly"
    },
    {
      type: "confine_violation",
      tool: "Write",
      path: "../escape.txt",
      resolvedPath: "/repo/escape.txt",
      root: "/tmp/wt"
    },
    {
      type: "tool_denied",
      tool: "Bash",
      reason: "not allowed"
    },
    { type: "max_turns_reached" },
    { type: "auto_compact_started" },
    { type: "auto_compact_completed" },
    { type: "model_resolved", servedModel: "grok-4.5-build" },
    {
      type: "end",
      stopReason: "EndTurn",
      filesChanged: { count: 3, paths: ["a.ts", "b.ts", "c.ts"] },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      total_cost_usd: 0.01,
      num_turns: 1
    }
  ]);
  const result = transcript.finish();

  assert.ok(result.recognizedEvents >= 10);
  assert.deepEqual(result.unknownTypes, []);
  assert.equal(result.start.confineRoot, "/tmp/wt");
  assert.equal(result.start.schemaVersion, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Connection closed/);
  assert.equal(result.confineViolations.length, 1);
  assert.equal(result.confineViolations[0].tool, "Write");
  assert.equal(result.confineViolations[0].resolvedPath, "/repo/escape.txt");
  assert.equal(result.toolDenials.length, 1);
  assert.equal(result.maxTurnsReached, true);
  assert.equal(result.compaction.length, 2);
  assert.equal(result.filesChanged.count, 3);
  assert.equal(result.toolVisibility, "unavailable");
  assert.equal(result.toolCallCount, null);
  assert.equal(result.toolCallCountFloor, 3);
});

test("unknown event types are still surfaced after known Hyper vocabulary", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "start", schemaVersion: 1 },
    { type: "future_widget_v2", payload: 1 },
    { type: "text", data: "hi" },
    { type: "end", stopReason: "EndTurn" }
  ]);
  const result = transcript.finish();
  assert.deepEqual(result.unknownTypes, ["future_widget_v2"]);
  assert.ok(result.recognizedEvents >= 3);
});

test("normalizeUsage carries usage_is_incomplete and cost_is_partial; hides cost", () => {
  const usage = normalizeUsage({
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
      usage_is_incomplete: true
    },
    cost_is_partial: true,
    total_cost_usd: 1.23,
    total_cost_usd_ticks: 1_230_000,
    num_turns: 1
  });
  assert.equal(usage.usageIsIncomplete, true);
  assert.equal(usage.costIsPartial, true);
  assert.equal(usage.costUsd, null, "partial/incomplete must not surface a dollar figure");
  assert.equal(usage.costUsdTicks, 1_230_000);
  assert.equal(usage.inputTokens, 100);
});

test("addUsage keeps null cost across turns (null + null ≠ 0)", () => {
  const a = normalizeUsage({
    usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55, usage_is_incomplete: true },
    num_turns: 1
  });
  const b = normalizeUsage({
    usage: { input_tokens: 40, output_tokens: 4, total_tokens: 44, usage_is_incomplete: true },
    num_turns: 1
  });
  const sum = addUsage(a, b);
  assert.equal(sum.costUsd, null);
  assert.equal(sum.usageIsIncomplete, true);
  assert.equal(sum.inputTokens, 90);
  assert.equal(sum.numTurns, 2);
});

test("addUsage ORs costIsPartial when only one turn reports cost", () => {
  const a = normalizeUsage({
    usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    total_cost_usd: 0.5,
    num_turns: 1
  });
  const b = normalizeUsage({
    usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, cost_is_partial: true },
    num_turns: 1
  });
  const sum = addUsage(a, b);
  assert.equal(sum.costIsPartial, true);
  assert.ok(sum.costUsd == null || sum.costIsPartial);
});

// --- WP-B8: schemaVersion 2 vocabulary ---

import { describeToolProgress, HYPER_STREAM_EVENT_TYPES } from "../plugins/grok-build/scripts/lib/stream-events.mjs";

test("schemaVersion 2 start captures sessionCwd, originalCwd, folderTrust", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    {
      type: "start",
      schemaVersion: 2,
      sessionId: "sess-v2",
      cwd: "/launch",
      sessionCwd: "/session",
      originalCwd: "/origin",
      confineRoot: "/wt",
      binary: "hyper",
      version: "0.2.114-r6",
      alwaysApprove: true,
      rulesApplied: true,
      folderTrust: {
        trusted: false,
        key: "k",
        reason: "untrusted-headless",
        droppedMcpServers: ["blender"]
      },
      servedModel: "grok-4.5-build",
      requestedModel: "grok-4.5"
    },
    { type: "end", schemaVersion: 2, stopReason: "EndTurn", toolCalls: 0, usage: null, filesChanged: { count: 0, paths: [], truncated: false }, subagents: { spawned: 0, completed: 0, failed: 0, cancelled: 0 } }
  ]);
  const result = transcript.finish();
  assert.equal(result.streamSchemaVersion, 2);
  assert.equal(result.start.sessionCwd, "/session");
  assert.equal(result.start.originalCwd, "/origin");
  assert.equal(result.start.folderTrust.reason, "untrusted-headless");
  assert.equal(result.start.requestedModel, "grok-4.5");
  assert.equal(result.toolCallCount, 0, "end.toolCalls:0 is a genuine zero on schemaVersion 2");
  assert.equal(result.toolVisibility, "explicit");
});

test("schemaVersion 2 tool_call sets phase to tool+target (not thinking)", () => {
  const transcript = createStreamTranscript();
  const call = transcript.accept({
    type: "tool_call",
    schemaVersion: 2,
    toolCallId: "call_1",
    name: "bash",
    kind: "execute",
    status: "in_progress",
    title: "Bash: cargo test",
    rawInput: { command: "cargo test" }
  });
  assert.equal(call.phase, "Bash: cargo test");
  assert.equal(call.toolProgress, "Bash: cargo test");

  // A thought while the tool is in flight must NOT replace the tool phase.
  const thought = transcript.accept({ type: "thought", data: "waiting on tests" });
  assert.equal(thought.phase, "Bash: cargo test");

  const update = transcript.accept({
    type: "tool_call_update",
    schemaVersion: 2,
    toolCallId: "call_1",
    status: "in_progress",
    title: "Bash: cargo test",
    elapsedMs: 120000
  });
  assert.equal(update.phase, "Bash: cargo test");

  const done = transcript.accept({
    type: "tool_result",
    schemaVersion: 2,
    toolCallId: "call_1",
    status: "completed",
    elapsedMs: 34000
  });
  assert.equal(done.phase, null, "no remaining active tool");

  transcript.accept({
    type: "end",
    schemaVersion: 2,
    stopReason: "EndTurn",
    toolCalls: 1,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    filesChanged: { count: 0, paths: [], truncated: false },
    subagents: { spawned: 0, completed: 0, failed: 0, cancelled: 0 }
  });
  const result = transcript.finish();
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.toolVisibility, "explicit");
  assert.equal(result.toolActivity.length, 1);
  assert.equal(result.toolActivity[0].progress, "Bash: cargo test");
});

test("describeToolProgress prefers title then path/command", () => {
  assert.equal(describeToolProgress({ title: "Read: src/main.rs" }), "Read: src/main.rs");
  assert.equal(
    describeToolProgress({ name: "read_file", locations: [{ path: "lib/foo.mjs" }] }),
    "read_file: lib/foo.mjs"
  );
  assert.equal(
    describeToolProgress({ name: "bash", rawInput: { command: "cargo test -p bridge" } }),
    "bash: cargo test -p bridge"
  );
});

test("error and confine_violation are recognized and keep blocked≠breach shape", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "start", schemaVersion: 2, sessionCwd: "/wt", binary: "hyper", version: "x", alwaysApprove: true, rulesApplied: true, folderTrust: { trusted: true, key: "k", reason: "store" } },
    {
      type: "error",
      message: "auth failed",
      usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 }
    },
    {
      type: "confine_violation",
      tool: "write",
      path: "../escape.txt",
      resolvedPath: "/repo/escape.txt",
      root: "/wt",
      schemaVersion: 1
    }
  ]);
  const result = transcript.finish();
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /auth failed/);
  assert.equal(result.usage.inputTokens, 5);
  assert.equal(result.confineViolations.length, 1);
  assert.equal(result.confineViolations[0].resolvedPath, "/repo/escape.txt");
  // Presence of confine_violation does not invent isolationBreached — that is
  // a bridge-level main-checkout dirty-set verdict, not a stream field.
  assert.equal(result.confineViolations[0].tool, "write");
});

test("question_suppressed, warning, and subagent lifecycle are recognized", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "start", schemaVersion: 2, binary: "hyper", version: "x", alwaysApprove: true, rulesApplied: true, folderTrust: { trusted: true, key: "k", reason: "store" }, sessionCwd: "/w" },
    {
      type: "question_suppressed",
      schemaVersion: 2,
      toolCallId: "q1",
      reason: "headless: ask_user_question is disabled; no interactive user"
    },
    {
      type: "warning",
      schemaVersion: 2,
      code: "folder_trust_untrusted",
      message: "dropped project MCP"
    },
    {
      type: "subagent_spawned",
      schemaVersion: 2,
      subagentId: "sa1",
      subagentType: "explore",
      description: "scan for callers"
    },
    {
      type: "subagent_finished",
      schemaVersion: 2,
      subagentId: "sa1",
      status: "completed",
      toolCalls: 4,
      durationMs: 1200
    },
    {
      type: "end",
      schemaVersion: 2,
      stopReason: "EndTurn",
      toolCalls: 0,
      usage: null,
      filesChanged: { count: 0, paths: [], truncated: false },
      subagents: { spawned: 1, completed: 1, failed: 0, cancelled: 0 }
    }
  ]);
  const result = transcript.finish();
  assert.deepEqual(result.unknownTypes, []);
  assert.equal(result.questionsSuppressed.length, 1);
  assert.match(result.questionsSuppressed[0].reason, /headless/);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "folder_trust_untrusted");
  assert.equal(result.subagents.length, 1);
  assert.equal(result.subagents[0].status, "completed");
  assert.deepEqual(result.subagentsRollup, {
    spawned: 1,
    completed: 1,
    failed: 0,
    cancelled: 0
  });
});

test("unknown event type is counted and does not fail the run", () => {
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "start", schemaVersion: 2, binary: "hyper", version: "x", alwaysApprove: true, rulesApplied: true, folderTrust: { trusted: true, key: "k", reason: "store" }, sessionCwd: "/w" },
    { type: "future_event_v9", payload: { x: 1 } },
    { type: "text", data: "still ok" },
    {
      type: "end",
      schemaVersion: 2,
      stopReason: "EndTurn",
      toolCalls: 0,
      usage: null,
      filesChanged: { count: 0, paths: [], truncated: false },
      subagents: { spawned: 0, completed: 0, failed: 0, cancelled: 0 }
    }
  ]);
  const result = transcript.finish();
  assert.deepEqual(result.unknownTypes, ["future_event_v9"]);
  assert.ok(result.recognizedEvents >= 3);
  assert.deepEqual(result.messages, ["still ok"]);
});

test("older binary with no tool events keeps toolCallCount null (not zero)", () => {
  // Pre-tool-event CLI: thought/text/end only. Must NOT report 0 (completed-blind).
  const transcript = createStreamTranscript();
  feed(transcript, [
    { type: "thought", data: "planning" },
    { type: "text", data: "I read the files and the answer is 42." },
    { type: "end", stopReason: "EndTurn", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } }
  ]);
  const result = transcript.finish();
  assert.equal(result.toolCallCount, null);
  assert.equal(result.toolVisibility, "unavailable");
  assert.equal(result.streamSchemaVersion, null);
});

test("HYPER_STREAM_EVENT_TYPES includes schemaVersion 2 tool and subagent names", () => {
  for (const type of [
    "tool_call",
    "tool_call_update",
    "tool_result",
    "subagent_spawned",
    "subagent_finished",
    "question_suppressed",
    "warning",
    "error",
    "confine_violation"
  ]) {
    assert.ok(HYPER_STREAM_EVENT_TYPES.includes(type), type);
  }
});

