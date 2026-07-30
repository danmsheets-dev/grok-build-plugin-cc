import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { makeTempDir } from "./helpers.mjs";
import { startHeartbeat } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import {
  OUTPUT_FAILURE_PATTERNS,
  classifyVerifyFailure,
  compareFailureSignatures,
  compileUserPatterns,
  deriveVerifyTimeoutMs,
  detectOutputFailures,
  normalizeFailureText,
  probeBaselines,
  resolveOutputFailurePatterns,
  resolveVerifyMaxBufferBytes,
  resolveVerifyTimeoutMs,
  runVerifyCommand,
  summarizeFailures
} from "../plugins/grok-build/scripts/lib/verify.mjs";

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// On win32, cmd /d /s /c receives the whole command as one arg. Nested double
// quotes in `node -e "..."` are mangled by CreateProcess quoting, so use
// space-free -e scripts (single quotes are JS string delimiters, not shell).

test("runVerifyCommand succeeds with a trivial node -e command", async () => {
  const result = await runVerifyCommand("node -e process.exit(0)", process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("runVerifyCommand reports non-zero exit", async () => {
  const result = await runVerifyCommand("node -e process.exit(7)", process.cwd());
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
});

test("runVerifyCommand builds exit_code/stdout/stderr output shape", async () => {
  const result = await runVerifyCommand(
    "node -e process.stdout.write('out-line');process.stderr.write('err-line');process.exit(1)",
    process.cwd()
  );
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^exit_code: 1\n/);
  assert.match(result.output, /stdout:\nout-line/);
  assert.match(result.output, /stderr:\nerr-line/);
});

test("runVerifyCommand uses (no output) when stdout and stderr are empty", async () => {
  const result = await runVerifyCommand("node -e process.exit(0)", process.cwd());
  assert.equal(result.ok, true);
  assert.match(result.output, /exit_code: 0/);
  assert.match(result.output, /\(no output\)/);
});

test("normalizeFailureText equates path, timing, and line:col noise", () => {
  const a =
    "Error: Assertion failed in C:\\Users\\dev\\project\\src\\math.test.js:42:10 (took 123ms)";
  const b =
    "Error: Assertion failed in C:\\Users\\other\\app\\src\\math.test.js:99:3 (took 4.5s)";
  assert.equal(normalizeFailureText(a), normalizeFailureText(b));

  const posixA = "FAIL /home/ci/repo/lib/foo.test.mjs:12:34 AssertionError value";
  const posixB = "FAIL /tmp/work/lib/foo.test.mjs:88:1 AssertionError value";
  assert.equal(normalizeFailureText(posixA), normalizeFailureText(posixB));
});

test("summarizeFailures extracts only failure-looking lines and dedupes", () => {
  const output = [
    "exit_code: 1",
    "stdout:",
    "ok 1 should pass",
    "not ok 2 adds numbers",
    "Error: expected 3 got 4",
    "TypeError: cannot read property x",
    "not ok 2 adds numbers",
    "stderr:",
    "(no output)",
    "PASS suite finished",
    "FAIL suite math",
    ""
  ].join("\n");

  const { signature, failureCount } = summarizeFailures(output);
  assert.ok(failureCount >= 3);
  assert.ok(signature.every((id) => typeof id === "string" && id.length > 0));
  assert.deepEqual(signature, [...new Set(signature)].sort());
  assert.ok(signature.some((id) => id.includes("not ok 2")));
  assert.ok(signature.some((id) => id.includes("error") || id.includes("typeerror")));
  assert.ok(!signature.some((id) => id.includes("ok 1 should pass")));
  assert.ok(!signature.some((id) => id === "exit_code: 1"));
});

test("compareFailureSignatures returns new-failures when current has an id absent from baseline", () => {
  const result = compareFailureSignatures(
    ["error: a", "error: b", "error: new"],
    ["error: a", "error: b"]
  );
  assert.equal(result.outcome, "new-failures");
  assert.deepEqual(result.newFailures, ["error: new"]);
  assert.equal(result.remainingCount, 2);
  assert.equal(result.baselineCount, 2);
});

test("compareFailureSignatures returns unchanged-from-baseline when current equals baseline", () => {
  // Pre-existing red suite must not be blamed on the agent.
  const baseline = ["error: flaky", "fail suite math"];
  const result = compareFailureSignatures([...baseline], [...baseline]);
  assert.equal(result.outcome, "unchanged-from-baseline");
  assert.deepEqual(result.newFailures, []);
  assert.equal(result.remainingCount, 2);
  assert.equal(result.baselineCount, 2);
});

test("compareFailureSignatures returns partial-progress when current is a strict subset of baseline", () => {
  const result = compareFailureSignatures(
    ["error: a"],
    ["error: a", "error: b", "error: c"]
  );
  assert.equal(result.outcome, "partial-progress");
  assert.deepEqual(result.newFailures, []);
  assert.equal(result.remainingCount, 1);
  assert.equal(result.baselineCount, 3);
});

test("compareFailureSignatures returns incomparable for an empty current set", () => {
  const result = compareFailureSignatures([], ["error: a"]);
  assert.equal(result.outcome, "incomparable");
  assert.deepEqual(result.newFailures, []);
  assert.equal(result.remainingCount, 0);
  assert.equal(result.baselineCount, 1);
  assert.match(result.reason, /no comparable failures/i);
});

test("deriveVerifyTimeoutMs returns floor for invalid baselines and scales/clamps", () => {
  assert.equal(deriveVerifyTimeoutMs(0), 120_000);
  assert.equal(deriveVerifyTimeoutMs(NaN), 120_000);
  assert.equal(deriveVerifyTimeoutMs(-10), 120_000);

  // 30s baseline * 4 = 120s → floor
  assert.equal(deriveVerifyTimeoutMs(30_000), 120_000);
  // 40s * 4 = 160s
  assert.equal(deriveVerifyTimeoutMs(40_000), 160_000);
  // very large baseline clamps at cap
  assert.equal(deriveVerifyTimeoutMs(1_000_000), 900_000);
});

test("runVerifyCommand does not corrupt a command containing double quotes", async () => {
  // Regression: passing the command string as a plain argv element to cmd.exe
  // /d /s /c let Node apply its own escaping on top of the command's own
  // quotes, corrupting anything with an embedded double quote. Reproduced
  // directly before the fix: the process below received a truncated,
  // syntactically invalid script instead of the real one-liner.
  const result = await runVerifyCommand(`node -e "console.log('hello world')"`, process.cwd(), {
    timeoutMs: 10000
  });
  assert.equal(result.ok, true, `expected success, got: ${result.output}`);
  assert.match(result.output, /hello world/);
});

test("runVerifyCommand still reports a real failure inside a quoted command", async () => {
  const result = await runVerifyCommand(`node -e "process.exit(1)"`, process.cwd(), {
    timeoutMs: 10000
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /SyntaxError|Unterminated/);
});

test("runVerifyCommand actually enforces its timeout on a hung command", async () => {
  // Regression: the timeout option never reached spawnSync at all. A 300ms
  // budget let a 4-second command run to completion with timedOut:false -
  // any hung cargo test / pytest / npm test / Godot headless check would
  // have wedged the bridge worker forever.
  const start = Date.now();
  const result = await runVerifyCommand(`node -e "setTimeout(()=>{}, 4000)"`, process.cwd(), {
    timeoutMs: 300
  });
  const elapsed = Date.now() - start;
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.ok(elapsed < 3000, `expected the command to be killed near its budget, took ${elapsed}ms`);
});

test("compareFailureSignatures catches more raw failures hiding behind an identical id set", () => {
  // Two genuinely different failures can normalize to the same string (paths
  // truncated, line numbers stripped). A bare set comparison would call this
  // "unchanged" even though there are now 2 distinct failure occurrences
  // where baseline had only 1 - hiding a real regression the agent introduced.
  const comparison = compareFailureSignatures(["assertionerror"], ["assertionerror"], {
    currentRawCount: 2,
    baselineRawCount: 1
  });
  assert.equal(comparison.outcome, "more-failures-same-signature");
});

test("compareFailureSignatures without raw counts still reports unchanged for an identical set", () => {
  const comparison = compareFailureSignatures(["assertionerror"], ["assertionerror"]);
  assert.equal(comparison.outcome, "unchanged-from-baseline");
});

test("summarizeFailures reports both the deduped and raw failure counts", () => {
  const output = "exit_code: 1\nstderr:\nAssertionError: x\nAssertionError: x\nAssertionError: y";
  const result = summarizeFailures(output);
  assert.equal(result.rawCount, 3);
  assert.ok(result.failureCount <= result.rawCount);
});

test("classifyVerifyFailure blames a genuine new failure", () => {
  const result = classifyVerifyFailure(
    { signature: ["new failure text"], rawCount: 1 },
    { ok: true, signature: [], rawCount: 0, timedOut: false }
  );
  assert.equal(result.blamed, true);
});

test("classifyVerifyFailure does not blame a failure unchanged from baseline", () => {
  const result = classifyVerifyFailure(
    { signature: ["same failure"], rawCount: 1 },
    { ok: false, signature: ["same failure"], rawCount: 1, timedOut: false }
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "unchanged-from-baseline");
});

test("classifyVerifyFailure does not blame when the baseline probe itself timed out", () => {
  // Regression: a hard-capped baseline probe silently produced an empty
  // signature on timeout, so every real pre-existing failure looked new
  // once the agent's run finished. Now the timeout is tracked explicitly
  // and short-circuits to an honest "we don't know" instead.
  const result = classifyVerifyFailure(
    { signature: ["some failure"], rawCount: 1 },
    { ok: false, signature: [], rawCount: 0, timedOut: true }
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "baseline-unknown");
});

test("classifyVerifyFailure does not blame an already-failing baseline with unextractable output", () => {
  // Regression: baselineEntry.ok was captured but never read, so a command
  // whose output never matched a recognisable failure pattern (e.g. a bare
  // `cargo fmt --check` diff) but was ALREADY red at baseline fell through
  // to being blamed on the agent by default.
  const result = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: false, signature: [], rawCount: 0, timedOut: false }
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "baseline-already-failing");
});

test("classifyVerifyFailure blames unextractable output when the baseline actually passed", () => {
  const result = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: true, signature: [], rawCount: 0, timedOut: false }
  );
  assert.equal(result.blamed, true);
});

