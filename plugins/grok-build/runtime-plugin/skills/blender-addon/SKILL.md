---
name: blender-addon
description: Blender add-on/extension facts for isolated grok-build runs.
---

# Blender (grok-build)

## Headless form that is honest

The only reliable headless invocation the bridge uses:

```text
blender --background --factory-startup --python-exit-code 1 --python <script>
```

- `--python-exit-code 1` turns an **uncaught** Python exception into a non-zero
  exit. Without it Blender exits 0 and the failure is invisible. A unittest
  runner that collects failures and returns normally still exits 0 — the
  bridge wraps test scripts in a shim that forces `sys.exit(1)` on a red
  `TestResult`.
- `--factory-startup` disables **every** installed add-on, including the one
  under test. The test script must enable it **and check the return value**:
  `addon_utils.enable` wraps `register()` in try/except, prints the traceback,
  and **returns `None` without re-raising**. Ignoring the return verifies green
  on a broken add-on.

```python
import addon_utils, sys
mod = addon_utils.enable("<module>", default_set=False, persistent=True)
if mod is None:
    sys.exit("enable() returned None: register() raised, see traceback above")
```

## Add-on directory control

- There is no CLI flag for "use this add-on directory". The only lever is
  `BLENDER_USER_SCRIPTS` (and `BLENDER_USER_EXTENSIONS`). Isolated runs point
  these at a worktree-private sandbox so the headless process does not load the
  developer's real `scripts/addons` symlink into the main checkout.
- Do not set `BLENDER_USER_CONFIG` in test scripts: that drops the user's
  preferences and forces CPU Cycles.

## Files

- `.blend` is **binary**. Never text-patch it. Prefer Python via `bpy` or the
  user's existing test entry point (`tests/run_tests.py` / `tests/run.py`).
- Close Blender before verify if a `.blend` is open (Windows lock / `.blend@`
  sibling). A locked scene fails for an environment reason, not an agent bug.

## Extensions (4.2+)

- `blender_manifest.toml` marks a 4.2+ extension. The bridge may run
  `blender --command extension validate <path>` and checks
  `blender_version_min` against the binary before a doomed run.
