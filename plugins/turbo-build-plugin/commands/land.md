---
description: Review an isolated delegate run's diff, then merge it into your working tree or discard it
argument-hint: '[run-id] [--discard] [--force]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Land the changes from an isolated Grok Build delegate run.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command moves the agent's work into the user's working tree. That is the one
  irreversible-feeling step in the whole plugin, so never do it without showing the
  diff first.
- Do not edit any file yourself. Your job is to show the change and run the bridge.

Flow:

- If the arguments include `--discard`, do not ask. Run the discard directly:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" land "$ARGUMENTS"
```

- Otherwise, first show the user what would land (read-only preview — no merge):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-bridge.mjs" land "$ARGUMENTS --preview --json"
```

- If that reports an error, return the error verbatim and stop. One error is expected
  and is not a bug: the run has no worktree, meaning it ran without isolation (or was
  already landed or discarded earlier).
- Otherwise use `AskUserQuestion` exactly once with two options:
  - `Apply to my working tree (Recommended)`
  - `Discard the run`
- On apply, run the bridge `land` without `--preview` and without `--discard`. On discard,
  re-run it with `--discard`.
- **The dirty-working-tree check only runs on the apply step, never during `--preview`.**
  `--preview` is read-only and returns before that check exists in the code at all — the
  diff can be shown even with a dirty tree. If apply then reports the tree is dirty, tell
  the user to commit or stash first and stop; do not retry with `--discard`.

After a successful apply:

- Tell the user the changes are **staged, not committed**, and that they can review with
  `git diff --cached` before committing.
- Do not commit on their behalf.

Notes:

- `land` squash-merges the run branch, so the whole delegation arrives as one staged
  change rather than the agent's intermediate commits.
- The worktree and its branch are removed afterwards either way.
- Only runs started with isolation have a worktree. A run started with `--no-isolate`
  edited the working tree directly and has nothing to land.
- Always pass `--preview` for the first read-only step. Without it, `land` performs the
  squash-merge immediately.
- Land refuses more than 50 files. If the user asked to land a large isolated run,
  add `--force` on the apply step only (never on `--preview`).
- Isolation harness paths (`.grok-subagent-live`, `.grok/`) are ignored; they are
  not payload.