test("runVerifyCommand keeps the head and tail of a 20MB firehose and still reports its exit code", async () => {
  // Fixture change, deliberate (backlog item 6): this used to be the
  // maxBuffer-overflow case, and it asserted bufferExceeded:true on this exact
  // producer. With the head+tail ring there is no cliff left to hit - every
  // byte is read, the middle is dropped, and the command's REAL exit code
  // survives. That is the whole point: a command one line from passing used to
  // be killed and reported as an infrastructure failure. The old classifier
  // assertions live on in the two classifyVerifyFailure cases below and in the
  // legacy-ENOBUFS case above, so nothing about the attribution story is lost.
  const result = await runVerifyCommand(
    `node -e "for(let i=0;i<200000;i++){console.log(i+' '+'x'.repeat(100))}"`,
    process.cwd(),
    { timeoutMs: 60000, maxOutputBytes: 1024 * 1024 }
  );

  assert.equal(result.ok, true, `expected the real exit code, got: ${result.output.slice(0, 400)}`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.bufferExceeded, true, "overflow is no longer a failure mode");
  assert.ok(
    result.output.length < 1200 * 1024,
    `expected a bounded capture, got ${result.output.length} bytes`
  );
  // Was `< 512 * 1024`, and it passed for the wrong reason: retention was
  // capped at 320 KiB for EVERY budget, so the 1 MiB asked for here had no
  // effect whatsoever. The budget is a real budget now, and asserting that it
  // is actually spent is what keeps `--verify-max-buffer` from silently
  // reverting to a no-op ceiling.
  assert.ok(
    result.output.length > 768 * 1024,
    `expected the 1 MiB budget to be used, got only ${result.output.length} bytes`
  );
  assert.ok(result.elidedBytes > 0, "expected the middle of the stream to be elided");
  assert.match(result.output, /\.\.\.\[elided \d+ bytes of output\]\.\.\./);
  assert.ok(result.output.includes(`\n0 ${"x".repeat(100)}`), "expected the first emitted line");
  assert.ok(
    result.output.includes(`199999 ${"x".repeat(100)}`),
    "expected the last emitted line"
  );
});

test("runVerifyCommand still labels a legacy maxBuffer overflow distinctly, not as a generic failure", async () => {
  // The async runner cannot produce ENOBUFS, but an injected synchronous
  // runCommand still can - and the message has to name the resolved limit and
  // say plainly that this is not a code failure, or the agent goes hunting for
  // a bug that does not exist. Hermetic: nothing is spawned.
  const result = await runVerifyCommand("noisy-suite --verbose", process.cwd(), {
    maxOutputBytes: 4096,
    runCommandImpl: async () => ({
      command: "sh",
      args: [],
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ENOBUFS" })
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.bufferExceeded, true);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /exceeded the 4096 byte limit/);
  assert.doesNotMatch(result.output, /^Failed to run command/);
  assert.notEqual(result.commandNotFound, true, "an overflow is not a missing command");

  const classified = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: true, signature: [], rawCount: 0, timedOut: false },
    { bufferExceeded: result.bufferExceeded }
  );
  assert.equal(classified.blamed, false);
  assert.equal(classified.reason, "verify-output-truncated");
  assert.equal(classified.infrastructure, true);
});

