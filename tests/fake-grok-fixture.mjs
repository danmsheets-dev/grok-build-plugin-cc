import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Install a fake `grok` binary that responds to version/models/-p/import for hermetic tests.
 * @param {string} binDir directory that will be prepended to PATH
 * @param {"default"|"not-logged-in"|"fail-print"|"import-ok"} scenario
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
    process.stdout.write(JSON.stringify({ currentVersion: "0.2.83-fake", channel: "test" }) + "\\n");
  } else {
    process.stdout.write("grok 0.2.83-fake\\n");
  }
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
const isPrint = printIndex !== -1 || hasFlag("--print");
if (isPrint || hasFlag("-r") || hasFlag("--resume") || hasFlag("-c") || hasFlag("--continue")) {
  if (scenario === "fail-print") {
    process.stderr.write("fake grok failed the print run\\n");
    process.exit(2);
  }

  const prompt = printIndex !== -1 ? (argv[printIndex + 1] ?? "") : "";
  const wantsJson = hasFlag("--json-schema") || flagValue("--output-format") === "json";

  if (flagValue("--output-format") === "streaming-json") {
    const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
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
    emit({
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
    });
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
  return scriptPath;
}

export function buildEnv(binDir, extra = {}) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extra
  };
}
