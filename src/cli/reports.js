import chalk from 'chalk';
import { execSync } from 'child_process';
import { posix } from 'path';

import { matchesPathPatterns } from '../core/ignore.js';
import {
  getActiveFileClaims,
  getBoundaryValidationState,
  getMergeQueueItem,
  getStaleLeases,
  getTask,
  getTaskSpec,
  listAuditEvents,
  listDependencyInvalidations,
  listLeases,
  listMergeQueue,
  listMergeQueueEvents,
  listScopeReservations,
  listTasks,
  listUsageEvents,
  openDb,
  pruneDatabaseMaintenance,
  reapStaleLeases,
} from '../core/db.js';
import { scanAllWorktrees } from '../core/detector.js';
import { runAiMergeGate } from '../core/merge-gate.js';
import { FREE_LOGGED_IN_RETENTION_DAYS, FREE_RETENTION_DAYS, getRetentionDaysForCurrentPlan } from '../core/licence.js';
import { loadChangePolicy, loadLeasePolicy } from '../core/policy.js';
import { getPipelineLandingExplainReport, getPipelineStatus, summarizePipelinePolicyState } from '../core/pipeline.js';
import { buildQueueStatusSummary, resolveQueueSource } from '../core/queue.js';
import { cleanupOldSyncEvents, getPendingQueueStatus } from '../core/sync.js';
import { getSharedStatusSnapshot } from '../core/shared-coordination.js';
import {
  colorForHealth,
  formatRelativePolicy,
  healthLabel,
  renderChip,
  renderMetricRow,
  renderMiniBar,
  renderPanel,
  renderSignalStrip,
  statusBadge,
} from './ui.js';

