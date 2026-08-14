---
description: Stop an active background Grok Build run in this repository
argument-hint: '[run-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" stop "$ARGUMENTS"`
