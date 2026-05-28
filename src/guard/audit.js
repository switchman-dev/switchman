import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

export const GUARD_AUDIT_LOG = join('.switchman', 'guard-audit.log');

export function getGuardAuditPath(repoRoot) {
  return join(repoRoot, GUARD_AUDIT_LOG);
}

export function buildAuditEntry({
  agentId = null,
  taskId = null,
  tool,
  args = {},
  result,
  reason = null,
  timestamp = new Date().toISOString(),
}) {
  return {
    timestamp,
    agentId: agentId ? String(agentId) : 'unknown',
    taskId: taskId ? String(taskId) : null,
    tool: String(tool),
    args: args && typeof args === 'object' ? args : {},
    result,
    reason: reason ? String(reason) : null,
  };
}

export function writeAuditLog(repoRoot, entry) {
  try {
    const auditPath = getGuardAuditPath(repoRoot);
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Guard must never break normal Switchman operation because audit IO failed.
  }
}

export function readAuditEntries(repoRoot) {
  const auditPath = getGuardAuditPath(repoRoot);
  if (!existsSync(auditPath)) return [];

  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function getAuditSummary(repoRoot) {
  const entries = readAuditEntries(repoRoot);
  return {
    total_calls: entries.length,
    blocked_calls: entries.filter((entry) => entry.result === 'blocked').length,
    anomalies: entries.filter((entry) => entry.result === 'anomaly').length,
  };
}
