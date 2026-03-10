/**
 * switchman - Database layer
 * SQLite-backed task queue and file ownership registry
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const SWITCHMAN_DIR = '.switchman';
const DB_FILE = 'switchman.db';

// How long (ms) a writer will wait for a lock before giving up.
// 5 seconds is generous for a CLI tool with 3-10 concurrent agents.
const BUSY_TIMEOUT_MS = 5000;
const CLAIM_RETRY_DELAY_MS = 100;
const CLAIM_RETRY_ATTEMPTS = 5;
export const DEFAULT_STALE_LEASE_MINUTES = 15;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('database is locked') || message.includes('sqlite_busy');
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function configureDb(db) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};
  `);
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      description  TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      worktree     TEXT,
      agent        TEXT,
      priority     INTEGER DEFAULT 5,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS leases (
      id            TEXT PRIMARY KEY,
      task_id       TEXT NOT NULL,
      worktree      TEXT NOT NULL,
      agent         TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      started_at    TEXT NOT NULL DEFAULT (datetime('now')),
      heartbeat_at  TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at   TEXT,
      failure_reason TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS file_claims (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      lease_id    TEXT,
      file_path   TEXT NOT NULL,
      worktree    TEXT NOT NULL,
      agent       TEXT,
      claimed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id),
      FOREIGN KEY(lease_id) REFERENCES leases(id)
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      name          TEXT PRIMARY KEY,
      path          TEXT NOT NULL,
      branch        TEXT NOT NULL,
      agent         TEXT,
      status        TEXT NOT NULL DEFAULT 'idle',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conflict_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at       TEXT NOT NULL DEFAULT (datetime('now')),
      worktree_a        TEXT NOT NULL,
      worktree_b        TEXT NOT NULL,
      conflicting_files TEXT NOT NULL,
      resolved          INTEGER DEFAULT 0
    );
  `);

  const fileClaimColumns = getTableColumns(db, 'file_claims');
  if (fileClaimColumns.length > 0 && !fileClaimColumns.includes('lease_id')) {
    db.exec(`ALTER TABLE file_claims ADD COLUMN lease_id TEXT REFERENCES leases(id)`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_leases_task ON leases(task_id);
    CREATE INDEX IF NOT EXISTS idx_leases_status ON leases(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_unique_active_task
      ON leases(task_id)
      WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_file_claims_task_id ON file_claims(task_id);
    CREATE INDEX IF NOT EXISTS idx_file_claims_lease_id ON file_claims(lease_id);
    CREATE INDEX IF NOT EXISTS idx_file_claims_path ON file_claims(file_path);
    CREATE INDEX IF NOT EXISTS idx_file_claims_active ON file_claims(released_at) WHERE released_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_claims_unique_active
      ON file_claims(file_path)
      WHERE released_at IS NULL;
  `);

  migrateLegacyActiveTasks(db);
}

function touchWorktreeLeaseState(db, worktree, agent, status) {
  if (!worktree) return;
  db.prepare(`
    UPDATE worktrees
    SET status=?, agent=COALESCE(?, agent), last_seen=datetime('now')
    WHERE name=?
  `).run(status, agent || null, worktree);
}

function getTaskTx(db, taskId) {
  return db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
}

function getLeaseTx(db, leaseId) {
  return db.prepare(`SELECT * FROM leases WHERE id=?`).get(leaseId);
}

function getActiveLeaseForTaskTx(db, taskId) {
  return db.prepare(`
    SELECT * FROM leases
    WHERE task_id=? AND status='active'
    ORDER BY started_at DESC
    LIMIT 1
  `).get(taskId);
}

function createLeaseTx(db, { id, taskId, worktree, agent, status = 'active', failureReason = null }) {
  const leaseId = id || makeId('lease');
  db.prepare(`
    INSERT INTO leases (id, task_id, worktree, agent, status, failure_reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(leaseId, taskId, worktree, agent || null, status, failureReason);
  touchWorktreeLeaseState(db, worktree, agent, status === 'active' ? 'busy' : 'idle');
  return getLeaseTx(db, leaseId);
}

function migrateLegacyActiveTasks(db) {
  const legacyTasks = db.prepare(`
    SELECT *
    FROM tasks
    WHERE status='in_progress'
      AND worktree IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM leases
        WHERE leases.task_id = tasks.id
          AND leases.status='active'
      )
  `).all();

  if (!legacyTasks.length) return;

  const backfillClaims = db.prepare(`
    UPDATE file_claims
    SET lease_id=?
    WHERE task_id=? AND released_at IS NULL AND lease_id IS NULL
  `);

  for (const task of legacyTasks) {
    const lease = createLeaseTx(db, {
      taskId: task.id,
      worktree: task.worktree,
      agent: task.agent,
    });
    backfillClaims.run(lease.id, task.id);
  }
}

function resolveActiveLeaseTx(db, taskId, worktree, agent) {
  const task = getTaskTx(db, taskId);
  if (!task) {
    throw new Error(`Task ${taskId} does not exist.`);
  }
  if (task.status !== 'in_progress') {
    throw new Error(`Task ${taskId} is not in progress.`);
  }
  if (task.worktree && task.worktree !== worktree) {
    throw new Error(`Task ${taskId} is assigned to worktree ${task.worktree}, not ${worktree}.`);
  }

  let lease = getActiveLeaseForTaskTx(db, taskId);
  if (lease) {
    if (lease.worktree !== worktree) {
      throw new Error(`Task ${taskId} already has an active lease for worktree ${lease.worktree}, not ${worktree}.`);
    }

    db.prepare(`
      UPDATE leases
      SET heartbeat_at=datetime('now'),
          agent=COALESCE(?, agent)
      WHERE id=?
    `).run(agent || null, lease.id);
    touchWorktreeLeaseState(db, worktree, agent || lease.agent, 'busy');
    return getLeaseTx(db, lease.id);
  }

  lease = createLeaseTx(db, {
    taskId,
    worktree,
    agent: agent || task.agent,
  });

  db.prepare(`
    UPDATE file_claims
    SET lease_id=?
    WHERE task_id=? AND worktree=? AND released_at IS NULL AND lease_id IS NULL
  `).run(lease.id, taskId, worktree);

  return lease;
}

function releaseClaimsForLeaseTx(db, leaseId) {
  db.prepare(`
    UPDATE file_claims
    SET released_at=datetime('now')
    WHERE lease_id=? AND released_at IS NULL
  `).run(leaseId);
}

function closeActiveLeasesForTaskTx(db, taskId, status, failureReason = null) {
  const activeLeases = db.prepare(`
    SELECT * FROM leases
    WHERE task_id=? AND status='active'
  `).all(taskId);

  db.prepare(`
    UPDATE leases
    SET status=?,
        finished_at=datetime('now'),
        failure_reason=?
    WHERE task_id=? AND status='active'
  `).run(status, failureReason, taskId);

  for (const lease of activeLeases) {
    touchWorktreeLeaseState(db, lease.worktree, lease.agent, 'idle');
  }

  return activeLeases;
}

function withImmediateTransaction(db, fn) {
  for (let attempt = 1; attempt <= CLAIM_RETRY_ATTEMPTS; attempt++) {
    let beganTransaction = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      beganTransaction = true;
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      if (beganTransaction) {
        try { db.exec('ROLLBACK'); } catch { /* no-op */ }
      }

      if (isBusyError(err) && attempt < CLAIM_RETRY_ATTEMPTS) {
        sleepSync(CLAIM_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw err;
    }
  }
}

