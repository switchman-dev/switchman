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
        'Authorization': `Bearer ${creds.access_token}`,
        'apikey': SUPABASE_ANON,
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
  const { createServer } = await import('http');

  return new Promise((resolve) => {
    let server;
    const timeout = setTimeout(() => {
      server?.close();
      resolve({ success: false, error: 'timeout' });
    }, 5 * 60 * 1000);

    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:7429');

      if (url.pathname === '/callback') {
        const code         = url.searchParams.get('code');
        const accessToken  = url.searchParams.get('access_token');
        const refreshToken = url.searchParams.get('refresh_token');
        const error        = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html><html>
          <head><style>
            body { background:#0b1020; color:#e6eef8; font-family:monospace;
                   display:flex; align-items:center; justify-content:center;
                   min-height:100vh; margin:0; }
            .box { text-align:center; }
            .ok  { color:#4ade80; font-size:48px; }
            .err { color:#f87171; font-size:48px; }
            h2   { font-size:24px; margin:16px 0 8px; }
            p    { color:#5f7189; }
          </style></head>
          <body><div class="box">
            <div class="${error ? 'err' : 'ok'}">${error ? '✕' : '✓'}</div>
            <h2>${error ? 'Sign in failed' : 'Signed in successfully'}</h2>
            <p>${error ? 'You can close this tab.' : 'You can close this tab and return to your terminal.'}</p>
          </div></body></html>
        `);

        clearTimeout(timeout);
        server.close();

        if (error) {
          resolve({ success: false, error });
          return;
        }

        // If Supabase sent the token directly as query params
        if (accessToken) {
          saveSession({
            access_token:  accessToken,
            refresh_token: refreshToken ?? null,
            expires_in:    3600,
            user:          null, // will be fetched on next checkLicence
          });
          // Fetch the user email from Supabase
          try {
            const userRes = await fetch(`${AUTH_URL}/user`, {
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'apikey': SUPABASE_ANON,
              },
            });
            if (userRes.ok) {
              const user = await userRes.json();
              const creds = readCredentials() || {};
              writeCredentials({ ...creds, email: user.email, user_id: user.id });
              resolve({ success: true, email: user.email });
            } else {
              resolve({ success: true, email: null });
            }
          } catch {
            resolve({ success: true, email: null });
          }
          return;
        }

        // Exchange the code for a session
        if (code) {
          try {
            const tokenRes = await fetch(`${AUTH_URL}/token?grant_type=pkce`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON,
              },
              body: JSON.stringify({ auth_code: code }),
            });

            if (tokenRes.ok) {
              const session = await tokenRes.json();
              saveSession(session);
              resolve({ success: true, email: session.user?.email ?? null });
              return;
            }

            // Fallback exchange
            const exchangeRes = await fetch(`${AUTH_URL}/token?grant_type=authorization_code`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON,
              },
              body: JSON.stringify({ code }),
            });

            if (exchangeRes.ok) {
              const session = await exchangeRes.json();
              saveSession(session);
              resolve({ success: true, email: session.user?.email ?? null });
              return;
            }

            resolve({ success: false, error: 'token_exchange_failed' });
          } catch (err) {
            resolve({ success: false, error: err.message });
          }
          return;
        }

        resolve({ success: false, error: 'no_code' });
      }
    });

    server.listen(7429, 'localhost', () => {
      const params = new URLSearchParams({
        provider:    'github',
        redirect_to: 'http://localhost:7429/callback',
        scopes:      'read:user user:email',
      });

      const loginUrl = `${AUTH_URL}/authorize?${params}`;
      console.log('');
      console.log('  Opening GitHub sign-in in your browser...');
      console.log(`  If it doesn\'t open, visit: ${loginUrl}`);
      console.log('');

      open(loginUrl).catch(() => {
        console.log('  Could not open browser automatically.');
        console.log(`  Please visit: ${loginUrl}`);
      });
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ success: false, error: err.message });
    });
  });
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
