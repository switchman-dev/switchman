import chalk from 'chalk';
import { existsSync } from 'fs';

import {
  finishOperationJournalEntry,
  getActiveLeaseForTask,
  getBoundaryValidationState,
  getLeaseExecutionContext,
  getMergeQueueItem,
  getStaleLeases,
  getTask,
  getTaskSpec,
  listAuditEvents,
  listMergeQueue,
  listOperationJournal,
  listTasks,
  listTempResources,
  listWorktrees,
  markMergeQueueState,
  registerWorktree,
  reapStaleLeases,
  retryTask,
  updateTempResource,
  updateWorktreeStatus,
} from '../core/db.js';
import { cleanupCrashedLandingTempWorktrees, getWorktreeChangedFiles, listGitWorktrees } from '../core/git.js';
import { loadLeasePolicy } from '../core/policy.js';
import { repairPipelineState } from '../core/pipeline.js';

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
  return `${chalk.dim(`${action.kind}:`)} ${JSON.stringify(action)}`;
}

function renderRepairWarningLine(warning) {
  if (warning.kind === 'temp_resource_manual_review') {
    return `${chalk.yellow('manual review:')} ${warning.resource_type} ${warning.path}`;
  }
  return `${chalk.yellow('manual review:')} ${warning.kind}`;
}

