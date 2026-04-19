# theorchestra

**Multi-agent orchestrator for Claude Code and Codex sessions, with WezTerm panes as the substrate.**

theorchestra lets you run many long-lived AI coding sessions in parallel — each in its own WezTerm pane — and gives them a shared protocol to talk to each other, a browser dashboard to steer them, intelligent session-reset when context fills up, domain-specialized personas, and a Telegram feed so you can read what they're doing from your phone.

```
     ┌──────────────────────────────────────────────────────────────────┐
     │                          WezTerm (mux)                           │
     │                                                                  │
     │  pane-6 OmniClaude    pane-2 coder       pane-3 reviewer         │
     │   (orchestrator) ──▶ (frontend lead)  ◀─▶ (plan-mode audit)      │
     │        ▲                  │                   │                  │
     │        │                  └── A2A envelope ───┘                  │
     │        │             via mcp__wezbridge__send_prompt             │
     │        │                                                         │
     │        │       dashboard @ :4200 (pane grid, 🔄 auto-handoff,    │
     │        │       Ctx badges, A2A flow, tasks panel, Agency spawn)  │
     └────────┼─────────────────────────────────────────────────────────┘
              │
              ├─ omni-watcher ─────▶ stdout events (session state + A2A)
              ├─ tasks-watcher ────▶ active_tasks.md signals (stuck / follow-ups)
              ├─ auto-handoff ─────▶ readiness check → /handoff → /clear → resume
              └─ telegram-streamer ▶ live feed per pane → Telegram topic
```

## What it looks like

**Dashboard** (`http://localhost:4200`) — live pane grid with Ctx badges, 🔄 handoff button per pane, Agency Mode spawn, A2A event stream, tasks panel:

![theorchestra dashboard](docs/screenshots/dashboard.png)

**Telegram feed** — one forum topic per project, live-edited message shows the pane's current output, auto-handoff orchestration + A2A envelopes visible inline:

![Telegram feed](docs/screenshots/telegram-feed.png)

## Why theorchestra is different

| | Bot-centric (typical Telegram-Claude bridges) | Agent-centric (theorchestra) |
|---|---|---|
| Coordinator | Node bot monolith | A real Claude Code session (`OmniClaude`) |
| Message passing | Bot → session, one direction | Peer ↔ peer via wezbridge MCP + envelope protocol |
| Multi-LLM | Single provider | Claude + Codex in the same swarm |
| Crash isolation | Bot crash = total outage | One pane dies, peers and orchestrator survive |
| State durability | In-memory | `active_tasks.md` + MemoryMaster claims |
| Personas | One generic assistant | 95+ domain-specialized agents (spawn any with `persona: "<name>"`) |
| Session lifecycle | Manual reset when ctx fills | Auto-handoff: readiness check → handoff file → /clear → fresh session resumes from the file |

theorchestra is for workflows where the AI sessions need to talk to each other, survive restarts, and keep working while you're asleep.

## What's new

**v2.5 — Agency Mode**
- Spawn panes with any persona from `~/.claude/agents/` via `mcp__wezbridge__spawn_session({cwd, persona, permission_mode, prompt})` or the dashboard's Spawn tab.
- 95+ specialised agents available (frontend-design, coder, reviewer, tester, backend-dev, security-auditor, devops-automator, etc.).
- Persona detection from tab titles — the dashboard shows a badge for each persona-spawned pane.
- Per-persona worktree isolation (`git worktree add`) so parallel agents don't collide.
- PRD-driven team bootstrap: one YAML file defines roles + tasks, and the dashboard spawns the whole team.

**v2.6 — Intelligent Auto-Handoff**
- Each pane's Ctx% is visible live in the dashboard (green < 30%, yellow 30–50%, red > 50%).
- Click 🔄 on any pane to trigger a graceful handoff: the pane self-reports READY/NOT_READY (the PRE-HANDOFF READINESS CHECK pattern — idle ≠ task-complete), writes a structured handoff file via the `/handoff` skill, gets `/clear`-ed, and the fresh session resumes from the handoff file.
- Auto-trigger mode (🤖 toggle) fires suggestions at Ctx > 30% and urgent countdowns at > 50%.
- Dashboard broadcasts these over SSE so auto-trigger notifications reach connected clients in real time.

