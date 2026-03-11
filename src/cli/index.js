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
import { join } from 'path';
import { execSync, spawn } from 'child_process';

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
import { upsertProjectMcpConfig } from '../core/mcp.js';
import { gatewayAppendFile, gatewayMakeDirectory, gatewayMovePath, gatewayRemovePath, gatewayWriteFile, installGateHooks, monitorWorktreesOnce, runCommitGate, runWrappedCommand, writeEnforcementPolicy } from '../core/enforcement.js';
import { runAiMergeGate } from '../core/merge-gate.js';
import { clearMonitorState, getMonitorStatePath, isProcessRunning, readMonitorState, writeMonitorState } from '../core/monitor.js';
import { buildPipelinePrSummary, createPipelineFollowupTasks, executePipeline, exportPipelinePrBundle, getPipelineStatus, publishPipelinePr, runPipeline, startPipeline } from '../core/pipeline.js';

function installMcpConfig(targetDirs) {
  return targetDirs.map((targetDir) => upsertProjectMcpConfig(targetDir));
}

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
    managed: chalk.green,
    observed: chalk.yellow,
    non_compliant: chalk.red,
    stale: chalk.red,
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

      const mcpConfigWrites = installMcpConfig([...new Set([repoRoot, ...gitWorktrees.map((wt) => wt.path)])]);

      db.close();
      spinner.succeed(`Initialized in ${chalk.cyan(repoRoot)}`);
      console.log(chalk.dim(`  Found and registered ${gitWorktrees.length} git worktree(s)`));
      console.log(chalk.dim(`  Database: .switchman/switchman.db`));
      console.log(chalk.dim(`  MCP config: ${mcpConfigWrites.filter((result) => result.changed).length} file(s) written`));
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

      const mcpConfigWrites = installMcpConfig([...new Set([repoRoot, ...created.map((wt) => wt.path)])]);

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
      console.log(chalk.bold('MCP config:'));
      for (const result of mcpConfigWrites) {
        const status = result.created ? 'created' : result.changed ? 'updated' : 'unchanged';
        console.log(`  ${chalk.green('✓')} ${chalk.cyan(result.path)} ${chalk.dim(`(${status})`)}`);
      }

      console.log('');
      console.log(chalk.bold('Next steps:'));
      console.log(`  1. Add your tasks:`);
      console.log(`     ${chalk.cyan('switchman task add "Your first task" --priority 8')}`);
      console.log(`  2. Open Claude Code in each folder above — the local .mcp.json will attach Switchman automatically`);
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

// ── pipeline ──────────────────────────────────────────────────────────────────

const pipelineCmd = program.command('pipeline').description('Create and summarize issue-to-PR execution pipelines');

pipelineCmd
  .command('start <title>')
  .description('Create a pipeline from one issue title and split it into execution subtasks')
  .option('-d, --description <desc>', 'Issue description or markdown checklist')
  .option('-p, --priority <n>', 'Priority 1-10 (default 5)', '5')
  .option('--id <id>', 'Custom pipeline ID')
  .option('--json', 'Output raw JSON')
  .action((title, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = startPipeline(db, {
      title,
      description: opts.description || null,
      priority: Number.parseInt(opts.priority, 10),
      pipelineId: opts.id || null,
    });
    db.close();

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`${chalk.green('✓')} Pipeline created ${chalk.cyan(result.pipeline_id)}`);
    console.log(`  ${chalk.bold(result.title)}`);
    for (const task of result.tasks) {
      const suggested = task.suggested_worktree ? ` ${chalk.dim(`→ ${task.suggested_worktree}`)}` : '';
      const type = task.task_spec?.task_type ? ` ${chalk.dim(`[${task.task_spec.task_type}]`)}` : '';
      console.log(`  ${chalk.cyan(task.id)} ${task.title}${type}${suggested}`);
    }
  });

