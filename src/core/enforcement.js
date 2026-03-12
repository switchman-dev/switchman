import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join, posix, relative, resolve } from 'path';
import { execFileSync, spawnSync } from 'child_process';

import {
  getActiveFileClaims,
  getCompletedFileClaims,
  getLease,
  getTaskSpec,
  getWorktree,
  getWorktreeSnapshotState,
  replaceWorktreeSnapshotState,
  getStaleLeases,
  listAuditEvents,
  listLeases,
  logAuditEvent,
  updateWorktreeCompliance,
} from './db.js';
import { isIgnoredPath, matchesPathPatterns } from './ignore.js';
import { getCurrentWorktree, getGitCommonDir, getWorktreeChangedFiles } from './git.js';

export const COMPLIANCE_STATES = {
  MANAGED: 'managed',
  OBSERVED: 'observed',
  NON_COMPLIANT: 'non_compliant',
  STALE: 'stale',
};

const DEFAULT_ENFORCEMENT_POLICY = {
  allowed_generated_paths: [],
};

function getEnforcementPolicyPath(repoRoot) {
  return join(repoRoot, '.switchman', 'enforcement.json');
}

export function loadEnforcementPolicy(repoRoot) {
  const policyPath = getEnforcementPolicyPath(repoRoot);
  if (!existsSync(policyPath)) {
    return DEFAULT_ENFORCEMENT_POLICY;
  }

  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
    return {
      ...DEFAULT_ENFORCEMENT_POLICY,
      ...parsed,
      allowed_generated_paths: Array.isArray(parsed.allowed_generated_paths) ? parsed.allowed_generated_paths : [],
    };
  } catch {
    return DEFAULT_ENFORCEMENT_POLICY;
  }
}

