import assert from "node:assert/strict";
import test from "node:test";

import {
  compareFailureSignatures,
  deriveVerifyTimeoutMs,
  normalizeFailureText,
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
