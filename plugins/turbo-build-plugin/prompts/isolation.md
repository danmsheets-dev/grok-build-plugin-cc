Isolation contract for this run.

The absolute worktree path below is the only writable root for this run.
Every edit, write, notebook change, and shell redirection must land under it.
Work written anywhere else does not count, is not verified, and is reported as
an isolation breach.

Worktree (writable root): {{WORKTREE_PATH}}
Main checkout (off-limits): {{WORKSPACE_ROOT}}

Any absolute path in the task text that starts with the main checkout path
refers to the corresponding path **inside the worktree**. Resolve it there —
do not open or edit the main checkout path itself.

The bridge snapshots the main checkout before and after this run. Newly dirty
paths under the main checkout are a breach: status `isolation-breached`, never
`completed`, never `Verified: yes`.
