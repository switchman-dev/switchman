import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function getSwitchmanPackageRoot() {
  return resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

export function resolveBuiltMacAppBundle(packageRoot = getSwitchmanPackageRoot()) {
  const candidates = [
    join(packageRoot, 'desktop', 'src-tauri', 'target', 'release', 'bundle', 'macos', 'Switchman.app'),
    join(packageRoot, 'desktop', 'src-tauri', 'target', 'debug', 'bundle', 'macos', 'Switchman.app'),
  ];

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function resolveInstalledMacAppBundle() {
  const candidates = [
    process.env.SWITCHMAN_APP_PATH,
    '/Applications/Switchman.app',
    join(homedir(), 'Applications', 'Switchman.app'),
    resolveBuiltMacAppBundle(),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function isSwitchmanAppRunning() {
  if (process.platform !== 'darwin') return false;

  try {
    const output = execFileSync('pgrep', ['-f', '/Switchman.app/Contents/MacOS/'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return Boolean(output);
  } catch {
    return false;
  }
}

export function openSwitchmanApp({ appPath = resolveInstalledMacAppBundle(), background = true } = {}) {
  if (!appPath) {
    return { ok: false, reason: 'missing-app' };
  }

  if (process.platform === 'darwin') {
    const args = background ? ['-g', '-a', appPath] : ['-a', appPath];
    const child = spawn('open', args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, appPath, alreadyRunning: isSwitchmanAppRunning() };
  }

  if (process.platform === 'linux') {
    const child = spawn(appPath, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, appPath };
  }

  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', appPath], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, appPath };
  }

  return { ok: false, reason: 'unsupported-platform' };
}

export function installSwitchmanMacApp({
  sourceBundle = resolveBuiltMacAppBundle(),
  destination = join(homedir(), 'Applications', 'Switchman.app'),
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('switchman board install currently supports macOS only');
  }

  if (!sourceBundle) {
    throw new Error('No built Switchman.app found. Run: cd desktop && npm run build');
  }

  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { force: true, recursive: true });
  cpSync(sourceBundle, destination, { recursive: true });
  return destination;
}
