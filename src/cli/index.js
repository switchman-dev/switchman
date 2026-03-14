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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, posix } from 'path';
import { execSync, spawn } from 'child_process';

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
  listAuditEvents, pruneDatabaseMaintenance, verifyAuditTrail,
} from '../core/db.js';
import { scanAllWorktrees } from '../core/detector.js';
import { getWindsurfMcpConfigPath, upsertAllProjectMcpConfigs, upsertWindsurfMcpConfig } from '../core/mcp.js';
import { evaluateRepoCompliance, gatewayAppendFile, gatewayMakeDirectory, gatewayMovePath, gatewayRemovePath, gatewayWriteFile, installGateHooks, monitorWorktreesOnce, runCommitGate, runWrappedCommand, writeEnforcementPolicy } from '../core/enforcement.js';
import { runAiMergeGate } from '../core/merge-gate.js';
import { clearMonitorState, getMonitorStatePath, isProcessRunning, readMonitorState, writeMonitorState } from '../core/monitor.js';
import { buildPipelinePrSummary, cleanupPipelineLandingRecovery, commentPipelinePr, createPipelineFollowupTasks, evaluatePipelinePolicyGate, executePipeline, exportPipelinePrBundle, getPipelineLandingBranchStatus, getPipelineLandingExplainReport, getPipelineStatus, inferPipelineIdFromBranch, materializePipelineLandingBranch, preparePipelineLandingRecovery, preparePipelineLandingTarget, publishPipelinePr, repairPipelineState, resumePipelineLandingRecovery, runPipeline, startPipeline, summarizePipelinePolicyState, syncPipelinePr } from '../core/pipeline.js';
import { installGitHubActionsWorkflow, resolveGitHubOutputTargets, writeGitHubCiStatus, writeGitHubPipelineLandingStatus } from '../core/ci.js';
import { importCodeObjectsToStore, listCodeObjects, materializeCodeObjects, materializeSemanticIndex, updateCodeObjectSource } from '../core/semantic.js';
import { buildQueueStatusSummary, evaluateQueueRepoGate, resolveQueueSource, runMergeQueue } from '../core/queue.js';
import { DEFAULT_CHANGE_POLICY, DEFAULT_LEASE_POLICY, getChangePolicyPath, loadChangePolicy, loadLeasePolicy, writeChangePolicy, writeLeasePolicy } from '../core/policy.js';
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

function resolvePrNumberFromEnv(env = process.env) {
  if (env.SWITCHMAN_PR_NUMBER) return String(env.SWITCHMAN_PR_NUMBER);
  if (env.GITHUB_PR_NUMBER) return String(env.GITHUB_PR_NUMBER);

  if (env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
    try {
      const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
      const prNumber = payload.pull_request?.number || payload.issue?.number || null;
      if (prNumber) return String(prNumber);
    } catch {
      // Ignore malformed GitHub event payloads.
    }
  }

  return null;
}

function resolveBranchFromEnv(env = process.env) {
  return env.SWITCHMAN_BRANCH
    || env.GITHUB_HEAD_REF
    || env.GITHUB_REF_NAME
    || null;
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
    queued: chalk.yellow,
    validating: chalk.blue,
    rebasing: chalk.blue,
    retrying: chalk.yellow,
    blocked: chalk.red,
    merging: chalk.blue,
    merged: chalk.green,
    canceled: chalk.gray,
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

function padRight(value, width) {
  return String(value).padEnd(width);
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-9;]*m/g, '');
}

function colorForHealth(health) {
  if (health === 'healthy') return chalk.green;
  if (health === 'warn') return chalk.yellow;
  return chalk.red;
}

function healthLabel(health) {
  if (health === 'healthy') return 'HEALTHY';
  if (health === 'warn') return 'ATTENTION';
  return 'BLOCKED';
}

function renderPanel(title, lines, color = chalk.cyan) {
  const content = lines.length > 0 ? lines : [chalk.dim('No items.')];
  const width = Math.max(
    stripAnsi(title).length + 2,
    ...content.map((line) => stripAnsi(line).length),
  );
  const top = color(`+${'-'.repeat(width + 2)}+`);
  const titleLine = color(`| ${padRight(title, width)} |`);
  const body = content.map((line) => `| ${padRight(line, width)} |`);
  const bottom = color(`+${'-'.repeat(width + 2)}+`);
  return [top, titleLine, top, ...body, bottom];
}

function renderMetricRow(metrics) {
  return metrics.map(({ label, value, color = chalk.white }) => `${chalk.dim(label)} ${color(String(value))}`).join(chalk.dim('   |   '));
}

function renderMiniBar(items) {
  if (!items.length) return chalk.dim('none');
  return items.map(({ label, value, color = chalk.white }) => `${color('■')} ${label}:${value}`).join(chalk.dim('  '));
}

function renderChip(label, value, color = chalk.white) {
  return color(`[${label}:${value}]`);
}

function renderSignalStrip(signals) {
  return signals.join(chalk.dim('  '));
}

