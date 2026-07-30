import assert from "node:assert/strict";
import test from "node:test";

import { createJobProgressUpdater } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";

/**
 * A controllable clock plus a patch spy. Deliberately not node:test's
 * t.mock.timers - that needs Node >= 20.4 and package.json pins >= 18.18, so
 * the updater takes injectable nowImpl/patchImpl instead.
 */
function makeUpdater(minRefreshMs = 10) {
  const patches = [];
  let now = 1_000;
  const update = createJobProgressUpdater("/repo", "run-1", {
    minRefreshMs,
    nowImpl: () => now,
    patchImpl: (_root, _jobId, patch) => {
      patches.push(patch);
      return { patched: true };
    }
  });
  return {
    patches,
    update,
    advance(ms) {
      now += ms;
    }
  };
}

test("a message-only progress event refreshes lastEventAt", () => {
  // Regression: createJobProgressUpdater returned early whenever no transition
  // field changed, so patch.lastEventAt was never reached. A long, healthy,
  // single-phase stretch - a fifteen-minute Godot import, a chatty agent turn -
  // aged without bound while producing events the whole time, and every
  // staleness check read it as dead.
  const { patches, update } = makeUpdater();

  update({ message: "Verify attempt 1/3: cargo test" });

  assert.equal(patches.length, 1);
  assert.ok(patches[0].lastEventAt, "expected a lastEventAt refresh");
  assert.equal(patches[0].phase, undefined, "a message-only event must not invent a phase");
});

test("a second message-only event inside the refresh window is throttled", () => {
  const { patches, update, advance } = makeUpdater(10);

  update({ message: "first" });
  advance(9);
  update({ message: "second" });

  assert.equal(patches.length, 1, "the job file must not be rewritten per streamed token");

  advance(2);
  update({ message: "third" });
  assert.equal(patches.length, 2, "past the window, liveness is reported again");
});

test("a transition event still patches its fields, and resets the throttle", () => {
  const { patches, update, advance } = makeUpdater(10);

  update({ phase: "verifying", message: "Verify baseline: measuring 1 command" });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].phase, "verifying");
  assert.ok(patches[0].lastEventAt);

  // Same phase again with no other change: throttled like any other
  // no-transition event rather than rewriting the record.
  advance(1);
  update({ phase: "verifying", message: "Verify attempt 1/3" });
  assert.equal(patches.length, 1);

  // A real transition is never throttled.
  update({ phase: "fixing", message: "Verify fix turn 1/2" });
  assert.equal(patches.length, 2);
  assert.equal(patches[1].phase, "fixing");
});

test("the refresh window defaults to 5 seconds", () => {
  // createTrackedProgress constructs the updater with no options at all, so
  // the default is what every real run gets.
  const patches = [];
  let now = 0;
  const update = createJobProgressUpdater("/repo", "run-1", {
    nowImpl: () => now,
    patchImpl: (_root, _jobId, patch) => patches.push(patch)
  });

  update({ message: "first" });
  now = 4_999;
  update({ message: "still inside the window" });
  assert.equal(patches.length, 1);

  now = 5_000;
  update({ message: "past it" });
  assert.equal(patches.length, 2);
});
