---
name: turbo-delegate-runtime
description: Internal helper contract for calling the Turbo Build Plugin bridge runtime from Claude Code
user-invocable: false
---

# Turbo Build Plugin Delegate Runtime

Use this skill only inside the `turbo-build-plugin:turbo-delegate` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" run --prompt-file <temp-file> [flags]`

Why `--prompt-file` (not an inline quoted string):
- Task text may itself be read from an untrusted source (a file, issue, or PR the agent looked at).
- If that text is interpolated into a hand-built shell string inside double quotes, backticks and `$(...)` are re-parsed by the shell and execute as commands.
- The bridge already supports `--prompt-file` and stdin via `readTaskPrompt`. Prefer those over embedding the prompt in the argv string.

Safe invocation pattern:
1. Write the preserved task text (routing flags stripped) to a temporary file using a mechanism that does not shell-expand the body (Write tool, or a here-doc / redirected write that does not expand the task).
2. Invoke once: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" run --prompt-file /path/to/task-prompt.txt --write --background` plus any other bridge flags.
3. Never build the Bash command by directly embedding the task text inside double quotes in a hand-written shell string.
4. Optional equivalent: pipe stdin (`node ... run --write --background < task-prompt.txt`).

Forbidden:
- `node ... run "user task with $(rm -rf /) and \`id\`"`
- Any hand-rolled shell string that places the raw task body between quotes on the command line.

Execution rules:
- The delegate subagent is a forwarder, not an orchestrator. Its only job is to invoke `run` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct Grok CLI strings, or any other Bash activity.
- Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop` from `turbo-build-plugin:turbo-delegate`.
- Use `run` for every delegate request, including diagnosis, planning, research, and explicit fix requests.
- Default to `--model grok-4.6 --effort xhigh` (Extra High Effort) unless the user explicitly requests a different model or effort.
- Default to a write-capable Grok run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.

Command selection:
- Use exactly one `run` invocation per delegate handoff.
- **Always add `--background` unless the user explicitly asked for a foreground run** (`--foreground` or `--wait` on the command). Why: Claude Code's Bash tool hard-caps foreground at ~10 minutes; real Grok runs routinely take 5–20 minutes. A wrapper killed at the ceiling used to report failure for a run that later succeeded. Background returns immediately with the run id and log path — return that stdout unchanged so the main thread can wait.
- Follow-up (for the main Claude thread, not this subagent): `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" wait <id> --timeout <seconds>` (or `runs <id> --wait --timeout-ms <n>`) then `show <id>`.
- If the forwarded request includes `--model`, pass it through to `run`.
- If the forwarded request includes `--effort`, pass it through to `run`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `run --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `run`, even if the request sounds like a follow-up.
- `--effort`: accepted values are the full Hyper ladder `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. Unknown values are warned and passed through to the CLI (the bridge is not the authority that refuses a new tier).
- `run --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous delegate run.

Passthrough flags (forward verbatim, never fold into the task text):
- `--verify` (repeatable — forward every occurrence), `--verify-attempts`, `--verify-ignore` (repeatable), `--verify-timeout`, `--baseline-timeout`, `--verify-max-buffer`, `--no-verify`, `--no-verify-baseline`, `--env` (repeatable), `--blender-sandbox`, `--no-blender-sandbox`, `--godot-export-smoke`, `--no-isolate`, `--max-duration`, `--max-turns`, `--max-cost`.
- Strip each one out of the preserved task text before writing it to the prompt file, exactly like `--model`/`--effort`/`--resume`/`--fresh` are already stripped.
- `--prompt-file` is not on this list — it is the delivery mechanism for the task text itself, not a flag a user types into a delegate request.

Verification (the bridge handles it; do not construct it yourself):
- The bridge resolves the verify plan server-side and runs the commands itself. Do not add `--verify`, do not call `verify-plan`, and do not make a second Bash call to work out what should be verified.
- Game engines are the one place where a passing exit code is not evidence. `godot --headless --import` prints `SCRIPT ERROR:` for a GDScript that does not parse and exits **0**; `blender -b --python x.py` exits **0** when the script raises. The bridge scans output for those markers, so a run reported `completed-unverified` on an exit-0 command is correct, not a bridge bug — return it unchanged.
- If a user explicitly supplies a Blender verify command, the honest form passes `--python-exit-code` so a raising script also fails the process:
  `blender --background --factory-startup --python-exit-code 1 --python tests/run_tests.py`
  `--factory-startup` disables every installed add-on, including the one under test, so the script must call `addon_utils.enable("<module>", default_set=False, persistent=True)` itself.

Safety rules:
- Default to write-capable Grok work in `turbo-build-plugin:turbo-delegate` unless the user explicitly asks for read-only behavior.
- Preserve the user's task text as-is apart from stripping routing flags (deliver via `--prompt-file` or stdin, never shell-interpolated).
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, stop runs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `run` command exactly as-is.
- If the Bash call fails or Grok cannot be invoked, return nothing.
