/**
 * PRD-YAML team bootstrap — parses a simple multi-role YAML spec and returns
 * an array of spawn configs the caller can hand to PtyManager.spawn + the
 * persona-resolution + worktree logic in spawn_session.
 *
 * Not a full YAML implementation. Supports the narrow shape our dashboard's
 * Spawn wizard + /api/prd-bootstrap use:
 *
 *   project: <name>
 *   cwd: <absolute-path>
 *   roles:
 *     - name: <role-name>         # required
 *       persona: <persona-name>   # optional; resolved by personas.ts
 *       prompt: |                 # optional, multi-line ok
 *         initial prompt text
 *       permission_mode: plan     # optional enum
 *       branch: <branch>          # optional; triggers worktree spawn
 *       tab_title: <title>        # optional; defaults to [<name>]
 *
 * Keep it small — we will replace with a real YAML lib if the shape grows.
 */

import * as fs from 'node:fs';

export interface PrdRole {
  name: string;
  persona?: string;
  prompt?: string;
  permission_mode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  branch?: string;
  tab_title?: string;
}

export interface PrdSpec {
  project: string;
  cwd: string;
  roles: PrdRole[];
}

const PERMISSION_MODES = new Set([
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
]);

/**
 * Parse a PRD YAML string into a spec. Intentionally lenient — ignores
 * unknown top-level keys, skips malformed role blocks, throws only on
 * structural problems (no `roles:`, no list, etc).
 */
export function parsePrdYaml(source: string): PrdSpec {
  const lines = source.split(/\r?\n/);

  let project = '';
  let cwd = '';
  const roles: PrdRole[] = [];

  let i = 0;
  // Pass 1: top-level keys until we hit `roles:`.
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!top) continue;
    const [, key, value] = top;
    if (key === 'project') project = stripQuotes(value!.trim());
    else if (key === 'cwd') cwd = stripQuotes(value!.trim());
    else if (key === 'roles') {
      i += 1;
      break;
    }
  }

  if (!roles) {
    // unreachable, but guards against tooling confusion
  }

  // Pass 2: every `- name: ...` starts a new role block.
  let current: PrdRole | null = null;
  let expectingPromptBlock = false;
  let promptLines: string[] = [];
  let promptIndent = 0;

  const flushCurrent = (): void => {
    if (current && current.name) {
      if (expectingPromptBlock && promptLines.length > 0) {
        current.prompt = promptLines.join('\n').trim();
      }
      roles.push(current);
    }
    current = null;
    expectingPromptBlock = false;
    promptLines = [];
    promptIndent = 0;
  };

  for (; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine;

    // Continuation of a `prompt: |` block?
    if (expectingPromptBlock) {
      const thisIndent = rawLine.match(/^(\s*)/)?.[1].length ?? 0;
      if (rawLine.trim() === '') {
        promptLines.push('');
        continue;
      }
      if (thisIndent >= promptIndent) {
        promptLines.push(rawLine.slice(promptIndent));
        continue;
      }
      // Dedent — end of block. Fall through to normal parsing of this line.
      if (current) current.prompt = promptLines.join('\n').trim();
      expectingPromptBlock = false;
      promptLines = [];
      promptIndent = 0;
    }

    if (/^\s*#/.test(line) || line.trim() === '') continue;

    // New role start: `  - name: value`.
    const roleStart = line.match(/^\s*-\s+name\s*:\s*(.+?)\s*$/);
    if (roleStart) {
      flushCurrent();
      current = { name: stripQuotes(roleStart[1]!.trim()) };
      continue;
    }

    // Key within the current role: `    key: value`.
    if (current) {
      const kv = line.match(/^(\s+)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      const [, leading, key, rawValue] = kv;
      const value = rawValue!.trim();

      if (value === '|' || value === '|+' || value === '|-') {
        // Multi-line block follows. Determine the block's indent from the
        // first non-empty follower line.
        expectingPromptBlock = true;
        promptLines = [];
        promptIndent = 0;
        // Look ahead to find the block indent.
        for (let k = i + 1; k < lines.length; k++) {
          const peek = lines[k]!;
          if (peek.trim() === '') continue;
          const peekIndent = peek.match(/^(\s*)/)?.[1].length ?? 0;
          if (peekIndent > leading!.length) {
            promptIndent = peekIndent;
            break;
          }
          // The next non-empty line isn't indented further — empty block.
          break;
        }
        continue;
      }

      switch (key) {
        case 'persona':
          current.persona = stripQuotes(value);
          break;
        case 'prompt':
          current.prompt = stripQuotes(value);
          break;
        case 'permission_mode': {
          const mode = stripQuotes(value);
          if (PERMISSION_MODES.has(mode)) {
            current.permission_mode = mode as PrdRole['permission_mode'];
          }
          break;
        }
        case 'branch':
          current.branch = stripQuotes(value);
          break;
        case 'tab_title':
          current.tab_title = stripQuotes(value);
          break;
        default:
          // Unknown role field — skip quietly.
          break;
      }
    }
  }
  flushCurrent();

  if (!project) throw new Error('prd: missing `project:` top-level key');
  if (!cwd) throw new Error('prd: missing `cwd:` top-level key');
  if (roles.length === 0) throw new Error('prd: no valid roles parsed');

  return { project, cwd, roles };
}

export function parsePrdFile(filePath: string): PrdSpec {
  const source = fs.readFileSync(filePath, 'utf-8');
  return parsePrdYaml(source);
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}
