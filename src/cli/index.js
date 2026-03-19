#!/usr/bin/env node
/**
 * switchman CLI
 * Conflict-aware task coordinator for parallel AI coding agents
 *
 * Commands:
 *   switchman init               - Initialize in current repo
 *   switchman task add           - Add a task to the queue
 *   switchman task list          - List all tasks
 *   switchman task assign        - Assign task to a workspace
 *   switchman task done          - Mark task complete
 *   switchman worktree add       - Register a workspace
 *   switchman worktree list      - List registered workspaces
 *   switchman scan               - Scan for conflicts across workspaces
 *   switchman claim              - Claim files for a task
 *   switchman status             - Show the repo dashboard
 */

import { Help, program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, posix } from 'path';
import { execSync, spawn } from 'child_process';
import readline from 'readline/promises';

import { cleanupCrashedLandingTempWorktrees, createGitWorktree, findRepoRoot, getWorktreeChangedFiles, gitAssessBranchFreshness, gitBranchExists, listGitWorktrees } from '../core/git.js';
import { matchesPathPatterns } from '../core/ignore.js';
import {
  initDb, openDb,
  DEFAULT_STALE_LEASE_MINUTES,
  createTask, startTaskLease, completeTask, failTask, getBoundaryValidationState, getTaskSpec, listTasks, getTask, getNextPendingTask,
  listDependencyInvalidations, listLeases, listScopeReservations, heartbeatLease, getStaleLeases, reapStaleLeases,
  registerWorktree, listWorktrees, updateWorktreeStatus,
  enqueueMergeItem, escalateMergeQueueItem, getMergeQueueItem, listMergeQueue, listMergeQueueEvents, removeMergeQueueItem, retryMergeQueueItem,
  markMergeQueueState,
  createPolicyOverride, listPolicyOverrides, revokePolicyOverride,
  finishOperationJournalEntry, listOperationJournal, listTempResources, updateTempResource,
  claimFiles, releaseFileClaims, getActiveFileClaims, checkFileConflicts, retryTask,
  upsertTaskSpec,
  listAuditEvents, pruneDatabaseMaintenance, verifyAuditTrail,
  getLeaseExecutionContext, getActiveLeaseForTask,
} from '../core/db.js';
import { scanAllWorktrees } from '../core/detector.js';
import { ensureProjectLocalMcpGitExcludes, getWindsurfMcpConfigPath, upsertAllProjectMcpConfigs, upsertWindsurfMcpConfig } from '../core/mcp.js';
import { evaluateRepoCompliance, gatewayAppendFile, gatewayMakeDirectory, gatewayMovePath, gatewayRemovePath, gatewayWriteFile, installGateHooks, monitorWorktreesOnce, runCommitGate, runWrappedCommand, writeEnforcementPolicy } from '../core/enforcement.js';
import { runAiMergeGate } from '../core/merge-gate.js';
import { clearMonitorState, getMonitorStatePath, isProcessRunning, readMonitorState, writeMonitorState } from '../core/monitor.js';
import { buildPipelinePrSummary, cleanupPipelineLandingRecovery, commentPipelinePr, createPipelineFollowupTasks, evaluatePipelinePolicyGate, executePipeline, exportPipelinePrBundle, getPipelineLandingBranchStatus, getPipelineLandingExplainReport, getPipelineStatus, inferPipelineIdFromBranch, materializePipelineLandingBranch, preparePipelineLandingRecovery, preparePipelineLandingTarget, publishPipelinePr, repairPipelineState, resumePipelineLandingRecovery, runPipeline, startPipeline, summarizePipelinePolicyState, syncPipelinePr } from '../core/pipeline.js';
import { installGitHubActionsWorkflow, resolveGitHubOutputTargets, writeGitHubCiStatus, writeGitHubPipelineLandingStatus } from '../core/ci.js';
import { importCodeObjectsToStore, listCodeObjects, materializeCodeObjects, materializeSemanticIndex, updateCodeObjectSource } from '../core/semantic.js';
import { buildQueueStatusSummary, evaluateQueueRepoGate, resolveQueueSource, runMergeQueue } from '../core/queue.js';
import { DEFAULT_CHANGE_POLICY, DEFAULT_LEASE_POLICY, getChangePolicyPath, loadChangePolicy, loadLeasePolicy, writeChangePolicy, writeLeasePolicy } from '../core/policy.js';
import { planPipelineTasks } from '../core/planner.js';
import { clearSchedulerState, dispatchReadyTasks, getSchedulerStatePath, readSchedulerState, writeSchedulerState } from '../core/scheduler.js';
import {
  captureTelemetryEvent,
  disableTelemetry,
  enableTelemetry,
  getTelemetryConfigPath,
  getTelemetryRuntimeConfig,
  loadTelemetryConfig,
  maybePromptForTelemetry,
  sendTelemetryEvent,
} from '../core/telemetry.js';
import { checkLicence, clearCredentials, FREE_AGENT_LIMIT, getRetentionDaysForCurrentPlan, loginWithGitHub, PRO_PAGE_URL, readCredentials } from '../core/licence.js';
import { homedir } from 'os';
import { cleanupOldSyncEvents, pullActiveTeamMembers, pullTeamState, pushSyncEvent } from '../core/sync.js';
import { registerClaudeCommands } from './commands/claude.js';
import { registerMcpCommands } from './commands/mcp.js';
import { registerAuditCommands } from './commands/audit.js';
import { registerAccountCommands } from './commands/account.js';
import { registerGateCommands } from './commands/gate.js';
import { registerLeaseCommands } from './commands/lease.js';
import { registerMonitorCommands } from './commands/monitor.js';
import { registerOperatorCommands } from './commands/operator.js';
import { registerPipelineCommands } from './commands/pipeline.js';
import { registerPolicyCommands } from './commands/policy.js';
import { registerQueueCommands } from './commands/queue.js';
import { registerTaskCommands } from './commands/task.js';
import { registerTelemetryCommands } from './commands/telemetry.js';
import { registerWorktreeCommands } from './commands/worktree.js';
import { registerSchedulerCommands } from './commands/scheduler.js';
import {
  buildPlanningCommentBody,
  collectPlanContext,
  fetchGitHubIssueContext,
  formatHumanList,
  planTaskPriority,
  postPlanningSummaryComment,
  resolveBranchFromEnv,
  resolvePlanningWorktrees,
  resolvePrNumberFromEnv,
  slugifyValue,
} from './planning.js';
import {
  collectSetupVerification,
  renderClaudeGuide,
  renderSetupVerification,
} from './setup.js';
import {
  buildRecoverReport,
  printRecoverSummary,
  printRepairSummary,
  repairRepoState,
} from './repair.js';
import {
  buildSessionSummary,
  analyzeTaskScope,
  buildClaimExplainReport,
  buildDoctorReport,
  buildLandingStateLabel,
  buildPipelineHistoryReport,
  buildQueueExplainReport,
  buildStalePipelineExplainReport,
  buildStaleTaskExplainReport,
  collectStatusSnapshot,
  humanizeReasonCode,
  nextStepForReason,
  renderUnifiedStatusReport,
  summarizeTeamCoordinationState,
} from './reports.js';
import {
  buildWatchSignature,
  colorForHealth,
  formatClockTime,
  formatRelativePolicy,
  healthLabel,
  printErrorWithNext,
  printTable,
  renderChip,
  renderMetricRow,
  renderMiniBar,
  renderPanel,
  renderSignalStrip,
  sleepSync,
  statusBadge,
} from './ui.js';

const originalProcessEmit = process.emit.bind(process);
process.emit = function patchedProcessEmit(event, ...args) {
  if (event === 'warning') {
    const [warning] = args;
    if (warning?.name === 'ExperimentalWarning' && warning?.message?.includes('SQLite')) {
      return false;
    }
  }
  return originalProcessEmit(event, ...args);
};

function installMcpConfig(targetDirs) {
  return targetDirs.flatMap((targetDir) => upsertAllProjectMcpConfigs(targetDir));
}

async function confirmCliAction(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return 'non_interactive';
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = String(await rl.question(prompt)).trim().toLowerCase();
    if (!answer || answer === 'y' || answer === 'yes') return 'yes';
    if (answer === 'n' || answer === 'no') return 'no';
    if (answer === 'e' || answer === 'edit') return 'edit';
    return 'no';
  } finally {
    rl.close();
  }
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

function getOptionalDb(repoRoot) {
  try {
    return openDb(repoRoot);
  } catch {
    return null;
  }
}

