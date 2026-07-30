import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("command set is complete and does not expose continue", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "check.md",
    "critique.md",
    "delegate.md",
    "doctor.md",
    "import.md",
    "land.md",
    "prune.md",
    "review.md",
    "runs.md",
    "show.md",
    "stop.md"
  ]);
});

test("plugin surfaces use /grok-build names and grok binary, not codex", () => {
  const files = [
    "commands/check.md",
    "commands/review.md",
    "commands/critique.md",
    "commands/delegate.md",
    "commands/runs.md",
    "commands/show.md",
    "commands/stop.md",
    "commands/import.md",
    "agents/grok-delegate.md",
    "hooks/hooks.json",
    "skills/grok-delegate-runtime/SKILL.md",
    "skills/grok-run-output/SKILL.md",
    "scripts/grok-bridge.mjs"
  ];

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /\bcodex\b/i, `${file} should not mention codex`);
    assert.doesNotMatch(source, /codex-companion/, `${file} should not reference codex-companion`);
  }

  const bridge = read("scripts/grok-bridge.mjs");
  assert.match(bridge, /grok-bridge/);
  assert.match(bridge, /GROK_BINARY|resolveGrokBinary|getGrokAvailability/);
  assert.doesNotMatch(bridge, /enable-review-gate|stopReviewGate|stop-review-gate/);

  const review = read("commands/review.md");
  assert.match(review, /\/grok-build:review/);
  assert.match(review, /grok-bridge\.mjs" review/);
  assert.match(review, /AskUserQuestion/);
  assert.match(review, /run_in_background:\s*true/);
  assert.match(review, /review --background/);
  assert.match(review, /Prefer the bridge's own detached worker/i);
  assert.match(review, /Bridge `--background` owns the long-running process group/i);
  assert.doesNotMatch(review, /is what actually detaches the run/);
  assert.match(review, /Do not fix issues/i);
  assert.match(review, /return Grok's output verbatim to the user/i);
  assert.match(review, /The bridge script parses `--wait` and `--background`/);
  assert.match(review, /\(Recommended\)/);
  assert.match(review, /--model <model>/);
  assert.match(review, /--effort <low\|medium\|high>/);

  const critique = read("commands/critique.md");
  assert.match(critique, /\/grok-build:critique/);
  assert.match(critique, /critique --background/);
  assert.match(critique, /uses the same review target selection as `\/grok-build:review`/i);
  assert.match(critique, /can still take extra focus text after the flags/i);
  assert.match(critique, /--model <model>/);
  assert.match(critique, /--effort <low\|medium\|high>/);

  const delegate = read("commands/delegate.md");
  assert.match(delegate, /subagent_type: "grok-build:grok-delegate"/);
  assert.match(delegate, /do not call `Skill\(grok-build:grok-delegate\)`/i);
  assert.doesNotMatch(delegate, /^context:\s*fork\b/m);
  assert.match(delegate, /run-resume-candidate --json/);
  assert.match(delegate, /Continue current Grok thread/);
  assert.match(delegate, /Start a new Grok thread/);

  const agent = read("agents/grok-delegate.md");
  assert.match(agent, /grok-bridge\.mjs" run/);
  assert.match(agent, /--resume-last/);
  assert.match(agent, /thin forwarding wrapper/i);

  const hooks = read("hooks/hooks.json");
  assert.match(hooks, /SessionStart/);
  assert.match(hooks, /SessionEnd/);
  assert.doesNotMatch(hooks, /stop-review-gate-hook\.mjs/);
  assert.doesNotMatch(hooks, /"Stop"/);
  assert.match(hooks, /session-lifecycle-hook\.mjs/);

  const importCmd = read("commands/import.md");
  assert.match(importCmd, /grok -r <session-id>/);
  assert.match(importCmd, /grok-bridge\.mjs" import/);

  const check = read("commands/check.md");
  assert.match(check, /grok-bridge\.mjs" check --json/);
  assert.doesNotMatch(check, /enable-review-gate|disable-review-gate/);

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /### `\/grok-build:check`/);
  assert.match(readme, /### `\/grok-build:review`/);
  assert.match(readme, /### `\/grok-build:critique`/);
  assert.match(readme, /### `\/grok-build:delegate`/);
  assert.match(readme, /### `\/grok-build:import`/);
  assert.match(readme, /### `\/grok-build:runs`/);
  assert.match(readme, /### `\/grok-build:show`/);
  assert.match(readme, /### `\/grok-build:stop`/);
  assert.match(readme, /plugin install grok-build@xai-grok-build/);
  assert.doesNotMatch(readme, /\bcodex\b/i);
  assert.doesNotMatch(readme, /review-gate|enable-review-gate/i);
});

test("runtime skill only forwards run once", () => {
  const runtimeSkill = read("skills/grok-delegate-runtime/SKILL.md");
  assert.match(runtimeSkill, /grok-bridge\.mjs" run --prompt-file/);
  assert.match(runtimeSkill, /Use `run` for every delegate request/i);
  assert.match(runtimeSkill, /run --resume-last/i);
  assert.match(runtimeSkill, /Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop`/);
  assert.match(runtimeSkill, /natural-language task text/);
  // Shell-injection safety: task text must not be interpolated into a quoted shell string.
  assert.match(runtimeSkill, /--prompt-file/i);
  assert.match(runtimeSkill, /Never build the Bash command by directly embedding the task text/i);

  const agent = read("agents/grok-delegate.md");
  assert.match(agent, /--prompt-file/i);
  assert.match(agent, /Never interpolate the task text into a hand-built shell string/i);

  const delegate = read("commands/delegate.md");
  assert.match(delegate, /--prompt-file/i);

  const resultHandling = read("skills/grok-run-output/SKILL.md");
  assert.match(resultHandling, /do not turn a failed or incomplete Grok run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Grok was never successfully invoked, do not generate a substitute answer at all/i);
});

test("the delegate command documents that verification is automatic", () => {
  const delegate = read(path.join("commands", "delegate.md"));

  assert.match(delegate, /[Vv]erification is automatic when a plan exists/);
  assert.match(delegate, /\.grok-build\.json/, "the config source must be named");
  assert.match(delegate, /trust-config/, "the trust gate must be documented");
  assert.match(delegate, /--no-verify/, "the opt-out must be documented");

  // The mechanism, not just the outcome: the plan is resolved server-side, so
  // the subagent must NOT be told to look one up and re-serialise --verify
  // flags. That would break the single-Bash-call invariant this file and the
  // agent state twice for prompt-injection reasons, and would put an LLM in
  // charge of re-quoting command strings.
  assert.match(delegate, /does not construct `--verify`/i);
  assert.match(delegate, /must not make a second `Bash` call/i);
  assert.match(delegate, /one `Bash` call/);
});

test("the delegate subagent never chooses background on its own", () => {
  const agent = read(path.join("agents", "grok-delegate.md"));
  assert.match(
    agent,
    /only add `--background` when the user explicitly passed/i,
    "the agent must not infer background from task complexity"
  );
  assert.doesNotMatch(
    agent,
    /looks complicated, open-ended, multi-step/i,
    "the complexity-based background heuristic must be removed"
  );
});

test("the delegate runtime skill states the same rule", () => {
  const skill = read(path.join("skills", "grok-delegate-runtime", "SKILL.md"));
  assert.match(skill, /only add `--background` when the user explicitly passed/i);
  assert.doesNotMatch(skill, /Prefer bridge `--background` for long work/i);
});

test("the plugin README states the isolation guarantee plainly", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  assert.match(readme, /## What isolation does and does not guarantee/);
  assert.match(readme, /GROK_HOME|HOME/, "the HOME requirement must be documented");

  // The section must state the limits, not just the win. These are the four ways
  // isolation can still surprise someone, and each cost real reasoning to establish.
  assert.match(readme, /--no-isolate/, "the opt-out must be documented");
  assert.match(readme, /not a sandbox/i, "must not imply filesystem isolation");
  assert.match(readme, /linked, not copied/i, "linked dirs write through to the real repo");
  assert.match(readme, /only copy of unlanded work/i, "prune can destroy unlanded work");
});

test("the README documents verification honestly", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  assert.match(readme, /completed-unverified/, "the unverified terminal status must be stated");
  assert.match(readme, /by the bridge/i, "must say the bridge runs verify, not the agent");
  assert.match(readme, /[Pp]ost-hoc/, "--max-cost must be described as post-hoc, not a hard cap");
});

test("the README documents the engines that exit 0 while broken", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  // The highest-confidence half of item 8: a user pointing the bridge at
  // Blender cannot get an honest verdict without this flag, and nothing in
  // the docs said so.
  assert.match(readme, /--python-exit-code/, "the Blender invocation must be spelled out");
  assert.match(
    readme,
    /--factory-startup/,
    "and the add-on it disables, or the test script silently tests nothing"
  );
  assert.match(readme, /addon_utils\.enable/, "the script has to re-enable the add-on itself");

  // The default marker sets, and the two Godot markers deliberately left out.
  assert.match(readme, /SCRIPT ERROR:/);
  assert.match(readme, /verifyFailurePatterns/, "the opt-in escape hatch must be named");
  assert.match(readme, /--verify-ignore/);
});

test("the delegate runtime skill warns that an engine exit code is not evidence", () => {
  const skill = read(path.join("skills", "grok-delegate-runtime", "SKILL.md"));
  assert.match(skill, /--python-exit-code/);
  assert.match(skill, /exits \*\*0\*\*/, "the exit-0-while-broken behaviour must be stated");
  assert.match(skill, /addon_utils\.enable/);
});

test("every command file is documented in the plugin README", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  const commands = fs
    .readdirSync(path.join(PLUGIN_ROOT, "commands"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.basename(name, ".md"));

  for (const command of commands) {
    assert.match(readme, new RegExp(`/grok-build:${command}\\b`), `README is missing /grok-build:${command}`);
  }
});

test("the README warns about the shared Godot cache and names the opt-out", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  // The link is the default and stays the default, so the hazard it creates -
  // an open Godot editor writing the same import cache a headless run is
  // reimporting into - has to be said where the linking is described.
  assert.match(readme, /close the Godot editor/i);
  assert.match(readme, /GROK_BUILD_LINK_GODOT_CACHE=0/);
  assert.match(readme, /"provision": \{"copy": true\}/);
  assert.match(
    readme,
    /`\.godot\/imported` is never copied/,
    "the reason the default is a link, not a copy"
  );
});

test("the README tells the truth about a conflicted land", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  // `git merge --abort` is the recovery every user reaches for and it exits
  // 128 here, because --squash writes no MERGE_HEAD.
  assert.match(readme, /rolls the repository\s+back to HEAD/i);
  assert.match(readme, /merge --abort` does not work here/);
  assert.match(readme, /--discard/);
});