export function getSwitchmanDir(repoRoot) {
  return join(repoRoot, SWITCHMAN_DIR);
}

export function getDbPath(repoRoot) {
  return join(repoRoot, SWITCHMAN_DIR, DB_FILE);
}

export function initDb(repoRoot) {
  const dir = getSwitchmanDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(getDbPath(repoRoot));
  configureDb(db);
  ensureSchema(db);
  return db;
}

export function openDb(repoRoot) {
  const dbPath = getDbPath(repoRoot);
  if (!existsSync(dbPath)) {
    throw new Error(`No switchman database found. Run 'switchman init' first.`);
  }
  const db = new DatabaseSync(dbPath);
  configureDb(db);
  ensureSchema(db);
  return db;
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export function createTask(db, { id, title, description, priority = 5 }) {
  const taskId = id || makeId('task');
  db.prepare(`
    INSERT INTO tasks (id, title, description, priority)
    VALUES (?, ?, ?, ?)
  `).run(taskId, title, description || null, priority);
  return taskId;
}

export function startTaskLease(db, taskId, worktree, agent) {
  return withImmediateTransaction(db, () => {
    const task = getTaskTx(db, taskId);
    if (!task || task.status !== 'pending') {
      return null;
    }

    db.prepare(`
      UPDATE tasks
      SET status='in_progress', worktree=?, agent=?, updated_at=datetime('now')
      WHERE id=? AND status='pending'
    `).run(worktree, agent || null, taskId);

    return createLeaseTx(db, { taskId, worktree, agent });
  });
}

export function assignTask(db, taskId, worktree, agent) {
  return Boolean(startTaskLease(db, taskId, worktree, agent));
}

export function completeTask(db, taskId) {
  withImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE tasks
      SET status='done', completed_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(taskId);
    closeActiveLeasesForTaskTx(db, taskId, 'completed');
  });
}

