import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export function getSwitchmanMcpConfig() {
  return {
    mcpServers: {
      switchman: {
        command: 'switchman-mcp',
        args: [],
      },
    },
  };
}

export function upsertProjectMcpConfig(targetDir) {
  const configPath = join(targetDir, '.mcp.json');
  let config = {};
  let created = true;

  if (existsSync(configPath)) {
    created = false;
    const raw = readFileSync(configPath, 'utf8').trim();
    config = raw ? JSON.parse(raw) : {};
  }

  const nextConfig = {
    ...config,
    mcpServers: {
      ...(config.mcpServers || {}),
      ...getSwitchmanMcpConfig().mcpServers,
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