function assertWorkspaceRepoHasCommit(repoRoot) {
  try {
    execSync('git rev-parse HEAD', {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Your repo needs at least one commit before agent workspaces can be created.');
  }
}

function createStartPlanningWorktrees(agentCount) {
  return Array.from({ length: agentCount }, (_, index) => ({
    name: `agent${index + 1}`,
    path: null,
    branch: `${index + 1}`,
  }));
}

async function provisionAgentWorkspaces(repoRoot, {
  agentCount,
  prefix = 'switchman',
  monitor = true,
  monitorIntervalMs = 2000,
}) {
  assertWorkspaceRepoHasCommit(repoRoot);

  const db = initDb(repoRoot);
  const created = [];

  for (let i = 1; i <= agentCount; i++) {
    const name = `agent${i}`;
    const branch = `${prefix}/agent${i}`;
    try {
      const wtPath = createGitWorktree(repoRoot, name, branch);
      registerWorktree(db, { name, path: wtPath, branch });
      created.push({ name, path: wtPath, branch });
    } catch {
      const repoName = repoRoot.split('/').pop();
      const wtPath = join(repoRoot, '..', `${repoName}-${name}`);
      registerWorktree(db, { name, path: wtPath, branch });
      created.push({ name, path: wtPath, branch, existed: true });
    }
  }

  const gitWorktrees = listGitWorktrees(repoRoot);
  for (const wt of gitWorktrees) {
    registerWorktree(db, { name: wt.name, path: wt.path, branch: wt.branch || 'unknown' });
  }

  const mcpConfigWrites = installMcpConfig([...new Set([repoRoot, ...created.map((wt) => wt.path)])]);
  const mcpExclude = ensureProjectLocalMcpGitExcludes(repoRoot);

  const effectiveMonitorIntervalMs = Math.max(100, Number.parseInt(String(monitorIntervalMs), 10) || 2000);
  const monitorState = monitor
    ? startBackgroundMonitor(repoRoot, { intervalMs: effectiveMonitorIntervalMs, quarantine: false })
    : null;

  return {
    db,
    created,
    gitWorktrees,
    mcpConfigWrites,
    mcpExclude,
    monitorState,
    monitorIntervalMs: effectiveMonitorIntervalMs,
  };
}

function createPlannedTasks(db, plannedTasks, title) {
  const createdTaskIds = [];
  for (const task of plannedTasks) {
    const taskDescription = [
      `[Planned from ${title}]`,
      task.suggested_worktree ? `Suggested worktree: ${task.suggested_worktree}` : null,
      task.dependencies?.length > 0 ? `Depends on: ${task.dependencies.join(', ')}` : null,
    ].filter(Boolean).join('\n');
    createTask(db, {
      id: task.id,
      title: task.title,
      description: taskDescription,
      priority: planTaskPriority(task.task_spec),
    });
    upsertTaskSpec(db, task.id, task.task_spec);
    createdTaskIds.push(task.id);
  }
  return createdTaskIds;
}

function retryStaleTasks(db, { pipelineId = null, reason = 'bulk stale retry' } = {}) {
  const invalidations = listDependencyInvalidations(db, { pipelineId });
  const staleTaskIds = [...new Set(invalidations.map((item) => item.affected_task_id).filter(Boolean))];
  const retried = [];
  const skipped = [];

  for (const taskId of staleTaskIds) {
    const task = retryTask(db, taskId, reason);
    if (task) {
      retried.push(task);
    } else {
      skipped.push(taskId);
    }
  }

  return {
    pipeline_id: pipelineId,
    stale_task_ids: staleTaskIds,
    retried,
    skipped,
    invalidation_count: invalidations.length,
  };
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

function writeDemoFile(filePath, contents) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function gitCommitAll(worktreePath, message) {
  execSync('git add .', {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execSync(`git -c user.email="demo@switchman.dev" -c user.name="Switchman Demo" commit -m ${JSON.stringify(message)}`, {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runDemoScenario({ repoPath = null, cleanup = false } = {}) {
  const repoDir = repoPath || join(tmpdir(), `switchman-demo-${Date.now()}`);
  mkdirSync(repoDir, { recursive: true });

  try {
    execSync('git init -b main', { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    execSync('git config user.email "demo@switchman.dev"', { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });
    execSync('git config user.name "Switchman Demo"', { cwd: repoDir, stdio: ['ignore', 'pipe', 'pipe'] });

    writeDemoFile(join(repoDir, 'README.md'), '# Switchman demo repo\n');
    writeDemoFile(join(repoDir, 'src', 'index.js'), 'export function ready() {\n  return true;\n}\n');
    writeDemoFile(join(repoDir, 'docs', 'overview.md'), '# Demo\n');
    gitCommitAll(repoDir, 'Initial demo repo');

    const db = initDb(repoDir);
    registerWorktree(db, { name: 'main', path: repoDir, branch: 'main' });

    const agent1Path = createGitWorktree(repoDir, 'agent1', 'switchman/demo-agent1');
    const agent2Path = createGitWorktree(repoDir, 'agent2', 'switchman/demo-agent2');
    registerWorktree(db, { name: 'agent1', path: agent1Path, branch: 'switchman/demo-agent1' });
    registerWorktree(db, { name: 'agent2', path: agent2Path, branch: 'switchman/demo-agent2' });

    const taskAuth = createTask(db, {
      id: 'demo-01',
      title: 'Add auth helper',
      priority: 9,
    });
    const taskDocs = createTask(db, {
      id: 'demo-02',
      title: 'Document auth flow',
      priority: 8,
    });

    const lease1 = startTaskLease(db, taskAuth, 'agent1');
    claimFiles(db, taskAuth, 'agent1', ['src/auth.js']);

    const lease2 = startTaskLease(db, taskDocs, 'agent2');
    let blockedClaimMessage = null;
    try {
      claimFiles(db, taskDocs, 'agent2', ['src/auth.js']);
    } catch (err) {
      blockedClaimMessage = String(err.message || 'Claim blocked.');
    }
    claimFiles(db, taskDocs, 'agent2', ['docs/auth-flow.md']);

    writeDemoFile(join(agent1Path, 'src', 'auth.js'), 'export function authHeader(token) {\n  return `Bearer ${token}`;\n}\n');
    gitCommitAll(agent1Path, 'Add auth helper');
    completeTask(db, taskAuth);

    writeDemoFile(join(agent2Path, 'docs', 'auth-flow.md'), '# Auth flow\n\n- claims stop overlap early\n');
    gitCommitAll(agent2Path, 'Document auth flow');
    completeTask(db, taskDocs);

    enqueueMergeItem(db, {
      sourceType: 'worktree',
      sourceRef: 'agent1',
      sourceWorktree: 'agent1',
      targetBranch: 'main',
    });
    enqueueMergeItem(db, {
      sourceType: 'worktree',
      sourceRef: 'agent2',
      sourceWorktree: 'agent2',
      targetBranch: 'main',
    });

    const queueRun = await runMergeQueue(db, repoDir, {
      maxItems: 2,
      targetBranch: 'main',
    });
    const queueItems = listMergeQueue(db);
    const gateReport = await scanAllWorktrees(db, repoDir);
    const aiGate = await runAiMergeGate(db, repoDir);

    const result = {
      repo_path: repoDir,
      worktrees: listWorktrees(db).map((worktree) => ({
        name: worktree.name,
        path: worktree.path,
        branch: worktree.branch,
      })),
      tasks: listTasks(db).map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
      })),
      overlap_demo: {
        blocked_path: 'src/auth.js',
        blocked_message: blockedClaimMessage,
        safe_path: 'docs/auth-flow.md',
        leases: [lease1.id, lease2.id],
      },
      queue: {
        processed: queueRun.processed.map((entry) => ({
          status: entry.status,
          item_id: entry.item?.id || null,
          source_ref: entry.item?.source_ref || null,
        })),
        final_items: queueItems.map((item) => ({
          id: item.id,
          status: item.status,
          source_ref: item.source_ref,
        })),
      },
      final_gate: {
        ok: gateReport.conflicts.length === 0
          && gateReport.fileConflicts.length === 0
          && gateReport.unclaimedChanges.length === 0
          && gateReport.complianceSummary.non_compliant === 0
          && aiGate.status !== 'blocked',
        ai_gate_status: aiGate.status,
      },
      next_steps: [
        `cd ${repoDir}`,
        'switchman status',
        'switchman queue status',
      ],
    };

    db.close();
    if (cleanup) {
      rmSync(repoDir, { recursive: true, force: true });
    }
    return result;
  } catch (err) {
    if (cleanup) {
      rmSync(repoDir, { recursive: true, force: true });
    }
    throw err;
  }
}

async function maybeCaptureTelemetry(event, properties = {}, { homeDir = null } = {}) {
  try {
    await maybePromptForTelemetry({ homeDir: homeDir || undefined });
    await captureTelemetryEvent(event, {
      app_version: program.version(),
      os: process.platform,
      node_version: process.version,
      ...properties,
    }, { homeDir: homeDir || undefined });
  } catch {
    // Telemetry must never block CLI usage.
  }
}

function isBusyError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('database is locked') || message.includes('sqlite_busy');
}

function acquireNextTaskLease(db, worktreeName, agent, attempts = 20) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const task = getNextPendingTask(db);
      if (!task) {
        return { task: null, lease: null, exhausted: true };
      }

      const lease = startTaskLease(db, task.id, worktreeName, agent || null);
      if (lease) {
        return { task, lease, exhausted: false };
      }
    } catch (err) {
      if (!isBusyError(err) || attempt === attempts) {
        throw err;
      }
    }

    if (attempt < attempts) {
      sleepSync(75 * attempt);
    }
  }

  return { task: null, lease: null, exhausted: false };
}

function acquireNextTaskLeaseWithRetries(repoRoot, worktreeName, agent, attempts = 20) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let db = null;
    try {
      db = openDb(repoRoot);
      const result = acquireNextTaskLease(db, worktreeName, agent, attempts);
      db.close();
      return result;
    } catch (err) {
      lastError = err;
      try { db?.close(); } catch { /* no-op */ }
      if (!isBusyError(err) || attempt === attempts) {
        throw err;
      }
      sleepSync(100 * attempt);
    }
  }
  throw lastError;
}

function completeTaskWithRetries(repoRoot, taskId, attempts = 20) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let db = null;
    try {
      db = openDb(repoRoot);
      const result = completeTask(db, taskId);
      if (result?.status === 'completed') {
        releaseFileClaims(db, taskId);
      }
      db.close();
      return result;
    } catch (err) {
      lastError = err;
      try { db?.close(); } catch { /* no-op */ }
      if (!isBusyError(err) || attempt === attempts) {
        throw err;
      }
      sleepSync(100 * attempt);
    }
  }
  throw lastError;
}

