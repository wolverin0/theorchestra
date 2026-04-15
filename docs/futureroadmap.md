# Future Roadmap — theorchestra

Ideas capturadas que NO están en la cola actual. Un plan por versión. Se ejecutan después de estabilizar la versión anterior en uso real.

**Gate**: antes de arrancar cualquier item de este archivo, la versión actual debe estar: taggeada, con E2E tests mínimos, security-auditada, y **usada al menos una semana por el user**.

---

## v2.5 — Agency Mode (multi-agent personas)

**Pitch**: el user dropea un PRD → el orchestrator pane spawnea un team de specialists (frontend-dev, backend-arch, test-engineer, etc), cada uno en su propio pane con su persona inyectada, trabajando en paralelo en worktrees aislados, coordinándose via A2A, reporting back al orchestrator.

### Infraestructura ya en su lugar (70%)

- `mcp__wezbridge__spawn_session` — spawn de panes ✅
- A2A envelope protocol — comunicación inter-pane ✅
- Handoff delegation (v2.3.1) — un pane despacha trabajo a otro ✅
- Dashboard con arrows visualizando la conversación ✅
- Monitor tool para observar panes ajenos ✅

### Lo que falta (30%)

#### 1. Persona injection en spawn

Verificado en doc oficial (claim 9469, `code.claude.com/docs/en/cli-reference`): Claude Code acepta 4 flags para system prompt custom:
- `--system-prompt "..."` / `--system-prompt-file <path>` — REEMPLAZAN el default
- `--append-system-prompt "..."` / `--append-system-prompt-file <path>` — APPEND al default (preserva tools/behavior)

**Recomendación oficial**: usar APPEND para preservar capacidades built-in.

**Implementación**: extender `POST /api/spawn` body:
```json
{ "cwd": "...", "persona": "frontend-developer", "worktree": true }
```

En `handlePostSpawn`, si `persona` está presente:
```js
args: ['--append-system-prompt-file', path.join(os.homedir(), '.claude/agents', persona + '.md')]
```

Personas viven en `~/.claude/agents/<name>.md` (estándar oficial, user-wide, shareable).

#### 2. Persona library

