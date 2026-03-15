/**
 * switchman cloud sync module
 * Syncs coordination state to Supabase for Pro team users.
 *
 * Only runs when:
 *   1. The user has a valid Pro licence
 *   2. The user is a member of a team
 *   3. Network is available
 *
 * Never throws — all sync operations are best-effort.
 * Local SQLite remains the source of truth.
 */

import { readCredentials } from './licence.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL  = process.env.SWITCHMAN_SUPABASE_URL
  ?? 'https://afilbolhlkiingnsupgr.supabase.co';

const SUPABASE_ANON = process.env.SWITCHMAN_SUPABASE_ANON
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmaWxib2xobGtpaW5nbnN1cGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTIzOTIsImV4cCI6MjA4OTE2ODM5Mn0.8TBfHfRB0vEyKPMWBd6i1DNwx1nS9UqprIAsJf35n88';

const SYNC_TIMEOUT_MS = 3000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON,
    'Authorization': `Bearer ${accessToken}`,
  };
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

/**
 * Get the team ID for the current user.
 * Returns null if not in a team or on error.
 */
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

// ─── Push ─────────────────────────────────────────────────────────────────────

/**
 * Push a state change event to Supabase.
 * Called after any state-changing command.
 *
 * eventType: 'task_added' | 'task_done' | 'task_failed' | 'lease_acquired' |
 *            'claim_added' | 'claim_released' | 'status_ping'
 * payload: object with relevant fields
 */
export async function pushSyncEvent(eventType, payload, { worktree = null } = {}) {
  try {
    const creds = readCredentials();
    if (!creds?.access_token || !creds?.user_id) return;

    const teamId = await getTeamId(creds.access_token, creds.user_id);
    if (!teamId) return; // Not in a team — no sync needed

    const resolvedWorktree = worktree
      ?? process.cwd().split('/').pop()
      ?? 'unknown';

    await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/sync_state`,
      {
        method: 'POST',
        headers: {
          ...getHeaders(creds.access_token),
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          team_id: teamId,
          user_id: creds.user_id,
          worktree: resolvedWorktree,
          event_type: eventType,
          payload: {
            ...payload,
            email: creds.email ?? null,
            synced_at: new Date().toISOString(),
          },
        }),
      }
    );
  } catch {
    // Best effort — never fail the local operation
  }
}

// ─── Pull ─────────────────────────────────────────────────────────────────────

/**
 * Pull recent team sync events from Supabase.
 * Returns an array of events or empty array on error.
 * Used by `switchman status` to show team-wide activity.
 */
export async function pullTeamState() {
  try {
    const creds = readCredentials();
    if (!creds?.access_token || !creds?.user_id) return [];

    const teamId = await getTeamId(creds.access_token, creds.user_id);
    if (!teamId) return [];

    // Pull last 5 minutes of events from all team members
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/sync_state` +
      `?team_id=eq.${teamId}` +
      `&created_at=gte.${since}` +
      `&order=created_at.desc` +
      `&limit=50`,
      { headers: getHeaders(creds.access_token) }
    );

    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/**
 * Pull active team members (those with events in the last 15 minutes).
 * Returns array of { email, worktree, event_type, payload, created_at }
 */
export async function pullActiveTeamMembers() {
  try {
    const creds = readCredentials();
    if (!creds?.access_token || !creds?.user_id) return [];

    const teamId = await getTeamId(creds.access_token, creds.user_id);
    if (!teamId) return [];

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const res = await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/sync_state` +
      `?team_id=eq.${teamId}` +
      `&created_at=gte.${since}` +
      `&order=created_at.desc` +
      `&limit=100`,
      { headers: getHeaders(creds.access_token) }
    );

    if (!res.ok) return [];
    const events = await res.json();

    // Deduplicate — keep most recent event per user+worktree
    const seen = new Map();
    for (const event of events) {
      const key = `${event.user_id}:${event.worktree}`;
      if (!seen.has(key)) {
        seen.set(key, event);
      }
    }

    return [...seen.values()];
  } catch {
    return [];
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Delete sync events older than the configured retention window for this user.
 * Called occasionally to keep the table tidy.
 * Best effort — never fails.
 */
export async function cleanupOldSyncEvents({ retentionDays = 7 } = {}) {
  try {
    const creds = readCredentials();
    if (!creds?.access_token || !creds?.user_id) return;

    const cutoff = new Date(Date.now() - Math.max(1, Number.parseInt(retentionDays, 10) || 7) * 24 * 60 * 60 * 1000).toISOString();

    await fetchWithTimeout(
      `${SUPABASE_URL}/rest/v1/sync_state` +
      `?user_id=eq.${creds.user_id}` +
      `&created_at=lt.${cutoff}`,
      {
        method: 'DELETE',
        headers: getHeaders(creds.access_token),
      }
    );
  } catch {
    // Best effort
  }
}
