# Code Review — `frontend.html` + `backend.py`

## Summary

Reviewed a single-page vanilla-JS todo UI (`frontend.html`, 374 lines) and an
in-memory Flask REST API (`backend.py`, 211 lines) that are intended to be a
matched pair. The Flask API is reasonably structured (thread-safe dict, route
handlers, input validation on `priority` and `due_date`, 4xx error helper),
and the HTML is a clean, accessible SPA with theming, filters, search and
keyboard affordances. However, the two halves are **not actually wired
together** — the frontend persists everything to `localStorage` and never
performs a single `fetch()` call, and where the contracts *should* line up
(the `priority` enum in particular) they diverge silently. On top of that the
backend is configured with `debug=True` and wildcard CORS, which together are
unsafe even for a dev server.

## Security findings (8)

- **`app.run(..., debug=True)` at `backend.py:211` exposes the Werkzeug
  debugger.** If the server is ever bound to anything other than
  `127.0.0.1`, any HTTP request that triggers an exception hands the caller
  the interactive Werkzeug console, which is arbitrary code execution. The
  debug PIN is trivially derivable from machine metadata. Drop `debug=True`
  and gate it behind an env var (`FLASK_DEBUG`) that defaults to off.

- **`Access-Control-Allow-Origin: *` is set globally in `_cors`
  (`backend.py:48-53`)** for every route, every method, including
  state-changing verbs (`POST`, `PATCH`, `PUT`, `DELETE`). Combined with
  allowing `Content-Type`, any origin on the internet can mutate todos from
  a user's browser session. Since the API has no auth this is not credential
  theft per se, but it does mean every browser tab the user ever opens has
  full write access. Restrict to an explicit allow-list read from env, and
  drop the wildcard on mutating methods entirely.

- **No authentication or authorization on any route.** `GET /todos`,
  `POST /todos`, `PATCH /todos/<id>`, `DELETE /todos/<id>`,
  `PUT /todos/<id>/complete` and `/todos/stats` all accept anonymous
  requests. This is acceptable for a local-only dev server (the docstring
  says so) but `0.0.0.0` binding or a dev tunnel exposing port 5000 would
  turn this into a public, unauthenticated mutation surface. There is also
  no per-user scoping — every client sees every other client's data.

- **No request size limits.** `request.get_json(silent=True)` in
  `create_todo` (`backend.py:96`) and `update_todo` (`backend.py:129`) has
  no `MAX_CONTENT_LENGTH` cap. A single `POST /todos` with a 100 MB `text`
  field will be buffered into memory and then stored indefinitely in
  `_todos`. Set `app.config["MAX_CONTENT_LENGTH"] = 64 * 1024` or similar
  and also cap `len(text)` explicitly (e.g. ≤500 chars).

- **Error messages echo attacker-controlled enum values.** `_error(f"priority
  must be one of {sorted(VALID_PRIORITIES)}")` at `backend.py:76, 103, 144`
  is fine, but `_error("todo not found", status=404, id=todo_id)` at
  `backend.py:133, 165, 175` leaks the fact that numeric IDs are sequential
  (`count(1)`), which makes enumeration trivial. Either return a generic
  404 without the echoed `id`, or use opaque slugs/UUIDs (see Quality
  findings).

- **No CSRF protection on mutating routes.** Combined with the wildcard CORS
  above and the fact that preflight is blanket-allowed by `_preflight`
  (`backend.py:56-59`), a hostile page can trigger `PATCH /todos/<id>` as
  long as it sets `Content-Type: application/json`. Typical mitigations
  (same-site cookie + CSRF token, or requiring a custom header that forces
  preflight and then rejecting unknown origins) are all missing.

- **The frontend's `esc()` handles innerHTML injection, but nothing protects
  against prototype pollution via `JSON.parse(localStorage...)`** in `load()`
  at `frontend.html:213-216`. A malicious extension or prior XSS that
  planted `{"__proto__":{"done":true}}` into `todo.v1.items` would poison
  the `state.items` entries as they are re-read. Reject non-array roots
  explicitly and use `Object.create(null)` or `structuredClone` on untrusted
  shapes before merging.

- **`localStorage.setItem(STORAGE_KEY, JSON.stringify(...))` at
  `frontend.html:217` is unguarded.** If the user fills their quota (Safari
  default is 5 MB, private mode is ~0), `save()` throws and the UI silently
  loses data on the next render cycle. Wrap it in `try/catch` and surface an
  error to the user via `aria-live`.

## Quality findings (6)

- **Contract mismatch: `priority` enum diverges between the two files.**
  Backend `VALID_PRIORITIES = {"low", "medium", "high"}` at `backend.py:15`,
  but the frontend `<option value="med" selected>` at
  `frontend.html:171` (and the CSS badge class `.badge.med` at
  `frontend.html:121`) uses `"med"`. If anyone ever flips the frontend from
  `localStorage` to `fetch('/todos')`, every create and update with a medium
  priority will be rejected with `400`. Pick one — the spelled-out value
  is safer — and fix the CSS class + the `<option>` together.

