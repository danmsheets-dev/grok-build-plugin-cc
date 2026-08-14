---
description: Show active and recent Grok Build runs for this repository
argument-hint: '[run-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" runs "$ARGUMENTS"`

If the user did not pass a run ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including run ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a run ID:
- Present the full command output to the user.
- Do not summarize or condense it.