function formatClockTime(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function buildWatchSignature(report) {
  return JSON.stringify({
    health: report.health,
    summary: report.summary,
    counts: report.counts,
    active_work: report.active_work,
    attention: report.attention,
    queue_summary: report.queue?.summary || null,
    next_up: report.next_up || null,
    next_steps: report.next_steps,
    suggested_commands: report.suggested_commands,
  });
}

function formatRelativePolicy(policy) {
  return `stale ${policy.stale_after_minutes}m • heartbeat ${policy.heartbeat_interval_seconds}s • auto-reap ${policy.reap_on_status_check ? 'on' : 'off'}`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function boolBadge(ok) {
  return ok ? chalk.green('OK   ') : chalk.yellow('CHECK');
}

function printErrorWithNext(message, nextCommand = null) {
  console.error(chalk.red(message));
  if (nextCommand) {
    console.error(`${chalk.yellow('next:')} ${nextCommand}`);
  }
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

function normalizeCliRepoPath(targetPath) {
  const rawPath = String(targetPath || '').replace(/\\/g, '/').trim();
  const normalized = posix.normalize(rawPath.replace(/^\.\/+/, ''));
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    rawPath.startsWith('/') ||
    /^[A-Za-z]:\//.test(rawPath)
  ) {
    throw new Error('Target path must point to a file inside the repository.');
  }
  return normalized;
}

function buildQueueExplainReport(db, repoRoot, itemId) {
  const item = getMergeQueueItem(db, itemId);
  if (!item) {
    throw new Error(`Queue item ${itemId} does not exist.`);
  }

  let resolved = null;
  let resolutionError = null;
  try {
    resolved = resolveQueueSource(db, repoRoot, item);
  } catch (err) {
    resolutionError = err.message;
  }

  const recentEvents = listMergeQueueEvents(db, item.id, { limit: 5 });
  return {
    item,
    resolved_source: resolved,
    resolution_error: resolutionError,
    next_action: item.next_action || inferQueueExplainNextAction(item, resolved, resolutionError),
    recent_events: recentEvents,
  };
}

function inferQueueExplainNextAction(item, resolved, resolutionError) {
  if (item.status === 'blocked' && item.next_action) return item.next_action;
  if (item.status === 'blocked' && item.last_error_code === 'source_missing') {
    return `Recreate the source branch, then run \`switchman queue retry ${item.id}\`.`;
  }
  if (resolutionError) return 'Fix the source resolution issue, then re-run `switchman explain queue <itemId>` or queue a branch/worktree explicitly.';
  if (item.status === 'retrying' && item.backoff_until) {
    return item.next_action || `Wait until ${item.backoff_until}, or run \`switchman queue retry ${item.id}\` to retry sooner.`;
  }
  if (item.status === 'wave_blocked') {
    return item.next_action || `Run \`switchman explain queue ${item.id}\` to review the shared stale wave, then revalidate the affected pipelines together.`;
  }
  if (item.status === 'escalated') {
    return item.next_action || `Run \`switchman explain queue ${item.id}\` to review the landing risk, then \`switchman queue retry ${item.id}\` when it is ready again.`;
  }
  if (item.status === 'queued' || item.status === 'retrying') return 'Run `switchman queue run` to continue landing queued work.';
  if (item.status === 'merged') return 'No action needed.';
  if (resolved?.pipeline_id) return `Run \`switchman pipeline status ${resolved.pipeline_id}\` to inspect the pipeline state.`;
  return 'Run `switchman queue status` to inspect the landing queue.';
}

function buildClaimExplainReport(db, filePath) {
  const normalizedPath = normalizeCliRepoPath(filePath);
  const activeClaims = getActiveFileClaims(db);
  const directClaims = activeClaims.filter((claim) => claim.file_path === normalizedPath);
  const activeLeases = listLeases(db, 'active');
  const scopeOwners = activeLeases.flatMap((lease) => {
    const taskSpec = getTaskSpec(db, lease.task_id);
    const patterns = taskSpec?.allowed_paths || [];
    if (!patterns.some((pattern) => matchesPathPatterns(normalizedPath, [pattern]))) {
      return [];
    }
    return [{
      lease_id: lease.id,
      task_id: lease.task_id,
      task_title: lease.task_title,
      worktree: lease.worktree,
      agent: lease.agent || null,
      ownership_type: 'scope',
      allowed_paths: patterns,
    }];
  });

  return {
    file_path: normalizedPath,
    claims: directClaims.map((claim) => ({
      lease_id: claim.lease_id,
      task_id: claim.task_id,
      task_title: claim.task_title,
      task_status: claim.task_status,
      worktree: claim.worktree,
      agent: claim.agent || null,
      ownership_type: 'claim',
      heartbeat_at: claim.lease_heartbeat_at || null,
    })),
    scope_owners: scopeOwners.filter((owner, index, all) =>
      all.findIndex((candidate) => candidate.lease_id === owner.lease_id) === index,
    ),
  };
}

function buildStaleTaskExplainReport(db, taskId) {
  const task = getTask(db, taskId);
  if (!task) {
    throw new Error(`Task ${taskId} does not exist.`);
  }

  const invalidations = listDependencyInvalidations(db, { affectedTaskId: taskId });
  return {
    task,
    invalidations: invalidations.map((item) => ({
      ...item,
      details: item.details || {},
      revalidation_set: item.details?.revalidation_set || (item.reason_type === 'semantic_contract_drift' ? 'contract' : item.reason_type === 'semantic_object_overlap' ? 'semantic_object' : item.reason_type === 'shared_module_drift' ? 'shared_module' : item.reason_type === 'subsystem_overlap' ? 'subsystem' : 'scope'),
      stale_area: item.reason_type === 'subsystem_overlap'
        ? `subsystem:${item.subsystem_tag}`
        : item.reason_type === 'semantic_contract_drift'
          ? `contract:${(item.details?.contract_names || []).join('|') || 'unknown'}`
        : item.reason_type === 'semantic_object_overlap'
          ? `object:${(item.details?.object_names || []).join('|') || 'unknown'}`
        : item.reason_type === 'shared_module_drift'
          ? `module:${(item.details?.module_paths || []).join('|') || 'unknown'}`
        : `${item.source_scope_pattern} ↔ ${item.affected_scope_pattern}`,
      summary: item.reason_type === 'semantic_contract_drift'
        ? `${item.details?.source_task_title || item.source_task_id} changed shared contract ${(item.details?.contract_names || []).join(', ') || 'unknown'}`
        : item.reason_type === 'semantic_object_overlap'
          ? `${item.details?.source_task_title || item.source_task_id} changed shared exported object ${(item.details?.object_names || []).join(', ') || 'unknown'}`
          : item.reason_type === 'shared_module_drift'
            ? `${item.details?.source_task_title || item.source_task_id} changed shared module ${(item.details?.module_paths || []).join(', ') || 'unknown'} used by ${(item.details?.dependent_files || []).join(', ') || item.affected_task_id}`
          : `${item.details?.source_task_title || item.source_task_id} changed shared ${item.reason_type === 'subsystem_overlap' ? `subsystem:${item.subsystem_tag}` : 'scope'}`,
    })),
    next_action: invalidations.length > 0
      ? `switchman task retry ${taskId}`
      : null,
  };
}

function normalizeDependencyInvalidation(item) {
  const details = item.details || {};
  return {
    ...item,
    severity: item.severity || details.severity || (item.reason_type === 'semantic_contract_drift' ? 'blocked' : 'warn'),
    details,
    revalidation_set: details.revalidation_set || (item.reason_type === 'semantic_contract_drift' ? 'contract' : item.reason_type === 'semantic_object_overlap' ? 'semantic_object' : item.reason_type === 'shared_module_drift' ? 'shared_module' : item.reason_type === 'subsystem_overlap' ? 'subsystem' : 'scope'),
    stale_area: item.reason_type === 'subsystem_overlap'
      ? `subsystem:${item.subsystem_tag}`
      : item.reason_type === 'semantic_contract_drift'
        ? `contract:${(details.contract_names || []).join('|') || 'unknown'}`
      : item.reason_type === 'semantic_object_overlap'
        ? `object:${(details.object_names || []).join('|') || 'unknown'}`
      : item.reason_type === 'shared_module_drift'
        ? `module:${(details.module_paths || []).join('|') || 'unknown'}`
      : `${item.source_scope_pattern} ↔ ${item.affected_scope_pattern}`,
    summary: item.reason_type === 'semantic_contract_drift'
      ? `${details?.source_task_title || item.source_task_id} changed shared contract ${(details.contract_names || []).join(', ') || 'unknown'}`
      : item.reason_type === 'semantic_object_overlap'
        ? `${details?.source_task_title || item.source_task_id} changed shared exported object ${(details.object_names || []).join(', ') || 'unknown'}`
        : item.reason_type === 'shared_module_drift'
          ? `${details?.source_task_title || item.source_task_id} changed shared module ${(details.module_paths || []).join(', ') || 'unknown'} used by ${(details.dependent_files || []).join(', ') || item.affected_task_id}`
        : `${details?.source_task_title || item.source_task_id} changed shared ${item.reason_type === 'subsystem_overlap' ? `subsystem:${item.subsystem_tag}` : 'scope'}`,
  };
}

function buildStaleClusters(invalidations = []) {
  const clusters = new Map();
  for (const invalidation of invalidations.map(normalizeDependencyInvalidation)) {
    const clusterKey = invalidation.affected_pipeline_id
      ? `pipeline:${invalidation.affected_pipeline_id}`
      : `task:${invalidation.affected_task_id}`;
    if (!clusters.has(clusterKey)) {
      clusters.set(clusterKey, {
        key: clusterKey,
        affected_pipeline_id: invalidation.affected_pipeline_id || null,
        affected_task_ids: new Set(),
        source_task_ids: new Set(),
        source_task_titles: new Set(),
        source_worktrees: new Set(),
        affected_worktrees: new Set(),
        stale_areas: new Set(),
        revalidation_sets: new Set(),
        dependent_files: new Set(),
        dependent_areas: new Set(),
        module_paths: new Set(),
        invalidations: [],
        severity: 'warn',
        highest_affected_priority: 0,
        highest_source_priority: 0,
      });
    }
    const cluster = clusters.get(clusterKey);
    cluster.invalidations.push(invalidation);
    cluster.affected_task_ids.add(invalidation.affected_task_id);
    if (invalidation.source_task_id) cluster.source_task_ids.add(invalidation.source_task_id);
    if (invalidation.details?.source_task_title) cluster.source_task_titles.add(invalidation.details.source_task_title);
    if (invalidation.source_worktree) cluster.source_worktrees.add(invalidation.source_worktree);
    if (invalidation.affected_worktree) cluster.affected_worktrees.add(invalidation.affected_worktree);
    cluster.stale_areas.add(invalidation.stale_area);
    if (invalidation.revalidation_set) cluster.revalidation_sets.add(invalidation.revalidation_set);
    for (const filePath of invalidation.details?.dependent_files || []) cluster.dependent_files.add(filePath);
    for (const area of invalidation.details?.dependent_areas || []) cluster.dependent_areas.add(area);
    for (const modulePath of invalidation.details?.module_paths || []) cluster.module_paths.add(modulePath);
    if (invalidation.severity === 'blocked') cluster.severity = 'block';
    cluster.highest_affected_priority = Math.max(cluster.highest_affected_priority, Number(invalidation.details?.affected_task_priority || 0));
    cluster.highest_source_priority = Math.max(cluster.highest_source_priority, Number(invalidation.details?.source_task_priority || 0));
  }

  const clusterEntries = [...clusters.values()]
    .map((cluster) => {
      const affectedTaskIds = [...cluster.affected_task_ids];
      const sourceTaskTitles = [...cluster.source_task_titles];
      const staleAreas = [...cluster.stale_areas];
      const sourceWorktrees = [...cluster.source_worktrees];
      const affectedWorktrees = [...cluster.affected_worktrees];
      return {
        key: cluster.key,
        affected_pipeline_id: cluster.affected_pipeline_id,
        affected_task_ids: affectedTaskIds,
        invalidation_count: cluster.invalidations.length,
        source_task_ids: [...cluster.source_task_ids],
        source_pipeline_ids: [...new Set(cluster.invalidations.map((item) => item.source_pipeline_id).filter(Boolean))],
        source_task_titles: sourceTaskTitles,
        source_worktrees: sourceWorktrees,
        affected_worktrees: affectedWorktrees,
        stale_areas: staleAreas,
        revalidation_sets: [...cluster.revalidation_sets],
        dependent_files: [...cluster.dependent_files],
        dependent_areas: [...cluster.dependent_areas],
        module_paths: [...cluster.module_paths],
        revalidation_set_type: cluster.revalidation_sets.has('contract')
          ? 'contract'
          : cluster.revalidation_sets.has('shared_module')
            ? 'shared_module'
          : cluster.revalidation_sets.has('semantic_object')
            ? 'semantic_object'
            : cluster.revalidation_sets.has('subsystem')
              ? 'subsystem'
              : 'scope',
        rerun_priority: cluster.severity === 'block'
          ? (cluster.revalidation_sets.has('contract') || cluster.highest_affected_priority >= 8 ? 'urgent' : 'high')
          : cluster.revalidation_sets.has('shared_module') && cluster.dependent_files.size >= 3
            ? 'high'
          : cluster.highest_affected_priority >= 8
            ? 'high'
            : cluster.highest_affected_priority >= 5
              ? 'medium'
              : 'low',
        rerun_priority_score: (cluster.severity === 'block' ? 100 : 0)
          + (cluster.revalidation_sets.has('contract') ? 30 : cluster.revalidation_sets.has('shared_module') ? 20 : cluster.revalidation_sets.has('semantic_object') ? 15 : 0)
          + (cluster.highest_affected_priority * 3)
          + (cluster.dependent_files.size * 4)
          + (cluster.dependent_areas.size * 2)
          + cluster.module_paths.size
          + cluster.invalidations.length,
        rerun_breadth_score: (cluster.dependent_files.size * 4) + (cluster.dependent_areas.size * 2) + cluster.module_paths.size,
        highest_affected_priority: cluster.highest_affected_priority,
        highest_source_priority: cluster.highest_source_priority,
        severity: cluster.severity,
        invalidations: cluster.invalidations,
        title: cluster.affected_pipeline_id
          ? `Pipeline ${cluster.affected_pipeline_id} has ${cluster.invalidations.length} stale ${cluster.revalidation_sets.has('contract') ? 'contract' : cluster.revalidation_sets.has('shared_module') ? 'shared-module' : cluster.revalidation_sets.has('semantic_object') ? 'semantic-object' : 'dependency'} invalidation${cluster.invalidations.length === 1 ? '' : 's'}`
          : `${affectedTaskIds[0]} has ${cluster.invalidations.length} stale ${cluster.revalidation_sets.has('contract') ? 'contract' : cluster.revalidation_sets.has('shared_module') ? 'shared-module' : cluster.revalidation_sets.has('semantic_object') ? 'semantic-object' : 'dependency'} invalidation${cluster.invalidations.length === 1 ? '' : 's'}`,
        detail: `${sourceTaskTitles[0] || cluster.invalidations[0]?.source_task_id || 'unknown source'} -> ${affectedWorktrees.join(', ') || 'unknown target'} (${staleAreas.join(', ')})`,
        next_step: cluster.revalidation_sets.has('contract')
          ? (cluster.affected_pipeline_id
            ? 'retry the stale pipeline tasks together so the affected contract can be revalidated before merge'
            : 'retry the stale task so the affected contract can be revalidated before merge')
          : cluster.revalidation_sets.has('shared_module')
            ? (cluster.affected_pipeline_id
              ? 'retry the stale pipeline tasks together so dependent shared-module work can be revalidated before merge'
              : 'retry the stale task so its shared-module dependency can be revalidated before merge')
          : cluster.affected_pipeline_id
            ? 'retry the stale pipeline tasks together so the whole cluster can be revalidated before merge'
            : 'retry the stale task so it can be revalidated before merge',
        command: cluster.affected_pipeline_id
          ? `switchman task retry-stale --pipeline ${cluster.affected_pipeline_id}`
          : `switchman task retry ${affectedTaskIds[0]}`,
      };
    });

  const causeGroups = new Map();
  for (const cluster of clusterEntries) {
    const primary = cluster.invalidations[0] || {};
    const details = primary.details || {};
    const causeKey = cluster.revalidation_set_type === 'contract'
      ? `contract:${(details.contract_names || []).join('|') || cluster.stale_areas.join('|')}|source:${cluster.source_task_ids.join('|') || 'unknown'}`
      : cluster.revalidation_set_type === 'shared_module'
        ? `shared_module:${(details.module_paths || cluster.module_paths || []).join('|') || cluster.stale_areas.join('|')}|source:${cluster.source_task_ids.join('|') || 'unknown'}`
        : cluster.revalidation_set_type === 'semantic_object'
          ? `semantic_object:${(details.object_names || []).join('|') || cluster.stale_areas.join('|')}|source:${cluster.source_task_ids.join('|') || 'unknown'}`
          : `dependency:${cluster.stale_areas.join('|')}|source:${cluster.source_task_ids.join('|') || 'unknown'}`;
    if (!causeGroups.has(causeKey)) causeGroups.set(causeKey, []);
    causeGroups.get(causeKey).push(cluster);
  }

  for (const [causeKey, relatedClusters] of causeGroups.entries()) {
    const relatedPipelines = [...new Set(relatedClusters.map((cluster) => cluster.affected_pipeline_id).filter(Boolean))];
    const primary = relatedClusters[0];
    const details = primary.invalidations[0]?.details || {};
    const causeSummary = primary.revalidation_set_type === 'contract'
      ? `shared contract drift in ${(details.contract_names || []).join(', ') || 'unknown contract'}`
      : primary.revalidation_set_type === 'shared_module'
        ? `shared module drift in ${(details.module_paths || primary.module_paths || []).join(', ') || 'unknown module'}`
        : primary.revalidation_set_type === 'semantic_object'
          ? `shared exported object drift in ${(details.object_names || []).join(', ') || 'unknown object'}`
          : `shared dependency drift across ${primary.stale_areas.join(', ')}`;
    for (let index = 0; index < relatedClusters.length; index += 1) {
      relatedClusters[index].causal_group_id = `cause-${causeKey}`;
      relatedClusters[index].causal_group_size = relatedClusters.length;
      relatedClusters[index].causal_group_rank = index + 1;
      relatedClusters[index].causal_group_summary = causeSummary;
      relatedClusters[index].related_affected_pipelines = relatedPipelines;
    }
  }

  return clusterEntries.sort((a, b) =>
      b.rerun_priority_score - a.rerun_priority_score
      || (a.severity === 'block' ? -1 : 1) - (b.severity === 'block' ? -1 : 1)
      || (a.revalidation_set_type === 'contract' ? -1 : 1) - (b.revalidation_set_type === 'contract' ? -1 : 1)
      || (a.revalidation_set_type === 'shared_module' ? -1 : 1) - (b.revalidation_set_type === 'shared_module' ? -1 : 1)
      || b.invalidation_count - a.invalidation_count
      || String(a.affected_pipeline_id || a.affected_task_ids[0]).localeCompare(String(b.affected_pipeline_id || b.affected_task_ids[0])));
}

function buildStalePipelineExplainReport(db, pipelineId) {
  const invalidations = listDependencyInvalidations(db, { pipelineId });
  const staleClusters = buildStaleClusters(invalidations)
    .filter((cluster) => cluster.affected_pipeline_id === pipelineId);
  return {
    pipeline_id: pipelineId,
    invalidations: invalidations.map(normalizeDependencyInvalidation),
    stale_clusters: staleClusters,
    next_action: staleClusters.length > 0
      ? `switchman task retry-stale --pipeline ${pipelineId}`
      : null,
  };
}

function parseEventDetails(details) {
  try {
    return JSON.parse(details || '{}');
  } catch {
    return {};
  }
}

function pipelineOwnsAuditEvent(event, pipelineId) {
  if (event.task_id?.startsWith(`${pipelineId}-`)) return true;
  const details = parseEventDetails(event.details);
  if (details.pipeline_id === pipelineId) return true;
  if (details.source_pipeline_id === pipelineId) return true;
  if (Array.isArray(details.task_ids) && details.task_ids.some((taskId) => String(taskId).startsWith(`${pipelineId}-`))) {
    return true;
  }
  return false;
}

function fallbackEventLabel(eventType) {
  return String(eventType || 'event')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function summarizePipelineAuditHistoryEvent(event, pipelineId) {
  const details = parseEventDetails(event.details);
  const defaultNextAction = `switchman pipeline status ${pipelineId}`;

  switch (event.event_type) {
    case 'pipeline_created':
      return {
        label: 'Pipeline created',
        summary: `Created pipeline "${details.title || pipelineId}" with ${(details.task_ids || []).length} planned task${(details.task_ids || []).length === 1 ? '' : 's'}.`,
        next_action: defaultNextAction,
      };
    case 'task_completed':
      return {
        label: 'Task completed',
        summary: `Completed ${event.task_id}.`,
        next_action: defaultNextAction,
      };
    case 'task_failed':
      return {
        label: 'Task failed',
        summary: `Failed ${event.task_id}${event.reason_code ? ` because ${humanizeReasonCode(event.reason_code)}` : ''}.`,
        next_action: defaultNextAction,
      };
    case 'task_retried':
    case 'pipeline_task_retry_scheduled':
      return {
        label: 'Task retry scheduled',
        summary: `Scheduled a retry for ${event.task_id}${details.retry_attempt ? ` (attempt ${details.retry_attempt})` : ''}.`,
        next_action: defaultNextAction,
      };
    case 'dependency_invalidations_updated':
      {
        const reasonTypes = details.reason_types || [];
        const revalidationSets = details.revalidation_sets || [];
      return {
        label: 'Stale work detected',
        summary: `Marked stale work after ${details.source_task_title || details.source_task_id || 'an upstream task'} changed a shared boundary${revalidationSets.length > 0 ? ` across ${revalidationSets.join(', ')} revalidation` : reasonTypes.length > 0 ? ` across ${reasonTypes.join(', ')}` : ''}.`,
        next_action: details.affected_pipeline_id
          ? `switchman explain stale --pipeline ${details.affected_pipeline_id}`
          : defaultNextAction,
      };
      }
    case 'boundary_validation_state':
      return {
        label: 'Boundary validation updated',
        summary: details.summary || 'Updated boundary validation state for the pipeline.',
        next_action: defaultNextAction,
      };
    case 'pipeline_followups_created':
      return {
        label: 'Follow-up work created',
        summary: `Created ${(details.created_task_ids || []).length} follow-up task${(details.created_task_ids || []).length === 1 ? '' : 's'} for review or validation.`,
        next_action: `switchman pipeline review ${pipelineId}`,
      };
    case 'pipeline_pr_summary':
      return {
        label: 'PR summary built',
        summary: 'Built the reviewer-facing pipeline summary.',
        next_action: `switchman pipeline sync-pr ${pipelineId} --pr-from-env`,
      };
    case 'pipeline_pr_bundle_exported':
      return {
        label: 'PR bundle exported',
        summary: 'Exported PR and landing artifacts for CI or review.',
        next_action: `switchman pipeline sync-pr ${pipelineId} --pr-from-env`,
      };
    case 'pipeline_pr_commented':
      return {
        label: 'PR comment updated',
        summary: `Updated PR #${details.pr_number || 'unknown'} with the latest pipeline status.`,
        next_action: defaultNextAction,
      };
    case 'pipeline_pr_synced':
      return {
        label: 'PR sync completed',
        summary: `Synced PR #${details.pr_number || 'unknown'} with bundle artifacts, comment, and CI outputs.`,
        next_action: defaultNextAction,
      };
    case 'pipeline_pr_published':
      return {
        label: 'PR published',
        summary: `Published pipeline PR${details.pr_number ? ` #${details.pr_number}` : ''}.`,
        next_action: defaultNextAction,
      };
    case 'pipeline_landing_branch_materialized':
      return {
        label: event.status === 'allowed' ? 'Landing branch assembled' : 'Landing branch failed',
        summary: event.status === 'allowed'
          ? `Materialized synthetic landing branch ${details.branch || 'unknown'} from ${(details.component_branches || []).length} component branch${(details.component_branches || []).length === 1 ? '' : 'es'}.`
          : `Failed to materialize the landing branch${details.failed_branch ? ` while merging ${details.failed_branch}` : ''}.`,
        next_action: details.next_action || `switchman explain landing ${pipelineId}`,
      };
    case 'pipeline_landing_recovery_prepared':
      return {
        label: 'Landing recovery prepared',
        summary: `Prepared a recovery worktree${details.recovery_path ? ` at ${details.recovery_path}` : ''} for the landing branch.`,
        next_action: details.inspect_command || `switchman pipeline land ${pipelineId} --recover`,
      };
    case 'pipeline_landing_recovery_resumed':
      return {
        label: 'Landing recovery resumed',
        summary: 'Recorded a manually resolved landing branch and marked it ready to queue again.',
        next_action: details.resume_command || `switchman queue add --pipeline ${pipelineId}`,
      };
    case 'pipeline_landing_recovery_cleared':
      return {
        label: 'Landing recovery cleaned up',
        summary: `Cleared the recorded landing recovery worktree${details.recovery_path ? ` at ${details.recovery_path}` : ''}.`,
        next_action: defaultNextAction,
      };
    default:
      return {
        label: fallbackEventLabel(event.event_type),
        summary: details.summary || fallbackEventLabel(event.event_type),
        next_action: defaultNextAction,
      };
  }
}

function summarizePipelineQueueHistoryEvent(item, event) {
  const details = parseEventDetails(event.details);

  switch (event.event_type) {
    case 'merge_queue_enqueued':
      return {
        label: 'Queued for landing',
        summary: `Queued ${item.id} to land ${item.source_ref} onto ${item.target_branch}.${details.policy_override_summary ? ` ${details.policy_override_summary}` : ''}`,
        next_action: 'switchman queue status',
      };
    case 'merge_queue_started':
      return {
        label: 'Queue processing started',
        summary: `Started validating queue item ${item.id}.`,
        next_action: 'switchman queue status',
      };
    case 'merge_queue_retried':
      return {
        label: 'Queue item retried',
        summary: `Moved ${item.id} back into the landing queue for another attempt.`,
        next_action: 'switchman queue status',
      };
    case 'merge_queue_state_changed':
      return {
        label: `Queue ${event.status || 'updated'}`,
        summary: details.last_error_summary
          || (event.status === 'merged'
            ? `Merged ${item.id}${details.merged_commit ? ` at ${String(details.merged_commit).slice(0, 12)}` : ''}.`
            : `Updated ${item.id} to ${event.status || 'unknown'}.`),
        next_action: details.next_action || item.next_action || `switchman explain queue ${item.id}`,
      };
    default:
      return {
        label: fallbackEventLabel(event.event_type),
        summary: fallbackEventLabel(event.event_type),
        next_action: item.next_action || `switchman explain queue ${item.id}`,
      };
  }
}

function buildPipelineHistoryReport(db, repoRoot, pipelineId) {
  const status = getPipelineStatus(db, pipelineId);
  let landing;
  try {
    landing = getPipelineLandingExplainReport(db, repoRoot, pipelineId);
  } catch (err) {
    landing = {
      pipeline_id: pipelineId,
      landing: {
        branch: null,
        strategy: 'unresolved',
        synthetic: false,
        stale: false,
        stale_reasons: [],
        last_failure: {
          reason_code: 'landing_not_ready',
          summary: String(err.message || 'Landing branch is not ready yet.'),
        },
        last_recovery: null,
      },
      next_action: `switchman pipeline status ${pipelineId}`,
    };
  }
  const staleClusters = buildStaleClusters(listDependencyInvalidations(db, { pipelineId }))
    .filter((cluster) => cluster.affected_pipeline_id === pipelineId);
  const queueItems = listMergeQueue(db)
    .filter((item) => item.source_pipeline_id === pipelineId)
    .map((item) => ({
      ...item,
      recent_events: listMergeQueueEvents(db, item.id, { limit: 20 }),
    }));
  const auditEvents = listAuditEvents(db, { limit: 2000 })
    .filter((event) => pipelineOwnsAuditEvent(event, pipelineId));

  const events = [
    ...auditEvents.map((event) => {
      const described = summarizePipelineAuditHistoryEvent(event, pipelineId);
      return {
        source: 'audit',
        id: `audit:${event.id}`,
        created_at: event.created_at,
        event_type: event.event_type,
        status: event.status,
        reason_code: event.reason_code || null,
        task_id: event.task_id || null,
        ...described,
      };
    }),
    ...queueItems.flatMap((item) => item.recent_events.map((event) => {
      const described = summarizePipelineQueueHistoryEvent(item, event);
      return {
        source: 'queue',
        id: `queue:${item.id}:${event.id}`,
        created_at: event.created_at,
        event_type: event.event_type,
        status: event.status || item.status,
        reason_code: null,
        task_id: null,
        queue_item_id: item.id,
        ...described,
      };
    })),
  ].sort((a, b) => {
    const timeCompare = String(a.created_at || '').localeCompare(String(b.created_at || ''));
    if (timeCompare !== 0) return timeCompare;
    return a.id.localeCompare(b.id);
  });

  const blockedQueueItem = queueItems.find((item) => item.status === 'blocked');
  const nextAction = staleClusters[0]?.command
    || blockedQueueItem?.next_action
    || landing.next_action
    || `switchman pipeline status ${pipelineId}`;

  return {
    pipeline_id: pipelineId,
    title: status.title,
    description: status.description,
    counts: status.counts,
    current: {
      stale_clusters: staleClusters,
      queue_items: queueItems.map((item) => ({
        id: item.id,
        status: item.status,
        target_branch: item.target_branch,
        last_error_code: item.last_error_code || null,
        last_error_summary: item.last_error_summary || null,
        next_action: item.next_action || null,
      })),
      landing: {
        branch: landing.landing.branch,
        strategy: landing.landing.strategy,
        synthetic: landing.landing.synthetic,
        stale: landing.landing.stale,
        stale_reasons: landing.landing.stale_reasons,
        last_failure: landing.landing.last_failure,
        last_recovery: landing.landing.last_recovery,
      },
    },
    events,
    next_action: nextAction,
  };
}

function collectKnownPipelineIds(db) {
  return [...new Set(
    listTasks(db)
      .map((task) => getTaskSpec(db, task.id)?.pipeline_id || null)
      .filter(Boolean),
  )].sort();
}

function reconcileWorktreeState(db, repoRoot) {
  const actions = [];
  const dbWorktrees = listWorktrees(db);
  const gitWorktrees = listGitWorktrees(repoRoot);

  const dbByPath = new Map(dbWorktrees.map((worktree) => [worktree.path, worktree]));
  const dbByName = new Map(dbWorktrees.map((worktree) => [worktree.name, worktree]));
  const gitByPath = new Map(gitWorktrees.map((worktree) => [worktree.path, worktree]));

  for (const gitWorktree of gitWorktrees) {
    const dbMatch = dbByPath.get(gitWorktree.path) || dbByName.get(gitWorktree.name) || null;
    if (!dbMatch) {
      registerWorktree(db, {
        name: gitWorktree.name,
        path: gitWorktree.path,
        branch: gitWorktree.branch || 'unknown',
        agent: null,
      });
      actions.push({
        kind: 'git_worktree_registered',
        worktree: gitWorktree.name,
        path: gitWorktree.path,
        branch: gitWorktree.branch || 'unknown',
      });
      continue;
    }

    if (dbMatch.path !== gitWorktree.path || dbMatch.branch !== (gitWorktree.branch || dbMatch.branch) || dbMatch.status === 'missing') {
      registerWorktree(db, {
        name: dbMatch.name,
        path: gitWorktree.path,
        branch: gitWorktree.branch || dbMatch.branch || 'unknown',
        agent: dbMatch.agent,
      });
      actions.push({
        kind: 'db_worktree_reconciled',
        worktree: dbMatch.name,
        path: gitWorktree.path,
        branch: gitWorktree.branch || dbMatch.branch || 'unknown',
      });
    }
  }

  for (const dbWorktree of dbWorktrees) {
    if (!gitByPath.has(dbWorktree.path) && dbWorktree.status !== 'missing') {
      updateWorktreeStatus(db, dbWorktree.name, 'missing');
      actions.push({
        kind: 'db_worktree_marked_missing',
        worktree: dbWorktree.name,
        path: dbWorktree.path,
        branch: dbWorktree.branch,
      });
    }
  }

  return actions;
}

function reconcileTrackedTempResources(db, repoRoot) {
  const actions = [];
  const warnings = [];
  const gitWorktrees = listGitWorktrees(repoRoot);
  const gitPaths = new Set(gitWorktrees.map((worktree) => worktree.path));
  const resources = listTempResources(db, { limit: 500 }).filter((resource) => resource.status !== 'released');

  for (const resource of resources) {
    const exists = existsSync(resource.path);
    const trackedByGit = gitPaths.has(resource.path);

    if (resource.resource_type === 'landing_temp_worktree') {
      if (!exists && !trackedByGit) {
        updateTempResource(db, resource.id, {
          status: 'abandoned',
          details: JSON.stringify({
            repaired_by: 'switchman repair',
            reason: 'temp_worktree_missing_after_interruption',
            path: resource.path,
          }),
        });
        actions.push({
          kind: 'temp_resource_reconciled',
          resource_id: resource.id,
          resource_type: resource.resource_type,
          path: resource.path,
          status: 'abandoned',
        });
      }
      continue;
    }

    if (resource.resource_type === 'landing_recovery_worktree') {
      if (!exists && !trackedByGit) {
        updateTempResource(db, resource.id, {
          status: 'abandoned',
          details: JSON.stringify({
            repaired_by: 'switchman repair',
            reason: 'recovery_worktree_missing',
            path: resource.path,
          }),
        });
        actions.push({
          kind: 'temp_resource_reconciled',
          resource_id: resource.id,
          resource_type: resource.resource_type,
          path: resource.path,
          status: 'abandoned',
        });
      } else if (exists && !trackedByGit) {
        warnings.push({
          kind: 'temp_resource_manual_review',
          resource_id: resource.id,
          resource_type: resource.resource_type,
          path: resource.path,
          status: resource.status,
          next_action: `Inspect ${resource.path} and either re-register it or clean it up with switchman pipeline land ${resource.scope_id} --cleanup ${JSON.stringify(resource.path)}`,
        });
      }
    }
  }

  return { actions, warnings };
}

function summarizeRepairReport(actions = [], warnings = [], notes = []) {
  return {
    auto_fixed: actions,
    manual_review: warnings,
    skipped: [],
    notes,
    counts: {
      auto_fixed: actions.length,
      manual_review: warnings.length,
      skipped: 0,
    },
  };
}

function renderRepairLine(action) {
  if (action.kind === 'git_worktree_registered') {
    return `${chalk.dim('registered git worktree:')} ${action.worktree} ${action.path}`;
  }
  if (action.kind === 'db_worktree_reconciled') {
    return `${chalk.dim('reconciled db worktree:')} ${action.worktree} ${action.path}`;
  }
  if (action.kind === 'db_worktree_marked_missing') {
    return `${chalk.dim('marked missing db worktree:')} ${action.worktree} ${action.path}`;
  }
  if (action.kind === 'queue_item_blocked_missing_worktree') {
    return `${chalk.dim('blocked queue item with missing worktree:')} ${action.queue_item_id} ${action.worktree}`;
  }
  if (action.kind === 'stale_temp_worktree_removed') {
    return `${chalk.dim('removed stale temp landing worktree:')} ${action.path}`;
  }
  if (action.kind === 'stale_temp_worktree_pruned') {
    return `${chalk.dim('pruned stale temp landing metadata:')} ${action.path}`;
  }
  if (action.kind === 'journal_operation_repaired') {
    return `${chalk.dim('closed interrupted operation:')} ${action.operation_type} ${action.scope_type}:${action.scope_id}`;
  }
  if (action.kind === 'queue_item_reset') {
    return `${chalk.dim('queue reset:')} ${action.queue_item_id} ${action.previous_status} -> ${action.status}`;
  }
  if (action.kind === 'pipeline_repaired') {
    return `${chalk.dim('pipeline repair:')} ${action.pipeline_id}`;
  }
  if (action.kind === 'temp_resource_reconciled') {
    return `${chalk.dim('reconciled tracked temp resource:')} ${action.resource_type} ${action.path} -> ${action.status}`;
  }
  return `${chalk.dim(action.kind + ':')} ${JSON.stringify(action)}`;
}

function renderRepairWarningLine(warning) {
  if (warning.kind === 'temp_resource_manual_review') {
    return `${chalk.yellow('manual review:')} ${warning.resource_type} ${warning.path}`;
  }
  return `${chalk.yellow('manual review:')} ${warning.kind}`;
}

function printRepairSummary(report, {
  repairedHeading,
  noRepairHeading,
  limit = null,
} = {}) {
  const autoFixed = report.summary?.auto_fixed || report.actions || [];
  const manualReview = report.summary?.manual_review || report.warnings || [];
  const skipped = report.summary?.skipped || [];
  const limitedAutoFixed = limit == null ? autoFixed : autoFixed.slice(0, limit);
  const limitedManualReview = limit == null ? manualReview : manualReview.slice(0, limit);
  const limitedSkipped = limit == null ? skipped : skipped.slice(0, limit);

  console.log(report.repaired ? repairedHeading : noRepairHeading);
  for (const note of report.notes || []) {
    console.log(`  ${chalk.dim(note)}`);
  }

  console.log(`  ${chalk.green('auto-fixed:')} ${autoFixed.length}`);
  for (const action of limitedAutoFixed) {
    console.log(`    ${renderRepairLine(action)}`);
  }
  console.log(`  ${chalk.yellow('manual review:')} ${manualReview.length}`);
  for (const warning of limitedManualReview) {
    console.log(`    ${renderRepairWarningLine(warning)}`);
  }
  console.log(`  ${chalk.dim('skipped:')} ${skipped.length}`);
  for (const item of limitedSkipped) {
    console.log(`    ${chalk.dim(JSON.stringify(item))}`);
  }
}

function repairRepoState(db, repoRoot) {
  const actions = [];
  const warnings = [];
  const notes = [];
  const repairedQueueItems = new Set();
  for (const action of reconcileWorktreeState(db, repoRoot)) {
    actions.push(action);
  }
  const tempLandingCleanup = cleanupCrashedLandingTempWorktrees(repoRoot);
  for (const action of tempLandingCleanup.actions) {
    actions.push(action);
  }
  const tempResourceReconciliation = reconcileTrackedTempResources(db, repoRoot);
  for (const action of tempResourceReconciliation.actions) {
    actions.push(action);
  }
  for (const warning of tempResourceReconciliation.warnings) {
    warnings.push(warning);
  }
  const queueItems = listMergeQueue(db);
  const runningQueueOperations = listOperationJournal(db, { scopeType: 'queue_item', status: 'running', limit: 200 });

  for (const operation of runningQueueOperations) {
    const item = getMergeQueueItem(db, operation.scope_id);
    if (!item) {
      finishOperationJournalEntry(db, operation.id, {
        status: 'repaired',
        details: JSON.stringify({
          repaired_by: 'switchman repair',
          summary: 'Queue item no longer exists; interrupted journal entry was cleared.',
        }),
      });
      actions.push({
        kind: 'journal_operation_repaired',
        operation_id: operation.id,
        operation_type: operation.operation_type,
        scope_type: operation.scope_type,
        scope_id: operation.scope_id,
      });
      continue;
    }

    if (['validating', 'rebasing', 'merging'].includes(item.status)) {
      const repaired = markMergeQueueState(db, item.id, {
        status: 'retrying',
        lastErrorCode: 'interrupted_queue_run',
        lastErrorSummary: `Queue item ${item.id} was interrupted during ${operation.operation_type} and has been reset to retrying.`,
        nextAction: 'Run `switchman queue run` to resume landing.',
      });
      finishOperationJournalEntry(db, operation.id, {
        status: 'repaired',
        details: JSON.stringify({
          repaired_by: 'switchman repair',
          queue_item_id: item.id,
          previous_status: item.status,
          status: repaired.status,
        }),
      });
      repairedQueueItems.add(item.id);
      actions.push({
        kind: 'queue_item_reset',
        queue_item_id: repaired.id,
        previous_status: item.status,
        status: repaired.status,
        next_action: repaired.next_action,
      });
      actions.push({
        kind: 'journal_operation_repaired',
        operation_id: operation.id,
        operation_type: operation.operation_type,
        scope_type: operation.scope_type,
        scope_id: operation.scope_id,
      });
      continue;
    }

    if (!['running', 'queued', 'retrying'].includes(item.status)) {
      finishOperationJournalEntry(db, operation.id, {
        status: 'repaired',
        details: JSON.stringify({
          repaired_by: 'switchman repair',
          queue_item_id: item.id,
          summary: `Queue item is already ${item.status}; stale running journal entry was cleared.`,
        }),
      });
      actions.push({
        kind: 'journal_operation_repaired',
        operation_id: operation.id,
        operation_type: operation.operation_type,
        scope_type: operation.scope_type,
        scope_id: operation.scope_id,
      });
    }
  }

  const interruptedQueueItems = queueItems.filter((item) => ['validating', 'rebasing', 'merging'].includes(item.status) && !repairedQueueItems.has(item.id));

  for (const item of interruptedQueueItems) {
    const repaired = markMergeQueueState(db, item.id, {
      status: 'retrying',
      lastErrorCode: 'interrupted_queue_run',
      lastErrorSummary: `Queue item ${item.id} was left in ${item.status} and has been reset to retrying.`,
      nextAction: 'Run `switchman queue run` to resume landing.',
    });
    actions.push({
      kind: 'queue_item_reset',
      queue_item_id: repaired.id,
      previous_status: item.status,
      status: repaired.status,
      next_action: repaired.next_action,
      });
  }

  const reconciledWorktrees = new Map(listWorktrees(db).map((worktree) => [worktree.name, worktree]));
  for (const item of queueItems.filter((entry) => ['queued', 'retrying'].includes(entry.status) && entry.source_type === 'worktree')) {
    const worktree = reconciledWorktrees.get(item.source_worktree || item.source_ref) || null;
    if (!worktree || worktree.status === 'missing') {
      const blocked = markMergeQueueState(db, item.id, {
        status: 'blocked',
        lastErrorCode: 'source_worktree_missing',
        lastErrorSummary: `Queued worktree ${item.source_worktree || item.source_ref} is no longer available.`,
        nextAction: `Restore or re-register ${item.source_worktree || item.source_ref}, then run \`switchman queue retry ${item.id}\`.`,
      });
      actions.push({
        kind: 'queue_item_blocked_missing_worktree',
        queue_item_id: blocked.id,
        worktree: item.source_worktree || item.source_ref,
        next_action: blocked.next_action,
      });
    }
  }

  const pipelineIds = [...new Set([
    ...collectKnownPipelineIds(db),
    ...queueItems.map((item) => item.source_pipeline_id).filter(Boolean),
  ])];
  const runningPipelineOperations = listOperationJournal(db, { scopeType: 'pipeline', status: 'running', limit: 200 });

  for (const pipelineId of pipelineIds) {
    const repaired = repairPipelineState(db, repoRoot, pipelineId);
    if (!repaired.repaired) continue;
    actions.push({
      kind: 'pipeline_repaired',
      pipeline_id: pipelineId,
      actions: repaired.actions,
      next_action: repaired.next_action,
    });

    for (const operation of runningPipelineOperations.filter((entry) => entry.scope_id === pipelineId)) {
      finishOperationJournalEntry(db, operation.id, {
        status: 'repaired',
        details: JSON.stringify({
          repaired_by: 'switchman repair',
          pipeline_id: pipelineId,
          repair_actions: repaired.actions.map((action) => action.kind),
        }),
      });
      actions.push({
        kind: 'journal_operation_repaired',
        operation_id: operation.id,
        operation_type: operation.operation_type,
        scope_type: operation.scope_type,
        scope_id: operation.scope_id,
      });
    }
  }

  if (actions.length === 0) {
    notes.push('No safe repair action was needed.');
  }

  const summary = summarizeRepairReport(actions, warnings, notes);

  return {
    repaired: actions.length > 0,
    actions,
    warnings,
    summary,
    notes,
    next_action: warnings[0]?.next_action || (interruptedQueueItems.length > 0 ? 'switchman queue run' : 'switchman status'),
  };
}

function buildLandingStateLabel(landing) {
  if (!landing) return null;
  if (!landing.synthetic) {
    return `${landing.branch} ${chalk.dim('(single branch)')}`;
  }
  if (!landing.last_materialized) {
    return `${landing.branch} ${chalk.yellow('(not created yet)')}`;
  }
  if (landing.stale) {
    return `${landing.branch} ${chalk.red('(stale)')}`;
  }
  return `${landing.branch} ${chalk.green('(current)')}`;
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

function collectSetupVerification(repoRoot, { homeDir = null } = {}) {
  const dbPath = join(repoRoot, '.switchman', 'switchman.db');
  const rootMcpPath = join(repoRoot, '.mcp.json');
  const cursorMcpPath = join(repoRoot, '.cursor', 'mcp.json');
  const claudeGuidePath = join(repoRoot, 'CLAUDE.md');
  const checks = [];
  const nextSteps = [];
  let workspaces = [];
  let db = null;

  const dbExists = existsSync(dbPath);
  checks.push({
    key: 'database',
    ok: dbExists,
    label: 'Project database',
    detail: dbExists ? '.switchman/switchman.db is ready' : 'Switchman database is missing',
  });
  if (!dbExists) {
    nextSteps.push('Run `switchman init` or `switchman setup --agents 3` in this repo.');
  }

  if (dbExists) {
    try {
      db = getDb(repoRoot);
      workspaces = listWorktrees(db);
    } catch {
      checks.push({
        key: 'database_open',
        ok: false,
        label: 'Database access',
        detail: 'Switchman could not open the project database',
      });
      nextSteps.push('Re-run `switchman init` if the project database looks corrupted.');
    } finally {
      try { db?.close(); } catch { /* no-op */ }
    }
  }

  const agentWorkspaces = workspaces.filter((entry) => entry.name !== 'main');
  const workspaceReady = agentWorkspaces.length > 0;
  checks.push({
    key: 'workspaces',
    ok: workspaceReady,
    label: 'Agent workspaces',
    detail: workspaceReady
      ? `${agentWorkspaces.length} agent workspace(s) registered`
      : 'No agent workspaces are registered yet',
  });
  if (!workspaceReady) {
    nextSteps.push('Run `switchman setup --agents 3` to create agent workspaces.');
  }

  const rootMcpExists = existsSync(rootMcpPath);
  checks.push({
    key: 'claude_mcp',
    ok: rootMcpExists,
    label: 'Claude Code MCP',
    detail: rootMcpExists ? '.mcp.json is present in the repo root' : '.mcp.json is missing from the repo root',
  });
  if (!rootMcpExists) {
    nextSteps.push('Re-run `switchman setup --agents 3` to restore the repo-local MCP config.');
  }

  const cursorMcpExists = existsSync(cursorMcpPath);
  checks.push({
    key: 'cursor_mcp',
    ok: cursorMcpExists,
    label: 'Cursor MCP',
    detail: cursorMcpExists ? '.cursor/mcp.json is present in the repo root' : '.cursor/mcp.json is missing from the repo root',
  });
  if (!cursorMcpExists) {
    nextSteps.push('Re-run `switchman setup --agents 3` if you want Cursor to attach automatically.');
  }

  const claudeGuideExists = existsSync(claudeGuidePath);
  checks.push({
    key: 'claude_md',
    ok: claudeGuideExists,
    label: 'Claude guide',
    detail: claudeGuideExists ? 'CLAUDE.md is present' : 'CLAUDE.md is optional but recommended for Claude Code',
  });
  if (!claudeGuideExists) {
    nextSteps.push('If you use Claude Code, add `CLAUDE.md` from the repo root setup guide.');
  }

  const windsurfConfigExists = existsSync(getWindsurfMcpConfigPath(homeDir || undefined));
  checks.push({
    key: 'windsurf_mcp',
    ok: windsurfConfigExists,
    label: 'Windsurf MCP',
    detail: windsurfConfigExists
      ? 'Windsurf shared MCP config is installed'
      : 'Windsurf shared MCP config is optional and not installed',
  });
  if (!windsurfConfigExists) {
    nextSteps.push('If you use Windsurf, run `switchman mcp install --windsurf` once.');
  }

  const ok = checks.every((item) => item.ok || ['claude_md', 'windsurf_mcp'].includes(item.key));
  return {
    ok,
    repo_root: repoRoot,
    checks,
    workspaces: workspaces.map((entry) => ({
      name: entry.name,
      path: entry.path,
      branch: entry.branch,
    })),
    suggested_commands: [
      'switchman status --watch',
      'switchman task add "Your first task" --priority 8',
      'switchman gate ci',
      ...nextSteps.some((step) => step.includes('Windsurf')) ? ['switchman mcp install --windsurf'] : [],
    ],
    next_steps: [...new Set(nextSteps)].slice(0, 6),
  };
}

function renderSetupVerification(report, { compact = false } = {}) {
  console.log(chalk.bold(compact ? 'First-run check:' : 'Setup verification:'));
  for (const check of report.checks) {
    const badge = boolBadge(check.ok);
    console.log(`  ${badge} ${check.label} ${chalk.dim(`— ${check.detail}`)}`);
  }
  if (report.next_steps.length > 0) {
    console.log('');
    console.log(chalk.bold('Fix next:'));
    for (const step of report.next_steps) {
      console.log(`  - ${step}`);
    }
  }
  console.log('');
  console.log(chalk.bold('Try next:'));
  for (const command of report.suggested_commands.slice(0, 4)) {
    console.log(`  ${chalk.cyan(command)}`);
  }
}

function summarizeLeaseScope(db, lease) {
  const reservations = listScopeReservations(db, { leaseId: lease.id });
  const pathScopes = reservations
    .filter((reservation) => reservation.ownership_level === 'path_scope' && reservation.scope_pattern)
    .map((reservation) => reservation.scope_pattern);
  if (pathScopes.length === 1) return `scope:${pathScopes[0]}`;
  if (pathScopes.length > 1) return `scope:${pathScopes.length} paths`;

  const subsystemScopes = reservations
    .filter((reservation) => reservation.ownership_level === 'subsystem' && reservation.subsystem_tag)
    .map((reservation) => reservation.subsystem_tag);
  if (subsystemScopes.length === 1) return `subsystem:${subsystemScopes[0]}`;
  if (subsystemScopes.length > 1) return `subsystem:${subsystemScopes.length}`;
  return null;
}

function isBusyError(err) {
  const message = String(err?.message || '').toLowerCase();
  return message.includes('database is locked') || message.includes('sqlite_busy');
}

function humanizeReasonCode(reasonCode) {
  const labels = {
    no_active_lease: 'no active lease',
    lease_expired: 'lease expired',
    worktree_mismatch: 'wrong worktree',
    path_not_claimed: 'path not claimed',
    path_claimed_by_other_lease: 'claimed by another lease',
    path_scoped_by_other_lease: 'scoped by another lease',
    path_within_task_scope: 'within task scope',
    policy_exception_required: 'policy exception required',
    policy_exception_allowed: 'policy exception allowed',
    changes_outside_claims: 'changed files outside claims',
    changes_outside_task_scope: 'changed files outside task scope',
    missing_expected_tests: 'missing expected tests',
    missing_expected_docs: 'missing expected docs',
    missing_expected_source_changes: 'missing expected source changes',
    objective_not_evidenced: 'task objective not evidenced',
    no_changes_detected: 'no changes detected',
    task_execution_timeout: 'task execution timed out',
    task_failed: 'task failed',
    agent_command_failed: 'agent command failed',
    rejected: 'rejected',
  };
  return labels[reasonCode] || String(reasonCode || 'unknown').replace(/_/g, ' ');
}

function nextStepForReason(reasonCode) {
  const actions = {
    no_active_lease: 'reacquire the task or lease before writing',
    lease_expired: 'refresh or reacquire the lease, then retry',
    worktree_mismatch: 'run the task from the assigned worktree',
    path_not_claimed: 'claim the file before editing it',
    path_claimed_by_other_lease: 'wait for the other task or pick a different file',
    changes_outside_claims: 'claim all edited files or narrow the task scope',
    changes_outside_task_scope: 'keep edits inside allowed paths or update the plan',
    missing_expected_tests: 'add test coverage before rerunning',
    missing_expected_docs: 'add the expected docs change before rerunning',
    missing_expected_source_changes: 'make a source change inside the task scope',
    objective_not_evidenced: 'align the output more closely to the task objective',
    no_changes_detected: 'produce a tracked change or close the task differently',
    task_execution_timeout: 'raise the timeout or reduce task size',
    agent_command_failed: 'inspect stderr/stdout and rerun the agent',
  };
  return actions[reasonCode] || null;
}

function latestTaskFailure(task) {
  const failureLine = String(task.description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse()
    .find((line) => line.startsWith('FAILED: '));
  if (!failureLine) return null;
  const failureText = failureLine.slice('FAILED: '.length);
  const reasonMatch = failureText.match(/^([a-z0-9_]+):\s*(.+)$/i);
  return {
    reason_code: reasonMatch ? reasonMatch[1] : null,
    summary: reasonMatch ? reasonMatch[2] : failureText,
  };
}

function analyzeTaskScope(title, description = '') {
  const text = `${title}\n${description}`.toLowerCase();
  const broadPatterns = [
    /\brefactor\b/,
    /\bwhole repo\b/,
    /\bentire repo\b/,
    /\bacross the repo\b/,
    /\bacross the codebase\b/,
    /\bmultiple modules\b/,
    /\ball routes\b/,
    /\bevery route\b/,
    /\ball files\b/,
    /\bevery file\b/,
    /\brename\b.*\bacross\b/,
    /\bsweep(ing)?\b/,
    /\bglobal\b/,
    /\bwide\b/,
    /\blarge\b/,
  ];
  const matches = broadPatterns.filter((pattern) => pattern.test(text));
  if (matches.length === 0) return null;

  return {
    level: 'warn',
    summary: 'This task looks broad and may fan out across many files or shared areas.',
    next_step: 'Split it into smaller tasks or use `switchman pipeline start` so Switchman can plan and govern the work explicitly.',
    command: `switchman pipeline start "${title.replace(/"/g, '\\"')}"`,
  };
}

function commandForFailedTask(task, failure) {
  if (!task?.id) return null;
  switch (failure?.reason_code) {
    case 'changes_outside_task_scope':
    case 'objective_not_evidenced':
    case 'missing_expected_tests':
    case 'missing_expected_docs':
    case 'missing_expected_source_changes':
    case 'no_changes_detected':
      return `switchman pipeline status ${task.id.split('-').slice(0, -1).join('-')}`;
    default:
      return null;
  }
}

function buildDoctorReport({ db, repoRoot, tasks, activeLeases, staleLeases, scanReport, aiGate }) {
  const changePolicy = loadChangePolicy(repoRoot);
  const failedTasks = tasks
    .filter((task) => task.status === 'failed')
    .map((task) => {
      const failure = latestTaskFailure(task);
      return {
        id: task.id,
        title: task.title,
        worktree: task.worktree || null,
        reason_code: failure?.reason_code || null,
        summary: failure?.summary || 'task failed without a recorded summary',
        next_step: nextStepForReason(failure?.reason_code) || 'inspect the task output and rerun with a narrower scope',
        command: commandForFailedTask(task, failure),
      };
    });

  const worktreeByName = new Map((scanReport.worktrees || []).map((worktree) => [worktree.name, worktree]));
  const blockedWorktrees = scanReport.unclaimedChanges.map((entry) => {
    const worktreeInfo = worktreeByName.get(entry.worktree) || null;
    const reasonCode = entry.reasons?.[0]?.reason_code || null;
    const isDirtyWorktree = reasonCode === 'no_active_lease';
    return {
      worktree: entry.worktree,
      path: worktreeInfo?.path || null,
      files: entry.files,
      reason_code: reasonCode,
      next_step: isDirtyWorktree
        ? 'commit or discard the changed files in that worktree, then rescan before continuing'
        : (nextStepForReason(reasonCode) || 'inspect the changed files and bring them back under Switchman claims'),
      command: worktreeInfo?.path
        ? `cd ${JSON.stringify(worktreeInfo.path)} && git status`
        : 'switchman scan',
    };
  });

  const fileConflicts = scanReport.fileConflicts.map((conflict) => ({
    file: conflict.file,
    worktrees: conflict.worktrees,
    next_step: 'let one task finish first or re-scope the conflicting work',
  }));

  const ownershipConflicts = (scanReport.ownershipConflicts || []).map((conflict) => ({
    type: conflict.type,
    worktree_a: conflict.worktreeA,
    worktree_b: conflict.worktreeB,
    subsystem_tag: conflict.subsystemTag || null,
    scope_a: conflict.scopeA || null,
    scope_b: conflict.scopeB || null,
    next_step: 'split the task scopes or serialize work across the shared ownership boundary',
  }));
  const semanticConflicts = (scanReport.semanticConflicts || []).map((conflict) => ({
    ...conflict,
    next_step: 'review the overlapping exported object or split the work across different boundaries',
  }));

  const branchConflicts = scanReport.conflicts.map((conflict) => ({
    worktree_a: conflict.worktreeA,
    worktree_b: conflict.worktreeB,
    files: conflict.conflictingFiles,
    next_step: 'review the overlapping branches before merge',
  }));

  const staleClusters = buildStaleClusters(aiGate.dependency_invalidations || []);
  const attention = [
    ...staleLeases.map((lease) => ({
      kind: 'stale_lease',
      title: `${lease.worktree} lost its active heartbeat`,
      detail: lease.task_title,
      next_step: 'run `switchman lease reap` to return the task to pending',
      command: 'switchman lease reap',
      severity: 'block',
    })),
    ...failedTasks.map((task) => ({
      kind: 'failed_task',
      title: task.title,
      detail: task.summary,
      next_step: task.next_step,
      command: task.command,
      severity: 'warn',
    })),
    ...blockedWorktrees.map((entry) => ({
      kind: 'unmanaged_changes',
      title: `${entry.worktree} has unmanaged changed files`,
      detail: `${entry.files.slice(0, 5).join(', ')}${entry.files.length > 5 ? ` +${entry.files.length - 5} more` : ''}${entry.path ? ` • ${entry.path}` : ''}`,
      next_step: entry.next_step,
      command: entry.command,
      severity: 'block',
    })),
    ...fileConflicts.map((conflict) => ({
      kind: 'file_conflict',
      title: `${conflict.file} is being edited in multiple worktrees`,
      detail: conflict.worktrees.join(', '),
      next_step: conflict.next_step,
      command: 'switchman scan',
      severity: 'block',
    })),
    ...ownershipConflicts.map((conflict) => ({
      kind: 'ownership_conflict',
      title: conflict.type === 'subsystem_overlap'
        ? `${conflict.worktree_a} and ${conflict.worktree_b} share subsystem ownership`
        : `${conflict.worktree_a} and ${conflict.worktree_b} share scoped ownership`,
      detail: conflict.type === 'subsystem_overlap'
        ? `subsystem:${conflict.subsystem_tag}`
        : `${conflict.scope_a} ↔ ${conflict.scope_b}`,
      next_step: conflict.next_step,
      command: 'switchman scan',
      severity: 'block',
    })),
    ...semanticConflicts.map((conflict) => ({
      kind: 'semantic_conflict',
      title: conflict.type === 'semantic_object_overlap'
        ? `${conflict.worktreeA} and ${conflict.worktreeB} changed the same exported object`
        : `${conflict.worktreeA} and ${conflict.worktreeB} changed semantically similar objects`,
      detail: `${conflict.object_name} (${conflict.fileA} ↔ ${conflict.fileB})`,
      next_step: conflict.next_step,
      command: 'switchman gate ai',
      severity: conflict.severity === 'blocked' ? 'block' : 'warn',
    })),
    ...branchConflicts.map((conflict) => ({
      kind: 'branch_conflict',
      title: `${conflict.worktree_a} and ${conflict.worktree_b} have merge risk`,
      detail: `${conflict.files.slice(0, 3).join(', ')}${conflict.files.length > 3 ? ` +${conflict.files.length - 3} more` : ''}`,
      next_step: conflict.next_step,
      command: 'switchman gate ai',
      severity: 'block',
    })),
  ];

  if (aiGate.status === 'warn' || aiGate.status === 'blocked') {
    attention.push({
      kind: 'ai_merge_gate',
      title: aiGate.status === 'blocked' ? 'AI merge gate blocked the repo' : 'AI merge gate wants manual review',
      detail: aiGate.summary,
      next_step: 'run `switchman gate ai` and review the risky worktree pairs',
      command: 'switchman gate ai',
      severity: aiGate.status === 'blocked' ? 'block' : 'warn',
    });
  }

  for (const validation of aiGate.boundary_validations || []) {
    attention.push({
      kind: 'boundary_validation',
      title: validation.summary,
      detail: validation.rationale?.[0] || `missing ${validation.missing_task_types.join(', ')}`,
      next_step: 'complete the missing validation work before merge',
      command: validation.pipeline_id ? `switchman pipeline status ${validation.pipeline_id}` : 'switchman gate ai',
      severity: validation.severity === 'blocked' ? 'block' : 'warn',
    });
  }

  for (const cluster of staleClusters) {
    attention.push({
      kind: 'dependency_invalidation',
      title: cluster.title,
      detail: cluster.detail,
      next_step: cluster.next_step,
      command: cluster.command,
      severity: cluster.severity,
      affected_pipeline_id: cluster.affected_pipeline_id,
      affected_task_ids: cluster.affected_task_ids,
      invalidation_count: cluster.invalidation_count,
    });
  }

  const health = attention.some((item) => item.severity === 'block')
    ? 'block'
    : attention.some((item) => item.severity === 'warn')
      ? 'warn'
      : 'healthy';

  const repoPolicyState = summarizePipelinePolicyState(db, {
    tasks,
    counts: {
      done: tasks.filter((task) => task.status === 'done').length,
      in_progress: tasks.filter((task) => task.status === 'in_progress').length,
      pending: tasks.filter((task) => task.status === 'pending').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
    },
  }, changePolicy, aiGate.boundary_validations || []);

  return {
    repo_root: repoRoot,
    health,
    summary: health === 'healthy'
      ? 'Repo looks healthy. Agents are coordinated and merge checks are clear.'
      : health === 'warn'
        ? 'Repo is running, but there are issues that need review before merge.'
        : 'Repo needs attention before more work or merge.',
    counts: {
      pending: tasks.filter((task) => task.status === 'pending').length,
      in_progress: tasks.filter((task) => task.status === 'in_progress').length,
      done: tasks.filter((task) => task.status === 'done').length,
      failed: failedTasks.length,
      active_leases: activeLeases.length,
      stale_leases: staleLeases.length,
    },
    active_work: activeLeases.map((lease) => ({
      worktree: lease.worktree,
      task_id: lease.task_id,
      task_title: lease.task_title,
      heartbeat_at: lease.heartbeat_at,
      scope_summary: summarizeLeaseScope(db, lease),
      boundary_validation: getBoundaryValidationState(db, lease.id),
      dependency_invalidations: listDependencyInvalidations(db, { affectedTaskId: lease.task_id }),
    })),
    attention,
    merge_readiness: {
      ci_gate_ok: scanReport.conflicts.length === 0
        && scanReport.fileConflicts.length === 0
        && (scanReport.ownershipConflicts?.length || 0) === 0
        && (scanReport.semanticConflicts?.length || 0) === 0
        && scanReport.unclaimedChanges.length === 0
        && scanReport.complianceSummary.non_compliant === 0
        && scanReport.complianceSummary.stale === 0
        && aiGate.status !== 'blocked'
        && (aiGate.dependency_invalidations || []).filter((item) => item.severity === 'blocked').length === 0,
      ai_gate_status: aiGate.status,
      boundary_validations: aiGate.boundary_validations || [],
      dependency_invalidations: aiGate.dependency_invalidations || [],
      stale_clusters: staleClusters,
      compliance: scanReport.complianceSummary,
      semantic_conflicts: scanReport.semanticConflicts || [],
      policy_state: repoPolicyState,
    },
    next_steps: attention.length > 0
      ? [...new Set(attention.map((item) => item.next_step))].slice(0, 5)
      : ['run `switchman gate ci` before merge', 'run `switchman scan` after major parallel work'],
    suggested_commands: attention.length > 0
      ? [...new Set(attention.map((item) => item.command).filter(Boolean))].slice(0, 5)
      : ['switchman gate ci', 'switchman scan'],
  };
}

function buildUnifiedStatusReport({
  repoRoot,
  leasePolicy,
  tasks,
  claims,
  doctorReport,
  queueItems,
  queueSummary,
  recentQueueEvents,
}) {
  const queueAttention = [
    ...queueItems
      .filter((item) => item.status === 'blocked')
      .map((item) => ({
        kind: 'queue_blocked',
        title: `${item.id} is blocked from landing`,
        detail: item.last_error_summary || `${item.source_type}:${item.source_ref}`,
        next_step: item.next_action || `Run \`switchman queue retry ${item.id}\` after fixing the branch state.`,
        command: item.next_action?.includes('queue retry') ? `switchman queue retry ${item.id}` : 'switchman queue status',
        severity: 'block',
      })),
    ...queueItems
      .filter((item) => item.status === 'retrying')
      .map((item) => ({
        kind: 'queue_retrying',
        title: `${item.id} is waiting for another landing attempt`,
        detail: item.last_error_summary || `${item.source_type}:${item.source_ref}`,
        next_step: item.next_action || 'Run `switchman queue run` again to continue landing queued work.',
        command: 'switchman queue run',
        severity: 'warn',
      })),
  ];

  const attention = [...doctorReport.attention, ...queueAttention];
  const nextUp = tasks
    .filter((task) => task.status === 'pending')
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))
    .slice(0, 3)
    .map((task) => ({
      id: task.id,
      title: task.title,
      priority: task.priority,
    }));
  const failedTasks = tasks
    .filter((task) => task.status === 'failed')
    .slice(0, 5)
    .map((task) => ({
      id: task.id,
      title: task.title,
      failure: latestTaskFailure(task),
    }));

  const suggestedCommands = [
    ...doctorReport.suggested_commands,
    ...(queueItems.length > 0 ? ['switchman queue status'] : []),
    ...(queueSummary.next ? ['switchman queue run'] : []),
  ].filter(Boolean);
  const isFirstRunReady = tasks.length === 0
    && doctorReport.active_work.length === 0
    && queueItems.length === 0
    && claims.length === 0;
  const defaultNextSteps = isFirstRunReady
    ? [
      'add a first task with `switchman task add "Your first task" --priority 8`',
      'keep `switchman status --watch` open while agents start work',
      'run `switchman demo` if you want the shortest proof before using a real repo',
    ]
    : ['run `switchman gate ci` before merge', 'run `switchman scan` after major parallel work'];
  const defaultSuggestedCommands = isFirstRunReady
    ? ['switchman task add "Your first task" --priority 8', 'switchman status --watch', 'switchman demo']
    : ['switchman gate ci', 'switchman scan'];

  return {
    generated_at: new Date().toISOString(),
    repo_root: repoRoot,
    health: attention.some((item) => item.severity === 'block')
      ? 'block'
      : attention.some((item) => item.severity === 'warn')
        ? 'warn'
        : doctorReport.health,
    summary: attention.some((item) => item.severity === 'block')
      ? 'Repo needs attention before more work or merge.'
      : attention.some((item) => item.severity === 'warn')
        ? 'Repo is running, but a few items need review.'
        : isFirstRunReady
          ? 'Switchman is set up and ready. Add a task or run the demo to start.'
        : 'Repo looks healthy. Agents are coordinated and merge checks are clear.',
    lease_policy: leasePolicy,
    counts: {
      ...doctorReport.counts,
      queue: queueSummary.counts,
      active_claims: claims.length,
    },
    active_work: doctorReport.active_work,
    attention,
    next_up: nextUp,
    failed_tasks: failedTasks,
    queue: {
      items: queueItems,
      summary: queueSummary,
      recent_events: recentQueueEvents,
    },
    merge_readiness: doctorReport.merge_readiness,
    claims: claims.map((claim) => ({
      worktree: claim.worktree,
      task_id: claim.task_id,
      file_path: claim.file_path,
    })),
    next_steps: [...new Set([
      ...(attention.length > 0 ? doctorReport.next_steps : defaultNextSteps),
      ...queueAttention.map((item) => item.next_step),
    ])].slice(0, 6),
    suggested_commands: [...new Set(attention.length > 0 ? suggestedCommands : defaultSuggestedCommands)].slice(0, 6),
  };
}

async function collectStatusSnapshot(repoRoot) {
  const db = getDb(repoRoot);
  try {
    const leasePolicy = loadLeasePolicy(repoRoot);
    pruneDatabaseMaintenance(db);

    if (leasePolicy.reap_on_status_check) {
      reapStaleLeases(db, leasePolicy.stale_after_minutes, {
        requeueTask: leasePolicy.requeue_task_on_reap,
      });
    }

    const tasks = listTasks(db);
    const activeLeases = listLeases(db, 'active');
    const staleLeases = getStaleLeases(db, leasePolicy.stale_after_minutes);
    const claims = getActiveFileClaims(db);
    const queueItems = listMergeQueue(db);
    const queueSummary = buildQueueStatusSummary(queueItems);
    const recentQueueEvents = queueItems
      .slice(0, 5)
      .flatMap((item) => listMergeQueueEvents(db, item.id, { limit: 3 }).map((event) => ({ ...event, queue_item_id: item.id })))
      .sort((a, b) => b.id - a.id)
      .slice(0, 8);
    const scanReport = await scanAllWorktrees(db, repoRoot);
    const aiGate = await runAiMergeGate(db, repoRoot);
    const doctorReport = buildDoctorReport({
      db,
      repoRoot,
      tasks,
      activeLeases,
      staleLeases,
      scanReport,
      aiGate,
    });

    return buildUnifiedStatusReport({
      repoRoot,
      leasePolicy,
      tasks,
      claims,
      doctorReport,
      queueItems,
      queueSummary,
      recentQueueEvents,
    });
  } finally {
    db.close();
  }
}

function renderUnifiedStatusReport(report) {
  const healthColor = colorForHealth(report.health);
  const badge = healthColor(healthLabel(report.health));
  const mergeColor = report.merge_readiness.ci_gate_ok ? chalk.green : chalk.red;
  const queueCounts = report.counts.queue;
  const blockedCount = report.attention.filter((item) => item.severity === 'block').length;
  const warningCount = report.attention.filter((item) => item.severity !== 'block').length;
  const focusItem = blockedCount > 0
    ? report.attention.find((item) => item.severity === 'block')
    : warningCount > 0
      ? report.attention.find((item) => item.severity !== 'block')
      : report.next_up[0];
  const focusLine = focusItem
    ? ('title' in focusItem
      ? `${focusItem.title}${focusItem.detail ? ` ${chalk.dim(`• ${focusItem.detail}`)}` : ''}`
      : `${focusItem.title} ${chalk.dim(focusItem.id)}`)
    : report.counts.pending === 0 && report.counts.in_progress === 0 && report.queue.items.length === 0
      ? 'Nothing active yet. Add a task or run the demo to start.'
    : 'Nothing urgent. Safe to keep parallel work moving.';
  const primaryCommand = ('command' in (focusItem || {}) && focusItem?.command)
    ? focusItem.command
    : report.suggested_commands[0] || 'switchman status --watch';
  const nextStepLine = ('next_step' in (focusItem || {}) && focusItem?.next_step)
    ? focusItem.next_step
    : report.next_steps[0] || 'Keep work moving and check back here if anything blocks.';
  const queueLoad = queueCounts.queued + queueCounts.retrying + queueCounts.merging + queueCounts.blocked;
  const landingLabel = report.merge_readiness.ci_gate_ok ? 'ready' : 'hold';

  console.log('');
  console.log(healthColor('='.repeat(72)));
  console.log(`${badge} ${chalk.bold('switchman status')} ${chalk.dim('• mission control for parallel agents')}`);
  console.log(`${chalk.dim(report.repo_root)}`);
  console.log(`${chalk.dim(report.summary)}`);
  console.log(healthColor('='.repeat(72)));
  console.log(renderSignalStrip([
    renderChip('health', healthLabel(report.health), healthColor),
    renderChip('blocked', blockedCount, blockedCount > 0 ? chalk.red : chalk.green),
    renderChip('watch', warningCount, warningCount > 0 ? chalk.yellow : chalk.green),
    renderChip('landing', landingLabel, mergeColor),
    renderChip('queue', queueLoad, queueLoad > 0 ? chalk.blue : chalk.green),
  ]));
  console.log(renderMetricRow([
    { label: 'tasks', value: `${report.counts.pending}/${report.counts.in_progress}/${report.counts.done}/${report.counts.failed}`, color: chalk.white },
    { label: 'leases', value: `${report.counts.active_leases} active`, color: chalk.blue },
    { label: 'claims', value: report.counts.active_claims, color: chalk.cyan },
    { label: 'merge', value: report.merge_readiness.ci_gate_ok ? 'clear' : 'blocked', color: mergeColor },
  ]));
  console.log(renderMiniBar([
    { label: 'queued', value: queueCounts.queued, color: chalk.yellow },
    { label: 'retrying', value: queueCounts.retrying, color: chalk.yellow },
    { label: 'blocked', value: queueCounts.blocked, color: chalk.red },
    { label: 'merging', value: queueCounts.merging, color: chalk.blue },
    { label: 'merged', value: queueCounts.merged, color: chalk.green },
  ]));
  console.log(`${chalk.bold('Now:')} ${report.summary}`);
  console.log(`${chalk.bold('Attention:')} ${focusLine}`);
  console.log(`${chalk.bold('Run next:')} ${chalk.cyan(primaryCommand)}`);
  console.log(`${chalk.dim('why:')} ${nextStepLine}`);
  console.log(chalk.dim(`policy: ${formatRelativePolicy(report.lease_policy)} • requeue on reap ${report.lease_policy.requeue_task_on_reap ? 'on' : 'off'}`));
  if (report.merge_readiness.policy_state?.active) {
    console.log(chalk.dim(`change policy: ${report.merge_readiness.policy_state.domains.join(', ')} • ${report.merge_readiness.policy_state.enforcement} • missing ${report.merge_readiness.policy_state.missing_task_types.join(', ') || 'none'}`));
  }

  const runningLines = report.active_work.length > 0
    ? report.active_work.slice(0, 5).map((item) => {
      const boundary = item.boundary_validation
        ? ` ${renderChip('validation', item.boundary_validation.status, item.boundary_validation.status === 'accepted' ? chalk.green : chalk.yellow)}`
        : '';
      const stale = (item.dependency_invalidations?.length || 0) > 0
        ? ` ${renderChip('stale', item.dependency_invalidations.length, chalk.yellow)}`
        : '';
      return `${chalk.cyan(item.worktree)} -> ${item.task_title} ${chalk.dim(item.task_id)}${item.scope_summary ? ` ${chalk.dim(item.scope_summary)}` : ''}${boundary}${stale}`;
    })
    : [chalk.dim('Nothing active right now.')];

  const blockedItems = report.attention.filter((item) => item.severity === 'block');
  const warningItems = report.attention.filter((item) => item.severity !== 'block');
  const isQuietEmptyState = report.active_work.length === 0
    && blockedItems.length === 0
    && warningItems.length === 0
    && report.queue.items.length === 0
    && report.next_up.length === 0
    && report.failed_tasks.length === 0;

  if (isQuietEmptyState) {
    console.log('');
    console.log(healthColor('='.repeat(72)));
    console.log(`${badge} ${chalk.bold('switchman status')} ${chalk.dim('• mission control for parallel agents')}`);
    console.log(`${chalk.dim(report.repo_root)}`);
    console.log(`${chalk.dim(report.summary)}`);
    console.log(healthColor('='.repeat(72)));
    console.log('');
    console.log(chalk.green('Nothing is running yet.'));
    console.log(`Add work with: ${chalk.cyan('switchman task add "Your first task" --priority 8')}`);
    console.log(`Or prove the flow in 30 seconds with: ${chalk.cyan('switchman demo')}`);
    console.log('');
    return;
  }

  const blockedLines = blockedItems.length > 0
    ? blockedItems.slice(0, 4).flatMap((item) => {
      const lines = [`${renderChip('BLOCKED', item.kind || 'item', chalk.red)} ${item.title}`];
      if (item.detail) lines.push(`  ${chalk.dim(item.detail)}`);
      lines.push(`  ${chalk.yellow('next:')} ${item.next_step}`);
      if (item.command) lines.push(`  ${chalk.cyan('run:')} ${item.command}`);
      return lines;
    })
    : [chalk.green('Nothing blocked.')];

  const warningLines = warningItems.length > 0
    ? warningItems.slice(0, 4).flatMap((item) => {
      const lines = [`${renderChip('WATCH', item.kind || 'item', chalk.yellow)} ${item.title}`];
      if (item.detail) lines.push(`  ${chalk.dim(item.detail)}`);
      lines.push(`  ${chalk.yellow('next:')} ${item.next_step}`);
      if (item.command) lines.push(`  ${chalk.cyan('run:')} ${item.command}`);
      return lines;
    })
    : [chalk.green('Nothing warning-worthy right now.')];

  const queueLines = report.queue.items.length > 0
    ? [
      ...(report.queue.summary.next
        ? [
          `${chalk.dim('next:')} ${report.queue.summary.next.id} ${report.queue.summary.next.source_type}:${report.queue.summary.next.source_ref} ${chalk.dim(`retries:${report.queue.summary.next.retry_count}/${report.queue.summary.next.max_retries}`)}${report.queue.summary.next.queue_assessment?.goal_priority ? ` ${chalk.dim(`priority:${report.queue.summary.next.queue_assessment.goal_priority}`)}` : ''}${report.queue.summary.next.queue_assessment?.integration_risk && report.queue.summary.next.queue_assessment.integration_risk !== 'normal' ? ` ${chalk.dim(`risk:${report.queue.summary.next.queue_assessment.integration_risk}`)}` : ''}`,
          ...(report.queue.summary.next.recommendation?.summary ? [`  ${chalk.dim('decision:')} ${report.queue.summary.next.recommendation.summary}`] : []),
        ]
        : []),
      ...report.queue.summary.held_back
        .slice(0, 2)
        .map((item) => `  ${chalk.dim(item.recommendation?.action === 'escalate' ? 'escalate:' : 'hold:')} ${item.id} ${item.source_type}:${item.source_ref} ${chalk.dim(item.recommendation?.summary || item.queue_assessment?.reason || '')}`),
      ...report.queue.items
        .filter((entry) => ['blocked', 'retrying', 'merging'].includes(entry.status))
        .slice(0, 4)
        .flatMap((item) => {
          const lines = [`${renderChip(item.status.toUpperCase(), item.id, item.status === 'blocked' ? chalk.red : item.status === 'retrying' ? chalk.yellow : chalk.blue)} ${item.source_type}:${item.source_ref} ${chalk.dim(`retries:${item.retry_count}/${item.max_retries}`)}`];
          if (item.last_error_summary) lines.push(`  ${chalk.red('why:')} ${item.last_error_summary}`);
          if (item.next_action) lines.push(`  ${chalk.yellow('next:')} ${item.next_action}`);
          return lines;
        }),
    ]
    : [chalk.dim('No queued merges.')];

  const staleClusterLines = report.merge_readiness.stale_clusters?.length > 0
    ? report.merge_readiness.stale_clusters.slice(0, 4).flatMap((cluster) => {
      const lines = [`${renderChip(cluster.severity === 'block' ? 'STALE' : 'WATCH', cluster.affected_pipeline_id || cluster.affected_task_ids[0], cluster.severity === 'block' ? chalk.red : chalk.yellow)} ${cluster.title}`];
      lines.push(`  ${chalk.dim(cluster.detail)}`);
      if (cluster.causal_group_size > 1) lines.push(`  ${chalk.dim('cause:')} ${cluster.causal_group_summary} ${chalk.dim(`(${cluster.causal_group_rank}/${cluster.causal_group_size} in same stale wave)`)}${cluster.related_affected_pipelines?.length ? ` ${chalk.dim(`related:${cluster.related_affected_pipelines.join(', ')}`)}` : ''}`);
      lines.push(`  ${chalk.dim('areas:')} ${cluster.stale_areas.join(', ')}`);
      lines.push(`  ${chalk.dim('rerun priority:')} ${cluster.rerun_priority} ${chalk.dim(`score:${cluster.rerun_priority_score}`)}${cluster.highest_affected_priority ? ` ${chalk.dim(`affected-priority:${cluster.highest_affected_priority}`)}` : ''}${cluster.rerun_breadth_score ? ` ${chalk.dim(`breadth:${cluster.rerun_breadth_score}`)}` : ''}`);
      lines.push(`  ${chalk.yellow('next:')} ${cluster.next_step}`);
      lines.push(`  ${chalk.cyan('run:')} ${cluster.command}`);
      return lines;
    })
    : [chalk.green('No stale dependency clusters.')];

  const policyLines = report.merge_readiness.policy_state?.active
    ? [
      `${renderChip(report.merge_readiness.policy_state.enforcement.toUpperCase(), report.merge_readiness.policy_state.domains.join(','), report.merge_readiness.policy_state.enforcement === 'blocked' ? chalk.red : chalk.yellow)} ${report.merge_readiness.policy_state.summary}`,
      `  ${chalk.dim('required:')} ${report.merge_readiness.policy_state.required_task_types.join(', ') || 'none'}`,
      `  ${chalk.dim('missing:')} ${report.merge_readiness.policy_state.missing_task_types.join(', ') || 'none'}`,
      `  ${chalk.dim('overridden:')} ${report.merge_readiness.policy_state.overridden_task_types.join(', ') || 'none'}`,
      ...report.merge_readiness.policy_state.requirement_status
        .filter((requirement) => requirement.evidence.length > 0)
        .slice(0, 3)
        .map((requirement) => `  ${chalk.dim(`${requirement.task_type}:`)} ${requirement.evidence.map((entry) => entry.artifact_path ? `${entry.task_id} (${entry.artifact_path})` : entry.task_id).join(', ')}`),
      ...report.merge_readiness.policy_state.overrides
        .slice(0, 3)
        .map((entry) => `  ${chalk.dim(`override ${entry.id}:`)} ${(entry.task_types || []).join(', ') || 'all'} by ${entry.approved_by || 'unknown'}`),
    ]
    : [chalk.green('No explicit change policy requirements are active.')];

  const nextActionLines = [
    ...(report.next_up.length > 0
      ? report.next_up.map((task) => `${renderChip('NEXT', `p${task.priority}`, chalk.green)} ${task.title} ${chalk.dim(task.id)}`)
      : [chalk.dim('No pending tasks waiting right now.')]),
    '',
    ...report.suggested_commands.slice(0, 4).map((command) => `${chalk.cyan('$')} ${command}`),
  ];

  const panelBlocks = [
    renderPanel('Running now', runningLines, chalk.cyan),
    renderPanel('Blocked', blockedLines, blockedItems.length > 0 ? chalk.red : chalk.green),
    renderPanel('Warnings', warningLines, warningItems.length > 0 ? chalk.yellow : chalk.green),
    renderPanel('Stale clusters', staleClusterLines, (report.merge_readiness.stale_clusters?.some((cluster) => cluster.severity === 'block') ? chalk.red : (report.merge_readiness.stale_clusters?.length || 0) > 0 ? chalk.yellow : chalk.green)),
    renderPanel('Policy', policyLines, report.merge_readiness.policy_state?.active && report.merge_readiness.policy_state.missing_task_types.length > 0 ? chalk.red : chalk.green),
    renderPanel('Landing queue', queueLines, queueCounts.blocked > 0 ? chalk.red : chalk.blue),
    renderPanel('Next action', nextActionLines, chalk.green),
  ];

  console.log('');
  for (const block of panelBlocks) {
    for (const line of block) console.log(line);
    console.log('');
  }

  if (report.failed_tasks.length > 0) {
    console.log(chalk.bold('Recent failed tasks:'));
    for (const task of report.failed_tasks) {
      const reason = humanizeReasonCode(task.failure?.reason_code);
      const summary = task.failure?.summary || 'unknown failure';
      console.log(`  ${chalk.red(task.title)} ${chalk.dim(task.id)}`);
      console.log(`    ${chalk.red('why:')} ${summary} ${chalk.dim(`(${reason})`)}`);
    }
    console.log('');
  }

  if (report.queue.recent_events.length > 0) {
    console.log(chalk.bold('Recent queue events:'));
    for (const event of report.queue.recent_events.slice(0, 5)) {
      console.log(`  ${chalk.cyan(event.queue_item_id)} ${chalk.dim(event.event_type)} ${chalk.dim(event.status || '')} ${chalk.dim(event.created_at)}`.trim());
    }
    console.log('');
  }

  console.log(chalk.bold('Recommended next steps:'));
  for (const step of report.next_steps) {
    console.log(`  - ${step}`);
  }
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
program.configureHelp({
  visibleCommands(cmd) {
    const commands = Help.prototype.visibleCommands.call(this, cmd);
    if (cmd.parent) return commands;
    return commands.filter((command) => !command._switchmanAdvanced);
  },
});
program.addHelpText('after', `
Start here:
  switchman demo
  switchman setup --agents 3
  switchman task add "Your task" --priority 8
  switchman status --watch
  switchman gate ci
  switchman queue run

For you (the operator):
  switchman demo
  switchman setup
  switchman status
  switchman repair
  switchman scan
  switchman queue run
  switchman gate ci

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
        spinner.fail('Your repo needs at least one commit before agent workspaces can be created.');
        console.log(chalk.dim('  Run: git commit --allow-empty -m "init"  then try again'));
        process.exit(1);
      }

      // Init the switchman database
      const db = initDb(repoRoot);

      // Create one workspace (git worktree) per agent
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

      const monitorIntervalMs = Math.max(100, Number.parseInt(opts.monitorIntervalMs, 10) || 2000);
      const monitorState = opts.monitor
        ? startBackgroundMonitor(repoRoot, { intervalMs: monitorIntervalMs, quarantine: false })
        : null;

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

program
  .command('upgrade')
  .description('See Switchman upgrade options and paid plan details')
  .action(() => {
    console.log(chalk.bold('Switchman upgrade'));
    console.log('');
    console.log('Explore paid plans and team features at:');
    console.log(`  ${chalk.cyan('https://switchman.dev/pro')}`);
  });


// ── mcp ───────────────────────────────────────────────────────────────────────

const mcpCmd = program.command('mcp').description('Manage editor connections for Switchman');
const telemetryCmd = program.command('telemetry').description('Control anonymous opt-in telemetry for Switchman');

telemetryCmd
  .command('status')
  .description('Show whether telemetry is enabled and where events would be sent')
  .option('--home <path>', 'Override the home directory for telemetry config')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const config = loadTelemetryConfig(opts.home || undefined);
    const runtime = getTelemetryRuntimeConfig();
    const payload = {
      enabled: config.telemetry_enabled === true,
      configured: Boolean(runtime.apiKey) && !runtime.disabled,
      install_id: config.telemetry_install_id,
      destination: runtime.apiKey && !runtime.disabled ? runtime.host : null,
      config_path: getTelemetryConfigPath(opts.home || undefined),
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Telemetry: ${payload.enabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
    console.log(`Configured destination: ${payload.configured ? chalk.cyan(payload.destination) : chalk.dim('not configured')}`);
    console.log(`Config file: ${chalk.dim(payload.config_path)}`);
    if (payload.install_id) {
      console.log(`Install ID: ${chalk.dim(payload.install_id)}`);
    }
  });

telemetryCmd
  .command('enable')
  .description('Enable anonymous telemetry for setup and operator workflows')
  .option('--home <path>', 'Override the home directory for telemetry config')
  .action((opts) => {
    const runtime = getTelemetryRuntimeConfig();
    if (!runtime.apiKey || runtime.disabled) {
      printErrorWithNext('Telemetry destination is not configured. Set SWITCHMAN_TELEMETRY_API_KEY first.', 'switchman telemetry status');
      process.exitCode = 1;
      return;
    }
    const result = enableTelemetry(opts.home || undefined);
    console.log(`${chalk.green('✓')} Telemetry enabled`);
    console.log(`  ${chalk.dim(result.path)}`);
  });

telemetryCmd
  .command('disable')
  .description('Disable anonymous telemetry')
  .option('--home <path>', 'Override the home directory for telemetry config')
  .action((opts) => {
    const result = disableTelemetry(opts.home || undefined);
    console.log(`${chalk.green('✓')} Telemetry disabled`);
    console.log(`  ${chalk.dim(result.path)}`);
  });

telemetryCmd
  .command('test')
  .description('Send one test telemetry event and report whether delivery succeeded')
  .option('--home <path>', 'Override the home directory for telemetry config')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const result = await sendTelemetryEvent('telemetry_test', {
      app_version: program.version(),
      os: process.platform,
      node_version: process.version,
      source: 'switchman-cli-test',
    }, { homeDir: opts.home || undefined });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }

    if (result.ok) {
      console.log(`${chalk.green('✓')} Telemetry test event delivered`);
      console.log(`  ${chalk.dim('destination:')} ${chalk.cyan(result.destination)}`);
      if (result.status) {
        console.log(`  ${chalk.dim('status:')} ${result.status}`);
      }
      return;
    }

    printErrorWithNext(`Telemetry test failed (${result.reason || 'unknown_error'}).`, 'switchman telemetry status');
    console.log(`  ${chalk.dim('destination:')} ${result.destination || 'unknown'}`);
    if (result.status) {
      console.log(`  ${chalk.dim('status:')} ${result.status}`);
    }
    if (result.error) {
      console.log(`  ${chalk.dim('error:')} ${result.error}`);
    }
    process.exitCode = 1;
  });

mcpCmd
  .command('install')
  .description('Install editor-specific MCP config for Switchman')
  .option('--windsurf', 'Write Windsurf MCP config to ~/.codeium/mcp_config.json')
  .option('--home <path>', 'Override the home directory for config writes (useful for testing)')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Examples:
  switchman mcp install --windsurf
  switchman mcp install --windsurf --json
`)
  .action((opts) => {
    if (!opts.windsurf) {
      console.error(chalk.red('Choose an editor install target, for example `switchman mcp install --windsurf`.'));
      process.exitCode = 1;
      return;
    }

    const result = upsertWindsurfMcpConfig(opts.home);

    if (opts.json) {
      console.log(JSON.stringify({
        editor: 'windsurf',
        path: result.path,
        created: result.created,
        changed: result.changed,
      }, null, 2));
      return;
    }

    console.log(`${chalk.green('✓')} Windsurf MCP config ${result.changed ? 'written' : 'already up to date'}`);
    console.log(`  ${chalk.dim('path:')} ${chalk.cyan(result.path)}`);
    console.log(`  ${chalk.dim('open:')} Windsurf -> Settings -> Cascade -> MCP Servers`);
    console.log(`  ${chalk.dim('note:')} Windsurf reads the shared config from ${getWindsurfMcpConfigPath(opts.home)}`);
  });


// ── task ──────────────────────────────────────────────────────────────────────

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
    const scopeWarning = analyzeTaskScope(title, opts.description || '');
    console.log(`${chalk.green('✓')} Task created: ${chalk.cyan(taskId)}`);
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
    if (result.pipeline_id) {
      console.log(`  ${chalk.dim('pipeline:')} ${result.pipeline_id}`);
    }
    console.log(`  ${chalk.dim('tasks:')} ${result.retried.map((task) => task.id).join(', ')}`);
    console.log(`${chalk.yellow('next:')} switchman status`);
  });

taskCmd
  .command('done <taskId>')
  .description('Mark a task as complete and release all file claims')
  .action((taskId) => {
    const repoRoot = getRepo();
    try {
      const result = completeTaskWithRetries(repoRoot, taskId);
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
      if (result?.status === 'completed_without_lease') {
        console.log(`${chalk.yellow('!')} Task ${chalk.cyan(taskId)} was marked done, but no active lease was present — claims were released, but inspect the worktree state`);
        return;
      }
      console.log(`${chalk.green('✓')} Task ${chalk.cyan(taskId)} marked done — file claims released`);
    } catch (err) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
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
  .description('Get the next pending task quickly (use `lease next` for the full workflow)')
  .option('--json', 'Output as JSON')
  .option('--worktree <name>', 'Workspace to assign the task to (defaults to the current folder name)')
  .option('--agent <name>', 'Agent identifier for logging (e.g. claude-code)')
  .addHelpText('after', `
Examples:
  switchman task next
  switchman task next --json
`)
  .action((opts) => {
    const repoRoot = getRepo();
    const worktreeName = getCurrentWorktreeName(opts.worktree);
    const { task, lease, exhausted } = acquireNextTaskLeaseWithRetries(repoRoot, worktreeName, opts.agent || null);

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

// ── queue ─────────────────────────────────────────────────────────────────────

const queueCmd = program.command('queue').alias('land').description('Land finished work safely back onto main, one item at a time');
queueCmd.addHelpText('after', `
Examples:
  switchman queue add --worktree agent1
  switchman queue status
  switchman queue run --watch
`);

queueCmd
  .command('add [branch]')
  .description('Add a branch, workspace, or pipeline to the landing queue')
  .option('--worktree <name>', 'Queue a registered workspace by name')
  .option('--pipeline <pipelineId>', 'Queue a pipeline by id')
  .option('--target <branch>', 'Target branch to merge into', 'main')
  .option('--max-retries <n>', 'Maximum automatic retries', '1')
  .option('--submitted-by <name>', 'Operator or automation name')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Examples:
  switchman queue add feature/auth-hardening
  switchman queue add --worktree agent2
  switchman queue add --pipeline pipe-123

Pipeline landing rule:
  switchman queue add --pipeline <id>
  lands the pipeline's inferred landing branch.
  If completed work spans multiple branches, Switchman creates one synthetic landing branch first.
`)
  .action(async (branch, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      let payload;
      if (opts.worktree) {
        const worktree = listWorktrees(db).find((entry) => entry.name === opts.worktree);
        if (!worktree) {
          throw new Error(`Workspace ${opts.worktree} is not registered.`);
        }
        payload = {
          sourceType: 'worktree',
          sourceRef: worktree.branch,
          sourceWorktree: worktree.name,
          targetBranch: opts.target,
          maxRetries: opts.maxRetries,
          submittedBy: opts.submittedBy || null,
        };
      } else if (opts.pipeline) {
        const policyGate = await evaluatePipelinePolicyGate(db, repoRoot, opts.pipeline);
        if (!policyGate.ok) {
          throw new Error(`${policyGate.summary} Next: ${policyGate.next_action}`);
        }
        const landingTarget = preparePipelineLandingTarget(db, repoRoot, opts.pipeline, {
          baseBranch: opts.target || 'main',
          requireCompleted: true,
          allowCurrentBranchFallback: false,
        });
        payload = {
          sourceType: 'pipeline',
          sourceRef: landingTarget.branch,
          sourcePipelineId: opts.pipeline,
          sourceWorktree: landingTarget.worktree || null,
          targetBranch: opts.target,
          maxRetries: opts.maxRetries,
          submittedBy: opts.submittedBy || null,
          eventDetails: policyGate.override_applied
            ? {
              policy_override_summary: policyGate.override_summary,
              overridden_task_types: policyGate.policy_state?.overridden_task_types || [],
            }
            : null,
        };
      } else if (branch) {
        payload = {
          sourceType: 'branch',
          sourceRef: branch,
          targetBranch: opts.target,
          maxRetries: opts.maxRetries,
          submittedBy: opts.submittedBy || null,
        };
      } else {
        throw new Error('Choose one source to land: a branch name, `--worktree`, or `--pipeline`.');
      }

      const result = enqueueMergeItem(db, payload);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Queued ${chalk.cyan(result.id)} for ${chalk.bold(result.target_branch)}`);
      console.log(`  ${chalk.dim('source:')} ${result.source_type} ${result.source_ref}`);
      if (result.source_worktree) console.log(`  ${chalk.dim('worktree:')} ${result.source_worktree}`);
      if (payload.eventDetails?.policy_override_summary) {
        console.log(`  ${chalk.dim('policy override:')} ${payload.eventDetails.policy_override_summary}`);
      }
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, 'switchman queue add --help');
      process.exitCode = 1;
    }
  });

queueCmd
  .command('list')
  .description('List merge queue items')
  .option('--status <status>', 'Filter by queue status')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const items = listMergeQueue(db, { status: opts.status || null });
    db.close();

    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log(chalk.dim('Merge queue is empty.'));
      return;
    }

    for (const item of items) {
      const retryInfo = chalk.dim(`retries:${item.retry_count}/${item.max_retries}`);
      const attemptInfo = item.last_attempt_at ? ` ${chalk.dim(`last-attempt:${item.last_attempt_at}`)}` : '';
      const backoffInfo = item.backoff_until ? ` ${chalk.dim(`backoff-until:${item.backoff_until}`)}` : '';
      const escalationInfo = item.escalated_at ? ` ${chalk.dim(`escalated:${item.escalated_at}`)}` : '';
      console.log(`  ${statusBadge(item.status)} ${item.id} ${item.source_type}:${item.source_ref} ${chalk.dim(`→ ${item.target_branch}`)} ${retryInfo}${attemptInfo}${backoffInfo}${escalationInfo}`);
      if (item.last_error_summary) {
        console.log(`    ${chalk.red('why:')} ${item.last_error_summary}`);
      }
      if (item.next_action) {
        console.log(`    ${chalk.yellow('next:')} ${item.next_action}`);
      }
    }
  });