export function printRepairSummary(report, {
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

function summarizeRecoveredTaskState({
  task,
  lease = null,
  worktree = null,
  changedFiles = [],
  claims = [],
  boundaryValidation = null,
  auditEvents = [],
  recoveryKind,
  staleAfterMinutes = null,
}) {
  const observedWrites = auditEvents.filter((event) => event.event_type === 'write_observed');
  const latestAuditEvent = auditEvents[0] || null;
  const nextAction = worktree?.path
    ? `cd "${worktree.path}" && git status`
    : `switchman task retry ${task.id}`;

  return {
    kind: recoveryKind,
    task_id: task.id,
    task_title: task.title,
    worktree: worktree?.name || lease?.worktree || task.worktree || null,
    worktree_path: worktree?.path || null,
    lease_id: lease?.id || null,
    agent: lease?.agent || task.agent || null,
    stale_after_minutes: staleAfterMinutes,
    changed_files: changedFiles,
    claimed_files: claims,
    observed_write_count: observedWrites.length,
    latest_audit_event: latestAuditEvent ? {
      event_type: latestAuditEvent.event_type,
      status: latestAuditEvent.status,
      created_at: latestAuditEvent.created_at,
      reason_code: latestAuditEvent.reason_code || null,
    } : null,
    boundary_validation: boundaryValidation ? {
      status: boundaryValidation.status,
      missing_task_types: boundaryValidation.missing_task_types || [],
    } : null,
    progress_summary: changedFiles.length > 0
      ? `Observed uncommitted changes in ${changedFiles.length} file(s).`
      : claims.length > 0
        ? `Lease held ${claims.length} active claim(s) before recovery.`
        : observedWrites.length > 0
          ? `Observed ${observedWrites.length} governed write event(s) before recovery.`
          : 'No uncommitted changes were detected at recovery time.',
    next_action: nextAction,
  };
}

export function buildRecoverReport(db, repoRoot, { staleAfterMinutes = null, reason = 'operator recover' } = {}) {
  const leasePolicy = loadLeasePolicy(repoRoot);
  const staleMinutes = staleAfterMinutes
    ? Number.parseInt(staleAfterMinutes, 10)
    : leasePolicy.stale_after_minutes;
  const worktreeMap = new Map(listWorktrees(db).map((worktree) => [worktree.name, worktree]));
  const currentStaleLeases = getStaleLeases(db, staleMinutes);
  const staleTaskIds = new Set(currentStaleLeases.map((lease) => lease.task_id));
  const staleLeaseSummaries = currentStaleLeases.map((lease) => {
    const execution = getLeaseExecutionContext(db, lease.id);
    const worktree = worktreeMap.get(lease.worktree) || execution?.worktree || null;
    const changedFiles = worktree?.path ? getWorktreeChangedFiles(worktree.path, repoRoot) : [];
    const claims = execution?.claims?.map((claim) => claim.file_path) || [];
    const boundaryValidation = getBoundaryValidationState(db, lease.id);
    const auditEvents = listAuditEvents(db, { taskId: lease.task_id, limit: 10 });
    return summarizeRecoveredTaskState({
      task: execution?.task || getTask(db, lease.task_id),
      lease,
      worktree,
      changedFiles,
      claims,
      boundaryValidation,
      auditEvents,
      recoveryKind: 'stale_lease',
      staleAfterMinutes: staleMinutes,
    });
  });

  const strandedTasks = listTasks(db, 'in_progress')
    .filter((task) => !staleTaskIds.has(task.id))
    .filter((task) => !getActiveLeaseForTask(db, task.id));
  const strandedTaskSummaries = strandedTasks.map((task) => {
    const worktree = task.worktree ? worktreeMap.get(task.worktree) || null : null;
    const changedFiles = worktree?.path ? getWorktreeChangedFiles(worktree.path, repoRoot) : [];
    const auditEvents = listAuditEvents(db, { taskId: task.id, limit: 10 });
    return summarizeRecoveredTaskState({
      task,
      worktree,
      changedFiles,
      claims: [],
      boundaryValidation: null,
      auditEvents,
      recoveryKind: 'stranded_task',
    });
  });

  const expiredLeases = currentStaleLeases.length > 0
    ? reapStaleLeases(db, staleMinutes, { requeueTask: leasePolicy.requeue_task_on_reap })
    : [];
  const retriedTasks = strandedTasks
    .map((task) => retryTask(db, task.id, reason))
    .filter(Boolean);
  const repair = repairRepoState(db, repoRoot);

  return {
    stale_after_minutes: staleMinutes,
    requeue_task_on_reap: leasePolicy.requeue_task_on_reap,
    stale_leases: staleLeaseSummaries.map((item) => ({
      ...item,
      recovered_to: leasePolicy.requeue_task_on_reap ? 'pending' : 'failed',
    })),
    stranded_tasks: strandedTaskSummaries.map((item) => ({
      ...item,
      recovered_to: 'pending',
    })),
    repair,
    recovered: {
      stale_leases: expiredLeases.length,
      stranded_tasks: retriedTasks.length,
      repo_actions: repair.actions.length,
    },
    next_steps: [
      ...(staleLeaseSummaries.length > 0 || strandedTaskSummaries.length > 0
        ? ['switchman status', 'switchman task list --status pending']
        : []),
      ...(repair.next_action ? [repair.next_action] : []),
    ].filter((value, index, all) => all.indexOf(value) === index),
  };
}

export function printRecoverSummary(report) {
  const totalRecovered = report.recovered.stale_leases + report.recovered.stranded_tasks;
  console.log(totalRecovered > 0 || report.repair.repaired
    ? `${chalk.green('✓')} Recovered abandoned work and repaired safe interrupted state`
    : `${chalk.green('✓')} No abandoned work needed recovery`);

  console.log(`  ${chalk.dim('stale lease threshold:')} ${report.stale_after_minutes} minute(s)`);
  console.log(`  ${chalk.dim('requeue on reap:')} ${report.requeue_task_on_reap ? 'on' : 'off'}`);
  console.log(`  ${chalk.green('recovered stale leases:')} ${report.recovered.stale_leases}`);
  console.log(`  ${chalk.green('recovered stranded tasks:')} ${report.recovered.stranded_tasks}`);
  console.log(`  ${chalk.green('repo repair actions:')} ${report.recovered.repo_actions}`);

  const recoveredItems = [...report.stale_leases, ...report.stranded_tasks];
  if (recoveredItems.length > 0) {
    console.log('');
    console.log(chalk.bold('Recovered work:'));
    for (const item of recoveredItems) {
      console.log(`  ${chalk.cyan(item.worktree || 'unknown')} ${chalk.dim(item.task_id)} ${chalk.bold(item.task_title)}`);
      console.log(`    ${chalk.dim('type:')} ${item.kind === 'stale_lease' ? 'stale lease' : 'stranded in-progress task'}${item.lease_id ? `  ${chalk.dim('lease:')} ${item.lease_id}` : ''}`);
      console.log(`    ${chalk.dim('summary:')} ${item.progress_summary}`);
      if (item.changed_files.length > 0) {
        console.log(`    ${chalk.dim('changed:')} ${item.changed_files.slice(0, 5).join(', ')}${item.changed_files.length > 5 ? ` ${chalk.dim(`+${item.changed_files.length - 5} more`)}` : ''}`);
      }
      if (item.claimed_files.length > 0) {
        console.log(`    ${chalk.dim('claimed:')} ${item.claimed_files.slice(0, 5).join(', ')}${item.claimed_files.length > 5 ? ` ${chalk.dim(`+${item.claimed_files.length - 5} more`)}` : ''}`);
      }
      if (item.boundary_validation) {
        console.log(`    ${chalk.dim('validation:')} ${item.boundary_validation.status}${item.boundary_validation.missing_task_types.length > 0 ? ` ${chalk.dim(`missing ${item.boundary_validation.missing_task_types.join(', ')}`)}` : ''}`);
      }
      console.log(`    ${chalk.yellow('inspect:')} ${item.next_action}`);
    }
  }

  console.log('');
  printRepairSummary(report.repair, {
    repairedHeading: `${chalk.green('✓')} Repaired safe interrupted repo state during recovery`,
    noRepairHeading: `${chalk.green('✓')} No extra repo repair action was needed during recovery`,
    limit: 6,
  });
  if (report.next_steps.length > 0) {
    console.log('');
    console.log(chalk.bold('Next steps:'));
    for (const step of report.next_steps) {
      console.log(`  ${chalk.cyan(step)}`);
    }
  }
}

export function repairRepoState(db, repoRoot) {
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