function listRecentGitAuthors(repoRoot, limit = 30) {
  try {
    return [...new Set(
      execSync(`git log --format=%ae -n ${limit}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
        .split('\n')
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
    )];
  } catch {
    return [];
  }
}

function buildUpgradeHints({ repoRoot, retentionDays, oldestAuditAt = null, recentAuthors = [] }) {
  const hints = [];

  // Unauthenticated (3-day retention) — nudge to log in free, not upgrade
  if (Number(retentionDays) === FREE_RETENTION_DAYS && oldestAuditAt) {
  const oldest = new Date(oldestAuditAt);
  if (!Number.isNaN(oldest.getTime())) {
    const ageDays = Math.floor((Date.now() - oldest.getTime()) / (24 * 60 * 60 * 1000));
    const daysUntilExpiry = Math.max(0, FREE_LOGGED_IN_RETENTION_DAYS - ageDays);
    if (daysUntilExpiry <= 2) {
        hints.push({
          kind: 'history_retention',
          severity: 'warn',
          title: `Your session history expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`,
          detail: `Log in free to extend history to ${FREE_LOGGED_IN_RETENTION_DAYS} days. Pro extends to 90 days.`,
          next_step: 'log in free to keep recent session history',
          command: 'switchman login',
        });
      }
    }
  }

  // Free logged-in (14-day retention) — nudge to upgrade for more history
  if (Number(retentionDays) === FREE_LOGGED_IN_RETENTION_DAYS && oldestAuditAt) {
    const oldest = new Date(oldestAuditAt);
    if (!Number.isNaN(oldest.getTime())) {
      const ageDays = Math.floor((Date.now() - oldest.getTime()) / (24 * 60 * 60 * 1000));
      const daysUntilExpiry = Math.max(0, FREE_LOGGED_IN_RETENTION_DAYS - ageDays);
      if (daysUntilExpiry <= 2) {
        hints.push({
          kind: 'history_retention',
          severity: 'warn',
          title: `Your task history expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`,
          detail: `Free history keeps ${FREE_LOGGED_IN_RETENTION_DAYS} days of audit trail in ${repoRoot}. Pro keeps 90 days for debugging, handoff, and incident review.`,
          next_step: 'upgrade before the oldest recent work rolls out of local history',
          command: 'switchman upgrade',
        });
      }
    }
  }

  if (Number(retentionDays) <= FREE_LOGGED_IN_RETENTION_DAYS && recentAuthors.length > 1) {
    hints.push({
      kind: 'team_visibility',
      severity: 'warn',
      title: 'Multiple developers are active in this repo',
      detail: `Recent git history shows ${recentAuthors.length} contributors. Free coordination is local to one machine; Pro adds shared cloud state, handoff, and team visibility.`,
      next_step: 'upgrade if this repo is becoming shared operational territory',
      command: 'switchman upgrade',
    });
  }

  return hints;
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

export function buildQueueExplainReport(db, repoRoot, itemId) {
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

export function buildClaimExplainReport(db, filePath) {
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

export function buildStaleTaskExplainReport(db, taskId) {
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

export function buildStaleClusters(invalidations = []) {
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

export function buildStalePipelineExplainReport(db, pipelineId) {
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

export function buildPipelineHistoryReport(db, repoRoot, pipelineId) {
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


export function buildLandingStateLabel(landing) {
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


export function humanizeReasonCode(reasonCode) {
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

export function nextStepForReason(reasonCode) {
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

export function latestTaskFailure(task) {
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

export function analyzeTaskScope(title, description = '') {
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

export function buildDoctorReport({ db, repoRoot, tasks, activeLeases, staleLeases, scanReport, aiGate }) {
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

  if (aiGate.status === 'warn' || aiGate.status === 'blocked' || aiGate.status === 'uncertain') {
    attention.push({
      kind: 'ai_merge_gate',
      title: aiGate.status === 'blocked'
        ? 'AI merge gate blocked the repo'
        : aiGate.status === 'uncertain'
          ? 'AI merge gate could not determine merge confidence'
          : 'AI merge gate wants manual review',
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
  retentionDays = 7,
  syncState = null,
  sharedSummary = null,
  upgradeHints = [],
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

  const upgradeAttention = upgradeHints.map((hint) => ({
    ...hint,
    severity: hint.severity || 'warn',
  }));
  const attention = [...doctorReport.attention, ...queueAttention, ...upgradeAttention];
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
    ...upgradeHints.map((hint) => hint.command).filter(Boolean),
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
      ...upgradeHints.map((item) => item.next_step),
    ])].slice(0, 6),
    suggested_commands: [...new Set(attention.length > 0 ? suggestedCommands : defaultSuggestedCommands)].slice(0, 6),
    retention_days: retentionDays,
    shared_summary: sharedSummary,
    sync_state: syncState || {
      pending: 0,
      oldest_queued_at: null,
      next_retry_at: null,
      last_error: null,
    },
    upgrade_hints: upgradeHints,
  };
}

export async function collectStatusSnapshot(repoRoot) {
  const db = openDb(repoRoot);
  try {
    const leasePolicy = loadLeasePolicy(repoRoot);
    const retentionDays = await getRetentionDaysForCurrentPlan();
    pruneDatabaseMaintenance(db, { retentionDays });
    cleanupOldSyncEvents({ retentionDays }).catch(() => {});

    if (leasePolicy.reap_on_status_check) {
      reapStaleLeases(db, leasePolicy.stale_after_minutes, {
        requeueTask: leasePolicy.requeue_task_on_reap,
      });
    }

    let tasks = listTasks(db);
    let activeLeases = listLeases(db, 'active');
    let staleLeases = getStaleLeases(db, leasePolicy.stale_after_minutes);
    let claims = getActiveFileClaims(db);
    const sharedSnapshot = await getSharedStatusSnapshot(repoRoot);
    if (sharedSnapshot.shared && !sharedSnapshot.ok) {
      throw new Error(sharedSnapshot.message || `Shared coordination status snapshot failed (${sharedSnapshot.reason}).`);
    }
    const sharedSummary = sharedSnapshot.ok ? (sharedSnapshot.summary || null) : null;
    if (sharedSnapshot.ok) {
      tasks = sharedSnapshot.tasks || [];
      activeLeases = sharedSnapshot.active_leases || [];
      staleLeases = sharedSnapshot.stale_leases || [];
      claims = sharedSnapshot.claims || [];
    }
    const queueItems = listMergeQueue(db);
    const queueSummary = buildQueueStatusSummary(queueItems);
    const syncState = getPendingQueueStatus();
    const recentQueueEvents = queueItems
      .slice(0, 5)
      .flatMap((item) => listMergeQueueEvents(db, item.id, { limit: 3 }).map((event) => ({ ...event, queue_item_id: item.id })))
      .sort((a, b) => b.id - a.id)
      .slice(0, 8);
    const recentAuditEvents = listAuditEvents(db, { limit: 5000 });
    const oldestAuditAt = recentAuditEvents.length > 0
      ? recentAuditEvents.reduce((oldest, event) =>
        !oldest || String(event.created_at || '') < String(oldest) ? event.created_at : oldest,
      null)
      : null;
    const upgradeHints = buildUpgradeHints({
      repoRoot,
      retentionDays,
      oldestAuditAt,
      recentAuthors: listRecentGitAuthors(repoRoot),
    });
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
      retentionDays,
      syncState,
      sharedSummary,
      upgradeHints,
    });
  } finally {
    db.close();
  }
}

export async function buildSessionSummary(repoRoot, { hours = 8 } = {}) {
  const db = openDb(repoRoot);
  try {
    const retentionDays = await getRetentionDaysForCurrentPlan();
    const since = Date.now() - Math.max(1, Number(hours) || 8) * 60 * 60 * 1000;
    const isRecent = (isoString) => {
      const timestamp = new Date(isoString || '').getTime();
      return !Number.isNaN(timestamp) && timestamp >= since;
    };

    const auditEvents = listAuditEvents(db, { limit: 5000 }).filter((event) => isRecent(event.created_at));
    const queueItems = listMergeQueue(db);
    const queueEvents = queueItems
      .flatMap((item) => listMergeQueueEvents(db, item.id, { limit: 50 }).map((event) => ({ ...event, item })))
      .filter((event) => isRecent(event.created_at));
    const scanReport = await scanAllWorktrees(db, repoRoot);
    const liveSemanticConflicts = scanReport.semanticConflicts || [];
    const agentSummaries = buildAgentSessionSummaries(db, auditEvents);
    const summary = summarizeSessionWindow(auditEvents, queueEvents, {
      hours: Math.max(1, Number(hours) || 8),
      retentionDays,
      liveSemanticConflicts,
      agentSummaries,
    });

    return {
      generated_at: new Date().toISOString(),
      hours: Math.max(1, Number(hours) || 8),
      retention_days: retentionDays,
      metrics: summary.metrics,
      merge_confidence: summary.merge_confidence,
      narrative: summary.narrative,
      semantic_conflicts: summary.semantic_conflicts,
      agent_summaries: summary.agent_summaries,
      estimated_minutes_saved: summary.estimated_minutes_saved,
      upgrade_cta: null,
      counterfactual_depth: summary.counterfactual_depth,
      depth_hint: summary.depth_hint,
    };
  } finally {
    db.close();
  }
}

function summarizeSessionWindow(
  auditEvents = [],
  queueEvents = [],
  {
    hours = null,
    retentionDays = FREE_RETENTION_DAYS,
    liveSemanticConflicts = [],
    agentSummaries = [],
  } = {},
) {
  const metrics = {
    tasks_completed: auditEvents.filter((event) => event.event_type === 'task_completed').length,
    retries_scheduled: auditEvents.filter((event) => event.event_type === 'task_retried' || event.event_type === 'pipeline_task_retry_scheduled').length,
    rogue_writes_blocked: auditEvents.filter((event) => event.event_type === 'write_observed' && event.status === 'denied').length,
    queue_merges_completed: queueEvents.filter((event) => event.event_type === 'merge_queue_state_changed' && event.status === 'merged').length,
    queue_blocks_avoided: queueEvents.filter((event) => event.event_type === 'merge_queue_state_changed' && ['blocked', 'retrying', 'wave_blocked', 'escalated', 'held'].includes(event.status)).length,
    live_semantic_conflicts: liveSemanticConflicts.length,
  };

  const aiGateEvents = auditEvents.filter((event) => event.event_type === 'ai_merge_gate');
  const hasBlocked = aiGateEvents.some((event) => {
    const details = parseEventDetails(event.details);
    return details.status === 'blocked' || event.status === 'denied';
  });
  const hasUncertain = aiGateEvents.some((event) => {
    const details = parseEventDetails(event.details);
    return details.status === 'uncertain';
  });
  const hasWarn = aiGateEvents.some((event) => {
    const details = parseEventDetails(event.details);
    return details.status === 'warn' || event.status === 'warn';
  });
  const hasLiveBlockedSemantic = liveSemanticConflicts.some((conflict) =>
    conflict.severity === 'blocked' || conflict.type === 'semantic_object_overlap');
  const hasLiveWarnSemantic = liveSemanticConflicts.some((conflict) =>
    !hasLiveBlockedSemantic && (conflict.severity === 'warn' || conflict.type === 'semantic_name_overlap'));
  const mergeConfidence = hasBlocked || hasLiveBlockedSemantic
    ? 'red'
    : hasUncertain
      ? 'uncertain'
      : hasWarn || hasLiveWarnSemantic
        ? 'amber'
        : metrics.tasks_completed > 0 || metrics.queue_merges_completed > 0
          ? 'green'
          : 'uncertain';

  const isProDepth = retentionDays > FREE_LOGGED_IN_RETENTION_DAYS;
  const isLoggedIn = retentionDays > FREE_RETENTION_DAYS;
  const estimatedMinutesSaved = isProDepth
    ? (
      metrics.rogue_writes_blocked * 12 +
      metrics.retries_scheduled * 10 +
      metrics.queue_blocks_avoided * 8 +
      metrics.queue_merges_completed * 4
    )
    : 0;
  const windowText = hours == null
    ? 'in that session.'
    : `in the last ${hours} hour${hours === 1 ? '' : 's'}.`;
  const semanticConflictSummaries = buildSemanticConflictSummaries(liveSemanticConflicts);
  const hasNoSessionWork = metrics.tasks_completed === 0
    && metrics.queue_merges_completed === 0
    && metrics.rogue_writes_blocked === 0
    && metrics.retries_scheduled === 0
    && metrics.queue_blocks_avoided === 0
    && semanticConflictSummaries.length === 0;
  const narrativeParts = [
    ...agentSummaries.slice(0, 3).map((entry) => entry.narrative),
    metrics.tasks_completed > 0
      ? `Completed ${metrics.tasks_completed} task${metrics.tasks_completed === 1 ? '' : 's'} ${windowText}`
      : `No task completions were recorded ${windowText}`,
    semanticConflictSummaries.length > 0
      ? `Live review scan flagged ${semanticConflictSummaries.length} semantic mismatch${semanticConflictSummaries.length === 1 ? '' : 'es'}: ${semanticConflictSummaries.join('; ')}.`
      : null,
    metrics.rogue_writes_blocked > 0
      ? `Switchman blocked ${metrics.rogue_writes_blocked} rogue write${metrics.rogue_writes_blocked === 1 ? '' : 's'} before they spread.`
      : null,
    metrics.retries_scheduled > 0
      ? `It scheduled ${metrics.retries_scheduled} retry or recovery handoff${metrics.retries_scheduled === 1 ? '' : 's'}.`
      : null,
    metrics.queue_blocks_avoided > 0
      ? `It caught ${metrics.queue_blocks_avoided} risky landing issue${metrics.queue_blocks_avoided === 1 ? '' : 's'} before merge.`
      : null,
    metrics.queue_merges_completed > 0
      ? `It landed ${metrics.queue_merges_completed} merge${metrics.queue_merges_completed === 1 ? '' : 's'} cleanly.`
      : null,
    mergeConfidence === 'green'
      ? 'Current merge confidence is green.'
      : mergeConfidence === 'amber'
        ? 'Current merge confidence is amber and deserves a careful review.'
        : mergeConfidence === 'red'
          ? 'Current merge confidence is red and should not be treated as merge-safe.'
          : hasNoSessionWork
            ? 'No completed tasks yet — run `switchman review` again when agents finish.'
            : 'Current merge confidence is uncertain, so manual review is recommended.',
  ].filter(Boolean);

  return {
    metrics,
    merge_confidence: mergeConfidence,
    narrative: narrativeParts.join(' '),
    semantic_conflicts: liveSemanticConflicts,
    agent_summaries: agentSummaries,
    estimated_minutes_saved: estimatedMinutesSaved,
    counterfactual_depth: isProDepth ? 'full' : 'read_only',
    depth_hint: !isProDepth
  ? {
    title: 'Want deeper counterfactual analysis?',
    command: isLoggedIn ? 'switchman upgrade' : 'switchman login',
    detail: isLoggedIn
      ? 'Pro adds richer counterfactual session analysis, longer history, and shared cloud coordination.'
      : 'Free login unlocks amber / red issue detail and extends session history to 14 days.',
  }
  : null,
  };
}

function formatTaskList(taskTitles = []) {
  const titles = taskTitles.filter(Boolean);
  if (titles.length === 0) return 'recent work';
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, 2).join(', ')}, and ${titles.length - 2} more`;
}

function buildAgentSessionSummaries(db, auditEvents = []) {
  const allLeases = listLeases(db);
  const leaseByTaskId = new Map();
  for (const lease of allLeases) {
    if (!lease?.task_id || leaseByTaskId.has(lease.task_id)) continue;
    leaseByTaskId.set(lease.task_id, lease);
  }

  const completedTaskIds = [...new Set(
    auditEvents
      .filter((event) => event.event_type === 'task_completed' && event.task_id)
      .map((event) => String(event.task_id)),
  )];

  const agents = new Map();
  for (const taskId of completedTaskIds) {
    const task = getTask(db, taskId);
    const lease = leaseByTaskId.get(taskId);
    const agent = task?.agent || lease?.agent || task?.worktree || lease?.worktree || 'unknown agent';
    if (!agents.has(agent)) {
      agents.set(agent, {
        agent,
        worktrees: new Set(),
        task_ids: [],
        task_titles: [],
      });
    }
    const entry = agents.get(agent);
    if (task?.worktree || lease?.worktree) entry.worktrees.add(task?.worktree || lease?.worktree);
    entry.task_ids.push(taskId);
    entry.task_titles.push(task?.title || taskId);
  }

  return [...agents.values()]
    .map((entry) => ({
      agent: entry.agent,
      worktrees: [...entry.worktrees],
      task_count: entry.task_ids.length,
      task_ids: entry.task_ids,
      task_titles: entry.task_titles,
      narrative: `${entry.agent}${entry.worktrees.length > 0 ? ` in ${entry.worktrees.join(', ')}` : ''} completed ${entry.task_ids.length} task${entry.task_ids.length === 1 ? '' : 's'}: ${formatTaskList(entry.task_titles)}.`,
    }))
    .sort((a, b) => b.task_count - a.task_count || String(a.agent).localeCompare(String(b.agent)));
}

function buildSemanticConflictSummaries(conflicts = []) {
  return conflicts.slice(0, 3).map((conflict) => {
    if (conflict.type === 'semantic_object_overlap') {
      return `flagged: ${conflict.object_name || 'shared export'} defined in both ${conflict.worktreeA}/${conflict.fileA || 'unknown'} and ${conflict.worktreeB}/${conflict.fileB || 'unknown'} — resolve before merging`;
    }
    return `flagged: ${conflict.object_name || 'shared symbol'} appears in both ${conflict.worktreeA}/${conflict.fileA || 'unknown'} and ${conflict.worktreeB}/${conflict.fileB || 'unknown'} — review before merging`;
  });
}

function buildSessionHighlights(auditEvents = [], queueEvents = []) {
  const highlights = new Set();
  for (const event of auditEvents) {
    if (event.task_id) highlights.add(String(event.task_id));
    const details = parseEventDetails(event.details);
    if (details.summary) highlights.add(String(details.summary));
    if (Array.isArray(details.shared_areas)) {
      for (const area of details.shared_areas.slice(0, 3)) {
        if (typeof area === 'string') highlights.add(area);
        else if (area?.name) highlights.add(area.name);
      }
    }
  }
  for (const event of queueEvents) {
    if (event.item?.source_ref) highlights.add(String(event.item.source_ref));
    if (event.item?.target_branch) highlights.add(String(event.item.target_branch));
    if (event.details) highlights.add(String(event.details));
  }
  return [...highlights].filter(Boolean).slice(0, 4);
}

export async function buildSessionHistoryReport(repoRoot, { days = 90, search = null } = {}) {
  const db = openDb(repoRoot);
  try {
    const retentionDays = await getRetentionDaysForCurrentPlan();
    const effectiveDays = Math.max(1, Math.min(Number.parseInt(days, 10) || 90, retentionDays));
    const sinceTimestamp = Date.now() - effectiveDays * 24 * 60 * 60 * 1000;
    const isRecent = (isoString) => {
      const timestamp = new Date(isoString || '').getTime();
      return !Number.isNaN(timestamp) && timestamp >= sinceTimestamp;
    };

    const auditEvents = listAuditEvents(db, { limit: 10000 }).filter((event) => isRecent(event.created_at));
    const queueItems = listMergeQueue(db);
    const queueEvents = queueItems
      .flatMap((item) => listMergeQueueEvents(db, item.id, { limit: 100 }).map((event) => ({ ...event, item })))
      .filter((event) => isRecent(event.created_at));

    const timeline = [
      ...auditEvents.map((event) => ({ kind: 'audit', created_at: event.created_at, payload: event })),
      ...queueEvents.map((event) => ({ kind: 'queue', created_at: event.created_at, payload: event })),
    ].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));

    const sessions = [];
    const gapMs = 6 * 60 * 60 * 1000;
    let current = null;

    for (const entry of timeline) {
      const timestamp = new Date(entry.created_at || '').getTime();
      if (!current || Number.isNaN(timestamp) || (current.last_timestamp != null && timestamp - current.last_timestamp > gapMs)) {
        current = {
          first_timestamp: timestamp,
          last_timestamp: timestamp,
          audit_events: [],
          queue_events: [],
        };
        sessions.push(current);
      }
      current.last_timestamp = Number.isNaN(timestamp) ? current.last_timestamp : timestamp;
      if (entry.kind === 'audit') current.audit_events.push(entry.payload);
      else current.queue_events.push(entry.payload);
    }

    const normalizedSearch = String(search || '').trim().toLowerCase();
    const history = sessions.map((session, index) => {
      const startedAt = session.audit_events[0]?.created_at || session.queue_events[0]?.created_at || null;
      const endedAt = [...session.audit_events, ...session.queue_events]
        .map((event) => event.created_at || null)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] || startedAt;
      const summary = summarizeSessionWindow(session.audit_events, session.queue_events, {
        hours: null,
        retentionDays,
      });
      const highlights = buildSessionHighlights(session.audit_events, session.queue_events);
      const narrative = highlights.length > 0
        ? `${summary.narrative} Highlights: ${highlights.join('; ')}.`
        : summary.narrative;
      const searchBlob = [
        narrative,
        summary.merge_confidence,
        ...session.audit_events.map((event) => [event.event_type, event.task_id, event.reason_code, event.details].filter(Boolean).join(' ')),
        ...session.queue_events.map((event) => [event.event_type, event.status, event.details, event.item?.source_ref].filter(Boolean).join(' ')),
      ].join(' ').toLowerCase();
      return {
        id: `session-${String(index + 1).padStart(3, '0')}`,
        started_at: startedAt,
        ended_at: endedAt,
        audit_event_count: session.audit_events.length,
        queue_event_count: session.queue_events.length,
        metrics: summary.metrics,
        merge_confidence: summary.merge_confidence,
        narrative,
        highlights,
        estimated_minutes_saved: summary.estimated_minutes_saved,
        matched_search: normalizedSearch ? searchBlob.includes(normalizedSearch) : true,
      };
    }).filter((session) => session.matched_search)
      .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));

    return {
      generated_at: new Date().toISOString(),
      repo_root: repoRoot,
      retention_days: retentionDays,
      days_analyzed: effectiveDays,
      search: normalizedSearch || null,
      sessions: history,
    };
  } finally {
    db.close();
  }
}

