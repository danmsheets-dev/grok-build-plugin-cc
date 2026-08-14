---
description: Import the current Claude Code session into a resumable Grok session
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" import "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Grok session ID and the resume command (`turbo -r <session-id>` or whatever binary the bridge resolved).