pipelineCmd
  .command('status <pipelineId>')
  .description('Show task status for a pipeline')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = getPipelineStatus(db, pipelineId);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.bold(result.title)} ${chalk.dim(result.pipeline_id)}`);
      console.log(`  ${chalk.dim('done')} ${result.counts.done}  ${chalk.dim('in_progress')} ${result.counts.in_progress}  ${chalk.dim('pending')} ${result.counts.pending}  ${chalk.dim('failed')} ${result.counts.failed}`);
      for (const task of result.tasks) {
        const worktree = task.worktree || task.suggested_worktree || 'unassigned';
        const blocked = task.blocked_by?.length ? ` ${chalk.dim(`blocked by ${task.blocked_by.join(', ')}`)}` : '';
        const type = task.task_spec?.task_type ? ` ${chalk.dim(`[${task.task_spec.task_type}]`)}` : '';
        console.log(`  ${statusBadge(task.status)} ${task.id} ${task.title}${type} ${chalk.dim(worktree)}${blocked}`);
      }
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

pipelineCmd
  .command('pr <pipelineId>')
  .description('Generate a PR-ready summary for a pipeline using the repo and AI gates')
  .option('--json', 'Output raw JSON')
  .action(async (pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = await buildPipelinePrSummary(db, repoRoot, pipelineId);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(result.markdown);
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

pipelineCmd
  .command('bundle <pipelineId> [outputDir]')
  .description('Export a reviewer-ready PR bundle for a pipeline to disk')
  .option('--json', 'Output raw JSON')
  .action(async (pipelineId, outputDir, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = await exportPipelinePrBundle(db, repoRoot, pipelineId, outputDir || null);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Exported PR bundle for ${chalk.cyan(result.pipeline_id)}`);
      console.log(`  ${chalk.dim(result.output_dir)}`);
      console.log(`  ${chalk.dim('json:')} ${result.files.summary_json}`);
      console.log(`  ${chalk.dim('summary:')} ${result.files.summary_markdown}`);
      console.log(`  ${chalk.dim('body:')} ${result.files.pr_body_markdown}`);
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

