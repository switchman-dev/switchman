/**
 * switchman licence module
 * Handles Pro licence validation, credential storage, and caching.
 *
 * Credentials file: ~/.switchman/credentials.json
 * Cache file:       ~/.switchman/licence-cache.json
 *
 * The CLI calls checkLicence() before any Pro-gated feature.
 * It returns { valid, plan, email, cached } and never throws —
 * if anything goes wrong it returns { valid: false }.
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ─── Config ───────────────────────────────────────────────────────────────────
//
// Defaults point at the hosted Switchman Pro backend.
// Override with environment variables if self-hosting:
//   SWITCHMAN_SUPABASE_URL=https://your-project.supabase.co
//   SWITCHMAN_SUPABASE_ANON=your-anon-key

const SUPABASE_URL  = process.env.SWITCHMAN_SUPABASE_URL
  ?? 'https://afilbolhlkiingnsupgr.supabase.co';

const SUPABASE_ANON = process.env.SWITCHMAN_SUPABASE_ANON
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFmaWxib2xobGtpaW5nbnN1cGdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTIzOTIsImV4cCI6MjA4OTE2ODM5Mn0.8TBfHfRB0vEyKPMWBd6i1DNwx1nS9UqprIAsJf35n88';
const VALIDATE_URL      = `${SUPABASE_URL}/functions/v1/validate-licence`;
const AUTH_URL          = `${SUPABASE_URL}/auth/v1`;
const PRO_PAGE_URL      = 'https://switchman.dev/pro';

const FREE_AGENT_LIMIT  = Number.POSITIVE_INFINITY;
const FREE_RETENTION_DAYS = 3;          // unauthenticated — triggers login nudge
const FREE_LOGGED_IN_RETENTION_DAYS = 14; // logged in, free plan
const PRO_RETENTION_DAYS = 90;
const FREE_CLOUD_PROJECT_LIMIT = 1;
const CACHE_TTL_MS      = 24 * 60 * 60 * 1000;   // 24 hours
const OFFLINE_GRACE_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Paths ────────────────────────────────────────────────────────────────────

function getSwitchmanConfigDir() {
  return join(homedir(), '.switchman');
}

function getCredentialsPath() {
  return join(getSwitchmanConfigDir(), 'credentials.json');
}

function getLicenceCachePath() {
  return join(getSwitchmanConfigDir(), 'licence-cache.json');
}

function getFreeCloudProjectsPath() {
  return join(getSwitchmanConfigDir(), 'free-cloud-projects.json');
}

function ensureConfigDir() {
  const dir = getSwitchmanConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// ─── Credentials ─────────────────────────────────────────────────────────────

export function readCredentials() {
  try {
    const path = getCredentialsPath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCredentials(creds) {
  ensureConfigDir();
  writeFileSync(getCredentialsPath(), JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function clearCredentials() {
  try {
    const path = getCredentialsPath();
    if (existsSync(path)) {
      writeFileSync(path, JSON.stringify({}), { mode: 0o600 });
    }
  } catch { /* no-op */ }
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function readLicenceCache() {
  try {
    const path = getLicenceCachePath();
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeLicenceCache(result) {
  try {
    ensureConfigDir();
    writeFileSync(getLicenceCachePath(), JSON.stringify({
      ...result,
      cached_at: Date.now(),
    }, null, 2), { mode: 0o600 });
  } catch { /* no-op */ }
}

function clearLicenceCache() {
  try {
    const path = getLicenceCachePath();
    if (existsSync(path)) writeFileSync(path, '{}');
  } catch { /* no-op */ }
}

function readFreeCloudProjects() {
  try {
    const path = getFreeCloudProjectsPath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed?.projects)
      ? parsed.projects.filter((entry) => typeof entry === 'string' && entry.trim())
      : [];
  } catch {
    return [];
  }
}

function writeFreeCloudProjects(projects) {
  try {
    ensureConfigDir();
    const uniqueProjects = [...new Set(projects.map((entry) => String(entry || '').trim()).filter(Boolean))];
    writeFileSync(getFreeCloudProjectsPath(), JSON.stringify({
      limit: FREE_CLOUD_PROJECT_LIMIT,
      projects: uniqueProjects.slice(0, FREE_CLOUD_PROJECT_LIMIT),
    }, null, 2), { mode: 0o600 });
  } catch {
    // Best effort
  }
}

function buildFreeCloudScopeId(projectKey) {
  const digest = createHash('sha256').update(String(projectKey || '')).digest('hex').slice(0, 16);
  return `free-project-${digest}`;
}

export function resolveFreeCloudProjectAccess(projectKey) {
  const normalizedKey = String(projectKey || '').trim();
  if (!normalizedKey) {
    return { allowed: false, reason: 'missing_project_key', active_projects: [] };
  }

  const activeProjects = readFreeCloudProjects();
  if (activeProjects.includes(normalizedKey)) {
    return {
      allowed: true,
      reason: null,
      first_use: false,
      project_key: normalizedKey,
      active_projects: activeProjects,
      scope_id: buildFreeCloudScopeId(normalizedKey),
    };
  }

  if (activeProjects.length >= FREE_CLOUD_PROJECT_LIMIT) {
    return {
      allowed: false,
      reason: 'free_project_limit',
      project_key: normalizedKey,
      active_projects: activeProjects,
      limit: FREE_CLOUD_PROJECT_LIMIT,
    };
  }

  const nextProjects = [...activeProjects, normalizedKey];
  writeFreeCloudProjects(nextProjects);
  return {
    allowed: true,
    reason: null,
    first_use: true,
    project_key: normalizedKey,
    active_projects: nextProjects,
    scope_id: buildFreeCloudScopeId(normalizedKey),
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Check whether the current user has a valid Pro licence.
 * Returns { valid, plan, email, cached, offline }
 * Never throws.
 */
export async function checkLicence() {
  const creds = readCredentials();
  if (!creds?.access_token) {
    return { valid: false, reason: 'not_logged_in' };
  }

   // Proactively refresh if token expires within 5 minutes
  if (creds.expires_at && Date.now() > creds.expires_at - 5 * 60 * 1000) {
    if (creds.refresh_token) {
      await refreshToken(creds.refresh_token);
    }
  }

  // Check the 24-hour cache first
  const cache = readLicenceCache();
  if (cache?.valid && cache.cached_at) {
    const age = Date.now() - cache.cached_at;
    if (age < CACHE_TTL_MS) {
      return { ...cache, cached: true, offline: false };
    }
  }

  // Try live validation
  try {
   const res = await fetch(VALIDATE_URL, {
  headers: {
    'Authorization': `Bearer ${SUPABASE_ANON}`,
    'apikey': SUPABASE_ANON,
    'x-user-token': creds.access_token,
  },
});

    if (!res.ok) {
      // If token is expired, try to refresh
      if (res.status === 401 && creds.refresh_token) {
        const refreshed = await refreshToken(creds.refresh_token);
        if (refreshed) {
          return checkLicence(); // retry with new token
        }
      }
      // Fall through to offline grace check
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    const result = {
      valid: data.valid === true,
      plan: data.plan ?? null,
      email: data.email ?? null,
      current_period_end: data.current_period_end ?? null,
      reason: data.valid ? null : (data.reason ?? 'no_licence'),
    };

    writeLicenceCache(result);
    return { ...result, cached: false, offline: false };

  } catch {
    // Network error — fall back to offline grace period
    if (cache?.valid && cache.cached_at) {
      const age = Date.now() - cache.cached_at;
      if (age < OFFLINE_GRACE_MS) {
        return { ...cache, cached: true, offline: true };
      }
    }
    return { valid: false, reason: 'offline', cached: false, offline: true };
  }
}

export async function getRetentionDaysForCurrentPlan() {
  const creds = readCredentials();
  if (!creds?.access_token) return FREE_RETENTION_DAYS;       // not logged in → 3 days
  const licence = await checkLicence();
  return licence.valid ? PRO_RETENTION_DAYS : FREE_LOGGED_IN_RETENTION_DAYS; // pro → 90, free logged-in → 14
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshToken(refreshToken) {
  try {
    const res = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) return null;
    const data = await res.json();

    if (data.access_token) {
      const creds = readCredentials() || {};
      writeCredentials({
        ...creds,
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? refreshToken,
        expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      });
      clearLicenceCache();
      return true;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── GitHub Device Flow login ─────────────────────────────────────────────────

/**
 * Run the GitHub OAuth device flow via Supabase.
 * Opens the browser, polls for the token, saves credentials.
 * Returns { success, email } or { success: false, error }
 */
function humanizeLoginError(reason, activateUrl = null, code = null) {
  const retryLine = 'Run `switchman login` again.';
  const manualLine = activateUrl
    ? `Open ${activateUrl}${code ? ` and enter code ${code}` : ''} manually.`
    : 'Run `switchman login` again.';

  switch (reason) {
    case 'auth_session_create_failed':
      return `Could not create an auth session with the Switchman backend. ${retryLine}`;
    case 'network_unavailable':
      return `Switchman could not reach the auth backend. Check your connection, then try again.`;
    case 'browser_open_failed':
      return `Switchman could not open your browser automatically. ${manualLine}`;
    case 'auth_code_expired':
      return `This sign-in code expired before authorization completed. ${retryLine}`;
    case 'token_exchange_failed':
      return `Authorization completed, but Switchman could not store the returned session cleanly. ${retryLine}`;
    case 'timeout':
      return `Timed out waiting for GitHub authorization. ${manualLine}`;
    default:
      return reason || 'Unknown login error.';
  }
}

export async function loginWithGitHub({
  fetchImpl = globalThis.fetch,
  openBrowser = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pollIntervalMs = 2000,
  maxWaitMs = 10 * 60 * 1000,
} = {}) {
  const open = openBrowser ?? (await import('open')).default;

  // ── Step 1: Generate a short human-readable code ──────────────────────────
  const adjectives = ['SWIFT', 'CLEAR', 'SAFE', 'CLEAN', 'FAST', 'BOLD', 'CALM', 'KEEN'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  const code = `${adj}-${num}`;

  // ── Step 2: Store the pending code in Supabase ────────────────────────────
  try {
    const insertRes = await fetchImpl(`${SUPABASE_URL}/rest/v1/cli_auth_codes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        code,
        status: 'pending',
      }),
    });

    if (!insertRes.ok) {
      return {
        success: false,
        error: humanizeLoginError('auth_session_create_failed'),
        reason: 'auth_session_create_failed',
      };
    }
  } catch {
    return {
      success: false,
      error: humanizeLoginError('network_unavailable'),
      reason: 'network_unavailable',
    };
  }

  // ── Step 3: Open the activate page in the browser ─────────────────────────
  const activateUrl = `https://switchman.dev/activate?code=${code}`;

  console.log('');
  console.log('  Visit this URL to sign in:');
  console.log(`  ${activateUrl}`);
  console.log('');
  console.log(`  Your code: ${code}`);
  console.log('');
  console.log('  Waiting for authorization...');

  try {
    await open(activateUrl);
  } catch {
    return {
      success: false,
      error: humanizeLoginError('browser_open_failed', activateUrl, code),
      reason: 'browser_open_failed',
      activate_url: activateUrl,
      code,
    };
  }

  // ── Step 4: Poll Supabase every 2 seconds for up to 10 minutes ────────────
  const started          = Date.now();

  while (Date.now() - started < maxWaitMs) {
    await sleep(pollIntervalMs);

    try {
      const pollRes = await fetchImpl(
        `${SUPABASE_URL}/rest/v1/cli_auth_codes?code=eq.${code}&select=status,access_token,refresh_token,user_email,user_id`,
        {
          headers: {
            'apikey': SUPABASE_ANON,
            'Accept': 'application/json',
          },
        }
      );

      if (!pollRes.ok) continue;

      const rows = await pollRes.json();
      const row  = rows?.[0];

      if (!row) continue;

      if (row.status === 'expired') {
        return {
          success: false,
          error: humanizeLoginError('auth_code_expired'),
          reason: 'auth_code_expired',
        };
      }

      if (row.status === 'authorized' && row.access_token) {
        // Save the credentials
        writeCredentials({
          access_token:  row.access_token,
          refresh_token: row.refresh_token ?? null,
          expires_at:    Date.now() + 3600 * 1000,
          email:         row.user_email ?? null,
          user_id:       row.user_id ?? null,
        });
        clearLicenceCache();

        // Clean up the code row
        fetchImpl(`${SUPABASE_URL}/rest/v1/cli_auth_codes?code=eq.${code}`, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_ANON },
        }).catch(() => {});

        return { success: true, email: row.user_email };
      }

      // status === 'pending' — keep polling
    } catch {
      // Network blip — keep polling
    }
  }

  return {
    success: false,
    error: humanizeLoginError('timeout', activateUrl, code),
    reason: 'timeout',
    activate_url: activateUrl,
    code,
  };
}

function saveSession(session) {
  if (!session?.access_token) return;
  writeCredentials({
    access_token: session.access_token,
    refresh_token: session.refresh_token ?? null,
    expires_at: Date.now() + (session.expires_in ?? 3600) * 1000,
    email: session.user?.email ?? null,
    user_id: session.user?.id ?? null,
  });
  clearLicenceCache();
}

// ─── Helpers for CLI commands ─────────────────────────────────────────────────

export {
  FREE_AGENT_LIMIT,
  FREE_CLOUD_PROJECT_LIMIT,
  FREE_LOGGED_IN_RETENTION_DAYS,
  FREE_RETENTION_DAYS,
  PRO_PAGE_URL,
  PRO_RETENTION_DAYS,
};