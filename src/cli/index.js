#!/usr/bin/env node
/**
 * switchman CLI
 * Conflict-aware task coordinator for parallel AI coding agents
 *
 * Commands:
 *   switchman init               - Initialize in current repo
 *   switchman task add           - Add a task to the queue
 *   switchman task list          - List all tasks
 *   switchman task assign        - Assign task to a worktree
 *   switchman task done          - Mark task complete
 *   switchman worktree add       - Register a worktree
 *   switchman worktree list      - List registered worktrees
 *   switchman scan               - Scan for conflicts across worktrees
 *   switchman claim              - Claim files for a task
 *   switchman status             - Show full system status
 */

import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

import { findRepoRoot, listGitWorktrees, createGitWorktree } from '../core/git.js';
import {
  initDb, openDb,
  DEFAULT_STALE_LEASE_MINUTES,
  createTask, startTaskLease, completeTask, failTask, listTasks, getTask, getNextPendingTask,
  listLeases, heartbeatLease, getStaleLeases, reapStaleLeases,
  registerWorktree, listWorktrees,
  claimFiles, releaseFileClaims, getActiveFileClaims, checkFileConflicts,
} from '../core/db.js';
import { scanAllWorktrees } from '../core/detector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRepo() {
  try {
    return findRepoRoot();
  } catch (err) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
}

function getDb(repoRoot) {
  try {
    return openDb(repoRoot);
  } catch (err) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
}

function statusBadge(status) {
  const colors = {
    pending: chalk.yellow,
    in_progress: chalk.blue,
    active: chalk.blue,
    completed: chalk.green,
    done: chalk.green,
    failed: chalk.red,
    expired: chalk.red,
    idle: chalk.gray,
    busy: chalk.blue,
  };
  return (colors[status] || chalk.white)(status.toUpperCase().padEnd(11));
}

function getCurrentWorktreeName(explicitWorktree) {
  return explicitWorktree || process.cwd().split('/').pop();
}

function taskJsonWithLease(task, worktree, lease) {
  return {
    task: {
      ...task,
      worktree,
      status: 'in_progress',
      lease_id: lease?.id ?? null,
      lease_status: lease?.status ?? null,
      heartbeat_at: lease?.heartbeat_at ?? null,
    },
  };
}

function printTable(rows, columns) {
  if (!rows.length) return;
  const widths = columns.map(col =>
    Math.max(col.label.length, ...rows.map(r => String(r[col.key] || '').length))
  );
  const header = columns.map((col, i) => col.label.padEnd(widths[i])).join('  ');
  console.log(chalk.dim(header));
  console.log(chalk.dim('─'.repeat(header.length)));
  for (const row of rows) {
    console.log(columns.map((col, i) => {
      const val = String(row[col.key] || '');
      return col.format ? col.format(val) : val.padEnd(widths[i]);
    }).join('  '));
  }
}

// ─── Program ──────────────────────────────────────────────────────────────────

program
  .name('switchman')
  .description('Conflict-aware task coordinator for parallel AI coding agents')
  .version('0.1.0');

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize switchman in the current git repository')
  .action(() => {
    const repoRoot = getRepo();
    const spinner = ora('Initializing switchman...').start();
    try {
      const db = initDb(repoRoot);

      // Auto-register existing git worktrees
      const gitWorktrees = listGitWorktrees(repoRoot);
      for (const wt of gitWorktrees) {
        registerWorktree(db, { name: wt.name, path: wt.path, branch: wt.branch || 'unknown' });
      }

      db.close();
      spinner.succeed(`Initialized in ${chalk.cyan(repoRoot)}`);
      console.log(chalk.dim(`  Found and registered ${gitWorktrees.length} git worktree(s)`));
      console.log(chalk.dim(`  Database: .switchman/switchman.db`));
      console.log('');
      console.log(`Next steps:`);
      console.log(`  ${chalk.cyan('switchman task add "Fix the login bug"')}  — add a task`);
      console.log(`  ${chalk.cyan('switchman scan')}                         — check for conflicts`);
      console.log(`  ${chalk.cyan('switchman status')}                       — view full status`);
    } catch (err) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });


