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

const FREE_AGENT_LIMIT  = 3;
const FREE_RETENTION_DAYS = 7;
const PRO_RETENTION_DAYS = 90;
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
  const licence = await checkLicence();
  return licence.valid ? PRO_RETENTION_DAYS : FREE_RETENTION_DAYS;
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
export async function loginWithGitHub() {
  const { default: open } = await import('open');

  // ── Step 1: Generate a short human-readable code ──────────────────────────
  const adjectives = ['SWIFT', 'CLEAR', 'SAFE', 'CLEAN', 'FAST', 'BOLD', 'CALM', 'KEEN'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const num = Math.floor(1000 + Math.random() * 9000);
  const code = `${adj}-${num}`;

  // ── Step 2: Store the pending code in Supabase ────────────────────────────
  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/cli_auth_codes`, {
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
      return { success: false, error: 'Could not create auth session. Please try again.' };
    }
  } catch {
    return { success: false, error: 'Network error. Please check your connection.' };
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

  open(activateUrl).catch(() => {
    // Browser didn't open — user can copy the URL manually
  });

  // ── Step 4: Poll Supabase every 2 seconds for up to 10 minutes ────────────
  const POLL_INTERVAL_MS = 2000;
  const MAX_WAIT_MS      = 10 * 60 * 1000;
  const started          = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const pollRes = await fetch(
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
        return { success: false, error: 'Code expired. Please run switchman login again.' };
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
        fetch(`${SUPABASE_URL}/rest/v1/cli_auth_codes?code=eq.${code}`, {
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

  return { success: false, error: 'timeout' };
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

export { FREE_AGENT_LIMIT, FREE_RETENTION_DAYS, PRO_PAGE_URL, PRO_RETENTION_DAYS };