function startBackgroundMonitor(repoRoot, { intervalMs = 2000, quarantine = false } = {}) {
  const existingState = readMonitorState(repoRoot);
  if (existingState && isProcessRunning(existingState.pid)) {
    return {
      already_running: true,
      state: existingState,
      state_path: getMonitorStatePath(repoRoot),
    };
  }

  const logPath = join(repoRoot, '.switchman', 'monitor.log');
  const child = spawn(process.execPath, [
    process.argv[1],
    'monitor',
    'watch',
    '--interval-ms',
    String(intervalMs),
    ...(quarantine ? ['--quarantine'] : []),
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
    quarantine: Boolean(quarantine),
    log_path: logPath,
    started_at: new Date().toISOString(),
  });

  return {
    already_running: false,
    state: readMonitorState(repoRoot),
    state_path: statePath,
  };
}

function startBackgroundScheduler(repoRoot, { intervalMs = 2000, agentName = 'switchman-scheduler' } = {}) {
  const existingState = readSchedulerState(repoRoot);
  if (existingState && isProcessRunning(existingState.pid)) {
    return {
      already_running: true,
      state: existingState,
      state_path: getSchedulerStatePath(repoRoot),
    };
  }

  const logPath = join(repoRoot, '.switchman', 'scheduler.log');
  const child = spawn(process.execPath, [
    process.argv[1],
    'scheduler',
    'watch',
    '--interval-ms',
    String(intervalMs),
    '--agent',
    String(agentName),
    '--daemonized',
  ], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const statePath = writeSchedulerState(repoRoot, {
    pid: child.pid,
    interval_ms: intervalMs,
    agent_name: agentName,
    log_path: logPath,
    started_at: new Date().toISOString(),
  });

  return {
    already_running: false,
    state: readSchedulerState(repoRoot),
    state_path: statePath,
  };
}

function renderMonitorEvent(event) {
  const ownerText = event.owner_worktree
    ? `${event.owner_worktree}${event.owner_task_id ? ` (${event.owner_task_id})` : ''}`
    : null;
  const claimCommand = event.task_id
    ? `switchman claim ${event.task_id} ${event.worktree} ${event.file_path}`
    : null;

  if (event.status === 'denied') {
    console.log(`${chalk.yellow('⚠')} ${chalk.cyan(event.worktree)} modified ${chalk.yellow(event.file_path)} without governed ownership`);
    if (ownerText) {
      console.log(`   ${chalk.dim('Owned by:')} ${chalk.cyan(ownerText)}${event.owner_task_title ? ` ${chalk.dim(`— ${event.owner_task_title}`)}` : ''}`);
    }
    if (claimCommand) {
      console.log(`   ${chalk.dim('Run:')} ${chalk.cyan(claimCommand)}`);
    }
    console.log(`   ${chalk.dim('Or:')} ${chalk.cyan('switchman status')}  ${chalk.dim('to inspect current claims and blockers')}`);
    if (event.enforcement_action) {
      console.log(`   ${chalk.dim('Action:')} ${event.enforcement_action}`);
    }
    return;
  }

  const ownerSuffix = ownerText ? ` ${chalk.dim(`(${ownerText})`)}` : '';
  console.log(`${chalk.green('✓')} ${chalk.cyan(event.worktree)} ${chalk.yellow(event.file_path)} ${chalk.dim(event.change_type)}${ownerSuffix}`);
}

function resolveMonitoredWorktrees(db, repoRoot) {
  const registeredByPath = new Map(
    listWorktrees(db)
      .filter((worktree) => worktree.path)
      .map((worktree) => [worktree.path, worktree])
  );

  return listGitWorktrees(repoRoot).map((worktree) => {
    const registered = registeredByPath.get(worktree.path);
    if (!registered) return worktree;
    return {
      ...worktree,
      name: registered.name,
      path: registered.path || worktree.path,
      branch: registered.branch || worktree.branch,
    };
  });
}

function discoverMergeCandidates(db, repoRoot, { targetBranch = 'main' } = {}) {
  const worktrees = listWorktrees(db).filter((worktree) => worktree.name !== 'main');
  const activeLeases = new Set(listLeases(db, 'active').map((lease) => lease.worktree));
  const tasks = listTasks(db);
  const queueItems = listMergeQueue(db).filter((item) => item.status !== 'merged');
  const alreadyQueued = new Set(queueItems.map((item) => item.source_worktree).filter(Boolean));

  const eligible = [];
  const blocked = [];
  const skipped = [];

  for (const worktree of worktrees) {
    const doneTasks = tasks.filter((task) => task.worktree === worktree.name && task.status === 'done');
    if (doneTasks.length === 0) {
      skipped.push({
        worktree: worktree.name,
        branch: worktree.branch,
        reason: 'no_completed_tasks',
        summary: 'no completed tasks are assigned to this worktree yet',
        command: `switchman task list --status done`,
      });
      continue;
    }

    if (!worktree.branch || worktree.branch === targetBranch) {
      skipped.push({
        worktree: worktree.name,
        branch: worktree.branch || null,
        reason: 'no_merge_branch',
        summary: `worktree is on ${targetBranch} already`,
        command: `switchman worktree list`,
      });
      continue;
    }

    if (!gitBranchExists(repoRoot, worktree.branch)) {
      blocked.push({
        worktree: worktree.name,
        branch: worktree.branch,
        reason: 'missing_branch',
        summary: `branch ${worktree.branch} is not available in git`,
        command: `switchman worktree sync`,
      });
      continue;
    }

    if (activeLeases.has(worktree.name)) {
      blocked.push({
        worktree: worktree.name,
        branch: worktree.branch,
        reason: 'active_lease',
        summary: 'an active lease is still running in this worktree',
        command: `switchman status`,
      });
      continue;
    }

    if (alreadyQueued.has(worktree.name)) {
      skipped.push({
        worktree: worktree.name,
        branch: worktree.branch,
        reason: 'already_queued',
        summary: 'worktree is already in the landing queue',
        command: `switchman queue status`,
      });
      continue;
    }

    const dirtyFiles = getWorktreeChangedFiles(worktree.path, repoRoot);
    if (dirtyFiles.length > 0) {
      blocked.push({
        worktree: worktree.name,
        branch: worktree.branch,
        path: worktree.path,
        files: dirtyFiles,
        reason: 'dirty_worktree',
        summary: `worktree has uncommitted changes: ${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? ` +${dirtyFiles.length - 5} more` : ''}`,
        command: `cd ${JSON.stringify(worktree.path)} && git status`,
      });
      continue;
    }

    const freshness = gitAssessBranchFreshness(repoRoot, targetBranch, worktree.branch);
    eligible.push({
      worktree: worktree.name,
      branch: worktree.branch,
      path: worktree.path,
      done_task_count: doneTasks.length,
      done_task_titles: doneTasks.slice(0, 3).map((task) => task.title),
      freshness,
    });
  }

  return { eligible, blocked, skipped, queue_items: queueItems };
}

function printMergeDiscovery(discovery) {
  console.log('');
  console.log(chalk.bold(`Checking ${discovery.eligible.length + discovery.blocked.length + discovery.skipped.length} worktree(s)...`));

  for (const entry of discovery.eligible) {
    const freshness = entry.freshness?.state && entry.freshness.state !== 'unknown'
      ? ` ${chalk.dim(`(${entry.freshness.state})`)}`
      : '';
    console.log(`  ${chalk.green('✓')} ${chalk.cyan(entry.worktree)}  ${chalk.dim(entry.branch)}${freshness}`);
  }

  for (const entry of discovery.blocked) {
    console.log(`  ${chalk.yellow('!')} ${chalk.cyan(entry.worktree)}  ${chalk.dim(entry.branch || 'no branch')}  ${chalk.dim(`— ${entry.summary}`)}`);
  }

  for (const entry of discovery.skipped) {
    if (entry.reason === 'no_completed_tasks') continue;
    console.log(`  ${chalk.dim('·')} ${chalk.cyan(entry.worktree)}  ${chalk.dim(entry.branch || 'no branch')}  ${chalk.dim(`— ${entry.summary}`)}`);
  }
}

// ─── Program ──────────────────────────────────────────────────────────────────

program
  .name('switchman')
  .description('Conflict-aware task coordinator for parallel AI coding agents')
  .version('0.1.0');

program.showHelpAfterError('(run with --help for usage examples)');
const ROOT_HELP_COMMANDS = new Set([
  'advanced',
  'claude',
  'demo',
  'start',
  'setup',
  'verify-setup',
  'login',
  'upgrade',
  'plan',
  'task',
  'status',
  'session-summary',
  'recover',
  'merge',
  'scheduler',
  'repair',
  'help',
]);
program.configureHelp({
  visibleCommands(cmd) {
    const commands = Help.prototype.visibleCommands.call(this, cmd);
    if (cmd.parent) return commands;
    return commands.filter((command) => ROOT_HELP_COMMANDS.has(command.name()) && !command._switchmanAdvanced);
  },
});
program.addHelpText('after', `
Start here:
  switchman demo
  switchman start "Add authentication"
  switchman setup --agents 3
  switchman task add "Your task" --priority 8
  switchman status --watch
  switchman session-summary
  switchman recover
  switchman scheduler status
  switchman gate ci && switchman queue run

For you (the operator):
  switchman demo
  switchman start "Add authentication"
  switchman setup
  switchman claude refresh
  switchman task add
  switchman status
  switchman session-summary
  switchman recover
  switchman scheduler status
  switchman merge
  switchman repair
  switchman upgrade
  switchman login
  switchman plan "Add authentication"   (Pro)

For your agents (via CLAUDE.md or MCP):
  switchman lease next
  switchman claim
  switchman task done
  switchman write
  switchman wrap

Docs:
  README.md
  docs/setup-claude-code.md

Power tools:
  switchman advanced --help
`);

const advancedCmd = program
  .command('advanced')
  .description('Show advanced, experimental, and power-user command groups')
  .addHelpText('after', `
Advanced operator commands:
  switchman pipeline <...>
  switchman audit <...>
  switchman policy <...>
  switchman monitor <...>
  switchman repair

Experimental commands:
  switchman semantic <...>
  switchman object <...>

Compatibility aliases:
  switchman doctor

Tip:
  The main help keeps the day-one workflow small on purpose.
`)
  .action(() => {
    advancedCmd.outputHelp();
  });
advancedCmd._switchmanAdvanced = false;

program
  .command('demo')
  .description('Create a throwaway repo that proves overlapping claims are blocked and safe landing works')
  .option('--path <dir>', 'Directory to create the demo repo in')
  .option('--cleanup', 'Delete the demo repo after the run finishes')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Examples:
  switchman demo
  switchman demo --path /tmp/switchman-demo
`)
  .action(async (opts) => {
    try {
      const result = await runDemoScenario({
        repoPath: opts.path || null,
        cleanup: Boolean(opts.cleanup),
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Demo repo ready`);
      console.log(`  ${chalk.dim('path:')} ${result.repo_path}`);
      console.log(`  ${chalk.dim('proof:')} agent2 was blocked from ${chalk.cyan(result.overlap_demo.blocked_path)}`);
      console.log(`  ${chalk.dim('safe reroute:')} agent2 claimed ${chalk.cyan(result.overlap_demo.safe_path)} instead`);
      console.log(`  ${chalk.dim('landing:')} ${result.queue.processed.filter((entry) => entry.status === 'merged').length} queue item(s) merged safely`);
      console.log(`  ${chalk.dim('final gate:')} ${result.final_gate.ok ? chalk.green('clean') : chalk.red('attention needed')}`);
      console.log('');
      console.log(chalk.bold('What to do next:'));
      for (const step of result.next_steps) {
        console.log(`  ${chalk.cyan(step)}`);
      }
      if (!opts.cleanup) {
        console.log('');
        console.log(chalk.dim('The demo repo stays on disk so you can inspect it, record it, or keep experimenting.'));
      }
    } catch (err) {
      printErrorWithNext(err.message, 'switchman demo --json');
      process.exitCode = 1;
    }
  });

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
      const mcpExclude = ensureProjectLocalMcpGitExcludes(repoRoot);

      db.close();
      spinner.succeed(`Initialized in ${chalk.cyan(repoRoot)}`);
      console.log(chalk.dim(`  Found and registered ${gitWorktrees.length} git worktree(s)`));
      console.log(chalk.dim(`  Database: .switchman/switchman.db`));
      console.log(chalk.dim(`  MCP config: ${mcpConfigWrites.filter((result) => result.changed).length} file(s) written`));
      if (mcpExclude.managed) {
        console.log(chalk.dim(`  MCP excludes: ${mcpExclude.changed ? 'updated' : 'already set'} in .git/info/exclude`));
      }
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