// A Godot-shaped firehose: the same SCRIPT ERROR line 8000 times, ~590 KB.
// The "current" variant differs from the "baseline" only by one extra leading
// banner line, which is the entire delta the reproduction turned on.
const GODOT_ERROR_LINE =
  "console.log('SCRIPT ERROR: Invalid get index ' + String.fromCharCode(39) + 'health' + String.fromCharCode(39) + ' (on base: ' + String.fromCharCode(39) + 'Nil' + String.fromCharCode(39) + ').')";
const godotFirehose = (banner) =>
  `node -e "${banner ? "console.log('BANNER-1.2.3');" : ""}for(let i=0;i<8000;i++){${GODOT_ERROR_LINE}}"`;

test("a byte-shifted truncated capture is not blamed on the agent", async () => {
  // The reproduced regression. Both cuts landed on exact byte offsets, so the
  // head's last line and the tail's first line were fragments whose position
  // moved with the stream's TOTAL byte count. A 12-byte banner was enough to
  // give two byte-identical failure sets two different signatures, and
  // classifyVerifyFailure returned {blamed:true, reason:"new-failures"} - a
  // real model turn spent chasing a failure that did not exist. Under main's
  // 5 MB maxBuffer the same output was captured whole and reported
  // unchanged-from-baseline, so this was a 0.4.0 regression.
  const budget = 320 * 1024;
  const baselineRun = await runVerifyCommand(godotFirehose(false), process.cwd(), {
    timeoutMs: 120000,
    maxOutputBytes: budget
  });
  const currentRun = await runVerifyCommand(godotFirehose(true), process.cwd(), {
    timeoutMs: 120000,
    maxOutputBytes: budget
  });

  assert.ok(baselineRun.elidedBytes > 0, "the fixture has to overflow the budget");
  assert.ok(currentRun.elidedBytes > 0, "the fixture has to overflow the budget");

  const baselineSummary = summarizeFailures(baselineRun.output);
  const currentSummary = summarizeFailures(currentRun.output);
  // Half one: the newline snap. No fragment ids, so the signature no longer
  // depends on where the byte offset happened to land.
  assert.deepEqual(
    currentSummary.signature,
    baselineSummary.signature,
    "a 12-byte shift must not change the failure signature"
  );
  assert.deepEqual(baselineSummary.signature, [
    "script error: invalid get index 'health' (on base: 'nil')."
  ]);

  // Half two: the classifier guard. Even with identical signatures, a capture
  // whose middle was dropped is a SAMPLE of the failures - it carries the same
  // "no comparable verdict" weight the legacy bufferExceeded flag did.
  const classification = classifyVerifyFailure(
    currentSummary,
    {
      ok: false,
      signature: baselineSummary.signature,
      rawCount: baselineSummary.rawCount,
      timedOut: false,
      bufferExceeded: false,
      elidedBytes: baselineRun.elidedBytes,
      commandNotFound: false
    },
    {
      timedOut: false,
      bufferExceeded: currentRun.bufferExceeded,
      elidedBytes: currentRun.elidedBytes,
      commandNotFound: false
    }
  );
  assert.equal(classification.blamed, false);
  assert.equal(classification.reason, "verify-output-truncated");
  assert.equal(classification.infrastructure, true);
});

test("a NON-truncated run is still blamed for a genuinely new failure", async () => {
  // The guard above converts blame into "infrastructure", which could mask a
  // real regression permanently for a chatty repo. It must fire only when the
  // capture was actually truncated: the same fixture inside a budget that fits
  // it whole reports elidedBytes 0 and stays fully attributable. The escape
  // hatch is real precisely because the retention budget scales now.
  const roomy = await runVerifyCommand(godotFirehose(true), process.cwd(), {
    timeoutMs: 120000,
    maxOutputBytes: 4 * 1024 * 1024
  });
  assert.equal(roomy.elidedBytes, 0, "a 4 MiB budget must capture ~590 KB whole");

  const summary = summarizeFailures(roomy.output);
  const classification = classifyVerifyFailure(
    summary,
    { ok: true, signature: [], rawCount: 0, timedOut: false, elidedBytes: 0 },
    { timedOut: false, elidedBytes: roomy.elidedBytes, commandNotFound: false }
  );
  assert.equal(classification.blamed, true);
  assert.equal(classification.reason, "new-failures");
});

test("classifyVerifyFailure treats an elided capture the same as a buffer overflow", () => {
  const current = classifyVerifyFailure(
    { signature: ["error: a"], rawCount: 1 },
    { ok: true, signature: [], rawCount: 0, timedOut: false },
    { elidedBytes: 4096 }
  );
  assert.equal(current.blamed, false);
  assert.equal(current.reason, "verify-output-truncated");
  assert.equal(current.infrastructure, true);

  // Mirrored on the baseline side, exactly as bufferExceeded already is: a
  // probe whose middle was dropped captured a partial sample, not a baseline.
  const baseline = classifyVerifyFailure(
    { signature: ["error: a"], rawCount: 1 },
    { ok: false, signature: ["error: b"], rawCount: 1, timedOut: false, elidedBytes: 4096 },
    {}
  );
  assert.equal(baseline.blamed, false);
  assert.equal(baseline.reason, "baseline-unknown");

  // And zero must remain fully attributable.
  const clean = classifyVerifyFailure(
    { signature: ["error: a"], rawCount: 1 },
    { ok: true, signature: [], rawCount: 0, timedOut: false, elidedBytes: 0 },
    { elidedBytes: 0 }
  );
  assert.equal(clean.blamed, true);
  assert.equal(clean.reason, "new-failures");
});

test("runVerifyCommand flags a command that cannot be started at all", async () => {
  // Regression: an unrunnable verify command looked like a plain non-zero
  // exit and was blamed on the agent. It cannot be detected from the exit
  // code - cmd.exe reports 1, not 9009, because the command is wrapped in
  // `cmd /d /s /c` - so assert on the flag, never on the code.
  const result = await runVerifyCommand("grok-build-nonexistent-binary-xyz --headless", process.cwd(), {
    timeoutMs: 10000
  });
  assert.equal(result.ok, false);
  assert.equal(result.commandNotFound, true, `unexpected output: ${result.output}`);
});

