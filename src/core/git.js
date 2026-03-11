/**
 * switchman - Git utilities
 * Worktree discovery and conflict detection via git merge-tree
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, relative, resolve, basename } from 'path';
import { filterIgnoredPaths } from './ignore.js';

/**
 * Find the switchman database root from cwd or a given path.
 *
 * Problem: `git rev-parse --show-toplevel` returns the *current worktree's*
 * root when called from inside a linked worktree — not the main repo where
 * .switchman/ lives. We handle this in two steps:
 *
 *   1. Use `git rev-parse --show-toplevel` to get the current worktree root.
 *   2. Use `git rev-parse --git-common-dir` to find the shared .git directory,
 *      then resolve the main repo root from there.
 *
 * This means `switchman scan` works correctly whether you run it from:
 *   /projects/myapp/              (main worktree)
 *   /projects/myapp-feature-auth/ (linked worktree)
 */
export function findRepoRoot(startPath = process.cwd()) {
  try {
    // Step 1: confirm we're inside *some* git repo
    execSync('git rev-parse --show-toplevel', {
      cwd: startPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Step 2: get the shared git dir (e.g. /projects/myapp/.git or
    // /projects/myapp/.git/worktrees/feature-auth). For the main worktree
    // this resolves to the .git dir itself; for linked worktrees it points
    // to .git/worktrees/<name> inside the main repo.
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: startPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // --git-common-dir returns a path relative to cwd (or absolute).
    // We need the directory that *contains* the .git folder.
    const resolvedCommon = resolve(startPath, commonDir);

    // resolvedCommon is something like /projects/myapp/.git
    // The main repo root is its parent.
    const mainRoot = resolve(resolvedCommon, '..');

    return mainRoot;
  } catch {
    throw new Error('Not inside a git repository. Run switchman from inside a git repo.');
  }
}

/**
 * List all git worktrees for this repo
 * Returns: [{ name, path, branch, isMain, HEAD }]
 */
export function listGitWorktrees(repoRoot) {
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    const worktrees = [];
    const blocks = output.trim().split('\n\n');

    for (const block of blocks) {
      if (!block.trim()) continue;
      const lines = block.trim().split('\n');
      const wt = {};

      for (const line of lines) {
        if (line.startsWith('worktree ')) wt.path = line.slice(9).trim();
        else if (line.startsWith('HEAD ')) wt.HEAD = line.slice(5).trim();
        else if (line.startsWith('branch ')) wt.branch = line.slice(7).trim().replace('refs/heads/', '');
        else if (line === 'bare') wt.bare = true;
        else if (line === 'detached') wt.detached = true;
      }

      if (wt.path) {
        wt.name = wt.path === repoRoot ? 'main' : wt.path.split('/').pop();
        wt.isMain = wt.path === repoRoot;
        worktrees.push(wt);
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Get files changed in a worktree relative to its base branch
 * Returns array of file paths (relative to repo root)
 */
export function getWorktreeChangedFiles(worktreePath, repoRoot) {
  try {
    // Get both staged and unstaged changes
    const staged = execSync('git diff --name-only --cached', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const unstaged = execSync('git diff --name-only', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const untracked = execSync('git ls-files --others --exclude-standard', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const allFiles = [
      ...staged.split('\n'),
      ...unstaged.split('\n'),
      ...untracked.split('\n'),
    ].filter(Boolean);

    return filterIgnoredPaths([...new Set(allFiles)]);
  } catch {
    return [];
  }
}

/**
 * Check for merge conflicts between two branches using git merge-tree
 * Returns: { hasConflicts: bool, conflictingFiles: string[], details: string }
 */
export function checkMergeConflicts(repoRoot, branchA, branchB) {
  try {
    // Find merge base
    const mergeBase = execSync(`git merge-base ${branchA} ${branchB}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // Run merge-tree (read-only simulation)
    const result = spawnSync(
      'git',
      ['merge-tree', '--write-tree', '--name-only', mergeBase, branchA, branchB],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      }
    );

    const output = (result.stdout || '') + (result.stderr || '');
if (result.status === 0 || !output.includes('CONFLICT')) {
  return { hasConflicts: false, conflictingFiles: [], details: '' };
}
const conflictingFiles = parseConflictingFiles(output);

    return {
      hasConflicts: true,
      conflictingFiles,
      details: output.slice(0, 500),
    };
  } catch (err) {
    // Fallback: compare changed file sets for overlap
    return checkFileOverlap(repoRoot, branchA, branchB);
  }
}

/**
 * Fallback: check if two branches touch the same files
 */
function checkFileOverlap(repoRoot, branchA, branchB) {
  try {
    const mergeBase = execSync(`git merge-base ${branchA} ${branchB}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const filesA = execSync(`git diff --name-only ${mergeBase} ${branchA}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    const filesB = execSync(`git diff --name-only ${mergeBase} ${branchB}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);

    const setB = new Set(filesB);
    const overlap = filesA.filter(f => setB.has(f));

    return {
      hasConflicts: overlap.length > 0,
      conflictingFiles: overlap,
      details: overlap.length ? `File overlap detected (not necessarily merge conflict)` : '',
      isOverlapOnly: true,
    };
  } catch {
    return { hasConflicts: false, conflictingFiles: [], details: 'Could not compare branches', error: true };
  }
}

function parseConflictingFiles(output) {
  const files = new Set();
  const lines = output.split('\n');
  for (const line of lines) {
    // "CONFLICT (content): Merge conflict in path/to/file.js"
    // This is the only reliable format across git versions.
    const match = line.trim().match(/Merge conflict in (.+)$/);
    if (match) files.add(match[1].trim());
  }
  return [...files];
}

/**
 * Get the current branch of a worktree
 */
export function getWorktreeBranch(worktreePath) {
  try {
    return execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Create a new git worktree
 */
export function createGitWorktree(repoRoot, name, branch) {
  const repoName = basename(repoRoot);
  const wtPath = join(repoRoot, '..', `${repoName}-${name}`);
  execSync(`git worktree add -b "${branch}" "${wtPath}"`, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return wtPath;
}

/**
 * Get summary stats for a worktree
 */
export function getWorktreeStats(worktreePath) {
  try {
    const status = execSync('git status --short', {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const lines = status.split('\n').filter(Boolean);
    const modified = lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length;
    const added = lines.filter(l => l.startsWith('A ') || l.startsWith('??')).length;
    const deleted = lines.filter(l => l.startsWith(' D') || l.startsWith('D ')).length;

    return { modified, added, deleted, total: lines.length, raw: status };
  } catch {
    return { modified: 0, added: 0, deleted: 0, total: 0, raw: '' };
  }
}