// ── start ────────────────────────────────────────────────────────────────────

program
  .command('start [goal]')
  .description('Boot a Switchman session: infer context, propose work, and spin up agent workspaces')
  .option('--issue <number>', 'Read planning context from a GitHub issue via gh')
  .option('--gh-command <command>', 'Executable to use for GitHub CLI', 'gh')
  .option('-a, --agents <n>', 'Number of agent workspaces to create (default: auto)', 'auto')
  .option('--max-tasks <n>', 'Maximum number of suggested tasks', '6')
  .option('--prefix <prefix>', 'Branch prefix for created workspaces (default: switchman)', 'switchman')
  .option('--no-scheduler', 'Do not start the background task scheduler')
  .option('--scheduler-interval-ms <ms>', 'Polling interval for the background scheduler', '2000')
  .option('--no-monitor', 'Do not start the background rogue-edit monitor')
  .option('--monitor-interval-ms <ms>', 'Polling interval for the background monitor', '2000')
  .option('-y, --yes', 'Skip the confirmation prompt and start immediately')
  .addHelpText('after', `
Examples:
  switchman start "Add authentication"
  switchman start --issue 47
  switchman start "Ship the billing flow" --agents 4 --yes
`)
  .action(async (goal, opts) => {
    const repoRoot = getRepo();

    let issueContext = null;
    if (opts.issue) {
      try {
        issueContext = fetchGitHubIssueContext(repoRoot, opts.issue, opts.ghCommand);
      } catch (err) {
        printErrorWithNext(err.message, 'switchman start "Add authentication"');
        process.exitCode = 1;
        return;
      }
    }

    const licence = await checkLicence();
    const requestedAgentCount = String(opts.agents || 'auto').trim().toLowerCase();
    const maxTasks = Math.max(1, Number.parseInt(String(opts.maxTasks), 10) || 6);
    const context = collectPlanContext(repoRoot, goal || null, issueContext);

    let desiredAgentCount = requestedAgentCount === 'auto'
      ? Math.min(maxTasks, licence.valid ? maxTasks : FREE_AGENT_LIMIT)
      : Number.parseInt(requestedAgentCount, 10);

    if (!Number.isInteger(desiredAgentCount) || desiredAgentCount < 1) {
      console.error(chalk.red('--agents must be a positive number or "auto"'));
      process.exit(1);
    }

    if (!licence.valid && desiredAgentCount > FREE_AGENT_LIMIT) {
      console.log('');
      console.log(chalk.red(`  ✗ Agent limit reached (${FREE_AGENT_LIMIT}/${FREE_AGENT_LIMIT})`));
      console.log('');
      console.log(`  You need ${chalk.cyan(`agent${desiredAgentCount}`)} right now.`);
      console.log('');
      console.log(`  Unlock unlimited agents in 60 seconds -> ${chalk.cyan('switchman upgrade')}`);
      console.log(`  ${chalk.dim('Or visit:')} ${chalk.cyan(PRO_PAGE_URL)}`);
      console.log('');
      process.exitCode = 1;
      return;
    }

    const planningWorktrees = createStartPlanningWorktrees(desiredAgentCount);
    const pipelineId = `start-${slugifyValue(context.title)}-${Date.now().toString(36)}`;
    const plannedTasks = planPipelineTasks({
      pipelineId,
      title: context.title,
      description: context.description,
      worktrees: planningWorktrees,
      maxTasks,
      repoRoot,
    });

    if (requestedAgentCount === 'auto') {
      desiredAgentCount = Math.max(1, Math.min(
        plannedTasks.length || 1,
        licence.valid ? Math.max(plannedTasks.length || 1, 1) : FREE_AGENT_LIMIT,
      ));
    }

    const finalPlanningWorktrees = createStartPlanningWorktrees(desiredAgentCount);
    const finalPlannedTasks = planPipelineTasks({
      pipelineId,
      title: context.title,
      description: context.description,
      worktrees: finalPlanningWorktrees,
      maxTasks,
      repoRoot,
    });

    console.log(chalk.bold('Reading repo context...'));
    if (context.found.length > 0) {
      console.log(`${chalk.dim('Found:')} ${context.found.join(', ')}`);
    } else {
      console.log(chalk.dim('Found: local repo context only'));
    }
    console.log('');
    console.log(`${chalk.bold('Suggested plan based on:')} ${context.used.length > 0 ? formatHumanList(context.used) : 'available repo context'}`);
    console.log('');

    finalPlannedTasks.forEach((task, index) => {
      const worktreeLabel = task.suggested_worktree ? chalk.cyan(task.suggested_worktree) : chalk.dim('unassigned');
      console.log(`  ${chalk.green('✓')} ${chalk.bold(`${index + 1}.`)} ${task.title}  ${chalk.dim('→')} ${worktreeLabel}`);
    });

    console.log('');
    console.log(chalk.bold('Session plan:'));
    console.log(`  ${chalk.dim('tier:')} ${licence.valid ? chalk.green('Pro') : chalk.yellow('Free')}`);
    console.log(`  ${chalk.dim('coordination:')} ${licence.valid ? 'local coordination with Pro agent capacity' : 'local coordination only'}`);
    console.log(`  ${chalk.dim('agents:')} ${desiredAgentCount}${!licence.valid ? chalk.dim(` (capped at ${FREE_AGENT_LIMIT} on free)`) : ''}`);
    console.log('');

    if (!opts.yes) {
      const answer = await confirmCliAction('Does this look right? [Y/n/edit] ');
      if (answer === 'non_interactive') {
        console.log(chalk.dim('Non-interactive shell detected — rerun with `switchman start --yes` to create the session.'));
        process.exitCode = 1;
        return;
      }
      if (answer === 'edit') {
        console.log(chalk.dim('Edit the goal or issue context, then rerun `switchman start` with the updated prompt.'));
        return;
      }
      if (answer !== 'yes') {
        console.log(chalk.dim('Start cancelled.'));
        return;
      }
    }

    const spinner = ora('Starting Switchman session...').start();
    let db = null;

    try {
      if (!existsSync(join(repoRoot, 'CLAUDE.md'))) {
        writeFileSync(join(repoRoot, 'CLAUDE.md'), renderClaudeGuide(repoRoot), 'utf8');
      }

      const setupResult = await provisionAgentWorkspaces(repoRoot, {
        agentCount: desiredAgentCount,
        prefix: opts.prefix,
        monitor: opts.monitor,
        monitorIntervalMs: opts.monitorIntervalMs,
      });
      db = setupResult.db;
      createPlannedTasks(db, finalPlannedTasks, context.title);
      const schedulerIntervalMs = Math.max(100, Number.parseInt(String(opts.schedulerIntervalMs), 10) || 2000);
      const schedulerState = opts.scheduler
        ? startBackgroundScheduler(repoRoot, { intervalMs: schedulerIntervalMs })
        : null;

      spinner.succeed(`Switchman start is ready — ${desiredAgentCount} agent workspace${desiredAgentCount === 1 ? '' : 's'} and ${finalPlannedTasks.length} task${finalPlannedTasks.length === 1 ? '' : 's'} prepared`);
      console.log('');
      console.log(chalk.bold('Open your agents here:'));
      for (const wt of setupResult.created) {
        console.log(`  ${chalk.green('✓')} ${chalk.cyan(wt.name)}  ${chalk.dim(wt.path)}`);
      }
      console.log('');
      console.log(chalk.bold('Next steps:'));
      console.log(`  1. Open Claude Code or Cursor in the agent workspaces above`);
      console.log(`  2. Keep the repo dashboard open:`);
      console.log(`     ${chalk.cyan('switchman status --watch')}`);
      if (opts.scheduler) {
        console.log(`  3. Scheduler: ${schedulerState?.already_running ? 'already running' : 'started'} ${chalk.dim(`(${chalk.cyan('switchman scheduler status')})`)}`);
      }
      console.log(`  ${opts.scheduler ? '4' : '3'}. When the first session ends, see what Switchman prevented:`);
      console.log(`     ${chalk.cyan('switchman session-summary')}`);
      if (!licence.valid) {
        console.log(`  ${opts.scheduler ? '5' : '4'}. Need more than ${FREE_AGENT_LIMIT} agents or team sync?`);
        console.log(`     ${chalk.cyan('switchman upgrade')}`);
      }
    } catch (err) {
      spinner.fail(err.message);
      process.exitCode = 1;
    } finally {
      try { db?.close(); } catch { /* no-op */ }
    }
  });


