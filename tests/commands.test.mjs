import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { loadPromptTemplate } from "../plugins/grok-build/scripts/lib/prompts.mjs";
import {
  FINAL_REPORT_CLOSE,
  FINAL_REPORT_OPEN
} from "../plugins/grok-build/scripts/lib/stream-events.mjs";
import { RUN_PASSTHROUGH_FLAGS } from "../plugins/grok-build/scripts/grok-bridge.mjs";
import { PROVISION_LINK_DIRS } from "../plugins/grok-build/scripts/lib/provision.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

// A bare /--verify\b/ would give a false green: the word appears all over
// these files in prose that is NOT the backticked, forward-this-flag
// contract. Every drift guard below anchors on a leading backtick instead.
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

test("the README documents the Blender sandbox, including what it deliberately leaves alone", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  assert.match(readme, /`--blender-sandbox`/);
  assert.match(readme, /`--env KEY=VALUE`/);
  assert.match(readme, /BLENDER_USER_SCRIPTS/);
  // The two things a user cannot discover by running it: preferences survive
  // because BLENDER_USER_CONFIG is untouched, and nothing is auto-enabled, so a
  // test script that does not call addon_utils.enable finds no add-on at all.
  assert.match(readme, /BLENDER_USER_CONFIG/);
  assert.match(readme, /addon_utils\.enable/);
});

test("the README tells the truth about a conflicted land", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  // `git merge --abort` is the recovery every user reaches for and it exits
  // 128 here, because --squash writes no MERGE_HEAD.
  assert.match(readme, /rolls the repository\s+back to HEAD/i);
  assert.match(readme, /merge --abort` does not work here/);
  assert.match(readme, /--discard/);
});

test("the README says binaries are described rather than inlined into the prompt", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  assert.match(readme, /Binary files are described, never inlined/i);
  assert.match(readme, /## Binary Assets/);
  // The two bounds a user can actually be surprised by.
  assert.match(readme, /40 files and 64 KB/);
  assert.match(readme, /--prompt-file/);
});

test("the run-report contract ships as a loadable prompt template", () => {
  const template = loadPromptTemplate(PLUGIN_ROOT, "run-report");
  assert.ok(template.trim().length > 0, "prompts/run-report.md must not be empty");

  assert.match(template, new RegExp(FINAL_REPORT_OPEN));
  assert.match(template, new RegExp(FINAL_REPORT_CLOSE));
  for (const section of ["## Result", "## Files changed", "## Artifacts", "## Verification", "## Follow-ups"]) {
    assert.match(template, new RegExp(section), `the contract must name ${section}`);
  }
  // The two behaviours the reported bug is made of: an answer that only exists
  // as a file, and a failed run that says nothing at all.
  assert.match(template, /not only into a file|only in a file/i);
  assert.match(template, /even when the task failed/i);

  // It has no interpolation variables: there is no per-run value to fill in, so
  // an unreplaced {{TOKEN}} would reach the model verbatim.
  assert.doesNotMatch(template, /\{\{[A-Z_]+\}\}/);
});

test("the run-report contract survives the Windows cmd.exe shim", () => {
  // It travels in argv on --rules. On Windows an npm-installed grok is a .cmd,
  // which which.mjs routes through `cmd /d /s /c "<line>"` - and cmd still
  // expands `%VAR%` and re-reads `<`, `>`, `&`, `^`, `|` in there. Angle-bracket
  // tags (the shape prompts/critique.md uses, which never goes through that
  // path) would come back mangled, which is why this file is plain ASCII.
  const template = loadPromptTemplate(PLUGIN_ROOT, "run-report");

  for (const char of ["<", ">", "%", "&", "^", "|", '"']) {
    assert.ok(!template.includes(char), `run-report.md must not contain ${char}`);
  }
  // Non-ASCII would depend on the console code page too.
  assert.doesNotMatch(template, /[^\x20-\x7e\r\n\t]/, "run-report.md must be printable ASCII");
});

test("the docs explain why a delegate run used to look like it returned nothing", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  // The root cause, so nobody "simplifies" the contract away again.
  assert.match(readme, /only `text`, `thought` and `end` events/);
  assert.match(readme, /--rules/);
  assert.match(readme, new RegExp(FINAL_REPORT_OPEN));
  // The two failure modes the release fixes.
  assert.match(readme, /not\*{0,2} only into a file/i);
  assert.match(readme, /Grok did not return a final message/);

  const skill = read("skills/grok-run-output/SKILL.md");
  assert.match(skill, /## Artifacts/, "artifact paths are the deliverable for Godot and Blender");
  assert.match(skill, /do not invent one/i);
});

test("the docs promise a changed-files manifest, including for a run that changed nothing", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  assert.match(readme, /Changed files/);
  // The Godot import-cache case, which is where a silent result is most
  // confusing: the worktree is full of files and the commit is empty.
  assert.match(readme, /none \(run produced only excluded build artifacts\)/);
  // The non-isolated path cannot tell the user's in-flight edits from the
  // agent's, and has to say which is which rather than claim them all.
  assert.match(readme, /already dirty/i);
  assert.match(readme, /Log: <path>/);

  const skill = read("skills/grok-run-output/SKILL.md");
  assert.match(skill, /measured from git, not claimed by the model/);
  assert.match(skill, /showing raw stdout/);
});

test("every RUN_PASSTHROUGH_FLAGS entry is documented, backticked, on all three delegate surfaces", () => {
  // The env/Blender unit flagged this gap directly: --env and --blender-sandbox
  // reach the bridge's `run` command but nothing forwards them from
  // /grok-build:delegate, so a user typing either into a delegate request got
  // it folded into the prompt as prose. RUN_PASSTHROUGH_FLAGS is the single
  // source of truth for the full list (every flag this release added to the
  // delegate path, not only those two); this test is the contract that keeps
  // the three surfaces from drifting from it.
  const surfaces = [
    "commands/delegate.md",
    "agents/grok-delegate.md",
    "skills/grok-delegate-runtime/SKILL.md"
  ];
  assert.ok(RUN_PASSTHROUGH_FLAGS.length > 0, "RUN_PASSTHROUGH_FLAGS must not be empty");
  for (const surface of surfaces) {
    const source = read(surface);
    for (const flag of RUN_PASSTHROUGH_FLAGS) {
      assert.match(
        source,
        new RegExp("`" + escapeRegExp(flag)),
        `${surface} is missing a backticked mention of ${flag}`
      );
    }
  }
});

