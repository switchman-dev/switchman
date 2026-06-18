import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const BOARD_AGENT_COMMANDS = {
  'claude-code': process.env.SWITCHMAN_AGENT_CLAUDE_CODE || 'claude',
  codex: process.env.SWITCHMAN_AGENT_CODEX || 'codex',
  gemini: process.env.SWITCHMAN_AGENT_GEMINI || 'gemini',
  aider: process.env.SWITCHMAN_AGENT_AIDER || 'aider',
};

export function defaultBoardRegistryPath() {
  return join(homedir(), '.switchman', 'sessions.json');
}

export function resolveBoardRegistryPath(registryPath = process.env.SWITCHMAN_SESSION_REGISTRY) {
  return resolve(registryPath || defaultBoardRegistryPath());
}

export function readRegistryUnlocked(path) {
  if (!existsSync(path)) return { sessions: [] };

  const text = readFileSync(path, 'utf8');
  const parsed = JSON.parse(text);

  if (Array.isArray(parsed)) return { sessions: parsed };
  if (Array.isArray(parsed.sessions)) return parsed;

  throw new Error(`registry must be an array or object with sessions[]: ${path}`);
}

export function writeRegistryUnlocked(path, registry) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify({ ...registry, sessions: registry.sessions }, null, 2)}\n`);
  renameSync(tmpPath, path);
}

export function withRegistryLock(path, fn) {
  const lockDir = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  acquireLock(lockDir);

  try {
    return fn();
  } finally {
    rmSync(lockDir, { force: true, recursive: true });
  }
}

function acquireLock(lockDir) {
  const deadline = Date.now() + Number(process.env.SWITCHMAN_LOCK_TIMEOUT_MS || 5000);
  let lastError;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EEXIST') throw error;
      sleep(50);
    }
  }

  throw new Error(`timed out waiting for registry lock: ${lockDir}${lastError ? ` (${lastError.message})` : ''}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function loadBoardSessions(registryPath) {
  return withRegistryLock(registryPath, () => {
    const registry = readRegistryUnlocked(registryPath);
    const sessions = registry.sessions.map((session) => hydrateBoardSession(session));
    const changed = reconcileSessionsLiveness(sessions);

    if (changed) {
      registry.sessions = sessions;
      writeRegistryUnlocked(registryPath, registry);
    }

    return sessions;
  });
}

export function updateBoardSession(path, sessionId, patch) {
  return withRegistryLock(path, () => {
    const registry = readRegistryUnlocked(path);
    const now = new Date().toISOString();

    registry.sessions = registry.sessions.map((session) =>
      session.id === sessionId ? { ...session, ...patch, updatedAt: now } : session,
    );

    writeRegistryUnlocked(path, registry);
  });
}

export function startBoardSession({
  task,
  agent = 'claude-code',
  baseRef = null,
  branchName = null,
  registryPath = resolveBoardRegistryPath(),
  repoRoot,
  worktreesDir = null,
  noLaunch = false,
}) {
  if (!task?.trim()) {
    throw new Error('start requires a task name, for example: switchman board start "refactor cart total"');
  }

  if (!BOARD_AGENT_COMMANDS[agent]) {
    throw new Error(`unsupported agent "${agent}"`);
  }

  const repoName = repoRoot.split(/[\\/]/).filter(Boolean).at(-1) || 'repo';
  const resolvedBaseRef = baseRef || gitOutput(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const resolvedWorktreesDir =
    worktreesDir || join(dirname(repoRoot), '.switchman-worktrees', repoName);

  const prepared = withRegistryLock(registryPath, () => {
    const registry = readRegistryUnlocked(registryPath);
    const id = uniqueId(slugify(task), registry.sessions);
    const branch = branchName || `switchman/${id}`;
    const worktreePath = resolve(resolvedWorktreesDir, id);

    if (existsSync(worktreePath)) {
      throw new Error(`worktree path already exists: ${worktreePath}`);
    }

    mkdirSync(resolvedWorktreesDir, { recursive: true });
    git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, resolvedBaseRef]);

    const session = {
      id,
      taskName: task.trim(),
      agent,
      repoRoot,
      baseRef: resolvedBaseRef,
      worktreePath,
      branchName: branch,
      status: 'in-progress',
      filesTouched: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      registeredBy: 'cli',
    };

    registry.sessions = registry.sessions.filter((existing) => existing.id !== id);
    registry.sessions.push(session);
    writeRegistryUnlocked(registryPath, registry);
    return { branchName: branch, id, repoRoot, worktreePath };
  });

  const warnings = warnLiveSessions(registryPath, repoRoot, prepared.id);

  return {
    ...prepared,
    agent,
    taskName: task.trim(),
    registryPath,
    noLaunch,
    warnings,
  };
}

