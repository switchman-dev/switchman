/**
 * switchman - Database layer
 * SQLite-backed task queue and file ownership registry
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { join, posix, resolve } from 'path';
import { matchesPathPatterns } from './ignore.js';
import { buildModuleDependencyIndexForPath, buildSemanticIndexForPath, classifySubsystemsForPath, listTrackedFiles } from './semantic.js';

const SWITCHMAN_DIR = '.switchman';
const DB_FILE = 'switchman.db';
const AUDIT_KEY_FILE = 'audit.key';
const MIGRATION_STATE_FILE = 'migration-state.json';
const CURRENT_SCHEMA_VERSION = 6;

// How long (ms) a writer will wait for a lock before giving up.
// 5 seconds is generous for a CLI tool with 3-10 concurrent agents.
const BUSY_TIMEOUT_MS = 10000;
const CLAIM_RETRY_DELAY_MS = 200;
const CLAIM_RETRY_ATTEMPTS = 20;
export const DEFAULT_STALE_LEASE_MINUTES = 15;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('database is locked') || message.includes('sqlite_busy');
}

function withBusyRetry(fn, { attempts = CLAIM_RETRY_ATTEMPTS, delayMs = CLAIM_RETRY_DELAY_MS } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (isBusyError(err) && attempt < attempts) {
        sleepSync(delayMs * attempt);
        continue;
      }
      throw err;
    }
  }
}

function normalizeWorktreePath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function normalizeClaimedFilePath(filePath) {
  const rawPath = String(filePath || '').replace(/\\/g, '/').trim();
  const normalized = posix.normalize(rawPath.replace(/^\.\/+/, ''));
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    rawPath.startsWith('/') ||
    /^[A-Za-z]:\//.test(rawPath)
  ) {
    throw new Error('Claimed file paths must stay inside the repository.');
  }
  return normalized;
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function configureDb(db, { initialize = false } = {}) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA synchronous=NORMAL;
    PRAGMA busy_timeout=${BUSY_TIMEOUT_MS};
  `);

  if (initialize) {
    withBusyRetry(() => {
      db.exec(`PRAGMA journal_mode=WAL;`);
    });
  }
}

function getTableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function getSchemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
}

function setSchemaVersion(db, version) {
  db.exec(`PRAGMA user_version=${Number(version) || 0}`);
}

function getMigrationStatePath(repoRoot) {
  return join(getSwitchmanDir(repoRoot), MIGRATION_STATE_FILE);
}

function readMigrationState(repoRoot) {
  const path = getMigrationStatePath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Switchman migration state is unreadable at ${path}. Remove or repair it before reopening the database.`);
  }
}

function writeMigrationState(repoRoot, state) {
  writeFileSync(getMigrationStatePath(repoRoot), `${JSON.stringify(state, null, 2)}\n`);
}

function clearMigrationState(repoRoot) {
  const path = getMigrationStatePath(repoRoot);
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

function getAuditSecret(repoRoot) {
  const keyPath = join(getSwitchmanDir(repoRoot), AUDIT_KEY_FILE);
  if (!existsSync(keyPath)) {
    const secret = randomBytes(32).toString('hex');
    writeFileSync(keyPath, `${secret}\n`, { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      // Best-effort on platforms that do not fully support chmod semantics.
    }
    return secret;
  }
  return readFileSync(keyPath, 'utf8').trim();
}

function getAuditContext(db) {
  const repoRoot = db.__switchmanRepoRoot;
  const secret = db.__switchmanAuditSecret;
  if (!repoRoot || !secret) {
    throw new Error('Audit context is not configured for this database.');
  }
  return { repoRoot, secret };
}

function canonicalizeAuditEvent(event) {
  return JSON.stringify({
    sequence: event.sequence,
    prev_hash: event.prevHash,
    event_type: event.eventType,
    status: event.status,
    reason_code: event.reasonCode,
    worktree: event.worktree,
    task_id: event.taskId,
    lease_id: event.leaseId,
    file_path: event.filePath,
    details: event.details,
    created_at: event.createdAt,
  });
}

function computeAuditEntryHash(event) {
  return createHash('sha256').update(canonicalizeAuditEvent(event)).digest('hex');
}

function signAuditEntry(secret, entryHash) {
  return createHmac('sha256', secret).update(entryHash).digest('hex');
}

function applySchemaVersion1(db) {
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
      enforcement_mode TEXT NOT NULL DEFAULT 'observed',
      compliance_state TEXT NOT NULL DEFAULT 'observed',
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

    CREATE TABLE IF NOT EXISTS audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'info',
      reason_code  TEXT,
      worktree     TEXT,
      task_id      TEXT,
      lease_id     TEXT,
      file_path    TEXT,
      details      TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      sequence     INTEGER,
      prev_hash    TEXT,
      entry_hash   TEXT,
      signature    TEXT
    );

    CREATE TABLE IF NOT EXISTS worktree_snapshots (
      worktree     TEXT NOT NULL,
      file_path    TEXT NOT NULL,
      fingerprint  TEXT NOT NULL,
      observed_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (worktree, file_path)
    );

    CREATE TABLE IF NOT EXISTS task_specs (
      task_id      TEXT PRIMARY KEY,
      spec_json    TEXT NOT NULL,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scope_reservations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      lease_id        TEXT NOT NULL,
      task_id         TEXT NOT NULL,
      worktree        TEXT NOT NULL,
      ownership_level TEXT NOT NULL,
      scope_pattern   TEXT,
      subsystem_tag   TEXT,
      reserved_at     TEXT NOT NULL DEFAULT (datetime('now')),
      released_at     TEXT,
      FOREIGN KEY(lease_id) REFERENCES leases(id),
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS boundary_validation_state (
      lease_id           TEXT PRIMARY KEY,
      task_id            TEXT NOT NULL,
      pipeline_id        TEXT,
      status             TEXT NOT NULL,
      missing_task_types TEXT NOT NULL DEFAULT '[]',
      touched_at         TEXT,
      last_evaluated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      details            TEXT,
      FOREIGN KEY(lease_id) REFERENCES leases(id),
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS dependency_invalidations (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      source_lease_id      TEXT NOT NULL,
      source_task_id       TEXT NOT NULL,
      source_pipeline_id   TEXT,
      source_worktree      TEXT,
      affected_task_id     TEXT NOT NULL,
      affected_pipeline_id TEXT,
      affected_worktree    TEXT,
      status               TEXT NOT NULL DEFAULT 'stale',
      reason_type          TEXT NOT NULL,
      subsystem_tag        TEXT,
      source_scope_pattern TEXT,
      affected_scope_pattern TEXT,
      details              TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at          TEXT,
      FOREIGN KEY(source_lease_id) REFERENCES leases(id),
      FOREIGN KEY(source_task_id) REFERENCES tasks(id),
      FOREIGN KEY(affected_task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS code_objects (
      object_id      TEXT PRIMARY KEY,
      file_path      TEXT NOT NULL,
      kind           TEXT NOT NULL,
      name           TEXT NOT NULL,
      source_text    TEXT NOT NULL,
      subsystem_tags TEXT NOT NULL DEFAULT '[]',
      area           TEXT,
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS merge_queue (
      id                 TEXT PRIMARY KEY,
      source_type        TEXT NOT NULL,
      source_ref         TEXT NOT NULL,
      source_worktree    TEXT,
      source_pipeline_id TEXT,
      target_branch      TEXT NOT NULL DEFAULT 'main',
      status             TEXT NOT NULL DEFAULT 'queued',
      retry_count        INTEGER NOT NULL DEFAULT 0,
      max_retries        INTEGER NOT NULL DEFAULT 1,
      last_error_code    TEXT,
      last_error_summary TEXT,
      next_action        TEXT,
      merged_commit      TEXT,
      submitted_by       TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      last_attempt_at    TEXT,
      backoff_until      TEXT,
      escalated_at       TEXT,
      started_at         TEXT,
      finished_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS merge_queue_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_item_id TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      status        TEXT,
      details       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(queue_item_id) REFERENCES merge_queue(id) ON DELETE CASCADE
    );
  `);

  const fileClaimColumns = getTableColumns(db, 'file_claims');
  if (fileClaimColumns.length > 0 && !fileClaimColumns.includes('lease_id')) {
    db.exec(`ALTER TABLE file_claims ADD COLUMN lease_id TEXT REFERENCES leases(id)`);
  }

  const worktreeColumns = getTableColumns(db, 'worktrees');
  if (worktreeColumns.length > 0 && !worktreeColumns.includes('enforcement_mode')) {
    db.exec(`ALTER TABLE worktrees ADD COLUMN enforcement_mode TEXT NOT NULL DEFAULT 'observed'`);
  }
  if (worktreeColumns.length > 0 && !worktreeColumns.includes('compliance_state')) {
    db.exec(`ALTER TABLE worktrees ADD COLUMN compliance_state TEXT NOT NULL DEFAULT 'observed'`);
  }

  const auditColumns = getTableColumns(db, 'audit_log');
  if (auditColumns.length > 0 && !auditColumns.includes('sequence')) {
    db.exec(`ALTER TABLE audit_log ADD COLUMN sequence INTEGER`);
  }
  if (auditColumns.length > 0 && !auditColumns.includes('prev_hash')) {
    db.exec(`ALTER TABLE audit_log ADD COLUMN prev_hash TEXT`);
  }
  if (auditColumns.length > 0 && !auditColumns.includes('entry_hash')) {
    db.exec(`ALTER TABLE audit_log ADD COLUMN entry_hash TEXT`);
  }
  if (auditColumns.length > 0 && !auditColumns.includes('signature')) {
    db.exec(`ALTER TABLE audit_log ADD COLUMN signature TEXT`);
  }

  const mergeQueueColumns = getTableColumns(db, 'merge_queue');
  if (mergeQueueColumns.length > 0 && !mergeQueueColumns.includes('last_attempt_at')) {
    db.exec(`ALTER TABLE merge_queue ADD COLUMN last_attempt_at TEXT`);
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
    CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_sequence ON audit_log(sequence) WHERE sequence IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_worktree_snapshots_worktree ON worktree_snapshots(worktree);
    CREATE INDEX IF NOT EXISTS idx_task_specs_updated_at ON task_specs(updated_at);
    CREATE INDEX IF NOT EXISTS idx_scope_reservations_lease_id ON scope_reservations(lease_id);
    CREATE INDEX IF NOT EXISTS idx_scope_reservations_task_id ON scope_reservations(task_id);
    CREATE INDEX IF NOT EXISTS idx_scope_reservations_active ON scope_reservations(released_at) WHERE released_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_scope_reservations_scope_pattern ON scope_reservations(scope_pattern);
    CREATE INDEX IF NOT EXISTS idx_scope_reservations_subsystem_tag ON scope_reservations(subsystem_tag);
    CREATE INDEX IF NOT EXISTS idx_boundary_validation_pipeline_id ON boundary_validation_state(pipeline_id);
    CREATE INDEX IF NOT EXISTS idx_boundary_validation_status ON boundary_validation_state(status);
    CREATE INDEX IF NOT EXISTS idx_dependency_invalidations_source_lease ON dependency_invalidations(source_lease_id);
    CREATE INDEX IF NOT EXISTS idx_dependency_invalidations_affected_task ON dependency_invalidations(affected_task_id);
    CREATE INDEX IF NOT EXISTS idx_dependency_invalidations_affected_pipeline ON dependency_invalidations(affected_pipeline_id);
    CREATE INDEX IF NOT EXISTS idx_dependency_invalidations_status ON dependency_invalidations(status);
    CREATE INDEX IF NOT EXISTS idx_code_objects_file_path ON code_objects(file_path);
    CREATE INDEX IF NOT EXISTS idx_code_objects_name ON code_objects(name);
    CREATE INDEX IF NOT EXISTS idx_merge_queue_status ON merge_queue(status);
    CREATE INDEX IF NOT EXISTS idx_merge_queue_created_at ON merge_queue(created_at);
    CREATE INDEX IF NOT EXISTS idx_merge_queue_pipeline_id ON merge_queue(source_pipeline_id);
    CREATE INDEX IF NOT EXISTS idx_merge_queue_events_item ON merge_queue_events(queue_item_id);
  `);
}

function applySchemaVersion2(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_journal (
      id             TEXT PRIMARY KEY,
      scope_type     TEXT NOT NULL,
      scope_id       TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'running',
      details        TEXT,
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_operation_journal_scope
      ON operation_journal(scope_type, scope_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_operation_journal_status
      ON operation_journal(status, started_at);
  `);

  migrateLegacyAuditLog(db);
  migrateLegacyActiveTasks(db);
}

function applySchemaVersion3(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS temp_resources (
      id            TEXT PRIMARY KEY,
      scope_type    TEXT NOT NULL,
      scope_id      TEXT NOT NULL,
      operation_id  TEXT,
      resource_type TEXT NOT NULL,
      path          TEXT NOT NULL,
      branch        TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      details       TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      released_at   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_temp_resources_scope
      ON temp_resources(scope_type, scope_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_temp_resources_status
      ON temp_resources(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_temp_resources_path
      ON temp_resources(path);
    CREATE INDEX IF NOT EXISTS idx_temp_resources_operation
      ON temp_resources(operation_id);
  `);
}

function applySchemaVersion4(db) {
  const mergeQueueColumns = getTableColumns(db, 'merge_queue');
  if (mergeQueueColumns.length > 0 && !mergeQueueColumns.includes('backoff_until')) {
    db.exec(`ALTER TABLE merge_queue ADD COLUMN backoff_until TEXT`);
  }
  if (mergeQueueColumns.length > 0 && !mergeQueueColumns.includes('escalated_at')) {
    db.exec(`ALTER TABLE merge_queue ADD COLUMN escalated_at TEXT`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_merge_queue_backoff_until ON merge_queue(backoff_until);
    CREATE INDEX IF NOT EXISTS idx_merge_queue_escalated_at ON merge_queue(escalated_at);
  `);
}

function applySchemaVersion5(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_overrides (
      id                TEXT PRIMARY KEY,
      pipeline_id       TEXT NOT NULL,
      requirement_keys  TEXT NOT NULL DEFAULT '[]',
      task_types        TEXT NOT NULL DEFAULT '[]',
      status            TEXT NOT NULL DEFAULT 'active',
      reason            TEXT NOT NULL,
      approved_by       TEXT,
      details           TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at        TEXT,
      revoked_by        TEXT,
      revoked_reason    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_policy_overrides_pipeline
      ON policy_overrides(pipeline_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_policy_overrides_status
      ON policy_overrides(status, created_at);
  `);
}

function applySchemaVersion6(db) {
  db.exec(`
    UPDATE file_claims
    SET released_at = COALESCE(released_at, datetime('now'))
    WHERE released_at IS NULL
      AND id NOT IN (
        SELECT MIN(id)
        FROM file_claims
        WHERE released_at IS NULL
        GROUP BY file_path
      );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_claims_active_path
      ON file_claims(file_path)
      WHERE released_at IS NULL;
  `);
}

function ensureSchemaMigrated(db) {
  const repoRoot = db.__switchmanRepoRoot;
  if (!repoRoot) {
    throw new Error('Database repo root is not configured.');
  }

  const recordedState = readMigrationState(repoRoot);
  const currentVersion = getSchemaVersion(db);

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Switchman database schema version ${currentVersion} is newer than this CLI supports (${CURRENT_SCHEMA_VERSION}). Upgrade Switchman before opening this repo.`);
  }

  if (recordedState?.status === 'running') {
    throw new Error(`Switchman detected an interrupted database migration from version ${recordedState.from_version} to ${recordedState.to_version}. Resolve the migration state in ${getMigrationStatePath(repoRoot)} before reopening the database.`);
  }

  if (currentVersion === CURRENT_SCHEMA_VERSION) {
    if (recordedState) {
      clearMigrationState(repoRoot);
    }
    return;
  }

  writeMigrationState(repoRoot, {
    status: 'running',
    from_version: currentVersion,
    to_version: CURRENT_SCHEMA_VERSION,
    started_at: new Date().toISOString(),
  });

  try {
    withImmediateTransaction(db, () => {
      if (currentVersion < 1) {
        applySchemaVersion1(db);
      }
      if (currentVersion < 2) {
        applySchemaVersion2(db);
      }
      if (currentVersion < 3) {
        applySchemaVersion3(db);
      }
      if (currentVersion < 4) {
        applySchemaVersion4(db);
      }
      if (currentVersion < 5) {
        applySchemaVersion5(db);
      }
      if (currentVersion < 6) {
        applySchemaVersion6(db);
      }
      setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    });
    clearMigrationState(repoRoot);
  } catch (err) {
    writeMigrationState(repoRoot, {
      status: 'failed',
      from_version: currentVersion,
      to_version: CURRENT_SCHEMA_VERSION,
      failed_at: new Date().toISOString(),
      error: String(err?.message || err),
    });
    throw err;
  }
}

function normalizeScopeRoot(pattern) {
  return String(pattern || '')
    .replace(/\\/g, '/')
    .replace(/\/\*\*$/, '')
    .replace(/\/\*$/, '')
    .replace(/\/+$/, '');
}

function scopeRootsOverlap(leftPattern, rightPattern) {
  const left = normalizeScopeRoot(leftPattern);
  const right = normalizeScopeRoot(rightPattern);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function intersectValues(left = [], right = []) {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => rightSet.has(value));
}

function buildSpecOverlap(sourceSpec = null, affectedSpec = null) {
  const sourceSubsystems = Array.isArray(sourceSpec?.subsystem_tags) ? sourceSpec.subsystem_tags : [];
  const affectedSubsystems = Array.isArray(affectedSpec?.subsystem_tags) ? affectedSpec.subsystem_tags : [];
  const sharedSubsystems = intersectValues(sourceSubsystems, affectedSubsystems);

  const sourceScopes = Array.isArray(sourceSpec?.allowed_paths) ? sourceSpec.allowed_paths : [];
  const affectedScopes = Array.isArray(affectedSpec?.allowed_paths) ? affectedSpec.allowed_paths : [];
  const sharedScopes = [];
  for (const sourceScope of sourceScopes) {
    for (const affectedScope of affectedScopes) {
      if (scopeRootsOverlap(sourceScope, affectedScope)) {
        sharedScopes.push({
          source_scope_pattern: sourceScope,
          affected_scope_pattern: affectedScope,
        });
      }
    }
  }

  return {
    shared_subsystems: sharedSubsystems,
    shared_scopes: sharedScopes,
  };
}

function taskSpecMatchesObject(taskSpec = null, object = null) {
  if (!taskSpec || !object) return false;
  const allowedPaths = Array.isArray(taskSpec.allowed_paths) ? taskSpec.allowed_paths.filter(Boolean) : [];
  if (allowedPaths.length > 0 && matchesPathPatterns(object.file_path, allowedPaths)) {
    return true;
  }

  const subsystemTags = Array.isArray(taskSpec.subsystem_tags) ? taskSpec.subsystem_tags.filter(Boolean) : [];
  return subsystemTags.some((tag) => (object.subsystem_tags || []).includes(tag));
}

function taskSpecMatchesFilePath(taskSpec = null, filePath = null) {
  if (!taskSpec || !filePath) return false;
  const allowedPaths = Array.isArray(taskSpec.allowed_paths) ? taskSpec.allowed_paths.filter(Boolean) : [];
  if (allowedPaths.length > 0 && matchesPathPatterns(filePath, allowedPaths)) {
    return true;
  }

  const subsystemTags = Array.isArray(taskSpec.subsystem_tags) ? taskSpec.subsystem_tags.filter(Boolean) : [];
  const fileSubsystems = classifySubsystemsForPath(filePath);
  return subsystemTags.some((tag) => fileSubsystems.includes(tag));
}

function buildSemanticDependencyOverlap(db, sourceSpec, affectedSpec, changedFiles = []) {
  const repoRoot = db.__switchmanRepoRoot;
  if (!repoRoot || !sourceSpec || !affectedSpec || changedFiles.length === 0) {
    return [];
  }

  const changedObjects = buildSemanticIndexForPath(repoRoot, changedFiles).objects || [];
  const sourceObjects = changedObjects.filter((object) =>
    changedFiles.includes(object.file_path)
    && taskSpecMatchesObject(sourceSpec, object),
  );
  const trackedSourceFiles = listTrackedFiles(repoRoot, { sourceOnly: true });
  const semanticCandidateFiles = [...new Set([...trackedSourceFiles, ...changedFiles])];
  const affectedObjects = buildSemanticIndexForPath(repoRoot, semanticCandidateFiles).objects
    .filter((object) => taskSpecMatchesObject(affectedSpec, object));
  const affectedKeys = new Set(affectedObjects.map((object) => `${object.kind}:${object.name}`));
  const overlaps = sourceObjects
    .filter((object) => affectedKeys.has(`${object.kind}:${object.name}`))
    .map((object) => ({
      overlap_type: ['interface', 'type'].includes(object.kind) ? 'contract' : 'exported_object',
      kind: object.kind,
      name: object.name,
      file_path: object.file_path,
      area: object.area || null,
    }));

  const sourceChangedFiles = changedFiles.filter((filePath) => taskSpecMatchesFilePath(sourceSpec, filePath));
  if (sourceChangedFiles.length === 0) return overlaps;

  const moduleDependencies = buildModuleDependencyIndexForPath(repoRoot, { filePaths: semanticCandidateFiles }).dependencies || [];
  const sharedModuleDependents = moduleDependencies.filter((dependency) =>
    sourceChangedFiles.includes(dependency.imported_path)
    && taskSpecMatchesFilePath(affectedSpec, dependency.file_path)
    && !sourceChangedFiles.includes(dependency.file_path)
  );
  const dependentFiles = [...new Set(sharedModuleDependents.map((item) => item.file_path))];
  const sharedModulePaths = [...new Set(sharedModuleDependents.map((item) => item.imported_path))];

  if (dependentFiles.length > 0) {
    overlaps.push({
      overlap_type: 'shared_module',
      kind: 'module',
      name: sharedModulePaths[0],
      file_path: sharedModulePaths[0],
      area: sharedModuleDependents[0]?.area || null,
      dependent_files: dependentFiles,
      module_paths: sharedModulePaths,
      subsystem_tags: [...new Set(sharedModuleDependents.flatMap((item) => item.subsystem_tags || []))],
      dependent_areas: [...new Set(sharedModuleDependents.map((item) => item.area).filter(Boolean))],
    });
  }

  return overlaps;
}

function buildLeaseScopeReservations(lease, taskSpec) {
  if (!taskSpec) return [];

  const reservations = [];
  const pathPatterns = Array.isArray(taskSpec.allowed_paths) ? [...new Set(taskSpec.allowed_paths)] : [];
  const subsystemTags = Array.isArray(taskSpec.subsystem_tags) ? [...new Set(taskSpec.subsystem_tags)] : [];

  for (const scopePattern of pathPatterns) {
    reservations.push({
      leaseId: lease.id,
      taskId: lease.task_id,
      worktree: lease.worktree,
      ownershipLevel: 'path_scope',
      scopePattern,
      subsystemTag: null,
    });
  }

  for (const subsystemTag of subsystemTags) {
    reservations.push({
      leaseId: lease.id,
      taskId: lease.task_id,
      worktree: lease.worktree,
      ownershipLevel: 'subsystem',
      scopePattern: null,
      subsystemTag,
    });
  }

  return reservations;
}

function getActiveScopeReservationsTx(db, { leaseId = null, worktree = null } = {}) {
  if (leaseId) {
    return db.prepare(`
      SELECT *
      FROM scope_reservations
      WHERE lease_id=? AND released_at IS NULL
      ORDER BY id ASC
    `).all(leaseId);
  }

  if (worktree) {
    return db.prepare(`
      SELECT *
      FROM scope_reservations
      WHERE worktree=? AND released_at IS NULL
      ORDER BY id ASC
    `).all(worktree);
  }

  return db.prepare(`
    SELECT *
    FROM scope_reservations
    WHERE released_at IS NULL
    ORDER BY id ASC
  `).all();
}

function findScopeReservationConflicts(reservations, activeReservations) {
  const conflicts = [];

  for (const reservation of reservations) {
    for (const activeReservation of activeReservations) {
      if (activeReservation.lease_id === reservation.leaseId) continue;

      if (
        reservation.ownershipLevel === 'subsystem' &&
        activeReservation.ownership_level === 'subsystem' &&
        reservation.subsystemTag &&
        reservation.subsystemTag === activeReservation.subsystem_tag
      ) {
        conflicts.push({
          type: 'subsystem',
          subsystem_tag: reservation.subsystemTag,
          lease_id: activeReservation.lease_id,
          worktree: activeReservation.worktree,
        });
        continue;
      }

      if (
        reservation.ownershipLevel === 'path_scope' &&
        activeReservation.ownership_level === 'path_scope' &&
        scopeRootsOverlap(reservation.scopePattern, activeReservation.scope_pattern)
      ) {
        conflicts.push({
          type: 'path_scope',
          scope_pattern: reservation.scopePattern,
          conflicting_scope_pattern: activeReservation.scope_pattern,
          lease_id: activeReservation.lease_id,
          worktree: activeReservation.worktree,
        });
      }
    }
  }

  return conflicts;
}

function reserveLeaseScopesTx(db, lease) {
  const existing = getActiveScopeReservationsTx(db, { leaseId: lease.id });
  if (existing.length > 0) {
    return existing;
  }

  const taskSpec = getTaskSpec(db, lease.task_id);
  const reservations = buildLeaseScopeReservations(lease, taskSpec);
  if (!reservations.length) {
    return [];
  }

  const activeReservations = getActiveScopeReservationsTx(db).filter((reservation) => reservation.lease_id !== lease.id);
  const conflicts = findScopeReservationConflicts(reservations, activeReservations);
  if (conflicts.length > 0) {
    const summary = conflicts[0].type === 'subsystem'
      ? `subsystem:${conflicts[0].subsystem_tag}`
      : `${conflicts[0].scope_pattern} overlaps ${conflicts[0].conflicting_scope_pattern}`;
    logAuditEventTx(db, {
      eventType: 'scope_reservation_denied',
      status: 'denied',
      reasonCode: 'scope_reserved_by_other_lease',
      worktree: lease.worktree,
      taskId: lease.task_id,
      leaseId: lease.id,
      details: JSON.stringify({ conflicts, summary }),
    });
    throw new Error(`Scope reservation conflict: ${summary}`);
  }

  const insert = db.prepare(`
    INSERT INTO scope_reservations (lease_id, task_id, worktree, ownership_level, scope_pattern, subsystem_tag)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const reservation of reservations) {
    insert.run(
      reservation.leaseId,
      reservation.taskId,
      reservation.worktree,
      reservation.ownershipLevel,
      reservation.scopePattern,
      reservation.subsystemTag,
    );
  }

  logAuditEventTx(db, {
    eventType: 'scope_reserved',
    status: 'allowed',
    worktree: lease.worktree,
    taskId: lease.task_id,
    leaseId: lease.id,
    details: JSON.stringify({
      ownership_levels: [...new Set(reservations.map((reservation) => reservation.ownershipLevel))],
      reservations: reservations.map((reservation) => ({
        ownership_level: reservation.ownershipLevel,
        scope_pattern: reservation.scopePattern,
        subsystem_tag: reservation.subsystemTag,
      })),
    }),
  });

  return getActiveScopeReservationsTx(db, { leaseId: lease.id });
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
  const lease = getLeaseTx(db, leaseId);
  if (status === 'active') {
    reserveLeaseScopesTx(db, lease);
  }
  touchWorktreeLeaseState(db, worktree, agent, status === 'active' ? 'busy' : 'idle');
  logAuditEventTx(db, {
    eventType: 'lease_started',
    status: 'allowed',
    worktree,
    taskId,
    leaseId,
    details: JSON.stringify({ agent: agent || null }),
  });
  return lease;
}

function logAuditEventTx(db, { eventType, status = 'info', reasonCode = null, worktree = null, taskId = null, leaseId = null, filePath = null, details = null }) {
  const { secret } = getAuditContext(db);
  const previousEvent = db.prepare(`
    SELECT sequence, entry_hash
    FROM audit_log
    WHERE sequence IS NOT NULL
    ORDER BY sequence DESC, id DESC
    LIMIT 1
  `).get();
  const createdAt = new Date().toISOString();
  const sequence = (previousEvent?.sequence || 0) + 1;
  const prevHash = previousEvent?.entry_hash || null;
  const normalizedDetails = details == null ? null : String(details);
  const entryHash = computeAuditEntryHash({
    sequence,
    prevHash,
    eventType,
    status,
    reasonCode,
    worktree,
    taskId,
    leaseId,
    filePath,
    details: normalizedDetails,
    createdAt,
  });
  const signature = signAuditEntry(secret, entryHash);
  db.prepare(`
    INSERT INTO audit_log (
      event_type, status, reason_code, worktree, task_id, lease_id, file_path, details, created_at, sequence, prev_hash, entry_hash, signature
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventType,
    status,
    reasonCode,
    worktree,
    taskId,
    leaseId,
    filePath,
    normalizedDetails,
    createdAt,
    sequence,
    prevHash,
    entryHash,
    signature,
  );
}

function migrateLegacyAuditLog(db) {
  const rows = db.prepare(`
    SELECT *
    FROM audit_log
    WHERE sequence IS NULL OR entry_hash IS NULL OR signature IS NULL
    ORDER BY datetime(created_at) ASC, id ASC
  `).all();

  if (!rows.length) return;

  const { secret } = getAuditContext(db);
  let previous = db.prepare(`
    SELECT sequence, entry_hash
    FROM audit_log
    WHERE sequence IS NOT NULL AND entry_hash IS NOT NULL
    ORDER BY sequence DESC, id DESC
    LIMIT 1
  `).get();

  const update = db.prepare(`
    UPDATE audit_log
    SET created_at=?, sequence=?, prev_hash=?, entry_hash=?, signature=?
    WHERE id=?
  `);

  let nextSequence = previous?.sequence || 0;
  let prevHash = previous?.entry_hash || null;

  for (const row of rows) {
    nextSequence += 1;
    const createdAt = row.created_at || new Date().toISOString();
    const entryHash = computeAuditEntryHash({
      sequence: nextSequence,
      prevHash,
      eventType: row.event_type,
      status: row.status,
      reasonCode: row.reason_code,
      worktree: row.worktree,
      taskId: row.task_id,
      leaseId: row.lease_id,
      filePath: row.file_path,
      details: row.details,
      createdAt,
    });
    const signature = signAuditEntry(secret, entryHash);
    update.run(createdAt, nextSequence, prevHash, entryHash, signature, row.id);
    prevHash = entryHash;
  }
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
    reserveLeaseScopesTx(db, lease);
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

function releaseScopeReservationsForLeaseTx(db, leaseId) {
  db.prepare(`
    UPDATE scope_reservations
    SET released_at=datetime('now')
    WHERE lease_id=? AND released_at IS NULL
  `).run(leaseId);
}

function releaseClaimsForTaskTx(db, taskId) {
  db.prepare(`
    UPDATE file_claims
    SET released_at=datetime('now')
    WHERE task_id=? AND released_at IS NULL
  `).run(taskId);
}

function releaseScopeReservationsForTaskTx(db, taskId) {
  db.prepare(`
    UPDATE scope_reservations
    SET released_at=datetime('now')
    WHERE task_id=? AND released_at IS NULL
  `).run(taskId);
}

function getBoundaryValidationStateTx(db, leaseId) {
  return db.prepare(`
    SELECT *
    FROM boundary_validation_state
    WHERE lease_id=?
  `).get(leaseId);
}

function listActiveDependencyInvalidationsTx(db, { sourceLeaseId = null, affectedTaskId = null, pipelineId = null } = {}) {
  const clauses = ['resolved_at IS NULL'];
  const params = [];
  if (sourceLeaseId) {
    clauses.push('source_lease_id=?');
    params.push(sourceLeaseId);
  }
  if (affectedTaskId) {
    clauses.push('affected_task_id=?');
    params.push(affectedTaskId);
  }
  if (pipelineId) {
    clauses.push('(source_pipeline_id=? OR affected_pipeline_id=?)');
    params.push(pipelineId, pipelineId);
  }

  return db.prepare(`
    SELECT *
    FROM dependency_invalidations
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC
  `).all(...params);
}

function resolveDependencyInvalidationsForAffectedTaskTx(db, affectedTaskId, resolvedBy = null) {
  db.prepare(`
    UPDATE dependency_invalidations
    SET status='revalidated',
        resolved_at=datetime('now'),
        details=CASE
          WHEN details IS NULL OR details='' THEN json_object('resolved_by', ?)
          ELSE json_set(details, '$.resolved_by', ?)
        END
    WHERE affected_task_id=? AND resolved_at IS NULL
  `).run(resolvedBy || null, resolvedBy || null, affectedTaskId);
}

function syncDependencyInvalidationsForLeaseTx(db, leaseId, source = 'write', context = {}) {
  const execution = getLeaseExecutionContext(db, leaseId);
  if (!execution?.task || !execution.task_spec) {
    return [];
  }

  const sourceTask = execution.task;
  const sourceSpec = execution.task_spec;
  const sourcePipelineId = sourceSpec.pipeline_id || null;
  const sourceWorktree = execution.lease.worktree || sourceTask.worktree || null;
  const tasks = listTasks(db);
  const desired = [];

  for (const affectedTask of tasks) {
    if (affectedTask.id === sourceTask.id) continue;
    if (!['in_progress', 'done'].includes(affectedTask.status)) continue;

    const affectedSpec = getTaskSpec(db, affectedTask.id);
    if (!affectedSpec) continue;
    if ((affectedSpec.pipeline_id || null) === sourcePipelineId) continue;

    const overlap = buildSpecOverlap(sourceSpec, affectedSpec);
    const semanticOverlap = buildSemanticDependencyOverlap(db, sourceSpec, affectedSpec, context.changed_files || []);
    if (overlap.shared_subsystems.length === 0 && overlap.shared_scopes.length === 0 && semanticOverlap.length === 0) continue;

    const affectedWorktree = affectedTask.worktree || null;
    for (const subsystemTag of overlap.shared_subsystems) {
      desired.push({
        source_lease_id: leaseId,
        source_task_id: sourceTask.id,
        source_pipeline_id: sourcePipelineId,
        source_worktree: sourceWorktree,
        affected_task_id: affectedTask.id,
        affected_pipeline_id: affectedSpec.pipeline_id || null,
        affected_worktree: affectedWorktree,
        status: 'stale',
        reason_type: 'subsystem_overlap',
        subsystem_tag: subsystemTag,
        source_scope_pattern: null,
        affected_scope_pattern: null,
        details: {
          source,
          source_task_title: sourceTask.title,
          affected_task_title: affectedTask.title,
          source_task_priority: Number(sourceTask.priority || 0),
          affected_task_priority: Number(affectedTask.priority || 0),
        },
      });
    }

    for (const sharedScope of overlap.shared_scopes) {
      desired.push({
        source_lease_id: leaseId,
        source_task_id: sourceTask.id,
        source_pipeline_id: sourcePipelineId,
        source_worktree: sourceWorktree,
        affected_task_id: affectedTask.id,
        affected_pipeline_id: affectedSpec.pipeline_id || null,
        affected_worktree: affectedWorktree,
        status: 'stale',
        reason_type: 'scope_overlap',
        subsystem_tag: null,
        source_scope_pattern: sharedScope.source_scope_pattern,
        affected_scope_pattern: sharedScope.affected_scope_pattern,
        details: {
          source,
          source_task_title: sourceTask.title,
          affected_task_title: affectedTask.title,
          source_task_priority: Number(sourceTask.priority || 0),
          affected_task_priority: Number(affectedTask.priority || 0),
        },
      });
    }

    const semanticContractOverlap = semanticOverlap.filter((item) => item.overlap_type === 'contract');
    const semanticObjectOverlap = semanticOverlap.filter((item) => item.overlap_type === 'exported_object');
    const sharedModuleOverlap = semanticOverlap.filter((item) => item.overlap_type === 'shared_module');

    if (semanticContractOverlap.length > 0) {
      desired.push({
        source_lease_id: leaseId,
        source_task_id: sourceTask.id,
        source_pipeline_id: sourcePipelineId,
        source_worktree: sourceWorktree,
        affected_task_id: affectedTask.id,
        affected_pipeline_id: affectedSpec.pipeline_id || null,
        affected_worktree: affectedWorktree,
        status: 'stale',
        reason_type: 'semantic_contract_drift',
        subsystem_tag: null,
        source_scope_pattern: null,
        affected_scope_pattern: null,
        details: {
          source,
          source_task_title: sourceTask.title,
          affected_task_title: affectedTask.title,
          source_task_priority: Number(sourceTask.priority || 0),
          affected_task_priority: Number(affectedTask.priority || 0),
          contract_names: [...new Set(semanticContractOverlap.map((item) => item.name))],
          contract_kinds: [...new Set(semanticContractOverlap.map((item) => item.kind))],
          contract_files: [...new Set(semanticContractOverlap.map((item) => item.file_path))],
          revalidation_set: 'contract',
          severity: 'blocked',
        },
      });
    }

    if (semanticObjectOverlap.length > 0) {
      desired.push({
        source_lease_id: leaseId,
        source_task_id: sourceTask.id,
        source_pipeline_id: sourcePipelineId,
        source_worktree: sourceWorktree,
        affected_task_id: affectedTask.id,
        affected_pipeline_id: affectedSpec.pipeline_id || null,
        affected_worktree: affectedWorktree,
        status: 'stale',
        reason_type: 'semantic_object_overlap',
        subsystem_tag: null,
        source_scope_pattern: null,
        affected_scope_pattern: null,
        details: {
          source,
          source_task_title: sourceTask.title,
          affected_task_title: affectedTask.title,
          source_task_priority: Number(sourceTask.priority || 0),
          affected_task_priority: Number(affectedTask.priority || 0),
          object_names: [...new Set(semanticObjectOverlap.map((item) => item.name))],
          object_kinds: [...new Set(semanticObjectOverlap.map((item) => item.kind))],
          object_files: [...new Set(semanticObjectOverlap.map((item) => item.file_path))],
          revalidation_set: 'semantic_object',
          severity: 'warn',
        },
      });
    }

    if (sharedModuleOverlap.length > 0) {
      desired.push({
        source_lease_id: leaseId,
        source_task_id: sourceTask.id,
        source_pipeline_id: sourcePipelineId,
        source_worktree: sourceWorktree,
        affected_task_id: affectedTask.id,
        affected_pipeline_id: affectedSpec.pipeline_id || null,
        affected_worktree: affectedWorktree,
        status: 'stale',
        reason_type: 'shared_module_drift',
        subsystem_tag: null,
        source_scope_pattern: null,
        affected_scope_pattern: null,
        details: {
          source,
          source_task_title: sourceTask.title,
          affected_task_title: affectedTask.title,
          source_task_priority: Number(sourceTask.priority || 0),
          affected_task_priority: Number(affectedTask.priority || 0),
          module_paths: [...new Set(sharedModuleOverlap.flatMap((item) => item.module_paths || [item.file_path]).filter(Boolean))],
          dependent_files: [...new Set(sharedModuleOverlap.flatMap((item) => item.dependent_files || []))],
          dependent_areas: [...new Set(sharedModuleOverlap.flatMap((item) => item.dependent_areas || []).filter(Boolean))],
          dependent_subsystems: [...new Set(sharedModuleOverlap.flatMap((item) => item.subsystem_tags || []).filter(Boolean))],
          revalidation_set: 'shared_module',
          severity: 'warn',
        },
      });
    }
  }

  const desiredKeys = new Set(desired.map((item) => JSON.stringify([
    item.affected_task_id,
    item.reason_type,
    item.subsystem_tag || '',
    item.source_scope_pattern || '',
    item.affected_scope_pattern || '',
  ])));
  const existing = listActiveDependencyInvalidationsTx(db, { sourceLeaseId: leaseId });

  for (const existingRow of existing) {
    const existingKey = JSON.stringify([
      existingRow.affected_task_id,
      existingRow.reason_type,
      existingRow.subsystem_tag || '',
      existingRow.source_scope_pattern || '',
      existingRow.affected_scope_pattern || '',
    ]);
    if (!desiredKeys.has(existingKey)) {
      db.prepare(`
        UPDATE dependency_invalidations
        SET status='revalidated',
            resolved_at=datetime('now'),
            details=CASE
              WHEN details IS NULL OR details='' THEN json_object('resolved_by', ?)
              ELSE json_set(details, '$.resolved_by', ?)
            END
        WHERE id=?
      `).run(source, source, existingRow.id);
    }
  }

  for (const item of desired) {
    const existingRow = existing.find((row) =>
      row.affected_task_id === item.affected_task_id
      && row.reason_type === item.reason_type
      && (row.subsystem_tag || null) === (item.subsystem_tag || null)
      && (row.source_scope_pattern || null) === (item.source_scope_pattern || null)
      && (row.affected_scope_pattern || null) === (item.affected_scope_pattern || null)
      && row.resolved_at === null
    );

    if (existingRow) {
      db.prepare(`
        UPDATE dependency_invalidations
        SET source_task_id=?,
            source_pipeline_id=?,
            source_worktree=?,
            affected_pipeline_id=?,
            affected_worktree=?,
            status='stale',
            details=?,
            resolved_at=NULL
        WHERE id=?
      `).run(
        item.source_task_id,
        item.source_pipeline_id,
        item.source_worktree,
        item.affected_pipeline_id,
        item.affected_worktree,
        JSON.stringify(item.details || {}),
        existingRow.id,
      );
      continue;
    }

    db.prepare(`
      INSERT INTO dependency_invalidations (
        source_lease_id, source_task_id, source_pipeline_id, source_worktree,
        affected_task_id, affected_pipeline_id, affected_worktree,
        status, reason_type, subsystem_tag, source_scope_pattern, affected_scope_pattern, details
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.source_lease_id,
      item.source_task_id,
      item.source_pipeline_id,
      item.source_worktree,
      item.affected_task_id,
      item.affected_pipeline_id,
      item.affected_worktree,
      item.status,
      item.reason_type,
      item.subsystem_tag,
      item.source_scope_pattern,
      item.affected_scope_pattern,
      JSON.stringify(item.details || {}),
    );
  }

  return listActiveDependencyInvalidationsTx(db, { sourceLeaseId: leaseId }).map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : {},
  }));
}

function upsertBoundaryValidationStateTx(db, state) {
  db.prepare(`
    INSERT INTO boundary_validation_state (
      lease_id, task_id, pipeline_id, status, missing_task_types, touched_at, last_evaluated_at, details
    )
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(lease_id) DO UPDATE SET
      status=excluded.status,
      missing_task_types=excluded.missing_task_types,
      touched_at=COALESCE(boundary_validation_state.touched_at, excluded.touched_at),
      last_evaluated_at=datetime('now'),
      details=excluded.details
  `).run(
    state.lease_id,
    state.task_id,
    state.pipeline_id || null,
    state.status,
    JSON.stringify(state.missing_task_types || []),
    state.touched_at || null,
    JSON.stringify(state.details || {}),
  );
}

function computeBoundaryValidationStateTx(db, leaseId, { touched = false, source = null } = {}) {
  const execution = getLeaseExecutionContext(db, leaseId);
  if (!execution?.task || !execution.task_spec?.validation_rules) {
    return null;
  }

  const validationRules = execution.task_spec.validation_rules;
  const requiredTaskTypes = validationRules.required_completed_task_types || [];
  if (requiredTaskTypes.length === 0) {
    return null;
  }

  const pipelineId = execution.task_spec.pipeline_id || null;
  const existing = getBoundaryValidationStateTx(db, leaseId);
  const touchedAt = existing?.touched_at || (touched ? new Date().toISOString() : null);
  if (!touchedAt) {
    return null;
  }

  const pipelineTasks = pipelineId
    ? listTasks(db).filter((task) => getTaskSpec(db, task.id)?.pipeline_id === pipelineId)
    : [];
  const completedTaskTypes = new Set(
    pipelineTasks
      .filter((task) => task.status === 'done')
      .map((task) => getTaskSpec(db, task.id)?.task_type)
      .filter(Boolean),
  );
  const missingTaskTypes = requiredTaskTypes.filter((taskType) => !completedTaskTypes.has(taskType));
  const status = missingTaskTypes.length === 0
    ? 'satisfied'
    : (validationRules.enforcement === 'blocked' ? 'blocked' : 'pending_validation');

  return {
    lease_id: leaseId,
    task_id: execution.task.id,
    pipeline_id: pipelineId,
    status,
    missing_task_types: missingTaskTypes,
    touched_at: touchedAt,
    details: {
      source,
      enforcement: validationRules.enforcement,
      required_completed_task_types: requiredTaskTypes,
      rationale: validationRules.rationale || [],
      subsystem_tags: execution.task_spec.subsystem_tags || [],
    },
  };
}

function syncPipelineBoundaryValidationStatesTx(db, pipelineId, { source = null } = {}) {
  if (!pipelineId) return [];
  const states = db.prepare(`
    SELECT *
    FROM boundary_validation_state
    WHERE pipeline_id=?
  `).all(pipelineId);

  const updated = [];
  for (const state of states) {
    const recomputed = computeBoundaryValidationStateTx(db, state.lease_id, { touched: false, source });
    if (!recomputed) continue;
    upsertBoundaryValidationStateTx(db, recomputed);
    updated.push(recomputed);
  }
  return updated;
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
    releaseScopeReservationsForLeaseTx(db, lease.id);
  }

  return activeLeases;
}

function finalizeTaskWithLeaseTx(db, taskId, activeLease, { taskStatus, leaseStatus, failureReason = null, auditStatus, auditEventType, auditReasonCode = null }) {
  const taskSpec = getTaskSpec(db, taskId);
  if (taskStatus === 'done') {
    db.prepare(`
      UPDATE tasks
      SET status='done', completed_at=datetime('now'), updated_at=datetime('now')
      WHERE id=?
    `).run(taskId);
  } else if (taskStatus === 'failed') {
    db.prepare(`
      UPDATE tasks
      SET status='failed', description=COALESCE(description,'') || '\nFAILED: ' || ?, updated_at=datetime('now')
      WHERE id=?
    `).run(failureReason || 'unknown', taskId);
  }

  if (activeLease) {
    db.prepare(`
      UPDATE leases
      SET status=?,
          finished_at=datetime('now'),
          failure_reason=?
      WHERE id=? AND status='active'
    `).run(leaseStatus, failureReason, activeLease.id);
    touchWorktreeLeaseState(db, activeLease.worktree, activeLease.agent, 'idle');
    releaseClaimsForLeaseTx(db, activeLease.id);
    releaseScopeReservationsForLeaseTx(db, activeLease.id);
  } else {
    releaseClaimsForTaskTx(db, taskId);
    releaseScopeReservationsForTaskTx(db, taskId);
  }

  closeActiveLeasesForTaskTx(db, taskId, leaseStatus, failureReason);

  logAuditEventTx(db, {
    eventType: auditEventType,
    status: auditStatus,
    reasonCode: auditReasonCode,
    worktree: activeLease?.worktree ?? null,
    taskId,
    leaseId: activeLease?.id ?? null,
    details: failureReason || null,
  });

  if (activeLease?.id && taskStatus === 'done') {
    const touchedState = computeBoundaryValidationStateTx(db, activeLease.id, { touched: true, source: auditEventType });
    if (touchedState) {
      upsertBoundaryValidationStateTx(db, touchedState);
    }
  }

  syncPipelineBoundaryValidationStatesTx(db, taskSpec?.pipeline_id || null, { source: auditEventType });
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
  db.__switchmanRepoRoot = repoRoot;
  db.__switchmanAuditSecret = getAuditSecret(repoRoot);
  configureDb(db, { initialize: true });
  withBusyRetry(() => ensureSchemaMigrated(db));
  return db;
}

export function openDb(repoRoot) {
  const dbPath = getDbPath(repoRoot);
  if (!existsSync(dbPath)) {
    throw new Error(`No switchman database found. Run 'switchman init' first.`);
  }
  const db = new DatabaseSync(dbPath);
  db.__switchmanRepoRoot = repoRoot;
  db.__switchmanAuditSecret = getAuditSecret(repoRoot);
  configureDb(db);
  withBusyRetry(() => ensureSchemaMigrated(db));
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
  return withImmediateTransaction(db, () => {
    const task = getTaskTx(db, taskId);
    if (!task) {
      throw new Error(`Task ${taskId} does not exist.`);
    }
    if (task.status === 'done') {
      return {
        ok: false,
        status: 'already_done',
        task: getTaskTx(db, taskId),
      };
    }
    const activeLease = getActiveLeaseForTaskTx(db, taskId);
    finalizeTaskWithLeaseTx(db, taskId, activeLease, {
      taskStatus: 'done',
      leaseStatus: 'completed',
      auditStatus: 'allowed',
      auditEventType: 'task_completed',
    });
    return {
      ok: true,
      status: 'completed',
      task: getTaskTx(db, taskId),
    };
  });
}

export function failTask(db, taskId, reason) {
  withImmediateTransaction(db, () => {
    const activeLease = getActiveLeaseForTaskTx(db, taskId);
    finalizeTaskWithLeaseTx(db, taskId, activeLease, {
      taskStatus: 'failed',
      leaseStatus: 'failed',
      failureReason: reason || 'unknown',
      auditStatus: 'denied',
      auditEventType: 'task_failed',
      auditReasonCode: 'task_failed',
    });
  });
}

export function completeLeaseTask(db, leaseId) {
  return withImmediateTransaction(db, () => {
    const activeLease = getLeaseTx(db, leaseId);
    if (!activeLease || activeLease.status !== 'active') {
      return null;
    }
    finalizeTaskWithLeaseTx(db, activeLease.task_id, activeLease, {
      taskStatus: 'done',
      leaseStatus: 'completed',
      auditStatus: 'allowed',
      auditEventType: 'task_completed',
    });
    return getTaskTx(db, activeLease.task_id);
  });
}

export function failLeaseTask(db, leaseId, reason) {
  return withImmediateTransaction(db, () => {
    const activeLease = getLeaseTx(db, leaseId);
    if (!activeLease || activeLease.status !== 'active') {
      return null;
    }
    finalizeTaskWithLeaseTx(db, activeLease.task_id, activeLease, {
      taskStatus: 'failed',
      leaseStatus: 'failed',
      failureReason: reason || 'unknown',
      auditStatus: 'denied',
      auditEventType: 'task_failed',
      auditReasonCode: 'task_failed',
    });
    return getTaskTx(db, activeLease.task_id);
  });
}

export function retryTask(db, taskId, reason = null) {
  return withImmediateTransaction(db, () => {
    const task = getTaskTx(db, taskId);
    if (!task || !['failed', 'done'].includes(task.status)) {
      return null;
    }

    db.prepare(`
      UPDATE tasks
      SET status='pending',
          worktree=NULL,
          agent=NULL,
          completed_at=NULL,
          updated_at=datetime('now')
      WHERE id=? AND status IN ('failed', 'done')
    `).run(taskId);

    logAuditEventTx(db, {
      eventType: 'task_retried',
      status: 'allowed',
      taskId,
      details: reason || null,
    });

    resolveDependencyInvalidationsForAffectedTaskTx(db, taskId, 'task_retried');
    syncPipelineBoundaryValidationStatesTx(db, getTaskSpec(db, taskId)?.pipeline_id || null, { source: 'task_retried' });

    return getTaskTx(db, taskId);
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

export function enqueueMergeItem(db, {
  id = null,
  sourceType,
  sourceRef,
  sourceWorktree = null,
  sourcePipelineId = null,
  targetBranch = 'main',
  maxRetries = 1,
  submittedBy = null,
  eventDetails = null,
} = {}) {
  const itemId = id || makeId('mq');
  db.prepare(`
    INSERT INTO merge_queue (
      id, source_type, source_ref, source_worktree, source_pipeline_id,
      target_branch, status, retry_count, max_retries, submitted_by
    )
    VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)
  `).run(
    itemId,
    sourceType,
    sourceRef,
    sourceWorktree || null,
    sourcePipelineId || null,
    targetBranch || 'main',
    Math.max(0, Number.parseInt(maxRetries, 10) || 0),
    submittedBy || null,
  );

  logMergeQueueEvent(db, itemId, {
    eventType: 'merge_queue_enqueued',
    status: 'queued',
    details: JSON.stringify({
      source_type: sourceType,
      source_ref: sourceRef,
      source_worktree: sourceWorktree || null,
      source_pipeline_id: sourcePipelineId || null,
      target_branch: targetBranch || 'main',
      ...(eventDetails || {}),
    }),
  });

  return getMergeQueueItem(db, itemId);
}

export function listMergeQueue(db, { status = null } = {}) {
  if (status) {
    return db.prepare(`
      SELECT *
      FROM merge_queue
      WHERE status=?
      ORDER BY datetime(created_at) ASC, id ASC
    `).all(status);
  }

  return db.prepare(`
    SELECT *
    FROM merge_queue
    ORDER BY datetime(created_at) ASC, id ASC
  `).all();
}

export function getMergeQueueItem(db, itemId) {
  return db.prepare(`
    SELECT *
    FROM merge_queue
    WHERE id=?
  `).get(itemId);
}

export function listMergeQueueEvents(db, itemId, { limit = 10 } = {}) {
  return db.prepare(`
    SELECT *
    FROM merge_queue_events
    WHERE queue_item_id=?
    ORDER BY id DESC
    LIMIT ?
  `).all(itemId, limit);
}

export function logMergeQueueEvent(db, itemId, {
  eventType,
  status = null,
  details = null,
} = {}) {
  db.prepare(`
    INSERT INTO merge_queue_events (queue_item_id, event_type, status, details)
    VALUES (?, ?, ?, ?)
  `).run(itemId, eventType, status || null, details == null ? null : String(details));
}

export function listOperationJournal(db, {
  scopeType = null,
  scopeId = null,
  status = null,
  limit = 50,
} = {}) {
  const clauses = [];
  const params = [];
  if (scopeType) {
    clauses.push('scope_type=?');
    params.push(scopeType);
  }
  if (scopeId) {
    clauses.push('scope_id=?');
    params.push(scopeId);
  }
  if (status) {
    clauses.push('status=?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM operation_journal
    ${where}
    ORDER BY datetime(started_at) DESC, id DESC
    LIMIT ?
  `).all(...params, limit);
}

export function startOperationJournalEntry(db, {
  id = null,
  scopeType,
  scopeId,
  operationType,
  details = null,
} = {}) {
  const entryId = id || makeId('op');
  db.prepare(`
    INSERT INTO operation_journal (id, scope_type, scope_id, operation_type, status, details)
    VALUES (?, ?, ?, ?, 'running', ?)
  `).run(entryId, scopeType, scopeId, operationType, details == null ? null : String(details));
  return db.prepare(`
    SELECT *
    FROM operation_journal
    WHERE id=?
  `).get(entryId);
}

export function finishOperationJournalEntry(db, entryId, {
  status = 'completed',
  details = null,
} = {}) {
  db.prepare(`
    UPDATE operation_journal
    SET status=?,
        details=COALESCE(?, details),
        updated_at=datetime('now'),
        finished_at=datetime('now')
    WHERE id=?
  `).run(status, details == null ? null : String(details), entryId);
  return db.prepare(`
    SELECT *
    FROM operation_journal
    WHERE id=?
  `).get(entryId);
}

export function listTempResources(db, {
  scopeType = null,
  scopeId = null,
  operationId = null,
  resourceType = null,
  status = null,
  limit = 100,
} = {}) {
  const clauses = [];
  const params = [];
  if (scopeType) {
    clauses.push('scope_type=?');
    params.push(scopeType);
  }
  if (scopeId) {
    clauses.push('scope_id=?');
    params.push(scopeId);
  }
  if (operationId) {
    clauses.push('operation_id=?');
    params.push(operationId);
  }
  if (resourceType) {
    clauses.push('resource_type=?');
    params.push(resourceType);
  }
  if (status) {
    clauses.push('status=?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM temp_resources
    ${where}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...params, limit);
}

export function getPolicyOverride(db, overrideId) {
  const entry = db.prepare(`
    SELECT *
    FROM policy_overrides
    WHERE id=?
  `).get(overrideId);
  if (!entry) return null;
  return {
    ...entry,
    requirement_keys: (() => {
      try {
        return JSON.parse(entry.requirement_keys || '[]');
      } catch {
        return [];
      }
    })(),
    task_types: (() => {
      try {
        return JSON.parse(entry.task_types || '[]');
      } catch {
        return [];
      }
    })(),
    details: (() => {
      try {
        return entry.details ? JSON.parse(entry.details) : null;
      } catch {
        return null;
      }
    })(),
  };
}

export function listPolicyOverrides(db, {
  pipelineId = null,
  status = null,
  limit = 100,
} = {}) {
  const clauses = [];
  const params = [];
  if (pipelineId) {
    clauses.push('pipeline_id=?');
    params.push(pipelineId);
  }
  if (status) {
    clauses.push('status=?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM policy_overrides
    ${where}
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(...params, limit).map((entry) => ({
    ...entry,
    requirement_keys: (() => {
      try {
        return JSON.parse(entry.requirement_keys || '[]');
      } catch {
        return [];
      }
    })(),
    task_types: (() => {
      try {
        return JSON.parse(entry.task_types || '[]');
      } catch {
        return [];
      }
    })(),
    details: (() => {
      try {
        return entry.details ? JSON.parse(entry.details) : null;
      } catch {
        return null;
      }
    })(),
  }));
}

export function createPolicyOverride(db, {
  pipelineId,
  requirementKeys = [],
  taskTypes = [],
  reason,
  approvedBy = null,
  details = null,
} = {}) {
  if (!pipelineId) throw new Error('pipelineId is required for a policy override.');
  if (!reason || !String(reason).trim()) throw new Error('A policy override reason is required.');

  const overrideId = makeId('po');
  const normalizedRequirementKeys = [...new Set((requirementKeys || []).map((value) => String(value || '').trim()).filter(Boolean))];
  const normalizedTaskTypes = [...new Set((taskTypes || []).map((value) => String(value || '').trim()).filter(Boolean))];

  return withImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO policy_overrides (
        id, pipeline_id, requirement_keys, task_types, status, reason, approved_by, details
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      overrideId,
      pipelineId,
      JSON.stringify(normalizedRequirementKeys),
      JSON.stringify(normalizedTaskTypes),
      String(reason).trim(),
      approvedBy || null,
      details == null ? null : JSON.stringify(details),
    );
    logAuditEventTx(db, {
      eventType: 'policy_override_created',
      status: 'warn',
      reasonCode: 'policy_override',
      details: JSON.stringify({
        override_id: overrideId,
        pipeline_id: pipelineId,
        requirement_keys: normalizedRequirementKeys,
        task_types: normalizedTaskTypes,
        reason: String(reason).trim(),
        approved_by: approvedBy || null,
        details: details || null,
      }),
    });
    return getPolicyOverride(db, overrideId);
  });
}

export function revokePolicyOverride(db, overrideId, {
  revokedBy = null,
  reason = null,
} = {}) {
  return withImmediateTransaction(db, () => {
    const existing = getPolicyOverride(db, overrideId);
    if (!existing) {
      throw new Error(`Policy override ${overrideId} does not exist.`);
    }
    if (existing.status !== 'active') {
      return existing;
    }
    db.prepare(`
      UPDATE policy_overrides
      SET status='revoked',
          revoked_at=datetime('now'),
          revoked_by=?,
          revoked_reason=?
      WHERE id=?
    `).run(revokedBy || null, reason || null, overrideId);
    logAuditEventTx(db, {
      eventType: 'policy_override_revoked',
      status: 'info',
      reasonCode: 'policy_override_revoked',
      details: JSON.stringify({
        override_id: overrideId,
        pipeline_id: existing.pipeline_id,
        revoked_by: revokedBy || null,
        revoked_reason: reason || null,
      }),
    });
    return getPolicyOverride(db, overrideId);
  });
}

export function createTempResource(db, {
  id = null,
  scopeType,
  scopeId,
  operationId = null,
  resourceType,
  path,
  branch = null,
  details = null,
  status = 'active',
} = {}) {
  const resourceId = id || makeId('res');
  db.prepare(`
    INSERT INTO temp_resources (
      id, scope_type, scope_id, operation_id, resource_type, path, branch, status, details
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resourceId,
    scopeType,
    scopeId,
    operationId || null,
    resourceType,
    path,
    branch || null,
    status,
    details == null ? null : String(details),
  );
  return db.prepare(`
    SELECT *
    FROM temp_resources
    WHERE id=?
  `).get(resourceId);
}

export function updateTempResource(db, resourceId, {
  status = null,
  path = null,
  branch = null,
  details = null,
} = {}) {
  db.prepare(`
    UPDATE temp_resources
    SET status=COALESCE(?, status),
        path=COALESCE(?, path),
        branch=COALESCE(?, branch),
        details=COALESCE(?, details),
        updated_at=datetime('now'),
        released_at=CASE
          WHEN COALESCE(?, status) = 'active' THEN NULL
          ELSE COALESCE(released_at, datetime('now'))
        END
    WHERE id=?
  `).run(
    status,
    path,
    branch,
    details == null ? null : String(details),
    status,
    resourceId,
  );
  return db.prepare(`
    SELECT *
    FROM temp_resources
    WHERE id=?
  `).get(resourceId);
}

export function startMergeQueueItem(db, itemId) {
  return withImmediateTransaction(db, () => {
    const item = getMergeQueueItem(db, itemId);
    if (!item || !['queued', 'retrying', 'held', 'wave_blocked', 'escalated'].includes(item.status)) {
      return null;
    }

    db.prepare(`
      UPDATE merge_queue
      SET status='validating',
          started_at=COALESCE(started_at, datetime('now')),
          last_attempt_at=datetime('now'),
          updated_at=datetime('now')
      WHERE id=? AND status IN ('queued', 'retrying', 'held', 'wave_blocked', 'escalated')
    `).run(itemId);

    logMergeQueueEvent(db, itemId, {
      eventType: 'merge_queue_started',
      status: 'validating',
    });

    return getMergeQueueItem(db, itemId);
  });
}

export function markMergeQueueState(db, itemId, {
  status,
  lastErrorCode = null,
  lastErrorSummary = null,
  nextAction = null,
  mergedCommit = null,
  incrementRetry = false,
  backoffUntil = undefined,
} = {}) {
  const terminal = ['merged', 'blocked', 'failed', 'canceled'].includes(status);
  db.prepare(`
    UPDATE merge_queue
    SET status=?,
        last_error_code=?,
        last_error_summary=?,
        next_action=?,
        merged_commit=COALESCE(?, merged_commit),
        retry_count=retry_count + ?,
        backoff_until=CASE
          WHEN ? THEN ?
          WHEN ? = 'retrying' THEN backoff_until
          ELSE NULL
        END,
        escalated_at=CASE
          WHEN ? = 'escalated' THEN COALESCE(escalated_at, datetime('now'))
          ELSE NULL
        END,
        updated_at=datetime('now'),
        finished_at=CASE WHEN ? THEN datetime('now') ELSE finished_at END
    WHERE id=?
  `).run(
    status,
    lastErrorCode || null,
    lastErrorSummary || null,
    nextAction || null,
    mergedCommit || null,
    incrementRetry ? 1 : 0,
    backoffUntil !== undefined ? 1 : 0,
    backoffUntil || null,
    status,
    status,
    terminal ? 1 : 0,
    itemId,
  );

  logMergeQueueEvent(db, itemId, {
    eventType: 'merge_queue_state_changed',
    status,
    details: JSON.stringify({
      last_error_code: lastErrorCode || null,
      last_error_summary: lastErrorSummary || null,
      next_action: nextAction || null,
      merged_commit: mergedCommit || null,
      increment_retry: incrementRetry,
    }),
  });

  return getMergeQueueItem(db, itemId);
}

export function retryMergeQueueItem(db, itemId) {
  const item = getMergeQueueItem(db, itemId);
  if (!item || !['blocked', 'failed', 'held', 'wave_blocked', 'escalated', 'retrying'].includes(item.status)) {
    return null;
  }

  db.prepare(`
    UPDATE merge_queue
    SET status='retrying',
        last_error_code=NULL,
        last_error_summary=NULL,
        next_action=NULL,
        backoff_until=NULL,
        escalated_at=NULL,
        finished_at=NULL,
        updated_at=datetime('now')
    WHERE id=?
  `).run(itemId);

  logMergeQueueEvent(db, itemId, {
    eventType: 'merge_queue_retried',
    status: 'retrying',
  });

  return getMergeQueueItem(db, itemId);
}

export function escalateMergeQueueItem(db, itemId, {
  summary = null,
  nextAction = null,
} = {}) {
  const item = getMergeQueueItem(db, itemId);
  if (!item || ['merged', 'canceled'].includes(item.status)) {
    return null;
  }

  const desiredSummary = summary || item.last_error_summary || 'Operator escalation requested before this queue item lands.';
  const desiredNextAction = nextAction || item.next_action || `Run \`switchman explain queue ${itemId}\` to review the risk, then \`switchman queue retry ${itemId}\` when you are ready to land it again.`;

  if (
    item.status === 'escalated'
    && (item.last_error_summary || null) === desiredSummary
    && (item.next_action || null) === desiredNextAction
  ) {
    return item;
  }

  return markMergeQueueState(db, itemId, {
    status: 'escalated',
    lastErrorCode: 'queue_escalated_manual',
    lastErrorSummary: desiredSummary,
    nextAction: desiredNextAction,
    backoffUntil: null,
  });
}

export function removeMergeQueueItem(db, itemId) {
  const item = getMergeQueueItem(db, itemId);
  if (!item) return null;
  db.prepare(`DELETE FROM merge_queue WHERE id=?`).run(itemId);
  return item;
}

export function upsertTaskSpec(db, taskId, spec) {
  db.prepare(`
    INSERT INTO task_specs (task_id, spec_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(task_id) DO UPDATE SET
      spec_json=excluded.spec_json,
      updated_at=datetime('now')
  `).run(taskId, JSON.stringify(spec || {}));

  const activeLease = getActiveLeaseForTaskTx(db, taskId);
  if (activeLease) {
    withImmediateTransaction(db, () => {
      releaseScopeReservationsForLeaseTx(db, activeLease.id);
      reserveLeaseScopesTx(db, activeLease);
      const updatedState = computeBoundaryValidationStateTx(db, activeLease.id, { touched: false, source: 'task_spec_updated' });
      if (updatedState) {
        upsertBoundaryValidationStateTx(db, updatedState);
      }
      syncPipelineBoundaryValidationStatesTx(db, spec?.pipeline_id || null, { source: 'task_spec_updated' });
    });
  }
}

export function getTaskSpec(db, taskId) {
  const row = db.prepare(`SELECT spec_json FROM task_specs WHERE task_id=?`).get(taskId);
  if (!row) return null;
  try {
    return JSON.parse(row.spec_json);
  } catch {
    return null;
  }
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

export function listScopeReservations(db, { activeOnly = true, leaseId = null, taskId = null, worktree = null } = {}) {
  const clauses = [];
  const params = [];

  if (activeOnly) {
    clauses.push('released_at IS NULL');
  }
  if (leaseId) {
    clauses.push('lease_id=?');
    params.push(leaseId);
  }
  if (taskId) {
    clauses.push('task_id=?');
    params.push(taskId);
  }
  if (worktree) {
    clauses.push('worktree=?');
    params.push(worktree);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM scope_reservations
    ${where}
    ORDER BY id ASC
  `).all(...params);
}

export function getBoundaryValidationState(db, leaseId) {
  const row = getBoundaryValidationStateTx(db, leaseId);
  if (!row) return null;
  return {
    ...row,
    missing_task_types: JSON.parse(row.missing_task_types || '[]'),
    details: row.details ? JSON.parse(row.details) : {},
  };
}

export function listBoundaryValidationStates(db, { status = null, pipelineId = null } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status=?');
    params.push(status);
  }
  if (pipelineId) {
    clauses.push('pipeline_id=?');
    params.push(pipelineId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM boundary_validation_state
    ${where}
    ORDER BY last_evaluated_at DESC, lease_id ASC
  `).all(...params).map((row) => ({
    ...row,
    missing_task_types: JSON.parse(row.missing_task_types || '[]'),
    details: row.details ? JSON.parse(row.details) : {},
  }));
}

export function listDependencyInvalidations(db, { status = 'stale', pipelineId = null, affectedTaskId = null } = {}) {
  const clauses = [];
  const params = [];
  if (status === 'stale') {
    clauses.push('resolved_at IS NULL');
  } else if (status === 'revalidated') {
    clauses.push('resolved_at IS NOT NULL');
  }
  if (pipelineId) {
    clauses.push('(source_pipeline_id=? OR affected_pipeline_id=?)');
    params.push(pipelineId, pipelineId);
  }
  if (affectedTaskId) {
    clauses.push('affected_task_id=?');
    params.push(affectedTaskId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT *
    FROM dependency_invalidations
    ${where}
    ORDER BY created_at DESC, id DESC
  `).all(...params).map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : {},
  }));
}

export function touchBoundaryValidationState(db, leaseId, source = 'write', context = {}) {
  return withImmediateTransaction(db, () => {
    const state = computeBoundaryValidationStateTx(db, leaseId, { touched: true, source });
    if (state) {
      upsertBoundaryValidationStateTx(db, state);
      logAuditEventTx(db, {
        eventType: 'boundary_validation_state',
        status: state.status === 'satisfied' ? 'allowed' : (state.status === 'blocked' ? 'denied' : 'warn'),
        reasonCode: state.status === 'satisfied' ? null : 'boundary_validation_pending',
        taskId: state.task_id,
        leaseId: state.lease_id,
        details: JSON.stringify({
          status: state.status,
          missing_task_types: state.missing_task_types,
          source,
        }),
      });
    }

    const invalidations = syncDependencyInvalidationsForLeaseTx(db, leaseId, source, context);
    if (invalidations.length > 0) {
      logAuditEventTx(db, {
        eventType: 'dependency_invalidations_updated',
        status: 'warn',
        reasonCode: 'dependent_work_stale',
        taskId: state?.task_id || getLeaseTx(db, leaseId)?.task_id || null,
        leaseId,
        details: JSON.stringify({
          source,
          stale_count: invalidations.length,
          affected_task_ids: [...new Set(invalidations.map((item) => item.affected_task_id))],
          reason_types: [...new Set(invalidations.map((item) => item.reason_type))],
          revalidation_sets: [...new Set(invalidations.map((item) => item.details?.revalidation_set).filter(Boolean))],
        }),
      });
    }

    return state ? getBoundaryValidationState(db, leaseId) : null;
  });
}

export function getLease(db, leaseId) {
  return db.prepare(`
    SELECT l.*, t.title AS task_title
    FROM leases l
    JOIN tasks t ON l.task_id = t.id
    WHERE l.id=?
  `).get(leaseId);
}

export function getLeaseExecutionContext(db, leaseId) {
  const lease = getLease(db, leaseId);
  if (!lease) return null;
  const task = getTask(db, lease.task_id);
  const worktree = getWorktree(db, lease.worktree);
  return {
    lease,
    task,
    task_spec: task ? getTaskSpec(db, task.id) : null,
    worktree,
    claims: getActiveFileClaims(db).filter((claim) => claim.lease_id === lease.id),
    scope_reservations: listScopeReservations(db, { leaseId: lease.id }),
  };
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
  logAuditEventTx(db, {
    eventType: 'lease_heartbeated',
    status: 'allowed',
    worktree: lease.worktree,
    taskId: lease.task_id,
    leaseId: lease.id,
    details: JSON.stringify({ agent: agent || lease.agent || null }),
  });
  return lease;
}

export function getStaleLeases(db, staleAfterMinutes = DEFAULT_STALE_LEASE_MINUTES) {
  return db.prepare(`
    SELECT l.*, t.title AS task_title
    FROM leases l
    JOIN tasks t ON l.task_id = t.id
    WHERE l.status='active'
      AND l.heartbeat_at <= datetime('now', ?)
    ORDER BY l.heartbeat_at ASC
  `).all(`-${staleAfterMinutes} minutes`);
}

export function reapStaleLeases(db, staleAfterMinutes = DEFAULT_STALE_LEASE_MINUTES, { requeueTask = true } = {}) {
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

    const failTaskForStaleLease = db.prepare(`
      UPDATE tasks
      SET status='failed',
          description=COALESCE(description,'') || '\nFAILED: lease_expired: stale lease reaped',
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
      releaseScopeReservationsForLeaseTx(db, lease.id);
      if (requeueTask) {
        resetTask.run(lease.task_id, lease.task_id);
      } else {
        failTaskForStaleLease.run(lease.task_id, lease.task_id);
      }
      touchWorktreeLeaseState(db, lease.worktree, lease.agent, 'idle');
      logAuditEventTx(db, {
        eventType: 'lease_expired',
        status: 'denied',
        reasonCode: 'lease_expired',
        worktree: lease.worktree,
        taskId: lease.task_id,
        leaseId: lease.id,
      });
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
    const activeClaims = db.prepare(`
      SELECT *
      FROM file_claims
      WHERE released_at IS NULL
      ORDER BY id ASC
    `).all();
    const activeClaimByPath = new Map();
    for (const claim of activeClaims) {
      const normalizedPath = normalizeClaimedFilePath(claim.file_path);
      if (!activeClaimByPath.has(normalizedPath)) {
        activeClaimByPath.set(normalizedPath, claim);
      }
    }

    const normalizeAndDeduplicate = [...new Set(filePaths.map((filePath) => normalizeClaimedFilePath(filePath)))];
    const findClaimOwner = (normalizedPath) => activeClaimByPath.get(normalizedPath) || null;
    const insert = db.prepare(`
      INSERT INTO file_claims (task_id, lease_id, file_path, worktree, agent)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const normalizedPath of normalizeAndDeduplicate) {
      const existing = findClaimOwner(normalizedPath);
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
            activeClaimByPath.set(normalizedPath, { ...existing, lease_id: lease.id, agent: agent || existing.agent });
          }
          continue;
        }

        throw new Error('One or more files are already actively claimed by another task.');
      }

      try {
        insert.run(taskId, lease.id, normalizedPath, worktree, agent || null);
      } catch (err) {
        const message = String(err?.message || '').toLowerCase();
        const isActiveClaimConstraint =
          message.includes('idx_file_claims_active_path')
          || (message.includes('unique') && message.includes('file_claims'));
        if (isActiveClaimConstraint) {
          throw new Error('One or more files are already actively claimed by another task.');
        }
        throw err;
      }
      activeClaimByPath.set(normalizedPath, {
        task_id: taskId,
        lease_id: lease.id,
        file_path: normalizedPath,
        worktree,
        agent: agent || null,
      });
      logAuditEventTx(db, {
        eventType: 'file_claimed',
        status: 'allowed',
        worktree,
        taskId,
        leaseId: lease.id,
        filePath: normalizedPath,
      });
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
  releaseClaimsForTaskTx(db, taskId);
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

export function getCompletedFileClaims(db, worktree = null) {
  if (worktree) {
    return db.prepare(`
      SELECT fc.*, t.title as task_title, t.status as task_status, t.completed_at
      FROM file_claims fc
      JOIN tasks t ON fc.task_id = t.id
      WHERE fc.worktree=?
        AND t.status='done'
      ORDER BY COALESCE(fc.released_at, t.completed_at) DESC, fc.file_path
    `).all(worktree);
  }

  return db.prepare(`
    SELECT fc.*, t.title as task_title, t.status as task_status, t.completed_at
    FROM file_claims fc
    JOIN tasks t ON fc.task_id = t.id
    WHERE t.status='done'
    ORDER BY COALESCE(fc.released_at, t.completed_at) DESC, fc.file_path
  `).all();
}

export function checkFileConflicts(db, filePaths, excludeWorktree) {
  const normalizedPaths = [...new Set(filePaths.map((filePath) => normalizeClaimedFilePath(filePath)))];
  const conflicts = [];
  const claims = db.prepare(`
    SELECT fc.*, t.title as task_title, l.id as lease_id, l.status as lease_status
    FROM file_claims fc
    JOIN tasks t ON fc.task_id = t.id
    LEFT JOIN leases l ON fc.lease_id = l.id
    WHERE fc.released_at IS NULL
      AND fc.worktree != ?
      AND t.status NOT IN ('done','failed')
  `).all(excludeWorktree || '');
  const claimByNormalizedPath = new Map();
  for (const claim of claims) {
    const normalizedPath = normalizeClaimedFilePath(claim.file_path);
    if (!claimByNormalizedPath.has(normalizedPath)) {
      claimByNormalizedPath.set(normalizedPath, claim);
    }
  }

  for (const fp of normalizedPaths) {
    const existing = claimByNormalizedPath.get(fp);
    if (existing) conflicts.push({ file: fp, claimedBy: existing });
  }
  return conflicts;
}

// ─── Worktrees ────────────────────────────────────────────────────────────────

export function registerWorktree(db, { name, path, branch, agent }) {
  const normalizedPath = normalizeWorktreePath(path);
  const existingByPath = db.prepare(`SELECT name FROM worktrees WHERE path=?`).get(normalizedPath);
  const canonicalName = existingByPath?.name || name;
  db.prepare(`
    INSERT INTO worktrees (name, path, branch, agent)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      path=excluded.path, branch=excluded.branch,
      agent=excluded.agent, last_seen=datetime('now'), status='idle'
  `).run(canonicalName, normalizedPath, branch, agent || null);
}

export function listWorktrees(db) {
  return db.prepare(`SELECT * FROM worktrees ORDER BY registered_at`).all();
}

export function getWorktree(db, name) {
  return db.prepare(`SELECT * FROM worktrees WHERE name=?`).get(name);
}

export function updateWorktreeStatus(db, name, status) {
  db.prepare(`UPDATE worktrees SET status=?, last_seen=datetime('now') WHERE name=?`).run(status, name);
}

export function updateWorktreeCompliance(db, name, complianceState, enforcementMode = null) {
  db.prepare(`
    UPDATE worktrees
    SET compliance_state=?,
        enforcement_mode=COALESCE(?, enforcement_mode),
        last_seen=datetime('now')
    WHERE name=?
  `).run(complianceState, enforcementMode, name);
}

// ─── Conflict Log ─────────────────────────────────────────────────────────────

export function logConflict(db, worktreeA, worktreeB, conflictingFiles) {
  db.prepare(`
    INSERT INTO conflict_log (worktree_a, worktree_b, conflicting_files)
    VALUES (?, ?, ?)
  `).run(worktreeA, worktreeB, JSON.stringify(conflictingFiles));
}

export function logAuditEvent(db, payload) {
  logAuditEventTx(db, payload);
}

export function listAuditEvents(db, { eventType = null, status = null, taskId = null, limit = 50 } = {}) {
  if (eventType && status && taskId) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE event_type=? AND status=? AND task_id=?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(eventType, status, taskId, limit);
  }
  if (eventType && taskId) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE event_type=? AND task_id=?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(eventType, taskId, limit);
  }
  if (status && taskId) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE status=? AND task_id=?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(status, taskId, limit);
  }
  if (eventType && status) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE event_type=? AND status=?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(eventType, status, limit);
  }
  if (eventType) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE event_type=?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(eventType, limit);
  }
  if (status) {
    return db.prepare(`
      SELECT * FROM audit_log
      WHERE status=?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(status, limit);
  }
  return db.prepare(`
    SELECT * FROM audit_log
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit);
}

export function verifyAuditTrail(db) {
  const { secret } = getAuditContext(db);
  const events = db.prepare(`
    SELECT *
    FROM audit_log
    ORDER BY sequence ASC, id ASC
  `).all();

  const failures = [];
  let expectedSequence = 1;
  let expectedPrevHash = null;

  for (const event of events) {
    if (event.sequence == null) {
      failures.push({ id: event.id, reason_code: 'missing_sequence', message: 'Audit event is missing sequence metadata.' });
      continue;
    }
    if (event.sequence !== expectedSequence) {
      failures.push({
        id: event.id,
        sequence: event.sequence,
        reason_code: 'sequence_gap',
        message: `Expected sequence ${expectedSequence} but found ${event.sequence}.`,
      });
      expectedSequence = event.sequence;
    }
    if ((event.prev_hash || null) !== expectedPrevHash) {
      failures.push({
        id: event.id,
        sequence: event.sequence,
        reason_code: 'prev_hash_mismatch',
        message: 'Previous hash does not match the prior audit event.',
      });
    }

    const recomputedHash = computeAuditEntryHash({
      sequence: event.sequence,
      prevHash: event.prev_hash || null,
      eventType: event.event_type,
      status: event.status,
      reasonCode: event.reason_code,
      worktree: event.worktree,
      taskId: event.task_id,
      leaseId: event.lease_id,
      filePath: event.file_path,
      details: event.details,
      createdAt: event.created_at,
    });
    if (event.entry_hash !== recomputedHash) {
      failures.push({
        id: event.id,
        sequence: event.sequence,
        reason_code: 'entry_hash_mismatch',
        message: 'Audit event payload hash does not match the stored entry hash.',
      });
    }

    const expectedSignature = signAuditEntry(secret, recomputedHash);
    if (event.signature !== expectedSignature) {
      failures.push({
        id: event.id,
        sequence: event.sequence,
        reason_code: 'signature_mismatch',
        message: 'Audit event signature does not match the project audit key.',
      });
    }

    expectedPrevHash = event.entry_hash || null;
    expectedSequence += 1;
  }

  return {
    ok: failures.length === 0,
    count: events.length,
    failures,
  };
}

export function getWorktreeSnapshotState(db, worktree) {
  const rows = db.prepare(`
    SELECT * FROM worktree_snapshots
    WHERE worktree=?
    ORDER BY file_path
  `).all(worktree);

  return new Map(rows.map((row) => [row.file_path, row.fingerprint]));
}

export function replaceWorktreeSnapshotState(db, worktree, snapshot) {
  withImmediateTransaction(db, () => {
    db.prepare(`
      DELETE FROM worktree_snapshots
      WHERE worktree=?
    `).run(worktree);

    const insert = db.prepare(`
      INSERT INTO worktree_snapshots (worktree, file_path, fingerprint)
      VALUES (?, ?, ?)
    `);

    for (const [filePath, fingerprint] of snapshot.entries()) {
      insert.run(worktree, filePath, fingerprint);
    }
  });
}

export function getConflictLog(db) {
  return db.prepare(`SELECT * FROM conflict_log ORDER BY detected_at DESC LIMIT 50`).all();
}