**v2.7 — Hardening + performance (2026-04-19)**
- `WEZTERM_LOG=wezterm_mux_server_impl::local=off` env var silences wezterm's internal 10054 mux-disconnect error category (root cause of periodic crashes under sustained MCP load).
- In-process TTL caches on `listPanes()` (3s) and `getFullText()` (1.5s per pane) — multiple concurrent callers across services dedup to one actual `wezterm cli` spawn.
- Telegram streamer poll interval bumped 5s → 10s; dashboard auto-handoff daemon skips ticks when no SSE client connected. Combined impact: **~50% fewer `wezterm cli` spawns in steady state**.
- `scripts/start-telegram-streamer.cmd` + Startup folder stub for persistent streamer across reboots without admin privileges.
- `spawn_session` gained a `spawned_by_pane_id` param that auto-injects a `[PEER-PANE CONTEXT]` preamble so spawned personas know they're peer panes, not in-process subagents (bridges ~95 persona files written for the subagent API).
- Triple-redundant enter submission (`\r` sync + async setTimeout 250ms) on `send_prompt` and `spawn_session` to defeat wezterm's CLI enter-swallowing on Windows.

## Core pieces

| File | What it does |
|------|--------------|
| `src/mcp-server.cjs` | MCP server exposing `wezbridge` tools (`discover_sessions`, `send_prompt`, `send_key`, `read_output`, `spawn_session`, `kill_session`, `auto_handoff`, `split_pane`, …) |
| `src/wezterm.cjs` | Wrapper around `wezterm cli` with TTL caches — pane spawning, text injection, scrollback reads, socket discovery |
| `src/pane-discovery.cjs` | Claude/Codex pane detection, status classification (idle / working / permission / stuck), Ctx% + persona + model extraction |
| `src/omni-watcher.cjs` | Event stream over `Monitor`: session state changes, metrics, A2A envelope tracking, `peer_orphaned` emission on crash |
| `src/tasks-watcher.cjs` + `src/task-parser.cjs` | Watches `active_tasks.md` for follow-ups, stuck tasks, status transitions |
| `src/telegram-streamer.cjs` | Streams each pane's live output to a Telegram forum topic. Three modes (`raw` default, `card`, `events`) via `STREAMER_MODE` env var |
| `src/dashboard-server.cjs` | HTTP server on :4200 — serves the single-file dashboard, handles `/api/panes`, `/api/auto-handoff/:id`, SSE events stream, Agency Mode endpoints |
| `src/dashboard.html` | Single-file vanilla-JS dashboard: Sessions / Live / Desktop / Spawn tabs, activity sidebar, Ctx badges, 🔄 handoff button + modal, auto-handoff mode toggle |
| `scripts/commit-guard.js` | PreToolUse + git pre-commit hook that blocks risky commits on `main` |
| `scripts/omniclaude-forever.sh` | Launches OmniClaude + streamer together with auto-restart on timeout |
| `scripts/start-telegram-streamer.cmd` | Standalone persistent streamer launcher — register in Windows Startup folder for auto-start at user logon |

## A2A protocol at a glance

Every peer-to-peer message uses an envelope header, parseable by regex, threadable by `corr`:

```
[A2A from pane-<N> to pane-<M> | corr=<id> | type=request|ack|progress|result|error]
<body>
```

Hard rules (mandatory for every Claude/Codex session):

1. **Always follow `send_prompt` with `send_key("enter")`.** Enter after typing is unreliable on Windows even with the triple-redundant retry — belt-and-suspenders wins.
2. **Never send bash via `send_text` into a running TUI.** Your text becomes a user prompt, not a shell command.
3. **Every responder MUST push** `type=progress` every ~3 min during long work and `type=result` on completion. Codex cannot `Monitor`; Claude can.
4. **Before spawning a peer, declare your coordinator role** — `parallel-worker` / `qa-verifier` / `pre-stager` / `monitor-only`. "parallel" ≠ "delegated"; if you'll be idle while the peer runs, do the work in-session instead.

Full spec in [`docs/a2a-protocol.md`](docs/a2a-protocol.md).

## Three orchestration layers

Agents reading their global instructions (`~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`) learn when to pick what:

| Layer | Cost | Lifetime | Use for |
|---|---|---|---|
| Subagent (in-process) | cheap | dies with parent | tight loop, one-turn fan-out |
| Peer pane (same project) | medium | survives parent | long work, cross-LLM, resilience |
| Peer pane (cross-project) | medium | survives | ask another project's specialist |

## Quick start