Instalar [agency-agents](https://github.com/msitarzewski/agency-agents) (claim 9470) — 130+ personas ya escritas en 10 divisiones: Engineering (Frontend Developer, Backend Architect, Mobile, AI Engineer, DevOps, Security, DB), Design, Sales, Marketing, Product, Testing.

Script: `./scripts/install.sh --tool claude-code` copia a `~/.claude/agents/`.

Nuevo endpoint `GET /api/personas` — lista `~/.claude/agents/*.md`. Dashboard muestra dropdown al spawnear.

#### 3. Worktree-per-agent (conflict prevention)

Si frontend-dev y backend-arch editan el mismo proyecto, se pisan. Solución: cada specialist obtiene su propio worktree.

`handlePostSpawn` con `worktree: true`:
```js
exec(`git worktree add ${cwd}-${persona}-${corr} claude/agency-${persona}-${corr}`);
wez.spawnPane({ cwd: `${cwd}-${persona}-${corr}`, program: 'claude', args: [...] });
```

Al final: cada agente tiene un branch `claude/agency-*`, el orchestrator mergea/cherrypicks al final.

Alternativa soft: declarar ownership en cada A2A envelope (`| owns=frontend/`). Menos seguro pero menos overhead.

#### 4. PRD schema + bootstrap

`docs/prd/<project>.md` con frontmatter:
```yaml
---
prd: true
name: "User auth refactor"
roles: [frontend-developer, backend-architect, test-engineer]
scope: auth-rewrite
deadline: 2026-05-01
---
```

Orchestrator pane lee el PRD, decide team, spawnea cada specialist con persona + worktree, despacha handoff inicial a cada uno con su slice del trabajo.

#### 5. Dashboard agency view (opcional)

- Pane cards muestran badge de persona (`🎨 frontend-developer`, `⚙️ backend-architect`)
- "Agency view" tab: tree que agrupa panes por orchestrator parent
- Las A2A arrows que ya tenemos (v2.4) ya visualizan la conversación — mucho del trabajo visual está hecho

### Decisiones abiertas

| Q | Opciones |
|---|---|
| Worktree vs file-ownership | (a) worktrees = clean, complejidad git; (b) declaración = flexible, riesgo pisar |
| Quién elige el team del PRD | (a) roles explícitos en frontmatter; (b) "project-manager" persona que decide |
| Cuántos agentes paralelos | 3-4 para empezar (rate limits reales de Claude Max) |
| Método de invocación | (1) CLI flag para specialists persistentes; (2) subagents vía `Agent` tool para one-shot |

### Método 1 vs Método 2 (resumen del análisis del 2026-04-14)

| Use case | Método | Por qué |
|---|---|---|
| Specialist persistente en su propio pane | **1**: `--append-system-prompt-file` | Vive, sobrevive crashes, observable, A2A real |
| Helper one-shot (reviewer, auditor) | **2**: Subagent via Agent tool | Cheaper, sin rate-limit slot extra, ephemeral |

Critical: subagents (Método 2) corren **dentro del mismo proceso del parent** y mueren con él. Para Agency Mode usar Método 1 para los long-running specialists.

### Fases sugeridas cuando se arranque

1. Extend `/api/spawn` con persona + install 1 persona de prueba
2. Install agency-agents library + `/api/personas` endpoint + dashboard dropdown
3. Worktree-per-agent
4. PRD schema + orchestrator bootstrap
5. Dashboard badges + agency tree view

---

## v2.6+ — otras ideas backlog (no priorizadas)

- **Pane-to-pane drag handoff**: arrastrar una pane card sobre otra en Desktop view = handoff shortcut visual
- **Telegram alerts opcional**: portar el bot de `wezbridge-legacy` como plugin opt-in (notificaciones de `completed`/`permission`/`orphaned`)
- **Actually wire Routines**: primera routine real — "orphan investigator" que se dispara cuando el daemon detecta peer_orphaned repetido, abre PR con diagnóstico
- ~~**Mobile view** (Telegram Mini App style) — si el user alguna vez quiere controlar desde el celular~~ → **SHIPPED en v2.4.1** (Nivel 1 + 2: drawer, bottom nav, swipe gestures, LAN-friendly CSRF). Si se quiere la vista Telegram-native específica del mini app, abrir nuevo item
- **Multi-project PRDs**: un PRD que spawneá team across several projects (ej: cambio de API que impacta a 3 apps)
- **Agency memory**: sessions con persona guardan aprendizajes en MemoryMaster con scope `persona:<name>` para persistir conocimiento entre ejecuciones

---

## v2.7+ — Claude Code surface area we're NOT using yet (research 2026-04-15)

Investigado vía context7 en `code.claude.com/docs`. Ranqueado por valor real para nuestro flow.

### A) Hooks adicionales (alto impacto, bajo esfuerzo)

Hoy usamos `UserPromptSubmit` (recall + classify) y `SessionStart` (memory inject). La doc oficial expone **9 hook events más**:

| Hook | Uso para wezbridge | Esfuerzo |
|---|---|---|
| **`PreToolUse`** | Bloquear MCP calls riesgosos. Ej: rechazar `wezbridge:send_prompt` a un pane en `permission` state sin override explícito; bloquear `kill_session` sin confirmación si el pane tiene tareas activas | 1h |
| **`PostToolUse`** | Audit trail automático. Cada call a wezbridge MCP se loggea a `vault/_mcp-audit/<date>.jsonl` para forensics | 30 min |
| **`PostToolUseFailure`** | Re-routing automático. Si `send_prompt` falla porque el pane murió, dispara peer_orphaned manualmente | 30 min |
| **`PreCompact`** | Salvar estado crítico antes que la compaction lo borre. Ej: serializar `pendingA2A` corrs activos a vault para que sobreviva | 1 h |
| **`SubagentStart`/`SubagentStop`** | Track subagent activity en el dashboard. Cada vez que un orchestrator pane invoca un subagent vía Agent tool, aparece como evento en el Live Feed | 1-2 h |
| **`PermissionRequest`** | Capturar todos los `permission` events ANTES que aparezcan al usuario. Auto-aprobar patrones seguros documentados en allowlist | 2 h |

**Hook contract**: stdin recibe JSON con `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`. Retorna `{decision: "block", reason: "..."}` para abortar, o vacío para permitir.

### B) Skills custom para nuestro flow (medio impacto, bajo-medio esfuerzo)

Hoy NO shippeamos ningún skill. Skills viven en `~/.claude/skills/<name>/SKILL.md` (user) o `.claude/skills/<name>/SKILL.md` (project), YAML frontmatter + body. Pueden incluir scripts/binarios anidados. Auto-descubiertos por Claude cuando relevante (a menos que `disable-model-invocation: true`, entonces solo el user los invoca).

**Skills propuestos (envío como `.claude/skills/` en el repo de theorchestra):**

```yaml
---
name: handoff-pane
description: Hand off current work to another pane. Use when the user asks to "delegate", "pass to", or "have X take over"
argument-hint: <target-pane-id> "<instruction>"
---

# Handoff to pane $ARGUMENTS

1. Identify target pane via `mcp__wezbridge__discover_sessions`
2. Author handoff file at `<cwd>/handoffs/handoff-to-<target-name>-<ts>-<uuid>.md`
   summarizing current work + state
3. Send A2A envelope via `mcp__wezbridge__send_prompt` + `send_key('enter')`
4. Acknowledge with corr id

Reference: docs/PLAN-dashboard-v2.3.md Phase 4
```

Otros candidatos: `/spawn-specialist`, `/a2a-status <corr>`, `/dashboard` (abre :4200), `/observe-pane <id>` (Monitor de un pane peer), `/digest-orphans` (resumen de corrs orphaned recientes).

**Importante**: la doc dice "Custom commands have been merged into skills" — `.claude/commands/` y `.claude/skills/X/SKILL.md` ambos crean `/X` y funcionan igual. Empezar con commands (single .md) y promover a skills (folder) cuando necesiten archivos de soporte.

### C) Headless / batch mode (medio impacto, bajo esfuerzo)

`claude -p "<prompt>"` (alias `--print`) corre Claude one-shot sin entrar a interactivo. Flags útiles que NO usamos hoy:

- `--output-format json` — output estructurado parseable
- `--output-format stream-json` — streaming line-delimited JSON (ideal para bridge a dashboard)
- `--json-schema <schema>` — Claude valida su output contra un schema antes de retornar
- `--max-budget-usd <n>` — corta si excede gasto (relevante con persona que pueden divagar)
- `--max-turns <n>` — limita iteraciones agénticas
- `--input-format stream-json` — encadenar Claudes (output de uno → input del siguiente)

**Use cases para wezbridge:**
- Orchestrator pane delega tareas one-shot a Claudes headless en lugar de spawnear panes nuevos (más barato, sin slot WezTerm)
- Routines del dashboard pueden POST a `/api/routines/fire-local` que internamente hace `claude -p` con un prompt + json-schema → trae resultado estructurado para mostrar
- CI/CD: `npm run review-pr` corre `claude -p --json-schema` para validar PRs antes de merge

### D) Permission modes (alto valor, ya casi gratis)

Hoy todos los panes corren con `--dangerously-skip-permissions` via `omniclaude-forever.sh`. Eso es sano para el orchestrator pero **no para specialists**.

| Mode | Cuándo |
|---|---|
| `default` | Pregunta cada acción riesgosa. Para panes user-facing donde querés review |
| `plan` | Solo lectura, no edita ni ejecuta. **PERFECTO para specialist "code-reviewer" / "auditor" en Agency Mode** |
| `acceptEdits` | Auto-aprueba edits, sigue preguntando bash. Para frontend-developer / backend-architect |
| `bypassPermissions` | Skip-permissions equivalent. Solo para orchestrator + worker |

Implementación trivial: extender `POST /api/spawn` con `permission_mode` opcional, mapear a `--permission-mode <mode>` en el spawn args. Default `bypassPermissions` para mantener comportamiento actual.

Per-project default vía `.claude/settings.json`:
```json
{ "permissions": { "defaultMode": "plan" } }
```

### E) Output styles (bajo impacto, bajo esfuerzo, win cosmético)

Output styles modifican el system prompt de Claude para cambiar TONE/FORMAT. Built-in: default, teaching, etc. Custom: `~/.claude/output-styles/<name>.md` con frontmatter `description` + body que se appendea.

**Use case**: orchestrator pane podría usar un style "terse-json-first" que pida respuestas estructuradas para que el dashboard parsee mejor. Specialist "code-reviewer" podría usar style "report-mode" que siempre devuelve markdown con secciones fijas.

### F) Settings hierarchy (medio impacto, esfuerzo medio)

`--setting-sources user,project,local` — control fino sobre dónde vienen los settings. Hoy mezclamos todo. Útil:
- Worker pane podría tener `settings.json` propio en `vault/_orchestrator-worker/.claude/` con tools muy restringidos (solo Read/Write a `.state.json` y `.response.json`)
- Specialists con persona podrían heredar un settings de project distinto al del user

### G) Plugins / channels (research)

`omniclaude-forever.sh` ya usa `--channels plugin:telegram@claude-plugins-official`. Plugins son distribuibles por Anthropic. Investigar si conviene shipear `wezbridge` como plugin propio:
- Pro: install-once en cualquier máquina con `claude --channels plugin:wezbridge@...`
- Con: requiere mantener el package en el registry, versioning, etc.

Probably overkill hasta que el proyecto sea estable + de uso público. Por ahora MCP server `npm i -g` en local es suficiente.

### Priorización sugerida cuando se promuevan al backlog real

1. **Hooks PreToolUse + PostToolUse** (A) — 1.5h, gana audit trail + safety inmediato
2. **Skills `/handoff-pane` + `/spawn-specialist`** (B) — 2h, gana ergonomía masiva (no más click-click-click en dashboard)
3. **Permission modes per spawn** (D) — 1h, prerrequisito para Agency Mode v2.5
4. **PreCompact hook** (A) — 1h, defensivo contra pérdida de A2A state
5. **Headless batch** (C) — 2-3h, abre la puerta a delegación cheap

Total estimado para los 5: ~7-9 horas. Todo opt-in, no rompe lo que ya hay.

---

## Policy: cómo se agrega acá

1. Cualquier idea de feature grande entra a este archivo PRIMERO
2. Se promueve a `docs/PLAN-*.md` solo cuando la versión anterior esté stable + usada
3. No se arranca trabajo que NO esté en un PLAN activo
4. Este archivo NO es compromiso — es inspiración inventariada
