import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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
    mkdirSync(join(configPath, '..'), { recursive: true });
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
