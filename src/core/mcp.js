import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export function getSwitchmanMcpServers() {
  return {
    switchman: {
      command: 'switchman-mcp',
      args: [],
    },
  };
}

export function getSwitchmanMcpConfig() {
  return {
    mcpServers: getSwitchmanMcpServers(),
  };
}

function upsertMcpConfigFile(configPath) {
  let config = {};
  let created = true;

  if (existsSync(configPath)) {
    created = false;
    const raw = readFileSync(configPath, 'utf8').trim();
    config = raw ? JSON.parse(raw) : {};
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  const nextConfig = {
    ...config,
    mcpServers: {
      ...(config.mcpServers || {}),
      ...getSwitchmanMcpServers(),
    },
  };

  const before = JSON.stringify(config);
  const after = JSON.stringify(nextConfig);
  const changed = before !== after;

  if (changed) {
    writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  }

  return {
    path: configPath,
    created,
    changed,
  };
}

export function ensureProjectLocalMcpGitExcludes(repoRoot) {
  const excludePath = join(repoRoot, '.git', 'info', 'exclude');
  const requiredEntries = ['.mcp.json', '.cursor/mcp.json'];
  let existing = '';

  try {
    if (existsSync(excludePath)) {
      existing = readFileSync(excludePath, 'utf8');
    } else {
      mkdirSync(dirname(excludePath), { recursive: true });
    }
  } catch {
    return {
      path: excludePath,
      changed: false,
      managed: false,
    };
  }

  const lines = existing.split('\n').map((line) => line.trim());
  const missing = requiredEntries.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) {
    return {
      path: excludePath,
      changed: false,
      managed: true,
    };
  }

  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const next = `${existing}${prefix}${missing.join('\n')}\n`;
  writeFileSync(excludePath, next);
  return {
    path: excludePath,
    changed: true,
    managed: true,
  };
}

export function upsertCursorProjectMcpConfig(targetDir) {
  return upsertMcpConfigFile(join(targetDir, '.cursor', 'mcp.json'));
}

export function upsertAllProjectMcpConfigs(targetDir) {
  return [
    upsertProjectMcpConfig(targetDir),
    upsertCursorProjectMcpConfig(targetDir),
  ];
}

export function upsertProjectMcpConfig(targetDir) {
  return upsertMcpConfigFile(join(targetDir, '.mcp.json'));
}

export function getWindsurfMcpConfigPath(homeDir = homedir()) {
  return join(homeDir, '.codeium', 'mcp_config.json');
}

export function upsertWindsurfMcpConfig(homeDir = homedir()) {
  return upsertMcpConfigFile(getWindsurfMcpConfigPath(homeDir));
}