pipelineCmd
  .command('publish <pipelineId> [outputDir]')
  .description('Create a hosted GitHub pull request for a pipeline using gh')
  .option('--base <branch>', 'Base branch for the pull request', 'main')
  .option('--head <branch>', 'Head branch for the pull request (defaults to inferred pipeline branch)')
  .option('--draft', 'Create the pull request as a draft')
  .option('--gh-command <command>', 'Executable to use for GitHub CLI', 'gh')
  .option('--json', 'Output raw JSON')
  .action(async (pipelineId, outputDir, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = await publishPipelinePr(db, repoRoot, pipelineId, {
        baseBranch: opts.base,
        headBranch: opts.head || null,
        draft: Boolean(opts.draft),
        ghCommand: opts.ghCommand,
        outputDir: outputDir || null,
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Published PR for ${chalk.cyan(result.pipeline_id)}`);
      console.log(`  ${chalk.dim('base:')} ${result.base_branch}`);
      console.log(`  ${chalk.dim('head:')} ${result.head_branch}`);
      if (result.output) {
        console.log(`  ${chalk.dim(result.output)}`);
      }
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

pipelineCmd
  .command('run <pipelineId> [agentCommand...]')
  .description('Dispatch pending pipeline tasks onto available worktrees and optionally launch an agent command in each one')
  .option('--agent <name>', 'Agent name to record on acquired leases', 'pipeline-runner')
  .option('--detached', 'Launch agent commands as detached background processes')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, agentCommand, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = runPipeline(db, repoRoot, {
        pipelineId,
        agentCommand,
        agentName: opts.agent,
        detached: Boolean(opts.detached),
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.assigned.length === 0) {
        console.log(chalk.dim('No pending pipeline tasks were assigned. All worktrees may already be busy.'));
        return;
      }

      console.log(`${chalk.green('✓')} Dispatched ${result.assigned.length} pipeline task(s)`);
      for (const assignment of result.assigned) {
        const launch = result.launched.find((item) => item.task_id === assignment.task_id);
        const launchInfo = launch ? ` ${chalk.dim(`pid=${launch.pid}`)}` : '';
        console.log(`  ${chalk.cyan(assignment.task_id)} → ${chalk.cyan(assignment.worktree)} ${chalk.dim(assignment.lease_id)}${launchInfo}`);
      }
      if (result.remaining_pending > 0) {
        console.log(chalk.dim(`${result.remaining_pending} pipeline task(s) remain pending due to unavailable worktrees.`));
      }
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

pipelineCmd
  .command('review <pipelineId>')
  .description('Inspect repo and AI gate failures for a pipeline and create follow-up fix tasks')
  .option('--json', 'Output raw JSON')
  .action(async (pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = await createPipelineFollowupTasks(db, repoRoot, pipelineId);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.created_count === 0) {
        console.log(chalk.dim('No follow-up tasks were created. The pipeline gates did not surface new actionable items.'));
        return;
      }

      console.log(`${chalk.green('✓')} Created ${result.created_count} follow-up task(s)`);
      for (const task of result.created) {
        console.log(`  ${chalk.cyan(task.id)} ${task.title}`);
      }
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

pipelineCmd
  .command('exec <pipelineId> [agentCommand...]')
  .description('Run a bounded autonomous loop: dispatch, execute, review, and stop when ready or blocked')
  .option('--agent <name>', 'Agent name to record on acquired leases', 'pipeline-runner')
  .option('--max-iterations <n>', 'Maximum execution/review iterations', '3')
  .option('--max-retries <n>', 'Retry a failed pipeline task up to this many times', '1')
  .option('--retry-backoff-ms <ms>', 'Base backoff in milliseconds between retry attempts', '0')
  .option('--timeout-ms <ms>', 'Default command timeout in milliseconds when a task spec does not provide one', '0')
  .option('--json', 'Output raw JSON')
  .action(async (pipelineId, agentCommand, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = await executePipeline(db, repoRoot, {
        pipelineId,
        agentCommand,
        agentName: opts.agent,
        maxIterations: Number.parseInt(opts.maxIterations, 10),
        maxRetries: Number.parseInt(opts.maxRetries, 10),
        retryBackoffMs: Number.parseInt(opts.retryBackoffMs, 10),
        timeoutMs: Number.parseInt(opts.timeoutMs, 10),
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      const badge = result.status === 'ready'
        ? chalk.green('READY')
        : result.status === 'blocked'
          ? chalk.red('BLOCKED')
          : chalk.yellow('MAX');
      console.log(`${badge} Pipeline ${chalk.cyan(result.pipeline_id)} ${chalk.dim(result.status)}`);
      for (const iteration of result.iterations) {
        console.log(`  iter ${iteration.iteration}: resumed=${iteration.resumed_retries} dispatched=${iteration.dispatched} executed=${iteration.executed} retries=${iteration.retries_scheduled} followups=${iteration.followups_created} ai=${iteration.ai_gate_status} ready=${iteration.ready}`);
      }
      console.log(chalk.dim(result.pr.markdown.split('\n')[0]));
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
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
      const compliance = dbInfo?.compliance_state ? statusBadge(dbInfo.compliance_state) : chalk.dim('unknown');
      console.log(`  ${chalk.bold(wt.name.padEnd(20))} ${status} ${compliance} branch: ${chalk.cyan(wt.branch || 'unknown')}  agent: ${agent}`);
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
    installMcpConfig([...new Set([repoRoot, ...gitWorktrees.map((wt) => wt.path)])]);
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

program
  .command('write <leaseId> <path>')
  .description('Write a file through the Switchman enforcement gateway')
  .requiredOption('--text <content>', 'Replacement file content')
  .option('--worktree <name>', 'Expected worktree for lease validation')
  .action((leaseId, path, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = gatewayWriteFile(db, repoRoot, {
      leaseId,
      path,
      content: opts.text,
      worktree: opts.worktree || null,
    });
    db.close();

    if (!result.ok) {
      console.log(chalk.red(`✗ Write denied for ${chalk.cyan(result.file_path || path)} ${chalk.dim(result.reason_code)}`));
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} Wrote ${chalk.cyan(result.file_path)} via lease ${chalk.dim(result.lease_id)}`);
  });

program
  .command('rm <leaseId> <path>')
  .description('Remove a file or directory through the Switchman enforcement gateway')
  .option('--worktree <name>', 'Expected worktree for lease validation')
  .action((leaseId, path, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = gatewayRemovePath(db, repoRoot, {
      leaseId,
      path,
      worktree: opts.worktree || null,
    });
    db.close();

    if (!result.ok) {
      console.log(chalk.red(`✗ Remove denied for ${chalk.cyan(result.file_path || path)} ${chalk.dim(result.reason_code)}`));
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} Removed ${chalk.cyan(result.file_path)} via lease ${chalk.dim(result.lease_id)}`);
  });

program
  .command('append <leaseId> <path>')
  .description('Append to a file through the Switchman enforcement gateway')
  .requiredOption('--text <content>', 'Content to append')
  .option('--worktree <name>', 'Expected worktree for lease validation')
  .action((leaseId, path, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = gatewayAppendFile(db, repoRoot, {
      leaseId,
      path,
      content: opts.text,
      worktree: opts.worktree || null,
    });
    db.close();

    if (!result.ok) {
      console.log(chalk.red(`✗ Append denied for ${chalk.cyan(result.file_path || path)} ${chalk.dim(result.reason_code)}`));
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} Appended to ${chalk.cyan(result.file_path)} via lease ${chalk.dim(result.lease_id)}`);
  });

