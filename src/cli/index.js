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

import { program } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync } from 'fs';
import { join } from 'path';
import { execSync, spawn } from 'child_process';

import { findRepoRoot, listGitWorktrees, createGitWorktree } from '../core/git.js';
import {
  initDb, openDb,
  DEFAULT_STALE_LEASE_MINUTES,
  createTask, startTaskLease, completeTask, failTask, getBoundaryValidationState, getTaskSpec, listTasks, getTask, getNextPendingTask,
  listDependencyInvalidations, listLeases, listScopeReservations, heartbeatLease, getStaleLeases, reapStaleLeases,
  registerWorktree, listWorktrees,
  enqueueMergeItem, getMergeQueueItem, listMergeQueue, listMergeQueueEvents, removeMergeQueueItem, retryMergeQueueItem,
  claimFiles, releaseFileClaims, getActiveFileClaims, checkFileConflicts,
  verifyAuditTrail,
} from '../core/db.js';
import { scanAllWorktrees } from '../core/detector.js';
import { getWindsurfMcpConfigPath, upsertAllProjectMcpConfigs, upsertWindsurfMcpConfig } from '../core/mcp.js';
import { gatewayAppendFile, gatewayMakeDirectory, gatewayMovePath, gatewayRemovePath, gatewayWriteFile, installGateHooks, monitorWorktreesOnce, runCommitGate, runWrappedCommand, writeEnforcementPolicy } from '../core/enforcement.js';
import { runAiMergeGate } from '../core/merge-gate.js';
import { clearMonitorState, getMonitorStatePath, isProcessRunning, readMonitorState, writeMonitorState } from '../core/monitor.js';
import { buildPipelinePrSummary, createPipelineFollowupTasks, executePipeline, exportPipelinePrBundle, getPipelineStatus, publishPipelinePr, resolvePipelineLandingTarget, runPipeline, startPipeline } from '../core/pipeline.js';
import { installGitHubActionsWorkflow, resolveGitHubOutputTargets, writeGitHubCiStatus } from '../core/ci.js';
import { importCodeObjectsToStore, listCodeObjects, materializeCodeObjects, materializeSemanticIndex, updateCodeObjectSource } from '../core/semantic.js';
import { buildQueueStatusSummary, runMergeQueue } from '../core/queue.js';
import { DEFAULT_LEASE_POLICY, loadLeasePolicy, writeLeasePolicy } from '../core/policy.js';
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

  const blockedWorktrees = scanReport.unclaimedChanges.map((entry) => ({
    worktree: entry.worktree,
    files: entry.files,
    reason_code: entry.reasons?.[0]?.reason_code || null,
    next_step: nextStepForReason(entry.reasons?.[0]?.reason_code) || 'inspect the changed files and bring them back under Switchman claims',
  }));

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
      detail: `${entry.files.slice(0, 3).join(', ')}${entry.files.length > 3 ? ` +${entry.files.length - 3} more` : ''}`,
      next_step: entry.next_step,
      command: 'switchman scan',
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

  for (const invalidation of aiGate.dependency_invalidations || []) {
    attention.push({
      kind: 'dependency_invalidation',
      title: invalidation.summary,
      detail: `${invalidation.source_worktree || 'unknown'} -> ${invalidation.affected_worktree || 'unknown'} (${invalidation.stale_area})`,
      next_step: 'rerun or re-review the stale task before merge',
      command: invalidation.affected_pipeline_id ? `switchman pipeline status ${invalidation.affected_pipeline_id}` : 'switchman gate ai',
      severity: invalidation.severity === 'blocked' ? 'block' : 'warn',
    });
  }

  const health = attention.some((item) => item.severity === 'block')
    ? 'block'
    : attention.some((item) => item.severity === 'warn')
      ? 'warn'
      : 'healthy';

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
      compliance: scanReport.complianceSummary,
      semantic_conflicts: scanReport.semanticConflicts || [],
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
      ...doctorReport.next_steps,
      ...queueAttention.map((item) => item.next_step),
    ])].slice(0, 6),
    suggested_commands: [...new Set(suggestedCommands)].slice(0, 6),
  };
}

