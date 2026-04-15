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
- **Mobile view** (Telegram Mini App style) — si el user alguna vez quiere controlar desde el celular
- **Multi-project PRDs**: un PRD que spawneá team across several projects (ej: cambio de API que impacta a 3 apps)
- **Agency memory**: sessions con persona guardan aprendizajes en MemoryMaster con scope `persona:<name>` para persistir conocimiento entre ejecuciones

---

## Policy: cómo se agrega acá

1. Cualquier idea de feature grande entra a este archivo PRIMERO
2. Se promueve a `docs/PLAN-*.md` solo cuando la versión anterior esté stable + usada
3. No se arranca trabajo que NO esté en un PLAN activo
4. Este archivo NO es compromiso — es inspiración inventariada
