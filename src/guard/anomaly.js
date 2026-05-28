import { buildAuditEntry, writeAuditLog } from './audit.js';
import { resolveAgentId, resolveTaskId } from './scope.js';

const WRITE_TOOLS = new Set([
  'switchman_write_file',
  'switchman_append_file',
  'switchman_remove_path',
  'switchman_move_path',
  'switchman_make_directory',
]);

function findLease(db, leaseId) {
  if (!db || !leaseId) return null;
  try {
    return db.prepare('SELECT * FROM leases WHERE id = ?').get(leaseId) || null;
  } catch {
    return null;
  }
}

function hasClaimForPath(db, leaseId, filePath) {
  if (!db || !leaseId || !filePath) return true;
  try {
    const row = db.prepare(`
      SELECT 1
      FROM file_claims
      WHERE lease_id = ?
        AND released_at IS NULL
        AND file_path = ?
      LIMIT 1
    `).get(leaseId, filePath);
    return Boolean(row);
  } catch {
    return true;
  }
}

function getTouchedPaths(tool, args) {
  if (tool === 'switchman_move_path') return [args.source_path, args.destination_path].filter(Boolean);
  if (WRITE_TOOLS.has(tool)) return [args.path].filter(Boolean);
  return [];
}

export function detectAnomaly({ db = null, tool, args = {}, response = null }) {
  if (!args || typeof args !== 'object') return { anomaly: false, reason: null };

  const leaseId = args.lease_id || args.leaseId || null;
  const taskId = resolveTaskId(args);
  const lease = findLease(db, leaseId);

  if (lease && taskId && lease.task_id !== taskId) {
    return {
      anomaly: true,
      reason: `Lease ${leaseId} belongs to task ${lease.task_id}, not ${taskId}.`,
    };
  }

  if (lease && args.worktree && lease.worktree !== args.worktree) {
    return {
      anomaly: true,
      reason: `Lease ${leaseId} belongs to worktree ${lease.worktree}, not ${args.worktree}.`,
    };
  }

  for (const filePath of getTouchedPaths(tool, args)) {
    if (!hasClaimForPath(db, leaseId, filePath)) {
      return {
        anomaly: true,
        reason: `Path ${filePath} is not claimed by lease ${leaseId}.`,
      };
    }
  }

  if (response?.isError && WRITE_TOOLS.has(tool)) {
    return {
      anomaly: true,
      reason: response.content?.[0]?.text || `${tool} returned an error.`,
    };
  }

  return { anomaly: false, reason: null };
}

export function reportAnomaly(repoRoot, { tool, args = {}, reason }) {
  try {
    process.stderr.write(`switchman guard anomaly: ${reason}\n`);
  } catch {
    // Ignore console failures; Guard is advisory unless configured otherwise.
  }

  writeAuditLog(repoRoot, buildAuditEntry({
    agentId: resolveAgentId(args),
    taskId: resolveTaskId(args),
    tool,
    args,
    result: 'anomaly',
    reason,
  }));
}