export async function launchBoardAgent({ agent, task, cwd, registryPath, sessionId }) {
  const command = BOARD_AGENT_COMMANDS[agent];
  const child = spawn(command, [task], {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });

  if (child.pid) {
    updateBoardSession(registryPath, sessionId, { agentPid: child.pid, status: 'in-progress' });
  }

  child.on('error', (error) => {
    updateBoardSession(registryPath, sessionId, { status: 'planning', agentPid: null });
    console.error(`switchman: failed to launch ${command}: ${error.message}`);
  });

  const code = await new Promise((resolveExit) => {
    child.on('exit', (exitCode) => resolveExit(exitCode ?? 0));
  });

  if (code === 0) {
    updateBoardSession(registryPath, sessionId, { status: 'review', agentPid: null });
  }

  return code;
}

export function mergeBoardSession({ sessionId, registryPath = resolveBoardRegistryPath(), force = false }) {
  const sessions = loadBoardSessions(registryPath);
  const session = sessions.find((candidate) => candidate.id === sessionId);

  if (!session) {
    throw new Error(`session not found: ${sessionId}`);
  }

  const blockers = activeBlockers(session, sessions);

  if (blockers.length && !force) {
    return { ok: false, blockers, session };
  }

  finalizeMerge(session);

  updateBoardSession(registryPath, session.id, {
    status: 'done',
    filesTouched: session.filesTouched,
    mergedAt: new Date().toISOString(),
    agentPid: null,
  });

  return { ok: true, session };
}

export function setBoardSessionStatus({ sessionId, status, registryPath = resolveBoardRegistryPath() }) {
  updateBoardSession(registryPath, sessionId, { status, agentPid: null });
}

export function hydrateBoardSession(session) {
  const filesTouched = touchedFiles(session.worktreePath, session.filesTouched || []);
  const live = isSessionLive({ ...session, filesTouched });
  return { ...session, filesTouched, live };
}

function warnLiveSessions(registryPath, repoRoot, excludingId) {
  return withRegistryLock(registryPath, () => {
    const registry = readRegistryUnlocked(registryPath);
    const warnings = [];

    for (const session of registry.sessions.map((entry) => hydrateBoardSession(entry))) {
      if (session.id === excludingId || session.repoRoot !== repoRoot || !isSessionLive(session)) continue;

      const file = (session.filesTouched || []).map(normalizedOverlapFile).find(Boolean);
      if (!file) continue;

      warnings.push({
        file,
        agent: session.agent,
        taskName: session.taskName,
        message: `Heads up: ${file} is already in play — ${agentLabel(session.agent)} is still editing it for ${session.taskName}.`,
      });
    }

    return warnings;
  });
}

function touchedFiles(worktreePath, fallback) {
  if (!worktreePath) return fallback;

  try {
    const files = [
      ...gitOutput(worktreePath, ['diff', '--name-only', 'HEAD']).split('\n'),
      ...gitOutput(worktreePath, ['ls-files', '--others', '--exclude-standard']).split('\n'),
    ]
      .map((file) => file.trim())
      .filter(Boolean);

    return [...new Set(files)].sort();
  } catch {
    return fallback;
  }
}

function finalizeMerge(session) {
  if (!session.repoRoot) {
    throw new Error(`session ${session.id} is missing repoRoot; cannot perform git merge`);
  }
  if (!session.worktreePath) {
    throw new Error(`session ${session.id} is missing worktreePath; cannot perform git merge`);
  }
  if (!session.branchName) {
    throw new Error(`session ${session.id} is missing branchName; cannot perform git merge`);
  }

  const baseRef = session.baseRef || 'main';
  ensureClean(session.repoRoot, 'target repository');
  commitWorktreeChanges(session);
  ensureClean(session.repoRoot, 'target repository');

  git(session.repoRoot, ['checkout', baseRef]);
  ensureClean(session.repoRoot, 'target repository');
  git(session.repoRoot, [
    'merge',
    '--no-ff',
    session.branchName,
    '-m',
    `Switchman merge: ${session.taskName || session.id}`,
  ]);
}