export function buildTeamReviewShareReport(events = []) {
  return events
    .map((event) => {
      const shared = event.payload?.review || {};
      return {
        user_id: event.user_id || null,
        email: event.payload?.email || 'unknown teammate',
        worktree: event.worktree || null,
        shared_at: event.created_at || event.payload?.synced_at || null,
        merge_confidence: shared.merge_confidence || 'uncertain',
        hours: shared.hours || null,
        metrics: shared.metrics || {},
        narrative: shared.narrative || 'No shared review narrative available.',
      };
    })
    .sort((a, b) =>
      String(b.shared_at || '').localeCompare(String(a.shared_at || ''))
      || String(a.email).localeCompare(String(b.email)));
}

function normalizeInsightKey(value) {
  return String(value || '').trim();
}

function pushInsight(map, {
  key,
  kind,
  label = null,
  severity = 'warn',
  createdAt = null,
  source = null,
}) {
  const normalizedKey = normalizeInsightKey(key);
  if (!normalizedKey) return;
  const compositeKey = `${kind}:${normalizedKey}`;
  const existing = map.get(compositeKey) || {
    key: normalizedKey,
    kind,
    label: label || normalizedKey,
    observations: 0,
    warn_count: 0,
    blocked_count: 0,
    uncertain_count: 0,
    sources: new Set(),
    last_seen: null,
    score: 0,
  };
  existing.observations += 1;
  if (severity === 'blocked') existing.blocked_count += 1;
  else if (severity === 'uncertain') existing.uncertain_count += 1;
  else existing.warn_count += 1;
  if (createdAt && (!existing.last_seen || String(createdAt) > String(existing.last_seen))) {
    existing.last_seen = createdAt;
  }
  if (source) existing.sources.add(source);
  existing.score = (existing.blocked_count * 4) + (existing.uncertain_count * 3) + (existing.warn_count * 2);
  map.set(compositeKey, existing);
}

