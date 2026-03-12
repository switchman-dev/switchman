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

function resolveExecution(db, { taskId = null, leaseId = null } = {}) {
  if (leaseId) {
    const execution = getLeaseExecutionContext(db, leaseId);
    if (!execution?.task) {
      return { task: null, taskSpec: null, worktree: null, leaseId };
    }
    return {
      task: execution.task,
      taskSpec: execution.task_spec,
      worktree: execution.worktree,
      leaseId: execution.lease?.id || leaseId,
    };
  }

  if (!taskId) {
    return { task: null, taskSpec: null, worktree: null, leaseId: null };
  }

  const task = getTask(db, taskId);
  return {
    task,
    taskSpec: task ? getTaskSpec(db, taskId) : null,
    worktree: task?.worktree ? getWorktree(db, task.worktree) : null,
    leaseId: null,
  };
}

export function evaluateTaskOutcome(db, repoRoot, { taskId = null, leaseId = null } = {}) {
  const execution = resolveExecution(db, { taskId, leaseId });
  const task = execution.task;
  const taskSpec = execution.taskSpec;

  if (!task || !task.worktree) {
    return {
      status: 'failed',
      reason_code: taskId || leaseId ? 'task_not_assigned' : 'task_identity_required',
      changed_files: [],
      findings: [taskId || leaseId ? 'task has no assigned worktree' : 'task outcome requires a taskId or leaseId'],
    };
  }

  const worktree = execution.worktree;
  if (!worktree) {
    return {
      status: 'failed',
      reason_code: 'worktree_missing',
      changed_files: [],
      findings: ['assigned worktree is not registered'],
    };
  }

  const changedFiles = getWorktreeChangedFiles(worktree.path, repoRoot);
  const activeClaims = getActiveFileClaims(db)
    .filter((claim) => claim.task_id === task.id && claim.worktree === task.worktree)
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
      changed_files: changedFiles,
      findings,
    };
  }

  if (activeClaims.length > 0 && changedOutsideClaims.length > 0) {
    findings.push(`changed files outside claimed scope: ${changedOutsideClaims.join(', ')}`);
    return {
      status: 'needs_followup',
      reason_code: 'changes_outside_claims',
      changed_files: changedFiles,
      findings,
    };
  }

  if (changedOutsideTaskScope.length > 0) {
    findings.push(`changed files outside task scope: ${changedOutsideTaskScope.join(', ')}`);
    return {
      status: 'needs_followup',
      reason_code: 'changes_outside_task_scope',
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
      changed_files: changedFiles,
      findings,
    };
  }

  if ((expectsDocs || requiredDeliverables.includes('docs')) && changedDocsFiles.length === 0) {
    findings.push('task looks like a docs task but no docs files changed');
    return {
      status: 'needs_followup',
      reason_code: 'missing_expected_docs',
      changed_files: changedFiles,
      findings,
    };
  }

  if ((expectsSource || requiredDeliverables.includes('source')) && changedSourceFiles.length === 0) {
    findings.push('implementation task finished without source-file changes');
    return {
      status: 'needs_followup',
      reason_code: 'missing_expected_source_changes',
      changed_files: changedFiles,
      findings,
    };
  }

  const matchedObjectiveKeywords = objectiveKeywords.filter((keyword) =>
    changedFiles.some((filePath) => fileMatchesKeyword(filePath, keyword)),
  );
  const minimumKeywordMatches = Math.min(1, objectiveKeywords.length);

  if (objectiveKeywords.length > 0 && matchedObjectiveKeywords.length < minimumKeywordMatches) {
    findings.push(`changed files do not clearly satisfy task objective keywords: ${objectiveKeywords.join(', ')}`);
    return {
      status: 'needs_followup',
      reason_code: 'objective_not_evidenced',
      changed_files: changedFiles,
      task_id: task.id,
      lease_id: execution.leaseId,
      findings,
    };
  }

  const result = {
    status: 'accepted',
    reason_code: null,
    changed_files: changedFiles,
    task_id: task.id,
    lease_id: execution.leaseId,
    task_spec: taskSpec,
    claimed_files: activeClaims,
    findings: changedInsideClaims.length > 0 ? ['changes stayed within claimed scope'] : [],
  };

  if (execution.leaseId) {
    touchBoundaryValidationState(db, execution.leaseId, 'task_outcome_accepted');
  }

  return result;
}
