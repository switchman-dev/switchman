import { getMergeQueueItem, listMergeQueue, listWorktrees, markMergeQueueState, startMergeQueueItem } from './db.js';
import { gitBranchExists, gitMergeBranchInto, gitRebaseOnto } from './git.js';
import { runAiMergeGate } from './merge-gate.js';
import { preparePipelineLandingTarget } from './pipeline.js';
import { scanAllWorktrees } from './detector.js';

function describeQueueError(err) {
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
    return {
      status: 'retrying',
      item: markMergeQueueState(db, item.id, {
        status: 'retrying',
        lastErrorCode: failure.code,
        lastErrorSummary: failure.summary,
        nextAction: `Retry ${retriesUsed + 1} of ${maxRetries} scheduled automatically. Run \`switchman queue run\` again after fixing any underlying branch drift if needed.`,
        incrementRetry: true,
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

async function evaluateQueueRepoGate(db, repoRoot) {
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
    return {
      branch: item.source_ref,
      worktree: item.source_worktree || null,
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

export function buildQueueStatusSummary(items) {
  const counts = {
    queued: items.filter((item) => item.status === 'queued').length,
    validating: items.filter((item) => item.status === 'validating').length,
    rebasing: items.filter((item) => item.status === 'rebasing').length,
    merging: items.filter((item) => item.status === 'merging').length,
    retrying: items.filter((item) => item.status === 'retrying').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    merged: items.filter((item) => item.status === 'merged').length,
  };

  return {
    counts,
    next: items.find((item) => ['queued', 'retrying', 'validating', 'rebasing', 'merging'].includes(item.status)) || null,
    blocked: items.filter((item) => item.status === 'blocked'),
  };
}

export async function runNextQueueItem(db, repoRoot, { targetBranch = 'main' } = {}) {
  const nextItem = listMergeQueue(db).find((item) => ['queued', 'retrying'].includes(item.status));
  if (!nextItem) {
    return { status: 'idle', item: null };
  }

  const started = startMergeQueueItem(db, nextItem.id);
  if (!started) {
    return { status: 'idle', item: null };
  }

  try {
    const resolved = resolveQueueSource(db, repoRoot, started);
    const queueTarget = started.target_branch || targetBranch;

    if (!gitBranchExists(repoRoot, resolved.branch)) {
      return scheduleRetryOrBlock(db, started, {
        code: 'source_missing',
        summary: `Source branch ${resolved.branch} does not exist.`,
        nextAction: `Remove this queue item or recreate ${resolved.branch}, then run \`switchman queue retry ${started.id}\`.`,
        retryable: false,
      });
    }

    markMergeQueueState(db, started.id, { status: 'rebasing' });
    gitRebaseOnto(resolved.worktree_path || repoRoot, queueTarget, resolved.branch);

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

    markMergeQueueState(db, started.id, { status: 'merging' });
    const mergedCommit = gitMergeBranchInto(repoRoot, queueTarget, resolved.branch);

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

export async function runMergeQueue(db, repoRoot, { maxItems = 1, targetBranch = 'main' } = {}) {
  const processed = [];
  for (let count = 0; count < maxItems; count++) {
    const result = await runNextQueueItem(db, repoRoot, { targetBranch });
    if (!result.item) break;
    processed.push(result);
    if (result.status !== 'merged') break;
  }

  return {
    processed,
    summary: buildQueueStatusSummary(listMergeQueue(db)),
  };
}