function finalizeInsights(map) {
  return [...map.values()]
    .map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      label: entry.label,
      observations: entry.observations,
      warn_count: entry.warn_count,
      blocked_count: entry.blocked_count,
      uncertain_count: entry.uncertain_count,
      score: entry.score,
      last_seen: entry.last_seen,
      sources: [...entry.sources].sort(),
    }))
    .sort((a, b) =>
      b.score - a.score
      || b.observations - a.observations
      || String(b.last_seen || '').localeCompare(String(a.last_seen || ''))
      || String(a.label).localeCompare(String(b.label)));
}

export async function buildInsightsReport(repoRoot, { days = 90 } = {}) {
  const db = openDb(repoRoot);
  try {
    const retentionDays = await getRetentionDaysForCurrentPlan();
    const effectiveDays = Math.max(1, Math.min(Number.parseInt(days, 10) || 90, retentionDays));
    const since = Date.now() - effectiveDays * 24 * 60 * 60 * 1000;
    const isRecent = (isoString) => {
      const timestamp = new Date(isoString || '').getTime();
      return !Number.isNaN(timestamp) && timestamp >= since;
    };

    const auditEvents = listAuditEvents(db, { limit: 5000 }).filter((event) => isRecent(event.created_at));
    const aiGateEvents = auditEvents.filter((event) => event.event_type === 'ai_merge_gate');
    const invalidationEvents = auditEvents.filter((event) => event.event_type === 'dependency_invalidations_updated');
    const boundaryEvents = auditEvents.filter((event) => event.event_type === 'boundary_validation_state' && event.status !== 'allowed');

    const hotspots = new Map();
    const signalCounts = {
      ai_gate_warn: 0,
      ai_gate_blocked: 0,
      ai_gate_uncertain: 0,
      dependency_invalidations: invalidationEvents.length,
      boundary_validation_pending: boundaryEvents.length,
    };

    for (const event of aiGateEvents) {
      const details = parseEventDetails(event.details);
      const status = details.status || (event.status === 'denied' ? 'blocked' : event.status === 'warn' ? 'warn' : 'pass');
      if (status === 'warn') signalCounts.ai_gate_warn += 1;
      if (status === 'blocked') signalCounts.ai_gate_blocked += 1;
      if (status === 'uncertain') signalCounts.ai_gate_uncertain += 1;
      if (!['warn', 'blocked', 'uncertain'].includes(status)) continue;

      for (const area of details.shared_areas || []) {
        const label = typeof area === 'string' ? area : area?.name;
        pushInsight(hotspots, {
          key: label,
          kind: 'area',
          label,
          severity: status,
          createdAt: event.created_at,
          source: 'ai_merge_gate',
        });
      }

      for (const tag of details.shared_risk_tags || []) {
        const label = typeof tag === 'string' ? tag : tag?.name;
        pushInsight(hotspots, {
          key: label,
          kind: 'risk_tag',
          label,
          severity: status,
          createdAt: event.created_at,
          source: 'ai_merge_gate',
        });
      }
    }

    for (const event of invalidationEvents) {
      const details = parseEventDetails(event.details);
      for (const reasonType of details.reason_types || []) {
        pushInsight(hotspots, {
          key: reasonType,
          kind: 'reason_type',
          label: reasonType.replace(/_/g, ' '),
          severity: 'warn',
          createdAt: event.created_at,
          source: 'dependency_invalidations_updated',
        });
      }
      for (const revalidationSet of details.revalidation_sets || []) {
        pushInsight(hotspots, {
          key: revalidationSet,
          kind: 'revalidation_set',
          label: revalidationSet.replace(/_/g, ' '),
          severity: 'warn',
          createdAt: event.created_at,
          source: 'dependency_invalidations_updated',
        });
      }
    }

    for (const event of boundaryEvents) {
      const details = parseEventDetails(event.details);
      const severity = event.status === 'denied' ? 'blocked' : 'warn';
      for (const missingTaskType of details.missing_task_types || []) {
        pushInsight(hotspots, {
          key: missingTaskType,
          kind: 'validation_gap',
          label: missingTaskType,
          severity,
          createdAt: event.created_at,
          source: 'boundary_validation_state',
        });
      }
    }

    const recurringHotspots = finalizeInsights(hotspots).slice(0, 8);
    const recommendation = recurringHotspots[0]
      ? recurringHotspots[0].kind === 'area'
        ? `Tasks touching ${recurringHotspots[0].label} keep surfacing amber-or-worse review signals. Split that area more narrowly or serialize work there.`
        : recurringHotspots[0].kind === 'risk_tag'
          ? `${recurringHotspots[0].label} work keeps surfacing amber-or-worse review signals. Add stronger validation or smaller task boundaries there.`
          : `${recurringHotspots[0].label} keeps recurring in review signals. Tighten the task structure or follow-up validation around it.`
      : 'No recurring amber patterns detected yet.';

    return {
      generated_at: new Date().toISOString(),
      repo_root: repoRoot,
      retention_days: retentionDays,
      days_analyzed: effectiveDays,
      event_counts: {
        audit_events: auditEvents.length,
        ai_merge_gate_events: aiGateEvents.length,
        dependency_invalidation_events: invalidationEvents.length,
        boundary_validation_events: boundaryEvents.length,
      },
      signal_counts: signalCounts,
      recurring_hotspots: recurringHotspots,
      recommendation,
      depth_hint: retentionDays <= FREE_RETENTION_DAYS
        ? {
          title: 'Log in free to see the full issue breakdown',
          command: 'switchman login',
          detail: 'Free login unlocks amber / red issue detail and extends history to 14 days.',
        }
        : retentionDays <= FREE_LOGGED_IN_RETENTION_DAYS
          ? {
            title: 'Want deeper pattern detection?',
            command: 'switchman upgrade',
            detail: 'Pro extends the history window so recurring repo patterns have more time to become obvious.',
          }
          : null,
    };
  } finally {
    db.close();
  }
}