function commitWorktreeChanges(session) {
  const files = touchedFiles(session.worktreePath, []);
  if (!files.length) return;

  git(session.worktreePath, ['add', '-A']);

  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], {
    cwd: session.worktreePath,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  if (staged.status === 0) return;
  if (staged.status !== 1) {
    throw new Error((staged.stderr || staged.stdout || 'failed to inspect staged changes').trim());
  }

  git(session.worktreePath, ['commit', '-m', `Switchman: ${session.taskName || session.id}`]);
}

function ensureClean(cwd, label) {
  const status = gitOutput(cwd, ['status', '--porcelain']);
  if (status) {
    throw new Error(`${label} has uncommitted changes; refusing to merge`);
  }
}

function activeBlockers(session, sessions) {
  if (!canOverlap(session)) return [];

  const files = new Set((session.filesTouched || []).map(normalizedOverlapFile).filter(Boolean));
  const blockers = [];

  for (const other of sessions) {
    if (other.id === session.id || !canOverlap(other) || !isSessionLive(other)) continue;

    const sharedFiles = (other.filesTouched || [])
      .map(normalizedOverlapFile)
      .filter((file) => file && files.has(file));

    if (sharedFiles.length) {
      blockers.push({
        id: other.id,
        taskName: other.taskName,
        agent: other.agent,
        sharedFiles: [...new Set(sharedFiles)].sort(),
      });
    }
  }

  return blockers;
}

function activityGraceMs() {
  const fromEnv = Number(process.env.SWITCHMAN_ACTIVITY_GRACE_SECS);
  const seconds = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 60 * 60;
  return seconds * 1000;
}

export function isSessionLive(session) {
  if (normalizeStatus(session.status) !== 'inprogress') return false;

  if (session.agentPid) {
    return processExists(session.agentPid);
  }

  return worktreeRecentlyActive(session.worktreePath, session.filesTouched || []);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function worktreeRecentlyActive(worktreePath, files) {
  if (!worktreePath || !existsSync(worktreePath)) return false;

  const threshold = Date.now() - activityGraceMs();

  for (const file of files) {
    const fullPath = join(worktreePath, file);
    if (!existsSync(fullPath)) continue;
    if (statSync(fullPath).mtimeMs >= threshold) return true;
  }

  return false;
}

function reconcileSessionsLiveness(sessions) {
  let changed = false;

  for (const session of sessions) {
    if (normalizeStatus(session.status) === 'inprogress' && session.agentPid && !processExists(session.agentPid)) {
      session.status = 'review';
      session.agentPid = null;
      session.live = false;
      changed = true;
      continue;
    }

    session.live = isSessionLive(session);
  }

  return changed;
}

export function agentLabel(agent) {
  switch (agent) {
    case 'claude-code':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'aider':
      return 'Aider';
    default:
      return 'Another agent';
  }
}

function canOverlap(session) {
  const status = normalizeStatus(session.status);
  return (
    status !== 'planning' &&
    status !== 'done' &&
    (session.filesTouched || []).some((file) => normalizedOverlapFile(file))
  );
}

function normalizedOverlapFile(file) {
  const normalized = String(file || '').trim().replaceAll('\\', '/');

  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('/../') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    isIgnoredOverlapFile(normalized)
  ) {
    return null;
  }

  return normalized;
}

function isIgnoredOverlapFile(file) {
  const lower = file.toLowerCase();
  const name = lower.split('/').at(-1);

  return (
    [
      '.ds_store',
      'thumbs.db',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'cargo.lock',
    ].includes(name) ||
    lower.startsWith('node_modules/') ||
    lower.startsWith('dist/') ||
    lower.startsWith('build/') ||
    lower.startsWith('target/') ||
    lower.startsWith('.git/') ||
    lower.endsWith('.log') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.map') ||
    lower.endsWith('.lock')
  );
}

function normalizeStatus(status) {
  return String(status || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function uniqueId(base, sessions) {
  const existing = new Set(sessions.map((session) => session.id));
  if (!existing.has(base)) return base;

  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || `task-${Date.now()}`;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  }
  return result;
}

function gitOutput(cwd, args) {
  return git(cwd, args).stdout.trim();
}