// ── setup ─────────────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('One-command setup: create agent workspaces and initialise Switchman')
  .option('-a, --agents <n>', 'Number of agent workspaces to create (default: 3)', '3')
  .option('--prefix <prefix>', 'Branch prefix (default: switchman)', 'switchman')
  .option('--no-monitor', 'Do not start the background rogue-edit monitor')
  .option('--monitor-interval-ms <ms>', 'Polling interval for the background monitor', '2000')
  .addHelpText('after', `
Examples:
  switchman setup --agents 5
  switchman setup --agents 3 --prefix team
`)
  .action(async (opts) => {
    const agentCount = parseInt(opts.agents);

    if (isNaN(agentCount) || agentCount < 1) {
      console.error(chalk.red('--agents must be a positive number'));
      process.exit(1);
    }

        if (agentCount > FREE_AGENT_LIMIT) {
      const licence = await checkLicence();
      if (!licence.valid) {
        console.log('');
        console.log(chalk.red(`  ✗ Agent limit reached (${FREE_AGENT_LIMIT}/${FREE_AGENT_LIMIT})`));
        console.log('');
        console.log(`  You need ${chalk.cyan(`agent${agentCount}`)} right now.`);
        console.log('');
        console.log(`  Unlock unlimited agents in 60 seconds -> ${chalk.cyan('switchman upgrade')}`);
        console.log(`  ${chalk.dim('Or visit:')} ${chalk.cyan(PRO_PAGE_URL)}`);
        console.log('');
        process.exit(1);
      }
      if (licence.offline) {
        console.log(chalk.dim(`  Pro licence verified (offline cache · ${Math.ceil((7 * 24 * 60 * 60 * 1000 - (Date.now() - (licence.cached_at ?? 0))) / (24 * 60 * 60 * 1000))}d remaining)`));
      }
    }

    const repoRoot = getRepo();
    const spinner = ora('Setting up Switchman...').start();

    try {
      const {
        db,
        created,
        mcpConfigWrites,
        mcpExclude,
        monitorIntervalMs,
        monitorState,
      } = await provisionAgentWorkspaces(repoRoot, {
        agentCount,
        prefix: opts.prefix,
        monitor: opts.monitor,
        monitorIntervalMs: opts.monitorIntervalMs,
      });

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
      if (mcpExclude.managed) {
        console.log(`  ${chalk.green('✓')} ${chalk.cyan(mcpExclude.path)} ${chalk.dim(`(${mcpExclude.changed ? 'updated' : 'unchanged'})`)}`);
      }

      if (opts.monitor) {
        console.log('');
        console.log(chalk.bold('Monitor:'));
        if (monitorState?.already_running) {
          console.log(`  ${chalk.green('✓')} Background rogue-edit monitor already running ${chalk.dim(`(pid ${monitorState.state.pid})`)}`);
        } else {
          console.log(`  ${chalk.green('✓')} Started background rogue-edit monitor ${chalk.dim(`(pid ${monitorState?.state?.pid ?? 'unknown'})`)}`);
        }
        console.log(`    ${chalk.dim('interval:')} ${monitorIntervalMs}ms`);
      }

      console.log('');
      console.log(chalk.bold('Next steps:'));
      console.log(`  1. Add a first task:`);
      console.log(`     ${chalk.cyan('switchman task add "Your first task" --priority 8')}`);
      console.log(`  2. Open Claude Code or Cursor in the workspaces above — the local MCP config will attach Switchman automatically`);
      console.log(`  3. Keep the repo dashboard open while work starts:`);
      console.log(`     ${chalk.cyan('switchman status --watch')}`);
      console.log(`  4. Run the final check and land finished work:`);
      console.log(`     ${chalk.cyan('switchman gate ci')}`);
      console.log(`     ${chalk.cyan('switchman queue run')}`);
      if (opts.monitor) {
        console.log(`  5. Watch for rogue edits or direct writes in real time:`);
        console.log(`     ${chalk.cyan('switchman monitor status')}`);
      }
      console.log('');

      const verification = collectSetupVerification(repoRoot);
      renderSetupVerification(verification, { compact: true });
      await maybeCaptureTelemetry('setup_completed', {
        agent_count: agentCount,
        verification_ok: verification.ok,
      });

    } catch (err) {
      spinner.fail(err.message);
      process.exit(1);
    }
  });

program
  .command('verify-setup')
  .description('Check whether this repo is ready for a smooth first Switchman run')
  .option('--json', 'Output raw JSON')
  .option('--home <path>', 'Override the home directory for editor config checks')
  .addHelpText('after', `
Examples:
  switchman verify-setup
  switchman verify-setup --json

Use this after setup or whenever editor/config wiring feels off.
`)
  .action(async (opts) => {
    const repoRoot = getRepo();
    const report = collectSetupVerification(repoRoot, { homeDir: opts.home || null });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      return;
    }

    renderSetupVerification(report);
    await maybeCaptureTelemetry(report.ok ? 'verify_setup_passed' : 'verify_setup_failed', {
      check_count: report.checks.length,
      next_step_count: report.next_steps.length,
    }, { homeDir: opts.home || null });
    if (!report.ok) process.exitCode = 1;
  });
registerClaudeCommands(program, {
  chalk,
  existsSync,
  getRepo,
  join,
  renderClaudeGuide,
  writeFileSync,
});


// ── mcp ───────────────────────────────────────────────────────────────────────

registerMcpCommands(program, {
  chalk,
  getWindsurfMcpConfigPath,
  upsertWindsurfMcpConfig,
});
registerTelemetryCommands(program, {
  chalk,
  disableTelemetry,
  enableTelemetry,
  getTelemetryConfigPath,
  getTelemetryRuntimeConfig,
  loadTelemetryConfig,
  printErrorWithNext,
  sendTelemetryEvent,
});


// ── plan ──────────────────────────────────────────────────────────────────────

program
  .command('plan [goal]')
  .description('Pro: suggest a parallel task plan from an explicit goal or GitHub issue')
  .option('--issue <number>', 'Read planning context from a GitHub issue via gh')
  .option('--pr <number>', 'Post the resulting plan summary to a GitHub pull request')
  .option('--comment', 'Post a GitHub comment with the created plan summary after --apply')
  .option('--gh-command <command>', 'Executable to use for GitHub CLI', 'gh')
  .option('--apply', 'Create the suggested tasks in Switchman')
  .option('--max-tasks <n>', 'Maximum number of suggested tasks', '6')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Examples:
  switchman plan "Add authentication"
  switchman plan --issue 47
  switchman plan "Add authentication" --apply
  switchman plan --issue 47 --apply --comment