export async function buildUsageReport(repoRoot, {
  days = 90,
  sessionId = null,
  agent = null,
  taskId = null,
} = {}) {
  const db = openDb(repoRoot);
  try {
    const retentionDays = await getRetentionDaysForCurrentPlan();
    const effectiveDays = Math.max(1, Math.min(Number.parseInt(days, 10) || 90, retentionDays));
    pruneDatabaseMaintenance(db, { retentionDays });
    const events = listUsageEvents(db, {
      days: effectiveDays,
      sessionId,
      agent,
      taskId,
      limit: 5000,
    });

    const sessionMap = new Map();
    const agentMap = new Map();
    const modelMap = new Map();
    const providerMap = new Map();
    const totals = {
      events: events.length,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };

    for (const event of events) {
      totals.prompt_tokens += Number(event.prompt_tokens || 0);
      totals.completion_tokens += Number(event.completion_tokens || 0);
      totals.total_tokens += Number(event.total_tokens || 0);
      totals.cost_usd += Number(event.cost_usd || 0);

      const sessionKey = event.session_id || 'standalone';
      if (!sessionMap.has(sessionKey)) {
        sessionMap.set(sessionKey, {
          session_id: sessionKey,
          event_count: 0,
          task_ids: new Set(),
          agents: new Set(),
          worktrees: new Set(),
          models: new Set(),
          providers: new Set(),
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          first_seen_at: event.created_at,
          last_seen_at: event.created_at,
        });
      }
      const sessionEntry = sessionMap.get(sessionKey);
      sessionEntry.event_count += 1;
      if (event.task_id) sessionEntry.task_ids.add(event.task_id);
      if (event.agent) sessionEntry.agents.add(event.agent);
      if (event.worktree) sessionEntry.worktrees.add(event.worktree);
      if (event.model) sessionEntry.models.add(event.model);
      if (event.provider) sessionEntry.providers.add(event.provider);
      sessionEntry.prompt_tokens += Number(event.prompt_tokens || 0);
      sessionEntry.completion_tokens += Number(event.completion_tokens || 0);
      sessionEntry.total_tokens += Number(event.total_tokens || 0);
      sessionEntry.cost_usd += Number(event.cost_usd || 0);
      if (String(event.created_at || '') < String(sessionEntry.first_seen_at || '')) sessionEntry.first_seen_at = event.created_at;
      if (String(event.created_at || '') > String(sessionEntry.last_seen_at || '')) sessionEntry.last_seen_at = event.created_at;

      const agentKey = event.agent || 'unknown';
      if (!agentMap.has(agentKey)) {
        agentMap.set(agentKey, {
          agent: agentKey,
          event_count: 0,
          sessions: new Set(),
          task_ids: new Set(),
          models: new Set(),
          total_tokens: 0,
          cost_usd: 0,
          last_seen_at: event.created_at,
        });
      }
      const agentEntry = agentMap.get(agentKey);
      agentEntry.event_count += 1;
      agentEntry.sessions.add(sessionKey);
      if (event.task_id) agentEntry.task_ids.add(event.task_id);
      if (event.model) agentEntry.models.add(event.model);
      agentEntry.total_tokens += Number(event.total_tokens || 0);
      agentEntry.cost_usd += Number(event.cost_usd || 0);
      if (String(event.created_at || '') > String(agentEntry.last_seen_at || '')) agentEntry.last_seen_at = event.created_at;

      const modelKey = event.model || 'unknown';
      if (!modelMap.has(modelKey)) {
        modelMap.set(modelKey, {
          model: modelKey,
          event_count: 0,
          total_tokens: 0,
          cost_usd: 0,
        });
      }
      const modelEntry = modelMap.get(modelKey);
      modelEntry.event_count += 1;
      modelEntry.total_tokens += Number(event.total_tokens || 0);
      modelEntry.cost_usd += Number(event.cost_usd || 0);

      const providerKey = event.provider || 'unknown';
      if (!providerMap.has(providerKey)) {
        providerMap.set(providerKey, {
          provider: providerKey,
          event_count: 0,
          total_tokens: 0,
          cost_usd: 0,
        });
      }
      const providerEntry = providerMap.get(providerKey);
      providerEntry.event_count += 1;
      providerEntry.total_tokens += Number(event.total_tokens || 0);
      providerEntry.cost_usd += Number(event.cost_usd || 0);
    }

    return {
      generated_at: new Date().toISOString(),
      repo_root: repoRoot,
      retention_days: retentionDays,
      days_analyzed: effectiveDays,
      filters: {
        session_id: sessionId || null,
        agent: agent || null,
        task_id: taskId || null,
      },
      totals: {
        ...totals,
        tracked_sessions: sessionMap.size,
        tracked_agents: agentMap.size,
        tracked_models: modelMap.size,
      },
      sessions: [...sessionMap.values()]
        .map((entry) => ({
          ...entry,
          task_ids: [...entry.task_ids].sort(),
          agents: [...entry.agents].sort(),
          worktrees: [...entry.worktrees].sort(),
          models: [...entry.models].sort(),
          providers: [...entry.providers].sort(),
          cost_usd: Number(entry.cost_usd.toFixed(6)),
        }))
        .sort((a, b) =>
          b.total_tokens - a.total_tokens
          || b.cost_usd - a.cost_usd
          || String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || ''))),
      agents: [...agentMap.values()]
        .map((entry) => ({
          ...entry,
          sessions: [...entry.sessions].sort(),
          task_ids: [...entry.task_ids].sort(),
          models: [...entry.models].sort(),
          cost_usd: Number(entry.cost_usd.toFixed(6)),
        }))
        .sort((a, b) =>
          b.total_tokens - a.total_tokens
          || b.cost_usd - a.cost_usd
          || String(a.agent).localeCompare(String(b.agent))),
      models: [...modelMap.values()]
        .map((entry) => ({
          ...entry,
          cost_usd: Number(entry.cost_usd.toFixed(6)),
        }))
        .sort((a, b) =>
          b.total_tokens - a.total_tokens
          || b.cost_usd - a.cost_usd
          || String(a.model).localeCompare(String(b.model))),
      providers: [...providerMap.values()]
        .map((entry) => ({
          ...entry,
          cost_usd: Number(entry.cost_usd.toFixed(6)),
        }))
        .sort((a, b) =>
          b.total_tokens - a.total_tokens
          || b.cost_usd - a.cost_usd
          || String(a.provider).localeCompare(String(b.provider))),
      recent_events: events.slice(0, 12).map((event) => ({
        ...event,
        cost_usd: Number(Number(event.cost_usd || 0).toFixed(6)),
      })),
    };
  } finally {
    db.close();
  }
}

