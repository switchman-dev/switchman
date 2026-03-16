export function registerMonitorCommands(program, {
  chalk,
  clearMonitorState,
  getDb,
  getRepo,
  isProcessRunning,
  monitorWorktreesOnce,
  processExecPath,
  readMonitorState,
  renderMonitorEvent,
  resolveMonitoredWorktrees,
  spawn,
  startBackgroundMonitor,
}) {
  const monitorCmd = program.command('monitor').description('Observe workspaces for runtime file changes');
  monitorCmd._switchmanAdvanced = true;

  monitorCmd
    .command('once')
    .description('Capture one monitoring pass and log observed file changes')
    .option('--json', 'Output raw JSON')
    .option('--quarantine', 'Move or restore denied runtime changes immediately after detection')
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const worktrees = resolveMonitoredWorktrees(db, repoRoot);
      const result = monitorWorktreesOnce(db, repoRoot, worktrees, { quarantine: opts.quarantine });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.events.length === 0) {
        console.log(chalk.dim('No file changes observed since the last monitor snapshot.'));
        return;
      }

      console.log(`${chalk.green('✓')} Observed ${result.summary.total} file change(s)`);
      for (const event of result.events) {
        renderMonitorEvent(event);
      }
    });

  monitorCmd
    .command('watch')
    .description('Poll workspaces continuously and log observed file changes')
    .option('--interval-ms <ms>', 'Polling interval in milliseconds', '2000')
    .option('--quarantine', 'Move or restore denied runtime changes immediately after detection')
    .option('--daemonized', 'Internal flag used by monitor start', false)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const intervalMs = Number.parseInt(opts.intervalMs, 10);

      if (!Number.isFinite(intervalMs) || intervalMs < 100) {
        console.error(chalk.red('--interval-ms must be at least 100'));
        process.exit(1);
      }

      console.log(chalk.cyan(`Watching workspaces every ${intervalMs}ms. Press Ctrl+C to stop.`));

      let stopped = false;
      const stop = () => {
        stopped = true;
        process.stdout.write('\n');
        if (opts.daemonized) {
          clearMonitorState(repoRoot);
        }
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);

      while (!stopped) {
        const db = getDb(repoRoot);
        const worktrees = resolveMonitoredWorktrees(db, repoRoot);
        const result = monitorWorktreesOnce(db, repoRoot, worktrees, { quarantine: opts.quarantine });
        db.close();

        for (const event of result.events) {
          renderMonitorEvent(event);
        }

        if (stopped) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
      }

      console.log(chalk.dim('Stopped worktree monitor.'));
    });

  monitorCmd
    .command('start')
    .description('Start the worktree monitor as a background process')
    .option('--interval-ms <ms>', 'Polling interval in milliseconds', '2000')
    .option('--quarantine', 'Move or restore denied runtime changes immediately after detection')
    .action((opts) => {
      const repoRoot = getRepo();
      const intervalMs = Number.parseInt(opts.intervalMs, 10);
      const state = startBackgroundMonitor(repoRoot, {
        intervalMs,
        quarantine: Boolean(opts.quarantine),
      });

      if (state.already_running) {
        console.log(chalk.yellow(`Monitor already running with pid ${state.state.pid}`));
        return;
      }

      console.log(`${chalk.green('✓')} Started monitor pid ${chalk.cyan(String(state.state.pid))}`);
      console.log(`${chalk.dim('State:')} ${state.state_path}`);
    });

  monitorCmd
    .command('stop')
    .description('Stop the background worktree monitor')
    .action(() => {
      const repoRoot = getRepo();
      const state = readMonitorState(repoRoot);

      if (!state) {
        console.log(chalk.dim('Monitor is not running.'));
        return;
      }

      if (!isProcessRunning(state.pid)) {
        clearMonitorState(repoRoot);
        console.log(chalk.dim('Monitor state was stale and has been cleared.'));
        return;
      }

      process.kill(state.pid, 'SIGTERM');
      clearMonitorState(repoRoot);
      console.log(`${chalk.green('✓')} Stopped monitor pid ${chalk.cyan(String(state.pid))}`);
    });

  monitorCmd
    .command('status')
    .description('Show background monitor process status')
    .action(() => {
      const repoRoot = getRepo();
      const state = readMonitorState(repoRoot);

      if (!state) {
        console.log(chalk.dim('Monitor is not running.'));
        return;
      }

      const running = isProcessRunning(state.pid);
      if (!running) {
        clearMonitorState(repoRoot);
        console.log(chalk.yellow('Monitor state existed but the process is no longer running.'));
        return;
      }

      console.log(`${chalk.green('✓')} Monitor running`);
      console.log(`  ${chalk.dim('pid')} ${state.pid}`);
      console.log(`  ${chalk.dim('interval_ms')} ${state.interval_ms}`);
      console.log(`  ${chalk.dim('quarantine')} ${state.quarantine ? 'true' : 'false'}`);
      console.log(`  ${chalk.dim('started_at')} ${state.started_at}`);
    });

  program
    .command('watch')
    .description('Watch worktrees for direct writes and rogue edits in real time')
    .option('--interval-ms <ms>', 'Polling interval in milliseconds', '2000')
    .option('--quarantine', 'Move or restore denied runtime changes immediately after detection')
    .action(async (opts) => {
      const repoRoot = getRepo();
      const child = spawn(processExecPath, [
        process.argv[1],
        'monitor',
        'watch',
        '--interval-ms',
        String(opts.intervalMs || '2000'),
        ...(opts.quarantine ? ['--quarantine'] : []),
      ], {
        cwd: repoRoot,
        stdio: 'inherit',
      });

      await new Promise((resolve, reject) => {
        child.on('exit', (code) => {
          process.exitCode = code ?? 0;
          resolve();
        });
        child.on('error', reject);
      });
    });

  return monitorCmd;
}
