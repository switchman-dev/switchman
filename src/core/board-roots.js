import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export function defaultBoardRootsPath() {
  if (process.env.SWITCHMAN_BOARD_ROOTS_FILE) {
    return resolve(process.env.SWITCHMAN_BOARD_ROOTS_FILE);
  }
  return join(homedir(), '.switchman', 'board-roots.json');
}

export function readBoardRoots(path = defaultBoardRootsPath()) {
  if (!existsSync(path)) return [];

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const repos = Array.isArray(parsed) ? parsed : parsed.repos;
    if (!Array.isArray(repos)) return [];
    return [...new Set(repos.map((repo) => resolve(repo)).filter(Boolean))];
  } catch {
    return [];
  }
}

export function rememberBoardRepo(repoRoot, path = defaultBoardRootsPath()) {
  if (!repoRoot) return readBoardRoots(path);

  const normalized = resolve(repoRoot);
  const repos = readBoardRoots(path);
  if (!repos.includes(normalized)) {
    repos.push(normalized);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ repos }, null, 2)}\n`);
  return repos;
}

export function collectBoardRepoRoots(registrySessions = [], extraRoots = [], { includeTracked = true } = {}) {
  const repos = new Set([
    ...extraRoots.map((repo) => resolve(repo)),
    ...registrySessions
      .map((session) => session.repoRoot)
      .filter(Boolean)
      .map((repo) => resolve(repo)),
  ]);

  if (includeTracked) {
    for (const repo of readBoardRoots()) {
      repos.add(repo);
    }
  }

  return [...repos];
}