test("runVerifyCommand does not mistake a compiler 'not found' diagnostic for a missing command", async () => {
  // The NOT_RUNNABLE patterns are anchored precisely so that ordinary tool
  // output mentioning "not found" mid-line stays a real code failure.
  const result = await runVerifyCommand(
    `node -e "console.log('error TS2307: Cannot find module x, command not found in registry');process.exit(2)"`,
    process.cwd(),
    { timeoutMs: 10000 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.notEqual(result.commandNotFound, true);
});

test("runVerifyCommand does not flag a PASSING command that merely prints the not-recognized message", async () => {
  // A test suite asserting on cmd.exe's own wording, or a build that recovered
  // from a missing optional tool, still exits 0 - and nothing that failed to
  // start can exit 0, so the flag must stay off.
  const result = await runVerifyCommand(
    `node -e "console.log([String.fromCharCode(39),'nope',String.fromCharCode(39)].join('')+' is not recognized as an internal or external command')"`,
    process.cwd(),
    { timeoutMs: 10000 }
  );
  assert.equal(result.ok, true, `expected success, got: ${result.output}`);
  assert.notEqual(result.commandNotFound, true);
});

test("classifyVerifyFailure treats a verify timeout as infrastructure, not a code failure", () => {
  const result = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: true, signature: [], rawCount: 0, timedOut: false },
    { timedOut: true }
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "verify-timed-out");
  assert.equal(result.infrastructure, true);
});

test("classifyVerifyFailure treats an output overflow as infrastructure, not a code failure", () => {
  const result = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: true, signature: [], rawCount: 0, timedOut: false },
    { bufferExceeded: true }
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "verify-output-truncated");
  assert.equal(result.infrastructure, true);
});

test("classifyVerifyFailure treats an unrunnable command as fatal, not a code failure", () => {
  const result = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: true, signature: [], rawCount: 0, timedOut: false },
    { commandNotFound: true }
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "verify-command-not-runnable");
  assert.equal(result.fatal, true);
});

test("classifyVerifyFailure treats an unrunnable BASELINE command as fatal too", () => {
  const result = classifyVerifyFailure(
    { signature: ["error: something"], rawCount: 1 },
    { ok: false, signature: [], rawCount: 0, timedOut: false, commandNotFound: true }
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "verify-command-not-runnable");
  assert.equal(result.fatal, true);
});

test("classifyVerifyFailure cannot compare against a baseline that overflowed its buffer", () => {
  const result = classifyVerifyFailure(
    { signature: ["error: something"], rawCount: 1 },
    { ok: false, signature: ["error: partial"], rawCount: 1, timedOut: false, bufferExceeded: true }
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "baseline-unknown");
});

test("classifyVerifyFailure without infrastructure flags still reports baseline-already-failing", () => {
  // Regression guard for the new branches above: they must be inert when no
  // flags are supplied, or every pre-existing failure stops being classified
  // at all. Same inputs as the baseline-already-failing case, third argument
  // present but empty.
  const result = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: false, signature: [], rawCount: 0, timedOut: false },
    {}
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "baseline-already-failing");
  assert.equal(result.comparison, "incomparable");
});

test("classifyVerifyFailure without infrastructure flags still blames a passing baseline's new failure", () => {
  const result = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: true, signature: [], rawCount: 0, timedOut: false },
    {}
  );
  assert.equal(result.blamed, true);
  assert.equal(result.comparison, "incomparable");
});

test("classifyVerifyFailure reports baseline-missing instead of blaming when no probe ran", () => {
  // Regression: with no baseline entry, compareFailureSignatures compared
  // against an empty set and returned new-failures, so every pre-existing
  // failure on a --no-isolate or read-only run was attributed to the agent.
  const result = classifyVerifyFailure(
    { signature: ["error: pre-existing"], rawCount: 1 },
    undefined
  );
  assert.equal(result.blamed, false);
  assert.equal(result.reason, "baseline-missing");
});

test("probeBaselines measures every command in order and forwards the timeout", () => {
  // Hermetic: no real process is spawned. The probe's contract is that each
  // command keeps its position, records a finite duration, and carries every
  // infrastructure flag through to classifyVerifyFailure.
  const seen = [];
  const fake = (command, cwd, options) => {
    seen.push({ command, cwd, timeoutMs: options?.timeoutMs });
    return {
      ok: false,
      exitCode: 1,
      timedOut: false,
      commandNotFound: false,
      output: `exit_code: 1\nstderr:\nError: ${command} was already failing`
    };
  };

  return probeBaselines(["a", "b"], "/tmp/project", {
    runVerifyCommandImpl: fake,
    timeoutMs: 4242
  }).then((baselines) => {
    assert.equal(baselines.length, 2);
    assert.deepEqual(baselines.map((entry) => entry.command), ["a", "b"]);
    assert.deepEqual(seen.map((entry) => entry.command), ["a", "b"]);
    assert.ok(seen.every((entry) => entry.cwd === "/tmp/project"));
    assert.ok(seen.every((entry) => entry.timeoutMs === 4242));
    assert.ok(baselines.every((entry) => Number.isFinite(entry.ms)));
    assert.ok(baselines.every((entry) => entry.ok === false));
    assert.ok(baselines[0].signature.length > 0);
    assert.equal(baselines[0].timedOut, false);
    assert.equal(baselines[0].bufferExceeded, false);
    assert.equal(baselines[0].commandNotFound, false);

    // The whole point of probing: the same failure post-agent is not blamed.
    const classification = classifyVerifyFailure(
      { signature: baselines[0].signature, rawCount: baselines[0].rawCount },
      baselines[0]
    );
    assert.equal(classification.blamed, false);
    assert.equal(classification.reason, "unchanged-from-baseline");
  });
});

test("probeBaselines awaits an async runner and mirrors its infrastructure flags", async () => {
  const fake = async (command) => ({
    ok: false,
    exitCode: null,
    timedOut: true,
    bufferExceeded: false,
    commandNotFound: false,
    output: `command ${command} timed out after 10ms`
  });

  const baselines = await probeBaselines(["slow"], "/tmp/project", {
    runVerifyCommandImpl: fake
  });
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].timedOut, true);
  assert.equal(
    classifyVerifyFailure({ signature: ["error: x"], rawCount: 1 }, baselines[0]).reason,
    "baseline-unknown"
  );
});

test("probeBaselines carries the ring's truncation flag through to the classifier", async () => {
  // Every infrastructure flag the post-agent pass can raise has to be mirrored
  // on the baseline entry, or the asymmetry itself becomes the blame. elidedBytes
  // is the one the async runner can actually raise - bufferExceeded needs the
  // legacy synchronous runner - so without this the baseline half of the guard
  // was unreachable in practice.
  const baselines = await probeBaselines(["noisy"], "/tmp/project", {
    runVerifyCommandImpl: async () => ({
      ok: false,
      exitCode: 1,
      timedOut: false,
      bufferExceeded: false,
      commandNotFound: false,
      elidedBytes: 262144,
      output: "exit_code: 1\nstderr:\nError: partial capture"
    })
  });

  assert.equal(baselines[0].elidedBytes, 262144);
  assert.equal(
    classifyVerifyFailure({ signature: ["error: x"], rawCount: 1 }, baselines[0]).reason,
    "baseline-unknown"
  );
});

