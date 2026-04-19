/**
 * Git worktree helper — spawns `git worktree add` / `git worktree remove`
 * around the PTY spawn path so parallel peer panes can edit the same repo
 * on different branches without clobbering each other.
 *
 * Phase 5 scope: thin wrappers around `git` via child_process. No state is
 * tracked between calls — the caller is responsible for matching add/remove
 * pairs. The dashboard records the worktree path on the SessionRecord's
 * `cwd` field so normal session lifecycle handles the lifetime.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export interface AddWorktreeOptions {
  /** Absolute path of the upstream repo the worktree diverges from. */
  repoPath: string;
  /** Branch name to check out in the new worktree. Created if missing. */
  branch: string;
  /**
   * Absolute path where the worktree should live. Must NOT exist yet.
   * Convention: `<repoPath>/.worktrees/<branch>` so cleanup is obvious.
   */
  worktreePath: string;
  /** If true, create the branch if it doesn't exist. Default: true. */
  createBranch?: boolean;
}

export interface AddWorktreeResult {
  worktreePath: string;
  branch: string;
  created: boolean;
}

function isInsideWorkTree(dir: string): Promise<boolean> {
  return pExecFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir })
    .then((r) => r.stdout.trim() === 'true')
    .catch(() => false);
}

async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await pExecFile('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}

export async function addWorktree(opts: AddWorktreeOptions): Promise<AddWorktreeResult> {
  const { repoPath, branch, worktreePath } = opts;
  const createBranch = opts.createBranch ?? true;

  if (!path.isAbsolute(repoPath)) {
    throw new Error(`addWorktree: repoPath must be absolute, got ${repoPath}`);
  }
  if (!path.isAbsolute(worktreePath)) {
    throw new Error(`addWorktree: worktreePath must be absolute, got ${worktreePath}`);
  }
  if (!fs.existsSync(repoPath)) {
    throw new Error(`addWorktree: repoPath does not exist: ${repoPath}`);
  }
  if (!(await isInsideWorkTree(repoPath))) {
    throw new Error(`addWorktree: ${repoPath} is not a git working tree`);
  }
  if (fs.existsSync(worktreePath)) {
    throw new Error(`addWorktree: worktreePath already exists: ${worktreePath}`);
  }

  const hasBranch = await branchExists(repoPath, branch);
  let created = false;

  const args = ['worktree', 'add'];
  if (!hasBranch && createBranch) {
    args.push('-b', branch, worktreePath);
    created = true;
  } else {
    args.push(worktreePath, branch);
  }

  await pExecFile('git', args, { cwd: repoPath });
  return { worktreePath, branch, created };
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
): Promise<void> {
  if (!fs.existsSync(worktreePath)) return;
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(worktreePath);
  await pExecFile('git', args, { cwd: repoPath });
}

export async function listWorktrees(repoPath: string): Promise<string[]> {
  try {
    const r = await pExecFile('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    return r.stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim());
  } catch {
    return [];
  }
}

/** Default path convention so multiple peer panes don't collide. */
export function defaultWorktreePath(repoPath: string, branch: string): string {
  const safeBranch = branch.replace(/[\/\\]/g, '-').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(repoPath, '.worktrees', safeBranch);
}
