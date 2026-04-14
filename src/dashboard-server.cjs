#!/usr/bin/env node
/**
 * theorchestra dashboard server — thin HTTP + SSE layer over wezbridge tooling.
 *
 * Endpoints:
 *   GET  /api/panes                        — current pane list with status, identity, metrics
 *   GET  /api/panes/:id/output?lines=50    — scrollback from a pane
 *   GET  /api/tasks                        — parsed active_tasks.md (if present)
 *   GET  /api/events                       — SSE stream of omni-watcher events
 *   POST /api/panes/:id/prompt  {text}     — send_prompt + send_key(enter)
 *   POST /api/panes/:id/key     {key}      — send_key
 *   POST /api/panes/:id/kill               — kill pane
 *   POST /api/spawn             {cwd,program?} — spawn a new pane
 *
 * Static frontend assets served from ../dashboard/dist (after `npm run build`).
 * Dev mode: run Vite separately on :5173 and set a proxy to this server on :4200.
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const wez = require('./wezterm.cjs');
const { discoverPanes } = require('./pane-discovery.cjs');
const { parseTasksFile } = (() => {
  try { return require('./task-parser.cjs'); }
  catch { return { parseTasksFile: () => ({ tasks: [], error: 'task-parser not available' }) }; }
})();
const { scanProjects } = (() => {
  try { return require('./project-scanner.cjs'); }
  catch { return { scanProjects: () => [] }; }
})();

const PORT = parseInt(process.env.DASHBOARD_PORT || '4200', 10);
const STATIC_DIR = path.join(__dirname, '..', 'dashboard', 'dist');
const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');
const ACTIVE_TASKS_PATH = process.env.ACTIVE_TASKS_PATH
  || path.join(process.env.OMNICLAUDE_PATH || path.join(__dirname, '..', '..', 'omniclaude'), 'active_tasks.md');

// --- helpers ---
function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function log(msg) { process.stderr.write(`[dashboard] ${new Date().toISOString()} ${msg}\n`); }

// --- route handlers ---

function collectPanes() {
  const raw = discoverPanes ? discoverPanes() : wez.listPanes().map(p => ({ paneId: p.pane_id }));
  return (raw || []).map(p => ({
    pane_id: p.paneId ?? p.pane_id,
    is_claude: p.isClaude ?? false,
    status: p.status ?? 'unknown',
    project: p.project ?? null,
    project_name: p.projectName ?? null,
    title: p.title ?? '',
    workspace: p.workspace ?? 'default',
    confidence: p.confidence ?? 0,
    last_line: p.lastLines ?? '',
  }));
}

async function handleGetPanes(req, res) {
  try { sendJson(res, 200, { panes: collectPanes() }); }
  catch (err) { log(`GET /api/panes error: ${err.message}`); sendJson(res, 500, { error: err.message }); }
}

// Legacy-compat: v3.1 HTML expects { sessions: [...] } with confidence in %.
async function handleGetSessions(req, res) {
  try {
    const sessions = collectPanes().map(p => ({
      ...p,
      confidence: Math.round((p.confidence || 0) * (p.confidence > 1 ? 1 : 100)),
    }));
    sendJson(res, 200, { sessions });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

async function handleGetProjects(req, res) {
  try {
    const list = scanProjects({ includeCodex: true, limit: null }) || [];
    // v3.1 HTML expects a bare array of {name, path, ...}.
    const projects = list.map(p => ({
      name: p.name || (p.realPath || '').split(/[/\\]/).pop() || 'project',
      path: p.realPath || p.cwd || '',
      cwd: p.realPath || p.cwd || '',
      type: p.agent || 'claude',
      last_activity: p.latestActivityMs ? new Date(p.latestActivityMs).toISOString() : null,
      session_count: p.sessionCount || 0,
    }));
    sendJson(res, 200, projects);
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

async function handleGetBrowse(req, res, queryPath) {
  try {
    const dir = queryPath || process.env.HOME || process.env.USERPROFILE || '/';
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return sendJson(res, 200, { cwd: dir, dirs: [], error: 'not a directory' });
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
      .slice(0, 200);
    sendJson(res, 200, { cwd: dir, dirs: entries });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

async function handlePostBroadcast(req, res) {
  try {
    const { text, panes: targets } = await parseBody(req);
    if (!text) return sendJson(res, 400, { error: 'missing text' });
    const all = collectPanes().filter(p => p.is_claude);
    const ids = Array.isArray(targets) && targets.length ? targets : all.map(p => p.pane_id);
    for (const id of ids) {
      try { wez.sendText(id, text); wez.sendTextNoEnter(id, '\r'); } catch (e) { log(`broadcast pane ${id}: ${e.message}`); }
    }
    sendJson(res, 200, { ok: true, sent: ids.length });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

async function handleGetPaneOutput(res, paneId, lines) {
  try {
    const text = wez.getFullText(paneId, lines);
    // Return both field names: `output` for v3.1 HTML compat, `lines` for new clients.
    sendJson(res, 200, { pane_id: paneId, output: text || '', lines: text || '' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleGetTasks(res) {
  try {
    if (!fs.existsSync(ACTIVE_TASKS_PATH)) {
      return sendJson(res, 200, { tasks: [], note: `no active_tasks.md at ${ACTIVE_TASKS_PATH}` });
    }
    const { tasks: tasksMap, errors } = parseTasksFile(ACTIVE_TASKS_PATH);
    const tasks = Array.from(tasksMap.values());
    sendJson(res, 200, { tasks, errors });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// Translate raw omni-watcher events → v3.1 dashboard contract.
// v3.1 HTML expects: {type, pane_id, project, timestamp, output?, from?, to?}.
// We skip noise (heartbeat, metrics_summary, watcher_started, relaunch_me).
const NOISE_EVENTS = new Set(['heartbeat', 'metrics_summary', 'watcher_started', 'relaunch_me']);

// --- A2A state (module-scoped, shared across all SSE clients) ---
// Map<corr, {corr, from, to, firstSeen, lastSeen, status}>
// Status: 'active' | 'resolved' | 'orphaned'. LRU cap 500 + 24h TTL.
const a2aState = new Map();
const A2A_MAX = 500;
const A2A_TTL_MS = 24 * 3600 * 1000;
const A2A_ENVELOPE_RE = /\[A2A from pane-(\d+) to pane-(\d+) \| corr=([^\s|]+) \| type=(\w+)/g;

function a2aEvict() {
  const now = Date.now();
  for (const [corr, info] of a2aState) {
    if (now - (info.lastSeen || info.firstSeen) > A2A_TTL_MS) a2aState.delete(corr);
  }
  // LRU: drop oldest lastSeen if over cap
  while (a2aState.size > A2A_MAX) {
    let oldestCorr = null;
    let oldestTs = Infinity;
    for (const [corr, info] of a2aState) {
      const ts = info.lastSeen || info.firstSeen || 0;
      if (ts < oldestTs) { oldestTs = ts; oldestCorr = corr; }
    }
    if (oldestCorr == null) break;
    a2aState.delete(oldestCorr);
  }
}

function a2aTouch(corr, patch) {
  const now = Date.now();
  const existing = a2aState.get(corr);
  if (existing) {
    Object.assign(existing, patch, { lastSeen: now });
  } else {
    a2aState.set(corr, { corr, from: null, to: null, firstSeen: now, lastSeen: now, status: 'active', ...patch });
  }
  a2aEvict();
}

function recordA2AFromRawEvent(raw) {
  if (!raw) return;
  // peer_orphaned carries corr at top level
  if (raw.event === 'peer_orphaned' && raw.corr) {
    a2aTouch(String(raw.corr), { status: 'orphaned' });
    return;
  }
  // Scan details string for A2A envelopes
  const haystack = typeof raw.details === 'string' ? raw.details
    : (raw.raw && typeof raw.raw === 'object' && typeof raw.raw.corr === 'string')
      ? `[A2A from pane-${raw.pane || 0} to pane-0 | corr=${raw.raw.corr} | type=request]`
      : null;
  if (!haystack) return;
  A2A_ENVELOPE_RE.lastIndex = 0;
  let m;
  while ((m = A2A_ENVELOPE_RE.exec(haystack)) !== null) {
    const from = parseInt(m[1], 10);
    const to = parseInt(m[2], 10);
    const corr = m[3];
    const type = m[4];
    if (type === 'request') {
      a2aTouch(corr, { from, to, status: 'active' });
    } else if (type === 'result') {
      a2aTouch(corr, { from, to, status: 'resolved' });
    } else if (type === 'error') {
      a2aTouch(corr, { from, to, status: 'resolved' });
    } else {
      // ack/progress: keep alive but don't overwrite status
      a2aTouch(corr, { from, to });
    }
  }
}

async function handleGetA2APending(req, res) {
  try {
    a2aEvict();
    const corrs = Array.from(a2aState.values())
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    sendJson(res, 200, { corrs });
  } catch (err) { sendJson(res, 500, { error: err.message }); }
}

function slugify(s) {
  return String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function isoForFilename() {
  // 2026-04-14T17-46-12Z (no ms, colons → dashes)
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

async function handlePostA2AHandoff(req, res) {
  try {
    const body = await parseBody(req);
    const source_pane = parseInt(body.source_pane, 10);
    const target_pane = parseInt(body.target_pane, 10);
    const summary = typeof body.summary === 'string' ? body.summary : '';
    const instruction = typeof body.instruction === 'string' ? body.instruction : '';
    if (!Number.isFinite(source_pane) || !Number.isFinite(target_pane)) {
      return sendJson(res, 400, { error: 'source_pane and target_pane must be integers' });
    }
    if (!summary.trim() || !instruction.trim()) {
      return sendJson(res, 400, { error: 'summary and instruction are required' });
    }

    const panes = discoverPanes ? discoverPanes() : [];
    const srcPane = panes.find(p => (p.paneId ?? p.pane_id) === source_pane);
    const tgtPane = panes.find(p => (p.paneId ?? p.pane_id) === target_pane);
    if (!srcPane || !srcPane.isClaude) {
      return sendJson(res, 400, { error: `source pane ${source_pane} not found or not claude` });
    }
    if (!tgtPane || !tgtPane.isClaude) {
      return sendJson(res, 400, { error: `target pane ${target_pane} not found or not claude` });
    }

    const targetCwd = tgtPane.project;
    if (!targetCwd) {
      return sendJson(res, 400, { error: `target pane ${target_pane} has no resolvable cwd` });
    }

    // corr + timestamps
    const corrShort = Math.random().toString(36).slice(2, 8).padEnd(6, '0').slice(0, 6);
    const corr = `handoff-${corrShort}`;
    const tsFile = isoForFilename();
    const tsIso = new Date().toISOString();

    // Source project name (prefer projectName, fall back to basename of cwd)
    const srcProjectName = srcPane.projectName
      || (srcPane.project ? srcPane.project.split(/[\\/]/).filter(Boolean).pop() : null)
      || 'unknown';
    const tgtProjectName = tgtPane.projectName
      || (tgtPane.project ? tgtPane.project.split(/[\\/]/).filter(Boolean).pop() : null)
      || 'unknown';

    // Scrollback
    let scrollback = '';
    try { scrollback = stripAnsi(wez.getFullText(source_pane, 30) || ''); }
    catch (e) { scrollback = `[error fetching scrollback: ${e.message}]`; }

    // Filename — unique per handoff, never overwrite (claim 9431)
    const baseName = `handoff-from-${slugify(srcProjectName)}-${tsFile}-${corrShort}`;
    const handoffsDir = path.join(targetCwd, 'handoffs');
    fs.mkdirSync(handoffsDir, { recursive: true });

    const bodyMd = [
      `# Handoff from ${srcProjectName} (pane-${source_pane}) → ${tgtProjectName} (pane-${target_pane})`,
      '',
      `**Sent**: ${tsIso}`,
      `**Corr**: ${corr}`,
      `**Source project**: ${srcPane.project || '(unknown)'}`,
      '',
      '## Summary',
      summary,
      '',
      '## Instruction',
      instruction,
      '',
      '## Source scrollback (last 30 lines)',
      '```',
      scrollback,
      '```',
      '',
    ].join('\n');

    // Write with wx flag — never overwrite. Collision: append +N.
    let finalName = `${baseName}.md`;
    let finalPath = path.join(handoffsDir, finalName);
    let attempt = 0;
    while (true) {
      try {
        fs.writeFileSync(finalPath, bodyMd, { flag: 'wx' });
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        attempt += 1;
        if (attempt > 50) throw new Error('could not find unique handoff filename');
        finalName = `${baseName}-${attempt}.md`;
        finalPath = path.join(handoffsDir, finalName);
      }
    }

    // Inject envelope into target pane
    const envelope = [
      `[A2A from pane-${source_pane} to pane-${target_pane} | corr=${corr} | type=request]`,
      `Handoff received. File: handoffs/${finalName}`,
      '',
      instruction,
      '',
      'Read the handoff file first, then acknowledge with an ack envelope and proceed.',
    ].join('\n');

    try {
      wez.sendText(target_pane, envelope);
      wez.sendTextNoEnter(target_pane, '\r');
    } catch (e) {
      return sendJson(res, 500, { error: `wrote file but failed to inject: ${e.message}`, file: `handoffs/${finalName}` });
    }

    // Track in a2aState
    const now = Date.now();
    a2aTouch(corr, { from: source_pane, to: target_pane, status: 'active', firstSeen: now, lastSeen: now });

    sendJson(res, 200, { ok: true, corr, file: `handoffs/${finalName}`, target_pane });
  } catch (err) {
    log(`POST /api/a2a/handoff error: ${err.message}`);
    sendJson(res, 500, { error: err.message });
  }
}

function translateWatcherEvent(raw) {
  if (!raw || !raw.event || NOISE_EVENTS.has(raw.event)) return null;
  const typeMap = {
    session_started: 'started',
    session_started_working: 'started',
    session_completed: 'completed',
    session_permission: 'permission',
    session_stuck: 'status_change',
    session_dead: 'removed',
    session_removed: 'removed',
    peer_orphaned: 'permission',
  };
  const type = typeMap[raw.event] || raw.event;
  const out = {
    // keep original fields for any new clients
    ...raw,
    // v3.1 contract
    type,
    timestamp: raw.ts || new Date().toISOString(),
    pane_id: raw.pane ?? raw.pane_id ?? null,
    project: raw.project || null,
  };
  // Richer payload: for started/completed/permission, pull recent pane text as `output`.
  if (['started', 'completed', 'permission'].includes(type) && out.pane_id != null) {
    try {
      const full = wez.getFullText(out.pane_id, 40) || '';
      const clean = full.split('\n').filter(l => l.trim()).slice(-15).join('\n');
      if (clean) out.output = clean;
    } catch { /* pane may have disappeared */ }
  }
  // If watcher already attached a details summary, use it as fallback output.
  if (!out.output && raw.details) out.output = String(raw.details);
  if (type === 'status_change') {
    out.from = raw.from || 'working';
    out.to = raw.to || (raw.event === 'session_stuck' ? 'stuck' : 'unknown');
  }
  return out;
}

