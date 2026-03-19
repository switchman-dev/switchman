export function registerTaskCommands(program, {
  acquireNextTaskLeaseViaCoordination,
  analyzeTaskScope,
  chalk,
  completeTaskViaCoordination,
  createTaskViaCoordination,
  failTaskViaCoordination,
  getCurrentWorktreeName,
  getDb,
  getRepo,
  listTasks,
  printErrorWithNext,
  pushSyncEvent,
  releaseFileClaims,
  retryStaleTasks,
  retryTask,
  startTaskLeaseViaCoordination,
  statusBadge,
  taskJsonWithLease,
}) {
  const taskCmd = program.command('task').description('Manage the task list');
  taskCmd.addHelpText('after', `
Examples:
  switchman task add "Fix login bug" --priority 8
  switchman task list --status pending
  switchman task done task-123
`);

  taskCmd
    .command('add <title>')
    .description('Add a new task to the queue')
    .option('-d, --description <desc>', 'Task description')
    .option('-p, --priority <n>', 'Priority 1-10 (default 5)', '5')
    .option('--id <id>', 'Custom task ID')
    .action(async (title, opts) => {
      const repoRoot = getRepo();
      const result = await createTaskViaCoordination(repoRoot, {
        id: opts.id,
        title,
        description: opts.description,
        priority: parseInt(opts.priority),
      });
      const taskId = result.task.id;
      const scopeWarning = analyzeTaskScope(title, opts.description || '');
      console.log(`${chalk.green('✓')} Task created: ${chalk.cyan(taskId)}`);
      pushSyncEvent('task_added', { task_id: taskId, title, priority: parseInt(opts.priority) }).catch(() => {});
      console.log(`  ${chalk.dim(title)}`);
      if (scopeWarning) {
        console.log(chalk.yellow(`  warning: ${scopeWarning.summary}`));
        console.log(chalk.yellow(`  next: ${scopeWarning.next_step}`));
        console.log(chalk.cyan(`  try: ${scopeWarning.command}`));
      }
    });

  taskCmd
    .command('list')
    .description('List all tasks')
    .option('-s, --status <status>', 'Filter by status (pending|in_progress|done|failed)')
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const tasks = listTasks(db, opts.status);
      db.close();

      if (!tasks.length) {
        console.log(chalk.dim('No tasks found.'));
        return;
      }

      console.log('');
      for (const t of tasks) {
        const badge = statusBadge(t.status);
        const worktree = t.worktree ? chalk.cyan(t.worktree) : chalk.dim('unassigned');
        console.log(`${badge} ${chalk.bold(t.title)}`);
        console.log(`  ${chalk.dim('id:')} ${t.id}  ${chalk.dim('worktree:')} ${worktree}  ${chalk.dim('priority:')} ${t.priority}`);
        if (t.description) console.log(`  ${chalk.dim(t.description)}`);
        console.log('');
      }
    });

  taskCmd
    .command('assign <taskId> <worktree>')
    .description('Assign a task to a workspace (compatibility shim for lease acquire)')
    .option('--agent <name>', 'Agent name (e.g. claude-code)')
    .action(async (taskId, worktree, opts) => {
      const repoRoot = getRepo();
      const { lease } = await startTaskLeaseViaCoordination(repoRoot, { taskId, worktree, agent: opts.agent });
      if (lease) {
        console.log(`${chalk.green('✓')} Assigned ${chalk.cyan(taskId)} → ${chalk.cyan(worktree)} (${chalk.dim(lease.id)})`);
      } else {
        console.log(chalk.red(`Could not assign task. It may not exist or is not in 'pending' status.`));
      }
    });

  taskCmd
    .command('retry <taskId>')
    .description('Return a failed or stale completed task to pending so it can be revalidated')
    .option('--reason <text>', 'Reason to record for the retry')
    .option('--json', 'Output raw JSON')
    .action((taskId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const task = retryTask(db, taskId, opts.reason || 'manual retry');
      db.close();

      if (!task) {
        printErrorWithNext(`Task ${taskId} is not retryable.`, 'switchman task list --status failed');
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(task, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Reset ${chalk.cyan(task.id)} to pending`);
      pushSyncEvent('task_retried', { task_id: task.id, title: task.title, reason: opts.reason || 'manual retry' }).catch(() => {});
      console.log(`  ${chalk.dim('title:')} ${task.title}`);
      console.log(`${chalk.yellow('next:')} switchman task assign ${task.id} <workspace>`);
    });

  taskCmd
    .command('retry-stale')
    .description('Return all currently stale tasks to pending so they can be revalidated together')
    .option('--pipeline <id>', 'Only retry stale tasks for one pipeline')
    .option('--reason <text>', 'Reason to record for the retry', 'bulk stale retry')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const result = retryStaleTasks(db, {
        pipelineId: opts.pipeline || null,
        reason: opts.reason,
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.retried.length === 0) {
        const scope = result.pipeline_id ? ` for ${result.pipeline_id}` : '';
        console.log(chalk.dim(`No stale tasks to retry${scope}.`));
        return;
      }

      console.log(`${chalk.green('✓')} Reset ${result.retried.length} stale task(s) to pending`);
      pushSyncEvent('task_retried', {
        pipeline_id: result.pipeline_id || null,
        task_count: result.retried.length,
        task_ids: result.retried.map((task) => task.id),
        reason: opts.reason,
      }).catch(() => {});
      if (result.pipeline_id) {
        console.log(`  ${chalk.dim('pipeline:')} ${result.pipeline_id}`);
      }
      console.log(`  ${chalk.dim('tasks:')} ${result.retried.map((task) => task.id).join(', ')}`);
      console.log(`${chalk.yellow('next:')} switchman status`);
    });

  taskCmd
    .command('done <taskId>')
    .description('Mark a task as complete and release all file claims')
    .action(async (taskId) => {
      const repoRoot = getRepo();
      try {
        const { result } = await completeTaskViaCoordination(repoRoot, taskId);
        if (result?.status === 'already_done') {
          console.log(`${chalk.yellow('!')} Task ${chalk.cyan(taskId)} was already marked done — no new changes were recorded`);
          return;
        }
        if (result?.status === 'failed') {
          console.log(`${chalk.yellow('!')} Task ${chalk.cyan(taskId)} is currently failed — retry it before marking it done again`);
          return;
        }
        if (result?.status === 'not_in_progress') {
          console.log(`${chalk.yellow('!')} Task ${chalk.cyan(taskId)} is not currently in progress — start a lease before marking it done`);
          return;
        }
        if (result?.status === 'no_active_lease') {
          console.log(`${chalk.yellow('!')} Task ${chalk.cyan(taskId)} has no active lease — reacquire the task before marking it done`);
          return;
        }
        console.log(`${chalk.green('✓')} Task ${chalk.cyan(taskId)} marked done — file claims released`);
        pushSyncEvent('task_done', { task_id: taskId }).catch(() => {});
      } catch (err) {
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  taskCmd
    .command('fail <taskId> [reason]')
    .description('Mark a task as failed')
    .action(async (taskId, reason) => {
      const repoRoot = getRepo();
      await failTaskViaCoordination(repoRoot, { taskId, reason });
      console.log(`${chalk.red('✗')} Task ${chalk.cyan(taskId)} marked failed`);
      pushSyncEvent('task_failed', { task_id: taskId, reason: reason || null }).catch(() => {});
    });

  taskCmd
    .command('next')
    .description('Get the next pending task quickly (use `lease next` for the full workflow)')
    .option('--json', 'Output as JSON')
    .option('--worktree <name>', 'Workspace to assign the task to (defaults to the current folder name)')
    .option('--agent <name>', 'Agent identifier for logging (e.g. claude-code)')
    .addHelpText('after', `
Examples:
  switchman task next
  switchman task next --json
`)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const worktreeName = getCurrentWorktreeName(opts.worktree);
      const { task, lease, exhausted } = await acquireNextTaskLeaseViaCoordination(repoRoot, worktreeName, opts.agent || null);

      if (!task) {
        if (opts.json) console.log(JSON.stringify({ task: null }));
        else if (exhausted) console.log(chalk.dim('No pending tasks.'));
        else console.log(chalk.yellow('Tasks were claimed by other agents during assignment. Run again to get the next one.'));
        return;
      }

      if (!lease) {
        if (opts.json) console.log(JSON.stringify({ task: null, message: 'Task claimed by another agent — try again' }));
        else console.log(chalk.yellow('Task was just claimed by another agent. Run again to get the next one.'));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(taskJsonWithLease(task, worktreeName, lease), null, 2));
      } else {
        console.log(`${chalk.green('✓')} Assigned: ${chalk.bold(task.title)}`);
        console.log(`  ${chalk.dim('id:')} ${task.id}  ${chalk.dim('worktree:')} ${chalk.cyan(worktreeName)}  ${chalk.dim('lease:')} ${chalk.dim(lease.id)}  ${chalk.dim('priority:')} ${task.priority}`);
      }
    });

  return taskCmd;
}
