import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export const GUARD_CONFIG_FILE = join('.switchman', 'guard-config.json');

export const DEFAULT_GUARD_CONFIG = {
  enabled: true,
  scopes: {
    default: [
      'switchman_task_next',
      'switchman_task_done',
      'switchman_task_fail',
      'switchman_task_claim',
      'switchman_lease_heartbeat',
      'switchman_scan',
      'switchman_status',
    ],
    readonly: [
      'switchman_scan',
      'switchman_status',
    ],
  },
  anomalyDetection: {
    enabled: true,
    blockOnAnomaly: false,
    logOnAnomaly: true,
  },
};

export function getGuardConfigPath(repoRoot) {
  return join(repoRoot, GUARD_CONFIG_FILE);
}

export function guardConfigExists(repoRoot) {
  return existsSync(getGuardConfigPath(repoRoot));
}

export function loadGuardConfig(repoRoot) {
  const configPath = getGuardConfigPath(repoRoot);
  if (!existsSync(configPath)) return null;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    return {
      ...DEFAULT_GUARD_CONFIG,
      ...config,
      scopes: {
        ...DEFAULT_GUARD_CONFIG.scopes,
        ...(config.scopes || {}),
      },
      anomalyDetection: {
        ...DEFAULT_GUARD_CONFIG.anomalyDetection,
        ...(config.anomalyDetection || {}),
      },
    };
  } catch {
    return null;
  }
}

export function writeDefaultGuardConfig(repoRoot) {
  const configPath = getGuardConfigPath(repoRoot);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(DEFAULT_GUARD_CONFIG, null, 2)}\n`, 'utf8');
  return configPath;
}

export function removeGuardConfig(repoRoot) {
  const configPath = getGuardConfigPath(repoRoot);
  if (existsSync(configPath)) rmSync(configPath);
  return configPath;
}

export function resolveAgentId(args = {}) {
  return args.agent || args.agent_id || args.agentId || args.worktree || process.env.SWITCHMAN_AGENT_ID || 'unknown';
}

export function resolveTaskId(args = {}) {
  return args.task_id || args.taskId || null;
}

export function resolveAgentRole(config, args = {}) {
  const agentId = resolveAgentId(args);
  if (args.role && config?.scopes?.[args.role]) return args.role;
  if (args.agent_role && config?.scopes?.[args.agent_role]) return args.agent_role;
  if (process.env.SWITCHMAN_GUARD_ROLE && config?.scopes?.[process.env.SWITCHMAN_GUARD_ROLE]) {
    return process.env.SWITCHMAN_GUARD_ROLE;
  }
  if (config?.agentRoles?.[agentId] && config.scopes?.[config.agentRoles[agentId]]) {
    return config.agentRoles[agentId];
  }
  return 'default';
}

export function checkToolScope(repoRoot, tool, args = {}) {
  const config = loadGuardConfig(repoRoot);
  if (!config || config.enabled !== true) {
    return { enabled: false, allowed: true, config: null, role: null, reason: null };
  }

  const role = resolveAgentRole(config, args);
  const allowedTools = config.scopes?.[role] || config.scopes?.default || [];
  const allowed = allowedTools.includes(tool);

  return {
    enabled: true,
    allowed,
    config,
    role,
    reason: allowed ? null : `Tool ${tool} is outside guard scope ${role}.`,
  };
}
