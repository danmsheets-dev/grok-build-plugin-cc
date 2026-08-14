---
name: node-workspace
description: Node/TypeScript package-manager and workspace facts for grok-build.
---

# Node / TypeScript (grok-build)

## Package manager

Use the lockfile / `packageManager` field the project already chose:

- `pnpm-lock.yaml` → `pnpm test`
- `yarn.lock` → `yarn test`
- `package-lock.json` / default → `npm test`
- `bun.lock` / `bun.lockb` → `bun test`

## Tests and types

- Prefer `scripts.test` when it is real (not npm's `no test specified` placeholder).
- If `scripts.test` is absent, vitest/jest are only invoked when a config file
  and dependency prove the project uses them.
- `tsc --noEmit` is added only when `tsconfig.json` exists and TypeScript is a
  dependency.

## Workspaces

Run at the **workspace root**. Do not descend into every package with
`pnpm -r test` unless the user explicitly asked — root `scripts.test` is the
contract.
