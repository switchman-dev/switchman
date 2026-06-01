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
  scanAllWorktrees,
  spawn,
  startBackgroundMonitor,
  getWorktreeSnapshotState,
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
    .description('Poll workspaces continuously, then scan automatically when worktrees go quiet')
    .option('--interval-ms <ms>', 'Polling interval in milliseconds', '2000')
    .option('--quiet-ms <ms>', 'How long worktrees must be quiet before triggering a scan', '5000')
    .option('--max-cycles <n>', 'Maximum watch cycles before exiting (mainly for tests)', '0')
    .option('--quarantine', 'Move or restore denied runtime changes immediately after detection')
    .option('--json', 'Output quiet-triggered scans as JSON')
    .option('--daemonized', 'Internal flag used by monitor start', false)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const intervalMs = Number.parseInt(opts.intervalMs, 10);
      const quietMs = Number.parseInt(opts.quietMs, 10);
      const maxCycles = Math.max(0, Number.parseInt(opts.maxCycles, 10) || 0);

      if (!Number.isFinite(intervalMs) || intervalMs < 100) {
        console.error(chalk.red('--interval-ms must be at least 100'));
        process.exit(1);
      }
      if (!Number.isFinite(quietMs) || quietMs < 0) {
        console.error(chalk.red('--quiet-ms must be zero or greater'));
        process.exit(1);
      }

      if (!opts.json) {
        console.log(chalk.cyan(`Watching workspaces every ${intervalMs}ms. Quiet scan after ${quietMs}ms. Press Ctrl+C to stop.`));
      }

      let stopped = false;
      let cycles = 0;
      let lastActivityAt = null;
      let quietScanDone = false;
      const stop = () => {
        stopped = true;
        if (!opts.json) process.stdout.write('\n');
        if (opts.daemonized) {
          clearMonitorState(repoRoot);
        }
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);

      while (!stopped) {
        const db = getDb(repoRoot);
        const worktrees = resolveMonitoredWorktrees(db, repoRoot);
        const hadSnapshots = typeof getWorktreeSnapshotState === 'function'
          && worktrees.some((worktree) => getWorktreeSnapshotState(db, worktree.name).size > 0);
        const result = monitorWorktreesOnce(db, repoRoot, worktrees, { quarantine: opts.quarantine });
        cycles += 1;

        if (result.events.length > 0 && (cycles > 1 || hadSnapshots)) {
          lastActivityAt = Date.now();
          quietScanDone = false;
        }

        if (!opts.json) {
          for (const event of result.events) {
            renderMonitorEvent(event);
          }
        }

        const quietForMs = lastActivityAt == null ? 0 : Date.now() - lastActivityAt;
        if (lastActivityAt != null && !quietScanDone && quietForMs >= quietMs) {
          const report = await scanAllWorktrees(db, repoRoot);
          quietScanDone = true;

          if (opts.json) {
            console.log(JSON.stringify({
              event: 'quiet_scan',
              cycles,
              quiet_ms: quietForMs,
              report,
            }, null, 2));
          } else {
            const hasIssues = report.conflicts.length > 0
              || report.fileConflicts.length > 0
              || (report.ownershipConflicts?.length || 0) > 0
              || (report.semanticConflicts?.length || 0) > 0
              || report.unclaimedChanges.length > 0;
            const color = hasIssues ? chalk.yellow : chalk.green;
            console.log(color(`✓ Worktrees quiet for ${quietForMs}ms; Switchman scan complete.`));
            console.log(`  ${chalk.dim(report.summary)}`);
          }
        }

        db.close();
        if (stopped) break;
        if (maxCycles > 0 && cycles >= maxCycles) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
      }

      if (!opts.json) {
        console.log(chalk.dim('Stopped worktree monitor.'));
      }
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
    .option('--quiet-ms <ms>', 'How long worktrees must be quiet before triggering a scan', '5000')
    .option('--max-cycles <n>', 'Maximum watch cycles before exiting (mainly for tests)', '0')
    .option('--quarantine', 'Move or restore denied runtime changes immediately after detection')
    .option('--json', 'Output quiet-triggered scans as JSON')
    .action(async (opts) => {
      const repoRoot = getRepo();
      const child = spawn(processExecPath, [
        process.argv[1],
        'monitor',
        'watch',
        '--interval-ms',
        String(opts.intervalMs || '2000'),
        '--quiet-ms',
        String(opts.quietMs || '5000'),
        ...(opts.maxCycles ? ['--max-cycles', String(opts.maxCycles)] : []),
        ...(opts.quarantine ? ['--quarantine'] : []),
        ...(opts.json ? ['--json'] : []),
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