test("the delegate command no longer claims --max-duration is unshipped", () => {
  const delegate = read("commands/delegate.md");
  // Stale line: --max-duration already exists, so telling the agent it
  // "ships in 0.5.0" told it the flag does not exist yet.
  assert.doesNotMatch(delegate, /ships in 0\.5\.0/);
  assert.doesNotMatch(delegate, /no wall-clock cap until/);
  assert.match(delegate, /`--max-duration/);
});

test("the delegate argument-hint mentions the passthrough flags a user can type", () => {
  const delegate = read("commands/delegate.md");
  const frontmatterMatch = delegate.match(/^argument-hint:\s*"([^"]*)"/m);
  assert.ok(frontmatterMatch, "commands/delegate.md must declare argument-hint");
  const hint = frontmatterMatch[1];
  assert.match(hint, /--verify\b/);
  assert.match(hint, /--no-verify\b/);
  assert.match(hint, /--env\b/);
});

test("the README's linked-dirs paragraph does not drift from PROVISION_LINK_DIRS", () => {
  // Token-shaped drift guard scoped to the paragraph, not the whole file:
  // ".venv" is a substring of "venv", and "target"/"vendor"/".next" all occur
  // in ordinary prose elsewhere in this README.
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  const match = readme.match(
    /- \*\*Heavyweight directories are linked, not copied\.\*\*[\s\S]*?(?=\n- \*\*A worktree holds)/
  );
  assert.ok(match, "the linked-dirs paragraph must exist in the plugin README");
  const paragraph = match[0];
  assert.ok(PROVISION_LINK_DIRS.length > 0);
  for (const dir of PROVISION_LINK_DIRS) {
    assert.match(
      paragraph,
      new RegExp("`" + escapeRegExp(dir) + "`"),
      `linked-dirs paragraph is missing ${dir}`
    );
  }
});

test("the root README does not carry a stale hardcoded version line", () => {
  // bump-version.mjs's TARGETS covers three JSON files, not this prose line -
  // the marketplace manifest is the version's source of truth, so a hand
  // written "Version: X" here can only go stale.
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(readme, /^Version:\s*`/m);
});

test("the README documents the --env plaintext-in-job-file risk for a background run", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  assert.match(readme, /`--env`/);
  assert.match(readme, /<stateDir>\/jobs\/<run-id>\.json/);
  assert.match(readme, /plaintext/i);
  assert.match(readme, /--background/);
  assert.match(readme, /not\s+encrypted/i);
});

test("the README documents ecosystem recipes, the Windows console-exe pitfall, and the new env vars", () => {
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");

  assert.match(readme, /Ecosystem recipes/);
  assert.match(readme, /--headless --path \. --import/);
  assert.match(readme, /--no-window --path \. --editor --quit/);
  assert.match(readme, /extension validate/);

  assert.match(readme, /_console\.exe/);
  assert.match(readme, /GROK_BUILD_GODOT_BIN/);
  assert.match(readme, /GROK_BUILD_BLENDER_BIN/);
  assert.match(readme, /GROK_BUILD_LINK_GODOT_CACHE/);
  assert.match(readme, /GROK_VERIFY_MAX_OUTPUT_BYTES/);
  assert.match(readme, /GROK_BUILD_MIN_FREE_BYTES/);
});

test("the doctor and printUsage surfaces both name verify-plan as a read-only preview", () => {
  const bridge = read("scripts/grok-bridge.mjs");
  assert.match(bridge, /verify-plan \[--verify <command>\].*\[--no-verify\]/);
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, "README.md"), "utf8");
  assert.match(readme, /node scripts\/grok-bridge\.mjs verify-plan/);
});
