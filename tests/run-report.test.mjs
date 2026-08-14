import assert from "node:assert/strict";
import test from "node:test";

import { summarizeFinalReport } from "../plugins/turbo-build-plugin/scripts/grok-bridge.mjs";

test("summarizeFinalReport takes the run's summary from the report's Result section", () => {
  // The whole reason this exists: firstMeaningfulLine returned the first
  // sentence the model ever emitted, and that string is job.summary - the title
  // of the run in /turbo-build-plugin:runs.
  const report = [
    "## Result",
    "Rebuilt the player scene and re-imported its meshes.",
    "",
    "## Files changed",
    "scenes/Player.tscn - rebuilt"
  ].join("\n");

  assert.equal(
    summarizeFinalReport(report),
    "Rebuilt the player scene and re-imported its meshes."
  );
});

test("summarizeFinalReport stops at the next heading, and reads the last section too", () => {
  const middle = "## Summary\nignored\n\n## Result\nDid the thing.\n\n## Files changed\nnone\n";
  assert.equal(summarizeFinalReport(middle), "Did the thing.");

  // No trailing newline, no following heading: the end-of-input assertion is
  // the only thing that terminates the capture, since JS has no \Z.
  assert.equal(summarizeFinalReport("## Files changed\nnone\n\n## Result\nAt the very end."), "At the very end.");
});

test("summarizeFinalReport collapses a multi-line result into one shortened line", () => {
  const report = `## Result\n${"very long sentence. ".repeat(20)}\n`;
  const summary = summarizeFinalReport(report);

  assert.ok(!summary.includes("\n"), "a job summary is one line");
  assert.ok(summary.length <= 96, `expected a shortened summary, got ${summary.length} chars`);
  assert.match(summary, /^very long sentence\./);
});

test("summarizeFinalReport is empty for a non-compliant report, and total for junk", () => {
  // Empty is the contract: every caller reads it as "fall back to the text".
  assert.equal(summarizeFinalReport("Handled the requested task."), "");
  assert.equal(summarizeFinalReport("## Files changed\nscene.tscn\n"), "");
  // A heading that only starts with the word is not the Result section.
  assert.equal(summarizeFinalReport("## Results so far\nnope\n"), "");
  // A section with nothing under it has nothing to say.
  assert.equal(summarizeFinalReport("## Result\n\n## Files changed\nx\n"), "");
  assert.equal(summarizeFinalReport(""), "");
  assert.equal(summarizeFinalReport(null), "");
  assert.equal(summarizeFinalReport(undefined), "");
  assert.equal(summarizeFinalReport(42), "");
});

test("summarizeFinalReport tolerates CRLF and a lowercase heading", () => {
  // The report travels through argv on Windows and comes back with whatever
  // line endings the model felt like emitting.
  assert.equal(summarizeFinalReport("## Result\r\nRebuilt the scene.\r\n"), "Rebuilt the scene.");
  assert.equal(summarizeFinalReport("## result\nRebuilt the scene.\n"), "Rebuilt the scene.");
});
