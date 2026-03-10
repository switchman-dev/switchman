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

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('database is locked') || message.includes('sqlite_busy');
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

  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};

    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      worktree    TEXT,
      agent       TEXT,
      priority    INTEGER DEFAULT 5,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS file_claims (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      worktree    TEXT NOT NULL,
      agent       TEXT,
      claimed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      name        TEXT PRIMARY KEY,
      path        TEXT NOT NULL,
      branch      TEXT NOT NULL,
      agent       TEXT,
      status      TEXT NOT NULL DEFAULT 'idle',
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conflict_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_at   TEXT NOT NULL DEFAULT (datetime('now')),
      worktree_a    TEXT NOT NULL,
      worktree_b    TEXT NOT NULL,
      conflicting_files TEXT NOT NULL,
      resolved      INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_file_claims_path ON file_claims(file_path);
    CREATE INDEX IF NOT EXISTS idx_file_claims_active ON file_claims(released_at) WHERE released_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_claims_unique_active
      ON file_claims(file_path)
      WHERE released_at IS NULL;
  `);

  return db;
}

export function openDb(repoRoot) {
  const dbPath = getDbPath(repoRoot);
  if (!existsSync(dbPath)) {
    throw new Error(`No switchman database found. Run 'switchman init' first.`);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};
  `);
  return db;
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export function createTask(db, { id, title, description, priority = 5 }) {
  const taskId = id || `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.prepare(`
    INSERT INTO tasks (id, title, description, priority)
    VALUES (?, ?, ?, ?)
  `).run(taskId, title, description || null, priority);
  return taskId;
}

export function assignTask(db, taskId, worktree, agent) {
  const result = db.prepare(`
    UPDATE tasks
    SET status='in_progress', worktree=?, agent=?, updated_at=datetime('now')
    WHERE id=? AND status='pending'
  `).run(worktree, agent || null, taskId);
  return result.changes > 0;
}

export function completeTask(db, taskId) {
  db.prepare(`
    UPDATE tasks
    SET status='done', completed_at=datetime('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(taskId);
}

export function failTask(db, taskId, reason) {
  db.prepare(`
    UPDATE tasks
    SET status='failed', description=COALESCE(description,'') || '\nFAILED: ' || ?, updated_at=datetime('now')
    WHERE id=?
  `).run(reason || 'unknown', taskId);
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

// ─── File Claims ──────────────────────────────────────────────────────────────

export function claimFiles(db, taskId, worktree, filePaths, agent) {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`Task ${taskId} does not exist.`);
  }
  if (task.status !== 'in_progress') {
    throw new Error(`Task ${taskId} is not in progress.`);
  }
  if (task.worktree && task.worktree !== worktree) {
    throw new Error(`Task ${taskId} is assigned to worktree ${task.worktree}, not ${worktree}.`);
  }

  const insert = db.prepare(`
    INSERT INTO file_claims (task_id, file_path, worktree, agent)
    VALUES (?, ?, ?, ?)
  `);
  for (let attempt = 1; attempt <= CLAIM_RETRY_ATTEMPTS; attempt++) {
    let beganTransaction = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      beganTransaction = true;

      for (const fp of filePaths) {
        insert.run(taskId, fp, worktree, agent || null);
      }

      db.exec('COMMIT');
      return;
    } catch (err) {
      if (beganTransaction) {
        try { db.exec('ROLLBACK'); } catch { /* no-op */ }
      }

      if (isBusyError(err) && attempt < CLAIM_RETRY_ATTEMPTS) {
        sleepSync(CLAIM_RETRY_DELAY_MS * attempt);
        continue;
      }

      if (String(err?.message || '').toLowerCase().includes('unique')) {
        throw new Error('One or more files are already actively claimed by another task.');
      }

      throw err;
    }
  }
}

export function releaseFileClaims(db, taskId) {
  db.prepare(`
    UPDATE file_claims SET released_at=datetime('now')
    WHERE task_id=? AND released_at IS NULL
  `).run(taskId);
}

export function getActiveFileClaims(db) {
  return db.prepare(`
    SELECT fc.*, t.title as task_title, t.status as task_status
    FROM file_claims fc
    JOIN tasks t ON fc.task_id = t.id
    WHERE fc.released_at IS NULL
    ORDER BY fc.file_path
  `).all();
}

export function checkFileConflicts(db, filePaths, excludeWorktree) {
  const conflicts = [];
  const stmt = db.prepare(`
    SELECT fc.*, t.title as task_title
    FROM file_claims fc
    JOIN tasks t ON fc.task_id = t.id
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
