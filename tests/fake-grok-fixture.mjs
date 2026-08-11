import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

// The exact body the `long-turn` scenario emits as its one completed message.
// Shared as a constant, rather than re-typed in every test that uses the
// scenario, so a test asserting on the full logged body cannot drift from
// what the fake binary actually sent.
export const FAKE_GROK_LONG_TURN_TEXT = "A".repeat(400);

/**
 * Install a fake `grok` binary that responds to version/models/-p/import for hermetic tests.
 *
 * Scenarios:
 * - `reporting` emits the run-report fence, but ONLY when `--rules` actually
 *   carried the contract - so a test using it proves the bridge injected it.
 * - `silent-fix` answers a verify fix prompt with a thought and nothing else,
 *   which is the shape that used to erase the original run's answer.
 * - `streaming-alien` speaks an event vocabulary the bridge does not know, the
 *   shape a future CLI release takes. FAKE_GROK_ALIEN_LINES pads it out so the
 *   raw-stdout fallback's cap can be observed.
 * - `writes-files` creates whatever FAKE_GROK_WRITE_FILES names (a JSON object
 *   of repo-relative path -> contents), so a write run has real changes to
 *   report.
 * - Absolute-path leaks for isolation-breach tests: FAKE_GROK_WRITE_ABSOLUTE is
 *   a JSON object of absolute path -> contents, written regardless of scenario
 *   when set (so an isolated run can dirty the main checkout on purpose).
 * - CLI-blocked confine attempts (not a breach): FAKE_GROK_CONFINE_VIOLATIONS is
 *   a JSON array of {tool, path, resolvedPath, root} objects emitted as
 *   streaming `confine_violation` events before the normal turn text.
 * - `long-turn` emits a single completed message far longer than any progress
 *   preview should be (400 chars, no newlines), so a test can assert the
 *   preview is shortened while the full body still reaches the log via
 *   `logBody`.
 *
 * @param {string} binDir directory that will be prepended to PATH
 * @param {"default"|"not-logged-in"|"fail-print"|"import-ok"|"reporting"|"silent-fix"|"streaming-alien"|"writes-files"|"long-turn"} scenario
 */
export function installFakeGrok(binDir, scenario = "default") {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "grok");

  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const scenario = ${JSON.stringify(scenario)};
const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(name);
}

function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function writeLog() {
  const logPath = process.env.FAKE_GROK_LOG;
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({ argv, scenario, cwd: process.cwd() }) + "\\n");
}

writeLog();

if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-V") {
  if (hasFlag("--json")) {
    process.stdout.write(
      JSON.stringify({
        currentVersion: "0.2.83-fake",
        channel: "test",
        product: "grok-build",
        binary: "grok",
        cliFamily: "grok-build",
        agentCompatible: true,
        features: { headless: true, confine: true, jobObject: false },
        permissionToolPrefixes: [
          "Any",
          "Bash",
          "Edit",
          "Write",
          "MultiEdit",
          "NotebookEdit",
          "Read",
          "NotebookRead",
          "Grep",
          "Glob",
          "MCPTool",
          "WebFetch",
          "WebSearch"
        ]
      }) + "\\n"
    );
  } else {
    process.stdout.write("grok 0.2.83-fake\\n");
  }
  process.exit(0);
}

if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
  process.stdout.write(
    "Usage: grok [OPTIONS]\\n" +
      "  -p, --single <PROMPT>\\n" +
      "  --prompt-file <PATH>\\n" +
      "  --output-format <FORMAT>\\n" +
      "  --always-approve\\n" +
      "  --confine <PATH>\\n" +
      "  models\\n" +
      "  version\\n"
  );
  process.exit(0);
}

if (argv[0] === "models") {
  if (scenario === "not-logged-in") {
    process.stderr.write("Not logged in. Run grok interactively to authenticate.\\n");
    process.exit(1);
  }
  process.stdout.write("You are logged in with grok.com.\\n\\nDefault model: fake-model\\n\\nAvailable models:\\n  - fake-model\\n");
  process.exit(0);
}

if (argv[0] === "import") {
  if (hasFlag("--list")) {
    if (hasFlag("--json")) {
      process.stdout.write(JSON.stringify({ sessions: [] }) + "\\n");
    } else {
      process.stdout.write("No sessions listed.\\n");
    }
    process.exit(0);
  }
  const target = argv.find((arg, i) => i > 0 && !arg.startsWith("-")) ?? "unknown";
  const sessionId = "11111111-2222-4333-8444-555555555555";
  if (hasFlag("--json")) {
    process.stdout.write(JSON.stringify({ sessionId, source: target, status: "imported" }) + "\\n");
  } else {
    process.stdout.write("Imported session " + sessionId + " from " + target + "\\n");
  }
  process.exit(0);
}