`)
  .action(async (goal, opts) => {
    const repoRoot = getRepo();
    const db = getOptionalDb(repoRoot);

    try {
      const licence = await checkLicence();
      if (!licence.valid) {
        console.log('');
        console.log(chalk.red('  ✗ switchman plan is a Pro feature'));
        console.log(`  ${chalk.dim('Generate parallel task plans from a goal — your repo context, your codebase, structured for agents.')}`);
        console.log(`  ${chalk.dim('Try it free for 30 days ->')} ${chalk.cyan('switchman upgrade')}`);
        console.log(`  ${chalk.dim('Or visit:')} ${chalk.cyan(PRO_PAGE_URL)}`);
        console.log('');
        process.exitCode = 1;
        return;
      }

      let issueContext = null;
      if (opts.issue) {
        try {
          issueContext = fetchGitHubIssueContext(repoRoot, opts.issue, opts.ghCommand);
        } catch (err) {
          printErrorWithNext(err.message, 'switchman plan "Add authentication"');
          process.exitCode = 1;
          return;
        }
      }

      if ((!goal || !goal.trim()) && !issueContext) {
        console.log('');
        console.log(chalk.yellow('  ⚠  AI planning currently requires an explicit goal.'));
        console.log(`  ${chalk.dim('Try:')} ${chalk.cyan('switchman plan "Add authentication"')}`);
        console.log(`  ${chalk.dim('Or:  ')} ${chalk.cyan('switchman plan --issue 47')}`);
        console.log(`  ${chalk.dim('Then:')} ${chalk.cyan('switchman plan "Add authentication" --apply')}`);
        console.log('');
        process.exitCode = 1;
        return;
      }

      if (opts.comment && !opts.apply) {
        console.log('');
        console.log(chalk.yellow('  ⚠  GitHub plan comments are only posted after task creation.'));
        console.log(`  ${chalk.dim('Run:')} ${chalk.cyan('switchman plan --apply --comment')}`);
        console.log('');
        process.exitCode = 1;
        return;
      }

      if (opts.comment && !opts.pr && !issueContext) {
        console.log('');
        console.log(chalk.yellow('  ⚠  Choose where to post the plan summary.'));
        console.log(`  ${chalk.dim('Use:')} ${chalk.cyan('switchman plan --issue 47 --apply --comment')}`);
        console.log(`  ${chalk.dim('Or: ')} ${chalk.cyan('switchman plan "Add authentication" --pr 123 --apply --comment')}`);
        console.log('');
        process.exitCode = 1;
        return;
      }

      const context = collectPlanContext(repoRoot, goal || null, issueContext);
      const planningWorktrees = resolvePlanningWorktrees(repoRoot, db);
      const pipelineId = `plan-${slugifyValue(context.title)}-${Date.now().toString(36)}`;
      const plannedTasks = planPipelineTasks({
        pipelineId,
        title: context.title,
        description: context.description,
        worktrees: planningWorktrees,
        maxTasks: Math.max(1, parseInt(opts.maxTasks, 10) || 6),
        repoRoot,
      });

      if (opts.json) {
        const payload = {
          title: context.title,
          context: {
            found: context.found,
            used: context.used,
            branch: context.branch,
          },
          planned_tasks: plannedTasks.map((task) => ({
            id: task.id,
            title: task.title,
            suggested_worktree: task.suggested_worktree || null,
            task_type: task.task_spec?.task_type || null,
            dependencies: task.dependencies || [],
          })),
          apply_ready: Boolean(db),
        };
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(chalk.bold('Reading repo context...'));
      if (context.found.length > 0) {
        console.log(`${chalk.dim('Found:')} ${context.found.join(', ')}`);
      } else {
        console.log(chalk.dim('Found: local repo context only'));
      }
      console.log('');
      console.log(`${chalk.bold('Suggested plan based on:')} ${context.used.length > 0 ? formatHumanList(context.used) : 'available repo context'}`);
      console.log('');

      plannedTasks.forEach((task, index) => {
        const worktreeLabel = task.suggested_worktree ? chalk.cyan(task.suggested_worktree) : chalk.dim('unassigned');
        console.log(`  ${chalk.green('✓')} ${chalk.bold(`${index + 1}.`)} ${task.title}  ${chalk.dim('→')} ${worktreeLabel}`);
      });

      if (!opts.apply) {
        console.log('');
        if (!db) {
          console.log(chalk.dim('Preview only — run `switchman setup --agents 3` first if you want Switchman to create and track these tasks.'));
        } else {
          console.log(chalk.dim('Preview only — rerun with `switchman plan --apply` to create these tasks.'));
        }
        return;
      }

      if (!db) {
        console.log('');
        console.log(`${chalk.red('✗')} Switchman is not set up in this repo yet.`);
        console.log(`  ${chalk.yellow('next:')} ${chalk.cyan('switchman setup --agents 3')}`);
        process.exitCode = 1;
        return;
      }

      console.log('');
      createPlannedTasks(db, plannedTasks, context.title);
      for (const task of plannedTasks) {
        console.log(`  ${chalk.green('✓')} Created ${chalk.cyan(task.id)} ${chalk.dim(task.title)}`);
      }

      console.log('');
      console.log(`${chalk.green('✓')} Planned ${plannedTasks.length} task(s) from repo context.`);
      if (opts.comment) {
        const commentBody = buildPlanningCommentBody(context, plannedTasks);
        const commentResult = postPlanningSummaryComment(repoRoot, {
          ghCommand: opts.ghCommand,
          issueNumber: issueContext?.number || null,
          prNumber: opts.pr || null,
          body: commentBody,
        });
        const targetLabel = commentResult.target_type === 'pr'
          ? `PR #${commentResult.target_number}`
          : `issue #${commentResult.target_number}`;
        console.log(`  ${chalk.green('✓')} Posted plan summary to ${chalk.cyan(targetLabel)}.`);
      }
      console.log(`  ${chalk.yellow('next:')} ${chalk.cyan('switchman status --watch')}`);
    } finally {
      db?.close();
    }
  });


// ── task ──────────────────────────────────────────────────────────────────────

registerTaskCommands(program, {
  acquireNextTaskLeaseWithRetries,
  analyzeTaskScope,
  chalk,
  completeTaskWithRetries,
  createTask,
  failTask,
  getCurrentWorktreeName,
  getDb,
  getRepo,
  listTasks,
  printErrorWithNext,
  pushSyncEvent,
  releaseFileClaims,
  retryStaleTasks,
  retryTask,
  startTaskLease,
  statusBadge,
  taskJsonWithLease,
});

// ── queue ─────────────────────────────────────────────────────────────────────

registerQueueCommands(program, {
  buildQueueStatusSummary,
  chalk,
  colorForHealth,
  escalateMergeQueueItem,
  enqueueMergeItem,
  evaluatePipelinePolicyGate,
  getDb,
  getRepo,
  healthLabel,
  listMergeQueue,
  listMergeQueueEvents,
  listWorktrees,
  maybeCaptureTelemetry,
  preparePipelineLandingTarget,
  printErrorWithNext,
  pushSyncEvent,
  renderChip,
  renderMetricRow,
  renderPanel,
  renderSignalStrip,
  removeMergeQueueItem,
  retryMergeQueueItem,
  runMergeQueue,
  sleepSync,
  statusBadge,
});

program
  .command('merge')
  .description('Queue finished worktrees and land safe work through one guided front door')
  .option('--target <branch>', 'Target branch to merge into', 'main')
  .option('--dry-run', 'Preview mergeable work without queueing or landing anything')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Examples:
  switchman merge
  switchman merge --dry-run
  switchman merge --target release
`)
  .action(async (opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const discovery = discoverMergeCandidates(db, repoRoot, { targetBranch: opts.target || 'main' });
      const queued = [];

      for (const entry of discovery.eligible) {
        queued.push(enqueueMergeItem(db, {
          sourceType: 'worktree',
          sourceRef: entry.branch,
          sourceWorktree: entry.worktree,
          targetBranch: opts.target || 'main',
          submittedBy: 'switchman merge',
        }));
      }

      const queueItems = listMergeQueue(db);
      const summary = buildQueueStatusSummary(queueItems, { db, repoRoot });
      const mergeOrder = summary.recommended_sequence
        .filter((item) => ['land_now', 'prepare_next'].includes(item.lane))
        .map((item) => item.source_ref);

      if (opts.json) {
        if (opts.dryRun) {
          console.log(JSON.stringify({ discovery, queued, summary, merge_order: mergeOrder, dry_run: true }, null, 2));
          db.close();
          return;
        }

        const gate = await evaluateQueueRepoGate(db, repoRoot);
        const runnableCount = listMergeQueue(db).filter((item) => ['queued', 'retrying'].includes(item.status)).length;
        const result = gate.ok
          ? await runMergeQueue(db, repoRoot, {
            targetBranch: opts.target || 'main',
            maxItems: Math.max(1, runnableCount),
            mergeBudget: Math.max(1, runnableCount),
            followPlan: false,
          })
          : null;
        console.log(JSON.stringify({ discovery, queued, summary, merge_order: mergeOrder, gate, result }, null, 2));
        db.close();
        return;
      }

      printMergeDiscovery(discovery);

      if (discovery.blocked.length > 0) {
        console.log('');
        console.log(chalk.bold('Needs attention before landing:'));
        for (const entry of discovery.blocked) {
          console.log(`  ${chalk.yellow(entry.worktree)}: ${entry.summary}`);
          console.log(`    ${chalk.dim('run:')} ${chalk.cyan(entry.command)}`);
        }
      }

      if (mergeOrder.length > 0) {
        console.log('');
        console.log(`${chalk.bold('Merge order:')} ${mergeOrder.join(' → ')}`);
      }

      if (opts.dryRun) {
        console.log('');
        console.log(chalk.dim('Dry run only — nothing was landed.'));
        db.close();
        return;
      }

      if (discovery.eligible.length === 0) {
        console.log('');
        console.log(chalk.dim('No finished worktrees are ready to land yet.'));
        console.log(`${chalk.yellow('next:')} ${chalk.cyan('switchman status')}`);
        db.close();
        return;
      }

      const gate = await evaluateQueueRepoGate(db, repoRoot);
      if (!gate.ok) {
        console.log('');
        console.log(`${chalk.red('✗')} Merge gate blocked landing`);
        console.log(`  ${chalk.dim(gate.summary)}`);
        console.log(`  ${chalk.yellow('next:')} ${chalk.cyan('switchman gate ci')}`);
        db.close();
        return;
      }

      console.log('');
      const runnableCount = listMergeQueue(db).filter((item) => ['queued', 'retrying'].includes(item.status)).length;
      const result = await runMergeQueue(db, repoRoot, {
        targetBranch: opts.target || 'main',
        maxItems: Math.max(1, runnableCount),
        mergeBudget: Math.max(1, runnableCount),
        followPlan: false,
      });

      const merged = result.processed.filter((item) => item.status === 'merged');
      for (const mergedItem of merged) {
        console.log(`  ${chalk.green('✓')} Landed ${chalk.cyan(mergedItem.item.source_ref)} into ${chalk.bold(mergedItem.item.target_branch)}`);
      }

      if (merged.length > 0 && !result.deferred && result.processed.every((item) => item.status === 'merged')) {
        console.log('');
        console.log(`${chalk.green('✓')} Done. ${merged.length} worktree(s) landed cleanly.`);
        db.close();
        return;
      }

      const blocked = result.processed.find((item) => item.status !== 'merged')?.item || result.deferred || null;
      if (blocked) {
        console.log('');
        console.log(`${chalk.yellow('!')} Landing stopped at ${chalk.cyan(blocked.source_ref)}`);
        if (blocked.last_error_summary) console.log(`  ${chalk.dim(blocked.last_error_summary)}`);
        if (blocked.next_action) console.log(`  ${chalk.yellow('next:')} ${blocked.next_action}`);
      }

      db.close();
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

// ── explain ───────────────────────────────────────────────────────────────────

const explainCmd = program.command('explain').description('Explain why Switchman blocked something and what to do next');
explainCmd.addHelpText('after', `
Examples:
  switchman explain queue mq-123
  switchman explain claim src/auth/login.js
  switchman explain history pipe-123