test("a verify command runs with the caller's environment overrides", async () => {
  // Blender is the reason --env exists: it has no CLI flag for "use this add-on
  // directory", only BLENDER_USER_SCRIPTS and friends. The override has to be
  // layered ON TOP of process.env - a bare overrides object would strip PATH
  // and SystemRoot and break every command on Windows, so `node` itself would
  // not resolve.
  const withOverride = await runVerifyCommand(
    "node -e process.exit(process.env.GROK_ENV_PROBE==='bar'?0:3)",
    process.cwd(),
    { env: { ...process.env, GROK_ENV_PROBE: "bar" } }
  );
  assert.equal(withOverride.ok, true);
  assert.equal(withOverride.exitCode, 0);

  // The discriminator: the identical command without the override.
  const without = await runVerifyCommand(
    "node -e process.exit(process.env.GROK_ENV_PROBE==='bar'?0:3)",
    process.cwd()
  );
  assert.equal(without.ok, false);
  assert.equal(without.exitCode, 3);
});

test("the baseline probe measures with the same environment as the real pass", async () => {
  // A baseline measured WITHOUT the run's overrides can be running a different
  // binary entirely, and every difference the real pass then finds is
  // attributed to the agent.
  const seen = [];
  const fake = async (command, cwd, options) => {
    seen.push(options?.env);
    return { ok: true, exitCode: 0, timedOut: false, output: "exit_code: 0" };
  };

  await probeBaselines(["a", "b"], "/tmp/project", {
    runVerifyCommandImpl: fake,
    env: { PATH: "/sandbox/bin", BLENDER_USER_SCRIPTS: "/wt/.grok-build/blender/scripts" }
  });

  assert.equal(seen.length, 2);
  for (const env of seen) {
    assert.equal(env?.BLENDER_USER_SCRIPTS, "/wt/.grok-build/blender/scripts");
    assert.equal(env?.PATH, "/sandbox/bin");
  }
});

test("probeBaselines forwards ignorePatterns to the probe, not only to summarizeFailures", async () => {
  // F2's symmetry requirement: the baseline probe and the post-agent pass must
  // both gate detection on the ignore list, or the two sides disagree about
  // whether the same line was ever a failure.
  const seen = [];
  const fake = async (command, cwd, options) => {
    seen.push(options?.ignorePatterns);
    return { ok: true, exitCode: 0, timedOut: false, output: "exit_code: 0" };
  };

  const ignorePatterns = [/Cannot create RenderingDevice/];
  await probeBaselines(["godot --headless --import"], "/repo", {
    runVerifyCommandImpl: fake,
    ignorePatterns
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0], ignorePatterns, "the exact ignore list must reach the probe call");
});

test("probeBaselines returns an empty list for an empty command list", () => {
  return probeBaselines([], "/tmp/project", {
    runVerifyCommandImpl: () => {
      throw new Error("should not run any command");
    }
  }).then((baselines) => {
    assert.deepEqual(baselines, []);
  });
});

test("a verify timeout kills the whole process tree, not just the shell", async () => {
  // Regression: the timeout killed only the direct child, which is the
  // `cmd /d /s /c` (or `/bin/sh -c`) wrapper - never the godot.exe /
  // blender.exe underneath it. The engine kept running, kept the import lock,
  // and kept burning the machine long after the run reported a timeout.
  // Hermetic: node spawns node, no engine binary anywhere.
  const dir = makeTempDir("grok-verify-orphan-");
  const marker = path.join(dir, "grandchild.log");

  fs.writeFileSync(
    path.join(dir, "grandchild.mjs"),
    [
      "import fs from 'node:fs';",
      `const marker = ${JSON.stringify(marker)};`,
      // No escape sequences anywhere in these two fixtures: they are written
      // out as source text, and an escape that survives one layer but not the
      // other produces a syntax error the spawn silently swallows.
      "setInterval(() => { fs.appendFileSync(marker, 'tick'); }, 100);",
      // Self-destruct, so a regression in the tree kill cannot leave a
      // permanent orphan behind on whatever machine ran the suite.
      "setTimeout(() => process.exit(0), 10000);",
      ""
    ].join("\n")
  );
  fs.writeFileSync(
    path.join(dir, "parent.mjs"),
    [
      "import { spawn } from 'node:child_process';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const here = path.dirname(fileURLToPath(import.meta.url));",
      // stdio:'ignore' so the grandchild holds no pipe of ours: it has to be
      // killed on its own merits, not merely stop being observed.
      "spawn(process.execPath, [path.join(here, 'grandchild.mjs')], { detached: false, stdio: 'ignore' });",
      "setTimeout(() => {}, 60000);",
      ""
    ].join("\n")
  );

  const started = Date.now();
  const result = await runVerifyCommand(`node "${path.join(dir, "parent.mjs")}"`, dir, {
    // 1500ms rather than the tighter budget this could use: on Windows the
    // shell, the parent, and the grandchild are three process launches, and a
    // loaded box must still reach the grandchild before the kill lands or the
    // test proves nothing.
    timeoutMs: 1500
  });
  assert.equal(result.timedOut, true);
  assert.ok(
    Date.now() - started < 8000,
    "expected the timeout to be enforced near its budget, not to wait out the 60s parent"
  );

  await sleep(400);
  const first = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
  assert.ok(first > 0, "the grandchild never wrote anything, so this test proves nothing");
  await sleep(800);
  const second = fs.statSync(marker).size;
  // Deliberately no terminateProcessTree cleanup in a finally: the test never
  // learns the grandchild's pid, which is precisely why the runner has to.
  assert.equal(second, first, `the grandchild outlived its shell (${first} -> ${second} bytes)`);
});

test("the verify runner keeps a job heartbeat beating while a command runs", async () => {
  // Regression: spawnSync blocked the event loop for the whole command, so
  // startHeartbeat's interval could not fire - up to 900s x 4 attempts of
  // total silence, during which /grok-build:runs showed a working run as
  // having had no activity, i.e. dead. Exactly one beat used to land: the
  // synchronous one startHeartbeat fires before its interval.
  let beats = 0;
  const stop = startHeartbeat(makeTempDir("grok-verify-heartbeat-"), "run-heartbeat", {
    intervalMs: 50,
    patchImpl: () => {
      beats += 1;
    }
  });

  try {
    const result = await runVerifyCommand(`node -e "setTimeout(()=>{}, 1500)"`, process.cwd(), {
      timeoutMs: 30000
    });
    assert.equal(result.ok, true, result.output);
  } finally {
    stop();
  }

  // Lenient on purpose: 1500ms at 50ms intervals is ~30 beats, and 5 is low
  // enough that a loaded Windows box cannot flake while still being five times
  // what the blocking runner could manage.
  assert.ok(beats >= 5, `expected the heartbeat to keep firing during verify, got ${beats}`);
});