// Headless print / prompt modes
const printIndex = argv.indexOf("-p");
// The real CLI takes an oversized prompt from a file instead of argv; the bridge
// switches to it when the prompt would blow the platform command-line limit.
const promptFile = flagValue("--prompt-file");
const isPrint = printIndex !== -1 || hasFlag("--print") || promptFile !== null;
if (isPrint || hasFlag("-r") || hasFlag("--resume") || hasFlag("-c") || hasFlag("--continue")) {
  if (scenario === "fail-print") {
    process.stderr.write("fake grok failed the print run\\n");
    process.exit(2);
  }

  let prompt = printIndex !== -1 ? (argv[printIndex + 1] ?? "") : "";
  if (promptFile) {
    prompt = fs.readFileSync(promptFile, "utf8");
  }

  // Real edits on disk, so a write run has a manifest to build. Done before any
  // output so it is in place whichever output mode the caller asked for.
  if (scenario === "writes-files" && process.env.FAKE_GROK_WRITE_FILES) {
    const files = JSON.parse(process.env.FAKE_GROK_WRITE_FILES);
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.resolve(process.cwd(), relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  }
  // Isolation-breach seam: absolute paths into the main checkout (or anywhere).
  // Independent of scenario so a normal successful agent can still leak.
  if (process.env.FAKE_GROK_WRITE_ABSOLUTE) {
    const files = JSON.parse(process.env.FAKE_GROK_WRITE_ABSOLUTE);
    for (const [absolute, contents] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents);
    }
  }
  const wantsJson = hasFlag("--json-schema") || flagValue("--output-format") === "json";

  if (flagValue("--output-format") === "streaming-json") {
    const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
    const endEvent = {
      type: "end",
      stopReason: "EndTurn",
      sessionId: "99999999-8888-4777-8666-555555555555",
      requestId: "fake-request",
      usage: {
        input_tokens: 1200,
        cache_read_input_tokens: 400,
        output_tokens: 40,
        reasoning_tokens: 12,
        total_tokens: 1652
      },
      num_turns: 2,
      total_cost_usd: 0.0123
    };

    // Emit CLI-blocked confine attempts (defence working). Independent of
    // scenario so a clean write run can still report blocked escapes without
    // dirtying the main checkout.
    if (process.env.FAKE_GROK_CONFINE_VIOLATIONS) {
      const violations = JSON.parse(process.env.FAKE_GROK_CONFINE_VIOLATIONS);
      for (const v of violations) {
        emit({
          type: "confine_violation",
          tool: v.tool ?? "Write",
          path: v.path ?? null,
          resolvedPath: v.resolvedPath ?? v.resolved_path ?? null,
          root: v.root ?? null
        });
      }
    }

    // A CLI whose streaming vocabulary the bridge has never heard of. Every
    // event is unrecognized, so the transcript comes back empty while stdout is
    // full of the answer - the shape a grok release that renames its events
    // takes, which used to render as "Grok did not return a final message."
    if (scenario === "streaming-alien") {
      const filler = Number(process.env.FAKE_GROK_ALIEN_LINES ?? 0);
      for (let i = 0; i < filler; i += 1) {
        emit({ type: "assistant_message", content: "filler line " + i });
      }
      emit({ type: "assistant_message", content: "Rebuilt the scene." });
      emit({ type: "done" });
      process.exit(0);
    }

    // A verify fix turn that ends on a tool call with no trailing prose. Real
    // and common: the fix prompt asks for an edit and a re-run, not an essay.
    if (scenario === "silent-fix" && /The verify command .* failed/.test(prompt)) {
      emit({ type: "thought", data: "re-running the failing command" });
      emit(endEvent);
      process.exit(0);
    }

    // FIELD-2: a fix turn that emits its OWN final report. The bridge must keep
    // the task-turn report as the run result and stash this under fixAttempts.
    if (scenario === "reporting" && /The verify command .* failed/.test(prompt)) {
      emit({ type: "thought", data: "trying to fix the verify failure" });
      emit({
        type: "text",
        data: "===GROK-FINAL-REPORT===\\n## Result\\nI fixed cargo test.\\n===END-GROK-FINAL-REPORT==="
      });
      emit(endEvent);
      process.exit(0);
    }

    // One completed message, deliberately much longer than any progress
    // preview should ever be and with no newlines to shorten at. Real shape:
    // a turn of narration that runs to several KB.
    if (scenario === "long-turn") {
      emit({ type: "thought", data: "working" });
      emit({ type: "text", data: ${JSON.stringify(FAKE_GROK_LONG_TURN_TEXT)} });
      emit(endEvent);
      process.exit(0);
    }

    // Only when the contract actually arrived on --rules. A test asserting the
    // report is then also asserting that the bridge delivered the contract.
    const rules = flagValue("--rules") ?? "";
    if (scenario === "reporting" && rules.includes("===GROK-FINAL-REPORT===")) {
      emit({ type: "thought", data: "planning the task" });
      emit({ type: "text", data: "Let me look at " });
      emit({ type: "text", data: "the project structure." });
      emit({ type: "thought", data: "writing the report" });
      emit({ type: "text", data: "===GROK-FINAL-REPORT===\\n## Result\\nRebuilt the scene.\\n" });
      emit({ type: "text", data: "## Files changed\\nscene.tscn - rebuilt\\n===END-GROK-FINAL-REPORT===" });
      emit(endEvent);
      process.exit(0);
    }

    // Mirror the plain-mode prompt branching below, so streaming callers get
    // content shaped like their request rather than generic task text.
    const isReview = /code review|Review the provided repository|Reviewing/i.test(prompt) || hasFlag("--agent");
    const firstTurn = isReview ? ["Reviewing ", "uncommitted changes."] : ["Starting ", "the requested task."];
    const secondTurn = isReview
      ? ["Reviewed uncommitted changes.", "\\nNo material issues found."]
      : ["Handled ", "the requested task."];
    emit({ type: "thought", data: "planning the task" });
    emit({ type: "text", data: firstTurn[0] });
    emit({ type: "text", data: firstTurn[1] });
    emit({ type: "thought", data: "double-checking" });
    emit({ type: "text", data: secondTurn[0] });
    emit({ type: "text", data: secondTurn[1] });
    emit(endEvent);
    process.exit(0);
  }

  if (wantsJson || /critique|adversarial|structured|Return only valid JSON/i.test(prompt)) {
    const payload = {
      verdict: "approve",
      summary: "No material issues found in the reviewed changes.",
      findings: [],
      next_steps: ["Ship it."]
    };
    process.stdout.write(JSON.stringify(payload) + "\\n");
  } else if (/stop-gate review|ALLOW:|BLOCK:/i.test(prompt)) {
    process.stdout.write("ALLOW: previous turn did not make code changes\\n");
  } else if (/code review|Review the provided repository|Reviewing/i.test(prompt) || hasFlag("--agent")) {
    process.stdout.write("Reviewed uncommitted changes.\\nNo material issues found.\\n");
  } else {
    process.stdout.write("Handled the requested task.\\n");
  }
  process.exit(0);
}