export function failTask(db, taskId, reason) {
  withImmediateTransaction(db, () => {
    db.prepare(`
      UPDATE tasks
      SET status='failed', description=COALESCE(description,'') || '\nFAILED: ' || ?, updated_at=datetime('now')
      WHERE id=?
    `).run(reason || 'unknown', taskId);
    closeActiveLeasesForTaskTx(db, taskId, 'failed', reason || 'unknown');
  });
}

export function listTasks(db, statusFilter) {
  if (statusFilter) {
    return db.prepare(`SELECT * FROM tasks WHERE status=? ORDER BY priority DESC, created_at ASC`).all(statusFilter);
  }
  return db.prepare(`SELECT * FROM tasks ORDER BY priority DESC, created_at ASC`).all();
}

export function getTask(db, taskId) {
  return db.prepare(`SELECT * FROM tasks WHERE id=?`).get(taskId);
}

export function getNextPendingTask(db) {
  return db.prepare(`
    SELECT * FROM tasks WHERE status='pending'
    ORDER BY priority DESC, created_at ASC LIMIT 1
  `).get();
}

export function listLeases(db, statusFilter) {
  if (statusFilter) {
    return db.prepare(`
      SELECT l.*, t.title AS task_title
      FROM leases l
      JOIN tasks t ON l.task_id = t.id
      WHERE l.status=?
      ORDER BY l.started_at DESC
    `).all(statusFilter);
  }

  return db.prepare(`
    SELECT l.*, t.title AS task_title
    FROM leases l
    JOIN tasks t ON l.task_id = t.id
    ORDER BY l.started_at DESC
  `).all();
}

export function getLease(db, leaseId) {
  return db.prepare(`
    SELECT l.*, t.title AS task_title
    FROM leases l
    JOIN tasks t ON l.task_id = t.id
    WHERE l.id=?
  `).get(leaseId);
}

export function getActiveLeaseForTask(db, taskId) {
  const lease = getActiveLeaseForTaskTx(db, taskId);
  return lease ? getLease(db, lease.id) : null;
}

export function heartbeatLease(db, leaseId, agent) {
  const result = db.prepare(`
    UPDATE leases
    SET heartbeat_at=datetime('now'),
        agent=COALESCE(?, agent)
    WHERE id=? AND status='active'
  `).run(agent || null, leaseId);

  if (result.changes === 0) {
    return null;
  }

  const lease = getLease(db, leaseId);
  touchWorktreeLeaseState(db, lease.worktree, agent || lease.agent, 'busy');
  return lease;
}

export function getStaleLeases(db, staleAfterMinutes = DEFAULT_STALE_LEASE_MINUTES) {
  return db.prepare(`
    SELECT l.*, t.title AS task_title
    FROM leases l
    JOIN tasks t ON l.task_id = t.id
    WHERE l.status='active'
      AND l.heartbeat_at < datetime('now', ?)
    ORDER BY l.heartbeat_at ASC
  `).all(`-${staleAfterMinutes} minutes`);
}

export function reapStaleLeases(db, staleAfterMinutes = DEFAULT_STALE_LEASE_MINUTES) {
  return withImmediateTransaction(db, () => {
    const staleLeases = getStaleLeases(db, staleAfterMinutes);
    if (!staleLeases.length) {
      return [];
    }

    const expireLease = db.prepare(`
      UPDATE leases
      SET status='expired',
          finished_at=datetime('now'),
          failure_reason=COALESCE(failure_reason, 'stale lease reaped')
      WHERE id=? AND status='active'
    `);

    const resetTask = db.prepare(`
      UPDATE tasks
      SET status='pending',
          worktree=NULL,
          agent=NULL,
          updated_at=datetime('now')
      WHERE id=? AND status='in_progress'
        AND NOT EXISTS (
          SELECT 1 FROM leases
          WHERE task_id=?
            AND status='active'
        )
    `);

    for (const lease of staleLeases) {
      expireLease.run(lease.id);
      releaseClaimsForLeaseTx(db, lease.id);
      resetTask.run(lease.task_id, lease.task_id);
      touchWorktreeLeaseState(db, lease.worktree, lease.agent, 'idle');
    }

    return staleLeases.map((lease) => ({
      ...lease,
      status: 'expired',
      failure_reason: lease.failure_reason || 'stale lease reaped',
    }));
  });
}

