import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyVerifyFailure,
  compareFailureSignatures,
  deriveVerifyTimeoutMs,
  normalizeFailureText,
  probeBaselines,
  runVerifyCommand,
  summarizeFailures
} from "../plugins/grok-build/scripts/lib/verify.mjs";

// On win32, cmd /d /s /c receives the whole command as one arg. Nested double
// quotes in `node -e "..."` are mangled by CreateProcess quoting, so use
// space-free -e scripts (single quotes are JS string delimiters, not shell).

test("runVerifyCommand succeeds with a trivial node -e command", () => {
  const result = runVerifyCommand("node -e process.exit(0)", process.cwd());
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
});

test("runVerifyCommand reports non-zero exit", () => {
  const result = runVerifyCommand("node -e process.exit(7)", process.cwd());
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
});

test("runVerifyCommand builds exit_code/stdout/stderr output shape", () => {
  const result = runVerifyCommand(
    "node -e process.stdout.write('out-line');process.stderr.write('err-line');process.exit(1)",
    process.cwd()
  );
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /^exit_code: 1\n/);
  assert.match(result.output, /stdout:\nout-line/);
  assert.match(result.output, /stderr:\nerr-line/);
});

test("runVerifyCommand uses (no output) when stdout and stderr are empty", () => {
  const result = runVerifyCommand("node -e process.exit(0)", process.cwd());
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

test("runVerifyCommand does not corrupt a command containing double quotes", () => {
  // Regression: passing the command string as a plain argv element to cmd.exe
  // /d /s /c let Node apply its own escaping on top of the command's own
  // quotes, corrupting anything with an embedded double quote. Reproduced
  // directly before the fix: the process below received a truncated,
  // syntactically invalid script instead of the real one-liner.
  const result = runVerifyCommand(`node -e "console.log('hello world')"`, process.cwd(), {
    timeoutMs: 10000
  });
  assert.equal(result.ok, true, `expected success, got: ${result.output}`);
  assert.match(result.output, /hello world/);
});

test("runVerifyCommand still reports a real failure inside a quoted command", () => {
  const result = runVerifyCommand(`node -e "process.exit(1)"`, process.cwd(), {
    timeoutMs: 10000
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /SyntaxError|Unterminated/);
});

test("runVerifyCommand actually enforces its timeout on a hung command", () => {
  // Regression: the timeout option never reached spawnSync at all. A 300ms
  // budget let a 4-second command run to completion with timedOut:false -
  // any hung cargo test / pytest / npm test / Godot headless check would
  // have wedged the bridge worker forever.
  const start = Date.now();
  const result = runVerifyCommand(`node -e "setTimeout(()=>{}, 4000)"`, process.cwd(), {
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

test("runVerifyCommand labels an output-buffer overflow distinctly, not as a generic failure", () => {
  // Regression: exceeding maxBuffer kills the process with no exit code, so
  // there is no way to know whether the command was about to pass. A bare
  // "Failed to run command" message sent the agent hunting for a code bug
  // that never existed - the real cause is output volume.
  const result = runVerifyCommand(
    `node -e "for(let i=0;i<200000;i++){console.log('x'.repeat(100))}"`,
    process.cwd(),
    { timeoutMs: 15000 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.bufferExceeded, true);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /exceeded the .* byte limit/);
  assert.doesNotMatch(result.output, /^Failed to run command/);
  assert.notEqual(result.commandNotFound, true, "an overflow is not a missing command");

  // Extends this case rather than paying for a second 200k-line spawn: the
  // flag has to survive all the way into the attribution decision, or the
  // run still ends up blaming the agent for output volume.
  const classified = classifyVerifyFailure(
    { signature: [], rawCount: 0 },
    { ok: true, signature: [], rawCount: 0, timedOut: false },
    { bufferExceeded: result.bufferExceeded }
  );
  assert.equal(classified.blamed, false);
  assert.equal(classified.reason, "verify-output-truncated");
  assert.equal(classified.infrastructure, true);
});

test("runVerifyCommand flags a command that cannot be started at all", () => {
  // Regression: an unrunnable verify command looked like a plain non-zero
  // exit and was blamed on the agent. It cannot be detected from the exit
  // code - cmd.exe reports 1, not 9009, because the command is wrapped in
  // `cmd /d /s /c` - so assert on the flag, never on the code.
  const result = runVerifyCommand("grok-build-nonexistent-binary-xyz --headless", process.cwd(), {
    timeoutMs: 10000
  });
  assert.equal(result.ok, false);
  assert.equal(result.commandNotFound, true, `unexpected output: ${result.output}`);
});

test("runVerifyCommand does not mistake a compiler 'not found' diagnostic for a missing command", () => {
  // The NOT_RUNNABLE patterns are anchored precisely so that ordinary tool
  // output mentioning "not found" mid-line stays a real code failure.
  const result = runVerifyCommand(
    `node -e "console.log('error TS2307: Cannot find module x, command not found in registry');process.exit(2)"`,
    process.cwd(),
    { timeoutMs: 10000 }
  );
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.notEqual(result.commandNotFound, true);
});

test("runVerifyCommand does not flag a PASSING command that merely prints the not-recognized message", () => {
  // A test suite asserting on cmd.exe's own wording, or a build that recovered
  // from a missing optional tool, still exits 0 - and nothing that failed to
  // start can exit 0, so the flag must stay off.
  const result = runVerifyCommand(
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

test("probeBaselines returns an empty list for an empty command list", () => {
  return probeBaselines([], "/tmp/project", {
    runVerifyCommandImpl: () => {
      throw new Error("should not run any command");
    }
  }).then((baselines) => {
    assert.deepEqual(baselines, []);
  });
});