export function summarizeTeamCoordinationState(events = [], myUserId = null) {
  const visibleEvents = events.filter((event) => event.user_id !== myUserId);
  if (visibleEvents.length === 0) {
    return {
      members: 0,
      queue_events: 0,
      lease_events: 0,
      claim_events: 0,
      latest_queue_event: null,
    };
  }

  const activeMembers = new Set(visibleEvents.map((event) => event.user_id || `${event.payload?.email || 'unknown'}:${event.worktree || 'unknown'}`));
  const queueEvents = visibleEvents.filter((event) => ['queue_added', 'queue_merged', 'queue_blocked'].includes(event.event_type));
  const leaseEvents = visibleEvents.filter((event) => ['lease_acquired', 'task_done', 'task_failed', 'task_retried'].includes(event.event_type));
  const claimEvents = visibleEvents.filter((event) => ['claim_added', 'claim_released'].includes(event.event_type));

  return {
    members: activeMembers.size,
    queue_events: queueEvents.length,
    lease_events: leaseEvents.length,
    claim_events: claimEvents.length,
    latest_queue_event: queueEvents[0] || null,
  };
}

export function renderUnifiedStatusReport(report, { teamActivity = [], teamSummary = null } = {}) {
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
  console.log(chalk.dim(`history retention: ${report.retention_days || 7} days`));
  if (report.shared_summary?.mode === 'shared') {
    console.log(chalk.dim(`coordination source: shared team queue • ${report.shared_summary.team_id || 'team'} • ${report.shared_summary.repo_key || 'repo'}`));
  }
  if ((report.sync_state?.pending || 0) > 0) {
    const retryNote = report.sync_state.next_retry_at
      ? ` • next retry ${report.sync_state.next_retry_at}`
      : '';
    console.log(chalk.yellow(`shared sync buffered locally: ${report.sync_state.pending} event(s) pending${retryNote}`));
  }
  if (report.merge_readiness.policy_state?.active) {
    console.log(chalk.dim(`change policy: ${report.merge_readiness.policy_state.domains.join(', ')} • ${report.merge_readiness.policy_state.enforcement} • missing ${report.merge_readiness.policy_state.missing_task_types.join(', ') || 'none'}`));
  }

  // ── Team activity (Pro cloud sync) ──────────────────────────────────────────
  if (teamSummary && teamSummary.members > 0) {
    console.log('');
    console.log(chalk.bold('Shared cloud state:'));
    console.log(`  ${chalk.dim('members:')} ${teamSummary.members}  ${chalk.dim('leases:')} ${teamSummary.lease_events}  ${chalk.dim('claims:')} ${teamSummary.claim_events}  ${chalk.dim('queue:')} ${teamSummary.queue_events}`);
    if (teamSummary.latest_queue_event) {
      console.log(`  ${chalk.dim('latest queue event:')} ${chalk.cyan(teamSummary.latest_queue_event.event_type)} ${chalk.dim(teamSummary.latest_queue_event.payload?.source_ref || teamSummary.latest_queue_event.payload?.item_id || '')}`.trim());
    }
  }
  if (teamActivity.length > 0) {
    console.log('');
    console.log(chalk.bold('Team activity:'));
    for (const member of teamActivity) {
      const email = member.payload?.email ?? chalk.dim(member.user_id?.slice(0, 8) ?? 'unknown');
      const worktree = chalk.cyan(member.worktree ?? 'unknown');
      const eventLabel = {
        task_added:     'added a task',
        task_done:      'completed a task',
        task_failed:    'failed a task',
        task_retried:   'retried a task',
        lease_acquired: `working on: ${chalk.dim(member.payload?.title ?? '')}`,
        claim_added:    `claimed ${chalk.dim(member.payload?.file_count ?? 0)} file(s)`,
        claim_released: 'released file claims',
        queue_added:    `queued ${chalk.dim(member.payload?.source_ref ?? member.payload?.item_id ?? 'work')}`,
        queue_merged:   `landed ${chalk.dim(member.payload?.source_ref ?? member.payload?.item_id ?? 'work')}`,
        queue_blocked:  `blocked ${chalk.dim(member.payload?.source_ref ?? member.payload?.item_id ?? 'work')}`,
        status_ping:    'active',
      }[member.event_type] ?? member.event_type;
      console.log(`  ${chalk.dim('○')} ${email} · ${worktree} · ${eventLabel}`);
    }
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

function summarizeTickerEvent(report, teamActivity = []) {
  const newestTeamEvent = teamActivity[0];
  if (newestTeamEvent) {
    const email = newestTeamEvent.payload?.email || newestTeamEvent.email || newestTeamEvent.user_id || 'teammate';
    const worktree = newestTeamEvent.worktree || newestTeamEvent.payload?.worktree || 'shared queue';
    return `${email} ${worktree} ${fallbackEventLabel(newestTeamEvent.event_type || 'activity').toLowerCase()}`;
  }

  const recentQueueEvent = report.queue?.recent_events?.[0];
  if (recentQueueEvent) {
    return `queue ${recentQueueEvent.queue_item_id} ${fallbackEventLabel(recentQueueEvent.event_type || 'updated').toLowerCase()}`;
  }

  const blockedItem = report.attention?.find((item) => item.severity === 'block');
  if (blockedItem) {
    return blockedItem.title;
  }

  const warningItem = report.attention?.find((item) => item.severity !== 'block');
  if (warningItem) {
    return warningItem.title;
  }

  const activeItem = report.active_work?.[0];
  if (activeItem) {
    return `${activeItem.worktree} is running ${activeItem.task_title}`;
  }

  return 'Watching for new work, conflicts, and queue movement.';
}

export function renderLiveWatchDashboard(report, {
  teamActivity = [],
  teamSummary = null,
  watchState = null,
  updatedAt = null,
  cycles = 0,
  maxCycles = 0,
  watchIntervalMs = 2000,
} = {}) {
  const healthColor = colorForHealth(report.health);
  const badge = healthColor(healthLabel(report.health));
  const queueCounts = report.counts.queue || {
    queued: 0,
    retrying: 0,
    blocked: 0,
    merging: 0,
    merged: 0,
  };
  const blockedItems = report.attention.filter((item) => item.severity === 'block');
  const warningItems = report.attention.filter((item) => item.severity !== 'block');
  const queueLoad = queueCounts.queued + queueCounts.retrying + queueCounts.blocked + queueCounts.merging;
  const syncPending = Number(report.sync_state?.pending || 0);
  const teamMembers = Number(teamSummary?.members || 0);
  const focusItem = blockedItems[0] || warningItems[0] || report.next_up[0] || null;
  const focusLine = focusItem
    ? ('command' in focusItem
      ? `${focusItem.title}${focusItem.detail ? ` ${chalk.dim(`• ${focusItem.detail}`)}` : ''}`
      : `${focusItem.title} ${chalk.dim(`(${focusItem.id})`)}`)
    : report.counts.pending === 0 && report.counts.in_progress === 0
      ? 'Nothing active yet. Safe to add work or run the demo.'
      : 'Nothing urgent. Safe to keep work moving.';
  const primaryCommand = ('command' in (focusItem || {}) && focusItem?.command)
    ? focusItem.command
    : report.suggested_commands[0] || 'switchman status';
  const sourceLine = report.shared_summary?.mode === 'shared'
    ? `shared team queue • ${report.shared_summary.team_id || 'team'} • ${report.shared_summary.repo_key || 'repo'}`
    : 'local coordination only';
  const watcherLine = [
    updatedAt ? `updated ${updatedAt}` : 'updated just now',
    watchState || 'baseline snapshot',
    maxCycles > 0 ? `cycle ${cycles}/${maxCycles}` : null,
    `refresh ${watchIntervalMs}ms`,
  ].filter(Boolean).join(' • ');

  const agentLines = report.active_work.length > 0
    ? report.active_work.slice(0, 6).map((item) => {
      const worktreeClaims = report.claims.filter((claim) => claim.worktree === item.worktree);
      const claimedFiles = worktreeClaims
        .slice(0, 2)
        .map((claim) => claim.file_path);
      const lastSeenMinutes = item.heartbeat_at
        ? Math.max(0, Math.round((Date.now() - new Date(item.heartbeat_at).getTime()) / 60000))
        : null;
      const claimSuffix = claimedFiles.length > 0
        ? ` ${chalk.dim(`claims ${claimedFiles.join(', ')}${worktreeClaims.length > 2 ? ' +' : ''}`)}`
        : '';
      const boundary = item.boundary_validation
        ? ` ${renderChip('validation', item.boundary_validation.status, item.boundary_validation.status === 'accepted' ? chalk.green : chalk.yellow)}`
        : '';
      const stale = (item.dependency_invalidations?.length || 0) > 0
        ? ` ${renderChip('stale', item.dependency_invalidations.length, chalk.yellow)}`
        : '';
      const scope = item.scope_summary ? ` ${chalk.dim(item.scope_summary)}` : '';
      const age = lastSeenMinutes !== null
        ? ` ${chalk.dim(`seen ${lastSeenMinutes}m ago`)}`
        : '';
      return `${statusBadge('busy')} ${chalk.cyan(item.worktree)} ${chalk.dim('->')} ${item.task_title} ${chalk.dim(item.task_id)}${boundary}${stale}${scope}${age}${claimSuffix}`;
    })
    : [chalk.dim('No agent work is active right now.')];

  const focusLines = [
    `${chalk.bold('Attention now:')} ${focusLine}`,
    `${chalk.bold('Run next:')} ${chalk.cyan(primaryCommand)}`,
    ...(blockedItems.slice(0, 2).map((item) => `${renderChip('BLOCKED', item.kind || 'item', chalk.red)} ${item.title}${item.detail ? ` ${chalk.dim(`• ${item.detail}`)}` : ''}`)),
    ...(warningItems.slice(0, 2).map((item) => `${renderChip('WATCH', item.kind || 'item', chalk.yellow)} ${item.title}${item.detail ? ` ${chalk.dim(`• ${item.detail}`)}` : ''}`)),
    ...(report.next_up.slice(0, 2).map((task) => `${renderChip('NEXT', `p${task.priority}`, chalk.green)} ${task.title} ${chalk.dim(task.id)}`)),
  ];
  if (focusLines.length === 0) {
    focusLines.push(chalk.green('Nothing urgent. Safe to keep work moving.'));
  }

  const queueLines = [];
  if (report.queue?.summary?.next) {
    const next = report.queue.summary.next;
    queueLines.push(`${chalk.bold('Land next:')} ${renderChip('NEXT', next.id, chalk.blue)} ${next.source_type}:${next.source_ref} ${chalk.dim(`retries:${next.retry_count}/${next.max_retries}`)}`);
  }
  for (const item of report.queue.items.filter((entry) => ['blocked', 'retrying', 'merging'].includes(entry.status)).slice(0, 3)) {
    queueLines.push(`${renderChip(item.status.toUpperCase(), item.id, item.status === 'blocked' ? chalk.red : item.status === 'retrying' ? chalk.yellow : chalk.blue)} ${item.source_type}:${item.source_ref}${item.last_error_summary ? ` ${chalk.dim(`• ${item.last_error_summary}`)}` : ''}`);
  }
  if (queueLines.length === 0) {
    queueLines.push(chalk.dim('No active landing queue pressure.'));
  }

  const teamLines = [];
  if (teamMembers > 0) {
    teamLines.push(`${chalk.white(teamMembers)} teammate${teamMembers === 1 ? '' : 's'} active in shared coordination`);
  }
  if ((teamSummary?.queue_events || 0) > 0) {
    teamLines.push(`${chalk.white(teamSummary.queue_events)} recent queue event${teamSummary.queue_events === 1 ? '' : 's'}`);
  }
  if ((teamSummary?.lease_events || 0) > 0) {
    teamLines.push(`${chalk.white(teamSummary.lease_events)} recent lease / task handoff${teamSummary.lease_events === 1 ? '' : 's'}`);
  }
  if ((teamSummary?.claim_events || 0) > 0) {
    teamLines.push(`${chalk.white(teamSummary.claim_events)} recent claim change${teamSummary.claim_events === 1 ? '' : 's'}`);
  }
  if (teamLines.length === 0) {
    teamLines.push(chalk.dim('No remote team activity visible in this cycle.'));
  }

  console.log('');
  console.log(healthColor('='.repeat(72)));
  console.log(`${badge} ${chalk.bold('switchman live watch')} ${chalk.dim('• terminal dashboard for parallel agents')}`);
  console.log(chalk.dim(report.repo_root));
  console.log(chalk.dim(sourceLine));
  console.log(healthColor('='.repeat(72)));
  console.log(renderSignalStrip([
    renderChip('tasks', `${report.counts.pending}/${report.counts.in_progress}/${report.counts.done}/${report.counts.failed}`, chalk.white),
    renderChip('leases', report.counts.active_leases, report.counts.active_leases > 0 ? chalk.blue : chalk.green),
    renderChip('claims', report.counts.active_claims, report.counts.active_claims > 0 ? chalk.cyan : chalk.green),
    renderChip('queue', queueLoad, queueLoad > 0 ? chalk.blue : chalk.green),
    renderChip('sync', syncPending, syncPending > 0 ? chalk.yellow : chalk.green),
    renderChip('team', teamMembers, teamMembers > 0 ? chalk.cyan : chalk.green),
  ]));
  console.log(renderMetricRow([
    { label: 'health', value: healthLabel(report.health), color: healthColor },
    { label: 'blocked', value: blockedItems.length, color: blockedItems.length > 0 ? chalk.red : chalk.green },
    { label: 'warnings', value: warningItems.length, color: warningItems.length > 0 ? chalk.yellow : chalk.green },
    { label: 'history', value: `${report.retention_days || 7}d`, color: chalk.white },
  ]));
  console.log(`${chalk.bold('Summary:')} ${report.summary}`);
  console.log(chalk.dim(watcherLine));
  console.log('');

  const panelBlocks = [
    renderPanel('Agents', agentLines, report.active_work.length > 0 ? chalk.cyan : chalk.green),
    renderPanel('Focus', focusLines, blockedItems.length > 0 ? chalk.red : warningItems.length > 0 ? chalk.yellow : chalk.green),
    renderPanel('Queue', queueLines, queueCounts.blocked > 0 ? chalk.red : queueLoad > 0 ? chalk.blue : chalk.green),
    renderPanel('Team + sync', [
      ...teamLines,
      syncPending > 0
        ? `${chalk.yellow('buffered sync:')} ${syncPending} event(s) waiting to flush`
        : chalk.green('Cloud sync is current.'),
    ], syncPending > 0 ? chalk.yellow : chalk.green),
  ];

  for (const block of panelBlocks) {
    for (const line of block) console.log(line);
    console.log('');
  }

  console.log(`${chalk.bold('Last event:')} ${summarizeTickerEvent(report, teamActivity)}`);
  if (report.failed_tasks.length > 0) {
    const failure = report.failed_tasks[0];
    console.log(`${chalk.bold('Latest failure:')} ${failure.title} ${chalk.dim(`(${humanizeReasonCode(failure.failure?.reason?.code || failure.failure?.reason_code || '') || failure.failure?.summary || 'unknown'})`)}`);
  }
  console.log(`${chalk.bold('Run next:')} ${chalk.cyan(report.suggested_commands[0] || 'switchman status')}`);
}