test("resolveVerifyTimeoutMs converts whole seconds and rejects anything unusable", () => {
  // Unusable resolves to null rather than 0 so the value falls through to the
  // next source in the precedence chain instead of overriding it with a
  // timeout that would fire instantly.
  assert.equal(resolveVerifyTimeoutMs("1800"), 1_800_000);
  assert.equal(resolveVerifyTimeoutMs(2400), 2_400_000);
  assert.equal(resolveVerifyTimeoutMs(""), null);
  assert.equal(resolveVerifyTimeoutMs(null), null);
  assert.equal(resolveVerifyTimeoutMs(undefined), null);
  assert.equal(resolveVerifyTimeoutMs("-5"), null);
  assert.equal(resolveVerifyTimeoutMs("0"), null);
  assert.equal(resolveVerifyTimeoutMs("abc"), null);
});

test("resolveVerifyMaxBufferBytes converts megabytes and rejects anything unusable", () => {
  assert.equal(resolveVerifyMaxBufferBytes("32"), 32 * 1024 * 1024);
  assert.equal(resolveVerifyMaxBufferBytes(0.5), 512 * 1024);
  assert.equal(resolveVerifyMaxBufferBytes(""), null);
  assert.equal(resolveVerifyMaxBufferBytes(null), null);
  assert.equal(resolveVerifyMaxBufferBytes("-1"), null);
  assert.equal(resolveVerifyMaxBufferBytes("lots"), null);
});

test("deriveVerifyTimeoutMs honours an explicit cap and multiplier", () => {
  // The cap is what --verify-timeout / verifyTimeoutMs exists to move: 15
  // minutes is well under a cold Godot import on a large project.
  assert.equal(deriveVerifyTimeoutMs(1_000_000, { capMs: 2_400_000 }), 2_400_000);
  // ...and the default is untouched by the plumbing.
  assert.equal(deriveVerifyTimeoutMs(600_000), 900_000);
  // A raised cap is rarely the binding constraint on its own; the multiplier
  // is what decides whether a 60s baseline gets 4 minutes or 10.
  assert.equal(deriveVerifyTimeoutMs(60_000, { multiplier: 10 }), 600_000);
  // A cap below the floor degrades to the floor rather than producing a
  // timeout shorter than the minimum.
  assert.equal(deriveVerifyTimeoutMs(500_000, { capMs: 1000 }), 120_000);
});

/* --------------------------------------------------------------------------
 * Item 8 - output-pattern failure detection (both engines exit 0 while broken)
 * ----------------------------------------------------------------------- */

// A real-shaped slice of `godot --headless --import` on a project with one
// unparseable script: the error, its `at:` continuation line, and a warning
// that must NOT count.
const GODOT_IMPORT_OUTPUT = [
  "Godot Engine v4.2.2.stable.official - https://godotengine.org",
  'SCRIPT ERROR: Parse Error: Identifier "velcoity" not declared in the current scope.',
  "          at: GDScript::reload (res://player.gd:12)",
  "WARNING: Attempting to parse a resource with an unknown UID.",
  "     at: ResourceLoader::load (core/io/resource_loader.cpp:283)"
].join("\n");

test("detectOutputFailures picks the Godot error line and leaves the warning alone", () => {
  const matched = detectOutputFailures(GODOT_IMPORT_OUTPUT, OUTPUT_FAILURE_PATTERNS.godot);
  assert.equal(matched.length, 1, `expected exactly one match, got ${JSON.stringify(matched)}`);
  assert.match(matched[0].line, /^SCRIPT ERROR: Parse Error:/);
  assert.equal(matched[0].id, "godot-script-error");
});

test("detectOutputFailures never treats a Godot warning as a failure", () => {
  // Turning a green run red is the same class of bug as reporting a red run
  // green, and Godot 4 is extremely free with warnings.
  const warnings = [
    "WARNING: Parse Error recovered, continuing.",
    "SCRIPT WARNING: Unused variable: velocity",
    "     at: GDScript::reload (res://player.gd:12)"
  ].join("\n");
  assert.deepEqual(detectOutputFailures(warnings, OUTPUT_FAILURE_PATTERNS.godot), []);
});

test("the bare ERROR: and override.cfg markers are config opt-ins, not Godot defaults", () => {
  // Godot 4 emits ERROR: for benign driver / plugin / leaked-ObjectDB
  // conditions on plenty of machines, and "Cannot open file '" fires for an
  // optional override.cfg. Shipping either as a default turns healthy runs red.
  const benign = [
    "ERROR: Cannot create RenderingDevice, falling back to compatibility renderer.",
    "     at: initialize (drivers/vulkan/rendering_context_driver_vulkan.cpp:100)",
    "Cannot open file 'res://override.cfg'."
  ].join("\n");
  assert.deepEqual(detectOutputFailures(benign, OUTPUT_FAILURE_PATTERNS.godot), []);

  // ...but a project clean enough to afford them can add them itself.
  const optedIn = resolveOutputFailurePatterns("godot", ["^\\s*ERROR:"]);
  const matched = detectOutputFailures(benign, optedIn);
  assert.equal(matched.length, 1);
  assert.match(matched[0].line, /^ERROR: Cannot create RenderingDevice/);
});

test("detectOutputFailures matches Blender's anchored python-failure marker only", () => {
  const failed = [
    "Read blend: /home/dev/scene.blend",
    "Error: Python script failed, look above for details"
  ].join("\n");
  const matched = detectOutputFailures(failed, OUTPUT_FAILURE_PATTERNS.blender);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, "blender-python-script-failed");

  // No bare /^Traceback/ marker ships: a suite that deliberately prints a
  // traceback while passing would start failing.
  const passingWithTraceback = [
    "Traceback (most recent call last):",
    '  File "tests/run_tests.py", line 9, in <module>',
    "ok - 12 tests passed"
  ].join("\n");
  assert.deepEqual(detectOutputFailures(passingWithTraceback, OUTPUT_FAILURE_PATTERNS.blender), []);
});

test("detectOutputFailures counts a line that trips two patterns once", () => {
  // "SCRIPT ERROR: Parse Error: ..." matches both godot-script-error and
  // godot-parse-error. It is one failure, not two.
  const matched = detectOutputFailures(
    "SCRIPT ERROR: Parse Error: bad token",
    OUTPUT_FAILURE_PATTERNS.godot
  );
  assert.equal(matched.length, 1);
});

