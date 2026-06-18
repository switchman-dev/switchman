import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot } from '../../core/git.js';
import {
  installSwitchmanMacApp,
  openSwitchmanApp,
  resolveBuiltMacAppBundle,
} from '../../core/board-app.js';
import {
  agentLabel,
  BOARD_AGENT_COMMANDS,
  launchBoardAgent,
  loadBoardSessions,
  mergeBoardSession,
  resolveBoardRegistryPath,
  setBoardSessionStatus,
  startBoardSession,
} from '../../core/board-registry.js';
import { rememberBoardRepoFromCwd, syncDiscoveredWorktrees } from '../../core/board-discovery.js';
import { rememberBoardRepo } from '../../core/board-roots.js';

function getSwitchmanPackageRoot() {
  return resolve(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
}

function resolveDesktopDir() {
  return join(getSwitchmanPackageRoot(), 'desktop');
}

function resolveRepoRoot(repoOption) {
  try {
    return findRepoRoot(repoOption ? resolve(repoOption) : process.cwd());
  } catch (error) {
    throw new Error(error.message || 'Run this command inside a git repository, or pass --repo <path>.');
  }
}

function refreshBoardRegistry(registryPath, { repoRoots = [], rememberCwd = false } = {}) {
  if (rememberCwd) {
    const remembered = rememberBoardRepoFromCwd();
    if (remembered) {
      rememberBoardRepo(remembered);
    }
  }

  syncDiscoveredWorktrees(registryPath, { extraRepoRoots: repoRoots });
}

export function registerBoardCommands(program, { chalk, spawn }) {
  const boardCmd = program
    .command('board')
    .description('Desktop lane board: open the UI and manage parallel agent sessions');

  boardCmd
    .command('open', { isDefault: true, hidden: true })
    .description('Open the Switchman desktop board')
    .option('--dev', 'Run from source with npm run dev instead of the installed app')
    .action((opts) => {
      const registryPath = resolveBoardRegistryPath();
      refreshBoardRegistry(registryPath, { rememberCwd: true });

      const opened = openSwitchmanApp();
      if (opened.ok) {
        console.log(chalk.dim('Switchman is in the menu bar. The board opens when live file overlaps appear.'));
        console.log(chalk.dim(`Registry: ${registryPath}`));
        return;
      }

      const desktopDir = resolveDesktopDir();

      if (opts.dev && existsSync(desktopDir)) {
        if (!existsSync(join(desktopDir, 'node_modules'))) {
          console.error(chalk.red('Desktop dependencies are missing.'));
          console.error(`${chalk.yellow('next:')} cd ${desktopDir} && npm install`);
          process.exitCode = 1;
          return;
        }

        console.log(chalk.cyan('Starting Switchman desktop board (dev mode)...'));
        const child = spawn('npm', ['run', 'dev'], {
          cwd: desktopDir,
          env: process.env,
          stdio: 'inherit',
        });
        child.on('exit', (code) => {
          process.exitCode = code ?? 0;
        });
        return;
      }

      const builtBundle = resolveBuiltMacAppBundle();
      console.log('');
      console.log(chalk.bold('Switchman desktop board'));
      console.log('');
      if (process.platform === 'darwin') {
        console.log('Install the menu-bar app once, then run `switchman board` anytime:');
        console.log('');
        if (builtBundle) {
          console.log('  switchman board install');
        } else {
          console.log('  cd desktop && npm install && npm run build');
          console.log('  switchman board install');
        }
        console.log('');
        console.log('For source development:');
        console.log('  switchman board --dev');
      } else {
        console.log('Build the desktop app from this repo:');
        console.log('  cd desktop && npm install && npm run dev');
      }
      console.log('');
      console.log(chalk.dim(`Registry: ${registryPath}`));
      console.log(chalk.dim('Git worktrees in tracked repos are auto-registered — no board start required.'));
      console.log('');
    });

  boardCmd
    .command('install')
    .description('Install the built Switchman.app to ~/Applications (macOS)')
    .action(() => {
      try {
        const destination = installSwitchmanMacApp();
        console.log(`${chalk.green('✓')} Installed Switchman to ${destination}`);
        console.log(`${chalk.dim('next:')} switchman board`);
      } catch (error) {
        console.error(chalk.red(error.message));
        process.exitCode = 1;
      }
    });

  boardCmd
    .command('list')
    .description('List registered board sessions')
    .option('--registry <path>', 'Session registry path')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const registryPath = resolveBoardRegistryPath(opts.registry);
      refreshBoardRegistry(registryPath, { rememberCwd: true });
      const sessions = loadBoardSessions(registryPath);

      if (opts.json) {
        console.log(JSON.stringify({ registryPath, sessions }, null, 2));
        return;
      }

      if (!sessions.length) {
        console.log(chalk.dim('No parallel worktrees discovered yet.'));
        console.log(`${chalk.yellow('next:')} create git worktrees as usual, then run switchman board`);
        return;
      }

      console.log('');
      console.log(chalk.bold('Switchman board sessions'));
      console.log(chalk.dim(registryPath));
      console.log('');

      for (const session of sessions) {
        const live = session.live ? chalk.green('live') : chalk.dim('idle');
        const source = session.registeredBy === 'discovered' ? chalk.dim('auto') : chalk.dim('cli');
        console.log(`  ${chalk.bold(session.id)} ${chalk.dim(`[${session.status}]`)} ${live} ${source}`);
        console.log(`    ${session.taskName} · ${agentLabel(session.agent)}`);
        if (session.worktreePath) {
          console.log(chalk.dim(`    ${session.worktreePath}`));
        }
      }
      console.log('');
    });

  boardCmd
    .command('start <task...>')
    .description('Create a worktree, register a lane, and launch an agent')
    .option('--agent <name>', 'Agent launcher: claude-code, codex, gemini, or aider', 'claude-code')
    .option('--base <ref>', 'Base branch/ref for the worktree')
    .option('--branch <name>', 'Branch name to create')
    .option('--repo <path>', 'Repository to create the worktree from')
    .option('--registry <path>', 'Session registry path')
    .option('--worktrees-dir <path>', 'Directory for created worktrees')
    .option('--no-launch', 'Create/register the session without launching the agent')
    .addHelpText('after', `
Examples:
  switchman board start "refactor cart total" --agent claude-code
  switchman board start "fix checkout bug" --agent codex --no-launch

Git worktrees you create yourself are auto-registered. Use start only when you
want Switchman to create the worktree and launch an agent in one step.
`)
    .action(async (taskParts, opts) => {
      const task = taskParts.join(' ').trim();
      const repoRoot = resolveRepoRoot(opts.repo);
      const registryPath = resolveBoardRegistryPath(opts.registry);
      const noLaunch = opts.launch === false;

      refreshBoardRegistry(registryPath, { repoRoots: [repoRoot] });

      try {
        const started = startBoardSession({
          task,
          agent: opts.agent,
          baseRef: opts.base || null,
          branchName: opts.branch || null,
          registryPath,
          repoRoot,
          worktreesDir: opts.worktreesDir ? resolve(opts.worktreesDir) : null,
          noLaunch,
        });

        for (const warning of started.warnings) {
          console.error(chalk.yellow(warning.message));
        }

        console.log(`${chalk.green('✓')} Registered ${started.id}`);
        console.log(`  ${chalk.dim('worktree:')} ${started.worktreePath}`);
        console.log(`  ${chalk.dim('branch:')}   ${started.branchName}`);
        console.log(`  ${chalk.dim('registry:')} ${registryPath}`);

        if (started.noLaunch) {
          console.log(chalk.dim('Agent launch skipped (--no-launch).'));
          console.log(`${chalk.yellow('next:')} switchman board`);
          return;
        }

        if (!BOARD_AGENT_COMMANDS[started.agent]) {
          console.error(chalk.red(`unsupported agent "${started.agent}"`));
          process.exitCode = 1;
          return;
        }

        const code = await launchBoardAgent({
          agent: started.agent,
          task: started.taskName,
          cwd: started.worktreePath,
          registryPath,
          sessionId: started.id,
        });

        process.exitCode = code;
      } catch (error) {
        console.error(chalk.red(error.message));
        process.exitCode = 1;
      }
    });

  boardCmd
    .command('merge <sessionId>')
    .description('Merge a registered lane back into its base branch')
    .option('--registry <path>', 'Session registry path')
    .option('--force', 'Merge after checking shared files')
    .action((sessionId, opts) => {
      const registryPath = resolveBoardRegistryPath(opts.registry);
      refreshBoardRegistry(registryPath);

      try {
        const result = mergeBoardSession({
          sessionId,
          registryPath,
          force: Boolean(opts.force),
        });

        if (!result.ok) {
          console.error(chalk.red(`Switchman paused merge for "${result.session.taskName}".`));
          for (const blocker of result.blockers) {
            console.error(
              `- ${agentLabel(blocker.agent)} is still editing ${blocker.sharedFiles.join(', ')} for "${blocker.taskName || blocker.id}".`,
            );
          }
          console.error('Run again with --force if you have checked the files and still want to merge.');
          process.exitCode = 2;
          return;
        }

        console.log(`${chalk.green('✓')} Merged ${sessionId}`);
      } catch (error) {
        console.error(chalk.red(error.message));
        process.exitCode = 1;
      }
    });

  boardCmd
    .command('pause <sessionId>')
    .description('Mark a lane as paused')
    .option('--registry <path>', 'Session registry path')
    .action((sessionId, opts) => {
      try {
        refreshBoardRegistry(resolveBoardRegistryPath(opts.registry));
        setBoardSessionStatus({
          sessionId,
          status: 'paused',
          registryPath: resolveBoardRegistryPath(opts.registry),
        });
        console.log(`${chalk.green('✓')} Marked ${sessionId} as paused`);
      } catch (error) {
        console.error(chalk.red(error.message));
        process.exitCode = 1;
      }
    });

  boardCmd
    .command('done <sessionId>')
    .description('Mark a lane as ready for review')
    .option('--registry <path>', 'Session registry path')
    .action((sessionId, opts) => {
      try {
        refreshBoardRegistry(resolveBoardRegistryPath(opts.registry));
        setBoardSessionStatus({
          sessionId,
          status: 'review',
          registryPath: resolveBoardRegistryPath(opts.registry),
        });
        console.log(`${chalk.green('✓')} Marked ${sessionId} as review`);
      } catch (error) {
        console.error(chalk.red(error.message));
        process.exitCode = 1;
      }
    });
}
