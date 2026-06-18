import { existsSync, statSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { findRepoRoot, getWorktreeChangedFiles, listGitWorktrees } from './git.js';
import {
  readRegistryUnlocked,
  resolveBoardRegistryPath,
  withRegistryLock,
  writeRegistryUnlocked,
} from './board-registry.js';
import { collectBoardRepoRoots, rememberBoardRepo } from './board-roots.js';

function normalizePath(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || `lane-${Date.now()}`;
}

function humanizeBranch(branchName) {
  const stripped = String(branchName || '')
    .replace(/^refs\/heads\//, '')
    .replace(/^switchman\//, '')
    .replace(/[-_/]+/g, ' ')
    .trim();

  return stripped || 'parallel lane';
}

function uniqueId(base, sessions) {
  const existing = new Set(sessions.map((session) => session.id));
  if (!existing.has(base)) return base;

  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function inferBaseRef(repoRoot, worktrees) {
  const main = worktrees.find((worktree) => worktree.isMain);
  return main?.branch || 'main';
}

function inferDiscoveredStatus(session) {
  if (worktreeRecentlyActive(session.worktreePath, session.filesTouched || [])) return 'in-progress';

  const hasChanges = (session.filesTouched || []).length > 0;
  return hasChanges ? 'review' : 'planning';
}

export function discoverWorktreeSessions(repoRoot, existingSessions = []) {
  const normalizedRepoRoot = normalizePath(repoRoot);
  if (!existsSync(normalizedRepoRoot)) return [];

  let worktrees;
  try {
    worktrees = listGitWorktrees(normalizedRepoRoot);
  } catch {
    return [];
  }

  const baseRef = inferBaseRef(normalizedRepoRoot, worktrees);
  const now = new Date().toISOString();
  const discovered = [];

  for (const worktree of worktrees) {
    if (worktree.isMain || worktree.bare || !worktree.path) continue;

    const worktreePath = normalizePath(worktree.path);
    const branchName = worktree.branch || basename(worktreePath);
    const id = uniqueId(slugify(branchName || basename(worktreePath)), [...existingSessions, ...discovered]);
    const filesTouched = getWorktreeChangedFiles(worktreePath, normalizedRepoRoot);
    const session = {
      id,
      taskName: humanizeBranch(branchName),
      agent: 'other',
      repoRoot: normalizedRepoRoot,
      baseRef,
      worktreePath,
      branchName,
      status: 'in-progress',
      filesTouched,
      registeredBy: 'discovered',
      createdAt: now,
      updatedAt: now,
    };

    session.status = inferDiscoveredStatus(session);
    discovered.push(session);
  }

  return discovered;
}

export function syncDiscoveredWorktrees(registryPath, { extraRepoRoots = [], includeTrackedRepos } = {}) {
  return withRegistryLock(registryPath, () => {
    const registry = readRegistryUnlocked(registryPath);
    const existing = registry.sessions.map((session) => ({ ...session }));
    const includeTracked = includeTrackedRepos ?? registryPath === resolveBoardRegistryPath();
    const repoRoots = collectBoardRepoRoots(existing, extraRepoRoots, { includeTracked });
    const discovered = repoRoots.flatMap((repoRoot) =>
      discoverWorktreeSessions(repoRoot, existing),
    );

    const byWorktree = new Map(
      existing.map((session) => [normalizePath(session.worktreePath), session]),
    );

    let changed = false;

    for (const candidate of discovered) {
      const key = normalizePath(candidate.worktreePath);
      const current = byWorktree.get(key);

      if (!current) {
        existing.push(candidate);
        byWorktree.set(key, candidate);
        changed = true;
        continue;
      }

      const isDiscovered = current.registeredBy === 'discovered';
      const patch = {
        repoRoot: candidate.repoRoot,
        baseRef: candidate.baseRef,
        branchName: candidate.branchName,
        worktreePath: candidate.worktreePath,
        filesTouched: candidate.filesTouched,
        updatedAt: new Date().toISOString(),
      };

      if (isDiscovered) {
        patch.taskName = candidate.taskName;
        patch.agent = candidate.agent;
        patch.status = candidate.status;
        patch.registeredBy = 'discovered';
      } else if (current.status === 'in-progress' || current.status === 'planning') {
        patch.status = inferDiscoveredStatus({
          ...current,
          filesTouched: candidate.filesTouched,
        });
      }

      const next = { ...current, ...patch };
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        const index = existing.findIndex((session) => normalizePath(session.worktreePath) === key);
        if (index >= 0) existing[index] = next;
        byWorktree.set(key, next);
        changed = true;
      }
    }

    const discoveredPaths = new Set(discovered.map((session) => normalizePath(session.worktreePath)));
    const pruned = existing.filter((session) => {
      if (session.registeredBy !== 'discovered') return true;
      return discoveredPaths.has(normalizePath(session.worktreePath));
    });

    if (pruned.length !== existing.length) {
      changed = true;
    }

    if (changed) {
      registry.sessions = pruned;
      writeRegistryUnlocked(registryPath, registry);
    }

    return pruned;
  });
}

export function rememberBoardRepoFromCwd(cwd = process.cwd()) {
  try {
    const repoRoot = findRepoRoot(cwd);
    rememberBoardRepo(repoRoot);
    return repoRoot;
  } catch {
    return null;
  }
}

export function worktreeRecentlyActive(worktreePath, files, graceMs = 60 * 60 * 1000) {
  if (!worktreePath || !existsSync(worktreePath)) return false;

  const threshold = Date.now() - graceMs;

  for (const file of files) {
    const fullPath = resolve(worktreePath, file);
    if (!existsSync(fullPath)) continue;
    if (statSync(fullPath).mtimeMs >= threshold) return true;
  }

  return false;
}
