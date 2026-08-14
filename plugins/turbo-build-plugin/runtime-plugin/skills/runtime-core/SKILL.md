---
name: runtime-core
description: Per-run facts injected by grok-build into this isolated worktree.
---

# grok-build runtime pack

This skill tree was **copied** into `.grok/plugins/turbo-build-runtime/` for this
isolated run only. It is not part of the user's project. Do not edit it to "fix"
the repo; do not commit `.grok/`.

Verify commands run in the **bridge**, not in your shell. A run that did not
pass verification is never reported as success (`completed-unverified`).

When an ecosystem-specific skill is present next to this one (godot-engine,
blender-addon, python-django, node-workspace, rust-cargo), prefer those facts
over general knowledge — they encode failure modes the bridge already accounts
for.
