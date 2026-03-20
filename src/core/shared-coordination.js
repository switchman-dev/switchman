import { basename } from 'path';
import { execSync } from 'child_process';

import { checkLicence, readCredentials, resolveFreeCloudProjectAccess } from './licence.js';

const SUPABASE_URL = process.env.SWITCHMAN_SUPABASE_URL
  ?? 'https://afilbolhlkiingnsupgr.supabase.co';

const SUPABASE_ANON = process.env.SWITCHMAN_SUPABASE_ANON
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmaWxib2xobGtpaW5nbnN1cGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTIzOTIsImV4cCI6MjA4OTE2ODM5Mn0.8TBfHfRB0vEyKPMWBd6i1DNwx1nS9UqprIAsJf35n88';

const SHARED_COORDINATION_URL = process.env.SWITCHMAN_SHARED_QUEUE_URL
  ?? `${SUPABASE_URL}/functions/v1/shared-coordination`;

const SHARED_TIMEOUT_MS = 5000;

function getHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON,
    'Authorization': `Bearer ${SUPABASE_ANON}`,
    'x-user-token': accessToken,
  };
}

async function fetchWithTimeout(url, options, timeoutMs = SHARED_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function deriveRepoKey(repoRoot) {
  try {
    const remoteUrl = execSync('git config --get remote.origin.url', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (remoteUrl) return remoteUrl;
  } catch {
    // fall back to repo basename
  }
  return basename(repoRoot);
}

async function resolveSharedContext(repoRoot) {
  if (process.env.SWITCHMAN_FORCE_LOCAL_COORDINATION === '1') {
    return { enabled: false, reason: 'forced_local' };
  }

  const licence = await checkLicence();
  const creds = readCredentials();
  if (!creds?.access_token || !creds?.user_id) {
    return { enabled: false, reason: 'missing_credentials' };
  }

  const repoKey = deriveRepoKey(repoRoot);
  if (!licence.valid) {
    const freeProject = resolveFreeCloudProjectAccess(repoKey);
    if (!freeProject.allowed) {
      return { enabled: false, reason: freeProject.reason || 'free_project_limit', active_projects: freeProject.active_projects || [] };
    }

    return {
      enabled: true,
      accessToken: creds.access_token,
      userId: creds.user_id,
      teamId: freeProject.scope_id,
      repoKey,
      plan: 'free',
      firstUse: freeProject.first_use,
    };
  }

  const teamId = process.env.SWITCHMAN_TEAM_ID || creds.team_id || null;
  if (!teamId) {
    return { enabled: false, reason: 'no_team' };
  }

  return {
    enabled: true,
    accessToken: creds.access_token,
    userId: creds.user_id,
    teamId,
    repoKey,
    plan: 'pro',
  };
}

async function performSharedOperation(repoRoot, operation, payload = {}) {
  const context = await resolveSharedContext(repoRoot);
  if (!context.enabled) {
    return {
      ok: false,
      shared: false,
      reason: context.reason,
    };
  }

  try {
    const response = await fetchWithTimeout(SHARED_COORDINATION_URL, {
      method: 'POST',
      headers: getHeaders(context.accessToken),
      body: JSON.stringify({
        operation,
        repo_key: context.repoKey,
        team_id: context.teamId,
        user_id: context.userId,
        payload,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        shared: true,
        reason: data?.reason || `http_${response.status}`,
        status: response.status,
        message: data?.message || null,
        ...data,
      };
    }

    return {
      ok: true,
      shared: true,
      ...data,
    };
  } catch (err) {
    return {
      ok: false,
      shared: true,
      reason: err?.name === 'AbortError' ? 'timeout' : 'network_error',
      message: err?.message || null,
    };
  }
}

export async function createSharedTask(repoRoot, task) {
  return performSharedOperation(repoRoot, 'create_task', { task });
}

export async function listSharedTasks(repoRoot, { status = null } = {}) {
  return performSharedOperation(repoRoot, 'list_tasks', { status });
}

export async function listSharedLeases(repoRoot, { status = null } = {}) {
  return performSharedOperation(repoRoot, 'list_leases', { status });
}

export async function listSharedClaims(repoRoot) {
  return performSharedOperation(repoRoot, 'list_claims');
}

export async function getSharedStatusSnapshot(repoRoot) {
  return performSharedOperation(repoRoot, 'status_snapshot');
}

export async function acquireSharedNextLease(repoRoot, { worktree, agent = null } = {}) {
  return performSharedOperation(repoRoot, 'acquire_next', { worktree, agent });
}

export async function acquireSharedTaskLease(repoRoot, { taskId, worktree, agent = null } = {}) {
  return performSharedOperation(repoRoot, 'acquire_task', { task_id: taskId, worktree, agent });
}

export async function claimSharedFiles(repoRoot, {
  taskId,
  worktree,
  files,
  agent = null,
  force = false,
} = {}) {
  return performSharedOperation(repoRoot, 'claim_files', {
    task_id: taskId,
    worktree,
    files,
    agent,
    force,
  });
}

export async function releaseSharedClaims(repoRoot, { taskId } = {}) {
  return performSharedOperation(repoRoot, 'release_claims', { task_id: taskId });
}

export async function completeSharedTask(repoRoot, { taskId } = {}) {
  return performSharedOperation(repoRoot, 'complete_task', { task_id: taskId });
}

export async function failSharedTask(repoRoot, { taskId, reason = null } = {}) {
  return performSharedOperation(repoRoot, 'fail_task', { task_id: taskId, reason });
}

export async function retrySharedTask(repoRoot, { taskId, reason = null } = {}) {
  return performSharedOperation(repoRoot, 'retry_task', { task_id: taskId, reason });
}

export async function recoverSharedAbandonedWork(repoRoot, {
  staleAfterMinutes = null,
  reason = 'operator recover',
} = {}) {
  return performSharedOperation(repoRoot, 'recover_abandoned', {
    stale_after_minutes: staleAfterMinutes,
    reason,
  });
}

export async function dispatchSharedReadyTasks(repoRoot, { agentName = 'switchman-scheduler', limit = null } = {}) {
  return performSharedOperation(repoRoot, 'dispatch_ready', {
    agent_name: agentName,
    limit,
  });
}

export async function getSharedCoordinationMode(repoRoot) {
  return resolveSharedContext(repoRoot);
}