queueCmd
  .command('status')
  .description('Show an operator-friendly merge queue summary')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Plain English:
  Use this when finished branches are waiting to land and you want one safe queue view.

Examples:
  switchman queue status
  switchman queue status --json

What it helps you answer:
  - what lands next
  - what is blocked
  - what command should I run now
`)
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const items = listMergeQueue(db);
    const summary = buildQueueStatusSummary(items, { db, repoRoot });
    const recentEvents = items.slice(0, 5).flatMap((item) =>
      listMergeQueueEvents(db, item.id, { limit: 3 }).map((event) => ({ ...event, queue_item_id: item.id })),
    ).sort((a, b) => b.id - a.id).slice(0, 8);
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ items, summary, recent_events: recentEvents }, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log('');
      console.log(chalk.bold('switchman queue status'));
      console.log('');
      console.log('Queue is empty.');
      console.log(`Add finished work with: ${chalk.cyan('switchman queue add --worktree agent1')}`);
      return;
    }

    const queueHealth = summary.counts.blocked > 0
      ? 'block'
      : summary.counts.retrying > 0 || summary.counts.held > 0 || summary.counts.wave_blocked > 0 || summary.counts.escalated > 0
        ? 'warn'
        : 'healthy';
    const queueHealthColor = colorForHealth(queueHealth);
    const retryingItems = items.filter((item) => item.status === 'retrying');
    const focus = summary.blocked[0] || retryingItems[0] || summary.next || null;
    const focusLine = focus
      ? `${focus.id} ${focus.source_type}:${focus.source_ref}${focus.last_error_summary ? ` ${chalk.dim(`• ${focus.last_error_summary}`)}` : ''}`
      : 'Nothing waiting. Landing queue is clear.';

    console.log('');
    console.log(queueHealthColor('='.repeat(72)));
    console.log(`${queueHealthColor(healthLabel(queueHealth))} ${chalk.bold('switchman queue status')} ${chalk.dim('• landing mission control')}`);
    console.log(queueHealthColor('='.repeat(72)));
    console.log(renderSignalStrip([
      renderChip('queued', summary.counts.queued, summary.counts.queued > 0 ? chalk.yellow : chalk.green),
      renderChip('retrying', summary.counts.retrying, summary.counts.retrying > 0 ? chalk.yellow : chalk.green),
      renderChip('held', summary.counts.held, summary.counts.held > 0 ? chalk.yellow : chalk.green),
      renderChip('wave blocked', summary.counts.wave_blocked, summary.counts.wave_blocked > 0 ? chalk.yellow : chalk.green),
      renderChip('escalated', summary.counts.escalated, summary.counts.escalated > 0 ? chalk.red : chalk.green),
      renderChip('blocked', summary.counts.blocked, summary.counts.blocked > 0 ? chalk.red : chalk.green),
      renderChip('merging', summary.counts.merging, summary.counts.merging > 0 ? chalk.blue : chalk.green),
      renderChip('merged', summary.counts.merged, summary.counts.merged > 0 ? chalk.green : chalk.white),
    ]));
    console.log(renderMetricRow([
      { label: 'items', value: items.length, color: chalk.white },
      { label: 'validating', value: summary.counts.validating, color: chalk.blue },
      { label: 'rebasing', value: summary.counts.rebasing, color: chalk.blue },
      { label: 'target', value: summary.next?.target_branch || 'main', color: chalk.cyan },
    ]));
    console.log(`${chalk.bold('Focus now:')} ${focusLine}`);

    const queueFocusLines = summary.next
      ? [
        `${renderChip(summary.next.recommendation?.action === 'retry' ? 'RETRY' : summary.next.recommendation?.action === 'escalate' ? 'ESCALATE' : 'NEXT', summary.next.id, summary.next.recommendation?.action === 'retry' ? chalk.yellow : summary.next.recommendation?.action === 'escalate' ? chalk.red : chalk.green)} ${summary.next.source_type}:${summary.next.source_ref} ${chalk.dim(`retries:${summary.next.retry_count}/${summary.next.max_retries}`)}${summary.next.queue_assessment?.goal_priority ? ` ${chalk.dim(`priority:${summary.next.queue_assessment.goal_priority}`)}` : ''}${summary.next.queue_assessment?.integration_risk && summary.next.queue_assessment.integration_risk !== 'normal' ? ` ${chalk.dim(`risk:${summary.next.queue_assessment.integration_risk}`)}` : ''}${summary.next.queue_assessment?.freshness ? ` ${chalk.dim(`freshness:${summary.next.queue_assessment.freshness}`)}` : ''}${summary.next.queue_assessment?.stale_invalidation_count ? ` ${chalk.dim(`stale:${summary.next.queue_assessment.stale_invalidation_count}`)}` : ''}`,
        ...(summary.next.queue_assessment?.reason ? [`  ${chalk.dim('why next:')} ${summary.next.queue_assessment.reason}`] : []),
        ...(summary.next.recommendation?.summary ? [`  ${chalk.dim('decision:')} ${summary.next.recommendation.summary}`] : []),
        `  ${chalk.yellow('run:')} ${summary.next.recommendation?.command || 'switchman queue run'}`,
      ]
      : [chalk.dim('No queued landing work right now.')];

    const queueHeldBackLines = summary.held_back.length > 0
      ? summary.held_back.flatMap((item) => {
        const lines = [`${renderChip(item.recommendation?.action === 'escalate' ? 'ESCALATE' : 'HOLD', item.id, item.recommendation?.action === 'escalate' ? chalk.red : chalk.yellow)} ${item.source_type}:${item.source_ref}${item.queue_assessment?.goal_priority ? ` ${chalk.dim(`priority:${item.queue_assessment.goal_priority}`)}` : ''} ${chalk.dim(`freshness:${item.queue_assessment?.freshness || 'unknown'}`)}${item.queue_assessment?.integration_risk && item.queue_assessment.integration_risk !== 'normal' ? ` ${chalk.dim(`risk:${item.queue_assessment.integration_risk}`)}` : ''}${item.queue_assessment?.stale_invalidation_count ? ` ${chalk.dim(`stale:${item.queue_assessment.stale_invalidation_count}`)}` : ''}`];
        if (item.queue_assessment?.reason) lines.push(`  ${chalk.dim('why later:')} ${item.queue_assessment.reason}`);
        if (item.recommendation?.summary) lines.push(`  ${chalk.dim('decision:')} ${item.recommendation.summary}`);
        if (item.queue_assessment?.next_action) lines.push(`  ${chalk.yellow('next:')} ${item.queue_assessment.next_action}`);
        return lines;
      })
      : [chalk.green('Nothing significant is being held back.')];

    const queueBlockedLines = summary.blocked.length > 0
      ? summary.blocked.slice(0, 4).flatMap((item) => {
        const lines = [`${renderChip('BLOCKED', item.id, chalk.red)} ${item.source_type}:${item.source_ref} ${chalk.dim(`retries:${item.retry_count}/${item.max_retries}`)}`];
        if (item.last_error_summary) lines.push(`  ${chalk.red('why:')} ${item.last_error_summary}`);
        if (item.next_action) lines.push(`  ${chalk.yellow('next:')} ${item.next_action}`);
        return lines;
      })
      : [chalk.green('Nothing blocked.')];

    const queueWatchLines = items.filter((item) => ['retrying', 'held', 'wave_blocked', 'escalated', 'merging', 'rebasing', 'validating'].includes(item.status)).length > 0
      ? items
        .filter((item) => ['retrying', 'held', 'wave_blocked', 'escalated', 'merging', 'rebasing', 'validating'].includes(item.status))
        .slice(0, 4)
        .flatMap((item) => {
          const lines = [`${renderChip(item.status.toUpperCase(), item.id, item.status === 'retrying' || item.status === 'held' || item.status === 'wave_blocked' ? chalk.yellow : item.status === 'escalated' ? chalk.red : chalk.blue)} ${item.source_type}:${item.source_ref}`];
          if (item.last_error_summary) lines.push(`  ${chalk.dim(item.last_error_summary)}`);
          if (item.next_action) lines.push(`  ${chalk.yellow('next:')} ${item.next_action}`);
          return lines;
        })
      : [chalk.green('No in-flight queue items right now.')];

    const queueCommandLines = [
      `${chalk.cyan('$')} switchman queue run`,
      `${chalk.cyan('$')} switchman queue status --json`,
      ...(summary.blocked[0] ? [`${chalk.cyan('$')} switchman queue retry ${summary.blocked[0].id}`] : []),
    ];

    const queuePlanLines = [
      ...(summary.plan?.land_now?.slice(0, 2).map((item) => `${renderChip('LAND NOW', item.item_id, chalk.green)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
      ...(summary.plan?.prepare_next?.slice(0, 2).map((item) => `${renderChip('PREP NEXT', item.item_id, chalk.cyan)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
      ...(summary.plan?.unblock_first?.slice(0, 2).map((item) => `${renderChip('UNBLOCK', item.item_id, chalk.yellow)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
      ...(summary.plan?.escalate?.slice(0, 2).map((item) => `${renderChip('ESCALATE', item.item_id, chalk.red)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
      ...(summary.plan?.defer?.slice(0, 2).map((item) => `${renderChip('DEFER', item.item_id, chalk.white)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
    ];
    const queueSequenceLines = summary.recommended_sequence?.length > 0
      ? summary.recommended_sequence.map((item) => `${chalk.bold(`${item.stage}.`)} ${item.source_type}:${item.source_ref} ${chalk.dim(`[${item.lane}]`)} ${item.summary}`)
      : [chalk.green('No recommended sequence beyond the current landing focus.')];

    console.log('');
    for (const block of [
      renderPanel('Landing focus', queueFocusLines, chalk.green),
      renderPanel('Recommended sequence', queueSequenceLines, summary.recommended_sequence?.length > 0 ? chalk.cyan : chalk.green),
      renderPanel('Queue plan', queuePlanLines.length > 0 ? queuePlanLines : [chalk.green('Nothing else needs planning right now.')], queuePlanLines.length > 0 ? chalk.cyan : chalk.green),
      renderPanel('Held back', queueHeldBackLines, summary.held_back.length > 0 ? chalk.yellow : chalk.green),
      renderPanel('Blocked', queueBlockedLines, summary.counts.blocked > 0 ? chalk.red : chalk.green),
      renderPanel('In flight', queueWatchLines, queueWatchLines[0] === 'No in-flight queue items right now.' ? chalk.green : chalk.blue),
      renderPanel('Next commands', queueCommandLines, chalk.cyan),
    ]) {
      for (const line of block) console.log(line);
      console.log('');
    }

    if (recentEvents.length > 0) {
      console.log(chalk.bold('Recent Queue Events:'));
      for (const event of recentEvents) {
        console.log(`  ${chalk.cyan(event.queue_item_id)} ${chalk.dim(event.event_type)} ${chalk.dim(event.status || '')} ${chalk.dim(event.created_at)}`.trim());
      }
    }
  });

queueCmd
  .command('run')
  .description('Process landing-queue items one at a time')
  .option('--max-items <n>', 'Maximum queue items to process', '1')
  .option('--follow-plan', 'Only run queue items that are currently in the land_now lane')
  .option('--merge-budget <n>', 'Maximum successful merges to allow in this run')
  .option('--target <branch>', 'Default target branch', 'main')
  .option('--watch', 'Keep polling for new queue items')
  .option('--watch-interval-ms <n>', 'Polling interval for --watch mode', '1000')
  .option('--max-cycles <n>', 'Maximum watch cycles before exiting (mainly for tests)')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Examples:
  switchman queue run
  switchman queue run --follow-plan --merge-budget 2
  switchman queue run --watch
  switchman queue run --watch --watch-interval-ms 1000
`)
  .action(async (opts) => {
    const repoRoot = getRepo();

    try {
      const watch = Boolean(opts.watch);
      const followPlan = Boolean(opts.followPlan);
      const watchIntervalMs = Math.max(0, Number.parseInt(opts.watchIntervalMs, 10) || 1000);
      const maxCycles = opts.maxCycles ? Math.max(1, Number.parseInt(opts.maxCycles, 10) || 1) : null;
      const mergeBudget = opts.mergeBudget !== undefined
        ? Math.max(0, Number.parseInt(opts.mergeBudget, 10) || 0)
        : null;
      const aggregate = {
        processed: [],
        cycles: 0,
        watch,
        execution_policy: {
          follow_plan: followPlan,
          merge_budget: mergeBudget,
          merged_count: 0,
        },
      };

      while (true) {
        const db = getDb(repoRoot);
        const result = await runMergeQueue(db, repoRoot, {
          maxItems: Number.parseInt(opts.maxItems, 10) || 1,
          targetBranch: opts.target || 'main',
          followPlan,
          mergeBudget,
        });
        db.close();

        aggregate.processed.push(...result.processed);
        aggregate.summary = result.summary;
        aggregate.deferred = result.deferred || aggregate.deferred || null;
        aggregate.execution_policy = result.execution_policy || aggregate.execution_policy;
        aggregate.cycles += 1;

        if (!watch) break;
        if (maxCycles && aggregate.cycles >= maxCycles) break;
        if (mergeBudget !== null && aggregate.execution_policy.merged_count >= mergeBudget) break;
        if (result.processed.length === 0) {
          sleepSync(watchIntervalMs);
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(aggregate, null, 2));
        return;
      }

      if (aggregate.processed.length === 0) {
        const deferredFocus = aggregate.deferred || aggregate.summary?.next || null;
        if (deferredFocus?.recommendation?.action) {
          console.log(chalk.yellow('No landing candidate is ready to run right now.'));
          console.log(`  ${chalk.dim('focus:')} ${deferredFocus.id} ${deferredFocus.source_type}:${deferredFocus.source_ref}`);
          if (followPlan) {
            console.log(`  ${chalk.dim('policy:')} following the queue plan, so only land_now items will run automatically`);
          }
          if (deferredFocus.recommendation?.summary) {
            console.log(`  ${chalk.dim('decision:')} ${deferredFocus.recommendation.summary}`);
          }
          if (deferredFocus.recommendation?.command) {
            console.log(`  ${chalk.yellow('next:')} ${deferredFocus.recommendation.command}`);
          }
        } else {
          console.log(chalk.dim('No queued merge items.'));
        }
        await maybeCaptureTelemetry('queue_used', {
          watch,
          cycles: aggregate.cycles,
          processed_count: 0,
          merged_count: 0,
          blocked_count: 0,
        });
        return;
      }

      for (const entry of aggregate.processed) {
        const item = entry.item;
        if (entry.status === 'merged') {
          console.log(`${chalk.green('✓')} Merged ${chalk.cyan(item.id)} into ${chalk.bold(item.target_branch)}`);
          console.log(`  ${chalk.dim('commit:')} ${item.merged_commit}`);
        } else {
          console.log(`${chalk.red('✗')} Blocked ${chalk.cyan(item.id)}`);
          console.log(`  ${chalk.red('why:')} ${item.last_error_summary}`);
          if (item.next_action) console.log(`  ${chalk.yellow('next:')} ${item.next_action}`);
        }
      }

      if (aggregate.execution_policy.follow_plan) {
        console.log(`${chalk.dim('plan-aware run:')} merged ${aggregate.execution_policy.merged_count}${aggregate.execution_policy.merge_budget !== null ? ` of ${aggregate.execution_policy.merge_budget}` : ''} budgeted item(s)`);
      }

      await maybeCaptureTelemetry('queue_used', {
        watch,
        cycles: aggregate.cycles,
        processed_count: aggregate.processed.length,
        merged_count: aggregate.processed.filter((entry) => entry.status === 'merged').length,
        blocked_count: aggregate.processed.filter((entry) => entry.status !== 'merged').length,
      });
    } catch (err) {
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
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

queueCmd
  .command('retry <itemId>')
  .description('Retry a blocked merge queue item')
  .option('--json', 'Output raw JSON')
  .action((itemId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const item = retryMergeQueueItem(db, itemId);
    db.close();

    if (!item) {
      printErrorWithNext(`Queue item ${itemId} is not retryable.`, 'switchman queue status');
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(item, null, 2));
      return;
    }

    console.log(`${chalk.green('✓')} Queue item ${chalk.cyan(item.id)} reset to retrying`);
  });

queueCmd
  .command('escalate <itemId>')
  .description('Mark a queue item as needing explicit operator review before landing')
  .option('--reason <text>', 'Why this item is being escalated')
  .option('--json', 'Output raw JSON')
  .action((itemId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const item = escalateMergeQueueItem(db, itemId, {
      summary: opts.reason || null,
      nextAction: `Run \`switchman explain queue ${itemId}\` to review the landing risk, then \`switchman queue retry ${itemId}\` when it is ready again.`,
    });
    db.close();

    if (!item) {
      printErrorWithNext(`Queue item ${itemId} cannot be escalated.`, 'switchman queue status');
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(item, null, 2));
      return;
    }

    console.log(`${chalk.yellow('!')} Queue item ${chalk.cyan(item.id)} marked escalated for operator review`);
    if (item.last_error_summary) {
      console.log(`  ${chalk.red('why:')} ${item.last_error_summary}`);
    }
    if (item.next_action) {
      console.log(`  ${chalk.yellow('next:')} ${item.next_action}`);
    }
  });

