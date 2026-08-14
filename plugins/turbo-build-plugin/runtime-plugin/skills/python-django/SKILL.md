---
name: python-django
description: Python and Django verify conventions for grok-build runs.
---

# Python / Django (grok-build)

## Interpreter

Prefer the project runner the bridge resolves — do not assume bare `python` on
PATH:

- `uv.lock` → `uv run …`
- `poetry.lock` → `poetry run …`
- `pdm.lock` → `pdm run …`
- `.venv` / `venv` → that environment's `python` (`Scripts\python.exe` on Windows)

## Django

When `manage.py` is present with settings or a Django dependency, verify order is:

1. `python manage.py check`
2. `python manage.py makemigrations --check --dry-run` (missing migration is the
   classic silent breakage)
3. `pytest` when configured, else `python manage.py test`

Honour `DJANGO_SETTINGS_MODULE` from the project's trusted env config when set.

## Linters

`ruff check` and `mypy` are only part of the plan when the project configures
them (`[tool.ruff]`, `ruff.toml`, `[tool.mypy]`, `mypy.ini`, …). Do not invent
lint failures as "required" when the project never opted in.
