import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function upsertClaudeStopHook(repoRoot, { command = 'switchman agent-complete --source claude-code --quiet --confirm-clean 3' } = {}) {
  const settingsPath = join(repoRoot, '.claude', 'settings.local.json');
  const settings = readJsonFile(settingsPath, {});
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const stopHooks = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const hookEntry = {
    matcher: '',
    hooks: [{ type: 'command', command }],
  };
  const alreadyInstalled = stopHooks.some((entry) =>
    Array.isArray(entry?.hooks)
      && entry.hooks.some((hook) => hook?.type === 'command' && hook?.command === command),
  );

  if (!alreadyInstalled) {
    stopHooks.push(hookEntry);
  }

  const nextSettings = {
    ...settings,
    hooks: {
      ...hooks,
      Stop: stopHooks,
    },
  };

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, 'utf8');

  return {
    path: settingsPath,
    changed: !alreadyInstalled,
    command,
  };
}

export function registerClaudeCommands(program, {
  chalk,
  getRepo,
  join,
  renderClaudeGuide,
}) {
  const claudeCmd = program.command('claude').description('Generate or refresh Claude Code instructions for this repo');

  claudeCmd
    .command('refresh')
    .description('Generate a repo-aware CLAUDE.md for this repository')
    .option('--print', 'Print the generated guide instead of writing CLAUDE.md')
    .addHelpText('after', `
Examples:
  switchman claude refresh
  switchman claude refresh --print
`)
    .action((opts) => {
      const repoRoot = getRepo();
      const claudeGuidePath = join(repoRoot, 'CLAUDE.md');
      const content = renderClaudeGuide(repoRoot);

      if (opts.print) {
        process.stdout.write(content);
        return;
      }

      const existed = existsSync(claudeGuidePath);
      writeFileSync(claudeGuidePath, content, 'utf8');
      console.log(`${chalk.green('✓')} ${existed ? 'Refreshed' : 'Created'} ${chalk.cyan(claudeGuidePath)}`);
      console.log(`  ${chalk.dim('next:')} ${chalk.cyan('switchman verify-setup')}`);
    });

  const hooksCmd = claudeCmd.command('hooks').description('Manage Claude Code hooks for Switchman');

  hooksCmd
    .command('install')
    .description('Install a Claude Code Stop hook that runs Switchman when an agent session ends')
    .option('--command <command>', 'Hook command to run on Claude Code Stop')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Examples:
  switchman claude hooks install
  switchman claude hooks install --command "switchman agent-complete --source claude-code --quiet --confirm-clean 3"
`)
    .action((opts) => {
      const repoRoot = getRepo();
      const result = upsertClaudeStopHook(repoRoot, { command: opts.command });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Claude Code Stop hook ${result.changed ? 'installed' : 'already installed'}`);
      console.log(`  ${chalk.dim('path:')} ${chalk.cyan(result.path)}`);
      console.log(`  ${chalk.dim('runs:')} ${chalk.cyan(result.command)}`);
    });

  return claudeCmd;
}
