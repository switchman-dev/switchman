import { getActiveFileClaims, getLeaseExecutionContext, getTask, getTaskSpec, getWorktree, touchBoundaryValidationState } from './db.js';
import { getWorktreeChangedFiles } from './git.js';
import { matchesPathPatterns } from './ignore.js';

function isTestPath(filePath) {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/i.test(filePath);
}

function isDocsPath(filePath) {
  return /(^|\/)(docs?|readme)(\/|$)|(^|\/)README(\.[^.]+)?$/i.test(filePath);
}

function isSourcePath(filePath) {
  return /(^|\/)(src|app|lib|server|client)(\/|$)/i.test(filePath) && !isTestPath(filePath);
}

function fileMatchesKeyword(filePath, keyword) {
  const normalizedPath = String(filePath || '').toLowerCase();
  const normalizedKeyword = String(keyword || '').toLowerCase();
  return normalizedKeyword.length >= 3 && normalizedPath.includes(normalizedKeyword);
}

export function evaluateTaskOutcome(db, repoRoot, { taskId = null, leaseId = null }) {
  const execution = leaseId ? getLeaseExecutionContext(db, leaseId) : null;
  const task = execution?.task || (taskId ? getTask(db, taskId) : null);
  const taskSpec = execution?.task_spec || (task ? getTaskSpec(db, task.id) : null);
  const resolvedTaskId = task?.id || taskId || execution?.lease?.task_id || null;
  const resolvedLeaseId = execution?.lease?.id || leaseId || null;

  if (!task || !task.worktree) {
    return {
      status: 'failed',
      reason_code: 'task_not_assigned',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: [],
      findings: [taskId || leaseId ? 'task has no assigned worktree' : 'task outcome requires a taskId or leaseId'],
    };
  }

  const worktree = execution?.worktree || getWorktree(db, task.worktree);
  if (!worktree) {
    return {
      status: 'failed',
      reason_code: 'worktree_missing',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: [],
      findings: ['assigned worktree is not registered'],
    };
  }

  const changedFiles = getWorktreeChangedFiles(worktree.path, repoRoot);
  const activeClaims = (execution?.claims || getActiveFileClaims(db)
    .filter((claim) => claim.task_id === task.id && claim.worktree === task.worktree))
    .map((claim) => claim.file_path);
  const changedOutsideClaims = changedFiles.filter((filePath) => !activeClaims.includes(filePath));
  const changedInsideClaims = changedFiles.filter((filePath) => activeClaims.includes(filePath));
  const allowedPaths = taskSpec?.allowed_paths || [];
  const changedOutsideTaskScope = allowedPaths.length > 0
    ? changedFiles.filter((filePath) => !matchesPathPatterns(filePath, allowedPaths))
    : [];
  const expectedOutputTypes = taskSpec?.expected_output_types || [];
  const requiredDeliverables = taskSpec?.required_deliverables || [];
  const objectiveKeywords = taskSpec?.objective_keywords || [];
  const findings = [];

  if (changedFiles.length === 0) {
    findings.push('command exited successfully but produced no tracked file changes');
    return {
      status: 'needs_followup',
      reason_code: 'no_changes_detected',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: changedFiles,
      findings,
    };
  }

  if (activeClaims.length > 0 && changedOutsideClaims.length > 0) {
    findings.push(`changed files outside claimed scope: ${changedOutsideClaims.join(', ')}`);
    return {
      status: 'needs_followup',
      reason_code: 'changes_outside_claims',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: changedFiles,
      findings,
    };
  }

  if (changedOutsideTaskScope.length > 0) {
    findings.push(`changed files outside task scope: ${changedOutsideTaskScope.join(', ')}`);
    return {
      status: 'needs_followup',
      reason_code: 'changes_outside_task_scope',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: changedFiles,
      findings,
    };
  }

  const title = String(task.title || '').toLowerCase();
  const expectsTests = expectedOutputTypes.includes('tests') || title.includes('test');
  const expectsDocs = expectedOutputTypes.includes('docs') || title.includes('docs') || title.includes('readme') || title.includes('integration notes');
  const expectsSource = expectedOutputTypes.includes('source') || title.startsWith('implement:') || title.includes('implement');
  const changedTestFiles = changedFiles.filter(isTestPath);
  const changedDocsFiles = changedFiles.filter(isDocsPath);
  const changedSourceFiles = changedFiles.filter(isSourcePath);

  if ((expectsTests || requiredDeliverables.includes('tests')) && changedTestFiles.length === 0) {
    findings.push('task looks like a test task but no test files changed');
    return {
      status: 'needs_followup',
      reason_code: 'missing_expected_tests',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: changedFiles,
      findings,
    };
  }

  if ((expectsDocs || requiredDeliverables.includes('docs')) && changedDocsFiles.length === 0) {
    findings.push('task looks like a docs task but no docs files changed');
    return {
      status: 'needs_followup',
      reason_code: 'missing_expected_docs',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: changedFiles,
      findings,
    };
  }

  if ((expectsSource || requiredDeliverables.includes('source')) && changedSourceFiles.length === 0) {
    findings.push('implementation task finished without source-file changes');
    return {
      status: 'needs_followup',
      reason_code: 'missing_expected_source_changes',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: changedFiles,
      findings,
    };
  }

  const matchedObjectiveKeywords = objectiveKeywords.filter((keyword) =>
    changedFiles.some((filePath) => fileMatchesKeyword(filePath, keyword)),
  );
  const minimumKeywordMatches = taskSpec?.task_type === 'governance'
    ? (taskSpec?.risk_level === 'high'
      ? Math.min(2, objectiveKeywords.length)
      : Math.min(1, objectiveKeywords.length))
    : Math.min(1, objectiveKeywords.length);

  if (objectiveKeywords.length > 0 && matchedObjectiveKeywords.length < minimumKeywordMatches) {
    findings.push(`changed files do not clearly satisfy task objective keywords: ${objectiveKeywords.join(', ')}`);
    return {
      status: 'needs_followup',
      reason_code: 'objective_not_evidenced',
      lease_id: resolvedLeaseId,
      task_id: resolvedTaskId,
      changed_files: changedFiles,
      task_id: task.id,
      lease_id: execution.lease?.id,
      findings,
    };
  }

  const acceptedResult = {
    status: 'accepted',
    reason_code: null,
    lease_id: resolvedLeaseId,
    task_id: resolvedTaskId,
    changed_files: changedFiles,
    task_id: task.id,
    lease_id: execution.lease?.id,
    task_spec: taskSpec,
    claimed_files: activeClaims,
    findings: changedInsideClaims.length > 0 ? ['changes stayed within claimed scope'] : [],
  };
  if (resolvedLeaseId) {
    touchBoundaryValidationState(db, resolvedLeaseId, 'outcome:accepted', {
      changed_files: changedFiles,
    });
  }
  return acceptedResult;
}
