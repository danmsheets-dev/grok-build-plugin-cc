---
description: Delegate investigation, an explicit fix request, or follow-up work to the Grok Build delegate subagent
argument-hint: "[--background|--wait|--foreground] [--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [--verify <cmd>] [--no-verify] [--env KEY=VALUE] [--blender-sandbox|--no-blender-sandbox] [--godot-export-smoke] [--no-isolate] [--max-duration <s>] [what Grok should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `grok-build:grok-delegate` subagent via the `Agent` tool (`subagent_type: "grok-build:grok-delegate"`), forwarding the raw user request as the prompt.
`grok-build:grok-delegate` is a subagent, not a skill — do not call `Skill(grok-build:grok-delegate)` (no such skill) or `Skill(grok-build:delegate)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.
The final user-visible response must be Grok's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- **Default is background.** The Claude Code Bash tool hard-caps foreground work at ~10 minutes; real Grok runs are often 5–20 minutes. A killed wrapper used to report failure for a run that later succeeded. Unless the user passed `--wait` or `--foreground`, run the `grok-build:grok-delegate` subagent in the background and have it pass `--background` to the bridge.
- If the request includes `--background`, run the subagent in the background (same as the default).
- If the request includes `--wait` or `--foreground`, run the subagent in the foreground and do **not** pass bridge `--background`.
- After a background launch, the bridge stdout names the run id and log path. Follow up with:
  - `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" wait <id> --timeout <seconds>`
  - or `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" runs <id> --wait --timeout-ms <n>` then `show <id>`
- Pass `--max-duration <seconds>` if the caller wants a wall-clock cap on the run itself. That flag already exists and stops the run after the limit — it is not the same thing as Claude Code's own (separate, shorter) Bash-tool timeout, so do not treat one as a substitute for the other.
- `--background`, `--wait`, and `--foreground` are execution flags for Claude Code. Do not forward them to `run`, and do not treat them as part of the natural-language task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `run` call, but do not treat them as part of the natural-language task text.
- **Passthrough flags.** The user may type any of the following directly into `/grok-build:delegate`. Forward each one **verbatim** to the `run` invocation the subagent builds, and strip it out of the natural-language task text exactly like `--model`/`--effort` are already stripped — never fold one of these into prose:
  `--verify` (repeatable — forward every occurrence), `--verify-attempts`, `--verify-ignore` (repeatable), `--verify-timeout`, `--baseline-timeout`, `--verify-max-buffer`, `--no-verify`, `--no-verify-baseline`, `--env` (repeatable), `--blender-sandbox`, `--no-blender-sandbox`, `--godot-export-smoke`, `--no-isolate`, `--max-duration`, `--max-turns`, `--max-cost`. `--prompt-file` is deliberately **not** in this list: it is the subagent's own mechanism for delivering the task text (see below), not a flag a user types.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Grok, check for a resumable delegate thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" run-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Grok thread or start a new one.
- The two choices must be:
  - `Continue current Grok thread`
  - `Start a new Grok thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Grok thread (Recommended)` first.
- Otherwise put `Start a new Grok thread (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new thread, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Verification:

- Verification is automatic when a plan exists. The bridge resolves the verify plan itself, server-side, from `--verify` flags, then the project's `.grok-build.json`, then the detected ecosystem's defaults (Godot, Blender, Rust, Python, Node). The subagent does not construct `--verify` and must not make a second `Bash` call to look one up.
- A `.grok-build.json` can only contribute verify commands or tool paths after the user has trusted that file with `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" trust-config`. Until then those keys are withheld and the run says so.
- To see what would run without running it: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" verify-plan`. That is a user/debug aid, not a step the subagent performs.
- Pass `--no-verify` only when the user explicitly asks for no verification.

Operating rules:

- The subagent is a thin forwarder only. It should use one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" run ...` and return that command's stdout as-is.
- The subagent must NOT embed the raw task text inside a double-quoted shell string. Task text may contain backticks or `$(...)` (including when quoted from a file, issue, or PR) and would execute if re-parsed by the shell. Prefer writing the task to a temp file and passing `--prompt-file` (the bridge supports this), or piping on stdin. Never hand-build `run "…task…"`.
- Return the Grok bridge stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/grok-build:runs`, fetch `/grok-build:show`, call `/grok-build:stop`, summarize output, or do follow-up work of its own. The main thread may wait with `wait <id>` / `runs <id> --wait` after a background launch.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `run` command.
- If the helper reports that Grok is missing or unauthenticated, stop and tell the user to run `/grok-build:check`.
- If the user did not supply a request, ask what Grok should investigate or fix.