program
  .command('mv <leaseId> <sourcePath> <destinationPath>')
  .description('Move a file through the Switchman enforcement gateway')
  .option('--worktree <name>', 'Expected worktree for lease validation')
  .action((leaseId, sourcePath, destinationPath, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = gatewayMovePath(db, repoRoot, {
      leaseId,
      sourcePath,
      destinationPath,
      worktree: opts.worktree || null,
    });
    db.close();

    if (!result.ok) {
      console.log(chalk.red(`✗ Move denied for ${chalk.cyan(result.file_path || destinationPath)} ${chalk.dim(result.reason_code)}`));
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} Moved ${chalk.cyan(result.source_path)} → ${chalk.cyan(result.file_path)} via lease ${chalk.dim(result.lease_id)}`);
  });

program
  .command('mkdir <leaseId> <path>')
  .description('Create a directory through the Switchman enforcement gateway')
  .option('--worktree <name>', 'Expected worktree for lease validation')
  .action((leaseId, path, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = gatewayMakeDirectory(db, repoRoot, {
      leaseId,
      path,
      worktree: opts.worktree || null,
    });
    db.close();

    if (!result.ok) {
      console.log(chalk.red(`✗ Mkdir denied for ${chalk.cyan(result.file_path || path)} ${chalk.dim(result.reason_code)}`));
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} Created ${chalk.cyan(result.file_path)} via lease ${chalk.dim(result.lease_id)}`);
  });

