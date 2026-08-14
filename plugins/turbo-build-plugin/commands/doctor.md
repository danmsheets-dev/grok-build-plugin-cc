---
description: Diagnose the Grok Build environment and run state, with a suggested fix for each problem
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Diagnose the Grok Build install and its run state.

Raw slash-command arguments:
`$ARGUMENTS`

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" doctor "$ARGUMENTS"
```

Return the command stdout verbatim.

Rules:

- Do not fix anything yourself. `doctor` reports a suggested fix for each failing check;
  the user decides whether to run it.
- Do not paraphrase or summarise the report. The point of this command is that it states
  exactly what it checked and what it found.
- If a check reports abandoned runs or stale worktrees, the suggested fix is
  `/turbo-build-plugin:prune`. Mention that command, but do not run it — prune changes state.
- `doctor` reports only what it actually tested. Do not add claims about anything it did
  not check.
