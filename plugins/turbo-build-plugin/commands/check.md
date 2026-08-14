---
description: Check whether the local Grok Build CLI is ready for the Claude Code bridge
argument-hint: ''
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" check --json $ARGUMENTS
```

If the result says Grok is unavailable:
- Do not invent an install path. Report the `fix` text the bridge returns verbatim — it already names the binary that was actually tried (`turbo` preferred, then `grok`, or whatever `GROK_BINARY` selected). Do not tell the user to install Grok Build when they deliberately configured a different CLI.
- Then rerun `/turbo-build-plugin:check` after they install it.

If Grok is already installed:
- Do not ask about installation.

Output rules:
- Present the final check output to the user.
- If Grok is installed but not authenticated, preserve the guidance to authenticate (for example complete login via interactive `grok`, then verify with `grok models`).
