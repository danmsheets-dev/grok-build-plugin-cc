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
