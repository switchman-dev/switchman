import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import readline from 'readline/promises';

export const DEFAULT_TELEMETRY_HOST = 'https://us.i.posthog.com';

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const lowered = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(lowered)) return false;
  return null;
}

export function getTelemetryConfigPath(homeDir = homedir()) {
  return join(homeDir, '.switchman', 'config.json');
}

export function getTelemetryRuntimeConfig(env = process.env) {
  return {
    apiKey: env.SWITCHMAN_TELEMETRY_API_KEY || env.POSTHOG_API_KEY || null,
    host: env.SWITCHMAN_TELEMETRY_HOST || env.POSTHOG_HOST || DEFAULT_TELEMETRY_HOST,
    disabled: normalizeBoolean(env.SWITCHMAN_TELEMETRY_DISABLED) === true,
  };
}

export function loadTelemetryConfig(homeDir = homedir()) {
  const configPath = getTelemetryConfigPath(homeDir);
  if (!existsSync(configPath)) {
    return {
      telemetry_enabled: null,
      telemetry_install_id: null,
      telemetry_prompted_at: null,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return {
      telemetry_enabled: typeof parsed?.telemetry_enabled === 'boolean' ? parsed.telemetry_enabled : null,
      telemetry_install_id: typeof parsed?.telemetry_install_id === 'string' ? parsed.telemetry_install_id : null,
      telemetry_prompted_at: typeof parsed?.telemetry_prompted_at === 'string' ? parsed.telemetry_prompted_at : null,
    };
  } catch {
    return {
      telemetry_enabled: null,
      telemetry_install_id: null,
      telemetry_prompted_at: null,
    };
  }
}

export function writeTelemetryConfig(homeDir = homedir(), config = {}) {
  const configPath = getTelemetryConfigPath(homeDir);
  mkdirSync(dirname(configPath), { recursive: true });
  const normalized = {
    telemetry_enabled: typeof config.telemetry_enabled === 'boolean' ? config.telemetry_enabled : null,
    telemetry_install_id: typeof config.telemetry_install_id === 'string' ? config.telemetry_install_id : (config.telemetry_enabled ? randomUUID() : null),
    telemetry_prompted_at: typeof config.telemetry_prompted_at === 'string' ? config.telemetry_prompted_at : null,
  };
  writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return { path: configPath, config: normalized };
}

export function enableTelemetry(homeDir = homedir()) {
  const current = loadTelemetryConfig(homeDir);
  return writeTelemetryConfig(homeDir, {
    ...current,
    telemetry_enabled: true,
    telemetry_install_id: current.telemetry_install_id || randomUUID(),
    telemetry_prompted_at: new Date().toISOString(),
  });
}

export function disableTelemetry(homeDir = homedir()) {
  const current = loadTelemetryConfig(homeDir);
  return writeTelemetryConfig(homeDir, {
    ...current,
    telemetry_enabled: false,
    telemetry_install_id: current.telemetry_install_id || randomUUID(),
    telemetry_prompted_at: new Date().toISOString(),
  });
}

export async function maybePromptForTelemetry({ homeDir = homedir(), stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  const runtime = getTelemetryRuntimeConfig(env);
  if (!runtime.apiKey || runtime.disabled) {
    return { prompted: false, enabled: false, available: Boolean(runtime.apiKey) && !runtime.disabled };
  }

  const current = loadTelemetryConfig(homeDir);
  if (typeof current.telemetry_enabled === 'boolean') {
    return { prompted: false, enabled: current.telemetry_enabled, available: true };
  }

  if (!stdin?.isTTY || !stdout?.isTTY) {
    return { prompted: false, enabled: false, available: true };
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write('\nHelp improve Switchman?\n');
    stdout.write('If you opt in, Switchman will send anonymous usage events like setup success,\n');
    stdout.write('verify-setup pass, status --watch, queue usage, and gate outcomes.\n');
    stdout.write('No code, prompts, file contents, repo names, or secrets are collected.\n\n');
    const answer = await rl.question('Enable telemetry? [y/N] ');
    const enabled = ['y', 'yes'].includes(String(answer || '').trim().toLowerCase());
    if (enabled) {
      enableTelemetry(homeDir);
    } else {
      disableTelemetry(homeDir);
    }
    return { prompted: true, enabled, available: true };
  } finally {
    rl.close();
  }
}

export async function captureTelemetryEvent(event, properties = {}, {
  homeDir = homedir(),
  env = process.env,
  timeoutMs = 1500,
} = {}) {
  const result = await sendTelemetryEvent(event, properties, {
    homeDir,
    env,
    timeoutMs,
  });
  return result.ok;
}

export async function sendTelemetryEvent(event, properties = {}, {
  homeDir = homedir(),
  env = process.env,
  timeoutMs = 1500,
} = {}) {
  const runtime = getTelemetryRuntimeConfig(env);
  if (!runtime.apiKey) {
    return {
      ok: false,
      reason: 'not_configured',
      status: null,
      destination: runtime.host,
    };
  }
  if (runtime.disabled) {
    return {
      ok: false,
      reason: 'disabled_by_env',
      status: null,
      destination: runtime.host,
    };
  }
  if (typeof fetch !== 'function') {
    return {
      ok: false,
      reason: 'fetch_unavailable',
      status: null,
      destination: runtime.host,
    };
  }

  const config = loadTelemetryConfig(homeDir);
  if (config.telemetry_enabled !== true || !config.telemetry_install_id) {
    return {
      ok: false,
      reason: 'not_enabled',
      status: null,
      destination: runtime.host,
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${runtime.host.replace(/\/$/, '')}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: runtime.apiKey,
        event,
        distinct_id: config.telemetry_install_id,
        properties: {
          source: 'switchman-cli',
          ...properties,
        },
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return {
      ok: response.ok,
      reason: response.ok ? null : 'http_error',
      status: response.status,
      destination: runtime.host,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === 'AbortError' ? 'timeout' : 'network_error',
      status: null,
      destination: runtime.host,
      error: String(err?.message || err),
    };
  }
}