process.stderr.write("fake grok: unknown invocation: " + argv.join(" ") + "\\n");
process.exit(1);
`;

  writeExecutable(scriptPath, source);
  // Bridge prefers `turbo` on PATH, then `grok`. Install both names so hermetic
  // tests always hit this fixture first and never the developer's real Turbo.
  const turboPath = path.join(binDir, "turbo");
  if (turboPath !== scriptPath) {
    fs.copyFileSync(scriptPath, turboPath);
    try {
      fs.chmodSync(turboPath, 0o755);
    } catch {
      // Windows may ignore mode bits; the copy is still invocable via PATHEXT.
    }
  }
  return scriptPath;
}

export function buildEnv(binDir, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extra
  };

  // Putting the fake CLI first on PATH is not enough on its own: GROK_BINARY
  // outranks PATH entirely, so a developer who has it exported — a supported
  // setup for driving a local fork such as Turbo — runs the whole suite against
  // their REAL CLI. The failure is baffling rather than obvious: fixtures
  // return live model output instead of scripted text, so assertions fail on
  // content, not on "binary not found".
  //
  // Deleted rather than pinned so PATH stays the single source of truth for
  // which binary a test exercises. A test that genuinely wants the override can
  // still pass it through `extra`, which is applied above.
  if (!Object.prototype.hasOwnProperty.call(extra, "GROK_BINARY")) {
    delete env.GROK_BINARY;
  }

  // Same story for programmatic-caller markers: this suite often runs under
  // Claude Code itself, which exports CLAUDECODE / CLAUDE_PLUGIN_ROOT. Without
  // stripping them, every test inherits forced isolation and `--no-isolate`
  // tests fail for the wrong reason. Opt in via `extra` when a test needs the
  // programmatic path.
  for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PLUGIN_ROOT", "GROK_BUILD_CALLER"]) {
    if (!Object.prototype.hasOwnProperty.call(extra, key)) {
      delete env[key];
    }
  }

  // R6-7 / R6-8: never let tests create worktrees under the shared volume root
  // (`H:\gb\w` / `%TEMP%\gb\w`). That was the measured source of 500+ orphan
  // directories. Pin to a per-test directory under CLAUDE_PLUGIN_DATA when the
  // caller did not already set GROK_BUILD_WORKTREE_ROOT.
  if (!Object.prototype.hasOwnProperty.call(extra, "GROK_BUILD_WORKTREE_ROOT")) {
    if (env.CLAUDE_PLUGIN_DATA) {
      env.GROK_BUILD_WORKTREE_ROOT = path.join(env.CLAUDE_PLUGIN_DATA, "wt-root");
    } else {
      delete env.GROK_BUILD_WORKTREE_ROOT;
    }
  }

  return env;
}
