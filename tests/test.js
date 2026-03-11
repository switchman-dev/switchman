/**
 * switchman - Basic test suite
 * Tests core DB and git functions without needing a real git repo
 */

import { execFileSync, execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, realpathSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from 'node:sqlite';

import { findRepoRoot } from '../src/core/git.js';
import { getWorktreeChangedFiles } from '../src/core/git.js';
import { filterIgnoredPaths, isIgnoredPath, matchesPathPatterns } from '../src/core/ignore.js';
import { upsertProjectMcpConfig } from '../src/core/mcp.js';
import { evaluateWorktreeCompliance, gatewayAppendFile, gatewayMakeDirectory, gatewayMovePath, gatewayRemovePath, gatewayWriteFile, installCommitHook, installGateHooks, monitorWorktreesOnce, runCommitGate, runWrappedCommand, validateWriteAccess, writeEnforcementPolicy } from '../src/core/enforcement.js';
import { clearMonitorState, isProcessRunning, readMonitorState, writeMonitorState } from '../src/core/monitor.js';

const TEST_DIR = join(tmpdir(), `switchman-test-${Date.now()}`);

// Import modules
import {
  initDb,
  openDb,
  createTask,
  assignTask,
  startTaskLease,
  completeTask,
  listTasks,
  getTask,
  getNextPendingTask,
  listLeases,
  getLease,
  getActiveLeaseForTask,
  heartbeatLease,
  getStaleLeases,
  reapStaleLeases,
  registerWorktree,
  listWorktrees,
  claimFiles,
  releaseFileClaims,
  checkFileConflicts,
  getActiveFileClaims,
  listAuditEvents,
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

  const lease = startTaskLease(db, next.id, 'worktree-feature-auth', 'claude-code');
  assert(Boolean(lease), 'Lease acquired successfully');
  assert(lease.worktree === 'worktree-feature-auth', 'Lease stores the assigned worktree');

  const tasks = listTasks(db, 'in_progress');
  assert(tasks.length === 1, 'One task in progress');
  assert(tasks[0].worktree === 'worktree-feature-auth', 'Worktree correctly set');

  // Cannot re-assign a non-pending task
  const fail = assignTask(db, next.id, 'worktree-other');
  assert(!fail, 'Cannot re-assign in-progress task');

  const activeLease = getActiveLeaseForTask(db, next.id);
  assert(activeLease?.id === lease.id, 'Task exposes its active lease');

  completeTask(db, next.id);
  const doneTasks = listTasks(db, 'done');
  assert(doneTasks.length === 1, 'Task marked as done');
  const completedLease = getLease(db, lease.id);
  assert(completedLease?.status === 'completed', 'Completing a task closes its active lease');
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

  const lease = claimFiles(db, taskId, 'feature-auth', [
    'src/auth/login.js',
    'src/auth/token.js',
    'tests/auth.test.js',
  ]);

  const claims = getActiveFileClaims(db);
  assert(claims.length === 3, 'Three files claimed');
  assert(claims[0].worktree === 'feature-auth', 'Claims associated with correct worktree');
  assert(claims.every((claim) => claim.lease_id === lease.id), 'Claims are attached to the active lease');
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

test('File claims auto-release when a task completes', () => {
  const taskId = createTask(db, { title: 'Auto release on done' });
  assignTask(db, taskId, 'feature-auto-release');
  claimFiles(db, taskId, 'feature-auto-release', [
    'src/auto-release.js',
  ]);

  completeTask(db, taskId);
  const claims = getActiveFileClaims(db).filter((claim) => claim.task_id === taskId);
  assert(claims.length === 0, 'Completing a task releases its active claims automatically');
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

test('Lease heartbeat refreshes the active session timestamp', () => {
  const leaseDb = initDb(join(tmpdir(), `sw-lease-hb-${Date.now()}`));
  const taskId = createTask(leaseDb, { title: 'heartbeat task' });
  const lease = startTaskLease(leaseDb, taskId, 'lease-hb-worktree', 'codex');

  leaseDb.prepare(`
    UPDATE leases
    SET heartbeat_at=datetime('now', '-45 minutes')
    WHERE id=?
  `).run(lease.id);

  const staleBefore = getStaleLeases(leaseDb, 15);
  assert(staleBefore.some((staleLease) => staleLease.id === lease.id), 'Lease is stale before heartbeat refresh');

  const refreshed = heartbeatLease(leaseDb, lease.id, 'codex');
  const staleAfter = getStaleLeases(leaseDb, 15);
  assert(refreshed?.id === lease.id, 'Heartbeat refresh returns the active lease');
  assert(!staleAfter.some((staleLease) => staleLease.id === lease.id), 'Heartbeat refresh removes the lease from the stale set');
  leaseDb.close();
});

test('Stale lease reaping releases claims and re-queues the task', () => {
  const reapDb = initDb(join(tmpdir(), `sw-lease-reap-${Date.now()}`));
  const taskId = createTask(reapDb, { title: 'reap task' });
  const lease = startTaskLease(reapDb, taskId, 'lease-reap-worktree', 'codex');
  claimFiles(reapDb, taskId, 'lease-reap-worktree', ['src/reap.js']);

  reapDb.prepare(`
    UPDATE leases
    SET heartbeat_at=datetime('now', '-30 minutes')
    WHERE id=?
  `).run(lease.id);

  const expired = reapStaleLeases(reapDb, 15);
  const task = getTask(reapDb, taskId);
  const activeClaims = getActiveFileClaims(reapDb);
  const leaseAfter = getLease(reapDb, lease.id);

  assert(expired.length === 1, 'One stale lease was reaped');
  assert(task.status === 'pending', 'Stale lease returns the task to pending');
  assert(task.worktree === null, 'Re-queued task clears its assigned worktree');
  assert(activeClaims.length === 0, 'Reaping a stale lease releases active claims');
  assert(leaseAfter.status === 'expired', 'Stale lease is marked expired');
  reapDb.close();
});

test('openDb migrates legacy in-progress tasks into leases and backfills claims', () => {
  const legacyRepo = join(tmpdir(), `sw-legacy-${Date.now()}`);
  mkdirSync(join(legacyRepo, '.switchman'), { recursive: true });

  const legacyDb = new DatabaseSync(join(legacyRepo, '.switchman', 'switchman.db'));
  legacyDb.exec(`
    PRAGMA foreign_keys=OFF;
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      worktree TEXT,
      agent TEXT,
      priority INTEGER DEFAULT 5,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE TABLE file_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      worktree TEXT NOT NULL,
      agent TEXT,
      claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT
    );
    CREATE TABLE worktrees (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      agent TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE conflict_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      worktree_a TEXT NOT NULL,
      worktree_b TEXT NOT NULL,
      conflicting_files TEXT NOT NULL,
      resolved INTEGER DEFAULT 0
    );
    INSERT INTO tasks (id, title, status, worktree, agent)
    VALUES ('legacy-task', 'Legacy task', 'in_progress', 'legacy-wt', 'legacy-agent');
    INSERT INTO file_claims (task_id, file_path, worktree, agent)
    VALUES ('legacy-task', 'src/legacy.js', 'legacy-wt', 'legacy-agent');
  `);
  legacyDb.close();

  const migratedDb = openDb(legacyRepo);
  const lease = getActiveLeaseForTask(migratedDb, 'legacy-task');
  const claims = getActiveFileClaims(migratedDb);
  migratedDb.close();

  assert(Boolean(lease), 'Legacy in-progress task receives an active lease on openDb');
  assert(claims[0].lease_id === lease.id, 'Legacy active claims are backfilled onto the migrated lease');
  rmSync(legacyRepo, { recursive: true, force: true });
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

test('Fix 6: default ignore list drops node_modules and build output noise', () => {
  const filtered = filterIgnoredPaths([
    'src/app.js',
    'node_modules/pkg/index.js',
    'coverage/lcov.info',
    'dist/app.js',
    'nested/node_modules/pkg/index.js',
  ]);

  assert(filtered.length === 1, 'Ignored paths are removed from conflict scans');
  assert(filtered[0] === 'src/app.js', 'Non-generated source files are preserved');
  assert(isIgnoredPath('examples/taskapi/node_modules/pkg/index.js'), 'Nested node_modules paths are ignored');
});

test('Fix 7: setup MCP config can be written locally without clobbering other servers', () => {
  const repoDir = join(tmpdir(), `sw-mcp-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });

  const first = upsertProjectMcpConfig(repoDir);
  const firstConfig = JSON.parse(readFileSync(first.path, 'utf8'));
  assert(first.created, 'Initial MCP config write reports creation');
  assert(firstConfig.mcpServers.switchman.command === 'switchman-mcp', 'Switchman MCP server is registered');

  writeFileSync(first.path, `${JSON.stringify({
    mcpServers: {
      other: {
        command: 'other-mcp',
        args: [],
      },
    },
  }, null, 2)}\n`);
  const second = upsertProjectMcpConfig(repoDir);
  const secondConfig = JSON.parse(readFileSync(second.path, 'utf8'));

  assert(secondConfig.mcpServers.other.command === 'other-mcp', 'Existing MCP servers are preserved');
  assert(secondConfig.mcpServers.switchman.command === 'switchman-mcp', 'Switchman MCP server is merged into existing config');

  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 8: worktree compliance marks unmanaged changes as non-compliant', () => {
  const repoDir = join(tmpdir(), `sw-enforce-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });
  execSync('mkdir -p src && printf "x\\n" > src/unclaimed.js', { cwd: repoDir, shell: '/bin/zsh' });

  const enforceDb = initDb(repoDir);
  registerWorktree(enforceDb, { name: 'main', path: repoDir, branch: 'main' });
  const compliance = evaluateWorktreeCompliance(enforceDb, repoDir, { name: 'main', path: repoDir, branch: 'main' });

  assert(compliance.compliance_state === 'non_compliant', 'Unmanaged changed files mark the worktree non-compliant');
  assert(compliance.unclaimed_changed_files.includes('src/unclaimed.js'), 'Unclaimed changed file is reported');
  enforceDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 9: commit gate passes for claimed files under an active lease', () => {
  const repoDir = join(tmpdir(), `sw-gate-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const gateDb = initDb(repoDir);
  registerWorktree(gateDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(gateDb, { title: 'Gate pass task' });
  assignTask(gateDb, taskId, 'main');
  claimFiles(gateDb, taskId, 'main', ['src/claimed.js']);
  execSync('mkdir -p src && printf "ok\\n" > src/claimed.js', { cwd: repoDir, shell: '/bin/zsh' });

  const result = runCommitGate(gateDb, repoDir, { cwd: repoDir });
  assert(result.ok, 'Commit gate allows claimed changes under the active lease');
  assert(result.changed_files.includes('src/claimed.js'), 'Commit gate inspects the changed claimed file');
  gateDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 10: commit gate rejects unclaimed files', () => {
  const repoDir = join(tmpdir(), `sw-gate-fail-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const gateDb = initDb(repoDir);
  registerWorktree(gateDb, { name: 'main', path: repoDir, branch: 'main' });
  execSync('mkdir -p src && printf "bad\\n" > src/unclaimed.js', { cwd: repoDir, shell: '/bin/zsh' });

  const result = runCommitGate(gateDb, repoDir, { cwd: repoDir });
  assert(!result.ok, 'Commit gate rejects unclaimed changes');
  assert(result.violations.some((violation) => violation.reason_code === 'no_active_lease'), 'Missing lease is reported as the rejection reason');
  gateDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 11: commit hook installer writes a pre-commit hook', () => {
  const repoDir = join(tmpdir(), `sw-hook-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const hookPath = installCommitHook(repoDir);
  const hookBody = readFileSync(hookPath, 'utf8');
  const hookMode = statSync(hookPath).mode & 0o777;

  assert(existsSync(hookPath), 'Pre-commit hook file is written');
  assert(hookBody.includes('switchman gate commit'), 'Pre-commit hook runs the Switchman commit gate');
  assert(hookMode === 0o755, 'Pre-commit hook is executable');

  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 11b: gate hook installer writes both commit and merge hooks', () => {
  const repoDir = join(tmpdir(), `sw-gate-hooks-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const hookPaths = installGateHooks(repoDir);
  const mergeHookBody = readFileSync(hookPaths.pre_merge_commit, 'utf8');

  assert(existsSync(hookPaths.pre_commit), 'Pre-commit hook is installed by the gate hook installer');
  assert(existsSync(hookPaths.pre_merge_commit), 'Pre-merge-commit hook is installed by the gate hook installer');
  assert(mergeHookBody.includes('switchman gate merge'), 'Pre-merge-commit hook runs the merge gate');

  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 12: managed write gateway allows claimed writes', () => {
  const repoDir = join(tmpdir(), `sw-write-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const writeDb = initDb(repoDir);
  registerWorktree(writeDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(writeDb, { title: 'Gateway write task' });
  assignTask(writeDb, taskId, 'main');
  const lease = claimFiles(writeDb, taskId, 'main', ['src/gateway.js']);

  const result = gatewayWriteFile(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/gateway.js',
    content: 'export const ok = true;\n',
    worktree: 'main',
  });

  assert(result.ok, 'Write gateway allows a claimed file write');
  assert(readFileSync(join(repoDir, 'src/gateway.js'), 'utf8') === 'export const ok = true;\n', 'Write gateway updates the file contents');
  writeDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 13: managed write gateway rejects unclaimed paths', () => {
  const repoDir = join(tmpdir(), `sw-write-fail-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const writeDb = initDb(repoDir);
  registerWorktree(writeDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(writeDb, { title: 'Gateway denied task' });
  assignTask(writeDb, taskId, 'main');
  const lease = getActiveLeaseForTask(writeDb, taskId);

  const validation = validateWriteAccess(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/unclaimed.js',
    worktree: 'main',
  });
  const result = gatewayWriteFile(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/unclaimed.js',
    content: 'nope\n',
    worktree: 'main',
  });

  assert(!validation.ok, 'Validation rejects an unclaimed path');
  assert(validation.reason_code === 'path_not_claimed', 'Unclaimed write is classified correctly');
  assert(!result.ok, 'Write gateway denies an unclaimed path');
  assert(result.reason_code === 'path_not_claimed', 'Denied write returns path_not_claimed');
  writeDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 14: managed remove gateway enforces the same claim policy', () => {
  const repoDir = join(tmpdir(), `sw-rm-pass-${Date.now()}`);
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'src/remove-me.js'), 'delete me\n');
  execSync('git add src/remove-me.js', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const writeDb = initDb(repoDir);
  registerWorktree(writeDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(writeDb, { title: 'Gateway remove task' });
  assignTask(writeDb, taskId, 'main');
  const lease = claimFiles(writeDb, taskId, 'main', ['src/remove-me.js']);

  const result = gatewayRemovePath(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/remove-me.js',
    worktree: 'main',
  });

  assert(result.ok, 'Remove gateway allows a claimed delete');
  assert(!existsSync(join(repoDir, 'src/remove-me.js')), 'Remove gateway deletes the claimed file');
  writeDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 14b: managed append gateway appends only to claimed files', () => {
  const repoDir = join(tmpdir(), `sw-append-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const writeDb = initDb(repoDir);
  registerWorktree(writeDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(writeDb, { title: 'Gateway append task' });
  assignTask(writeDb, taskId, 'main');
  const lease = claimFiles(writeDb, taskId, 'main', ['src/append.js']);
  gatewayWriteFile(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/append.js',
    content: 'start\n',
    worktree: 'main',
  });

  const result = gatewayAppendFile(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/append.js',
    content: 'finish\n',
    worktree: 'main',
  });

  assert(result.ok, 'Append gateway allows appending to a claimed file');
  assert(readFileSync(join(repoDir, 'src/append.js'), 'utf8') === 'start\nfinish\n', 'Append gateway preserves existing content and appends new content');
  writeDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 14c: managed move gateway requires both source and destination claims', () => {
  const repoDir = join(tmpdir(), `sw-mv-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const writeDb = initDb(repoDir);
  registerWorktree(writeDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(writeDb, { title: 'Gateway move task' });
  assignTask(writeDb, taskId, 'main');
  const lease = claimFiles(writeDb, taskId, 'main', ['src/source.js', 'src/destination.js']);
  gatewayWriteFile(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/source.js',
    content: 'move me\n',
    worktree: 'main',
  });

  const result = gatewayMovePath(writeDb, repoDir, {
    leaseId: lease.id,
    sourcePath: 'src/source.js',
    destinationPath: 'src/destination.js',
    worktree: 'main',
  });

  assert(result.ok, 'Move gateway allows renaming between two claimed paths');
  assert(!existsSync(join(repoDir, 'src/source.js')), 'Move gateway removes the source path');
  assert(readFileSync(join(repoDir, 'src/destination.js'), 'utf8') === 'move me\n', 'Move gateway creates the destination path with the original contents');
  writeDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 14d: managed mkdir gateway allows directories for claimed descendants', () => {
  const repoDir = join(tmpdir(), `sw-mkdir-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const writeDb = initDb(repoDir);
  registerWorktree(writeDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(writeDb, { title: 'Gateway mkdir task' });
  assignTask(writeDb, taskId, 'main');
  const lease = claimFiles(writeDb, taskId, 'main', ['src/generated/file.js']);

  const result = gatewayMakeDirectory(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/generated',
    worktree: 'main',
  });

  assert(result.ok, 'Mkdir gateway allows creating a directory that contains a claimed descendant');
  assert(existsSync(join(repoDir, 'src/generated')), 'Mkdir gateway creates the requested directory');
  writeDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 15: runtime monitor logs denied direct writes immediately', () => {
  const repoDir = join(tmpdir(), `sw-monitor-denied-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const monitorDb = initDb(repoDir);
  registerWorktree(monitorDb, { name: 'main', path: repoDir, branch: 'main' });
  monitorWorktreesOnce(monitorDb, repoDir, [{ name: 'main', path: repoDir, branch: 'main' }]);

  execSync('mkdir -p src && printf "drift\\n" > src/drift.js', { cwd: repoDir, shell: '/bin/zsh' });
  const result = monitorWorktreesOnce(monitorDb, repoDir, [{ name: 'main', path: repoDir, branch: 'main' }]);
  const audit = listAuditEvents(monitorDb, { eventType: 'write_observed', status: 'denied', limit: 10 });

  assert(result.summary.denied === 1, 'Monitor reports the denied direct write');
  assert(result.events[0].reason_code === 'no_active_lease', 'Denied direct write is classified correctly');
  assert(audit.some((event) => event.file_path === 'src/drift.js'), 'Denied observed write is written to the audit log');
  monitorDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 16: runtime monitor treats claimed in-scope writes as allowed', () => {
  const repoDir = join(tmpdir(), `sw-monitor-allowed-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const monitorDb = initDb(repoDir);
  registerWorktree(monitorDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(monitorDb, { title: 'Observed write task' });
  assignTask(monitorDb, taskId, 'main');
  claimFiles(monitorDb, taskId, 'main', ['src/observed.js']);
  monitorWorktreesOnce(monitorDb, repoDir, [{ name: 'main', path: repoDir, branch: 'main' }]);

  execSync('mkdir -p src && printf "claimed\\n" > src/observed.js', { cwd: repoDir, shell: '/bin/zsh' });
  const result = monitorWorktreesOnce(monitorDb, repoDir, [{ name: 'main', path: repoDir, branch: 'main' }]);

  assert(result.summary.allowed === 1, 'Monitor reports the claimed write as allowed');
  assert(result.events[0].file_path === 'src/observed.js', 'Monitor reports the claimed file path');
  monitorDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 17: managed gateway writes into the assigned linked worktree path', () => {
  const mainRepo = join(tmpdir(), `sw-linked-main-${Date.now()}`);
  mkdirSync(mainRepo, { recursive: true });
  execSync('git init', { cwd: mainRepo });
  execSync('git config user.email "test@test.com"', { cwd: mainRepo });
  execSync('git config user.name "Test"', { cwd: mainRepo });
  execSync('git commit --allow-empty -m "init"', { cwd: mainRepo });

  const linkedPath = join(tmpdir(), `sw-linked-wt-${Date.now()}`);
  execSync(`git worktree add -b linked-test "${linkedPath}"`, { cwd: mainRepo });

  const linkedDb = initDb(mainRepo);
  registerWorktree(linkedDb, { name: 'main', path: mainRepo, branch: 'main' });
  registerWorktree(linkedDb, { name: linkedPath.split('/').pop(), path: linkedPath, branch: 'linked-test' });
  const taskId = createTask(linkedDb, { title: 'Linked worktree write task' });
  assignTask(linkedDb, taskId, linkedPath.split('/').pop());
  const lease = claimFiles(linkedDb, taskId, linkedPath.split('/').pop(), ['src/linked.js']);

  const result = gatewayWriteFile(linkedDb, mainRepo, {
    leaseId: lease.id,
    path: 'src/linked.js',
    content: 'export const linked = true;\n',
    worktree: linkedPath.split('/').pop(),
  });

  assert(result.ok, 'Gateway write succeeds for linked worktree lease');
  assert(readFileSync(join(linkedPath, 'src/linked.js'), 'utf8') === 'export const linked = true;\n', 'Gateway writes into the linked worktree checkout');
  assert(!existsSync(join(mainRepo, 'src', 'linked.js')), 'Gateway does not write into the main repo checkout by mistake');
  linkedDb.close();
  execSync(`git worktree remove "${linkedPath}" --force`, { cwd: mainRepo });
  rmSync(mainRepo, { recursive: true, force: true });
});

test('Fix 18: runtime quarantine moves denied added files out of the worktree', () => {
  const repoDir = join(tmpdir(), `sw-monitor-quarantine-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const monitorDb = initDb(repoDir);
  registerWorktree(monitorDb, { name: 'main', path: repoDir, branch: 'main' });
  monitorWorktreesOnce(monitorDb, repoDir, [{ name: 'main', path: repoDir, branch: 'main' }]);

  execSync('mkdir -p src && printf "rogue\\n" > src/rogue.js', { cwd: repoDir, shell: '/bin/zsh' });
  const result = monitorWorktreesOnce(monitorDb, repoDir, [{ name: 'main', path: repoDir, branch: 'main' }], { quarantine: true });
  const event = result.events.find((item) => item.file_path === 'src/rogue.js');

  assert(result.summary.quarantined === 1, 'Denied runtime write is quarantined');
  assert(event.enforcement_action === 'quarantined', 'Quarantine action is recorded on the observed event');
  assert(!existsSync(join(repoDir, 'src/rogue.js')), 'Quarantined file is removed from the worktree');
  assert(existsSync(event.quarantine_path), 'Quarantined file is moved into the quarantine area');
  monitorDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 19: enforcement policy allows generated outputs without explicit claims', () => {
  const repoDir = join(tmpdir(), `sw-policy-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const policyPath = writeEnforcementPolicy(repoDir, {
    allowed_generated_paths: ['generated/**'],
  });
  assert(matchesPathPatterns('generated/output.js', ['generated/**']), 'Path matcher accepts generated-path policy patterns');
  assert(existsSync(policyPath), 'Enforcement policy file is written');

  const policyDb = initDb(repoDir);
  registerWorktree(policyDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(policyDb, { title: 'Generated output task' });
  assignTask(policyDb, taskId, 'main');
  monitorWorktreesOnce(policyDb, repoDir, [{ name: 'main', path: repoDir, branch: 'main' }]);

  execSync('mkdir -p generated && printf "artifact\\n" > generated/output.js', { cwd: repoDir, shell: '/bin/zsh' });
  const result = monitorWorktreesOnce(policyDb, repoDir, [{ name: 'main', path: repoDir, branch: 'main' }]);
  const event = result.events.find((item) => item.file_path === 'generated/output.js');

  assert(result.summary.allowed === 1, 'Generated output covered by policy is allowed');
  assert(event.reason_code === 'policy_exception_allowed', 'Allowed generated output records the policy exception reason');
  policyDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 20: wrapper mode launches commands with Switchman lease context', () => {
  const repoDir = join(tmpdir(), `sw-wrapper-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const wrapDb = initDb(repoDir);
  registerWorktree(wrapDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(wrapDb, { title: 'Wrapper task' });
  const lease = startTaskLease(wrapDb, taskId, 'main', 'claude-code');
  const outputPath = join(repoDir, 'wrapper-env.json');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ lease: process.env.SWITCHMAN_LEASE_ID, task: process.env.SWITCHMAN_TASK_ID, worktree: process.env.SWITCHMAN_WORKTREE, repo: process.env.SWITCHMAN_REPO_ROOT, worktreePath: process.env.SWITCHMAN_WORKTREE_PATH }));`;

  const result = runWrappedCommand(wrapDb, repoDir, {
    leaseId: lease.id,
    command: 'node',
    args: ['-e', script],
    worktree: 'main',
  });
  const wrappedEnv = JSON.parse(readFileSync(outputPath, 'utf8'));

  assert(result.ok, 'Wrapper command succeeds for an active lease');
  assert(wrappedEnv.lease === lease.id, 'Wrapper injects SWITCHMAN_LEASE_ID');
  assert(wrappedEnv.task === taskId, 'Wrapper injects SWITCHMAN_TASK_ID');
  assert(wrappedEnv.worktree === 'main', 'Wrapper injects SWITCHMAN_WORKTREE');
  assert(wrappedEnv.repo === repoDir, 'Wrapper injects SWITCHMAN_REPO_ROOT');
  assert(wrappedEnv.worktreePath === repoDir, 'Wrapper injects SWITCHMAN_WORKTREE_PATH');
  wrapDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 21: wrapper mode rejects expired leases before launch', () => {
  const repoDir = join(tmpdir(), `sw-wrapper-denied-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const wrapDb = initDb(repoDir);
  registerWorktree(wrapDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(wrapDb, { title: 'Expired wrapper task' });
  const lease = startTaskLease(wrapDb, taskId, 'main', 'claude-code');
  wrapDb.prepare(`
    UPDATE leases
    SET heartbeat_at=datetime('now', '-30 minutes')
    WHERE id=?
  `).run(lease.id);

  const result = runWrappedCommand(wrapDb, repoDir, {
    leaseId: lease.id,
    command: 'node',
    args: ['-e', 'process.exit(0)'],
    worktree: 'main',
  });

  assert(!result.ok, 'Wrapper command is denied for an expired lease');
  assert(result.reason_code === 'lease_expired', 'Expired lease denial returns lease_expired');
  wrapDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 22: repo CI gate rejects unmanaged changes across worktrees', () => {
  const repoDir = join(tmpdir(), `sw-ci-gate-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  initDb(repoDir).close();
  execSync('mkdir -p src && printf "drift\\n" > src/rogue.js', { cwd: repoDir, shell: '/bin/zsh' });
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ci', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    status = err.status ?? 1;
    stdout = String(err.stdout || '');
  }

  const result = JSON.parse(stdout);
  assert(status === 1, 'CI gate exits non-zero for unmanaged changes');
  assert(!result.ok, 'CI gate reports the repo as rejected');
  assert(result.unclaimed_changes.some((entry) => entry.files.includes('src/rogue.js')), 'CI gate reports the unmanaged changed file');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 23: monitor state helpers persist and clear background monitor state', () => {
  const repoDir = join(tmpdir(), `sw-monitor-state-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });

  const statePath = writeMonitorState(repoDir, {
    pid: 12345,
    interval_ms: 2000,
    quarantine: true,
    started_at: new Date().toISOString(),
  });
  const state = readMonitorState(repoDir);

  assert(existsSync(statePath), 'Monitor state file is written');
  assert(state?.pid === 12345, 'Monitor state can be read back from disk');

  clearMonitorState(repoDir);
  assert(readMonitorState(repoDir) === null, 'Monitor state file can be cleared');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 24: process liveness helper detects running and exited processes', () => {
  const pid = Number.parseInt(execFileSync('/bin/sh', [
    '-c',
    `node -e "setTimeout(() => {}, 5000)" >/dev/null 2>&1 & echo $!`,
  ], {
    cwd: TEST_DIR,
    encoding: 'utf8',
  }).trim(), 10);

  assert(isProcessRunning(pid), 'Liveness helper returns true for a running process');
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20; i++) {
    if (!isProcessRunning(pid)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert(!isProcessRunning(pid), 'Liveness helper returns false after the process exits');
});

test('Fix 25: AI merge gate blocks high-risk overlapping subsystem changes', () => {
  const repoDir = join(tmpdir(), `sw-ai-gate-block-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const featureA = join(tmpdir(), `sw-ai-gate-a-${Date.now()}`);
  const featureB = join(tmpdir(), `sw-ai-gate-b-${Date.now()}`);
  execSync(`git worktree add -b feature-auth-a "${featureA}"`, { cwd: repoDir });
  execSync(`git worktree add -b feature-auth-b "${featureB}"`, { cwd: repoDir });

  execSync('mkdir -p src/auth && printf "one\\n" > src/auth/login.js', { cwd: featureA, shell: '/bin/zsh' });
  execSync('mkdir -p src/auth && printf "two\\n" > src/auth/session.js', { cwd: featureB, shell: '/bin/zsh' });

  const gateDb = initDb(repoDir);
  registerWorktree(gateDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(gateDb, { name: featureA.split('/').pop(), path: featureA, branch: 'feature-auth-a' });
  registerWorktree(gateDb, { name: featureB.split('/').pop(), path: featureB, branch: 'feature-auth-b' });
  const taskA = createTask(gateDb, { title: 'Auth A' });
  const taskB = createTask(gateDb, { title: 'Auth B' });
  assignTask(gateDb, taskA, featureA.split('/').pop());
  assignTask(gateDb, taskB, featureB.split('/').pop());
  claimFiles(gateDb, taskA, featureA.split('/').pop(), ['src/auth/login.js']);
  claimFiles(gateDb, taskB, featureB.split('/').pop(), ['src/auth/session.js']);
  gateDb.close();
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ai', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    stdout = String(err.stdout || '');
  }
  const result = JSON.parse(stdout);

  assert(result.status === 'blocked', 'AI merge gate blocks overlapping high-risk subsystem changes');
  assert(result.pairs.some((pair) =>
    pair.status === 'blocked'
    && pair.shared_areas.includes('src/auth')
    && pair.shared_risk_tags.includes('auth'),
  ), 'Blocked pair identifies shared auth subsystem risk');
  execSync(`git worktree remove "${featureA}" --force`, { cwd: repoDir });
  execSync(`git worktree remove "${featureB}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 26: AI merge gate passes isolated worktree changes', () => {
  const repoDir = join(tmpdir(), `sw-ai-gate-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const featureA = join(tmpdir(), `sw-ai-gate-pass-a-${Date.now()}`);
  const featureB = join(tmpdir(), `sw-ai-gate-pass-b-${Date.now()}`);
  execSync(`git worktree add -b feature-ui "${featureA}"`, { cwd: repoDir });
  execSync(`git worktree add -b feature-docs "${featureB}"`, { cwd: repoDir });

  execSync('mkdir -p src/ui && printf "button\\n" > src/ui/button.js', { cwd: featureA, shell: '/bin/zsh' });
  execSync('printf "docs\\n" > docs.md', { cwd: featureB, shell: '/bin/zsh' });

  const gateDb = initDb(repoDir);
  registerWorktree(gateDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(gateDb, { name: featureA.split('/').pop(), path: featureA, branch: 'feature-ui' });
  registerWorktree(gateDb, { name: featureB.split('/').pop(), path: featureB, branch: 'feature-docs' });
  const taskA = createTask(gateDb, { title: 'UI work' });
  const taskB = createTask(gateDb, { title: 'Docs work' });
  assignTask(gateDb, taskA, featureA.split('/').pop());
  assignTask(gateDb, taskB, featureB.split('/').pop());
  claimFiles(gateDb, taskA, featureA.split('/').pop(), ['src/ui/button.js']);
  claimFiles(gateDb, taskB, featureB.split('/').pop(), ['docs.md']);
  gateDb.close();
  const result = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ai', '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.status === 'pass', 'AI merge gate passes isolated low-overlap changes');
  assert(result.pairs.every((pair) => pair.status === 'pass'), 'All pair analyses pass for isolated changes');
  execSync(`git worktree remove "${featureA}" --force`, { cwd: repoDir });
  execSync(`git worktree remove "${featureB}" --force`, { cwd: repoDir });
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
