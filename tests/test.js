/**
 * switchman - Basic test suite
 * Tests core DB and git functions without needing a real git repo
 */

import { execFileSync, execSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, realpathSync, readFileSync, writeFileSync, statSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DatabaseSync } from 'node:sqlite';

import { findRepoRoot } from '../src/core/git.js';
import { getWorktreeChangedFiles } from '../src/core/git.js';
import { filterIgnoredPaths, isIgnoredPath, matchesPathPatterns } from '../src/core/ignore.js';
import { upsertProjectMcpConfig } from '../src/core/mcp.js';
import { evaluateWorktreeCompliance, gatewayAppendFile, gatewayMakeDirectory, gatewayMovePath, gatewayRemovePath, gatewayWriteFile, installCommitHook, installGateHooks, monitorWorktreesOnce, runCommitGate, runWrappedCommand, validateWriteAccess, writeEnforcementPolicy } from '../src/core/enforcement.js';
import { clearMonitorState, isProcessRunning, readMonitorState, writeMonitorState } from '../src/core/monitor.js';
import { evaluateTaskOutcome } from '../src/core/outcome.js';
import { getPipelineStatus, runPipeline, startPipeline } from '../src/core/pipeline.js';
import { buildTaskSpec } from '../src/core/planner.js';
import { DEFAULT_LEASE_POLICY, loadLeasePolicy, writeLeasePolicy } from '../src/core/policy.js';

const TEST_DIR = join(tmpdir(), `switchman-test-${Date.now()}`);
const TEST_ZDOTDIR = join(tmpdir(), `switchman-zdotdir-${Date.now()}`);

mkdirSync(TEST_ZDOTDIR, { recursive: true });
process.env.ZDOTDIR = TEST_ZDOTDIR;