- **The frontend and backend share no transport.** `frontend.html` never
  calls `fetch`, `XMLHttpRequest`, or `EventSource`. All state is in
  `state.items` and mirrored to `localStorage`. That makes `backend.py`
  dead code from the UI's perspective and means both halves are untested
  against each other. This is the single highest-leverage finding — the
  whole review hinges on it.

- **Sequential integer IDs (`_id_seq = count(1)` at `backend.py:19`) don't
  survive a restart and aren't safe under multi-worker deployment.**
  Running this under `gunicorn -w 4` would give four independent counters
  and four independent `_todos` dicts, producing duplicate IDs and sharded
  data. Use `uuid.uuid4().hex` like the frontend already does (`uid()` at
  `frontend.html:218`) and, longer term, a real store (SQLite at minimum).

- **`PATCH /todos/<id>` cannot toggle `completed`** — the handler
  (`backend.py:127-157`) accepts `text`, `priority`, `due_date` only, and
  the separate `PUT /todos/<id>/complete` endpoint is a bare *toggle* (line
  176: `todo["completed"] = not todo["completed"]`). That means a client
  cannot idempotently set `completed=true`; two racing clients each
  believing they're checking the box will cancel each other out. Either
  make `PATCH` accept a boolean `completed`, or change `PUT .../complete`
  to accept `{completed: bool}` rather than toggling.

- **`_serialize(todo)` at `backend.py:39-40` is `dict(todo)` — a shallow
  copy that re-exposes internal field names verbatim** (`created_at`,
  `updated_at`, `due_date`). There is no response schema, no version key,
  and no field filtering. The snake_case response will also conflict with
  the frontend's camelCase/short-form fields (`due`, `priority`, `done` vs.
  backend `due_date`, `priority`, `completed`). Introduce an explicit
  `to_public_dict(todo)` with the exact wire shape documented once.

- **Full DOM re-render on every mutation** (`render()` at
  `frontend.html:238-293` does `list.innerHTML = ''` then rebuilds every
  `<li>`). For the <50-item case this is fine, but it also destroys focus
  on any in-progress edit other than the currently edited item, and for a
  user with 500+ items on a slow device the 60fps budget will be gone.
  Consider keying items and diffing, or at least skipping re-render when
  only `state.query` changed by hiding/showing existing nodes via CSS.

## Recommended next actions (5)

1. **Reconcile the priority enum first.** Change `frontend.html:171` to
   `value="medium"`, rename `.badge.med` → `.badge.medium` at
   `frontend.html:121` and in the template literal at `frontend.html:271`.
   This is a one-line bug that will bite the moment the UI is wired to the
   API. No other refactor unblocks as much as this one.

2. **Turn off `debug=True` and tighten CORS before anything else touches
   the API.** Replace `backend.py:211` with
   `app.run(host="127.0.0.1", port=5000, debug=os.getenv("FLASK_DEBUG")=="1")`,
   and replace the blanket `Access-Control-Allow-Origin: *` in `_cors`
   with a single allowed origin read from `ALLOWED_ORIGIN`. Also drop the
   wildcard on `OPTIONS` for non-safelisted methods.

3. **Wire the frontend to the backend via a thin `api.js` module** — one
   `createTodo`, `listTodos`, `updateTodo`, `deleteTodo`, `toggleComplete`
   wrapper around `fetch`, keyed off a single `API_BASE` constant. Keep
   `localStorage` as an *offline cache* only, hydrated from the server on
   load. This also forces the schema mismatch (point 1) and the field-name
   mismatch (`done` vs `completed`, `due` vs `due_date`) to be resolved in
   one place.

4. **Replace the `count(1)` id generator with UUIDs and add a
   `MAX_CONTENT_LENGTH`.** This removes two whole classes of problem
   (enumeration + unbounded-memory-on-POST) with roughly ten lines of
   change and no behavior difference for the happy path. Swap
   `@app.route("/todos/<int:todo_id>")` to `<string:todo_id>` at
   `backend.py:127, 160, 170`.

5. **Add at minimum a `tests/` folder with `pytest` cases for
   `create_todo` happy path, `priority` rejection, `due_date` rejection,
   `404 on missing id`, and the CORS preflight.** The API is small enough
   that 60 lines of tests cover every branch, and they will catch the
   `medium`/`med` mismatch the moment the frontend starts calling it.

## Verdict

Solid day-one scaffolding on both sides. Biggest real risks are (a) the
silent enum mismatch that will detonate on integration, (b) debug mode +
wildcard CORS on the server, and (c) the fact that nothing currently
verifies the two halves agree. Fix the five items above and this is a
reasonable foundation to build on.