program
  .command('wrap <leaseId> <command...>')
  .description('Launch a CLI tool under an active Switchman lease with enforcement context env vars')
  .option('--worktree <name>', 'Expected worktree for lease validation')
  .option('--cwd <path>', 'Override working directory for the wrapped command')
  .action((leaseId, commandParts, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const [command, ...args] = commandParts;
    const result = runWrappedCommand(db, repoRoot, {
      leaseId,
      command,
      args,
      worktree: opts.worktree || null,
      cwd: opts.cwd || null,
    });
    db.close();

    if (!result.ok) {
      console.log(chalk.red(`✗ Wrapped command denied ${chalk.dim(result.reason_code || 'wrapped_command_failed')}`));
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} Wrapped command completed under lease ${chalk.dim(result.lease_id)}`);
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
          const compliance = report.worktreeCompliance?.find((entry) => entry.worktree === wt.name)?.compliance_state || wt.compliance_state || 'observed';
          console.log(`  ${chalk.cyan(wt.name.padEnd(20))} ${statusBadge(compliance)} branch: ${(wt.branch || 'unknown').padEnd(30)} ${chalk.dim(files.length + ' changed file(s)')}`);
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

      if (report.unclaimedChanges.length > 0) {
        console.log(chalk.red(`✗ Unclaimed or unmanaged changed files detected:`));
        for (const entry of report.unclaimedChanges) {
          console.log(`  ${chalk.cyan(entry.worktree)} ${chalk.dim(entry.lease_id || 'no active lease')}`);
          entry.files.forEach((file) => {
            const reason = entry.reasons.find((item) => item.file === file)?.reason_code || 'path_not_claimed';
            console.log(`    ${chalk.yellow(file)} ${chalk.dim(reason)}`);
          });
        }
        console.log('');
      }

      // All clear
      if (report.conflicts.length === 0 && report.fileConflicts.length === 0 && report.unclaimedChanges.length === 0) {
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

      const totalConflicts = report.conflicts.length + report.fileConflicts.length + report.unclaimedChanges.length;
      if (totalConflicts === 0) {
        console.log(chalk.green(`✓ No conflicts across ${report.worktrees.length} worktree(s)`));
      } else {
        console.log(chalk.red(`⚠ ${totalConflicts} conflict(s) detected — run 'switchman scan' for details`));
      }

      console.log('');
      console.log(chalk.bold('Compliance:'));
      console.log(`  ${chalk.green('Managed')}       ${report.complianceSummary.managed}`);
      console.log(`  ${chalk.yellow('Observed')}      ${report.complianceSummary.observed}`);
      console.log(`  ${chalk.red('Non-Compliant')} ${report.complianceSummary.non_compliant}`);
      console.log(`  ${chalk.red('Stale')}         ${report.complianceSummary.stale}`);

      if (report.unclaimedChanges.length > 0) {
        console.log('');
        console.log(chalk.bold('Unclaimed Changed Paths:'));
        for (const entry of report.unclaimedChanges) {
          console.log(`  ${chalk.cyan(entry.worktree)}: ${entry.files.slice(0, 5).join(', ')}${entry.files.length > 5 ? ` +${entry.files.length - 5} more` : ''}`);
        }
      }

      if (report.commitGateFailures.length > 0) {
        console.log('');
        console.log(chalk.bold('Recent Commit Gate Failures:'));
        for (const failure of report.commitGateFailures.slice(0, 5)) {
          console.log(`  ${chalk.red(failure.worktree || 'unknown')} ${chalk.dim(failure.reason_code || 'rejected')} ${chalk.dim(failure.created_at)}`);
        }
      }

      if (report.deniedWrites.length > 0) {
        console.log('');
        console.log(chalk.bold('Recent Denied Events:'));
        for (const event of report.deniedWrites.slice(0, 5)) {
          console.log(`  ${chalk.red(event.event_type)} ${chalk.cyan(event.worktree || 'repo')} ${chalk.dim(event.reason_code || event.status)}`);
        }
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

// ── gate ─────────────────────────────────────────────────────────────────────

const gateCmd = program.command('gate').description('Enforcement and commit-gate helpers');

gateCmd
  .command('commit')
  .description('Validate current worktree changes against the active lease and claims')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = runCommitGate(db, repoRoot);
    db.close();

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(`${chalk.green('✓')} ${result.summary}`);
    } else {
      console.log(chalk.red(`✗ ${result.summary}`));
      for (const violation of result.violations) {
        const label = violation.file || '(worktree)';
        console.log(`  ${chalk.yellow(label)} ${chalk.dim(violation.reason_code)}`);
      }
    }

    if (!result.ok) process.exitCode = 1;
  });

gateCmd
  .command('merge')
  .description('Validate current worktree changes before recording a merge commit')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = runCommitGate(db, repoRoot);
    db.close();

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(`${chalk.green('✓')} Merge gate passed for ${chalk.cyan(result.worktree || 'current worktree')}.`);
    } else {
      console.log(chalk.red(`✗ Merge gate rejected changes in ${chalk.cyan(result.worktree || 'current worktree')}.`));
      for (const violation of result.violations) {
        const label = violation.file || '(worktree)';
        console.log(`  ${chalk.yellow(label)} ${chalk.dim(violation.reason_code)}`);
      }
    }

    if (!result.ok) process.exitCode = 1;
  });

gateCmd
  .command('install')
  .description('Install git hooks that run the Switchman commit and merge gates')
  .action(() => {
    const repoRoot = getRepo();
    const hookPaths = installGateHooks(repoRoot);
    console.log(`${chalk.green('✓')} Installed pre-commit hook at ${chalk.cyan(hookPaths.pre_commit)}`);
    console.log(`${chalk.green('✓')} Installed pre-merge-commit hook at ${chalk.cyan(hookPaths.pre_merge_commit)}`);
  });

gateCmd
  .command('ci')
  .description('Run a repo-level enforcement gate suitable for CI, merges, or PR validation')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const report = await scanAllWorktrees(db, repoRoot);
    db.close();

    const ok = report.conflicts.length === 0
      && report.fileConflicts.length === 0
      && report.unclaimedChanges.length === 0
      && report.complianceSummary.non_compliant === 0
      && report.complianceSummary.stale === 0;

    const result = {
      ok,
      summary: ok
        ? `Repo gate passed for ${report.worktrees.length} worktree(s).`
        : 'Repo gate rejected unmanaged changes, stale leases, or worktree conflicts.',
      compliance: report.complianceSummary,
      unclaimed_changes: report.unclaimedChanges,
      file_conflicts: report.fileConflicts,
      branch_conflicts: report.conflicts,
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (ok) {
      console.log(`${chalk.green('✓')} ${result.summary}`);
    } else {
      console.log(chalk.red(`✗ ${result.summary}`));
      if (result.unclaimed_changes.length > 0) {
        console.log(chalk.bold('  Unclaimed changes:'));
        for (const entry of result.unclaimed_changes) {
          console.log(`    ${chalk.cyan(entry.worktree)}: ${entry.files.join(', ')}`);
        }
      }
      if (result.file_conflicts.length > 0) {
        console.log(chalk.bold('  File conflicts:'));
        for (const conflict of result.file_conflicts) {
          console.log(`    ${chalk.yellow(conflict.file)} ${chalk.dim(conflict.worktrees.join(', '))}`);
        }
      }
      if (result.branch_conflicts.length > 0) {
        console.log(chalk.bold('  Branch conflicts:'));
        for (const conflict of result.branch_conflicts) {
          console.log(`    ${chalk.yellow(conflict.worktreeA)} ${chalk.dim('vs')} ${chalk.yellow(conflict.worktreeB)}`);
        }
      }
    }

    if (!ok) process.exitCode = 1;
  });

gateCmd
  .command('ai')
  .description('Run the AI-style merge gate to assess semantic integration risk across worktrees')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = await runAiMergeGate(db, repoRoot);
    db.close();

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const badge = result.status === 'pass'
        ? chalk.green('PASS')
        : result.status === 'warn'
          ? chalk.yellow('WARN')
          : chalk.red('BLOCK');
      console.log(`${badge} ${result.summary}`);

      const riskyPairs = result.pairs.filter((pair) => pair.status !== 'pass');
      if (riskyPairs.length > 0) {
        console.log(chalk.bold('  Risky pairs:'));
        for (const pair of riskyPairs) {
          console.log(`    ${chalk.cyan(pair.worktree_a)} ${chalk.dim('vs')} ${chalk.cyan(pair.worktree_b)} ${chalk.dim(pair.status)} ${chalk.dim(`score=${pair.score}`)}`);
          for (const reason of pair.reasons.slice(0, 3)) {
            console.log(`      ${chalk.yellow(reason)}`);
          }
        }
      }

      const riskyWorktrees = result.worktrees.filter((worktree) => worktree.findings.length > 0);
      if (riskyWorktrees.length > 0) {
        console.log(chalk.bold('  Worktree signals:'));
        for (const worktree of riskyWorktrees) {
          console.log(`    ${chalk.cyan(worktree.worktree)} ${chalk.dim(`score=${worktree.score}`)}`);
          for (const finding of worktree.findings.slice(0, 2)) {
            console.log(`      ${chalk.yellow(finding)}`);
          }
        }
      }
    }

    if (result.status === 'blocked') process.exitCode = 1;
  });

// ── monitor ──────────────────────────────────────────────────────────────────

const monitorCmd = program.command('monitor').description('Observe worktrees for runtime file mutations');

monitorCmd
  .command('once')
  .description('Capture one monitoring pass and log observed file changes')
  .option('--json', 'Output raw JSON')
  .option('--quarantine', 'Move or restore denied runtime changes immediately after detection')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const worktrees = listGitWorktrees(repoRoot);
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
      const badge = event.status === 'allowed' ? chalk.green('ALLOWED') : chalk.red('DENIED ');
      const action = event.enforcement_action ? ` ${chalk.dim(event.enforcement_action)}` : '';
      console.log(`  ${badge} ${chalk.cyan(event.worktree)} ${chalk.yellow(event.file_path)} ${chalk.dim(event.change_type)}${event.reason_code ? ` ${chalk.dim(event.reason_code)}` : ''}${action}`);
    }
  });

monitorCmd
  .command('watch')
  .description('Poll worktrees continuously and log observed file changes')
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

    console.log(chalk.cyan(`Watching worktrees every ${intervalMs}ms. Press Ctrl+C to stop.`));

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
      const worktrees = listGitWorktrees(repoRoot);
      const result = monitorWorktreesOnce(db, repoRoot, worktrees, { quarantine: opts.quarantine });
      db.close();

      for (const event of result.events) {
        const badge = event.status === 'allowed' ? chalk.green('ALLOWED') : chalk.red('DENIED ');
        const action = event.enforcement_action ? ` ${chalk.dim(event.enforcement_action)}` : '';
        console.log(`  ${badge} ${chalk.cyan(event.worktree)} ${chalk.yellow(event.file_path)} ${chalk.dim(event.change_type)}${event.reason_code ? ` ${chalk.dim(event.reason_code)}` : ''}${action}`);
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
    const existingState = readMonitorState(repoRoot);

    if (existingState && isProcessRunning(existingState.pid)) {
      console.log(chalk.yellow(`Monitor already running with pid ${existingState.pid}`));
      return;
    }

    const logPath = join(repoRoot, '.switchman', 'monitor.log');
    const child = spawn(process.execPath, [
      process.argv[1],
      'monitor',
      'watch',
      '--interval-ms',
      String(intervalMs),
      ...(opts.quarantine ? ['--quarantine'] : []),
      '--daemonized',
    ], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const statePath = writeMonitorState(repoRoot, {
      pid: child.pid,
      interval_ms: intervalMs,
      quarantine: Boolean(opts.quarantine),
      log_path: logPath,
      started_at: new Date().toISOString(),
    });

    console.log(`${chalk.green('✓')} Started monitor pid ${chalk.cyan(String(child.pid))}`);
    console.log(`${chalk.dim('State:')} ${statePath}`);
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

// ── policy ───────────────────────────────────────────────────────────────────

const policyCmd = program.command('policy').description('Manage enforcement policy exceptions');

policyCmd
  .command('init')
  .description('Write a starter enforcement policy file for generated-path exceptions')
  .action(() => {
    const repoRoot = getRepo();
    const policyPath = writeEnforcementPolicy(repoRoot, {
      allowed_generated_paths: [
        'dist/**',
        'build/**',
        'coverage/**',
      ],
    });
    console.log(`${chalk.green('✓')} Wrote enforcement policy to ${chalk.cyan(policyPath)}`);
  });

program.parse();