test("detectOutputFailures drops an ignored line before it is ever tested against a pattern", () => {
  // This is the load-bearing half of F2: threading ignorePatterns into
  // summarizeFailures alone (as shipped) left THIS function - the one that
  // decides outcome.ok - ungated, so an "ignored" line still failed the
  // command outright and produced an empty, incomparable signature.
  const output = [
    "SCRIPT ERROR: Parse Error: identifier foo not declared",
    "SCRIPT ERROR: Failed to load script res://always_broken.gd"
  ].join("\n");

  const ignoringTheOnlyFailure = detectOutputFailures(output, OUTPUT_FAILURE_PATTERNS.godot, [
    /identifier foo not declared/
  ]);
  assert.equal(ignoringTheOnlyFailure.length, 1, "the second, non-ignored line must still be caught");
  assert.match(ignoringTheOnlyFailure[0].line, /Failed to load script/);

  const ignoringEverything = detectOutputFailures(output, OUTPUT_FAILURE_PATTERNS.godot, [
    /SCRIPT ERROR/
  ]);
  assert.deepEqual(ignoringEverything, [], "both lines dropped means no failure at all, not an empty-signature failure");

  // No ignore list at all must behave exactly as before - this is not a case
  // of the new parameter being silently mandatory.
  assert.deepEqual(detectOutputFailures(output, OUTPUT_FAILURE_PATTERNS.godot), detectOutputFailures(output, OUTPUT_FAILURE_PATTERNS.godot, []));
});

test("detectOutputFailures with no patterns is a no-op", () => {
  assert.deepEqual(detectOutputFailures(GODOT_IMPORT_OUTPUT, []), []);
  assert.deepEqual(detectOutputFailures(GODOT_IMPORT_OUTPUT, undefined), []);
});

test("a command that prints SCRIPT ERROR and exits 0 does not pass verification", async () => {
  // The headline Godot/Blender correctness bug: runVerifyCommand returned
  // `ok: status === 0`, so `godot --headless --import` reporting an
  // unparseable script - and exiting 0 anyway, as it does - was recorded as a
  // clean verification of a broken project.
  //
  // Driven through a temp script rather than `node -e` so no layer of cmd.exe
  // or /bin/sh quoting has to survive the double quotes in the payload.
  const dir = makeTempDir("grok-output-pattern-");
  const script = path.join(dir, "godot-like.cjs");
  fs.writeFileSync(
    script,
    'console.log("SCRIPT ERROR: Parse Error: Identifier not declared");\nprocess.exit(0);\n',
    "utf8"
  );

  const failed = await runVerifyCommand(`node "${script}"`, dir, {
    outputFailurePatterns: OUTPUT_FAILURE_PATTERNS.godot
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 0, "the process really did exit 0 - that is the whole point");
  assert.equal(failed.failureSource, "output-pattern");
  assert.equal(failed.matchedLines.length, 1);
  assert.match(failed.matchedLines[0], /^SCRIPT ERROR:/);

  // The matched lines are NOT appended to the output: they are already in it,
  // and echoing them would double-count rawCount in summarizeFailures.
  assert.equal(failed.output.match(/SCRIPT ERROR:/g).length, 1);

  // Same command, no pattern set: an exit-0 command passes, exactly as before.
  const passed = await runVerifyCommand(`node "${script}"`, dir);
  assert.equal(passed.ok, true);
  assert.equal(passed.exitCode, 0);
  assert.equal(passed.failureSource, undefined);
});

test("runVerifyCommand's ignorePatterns option reaches detection, not just the summary", () => {
  // F2: the ignore list used to be threaded into summarizeFailures only, so a
  // command whose only failure was on the ignore list still came back
  // ok:false with failureSource:"output-pattern" - it just produced an empty,
  // "incomparable" signature afterwards. That is strictly worse than not
  // matching at all: the command reports failed for a reason the caller can
  // no longer see or explain.
  const dir = makeTempDir("grok-output-pattern-ignore-");
  const script = path.join(dir, "godot-like.cjs");
  fs.writeFileSync(
    script,
    'console.log("SCRIPT ERROR: Parse Error: Identifier not declared");\nprocess.exit(0);\n',
    "utf8"
  );

  return runVerifyCommand(`node "${script}"`, dir, {
    outputFailurePatterns: OUTPUT_FAILURE_PATTERNS.godot,
    ignorePatterns: [/Identifier not declared/]
  }).then((ignored) => {
    assert.equal(ignored.ok, true, "the only failure line was ignored, so the command must pass");
    assert.equal(ignored.exitCode, 0);
    assert.equal(ignored.failureSource, undefined);
    assert.equal(ignored.matchedLines, undefined);
  });
});

test("a command that prints Blender's python-failure marker and exits 0 does not pass either", async () => {
  const dir = makeTempDir("grok-output-pattern-blender-");
  const script = path.join(dir, "blender-like.cjs");
  fs.writeFileSync(
    script,
    'console.log("Error: Python script failed, look above for details");\nprocess.exit(0);\n',
    "utf8"
  );

  const failed = await runVerifyCommand(`node "${script}"`, dir, {
    outputFailurePatterns: OUTPUT_FAILURE_PATTERNS.blender
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 0);
  assert.equal(failed.failureSource, "output-pattern");

  const passed = await runVerifyCommand(`node "${script}"`, dir);
  assert.equal(passed.ok, true);
});

test("output patterns are only consulted on a zero exit", async () => {
  // A non-zero exit is already a failure; relabelling its source would
  // overwrite the more specific attribution the baseline comparison derives.
  const dir = makeTempDir("grok-output-pattern-nonzero-");
  const script = path.join(dir, "loud-failure.cjs");
  fs.writeFileSync(script, 'console.log("SCRIPT ERROR: x");\nprocess.exit(3);\n', "utf8");

  const result = await runVerifyCommand(`node "${script}"`, dir, {
    outputFailurePatterns: OUTPUT_FAILURE_PATTERNS.godot
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.failureSource, undefined);
});

test("probeBaselines records an exit-0 output failure that was already there", async () => {
  // Without this, the first post-agent pass would blame the agent for a
  // SCRIPT ERROR the project shipped with. Item 8 is only safe because the
  // probe measures with the same pattern set.
  const seen = [];
  const baselines = await probeBaselines(["godot --headless --import"], "/repo", {
    outputFailurePatterns: OUTPUT_FAILURE_PATTERNS.godot,
    runVerifyCommandImpl: async (_command, _cwd, options) => {
      seen.push(options.outputFailurePatterns);
      return {
        ok: false,
        exitCode: 0,
        timedOut: false,
        failureSource: "output-pattern",
        matchedLines: ["SCRIPT ERROR: Parse Error: x"],
        output: "exit_code: 0\nstdout:\nSCRIPT ERROR: Parse Error: x"
      };
    }
  });

  assert.equal(seen[0], OUTPUT_FAILURE_PATTERNS.godot, "the probe must use the same pattern set");
  assert.equal(baselines[0].ok, false);
  assert.equal(baselines[0].outputFailure, true);
  assert.equal(baselines[0].signature.length, 1);
});

test("resolveOutputFailurePatterns extends the ecosystem set and ignores an unknown one", () => {
  assert.deepEqual(resolveOutputFailurePatterns(null, []), []);
  assert.deepEqual(resolveOutputFailurePatterns("rust", []), []);
  assert.equal(
    resolveOutputFailurePatterns("godot", []).length,
    OUTPUT_FAILURE_PATTERNS.godot.length
  );
  assert.equal(
    resolveOutputFailurePatterns("Blender", ["^custom failure"]).length,
    OUTPUT_FAILURE_PATTERNS.blender.length + 1
  );
});

/* --------------------------------------------------------------------------
 * Item 9 - signature robustness
 * ----------------------------------------------------------------------- */

test("rawCountComparison:'ignore' tolerates Godot's per-frame error spam", () => {
  // Godot re-prints the same runtime error once PER FRAME, so a run that idles
  // three frames longer than the baseline reports more occurrences of an
  // identical error set - a regression that never happened.
  const ignored = compareFailureSignatures(["x"], ["x"], {
    currentRawCount: 121,
    baselineRawCount: 118,
    rawCountComparison: "ignore"
  });
  assert.equal(ignored.outcome, "unchanged-from-baseline");
});

test("rawCountComparison defaults to 'strict' and still catches a hidden regression", () => {
  // Pins the existing behaviour: 'strict' is the default, and passing it
  // explicitly changes nothing. Everything that does not opt in keeps the
  // occurrence-count check.
  const explicit = compareFailureSignatures(["x"], ["x"], {
    currentRawCount: 121,
    baselineRawCount: 118,
    rawCountComparison: "strict"
  });
  assert.equal(explicit.outcome, "more-failures-same-signature");

  const omitted = compareFailureSignatures(["x"], ["x"], {
    currentRawCount: 121,
    baselineRawCount: 118
  });
  assert.equal(omitted.outcome, "more-failures-same-signature");
});

test("classifyVerifyFailure forwards rawCountComparison to the comparison", () => {
  const current = { signature: ["parse error"], rawCount: 121 };
  const baseline = { ok: true, signature: ["parse error"], rawCount: 118, timedOut: false };

  const strict = classifyVerifyFailure(current, baseline);
  assert.equal(strict.blamed, true);
  assert.equal(strict.reason, "more-failures-same-signature");

  const lenient = classifyVerifyFailure(current, baseline, { rawCountComparison: "ignore" });
  assert.equal(lenient.blamed, false);
  assert.equal(lenient.reason, "unchanged-from-baseline");
});

test("summarizeFailures treats a bare carriage return as a line break", () => {
  // Generic hardening, not a fix for any one tool: anything that draws a
  // progress indicator by rewriting the current line emits bare CRs, and a
  // \r?\n split folds the whole run into ONE line whose normalized form
  // differs on every invocation - so it never compares equal to its baseline.
  const chunks = [];
  for (let index = 0; index < 50; index += 1) {
    chunks.push(`Fra:${index} Mem:31.44M | Compositing | Tile 1-${index}`);
  }
  chunks.push("AssertionError: expected 3 objects");
  const output = `exit_code: 1\nstderr:\n${chunks.join("\r")}`;

  const summary = summarizeFailures(output);
  assert.equal(summary.signature.length, 1);
  assert.doesNotMatch(
    summary.signature[0],
    /compositing/i,
    "the progress chunks must not be glued onto the failure id"
  );
  assert.match(summary.signature[0], /assertionerror/);
});

test("a pathological failure line is capped, and capped AFTER normalization", () => {
  // Slicing the RAW line first can cut a Windows path mid-token and defeat the
  // path rules entirely, so the cap has to run last.
  const noisy = `AssertionError: C:\\Users\\dev\\repo\\src\\math.test.js:42:10 ${"x".repeat(10_000)}`;
  const summary = summarizeFailures(`exit_code: 1\nstderr:\n${noisy}`);

  assert.equal(summary.signature.length, 1);
  assert.ok(
    summary.signature[0].length <= 512,
    `expected a capped id, got ${summary.signature[0].length} chars`
  );
  assert.match(summary.signature[0], /src\/math\.test\.js/, "the path rules ran before the slice");
  assert.doesNotMatch(summary.signature[0], /users\/dev/);
  assert.doesNotMatch(summary.signature[0], /42:10/);
});

test("summarizeFailures drops ignored lines before they can count as failures", () => {
  const output = [
    "exit_code: 1",
    "stderr:",
    "ERROR: Cannot create RenderingDevice, falling back",
    "AssertionError: expected 3 objects"
  ].join("\n");

  const unfiltered = summarizeFailures(output);
  assert.equal(unfiltered.signature.length, 2);
  assert.equal(unfiltered.rawCount, 2);

  const filtered = summarizeFailures(output, {
    ignorePatterns: [/Cannot create RenderingDevice/]
  });
  assert.equal(filtered.signature.length, 1);
  // Before looksLikeFailure, so an ignored line never reaches rawCount either.
  assert.equal(filtered.rawCount, 1);
  assert.match(filtered.signature[0], /assertionerror/);
});

test("compileUserPatterns drops an invalid regex with a warning instead of throwing", () => {
  // These arrive from --verify-ignore and from .grok-build.json, i.e. from a
  // human typing a regex. One bad character must cost the pattern, not the run.
  const warnings = [];
  const compiled = compileUserPatterns(["(unclosed", "\\bok\\b", "   ", null], {
    onWarning: (message) => warnings.push(message)
  });

  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].source, "\\bok\\b");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid verify pattern/);
});

