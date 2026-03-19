export function registerSchedulerCommands(program, {
  chalk,
  clearSchedulerState,
  dispatchReadyTasksViaCoordination,
  getRepo,
  isProcessRunning,
  processExecPath,
  readSchedulerState,
  spawn,
  startBackgroundScheduler,
}) {
  const schedulerCmd = program.command('scheduler').description('Automatically dispatch ready tasks onto idle agent workspaces');

  schedulerCmd
    .command('once')
    .description('Run one safe scheduling pass')
    .option('--agent <name>', 'Agent identifier to record on created leases', 'switchman-scheduler')
    .option('--limit <n>', 'Maximum assignments to create in this pass')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const repoRoot = getRepo();
      const result = await dispatchReadyTasksViaCoordination(repoRoot, {
        agentName: opts.agent,
        limit: opts.limit ? Number.parseInt(opts.limit, 10) : null,
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.assignments.length === 0) {
        if (result.ready_task_count === 0) {
          console.log(chalk.dim('No dependency-ready tasks to schedule right now.'));
        } else if (result.available_worktree_count === 0) {
          console.log(chalk.dim('No idle agent workspaces are available right now.'));
        } else {
          console.log(chalk.dim('Ready tasks were unavailable by the time the scheduler tried to lease them.'));
        }
        return;
      }

      console.log(`${chalk.green('✓')} Scheduled ${result.assignments.length} task(s)`);
      for (const assignment of result.assignments) {
        console.log(`  ${chalk.cyan(assignment.worktree)} ← ${assignment.title} ${chalk.dim(`(${assignment.task_id})`)}`);
      }
    });

  schedulerCmd
    .command('watch')
    .description('Poll for idle workspaces and dependency-ready tasks continuously')
    .option('--interval-ms <ms>', 'Polling interval in milliseconds', '2000')
    .option('--agent <name>', 'Agent identifier to record on created leases', 'switchman-scheduler')
    .option('--daemonized', 'Internal flag used by scheduler start', false)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const intervalMs = Number.parseInt(opts.intervalMs, 10);

      if (!Number.isFinite(intervalMs) || intervalMs < 100) {
        console.error(chalk.red('--interval-ms must be at least 100'));
        process.exit(1);
      }

      if (!opts.daemonized) {
        console.log(chalk.cyan(`Watching for idle agents every ${intervalMs}ms. Press Ctrl+C to stop.`));
      }

      let stopped = false;
      const stop = () => {
        stopped = true;
        process.stdout.write('\n');
        if (opts.daemonized) {
          clearSchedulerState(repoRoot);
        }
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);

      while (!stopped) {
        const result = await dispatchReadyTasksViaCoordination(repoRoot, { agentName: opts.agent });

        if (!opts.daemonized) {
          for (const assignment of result.assignments) {
            console.log(`${chalk.green('✓')} ${chalk.cyan(assignment.worktree)} picked up ${assignment.title} ${chalk.dim(`(${assignment.task_id})`)}`);
          }
        }

        if (stopped) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
      }

      if (!opts.daemonized) {
        console.log(chalk.dim('Stopped scheduler.'));
      }
    });

  schedulerCmd
    .command('start')
    .description('Start the background scheduler')
    .option('--interval-ms <ms>', 'Polling interval in milliseconds', '2000')
    .option('--agent <name>', 'Agent identifier to record on created leases', 'switchman-scheduler')
    .action((opts) => {
      const repoRoot = getRepo();
      const intervalMs = Number.parseInt(opts.intervalMs, 10);
      const state = startBackgroundScheduler(repoRoot, {
        intervalMs,
        agentName: opts.agent,
      });

      if (state.already_running) {
        console.log(chalk.yellow(`Scheduler already running with pid ${state.state.pid}`));
        return;
      }

      console.log(`${chalk.green('✓')} Started scheduler pid ${chalk.cyan(String(state.state.pid))}`);
      console.log(`${chalk.dim('State:')} ${state.state_path}`);
    });

  schedulerCmd
    .command('stop')
    .description('Stop the background scheduler')
    .action(() => {
      const repoRoot = getRepo();
      const state = readSchedulerState(repoRoot);

      if (!state) {
        console.log(chalk.dim('Scheduler is not running.'));
        return;
      }

      if (!isProcessRunning(state.pid)) {
        clearSchedulerState(repoRoot);
        console.log(chalk.dim('Scheduler state was stale and has been cleared.'));
        return;
      }

      process.kill(state.pid, 'SIGTERM');
      clearSchedulerState(repoRoot);
      console.log(`${chalk.green('✓')} Stopped scheduler pid ${chalk.cyan(String(state.pid))}`);
    });

  schedulerCmd
    .command('status')
    .description('Show background scheduler status')
    .action(() => {
      const repoRoot = getRepo();
      const state = readSchedulerState(repoRoot);

      if (!state) {
        console.log(chalk.dim('Scheduler is not running.'));
        return;
      }

      const running = isProcessRunning(state.pid);
      if (!running) {
        clearSchedulerState(repoRoot);
        console.log(chalk.yellow('Scheduler state existed but the process is no longer running.'));
        return;
      }

      console.log(`${chalk.green('✓')} Scheduler running`);
      console.log(`  ${chalk.dim('pid')} ${state.pid}`);
      console.log(`  ${chalk.dim('interval_ms')} ${state.interval_ms}`);
      console.log(`  ${chalk.dim('agent')} ${state.agent_name}`);
      console.log(`  ${chalk.dim('started_at')} ${state.started_at}`);
    });

  program
    .command('schedule')
    .description('Run one safe scheduling pass right now')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const child = spawn(processExecPath, [
        process.argv[1],
        'scheduler',
        'once',
        ...(opts.json ? ['--json'] : []),
      ], {
        cwd: repoRoot,
        stdio: 'inherit',
      });

      child.on('exit', (code) => {
        process.exitCode = code ?? 0;
      });
    });

  return schedulerCmd;
}