`);

explainCmd
  .command('queue <itemId>')
  .description('Explain one landing-queue item in plain English')
  .option('--json', 'Output raw JSON')
  .action((itemId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const report = buildQueueExplainReport(db, repoRoot, itemId);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(chalk.bold(`Queue item ${report.item.id}`));
      console.log(`  ${chalk.dim('status:')} ${statusBadge(report.item.status)}`.trim());
      console.log(`  ${chalk.dim('source:')} ${report.item.source_type} ${report.item.source_ref}`);
      console.log(`  ${chalk.dim('target:')} ${report.item.target_branch}`);
      if (report.resolved_source) {
        console.log(`  ${chalk.dim('resolved branch:')} ${chalk.cyan(report.resolved_source.branch)}`);
        if (report.resolved_source.worktree) {
          console.log(`  ${chalk.dim('resolved worktree:')} ${chalk.cyan(report.resolved_source.worktree)}`);
        }
      }
      if (report.resolution_error) {
        console.log(`  ${chalk.red('why:')} ${report.resolution_error}`);
      } else if (report.item.last_error_summary) {
        console.log(`  ${chalk.red('why:')} ${report.item.last_error_summary}`);
      } else {
        console.log(`  ${chalk.dim('why:')} waiting to land`);
      }
      console.log(`  ${chalk.yellow('next:')} ${report.next_action}`);
      if (report.recent_events.length > 0) {
        console.log(chalk.bold('\nRecent events'));
        for (const event of report.recent_events) {
          console.log(`  ${chalk.dim(event.created_at)} ${event.event_type}${event.status ? ` ${statusBadge(event.status).trim()}` : ''}`);
        }
      }
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, 'switchman queue status');
      process.exitCode = 1;
    }
  });

explainCmd
  .command('claim <path>')
  .description('Explain who currently owns a file path')
  .option('--json', 'Output raw JSON')
  .action((filePath, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const report = buildClaimExplainReport(db, filePath);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(chalk.bold(`Claim status for ${report.file_path}`));
      if (report.claims.length === 0 && report.scope_owners.length === 0) {
        console.log(`  ${chalk.green('status:')} unowned`);
        console.log(`  ${chalk.yellow('next:')} switchman claim <taskId> <workspace> ${report.file_path}`);
        return;
      }

      if (report.claims.length > 0) {
        console.log(`  ${chalk.red('explicit claim:')}`);
        for (const claim of report.claims) {
          console.log(`    ${chalk.cyan(claim.worktree)} task:${claim.task_id} ${chalk.dim(`lease:${claim.lease_id}`)}`);
          console.log(`    ${chalk.dim('title:')} ${claim.task_title}`);
        }
      }

      if (report.scope_owners.length > 0) {
        console.log(`  ${chalk.yellow('task scope owner:')}`);
        for (const owner of report.scope_owners) {
          console.log(`    ${chalk.cyan(owner.worktree)} task:${owner.task_id} ${chalk.dim(`lease:${owner.lease_id}`)}`);
          console.log(`    ${chalk.dim('title:')} ${owner.task_title}`);
        }
      }

      const blockingOwner = report.claims[0] || report.scope_owners[0];
      if (blockingOwner) {
        console.log(`  ${chalk.yellow('next:')} inspect ${chalk.cyan(blockingOwner.worktree)} or choose a different file before claiming this path`);
      }
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, 'switchman status');
      process.exitCode = 1;
    }
  });

explainCmd
  .command('stale [taskId]')
  .description('Explain why a task or pipeline is stale and how to revalidate it')
  .option('--pipeline <pipelineId>', 'Explain stale invalidations for a whole pipeline')
  .option('--json', 'Output raw JSON')
  .action((taskId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      if (!opts.pipeline && !taskId) {
        throw new Error('Pass a task id or `--pipeline <id>`.');
      }
      const report = opts.pipeline
        ? buildStalePipelineExplainReport(db, opts.pipeline)
        : buildStaleTaskExplainReport(db, taskId);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      if (opts.pipeline) {
        console.log(chalk.bold(`Stale status for pipeline ${report.pipeline_id}`));
        if (report.stale_clusters.length === 0) {
          console.log(`  ${chalk.green('state:')} no active dependency invalidations`);
          return;
        }
        for (const cluster of report.stale_clusters) {
          console.log(`  ${cluster.severity === 'block' ? chalk.red('why:') : chalk.yellow('why:')} ${cluster.title}`);
          console.log(`  ${chalk.dim('source worktrees:')} ${cluster.source_worktrees.join(', ') || 'unknown'}`);
          console.log(`  ${chalk.dim('affected tasks:')} ${cluster.affected_task_ids.join(', ')}`);
          console.log(`  ${chalk.dim('stale areas:')} ${cluster.stale_areas.join(', ')}`);
        }
        console.log(`  ${chalk.yellow('next:')} ${report.next_action}`);
        return;
      }

      console.log(chalk.bold(`Stale status for ${report.task.id}`));
      console.log(`  ${chalk.dim('title:')} ${report.task.title}`);
      console.log(`  ${chalk.dim('status:')} ${statusBadge(report.task.status)}`.trim());
      if (report.invalidations.length === 0) {
        console.log(`  ${chalk.green('state:')} no active dependency invalidations`);
        return;
      }
      for (const invalidation of report.invalidations) {
        console.log(`  ${chalk.red('why:')} ${invalidation.summary}`);
        console.log(`  ${chalk.dim('source task:')} ${invalidation.source_task_id}`);
        console.log(`  ${chalk.dim('stale area:')} ${invalidation.stale_area}`);
      }
      console.log(`  ${chalk.yellow('next:')} ${report.next_action}`);
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, opts.pipeline ? 'switchman doctor' : 'switchman doctor');
      process.exitCode = 1;
    }
  });

explainCmd
  .command('history <pipelineId>')
  .description('Explain the recent change timeline for one pipeline')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const report = buildPipelineHistoryReport(db, repoRoot, pipelineId);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(chalk.bold(`History for pipeline ${report.pipeline_id}`));
      console.log(`  ${chalk.dim('title:')} ${report.title}`);
      console.log(`  ${chalk.dim('tasks:')} pending ${report.counts.pending} • in progress ${report.counts.in_progress} • done ${report.counts.done} • failed ${report.counts.failed}`);
      if (report.current.queue_items.length > 0) {
        const queueSummary = report.current.queue_items
          .map((item) => `${item.id} ${item.status}`)
          .join(', ');
        console.log(`  ${chalk.dim('queue:')} ${queueSummary}`);
      }
      if (report.current.stale_clusters.length > 0) {
        console.log(`  ${chalk.red('stale:')} ${report.current.stale_clusters[0].title}`);
      }
      if (report.current.landing.last_failure) {
        console.log(`  ${chalk.red('landing:')} ${humanizeReasonCode(report.current.landing.last_failure.reason_code || 'landing_branch_materialization_failed')}`);
      } else if (report.current.landing.stale) {
        console.log(`  ${chalk.yellow('landing:')} synthetic landing branch is stale`);
      } else {
        console.log(`  ${chalk.dim('landing:')} ${report.current.landing.branch} (${report.current.landing.strategy})`);
      }
      console.log(`  ${chalk.yellow('next:')} ${report.next_action}`);

      console.log(chalk.bold('\nTimeline'));
      for (const event of report.events.slice(-20)) {
        const status = event.status ? ` ${statusBadge(event.status).trim()}` : '';
        console.log(`  ${chalk.dim(event.created_at)} ${chalk.cyan(event.label)}${status}`);
        console.log(`    ${event.summary}`);
        if (event.next_action) {
          console.log(`    ${chalk.dim(`next: ${event.next_action}`)}`);
        }
      }
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
      process.exitCode = 1;
    }
  });

explainCmd
  .command('landing <pipelineId>')
  .description('Explain the current landing branch state for a pipeline')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const report = getPipelineLandingExplainReport(db, repoRoot, pipelineId);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(chalk.bold(`Landing status for ${report.pipeline_id}`));
      console.log(`  ${chalk.dim('branch:')} ${report.landing.branch}`);
      console.log(`  ${chalk.dim('strategy:')} ${report.landing.strategy}`);
      if (report.landing.last_failure) {
        console.log(`  ${chalk.red('failure:')} ${humanizeReasonCode(report.landing.last_failure.reason_code || 'landing_branch_materialization_failed')}`);
        if (report.landing.last_failure.failed_branch) {
          console.log(`  ${chalk.dim('failed branch:')} ${report.landing.last_failure.failed_branch}`);
        }
        if (report.landing.last_failure.conflicting_files?.length > 0) {
          console.log(`  ${chalk.dim('conflicts:')} ${report.landing.last_failure.conflicting_files.join(', ')}`);
        }
        if (report.landing.last_failure.output) {
          console.log(`  ${chalk.dim('details:')} ${report.landing.last_failure.output.split('\n')[0]}`);
        }
      } else if (report.landing.last_recovery?.recovery_path) {
        console.log(`  ${chalk.dim('recovery path:')} ${report.landing.last_recovery.recovery_path}`);
        if (report.landing.last_recovery.state?.status) {
          console.log(`  ${chalk.dim('recovery state:')} ${report.landing.last_recovery.state.status}`);
        }
      } else if (report.landing.last_materialized?.head_commit) {
        console.log(`  ${chalk.green('head:')} ${report.landing.last_materialized.head_commit.slice(0, 12)}`);
      } else if (report.landing.stale_reasons.length > 0) {
        for (const reason of report.landing.stale_reasons) {
          console.log(`  ${chalk.red('why:')} ${reason.summary}`);
        }
      } else if (report.landing.last_materialized) {
        console.log(`  ${chalk.green('state:')} landing branch is current`);
      } else {
        console.log(`  ${chalk.yellow('state:')} landing branch has not been materialized yet`);
      }
      console.log(`  ${chalk.yellow('next:')} ${report.next_action}`);
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
      process.exitCode = 1;
    }
  });

// ── pipeline ──────────────────────────────────────────────────────────────────

registerPipelineCommands(program, {
  buildLandingStateLabel,
  buildPipelinePrSummary,
  chalk,
  cleanupPipelineLandingRecovery,
  colorForHealth,
  commentPipelinePr,
  createPipelineFollowupTasks,
  executePipeline,
  exportPipelinePrBundle,
  getDb,
  getRepo,
  getPipelineLandingBranchStatus,
  getPipelineStatus,
  healthLabel,
  humanizeReasonCode,
  inferPipelineIdFromBranch,
  loadChangePolicy,
  materializePipelineLandingBranch,
  preparePipelineLandingRecovery,
  printErrorWithNext,
  publishPipelinePr,
  renderChip,
  renderMetricRow,
  renderPanel,
  renderSignalStrip,
  repairPipelineState,
  resolveBranchFromEnv,
  resolveGitHubOutputTargets,
  resolvePrNumberFromEnv,
  resumePipelineLandingRecovery,
  runPipeline,
  startPipeline,
  summarizePipelinePolicyState,
  syncPipelinePr,
  writeGitHubPipelineLandingStatus,
});

// ── lease ────────────────────────────────────────────────────────────────────

registerLeaseCommands(program, {
  acquireNextTaskLeaseWithRetries,
  chalk,
  getCurrentWorktreeName,
  getDb,
  getRepo,
  getTask,
  heartbeatLease,
  listLeases,
  loadLeasePolicy,
  pushSyncEvent,
  reapStaleLeases,
  startTaskLease,
  statusBadge,
  taskJsonWithLease,
  writeLeasePolicy,
});

// ── worktree ───────────────────────────────────────────────────────────────────

registerWorktreeCommands(program, {
  chalk,
  evaluateRepoCompliance,
  getDb,
  getRepo,
  installMcpConfig,
  listGitWorktrees,
  listWorktrees,
  registerWorktree,
  statusBadge,
});

// ── claim ──────────────────────────────────────────────────────────────────────

program
  .command('claim <taskId> <worktree> [files...]')
  .description('Lock files for a task before editing')
  .option('--agent <name>', 'Agent name')
  .option('--force', 'Emergency override for manual recovery when a conflicting claim is known to be stale or wrong')
  .addHelpText('after', `
