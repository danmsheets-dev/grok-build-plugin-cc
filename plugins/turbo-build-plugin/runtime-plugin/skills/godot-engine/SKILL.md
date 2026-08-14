---
name: godot-engine
description: Godot-specific facts for isolated grok-build runs (uids, caches, headless verify).
---

# Godot (grok-build)

## Source vs cache

- `.godot/` (Godot 4) and `.import/` (Godot 3) are **regenerable caches**. Never
  treat them as the deliverable; the bridge excludes them from commits.
- `*.uid` and `*.import` companion files are **source**. They carry the
  `uid://…` identity every `.tscn` / `.tres` `ext_resource uid=` line resolves
  through.
- If a `*.uid` is deleted, Godot 4.4+ regenerates it with a **new random** uid
  on next open. That silently breaks every existing `ext_resource` that pointed
  at the old id. Prefer restoring the file from git over letting the editor
  recreate it.

## Scenes and resources

- `.tscn` and `.tres` are structured text. Prefer surgical edits; do not rewrite
  whole scenes when a property change will do.
- `ext_resource` lines bind path + optional `uid="uid://…"`. Keep them aligned
  with the companion `*.uid` file for that resource.

## Headless verify (bridge-owned)

- **Never** run bare `godot --headless --path . --check-only` without
  `--script`. Godot's docs require `--check-only` with `--script`; without it
  the flag is inert and Godot boots `run/main_scene` headlessly **forever**.
- Bridge default (Godot 4):  
  `godot --headless --path . --script res://.grok/plugins/turbo-build-runtime/tools/grok_check.gd --quit`  
  walks `res://`, loads every `.gd` / `.gdshader` / `.tscn` / `.tres`, and
  quits with a real exit code.
- `godot --headless --path . --import` **exits 0 while printing**
  `SCRIPT ERROR:` / `Parse Error` / `SHADER ERROR:`. Exit code alone is not
  success; the bridge reads the output.
- Godot 3 uses `--no-window` instead of `--headless`.
- Never invent shell expansions like `${GODOT_BIN:-godot}` in commands.

## Editor contention

- The Godot editor locks and rewrites `.godot/` (including
  `global_script_class_cache.cfg`). Concurrent editor + headless import produces
  bogus parse errors on unmodified files. Close the editor before verify when
  the run reports a **shared** cache; private per-run caches skip that risk.
- `export_credentials.cfg` is machine-local secrets — never commit, never patch.
  `export_presets.cfg` is normal project source.
