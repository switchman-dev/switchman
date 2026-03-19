export function registerLeaseCommands(program, {
  acquireNextTaskLeaseViaCoordination,
  chalk,
  getCurrentWorktreeName,
  getDb,
  getRepo,
  getTask,
  heartbeatLease,
  listLeasesViaCoordination,
  loadLeasePolicy,
  pushSyncEvent,
  reapStaleLeases,
  startTaskLeaseViaCoordination,
  statusBadge,
  taskJsonWithLease,
  writeLeasePolicy,
}) {
  const leaseCmd = program.command('lease').alias('session').description('Manage active work sessions and keep long-running tasks alive');
  leaseCmd.addHelpText('after', `
Plain English:
  lease = a task currently checked out by an agent

Examples:
  switchman lease next --json
  switchman lease heartbeat lease-123
  switchman lease reap
`);

  leaseCmd
    .command('acquire <taskId> <worktree>')
    .description('Start a tracked work session for a specific pending task')
    .option('--agent <name>', 'Agent identifier for logging')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  switchman lease acquire task-123 agent2
  switchman lease acquire task-123 agent2 --agent cursor
`)
    .action(async (taskId, worktree, opts) => {
      const repoRoot = getRepo();
      const { task, lease } = await startTaskLeaseViaCoordination(repoRoot, {
        taskId,
        worktree,
        agent: opts.agent || null,
      });

      if (!lease || !task) {
        if (opts.json) console.log(JSON.stringify({ lease: null, task: null }));
        else console.log(chalk.red('Could not start a work session. The task may not exist or may already be in progress.'));
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify({
          lease,
          task: taskJsonWithLease(task, worktree, lease).task,
        }, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Lease acquired ${chalk.dim(lease.id)}`);
      console.log(`  ${chalk.dim('task:')} ${chalk.bold(task.title)}`);
      console.log(`  ${chalk.dim('worktree:')} ${chalk.cyan(worktree)}`);
    });

  leaseCmd
    .command('next')
    .description('Start the next pending task and open a tracked work session for it')
    .option('--json', 'Output as JSON')
    .option('--worktree <name>', 'Workspace to assign the task to (defaults to the current folder name)')
    .option('--agent <name>', 'Agent identifier for logging')
    .addHelpText('after', `
Examples:
  switchman lease next
  switchman lease next --json
  switchman lease next --worktree agent2 --agent cursor
`)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const worktreeName = getCurrentWorktreeName(opts.worktree);
      const { task, lease, exhausted } = await acquireNextTaskLeaseViaCoordination(repoRoot, worktreeName, opts.agent || null);

      if (!task) {
        if (opts.json) console.log(JSON.stringify({ task: null, lease: null }));
        else if (exhausted) console.log(chalk.dim('No pending tasks. Add one with `switchman task add "Your task"`.'));
        else console.log(chalk.yellow('Tasks were claimed by other agents during assignment. Run again to get the next one.'));
        return;
      }

      if (!lease) {
        if (opts.json) console.log(JSON.stringify({ task: null, lease: null, message: 'Task claimed by another agent — try again' }));
        else console.log(chalk.yellow('Task was just claimed by another agent. Run again to get the next one.'));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify({
          lease,
          ...taskJsonWithLease(task, worktreeName, lease),
        }, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Lease acquired: ${chalk.bold(task.title)}`);
      pushSyncEvent('lease_acquired', { task_id: task.id, title: task.title }, { worktree: worktreeName }).catch(() => {});
      console.log(`  ${chalk.dim('task:')} ${task.id}  ${chalk.dim('lease:')} ${lease.id}`);
      console.log(`  ${chalk.dim('worktree:')} ${chalk.cyan(worktreeName)}  ${chalk.dim('priority:')} ${task.priority}`);
    });

  leaseCmd
    .command('list')
    .description('List leases, newest first')
    .option('-s, --status <status>', 'Filter by status (active|completed|failed|expired)')
    .action(async (opts) => {
      const repoRoot = getRepo();
      let leases;
      try {
        ({ leases } = await listLeasesViaCoordination(repoRoot, opts.status || null));
      } catch (err) {
        console.log(chalk.red(err.message));
        process.exitCode = 1;
        return;
      }

      if (!leases.length) {
        console.log(chalk.dim('No leases found.'));
        return;
      }

      console.log('');
      for (const lease of leases) {
        console.log(`${statusBadge(lease.status)} ${chalk.bold(lease.task_title)}`);
        console.log(`  ${chalk.dim('lease:')} ${lease.id}  ${chalk.dim('task:')} ${lease.task_id}`);
        console.log(`  ${chalk.dim('worktree:')} ${chalk.cyan(lease.worktree)}  ${chalk.dim('agent:')} ${lease.agent || 'unknown'}`);
        console.log(`  ${chalk.dim('started:')} ${lease.started_at}  ${chalk.dim('heartbeat:')} ${lease.heartbeat_at}`);
        if (lease.failure_reason) console.log(`  ${chalk.red(lease.failure_reason)}`);
        console.log('');
      }
    });

  leaseCmd
    .command('heartbeat <leaseId>')
    .description('Refresh the heartbeat timestamp for an active lease')
    .option('--agent <name>', 'Agent identifier for logging')
    .option('--json', 'Output as JSON')
    .action((leaseId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const lease = heartbeatLease(db, leaseId, opts.agent || null);
      db.close();

      if (!lease) {
        if (opts.json) console.log(JSON.stringify({ lease: null }));
        else console.log(chalk.red(`No active work session found for ${leaseId}.`));
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify({ lease }, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Heartbeat refreshed for ${chalk.dim(lease.id)}`);
      console.log(`  ${chalk.dim('task:')} ${lease.task_title}  ${chalk.dim('worktree:')} ${chalk.cyan(lease.worktree)}`);
    });

  leaseCmd
    .command('reap')
    .description('Clean up abandoned work sessions and release their file locks')
    .option('--stale-after-minutes <minutes>', 'Age threshold for staleness')
    .option('--json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  switchman lease reap
  switchman lease reap --stale-after-minutes 20
`)
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const leasePolicy = loadLeasePolicy(repoRoot);
      const staleAfterMinutes = opts.staleAfterMinutes
        ? Number.parseInt(opts.staleAfterMinutes, 10)
        : leasePolicy.stale_after_minutes;
      const expired = reapStaleLeases(db, staleAfterMinutes, {
        requeueTask: leasePolicy.requeue_task_on_reap,
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify({ stale_after_minutes: staleAfterMinutes, expired }, null, 2));
        return;
      }

      if (!expired.length) {
        console.log(chalk.dim(`No stale leases older than ${staleAfterMinutes} minute(s).`));
        return;
      }

      console.log(`${chalk.green('✓')} Reaped ${expired.length} stale lease(s)`);
      for (const lease of expired) {
        console.log(`  ${chalk.dim(lease.id)}  ${chalk.cyan(lease.worktree)} → ${lease.task_title}`);
      }
    });

  const leasePolicyCmd = leaseCmd.command('policy').description('Inspect or update the stale-lease policy for this repo');

  leasePolicyCmd
    .command('set')
    .description('Persist a stale-lease policy for this repo')
    .option('--heartbeat-interval-seconds <seconds>', 'Recommended heartbeat interval')
    .option('--stale-after-minutes <minutes>', 'Age threshold for staleness')
    .option('--reap-on-status-check <boolean>', 'Automatically reap stale leases during `switchman status`')
    .option('--requeue-task-on-reap <boolean>', 'Return stale tasks to pending instead of failing them')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const current = loadLeasePolicy(repoRoot);
      const next = {
        ...current,
        ...(opts.heartbeatIntervalSeconds ? { heartbeat_interval_seconds: Number.parseInt(opts.heartbeatIntervalSeconds, 10) } : {}),
        ...(opts.staleAfterMinutes ? { stale_after_minutes: Number.parseInt(opts.staleAfterMinutes, 10) } : {}),
        ...(opts.reapOnStatusCheck ? { reap_on_status_check: opts.reapOnStatusCheck === 'true' } : {}),
        ...(opts.requeueTaskOnReap ? { requeue_task_on_reap: opts.requeueTaskOnReap === 'true' } : {}),
      };
      const path = writeLeasePolicy(repoRoot, next);
      const saved = loadLeasePolicy(repoRoot);

      if (opts.json) {
        console.log(JSON.stringify({ path, policy: saved }, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Lease policy updated`);
      console.log(`  ${chalk.dim(path)}`);
      console.log(`  ${chalk.dim('heartbeat_interval_seconds:')} ${saved.heartbeat_interval_seconds}`);
      console.log(`  ${chalk.dim('stale_after_minutes:')} ${saved.stale_after_minutes}`);
      console.log(`  ${chalk.dim('reap_on_status_check:')} ${saved.reap_on_status_check}`);
      console.log(`  ${chalk.dim('requeue_task_on_reap:')} ${saved.requeue_task_on_reap}`);
    });

  leasePolicyCmd
    .description('Show the active stale-lease policy for this repo')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const policy = loadLeasePolicy(repoRoot);
      if (opts.json) {
        console.log(JSON.stringify({ policy }, null, 2));
        return;
      }

      console.log(chalk.bold('Lease policy'));
      console.log(`  ${chalk.dim('heartbeat_interval_seconds:')} ${policy.heartbeat_interval_seconds}`);
      console.log(`  ${chalk.dim('stale_after_minutes:')} ${policy.stale_after_minutes}`);
      console.log(`  ${chalk.dim('reap_on_status_check:')} ${policy.reap_on_status_check}`);
      console.log(`  ${chalk.dim('requeue_task_on_reap:')} ${policy.requeue_task_on_reap}`);
    });

  return leaseCmd;
}