queueCmd
  .command('remove <itemId>')
  .description('Remove a merge queue item')
  .action((itemId) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const item = removeMergeQueueItem(db, itemId);
    db.close();

    if (!item) {
      printErrorWithNext(`Queue item ${itemId} does not exist.`, 'switchman queue status');
      process.exitCode = 1;
      return;
    }

    console.log(`${chalk.green('✓')} Removed ${chalk.cyan(item.id)} from the merge queue`);
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

const pipelineCmd = program.command('pipeline').description('Create and summarize issue-to-PR execution pipelines');
pipelineCmd._switchmanAdvanced = true;
pipelineCmd.addHelpText('after', `
Examples:
  switchman pipeline start "Harden auth API permissions"
  switchman pipeline exec pipe-123 "/path/to/agent-command"
  switchman pipeline status pipe-123
  switchman pipeline land pipe-123
`);

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
  .addHelpText('after', `
Plain English:
  Use this when one goal has been split into several tasks and you want to see what is running, stuck, or next.

Examples:
  switchman pipeline status pipe-123
  switchman pipeline status pipe-123 --json
`)
  .action((pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = getPipelineStatus(db, pipelineId);
      let landing;
      let landingError = null;
      try {
        landing = getPipelineLandingBranchStatus(db, repoRoot, pipelineId, {
          requireCompleted: false,
        });
      } catch (err) {
        landingError = String(err.message || 'Landing branch is not ready yet.');
        landing = {
          branch: null,
          synthetic: false,
          stale: false,
          stale_reasons: [],
          last_failure: null,
          last_recovery: null,
        };
      }
      const policyState = summarizePipelinePolicyState(db, result, loadChangePolicy(repoRoot), []);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify({
          ...result,
          landing_branch: landing,
          landing_error: landingError,
          policy_state: policyState,
        }, null, 2));
        return;
      }

      const pipelineHealth = result.status === 'blocked'
        ? 'block'
        : result.counts.failed > 0
          ? 'warn'
          : result.counts.in_progress > 0
            ? 'warn'
            : 'healthy';
      const pipelineHealthColor = colorForHealth(pipelineHealth);
      const failedTask = result.tasks.find((task) => task.status === 'failed');
      const runningTask = result.tasks.find((task) => task.status === 'in_progress');
      const nextPendingTask = result.tasks.find((task) => task.status === 'pending');
      const focusTask = failedTask || runningTask || nextPendingTask || result.tasks[0] || null;
      const focusLine = focusTask
        ? `${focusTask.title} ${chalk.dim(focusTask.id)}`
        : 'No pipeline tasks found.';
      const landingLabel = buildLandingStateLabel(landing);

      console.log('');
      console.log(pipelineHealthColor('='.repeat(72)));
      console.log(`${pipelineHealthColor(healthLabel(pipelineHealth))} ${chalk.bold('switchman pipeline status')} ${chalk.dim('• pipeline mission control')}`);
      console.log(`${chalk.bold(result.title)} ${chalk.dim(result.pipeline_id)}`);
      console.log(pipelineHealthColor('='.repeat(72)));
      console.log(renderSignalStrip([
        renderChip('done', result.counts.done, result.counts.done > 0 ? chalk.green : chalk.white),
        renderChip('running', result.counts.in_progress, result.counts.in_progress > 0 ? chalk.blue : chalk.green),
        renderChip('pending', result.counts.pending, result.counts.pending > 0 ? chalk.yellow : chalk.green),
        renderChip('failed', result.counts.failed, result.counts.failed > 0 ? chalk.red : chalk.green),
      ]));
      console.log(`${chalk.bold('Focus now:')} ${focusLine}`);
      if (landingLabel) {
        console.log(`${chalk.bold('Landing:')} ${landingLabel}`);
      } else if (landingError) {
        console.log(`${chalk.bold('Landing:')} ${chalk.yellow('not ready yet')} ${chalk.dim(landingError)}`);
      }

      const runningLines = result.tasks.filter((task) => task.status === 'in_progress').slice(0, 4).map((task) => {
        const worktree = task.worktree || task.suggested_worktree || 'unassigned';
        const blocked = task.blocked_by?.length ? ` ${chalk.dim(`blocked by ${task.blocked_by.join(', ')}`)}` : '';
        const type = task.task_spec?.task_type ? ` ${chalk.dim(`[${task.task_spec.task_type}]`)}` : '';
        return `${chalk.cyan(worktree)} -> ${task.title}${type} ${chalk.dim(task.id)}${blocked}`;
      });

      const blockedLines = result.tasks.filter((task) => task.status === 'failed').slice(0, 4).flatMap((task) => {
        const type = task.task_spec?.task_type ? ` ${chalk.dim(`[${task.task_spec.task_type}]`)}` : '';
        const lines = [`${renderChip('BLOCKED', task.id, chalk.red)} ${task.title}${type}`];
        if (task.failure?.summary) {
          const reasonLabel = humanizeReasonCode(task.failure.reason_code);
          lines.push(`  ${chalk.red('why:')} ${task.failure.summary} ${chalk.dim(`(${reasonLabel})`)}`);
        }
        if (task.next_action) lines.push(`  ${chalk.yellow('next:')} ${task.next_action}`);
        return lines;
      });

      const nextLines = result.tasks.filter((task) => task.status === 'pending').slice(0, 4).map((task) => {
        const worktree = task.suggested_worktree || task.worktree || 'unassigned';
        const blocked = task.blocked_by?.length ? ` ${chalk.dim(`blocked by ${task.blocked_by.join(', ')}`)}` : '';
        return `${renderChip('NEXT', task.id, chalk.green)} ${task.title} ${chalk.dim(worktree)}${blocked}`;
      });

      const landingLines = landing.synthetic
        ? [
          `${renderChip(landing.stale ? 'STALE' : 'LAND', landing.branch, landing.stale ? chalk.red : chalk.green)} ${chalk.dim(`base ${landing.base_branch}`)}`,
          ...(landing.last_failure
            ? [
              `  ${chalk.red('failure:')} ${humanizeReasonCode(landing.last_failure.reason_code || 'landing_branch_materialization_failed')}`,
              ...(landing.last_failure.failed_branch ? [`  ${chalk.dim('failed branch:')} ${landing.last_failure.failed_branch}`] : []),
            ]
            : []),
          ...(landing.last_recovery?.state?.status
            ? [
              `  ${chalk.dim('recovery:')} ${landing.last_recovery.state.status} ${landing.last_recovery.recovery_path}`,
            ]
            : []),
          ...(landing.stale_reasons.length > 0
            ? landing.stale_reasons.slice(0, 3).map((reason) => `  ${chalk.red('why:')} ${reason.summary}`)
            : [landing.last_materialized
              ? `  ${chalk.green('state:')} ready to queue`
              : `  ${chalk.yellow('next:')} switchman pipeline land ${result.pipeline_id}`]),
          (landing.last_failure?.command
            ? `  ${chalk.yellow('next:')} ${landing.last_failure.command}`
            : landing.stale
            ? `  ${chalk.yellow('next:')} switchman pipeline land ${result.pipeline_id} --refresh`
            : `  ${chalk.yellow('next:')} switchman queue add --pipeline ${result.pipeline_id}`),
        ]
        : [];

      const policyLines = policyState.active
        ? [
          `${renderChip(policyState.enforcement.toUpperCase(), policyState.domains.join(','), policyState.enforcement === 'blocked' ? chalk.red : chalk.yellow)} ${policyState.summary}`,
          `  ${chalk.dim('required:')} ${policyState.required_task_types.join(', ') || 'none'}`,
          `  ${chalk.dim('satisfied:')} ${policyState.satisfied_task_types.join(', ') || 'none'}`,
          `  ${chalk.dim('missing:')} ${policyState.missing_task_types.join(', ') || 'none'}`,
          `  ${chalk.dim('overridden:')} ${policyState.overridden_task_types.join(', ') || 'none'}`,
          ...policyState.requirement_status
            .filter((requirement) => requirement.evidence.length > 0)
            .slice(0, 4)
            .map((requirement) => `  ${chalk.dim(`${requirement.task_type}:`)} ${requirement.evidence.map((entry) => entry.artifact_path ? `${entry.task_id} (${entry.artifact_path})` : entry.task_id).join(', ')}`),
          ...policyState.overrides
            .slice(0, 3)
            .map((entry) => `  ${chalk.dim(`override ${entry.id}:`)} ${(entry.task_types || []).join(', ') || 'all'} by ${entry.approved_by || 'unknown'}`),
        ]
        : [chalk.green('No explicit change policy requirements are active for this pipeline.')];

      const commandLines = [
        `${chalk.cyan('$')} switchman pipeline exec ${result.pipeline_id} "/path/to/agent-command"`,
        `${chalk.cyan('$')} switchman pipeline pr ${result.pipeline_id}`,
        ...(landing.last_failure?.command ? [`${chalk.cyan('$')} ${landing.last_failure.command}`] : []),
        ...(landing.synthetic && landing.stale ? [`${chalk.cyan('$')} switchman pipeline land ${result.pipeline_id} --refresh`] : []),
        ...(result.counts.failed > 0 ? [`${chalk.cyan('$')} switchman pipeline status ${result.pipeline_id}`] : []),
      ];

      console.log('');
      for (const block of [
        renderPanel('Running now', runningLines.length > 0 ? runningLines : [chalk.dim('No tasks are actively running.')], runningLines.length > 0 ? chalk.cyan : chalk.green),
        renderPanel('Blocked', blockedLines.length > 0 ? blockedLines : [chalk.green('Nothing blocked.')], blockedLines.length > 0 ? chalk.red : chalk.green),
        renderPanel('Next up', nextLines.length > 0 ? nextLines : [chalk.dim('No pending tasks left.')], chalk.green),
        renderPanel('Policy', policyLines, policyState.active ? (policyState.missing_task_types.length > 0 ? chalk.red : chalk.green) : chalk.green),
        ...(landing.synthetic ? [renderPanel('Landing branch', landingLines, landing.stale ? chalk.red : chalk.cyan)] : []),
        renderPanel('Next commands', commandLines, chalk.cyan),
      ]) {
        for (const line of block) console.log(line);
        console.log('');
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
  .option('--github', 'Write GitHub Actions step summary/output when GITHUB_* env vars are present')
  .option('--github-step-summary <path>', 'Path to write GitHub Actions step summary markdown')
  .option('--github-output <path>', 'Path to write GitHub Actions outputs')
  .option('--json', 'Output raw JSON')
  .action(async (pipelineId, outputDir, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = await exportPipelinePrBundle(db, repoRoot, pipelineId, outputDir || null);
      db.close();

      const githubTargets = resolveGitHubOutputTargets(opts);
      if (githubTargets.stepSummaryPath || githubTargets.outputPath) {
        writeGitHubPipelineLandingStatus({
          result: result.landing_summary,
          stepSummaryPath: githubTargets.stepSummaryPath,
          outputPath: githubTargets.outputPath,
        });
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Exported PR bundle for ${chalk.cyan(result.pipeline_id)}`);
      console.log(`  ${chalk.dim(result.output_dir)}`);
      console.log(`  ${chalk.dim('json:')} ${result.files.summary_json}`);
      console.log(`  ${chalk.dim('summary:')} ${result.files.summary_markdown}`);
      console.log(`  ${chalk.dim('body:')} ${result.files.pr_body_markdown}`);
      console.log(`  ${chalk.dim('landing json:')} ${result.files.landing_summary_json}`);
      console.log(`  ${chalk.dim('landing md:')} ${result.files.landing_summary_markdown}`);
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

pipelineCmd
  .command('land <pipelineId>')
  .description('Create or refresh one landing branch for a completed pipeline')
  .option('--base <branch>', 'Base branch for the landing branch', 'main')
  .option('--branch <branch>', 'Custom landing branch name')
  .option('--refresh', 'Rebuild the landing branch when a source branch or base branch has moved')
  .option('--recover', 'Create a recovery worktree for an unresolved landing merge conflict')
  .option('--replace-recovery', 'Replace an existing recovery worktree when creating a new one')
  .option('--resume [path]', 'Validate a resolved recovery worktree and mark the landing branch ready again')
  .option('--cleanup [path]', 'Remove a recorded recovery worktree after it is resolved or abandoned')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const selectedModes = [opts.refresh, opts.recover, Boolean(opts.resume), Boolean(opts.cleanup)].filter(Boolean).length;
      if (selectedModes > 1) {
        throw new Error('Choose only one of --refresh, --recover, --resume, or --cleanup.');
      }
      if (opts.recover) {
        const result = preparePipelineLandingRecovery(db, repoRoot, pipelineId, {
          baseBranch: opts.base,
          landingBranch: opts.branch || null,
          replaceExisting: Boolean(opts.replaceRecovery),
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} ${result.reused_existing ? 'Recovery worktree already ready for' : 'Recovery worktree ready for'} ${chalk.cyan(result.pipeline_id)}`);
        console.log(`  ${chalk.dim('branch:')} ${chalk.cyan(result.branch)}`);
        console.log(`  ${chalk.dim('path:')} ${result.recovery_path}`);
        if (result.reused_existing) {
          console.log(`  ${chalk.dim('state:')} reusing existing recovery worktree`);
        }
        console.log(`  ${chalk.dim('blocked by:')} ${result.failed_branch}`);
        if (result.conflicting_files.length > 0) {
          console.log(`  ${chalk.dim('conflicts:')} ${result.conflicting_files.join(', ')}`);
        }
        console.log(`  ${chalk.yellow('inspect:')} ${result.inspect_command}`);
        console.log(`  ${chalk.yellow('after resolving + commit:')} ${result.resume_command}`);
        return;
      }
      if (opts.cleanup) {
        const result = cleanupPipelineLandingRecovery(db, repoRoot, pipelineId, {
          baseBranch: opts.base,
          landingBranch: opts.branch || null,
          recoveryPath: typeof opts.cleanup === 'string' ? opts.cleanup : null,
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} Recovery worktree cleared for ${chalk.cyan(result.pipeline_id)}`);
        console.log(`  ${chalk.dim('path:')} ${result.recovery_path}`);
        console.log(`  ${chalk.dim('removed:')} ${result.removed ? 'yes' : 'no'}`);
        console.log(`  ${chalk.yellow('next:')} switchman explain landing ${result.pipeline_id}`);
        return;
      }
      if (opts.resume) {
        const result = resumePipelineLandingRecovery(db, repoRoot, pipelineId, {
          baseBranch: opts.base,
          landingBranch: opts.branch || null,
          recoveryPath: typeof opts.resume === 'string' ? opts.resume : null,
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} ${result.already_resumed ? 'Landing recovery already resumed for' : 'Landing recovery resumed for'} ${chalk.cyan(result.pipeline_id)}`);
        console.log(`  ${chalk.dim('branch:')} ${chalk.cyan(result.branch)}`);
        console.log(`  ${chalk.dim('head:')} ${result.head_commit}`);
        if (result.recovery_path) {
          console.log(`  ${chalk.dim('recovery path:')} ${result.recovery_path}`);
        }
        if (result.already_resumed) {
          console.log(`  ${chalk.dim('state:')} already aligned and ready to queue`);
        }
        console.log(`  ${chalk.yellow('next:')} ${result.resume_command}`);
        return;
      }

      const result = materializePipelineLandingBranch(db, repoRoot, pipelineId, {
        baseBranch: opts.base,
        landingBranch: opts.branch || null,
        requireCompleted: true,
        refresh: Boolean(opts.refresh),
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Landing branch ready for ${chalk.cyan(result.pipeline_id)}`);
      console.log(`  ${chalk.dim('branch:')} ${chalk.cyan(result.branch)}`);
      console.log(`  ${chalk.dim('base:')} ${result.base_branch}`);
      console.log(`  ${chalk.dim('strategy:')} ${result.strategy}`);
      console.log(`  ${chalk.dim('components:')} ${result.component_branches.join(', ')}`);
      if (result.reused_existing) {
        console.log(`  ${chalk.dim('state:')} already current`);
      } else if (result.refreshed) {
        console.log(`  ${chalk.dim('state:')} refreshed`);
      }
      console.log(`  ${chalk.yellow('next:')} switchman queue add ${result.branch}`);
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
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
  .command('comment <pipelineId> [outputDir]')
  .description('Post or update a GitHub PR comment with the pipeline landing summary')
  .option('--pr <number>', 'Pull request number to comment on')
  .option('--pr-from-env', 'Read the pull request number from GitHub Actions environment variables')
  .option('--gh-command <command>', 'Executable to use for GitHub CLI', 'gh')
  .option('--update-existing', 'Edit the last comment from this user instead of creating a new one')
  .option('--json', 'Output raw JSON')
  .action(async (pipelineId, outputDir, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const prNumber = opts.pr || (opts.prFromEnv ? resolvePrNumberFromEnv() : null);

    try {
      if (!prNumber) {
        throw new Error('A pull request number is required. Pass `--pr <number>` or `--pr-from-env`.');
      }
      const result = await commentPipelinePr(db, repoRoot, pipelineId, {
        prNumber,
        ghCommand: opts.ghCommand,
        outputDir: outputDir || null,
        updateExisting: Boolean(opts.updateExisting),
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Posted pipeline comment for ${chalk.cyan(result.pipeline_id)}`);
      console.log(`  ${chalk.dim('pr:')} #${result.pr_number}`);
      console.log(`  ${chalk.dim('body:')} ${result.bundle.files.landing_summary_markdown}`);
      if (result.updated_existing) {
        console.log(`  ${chalk.dim('mode:')} update existing comment`);
      }
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

pipelineCmd
  .command('sync-pr [pipelineId] [outputDir]')
  .description('Build PR artifacts, emit GitHub outputs, and update the PR comment in one command')
  .option('--pr <number>', 'Pull request number to comment on')
  .option('--pr-from-env', 'Read the pull request number from GitHub Actions environment variables')
  .option('--pipeline-from-env', 'Infer the pipeline id from the current GitHub branch context')
  .option('--skip-missing-pipeline', 'Exit successfully when no matching pipeline can be inferred')
  .option('--gh-command <command>', 'Executable to use for GitHub CLI', 'gh')
  .option('--github', 'Write GitHub Actions step summary/output when GITHUB_* env vars are present')
  .option('--github-step-summary <path>', 'Path to write GitHub Actions step summary markdown')
  .option('--github-output <path>', 'Path to write GitHub Actions outputs')
  .option('--no-comment', 'Skip updating the PR comment')
  .option('--json', 'Output raw JSON')
  .action(async (pipelineId, outputDir, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const branchFromEnv = opts.pipelineFromEnv ? resolveBranchFromEnv() : null;
    const resolvedPipelineId = pipelineId || (branchFromEnv ? inferPipelineIdFromBranch(db, branchFromEnv) : null);
    const prNumber = opts.pr || (opts.prFromEnv ? resolvePrNumberFromEnv() : null);

    try {
      if (!resolvedPipelineId) {
        if (!opts.skipMissingPipeline) {
          throw new Error(opts.pipelineFromEnv
            ? `Could not infer a pipeline from branch ${branchFromEnv || 'unknown'}. Pass a pipeline id explicitly or use a branch that maps to one Switchman pipeline.`
            : 'A pipeline id is required. Pass one explicitly or use `--pipeline-from-env`.');
        }
        const skipped = {
          skipped: true,
          reason: 'no_pipeline_inferred',
          branch: branchFromEnv,
          next_action: 'Run `switchman pipeline status <pipelineId>` locally to confirm the pipeline id, then rerun sync-pr with that id.',
        };
        db.close();
        if (opts.json) {
          console.log(JSON.stringify(skipped, null, 2));
          return;
        }
        console.log(`${chalk.green('✓')} No pipeline sync needed`);
        if (branchFromEnv) {
          console.log(`  ${chalk.dim('branch:')} ${branchFromEnv}`);
        }
        console.log(`  ${chalk.dim('reason:')} no matching Switchman pipeline was inferred`);
        console.log(`  ${chalk.yellow('next:')} ${skipped.next_action}`);
        return;
      }

      if (opts.comment !== false && !prNumber) {
        throw new Error('A pull request number is required for comment sync. Pass `--pr <number>`, `--pr-from-env`, or `--no-comment`.');
      }

      const result = await syncPipelinePr(db, repoRoot, resolvedPipelineId, {
        prNumber: opts.comment === false ? null : prNumber,
        ghCommand: opts.ghCommand,
        outputDir: outputDir || null,
        updateExisting: true,
      });
      db.close();

      const githubTargets = resolveGitHubOutputTargets(opts);
      if (githubTargets.stepSummaryPath || githubTargets.outputPath) {
        writeGitHubPipelineLandingStatus({
          result: result.bundle.landing_summary,
          stepSummaryPath: githubTargets.stepSummaryPath,
          outputPath: githubTargets.outputPath,
        });
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Synced PR artifacts for ${chalk.cyan(result.pipeline_id)}`);
      console.log(`  ${chalk.dim('bundle:')} ${result.bundle.output_dir}`);
      if (result.comment) {
        console.log(`  ${chalk.dim('pr:')} #${result.comment.pr_number}`);
        console.log(`  ${chalk.dim('comment:')} updated existing`);
      }
      if (githubTargets.stepSummaryPath || githubTargets.outputPath) {
        console.log(`  ${chalk.dim('github:')} wrote PR check artifacts`);
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
  .command('repair <pipelineId>')
  .description('Safely repair interrupted landing state for one pipeline')
  .option('--base <branch>', 'Base branch for landing repair checks', 'main')
  .option('--branch <branch>', 'Custom landing branch name')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = repairPipelineState(db, repoRoot, pipelineId, {
        baseBranch: opts.base,
        landingBranch: opts.branch || null,
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.repaired) {
        console.log(`${chalk.green('✓')} No repair action needed for ${chalk.cyan(result.pipeline_id)}`);
        for (const note of result.notes) {
          console.log(`  ${chalk.dim(note)}`);
        }
        console.log(`  ${chalk.yellow('next:')} ${result.next_action}`);
        return;
      }

      console.log(`${chalk.green('✓')} Repaired ${chalk.cyan(result.pipeline_id)}`);
      for (const action of result.actions) {
        if (action.kind === 'recovery_state_cleared') {
          console.log(`  ${chalk.dim('cleared recovery record:')} ${action.recovery_path}`);
        } else if (action.kind === 'landing_branch_refreshed') {
          console.log(`  ${chalk.dim('refreshed landing branch:')} ${action.branch}${action.head_commit ? ` ${chalk.dim(action.head_commit.slice(0, 12))}` : ''}`);
        }
      }
      console.log(`  ${chalk.yellow('next:')} ${result.next_action}`);
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
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
  .addHelpText('after', `
Plain English:
  pipeline = one goal, broken into smaller safe tasks

Examples:
  switchman pipeline exec pipe-123 "/path/to/agent-command"
  switchman pipeline exec pipe-123 "npm test"
`)
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
      printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
      process.exitCode = 1;
    }
  });

// ── lease ────────────────────────────────────────────────────────────────────

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
  .action((taskId, worktree, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const task = getTask(db, taskId);
    const lease = startTaskLease(db, taskId, worktree, opts.agent || null);
    db.close();

    if (!lease || !task) {
      if (opts.json) console.log(JSON.stringify({ lease: null, task: null }));
      else printErrorWithNext('Could not start a work session. The task may not exist or may already be in progress.', 'switchman task list --status pending');
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
  .action((opts) => {
    const repoRoot = getRepo();
    const worktreeName = getCurrentWorktreeName(opts.worktree);
    const { task, lease, exhausted } = acquireNextTaskLeaseWithRetries(repoRoot, worktreeName, opts.agent || null);

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
      else printErrorWithNext(`No active work session found for ${leaseId}.`, 'switchman lease list --status active');
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

// ── worktree ───────────────────────────────────────────────────────────────────

const wtCmd = program.command('worktree').alias('workspace').description('Manage registered workspaces (Git worktrees)');
wtCmd.addHelpText('after', `
Plain English:
  worktree = the Git feature behind each agent workspace

Examples:
  switchman worktree list
  switchman workspace list
  switchman worktree sync
`);

wtCmd
  .command('add <name> <path> <branch>')
  .description('Register a workspace with Switchman')
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
  .description('List all registered workspaces')
  .action(() => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const worktrees = listWorktrees(db);
    const gitWorktrees = listGitWorktrees(repoRoot);

    if (!worktrees.length && !gitWorktrees.length) {
      db.close();
      console.log(chalk.dim('No workspaces found. Run `switchman setup --agents 3` or `switchman worktree sync`.'));
      return;
    }

    // Show git worktrees (source of truth) annotated with db info
    const complianceReport = evaluateRepoCompliance(db, repoRoot, gitWorktrees);
    console.log('');
    console.log(chalk.bold('Git Worktrees:'));
    for (const wt of gitWorktrees) {
      const dbInfo = worktrees.find(d => d.path === wt.path);
      const complianceInfo = complianceReport.worktreeCompliance.find((entry) => entry.worktree === wt.name) || null;
      const agent = dbInfo?.agent ? chalk.cyan(dbInfo.agent) : chalk.dim('no agent');
      const status = dbInfo?.status ? statusBadge(dbInfo.status) : chalk.dim('unregistered');
      const compliance = complianceInfo?.compliance_state ? statusBadge(complianceInfo.compliance_state) : dbInfo?.compliance_state ? statusBadge(dbInfo.compliance_state) : chalk.dim('unknown');
      console.log(`  ${chalk.bold(wt.name.padEnd(20))} ${status} ${compliance} branch: ${chalk.cyan(wt.branch || 'unknown')}  agent: ${agent}`);
      console.log(`    ${chalk.dim(wt.path)}`);
      if ((complianceInfo?.unclaimed_changed_files || []).length > 0) {
        console.log(`    ${chalk.red('files:')} ${complianceInfo.unclaimed_changed_files.slice(0, 5).join(', ')}${complianceInfo.unclaimed_changed_files.length > 5 ? ` ${chalk.dim(`+${complianceInfo.unclaimed_changed_files.length - 5} more`)}` : ''}`);
      }
    }
    console.log('');
    db.close();
  });

wtCmd
  .command('sync')
  .description('Sync Git workspaces into the Switchman database')
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
  .description('Scan all workspaces for conflicts')
  .option('--json', 'Output raw JSON')
  .option('--quiet', 'Only show conflicts')
  .addHelpText('after', `
Examples:
  switchman scan
  switchman scan --quiet
  switchman scan --json
`)
  .action(async (opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const spinner = ora('Scanning workspaces for conflicts...').start();

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

      if ((report.ownershipConflicts?.length || 0) > 0) {
        console.log(chalk.yellow(`⚠ Ownership boundary overlaps detected:`));
        for (const conflict of report.ownershipConflicts) {
          if (conflict.type === 'subsystem_overlap') {
            console.log(`  ${chalk.yellow(`subsystem:${conflict.subsystemTag}`)}`);
            console.log(`    ${chalk.dim('reserved by:')} ${conflict.worktreeA}, ${conflict.worktreeB}`);
          } else {
            console.log(`  ${chalk.yellow(conflict.scopeA)}`);
            console.log(`    ${chalk.dim('overlaps with:')} ${conflict.scopeB}`);
            console.log(`    ${chalk.dim('reserved by:')} ${conflict.worktreeA}, ${conflict.worktreeB}`);
          }
        }
        console.log('');
      }

      if ((report.semanticConflicts?.length || 0) > 0) {
        console.log(chalk.yellow(`⚠ Semantic overlaps detected:`));
        for (const conflict of report.semanticConflicts) {
          console.log(`  ${chalk.yellow(conflict.object_name)}`);
          console.log(`    ${chalk.dim('changed by:')} ${conflict.worktreeA}, ${conflict.worktreeB}`);
          console.log(`    ${chalk.dim('files:')} ${conflict.fileA} ↔ ${conflict.fileB}`);
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
            const nextStep = nextStepForReason(reason);
            console.log(`    ${chalk.yellow(file)} ${chalk.dim(humanizeReasonCode(reason))}${nextStep ? ` ${chalk.dim(`— ${nextStep}`)}` : ''}`);
          });
        }
        console.log('');
      }

      // All clear
      if (report.conflicts.length === 0 && report.fileConflicts.length === 0 && (report.ownershipConflicts?.length || 0) === 0 && (report.semanticConflicts?.length || 0) === 0 && report.unclaimedChanges.length === 0) {
        console.log(chalk.green(`✓ No conflicts detected across ${report.worktrees.length} workspace(s)`));
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
  .description('Show one dashboard view of what is running, blocked, and ready next')
  .option('--json', 'Output raw JSON')
  .option('--watch', 'Keep refreshing status in the terminal')
  .option('--repair', 'Repair safe interrupted queue and pipeline state before rendering status')
  .option('--watch-interval-ms <n>', 'Polling interval for --watch mode', '2000')
  .option('--max-cycles <n>', 'Maximum refresh cycles before exiting', '0')
  .addHelpText('after', `
Examples:
  switchman status
  switchman status --watch
  switchman status --repair
  switchman status --json

Use this first when the repo feels stuck.
`)
  .action(async (opts) => {
    const repoRoot = getRepo();
    const watch = Boolean(opts.watch);
    const watchIntervalMs = Math.max(100, Number.parseInt(opts.watchIntervalMs, 10) || 2000);
    const maxCycles = Math.max(0, Number.parseInt(opts.maxCycles, 10) || 0);
    let cycles = 0;
    let lastSignature = null;

    while (true) {
      if (watch && process.stdout.isTTY && !opts.json) {
        console.clear();
      }

      let repairResult = null;
      if (opts.repair) {
        const repairDb = getDb(repoRoot);
        try {
          repairResult = repairRepoState(repairDb, repoRoot);
        } finally {
          repairDb.close();
        }
      }

      const report = await collectStatusSnapshot(repoRoot);
      cycles += 1;

      if (opts.json) {
        const payload = watch ? { ...report, watch: true, cycles } : report;
        console.log(JSON.stringify(opts.repair ? { ...payload, repair: repairResult } : payload, null, 2));
      } else {
        if (opts.repair && repairResult) {
          printRepairSummary(repairResult, {
            repairedHeading: `${chalk.green('✓')} Repaired safe interrupted repo state before rendering status`,
            noRepairHeading: `${chalk.green('✓')} No repo repair action needed before rendering status`,
            limit: 6,
          });
          console.log('');
        }
        renderUnifiedStatusReport(report);
        if (watch) {
          const signature = buildWatchSignature(report);
          const watchState = lastSignature === null
            ? chalk.cyan('baseline snapshot')
            : signature === lastSignature
              ? chalk.dim('no repo changes since last refresh')
              : chalk.green('change detected');
          const updatedAt = formatClockTime(report.generated_at);
          lastSignature = signature;
          console.log('');
          console.log(chalk.dim(`Live watch • updated ${updatedAt || 'just now'} • ${watchState}${maxCycles > 0 ? ` • cycle ${cycles}/${maxCycles}` : ''} • refresh ${watchIntervalMs}ms`));
        }
      }

      if (!watch) break;
      if (maxCycles > 0 && cycles >= maxCycles) break;
      if (opts.json) break;
      sleepSync(watchIntervalMs);
    }

    if (watch) {
      await maybeCaptureTelemetry('status_watch_used', {
        cycles,
        interval_ms: watchIntervalMs,
      });
    }
  });

program
  .command('repair')
  .description('Repair safe interrupted queue and pipeline state across the repo')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const result = repairRepoState(db, repoRoot);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.repaired) {
        printRepairSummary(result, {
          repairedHeading: `${chalk.green('✓')} Repaired safe interrupted repo state`,
          noRepairHeading: `${chalk.green('✓')} No repo repair action needed`,
        });
        console.log(`  ${chalk.yellow('next:')} ${result.next_action}`);
        return;
      }

      printRepairSummary(result, {
        repairedHeading: `${chalk.green('✓')} Repaired safe interrupted repo state`,
        noRepairHeading: `${chalk.green('✓')} No repo repair action needed`,
      });
      console.log(`  ${chalk.yellow('next:')} ${result.next_action}`);
    } catch (err) {
      db.close();
      console.error(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

const doctorCmd = program
  .command('doctor')
  .description('Show one operator-focused health view: what is running, what is blocked, and what to do next');
doctorCmd._switchmanAdvanced = true;
doctorCmd
  .option('--repair', 'Repair safe interrupted queue and pipeline state before reporting health')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Plain English:
  Use this when the repo feels risky, noisy, or stuck and you want the health summary plus exact next moves.

Examples:
  switchman doctor
  switchman doctor --json
`)
  .action(async (opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const repairResult = opts.repair ? repairRepoState(db, repoRoot) : null;
    const tasks = listTasks(db);
    const activeLeases = listLeases(db, 'active');
    const staleLeases = getStaleLeases(db);
    const scanReport = await scanAllWorktrees(db, repoRoot);
    const aiGate = await runAiMergeGate(db, repoRoot);
    const report = buildDoctorReport({
      db,
      repoRoot,
      tasks,
      activeLeases,
      staleLeases,
      scanReport,
      aiGate,
    });
    db.close();

    if (opts.json) {
      console.log(JSON.stringify(opts.repair ? { ...report, repair: repairResult } : report, null, 2));
      return;
    }

    if (opts.repair) {
      printRepairSummary(repairResult, {
        repairedHeading: `${chalk.green('✓')} Repaired safe interrupted repo state before running doctor`,
        noRepairHeading: `${chalk.green('✓')} No repo repair action needed before doctor`,
        limit: 6,
      });
      console.log('');
    }

    const doctorColor = colorForHealth(report.health);
    const blockedCount = report.attention.filter((item) => item.severity === 'block').length;
    const warningCount = report.attention.filter((item) => item.severity !== 'block').length;
    const focusItem = report.attention[0] || report.active_work[0] || null;
    const focusLine = focusItem
      ? `${focusItem.title || focusItem.task_title}${focusItem.detail ? ` ${chalk.dim(`• ${focusItem.detail}`)}` : ''}`
      : 'Nothing urgent. Repo health looks steady.';

    console.log('');
    console.log(doctorColor('='.repeat(72)));
    console.log(`${doctorColor(healthLabel(report.health))} ${chalk.bold('switchman doctor')} ${chalk.dim('• repo health mission control')}`);
    console.log(chalk.dim(repoRoot));
    console.log(chalk.dim(report.summary));
    console.log(doctorColor('='.repeat(72)));
    console.log(renderSignalStrip([
      renderChip('blocked', blockedCount, blockedCount > 0 ? chalk.red : chalk.green),
      renderChip('watch', warningCount, warningCount > 0 ? chalk.yellow : chalk.green),
      renderChip('leases', report.counts.active_leases, report.counts.active_leases > 0 ? chalk.blue : chalk.green),
      renderChip('stale', report.counts.stale_leases, report.counts.stale_leases > 0 ? chalk.red : chalk.green),
      renderChip('merge', report.merge_readiness.ci_gate_ok ? 'clear' : 'hold', report.merge_readiness.ci_gate_ok ? chalk.green : chalk.red),
    ]));
    console.log(renderMetricRow([
      { label: 'tasks', value: `${report.counts.pending}/${report.counts.in_progress}/${report.counts.done}/${report.counts.failed}`, color: chalk.white },
      { label: 'AI gate', value: report.merge_readiness.ai_gate_status, color: report.merge_readiness.ai_gate_status === 'blocked' ? chalk.red : report.merge_readiness.ai_gate_status === 'warn' ? chalk.yellow : chalk.green },
    ]));
    console.log(`${chalk.bold('Focus now:')} ${focusLine}`);

    const runningLines = report.active_work.length > 0
      ? report.active_work.slice(0, 5).map((item) => {
        const leaseId = activeLeases.find((lease) => lease.task_id === item.task_id && lease.worktree === item.worktree)?.id || null;
        const boundary = item.boundary_validation
          ? ` ${renderChip('validation', item.boundary_validation.status, item.boundary_validation.status === 'accepted' ? chalk.green : chalk.yellow)}`
          : '';
        const stale = (item.dependency_invalidations?.length || 0) > 0
          ? ` ${renderChip('stale', item.dependency_invalidations.length, chalk.yellow)}`
          : '';
        return `${chalk.cyan(item.worktree)} -> ${item.task_title} ${chalk.dim(item.task_id)}${leaseId ? ` ${chalk.dim(`lease:${leaseId}`)}` : ''}${item.scope_summary ? ` ${chalk.dim(item.scope_summary)}` : ''}${boundary}${stale}`;
      })
      : [chalk.dim('Nothing active right now.')];

    const attentionLines = report.attention.length > 0
      ? report.attention.slice(0, 6).flatMap((item) => {
        const lines = [`${item.severity === 'block' ? renderChip('BLOCKED', item.kind || 'item', chalk.red) : renderChip('WATCH', item.kind || 'item', chalk.yellow)} ${item.title}`];
        if (item.detail) lines.push(`  ${chalk.dim(item.detail)}`);
        lines.push(`  ${chalk.yellow('next:')} ${item.next_step}`);
        if (item.command) lines.push(`  ${chalk.cyan('run:')} ${item.command}`);
        return lines;
      })
      : [chalk.green('Nothing urgent.')];

    const staleClusterLines = report.merge_readiness.stale_clusters?.length > 0
      ? report.merge_readiness.stale_clusters.slice(0, 5).flatMap((cluster) => {
        const lines = [`${cluster.severity === 'block' ? renderChip('STALE', cluster.affected_pipeline_id || cluster.affected_task_ids[0], chalk.red) : renderChip('WATCH', cluster.affected_pipeline_id || cluster.affected_task_ids[0], chalk.yellow)} ${cluster.title}`];
        lines.push(`  ${chalk.dim(cluster.detail)}`);
        if (cluster.causal_group_size > 1) lines.push(`  ${chalk.dim('cause:')} ${cluster.causal_group_summary} ${chalk.dim(`(${cluster.causal_group_rank}/${cluster.causal_group_size} in same stale wave)`)}${cluster.related_affected_pipelines?.length ? ` ${chalk.dim(`related:${cluster.related_affected_pipelines.join(', ')}`)}` : ''}`);
        lines.push(`  ${chalk.dim('areas:')} ${cluster.stale_areas.join(', ')}`);
        lines.push(`  ${chalk.dim('rerun priority:')} ${cluster.rerun_priority} ${chalk.dim(`score:${cluster.rerun_priority_score}`)}${cluster.highest_affected_priority ? ` ${chalk.dim(`affected-priority:${cluster.highest_affected_priority}`)}` : ''}${cluster.rerun_breadth_score ? ` ${chalk.dim(`breadth:${cluster.rerun_breadth_score}`)}` : ''}`);
        lines.push(`  ${chalk.yellow('next:')} ${cluster.next_step}`);
        lines.push(`  ${chalk.cyan('run:')} ${cluster.command}`);
        return lines;
      })
      : [chalk.green('No stale dependency clusters.')];

    const nextStepLines = [
      ...report.next_steps.slice(0, 4).map((step) => `- ${step}`),
      '',
      ...report.suggested_commands.slice(0, 4).map((command) => `${chalk.cyan('$')} ${command}`),
    ];

    console.log('');
    console.log(chalk.bold('Attention now:'));
    for (const block of [
      renderPanel('Running now', runningLines, chalk.cyan),
      renderPanel('Attention now', attentionLines, report.attention.some((item) => item.severity === 'block') ? chalk.red : report.attention.length > 0 ? chalk.yellow : chalk.green),
      renderPanel('Stale clusters', staleClusterLines, report.merge_readiness.stale_clusters?.some((cluster) => cluster.severity === 'block') ? chalk.red : (report.merge_readiness.stale_clusters?.length || 0) > 0 ? chalk.yellow : chalk.green),
      renderPanel('Recommended next steps', nextStepLines, chalk.green),
    ]) {
      for (const line of block) console.log(line);
      console.log('');
    }
  });

// ── gate ─────────────────────────────────────────────────────────────────────

const gateCmd = program.command('gate').description('Safety checks for edits, merges, and CI');
gateCmd.addHelpText('after', `
Examples:
  switchman gate ci
  switchman gate ai
  switchman gate install-ci
`);

const auditCmd = program.command('audit').description('Inspect and verify the tamper-evident audit trail');
auditCmd._switchmanAdvanced = true;

auditCmd
  .command('change <pipelineId>')
  .description('Show a signed, operator-friendly history for one pipeline')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, options) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);

    try {
      const report = buildPipelineHistoryReport(db, repoRoot, pipelineId);
      db.close();

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(chalk.bold(`Audit history for pipeline ${report.pipeline_id}`));
      console.log(`  ${chalk.dim('title:')} ${report.title}`);
      console.log(`  ${chalk.dim('events:')} ${report.events.length}`);
      console.log(`  ${chalk.yellow('next:')} ${report.next_action}`);
      for (const event of report.events.slice(-20)) {
        const status = event.status ? ` ${statusBadge(event.status).trim()}` : '';
        console.log(`  ${chalk.dim(event.created_at)} ${chalk.cyan(event.label)}${status}`);
        console.log(`    ${event.summary}`);
      }
    } catch (err) {
      db.close();
      printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
      process.exitCode = 1;
    }
  });

auditCmd
  .command('verify')
  .description('Verify the audit log hash chain and project signatures')
  .option('--json', 'Output verification details as JSON')
  .action((options) => {
    const repo = getRepo();
    const db = getDb(repo);
    const result = verifyAuditTrail(db);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    }

    if (result.ok) {
      console.log(chalk.green(`Audit trail verified: ${result.count} signed events in order.`));
      return;
    }

    console.log(chalk.red(`Audit trail verification failed: ${result.failures.length} problem(s) across ${result.count} events.`));
    for (const failure of result.failures.slice(0, 10)) {
      const prefix = failure.sequence ? `#${failure.sequence}` : `event ${failure.id}`;
      console.log(`  ${chalk.red(prefix)} ${failure.reason_code}: ${failure.message}`);
    }
    if (result.failures.length > 10) {
      console.log(chalk.dim(`  ...and ${result.failures.length - 10} more`));
    }
    process.exit(1);
  });

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
  .option('--github', 'Write GitHub Actions step summary/output when GITHUB_* env vars are present')
  .option('--github-step-summary <path>', 'Path to write GitHub Actions step summary markdown')
  .option('--github-output <path>', 'Path to write GitHub Actions outputs')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const report = await scanAllWorktrees(db, repoRoot);
    const aiGate = await runAiMergeGate(db, repoRoot);
    db.close();

    const ok = report.conflicts.length === 0
      && report.fileConflicts.length === 0
      && (report.ownershipConflicts?.length || 0) === 0
      && (report.semanticConflicts?.length || 0) === 0
      && report.unclaimedChanges.length === 0
      && report.complianceSummary.non_compliant === 0
      && report.complianceSummary.stale === 0
      && aiGate.status !== 'blocked'
      && (aiGate.dependency_invalidations?.filter((item) => item.severity === 'blocked').length || 0) === 0;

    const result = {
      ok,
      summary: ok
        ? `Repo gate passed for ${report.worktrees.length} worktree(s).`
        : 'Repo gate rejected unmanaged changes, stale leases, ownership conflicts, stale dependency invalidations, or boundary validation failures.',
      compliance: report.complianceSummary,
      unclaimed_changes: report.unclaimedChanges,
      file_conflicts: report.fileConflicts,
      ownership_conflicts: report.ownershipConflicts || [],
      semantic_conflicts: report.semanticConflicts || [],
      branch_conflicts: report.conflicts,
      ai_gate_status: aiGate.status,
      boundary_validations: aiGate.boundary_validations || [],
      dependency_invalidations: aiGate.dependency_invalidations || [],
    };

    const githubTargets = resolveGitHubOutputTargets(opts);
    if (githubTargets.stepSummaryPath || githubTargets.outputPath) {
      writeGitHubCiStatus({
        result,
        stepSummaryPath: githubTargets.stepSummaryPath,
        outputPath: githubTargets.outputPath,
      });
    }

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
      if (result.ownership_conflicts.length > 0) {
        console.log(chalk.bold('  Ownership conflicts:'));
        for (const conflict of result.ownership_conflicts) {
          if (conflict.type === 'subsystem_overlap') {
            console.log(`    ${chalk.yellow(conflict.worktreeA)} ${chalk.dim('vs')} ${chalk.yellow(conflict.worktreeB)} ${chalk.dim(`subsystem:${conflict.subsystemTag}`)}`);
          } else {
            console.log(`    ${chalk.yellow(conflict.worktreeA)} ${chalk.dim('vs')} ${chalk.yellow(conflict.worktreeB)} ${chalk.dim(`${conflict.scopeA} ↔ ${conflict.scopeB}`)}`);
          }
        }
      }
      if (result.semantic_conflicts.length > 0) {
        console.log(chalk.bold('  Semantic conflicts:'));
        for (const conflict of result.semantic_conflicts) {
          console.log(`    ${chalk.yellow(conflict.object_name)} ${chalk.dim(`${conflict.worktreeA} vs ${conflict.worktreeB}`)}`);
        }
      }
      if (result.branch_conflicts.length > 0) {
        console.log(chalk.bold('  Branch conflicts:'));
        for (const conflict of result.branch_conflicts) {
          console.log(`    ${chalk.yellow(conflict.worktreeA)} ${chalk.dim('vs')} ${chalk.yellow(conflict.worktreeB)}`);
        }
      }
      if (result.boundary_validations.length > 0) {
        console.log(chalk.bold('  Boundary validations:'));
        for (const validation of result.boundary_validations) {
          console.log(`    ${chalk.yellow(validation.task_id)} ${chalk.dim(validation.missing_task_types.join(', '))}`);
        }
      }
      if (result.dependency_invalidations.length > 0) {
        console.log(chalk.bold('  Stale dependency invalidations:'));
        for (const invalidation of result.dependency_invalidations) {
          console.log(`    ${chalk.yellow(invalidation.affected_task_id)} ${chalk.dim(invalidation.stale_area)}`);
        }
      }
    }

    await maybeCaptureTelemetry(ok ? 'gate_ci_passed' : 'gate_ci_failed', {
      worktree_count: report.worktrees.length,
      unclaimed_change_count: result.unclaimed_changes.length,
      file_conflict_count: result.file_conflicts.length,
      ownership_conflict_count: result.ownership_conflicts.length,
      semantic_conflict_count: result.semantic_conflicts.length,
      branch_conflict_count: result.branch_conflicts.length,
    });

    if (!ok) process.exitCode = 1;
  });

gateCmd
  .command('install-ci')
  .description('Install a GitHub Actions workflow that runs the Switchman CI gate on PRs and pushes')
  .option('--workflow-name <name>', 'Workflow file name', 'switchman-gate.yml')
  .action((opts) => {
    const repoRoot = getRepo();
    const workflowPath = installGitHubActionsWorkflow(repoRoot, opts.workflowName);
    console.log(`${chalk.green('✓')} Installed GitHub Actions workflow at ${chalk.cyan(workflowPath)}`);
  });

gateCmd
  .command('ai')
  .description('Run the AI-style merge check to assess risky overlap across workspaces')
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

      if ((result.boundary_validations?.length || 0) > 0) {
        console.log(chalk.bold('  Boundary validations:'));
        for (const validation of result.boundary_validations.slice(0, 5)) {
          console.log(`    ${chalk.cyan(validation.task_id)} ${chalk.dim(validation.severity)} ${chalk.dim(validation.missing_task_types.join(', '))}`);
          if (validation.rationale?.[0]) {
            console.log(`      ${chalk.yellow(validation.rationale[0])}`);
          }
        }
      }

      if ((result.dependency_invalidations?.length || 0) > 0) {
        console.log(chalk.bold('  Stale dependency invalidations:'));
        for (const invalidation of result.dependency_invalidations.slice(0, 5)) {
          console.log(`    ${chalk.cyan(invalidation.affected_task_id)} ${chalk.dim(invalidation.severity)} ${chalk.dim(invalidation.stale_area)}`);
        }
      }

      if ((result.semantic_conflicts?.length || 0) > 0) {
        console.log(chalk.bold('  Semantic conflicts:'));
        for (const conflict of result.semantic_conflicts.slice(0, 5)) {
          console.log(`    ${chalk.cyan(conflict.object_name)} ${chalk.dim(conflict.type)} ${chalk.dim(`${conflict.worktreeA} vs ${conflict.worktreeB}`)}`);
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
    const child = spawn(process.execPath, [
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

// ── policy ───────────────────────────────────────────────────────────────────

const policyCmd = program.command('policy').description('Manage enforcement and change-governance policy');
policyCmd._switchmanAdvanced = true;

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

policyCmd
  .command('init-change')
  .description('Write a starter change policy file for governed domains like auth, payments, and schema')
  .action(() => {
    const repoRoot = getRepo();
    const policyPath = writeChangePolicy(repoRoot, DEFAULT_CHANGE_POLICY);
    console.log(`${chalk.green('✓')} Wrote change policy to ${chalk.cyan(policyPath)}`);
  });

policyCmd
  .command('show-change')
  .description('Show the active change policy for this repo')
  .option('--json', 'Output raw JSON')
  .action((opts) => {
    const repoRoot = getRepo();
    const policy = loadChangePolicy(repoRoot);
    const policyPath = getChangePolicyPath(repoRoot);

    if (opts.json) {
      console.log(JSON.stringify({ path: policyPath, policy }, null, 2));
      return;
    }

    console.log(chalk.bold('Change policy'));
    console.log(`  ${chalk.dim('path:')} ${policyPath}`);
    for (const [domain, rule] of Object.entries(policy.domain_rules || {})) {
      console.log(`  ${chalk.cyan(domain)} ${chalk.dim(rule.enforcement)}`);
      console.log(`    ${chalk.dim('requires:')} ${(rule.required_completed_task_types || []).join(', ') || 'none'}`);
    }
  });

policyCmd
  .command('override <pipelineId>')
  .description('Record a policy override for one pipeline requirement or task type')
  .requiredOption('--task-types <types>', 'Comma-separated task types to override, e.g. tests,governance')
  .requiredOption('--reason <text>', 'Why this override is being granted')
  .option('--by <actor>', 'Who approved the override', 'operator')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const taskTypes = String(opts.taskTypes || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (taskTypes.length === 0) {
      db.close();
      printErrorWithNext('At least one task type is required for a policy override.', 'switchman policy override <pipelineId> --task-types tests --reason "why"');
      process.exit(1);
    }

    const override = createPolicyOverride(db, {
      pipelineId,
      taskTypes,
      requirementKeys: taskTypes.map((taskType) => `completed_task_type:${taskType}`),
      reason: opts.reason,
      approvedBy: opts.by || null,
    });
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ override }, null, 2));
      return;
    }

    console.log(`${chalk.yellow('!')} Policy override ${chalk.cyan(override.id)} recorded for ${chalk.cyan(pipelineId)}`);
    console.log(`  ${chalk.dim('task types:')} ${taskTypes.join(', ')}`);
    console.log(`  ${chalk.dim('approved by:')} ${opts.by || 'operator'}`);
    console.log(`  ${chalk.dim('reason:')} ${opts.reason}`);
    console.log(`  ${chalk.dim('next:')} switchman pipeline status ${pipelineId}`);
  });

policyCmd
  .command('revoke <overrideId>')
  .description('Revoke a previously recorded policy override')
  .option('--reason <text>', 'Why the override is being revoked')
  .option('--by <actor>', 'Who revoked the override', 'operator')
  .option('--json', 'Output raw JSON')
  .action((overrideId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const override = revokePolicyOverride(db, overrideId, {
      revokedBy: opts.by || null,
      reason: opts.reason || null,
    });
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ override }, null, 2));
      return;
    }

    console.log(`${chalk.green('✓')} Policy override ${chalk.cyan(override.id)} revoked`);
    console.log(`  ${chalk.dim('pipeline:')} ${override.pipeline_id}`);
    console.log(`  ${chalk.dim('revoked by:')} ${opts.by || 'operator'}`);
    if (opts.reason) {
      console.log(`  ${chalk.dim('reason:')} ${opts.reason}`);
    }
  });

policyCmd
  .command('list-overrides <pipelineId>')
  .description('Show policy overrides recorded for a pipeline')
  .option('--json', 'Output raw JSON')
  .action((pipelineId, opts) => {
    const repoRoot = getRepo();
    const db = getDb(repoRoot);
    const overrides = listPolicyOverrides(db, { pipelineId, limit: 100 });
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ pipeline_id: pipelineId, overrides }, null, 2));
      return;
    }

    console.log(chalk.bold(`Policy overrides for ${pipelineId}`));
    if (overrides.length === 0) {
      console.log(`  ${chalk.green('No overrides recorded.')}`);
      return;
    }
    for (const entry of overrides) {
      console.log(`  ${chalk.cyan(entry.id)} ${chalk.dim(entry.status)}`);
      console.log(`    ${chalk.dim('task types:')} ${(entry.task_types || []).join(', ') || 'none'}`);
      console.log(`    ${chalk.dim('approved by:')} ${entry.approved_by || 'unknown'}`);
      console.log(`    ${chalk.dim('reason:')} ${entry.reason}`);
    }
  });

program.parse();