// Import modules
import {
  initDb,
  openDb,
  createTask,
  assignTask,
  startTaskLease,
  completeTask,
  completeLeaseTask,
  failTask,
  failLeaseTask,
  getBoundaryValidationState,
  getTaskSpec,
  upsertTaskSpec,
  retryTask,
  listTasks,
  getTask,
  getNextPendingTask,
  enqueueMergeItem,
  listMergeQueue,
  markMergeQueueState,
  listLeases,
  listBoundaryValidationStates,
  listDependencyInvalidations,
  listScopeReservations,
  getLease,
  getLeaseExecutionContext,
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
  logAuditEvent,
  verifyAuditTrail,
  retryMergeQueueItem,
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

function setupPipelineExecRepo(prefix, branchName) {
  const repoDir = join(tmpdir(), `${prefix}-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const agentPath = join(tmpdir(), `${prefix}-agent-${Date.now()}`);
  execSync(`git worktree add -b ${branchName} "${agentPath}"`, { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(db, { name: 'agent1', path: agentPath, branch: branchName });

  return { repoDir, agentPath, db };
}

function cleanupPipelineExecRepo(repoDir, agentPath) {
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
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

test('Lease execution context exposes task, worktree, spec, and claims as one execution object', () => {
  const leaseDir = join(tmpdir(), `sw-lease-context-${Date.now()}`);
  mkdirSync(leaseDir, { recursive: true });
  const leaseDb = initDb(leaseDir);
  registerWorktree(leaseDb, { name: 'lease-context-wt', path: leaseDir, branch: 'main' });
  const taskId = createTask(leaseDb, { title: 'Lease-centric work' });
  upsertTaskSpec(leaseDb, taskId, {
    task_type: 'implementation',
    allowed_paths: ['src/**'],
    required_deliverables: ['source'],
  });
  const lease = startTaskLease(leaseDb, taskId, 'lease-context-wt', 'codex');
  claimFiles(leaseDb, taskId, 'lease-context-wt', ['src/lease-context.js'], 'codex');

  const context = getLeaseExecutionContext(leaseDb, lease.id);

  assert(context.lease.id === lease.id, 'Lease execution context returns the active lease');
  assert(context.task.id === taskId, 'Lease execution context returns the assigned task');
  assert(context.worktree.name === 'lease-context-wt', 'Lease execution context returns the assigned worktree');
  assert(context.task_spec.task_type === 'implementation', 'Lease execution context returns the structured task spec');
  assert(context.claims.some((claim) => claim.file_path === 'src/lease-context.js'), 'Lease execution context returns active claims for the lease');
  leaseDb.close();
  rmSync(leaseDir, { recursive: true, force: true });
});

test('Lease-scoped completion and failure finalize execution by lease identity', () => {
  const leaseDir = join(tmpdir(), `sw-lease-finalize-${Date.now()}`);
  mkdirSync(leaseDir, { recursive: true });
  const leaseDb = initDb(leaseDir);
  registerWorktree(leaseDb, { name: 'lease-finalize-wt', path: leaseDir, branch: 'main' });

  const completeTaskId = createTask(leaseDb, { title: 'Complete by lease' });
  const completeLease = startTaskLease(leaseDb, completeTaskId, 'lease-finalize-wt', 'codex');
  const completed = completeLeaseTask(leaseDb, completeLease.id);
  assert(completed.status === 'done', 'Lease-scoped completion marks the task done');
  assert(getActiveLeaseForTask(leaseDb, completeTaskId) === null, 'Lease-scoped completion closes the active lease');

  const failTaskId = createTask(leaseDb, { title: 'Fail by lease' });
  const failedLease = startTaskLease(leaseDb, failTaskId, 'lease-finalize-wt', 'codex');
  const failed = failLeaseTask(leaseDb, failedLease.id, 'lease scoped failure');
  assert(failed.status === 'failed', 'Lease-scoped failure marks the task failed');
  assert(getTask(leaseDb, failTaskId).description.includes('lease scoped failure'), 'Lease-scoped failure records the reason on the task');
  leaseDb.close();
  rmSync(leaseDir, { recursive: true, force: true });
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

test('Worktree registration deduplicates repeated paths under one canonical name', () => {
  const pathDb = initDb(join(tmpdir(), `sw-worktree-path-${Date.now()}`));
  registerWorktree(pathDb, { name: 'agent1', path: '/tmp/repo-agent1', branch: 'switchman/agent1' });
  registerWorktree(pathDb, { name: 'repo-agent1', path: '/tmp/repo-agent1', branch: 'switchman/agent1' });

  const worktrees = listWorktrees(pathDb);
  assert(worktrees.length === 1, 'Registering the same worktree path twice does not create duplicate worktrees');
  assert(worktrees[0].name === 'agent1', 'The first registered worktree name remains canonical for that path');
  pathDb.close();
});

test('Worktree registration normalizes aliased paths to one canonical worktree', () => {
  const repoDir = join(tmpdir(), `sw-worktree-realpath-${Date.now()}`);
  const aliasDir = join(tmpdir(), `sw-worktree-realpath-alias-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync(`ln -s "${repoDir}" "${aliasDir}"`);

  const pathDb = initDb(join(tmpdir(), `sw-worktree-path-norm-${Date.now()}`));
  registerWorktree(pathDb, { name: 'agent11', path: repoDir, branch: 'switchman/agent11' });
  registerWorktree(pathDb, { name: 'repo-agent11', path: aliasDir, branch: 'switchman/agent11' });

  const worktrees = listWorktrees(pathDb);
  assert(worktrees.length === 1, 'Aliased real paths do not create duplicate worktrees');
  assert(worktrees[0].name === 'agent11', 'Canonical name is preserved when the same worktree is registered through an alias path');
  assert(worktrees[0].path === realpathSync(repoDir), 'Stored worktree path is normalized to its real path');
  pathDb.close();
  rmSync(aliasDir, { force: true });
  rmSync(repoDir, { recursive: true, force: true });
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

test('Merge queue add stores a queued worktree merge item', () => {
  const repoDir = join(tmpdir(), `sw-queue-add-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(queueDb, { name: 'agent1', path: join(tmpdir(), `sw-queue-add-agent-${Date.now()}`), branch: 'feature/queue-add' });

  const item = enqueueMergeItem(queueDb, {
    sourceType: 'worktree',
    sourceRef: 'feature/queue-add',
    sourceWorktree: 'agent1',
    targetBranch: 'main',
  });
  const items = listMergeQueue(queueDb);

  assert(item.status === 'queued', 'Queue item starts queued');
  assert(items.length === 1, 'Queue item is persisted');
  assert(items[0].source_worktree === 'agent1', 'Queue item stores the queued worktree name');
  queueDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Merge queue run fast-forwards a clean worktree branch into main', () => {
  const repoDir = join(tmpdir(), `sw-queue-run-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const agentPath = join(tmpdir(), `sw-queue-run-agent-${Date.now()}`);
  execSync(`git worktree add -b feature/queue-run "${agentPath}"`, { cwd: repoDir });
  writeFileSync(join(agentPath, 'queue.txt'), 'queued\n');
  execSync('git add queue.txt', { cwd: agentPath });
  execSync('git commit -m "queue work"', { cwd: agentPath });

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(queueDb, { name: 'agent1', path: agentPath, branch: 'feature/queue-run' });
  enqueueMergeItem(queueDb, {
    sourceType: 'worktree',
    sourceRef: 'feature/queue-run',
    sourceWorktree: 'agent1',
    targetBranch: 'main',
  });

  const cliResult = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'run',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  const updated = listMergeQueue(queueDb)[0];
  const mainFile = readFileSync(join(repoDir, 'queue.txt'), 'utf8');

  assert(cliResult.processed[0].status === 'merged', 'Queue runner reports a merged queue item');
  assert(updated.status === 'merged', 'Queue item is marked merged');
  assert(Boolean(updated.merged_commit), 'Merged queue item records the resulting commit');
  assert(mainFile === 'queued\n', 'Merged queue work lands on the main branch');
  queueDb.close();
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Merge queue run blocks missing source branches with a clear reason', () => {
  const repoDir = join(tmpdir(), `sw-queue-missing-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  enqueueMergeItem(queueDb, {
    sourceType: 'branch',
    sourceRef: 'feature/missing-branch',
    targetBranch: 'main',
  });

  const cliResult = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'run',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  const updated = listMergeQueue(queueDb)[0];

  assert(cliResult.processed[0].status === 'blocked', 'Queue runner blocks missing source branches');
  assert(updated.last_error_code === 'source_missing', 'Blocked queue item records the missing-source error code');
  assert(updated.next_action.includes('switchman queue retry'), 'Blocked queue item provides an exact retry command');
  queueDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Merge queue retry resets a blocked item back to retrying', () => {
  const repoDir = join(tmpdir(), `sw-queue-retry-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  const item = enqueueMergeItem(queueDb, {
    sourceType: 'branch',
    sourceRef: 'feature/missing-branch',
    targetBranch: 'main',
  });
  execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'run',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  const retried = retryMergeQueueItem(queueDb, item.id);

  assert(retried.status === 'retrying', 'Retrying a blocked queue item resets it to retrying');
  assert(retried.last_error_code === null, 'Retrying clears the last error code');
  queueDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Merge queue run blocks when the repo gate fails before merge', () => {
  const repoDir = join(tmpdir(), `sw-queue-gate-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const agentPath = join(tmpdir(), `sw-queue-gate-agent-${Date.now()}`);
  execSync(`git worktree add -b feature/queue-gate "${agentPath}"`, { cwd: repoDir });
  writeFileSync(join(agentPath, 'queue.txt'), 'queued\n');
  execSync('git add queue.txt', { cwd: agentPath });
  execSync('git commit -m "queue work"', { cwd: agentPath });
  writeFileSync(join(repoDir, 'rogue.txt'), 'unclaimed\n');

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(queueDb, { name: 'agent1', path: agentPath, branch: 'feature/queue-gate' });
  enqueueMergeItem(queueDb, {
    sourceType: 'worktree',
    sourceRef: 'feature/queue-gate',
    sourceWorktree: 'agent1',
    targetBranch: 'main',
  });

  const cliResult = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'run',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  const updated = listMergeQueue(queueDb)[0];

  assert(cliResult.processed[0].status === 'blocked', 'Queue runner blocks when the repo gate fails');
  assert(updated.last_error_code === 'gate_failed', 'Blocked queue item records the gate failure code');
  assert(updated.next_action.includes('switchman gate ci'), 'Blocked queue item points the operator at the repo gate');
  queueDb.close();
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Merge queue status JSON includes retry counts and recent queue events', () => {
  const repoDir = join(tmpdir(), `sw-queue-status-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  enqueueMergeItem(queueDb, {
    sourceType: 'branch',
    sourceRef: 'feature/missing-branch',
    targetBranch: 'main',
    maxRetries: 2,
  });
  queueDb.close();

  const statusJson = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'status',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(statusJson.items[0].max_retries === 2, 'Queue status JSON includes the retry budget');
  assert(Array.isArray(statusJson.recent_events) && statusJson.recent_events.length > 0, 'Queue status JSON includes recent queue events');
  assert(statusJson.summary.counts.queued === 1, 'Queue status JSON includes queue counts');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Merge queue run watch mode polls for work and exits after max cycles', () => {
  const repoDir = join(tmpdir(), `sw-queue-watch-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  queueDb.close();

  const watchJson = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'run',
    '--watch',
    '--watch-interval-ms',
    '10',
    '--max-cycles',
    '2',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(watchJson.watch === true, 'Queue watch mode reports that watch mode was enabled');
  assert(watchJson.cycles === 2, 'Queue watch mode respects the requested max cycle count');
  assert(Array.isArray(watchJson.processed) && watchJson.processed.length === 0, 'Queue watch mode can poll without processing items');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Merge queue run schedules an automatic retry for retryable rebase conflicts', () => {
  const repoDir = join(tmpdir(), `sw-queue-auto-retry-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'base\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const agentPath = join(tmpdir(), `sw-queue-auto-retry-agent-${Date.now()}`);
  execSync(`git worktree add -b feature/queue-auto-retry "${agentPath}"`, { cwd: repoDir });
  writeFileSync(join(agentPath, 'README.md'), 'feature\n');
  execSync('git add README.md', { cwd: agentPath });
  execSync('git commit -m "feature change"', { cwd: agentPath });
  writeFileSync(join(repoDir, 'README.md'), 'main\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "main change"', { cwd: repoDir });

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(queueDb, { name: 'agent1', path: agentPath, branch: 'feature/queue-auto-retry' });
  enqueueMergeItem(queueDb, {
    sourceType: 'worktree',
    sourceRef: 'feature/queue-auto-retry',
    sourceWorktree: 'agent1',
    targetBranch: 'main',
    maxRetries: 1,
  });

  const cliResult = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'run',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  const updated = listMergeQueue(queueDb)[0];

  assert(cliResult.processed[0].status === 'retrying', 'Queue runner schedules a retry for retryable rebase conflicts');
  assert(updated.status === 'retrying', 'Retryable merge failure leaves the queue item in retrying');
  assert(updated.retry_count === 1, 'Retryable merge failure increments the retry count');
  queueDb.close();
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Merge queue run blocks once retry budget is exhausted for rebase conflicts', () => {
  const repoDir = join(tmpdir(), `sw-queue-retry-exhausted-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init -b main', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'base\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const agentPath = join(tmpdir(), `sw-queue-retry-exhausted-agent-${Date.now()}`);
  execSync(`git worktree add -b feature/queue-retry-exhausted "${agentPath}"`, { cwd: repoDir });
  writeFileSync(join(agentPath, 'README.md'), 'feature\n');
  execSync('git add README.md', { cwd: agentPath });
  execSync('git commit -m "feature change"', { cwd: agentPath });
  writeFileSync(join(repoDir, 'README.md'), 'main\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "main change"', { cwd: repoDir });

  const queueDb = initDb(repoDir);
  registerWorktree(queueDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(queueDb, { name: 'agent1', path: agentPath, branch: 'feature/queue-retry-exhausted' });
  enqueueMergeItem(queueDb, {
    sourceType: 'worktree',
    sourceRef: 'feature/queue-retry-exhausted',
    sourceWorktree: 'agent1',
    targetBranch: 'main',
    maxRetries: 1,
  });

  execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'run',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  const secondResult = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'queue',
    'run',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  const updated = listMergeQueue(queueDb)[0];

  assert(secondResult.processed[0].status === 'blocked', 'Queue runner blocks once the retry budget is exhausted');
  assert(updated.status === 'blocked', 'Exhausted retry budget leaves the queue item blocked');
  assert(updated.retry_count === 1, 'Blocking after retry exhaustion does not increment retries again');
  queueDb.close();
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
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

test('Fix 1b: parallel CLI task acquisition avoids transient database lock failures', () => {
  const repoDir = join(tmpdir(), `sw-parallel-cli-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const cliPath = join(process.cwd(), 'src/cli/index.js');
  execFileSync(process.execPath, [cliPath, 'setup', '--agents', '3'], { cwd: repoDir, encoding: 'utf8' });
  execFileSync(process.execPath, [cliPath, 'task', 'add', 'Task one', '--priority', '9'], { cwd: repoDir, encoding: 'utf8' });
  execFileSync(process.execPath, [cliPath, 'task', 'add', 'Task two', '--priority', '8'], { cwd: repoDir, encoding: 'utf8' });
  execFileSync(process.execPath, [cliPath, 'task', 'add', 'Task three', '--priority', '7'], { cwd: repoDir, encoding: 'utf8' });

  const outputDir = join(repoDir, 'parallel-next');
  mkdirSync(outputDir, { recursive: true });
  execSync(`
    "${process.execPath}" "${cliPath}" task next --json --worktree agent1 --agent parallel-agent1 > "${join(outputDir, 'agent1.json')}" &
    pid1=$!
    "${process.execPath}" "${cliPath}" task next --json --worktree agent2 --agent parallel-agent2 > "${join(outputDir, 'agent2.json')}" &
    pid2=$!
    "${process.execPath}" "${cliPath}" task next --json --worktree agent3 --agent parallel-agent3 > "${join(outputDir, 'agent3.json')}" &
    pid3=$!
    wait "$pid1" "$pid2" "$pid3"
  `, { cwd: repoDir, shell: '/bin/sh' });

  const payloads = ['agent1', 'agent2', 'agent3'].map((name) => JSON.parse(readFileSync(join(outputDir, `${name}.json`), 'utf8')));
  const taskIds = payloads.map((payload) => payload.task?.id).filter(Boolean);

  assert(taskIds.length === 3, 'All parallel agents acquire a task without database lock failure');
  assert(new Set(taskIds).size === 3, 'Parallel task acquisition still assigns distinct tasks');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 1c: CLI task done succeeds while a transient SQLite write lock is present', () => {
  const repoDir = join(tmpdir(), `sw-task-done-retry-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const cliPath = join(process.cwd(), 'src/cli/index.js');
  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(db, { title: 'Complete under transient lock' });
  assignTask(db, taskId, 'main');
  db.close();

  const lockScript = `
    const { DatabaseSync } = require('node:sqlite');
    const path = require('node:path');
    const db = new DatabaseSync(path.join(${JSON.stringify(repoDir)}, '.switchman', 'switchman.db'));
    db.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE;');
    setTimeout(() => {
      db.exec('COMMIT;');
      db.close();
    }, 300);
  `;
  execSync(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(lockScript)} >/dev/null 2>&1 & sleep 0.1`, {
    cwd: repoDir,
    shell: '/bin/sh',
  });

  execFileSync(process.execPath, [cliPath, 'task', 'done', taskId], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  const verifyDb = openDb(repoDir);
  assert(getTask(verifyDb, taskId).status === 'done', 'task done reaches completion even when a transient lock is present');
  verifyDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 2: SWITCHMAN_DIR constant (no stale AGENTQ_DIR)', () => {
  // Verify the database is created at the correct path using the renamed constant
  const fixDir = join(tmpdir(), `sw-const-${Date.now()}`);
  const fixDb = initDb(fixDir);
  fixDb.close();
  const expectedPath = join(fixDir, '.switchman', 'switchman.db');
  assert(existsSync(expectedPath), `.switchman/switchman.db created at correct path`);
});

test('Fix 2b: task add warns when a task looks too broad for a first parallel run', () => {
  const repoDir = join(tmpdir(), `sw-task-warning-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });
  initDb(repoDir).close();

  const cliOutput = execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'task',
    'add',
    'Refactor auth across the codebase',
    '--description',
    'Large sweep touching all routes and shared middleware',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  assert(cliOutput.includes('warning:'), 'task add warns when a task looks broad');
  assert(cliOutput.includes('pipeline start'), 'task add points users toward pipeline planning for broad work');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 2c: blocked claim returns a non-zero exit code for shell automation', () => {
  const repoDir = join(tmpdir(), `sw-claim-exit-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const claimDb = initDb(repoDir);
  registerWorktree(claimDb, { name: 'agent1', path: repoDir, branch: 'main' });
  registerWorktree(claimDb, { name: 'agent2', path: join(repoDir, 'agent2'), branch: 'switchman/agent2' });
  const firstTask = createTask(claimDb, { title: 'Task one' });
  const secondTask = createTask(claimDb, { title: 'Task two' });
  assignTask(claimDb, firstTask, 'agent1');
  assignTask(claimDb, secondTask, 'agent2');
  claimFiles(claimDb, firstTask, 'agent1', ['src/shared.js']);
  claimDb.close();

  let error = null;
  try {
    execFileSync(process.execPath, [
      join(process.cwd(), 'src/cli/index.js'),
      'claim',
      secondTask,
      'agent2',
      'src/shared.js',
    ], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    error = err;
  }

  assert(error?.status === 1, 'Blocked claim exits with status 1');
  assert(String(error?.stdout || '').includes('Claim conflicts detected'), 'Blocked claim still prints the conflict explanation');
  rmSync(repoDir, { recursive: true, force: true });
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

test('Lease policy defaults load when no repo policy file exists', () => {
  const repoDir = join(tmpdir(), `sw-lease-policy-default-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });

  const policy = loadLeasePolicy(repoDir);

  assert(policy.stale_after_minutes === DEFAULT_LEASE_POLICY.stale_after_minutes, 'Missing lease policy falls back to the default stale timeout');
  assert(policy.reap_on_status_check === DEFAULT_LEASE_POLICY.reap_on_status_check, 'Missing lease policy falls back to the default auto-reap behavior');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Lease policy writes and reloads persisted settings', () => {
  const repoDir = join(tmpdir(), `sw-lease-policy-write-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });

  writeLeasePolicy(repoDir, {
    heartbeat_interval_seconds: 45,
    stale_after_minutes: 9,
    reap_on_status_check: true,
    requeue_task_on_reap: false,
  });
  const policy = loadLeasePolicy(repoDir);

  assert(policy.heartbeat_interval_seconds === 45, 'Lease policy persists the heartbeat interval');
  assert(policy.stale_after_minutes === 9, 'Lease policy persists the stale timeout');
  assert(policy.reap_on_status_check === true, 'Lease policy persists auto-reap-on-status');
  assert(policy.requeue_task_on_reap === false, 'Lease policy persists requeue-on-reap');
  rmSync(repoDir, { recursive: true, force: true });
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

test('Stale lease reaping can fail tasks instead of re-queueing them when policy disables requeue', () => {
  const reapDb = initDb(join(tmpdir(), `sw-lease-reap-fail-${Date.now()}`));
  const taskId = createTask(reapDb, { title: 'reap fail task' });
  const lease = startTaskLease(reapDb, taskId, 'lease-reap-fail-worktree', 'codex');

  reapDb.prepare(`
    UPDATE leases
    SET heartbeat_at=datetime('now', '-30 minutes')
    WHERE id=?
  `).run(lease.id);

  const expired = reapStaleLeases(reapDb, 15, { requeueTask: false });
  const task = getTask(reapDb, taskId);

  assert(expired.length === 1, 'One stale lease was reaped when requeue is disabled');
  assert(task.status === 'failed', 'Stale lease can mark the task failed instead of pending');
  assert(task.description.includes('lease_expired'), 'Failing on stale reap records the stale-lease reason');
  reapDb.close();
});

test('Lease reap CLI uses the configured stale policy by default', () => {
  const repoDir = join(tmpdir(), `sw-lease-policy-cli-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const reapDb = initDb(repoDir);
  registerWorktree(reapDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(reapDb, { title: 'policy cli reap task' });
  const lease = startTaskLease(reapDb, taskId, 'main', 'codex');
  reapDb.prepare(`
    UPDATE leases
    SET heartbeat_at=datetime('now', '-10 minutes')
    WHERE id=?
  `).run(lease.id);
  reapDb.close();

  writeLeasePolicy(repoDir, {
    stale_after_minutes: 5,
    requeue_task_on_reap: true,
  });

  const output = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'lease',
    'reap',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(output.stale_after_minutes === 5, 'Lease reap CLI uses the configured stale timeout by default');
  assert(output.expired.length === 1, 'Lease reap CLI expires leases using the configured stale timeout');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Status auto-reaps stale leases when policy enables it', () => {
  const repoDir = join(tmpdir(), `sw-lease-policy-status-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const statusDb = initDb(repoDir);
  registerWorktree(statusDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(statusDb, { title: 'policy status reap task' });
  const lease = startTaskLease(statusDb, taskId, 'main', 'codex');
  statusDb.prepare(`
    UPDATE leases
    SET heartbeat_at=datetime('now', '-10 minutes')
    WHERE id=?
  `).run(lease.id);
  statusDb.close();

  writeLeasePolicy(repoDir, {
    stale_after_minutes: 5,
    reap_on_status_check: true,
    requeue_task_on_reap: true,
  });

  execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'status',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  const verifyDb = openDb(repoDir);
  const leaseAfter = getLease(verifyDb, lease.id);
  const taskAfter = getTask(verifyDb, taskId);
  assert(leaseAfter.status === 'expired', 'Status auto-reaps stale leases when policy enables it');
  assert(taskAfter.status === 'pending', 'Status auto-reap requeues the task when policy enables requeue');
  verifyDb.close();
  rmSync(repoDir, { recursive: true, force: true });
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
  execSync('mkdir -p src && printf "hello\\n" > src/new-file.js', { cwd: repoDir, shell: '/bin/sh' });

  const changed = getWorktreeChangedFiles(repoDir, repoDir);
  assert(changed.includes('src/new-file.js'), 'Untracked file appears in changed-files scan');

  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 6: default ignore list drops node_modules and build output noise', () => {
  const filtered = filterIgnoredPaths([
    'src/app.js',
    '.mcp.json',
    'node_modules/pkg/index.js',
    'coverage/lcov.info',
    'dist/app.js',
    'nested/node_modules/pkg/index.js',
  ]);

  assert(filtered.length === 1, 'Ignored paths are removed from conflict scans');
  assert(filtered[0] === 'src/app.js', 'Non-generated source files are preserved');
  assert(isIgnoredPath('examples/taskapi/node_modules/pkg/index.js'), 'Nested node_modules paths are ignored');
  assert(isIgnoredPath('.mcp.json'), 'Project MCP config is ignored by default scans');
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
  execSync('mkdir -p src && printf "x\\n" > src/unclaimed.js', { cwd: repoDir, shell: '/bin/sh' });

  const enforceDb = initDb(repoDir);
  registerWorktree(enforceDb, { name: 'main', path: repoDir, branch: 'main' });
  const compliance = evaluateWorktreeCompliance(enforceDb, repoDir, { name: 'main', path: repoDir, branch: 'main' });

  assert(compliance.compliance_state === 'non_compliant', 'Unmanaged changed files mark the worktree non-compliant');
  assert(compliance.unclaimed_changed_files.includes('src/unclaimed.js'), 'Unclaimed changed file is reported');
  enforceDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 8b: completed claimed work remains governed for compliance checks', () => {
  const repoDir = join(tmpdir(), `sw-enforce-completed-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const enforceDb = initDb(repoDir);
  registerWorktree(enforceDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(enforceDb, { title: 'Implement: governed change' });
  assignTask(enforceDb, taskId, 'main');
  claimFiles(enforceDb, taskId, 'main', ['src/governed.js']);
  execSync('mkdir -p src && printf "ok\\n" > src/governed.js', { cwd: repoDir, shell: '/bin/sh' });
  completeTask(enforceDb, taskId);

  const compliance = evaluateWorktreeCompliance(enforceDb, repoDir, { name: 'main', path: repoDir, branch: 'main' });
  assert(compliance.compliance_state === 'observed', 'Completed governed changes remain observed instead of non-compliant');
  assert(compliance.unclaimed_changed_files.length === 0, 'Completed governed changes are not reported as unclaimed');
  enforceDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 8c: active task-scoped changes remain governed for compliance checks', () => {
  const repoDir = join(tmpdir(), `sw-enforce-scope-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const enforceDb = initDb(repoDir);
  registerWorktree(enforceDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(enforceDb, { title: 'Implement: scoped governed change' });
  assignTask(enforceDb, taskId, 'main');
  upsertTaskSpec(enforceDb, taskId, {
    task_type: 'implementation',
    allowed_paths: ['src/scoped/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });
  execSync('mkdir -p src/scoped && printf "ok\\n" > src/scoped/governed.js', { cwd: repoDir, shell: '/bin/sh' });

  const compliance = evaluateWorktreeCompliance(enforceDb, repoDir, { name: 'main', path: repoDir, branch: 'main' });
  assert(compliance.compliance_state === 'managed', 'In-scope task-owned changes remain managed without an explicit file claim');
  assert(compliance.unclaimed_changed_files.length === 0, 'In-scope task-owned changes are not reported as unclaimed');
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
  execSync('mkdir -p src && printf "ok\\n" > src/claimed.js', { cwd: repoDir, shell: '/bin/sh' });

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
  execSync('mkdir -p src && printf "bad\\n" > src/unclaimed.js', { cwd: repoDir, shell: '/bin/sh' });

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

test('Fix 12a: managed write gateway allows task-scoped writes without an explicit file claim', () => {
  const repoDir = join(tmpdir(), `sw-write-scope-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  const writeDb = initDb(repoDir);
  registerWorktree(writeDb, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(writeDb, { title: 'Scoped gateway write task' });
  assignTask(writeDb, taskId, 'main');
  const lease = getActiveLeaseForTask(writeDb, taskId);
  upsertTaskSpec(writeDb, taskId, {
    task_type: 'implementation',
    allowed_paths: ['src/scoped/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });

  const validation = validateWriteAccess(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/scoped/example.js',
    worktree: 'main',
  });
  const result = gatewayWriteFile(writeDb, repoDir, {
    leaseId: lease.id,
    path: 'src/scoped/example.js',
    content: 'export const scoped = true;\n',
    worktree: 'main',
  });

  assert(validation.ok, 'Validation allows an unclaimed path inside the lease task scope');
  assert(validation.ownership_type === 'scope', 'Scoped validation reports scope ownership');
  assert(result.ok, 'Write gateway allows an in-scope task-scoped write');
  assert(readFileSync(join(repoDir, 'src/scoped/example.js'), 'utf8') === 'export const scoped = true;\n', 'Write gateway writes scoped content to disk');
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

test('Fix 13a: attaching a conflicting task scope to an active lease is rejected immediately', () => {
  const mainDir = join(tmpdir(), `sw-scope-foreign-main-${Date.now()}`);
  const otherDir = join(tmpdir(), `sw-scope-foreign-other-${Date.now()}`);
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const scopeDb = initDb(mainDir);
  registerWorktree(scopeDb, { name: 'main', path: mainDir, branch: 'main' });
  registerWorktree(scopeDb, { name: 'agent2', path: otherDir, branch: 'feature/agent2' });

  const foreignTaskId = createTask(scopeDb, { title: 'Foreign scoped ownership' });
  assignTask(scopeDb, foreignTaskId, 'agent2');
  upsertTaskSpec(scopeDb, foreignTaskId, {
    task_type: 'implementation',
    allowed_paths: ['src/shared/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });

  const ownTaskId = createTask(scopeDb, { title: 'Own scoped ownership' });
  assignTask(scopeDb, ownTaskId, 'main');
  let threw = false;
  try {
    upsertTaskSpec(scopeDb, ownTaskId, {
      task_type: 'implementation',
      allowed_paths: ['src/shared/**'],
      expected_output_types: ['source'],
      required_deliverables: ['source'],
    });
  } catch (err) {
    threw = String(err.message).includes('Scope reservation conflict');
  }

  const ownReservations = listScopeReservations(scopeDb, { taskId: ownTaskId });
  assert(threw, 'Conflicting task scope is rejected as soon as it is attached to the active lease');
  assert(ownReservations.length === 0, 'Conflicting task does not keep any active scope reservations after rejection');
  scopeDb.close();
  rmSync(mainDir, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
});

test('Fix 13aa: validation still rejects writes into another lease claim inside shared areas', () => {
  const repoDir = join(tmpdir(), `sw-claim-conflict-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  const scopeDb = initDb(repoDir);
  registerWorktree(scopeDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(scopeDb, { name: 'agent2', path: join(repoDir, 'agent2'), branch: 'feature/agent2' });

  const foreignTaskId = createTask(scopeDb, { title: 'Foreign explicit claim' });
  assignTask(scopeDb, foreignTaskId, 'agent2');
  upsertTaskSpec(scopeDb, foreignTaskId, {
    task_type: 'implementation',
    allowed_paths: ['src/shared/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });
  claimFiles(scopeDb, foreignTaskId, 'agent2', ['src/shared/example.js']);

  const ownTaskId = createTask(scopeDb, { title: 'Own unrelated scope' });
  assignTask(scopeDb, ownTaskId, 'main');
  const ownLease = getActiveLeaseForTask(scopeDb, ownTaskId);
  upsertTaskSpec(scopeDb, ownTaskId, {
    task_type: 'implementation',
    allowed_paths: ['src/local/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });
  const validation = validateWriteAccess(scopeDb, repoDir, {
    leaseId: ownLease.id,
    path: 'src/shared/example.js',
    worktree: 'main',
  });

  assert(!validation.ok, 'Validation rejects a path already claimed by another active lease');
  assert(validation.reason_code === 'path_claimed_by_other_lease', 'Claim conflicts still use the explicit claim reason code');
  scopeDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 13b: overlapping scope reservations are blocked when the second lease starts', () => {
  const repoDir = join(tmpdir(), `sw-scope-reserve-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  const scopeDb = initDb(repoDir);
  registerWorktree(scopeDb, { name: 'agent1', path: repoDir, branch: 'feature/agent1' });
  registerWorktree(scopeDb, { name: 'agent2', path: join(repoDir, 'agent2'), branch: 'feature/agent2' });

  const taskA = createTask(scopeDb, { title: 'Own auth scope' });
  upsertTaskSpec(scopeDb, taskA, {
    task_type: 'implementation',
    allowed_paths: ['src/auth/**'],
    subsystem_tags: ['auth'],
  });
  const leaseA = startTaskLease(scopeDb, taskA, 'agent1', 'codex');

  const taskB = createTask(scopeDb, { title: 'Conflicting auth scope' });
  upsertTaskSpec(scopeDb, taskB, {
    task_type: 'implementation',
    allowed_paths: ['src/auth/session/**'],
    subsystem_tags: ['auth'],
  });

  let threw = false;
  try {
    startTaskLease(scopeDb, taskB, 'agent2', 'codex');
  } catch (err) {
    threw = String(err.message).includes('Scope reservation conflict');
  }

  const reservations = listScopeReservations(scopeDb, { activeOnly: true });
  const taskBAfter = getTask(scopeDb, taskB);
  assert(Boolean(leaseA), 'First lease acquires its reserved scope normally');
  assert(threw, 'Second overlapping lease is blocked at reservation time');
  assert(taskBAfter.status === 'pending', 'Task stays pending when scope reservation fails');
  assert(reservations.length >= 1 && reservations.every((reservation) => reservation.lease_id === leaseA.id), 'Only the first lease keeps active scope reservations after the conflict');
  scopeDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 13c: scope reservations are released when a lease completes', () => {
  const repoDir = join(tmpdir(), `sw-scope-release-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  const scopeDb = initDb(repoDir);
  registerWorktree(scopeDb, { name: 'main', path: repoDir, branch: 'main' });

  const taskId = createTask(scopeDb, { title: 'Scoped completion task' });
  upsertTaskSpec(scopeDb, taskId, {
    task_type: 'implementation',
    allowed_paths: ['src/payments/**'],
    subsystem_tags: ['payments'],
  });
  const lease = startTaskLease(scopeDb, taskId, 'main', 'codex');
  const activeReservations = listScopeReservations(scopeDb, { leaseId: lease.id });

  completeLeaseTask(scopeDb, lease.id);

  const releasedReservations = listScopeReservations(scopeDb, { activeOnly: false, leaseId: lease.id });
  const stillActive = listScopeReservations(scopeDb, { leaseId: lease.id });
  assert(activeReservations.length === 2, 'Lease creates both path-scope and subsystem reservations');
  assert(stillActive.length === 0, 'Lease completion releases active scope reservations');
  assert(releasedReservations.every((reservation) => Boolean(reservation.released_at)), 'Released scope reservations keep a release timestamp for auditability');
  scopeDb.close();
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

  execSync('mkdir -p src && printf "drift\\n" > src/drift.js', { cwd: repoDir, shell: '/bin/sh' });
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

  execSync('mkdir -p src && printf "claimed\\n" > src/observed.js', { cwd: repoDir, shell: '/bin/sh' });
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

  execSync('mkdir -p src && printf "rogue\\n" > src/rogue.js', { cwd: repoDir, shell: '/bin/sh' });
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

  execSync('mkdir -p generated && printf "artifact\\n" > generated/output.js', { cwd: repoDir, shell: '/bin/sh' });
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
  assert(wrappedEnv.worktreePath === realpathSync(repoDir), 'Wrapper injects SWITCHMAN_WORKTREE_PATH');
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
  execSync('mkdir -p src && printf "drift\\n" > src/rogue.js', { cwd: repoDir, shell: '/bin/sh' });
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

test('Fix 22b: gate ci writes GitHub Actions summary and outputs', () => {
  const repoDir = join(tmpdir(), `sw-ci-github-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });

  initDb(repoDir).close();
  const stepSummaryPath = join(repoDir, 'github-step-summary.md');
  const outputPath = join(repoDir, 'github-output.txt');
  execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'gate',
    'ci',
    '--github-step-summary',
    stepSummaryPath,
    '--github-output',
    outputPath,
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  const stepSummary = readFileSync(stepSummaryPath, 'utf8');
  const output = readFileSync(outputPath, 'utf8');
  assert(stepSummary.includes('# Switchman CI Gate'), 'gate ci writes a GitHub step summary markdown file');
  assert(output.includes('switchman_ok=true'), 'gate ci writes GitHub Actions outputs');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 22c: gate install-ci writes a GitHub Actions workflow', () => {
  const repoDir = join(tmpdir(), `sw-ci-install-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git commit --allow-empty -m "init"', { cwd: repoDir });
  execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'gate',
    'install-ci',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  const workflowPath = join(repoDir, '.github', 'workflows', 'switchman-gate.yml');
  const workflow = readFileSync(workflowPath, 'utf8');
  assert(existsSync(workflowPath), 'gate install-ci writes the GitHub Actions workflow file');
  assert(workflow.includes('switchman gate ci --github'), 'Installed workflow runs the Switchman CI gate in GitHub Actions');
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

  execSync('mkdir -p src/auth && printf "one\\n" > src/auth/login.js', { cwd: featureA, shell: '/bin/sh' });
  execSync('mkdir -p src/auth && printf "two\\n" > src/auth/session.js', { cwd: featureB, shell: '/bin/sh' });

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

test('Fix 25a: scan and gates report hierarchical ownership overlaps explicitly', () => {
  const repoDir = join(tmpdir(), `sw-ownership-report-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const featureA = join(tmpdir(), `sw-ownership-report-a-${Date.now()}`);
  const featureB = join(tmpdir(), `sw-ownership-report-b-${Date.now()}`);
  execSync(`git worktree add -b feature-owned-a "${featureA}"`, { cwd: repoDir });
  execSync(`git worktree add -b feature-owned-b "${featureB}"`, { cwd: repoDir });

  const gateDb = initDb(repoDir);
  const worktreeA = featureA.split('/').pop();
  const worktreeB = featureB.split('/').pop();
  registerWorktree(gateDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(gateDb, { name: worktreeA, path: featureA, branch: 'feature-owned-a' });
  registerWorktree(gateDb, { name: worktreeB, path: featureB, branch: 'feature-owned-b' });

  const taskA = createTask(gateDb, { title: 'Owned A' });
  const taskB = createTask(gateDb, { title: 'Owned B' });
  const leaseA = startTaskLease(gateDb, taskA, worktreeA, 'codex');
  const leaseB = startTaskLease(gateDb, taskB, worktreeB, 'codex');

  gateDb.prepare(`
    INSERT INTO scope_reservations (lease_id, task_id, worktree, ownership_level, scope_pattern, subsystem_tag)
    VALUES (?, ?, ?, 'subsystem', NULL, 'auth'),
           (?, ?, ?, 'subsystem', NULL, 'auth'),
           (?, ?, ?, 'path_scope', 'src/auth/**', NULL),
           (?, ?, ?, 'path_scope', 'src/auth/session/**', NULL)
  `).run(
    leaseA.id, taskA, worktreeA,
    leaseB.id, taskB, worktreeB,
    leaseA.id, taskA, worktreeA,
    leaseB.id, taskB, worktreeB,
  );
  gateDb.close();

  const scan = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'scan', '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  let aiStdout = '';
  try {
    aiStdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ai', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
  } catch (err) {
    aiStdout = String(err.stdout || '');
  }
  const aiGate = JSON.parse(aiStdout);
  let ciStdout = '';
  try {
    ciStdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ci', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
  } catch (err) {
    ciStdout = String(err.stdout || '');
  }
  const ciGate = JSON.parse(ciStdout);

  assert(scan.ownershipConflicts.some((conflict) => conflict.type === 'subsystem_overlap' && conflict.subsystemTag === 'auth'), 'Scan reports shared subsystem ownership explicitly');
  assert(scan.ownershipConflicts.some((conflict) => conflict.type === 'scope_overlap' && conflict.scopeA === 'src/auth/**'), 'Scan reports overlapping path scopes explicitly');
  assert(aiGate.ownership_conflicts.length >= 2, 'AI merge gate includes hierarchical ownership overlaps in its output');
  assert(aiGate.pairs.some((pair) => pair.reasons.some((reason) => reason.includes('reserve the auth subsystem'))), 'AI merge gate reasons mention shared subsystem ownership');
  assert(!ciGate.ok, 'Repo CI gate rejects ownership boundary overlaps');
  assert(ciGate.ownership_conflicts.length >= 2, 'Repo CI gate returns ownership overlaps in JSON output');

  execSync(`git worktree remove "${featureA}" --force`, { cwd: repoDir });
  execSync(`git worktree remove "${featureB}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 25aa: scan and gates report semantic exported-object overlaps explicitly', () => {
  const repoDir = join(tmpdir(), `sw-semantic-overlap-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const featureA = join(tmpdir(), `sw-semantic-a-${Date.now()}`);
  const featureB = join(tmpdir(), `sw-semantic-b-${Date.now()}`);
  execSync(`git worktree add -b feature-semantic-a "${featureA}"`, { cwd: repoDir });
  execSync(`git worktree add -b feature-semantic-b "${featureB}"`, { cwd: repoDir });

  execSync('mkdir -p src/auth && printf "export function ensureAuth() { return true; }\\n" > src/auth/guard.js', { cwd: featureA, shell: '/bin/sh' });
  execSync('mkdir -p src/auth && printf "export function ensureAuth() { return false; }\\n" > src/auth/policy.js', { cwd: featureB, shell: '/bin/sh' });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(db, { name: featureA.split('/').pop(), path: featureA, branch: 'feature-semantic-a' });
  registerWorktree(db, { name: featureB.split('/').pop(), path: featureB, branch: 'feature-semantic-b' });
  db.close();

  const scan = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'scan', '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  let aiStdout = '';
  try {
    aiStdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ai', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
  } catch (err) {
    aiStdout = String(err.stdout || '');
  }
  const aiGate = JSON.parse(aiStdout);
  let ciStdout = '';
  try {
    ciStdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ci', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
  } catch (err) {
    ciStdout = String(err.stdout || '');
  }
  const ciGate = JSON.parse(ciStdout);

  assert(scan.semanticConflicts.some((conflict) => conflict.object_name === 'ensureAuth'), 'Scan reports overlapping exported objects explicitly');
  assert(aiGate.semantic_conflicts.some((conflict) => conflict.object_name === 'ensureAuth'), 'AI merge gate includes semantic conflicts in JSON output');
  assert(aiGate.pairs.some((pair) => pair.reasons.some((reason) => reason.includes('ensureAuth'))), 'AI merge gate reasons mention the overlapping exported object');
  assert(!ciGate.ok, 'Repo CI gate rejects semantic exported-object overlaps');
  assert(ciGate.semantic_conflicts.some((conflict) => conflict.object_name === 'ensureAuth'), 'Repo CI gate returns semantic conflicts in JSON output');

  execSync(`git worktree remove "${featureA}" --force`, { cwd: repoDir });
  execSync(`git worktree remove "${featureB}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 25b: AI merge gate blocks missing boundary validation work for high-risk implementation', () => {
  const repoDir = join(tmpdir(), `sw-boundary-validation-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const gateDb = initDb(repoDir);
  registerWorktree(gateDb, { name: 'main', path: repoDir, branch: 'main' });
  const pipeline = startPipeline(gateDb, {
    title: 'Harden auth API permissions',
    description: 'Implement stricter auth checks for the API',
    pipelineId: 'pipe-boundary',
    priority: 5,
  });
  const implementationTask = pipeline.tasks.find((task) => task.task_spec.task_type === 'implementation');
  assignTask(gateDb, implementationTask.id, 'main');
  const lease = getActiveLeaseForTask(gateDb, implementationTask.id);
  completeLeaseTask(gateDb, lease.id);
  gateDb.close();

  let aiStdout = '';
  try {
    aiStdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ai', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
  } catch (err) {
    aiStdout = String(err.stdout || '');
  }
  const aiGate = JSON.parse(aiStdout);

  let ciStdout = '';
  try {
    ciStdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ci', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
  } catch (err) {
    ciStdout = String(err.stdout || '');
  }
  const ciGate = JSON.parse(ciStdout);

  assert(aiGate.status === 'blocked', 'AI merge gate blocks when a high-risk ownership boundary is missing validation work');
  assert(aiGate.boundary_validations.some((item) => item.pipeline_id === 'pipe-boundary' && item.missing_task_types.includes('tests')), 'AI merge gate reports the missing completed tests requirement');
  assert(aiGate.boundary_validations.some((item) => item.pipeline_id === 'pipe-boundary' && item.missing_task_types.includes('governance')), 'AI merge gate reports the missing completed governance review requirement');
  assert(!ciGate.ok, 'Repo CI gate fails when blocking boundary validations are still missing');
  assert(ciGate.boundary_validations.some((item) => item.pipeline_id === 'pipe-boundary'), 'Repo CI gate returns the blocking boundary validations in JSON output');

  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 25c: accepted high-risk boundary work creates incremental validation state and follow-up completion satisfies it', () => {
  const repoDir = join(tmpdir(), `sw-boundary-state-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const pipeline = startPipeline(db, {
    title: 'Harden auth API permissions',
    description: 'Implement stricter auth checks for the API',
    pipelineId: 'pipe-boundary-state',
    priority: 5,
  });
  const implementationTask = pipeline.tasks.find((task) => task.task_spec.task_type === 'implementation');
  const testsTask = pipeline.tasks.find((task) => task.task_spec.task_type === 'tests');
  const docsTask = pipeline.tasks.find((task) => task.task_spec.task_type === 'docs');
  const governanceTask = pipeline.tasks.find((task) => task.task_spec.task_type === 'governance');
  assignTask(db, implementationTask.id, 'main');
  const lease = getActiveLeaseForTask(db, implementationTask.id);
  execSync('mkdir -p src/auth && printf "ok\\n" > src/auth/login.js', { cwd: repoDir, shell: '/bin/sh' });

  const outcome = evaluateTaskOutcome(db, repoDir, { leaseId: lease.id });
  const pendingState = getBoundaryValidationState(db, lease.id);

  completeLeaseTask(db, lease.id);
  completeTask(db, testsTask.id);
  completeTask(db, docsTask.id);
  completeTask(db, governanceTask.id);
  const allStates = listBoundaryValidationStates(db, { pipelineId: 'pipe-boundary-state' });
  const satisfiedState = allStates.find((state) => state.lease_id === lease.id);

  assert(outcome.status === 'accepted', 'Outcome evaluator accepts the implementation work before follow-up validation is complete');
  assert(pendingState?.status === 'blocked', 'Accepted high-risk implementation work records a blocking boundary validation state immediately');
  assert(pendingState?.missing_task_types.includes('tests'), 'Boundary validation state tracks missing tests immediately after the implementation write');
  assert(satisfiedState?.status === 'satisfied', 'Completing the follow-up validation tasks satisfies the incremental boundary validation state');
  assert(satisfiedState?.missing_task_types.length === 0, 'Satisfied boundary validation state clears the missing follow-up task types');

  db.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 25d: shared-boundary changes mark dependent work stale until it is retried', () => {
  const repoDir = join(tmpdir(), `sw-dependency-stale-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  writeFileSync(join(repoDir, 'auth-old.js'), 'old\n');
  execSync('git add README.md auth-old.js', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const previousTaskId = createTask(db, { title: 'Previous auth hardening' });
  upsertTaskSpec(db, previousTaskId, {
    pipeline_id: 'pipe-old',
    task_type: 'implementation',
    allowed_paths: ['src/auth/**'],
    subsystem_tags: ['auth'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });
  assignTask(db, previousTaskId, 'main');
  const previousLease = getActiveLeaseForTask(db, previousTaskId);
  completeLeaseTask(db, previousLease.id);

  const pipeline = startPipeline(db, {
    title: 'Harden auth API permissions',
    description: 'Implement stricter auth checks for the API',
    pipelineId: 'pipe-fresh-auth',
    priority: 5,
  });
  const implementationTask = pipeline.tasks.find((task) => task.task_spec.task_type === 'implementation');
  assignTask(db, implementationTask.id, 'main');
  const currentLease = getActiveLeaseForTask(db, implementationTask.id);
  execSync('mkdir -p src/auth && printf "new\\n" > src/auth/login.js', { cwd: repoDir, shell: '/bin/sh' });
  const outcome = evaluateTaskOutcome(db, repoDir, { leaseId: currentLease.id });
  const staleInvalidations = listDependencyInvalidations(db, { affectedTaskId: previousTaskId });

  assert(outcome.status === 'accepted', 'Outcome evaluator still accepts the new implementation work');
  assert(staleInvalidations.some((item) => item.reason_type === 'subsystem_overlap' && item.status === 'stale'), 'Shared subsystem work marks the older completed task stale');

  retryTask(db, previousTaskId, 'revalidate after auth change');
  const clearedInvalidations = listDependencyInvalidations(db, { affectedTaskId: previousTaskId });
  assert(clearedInvalidations.length === 0, 'Retrying the stale task clears the active dependency invalidation');

  db.close();
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

  execSync('mkdir -p src/ui && printf "button\\n" > src/ui/button.js', { cwd: featureA, shell: '/bin/sh' });
  execSync('printf "docs\\n" > docs.md', { cwd: featureB, shell: '/bin/sh' });

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

test('Fix 27: pipeline start creates grouped subtasks with suggested worktrees', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-start-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: join(repoDir, 'agent1'), branch: 'feature/agent1' });
  registerWorktree(pipelineDb, { name: 'agent2', path: join(repoDir, 'agent2'), branch: 'feature/agent2' });

  const result = startPipeline(pipelineDb, {
    title: 'Ship login retries',
    description: '- implement retry logic\n- add tests\n- update docs',
    pipelineId: 'pipe-demo',
    priority: 8,
  });
  const status = getPipelineStatus(pipelineDb, 'pipe-demo');

  assert(result.tasks.length === 3, 'Pipeline start creates one task per checklist item');
  assert(result.tasks[0].id === 'pipe-demo-01', 'Pipeline tasks use stable prefixed IDs');
  assert(status.tasks.some((task) => task.suggested_worktree === 'agent1'), 'Pipeline tasks capture suggested worktrees');
  assert(result.tasks[0].task_spec?.task_type === 'implementation', 'Pipeline start attaches a structured implementation task spec');
  assert(result.tasks[1].task_spec?.task_type === 'tests', 'Pipeline start attaches a structured test task spec');
  assert(result.tasks[0].task_spec?.execution_policy?.timeout_ms >= 45000, 'Implementation tasks get a default execution policy');
  assert(result.tasks[1].task_spec?.execution_policy?.timeout_ms === 30000, 'Test tasks get a test-specific execution policy');
  assert(result.tasks[0].task_spec?.required_deliverables?.includes('source'), 'Implementation task specs include required deliverables');
  assert(Array.isArray(getTaskSpec(pipelineDb, 'pipe-demo-01')?.success_criteria), 'Pipeline task specs are persisted in the database');
  pipelineDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28: pipeline PR summary combines task status with gate results', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-pr-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  startPipeline(pipelineDb, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-pr',
    priority: 5,
  });
  const lease = startTaskLease(pipelineDb, 'pipe-pr-01', 'main', 'pipeline-reviewer');
  completeLeaseTask(pipelineDb, lease.id);
  pipelineDb.close();

  const result = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'pipeline', 'pr', 'pipe-pr', '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.pipeline_id === 'pipe-pr', 'Pipeline PR summary returns the requested pipeline ID');
  assert(typeof result.markdown === 'string' && result.markdown.includes('# PR Summary: Refresh docs'), 'Pipeline PR summary includes PR-ready markdown');
  assert(result.ci_gate.ok, 'Pipeline PR summary includes a passing repo gate for a clean repo');
  assert(result.pr_artifact.title === 'Refresh docs', 'Pipeline PR summary generates a reviewer-facing PR title');
  assert(result.pr_artifact.body.includes('## Reviewer Checklist'), 'Pipeline PR summary generates a structured PR body');
  assert(Array.isArray(result.pr_artifact.provenance), 'Pipeline PR summary includes provenance entries for reviewers');
  assert(result.pr_artifact.provenance[0].lease_id === lease.id, 'Pipeline PR summary includes completed lease provenance');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28a: pipeline status exposes readable failure context and next action', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-status-failure-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: join(repoDir, 'agent1'), branch: 'feature/agent1' });
  startPipeline(pipelineDb, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-status-failure',
    priority: 5,
  });
  failTask(pipelineDb, 'pipe-status-failure-01', 'changes_outside_task_scope: changed files outside task scope: src/rogue.js');

  const status = getPipelineStatus(pipelineDb, 'pipe-status-failure');
  const failedTask = status.tasks.find((task) => task.id === 'pipe-status-failure-01');
  assert(failedTask.failure.reason_code === 'changes_outside_task_scope', 'Pipeline status exposes the structured failure reason code');
  assert(failedTask.failure.summary.includes('src/rogue.js'), 'Pipeline status exposes a readable failure summary');
  assert(failedTask.next_action.includes('allowed paths'), 'Pipeline status provides a concrete next action for the failure');

  const cliOutput = execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'status',
    'pipe-status-failure',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  assert(cliOutput.includes('why:'), 'Pipeline status CLI prints a readable failure summary');
  assert(cliOutput.includes('next:'), 'Pipeline status CLI prints a concrete next step for failed tasks');
  pipelineDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28aa: doctor surfaces operator-friendly attention and next steps', () => {
  const repoDir = join(tmpdir(), `sw-doctor-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const doctorDb = initDb(repoDir);
  registerWorktree(doctorDb, { name: 'main', path: repoDir, branch: 'main' });
  const activeTaskId = createTask(doctorDb, { title: 'Implement scoped auth update' });
  assignTask(doctorDb, activeTaskId, 'main');
  upsertTaskSpec(doctorDb, activeTaskId, {
    task_type: 'implementation',
    allowed_paths: ['src/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });
  const taskId = createTask(doctorDb, { title: 'Update docs' });
  assignTask(doctorDb, taskId, 'main');
  failTask(doctorDb, taskId, 'changes_outside_task_scope: changed files outside task scope: src/rogue.js');
  doctorDb.close();

  const jsonOutput = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'doctor',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  assert(jsonOutput.health === 'warn', 'Doctor reports warning health when failed tasks need attention');
  assert(jsonOutput.attention.some((item) => item.title.includes('Update docs')), 'Doctor includes the failed task in the attention list');
  assert(jsonOutput.next_steps.some((step) => step.includes('allowed paths')), 'Doctor suggests a concrete next step for the failure');
  assert(jsonOutput.suggested_commands.some((command) => command.includes('pipeline status')), 'Doctor suggests an exact follow-through command');
  assert(jsonOutput.attention.some((item) => item.command && item.command.includes('pipeline status')), 'Doctor attention items include exact commands when available');
  assert(jsonOutput.active_work.some((item) => item.scope_summary === 'scope:src/**'), 'Doctor JSON surfaces scope ownership for active leases');

  const textOutput = execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'doctor',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  assert(textOutput.includes('Attention now:'), 'Doctor CLI prints an attention section');
  assert(textOutput.includes('next:'), 'Doctor CLI prints actionable next guidance');
  assert(textOutput.includes('run:'), 'Doctor CLI prints exact follow-through commands');
  assert(textOutput.includes('scope:src/**'), 'Doctor CLI prints scope ownership for active leases');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Status JSON unifies queue, lease policy, and operator attention', () => {
  const repoDir = join(tmpdir(), `sw-status-json-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  writeLeasePolicy(repoDir, {
    heartbeat_interval_seconds: 45,
    stale_after_minutes: 12,
    reap_on_status_check: false,
    requeue_task_on_reap: true,
  });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const activeTaskId = createTask(db, { title: 'Implement auth cleanup', priority: 8 });
  assignTask(db, activeTaskId, 'main');
  upsertTaskSpec(db, activeTaskId, {
    task_type: 'implementation',
    allowed_paths: ['src/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });
  const failedTaskId = createTask(db, { title: 'Update docs', priority: 5 });
  assignTask(db, failedTaskId, 'main');
  failTask(db, failedTaskId, 'changes_outside_task_scope: changed files outside task scope: src/rogue.js');
  const queued = enqueueMergeItem(db, {
    sourceType: 'branch',
    sourceRef: 'feature/docs',
    targetBranch: 'main',
  });
  markMergeQueueState(db, queued.id, {
    status: 'blocked',
    lastErrorCode: 'gate_failed',
    lastErrorSummary: 'Repo gate rejected unmanaged changes.',
    nextAction: `Run \`switchman gate ci\`, resolve the reported issues, then run \`switchman queue retry ${queued.id}\`.`,
  });
  db.close();

  const jsonOutput = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'status',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(jsonOutput.counts.queue.blocked === 1, 'Status JSON includes merge queue counts');
  assert(jsonOutput.lease_policy.stale_after_minutes === 12, 'Status JSON includes the active lease policy');
  assert(jsonOutput.attention.some((item) => item.kind === 'queue_blocked'), 'Status JSON includes blocked queue items in attention');
  assert(jsonOutput.active_work.some((item) => item.scope_summary === 'scope:src/**'), 'Status JSON preserves active lease scope summaries');
  assert(jsonOutput.suggested_commands.includes('switchman queue status'), 'Status JSON suggests queue follow-up commands');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Status text surfaces one front-door operator view', () => {
  const repoDir = join(tmpdir(), `sw-status-text-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const failedTaskId = createTask(db, { title: 'Refresh docs', priority: 6 });
  assignTask(db, failedTaskId, 'main');
  failTask(db, failedTaskId, 'changes_outside_task_scope: changed files outside task scope: src/rogue.js');
  const queued = enqueueMergeItem(db, {
    sourceType: 'branch',
    sourceRef: 'feature/docs',
    targetBranch: 'main',
  });
  markMergeQueueState(db, queued.id, {
    status: 'retrying',
    lastErrorCode: 'merge_conflict',
    lastErrorSummary: 'Merge conflict blocked queue item.',
    nextAction: 'Retry 1 of 1 scheduled automatically. Run `switchman queue run` again after fixing any underlying branch drift if needed.',
    incrementRetry: true,
  });
  db.close();

  const textOutput = execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'status',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  assert(textOutput.includes('switchman status'), 'Status text includes the dashboard banner');
  assert(textOutput.includes('Blocked'), 'Status text includes the blocked panel');
  assert(textOutput.includes('Landing queue'), 'Status text includes merge queue visibility');
  assert(textOutput.includes('Next action'), 'Status text includes the next action panel');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28ab: doctor and repo gate surface stale dependency invalidations', () => {
  const repoDir = join(tmpdir(), `sw-doctor-stale-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });

  const oldTaskId = createTask(db, { title: 'Old auth flow' });
  upsertTaskSpec(db, oldTaskId, {
    pipeline_id: 'pipe-old-doc',
    task_type: 'implementation',
    allowed_paths: ['src/auth/**'],
    subsystem_tags: ['auth'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
  });
  assignTask(db, oldTaskId, 'main');
  const oldLease = getActiveLeaseForTask(db, oldTaskId);
  completeLeaseTask(db, oldLease.id);

  const pipeline = startPipeline(db, {
    title: 'Harden auth API permissions',
    description: 'Implement stricter auth checks for the API',
    pipelineId: 'pipe-doctor-stale',
    priority: 5,
  });
  const implementationTask = pipeline.tasks.find((task) => task.task_spec.task_type === 'implementation');
  assignTask(db, implementationTask.id, 'main');
  const lease = getActiveLeaseForTask(db, implementationTask.id);
  execSync('mkdir -p src/auth && printf "stale\\n" > src/auth/guard.js', { cwd: repoDir, shell: '/bin/sh' });
  evaluateTaskOutcome(db, repoDir, { leaseId: lease.id });
  db.close();

  const doctorJson = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'doctor',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  assert(doctorJson.attention.some((item) => item.kind === 'dependency_invalidation'), 'Doctor includes stale dependency invalidations in the attention list');
  assert(doctorJson.merge_readiness.dependency_invalidations.some((item) => item.affected_task_id === oldTaskId), 'Doctor surfaces stale dependency invalidations in merge readiness');

  let ciStdout = '';
  try {
    ciStdout = execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'gate', 'ci', '--json'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
  } catch (err) {
    ciStdout = String(err.stdout || '');
  }
  const ciGate = JSON.parse(ciStdout);
  assert(!ciGate.ok, 'Repo gate fails while stale dependency invalidations are unresolved');
  assert(ciGate.dependency_invalidations.some((item) => item.affected_task_id === oldTaskId), 'Repo gate returns stale dependency invalidations in JSON output');

  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28b: planner emits subsystem-aware specs for high-risk work', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-planner-risk-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: join(repoDir, 'agent1'), branch: 'feature/agent1' });
  registerWorktree(pipelineDb, { name: 'agent2', path: join(repoDir, 'agent2'), branch: 'feature/agent2' });

  const result = startPipeline(pipelineDb, {
    title: 'Harden auth API permissions',
    description: 'Update login permissions for the public API and add migration checks',
    pipelineId: 'pipe-planner-risk',
    priority: 9,
  });

  const implementationTask = result.tasks.find((task) => task.task_spec?.task_type === 'implementation');
  const testsTask = result.tasks.find((task) => task.task_spec?.task_type === 'tests');
  const governanceTask = result.tasks.find((task) => task.task_spec?.task_type === 'governance');

  assert(result.tasks.length >= 4, 'High-risk work produces implementation, tests, docs, and safety review tasks');
  assert(implementationTask.task_spec.risk_level === 'high', 'Planner marks auth/API/migration work as high risk');
  assert(implementationTask.task_spec.subsystem_tags.includes('auth'), 'Planner tags auth-related implementation tasks with auth subsystem metadata');
  assert(implementationTask.task_spec.allowed_paths.some((path) => path.includes('auth')), 'Planner narrows implementation scope to auth-related paths');
  assert(implementationTask.task_spec.required_deliverables.includes('source'), 'Planner keeps source as the required deliverable for implementation work');
  assert(implementationTask.task_spec.followup_deliverables.includes('tests'), 'Planner records tests as a follow-up deliverable for high-risk implementation work');
  assert(implementationTask.task_spec.followup_deliverables.includes('docs'), 'Planner records docs as a follow-up deliverable for API/schema-related implementation work');
  assert(implementationTask.task_spec.validation_rules.required_completed_task_types.includes('tests'), 'Planner requires completed tests for high-risk ownership-boundary implementation work');
  assert(implementationTask.task_spec.validation_rules.required_completed_task_types.includes('governance'), 'Planner requires completed governance review for sensitive ownership-boundary implementation work');
  assert(implementationTask.task_spec.validation_rules.enforcement === 'blocked', 'Planner marks auth/schema/payment boundary validation as blocking');
  assert(implementationTask.task_spec.execution_policy.timeout_ms === 90000, 'Planner gives high-risk implementation tasks a stricter execution timeout');
  assert(implementationTask.task_spec.execution_policy.max_retries === 1, 'Planner keeps high-risk implementation retries constrained');
  assert(testsTask.dependencies.includes(implementationTask.id), 'Planner keeps generated test work dependent on implementation');
  assert(governanceTask.task_spec.allowed_paths.includes('.github/**'), 'Planner gives safety-review tasks governance-oriented allowed paths');
  assert(governanceTask.task_spec.primary_output_path === `docs/reviews/pipe-planner-risk/${governanceTask.id}.md`, 'Planner gives governance tasks a unique review artifact path');
  assert(governanceTask.task_spec.allowed_paths.includes(governanceTask.task_spec.primary_output_path), 'Planner allows governance tasks to write their unique review artifact');
  pipelineDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28bb: planner uses repo structure to narrow task scope', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-planner-scope-${Date.now()}`);
  mkdirSync(join(repoDir, 'src', 'auth'), { recursive: true });
  mkdirSync(join(repoDir, 'src', 'payments'), { recursive: true });
  mkdirSync(join(repoDir, 'tests', 'auth'), { recursive: true });
  mkdirSync(join(repoDir, 'docs'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'auth', 'login.js'), 'export function login() {}\n');
  writeFileSync(join(repoDir, 'src', 'payments', 'charge.js'), 'export function charge() {}\n');
  writeFileSync(join(repoDir, 'tests', 'auth', 'login.test.js'), 'test("login", () => {});\n');
  writeFileSync(join(repoDir, 'docs', 'auth.md'), '# Auth\n');

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: join(repoDir, 'agent1'), branch: 'feature/agent1' });
  registerWorktree(pipelineDb, { name: 'agent2', path: join(repoDir, 'agent2'), branch: 'feature/agent2' });

  const result = startPipeline(pipelineDb, {
    title: 'Improve login retries',
    description: 'Tighten login retry behavior and refresh docs for the auth flow',
    pipelineId: 'pipe-planner-scope',
    priority: 7,
  });

  const implementationTask = result.tasks.find((task) => task.task_spec?.task_type === 'implementation');
  const testsTask = result.tasks.find((task) => task.task_spec?.task_type === 'tests');
  const docsTask = result.tasks.find((task) => task.task_spec?.task_type === 'docs');

  assert(implementationTask.task_spec.allowed_paths.includes('src/auth/**'), 'Planner narrows implementation scope to the relevant auth area in the repo');
  assert(!implementationTask.task_spec.allowed_paths.includes('src/payments/**'), 'Planner avoids unrelated repo areas when narrowing task scope');
  assert(testsTask.task_spec.allowed_paths.includes('tests/auth/**'), 'Planner narrows generated test work to the relevant test subtree');
  assert(docsTask.task_spec.allowed_paths.includes('docs/auth/**') || docsTask.task_spec.allowed_paths.includes('docs/**'), 'Planner narrows docs work using the repo docs layout');
  pipelineDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28c: pipeline PR summary includes reviewer risk notes for high-risk work', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-pr-risk-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  startPipeline(pipelineDb, {
    title: 'Harden auth API permissions',
    description: 'Update login permissions for the public API and add migration checks',
    pipelineId: 'pipe-pr-risk',
    priority: 9,
  });
  completeTask(pipelineDb, 'pipe-pr-risk-01');
  pipelineDb.close();

  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'pr',
    'pipe-pr-risk',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.pr_artifact.risk_notes.some((note) => note.toLowerCase().includes('high-risk work')), 'Pipeline PR summary includes reviewer risk notes for high-risk tasks');
  assert(result.pr_artifact.subsystem_tags.includes('auth'), 'Pipeline PR summary carries subsystem tags into the reviewer artifact');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28d: pipeline bundle exports reviewer-ready files to disk', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-bundle-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  startPipeline(pipelineDb, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-bundle',
    priority: 5,
  });
  completeTask(pipelineDb, 'pipe-bundle-01');
  pipelineDb.close();

  const outputDir = join(repoDir, 'artifacts', 'pipe-bundle');
  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'bundle',
    'pipe-bundle',
    outputDir,
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.output_dir === outputDir, 'Pipeline bundle exports to the requested output directory');
  assert(existsSync(result.files.summary_json), 'Pipeline bundle writes the JSON summary file');
  assert(existsSync(result.files.summary_markdown), 'Pipeline bundle writes the markdown summary file');
  assert(existsSync(result.files.pr_body_markdown), 'Pipeline bundle writes the PR body markdown file');
  assert(readFileSync(result.files.pr_body_markdown, 'utf8').includes('## Reviewer Checklist'), 'Pipeline bundle writes reviewer checklist content into the PR body file');
  assert(readFileSync(result.files.summary_markdown, 'utf8').includes('lease '), 'Pipeline bundle summary markdown includes lease provenance for completed work');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28da: semantic materialize writes a deterministic semantic index artifact', () => {
  const repoDir = join(tmpdir(), `sw-semantic-materialize-${Date.now()}`);
  mkdirSync(join(repoDir, 'src/auth'), { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  writeFileSync(join(repoDir, 'src/auth/guard.js'), 'export function ensureAuth() { return true; }\nexport const AUTH_FLAG = true;\n');
  execSync('git add README.md src/auth/guard.js', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  db.close();

  execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'semantic', 'materialize'], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  const semanticIndexPath = join(repoDir, '.switchman', 'semantic-index.json');
  const artifact = JSON.parse(readFileSync(semanticIndexPath, 'utf8'));
  assert(existsSync(semanticIndexPath), 'Semantic materialize writes the semantic index artifact');
  assert(artifact.worktrees.some((entry) => entry.worktree === 'main'), 'Semantic index includes the main worktree');
  assert(artifact.worktrees.flatMap((entry) => entry.index.objects).some((object) => object.name === 'ensureAuth'), 'Semantic index materializes exported code objects deterministically');

  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28db: canonical object store can import, update, and materialize exported code objects', () => {
  const repoDir = join(tmpdir(), `sw-object-store-${Date.now()}`);
  mkdirSync(join(repoDir, 'src/auth'), { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  writeFileSync(join(repoDir, 'src/auth/guard.js'), 'export function ensureAuth() { return true; }\nexport const AUTH_FLAG = true;\n');
  execSync('git add README.md src/auth/guard.js', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  db.close();

  const imported = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'object',
    'import',
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));
  const targetObject = imported.objects.find((object) => object.name === 'ensureAuth');
  assert(imported.object_count >= 2, 'Object import stores exported code objects canonically');
  assert(Boolean(targetObject), 'Object import captures the exported ensureAuth function');

  execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'object',
    'update',
    targetObject.object_id,
    '--text',
    'export function ensureAuth() { return "from-store"; }',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'object',
    'materialize',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  });

  const materialized = readFileSync(join(repoDir, 'src/auth/guard.js'), 'utf8');
  assert(materialized.includes('from-store'), 'Object materialize rewrites files from the canonical object store');
  assert(materialized.includes('AUTH_FLAG'), 'Object materialize keeps other canonical exported objects in the same file');

  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28e: pipeline publish creates a hosted PR through gh with bundle content', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-publish-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  execSync('git checkout -b feature/docs-refresh', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'feature/docs-refresh' });
  startPipeline(pipelineDb, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-publish',
    priority: 5,
  });
  completeTask(pipelineDb, 'pipe-publish-01');
  pipelineDb.close();

  const ghCapturePath = join(repoDir, 'gh-invocation.json');
  const fakeGhPath = join(repoDir, 'fake-gh');
  writeFileSync(fakeGhPath, `#!/bin/sh
printf '%s\n' "$@" > /dev/null
printf '{"args":[' > ${JSON.stringify(ghCapturePath)}
first=1
for arg in "$@"; do
  if [ "$first" -eq 0 ]; then printf ',' >> ${JSON.stringify(ghCapturePath)}; fi
  first=0
  printf '%s' "$(printf '%s' "$arg" | sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g; s/$/\"/; s/^/\"/')" >> ${JSON.stringify(ghCapturePath)}
done
printf ']}' >> ${JSON.stringify(ghCapturePath)}
printf 'https://github.com/example/repo/pull/123\n'
`);
  chmodSync(fakeGhPath, 0o755);

  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'publish',
    'pipe-publish',
    '--base',
    'main',
    '--gh-command',
    fakeGhPath,
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  const invocation = JSON.parse(readFileSync(ghCapturePath, 'utf8'));
  assert(result.head_branch === 'feature/docs-refresh', 'Pipeline publish infers the head branch from the pipeline worktree when possible');
  assert(invocation.args.includes('pr') && invocation.args.includes('create'), 'Pipeline publish invokes gh pr create');
  assert(invocation.args.includes('--body-file'), 'Pipeline publish passes the generated PR body file to gh');
  assert(invocation.args.includes('--title') && invocation.args.includes('Refresh docs'), 'Pipeline publish passes the generated PR title to gh');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 28f: pipeline publish prefers the implementation worktree branch in multi-worktree pipelines', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-publish-multi-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: join(repoDir, 'agent1'), branch: 'switchman/agent1' });
  registerWorktree(pipelineDb, { name: 'agent2', path: join(repoDir, 'agent2'), branch: 'switchman/agent2' });
  startPipeline(pipelineDb, {
    title: 'Harden auth API permissions',
    description: 'Update login permissions for the public API and add migration checks',
    pipelineId: 'pipe-publish-multi',
    priority: 9,
  });

  const ghCapturePath = join(repoDir, 'gh-invocation-multi.json');
  const fakeGhPath = join(repoDir, 'fake-gh-multi');
  writeFileSync(fakeGhPath, `#!/bin/sh
printf '%s\n' "$@" > /dev/null
printf '{"args":[' > ${JSON.stringify(ghCapturePath)}
first=1
for arg in "$@"; do
  if [ "$first" -eq 0 ]; then printf ',' >> ${JSON.stringify(ghCapturePath)}; fi
  first=0
  printf '%s' "$(printf '%s' "$arg" | sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g; s/$/\"/; s/^/\"/')" >> ${JSON.stringify(ghCapturePath)}
done
printf ']}' >> ${JSON.stringify(ghCapturePath)}
printf 'https://github.com/example/repo/pull/456\n'
`);
  chmodSync(fakeGhPath, 0o755);

  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'publish',
    'pipe-publish-multi',
    '--base',
    'main',
    '--gh-command',
    fakeGhPath,
    '--json',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  const invocation = JSON.parse(readFileSync(ghCapturePath, 'utf8'));
  assert(result.head_branch === 'switchman/agent1', 'Pipeline publish infers the implementation worktree branch when multiple worktree branches exist');
  assert(invocation.args.includes('switchman/agent1'), 'Pipeline publish passes the inferred implementation branch to gh');
  pipelineDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 29: pipeline run dispatches pending tasks onto available worktrees', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-run-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: join(repoDir, 'agent1'), branch: 'feature/agent1' });
  registerWorktree(pipelineDb, { name: 'agent2', path: join(repoDir, 'agent2'), branch: 'feature/agent2' });
  startPipeline(pipelineDb, {
    title: 'Ship login retries',
    description: '- implement retry logic\n- add tests\n- update docs',
    pipelineId: 'pipe-run',
    priority: 8,
  });

  const result = runPipeline(pipelineDb, repoDir, { pipelineId: 'pipe-run' });
  const status = getPipelineStatus(pipelineDb, 'pipe-run');

  assert(result.assigned.length === 1, 'Pipeline run dispatches only dependency-ready tasks');
  assert(result.remaining_pending === 0, 'Pipeline run reports no additional ready tasks once dependent work is held back');
  assert(status.counts.in_progress === 1, 'Only the dependency-free task moves into in_progress');
  pipelineDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 30: pipeline run launches agent commands with Switchman env', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-launch-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });
  const agentPath = join(tmpdir(), `sw-pipeline-launch-agent-${Date.now()}`);
  execSync(`git worktree add -b pipeline-launch "${agentPath}"`, { cwd: repoDir });
  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: agentPath, branch: 'pipeline-launch' });
  startPipeline(pipelineDb, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-launch',
    priority: 5,
  });
  const outputPath = join(agentPath, 'pipeline-env.json');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ pipeline: process.env.SWITCHMAN_PIPELINE_ID, task: process.env.SWITCHMAN_TASK_ID, lease: process.env.SWITCHMAN_LEASE_ID, worktree: process.env.SWITCHMAN_WORKTREE, taskType: process.env.SWITCHMAN_TASK_TYPE, taskSpec: process.env.SWITCHMAN_TASK_SPEC, outputPath: process.env.SWITCHMAN_TASK_OUTPUT_PATH, timeoutMs: process.env.SWITCHMAN_TASK_TIMEOUT_MS, maxRetries: process.env.SWITCHMAN_TASK_MAX_RETRIES, retryBackoffMs: process.env.SWITCHMAN_TASK_RETRY_BACKOFF_MS }));`;

  const result = runPipeline(pipelineDb, repoDir, {
    pipelineId: 'pipe-launch',
    agentCommand: [process.execPath, '-e', script],
  });
  for (let i = 0; i < 20 && !existsSync(outputPath); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  const envPayload = JSON.parse(readFileSync(outputPath, 'utf8'));

  assert(result.launched.length === 1, 'Pipeline run launches one command per assigned task');
  assert(envPayload.pipeline === 'pipe-launch', 'Launched pipeline command receives SWITCHMAN_PIPELINE_ID');
  assert(envPayload.task === 'pipe-launch-01', 'Launched pipeline command receives SWITCHMAN_TASK_ID');
  assert(envPayload.worktree === 'agent1', 'Launched pipeline command receives SWITCHMAN_WORKTREE');
  assert(envPayload.taskType === 'docs', 'Launched pipeline command receives the structured task type');
  assert(JSON.parse(envPayload.taskSpec).expected_output_types.includes('docs'), 'Launched pipeline command receives the structured task spec payload');
  assert(envPayload.outputPath === '', 'Tasks without a primary output path get an empty SWITCHMAN_TASK_OUTPUT_PATH');
  assert(envPayload.timeoutMs === '15000', 'Launched pipeline command receives the task-specific timeout policy');
  assert(envPayload.maxRetries === '0', 'Launched pipeline command receives the task-specific retry policy');
  pipelineDb.close();
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 30b: pipeline run exposes governance artifact output paths to launched agents', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-launch-governance-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });
  const agentPath = join(tmpdir(), `sw-pipeline-launch-governance-agent-${Date.now()}`);
  execSync(`git worktree add -b pipeline-launch-governance "${agentPath}"`, { cwd: repoDir });
  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: agentPath, branch: 'pipeline-launch-governance' });
  const taskId = 'pipe-governance-launch-01';
  createTask(pipelineDb, {
    id: taskId,
    title: 'Review blocked AI merge findings',
    description: '[Pipeline pipe-governance-launch]\nSuggested worktree: agent1\nAudit auth API migration safety and document governance findings',
    priority: 9,
  });
  upsertTaskSpec(pipelineDb, taskId, buildTaskSpec({
    pipelineId: 'pipe-governance-launch',
    taskId,
    title: 'Review blocked AI merge findings',
    issueTitle: 'Review blocked AI merge findings',
    issueDescription: 'Audit auth API migration safety and document governance findings',
    suggestedWorktree: 'agent1',
    repoContext: null,
  }));
  const outputPath = join(agentPath, 'pipeline-governance-env.json');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ task: process.env.SWITCHMAN_TASK_ID, taskType: process.env.SWITCHMAN_TASK_TYPE, outputPath: process.env.SWITCHMAN_TASK_OUTPUT_PATH, taskSpec: process.env.SWITCHMAN_TASK_SPEC }));`;

  const result = runPipeline(pipelineDb, repoDir, {
    pipelineId: 'pipe-governance-launch',
    agentCommand: [process.execPath, '-e', script],
  });
  for (let i = 0; i < 20 && !existsSync(outputPath); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  const envPayload = JSON.parse(readFileSync(outputPath, 'utf8'));
  const taskSpec = JSON.parse(envPayload.taskSpec);

  assert(result.launched.length === 1, 'Pipeline run launches the ready governance task command');
  assert(envPayload.taskType === 'governance', 'Launched governance task receives the governance task type');
  assert(envPayload.outputPath === `docs/reviews/pipe-governance-launch/${envPayload.task}.md`, 'Launched governance task receives a unique review artifact output path');
  assert(taskSpec.primary_output_path === envPayload.outputPath, 'Structured task spec and env agree on the governance review artifact path');
  pipelineDb.close();
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 31: pipeline review avoids duplicate governance tasks when merge risk is already covered', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-review-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const featureA = join(tmpdir(), `sw-pipeline-review-a-${Date.now()}`);
  const featureB = join(tmpdir(), `sw-pipeline-review-b-${Date.now()}`);
  execSync(`git worktree add -b review-auth-a "${featureA}"`, { cwd: repoDir });
  execSync(`git worktree add -b review-auth-b "${featureB}"`, { cwd: repoDir });
  execSync('mkdir -p src/auth && printf "one\\n" > src/auth/login.js', { cwd: featureA, shell: '/bin/sh' });
  execSync('mkdir -p src/auth && printf "two\\n" > src/auth/session.js', { cwd: featureB, shell: '/bin/sh' });

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: featureA.split('/').pop(), path: featureA, branch: 'review-auth-a' });
  registerWorktree(pipelineDb, { name: featureB.split('/').pop(), path: featureB, branch: 'review-auth-b' });
  startPipeline(pipelineDb, {
    title: 'Harden login flow',
    description: '- update auth flow',
    pipelineId: 'pipe-review',
    priority: 7,
  });
  const taskA = createTask(pipelineDb, { id: 'pipe-review-02', title: 'Auth A', description: '[Pipeline pipe-review]', priority: 7 });
  const taskB = createTask(pipelineDb, { id: 'pipe-review-03', title: 'Auth B', description: '[Pipeline pipe-review]', priority: 7 });
  assignTask(pipelineDb, taskA, featureA.split('/').pop());
  assignTask(pipelineDb, taskB, featureB.split('/').pop());
  claimFiles(pipelineDb, taskA, featureA.split('/').pop(), ['src/auth/login.js']);
  claimFiles(pipelineDb, taskB, featureB.split('/').pop(), ['src/auth/session.js']);
  pipelineDb.close();

  const result = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'pipeline', 'review', 'pipe-review', '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.ai_gate_status === 'blocked', 'Pipeline review still reports blocked AI merge risk');
  assert(!result.created.some((task) => task.title.includes('Review integration risk')), 'Pipeline review avoids creating duplicate governance follow-ups when governance work already exists');
  execSync(`git worktree remove "${featureA}" --force`, { cwd: repoDir });
  execSync(`git worktree remove "${featureB}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 32: pipeline review stays quiet when gates have no new issues', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-review-clean-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  startPipeline(pipelineDb, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-review-clean',
    priority: 5,
  });
  completeTask(pipelineDb, 'pipe-review-clean-01');
  pipelineDb.close();

  const result = JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'src/cli/index.js'), 'pipeline', 'review', 'pipe-review-clean', '--json'], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.created_count === 0, 'Pipeline review creates no follow-up tasks for a clean pipeline');
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 33: pipeline exec drives a simple pipeline to ready', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-exec-ready-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const agentPath = join(tmpdir(), `sw-pipeline-exec-ready-agent-${Date.now()}`);
  execSync(`git worktree add -b pipe-exec-ready-branch "${agentPath}"`, { cwd: repoDir });
  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: agentPath, branch: 'pipe-exec-ready-branch' });
  startPipeline(pipelineDb, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-exec-ready',
    priority: 5,
  });
  pipelineDb.close();

  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'exec',
    'pipe-exec-ready',
    '--json',
    '--',
    '/bin/sh',
    '-c',
    "printf 'updated\\n' > README.md && git add README.md && git -c user.email=test@test.com -c user.name=Test commit -m 'docs update' >/dev/null",
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.status === 'ready', 'Pipeline exec reports ready when commands succeed and gates pass');
  assert(result.pr.ready, 'Pipeline exec returns a ready PR summary');
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 34: pipeline exec blocks when work fails and no new work can progress', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-exec-blocked-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const agentPath = join(tmpdir(), `sw-pipeline-exec-blocked-agent-${Date.now()}`);
  execSync(`git worktree add -b pipe-exec-blocked-branch "${agentPath}"`, { cwd: repoDir });
  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: agentPath, branch: 'pipe-exec-blocked-branch' });
  startPipeline(pipelineDb, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-exec-blocked',
    priority: 5,
  });
  pipelineDb.close();

  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'exec',
    'pipe-exec-blocked',
    '--max-iterations',
    '2',
    '--max-retries',
    '0',
    '--json',
    '--',
    process.execPath,
    '-e',
    'process.exit(2)',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.status === 'blocked', 'Pipeline exec blocks when commands fail and no forward progress remains');
  assert(result.iterations.some((iteration) => iteration.executed_failures > 0), 'Pipeline exec records failed command executions');
  execSync(`git worktree remove "${agentPath}" --force`, { cwd: repoDir });
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 35: dependency-aware pipeline execution holds test tasks until implementation completes', () => {
  const repoDir = join(tmpdir(), `sw-pipeline-deps-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const agentPath = join(repoDir, 'agent1');
  mkdirSync(agentPath, { recursive: true });
  const pipelineDb = initDb(repoDir);
  registerWorktree(pipelineDb, { name: 'main', path: repoDir, branch: 'main' });
  registerWorktree(pipelineDb, { name: 'agent1', path: agentPath, branch: 'feature/agent1' });
  startPipeline(pipelineDb, {
    title: 'Ship login retries',
    description: 'Implement login retries',
    pipelineId: 'pipe-deps',
    priority: 5,
  });
  const initialStatus = getPipelineStatus(pipelineDb, 'pipe-deps');
  const implementTask = initialStatus.tasks.find((task) => task.title.startsWith('Implement:'));
  const testTask = initialStatus.tasks.find((task) => task.title.startsWith('Add or update tests'));
  const firstRun = runPipeline(pipelineDb, repoDir, { pipelineId: 'pipe-deps' });

  assert(testTask.dependencies.includes(implementTask.id), 'Planner wires the test task to depend on the implementation task');
  assert(firstRun.assigned.length === 1 && firstRun.assigned[0].task_id === implementTask.id, 'Runner dispatches only the dependency-free implementation task first');

  completeTask(pipelineDb, implementTask.id);
  const secondRun = runPipeline(pipelineDb, repoDir, { pipelineId: 'pipe-deps' });
  assert(secondRun.assigned.some((assignment) => assignment.task_id === testTask.id), 'Runner dispatches the dependent test task after implementation completes');
  pipelineDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 36: task outcome evaluator flags successful no-op executions', () => {
  const repoDir = join(tmpdir(), `sw-outcome-noop-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const worktreePath = join(repoDir, 'agent1');
  mkdirSync(worktreePath, { recursive: true });
  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(db, { title: 'Implement: no-op task' });
  assignTask(db, taskId, 'main');
  claimFiles(db, taskId, 'main', ['src/example.js']);

  const result = evaluateTaskOutcome(db, repoDir, { taskId });
  assert(result.status === 'needs_followup', 'Outcome evaluator flags no-op command results');
  assert(result.reason_code === 'no_changes_detected', 'Outcome evaluator reports no_changes_detected for no-op results');
  db.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 37: task outcome evaluator accepts in-scope claimed source changes', () => {
  const repoDir = join(tmpdir(), `sw-outcome-pass-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(db, { title: 'Implement: update source' });
  assignTask(db, taskId, 'main');
  claimFiles(db, taskId, 'main', ['src/example.js']);
  execSync('mkdir -p src && printf "ok\\n" > src/example.js', { cwd: repoDir, shell: '/bin/sh' });

  const result = evaluateTaskOutcome(db, repoDir, { taskId });
  assert(result.status === 'accepted', 'Outcome evaluator accepts claimed source changes for implementation tasks');
  db.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 37aa: task outcome evaluator can resolve execution from lease identity', () => {
  const repoDir = join(tmpdir(), `sw-outcome-lease-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(db, { title: 'Implement: update auth helper via lease' });
  const lease = startTaskLease(db, taskId, 'main', 'codex');
  execSync('mkdir -p src', { cwd: repoDir, shell: '/bin/sh' });
  claimFiles(db, taskId, 'main', ['src/auth-helper.js']);
  upsertTaskSpec(db, taskId, {
    task_type: 'implementation',
    allowed_paths: ['src/auth-helper.js'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
    objective_keywords: ['auth'],
  });
  writeFileSync(join(repoDir, 'src/auth-helper.js'), 'export const authHelper = true;\n');

  const result = evaluateTaskOutcome(db, repoDir, { leaseId: lease.id });
  assert(result.status === 'accepted', 'Outcome evaluator accepts lease-resolved execution context');
  assert(result.lease_id === lease.id, 'Outcome evaluator returns the evaluated lease ID');
  assert(result.task_id === taskId, 'Outcome evaluator returns the task behind the lease');
  db.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 37b: task outcome evaluator enforces structured task scope', () => {
  const repoDir = join(tmpdir(), `sw-outcome-scope-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(db, { title: 'Update docs for release notes' });
  assignTask(db, taskId, 'main');
  claimFiles(db, taskId, 'main', ['src/example.js']);
  upsertTaskSpec(db, taskId, {
    task_type: 'docs',
    allowed_paths: ['docs/**', 'README.md'],
    expected_output_types: ['docs'],
    success_criteria: ['change a docs file'],
  });
  execSync('mkdir -p src && printf "oops\\n" > src/example.js', { cwd: repoDir, shell: '/bin/sh' });

  const result = evaluateTaskOutcome(db, repoDir, { taskId });
  assert(result.status === 'needs_followup', 'Outcome evaluator flags changes outside the structured task scope');
  assert(result.reason_code === 'changes_outside_task_scope', 'Outcome evaluator reports changes_outside_task_scope for out-of-scope edits');
  db.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 37c: task outcome evaluator allows implementation work when follow-up deliverables are split into separate tasks', () => {
  const repoDir = join(tmpdir(), `sw-outcome-deliverables-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(db, { title: 'Implement: Harden auth API permissions' });
  assignTask(db, taskId, 'main');
  claimFiles(db, taskId, 'main', ['src/auth/login.js']);
  upsertTaskSpec(db, taskId, {
    task_type: 'implementation',
    allowed_paths: ['src/auth/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
    followup_deliverables: ['tests', 'docs'],
    objective_keywords: ['auth', 'api', 'permissions'],
    risk_level: 'high',
    success_criteria: ['change auth source while tests/docs are handled by follow-up tasks'],
  });
  execSync('mkdir -p src/auth && printf "ok\\n" > src/auth/login.js', { cwd: repoDir, shell: '/bin/sh' });

  const result = evaluateTaskOutcome(db, repoDir, { taskId });
  assert(result.status === 'accepted', 'Outcome evaluator accepts implementation work when only source is required for the current task');
  assert(result.reason_code === null, 'Outcome evaluator does not force tests/docs onto the implementation task when they are follow-up deliverables');
  db.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 37d: task outcome evaluator checks objective evidence beyond scope', () => {
  const repoDir = join(tmpdir(), `sw-outcome-objective-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), 'init\n');
  execSync('git add README.md', { cwd: repoDir });
  execSync('git commit -m "init"', { cwd: repoDir });

  const db = initDb(repoDir);
  registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });
  const taskId = createTask(db, { title: 'Implement: auth permissions flow' });
  assignTask(db, taskId, 'main');
  claimFiles(db, taskId, 'main', ['src/auth/login.js']);
  upsertTaskSpec(db, taskId, {
    task_type: 'implementation',
    allowed_paths: ['src/**'],
    expected_output_types: ['source'],
    required_deliverables: ['source'],
    objective_keywords: ['auth', 'permissions'],
    risk_level: 'medium',
    success_criteria: ['change auth permission logic'],
  });
  releaseFileClaims(db, taskId);
  claimFiles(db, taskId, 'main', ['src/general/handler.js']);
  execSync('mkdir -p src/general && printf "ok\\n" > src/general/handler.js', { cwd: repoDir, shell: '/bin/sh' });

  const result = evaluateTaskOutcome(db, repoDir, { taskId });
  assert(result.status === 'needs_followup', 'Outcome evaluator rejects in-scope changes that do not evidence the task objective strongly enough');
  assert(result.reason_code === 'objective_not_evidenced', 'Outcome evaluator reports objective_not_evidenced when keywords are not reflected in changed outputs');
  db.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 38: pipeline exec retries transient failures and reaches ready', () => {
  const { repoDir, agentPath, db } = setupPipelineExecRepo('sw-pipeline-retry-ready', 'pipe-retry-ready-branch');
  startPipeline(db, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-retry-ready',
    priority: 5,
  });
  const retrySpec = getTaskSpec(db, 'pipe-retry-ready-01');
  upsertTaskSpec(db, 'pipe-retry-ready-01', {
    ...retrySpec,
    execution_policy: {
      ...retrySpec.execution_policy,
      max_retries: 1,
      retry_backoff_ms: 0,
    },
  });
  db.close();

  const attemptFile = join(tmpdir(), `sw-pipeline-retry-ready-attempt-${Date.now()}`);
  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'exec',
    'pipe-retry-ready',
    '--max-iterations',
    '3',
    '--max-retries',
    '1',
    '--json',
    '--',
    '/bin/sh',
    '-c',
    `count=$(cat "${attemptFile}" 2>/dev/null || echo 0); count=$((count+1)); printf '%s\\n' "$count" > "${attemptFile}"; if [ "$count" -lt 2 ]; then exit 1; fi; printf 'updated\\n' > README.md && git add README.md && git -c user.email=test@test.com -c user.name=Test commit -m 'docs update' >/dev/null`,
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.status === 'ready', 'Pipeline exec recovers from a transient task failure within retry budget');
  assert(result.iterations.some((iteration) => iteration.retries_scheduled === 1), 'Pipeline exec records scheduled retries when a task fails transiently');
  cleanupPipelineExecRepo(repoDir, agentPath);
});

test('Fix 39: pipeline exec blocks after exhausting retry budget', () => {
  const { repoDir, agentPath, db } = setupPipelineExecRepo('sw-pipeline-retry-blocked', 'pipe-retry-blocked-branch');
  startPipeline(db, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-retry-blocked',
    priority: 5,
  });
  const retrySpec = getTaskSpec(db, 'pipe-retry-blocked-01');
  upsertTaskSpec(db, 'pipe-retry-blocked-01', {
    ...retrySpec,
    execution_policy: {
      ...retrySpec.execution_policy,
      max_retries: 1,
      retry_backoff_ms: 0,
    },
  });
  db.close();

  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'exec',
    'pipe-retry-blocked',
    '--max-iterations',
    '3',
    '--max-retries',
    '1',
    '--json',
    '--',
    process.execPath,
    '-e',
    'process.exit(2)',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  const retryDb = openDb(repoDir);
  const retryEvents = listAuditEvents(retryDb, { eventType: 'pipeline_task_retry_scheduled', limit: 10 });
  const status = getPipelineStatus(retryDb, 'pipe-retry-blocked');
  retryDb.close();

  assert(result.status === 'blocked', 'Pipeline exec blocks once retry budget is exhausted and no forward progress remains');
  assert(retryEvents.length === 1, 'Pipeline exec schedules exactly one retry when max-retries is one');
  assert(status.counts.failed === 1, 'Pipeline leaves the task failed after retries are exhausted');
  cleanupPipelineExecRepo(repoDir, agentPath);
});

test('Fix 39b: pipeline exec enforces task-specific timeout policy', () => {
  const { repoDir, agentPath, db } = setupPipelineExecRepo('sw-pipeline-timeout', 'pipe-timeout-branch');
  startPipeline(db, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-timeout',
    priority: 5,
  });
  const spec = getTaskSpec(db, 'pipe-timeout-01');
  upsertTaskSpec(db, 'pipe-timeout-01', {
    ...spec,
    execution_policy: {
      timeout_ms: 50,
      max_retries: 0,
      retry_backoff_ms: 0,
    },
  });
  db.close();

  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'exec',
    'pipe-timeout',
    '--max-iterations',
    '2',
    '--json',
    '--',
    process.execPath,
    '-e',
    'setTimeout(() => process.exit(0), 500)',
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.status === 'blocked', 'Pipeline exec blocks when a task exceeds its execution timeout');
  assert(result.iterations[0].executed_failures === 1, 'Timed out execution is recorded as a failed task execution');
  const timeoutDb = openDb(repoDir);
  const timeoutEvents = listAuditEvents(timeoutDb, { eventType: 'pipeline_task_executed', limit: 10 });
  timeoutDb.close();
  assert(timeoutEvents.some((event) => event.reason_code === 'task_execution_timeout'), 'Timed out execution is logged with a timeout-specific reason code');
  cleanupPipelineExecRepo(repoDir, agentPath);
});

test('Fix 40: pipeline exec resumes previously failed tasks when retries remain', () => {
  const { repoDir, agentPath, db } = setupPipelineExecRepo('sw-pipeline-retry-resume', 'pipe-retry-resume-branch');
  startPipeline(db, {
    title: 'Refresh docs',
    description: '- update docs',
    pipelineId: 'pipe-retry-resume',
    priority: 5,
  });
  const retrySpec = getTaskSpec(db, 'pipe-retry-resume-01');
  upsertTaskSpec(db, 'pipe-retry-resume-01', {
    ...retrySpec,
    execution_policy: {
      ...retrySpec.execution_policy,
      max_retries: 1,
      retry_backoff_ms: 0,
    },
  });
  const lease = startTaskLease(db, 'pipe-retry-resume-01', 'agent1', 'pipeline-runner');
  assert(Boolean(lease), 'Fixture acquires a lease before simulating a previous failed run');
  failTask(db, 'pipe-retry-resume-01', 'pre-existing failure');
  db.close();

  const result = JSON.parse(execFileSync(process.execPath, [
    join(process.cwd(), 'src/cli/index.js'),
    'pipeline',
    'exec',
    'pipe-retry-resume',
    '--max-iterations',
    '2',
    '--max-retries',
    '1',
    '--json',
    '--',
    '/bin/sh',
    '-c',
    "printf 'updated\\n' > README.md && git add README.md && git -c user.email=test@test.com -c user.name=Test commit -m 'docs update' >/dev/null",
  ], {
    cwd: repoDir,
    encoding: 'utf8',
  }));

  assert(result.status === 'ready', 'Pipeline exec resumes a previously failed task when retry budget remains');
  assert(result.iterations[0].resumed_retries === 1, 'Pipeline exec reports resumed retry work in the iteration summary');
  cleanupPipelineExecRepo(repoDir, agentPath);
});

test('Fix 53: audit events are chained and signed with a project audit key', () => {
  const repoDir = join(tmpdir(), `switchman-audit-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  const auditDb = initDb(repoDir);

  logAuditEvent(auditDb, {
    eventType: 'test_event_started',
    status: 'allowed',
    worktree: 'agent1',
    taskId: 'task-1',
    details: JSON.stringify({ step: 1 }),
  });
  logAuditEvent(auditDb, {
    eventType: 'test_event_finished',
    status: 'allowed',
    worktree: 'agent1',
    taskId: 'task-1',
    details: JSON.stringify({ step: 2 }),
  });

  const events = listAuditEvents(auditDb, { limit: 10 });
  const verification = verifyAuditTrail(auditDb);

  assert(existsSync(join(repoDir, '.switchman', 'audit.key')), 'Audit key file is created alongside the project database');
  assert(events.length >= 2, 'Audit log stores the signed test events');
  assert(events[0].sequence !== null, 'Audit events include a chain sequence number');
  assert(Boolean(events[0].entry_hash), 'Audit events store an entry hash');
  assert(Boolean(events[0].signature), 'Audit events store a signature');
  assert(verification.ok, 'Audit verification succeeds for an untampered audit trail');

  auditDb.close();
  rmSync(repoDir, { recursive: true, force: true });
});

test('Fix 53b: audit verification detects tampering and CLI exits non-zero', () => {
  const repoDir = join(tmpdir(), `switchman-audit-tamper-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });
  execSync('git init', { cwd: repoDir });
  execSync('git config user.email "test@test.com"', { cwd: repoDir });
  execSync('git config user.name "Test"', { cwd: repoDir });
  const auditDb = initDb(repoDir);

  logAuditEvent(auditDb, {
    eventType: 'tamper_target',
    status: 'allowed',
    worktree: 'agent2',
    taskId: 'task-2',
    details: JSON.stringify({ original: true }),
  });
  logAuditEvent(auditDb, {
    eventType: 'tamper_followup',
    status: 'allowed',
    worktree: 'agent2',
    taskId: 'task-2',
    details: JSON.stringify({ original: false }),
  });
  auditDb.close();

  const rawDb = new DatabaseSync(join(repoDir, '.switchman', 'switchman.db'));
  rawDb.prepare(`UPDATE audit_log SET details=? WHERE sequence=1`).run('tampered');
  rawDb.close();

  const tamperedDb = openDb(repoDir);
  const verification = verifyAuditTrail(tamperedDb);
  tamperedDb.close();

  assert(!verification.ok, 'Audit verification fails after a stored event is modified');
  assert(verification.failures.some((failure) => failure.reason_code === 'entry_hash_mismatch'), 'Audit verification reports an entry hash mismatch after tampering');

  let cliFailed = false;
  try {
    execFileSync(process.execPath, [
      join(process.cwd(), 'src/cli/index.js'),
      'audit',
      'verify',
      '--json',
    ], {
      cwd: repoDir,
      encoding: 'utf8',
    });
  } catch (err) {
    cliFailed = true;
    const output = String(err.stdout || err.stderr || '');
    assert(output.includes('entry_hash_mismatch'), 'CLI audit verify surfaces the tamper reason code');
  }
  assert(cliFailed, 'CLI audit verify exits non-zero when the audit trail has been tampered with');

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
