import assert from "node:assert/strict";
import test from "node:test";

import { createNdjsonDecoder, parseStreamEvent } from "../plugins/grok-build/scripts/lib/stream-events.mjs";

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
  createStreamTranscript,
  extractFinalReport,
  FINAL_REPORT_CLOSE,
  FINAL_REPORT_OPEN,
  MESSAGE_SEPARATOR
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
    total_cost_usd: 0.0470828
  });
  const result = transcript.finish();

  assert.equal(result.sessionId, "019fae7c-fb03-7321-870e-0778e3119399");
  assert.equal(result.stopReason, "EndTurn");
  assert.deepEqual(result.usage, {
    inputTokens: 22648,
    cachedInputTokens: 5376,
    outputTokens: 29,
    reasoningTokens: 24,
    totalTokens: 28053,
    costUsd: 0.0470828,
    numTurns: 1
  });
});

test("unknown event types are recorded and do not break the transcript", () => {
  const transcript = createStreamTranscript();
  transcript.accept({ type: "text", data: "a" });
  assert.equal(transcript.accept({ type: "tool_use", name: "write" }).phase, null);
  transcript.accept({ type: "text", data: "b" });
  const result = transcript.finish();

  assert.deepEqual(result.unknownTypes, ["tool_use"]);
  assert.deepEqual(result.messages, ["a", "b"], "an unknown type still ends the current message");
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
