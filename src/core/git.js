/**
 * switchman - Git utilities
 * Worktree discovery and conflict detection via git merge-tree
 */

import { execFileSync, execSync, spawnSync } from 'child_process';
import { existsSync, realpathSync, rmSync, statSync } from 'fs';
import { join, relative, resolve, basename } from 'path';
import { tmpdir } from 'os';
import { filterIgnoredPaths } from './ignore.js';

function normalizeFsPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

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

export function getGitCommonDir(startPath = process.cwd()) {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: startPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return resolve(startPath, commonDir);
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
    const normalizedRepoRoot = normalizeFsPath(repoRoot);
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
        const normalizedPath = normalizeFsPath(wt.path);
        wt.name = normalizedPath === normalizedRepoRoot ? 'main' : wt.path.split('/').pop();
        wt.isMain = normalizedPath === normalizedRepoRoot;
        worktrees.push(wt);
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

export function getCurrentWorktree(repoRoot, startPath = process.cwd()) {
  const currentPath = normalizeFsPath(startPath);
  const worktrees = listGitWorktrees(repoRoot);
  return worktrees.find((wt) => normalizeFsPath(wt.path) === currentPath) || null;
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

export function gitBranchExists(repoRoot, branch) {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0;
}

export function gitRevParse(repoRoot, ref) {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function gitGetCurrentBranch(repoRoot) {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function gitCheckout(repoRoot, ref) {
  execFileSync('git', ['checkout', ref], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function gitRebaseOnto(repoRoot, baseBranch, topicBranch) {
  const previousBranch = gitGetCurrentBranch(repoRoot);
  try {
    gitCheckout(repoRoot, topicBranch);
    execFileSync('git', ['rebase', baseBranch], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    if (previousBranch && previousBranch !== topicBranch) {
      try { gitCheckout(repoRoot, previousBranch); } catch { /* no-op */ }
    }
  }
}

export function gitMergeBranchInto(repoRoot, baseBranch, topicBranch) {
  const previousBranch = gitGetCurrentBranch(repoRoot);
  try {
    gitCheckout(repoRoot, baseBranch);
    execFileSync('git', ['merge', '--ff-only', topicBranch], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return gitRevParse(repoRoot, 'HEAD');
  } finally {
    if (previousBranch && previousBranch !== baseBranch) {
      try { gitCheckout(repoRoot, previousBranch); } catch { /* no-op */ }
    }
  }
}

export function gitAssessBranchFreshness(repoRoot, baseBranch, topicBranch) {
  const baseCommit = gitRevParse(repoRoot, baseBranch);
  const topicCommit = gitRevParse(repoRoot, topicBranch);
  if (!baseCommit || !topicCommit) {
    return {
      state: 'unknown',
      base_commit: baseCommit || null,
      topic_commit: topicCommit || null,
      merge_base: null,
    };
  }

  try {
    const mergeBase = execFileSync('git', ['merge-base', baseBranch, topicBranch], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return {
      state: mergeBase === baseCommit ? 'fresh' : 'behind',
      base_commit: baseCommit,
      topic_commit: topicCommit,
      merge_base: mergeBase,
    };
  } catch {
    return {
      state: 'unknown',
      base_commit: baseCommit,
      topic_commit: topicCommit,
      merge_base: null,
    };
  }
}

export function gitMaterializeIntegrationBranch(repoRoot, {
  branch,
  baseBranch = 'main',
  mergeBranches = [],
  tempWorktreePath = null,
} = {}) {
  const uniqueBranches = [...new Set(mergeBranches.filter(Boolean))].filter((candidate) => candidate !== branch);
  const resolvedTempWorktreePath = tempWorktreePath || join(tmpdir(), `switchman-landing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  try {
    execFileSync('git', ['worktree', 'add', '--detach', resolvedTempWorktreePath, baseBranch], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    execFileSync('git', ['checkout', '-B', branch, baseBranch], {
      cwd: resolvedTempWorktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (const mergeBranch of uniqueBranches) {
      execFileSync('git', ['merge', '--no-ff', '--no-edit', mergeBranch], {
        cwd: resolvedTempWorktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    return {
      branch,
      base_branch: baseBranch,
      merged_branches: uniqueBranches,
      head_commit: gitRevParse(resolvedTempWorktreePath, 'HEAD'),
      temp_worktree_path: resolvedTempWorktreePath,
    };
  } catch (err) {
    const stderr = String(err?.stderr || '');
    const stdout = String(err?.stdout || '');
    const combinedOutput = `${stdout}${stderr}`.trim();
    const message = String(err?.message || combinedOutput || 'Failed to materialize integration branch.');
    const currentMergeBranch = uniqueBranches.find((candidate) =>
      message.includes(candidate) || combinedOutput.includes(candidate),
    ) || null;
    let reasonCode = 'landing_branch_materialization_failed';
    if (/CONFLICT|Automatic merge failed|Merge conflict/i.test(message) || /CONFLICT|Automatic merge failed/i.test(combinedOutput)) {
      reasonCode = 'landing_branch_merge_conflict';
    } else if (/not something we can merge|unknown revision|bad revision|not a valid object name/i.test(message) || /not something we can merge|unknown revision|bad revision|not a valid object name/i.test(combinedOutput)) {
      reasonCode = 'landing_branch_missing_component';
    } else if (message.includes(baseBranch) && /not something we can merge|unknown revision|bad revision|not a valid object name/i.test(message)) {
      reasonCode = 'landing_branch_missing_base';
    }
    const conflictingFiles = reasonCode === 'landing_branch_merge_conflict'
      ? execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
        cwd: resolvedTempWorktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim().split('\n').filter(Boolean)
      : [];
    try {
      execFileSync('git', ['merge', '--abort'], {
        cwd: resolvedTempWorktreePath,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // No active merge to abort.
    }
    const landingError = new Error(message);
    landingError.code = reasonCode;
    landingError.details = {
      branch,
      base_branch: baseBranch,
      merge_branches: uniqueBranches,
      failed_branch: currentMergeBranch,
      conflicting_files: conflictingFiles,
      output: combinedOutput.slice(0, 1000),
      temp_worktree_path: resolvedTempWorktreePath,
    };
    throw landingError;
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', resolvedTempWorktreePath, '--force'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      rmSync(resolvedTempWorktreePath, { recursive: true, force: true });
    }
  }
}

export function gitPrepareIntegrationRecoveryWorktree(repoRoot, {
  branch,
  baseBranch = 'main',
  mergeBranches = [],
  recoveryPath,
} = {}) {
  const uniqueBranches = [...new Set(mergeBranches.filter(Boolean))].filter((candidate) => candidate !== branch);
  if (!recoveryPath) {
    throw new Error('Recovery path is required.');
  }
  if (existsSync(recoveryPath)) {
    throw new Error(`Recovery path already exists: ${recoveryPath}`);
  }

  execFileSync('git', ['worktree', 'add', '--detach', recoveryPath, baseBranch], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    execFileSync('git', ['checkout', '-B', branch, baseBranch], {
      cwd: recoveryPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (const mergeBranch of uniqueBranches) {
      try {
        execFileSync('git', ['merge', '--no-ff', '--no-edit', mergeBranch], {
          cwd: recoveryPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const conflictingFiles = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
          cwd: recoveryPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim().split('\n').filter(Boolean);
        return {
          ok: false,
          branch,
          base_branch: baseBranch,
          recovery_path: recoveryPath,
          merged_branches: uniqueBranches,
          failed_branch: mergeBranch,
          conflicting_files: conflictingFiles,
          output: `${String(err.stdout || '')}${String(err.stderr || '')}`.trim().slice(0, 1000),
        };
      }
    }

    return {
      ok: true,
      branch,
      base_branch: baseBranch,
      recovery_path: recoveryPath,
      merged_branches: uniqueBranches,
      head_commit: gitRevParse(recoveryPath, 'HEAD'),
      conflicting_files: [],
      failed_branch: null,
      output: '',
    };
  } catch (err) {
    try {
      execFileSync('git', ['worktree', 'remove', recoveryPath, '--force'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      rmSync(recoveryPath, { recursive: true, force: true });
    }
    throw err;
  }
}

export function gitRemoveWorktree(repoRoot, worktreePath) {
  execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function gitPruneWorktrees(repoRoot) {
  execFileSync('git', ['worktree', 'prune'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isSwitchmanTempLandingWorktreePath(worktreePath) {
  const resolvedPath = normalizeFsPath(worktreePath || '');
  const tempRoot = normalizeFsPath(tmpdir());
  return resolvedPath.startsWith(`${tempRoot}/`) && basename(resolvedPath).startsWith('switchman-landing-');
}

export function cleanupCrashedLandingTempWorktrees(
  repoRoot,
  {
    olderThanMs = 15 * 60 * 1000,
    now = Date.now(),
  } = {},
) {
  const actions = [];
  const beforePrune = listGitWorktrees(repoRoot)
    .filter((worktree) => isSwitchmanTempLandingWorktreePath(worktree.path));
  const missingBeforePrune = beforePrune.filter((worktree) => !existsSync(worktree.path));

  gitPruneWorktrees(repoRoot);

  const afterPrune = listGitWorktrees(repoRoot)
    .filter((worktree) => isSwitchmanTempLandingWorktreePath(worktree.path));
  const remainingPaths = new Set(afterPrune.map((worktree) => worktree.path));

  for (const worktree of missingBeforePrune) {
    if (!remainingPaths.has(worktree.path)) {
      actions.push({
        kind: 'stale_temp_worktree_pruned',
        path: worktree.path,
        branch: worktree.branch || null,
      });
    }
  }

  for (const worktree of afterPrune) {
    if (!existsSync(worktree.path)) continue;

    let ageMs = 0;
    try {
      ageMs = Math.max(0, now - statSync(worktree.path).mtimeMs);
    } catch {
      continue;
    }

    if (ageMs < olderThanMs) continue;

    gitRemoveWorktree(repoRoot, worktree.path);
    actions.push({
      kind: 'stale_temp_worktree_removed',
      path: worktree.path,
      branch: worktree.branch || null,
      age_ms: ageMs,
    });
  }

  return {
    repaired: actions.length > 0,
    actions,
  };
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
    stdio: ['pipe', 'pipe', 'pipe'],
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
