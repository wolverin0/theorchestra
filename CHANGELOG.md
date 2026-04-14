# Changelog

All notable changes to clawfleet are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.3.0] - 2026-04-14

### Added — ops & observability

- **`src/diff-reporter.cjs`** — compact post-session-completed git-stat summary. Returns `{ summary, files, top, html, plain, branch, clean }` or `null` when there are no tracked changes. Designed for OmniClaude to post "what just changed?" to the pane's Telegram topic after a `session_completed` event. CLI mode: `node src/diff-reporter.cjs [cwd] [--json]`. Read-only.
- **`src/ntfy-notifier.cjs`** — [ntfy.sh](https://ntfy.sh) backup push notification channel. `isEnabled()` returns false when `NTFY_TOPIC` is unset so callers can always-call. Supports public ntfy.sh + self-hosted + token-authenticated instances. 80 LOC, Node stdlib only.
- **`ecosystem.config.cjs`** — PM2 production supervisor config. Two apps: `clawfleet-streamer` (telegram-streamer.cjs) + `clawfleet-dashboard` (dashboard-server.cjs). Watcher stays under OmniClaude's Monitor tool by default (commented config template included).

### Documented

- `docs/features/diff-reporter.md` — OmniClaude Event Reaction Tree integration + rate-limit/filter heuristics (skip trivial edits).
- `docs/features/ntfy-and-pm2.md` — ntfy setup (public / self-hosted / authenticated), PM2 commands, rationale for keeping OmniClaude itself outside PM2.

### Env vars

- `NTFY_TOPIC` (enables ntfy), `NTFY_SERVER` (default `https://ntfy.sh`), `NTFY_TOKEN` (optional bearer).

## [1.2.0] - 2026-04-14

### Added — new wezbridge MCP tools (6)

- **`split_pane(pane_id, direction?, cwd?, program?, args?)`** — side-by-side or top/bottom split without auto-launching Claude. Opens a shell / Codex / any program next to an existing session.
- **`set_tab_title(pane_id, title)`** — live rename a WezTerm tab. Best practice for multi-pane projects: `<project>-<agent>` (e.g. `app-codex`, `app-claude`).
- **`spawn_ssh_domain(domain, cwd?, program?, args?)`** — spawn a pane on a pre-configured WezTerm SSH domain. Run remote Claude/Codex sessions that local OmniClaude can still `send_prompt` / `read_output` / `kill_session` through.
- **`list_workspaces`** — enumerate WezTerm workspaces and the panes in each.
- **`switch_workspace(name)`** — activate a workspace (creates if missing).
- **`spawn_in_workspace(workspace, cwd?, program?, args?)`** — create a new pane directly in a named workspace. Useful for grouping peer panes by project.

### Documented

- `docs/features/split-workspace-remote.md` — `/split`, `/rename`, `/remote` Telegram command handlers for OmniClaude, plus recommended worktree flow for multi-pane peer projects on shared repos.
- `docs/features/workspaces.md` — `/workspace` command, WezTerm version compatibility caveats, when-to-use `workspaces` vs `split_pane`.

### Compatibility

- Running Claude Code sessions must reload the `wezbridge` MCP server to see the new tools.
- Some older WezTerm versions may not support all workspace operations — `list_workspaces` is widely supported, `switch_workspace` / `spawn_in_workspace` need recent WezTerm.

## [1.1.0] - 2026-04-14

### Added

- **Desktop dashboard** (Vite + React + TypeScript strict) — pane grid view, live SSE event stream from `omni-watcher.cjs`, active_tasks panel, action buttons (Prompt / Enter / Y / Kill).
- **`src/dashboard-server.cjs`** — ~200 LOC Node-stdlib HTTP + SSE backend. Endpoints: `GET /api/panes`, `GET /api/panes/:id/output`, `GET /api/tasks`, `GET /api/events` (SSE), `POST /api/panes/:id/prompt|key|kill`, `POST /api/spawn`. Also serves the built SPA from `dashboard/dist/`.
- **`dashboard/`** — Vite + React app. Dev: `npm run dev` proxies `/api` to `:4200`. Prod: `npm run build` emits `dashboard/dist/` which the backend serves directly.
- Dark terminal-native theme, snake_case pane shape matching wezbridge MCP contract.

### Not yet in this release
- A2A pending-corr panel (needs watcher-side state export)
- Claims feed (MemoryMaster MCP integration)
- Permission-prompt inline approve/reject buttons (upstream plugin patch required)
- Auth (assumes localhost-only)

## [1.0.0] - 2026-04-14

Initial public release as `clawfleet`. Forked in spirit (not in history) from [wolverin0/wezbridge v3.1](https://github.com/wolverin0/wezbridge) — substrate shared, coordination philosophy replaced.

### Agent-centric orchestration

- **OmniClaude orchestrator** — a persistent Claude Code session is the coordinator, not a Node bot. It discovers panes, watches events, reacts to Telegram, and dispatches A2A messages to peers.
- **Peer-to-peer A2A protocol** — any Claude/Codex pane can send a structured envelope to any other pane via `wezbridge` MCP. Envelopes are `corr`-threaded and carry `request` | `ack` | `progress` | `result` | `error` semantics.
- **Push-vs-watch asymmetry** — responders MUST push `type=progress` every ~3 min and `type=result` on completion (because Codex has no `Monitor` tool, so responders can't assume the requester is watching).
- **Three orchestration layers** — subagent (in-process) vs peer pane same-project vs peer pane cross-project. Agents reading the global instruction files know when to pick which.

### Crash detection & resilience

- **`peer_orphaned` events** — `omni-watcher.cjs` parses A2A envelopes in pane output, tracks pending exchanges by `corr`, and emits a P1 event when a pane dies with unresolved A2A. OmniClaude consumes the event and notifies the surviving peer.
- **`session_stuck` detection** — activity-based hashing of pane output distinguishes "working but silent" from "truly stuck". Configurable threshold.
- **Graceful watcher re-launch** — monitors emit `relaunch_me` at the 55-min mark so OmniClaude re-spawns them before the Monitor-tool 1h hard timeout.

### Telegram live feed

- **One editable message per pane per topic** — `editMessageText` keeps a single live tail in view; doesn't spam the topic with new messages.
- **Auto-topic creation** — new projects get their own forum topic the first time a pane appears there (via `createForumTopic`). Persisted to `~/.omniclaude/telegram-topics.json`.
- **Dense view** — chrome stripping removes status bar, `Ctx:`, spinner lines, box-drawing, ceremonial tool-call acks; long ⎿ tool-result blocks (>3 lines) collapse to a one-line summary + preview. The 40-line live window survives long `ingest_claim` or `query_memory` outputs.
- **Pane identity header** — `[project · agent-model]` (e.g. `[memorymaster · claude-opus]`), disambiguated to `[project-agent · model]` when ≥2 panes share the same project (e.g. `[app-codex · gpt5]` vs `[app-claude · opus]`).
- **User-supplied pane aliases** — `~/.omniclaude/pane-aliases.json` overrides auto-detection, hot-reloaded.

### Active tasks durability

- **`active_tasks.md`** is the single source of truth for in-flight work. Format: `## T-NNN · Title` + fenced YAML block per task.
- **`tasks-watcher.cjs`** emits `task_added`, `task_status_changed`, `task_stuck`, `followups_pending`, `tasks_file_updated`.
- **Contract**: no task without an entry, report = close, read before reply, signals are priority.

### Safety rails

- **`scripts/commit-guard.js`** — PreToolUse hook + git pre-commit hook. Blocks on `main`: ≥4 staged files, infra files (`.env`, `package.json`, docker*, nginx*, *.yml, …), new files, destructive flags (`--no-verify`, `reset --hard`, `push --force`, `rm -rf`, `drop`), cross-module commits. Any non-`main` branch allows everything.
- **No hardcoded secrets** — env-var-only.
- **No silent file corruption** — shared-repo safety recommends `git worktree add` for multi-pane projects and `| owns=<subdir>/` envelope declaration as fallback.

### Known limits (deferred, not blockers)

- **Heartbeat enforcement** — rule exists, no watcher-side silent-peer flag yet.
- **Envelope validation** — malformed envelopes are ignored silently rather than surfaced to the sender.
- **Worktree init script** — shared-repo worktree is recommended, not scripted.
- **Dashboard** — no desktop UI yet (Phase 2).
- **v3.1 features** — permission buttons, voice prompts, project scanner, plugins, /split/workspace/remote, code diffs, GitHub webhooks, PM2, inline mode, ntfy — all on the Phase 3 roadmap.

### Compatibility note

The MCP namespace is **`wezbridge`** (not `clawfleet`) to match the tool name agents call (`mcp__wezbridge__*`). The project is called clawfleet; the MCP tool stays `wezbridge` for backward compatibility with any existing Claude Code sessions that already have it registered.

---

## Pre-v1.0

Pre-rebrand iteration happened in `wolverin0/wezbridge` (v1–v3.1). That repo remains as the historical artifact of the bot-centric architecture and is not part of this changelog.