export function writeEnforcementPolicy(repoRoot, policy) {
  const policyPath = getEnforcementPolicyPath(repoRoot);
  mkdirSync(dirname(policyPath), { recursive: true });
  const normalized = {
    ...DEFAULT_ENFORCEMENT_POLICY,
    ...policy,
    allowed_generated_paths: Array.isArray(policy?.allowed_generated_paths) ? policy.allowed_generated_paths : [],
  };
  writeFileSync(policyPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return policyPath;
}

function buildSnapshotFingerprint(stats) {
  return `${stats.size}:${Math.floor(stats.mtimeMs)}:${Math.floor(stats.ctimeMs)}`;
}

function buildWorktreeSnapshot(worktreePath, currentPath = worktreePath, snapshot = new Map()) {
  const entries = readdirSync(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(currentPath, entry.name);
    const relativePath = relative(worktreePath, absolutePath).replace(/\\/g, '/');
    if (!relativePath || isIgnoredPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      buildWorktreeSnapshot(worktreePath, absolutePath, snapshot);
      continue;
    }

    if (entry.isSymbolicLink()) {
      try {
        const target = readlinkSync(absolutePath);
        snapshot.set(relativePath, `symlink:${target}`);
      } catch {
        snapshot.set(relativePath, 'symlink:unresolved');
      }
      continue;
    }

    if (!entry.isFile()) continue;

    const stats = statSync(absolutePath);
    snapshot.set(relativePath, buildSnapshotFingerprint(stats));
  }

  return snapshot;
}

function diffSnapshots(previousSnapshot, currentSnapshot) {
  const changes = [];
  const allPaths = new Set([
    ...previousSnapshot.keys(),
    ...currentSnapshot.keys(),
  ]);

  for (const filePath of allPaths) {
    const previous = previousSnapshot.get(filePath);
    const current = currentSnapshot.get(filePath);
    if (previous == null && current != null) {
      changes.push({ file_path: filePath, change_type: 'added' });
    } else if (previous != null && current == null) {
      changes.push({ file_path: filePath, change_type: 'deleted' });
    } else if (previous !== current) {
      changes.push({ file_path: filePath, change_type: 'modified' });
    }
  }

  return changes.sort((a, b) => a.file_path.localeCompare(b.file_path));
}

function getLeaseScopePatterns(db, lease) {
  return getTaskSpec(db, lease.task_id)?.allowed_paths || [];
}

function findScopedLeaseOwner(db, leases, filePath, excludeLeaseId = null) {
  for (const lease of leases) {
    if (excludeLeaseId && lease.id === excludeLeaseId) continue;
    const patterns = getLeaseScopePatterns(db, lease);
    if (patterns.length > 0 && matchesPathPatterns(filePath, patterns)) {
      return lease;
    }
  }
  return null;
}

function normalizeDirectoryScopeRoot(pattern) {
  return String(pattern || '').replace(/\\/g, '/').replace(/\/\*\*$/, '').replace(/\/\*$/, '').replace(/\/+$/, '');
}

function scopeAllowsDirectory(patterns, directoryPath) {
  const normalizedDir = String(directoryPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return patterns.some((pattern) => {
    const scopeRoot = normalizeDirectoryScopeRoot(pattern);
    return scopeRoot === normalizedDir || scopeRoot.startsWith(`${normalizedDir}/`) || normalizedDir.startsWith(`${scopeRoot}/`);
  });
}

function resolveLeasePathOwnership(db, lease, filePath, activeClaims, activeLeases) {
  const ownClaim = activeClaims.find((claim) => claim.file_path === filePath && claim.lease_id === lease.id);
  if (ownClaim) {
    return { ok: true, reason_code: null, claim: ownClaim, ownership_type: 'claim' };
  }

  const foreignClaim = activeClaims.find((claim) => claim.file_path === filePath && claim.lease_id && claim.lease_id !== lease.id);
  if (foreignClaim) {
    return { ok: false, reason_code: 'path_claimed_by_other_lease', claim: foreignClaim, ownership_type: null };
  }

  const ownScopePatterns = getLeaseScopePatterns(db, lease);
  const ownScopeMatch = ownScopePatterns.length > 0 && matchesPathPatterns(filePath, ownScopePatterns);
  if (ownScopeMatch) {
    const foreignScopeOwner = findScopedLeaseOwner(db, activeLeases, filePath, lease.id);
    if (foreignScopeOwner) {
      return { ok: false, reason_code: 'path_scoped_by_other_lease', claim: null, ownership_type: null };
    }
    return { ok: true, reason_code: 'path_within_task_scope', claim: null, ownership_type: 'scope' };
  }

  const foreignScopeOwner = findScopedLeaseOwner(db, activeLeases, filePath, lease.id);
  if (foreignScopeOwner) {
    return { ok: false, reason_code: 'path_scoped_by_other_lease', claim: null, ownership_type: null };
  }

  return { ok: false, reason_code: 'path_not_claimed', claim: null, ownership_type: null };
}

function classifyObservedPath(db, repoRoot, worktree, filePath, options = {}) {
  const activeLeases = options.activeLeases || listLeases(db, 'active');
  const activeClaims = options.activeClaims || getActiveFileClaims(db);
  const staleLeaseIds = options.staleLeaseIds || new Set(getStaleLeases(db).map((lease) => lease.id));
  const policy = options.policy || loadEnforcementPolicy(repoRoot);

  const activeLease = activeLeases.find((lease) => lease.worktree === worktree.name) || null;
  const claim = activeClaims.find((item) => item.file_path === filePath && item.worktree === worktree.name) || null;

  if (!activeLease) {
    return { status: 'denied', reason_code: 'no_active_lease', lease: null, claim };
  }
  if (staleLeaseIds.has(activeLease.id)) {
    return { status: 'denied', reason_code: 'lease_expired', lease: activeLease, claim };
  }
  const ownership = resolveLeasePathOwnership(db, activeLease, filePath, activeClaims, activeLeases);
  if (ownership.ok) {
    return {
      status: 'allowed',
      reason_code: ownership.reason_code,
      lease: activeLease,
      claim: ownership.claim ?? claim,
      ownership_type: ownership.ownership_type,
    };
  }
  if (matchesPathPatterns(filePath, policy.allowed_generated_paths || [])) {
    return { status: 'allowed', reason_code: 'policy_exception_allowed', lease: activeLease, claim: null, ownership_type: 'policy' };
  }
  return { status: 'denied', reason_code: ownership.reason_code, lease: activeLease, claim: ownership.claim ?? claim, ownership_type: null };
}

function normalizeRepoPath(repoRoot, targetPath) {
  const rawPath = String(targetPath || '').replace(/\\/g, '/').trim();
  const relativePath = posix.normalize(rawPath.replace(/^\.\/+/, ''));
  if (
    relativePath === '' ||
    relativePath === '.' ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    rawPath.startsWith('/') ||
    /^[A-Za-z]:\//.test(rawPath)
  ) {
    throw new Error('Target path must point to a file inside the repository.');
  }
  return {
    absolutePath: resolve(repoRoot, relativePath),
    relativePath,
  };
}

export function validateWriteAccess(db, repoRoot, { leaseId, path: targetPath, worktree = null }) {
  let normalized;
  try {
    normalized = normalizeRepoPath(repoRoot, targetPath);
  } catch {
    return {
      ok: false,
      reason_code: 'policy_exception_required',
      file_path: targetPath,
      lease: null,
      claim: null,
    };
  }

  const lease = getLease(db, leaseId);
  if (!lease || lease.status !== 'active') {
    return {
      ok: false,
      reason_code: 'no_active_lease',
      file_path: normalized.relativePath,
      lease: lease || null,
      claim: null,
    };
  }

  const staleLeaseIds = new Set(getStaleLeases(db).map((item) => item.id));
  if (staleLeaseIds.has(lease.id)) {
    return {
      ok: false,
      reason_code: 'lease_expired',
      file_path: normalized.relativePath,
      lease,
      claim: null,
    };
  }

  if (worktree && lease.worktree !== worktree) {
    return {
      ok: false,
      reason_code: 'worktree_mismatch',
      file_path: normalized.relativePath,
      lease,
      claim: null,
    };
  }

  const leaseWorktree = getWorktree(db, lease.worktree);
  if (!leaseWorktree) {
    return {
      ok: false,
      reason_code: 'worktree_mismatch',
      file_path: normalized.relativePath,
      lease,
      claim: null,
    };
  }

  normalized.absolutePath = join(leaseWorktree.path, normalized.relativePath);
  const activeLeases = listLeases(db, 'active');
  const activeClaims = getActiveFileClaims(db).filter((claim) => claim.file_path === normalized.relativePath);
  const ownership = resolveLeasePathOwnership(db, lease, normalized.relativePath, activeClaims, activeLeases);
  if (ownership.ok) {
    return {
      ok: true,
      reason_code: ownership.reason_code,
      file_path: normalized.relativePath,
      absolute_path: normalized.absolutePath,
      lease,
      claim: ownership.claim,
      ownership_type: ownership.ownership_type,
    };
  }

  return {
    ok: false,
    reason_code: ownership.reason_code,
    file_path: normalized.relativePath,
    lease,
    claim: ownership.claim,
  };
}

export function validateLeaseAccess(db, { leaseId, worktree = null }) {
  const lease = getLease(db, leaseId);
  if (!lease || lease.status !== 'active') {
    return {
      ok: false,
      reason_code: 'no_active_lease',
      lease: lease || null,
      worktree: null,
    };
  }

  const staleLeaseIds = new Set(getStaleLeases(db).map((item) => item.id));
  if (staleLeaseIds.has(lease.id)) {
    return {
      ok: false,
      reason_code: 'lease_expired',
      lease,
      worktree: null,
    };
  }

  if (worktree && lease.worktree !== worktree) {
    return {
      ok: false,
      reason_code: 'worktree_mismatch',
      lease,
      worktree: null,
    };
  }

  const leaseWorktree = getWorktree(db, lease.worktree);
  if (!leaseWorktree) {
    return {
      ok: false,
      reason_code: 'worktree_mismatch',
      lease,
      worktree: null,
    };
  }

  return {
    ok: true,
    reason_code: null,
    lease,
    worktree: leaseWorktree,
  };
}

function logWriteEvent(db, status, reasonCode, validation, eventType, details = null) {
  logAuditEvent(db, {
    eventType,
    status,
    reasonCode,
    worktree: validation.lease?.worktree ?? null,
    taskId: validation.lease?.task_id ?? null,
    leaseId: validation.lease?.id ?? null,
    filePath: validation.file_path ?? null,
    details: JSON.stringify({
      ownership_type: validation.ownership_type ?? null,
      ...(details || {}),
    }),
  });
}

function isTrackedByGit(worktreePath, filePath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', filePath], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function restoreTrackedPath(worktreePath, filePath) {
  execFileSync('git', ['checkout', '--', filePath], {
    cwd: worktreePath,
    stdio: 'ignore',
  });
}

function quarantinePath(repoRoot, worktree, filePath, absolutePath) {
  const quarantineRoot = join(repoRoot, '.switchman', 'quarantine', `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, worktree.name);
  const quarantinePath = join(quarantineRoot, filePath);
  mkdirSync(dirname(quarantinePath), { recursive: true });
  renameSync(absolutePath, quarantinePath);
  return quarantinePath;
}

function enforceObservedChange(repoRoot, worktree, change, classification) {
  const absolutePath = join(worktree.path, change.file_path);
  if (!existsSync(absolutePath)) {
    if (change.change_type === 'deleted' && isTrackedByGit(worktree.path, change.file_path)) {
      restoreTrackedPath(worktree.path, change.file_path);
      return { action: 'restored', quarantine_path: null };
    }
    return { action: 'none', quarantine_path: null };
  }

  const quarantinePathValue = quarantinePath(repoRoot, worktree, change.file_path, absolutePath);
  if (change.change_type === 'modified' && isTrackedByGit(worktree.path, change.file_path)) {
    restoreTrackedPath(worktree.path, change.file_path);
    return { action: 'quarantined_and_restored', quarantine_path: quarantinePathValue };
  }
  return { action: 'quarantined', quarantine_path: quarantinePathValue };
}

export function gatewayWriteFile(db, repoRoot, { leaseId, path: targetPath, content, worktree = null }) {
  const validation = validateWriteAccess(db, repoRoot, { leaseId, path: targetPath, worktree });
  if (!validation.ok) {
    logWriteEvent(db, 'denied', validation.reason_code, validation, 'write_denied');
    return {
      ok: false,
      reason_code: validation.reason_code,
      file_path: validation.file_path,
      lease_id: validation.lease?.id ?? leaseId,
    };
  }

  mkdirSync(dirname(validation.absolute_path), { recursive: true });
  writeFileSync(validation.absolute_path, content);
  logWriteEvent(db, 'allowed', null, validation, 'write_allowed', { operation: 'replace' });

  return {
    ok: true,
    file_path: validation.file_path,
    lease_id: validation.lease.id,
    bytes_written: Buffer.byteLength(content),
  };
}

export function gatewayAppendFile(db, repoRoot, { leaseId, path: targetPath, content, worktree = null }) {
  const validation = validateWriteAccess(db, repoRoot, { leaseId, path: targetPath, worktree });
  if (!validation.ok) {
    logWriteEvent(db, 'denied', validation.reason_code, validation, 'write_denied');
    return {
      ok: false,
      reason_code: validation.reason_code,
      file_path: validation.file_path,
      lease_id: validation.lease?.id ?? leaseId,
    };
  }

  mkdirSync(dirname(validation.absolute_path), { recursive: true });
  appendFileSync(validation.absolute_path, content);
  logWriteEvent(db, 'allowed', null, validation, 'write_allowed', { operation: 'append' });

  return {
    ok: true,
    file_path: validation.file_path,
    lease_id: validation.lease.id,
    bytes_written: Buffer.byteLength(content),
  };
}

export function gatewayRemovePath(db, repoRoot, { leaseId, path: targetPath, worktree = null }) {
  const validation = validateWriteAccess(db, repoRoot, { leaseId, path: targetPath, worktree });
  if (!validation.ok) {
    logWriteEvent(db, 'denied', validation.reason_code, validation, 'write_denied');
    return {
      ok: false,
      reason_code: validation.reason_code,
      file_path: validation.file_path,
      lease_id: validation.lease?.id ?? leaseId,
    };
  }

  rmSync(validation.absolute_path, { force: true, recursive: true });
  logWriteEvent(db, 'allowed', null, validation, 'write_allowed', { operation: 'remove' });

  return {
    ok: true,
    file_path: validation.file_path,
    lease_id: validation.lease.id,
    removed: true,
  };
}

export function gatewayMovePath(db, repoRoot, { leaseId, sourcePath, destinationPath, worktree = null }) {
  const sourceValidation = validateWriteAccess(db, repoRoot, { leaseId, path: sourcePath, worktree });
  if (!sourceValidation.ok) {
    logWriteEvent(db, 'denied', sourceValidation.reason_code, sourceValidation, 'write_denied');
    return {
      ok: false,
      reason_code: sourceValidation.reason_code,
      file_path: sourceValidation.file_path,
      lease_id: sourceValidation.lease?.id ?? leaseId,
    };
  }

  const destinationValidation = validateWriteAccess(db, repoRoot, { leaseId, path: destinationPath, worktree });
  if (!destinationValidation.ok) {
    logWriteEvent(db, 'denied', destinationValidation.reason_code, destinationValidation, 'write_denied');
    return {
      ok: false,
      reason_code: destinationValidation.reason_code,
      file_path: destinationValidation.file_path,
      lease_id: destinationValidation.lease?.id ?? leaseId,
    };
  }

  mkdirSync(dirname(destinationValidation.absolute_path), { recursive: true });
  renameSync(sourceValidation.absolute_path, destinationValidation.absolute_path);
  logWriteEvent(db, 'allowed', null, destinationValidation, 'write_allowed', {
    operation: 'move',
    source_path: sourceValidation.file_path,
  });

  return {
    ok: true,
    file_path: destinationValidation.file_path,
    source_path: sourceValidation.file_path,
    lease_id: destinationValidation.lease.id,
    moved: true,
  };
}

export function gatewayMakeDirectory(db, repoRoot, { leaseId, path: targetPath, worktree = null }) {
  let normalizedPath;
  try {
    normalizedPath = normalizeRepoPath(repoRoot, targetPath).relativePath.replace(/\/+$/, '');
  } catch {
    return {
      ok: false,
      reason_code: 'policy_exception_required',
      file_path: targetPath,
      lease_id: leaseId,
    };
  }
  const lease = getLease(db, leaseId);

  if (!lease || lease.status !== 'active') {
    return {
      ok: false,
      reason_code: 'no_active_lease',
      file_path: normalizedPath,
      lease_id: lease?.id ?? leaseId,
    };
  }

  if (worktree && lease.worktree !== worktree) {
    return {
      ok: false,
      reason_code: 'worktree_mismatch',
      file_path: normalizedPath,
      lease_id: lease.id,
    };
  }

  const leaseWorktree = getWorktree(db, lease.worktree);
  if (!leaseWorktree) {
    return {
      ok: false,
      reason_code: 'worktree_mismatch',
      file_path: normalizedPath,
      lease_id: lease.id,
    };
  }

  const claimedDescendant = getActiveFileClaims(db).find((claim) =>
    claim.lease_id === lease.id && (
      claim.file_path === normalizedPath ||
      claim.file_path.startsWith(`${normalizedPath}/`)
    ),
  );
  const scopedDescendant = scopeAllowsDirectory(getLeaseScopePatterns(db, lease), normalizedPath);

  if (!claimedDescendant && !scopedDescendant) {
    const validation = {
      lease,
      file_path: normalizedPath,
    };
    logWriteEvent(db, 'denied', 'path_not_claimed', validation, 'write_denied');
    return {
      ok: false,
      reason_code: 'path_not_claimed',
      file_path: normalizedPath,
      lease_id: lease.id,
    };
  }

  const absolutePath = join(leaseWorktree.path, normalizedPath);
  mkdirSync(absolutePath, { recursive: true });
  logWriteEvent(db, 'allowed', scopedDescendant && !claimedDescendant ? 'path_within_task_scope' : null, {
    lease,
    file_path: normalizedPath,
    ownership_type: scopedDescendant && !claimedDescendant ? 'scope' : 'claim',
  }, 'write_allowed', { operation: 'mkdir' });

  return {
    ok: true,
    file_path: normalizedPath,
    lease_id: lease.id,
    created: true,
  };
}

export function runWrappedCommand(
  db,
  repoRoot,
  {
    leaseId,
    command,
    args = [],
    worktree = null,
    cwd = null,
    env = {},
  },
) {
  const validation = validateLeaseAccess(db, { leaseId, worktree });
  if (!validation.ok) {
    logAuditEvent(db, {
      eventType: 'wrapper_command',
      status: 'denied',
      reasonCode: validation.reason_code,
      worktree: validation.lease?.worktree ?? null,
      taskId: validation.lease?.task_id ?? null,
      leaseId: validation.lease?.id ?? leaseId,
      details: JSON.stringify({
        phase: 'start',
        command,
        args,
      }),
    });
    return {
      ok: false,
      reason_code: validation.reason_code,
      lease_id: validation.lease?.id ?? leaseId,
      exit_code: null,
    };
  }

  const launchCwd = cwd || validation.worktree.path;
  const launchEnv = {
    ...process.env,
    ...env,
    SWITCHMAN_LEASE_ID: validation.lease.id,
    SWITCHMAN_TASK_ID: validation.lease.task_id,
    SWITCHMAN_WORKTREE: validation.lease.worktree,
    SWITCHMAN_REPO_ROOT: repoRoot,
    SWITCHMAN_WORKTREE_PATH: validation.worktree.path,
  };

  logAuditEvent(db, {
    eventType: 'wrapper_command',
    status: 'allowed',
    worktree: validation.lease.worktree,
    taskId: validation.lease.task_id,
    leaseId: validation.lease.id,
    details: JSON.stringify({
      phase: 'start',
      command,
      args,
      cwd: launchCwd,
    }),
  });

  const result = spawnSync(command, args, {
    cwd: launchCwd,
    env: launchEnv,
    stdio: 'inherit',
  });

  const wrappedOk = !result.error && result.status === 0;
  const reasonCode = result.error
    ? 'wrapper_launch_failed'
    : (result.status === 0 ? null : 'wrapped_command_failed');

  logAuditEvent(db, {
    eventType: 'wrapper_command',
    status: wrappedOk ? 'allowed' : 'denied',
    reasonCode,
    worktree: validation.lease.worktree,
    taskId: validation.lease.task_id,
    leaseId: validation.lease.id,
    details: JSON.stringify({
      phase: 'finish',
      command,
      args,
      cwd: launchCwd,
      exit_code: result.status,
      signal: result.signal || null,
      error: result.error?.message || null,
    }),
  });

  return {
    ok: wrappedOk,
    reason_code: reasonCode,
    lease_id: validation.lease.id,
    task_id: validation.lease.task_id,
    worktree: validation.lease.worktree,
    exit_code: result.status,
    signal: result.signal || null,
  };
}

export function evaluateWorktreeCompliance(db, repoRoot, worktree, options = {}) {
  const staleLeaseIds = options.staleLeaseIds || new Set(getStaleLeases(db).map((lease) => lease.id));
  const activeLeases = options.activeLeases || listLeases(db, 'active');
  const activeClaims = options.activeClaims || getActiveFileClaims(db);
  const completedClaims = options.completedClaims || getCompletedFileClaims(db, worktree.name);

  const changedFiles = getWorktreeChangedFiles(worktree.path, repoRoot);
  const activeLease = activeLeases.find((lease) => lease.worktree === worktree.name) || null;
  const claimsForWorktree = activeClaims.filter((claim) => claim.worktree === worktree.name);
  const completedClaimsByPath = new Map(completedClaims.map((claim) => [claim.file_path, claim]));

  const violations = [];
  const unclaimedChangedFiles = [];

  for (const file of changedFiles) {
    const completedClaim = completedClaimsByPath.get(file);
    if (!activeLease) {
      if (completedClaim) {
        continue;
      }
      violations.push({ file, reason_code: 'no_active_lease' });
      unclaimedChangedFiles.push(file);
      continue;
    }
    if (staleLeaseIds.has(activeLease.id)) {
      violations.push({ file, reason_code: 'lease_expired' });
      unclaimedChangedFiles.push(file);
      continue;
    }
    const ownership = resolveLeasePathOwnership(db, activeLease, file, activeClaims, activeLeases);
    if (!ownership.ok) {
      violations.push({ file, reason_code: ownership.reason_code });
      unclaimedChangedFiles.push(file);
    }
  }

  let complianceState = COMPLIANCE_STATES.OBSERVED;
  if (activeLease && staleLeaseIds.has(activeLease.id)) {
    complianceState = COMPLIANCE_STATES.STALE;
  } else if (violations.length > 0) {
    complianceState = COMPLIANCE_STATES.NON_COMPLIANT;
  } else if (activeLease) {
    complianceState = COMPLIANCE_STATES.MANAGED;
  }

  updateWorktreeCompliance(db, worktree.name, complianceState);

  return {
    worktree: worktree.name,
    active_lease_id: activeLease?.id ?? null,
    compliance_state: complianceState,
    changed_files: changedFiles,
    unclaimed_changed_files: unclaimedChangedFiles,
    violations,
  };
}

export function evaluateRepoCompliance(db, repoRoot, worktrees) {
  const activeLeases = listLeases(db, 'active');
  const activeClaims = getActiveFileClaims(db);
  const completedClaims = getCompletedFileClaims(db);
  const staleLeaseIds = new Set(getStaleLeases(db).map((lease) => lease.id));
  const completedClaimsByWorktree = completedClaims.reduce((acc, claim) => {
    if (!acc[claim.worktree]) acc[claim.worktree] = [];
    acc[claim.worktree].push(claim);
    return acc;
  }, {});

  const worktreeCompliance = worktrees.map((worktree) =>
    evaluateWorktreeCompliance(db, repoRoot, worktree, {
      activeLeases,
      activeClaims,
      completedClaims: completedClaimsByWorktree[worktree.name] || [],
      staleLeaseIds,
    }),
  );

  return {
    worktreeCompliance,
    unclaimedChanges: worktreeCompliance
      .filter((entry) => entry.unclaimed_changed_files.length > 0)
      .map((entry) => ({
        worktree: entry.worktree,
        lease_id: entry.active_lease_id,
        files: entry.unclaimed_changed_files,
        reasons: entry.violations,
      })),
    complianceSummary: {
      managed: worktreeCompliance.filter((entry) => entry.compliance_state === COMPLIANCE_STATES.MANAGED).length,
      observed: worktreeCompliance.filter((entry) => entry.compliance_state === COMPLIANCE_STATES.OBSERVED).length,
      non_compliant: worktreeCompliance.filter((entry) => entry.compliance_state === COMPLIANCE_STATES.NON_COMPLIANT).length,
      stale: worktreeCompliance.filter((entry) => entry.compliance_state === COMPLIANCE_STATES.STALE).length,
    },
    deniedWrites: listAuditEvents(db, { status: 'denied', limit: 20 }),
    commitGateFailures: listAuditEvents(db, { eventType: 'commit_gate', status: 'denied', limit: 20 }),
  };
}

export function monitorWorktreesOnce(db, repoRoot, worktrees, options = {}) {
  const activeLeases = listLeases(db, 'active');
  const activeClaims = getActiveFileClaims(db);
  const staleLeaseIds = new Set(getStaleLeases(db).map((lease) => lease.id));
  const policy = options.policy || loadEnforcementPolicy(repoRoot);

  const events = [];

  for (const worktree of worktrees) {
    const previousSnapshot = getWorktreeSnapshotState(db, worktree.name);
    const currentSnapshot = buildWorktreeSnapshot(worktree.path);
    const changes = diffSnapshots(previousSnapshot, currentSnapshot);

    for (const change of changes) {
      const classification = classifyObservedPath(db, repoRoot, worktree, change.file_path, {
        activeLeases,
        activeClaims,
        staleLeaseIds,
        policy,
      });

      const event = {
        worktree: worktree.name,
        file_path: change.file_path,
        change_type: change.change_type,
        status: classification.status,
        reason_code: classification.reason_code,
        lease_id: classification.lease?.id ?? null,
        task_id: classification.lease?.task_id ?? null,
        enforcement_action: null,
        quarantine_path: null,
      };

      logAuditEvent(db, {
        eventType: 'write_observed',
        status: classification.status,
        reasonCode: classification.reason_code,
        worktree: worktree.name,
        taskId: classification.lease?.task_id ?? null,
        leaseId: classification.lease?.id ?? null,
        filePath: change.file_path,
        details: JSON.stringify({ change_type: change.change_type }),
      });

      if (classification.status === 'denied') {
        updateWorktreeCompliance(db, worktree.name, COMPLIANCE_STATES.NON_COMPLIANT);
        if (options.quarantine) {
          const enforcementResult = enforceObservedChange(repoRoot, worktree, change, classification);
          event.enforcement_action = enforcementResult.action;
          event.quarantine_path = enforcementResult.quarantine_path;
          logAuditEvent(db, {
            eventType: 'write_quarantined',
            status: 'allowed',
            reasonCode: classification.reason_code,
            worktree: worktree.name,
            taskId: classification.lease?.task_id ?? null,
            leaseId: classification.lease?.id ?? null,
            filePath: change.file_path,
            details: JSON.stringify(enforcementResult),
          });
        }
      }

      events.push(event);
    }

    const finalSnapshot = options.quarantine ? buildWorktreeSnapshot(worktree.path) : currentSnapshot;
    replaceWorktreeSnapshotState(db, worktree.name, finalSnapshot);
  }

  return {
    events,
    summary: {
      total: events.length,
      allowed: events.filter((event) => event.status === 'allowed').length,
      denied: events.filter((event) => event.status === 'denied').length,
      quarantined: events.filter((event) => event.enforcement_action && event.enforcement_action !== 'none').length,
    },
  };
}

export function runCommitGate(db, repoRoot, { cwd = process.cwd(), worktreeName = null } = {}) {
  const currentWorktree = worktreeName
    ? null
    : getCurrentWorktree(repoRoot, cwd);
  const resolvedWorktree = worktreeName
    ? { name: worktreeName, path: cwd }
    : currentWorktree;

  if (!resolvedWorktree) {
    const result = {
      ok: false,
      worktree: null,
      changed_files: [],
      violations: [{ file: null, reason_code: 'worktree_mismatch' }],
      summary: 'Current directory is not a registered git worktree.',
    };
    logAuditEvent(db, {
      eventType: 'commit_gate',
      status: 'denied',
      reasonCode: 'worktree_mismatch',
      details: JSON.stringify(result),
    });
    return result;
  }

  const compliance = evaluateWorktreeCompliance(db, repoRoot, resolvedWorktree);
  const ok = compliance.violations.length === 0;
  const summary = ok
    ? `Commit gate passed for ${resolvedWorktree.name}.`
    : `Commit gate rejected ${compliance.violations.length} ungoverned file change(s) in ${resolvedWorktree.name}.`;

  logAuditEvent(db, {
    eventType: 'commit_gate',
    status: ok ? 'allowed' : 'denied',
    reasonCode: ok ? null : compliance.violations[0]?.reason_code ?? 'path_not_claimed',
    worktree: resolvedWorktree.name,
    leaseId: compliance.active_lease_id,
    details: JSON.stringify({
      changed_files: compliance.changed_files,
      violations: compliance.violations,
    }),
  });

  return {
    ok,
    worktree: resolvedWorktree.name,
    lease_id: compliance.active_lease_id,
    changed_files: compliance.changed_files,
    violations: compliance.violations,
    summary,
  };
}

export function installCommitHook(repoRoot) {
  const commonDir = getGitCommonDir(repoRoot);
  const hooksDir = join(commonDir, 'hooks');
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, 'pre-commit');
  const hookScript = `#!/bin/sh
switchman gate commit
`;
  writeFileSync(hookPath, hookScript);
  chmodSync(hookPath, 0o755);
  return hookPath;
}

export function installMergeHook(repoRoot) {
  const commonDir = getGitCommonDir(repoRoot);
  const hooksDir = join(commonDir, 'hooks');
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const hookPath = join(hooksDir, 'pre-merge-commit');
  const hookScript = `#!/bin/sh
switchman gate merge
`;
  writeFileSync(hookPath, hookScript);
  chmodSync(hookPath, 0o755);
  return hookPath;
}

export function installGateHooks(repoRoot) {
  return {
    pre_commit: installCommitHook(repoRoot),
    pre_merge_commit: installMergeHook(repoRoot),
  };
}