async function collectStatusSnapshot(repoRoot) {
  const db = getDb(repoRoot);
  try {
    const leasePolicy = loadLeasePolicy(repoRoot);

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
    : 'Nothing urgent. Safe to keep parallel work moving.';
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
  console.log(`${chalk.bold('Focus now:')} ${focusLine}`);
  console.log(chalk.dim(`policy: ${formatRelativePolicy(report.lease_policy)} • requeue on reap ${report.lease_policy.requeue_task_on_reap ? 'on' : 'off'}`));

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
        ? [`${chalk.dim('next:')} ${report.queue.summary.next.id} ${report.queue.summary.next.source_type}:${report.queue.summary.next.source_ref} ${chalk.dim(`retries:${report.queue.summary.next.retry_count}/${report.queue.summary.next.max_retries}`)}`]
        : []),
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
      completeTask(db, taskId);
      releaseFileClaims(db, taskId);
      db.close();
      return;
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

// ─── Program ──────────────────────────────────────────────────────────────────

program
  .name('switchman')
  .description('Conflict-aware task coordinator for parallel AI coding agents')
  .version('0.1.0');

program.showHelpAfterError('(run with --help for usage examples)');
program.addHelpText('after', `
Start here:
  switchman setup --agents 5
  switchman status --watch
  switchman gate ci

Most useful commands:
  switchman task add "Implement auth helper" --priority 9
  switchman lease next --json
  switchman queue run --watch

Docs:
  README.md
  docs/setup-cursor.md
`);

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
      console.log(`  2. Open Claude Code or Cursor in each folder above — the local MCP config will attach Switchman automatically`);
      console.log(`  3. Check status at any time:`);
      console.log(`     ${chalk.cyan('switchman status')}`);
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
  .command('done <taskId>')
  .description('Mark a task as complete and release all file claims')
  .action((taskId) => {
    const repoRoot = getRepo();
    try {
      completeTaskWithRetries(repoRoot, taskId);
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
  If Switchman cannot infer exactly one branch, queue the branch or worktree explicitly instead.
`)
  .action((branch, opts) => {
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
        const pipelineStatus = getPipelineStatus(db, opts.pipeline);
        const landingTarget = resolvePipelineLandingTarget(db, repoRoot, pipelineStatus, {
          requireCompleted: true,
          allowCurrentBranchFallback: false,
        });
        payload = {
          sourceType: 'pipeline',
          sourceRef: opts.pipeline,
          sourcePipelineId: opts.pipeline,
          sourceWorktree: landingTarget.worktree || null,
          targetBranch: opts.target,
          maxRetries: opts.maxRetries,
          submittedBy: opts.submittedBy || null,
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
      console.log(`  ${statusBadge(item.status)} ${item.id} ${item.source_type}:${item.source_ref} ${chalk.dim(`→ ${item.target_branch}`)} ${retryInfo}${attemptInfo}`);
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
    const summary = buildQueueStatusSummary(items);
    const recentEvents = items.slice(0, 5).flatMap((item) =>
      listMergeQueueEvents(db, item.id, { limit: 3 }).map((event) => ({ ...event, queue_item_id: item.id })),
    ).sort((a, b) => b.id - a.id).slice(0, 8);
    db.close();

    if (opts.json) {
      console.log(JSON.stringify({ items, summary, recent_events: recentEvents }, null, 2));
      return;
    }

    const queueHealth = summary.counts.blocked > 0 ? 'block' : summary.counts.retrying > 0 ? 'warn' : 'healthy';
    const queueHealthColor = colorForHealth(queueHealth);
    const focus = summary.blocked[0] || summary.retrying[0] || summary.next || null;
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
        `${renderChip('NEXT', summary.next.id, chalk.green)} ${summary.next.source_type}:${summary.next.source_ref} ${chalk.dim(`retries:${summary.next.retry_count}/${summary.next.max_retries}`)}`,
        `  ${chalk.yellow('run:')} switchman queue run`,
      ]
      : [chalk.dim('No queued landing work right now.')];

    const queueBlockedLines = summary.blocked.length > 0
      ? summary.blocked.slice(0, 4).flatMap((item) => {
        const lines = [`${renderChip('BLOCKED', item.id, chalk.red)} ${item.source_type}:${item.source_ref} ${chalk.dim(`retries:${item.retry_count}/${item.max_retries}`)}`];
        if (item.last_error_summary) lines.push(`  ${chalk.red('why:')} ${item.last_error_summary}`);
        if (item.next_action) lines.push(`  ${chalk.yellow('next:')} ${item.next_action}`);
        return lines;
      })
      : [chalk.green('Nothing blocked.')];

    const queueWatchLines = items.filter((item) => ['retrying', 'merging', 'rebasing', 'validating'].includes(item.status)).length > 0
      ? items
        .filter((item) => ['retrying', 'merging', 'rebasing', 'validating'].includes(item.status))
        .slice(0, 4)
        .flatMap((item) => {
          const lines = [`${renderChip(item.status.toUpperCase(), item.id, item.status === 'retrying' ? chalk.yellow : chalk.blue)} ${item.source_type}:${item.source_ref}`];
          if (item.last_error_summary) lines.push(`  ${chalk.dim(item.last_error_summary)}`);
          return lines;
        })
      : [chalk.green('No in-flight queue items right now.')];

    const queueCommandLines = [
      `${chalk.cyan('$')} switchman queue run`,
      `${chalk.cyan('$')} switchman queue status --json`,
      ...(summary.blocked[0] ? [`${chalk.cyan('$')} switchman queue retry ${summary.blocked[0].id}`] : []),
    ];

    console.log('');
    for (const block of [
      renderPanel('Landing focus', queueFocusLines, chalk.green),
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
  .option('--target <branch>', 'Default target branch', 'main')
  .option('--watch', 'Keep polling for new queue items')
  .option('--watch-interval-ms <n>', 'Polling interval for --watch mode', '1000')
  .option('--max-cycles <n>', 'Maximum watch cycles before exiting (mainly for tests)')
  .option('--json', 'Output raw JSON')
  .addHelpText('after', `
Examples:
  switchman queue run
  switchman queue run --watch
  switchman queue run --watch --watch-interval-ms 1000
`)
  .action(async (opts) => {
    const repoRoot = getRepo();

    try {
      const watch = Boolean(opts.watch);
      const watchIntervalMs = Math.max(0, Number.parseInt(opts.watchIntervalMs, 10) || 1000);
      const maxCycles = opts.maxCycles ? Math.max(1, Number.parseInt(opts.maxCycles, 10) || 1) : null;
      const aggregate = {
        processed: [],
        cycles: 0,
        watch,
      };

      while (true) {
        const db = getDb(repoRoot);
        const result = await runMergeQueue(db, repoRoot, {
          maxItems: Number.parseInt(opts.maxItems, 10) || 1,
          targetBranch: opts.target || 'main',
        });
        db.close();

        aggregate.processed.push(...result.processed);
        aggregate.summary = result.summary;
        aggregate.cycles += 1;

        if (!watch) break;
        if (maxCycles && aggregate.cycles >= maxCycles) break;
        if (result.processed.length === 0) {
          sleepSync(watchIntervalMs);
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(aggregate, null, 2));
        return;
      }

      if (aggregate.processed.length === 0) {
        console.log(chalk.dim('No queued merge items.'));
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

// ── pipeline ──────────────────────────────────────────────────────────────────

const pipelineCmd = program.command('pipeline').description('Create and summarize issue-to-PR execution pipelines');
pipelineCmd.addHelpText('after', `
Examples:
  switchman pipeline start "Harden auth API permissions"
  switchman pipeline exec pipe-123 "/path/to/agent-command"
  switchman pipeline status pipe-123
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
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
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

      const commandLines = [
        `${chalk.cyan('$')} switchman pipeline exec ${result.pipeline_id} "/path/to/agent-command"`,
        `${chalk.cyan('$')} switchman pipeline pr ${result.pipeline_id}`,
        ...(result.counts.failed > 0 ? [`${chalk.cyan('$')} switchman pipeline status ${result.pipeline_id}`] : []),
      ];

      console.log('');
      for (const block of [
        renderPanel('Running now', runningLines.length > 0 ? runningLines : [chalk.dim('No tasks are actively running.')], runningLines.length > 0 ? chalk.cyan : chalk.green),
        renderPanel('Blocked', blockedLines.length > 0 ? blockedLines : [chalk.green('Nothing blocked.')], blockedLines.length > 0 ? chalk.red : chalk.green),
        renderPanel('Next up', nextLines.length > 0 ? nextLines : [chalk.dim('No pending tasks left.')], chalk.green),
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
    db.close();

    if (!worktrees.length && !gitWorktrees.length) {
      console.log(chalk.dim('No workspaces found. Run `switchman setup --agents 3` or `switchman worktree sync`.'));
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
  .option('--force', 'Claim even if conflicts exist')
  .addHelpText('after', `
Examples:
  switchman claim task-123 agent2 src/auth.js src/server.js
  switchman claim task-123 agent2 src/auth.js --agent cursor

Use this before editing files in a shared repo.
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
        console.log(chalk.dim('\nUse --force to claim anyway, or pick different files first.'));
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
  .option('--watch-interval-ms <n>', 'Polling interval for --watch mode', '2000')
  .option('--max-cycles <n>', 'Maximum refresh cycles before exiting', '0')
  .addHelpText('after', `
Examples:
  switchman status
  switchman status --watch
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

      const report = await collectStatusSnapshot(repoRoot);
      cycles += 1;

      if (opts.json) {
        console.log(JSON.stringify(watch ? { ...report, watch: true, cycles } : report, null, 2));
      } else {
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
  .command('doctor')
  .description('Show one operator-focused health view: what is running, what is blocked, and what to do next')
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
      console.log(JSON.stringify(report, null, 2));
      return;
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
