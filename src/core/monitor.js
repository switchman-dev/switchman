import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export function getMonitorStatePath(repoRoot) {
  return join(repoRoot, '.switchman', 'monitor.json');
}

export function readMonitorState(repoRoot) {
  const statePath = getMonitorStatePath(repoRoot);
  if (!existsSync(statePath)) return null;

  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeMonitorState(repoRoot, state) {
  const statePath = getMonitorStatePath(repoRoot);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

export function clearMonitorState(repoRoot) {
  const statePath = getMonitorStatePath(repoRoot);
  rmSync(statePath, { force: true });
}

export function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
