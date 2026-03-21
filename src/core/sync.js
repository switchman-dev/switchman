/**
 * switchman cloud sync module
 * Syncs coordination state to Supabase for Pro team users.
 *
 * Only runs when:
 *   1. The user has a valid Pro licence
 *   2. The user is a member of a team
 *   3. Network is available
 *
 * Improvements over v1:
 *   - Offline event queue — events buffered to disk when offline, flushed on next success
 *   - Retry logic — failed pushes retried up to 3 times with exponential backoff
 *   - Push result returned — callers can optionally log or act on failures
 *
 * Never throws — all sync operations are best-effort.
 * Local SQLite remains the source of truth.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { checkLicence, readCredentials, resolveFreeCloudProjectAccess } from './licence.js';
import { basename } from 'path';
import { execSync } from 'child_process';

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL  = process.env.SWITCHMAN_SUPABASE_URL
  ?? 'https://afilbolhlkiingnsupgr.supabase.co';

const SUPABASE_ANON = process.env.SWITCHMAN_SUPABASE_ANON
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmaWxib2xobGtpaW5nbnN1cGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTIzOTIsImV4cCI6MjA4OTE2ODM5Mn0.8TBfHfRB0vEyKPMWBd6i1DNwx1nS9UqprIAsJf35n88';

const SYNC_TIMEOUT_MS  = 3000;
const MAX_RETRIES      = 3;
const MAX_QUEUED       = 50;
const QUEUE_FILE_NAME  = 'sync-queue.json';
const MAX_QUEUE_ATTEMPTS = 12;
const BASE_RETRY_DELAY_MS = 30 * 1000;

// ─── Offline queue ────────────────────────────────────────────────────────────

function getQueuePath() {
  return join(homedir(), '.switchman', QUEUE_FILE_NAME);
}

function ensureConfigDir() {
  const dir = join(homedir(), '.switchman');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function readQueue() {
  try {
    const path = getQueuePath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(events) {
  try {
    ensureConfigDir();
    const trimmed = events.slice(-MAX_QUEUED);
    writeFileSync(getQueuePath(), JSON.stringify(trimmed, null, 2), { mode: 0o600 });
  } catch {
    // Best effort
  }
}

function enqueueEvent(event) {
  try {
    const queue = readQueue();
    queue.push({
      ...event,
      queued_at: new Date().toISOString(),
      attempts: 0,
      last_error: null,
      next_retry_at: new Date().toISOString(),
    });
    writeQueue(queue);
  } catch {
    // Best effort
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON,
    'Authorization': `Bearer ${SUPABASE_ANON}`,
    'x-user-token': accessToken,
  };
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = SYNC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Team resolution ──────────────────────────────────────────────────────────

async function getTeamId(accessToken, userId) {
  try {
    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/team_members?user_id=eq.${userId}&select=team_id&limit=1`,
      { headers: getHeaders(accessToken) }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.team_id ?? null;
  } catch {
    return null;
  }
}

function deriveRepoKey(repoRoot = process.cwd()) {
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

async function resolveSyncScope(repoRoot = process.cwd()) {
  const creds = readCredentials();
  if (!creds?.access_token || !creds?.user_id) {
    return { ok: false, reason: 'not_logged_in' };
  }

  const licence = await checkLicence();
  if (licence.valid) {
    const teamId = await getTeamId(creds.access_token, creds.user_id);
    if (!teamId) return { ok: false, reason: 'no_team' };
    return {
      ok: true,
      accessToken: creds.access_token,
      userId: creds.user_id,
      email: creds.email ?? null,
      teamId,
      repoKey: deriveRepoKey(repoRoot),
      plan: 'pro',
    };
  }

  const repoKey = deriveRepoKey(repoRoot);
  const freeProject = resolveFreeCloudProjectAccess(repoKey);
  if (!freeProject.allowed) {
    return {
      ok: false,
      reason: freeProject.reason || 'free_project_limit',
      active_projects: freeProject.active_projects || [],
    };
  }

  return {
    ok: true,
    accessToken: creds.access_token,
    userId: creds.user_id,
    email: creds.email ?? null,
    teamId: freeProject.scope_id,
    repoKey,
    plan: 'free',
  };
}

// ─── Core push with retry ─────────────────────────────────────────────────────

async function pushEventWithRetry(row, accessToken) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchWithTimeout(
        `${SUPABASE_URL}/rest/v1/sync_state`,
        {
          method: 'POST',
          headers: {
            ...getHeaders(accessToken),
            'Prefer': 'return=minimal',
          },
          body: JSON.stringify(row),
        }
      );

      if (res.ok) {
        return { ok: true, attempts: attempt };
      }

      // 4xx errors won't improve with retries — bail early
      if (res.status >= 400 && res.status < 500) {
        return { ok: false, attempts: attempt, reason: `http_${res.status}` };
      }

      lastError = `http_${res.status}`;
    } catch (err) {
      lastError = err?.name === 'AbortError' ? 'timeout' : 'network_error';
    }

    // Exponential backoff: 200ms, 400ms, 800ms
    if (attempt < MAX_RETRIES) {
      await sleep(200 * Math.pow(2, attempt - 1));
    }
  }

  return { ok: false, attempts: MAX_RETRIES, reason: lastError };
}

function isRetryableFailure(reason) {
  return reason === 'network_error'
    || reason === 'timeout'
    || /^http_5\d\d$/.test(String(reason || ''));
}

function computeNextRetryAt(attempts) {
  const effectiveAttempts = Math.max(1, Number(attempts) || 1);
  const cappedExponent = Math.min(5, effectiveAttempts - 1);
  const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, cappedExponent);
  return new Date(Date.now() + delayMs).toISOString();
}

// ─── Flush offline queue ──────────────────────────────────────────────────────

async function flushQueue(accessToken) {
  const queue = readQueue();
  if (queue.length === 0) {
    return { attempted: 0, flushed: 0, remaining: 0 };
  }

  const remaining = [];
  let attempted = 0;
  let flushed = 0;
  const now = Date.now();

  for (const event of queue) {
    const nextRetryAt = event.next_retry_at ? new Date(event.next_retry_at).getTime() : 0;
    if (!Number.isNaN(nextRetryAt) && nextRetryAt > now) {
      remaining.push(event);
      continue;
    }

    const { queued_at, attempts, ...row } = event;
    attempted += 1;
    const result = await pushEventWithRetry(row, accessToken);
    if (!result.ok) {
      const totalAttempts = (attempts ?? 0) + result.attempts;
      if (totalAttempts >= MAX_QUEUE_ATTEMPTS || !isRetryableFailure(result.reason)) {
        continue;
      }
      remaining.push({
        ...event,
        attempts: totalAttempts,
        last_error: result.reason || 'unknown_error',
        next_retry_at: computeNextRetryAt(totalAttempts),
      });
      continue;
    }
    flushed += 1;
  }

  writeQueue(remaining);
  return {
    attempted,
    flushed,
    remaining: remaining.length,
  };
}

// ─── Push ─────────────────────────────────────────────────────────────────────

/**
 * Push a state change event to Supabase.
 * Returns { ok, queued, attempts } — never throws.
 *
 * eventType: 'task_added' | 'task_done' | 'task_failed' | 'lease_acquired' |
 *            'claim_added' | 'claim_released' | 'status_ping'
 */
