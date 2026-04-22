"""Flask REST API for a todo app. In-memory, local-only dev server."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from itertools import count
from threading import Lock
from typing import Any

from flask import Flask, jsonify, request

app = Flask(__name__)
app.logger.setLevel(logging.INFO)

VALID_PRIORITIES = {"low", "medium", "high"}
VALID_STATUS_FILTERS = {"all", "active", "completed"}

_lock = Lock()
_id_seq = count(1)
_todos: dict[int, dict[str, Any]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_due_date(raw: Any) -> tuple[str | None, str | None]:
    if raw is None or raw == "":
        return None, None
    if not isinstance(raw, str):
        return None, "due_date must be an ISO-8601 string"
    try:
        datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None, "due_date must be a valid ISO-8601 datetime"
    return raw, None


def _serialize(todo: dict[str, Any]) -> dict[str, Any]:
    return dict(todo)


def _error(message: str, status: int = 400, **extra: Any):
    body = {"error": message, **extra}
    return jsonify(body), status


@app.after_request
def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,PUT,DELETE,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/<path:_any>", methods=["OPTIONS"])
@app.route("/", methods=["OPTIONS"])
def _preflight(_any: str = ""):
    return ("", 204)


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/todos")
def list_todos():
    status = (request.args.get("status") or "all").lower()
    priority = request.args.get("priority")
    query = (request.args.get("q") or "").strip().lower()

    if status not in VALID_STATUS_FILTERS:
        return _error(f"status must be one of {sorted(VALID_STATUS_FILTERS)}")
    if priority is not None and priority not in VALID_PRIORITIES:
        return _error(f"priority must be one of {sorted(VALID_PRIORITIES)}")

    with _lock:
        items = [_serialize(t) for t in _todos.values()]

    if status == "active":
        items = [t for t in items if not t["completed"]]
    elif status == "completed":
        items = [t for t in items if t["completed"]]
    if priority:
        items = [t for t in items if t["priority"] == priority]
    if query:
        items = [t for t in items if query in t["text"].lower()]

    items.sort(key=lambda t: t["id"])
    return jsonify({"items": items, "count": len(items)})


@app.post("/todos")
def create_todo():
    payload = request.get_json(silent=True) or {}
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        return _error("text is required and must be a non-empty string")

    priority = payload.get("priority", "medium")
    if priority not in VALID_PRIORITIES:
        return _error(f"priority must be one of {sorted(VALID_PRIORITIES)}")

    due_date, err = _parse_due_date(payload.get("due_date"))
    if err:
        return _error(err)

    now = _now()
    with _lock:
        new_id = next(_id_seq)
        todo = {
            "id": new_id,
            "text": text.strip(),
            "priority": priority,
            "due_date": due_date,
            "completed": False,
            "created_at": now,
            "updated_at": now,
        }
        _todos[new_id] = todo

    app.logger.info("todo.create id=%s priority=%s", new_id, priority)
    return jsonify(_serialize(todo)), 201


@app.patch("/todos/<int:todo_id>")
def update_todo(todo_id: int):
    payload = request.get_json(silent=True) or {}
    with _lock:
        todo = _todos.get(todo_id)
        if todo is None:
            return _error("todo not found", status=404, id=todo_id)

        if "text" in payload:
            text = payload["text"]
            if not isinstance(text, str) or not text.strip():
                return _error("text must be a non-empty string")
            todo["text"] = text.strip()

        if "priority" in payload:
            priority = payload["priority"]
            if priority not in VALID_PRIORITIES:
                return _error(f"priority must be one of {sorted(VALID_PRIORITIES)}")
            todo["priority"] = priority

        if "due_date" in payload:
            due_date, err = _parse_due_date(payload["due_date"])
            if err:
                return _error(err)
            todo["due_date"] = due_date

        todo["updated_at"] = _now()
        snapshot = _serialize(todo)

    app.logger.info("todo.update id=%s keys=%s", todo_id, sorted(payload.keys()))
    return jsonify(snapshot)


@app.delete("/todos/<int:todo_id>")
def delete_todo(todo_id: int):
    with _lock:
        removed = _todos.pop(todo_id, None)
    if removed is None:
        return _error("todo not found", status=404, id=todo_id)
    app.logger.info("todo.delete id=%s", todo_id)
    return jsonify({"deleted": todo_id})


@app.put("/todos/<int:todo_id>/complete")
def toggle_complete(todo_id: int):
    with _lock:
        todo = _todos.get(todo_id)
        if todo is None:
            return _error("todo not found", status=404, id=todo_id)
        todo["completed"] = not todo["completed"]
        todo["updated_at"] = _now()
        snapshot = _serialize(todo)
    app.logger.info("todo.toggle id=%s completed=%s", todo_id, snapshot["completed"])
    return jsonify(snapshot)


@app.get("/todos/stats")
def stats():
    with _lock:
        items = list(_todos.values())
    total = len(items)
    completed = sum(1 for t in items if t["completed"])
    by_priority = {p: 0 for p in VALID_PRIORITIES}
    for t in items:
        by_priority[t["priority"]] = by_priority.get(t["priority"], 0) + 1
    return jsonify({
        "total": total,
        "active": total - completed,
        "completed": completed,
        "by_priority": by_priority,
    })


@app.errorhandler(404)
def not_found(_e):
    return _error("route not found", status=404)


@app.errorhandler(405)
def method_not_allowed(_e):
    return _error("method not allowed", status=405)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