// ─── File Claims ──────────────────────────────────────────────────────────────

export function claimFiles(db, taskId, worktree, filePaths, agent) {
  return withImmediateTransaction(db, () => {
    const lease = resolveActiveLeaseTx(db, taskId, worktree, agent);
    const findActiveClaim = db.prepare(`
      SELECT *
      FROM file_claims
      WHERE file_path=? AND released_at IS NULL
      LIMIT 1
    `);
    const insert = db.prepare(`
      INSERT INTO file_claims (task_id, lease_id, file_path, worktree, agent)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const fp of filePaths) {
      const existing = findActiveClaim.get(fp);
      if (existing) {
        const sameLease = existing.lease_id === lease.id;
        const sameLegacyOwner = existing.lease_id == null && existing.task_id === taskId && existing.worktree === worktree;

        if (sameLease || sameLegacyOwner) {
          if (sameLegacyOwner) {
            db.prepare(`
              UPDATE file_claims
              SET lease_id=?, agent=COALESCE(?, agent)
              WHERE id=?
            `).run(lease.id, agent || null, existing.id);
          }
          continue;
        }

        throw new Error('One or more files are already actively claimed by another task.');
      }

      insert.run(taskId, lease.id, fp, worktree, agent || null);
    }

    db.prepare(`
      UPDATE leases
      SET heartbeat_at=datetime('now'),
          agent=COALESCE(?, agent)
      WHERE id=?
    `).run(agent || null, lease.id);

    touchWorktreeLeaseState(db, worktree, agent || lease.agent, 'busy');
    return getLeaseTx(db, lease.id);
  });
}

export function releaseFileClaims(db, taskId) {
  db.prepare(`
    UPDATE file_claims SET released_at=datetime('now')
    WHERE task_id=? AND released_at IS NULL
  `).run(taskId);
}

export function releaseLeaseFileClaims(db, leaseId) {
  releaseClaimsForLeaseTx(db, leaseId);
}

export function getActiveFileClaims(db) {
  return db.prepare(`
    SELECT fc.*, t.title as task_title, t.status as task_status,
           l.id as lease_id, l.status as lease_status, l.heartbeat_at as lease_heartbeat_at
    FROM file_claims fc
    JOIN tasks t ON fc.task_id = t.id
    LEFT JOIN leases l ON fc.lease_id = l.id
    WHERE fc.released_at IS NULL
    ORDER BY fc.file_path
  `).all();
}

export function checkFileConflicts(db, filePaths, excludeWorktree) {
  const conflicts = [];
  const stmt = db.prepare(`
    SELECT fc.*, t.title as task_title, l.id as lease_id, l.status as lease_status
    FROM file_claims fc
    JOIN tasks t ON fc.task_id = t.id
    LEFT JOIN leases l ON fc.lease_id = l.id
    WHERE fc.file_path=?
      AND fc.released_at IS NULL
      AND fc.worktree != ?
      AND t.status NOT IN ('done','failed')
  `);
  for (const fp of filePaths) {
    const existing = stmt.get(fp, excludeWorktree || '');
    if (existing) conflicts.push({ file: fp, claimedBy: existing });
  }
  return conflicts;
}

// ─── Worktrees ────────────────────────────────────────────────────────────────

export function registerWorktree(db, { name, path, branch, agent }) {
  db.prepare(`
    INSERT INTO worktrees (name, path, branch, agent)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      path=excluded.path, branch=excluded.branch,
      agent=excluded.agent, last_seen=datetime('now'), status='idle'
  `).run(name, path, branch, agent || null);
}

export function listWorktrees(db) {
  return db.prepare(`SELECT * FROM worktrees ORDER BY registered_at`).all();
}

export function updateWorktreeStatus(db, name, status) {
  db.prepare(`UPDATE worktrees SET status=?, last_seen=datetime('now') WHERE name=?`).run(status, name);
}

// ─── Conflict Log ─────────────────────────────────────────────────────────────

export function logConflict(db, worktreeA, worktreeB, conflictingFiles) {
  db.prepare(`
    INSERT INTO conflict_log (worktree_a, worktree_b, conflicting_files)
    VALUES (?, ?, ?)
  `).run(worktreeA, worktreeB, JSON.stringify(conflictingFiles));
}

export function getConflictLog(db) {
  return db.prepare(`SELECT * FROM conflict_log ORDER BY detected_at DESC LIMIT 50`).all();
}
