"""Persistence layer for the todo CLI.

Todos are stored as a JSON array in ``todos.json`` in the current working
directory. Each todo has the shape ``{id, text, done, created_at}``. Writes
are atomic: we stage to a sibling tempfile and ``os.replace`` onto the target
so a crash mid-write cannot corrupt the store.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

STORE_FILENAME = "todos.json"


def _store_path() -> Path:
    return Path.cwd() / STORE_FILENAME


def load_todos() -> list[dict]:
    path = _store_path()
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path} must contain a JSON array, got {type(data).__name__}")
    return data


def save_todos(todos: list[dict]) -> None:
    path = _store_path()
    directory = path.parent
    fd, tmp_name = tempfile.mkstemp(prefix=".todos-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(todos, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except Exception:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise
