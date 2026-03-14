import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const DEFAULT_LEASE_POLICY = {
  heartbeat_interval_seconds: 60,
  stale_after_minutes: 15,
  reap_on_status_check: true,
  requeue_task_on_reap: true,
};

export const DEFAULT_CHANGE_POLICY = {
  domain_rules: {
    auth: {
      required_completed_task_types: ['tests', 'governance'],
      enforcement: 'blocked',
      rationale: [
        'auth changes require completed tests before landing',
        'auth changes require completed governance review before landing',
      ],
    },
    payments: {
      required_completed_task_types: ['tests', 'governance'],
      enforcement: 'blocked',
      rationale: [
        'payments changes require completed tests before landing',
        'payments changes require completed governance review before landing',
      ],
    },
    schema: {
      required_completed_task_types: ['tests', 'governance', 'docs'],
      enforcement: 'blocked',
      rationale: [
        'schema changes require completed tests before landing',
        'schema changes require completed governance review before landing',
        'schema changes require completed docs or migration notes before landing',
      ],
    },
    config: {
      required_completed_task_types: ['docs', 'governance'],
      enforcement: 'warn',
      rationale: [
        'shared config changes should include updated docs or runbooks',
        'shared config changes should include governance review',
      ],
    },
  },
};

export function getLeasePolicyPath(repoRoot) {
  return join(repoRoot, '.switchman', 'lease-policy.json');
}

export function getChangePolicyPath(repoRoot) {
  return join(repoRoot, '.switchman', 'change-policy.json');
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

function normalizeDomainRule(rule = {}, fallback = {}) {
  const requiredCompletedTaskTypes = Array.isArray(rule.required_completed_task_types)
    ? rule.required_completed_task_types.filter(Boolean)
    : (fallback.required_completed_task_types || []);
  const enforcement = ['none', 'warn', 'blocked'].includes(rule.enforcement)
    ? rule.enforcement
    : (fallback.enforcement || 'none');
  const rationale = Array.isArray(rule.rationale)
    ? rule.rationale.filter(Boolean)
    : (fallback.rationale || []);

  return {
    required_completed_task_types: [...new Set(requiredCompletedTaskTypes)],
    enforcement,
    rationale,
  };
}

export function loadChangePolicy(repoRoot) {
  const policyPath = getChangePolicyPath(repoRoot);
  if (!existsSync(policyPath)) {
    return JSON.parse(JSON.stringify(DEFAULT_CHANGE_POLICY));
  }

  try {
    const parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
    const rules = {
      ...DEFAULT_CHANGE_POLICY.domain_rules,
      ...(parsed?.domain_rules || {}),
    };

    return {
      domain_rules: Object.fromEntries(
        Object.entries(rules).map(([domain, rule]) => [
          domain,
          normalizeDomainRule(rule, DEFAULT_CHANGE_POLICY.domain_rules[domain] || {}),
        ]),
      ),
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CHANGE_POLICY));
  }
}

export function writeChangePolicy(repoRoot, policy = {}) {
  const policyPath = getChangePolicyPath(repoRoot);
  mkdirSync(dirname(policyPath), { recursive: true });
  const mergedRules = {
    ...DEFAULT_CHANGE_POLICY.domain_rules,
    ...(policy?.domain_rules || {}),
  };
  const normalized = {
    domain_rules: Object.fromEntries(
      Object.entries(mergedRules).map(([domain, rule]) => [
        domain,
        normalizeDomainRule(rule, DEFAULT_CHANGE_POLICY.domain_rules[domain] || {}),
      ]),
    ),
  };
  writeFileSync(policyPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return policyPath;
}
