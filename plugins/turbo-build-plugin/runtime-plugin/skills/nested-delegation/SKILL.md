---
name: nested-delegation
description: When and how to hand a sub-task to another Hyper run via delegate_* tools.
---

# Nested delegation

This isolated run may expose MCP tools: `delegate_run`, `delegate_status`,
`delegate_wait`, `delegate_result`, `delegate_land`, `delegate_stop`. They start
a **sibling** Hyper run (its own worktree and branch), not an in-process
subagent. Use them for real sub-tasks; do not use them as a fancy function call.

## When to delegate

- The work is **substantial** (many files, a multi-step verify loop, or a
  clearly separable module) and you would otherwise burn many turns on it.
- The sub-task is **separable**: it does not need your uncommitted half-edited
  state in this worktree (children start from the parent's base commit).
- You are willing to **read the structured result** and decide whether to land.

## When not to delegate

- A couple of tool calls would finish it — just do the work.
- You need the child's edits interleaved with yours in the same tree right now.
- You are already near the nest depth or fan-out limit (see the run header
  `Nested delegation:` line). Starting another child will be refused, not queued.
- You plan to ignore the child's report. Always call `delegate_result` (or
  `delegate_wait`) and read status / changed files / final report before
  claiming the sub-task succeeded.

## How to land nested work

1. Wait until the child is terminal (`delegate_wait` or poll `delegate_status`).
2. Read `delegate_result` — a non-`completed` status is not success.
3. Call `delegate_land` only when you want the child's branch merged into
   **this** worktree. It never auto-lands.
4. Your own later `/land` (or parent land) still has to bring this worktree into
   the main checkout.

## Limits (bridge-enforced)

- Depth: `GROK_BUILD_MAX_NEST_DEPTH` (default 2).
- Fan-out: `GROK_BUILD_MAX_NEST_CONCURRENCY` live children per parent (default 2).
- Budgets: child cannot exceed the parent's remaining `--max-cost` /
  `--max-duration` / `--max-turns`.
- Disable entirely with `GROK_BUILD_NESTED_DELEGATION=0`.