// SSE: spawn an omni-watcher child, translate + forward events.
function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const helloTs = new Date().toISOString();
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: helloTs, timestamp: helloTs })}\n\n`);

  const child = spawn(process.execPath, [path.join(__dirname, 'omni-watcher.cjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WATCHER_POLL_MS: process.env.WATCHER_POLL_MS || '30000' },
  });

  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let raw;
      try { raw = JSON.parse(line); } catch { continue; }
      // Side-effect: update A2A state from any envelope pattern or peer_orphaned event.
      try { recordA2AFromRawEvent(raw); } catch (e) { log(`a2a record error: ${e.message}`); }
      const translated = translateWatcherEvent(raw);
      if (!translated) continue;
      res.write(`data: ${JSON.stringify(translated)}\n\n`);
    }
  });
  child.stderr.on('data', chunk => log(`watcher stderr: ${chunk.toString('utf8').trim()}`));
  child.on('exit', code => {
    res.write(`event: watcher_exit\ndata: ${JSON.stringify({ code, timestamp: new Date().toISOString() })}\n\n`);
    res.end();
  });

  req.on('close', () => {
    child.kill();
  });
}

async function handlePostPrompt(req, res, paneId) {
  try {
    const { text } = await parseBody(req);
    if (typeof text !== 'string' || !text.length) {
      return sendJson(res, 400, { error: 'missing `text` body field' });
    }
    wez.sendText(paneId, text);
    // Auto-follow with enter per the A2A hard rule
    wez.sendTextNoEnter(paneId, '\r');
    sendJson(res, 200, { ok: true, pane_id: paneId });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostKey(req, res, paneId) {
  try {
    const { key } = await parseBody(req);
    if (!key) return sendJson(res, 400, { error: 'missing `key` body field' });
    const mapping = {
      enter: '\r', y: 'y', n: 'n',
      'ctrl+c': '\x03',
      '1': '1', '2': '2', '3': '3',
    };
    const payload = mapping[key.toLowerCase()] ?? key;
    wez.sendTextNoEnter(paneId, payload);
    sendJson(res, 200, { ok: true, pane_id: paneId, key });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostKill(res, paneId) {
  try {
    wez.killPane(paneId);
    sendJson(res, 200, { ok: true, pane_id: paneId });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handlePostSpawn(req, res) {
  try {
    const { cwd, program, args } = await parseBody(req);
    if (!cwd) return sendJson(res, 400, { error: 'missing `cwd` body field' });
    const paneId = wez.spawnPane({ cwd, program, args });
    sendJson(res, 200, { ok: true, pane_id: paneId });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// --- static file serving ---
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.map':  'application/json',
};

function serveStatic(res, urlPath) {
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('Dashboard not built. Run: cd dashboard && npm install && npm run build');
  }
  let relPath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(STATIC_DIR, relPath);
  if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback to index.html
    const idx = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return fs.createReadStream(idx).pipe(res);
    }
    res.writeHead(404); return res.end('not found');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// --- server ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // API routes
  if (pathname === '/api/panes' && method === 'GET') return handleGetPanes(req, res);
  if (pathname === '/api/sessions' && method === 'GET') return handleGetSessions(req, res);
  if (pathname === '/api/projects' && method === 'GET') return handleGetProjects(req, res);
  if (pathname === '/api/browse' && method === 'GET') return handleGetBrowse(req, res, url.searchParams.get('path'));
  if (pathname === '/api/broadcast' && method === 'POST') return handlePostBroadcast(req, res);
  if (pathname === '/api/a2a/pending' && method === 'GET') return handleGetA2APending(req, res);
  if (pathname === '/api/a2a/handoff' && method === 'POST') return handlePostA2AHandoff(req, res);
  if (pathname === '/api/tasks' && method === 'GET') return handleGetTasks(res);
  if (pathname === '/api/events' && method === 'GET') return handleEvents(req, res);
  if (pathname === '/api/spawn' && method === 'POST') return handlePostSpawn(req, res);

  const paneMatch = pathname.match(/^\/api\/(panes|sessions)\/(\d+)(\/(output|prompt|key|kill|queue|inject-context))?$/);
  if (paneMatch) {
    const paneId = parseInt(paneMatch[2], 10);
    const sub = paneMatch[4];
    if (sub === 'output' && method === 'GET') {
      const lines = parseInt(url.searchParams.get('lines') || '50', 10);
      return handleGetPaneOutput(res, paneId, lines);
    }
    if (sub === 'prompt' && method === 'POST') return handlePostPrompt(req, res, paneId);
    if (sub === 'key' && method === 'POST')    return handlePostKey(req, res, paneId);
    if (sub === 'kill' && method === 'POST')   return handlePostKill(res, paneId);
    // Graceful noops: v3.1 UI calls these; current backend doesn't support queue/inject yet.
    if ((sub === 'queue' || sub === 'inject-context') && method === 'POST') {
      return sendJson(res, 200, { ok: true, note: `${sub} not implemented yet — noop` });
    }
  }

  // Serve the v3.1 HTML dashboard at root.
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    if (fs.existsSync(DASHBOARD_HTML)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return fs.createReadStream(DASHBOARD_HTML).pipe(res);
    }
  }

  // Static fallthrough (assets from dashboard/dist, if built)
  if (method === 'GET') return serveStatic(res, pathname);

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  log(`theorchestra dashboard server listening on http://localhost:${PORT}`);
  log(`API: /api/panes, /api/tasks, /api/events (SSE)`);
  log(`Static: ${fs.existsSync(STATIC_DIR) ? STATIC_DIR : '(dashboard not built yet)'}`);
});

process.on('SIGTERM', () => { log('SIGTERM'); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { log('SIGINT'); server.close(() => process.exit(0)); });