// ── setup ─────────────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('One-command setup: create agent worktrees and initialise switchman')
  .option('-a, --agents <n>', 'Number of agent worktrees to create (default: 3)', '3')
  .option('--prefix <prefix>', 'Branch prefix (default: switchman)', 'switchman')
  .action((opts) => {
    const agentCount = parseInt(opts.agents);

    if (isNaN(agentCount) || agentCount < 1 || agentCount > 10) {
      console.error(chalk.red('--agents must be a number between 1 and 10'));
      process.exit(1);
    }

    const repoRoot = getRepo();
    const spinner = ora('Setting up Switchman...').start();

    try {
      // git worktree add requires at least one commit
      try {
        execSync('git rev-parse HEAD', {
          cwd: repoRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        spinner.fail('Your repo needs at least one commit before worktrees can be created.');
        console.log(chalk.dim('  Run: git commit --allow-empty -m "init"  then try again'));
        process.exit(1);
      }

      // Init the switchman database
      const db = initDb(repoRoot);

      // Create one worktree per agent
      const created = [];
      for (let i = 1; i <= agentCount; i++) {
        const name = `agent${i}`;
        const branch = `${opts.prefix}/agent${i}`;
        spinner.text = `Creating worktree ${i}/${agentCount}...`;
        try {
          const wtPath = createGitWorktree(repoRoot, name, branch);
          registerWorktree(db, { name, path: wtPath, branch });
          created.push({ name, path: wtPath, branch });
        } catch {
          // Worktree already exists — register it without failing
          const repoName = repoRoot.split('/').pop();
          const wtPath = join(repoRoot, '..', `${repoName}-${name}`);
          registerWorktree(db, { name, path: wtPath, branch });
          created.push({ name, path: wtPath, branch, existed: true });
        }
      }

      // Register the main worktree too
      const gitWorktrees = listGitWorktrees(repoRoot);
      for (const wt of gitWorktrees) {
        registerWorktree(db, { name: wt.name, path: wt.path, branch: wt.branch || 'unknown' });
      }

      db.close();

      const label = agentCount === 1 ? 'workspace' : 'workspaces';
      spinner.succeed(`Switchman ready — ${agentCount} agent ${label} created`);
      console.log('');

      for (const wt of created) {
        const note = wt.existed ? chalk.dim(' (already existed, re-registered)') : '';
        console.log(`  ${chalk.green('✓')} ${chalk.cyan(wt.path)}${note}`);
        console.log(`    ${chalk.dim('branch:')} ${wt.branch}`);
      }

      console.log('');
      console.log(chalk.bold('Next steps:'));
      console.log(`  1. Add your tasks:`);
      console.log(`     ${chalk.cyan('switchman task add "Your first task" --priority 8')}`);
      console.log(`  2. Open Claude Code in each folder above — agents will coordinate automatically`);
      console.log(`  3. Check status at any time:`);
      console.log(`     ${chalk.cyan('switchman status')}`);
      console.log('');

    } catch (err) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });


// ── task ──────────────────────────────────────────────────────────────────────

const taskCmd = program.command('task').description('Manage the task queue');

taskCmd
  .command('add <title>')
  .description('Add a new task to the queue')
  .option('-d, --description <desc>', 'Task description')
  .option('-p, --priority <n>', 'Priority 1-10 (default 5)', '5')
  .option('--id <id>', 'Custom task ID')
  .action((title, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const taskId = createTask(db, {
      id: opts.id,
      title,
      description: opts.description,
      priority: parseInt(opts.priority),
    });
    db.close();
    console.log(`${chalk.green('✓')} Task created: ${chalk.cyan(taskId)}`);
    console.log(`  ${chalk.dim(title)}`);
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
  .description('Assign a task to a worktree (compatibility shim for lease acquire)')
  .option('--agent <name>', 'Agent name (e.g. claude-code)')
  .action((taskId, worktree, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const lease = startTaskLease(db, taskId, worktree, opts.agent);
    db.close();
    if (lease) {
      console.log(`${chalk.green('✓')} Assigned ${chalk.cyan(taskId)} → ${chalk.cyan(worktree)} (${chalk.dim(lease.id)})`);
    } else {
      console.log(chalk.red(`Could not assign task. It may not exist or is not in 'pending' status.`));
    }
  });

taskCmd
  .command('done <taskId>')
  .description('Mark a task as complete and release all file claims')
  .action((taskId) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    completeTask(db, taskId);
    releaseFileClaims(db, taskId);
    db.close();
    console.log(`${chalk.green('✓')} Task ${chalk.cyan(taskId)} marked done — file claims released`);
  });

taskCmd
  .command('fail <taskId> [reason]')
  .description('Mark a task as failed')
  .action((taskId, reason) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    failTask(db, taskId, reason);
    releaseFileClaims(db, taskId);
    db.close();
    console.log(`${chalk.red('✗')} Task ${chalk.cyan(taskId)} marked failed`);
  });

taskCmd
  .command('next')
  .description('Get and assign the next pending task (compatibility shim for lease next)')
  .option('--json', 'Output as JSON')
  .option('--worktree <name>', 'Worktree to assign the task to (defaults to current worktree name)')
  .option('--agent <name>', 'Agent identifier for logging (e.g. claude-code)')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const task = getNextPendingTask(db);

    if (!task) {
      db.close();
      if (opts.json) console.log(JSON.stringify({ task: null }));
      else console.log(chalk.dim('No pending tasks.'));
      return;
    }

    // Determine worktree name: explicit flag, or derive from cwd
    const worktreeName = getCurrentWorktreeName(opts.worktree);
    const lease = startTaskLease(db, task.id, worktreeName, opts.agent || null);
    db.close();

    if (!lease) {
      // Race condition: another agent grabbed it between get and assign
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

// ── lease ────────────────────────────────────────────────────────────────────

const leaseCmd = program.command('lease').description('Manage active work leases');

leaseCmd
  .command('acquire <taskId> <worktree>')
  .description('Acquire a lease for a pending task')
  .option('--agent <name>', 'Agent identifier for logging')
  .option('--json', 'Output as JSON')
  .action((taskId, worktree, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const task = getTask(db, taskId);
    const lease = startTaskLease(db, taskId, worktree, opts.agent || null);
    db.close();

    if (!lease || !task) {
      if (opts.json) console.log(JSON.stringify({ lease: null, task: null }));
      else console.log(chalk.red(`Could not acquire lease. The task may not exist or is not pending.`));
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
  .description('Claim the next pending task and acquire its lease')
  .option('--json', 'Output as JSON')
  .option('--worktree <name>', 'Worktree to assign the task to (defaults to current worktree name)')
  .option('--agent <name>', 'Agent identifier for logging')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const task = getNextPendingTask(db);

    if (!task) {
      db.close();
      if (opts.json) console.log(JSON.stringify({ task: null, lease: null }));
      else console.log(chalk.dim('No pending tasks.'));
      return;
    }

    const worktreeName = getCurrentWorktreeName(opts.worktree);
    const lease = startTaskLease(db, task.id, worktreeName, opts.agent || null);
    db.close();

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
    console.log(`  ${chalk.dim('task:')} ${task.id}  ${chalk.dim('lease:')} ${lease.id}`);
    console.log(`  ${chalk.dim('worktree:')} ${chalk.cyan(worktreeName)}  ${chalk.dim('priority:')} ${task.priority}`);
  });

leaseCmd
  .command('list')
  .description('List leases, newest first')
  .option('-s, --status <status>', 'Filter by status (active|completed|failed|expired)')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const leases = listLeases(db, opts.status);
    db.close();

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
      else console.log(chalk.red(`No active lease found for ${leaseId}`));
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
  .description('Expire stale leases, release their claims, and return their tasks to pending')
  .option('--stale-after-minutes <minutes>', 'Age threshold for staleness', String(DEFAULT_STALE_LEASE_MINUTES))
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const staleAfterMinutes = Number.parseInt(opts.staleAfterMinutes, 10);
    const expired = reapStaleLeases(db, staleAfterMinutes);
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

// ── worktree ───────────────────────────────────────────────────────────────────

const wtCmd = program.command('worktree').description('Manage worktrees');

wtCmd
  .command('add <name> <path> <branch>')
  .description('Register a worktree with switchman')
  .option('--agent <name>', 'Agent assigned to this worktree')
  .action((name, path, branch, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    registerWorktree(db, { name, path, branch, agent: opts.agent });
    db.close();
    console.log(`${chalk.green('✓')} Registered worktree: ${chalk.cyan(name)}`);
  });

wtCmd
  .command('list')
  .description('List all registered worktrees')
  .action(() => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const worktrees = listWorktrees(db);
    const gitWorktrees = listGitWorktrees(repoRoot);
    db.close();

    if (!worktrees.length && !gitWorktrees.length) {
      console.log(chalk.dim('No worktrees found.'));
      return;
    }

    // Show git worktrees (source of truth) annotated with db info
    console.log('');
    console.log(chalk.bold('Git Worktrees:'));
    for (const wt of gitWorktrees) {
      const dbInfo = worktrees.find(d => d.path === wt.path);
      const agent = dbInfo?.agent ? chalk.cyan(dbInfo.agent) : chalk.dim('no agent');
      const status = dbInfo?.status ? statusBadge(dbInfo.status) : chalk.dim('unregistered');
      console.log(`  ${chalk.bold(wt.name.padEnd(20))} ${status} branch: ${chalk.cyan(wt.branch || 'unknown')}  agent: ${agent}`);
      console.log(`    ${chalk.dim(wt.path)}`);
    }
    console.log('');
  });

wtCmd
  .command('sync')
  .description('Sync git worktrees into the switchman database')
  .action(() => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const gitWorktrees = listGitWorktrees(repoRoot);
    for (const wt of gitWorktrees) {
      registerWorktree(db, { name: wt.name, path: wt.path, branch: wt.branch || 'unknown' });
    }
    db.close();
    console.log(`${chalk.green('✓')} Synced ${gitWorktrees.length} worktree(s) from git`);
  });

// ── claim ──────────────────────────────────────────────────────────────────────

program
  .command('claim <taskId> <worktree> [files...]')
  .description('Claim files for a task (warns if conflicts exist)')
  .option('--agent <name>', 'Agent name')
  .option('--force', 'Claim even if conflicts exist')
  .action((taskId, worktree, files, opts) => {
    if (!files.length) {
      console.log(chalk.yellow('No files specified. Use: switchman claim <taskId> <worktree> file1 file2 ...'));
      return;
    }
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const conflicts = checkFileConflicts(db, files, worktree);

      if (conflicts.length > 0 && !opts.force) {
        console.log(chalk.red(`\n⚠ Claim conflicts detected:`));
        for (const c of conflicts) {
          console.log(`  ${chalk.yellow(c.file)} → already claimed by worktree ${chalk.cyan(c.claimedBy.worktree)} (task: ${c.claimedBy.task_title})`);
        }
        console.log(chalk.dim('\nUse --force to claim anyway, or resolve conflicts first.'));
        return;
      }

      const lease = claimFiles(db, taskId, worktree, files, opts.agent);
      console.log(`${chalk.green('✓')} Claimed ${files.length} file(s) for task ${chalk.cyan(taskId)} (${chalk.dim(lease.id)})`);
      files.forEach(f => console.log(`  ${chalk.dim(f)}`));
    } catch (err) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

program
  .command('release <taskId>')
  .description('Release all file claims for a task')
  .action((taskId) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    releaseFileClaims(db, taskId);
    db.close();
    console.log(`${chalk.green('✓')} Released all claims for task ${chalk.cyan(taskId)}`);
  });

// ── scan ───────────────────────────────────────────────────────────────────────

program
  .command('scan')
  .description('Scan all worktrees for conflicts')
  .option('--json', 'Output raw JSON')
  .option('--quiet', 'Only show conflicts')
  .action(async (opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const spinner = ora('Scanning worktrees for conflicts...').start();

    try {
      const report = await scanAllWorktrees(db, repoRoot);
      db.close();
      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log('');
      console.log(chalk.bold(`Conflict Scan Report`));
      console.log(chalk.dim(`${report.scannedAt}`));
      console.log('');

      // Worktrees summary
      if (!opts.quiet) {
        console.log(chalk.bold('Worktrees:'));
        for (const wt of report.worktrees) {
          const files = report.fileMap?.[wt.name] || [];
          console.log(`  ${chalk.cyan(wt.name.padEnd(20))} branch: ${(wt.branch || 'unknown').padEnd(30)} ${chalk.dim(files.length + ' changed file(s)')}`);
        }
        console.log('');
      }

      // File-level overlaps (uncommitted)
      if (report.fileConflicts.length > 0) {
        console.log(chalk.yellow(`⚠ Files being edited in multiple worktrees (uncommitted):`));
        for (const fc of report.fileConflicts) {
          console.log(`  ${chalk.yellow(fc.file)}`);
          console.log(`    ${chalk.dim('edited in:')} ${fc.worktrees.join(', ')}`);
        }
        console.log('');
      }

      // Branch-level conflicts
      if (report.conflicts.length > 0) {
        console.log(chalk.red(`✗ Branch conflicts detected:`));
        for (const c of report.conflicts) {
          const icon = c.type === 'merge_conflict' ? chalk.red('MERGE CONFLICT') : chalk.yellow('FILE OVERLAP');
          console.log(`  ${icon}`);
          console.log(`    ${chalk.cyan(c.worktreeA)} (${c.branchA}) ↔ ${chalk.cyan(c.worktreeB)} (${c.branchB})`);
          if (c.conflictingFiles.length) {
            console.log(`    Conflicting files:`);
            c.conflictingFiles.forEach(f => console.log(`      ${chalk.yellow(f)}`));
          }
        }
        console.log('');
      }

      // All clear
      if (report.conflicts.length === 0 && report.fileConflicts.length === 0) {
        console.log(chalk.green(`✓ No conflicts detected across ${report.worktrees.length} worktree(s)`));
      }

    } catch (err) {
      spinner.fail(err.message);
      db.close();
      process.exit(1);
    }
  });

// ── status ─────────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show full system status: tasks, worktrees, claims, and conflicts')
  .action(async () => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    console.log('');
    console.log(chalk.bold.cyan('━━━ switchman status ━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log(chalk.dim(`Repo: ${repoRoot}`));
    console.log('');

    // Tasks
    const tasks = listTasks(db);
    const pending = tasks.filter(t => t.status === 'pending');
    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const done = tasks.filter(t => t.status === 'done');
    const failed = tasks.filter(t => t.status === 'failed');
    const activeLeases = listLeases(db, 'active');
    const staleLeases = getStaleLeases(db);

    console.log(chalk.bold('Tasks:'));
    console.log(`  ${chalk.yellow('Pending')}     ${pending.length}`);
    console.log(`  ${chalk.blue('In Progress')} ${inProgress.length}`);
    console.log(`  ${chalk.green('Done')}        ${done.length}`);
    console.log(`  ${chalk.red('Failed')}      ${failed.length}`);

    if (activeLeases.length > 0) {
      console.log('');
      console.log(chalk.bold('Active Leases:'));
      for (const lease of activeLeases) {
        console.log(`  ${chalk.cyan(lease.worktree)} → ${lease.task_title} ${chalk.dim(lease.id)}`);
      }
    } else if (inProgress.length > 0) {
      console.log('');
      console.log(chalk.bold('In-Progress Tasks Without Lease:'));
      for (const t of inProgress) {
        console.log(`  ${chalk.cyan(t.worktree || 'unassigned')} → ${t.title}`);
      }
    }

    if (staleLeases.length > 0) {
      console.log('');
      console.log(chalk.bold('Stale Leases:'));
      for (const lease of staleLeases) {
        console.log(`  ${chalk.red(lease.worktree)} → ${lease.task_title} ${chalk.dim(lease.id)} ${chalk.dim(lease.heartbeat_at)}`);
      }
    }

    if (pending.length > 0) {
      console.log('');
      console.log(chalk.bold('Next Up:'));
      const next = pending.slice(0, 3);
      for (const t of next) {
        console.log(`  [p${t.priority}] ${t.title} ${chalk.dim(t.id)}`);
      }
    }

    // File Claims
    const claims = getActiveFileClaims(db);
    if (claims.length > 0) {
      console.log('');
      console.log(chalk.bold(`Active File Claims (${claims.length}):`));
      const byWorktree = {};
      for (const c of claims) {
        if (!byWorktree[c.worktree]) byWorktree[c.worktree] = [];
        byWorktree[c.worktree].push(c.file_path);
      }
      for (const [wt, files] of Object.entries(byWorktree)) {
        console.log(`  ${chalk.cyan(wt)}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` +${files.length - 5} more` : ''}`);
      }
    }

    // Quick conflict scan
    console.log('');
    const spinner = ora('Running conflict scan...').start();
    try {
      const report = await scanAllWorktrees(db, repoRoot);
      spinner.stop();

      const totalConflicts = report.conflicts.length + report.fileConflicts.length;
      if (totalConflicts === 0) {
        console.log(chalk.green(`✓ No conflicts across ${report.worktrees.length} worktree(s)`));
      } else {
        console.log(chalk.red(`⚠ ${totalConflicts} conflict(s) detected — run 'switchman scan' for details`));
      }
    } catch {
      spinner.stop();
      console.log(chalk.dim('Could not run conflict scan'));
    }

    db.close();
    console.log('');
    console.log(chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    console.log('');
  });

program.parse();