**Prerequisites:**
- [WezTerm](https://wezfurlong.org/wezterm/) with mux server enabled
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- (Optional) [Codex CLI](https://github.com/openai/codex) for cross-LLM swarms
- Node.js 18+
- A Telegram bot token + a group with **Topics enabled** (for the streamer)

**Install:**
```bash
git clone https://github.com/wolverin0/theorchestra.git
cd theorchestra
npm install
cp .env.example .env     # edit with your bot token + group ID
```

**Register the MCP server** (global, so every Claude Code session can use it):
```bash
claude mcp add wezbridge --scope user -- node $(pwd)/src/mcp-server.cjs
```

**Set the crash-prevention env var** (Windows):
```powershell
[Environment]::SetEnvironmentVariable('WEZTERM_LOG','wezterm_mux_server_impl::local=off','User')
```
Then restart WezTerm so the new instance inherits it. This silences the internal 10054 error category that otherwise accumulates to MB-sized log files under sustained MCP load.

**Launch the orchestrator + streamer** (OmniClaude + live Telegram feed together):
```bash
bash scripts/omniclaude-forever.sh
```

Or if you want just the streamer (standalone, persistent):
```cmd
scripts\start-telegram-streamer.cmd
```
Copy the same `.cmd` into `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\` for auto-launch on login (no admin required).

**Open the dashboard:**
```
http://localhost:4200
```
Sessions tab for a list view, Desktop tab for windowed view, Spawn tab to launch new panes with personas, activity sidebar for the OmniClaude + A2A + events feeds.

## Install via agent (experimental)

Paste this prompt into any Claude Code session to auto-install theorchestra:

> You are being installed as a theorchestra orchestrator. Clone https://github.com/wolverin0/theorchestra to `~/theorchestra/`, run `npm install`, copy `.env.example` to `.env`, register the `wezbridge` MCP server with `claude mcp add wezbridge --scope user -- node ~/theorchestra/src/mcp-server.cjs`, set the `WEZTERM_LOG=wezterm_mux_server_impl::local=off` user env var, create `~/.omniclaude/telegram-topics.json` from the template in the repo, launch `Monitor` with `node ~/theorchestra/src/omni-watcher.cjs`, and greet the user on Telegram with a one-liner. Report done.

## Roadmap

- **Phase 2 — desktop dashboard** (single-file HTML + vanilla JS) — **shipped in v1.1**. Pane grid + SSE events stream + tasks panel. A2A flow panel and Agency Spawn tab shipped in v2.5.
- **v2.5 Agency Mode — shipped.** Persona injection, worktree isolation, PRD team bootstrap.
- **v2.6 Intelligent Auto-Handoff — shipped.** Ctx-aware session reset with readiness check.
- **v2.7 Hardening + perf — shipped (2026-04-19).** Wezterm CLI call-rate reduction via TTL caches; WEZTERM_LOG env var for crash prevention; persistent streamer launcher; spawn_session PEER-PANE CONTEXT bootstrap.
- **Phase 3 — remaining v3.1 features:**
  - Permission buttons in Telegram (approve/reject tool use)
  - Voice prompts (Whisper transcription)
  - Project scanner (spawn any Claude project from chat)
  - Photo/document support
  - Plugin system (`plugins/*.cjs` with context API)
  - `/split`, `/workspace`, `/remote` (SSH)
  - Code diffs post-response
  - GitHub webhooks → topic notifications
  - ntfy.sh backup channel
  - Inline mode (`@theorchestra_bot`)
- **Phase 4 — Telegram Mini App dashboard** (port of v3.1's 4-tab mobile UI, adapted to agent-centric model).
- **Future — persistent wezterm mux connection.** Replace per-call `wezterm cli` spawns with one long-lived connection (either via the Rust `wezterm-client` crate or direct mux protocol) to eliminate the 10054 error category at the source. Only needed if v2.7 rate-reduction + WEZTERM_LOG env var prove insufficient.

## History

theorchestra forks from [wolverin0/wezbridge v3.1](https://github.com/wolverin0/wezbridge) — a bot-centric Telegram ↔ Claude Code bridge. The substrate (WezTerm mux, pane discovery, MCP tools) is shared. The coordination philosophy is not: theorchestra replaces the Node bot monolith with a real Claude Code session as the orchestrator and adds a peer-to-peer A2A protocol so sessions can coordinate directly.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT — see [`LICENSE`](LICENSE).