Examples:
  switchman claim task-123 agent2 src/auth.js src/server.js
  switchman claim task-123 agent2 src/auth.js --agent cursor

Use this before editing files in a shared repo.
Only use --force for operator-led recovery after checking switchman status or switchman explain claim <path>.
`)
  .action((taskId, worktree, files, opts) => {
    if (!files.length) {
      console.log(chalk.yellow('No files specified.'));
      console.log(`${chalk.yellow('next:')} switchman claim <taskId> <workspace> file1 file2`);
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
        console.log(chalk.dim('\nDo not use --force as a shortcut. Check status or explain the claim first, then only override if the existing claim is known-bad.'));
        console.log(`${chalk.yellow('next:')} switchman status`);
        process.exitCode = 1;
        return;
      }

      const lease = claimFiles(db, taskId, worktree, files, opts.agent);
      console.log(`${chalk.green('✓')} Claimed ${files.length} file(s) for task ${chalk.cyan(taskId)} (${chalk.dim(lease.id)})`);
      pushSyncEvent('claim_added', {
        task_id: taskId,
        lease_id: lease.id,
        file_count: files.length,
        files: files.slice(0, 10),
      }, { worktree }).catch(() => {});
      files.forEach(f => console.log(`  ${chalk.dim(f)}`));
    } catch (err) {
      printErrorWithNext(err.message, 'switchman task list --status in_progress');
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
    const task = getTask(db, taskId);
    releaseFileClaims(db, taskId);
    db.close();
    console.log(`${chalk.green('✓')} Released all claims for task ${chalk.cyan(taskId)}`);
    pushSyncEvent('claim_released', { task_id: taskId }, { worktree: task?.worktree || null }).catch(() => {});
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

registerOperatorCommands(program, {
  buildSessionSummary,
  buildDoctorReport,
  buildRecoverReport,
  buildWatchSignature,
  chalk,
  collectStatusSnapshot,
  colorForHealth,
  formatClockTime,
  getDb,
  getRepo,
  getStaleLeases,
  healthLabel,
  humanizeReasonCode,
  listLeases,
  listTasks,
  maybeCaptureTelemetry,
  nextStepForReason,
  printErrorWithNext,
  printRecoverSummary,
  printRepairSummary,
  pullActiveTeamMembers,
  pullTeamState,
  readCredentials,
  renderChip,
  renderMetricRow,
  renderPanel,
  renderSignalStrip,
  renderUnifiedStatusReport,
  repairRepoState,
  runAiMergeGate,
  scanAllWorktrees,
  sleepSync,
  statusBadge,
  summarizeTeamCoordinationState,
});

// ── gate ─────────────────────────────────────────────────────────────────────

registerAuditCommands(program, {
  buildPipelineHistoryReport,
  chalk,
  getDb,
  getRepo,
  printErrorWithNext,
  statusBadge,
  verifyAuditTrail,
});

registerGateCommands(program, {
  chalk,
  getDb,
  getRepo,
  installGateHooks,
  installGitHubActionsWorkflow,
  maybeCaptureTelemetry,
  resolveGitHubOutputTargets,
  runAiMergeGate,
  runCommitGate,
  scanAllWorktrees,
  writeGitHubCiStatus,
});

const semanticCmd = program
  .command('semantic')
  .description('Inspect or materialize the derived semantic code-object view');
semanticCmd._switchmanAdvanced = true;

semanticCmd
  .command('materialize')
  .description('Write a deterministic semantic index artifact to .switchman/semantic-index.json')
  .action(() => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const worktrees = listWorktrees(db);
    const result = materializeSemanticIndex(repoRoot, { worktrees });
    db.close();
    console.log(`${chalk.green('✓')} Wrote semantic index to ${chalk.cyan(result.output_path)}`);
  });

const objectCmd = program
  .command('object')
  .description('Experimental object-source mode backed by canonical exported code objects');
objectCmd._switchmanAdvanced = true;

objectCmd
  .command('import')
  .description('Import exported code objects from tracked source files into the canonical object store')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const objects = importCodeObjectsToStore(db, repoRoot);
    db.close();
    if (opts.json) {
      console.log(JSON.stringify({ object_count: objects.length, objects }, null, 2));
      return;
    }
    console.log(`${chalk.green('✓')} Imported ${objects.length} code object(s) into the canonical store`);
  });

objectCmd
  .command('list')
  .description('List canonical code objects currently stored in Switchman')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const objects = listCodeObjects(db);
    db.close();
    if (opts.json) {
      console.log(JSON.stringify({ object_count: objects.length, objects }, null, 2));
      return;
    }
    if (objects.length === 0) {
      console.log(chalk.dim('No canonical code objects stored yet. Run `switchman object import` first.'));
      return;
    }
    for (const object of objects) {
      console.log(`${chalk.cyan(object.object_id)} ${chalk.dim(`${object.file_path} ${object.kind}`)}`);
    }
  });

objectCmd
  .command('update <objectId>')
  .description('Update the canonical source text for a stored code object')
  .requiredOption('--text <source>', 'Replacement exported source text')
  .option('--json', 'Output raw JSON')
  .action((objectId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const object = updateCodeObjectSource(db, objectId, opts.text);
    db.close();
    if (!object) {
      console.error(chalk.red(`Unknown code object: ${objectId}`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify({ object }, null, 2));
      return;
    }
    console.log(`${chalk.green('✓')} Updated ${chalk.cyan(object.object_id)} in the canonical object store`);
  });

objectCmd
  .command('materialize')
  .description('Materialize source files from the canonical object store')
  .option('--output-root <path>', 'Alternate root directory to write materialized files into')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const result = materializeCodeObjects(db, repoRoot, { outputRoot: opts.outputRoot || repoRoot });
    db.close();
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`${chalk.green('✓')} Materialized ${result.file_count} file(s) from the canonical object store`);
  });

// ── monitor ──────────────────────────────────────────────────────────────────

registerMonitorCommands(program, {
  chalk,
  clearMonitorState,
  getDb,
  getRepo,
  isProcessRunning,
  monitorWorktreesOnce,
  processExecPath: process.execPath,
  readMonitorState,
  renderMonitorEvent,
  resolveMonitoredWorktrees,
  spawn,
  startBackgroundMonitor,
});

registerSchedulerCommands(program, {
  chalk,
  clearSchedulerState,
  dispatchReadyTasks,
  getDb,
  getRepo,
  isProcessRunning,
  processExecPath: process.execPath,
  readSchedulerState,
  spawn,
  startBackgroundScheduler,
});

// ── policy ───────────────────────────────────────────────────────────────────

registerPolicyCommands(program, {
  chalk,
  createPolicyOverride,
  DEFAULT_CHANGE_POLICY,
  getChangePolicyPath,
  getDb,
  getRepo,
  listPolicyOverrides,
  loadChangePolicy,
  printErrorWithNext,
  revokePolicyOverride,
  writeChangePolicy,
  writeEnforcementPolicy,
});


 
// ── login ──────────────────────────────────────────────────────────────────────
 
registerAccountCommands(program, {
  chalk,
  checkLicence,
  clearCredentials,
  getRepo,
  loginWithGitHub,
  ora,
  PRO_PAGE_URL,
  readCredentials,
});

program.parse();