export async function pushSyncEvent(eventType, payload, { worktree = null, repoRoot = process.cwd() } = {}) {
  try {
    const scope = await resolveSyncScope(repoRoot);
    if (!scope.ok) return { ok: false, reason: scope.reason };

    const resolvedWorktree = worktree
      ?? process.cwd().split('/').pop()
      ?? 'unknown';

    const row = {
      team_id:    scope.teamId,
      user_id:    scope.userId,
      worktree:   resolvedWorktree,
      event_type: eventType,
      payload: {
        ...payload,
        email:     scope.email,
        synced_at: new Date().toISOString(),
        repo_key:  scope.repoKey,
        plan:      scope.plan,
      },
    };

    const result = await pushEventWithRetry(row, scope.accessToken);

    if (result.ok) {
      // Flush any previously queued offline events now that we're back online
      flushQueue(scope.accessToken).catch(() => {});
      return { ok: true, queued: false, attempts: result.attempts };
    }

    if (!isRetryableFailure(result.reason)) {
      return { ok: false, queued: false, attempts: result.attempts, reason: result.reason };
    }

    // Push failed after retries — save to offline queue
    enqueueEvent(row);
    return { ok: false, queued: true, attempts: result.attempts, reason: result.reason };

  } catch {
    return { ok: false, reason: 'unexpected_error' };
  }
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

/**
 * Pull recent team sync events (last 5 minutes).
 * Returns array of events or empty array on error.
 */
export async function pullTeamState() {
  try {
    return await fetchTeamSyncEvents({ minutes: 5, limit: 50 });
  } catch {
    return [];
  }
}

/**
 * Pull active team members (events in the last 15 minutes).
 * Returns array of { email, worktree, event_type, payload, created_at }
 * Excludes the current user's own events.
 */
export async function pullActiveTeamMembers() {
  try {
    const scope = await resolveSyncScope(process.cwd());
    if (!scope.ok) return [];
    const events = await fetchTeamSyncEvents({ minutes: 15, limit: 100 });

    // Deduplicate — keep most recent event per user+worktree, exclude self
    const seen = new Map();
    for (const event of events) {
      if (event.user_id === scope.userId) continue;
      const key = `${event.user_id}:${event.worktree}`;
      if (!seen.has(key)) seen.set(key, event);
    }

    return [...seen.values()];
  } catch {
    return [];
  }
}

async function fetchTeamSyncEvents({ minutes = 5, limit = 50, repoRoot = process.cwd() } = {}) {
  const scope = await resolveSyncScope(repoRoot);
  if (!scope.ok) return [];

  await flushQueue(scope.accessToken).catch(() => {});

  const since = new Date(Date.now() - Math.max(1, Number(minutes) || 5) * 60 * 1000).toISOString();
  const res = await fetchWithTimeout(
    `${SUPABASE_URL}/rest/v1/sync_state` +
    `?team_id=eq.${scope.teamId}` +
    `&created_at=gte.${since}` +
    `&order=created_at.desc` +
    `&limit=${Math.max(1, Number(limit) || 50)}`,
    { headers: getHeaders(scope.accessToken) }
  );

  if (!res.ok) return [];
  return await res.json();
}

export async function pullTeamReviewShares({
  hours = 24,
  limit = 20,
  repoRoot = process.cwd(),
  includeSelf = false,
} = {}) {
  try {
    const scope = await resolveSyncScope(repoRoot);
    if (!scope.ok) return [];

    const minutes = Math.max(1, Number(hours) || 24) * 60;
    const events = await fetchTeamSyncEvents({
      minutes,
      limit: Math.max(20, Number(limit) || 20),
      repoRoot,
    });

    return events.filter((event) => {
      if (event.event_type !== 'session_review_shared') return false;
      if (!includeSelf && event.user_id === scope.userId) return false;
      return event.payload?.repo_key === scope.repoKey;
    });
  } catch {
    return [];
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Delete sync events older than retentionDays for this user.
 * Also purges stale offline queue entries older than 24 hours.
 */
export async function cleanupOldSyncEvents({ retentionDays = 7 } = {}) {
  try {
    const scope = await resolveSyncScope(process.cwd());
    if (!scope.ok) return;

    const cutoff = new Date(
      Date.now() - Math.max(1, Number.parseInt(retentionDays, 10) || 7) * 24 * 60 * 60 * 1000
    ).toISOString();

    await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/sync_state` +
      `?user_id=eq.${scope.userId}` +
      `&created_at=lt.${cutoff}`,
      { method: 'DELETE', headers: getHeaders(scope.accessToken) }
    );

    // Purge queue entries older than 24 hours — too stale to be useful
    const queue = readQueue();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const fresh = queue.filter(e => (e.queued_at ?? '') > dayAgo);
    if (fresh.length !== queue.length) writeQueue(fresh);

  } catch {
    // Best effort
  }
}

/**
 * Return the number of events currently queued offline.
 * Useful for status display.
 */
export function getPendingQueueCount() {
  return readQueue().length;
}

export function getPendingQueueStatus() {
  const queue = readQueue();
  if (queue.length === 0) {
    return {
      pending: 0,
      oldest_queued_at: null,
      next_retry_at: null,
      last_error: null,
    };
  }

  const oldestQueuedAt = queue
    .map((event) => event.queued_at || null)
    .filter(Boolean)
    .sort()[0] || null;

  const nextRetryAt = queue
    .map((event) => event.next_retry_at || null)
    .filter(Boolean)
    .sort()[0] || null;

  const lastError = [...queue]
    .reverse()
    .map((event) => event.last_error || null)
    .find(Boolean) || null;

  return {
    pending: queue.length,
    oldest_queued_at: oldestQueuedAt,
    next_retry_at: nextRetryAt,
    last_error: lastError,
  };
}

export async function flushPendingSyncEvents() {
  try {
    const creds = readCredentials();
    if (!creds?.access_token) {
      return { ok: false, reason: 'not_logged_in', attempted: 0, flushed: 0, remaining: getPendingQueueCount() };
    }
    const result = await flushQueue(creds.access_token);
    return { ok: true, ...result };
  } catch {
    return { ok: false, reason: 'unexpected_error', attempted: 0, flushed: 0, remaining: getPendingQueueCount() };
  }
}
