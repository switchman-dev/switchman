import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import { discoverWorktreeSessions, syncDiscoveredWorktrees } from '../src/core/board-discovery.js';

function isolateBoardRoots(root) {
  const boardRootsFile = join(root, 'board-roots.json');
  writeFileSync(boardRootsFile, '{"repos":[]}\n');
  process.env.SWITCHMAN_BOARD_ROOTS_FILE = boardRootsFile;
  return boardRootsFile;
}

test('syncDiscoveredWorktrees auto-registers existing git worktrees', () => {
  const root = mkdtempSync(join(tmpdir(), 'switchman-discovery-'));
  const repo = join(root, 'repo');
  const registry = join(root, 'sessions.json');
  const lanePath = join(root, 'lane-a');

  try {
    isolateBoardRoots(root);
    git(root, ['init', '-b', 'main', repo]);
    git(repo, ['config', 'user.email', 'switchman@example.test']);
    git(repo, ['config', 'user.name', 'Switchman Test']);
    writeFileSync(join(repo, 'README.md'), '# Fixture\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'Initial commit']);
    git(repo, ['worktree', 'add', '-b', 'feature/auth', lanePath, 'main']);
    writeFileSync(join(lanePath, 'auth.ts'), 'export const auth = true;\n');

    const sessions = syncDiscoveredWorktrees(registry, { extraRepoRoots: [repo] });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].registeredBy, 'discovered');
    assert.equal(sessions[0].branchName, 'feature/auth');
    assert.ok(sessions[0].filesTouched.includes('auth.ts'));

    const discovered = discoverWorktreeSessions(repo, sessions);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].taskName, 'feature auth');
  } finally {
    delete process.env.SWITCHMAN_BOARD_ROOTS_FILE;
    rmSync(root, { force: true, recursive: true });
  }
});

test('syncDiscoveredWorktrees preserves cli-registered task metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'switchman-discovery-cli-'));
  const repo = join(root, 'repo');
  const registry = join(root, 'sessions.json');
  const lanePath = join(root, 'lane-cli');

  try {
    isolateBoardRoots(root);
    git(root, ['init', '-b', 'main', repo]);
    git(repo, ['config', 'user.email', 'switchman@example.test']);
    git(repo, ['config', 'user.name', 'Switchman Test']);
    writeFileSync(join(repo, 'README.md'), '# Fixture\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['commit', '-m', 'Initial commit']);
    git(repo, ['worktree', 'add', '-b', 'switchman/cart', lanePath, 'main']);

    writeFileSync(
      registry,
      `${JSON.stringify({
        sessions: [
          {
            id: 'cart',
            taskName: 'refactor cart total',
            agent: 'codex',
            repoRoot: repo,
            baseRef: 'main',
            worktreePath: lanePath,
            branchName: 'switchman/cart',
            status: 'in-progress',
            filesTouched: [],
            registeredBy: 'cli',
          },
        ],
      }, null, 2)}\n`,
    );

    const sessions = syncDiscoveredWorktrees(registry, { extraRepoRoots: [repo] });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].registeredBy, 'cli');
    assert.equal(sessions[0].taskName, 'refactor cart total');
    assert.equal(sessions[0].agent, 'codex');
  } finally {
    delete process.env.SWITCHMAN_BOARD_ROOTS_FILE;
    rmSync(root, { force: true, recursive: true });
  }
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
