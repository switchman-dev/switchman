import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';

function getSwitchmanConfigDir() {
  return join(homedir(), '.switchman');
}

export function getNotificationsConfigPath() {
  return join(getSwitchmanConfigDir(), 'notifications.json');
}

function ensureConfigDir() {
  const dir = getSwitchmanConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readNotificationsConfig() {
  try {
    const path = getNotificationsConfigPath();
    if (!existsSync(path)) {
      return {
        desktop_enabled: false,
        slack_enabled: false,
        slack_webhook_url: null,
      };
    }
    return {
      desktop_enabled: false,
      slack_enabled: false,
      slack_webhook_url: null,
      ...JSON.parse(readFileSync(path, 'utf8')),
    };
  } catch {
    return {
      desktop_enabled: false,
      slack_enabled: false,
      slack_webhook_url: null,
    };
  }
}

export function writeNotificationsConfig(nextConfig) {
  ensureConfigDir();
  const current = readNotificationsConfig();
  const merged = {
    ...current,
    ...nextConfig,
  };
  writeFileSync(getNotificationsConfigPath(), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}

function writeTestSink(entry) {
  const sinkPath = process.env.SWITCHMAN_NOTIFICATION_TEST_SINK;
  if (!sinkPath) return false;
  appendFileSync(sinkPath, `${JSON.stringify(entry)}\n`);
  return true;
}

function postDesktopNotification(title, message) {
  if (writeTestSink({ channel: 'desktop', title, message })) {
    return Promise.resolve({ ok: true, channel: 'desktop', simulated: true });
  }

  return new Promise((resolve) => {
    const body = String(message || '').slice(0, 240);
    if (platform() === 'darwin') {
      execFile('osascript', [
        '-e',
        `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
      ], (error) => resolve({ ok: !error, channel: 'desktop', error: error?.message || null }));
      return;
    }

    if (platform() === 'linux') {
      execFile('notify-send', [title, body], (error) => resolve({ ok: !error, channel: 'desktop', error: error?.message || null }));
      return;
    }

    if (platform() === 'win32') {
      execFile('powershell', [
        '-NoProfile',
        '-Command',
        `[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime];
$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02;
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template);
$texts = $xml.GetElementsByTagName('text');
$texts.Item(0).AppendChild($xml.CreateTextNode(${JSON.stringify(title)})) | Out-Null;
$texts.Item(1).AppendChild($xml.CreateTextNode(${JSON.stringify(body)})) | Out-Null;
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml);
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Switchman').Show($toast);`,
      ], (error) => resolve({ ok: !error, channel: 'desktop', error: error?.message || null }));
      return;
    }

    resolve({ ok: false, channel: 'desktop', error: `unsupported_platform:${platform()}` });
  });
}

async function postSlackNotification(webhookUrl, title, message) {
  if (!webhookUrl) return { ok: false, channel: 'slack', error: 'missing_webhook' };
  if (writeTestSink({ channel: 'slack', title, message, webhook: 'configured' })) {
    return { ok: true, channel: 'slack', simulated: true };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `*${title}*\n${message}`,
      }),
    });
    return {
      ok: response.ok,
      channel: 'slack',
      error: response.ok ? null : `http_${response.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      channel: 'slack',
      error: err?.message || 'network_error',
    };
  }
}

export async function sendSwitchmanNotification({
  title,
  message,
  allowDesktop = true,
  allowSlack = true,
  checkLicence = async () => ({ valid: false }),
} = {}) {
  const config = readNotificationsConfig();
  const attempts = [];

  if (allowDesktop && config.desktop_enabled) {
    attempts.push(postDesktopNotification(title, message));
  }

  if (allowSlack && config.slack_enabled && config.slack_webhook_url) {
    const licence = await checkLicence();
    if (licence.valid) {
      attempts.push(postSlackNotification(config.slack_webhook_url, title, message));
    }
  }

  if (attempts.length === 0) {
    return { sent: false, deliveries: [] };
  }

  const deliveries = await Promise.all(attempts);
  return {
    sent: deliveries.some((entry) => entry.ok),
    deliveries,
  };
}
