---
description: Reclaim abandoned runs and leftover worktrees (dry run by default)
argument-hint: '[--apply] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Reclaim Grok Build state left behind by runs that died or finished.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- `prune` changes state and removes worktrees. It is a **dry run unless `--apply` is
  passed**, and you must preserve that default.
- Never add `--apply` on the user's behalf without asking.

Flow:

- If the arguments already include `--apply`, the user has chosen. Run it directly.
- Otherwise run the dry run first and show the user exactly what it would do:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" prune "$ARGUMENTS"
```

- If it reports nothing to do, say so and stop. Do not ask a pointless question.
- If it lists items, use `AskUserQuestion` exactly once:
  - `Apply these changes`
  - `Leave everything as is (Recommended)`
- Only on `Apply these changes`, re-run the command with `--apply` added.

What it reclaims:

- **Abandoned runs** — status still says running, but the tracked process tree is gone.
  These are marked failed so they stop being reported as live.
- **Stale worktrees** — worktrees belonging to runs that have already finished.

Important: a worktree holds the only copy of an unlanded delegate run's work. If a run
has changes you still want, use `/grok-build:land` **before** pruning, not after. Say so
if any listed worktree belongs to a run that completed successfully.
