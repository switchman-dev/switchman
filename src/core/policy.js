import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const DEFAULT_LEASE_POLICY = {
  heartbeat_interval_seconds: 60,
  stale_after_minutes: 15,
  reap_on_status_check: false,
  requeue_task_on_reap: true,
};

export function getLeasePolicyPath(repoRoot) {
  return join(repoRoot, '.switchman', 'lease-policy.json');
}

export function loadLeasePolicy(repoRoot) {
  const policyPath = getLeasePolicyPath(repoRoot);
  if (!existsSync(policyPath)) {
    return { ...DEFAULT_LEASE_POLICY };
  }

  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
    return {
      ...DEFAULT_LEASE_POLICY,
      ...parsed,
      heartbeat_interval_seconds: Number.isFinite(parsed?.heartbeat_interval_seconds) ? parsed.heartbeat_interval_seconds : DEFAULT_LEASE_POLICY.heartbeat_interval_seconds,
      stale_after_minutes: Number.isFinite(parsed?.stale_after_minutes) ? parsed.stale_after_minutes : DEFAULT_LEASE_POLICY.stale_after_minutes,
      reap_on_status_check: typeof parsed?.reap_on_status_check === 'boolean' ? parsed.reap_on_status_check : DEFAULT_LEASE_POLICY.reap_on_status_check,
      requeue_task_on_reap: typeof parsed?.requeue_task_on_reap === 'boolean' ? parsed.requeue_task_on_reap : DEFAULT_LEASE_POLICY.requeue_task_on_reap,
    };
  } catch {
    return { ...DEFAULT_LEASE_POLICY };
  }
}

export function writeLeasePolicy(repoRoot, policy = {}) {
  const policyPath = getLeasePolicyPath(repoRoot);
  mkdirSync(dirname(policyPath), { recursive: true });
  const normalized = {
    ...DEFAULT_LEASE_POLICY,
    ...policy,
    heartbeat_interval_seconds: Math.max(1, Number.parseInt(policy.heartbeat_interval_seconds, 10) || DEFAULT_LEASE_POLICY.heartbeat_interval_seconds),
    stale_after_minutes: Math.max(1, Number.parseInt(policy.stale_after_minutes, 10) || DEFAULT_LEASE_POLICY.stale_after_minutes),
    reap_on_status_check: typeof policy.reap_on_status_check === 'boolean' ? policy.reap_on_status_check : DEFAULT_LEASE_POLICY.reap_on_status_check,
    requeue_task_on_reap: typeof policy.requeue_task_on_reap === 'boolean' ? policy.requeue_task_on_reap : DEFAULT_LEASE_POLICY.requeue_task_on_reap,
  };
  writeFileSync(policyPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return policyPath;
}
