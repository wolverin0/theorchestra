/**
 * Persona registry — scans `~/.claude/agents/` (flat + one level of nested
 * category dirs) and returns metadata about every `.md` persona file found.
 *
 * Used by:
 *   - GET /api/personas (dashboard Spawn wizard)
 *   - spawn_session backend endpoint when `persona` arg is set — resolves the
 *     name to an absolute file path, then injects `--append-system-prompt-file
 *     <path>` into the claude invocation.
 *
 * Phase 5 scope: read-only scan, no caching beyond a single call. Callers are
 * expected to re-scan when the UI asks; persona files don't change often.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Persona {
  /** The bare persona name (e.g. `reviewer`, `coder`, `dev-backend-api`). */
  name: string;
  /** Absolute path to the persona `.md` file. */
  filePath: string;
  /** One-line description, from the first non-empty non-heading line of the file. */
  description: string;
  /** Category dir under `~/.claude/agents/` — null for flat files. */
  category: string | null;
}

const AGENTS_DIR = path.join(os.homedir(), '.claude', 'agents');

function firstDescriptionLine(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8').slice(0, 2000);
    // Strip YAML frontmatter, if any, then first meaningful line.
    const body = content.startsWith('---')
      ? content.slice(content.indexOf('---\n', 4) + 4)
      : content;
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#')) continue;
      if (line.startsWith('<')) continue;
      return line.slice(0, 200);
    }
  } catch {
    /* unreadable */
  }
  return '';
}

/**
 * List every persona available. Skips dotfiles, directories without
 * `.md` files, and files that fail to read.
 */
export function listPersonas(): Persona[] {
  const out: Persona[] = [];
  if (!fs.existsSync(AGENTS_DIR)) return out;

  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    // Flat persona file at the top level.
    if (entry.isFile() && entry.name.endsWith('.md')) {
      const filePath = path.join(AGENTS_DIR, entry.name);
      out.push({
        name: entry.name.slice(0, -3),
        filePath,
        description: firstDescriptionLine(filePath),
        category: null,
      });
      continue;
    }

    // One level of nested category dirs (e.g. `development/coder.md`).
    if (entry.isDirectory()) {
      const subDir = path.join(AGENTS_DIR, entry.name);
      let sub: fs.Dirent[] = [];
      try {
        sub = fs.readdirSync(subDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of sub) {
        if (!file.isFile() || !file.name.endsWith('.md')) continue;
        const filePath = path.join(subDir, file.name);
        out.push({
          name: file.name.slice(0, -3),
          filePath,
          description: firstDescriptionLine(filePath),
          category: entry.name,
        });
      }
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Resolve a persona name to its absolute file path. Checks the flat dir
 * first, then each category dir. Returns null if not found.
 *
 * This mirrors v2.7's `resolvePersona()` in `src/mcp-server.cjs`.
 */
export function resolvePersona(name: string): string | null {
  if (!fs.existsSync(AGENTS_DIR)) return null;

  // 1. Exact match at top level: ~/.claude/agents/<name>.md
  const flat = path.join(AGENTS_DIR, `${name}.md`);
  if (fs.existsSync(flat)) return flat;

  // 2. One-level nested: ~/.claude/agents/*/<name>.md
  try {
    const dirs = fs
      .readdirSync(AGENTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    for (const d of dirs) {
      const nested = path.join(AGENTS_DIR, d.name, `${name}.md`);
      if (fs.existsSync(nested)) return nested;
    }
  } catch {
    /* unreadable */
  }
  return null;
}
