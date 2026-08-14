Blender sandbox for this run (do not guess module names or paths).

Module to enable: `{{MODULE_NAME}}`
Add-on / extension package name: `{{ADDON_NAME}}`
4.2+ extension: {{IS_EXTENSION}}
`BLENDER_USER_SCRIPTS`={{BLENDER_USER_SCRIPTS}}
`BLENDER_USER_EXTENSIONS`={{BLENDER_USER_EXTENSIONS}}
Declared `blender_version_min`: {{BLENDER_VERSION_MIN}}
Manifest declares wheels: {{HAS_WHEELS}}

Honest headless form (always use these flags):

```text
blender --background --factory-startup --python-exit-code 1 --python <script>
```

Enable the sandboxed add-on and **check the return value**.
`addon_utils.enable` swallows `register()` exceptions and returns `None`:

```python
import addon_utils, sys
mod = addon_utils.enable("{{MODULE_NAME}}", default_set=False, persistent=True)
if mod is None:
    sys.exit("enable() returned None: register() raised or module missing")
```

Do not invent a different module name from `bl_info["name"]`, the worktree
basename (a run id), or a hyphenated repo name. Use exactly `{{MODULE_NAME}}`.
Do not set `BLENDER_USER_CONFIG` (drops user preferences / forces CPU Cycles).
