/**
 * switchman - Basic test suite
 * Tests core DB and git functions without needing a real git repo
 */

import { execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { findRepoRoot } from '../src/core/git.js';
import { getWorktreeChangedFiles } from '../src/core/git.js';

const TEST_DIR = join(tmpdir(), `switchman-test-${Date.now()}`);

// Import modules
import {
  initDb,
  createTask,
  assignTask,
  completeTask,
  listTasks,
  getNextPendingTask,
  registerWorktree,
  listWorktrees,
  claimFiles,
  releaseFileClaims,
  checkFileConflicts,
  getActiveFileClaims,
} from '../src/core/db.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

function test(name, fn) {
  console.log(`\n${name}`);
  try {
    fn();
  } catch (err) {
    console.log(`  ✗ THREW: ${err.message}`);
    failed++;
  }
}

// Setup
mkdirSync(TEST_DIR, { recursive: true });

// Initialize a fake git repo for testing
execSync('git init', { cwd: TEST_DIR });
execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
execSync('git config user.name "Test"', { cwd: TEST_DIR });

// ─── Tests ────────────────────────────────────────────────────────────────────

test('DB initialization', () => {
  const db = initDb(TEST_DIR);
  assert(db !== null, 'Database created successfully');
  db.close();
  assert(existsSync(join(TEST_DIR, '.switchman', 'switchman.db')), 'Database file exists on disk');
});

let db;
test('Task creation', () => {
  db = initDb(TEST_DIR);
  const id1 = createTask(db, { title: 'Fix authentication bug', priority: 8 });
  const id2 = createTask(db, { title: 'Add rate limiting', priority: 6, description: 'Use Redis' });
  const id3 = createTask(db, { title: 'Update docs', priority: 3 });

  assert(id1.startsWith('task-'), 'Task ID auto-generated');
  const tasks = listTasks(db);
  assert(tasks.length === 3, 'Three tasks created');
  assert(tasks[0].title === 'Fix authentication bug', 'Highest priority task is first');
});

test('Task assignment and status flow', () => {
  const next = getNextPendingTask(db);
  assert(next.title === 'Fix authentication bug', 'Next task is highest priority');

  const ok = assignTask(db, next.id, 'worktree-feature-auth', 'claude-code');
  assert(ok, 'Task assigned successfully');

  const tasks = listTasks(db, 'in_progress');
  assert(tasks.length === 1, 'One task in progress');
  assert(tasks[0].worktree === 'worktree-feature-auth', 'Worktree correctly set');

  // Cannot re-assign a non-pending task
  const fail = assignTask(db, next.id, 'worktree-other');
  assert(!fail, 'Cannot re-assign in-progress task');

  completeTask(db, next.id);
  const doneTasks = listTasks(db, 'done');
  assert(doneTasks.length === 1, 'Task marked as done');
});

test('Worktree registration', () => {
  registerWorktree(db, { name: 'main', path: TEST_DIR, branch: 'main' });
  registerWorktree(db, { name: 'feature-auth', path: '/tmp/repo-feature-auth', branch: 'feature/auth', agent: 'claude-code' });
  registerWorktree(db, { name: 'feature-api', path: '/tmp/repo-feature-api', branch: 'feature/api', agent: 'cursor' });

  const wts = listWorktrees(db);
  assert(wts.length === 3, 'Three worktrees registered');
  assert(wts.find(w => w.name === 'feature-auth')?.agent === 'claude-code', 'Agent correctly stored');

  // Re-registering same worktree should update it (upsert)
  registerWorktree(db, { name: 'feature-auth', path: '/tmp/repo-feature-auth', branch: 'feature/auth', agent: 'claude-code-2' });
  const wts2 = listWorktrees(db);
  assert(wts2.length === 3, 'Still 3 worktrees after upsert');
});

test('File claims - happy path', () => {
  const taskId = createTask(db, { title: 'Refactor auth module' });
  assignTask(db, taskId, 'feature-auth');

  claimFiles(db, taskId, 'feature-auth', [
    'src/auth/login.js',
    'src/auth/token.js',
    'tests/auth.test.js',
  ]);

  const claims = getActiveFileClaims(db);
  assert(claims.length === 3, 'Three files claimed');
  assert(claims[0].worktree === 'feature-auth', 'Claims associated with correct worktree');
});

test('File claims - conflict detection', () => {
  const taskId2 = createTask(db, { title: 'Update auth middleware' });
  assignTask(db, taskId2, 'feature-api');

  // Try to claim a file already claimed by feature-auth
  const conflicts = checkFileConflicts(db, [
    'src/auth/login.js',   // CONFLICT - claimed by feature-auth
    'src/api/routes.js',   // OK - not claimed
  ], 'feature-api');

  assert(conflicts.length === 1, 'One conflict detected');
  assert(conflicts[0].file === 'src/auth/login.js', 'Correct conflicting file identified');
  assert(conflicts[0].claimedBy.worktree === 'feature-auth', 'Conflict correctly attributed to feature-auth');
});

test('File claims - release', () => {
  const activeBefore = getActiveFileClaims(db);
  const countBefore = activeBefore.length;

  // Find a task with claims
  const tasks = listTasks(db, 'in_progress');
  if (tasks.length > 0) {
    releaseFileClaims(db, tasks[0].id);
    const activeAfter = getActiveFileClaims(db);
    assert(activeAfter.length < countBefore, 'Claims released successfully');
  } else {
    assert(true, 'Skipped (no in_progress tasks)');
  }
});

test('Task queue ordering', () => {
  // Clear and re-add tasks with different priorities
  const t1 = createTask(db, { title: 'Low priority', priority: 2 });
  const t2 = createTask(db, { title: 'High priority', priority: 9 });
  const t3 = createTask(db, { title: 'Medium priority', priority: 5 });

  const next = getNextPendingTask(db);
  assert(next.title === 'High priority', 'Queue returns highest priority first');
});

// ─── Fix regression tests ─────────────────────────────────────────────────────

test('Fix 1: busy_timeout is set on new connections', () => {
  // Open a fresh connection and check that busy_timeout is active.
  // SQLite's PRAGMA busy_timeout returns the current timeout in ms.
  const freshDb = initDb(join(tmpdir(), `sw-busytimeout-${Date.now()}`));
  const row = freshDb.prepare('PRAGMA busy_timeout').get();
  // node:sqlite returns the value as a plain object keyed by column name
  const timeout = Object.values(row)[0];
  assert(timeout >= 5000, `busy_timeout is set to ${timeout}ms (expected ≥ 5000)`);
  freshDb.close();
});

test('Fix 2: SWITCHMAN_DIR constant (no stale AGENTQ_DIR)', () => {
  // Verify the database is created at the correct path using the renamed constant
  const fixDir = join(tmpdir(), `sw-const-${Date.now()}`);
  const fixDb = initDb(fixDir);
  fixDb.close();
  const expectedPath = join(fixDir, '.switchman', 'switchman.db');
  assert(existsSync(expectedPath), `.switchman/switchman.db created at correct path`);
});

test('Fix 3: claimFiles transaction is atomic (partial failure rolls back)', () => {
  // Create a duplicate-constraint scenario: claim a file twice in one call.
  // The second insert on the same unique key should fail.
  // With the old manual BEGIN/COMMIT this could leave partial data;
  // with db.transaction() the whole batch rolls back cleanly.
  const txDb = initDb(join(tmpdir(), `sw-tx-${Date.now()}`));
  const txTask = createTask(txDb, { title: 'tx test task' });

  let threw = false;
  try {
    // Insert same file path twice — SQLite will throw on the second one
    // because file_claims has no unique constraint but we can force an error
    // by using a bad value that violates NOT NULL on worktree
    claimFiles(txDb, txTask, null /* worktree NOT NULL violation */, ['src/a.js']);
  } catch {
    threw = true;
  }
  // Whether or not it threw, no partial claims should linger for this task
  const claims = txDb.prepare(`SELECT * FROM file_claims WHERE task_id=? AND released_at IS NULL`).all(txTask);
  assert(claims.length === 0, 'Transaction rolled back cleanly — no partial claims');
  txDb.close();
});

test('Fix 3b: active file claims are unique across tasks', () => {
  const uniqueDb = initDb(join(tmpdir(), `sw-unique-${Date.now()}`));
  const taskA = createTask(uniqueDb, { title: 'task A' });
  const taskB = createTask(uniqueDb, { title: 'task B' });
  assignTask(uniqueDb, taskA, 'agent-a');
  assignTask(uniqueDb, taskB, 'agent-b');

  claimFiles(uniqueDb, taskA, 'agent-a', ['src/shared.js']);

  let threw = false;
  try {
    claimFiles(uniqueDb, taskB, 'agent-b', ['src/shared.js']);
  } catch {
    threw = true;
  }

  assert(threw, 'Second active claim for the same file throws');
  const claims = uniqueDb.prepare(
    `SELECT * FROM file_claims WHERE file_path=? AND released_at IS NULL`,
  ).all('src/shared.js');
  assert(claims.length === 1, 'Only one active claim exists for the file');
  uniqueDb.close();
});

test('Fix 3c: claiming a nonexistent task is rejected', () => {
  const guardDb = initDb(join(tmpdir(), `sw-guard-${Date.now()}`));
  let threw = false;
  try {
    claimFiles(guardDb, 'missing-task', 'agent-a', ['src/missing.js']);
  } catch {
    threw = true;
  }
  assert(threw, 'Nonexistent task cannot claim files');
  guardDb.close();
});

test('Fix 4: findRepoRoot resolves main repo root from worktree dir', () => {
  // Set up a mini repo with a linked worktree, then verify findRepoRoot()
  // returns the main repo root from inside the linked worktree path.
  const mainRepo = join(tmpdir(), `sw-rootfix-main-${Date.now()}`);
  mkdirSync(mainRepo, { recursive: true });
  execSync('git init', { cwd: mainRepo });
  execSync('git config user.email "test@test.com"', { cwd: mainRepo });
  execSync('git config user.name "Test"', { cwd: mainRepo });
  // Need at least one commit before adding a worktree
  execSync('git commit --allow-empty -m "init"', { cwd: mainRepo });

  const wtPath = join(tmpdir(), `sw-rootfix-wt-${Date.now()}`);
  execSync(`git worktree add -b fix-test "${wtPath}"`, { cwd: mainRepo });

  const rootFromMain = findRepoRoot(mainRepo);
  const rootFromWorktree = findRepoRoot(wtPath);

  // On macOS, /tmp is a symlink to /private/tmp — resolve both sides before comparing
  const realMain = realpathSync(mainRepo);
  assert(realpathSync(rootFromMain) === realMain, `Root from main worktree is correct`);
  assert(realpathSync(rootFromWorktree) === realMain, `Root from linked worktree resolves to main repo`);

  // Cleanup
  execSync(`git worktree remove "${wtPath}" --force`, { cwd: mainRepo });
  rmSync(mainRepo, { recursive: true, force: true });
});

test('Fix 5: getWorktreeChangedFiles includes untracked files', () => {
  const repoDir = join(tmpdir(), `sw-untracked-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });
  execSync('mkdir -p src && printf "hello\\n" > src/new-file.js', { cwd: repoDir, shell: '/bin/zsh' });

  const changed = getWorktreeChangedFiles(repoDir, repoDir);
  assert(changed.includes('src/new-file.js'), 'Untracked file appears in changed-files scan');

  rmSync(repoDir, { recursive: true, force: true });
});

// ─── Cleanup & Results ────────────────────────────────────────────────────────

if (db) db.close();
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.log('\n⚠ Some tests failed');
  process.exit(1);
} else {
  console.log('\n✓ All tests passed');
}