test("compileUserPatterns is total for empty and missing input", () => {
  assert.deepEqual(compileUserPatterns(undefined), []);
  assert.deepEqual(compileUserPatterns([]), []);
});

/* --------------------------------------------------------------------------
 * Item 10 - --no-verify-baseline
 * ----------------------------------------------------------------------- */

test("classifyVerifyFailure treats a deliberately skipped baseline as strict", () => {
  // "We could not look" and "we chose not to look" have opposite correct
  // behaviours. A skipped baseline blames the run; it is emphatically NOT an
  // infrastructure outcome, or --no-verify-baseline would silently stop the
  // fix loop from ever running.
  const verdict = classifyVerifyFailure(
    { signature: ["assertionerror: x"], rawCount: 1 },
    { ok: null, signature: [], rawCount: 0, timedOut: false, baselineSkipped: true }
  );
  assert.equal(verdict.blamed, true);
  assert.equal(verdict.reason, "baseline-skipped");
  assert.notEqual(verdict.infrastructure, true);
  assert.notEqual(verdict.fatal, true);
});

test("a skipped baseline still yields to a genuine infrastructure fault", () => {
  // The command never ran at all - that is not the user's strictness choice.
  const skipped = { ok: null, signature: [], rawCount: 0, timedOut: false, baselineSkipped: true };
  const notRunnable = classifyVerifyFailure({ signature: [], rawCount: 0 }, skipped, {
    commandNotFound: true
  });
  assert.equal(notRunnable.reason, "verify-command-not-runnable");
  assert.equal(notRunnable.blamed, false);

  const timedOut = classifyVerifyFailure({ signature: [], rawCount: 0 }, skipped, {
    timedOut: true
  });
  assert.equal(timedOut.reason, "verify-timed-out");
});
