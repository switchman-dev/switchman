import { finishOperationJournalEntry, getMergeQueueItem, getTaskSpec, listDependencyInvalidations, listMergeQueue, listTasks, listWorktrees, markMergeQueueState, startMergeQueueItem, startOperationJournalEntry } from './db.js';
import { gitAssessBranchFreshness, gitBranchExists, gitMergeBranchInto, gitRebaseOnto } from './git.js';
import { runAiMergeGate } from './merge-gate.js';
import { evaluatePipelinePolicyGate, getPipelineStaleWaveContext, preparePipelineLandingTarget } from './pipeline.js';
import { scanAllWorktrees } from './detector.js';

const QUEUE_RETRY_BACKOFF_BASE_MS = 30_000;
const QUEUE_RETRY_BACKOFF_MAX_MS = 5 * 60_000;

function formatQueueTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function isQueueBackoffActive(item) {
  const raw = item?.backoff_until;
  if (!raw) return false;
  const timestamp = Date.parse(String(raw));
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function computeQueueRetryBackoff(item) {
  const retriesUsed = Number(item?.retry_count || 0);
  const delayMs = Math.min(QUEUE_RETRY_BACKOFF_MAX_MS, QUEUE_RETRY_BACKOFF_BASE_MS * (2 ** retriesUsed));
  const backoffUntil = new Date(Date.now() + delayMs).toISOString();
  return {
    delay_ms: delayMs,
    backoff_until: backoffUntil,
  };
}

export function describeQueueError(err) {
  const message = String(err?.stderr || err?.message || err || '').trim();
  if (/conflict/i.test(message)) {
    return {
      code: 'merge_conflict',
      summary: message || 'Merge conflict blocked queue item.',
      nextAction: 'Resolve the branch conflict manually, then run `switchman queue retry <itemId>`.',
      retryable: true,
    };
  }

  if (/not a valid object name|pathspec|did not match any file/i.test(message)) {
    return {
      code: 'source_missing',
      summary: message || 'The queued source branch no longer exists.',
      nextAction: 'Recreate the source branch or remove the queue item.',
      retryable: false,
    };
  }

  if (/untracked working tree files would be overwritten by merge/i.test(message)) {
    return {
      code: 'untracked_worktree_files',
      summary: message || 'Untracked local files would be overwritten by merge.',
      nextAction: 'Remove or ignore the untracked files in the target worktree, then run `switchman queue retry <itemId>`. Project-local MCP files should be excluded via `.git/info/exclude` after `switchman setup`.',
      retryable: true,
    };
  }

  return {
    code: 'merge_failed',
    summary: message || 'Merge queue item failed.',
    nextAction: 'Inspect the branch state, then retry or remove the queue item.',
    retryable: true,
  };
}

function scheduleRetryOrBlock(db, item, failure) {
  const retriesUsed = Number(item.retry_count || 0);
  const maxRetries = Number(item.max_retries || 0);
  if (failure.retryable && retriesUsed < maxRetries) {
    const backoff = computeQueueRetryBackoff(item);
    return {
      status: 'retrying',
      item: markMergeQueueState(db, item.id, {
        status: 'retrying',
        lastErrorCode: failure.code,
        lastErrorSummary: failure.summary,
        nextAction: `Retry ${retriesUsed + 1} of ${maxRetries} is waiting until ${backoff.backoff_until}. Run \`switchman queue retry ${item.id}\` to retry sooner after fixing any underlying branch drift.`,
        incrementRetry: true,
        backoffUntil: backoff.backoff_until,
      }),
    };
  }

  return {
    status: 'blocked',
    item: markMergeQueueState(db, item.id, {
      status: 'blocked',
      lastErrorCode: failure.code,
      lastErrorSummary: failure.summary,
      nextAction: failure.nextAction.replace('<itemId>', item.id),
    }),
  };
}

export async function evaluateQueueRepoGate(db, repoRoot) {
  const report = await scanAllWorktrees(db, repoRoot);
  const aiGate = await runAiMergeGate(db, repoRoot);
  const ok = report.conflicts.length === 0
    && report.fileConflicts.length === 0
    && (report.ownershipConflicts?.length || 0) === 0
    && (report.semanticConflicts?.length || 0) === 0
    && report.unclaimedChanges.length === 0
    && report.complianceSummary.non_compliant === 0
    && report.complianceSummary.stale === 0
    && aiGate.status !== 'blocked'
    && (aiGate.dependency_invalidations?.filter((item) => item.severity === 'blocked').length || 0) === 0;

  return {
    ok,
    summary: ok
      ? `Repo gate passed for ${report.worktrees.length} worktree(s).`
      : 'Repo gate rejected unmanaged changes, stale leases, ownership conflicts, stale dependency invalidations, or boundary validation failures.',
    report,
    aiGate,
  };
}

export function resolveQueueSource(db, repoRoot, item) {
  if (!item) {
    throw new Error('Queue item is required.');
  }

  if (item.source_type === 'branch') {
    const worktree = listWorktrees(db).find((entry) =>
      (item.source_worktree && entry.name === item.source_worktree)
      || entry.branch === item.source_ref);
    return {
      branch: item.source_ref,
      worktree: worktree?.name || item.source_worktree || null,
      worktree_path: worktree?.path || null,
      pipeline_id: item.source_pipeline_id || null,
    };
  }

  if (item.source_type === 'worktree') {
    const worktree = listWorktrees(db).find((entry) => entry.name === item.source_worktree || entry.name === item.source_ref);
    if (!worktree) {
      throw new Error(`Queued worktree ${item.source_worktree || item.source_ref} is not registered.`);
    }
    return {
      branch: worktree.branch,
      worktree: worktree.name,
      worktree_path: worktree.path,
      pipeline_id: item.source_pipeline_id || null,
    };
  }

  if (item.source_type === 'pipeline') {
    const pipelineId = item.source_pipeline_id || item.source_ref;
    const landingTarget = preparePipelineLandingTarget(db, repoRoot, pipelineId, {
      baseBranch: item.target_branch || 'main',
      requireCompleted: true,
      allowCurrentBranchFallback: false,
    });
    const worktree = landingTarget.worktree
      ? listWorktrees(db).find((entry) => entry.name === landingTarget.worktree) || null
      : null;

    return {
      branch: landingTarget.branch,
      worktree: worktree?.name || null,
      worktree_path: worktree?.path || null,
      pipeline_id: pipelineId,
    };
  }

  throw new Error(`Unsupported queue source type: ${item.source_type}`);
}

export function inferQueueNextAction(item) {
  if (!item) return null;
  if (item.status === 'blocked' && item.next_action) return item.next_action;
  if (item.status === 'merged') return 'No action needed.';
  return null;
}

function summarizeQueueGoalContext(db, item) {
  const pipelineId = item.source_pipeline_id || (item.source_type === 'pipeline' ? item.source_ref : null);
  if (!db || !pipelineId) {
    return {
      pipeline_id: pipelineId,
      goal_priority: null,
      goal_title: null,
      integration_risk: 'normal',
      task_count: 0,
    };
  }

  const pipelineTasks = listTasks(db)
    .map((task) => ({ ...task, task_spec: getTaskSpec(db, task.id) }))
    .filter((task) => task.task_spec?.pipeline_id === pipelineId);
  const goalPriority = pipelineTasks.reduce((highest, task) => Math.max(highest, Number(task.priority || 0)), 0) || null;
  const goalTitle = pipelineTasks[0]?.title || pipelineId;
  const riskLevels = new Set(pipelineTasks.map((task) => task.task_spec?.risk_level).filter(Boolean));
  const integrationRisk = riskLevels.has('high')
    ? 'high'
    : riskLevels.has('medium')
      ? 'medium'
      : 'normal';

  return {
    pipeline_id: pipelineId,
    goal_priority: goalPriority,
    goal_title: goalTitle,
    integration_risk: integrationRisk,
    task_count: pipelineTasks.length,
  };
}

function assessQueueCandidate(db, repoRoot, item) {
  if (!db || !repoRoot || !['queued', 'retrying', 'held', 'wave_blocked', 'escalated'].includes(item.status)) {
    return {
      freshness: 'unknown',
      revalidation_state: 'unknown',
      stale_invalidation_count: 0,
      stale_severity: 'clear',
      branch_availability: 'unknown',
      goal_priority: null,
      integration_risk: 'normal',
      priority_score: 99,
      reason: item.status === 'retrying'
        ? 'retrying item waiting for another landing attempt'
        : item.status === 'held'
          ? 'held item waiting for a safe landing window'
          : item.status === 'wave_blocked'
            ? 'wave-blocked item waiting for coordinated revalidation across the same stale wave'
          : item.status === 'escalated'
            ? 'escalated item waiting for operator review'
        : 'queued item waiting to land',
    };
  }

  try {
    const resolved = resolveQueueSource(db, repoRoot, item);
    const sourceBranchExists = gitBranchExists(repoRoot, resolved.branch);
    const targetBranchExists = gitBranchExists(repoRoot, item.target_branch || 'main');
    if (!sourceBranchExists || !targetBranchExists) {
      return {
        freshness: 'unknown',
        revalidation_state: 'unknown',
        stale_invalidation_count: 0,
        stale_severity: 'clear',
        branch_availability: !sourceBranchExists ? 'source_missing' : 'target_missing',
        goal_priority: null,
        integration_risk: 'normal',
        priority_score: 50,
        reason: !sourceBranchExists
          ? 'source branch is missing, so landing should surface an explicit queue block'
          : 'target branch is missing, so landing should surface an explicit queue block',
      };
    }
    const freshness = gitAssessBranchFreshness(repoRoot, item.target_branch || 'main', resolved.branch);
    const goalContext = summarizeQueueGoalContext(db, item);
    const pipelineId = goalContext.pipeline_id;
    const staleInvalidations = pipelineId
      ? listDependencyInvalidations(db, { pipelineId }).filter((entry) => entry.affected_pipeline_id === pipelineId)
      : [];
    const staleWaveContext = pipelineId
      ? getPipelineStaleWaveContext(db, pipelineId)
      : { shared_wave_count: 0, largest_wave_size: 0, primary_wave: null };
    const statusWeight = item.status === 'queued' ? 0 : 1;
    const freshnessWeight = freshness.state === 'fresh' ? 0 : freshness.state === 'behind' ? 2 : 4;
    const urgencyWeight = goalContext.goal_priority >= 8 ? -2 : goalContext.goal_priority >= 6 ? -1 : 0;
    const staleSeverity = staleInvalidations.some((entry) => entry.severity === 'blocked')
      ? 'block'
      : staleInvalidations.length > 0
        ? 'warn'
        : 'clear';
    const revalidationWeight = staleSeverity === 'block' ? 6 : staleSeverity === 'warn' ? 3 : 0;
    const waveWeight = staleWaveContext.largest_wave_size >= 3 ? 3 : staleWaveContext.largest_wave_size >= 2 ? 2 : 0;
    const integrationWeight = goalContext.integration_risk === 'high' ? 1 : 0;
    const backoffWaiting = item.status === 'retrying' && isQueueBackoffActive(item);
    const backoffWeight = backoffWaiting ? 3 : 0;
    const freshnessReason = freshness.state === 'fresh'
      ? 'fresh branch is most likely to land cleanly next'
      : freshness.state === 'behind'
        ? `branch is behind ${item.target_branch || 'main'}, so fresher queue items land first`
        : 'freshness is unknown, so this item stays behind clearly fresher work';
    const urgencyReason = goalContext.goal_priority >= 8
      ? `goal priority ${goalContext.goal_priority} raises this landing candidate above lower-priority work`
      : goalContext.goal_priority >= 6
        ? `goal priority ${goalContext.goal_priority} gives this candidate a small landing preference`
        : null;
    const revalidationReason = staleSeverity === 'block'
      ? `pipeline ${pipelineId} has stale work to revalidate before it should land`
      : staleSeverity === 'warn'
        ? `pipeline ${pipelineId} has stale work to revalidate, so clearer landing candidates land first`
        : null;
    const waveReason = staleWaveContext.primary_wave && staleWaveContext.largest_wave_size > 1
      ? `the same stale wave also affects ${staleWaveContext.primary_wave.related_affected_pipelines.filter((entry) => entry !== pipelineId).join(', ')}`
      : null;
    const riskReason = goalContext.integration_risk === 'high'
      ? `pipeline ${pipelineId} carries high integration risk and may need escalation if it is not clearly ready`
      : goalContext.integration_risk === 'medium'
        ? `pipeline ${pipelineId} carries moderate integration risk`
        : null;
    const backoffReason = backoffWaiting
      ? `automatic retry backoff is active until ${formatQueueTimestamp(item.backoff_until)}`
      : null;
    return {
      freshness: freshness.state,
      revalidation_state: staleSeverity === 'clear' ? 'clear' : 'stale',
      stale_invalidation_count: staleInvalidations.length,
      stale_severity: staleSeverity,
      stale_wave_count: staleWaveContext.shared_wave_count,
      stale_wave_size: staleWaveContext.largest_wave_size,
      stale_wave_summary: staleWaveContext.primary_wave?.summary || null,
      branch_availability: 'ready',
      goal_priority: goalContext.goal_priority,
      goal_title: goalContext.goal_title,
      integration_risk: goalContext.integration_risk,
      priority_score: freshnessWeight + statusWeight + revalidationWeight + waveWeight + integrationWeight + urgencyWeight + backoffWeight,
      reason: [freshnessReason, urgencyReason, revalidationReason, waveReason, riskReason, backoffReason].filter(Boolean).join('; '),
      freshness_details: freshness,
      backoff_until: item.backoff_until || null,
      backoff_active: backoffWaiting,
      next_action: staleInvalidations.length > 0 && pipelineId
        ? `switchman task retry-stale --pipeline ${pipelineId}`
        : null,
    };
  } catch {
    return {
      freshness: 'unknown',
      revalidation_state: 'unknown',
      stale_invalidation_count: 0,
      stale_severity: 'clear',
      branch_availability: 'unknown',
      goal_priority: null,
      integration_risk: 'normal',
      priority_score: 60,
      reason: 'queue source could not be resolved cleanly yet',
    };
  }
}

function rankQueueItems(items, { db = null, repoRoot = null } = {}) {
  return items
    .filter((item) => ['queued', 'retrying', 'held', 'wave_blocked', 'escalated'].includes(item.status))
    .map((item) => ({
      ...item,
      queue_assessment: assessQueueCandidate(db, repoRoot, item),
    }))
    .sort((left, right) => {
      const scoreDelta = (left.queue_assessment?.priority_score ?? 99) - (right.queue_assessment?.priority_score ?? 99);
      if (scoreDelta !== 0) return scoreDelta;
      return String(left.created_at || '').localeCompare(String(right.created_at || ''));
    });
}

function annotateQueueCandidates(items, { db = null, repoRoot = null } = {}) {
  return rankQueueItems(items, { db, repoRoot }).map((item) => ({
    ...item,
    recommendation: recommendQueueAction(item),
  }));
}

function recommendQueueAction(item) {
  const assessment = item.queue_assessment || {};
  if (item.status === 'retrying') {
    if (assessment.backoff_active) {
      return {
        action: 'retry',
        summary: `wait for retry backoff until ${assessment.backoff_until}, or run \`switchman queue retry ${item.id}\` to retry sooner`,
        command: `switchman queue retry ${item.id}`,
      };
    }
    return {
      action: 'retry',
      summary: item.next_action || 'retry the item after the underlying landing issue is resolved',
      command: 'switchman queue run',
    };
  }

  if (item.status === 'held' && assessment.stale_invalidation_count > 0) {
    return {
      action: 'hold',
      summary: item.next_action || (assessment.stale_wave_size > 1
        ? `hold for coordinated revalidation: ${assessment.stale_wave_summary || 'the same stale wave'} affects ${assessment.stale_wave_size} goals`
        : assessment.next_action) || 'hold until the stale pipeline work is revalidated',
      command: assessment.next_action || 'switchman queue retry <itemId>',
    };
  }

  if (item.status === 'wave_blocked' && assessment.stale_invalidation_count > 0) {
    return {
      action: 'hold',
      summary: item.next_action || `hold for coordinated revalidation: ${assessment.stale_wave_summary || 'shared stale wave'} affects ${assessment.stale_wave_size} goals`,
      command: assessment.next_action || 'switchman queue status',
    };
  }

  if (item.status === 'escalated' && assessment.integration_risk === 'high' && (assessment.stale_invalidation_count > 0 || assessment.freshness !== 'fresh')) {
    return {
      action: 'escalate',
      summary: item.last_error_summary || 'escalate before landing: high-risk work is not clearly ready yet',
      command: item.next_action || `switchman explain queue ${item.id}`,
    };
  }

  if (assessment.branch_availability === 'source_missing' || assessment.branch_availability === 'target_missing') {
    return {
      action: 'retry',
      summary: assessment.branch_availability === 'source_missing'
        ? 'attempt landing so Switchman can block the missing source branch explicitly'
        : 'attempt landing so Switchman can block the missing target branch explicitly',
      command: 'switchman queue run',
    };
  }

  if (assessment.integration_risk === 'high' && (assessment.stale_invalidation_count > 0 || assessment.freshness !== 'fresh')) {
    return {
      action: 'escalate',
      summary: assessment.next_action
        ? `escalate before landing: high-risk work is not clearly ready and still needs ${assessment.next_action}`
        : 'escalate before landing: high-risk work is not clearly ready yet',
      command: `switchman explain queue ${item.id}`,
    };
  }

  if (assessment.stale_invalidation_count > 0) {
    return {
      action: 'hold',
      summary: assessment.stale_wave_size > 1
        ? `hold for coordinated revalidation first: ${assessment.stale_wave_summary || 'shared stale wave'} affects ${assessment.stale_wave_size} goals`
        : assessment.next_action
        ? `hold for revalidation first: ${assessment.next_action}`
        : 'hold until the stale pipeline work is revalidated',
      command: assessment.next_action || 'switchman queue status',
    };
  }

  if (assessment.freshness === 'behind') {
    return {
      action: 'hold',
      summary: `hold until fresher ${item.target_branch || 'main'} candidates land first`,
      command: 'switchman queue run',
    };
  }

  if (assessment.freshness === 'unknown') {
    return {
      action: 'hold',
      summary: 'hold until branch freshness can be resolved cleanly',
      command: 'switchman queue status',
    };
  }

  return {
    action: 'land_now',
    summary: assessment.integration_risk === 'high'
      ? 'land now with elevated integration attention: this is the clearest current high-risk merge candidate'
      : 'land now: this is the clearest current merge candidate',
    command: 'switchman queue run',
  };
}

function classifyQueuePlanLane(item) {
  const action = item.recommendation?.action || 'hold';
  const assessment = item.queue_assessment || {};

  if (action === 'escalate') {
    return {
      lane: 'escalate',
      summary: item.recommendation?.summary || 'needs operator review before it should land',
      command: item.recommendation?.command || `switchman explain queue ${item.id}`,
    };
  }

  if (action === 'retry') {
    if (assessment.backoff_active) {
      return {
        lane: 'prepare_next',
        summary: item.recommendation?.summary || 'wait for retry backoff, then retry this landing candidate',
        command: item.recommendation?.command || `switchman queue retry ${item.id}`,
      };
    }
    return {
      lane: 'prepare_next',
      summary: item.recommendation?.summary || 'retry this landing candidate once the immediate issue is cleared',
      command: item.recommendation?.command || 'switchman queue run',
    };
  }

  if (action === 'land_now') {
    return {
      lane: 'land_now',
      summary: item.recommendation?.summary || 'this is ready to land now',
      command: item.recommendation?.command || 'switchman queue run',
    };
  }

  if (assessment.stale_invalidation_count > 0) {
    return {
      lane: 'unblock_first',
      summary: item.recommendation?.summary || 'revalidate this goal before it can land',
      command: item.recommendation?.command || assessment.next_action || 'switchman queue status',
    };
  }

  if (assessment.freshness === 'behind' || assessment.freshness === 'unknown') {
    return {
      lane: 'defer',
      summary: item.recommendation?.summary || 'wait until fresher candidates land first',
      command: item.recommendation?.command || 'switchman queue run',
    };
  }

  return {
    lane: 'prepare_next',
    summary: item.recommendation?.summary || 'keep this candidate close behind the current landing focus',
    command: item.recommendation?.command || 'switchman queue status',
  };
}

function buildQueueGoalPlan(candidates = []) {
  const lanes = {
    land_now: [],
    prepare_next: [],
    unblock_first: [],
    escalate: [],
    defer: [],
  };

  for (const item of candidates) {
    const plan = classifyQueuePlanLane(item);
    lanes[plan.lane].push({
      item_id: item.id,
      source_ref: item.source_ref,
      source_type: item.source_type,
      pipeline_id: item.source_pipeline_id || null,
      goal_title: item.queue_assessment?.goal_title || null,
      goal_priority: item.queue_assessment?.goal_priority || null,
      action: item.recommendation?.action || 'hold',
      freshness: item.queue_assessment?.freshness || 'unknown',
      stale_invalidation_count: item.queue_assessment?.stale_invalidation_count || 0,
      integration_risk: item.queue_assessment?.integration_risk || 'normal',
      summary: plan.summary,
      command: plan.command,
    });
  }

  return lanes;
}

function buildQueueRecommendedSequence(candidates = [], limit = 5) {
  const ordered = [];
  const pushLane = (laneName, items, stage) => {
    for (const item of items) {
      if (ordered.length >= limit) return;
      ordered.push({
        stage,
        lane: laneName,
        item_id: item.item_id,
        source_ref: item.source_ref,
        source_type: item.source_type,
        pipeline_id: item.pipeline_id,
        goal_title: item.goal_title,
        goal_priority: item.goal_priority,
        action: item.action,
        summary: item.summary,
        command: item.command,
      });
    }
  };

  const plan = buildQueueGoalPlan(candidates);
  pushLane('land_now', plan.land_now, '1');
  pushLane('prepare_next', plan.prepare_next, '2');
  pushLane('unblock_first', plan.unblock_first, '3');
  pushLane('escalate', plan.escalate, '4');
  pushLane('defer', plan.defer, '5');
  return ordered;
}

function chooseNextQueueItem(items, { db = null, repoRoot = null } = {}) {
  const candidates = annotateQueueCandidates(items, { db, repoRoot });
  return candidates[0] || null;
}

function isQueueItemRunnable(item) {
  if (!item?.recommendation?.action) return false;
  if (item.recommendation.action === 'retry' && item.queue_assessment?.backoff_active) {
    return false;
  }
  return ['land_now', 'retry'].includes(item.recommendation.action);
}

function chooseRunnableQueueItem(items, { db = null, repoRoot = null, followPlan = false } = {}) {
  const candidates = annotateQueueCandidates(items, { db, repoRoot });
  if (followPlan) {
    return candidates.find((item) => classifyQueuePlanLane(item).lane === 'land_now' && isQueueItemRunnable(item)) || null;
  }
  return candidates.find((item) => isQueueItemRunnable(item))
    || candidates.find((item) =>
      item.recommendation?.action === 'hold'
      && item.queue_assessment?.stale_invalidation_count === 0
      && item.queue_assessment?.integration_risk !== 'high')
    || null;
}

function syncDeferredQueueState(db, item) {
  if (!item?.recommendation?.action || !['hold', 'escalate'].includes(item.recommendation.action)) {
    return item;
  }

  const desiredStatus = item.recommendation.action === 'hold'
    ? (item.queue_assessment?.stale_wave_size > 1 ? 'wave_blocked' : 'held')
    : 'escalated';
  const desiredNextAction = item.recommendation.action === 'escalate'
    ? `Run \`switchman explain queue ${item.id}\` to review the landing risk, then \`switchman queue retry ${item.id}\` when it is ready again.`
    : item.queue_assessment?.next_action || item.recommendation.command || null;
  const desiredSummary = item.recommendation.summary || item.queue_assessment?.reason || null;

  if (
    item.status === desiredStatus
    && (item.next_action || null) === desiredNextAction
    && (item.last_error_summary || null) === desiredSummary
  ) {
    return item;
  }

  return markMergeQueueState(db, item.id, {
    status: desiredStatus,
    lastErrorCode: desiredStatus === 'wave_blocked' ? 'queue_wave_blocked' : desiredStatus === 'held' ? 'queue_hold' : 'queue_escalated',
    lastErrorSummary: desiredSummary,
    nextAction: desiredNextAction,
  });
}

export function buildQueueStatusSummary(items, { db = null, repoRoot = null } = {}) {
  const rankedCandidates = annotateQueueCandidates(items, { db, repoRoot });
  const plan = buildQueueGoalPlan(rankedCandidates.slice(0, 8));
  const next = rankedCandidates[0]
    || items.find((item) => ['validating', 'rebasing', 'merging'].includes(item.status))
    || null;
  const counts = {
    queued: items.filter((item) => item.status === 'queued').length,
    validating: items.filter((item) => item.status === 'validating').length,
    rebasing: items.filter((item) => item.status === 'rebasing').length,
    merging: items.filter((item) => item.status === 'merging').length,
    retrying: items.filter((item) => item.status === 'retrying').length,
    held: items.filter((item) => item.status === 'held').length,
    wave_blocked: items.filter((item) => item.status === 'wave_blocked').length,
    escalated: items.filter((item) => item.status === 'escalated').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    merged: items.filter((item) => item.status === 'merged').length,
  };

  return {
    counts,
    next,
    blocked: items.filter((item) => item.status === 'blocked'),
    held_back: rankedCandidates.slice(1, 4),
    decision_summary: next?.queue_assessment?.reason || null,
    focus_decision: next?.recommendation || null,
    plan,
    recommended_sequence: buildQueueRecommendedSequence(rankedCandidates.slice(0, 8)),
    recommendations: rankedCandidates.slice(0, 5).map((item) => ({
      item_id: item.id,
      source_ref: item.source_ref,
      source_type: item.source_type,
      action: item.recommendation?.action || 'hold',
      summary: item.recommendation?.summary || null,
      command: item.recommendation?.command || null,
      freshness: item.queue_assessment?.freshness || 'unknown',
      stale_invalidation_count: item.queue_assessment?.stale_invalidation_count || 0,
      stale_wave_count: item.queue_assessment?.stale_wave_count || 0,
      stale_wave_size: item.queue_assessment?.stale_wave_size || 0,
      stale_wave_summary: item.queue_assessment?.stale_wave_summary || null,
      goal_priority: item.queue_assessment?.goal_priority || null,
      integration_risk: item.queue_assessment?.integration_risk || 'normal',
    })),
  };
}

export async function runNextQueueItem(db, repoRoot, { targetBranch = 'main', followPlan = false } = {}) {
  const currentItems = listMergeQueue(db);
  const nextItem = chooseRunnableQueueItem(currentItems, { db, repoRoot, followPlan });
  if (!nextItem) {
    const deferred = chooseNextQueueItem(currentItems, { db, repoRoot });
    if (deferred) {
      syncDeferredQueueState(db, deferred);
      const refreshedDeferred = chooseNextQueueItem(listMergeQueue(db), { db, repoRoot });
      return { status: 'deferred', item: null, deferred: refreshedDeferred };
    }
    return { status: 'idle', item: null };
  }

  const started = startMergeQueueItem(db, nextItem.id);
  if (!started) {
    return { status: 'idle', item: null };
  }

  try {
    const resolved = resolveQueueSource(db, repoRoot, started);
    const queueTarget = started.target_branch || targetBranch;

    if (resolved.pipeline_id) {
      const policyGate = await evaluatePipelinePolicyGate(db, repoRoot, resolved.pipeline_id);
      if (!policyGate.ok) {
        return {
          status: 'blocked',
          item: markMergeQueueState(db, started.id, {
            status: 'blocked',
            lastErrorCode: policyGate.reason_code,
            lastErrorSummary: policyGate.summary,
            nextAction: policyGate.next_action,
          }),
        };
      }
    }

    if (!gitBranchExists(repoRoot, resolved.branch)) {
      return scheduleRetryOrBlock(db, started, {
        code: 'source_missing',
        summary: `Source branch ${resolved.branch} does not exist.`,
        nextAction: `Remove this queue item or recreate ${resolved.branch}, then run \`switchman queue retry ${started.id}\`.`,
        retryable: false,
      });
    }

    const rebaseOperation = startOperationJournalEntry(db, {
      scopeType: 'queue_item',
      scopeId: started.id,
      operationType: 'queue_rebase',
      details: JSON.stringify({
        queue_item_id: started.id,
        branch: resolved.branch,
        target_branch: queueTarget,
      }),
    });
    markMergeQueueState(db, started.id, { status: 'rebasing' });
    try {
      gitRebaseOnto(resolved.worktree_path || repoRoot, queueTarget, resolved.branch);
      finishOperationJournalEntry(db, rebaseOperation.id, {
        status: 'completed',
      });
    } catch (err) {
      finishOperationJournalEntry(db, rebaseOperation.id, {
        status: 'failed',
        details: JSON.stringify({
          queue_item_id: started.id,
          branch: resolved.branch,
          target_branch: queueTarget,
          error: String(err?.message || err),
        }),
      });
      throw err;
    }

    const gate = await evaluateQueueRepoGate(db, repoRoot);
    if (!gate.ok) {
      return {
        status: 'blocked',
        item: markMergeQueueState(db, started.id, {
          status: 'blocked',
          lastErrorCode: 'gate_failed',
          lastErrorSummary: gate.summary,
          nextAction: `Run \`switchman gate ci\`, resolve the reported issues, then run \`switchman queue retry ${started.id}\`.`,
        }),
      };
    }

    const mergeOperation = startOperationJournalEntry(db, {
      scopeType: 'queue_item',
      scopeId: started.id,
      operationType: 'queue_merge',
      details: JSON.stringify({
        queue_item_id: started.id,
        branch: resolved.branch,
        target_branch: queueTarget,
      }),
    });
    markMergeQueueState(db, started.id, { status: 'merging' });
    let mergedCommit;
    try {
      mergedCommit = gitMergeBranchInto(repoRoot, queueTarget, resolved.branch);
      finishOperationJournalEntry(db, mergeOperation.id, {
        status: 'completed',
        details: JSON.stringify({
          queue_item_id: started.id,
          branch: resolved.branch,
          target_branch: queueTarget,
          merged_commit: mergedCommit,
        }),
      });
    } catch (err) {
      finishOperationJournalEntry(db, mergeOperation.id, {
        status: 'failed',
        details: JSON.stringify({
          queue_item_id: started.id,
          branch: resolved.branch,
          target_branch: queueTarget,
          error: String(err?.message || err),
        }),
      });
      throw err;
    }

    return {
      status: 'merged',
      item: markMergeQueueState(db, started.id, {
        status: 'merged',
        mergedCommit,
      }),
    };
  } catch (err) {
    const failure = describeQueueError(err);
    return scheduleRetryOrBlock(db, started, failure);
  }
}

export async function runMergeQueue(db, repoRoot, {
  maxItems = 1,
  targetBranch = 'main',
  followPlan = false,
  mergeBudget = null,
} = {}) {
  const processed = [];
  let deferred = null;
  let mergedCount = 0;
  for (let count = 0; count < maxItems; count++) {
    if (mergeBudget !== null && mergedCount >= mergeBudget) break;
    const result = await runNextQueueItem(db, repoRoot, { targetBranch, followPlan });
    if (!result.item) {
      deferred = result.deferred || deferred;
      break;
    }
    processed.push(result);
    if (result.status === 'merged') {
      mergedCount += 1;
    }
    if (result.status !== 'merged') break;
  }

  return {
    processed,
    deferred,
    execution_policy: {
      follow_plan: followPlan,
      merge_budget: mergeBudget,
      merged_count: mergedCount,
    },
    summary: buildQueueStatusSummary(listMergeQueue(db), { db, repoRoot }),
  };
}
