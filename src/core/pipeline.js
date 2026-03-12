import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { completeLeaseTask, createTask, failLeaseTask, getTaskSpec, listAuditEvents, listBoundaryValidationStates, listDependencyInvalidations, listLeases, listMergeQueue, listTasks, listWorktrees, logAuditEvent, retryTask, startTaskLease, upsertTaskSpec } from './db.js';
import { scanAllWorktrees } from './detector.js';
import { runAiMergeGate } from './merge-gate.js';
import { evaluateTaskOutcome } from './outcome.js';
import { loadChangePolicy } from './policy.js';
import { buildTaskSpec, planPipelineTasks } from './planner.js';
import { getWorktreeBranch, gitBranchExists, gitMaterializeIntegrationBranch, gitPrepareIntegrationRecoveryWorktree, gitRemoveWorktree, gitRevParse, listGitWorktrees } from './git.js';

function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

function uniq(values) {
  return [...new Set(values)];
}

function makePipelineId() {
  return `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseSuggestedWorktree(description) {
  const match = String(description || '').match(/Suggested worktree:\s*(.+)$/m);
  return match?.[1] || null;
}

function parseDependencies(description) {
  const match = String(description || '').match(/Depends on:\s*(.+)$/m);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPipelineMetadata(db, pipelineId) {
  const events = listAuditEvents(db, { eventType: 'pipeline_created', limit: 500 });
  for (const event of events) {
    try {
      const details = JSON.parse(event.details || '{}');
      if (details.pipeline_id === pipelineId) {
        return details;
      }
    } catch {
      // Ignore malformed audit payloads.
    }
  }
  return null;
}

function withTaskSpec(db, task) {
  return {
    ...task,
    task_spec: getTaskSpec(db, task.id),
  };
}

function nextPipelineTaskId(tasks, pipelineId) {
  const nextNumber = tasks
    .map((task) => Number.parseInt(task.id.slice(`${pipelineId}-`.length), 10))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0) + 1;
  return `${pipelineId}-${String(nextNumber).padStart(2, '0')}`;
}

function rankEnforcement(level = 'none') {
  return level === 'blocked' ? 2 : level === 'warn' ? 1 : 0;
}

function normalizeDependencyInvalidation(item) {
  const details = item.details || {};
  return {
    ...item,
    details,
    stale_area: item.reason_type === 'subsystem_overlap'
      ? `subsystem:${item.subsystem_tag}`
      : `${item.source_scope_pattern} ↔ ${item.affected_scope_pattern}`,
    summary: `${details?.source_task_title || item.source_task_id} changed shared ${item.reason_type === 'subsystem_overlap' ? `subsystem:${item.subsystem_tag}` : 'scope'}`,
  };
}

function buildStaleClusters(invalidations = [], { pipelineId = null } = {}) {
  const clusters = new Map();
  for (const invalidation of invalidations.map(normalizeDependencyInvalidation)) {
    if (pipelineId && invalidation.affected_pipeline_id !== pipelineId) continue;
    const clusterKey = invalidation.affected_pipeline_id
      ? `pipeline:${invalidation.affected_pipeline_id}`
      : `task:${invalidation.affected_task_id}`;
    if (!clusters.has(clusterKey)) {
      clusters.set(clusterKey, {
        key: clusterKey,
        affected_pipeline_id: invalidation.affected_pipeline_id || null,
        affected_task_ids: new Set(),
        source_task_titles: new Set(),
        source_worktrees: new Set(),
        stale_areas: new Set(),
        invalidations: [],
        severity: 'warn',
      });
    }
    const cluster = clusters.get(clusterKey);
    cluster.invalidations.push(invalidation);
    cluster.affected_task_ids.add(invalidation.affected_task_id);
    if (invalidation.details?.source_task_title) cluster.source_task_titles.add(invalidation.details.source_task_title);
    if (invalidation.source_worktree) cluster.source_worktrees.add(invalidation.source_worktree);
    cluster.stale_areas.add(invalidation.stale_area);
    if (invalidation.severity === 'blocked') cluster.severity = 'block';
  }

  return [...clusters.values()].map((cluster) => ({
    key: cluster.key,
    affected_pipeline_id: cluster.affected_pipeline_id,
    affected_task_ids: [...cluster.affected_task_ids],
    invalidation_count: cluster.invalidations.length,
    source_task_titles: [...cluster.source_task_titles],
    source_worktrees: [...cluster.source_worktrees],
    stale_areas: [...cluster.stale_areas],
    severity: cluster.severity,
    invalidations: cluster.invalidations,
    title: cluster.affected_pipeline_id
      ? `Pipeline ${cluster.affected_pipeline_id} has ${cluster.invalidations.length} stale dependency invalidation${cluster.invalidations.length === 1 ? '' : 's'}`
      : `${[...cluster.affected_task_ids][0]} has ${cluster.invalidations.length} stale dependency invalidation${cluster.invalidations.length === 1 ? '' : 's'}`,
    detail: `${[...cluster.source_task_titles][0] || cluster.invalidations[0]?.source_task_id || 'unknown source'} (${[...cluster.stale_areas].join(', ')})`,
    next_action: cluster.affected_pipeline_id
      ? `switchman task retry-stale --pipeline ${cluster.affected_pipeline_id}`
      : `switchman task retry ${[...cluster.affected_task_ids][0]}`,
  })).sort((a, b) => b.invalidation_count - a.invalidation_count);
}

export function summarizePipelinePolicyState(status, changePolicy, boundaryValidations = []) {
  const tasks = status.tasks || [];
  const implementationTasks = tasks.filter((task) => task.task_spec?.task_type === 'implementation');
  const completedTasks = tasks.filter((task) => task.status === 'done' && task.task_spec?.task_type);
  const completedTaskTypes = new Set(completedTasks.map((task) => task.task_spec?.task_type).filter(Boolean));
  const governedDomains = uniq(
    implementationTasks
      .flatMap((task) => task.task_spec?.subsystem_tags || [])
      .filter((domain) => changePolicy.domain_rules?.[domain]),
  );
  const activeRules = governedDomains.map((domain) => ({
    domain,
    ...(changePolicy.domain_rules?.[domain] || { required_completed_task_types: [], enforcement: 'none', rationale: [] }),
  }));
  const requiredTaskTypes = uniq([
    ...implementationTasks.flatMap((task) => task.task_spec?.validation_rules?.required_completed_task_types || []),
    ...activeRules.flatMap((rule) => rule.required_completed_task_types || []),
  ]);
  const missingTaskTypes = uniq([
    ...boundaryValidations.flatMap((validation) => validation.missing_task_types || []),
    ...requiredTaskTypes.filter((taskType) => !completedTaskTypes.has(taskType)),
  ]);
  const satisfiedTaskTypes = requiredTaskTypes.filter((taskType) => completedTaskTypes.has(taskType));
  const evidenceByTaskType = Object.fromEntries(
    requiredTaskTypes.map((taskType) => [
      taskType,
      completedTasks
        .filter((task) => task.task_spec?.task_type === taskType)
        .map((task) => ({
          task_id: task.id,
          title: task.title,
          task_type: task.task_spec?.task_type || null,
          worktree: task.worktree || task.suggested_worktree || null,
          artifact_path: task.task_spec?.primary_output_path || null,
          subsystem_tags: task.task_spec?.subsystem_tags || [],
        })),
    ]),
  );
  const requirementStatus = requiredTaskTypes.map((taskType) => ({
    task_type: taskType,
    satisfied: satisfiedTaskTypes.includes(taskType),
    evidence: evidenceByTaskType[taskType] || [],
  }));
  const rationale = uniq([
    ...implementationTasks.flatMap((task) => task.task_spec?.validation_rules?.rationale || []),
    ...activeRules.flatMap((rule) => rule.rationale || []),
    ...boundaryValidations.flatMap((validation) => validation.rationale || validation.details?.rationale || []),
  ]);
  const enforcement = [...implementationTasks.map((task) => task.task_spec?.validation_rules?.enforcement || 'none'), ...activeRules.map((rule) => rule.enforcement || 'none')]
    .reduce((highest, current) => rankEnforcement(current) > rankEnforcement(highest) ? current : highest, 'none');

  return {
    active: governedDomains.length > 0 || boundaryValidations.length > 0,
    domains: governedDomains,
    active_rules: activeRules,
    required_task_types: requiredTaskTypes,
    satisfied_task_types: satisfiedTaskTypes,
    missing_task_types: missingTaskTypes,
    requirement_status: requirementStatus,
    evidence_by_task_type: evidenceByTaskType,
    enforcement,
    rationale,
    blocked_validations: boundaryValidations.filter((validation) => validation.severity === 'blocked').length,
    warned_validations: boundaryValidations.filter((validation) => validation.severity !== 'blocked').length,
    summary: governedDomains.length === 0
      ? 'No explicit governed-domain policy requirements are active for this pipeline.'
      : missingTaskTypes.length > 0
        ? `Governed domains ${governedDomains.join(', ')} still require ${missingTaskTypes.join(', ')} before landing.`
        : `Governed domains ${governedDomains.join(', ')} have satisfied their current policy requirements.`,
  };
}

function buildPipelinePolicyRemediationCommand(status, policyState) {
  if (policyState.missing_task_types.length === 0) {
    return `switchman pipeline status ${status.pipeline_id}`;
  }

  return `switchman pipeline review ${status.pipeline_id}`;
}

export async function evaluatePipelinePolicyGate(db, repoRoot, pipelineId) {
  const status = getPipelineStatus(db, pipelineId);
  const aiGate = await runAiMergeGate(db, repoRoot);
  const changePolicy = loadChangePolicy(repoRoot);
  const policyState = summarizePipelinePolicyState(status, changePolicy, aiGate.boundary_validations || []);
  const blocked = policyState.active
    && policyState.enforcement === 'blocked'
    && policyState.missing_task_types.length > 0;
  const nextAction = blocked ? buildPipelinePolicyRemediationCommand(status, policyState) : null;

  return {
    ok: !blocked,
    pipeline_id: pipelineId,
    reason_code: blocked ? 'policy_requirements_incomplete' : null,
    summary: blocked
      ? `Policy blocked landing for governed domains ${policyState.domains.join(', ')} because ${policyState.missing_task_types.join(', ')} is still required.`
      : policyState.summary,
    next_action: nextAction,
    policy_state: policyState,
  };
}

export function startPipeline(db, { title, description = null, priority = 5, pipelineId = null, maxTasks = 5 }) {
  const resolvedPipelineId = pipelineId || makePipelineId();
  const registeredWorktrees = listWorktrees(db);
  const suggestedWorktrees = registeredWorktrees.filter((worktree) => worktree.name !== 'main');
  const repoRoot = registeredWorktrees.find((worktree) => worktree.name === 'main')?.path || process.cwd();
  const plannedTasks = planPipelineTasks({
    pipelineId: resolvedPipelineId,
    title,
    description,
    worktrees: suggestedWorktrees,
    maxTasks,
    repoRoot,
  });

  const tasks = plannedTasks.map((plannedTask, index) => {
    const taskDescription = [
      `[Pipeline ${resolvedPipelineId}]`,
      plannedTask.suggested_worktree ? `Suggested worktree: ${plannedTask.suggested_worktree}` : null,
      plannedTask.dependencies.length > 0 ? `Depends on: ${plannedTask.dependencies.join(', ')}` : null,
      index === 0 && description ? description : null,
    ].filter(Boolean).join('\n');

    createTask(db, {
      id: plannedTask.id,
      title: plannedTask.title,
      description: taskDescription,
      priority,
    });
    upsertTaskSpec(db, plannedTask.id, plannedTask.task_spec);

    const taskRecord = {
      id: plannedTask.id,
      title: plannedTask.title,
      priority,
      suggested_worktree: plannedTask.suggested_worktree,
      dependencies: plannedTask.dependencies,
      task_spec: plannedTask.task_spec,
      status: 'pending',
    };

    return taskRecord;
  });

  logAuditEvent(db, {
    eventType: 'pipeline_created',
    status: 'allowed',
    details: JSON.stringify({
      pipeline_id: resolvedPipelineId,
      title,
      description,
      priority,
      task_ids: tasks.map((task) => task.id),
    }),
  });

  return {
    pipeline_id: resolvedPipelineId,
    title,
    description,
    priority,
    tasks,
  };
}

export function getPipelineStatus(db, pipelineId) {
  const tasks = listTasks(db).filter((task) => task.id.startsWith(`${pipelineId}-`));
  if (tasks.length === 0) {
    throw new Error(`Pipeline ${pipelineId} does not exist.`);
  }

  const metadata = getPipelineMetadata(db, pipelineId);
  const counts = {
    pending: tasks.filter((task) => task.status === 'pending').length,
    in_progress: tasks.filter((task) => task.status === 'in_progress').length,
    done: tasks.filter((task) => task.status === 'done').length,
    failed: tasks.filter((task) => task.status === 'failed').length,
  };

  return {
    pipeline_id: pipelineId,
    title: metadata?.title || tasks[0].title,
    description: metadata?.description || null,
    priority: metadata?.priority || tasks[0].priority,
    counts,
    tasks: tasks.map((task) => {
      const dependencies = parseDependencies(task.description);
      const blockedBy = dependencies.filter((dependencyId) =>
        tasks.find((candidate) => candidate.id === dependencyId)?.status !== 'done',
      );
      const taskSpec = getTaskSpec(db, task.id);
      const failure = task.status === 'failed' ? parseTaskFailure(task.description) : null;
      return {
        ...task,
        task_spec: taskSpec,
        suggested_worktree: parseSuggestedWorktree(task.description),
        dependencies,
        blocked_by: blockedBy,
        ready_to_run: task.status === 'pending' && blockedBy.length === 0,
        failure,
        next_action: task.status === 'failed'
          ? inferTaskNextAction({ ...task, task_spec: taskSpec }, failure)
          : null,
      };
    }),
  };
}

function parseTaskFailure(description) {
  const lines = String(description || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const failureLine = [...lines].reverse().find((line) => line.startsWith('FAILED: '));
  if (!failureLine) return null;

  const message = failureLine.slice('FAILED: '.length);
  const match = message.match(/^([a-z0-9_]+):\s*(.+)$/i);
  return {
    raw: message,
    reason_code: match ? match[1] : null,
    summary: match ? match[2] : message,
  };
}

function inferTaskNextAction(task, failure) {
  if (!failure?.reason_code) return null;

  switch (failure.reason_code) {
    case 'changes_outside_claims':
      return 'Claim every edited file first, or split the task into smaller scoped changes.';
    case 'changes_outside_task_scope':
      return 'Keep edits inside allowed paths or widen the planned task scope.';
    case 'missing_expected_tests':
      return 'Add or update tests before rerunning this task.';
    case 'missing_expected_docs':
      return 'Add the expected docs change or update the docs path in the task spec.';
    case 'missing_expected_source_changes':
      return 'Make a source change inside the claimed task scope.';
    case 'objective_not_evidenced':
      return 'Produce output that clearly matches the task objective or rewrite the task intent.';
    case 'no_changes_detected':
      return 'Create a tracked file change or move the work into a more appropriate follow-up task.';
    default:
      return 'Inspect the task output and rerun with a clearer, narrower task scope.';
  }
}

function chooseWorktree(task, availableWorktrees) {
  const suggested = parseSuggestedWorktree(task.description);
  if (suggested) {
    const suggestedIndex = availableWorktrees.findIndex((worktree) => worktree.name === suggested);
    if (suggestedIndex >= 0) {
      return availableWorktrees.splice(suggestedIndex, 1)[0];
    }
  }

  if (availableWorktrees.length === 0) return null;
  return availableWorktrees.shift();
}

function buildLaunchEnv(repoRoot, task, lease, worktree) {
  const taskSpec = task.task_spec || null;
  const executionPolicy = taskSpec?.execution_policy || null;
  return {
    ...process.env,
    SWITCHMAN_PIPELINE_ID: task.id.split('-').slice(0, -1).join('-'),
    SWITCHMAN_TASK_ID: task.id,
    SWITCHMAN_TASK_TITLE: task.title,
    SWITCHMAN_TASK_TYPE: taskSpec?.task_type || '',
    SWITCHMAN_TASK_SPEC: taskSpec ? JSON.stringify(taskSpec) : '',
    SWITCHMAN_TASK_OUTPUT_PATH: taskSpec?.primary_output_path || '',
    SWITCHMAN_TASK_TIMEOUT_MS: executionPolicy?.timeout_ms ? String(executionPolicy.timeout_ms) : '',
    SWITCHMAN_TASK_MAX_RETRIES: Number.isInteger(executionPolicy?.max_retries) ? String(executionPolicy.max_retries) : '',
    SWITCHMAN_TASK_RETRY_BACKOFF_MS: executionPolicy?.retry_backoff_ms ? String(executionPolicy.retry_backoff_ms) : '',
    SWITCHMAN_LEASE_ID: lease.id,
    SWITCHMAN_WORKTREE: worktree.name,
    SWITCHMAN_WORKTREE_PATH: worktree.path,
    SWITCHMAN_REPO_ROOT: repoRoot,
  };
}

function getHeadRevision(worktreePath) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

function getTaskRetryCount(db, taskId) {
  return listAuditEvents(db, {
    eventType: 'pipeline_task_retry_scheduled',
    taskId,
    limit: 1000,
  }).length;
}

function resolveExecutionPolicy(taskSpec, defaults = {}) {
  const policy = taskSpec?.execution_policy || {};
  const timeoutMs = Number.isFinite(policy.timeout_ms) ? policy.timeout_ms : (defaults.timeoutMs ?? 0);
  const maxRetries = Number.isInteger(policy.max_retries) ? policy.max_retries : (defaults.maxRetries ?? 1);
  const retryBackoffMs = Number.isFinite(policy.retry_backoff_ms) ? policy.retry_backoff_ms : (defaults.retryBackoffMs ?? 0);

  return {
    timeout_ms: Math.max(0, timeoutMs),
    max_retries: Math.max(0, maxRetries),
    retry_backoff_ms: Math.max(0, retryBackoffMs),
  };
}

function scheduleTaskRetry(db, { pipelineId, taskId, maxRetries, retryBackoffMs = 0 }) {
  const retriesUsed = getTaskRetryCount(db, taskId);
  if (retriesUsed >= maxRetries) {
    return {
      retried: false,
      retry_attempt: retriesUsed,
      retries_remaining: 0,
      retry_delay_ms: 0,
    };
  }

  const nextAttempt = retriesUsed + 1;
  const delayMs = Math.max(0, retryBackoffMs * nextAttempt);
  const task = retryTask(db, taskId, `retry attempt ${nextAttempt} of ${maxRetries}`);
  if (!task) {
    return {
      retried: false,
      retry_attempt: retriesUsed,
      retries_remaining: Math.max(0, maxRetries - retriesUsed),
      retry_delay_ms: 0,
    };
  }

  logAuditEvent(db, {
    eventType: 'pipeline_task_retry_scheduled',
    status: 'warn',
    taskId,
    reasonCode: 'retry_scheduled',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      retry_attempt: nextAttempt,
      max_retries: maxRetries,
      retry_delay_ms: delayMs,
    }),
  });

  if (delayMs > 0) sleepSync(delayMs);

  return {
    retried: true,
    retry_attempt: nextAttempt,
    retries_remaining: Math.max(0, maxRetries - nextAttempt),
    retry_delay_ms: delayMs,
  };
}

function resumeRetryablePipelineTasks(db, pipelineId, defaults = {}) {
  const tasks = listTasks(db)
    .filter((task) => task.id.startsWith(`${pipelineId}-`) && task.status === 'failed')
    .map((task) => withTaskSpec(db, task))
    .sort((a, b) => a.id.localeCompare(b.id));
  const resumed = [];

  for (const task of tasks) {
    const executionPolicy = resolveExecutionPolicy(task.task_spec, defaults);
    if (executionPolicy.max_retries <= 0) continue;
    const retriesUsed = getTaskRetryCount(db, task.id);
    if (retriesUsed >= executionPolicy.max_retries) continue;

    const nextAttempt = retriesUsed + 1;
    const resumedTask = retryTask(db, task.id, `resume retry attempt ${nextAttempt} of ${executionPolicy.max_retries}`);
    if (!resumedTask) continue;

    logAuditEvent(db, {
      eventType: 'pipeline_task_retry_scheduled',
      status: 'warn',
      taskId: task.id,
      reasonCode: 'retry_resumed',
      details: JSON.stringify({
        pipeline_id: pipelineId,
        retry_attempt: nextAttempt,
        max_retries: executionPolicy.max_retries,
        resumed: true,
      }),
    });

    resumed.push({
      task_id: task.id,
      retry_attempt: nextAttempt,
      retries_remaining: Math.max(0, executionPolicy.max_retries - nextAttempt),
    });
  }

  return resumed;
}

export function runPipeline(
  db,
  repoRoot,
  {
    pipelineId,
    agentCommand = [],
    agentName = 'pipeline-runner',
    detached = false,
  },
) {
  const allPipelineTasks = listTasks(db).filter((task) => task.id.startsWith(`${pipelineId}-`));
  const taskStatusById = new Map(allPipelineTasks.map((task) => [task.id, task.status]));
  const tasks = allPipelineTasks
    .map((task) => withTaskSpec(db, task))
    .filter((task) => task.status === 'pending')
    .filter((task) => parseDependencies(task.description).every((dependencyId) => taskStatusById.get(dependencyId) === 'done'))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (tasks.length === 0) {
    throw new Error(`Pipeline ${pipelineId} has no pending tasks to run.`);
  }

  const activeLeaseWorktrees = new Set(listLeases(db, 'active').map((lease) => lease.worktree));
  const availableWorktrees = listWorktrees(db)
    .filter((worktree) => worktree.name !== 'main' && !activeLeaseWorktrees.has(worktree.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const assignments = [];
  const launched = [];

  for (const task of tasks) {
    const worktree = chooseWorktree(task, availableWorktrees);
    if (!worktree) break;

    const lease = startTaskLease(db, task.id, worktree.name, agentName);
    if (!lease) continue;

    const assignment = {
      task_id: task.id,
      title: task.title,
      task_spec: task.task_spec || null,
      worktree: worktree.name,
      worktree_path: worktree.path,
      lease_id: lease.id,
    };
    assignments.push(assignment);

    logAuditEvent(db, {
      eventType: 'pipeline_task_dispatched',
      status: 'allowed',
      worktree: worktree.name,
      taskId: task.id,
      leaseId: lease.id,
      details: JSON.stringify({ pipeline_id: pipelineId }),
    });

    if (agentCommand.length > 0) {
      const [command, ...args] = agentCommand;
      const child = spawn(command, args, {
        cwd: worktree.path,
        env: buildLaunchEnv(repoRoot, task, lease, worktree),
        detached,
        stdio: detached ? 'ignore' : 'inherit',
      });
      if (detached) child.unref();

      launched.push({
        ...assignment,
        pid: child.pid,
        command,
        args,
      });

      logAuditEvent(db, {
        eventType: 'pipeline_agent_launched',
        status: 'allowed',
        worktree: worktree.name,
        taskId: task.id,
        leaseId: lease.id,
        details: JSON.stringify({
          pipeline_id: pipelineId,
          command,
          args,
          pid: child.pid,
        }),
      });
    }
  }

  return {
    pipeline_id: pipelineId,
    assigned: assignments,
    launched,
    remaining_pending: tasks.length - assignments.length,
  };
}

function runPipelineIteration(
  db,
  repoRoot,
  {
    pipelineId,
    agentCommand = [],
    agentName = 'pipeline-runner',
    maxRetries = 1,
    retryBackoffMs = 0,
    timeoutMs = 0,
  },
) {
  const dispatch = runPipeline(db, repoRoot, {
    pipelineId,
    agentCommand: [],
    agentName,
    detached: false,
  });

  const executed = [];

  if (agentCommand.length > 0) {
    for (const assignment of dispatch.assigned) {
      const [command, ...args] = agentCommand;
      const executionPolicy = resolveExecutionPolicy(assignment.task_spec, {
        maxRetries,
        retryBackoffMs,
        timeoutMs,
      });
      const beforeHead = getHeadRevision(assignment.worktree_path);
      const result = spawnSync(command, args, {
        cwd: assignment.worktree_path,
        env: buildLaunchEnv(
          repoRoot,
          { id: assignment.task_id, title: assignment.title, task_spec: assignment.task_spec },
          { id: assignment.lease_id },
          { name: assignment.worktree, path: assignment.worktree_path },
        ),
        encoding: 'utf8',
        timeout: executionPolicy.timeout_ms > 0 ? executionPolicy.timeout_ms : undefined,
      });
      const afterHead = getHeadRevision(assignment.worktree_path);

      const timedOut = result.error?.code === 'ETIMEDOUT';
      const commandOk = !result.error && result.status === 0;
      let evaluation = commandOk
        ? evaluateTaskOutcome(db, repoRoot, { leaseId: assignment.lease_id })
        : null;
      if (commandOk && evaluation?.reason_code === 'no_changes_detected' && beforeHead && afterHead && beforeHead !== afterHead) {
        evaluation = {
          status: 'accepted',
          reason_code: null,
          changed_files: [],
          claimed_files: [],
          findings: ['task created a new commit with no remaining uncommitted diff'],
        };
      }
      const ok = commandOk && evaluation?.status === 'accepted';
      let retry = {
        retried: false,
        retry_attempt: getTaskRetryCount(db, assignment.task_id),
        retries_remaining: Math.max(0, executionPolicy.max_retries - getTaskRetryCount(db, assignment.task_id)),
        retry_delay_ms: 0,
      };
      if (ok) {
        completeLeaseTask(db, assignment.lease_id);
      } else {
        const failureReason = !commandOk
          ? (timedOut
            ? `agent command timed out after ${executionPolicy.timeout_ms}ms`
            : (result.error?.message || `agent command exited with status ${result.status}`))
          : `${evaluation.reason_code}: ${evaluation.findings.join('; ')}`;
        failLeaseTask(db, assignment.lease_id, failureReason);
        retry = scheduleTaskRetry(db, {
          pipelineId,
          taskId: assignment.task_id,
          maxRetries: executionPolicy.max_retries,
          retryBackoffMs: executionPolicy.retry_backoff_ms,
        });
      }

      executed.push({
        ...assignment,
        ok,
        outcome_status: evaluation?.status ?? null,
        outcome_reason_code: evaluation?.reason_code ?? null,
        outcome_findings: evaluation?.findings ?? [],
        retried: retry.retried,
        retry_attempt: retry.retry_attempt,
        retries_remaining: retry.retries_remaining,
        retry_delay_ms: retry.retry_delay_ms,
        execution_policy: executionPolicy,
        timed_out: timedOut,
        exit_code: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      });

      logAuditEvent(db, {
        eventType: 'pipeline_task_executed',
        status: ok ? 'allowed' : 'denied',
        reasonCode: ok ? null : (timedOut ? 'task_execution_timeout' : 'agent_command_failed'),
        worktree: assignment.worktree,
        taskId: assignment.task_id,
        leaseId: assignment.lease_id,
        details: JSON.stringify({
          pipeline_id: pipelineId,
          command,
          args,
          exit_code: result.status,
          timed_out: timedOut,
          execution_policy: executionPolicy,
          outcome_status: evaluation?.status ?? null,
          outcome_reason_code: evaluation?.reason_code ?? null,
          retried: retry.retried,
          retry_attempt: retry.retry_attempt,
          retries_remaining: retry.retries_remaining,
        }),
      });
    }
  }

  return {
    ...dispatch,
    executed,
  };
}

export async function buildPipelinePrSummary(db, repoRoot, pipelineId) {
  const status = getPipelineStatus(db, pipelineId);
  const report = await scanAllWorktrees(db, repoRoot);
  const aiGate = await runAiMergeGate(db, repoRoot);
  const changePolicy = loadChangePolicy(repoRoot);
  const allLeases = listLeases(db);
  const ciGateOk = report.conflicts.length === 0
    && report.fileConflicts.length === 0
    && (report.semanticConflicts?.length || 0) === 0
    && report.unclaimedChanges.length === 0
    && report.complianceSummary.non_compliant === 0
    && report.complianceSummary.stale === 0
    && (aiGate.dependency_invalidations || []).filter((item) => item.severity === 'blocked').length === 0;

  const involvedWorktrees = [...new Set(status.tasks.map((task) => task.worktree).filter(Boolean))];
  const worktreeChanges = involvedWorktrees.map((worktree) => ({
    worktree,
    files: report.fileMap?.[worktree] ?? [],
  }));
  const completedTasks = status.tasks.filter((task) => task.status === 'done');
  const remainingTasks = status.tasks.filter((task) => task.status !== 'done');
  const completedLeaseByTask = new Map();
  for (const lease of allLeases) {
    if (lease.status !== 'completed') continue;
    if (!completedLeaseByTask.has(lease.task_id)) {
      completedLeaseByTask.set(lease.task_id, lease);
    }
  }
  const provenance = completedTasks.map((task) => ({
    task_id: task.id,
    lease_id: completedLeaseByTask.get(task.id)?.id || null,
    title: task.title,
    task_type: task.task_spec?.task_type || null,
    risk_level: task.task_spec?.risk_level || null,
    worktree: task.worktree || task.suggested_worktree || null,
    agent: completedLeaseByTask.get(task.id)?.agent || null,
    subsystem_tags: task.task_spec?.subsystem_tags || [],
    required_deliverables: task.task_spec?.required_deliverables || [],
  }));
  const changedFiles = uniq(worktreeChanges.flatMap((entry) => entry.files));
  const subsystemTags = uniq(completedTasks.flatMap((task) => task.task_spec?.subsystem_tags || []));
  const policyState = summarizePipelinePolicyState(status, changePolicy, aiGate.boundary_validations || []);
  const staleClusters = buildStaleClusters(aiGate.dependency_invalidations || [], { pipelineId });
  const riskNotes = [];
  if (!ciGateOk) riskNotes.push('Repo gate is blocked by conflicts, unmanaged changes, or stale worktrees.');
  if (aiGate.status !== 'pass') riskNotes.push(aiGate.summary);
  if ((aiGate.dependency_invalidations || []).length > 0) {
    riskNotes.push('Some completed work is stale and needs revalidation after a shared boundary changed.');
  }
  if ((report.semanticConflicts?.length || 0) > 0) {
    riskNotes.push('Semantic overlap was detected between changed exported objects across worktrees.');
  }
  if (completedTasks.some((task) => task.task_spec?.risk_level === 'high')) {
    riskNotes.push('High-risk work is included in this PR and should receive explicit reviewer attention.');
  }
  if (changedFiles.some((file) => /(^|\/)(auth|payments|db|migrations?|schema|config)(\/|$)/i.test(file))) {
    riskNotes.push('Changed files touch sensitive areas such as auth, payments, schema, or config.');
  }
  const reviewerChecklist = [
    ciGateOk ? 'Repo gate passed' : 'Resolve repo gate failures before merge',
    aiGate.status === 'pass' ? 'AI merge gate passed' : `Review AI merge gate findings: ${aiGate.summary}`,
    policyState.active
      ? (policyState.missing_task_types.length > 0
        ? `Complete policy requirements: ${policyState.missing_task_types.join(', ')}`
        : `Confirm governed domains remain satisfied: ${policyState.domains.join(', ')}`)
      : null,
    completedTasks.some((task) => task.task_spec?.risk_level === 'high')
      ? 'Confirm high-risk tasks have the expected tests and docs'
      : 'Review changed files and task outcomes',
  ].filter(Boolean);
  const prTitle = status.title.startsWith('Implement:')
    ? status.title.replace(/^Implement:\s*/i, '')
    : status.title;
  const prBody = [
    '## Summary',
    ...(completedTasks.length > 0
      ? completedTasks.map((task) => `- ${task.title}`)
      : ['- No completed tasks yet']),
    '',
    '## Validation',
    `- Repo gate: ${ciGateOk ? 'pass' : 'blocked'}`,
    `- AI merge gate: ${aiGate.status}`,
    ...(policyState.active
      ? [
        `- Policy domains: ${policyState.domains.join(', ')}`,
        `- Policy enforcement: ${policyState.enforcement}`,
        `- Policy requirements: ${policyState.required_task_types.join(', ') || 'none'}`,
        `- Policy evidence: ${policyState.satisfied_task_types.map((taskType) => `${taskType}:${(policyState.evidence_by_task_type?.[taskType] || []).map((entry) => entry.task_id).join(',')}`).join(' | ') || 'none'}`,
        `- Policy missing: ${policyState.missing_task_types.join(', ') || 'none'}`,
      ]
      : []),
    ...(staleClusters.length > 0
      ? [
        `- Stale clusters: ${staleClusters.map((cluster) => `${cluster.affected_pipeline_id || cluster.affected_task_ids[0]}:${cluster.invalidation_count}`).join(' | ')}`,
      ]
      : []),
    '',
    '## Reviewer Checklist',
    ...reviewerChecklist.map((item) => `- ${item}`),
    '',
    '## Provenance',
    ...(provenance.length > 0
      ? provenance.map((entry) => `- ${entry.task_id} (${entry.task_type || 'unknown'}) via ${entry.worktree || 'unassigned'} lease ${entry.lease_id || 'none'}`)
      : ['- No completed task provenance yet']),
  ].join('\n');
  const ready = status.counts.failed === 0
    && status.counts.pending === 0
    && status.counts.in_progress === 0
    && status.counts.done > 0
    && ciGateOk
    && aiGate.status !== 'blocked';

  const markdown = [
    `# PR Summary: ${status.title}`,
    '',
    `- Pipeline: \`${pipelineId}\``,
    `- Task status: ${status.counts.done} done, ${status.counts.in_progress} in progress, ${status.counts.pending} pending, ${status.counts.failed} failed`,
    `- CI gate: ${ciGateOk ? 'pass' : 'blocked'}`,
    `- AI merge gate: ${aiGate.status}`,
    '',
    '## Completed Tasks',
    ...completedTasks.map((task) => `- ${task.title}`),
    ...(completedTasks.length === 0 ? ['- None yet'] : []),
    '',
    '## Remaining Tasks',
    ...remainingTasks.map((task) => `- [${task.status}] ${task.title}`),
    ...(remainingTasks.length === 0 ? ['- None'] : []),
    '',
    '## Worktree Changes',
    ...worktreeChanges.map((entry) => `- ${entry.worktree}: ${entry.files.length ? entry.files.join(', ') : 'no active changes'}`),
    ...(worktreeChanges.length === 0 ? ['- No active worktree assignments yet'] : []),
    '',
    '## Reviewer Notes',
    ...reviewerChecklist.map((item) => `- ${item}`),
    '',
    ...(policyState.active
      ? [
        '## Policy Requirements',
        `- Domains: ${policyState.domains.join(', ')}`,
        `- Enforcement: ${policyState.enforcement}`,
        `- Required task types: ${policyState.required_task_types.join(', ') || 'none'}`,
        `- Satisfied task types: ${policyState.satisfied_task_types.join(', ') || 'none'}`,
        `- Missing task types: ${policyState.missing_task_types.join(', ') || 'none'}`,
        ...policyState.requirement_status
          .filter((requirement) => requirement.evidence.length > 0)
          .map((requirement) => `- Evidence for ${requirement.task_type}: ${requirement.evidence.map((entry) => entry.artifact_path ? `${entry.task_id} (${entry.artifact_path})` : entry.task_id).join(', ')}`),
        ...policyState.rationale.slice(0, 5).map((item) => `- ${item}`),
        '',
      ]
      : []),
    ...(staleClusters.length > 0
      ? [
        '## Stale Clusters',
        ...staleClusters.map((cluster) => `- ${cluster.title}: ${cluster.detail} -> ${cluster.next_action}`),
        '',
      ]
      : []),
    '## Provenance',
    ...provenance.map((entry) => `- ${entry.task_id}: ${entry.title} (${entry.task_type || 'unknown'}, ${entry.worktree || 'unassigned'}, lease ${entry.lease_id || 'none'})`),
    ...(provenance.length === 0 ? ['- No completed task provenance yet'] : []),
    '',
    '## Gate Notes',
    `- Repo gate summary: ${ciGateOk ? 'clear' : 'blocked by conflicts or unmanaged changes'}`,
    `- AI merge summary: ${aiGate.summary}`,
    ...(riskNotes.length > 0 ? ['', '## Risk Notes', ...riskNotes.map((note) => `- ${note}`)] : []),
  ].join('\n');

  logAuditEvent(db, {
    eventType: 'pipeline_pr_summary',
    status: ready ? 'allowed' : 'warn',
    reasonCode: ready ? null : 'pipeline_not_ready',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      ready,
      ci_gate_ok: ciGateOk,
      ai_gate_status: aiGate.status,
    }),
  });

  return {
    ready,
    pipeline_id: pipelineId,
    title: status.title,
    pr_artifact: {
      title: prTitle,
      body: prBody,
      reviewer_checklist: reviewerChecklist,
      provenance,
      risk_notes: riskNotes,
      changed_files: changedFiles,
      subsystem_tags: subsystemTags,
      policy_state: policyState,
      stale_clusters: staleClusters,
    },
    counts: status.counts,
    ci_gate: {
      ok: ciGateOk,
      summary: ciGateOk ? 'Repo gate passed.' : 'Repo gate blocked by conflicts, unmanaged changes, or stale worktrees.',
    },
    ai_gate: {
      ok: aiGate.status !== 'blocked',
      status: aiGate.status,
      summary: aiGate.summary,
    },
    policy_state: policyState,
    stale_clusters: staleClusters,
    worktree_changes: worktreeChanges,
    markdown,
  };
}

export function buildPipelineLandingSummary(db, repoRoot, pipelineId) {
  const status = getPipelineStatus(db, pipelineId);
  const staleClusters = buildStaleClusters(listDependencyInvalidations(db, { pipelineId }), { pipelineId });
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
      strategy: 'unavailable',
      synthetic: false,
      component_branches: [],
      stale: false,
      last_failure: null,
    };
  }
  const readyToQueue = status.counts.failed === 0
    && status.counts.pending === 0
    && status.counts.in_progress === 0
    && status.counts.done > 0
    && !landingError
    && !landing.stale
    && staleClusters.length === 0
    && !landing.last_failure;
  const nextAction = staleClusters[0]?.next_action
    || (landingError
      ? `switchman pipeline status ${pipelineId}`
      : landing.last_failure?.command
        || (landing.stale
          ? `switchman pipeline land ${pipelineId} --refresh`
          : `switchman queue add --pipeline ${pipelineId}`));
  const queueItems = listMergeQueue(db)
    .filter((item) => item.source_pipeline_id === pipelineId)
    .sort((a, b) => Number.parseInt(b.id.slice(1), 10) - Number.parseInt(a.id.slice(1), 10));
  const currentQueueItem = queueItems[0] || null;
  const queueState = {
    status: currentQueueItem?.status || 'not_queued',
    item_id: currentQueueItem?.id || null,
    target_branch: currentQueueItem?.target_branch || 'main',
    merged_commit: currentQueueItem?.merged_commit || null,
    next_action: currentQueueItem?.next_action || (currentQueueItem
      ? null
      : (readyToQueue ? `switchman queue add --pipeline ${pipelineId}` : nextAction)),
    last_error_code: currentQueueItem?.last_error_code || null,
    last_error_summary: currentQueueItem?.last_error_summary || null,
  };
  const recoveryState = landing.last_recovery
    ? {
      status: landing.last_recovery.state?.status || 'prepared',
      recovery_path: landing.last_recovery.recovery_path || null,
      inspect_command: landing.last_recovery.inspect_command || null,
      resume_command: landing.last_recovery.resume_command || null,
    }
    : null;

  const markdown = [
    `# Pipeline Landing Summary: ${status.title}`,
    '',
    `- Pipeline: \`${pipelineId}\``,
    `- Ready to queue: ${readyToQueue ? 'yes' : 'no'}`,
    `- Landing branch: ${landing.branch ? `\`${landing.branch}\`` : 'not resolved yet'}`,
    `- Strategy: ${landing.strategy}`,
    `- Synthetic: ${landing.synthetic ? 'yes' : 'no'}`,
    '',
    '## Component Branches',
    ...(landing.component_branches.length > 0
      ? landing.component_branches.map((branch) => `- ${branch}`)
      : ['- None inferred yet']),
    '',
    '## Landing State',
    ...(landingError
      ? [`- ${landingError}`]
      : landing.last_failure
      ? [
        `- Failure: ${landing.last_failure.reason_code || 'landing_branch_materialization_failed'}`,
        ...(landing.last_failure.failed_branch ? [`- Failed branch: ${landing.last_failure.failed_branch}`] : []),
        ...(landing.last_failure.conflicting_files?.length ? [`- Conflicts: ${landing.last_failure.conflicting_files.join(', ')}`] : []),
      ]
      : landing.stale
        ? landing.stale_reasons.map((reason) => `- Stale: ${reason.summary}`)
        : staleClusters.length > 0
          ? staleClusters.map((cluster) => `- Stale cluster: ${cluster.title}`)
        : ['- Current and ready for queueing']),
    '',
    '## Recovery State',
    ...(recoveryState
      ? [
        `- Status: ${recoveryState.status}`,
        ...(recoveryState.recovery_path ? [`- Path: ${recoveryState.recovery_path}`] : []),
        ...(recoveryState.resume_command ? [`- Resume: ${recoveryState.resume_command}`] : []),
      ]
      : ['- No active recovery worktree']),
    '',
    ...(staleClusters.length > 0
      ? [
        '## Stale Clusters',
        ...staleClusters.map((cluster) => `- ${cluster.title}: ${cluster.detail} -> ${cluster.next_action}`),
        '',
      ]
      : []),
    '',
    '## Queue State',
    `- Status: ${queueState.status}`,
    ...(queueState.item_id ? [`- Item: ${queueState.item_id}`] : []),
    `- Target branch: ${queueState.target_branch}`,
    ...(queueState.merged_commit ? [`- Merged commit: ${queueState.merged_commit}`] : []),
    ...(queueState.last_error_summary ? [`- Queue error: ${queueState.last_error_summary}`] : []),
    '',
    `## Next Action`,
    `- ${queueState.next_action || nextAction}`,
  ].join('\n');

  return {
    pipeline_id: pipelineId,
    title: status.title,
    ready_to_queue: readyToQueue,
    counts: status.counts,
    landing,
    recovery_state: recoveryState,
    stale_clusters: staleClusters,
    queue_state: queueState,
    landing_error: landingError,
    next_action: queueState.next_action || nextAction,
    markdown,
  };
}

export async function exportPipelinePrBundle(db, repoRoot, pipelineId, outputDir = null) {
  const summary = await buildPipelinePrSummary(db, repoRoot, pipelineId);
  const landingSummary = buildPipelineLandingSummary(db, repoRoot, pipelineId);
  const bundleDir = outputDir || join(repoRoot, '.switchman', 'pipelines', pipelineId);
  mkdirSync(bundleDir, { recursive: true });

  const summaryJsonPath = join(bundleDir, 'pr-summary.json');
  const summaryMarkdownPath = join(bundleDir, 'pr-summary.md');
  const prBodyPath = join(bundleDir, 'pr-body.md');
  const landingSummaryJsonPath = join(bundleDir, 'pipeline-landing-summary.json');
  const landingSummaryMarkdownPath = join(bundleDir, 'pipeline-landing-summary.md');

  writeFileSync(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(summaryMarkdownPath, `${summary.markdown}\n`);
  writeFileSync(prBodyPath, `${summary.pr_artifact.body}\n`);
  writeFileSync(landingSummaryJsonPath, `${JSON.stringify(landingSummary, null, 2)}\n`);
  writeFileSync(landingSummaryMarkdownPath, `${landingSummary.markdown}\n`);

  logAuditEvent(db, {
    eventType: 'pipeline_pr_bundle_exported',
    status: 'allowed',
    reasonCode: null,
    details: JSON.stringify({
      pipeline_id: pipelineId,
      output_dir: bundleDir,
      files: [summaryJsonPath, summaryMarkdownPath, prBodyPath, landingSummaryJsonPath, landingSummaryMarkdownPath],
    }),
  });

  return {
    pipeline_id: pipelineId,
    output_dir: bundleDir,
    files: {
      summary_json: summaryJsonPath,
      summary_markdown: summaryMarkdownPath,
      pr_body_markdown: prBodyPath,
      landing_summary_json: landingSummaryJsonPath,
      landing_summary_markdown: landingSummaryMarkdownPath,
    },
    summary,
    landing_summary: landingSummary,
  };
}

function resolvePipelineBranchForTask(worktreesByName, task) {
  const worktreeName = task.worktree || task.suggested_worktree || null;
  const branch = worktreeName ? worktreesByName.get(worktreeName)?.branch || null : null;
  return branch && branch !== 'main' && branch !== 'unknown' ? branch : null;
}

function collectPipelineLandingCandidates(db, pipelineStatus) {
  const worktreesByName = new Map(listWorktrees(db).map((worktree) => [worktree.name, worktree]));
  const orderedBranches = [];
  const branchToWorktree = new Map();

  for (const task of pipelineStatus.tasks) {
    const branch = resolvePipelineBranchForTask(worktreesByName, task);
    if (!branch) continue;
    if (!branchToWorktree.has(branch) && task.worktree) {
      branchToWorktree.set(branch, task.worktree);
    }
    if (!orderedBranches.includes(branch)) {
      orderedBranches.push(branch);
    }
  }

  const implementationBranches = uniq(
    pipelineStatus.tasks
      .filter((task) => task.task_spec?.task_type === 'implementation')
      .map((task) => resolvePipelineBranchForTask(worktreesByName, task))
      .filter(Boolean),
  );
  const candidateBranches = uniq(orderedBranches);
  const prioritizedBranches = [
    ...implementationBranches,
    ...candidateBranches.filter((branch) => !implementationBranches.includes(branch)),
  ];

  return {
    implementationBranches,
    candidateBranches,
    prioritizedBranches,
    branchToWorktree,
    worktreesByName,
  };
}

function getPipelineLandingBranchName(pipelineId, landingBranch = null) {
  return landingBranch || `switchman/pipeline-landing/${pipelineId}`;
}

function listPipelineLandingEvents(db, pipelineId, branch) {
  return listAuditEvents(db, {
    eventType: 'pipeline_landing_branch_materialized',
    status: 'allowed',
    limit: 500,
  }).flatMap((event) => {
    try {
      const details = JSON.parse(event.details || '{}');
      if (details.pipeline_id !== pipelineId || details.branch !== branch) {
        return [];
      }
      return [{
        audit_id: event.id,
        created_at: event.created_at,
        ...details,
      }];
    } catch {
      return [];
    }
  });
}

function getLatestLandingResolvedEvent(db, pipelineId, branch) {
  return listAuditEvents(db, {
    eventType: 'pipeline_landing_recovery_resumed',
    status: 'allowed',
    limit: 200,
  }).flatMap((event) => {
    try {
      const details = JSON.parse(event.details || '{}');
      if (details.pipeline_id !== pipelineId || details.branch !== branch) {
        return [];
      }
      return [{
        audit_id: event.id,
        created_at: event.created_at,
        ...details,
      }];
    } catch {
      return [];
    }
  })[0] || null;
}

function getLatestLandingRecoveryPrepared(db, pipelineId, branch) {
  return listAuditEvents(db, {
    eventType: 'pipeline_landing_recovery_prepared',
    status: 'allowed',
    limit: 200,
  }).flatMap((event) => {
    try {
      const details = JSON.parse(event.details || '{}');
      if (details.pipeline_id !== pipelineId || details.branch !== branch) {
        return [];
      }
      return [{
        audit_id: event.id,
        created_at: event.created_at,
        ...details,
      }];
    } catch {
      return [];
    }
  })[0] || null;
}

function getLatestLandingRecoveryCleared(db, pipelineId, branch) {
  return listAuditEvents(db, {
    eventType: 'pipeline_landing_recovery_cleared',
    status: 'allowed',
    limit: 200,
  }).flatMap((event) => {
    try {
      const details = JSON.parse(event.details || '{}');
      if (details.pipeline_id !== pipelineId || details.branch !== branch) {
        return [];
      }
      return [{
        audit_id: event.id,
        created_at: event.created_at,
        ...details,
      }];
    } catch {
      return [];
    }
  })[0] || null;
}

function buildRecoveryState(repoRoot, recoveryRecord, latestResolved) {
  if (!recoveryRecord) return null;
  const recoveryPath = recoveryRecord.recovery_path || null;
  const pathExists = recoveryPath ? existsSync(recoveryPath) : false;
  const normalizedRecoveryPath = recoveryPath
    ? (pathExists ? realpathSync(recoveryPath) : recoveryPath)
    : null;
  const tracked = recoveryPath
    ? listGitWorktrees(repoRoot).some((worktree) => worktree.path === recoveryPath || worktree.path === normalizedRecoveryPath)
    : false;
  const resolved = Boolean(latestResolved && latestResolved.audit_id > recoveryRecord.audit_id);
  return {
    path: recoveryPath,
    exists: pathExists,
    tracked,
    status: resolved ? (pathExists ? 'resolved' : 'resolved_missing') : (pathExists ? 'active' : 'missing'),
  };
}

function getLatestLandingFailure(db, pipelineId, branch) {
  return listAuditEvents(db, {
    eventType: 'pipeline_landing_branch_materialized',
    status: 'denied',
    limit: 200,
  }).flatMap((event) => {
    try {
      const details = JSON.parse(event.details || '{}');
      if (details.pipeline_id !== pipelineId || details.branch !== branch) {
        return [];
      }
      return [{
        audit_id: event.id,
        created_at: event.created_at,
        reason_code: event.reason_code || null,
        ...details,
      }];
    } catch {
      return [];
    }
  })[0] || null;
}

function collectBranchHeadCommits(repoRoot, branches) {
  return Object.fromEntries(
    branches.map((branch) => [branch, gitRevParse(repoRoot, branch)]),
  );
}

export function getPipelineLandingBranchStatus(
  db,
  repoRoot,
  pipelineId,
  {
    baseBranch = 'main',
    landingBranch = null,
    requireCompleted = true,
  } = {},
) {
  const pipelineStatus = getPipelineStatus(db, pipelineId);
  if (requireCompleted) {
    const unfinishedTasks = pipelineStatus.tasks.filter((task) => task.status !== 'done');
    if (unfinishedTasks.length > 0) {
      throw new Error(`Pipeline ${pipelineId} is not ready to land. Complete remaining tasks first: ${unfinishedTasks.map((task) => task.id).join(', ')}.`);
    }
  }

  const { candidateBranches, prioritizedBranches } = collectPipelineLandingCandidates(db, pipelineStatus);
  if (candidateBranches.length === 0) {
    throw new Error(`Pipeline ${pipelineId} has no landed worktree branch to materialize.`);
  }

  if (candidateBranches.length === 1) {
    const branch = candidateBranches[0];
    return {
      pipeline_id: pipelineId,
      branch,
      base_branch: baseBranch,
      synthetic: false,
      branch_exists: Boolean(gitRevParse(repoRoot, branch)),
      branch_head_commit: gitRevParse(repoRoot, branch),
      component_branches: [branch],
      component_commits: { [branch]: gitRevParse(repoRoot, branch) },
      strategy: 'single_branch',
      stale: false,
      stale_reasons: [],
      last_materialized: null,
    };
  }

  const resolvedLandingBranch = getPipelineLandingBranchName(pipelineId, landingBranch);
  const branchExists = gitBranchExists(repoRoot, resolvedLandingBranch);
  const branchHeadCommit = branchExists ? gitRevParse(repoRoot, resolvedLandingBranch) : null;
  const baseCommit = gitRevParse(repoRoot, baseBranch);
  const componentCommits = collectBranchHeadCommits(repoRoot, prioritizedBranches);
  const latestMaterialized = listPipelineLandingEvents(db, pipelineId, resolvedLandingBranch)[0] || null;
  const latestResolved = getLatestLandingResolvedEvent(db, pipelineId, resolvedLandingBranch);
  const latestRecoveryPreparedCandidate = getLatestLandingRecoveryPrepared(db, pipelineId, resolvedLandingBranch);
  const latestRecoveryCleared = getLatestLandingRecoveryCleared(db, pipelineId, resolvedLandingBranch);
  const latestRecoveryPrepared = latestRecoveryPreparedCandidate
    && (!latestRecoveryCleared || latestRecoveryPreparedCandidate.audit_id > latestRecoveryCleared.audit_id)
    ? latestRecoveryPreparedCandidate
    : null;
  const recoveryState = buildRecoveryState(repoRoot, latestRecoveryPrepared, latestResolved);
  const latestEvent = latestResolved && (!latestMaterialized || latestResolved.audit_id > latestMaterialized.audit_id)
    ? latestResolved
    : latestMaterialized;
  const latestFailureCandidate = getLatestLandingFailure(db, pipelineId, resolvedLandingBranch);
  const latestFailure = latestFailureCandidate && (!latestEvent || latestFailureCandidate.audit_id > latestEvent.audit_id)
    ? latestFailureCandidate
    : null;
  const staleReasons = [];

  if (!latestEvent) {
    staleReasons.push({
      code: 'not_materialized',
      summary: 'Landing branch has not been materialized yet.',
    });
  } else {
    if (!branchExists) {
      staleReasons.push({
        code: 'landing_branch_missing',
        summary: `Landing branch ${resolvedLandingBranch} no longer exists.`,
      });
    }

    const recordedComponents = Array.isArray(latestEvent.component_branches)
      ? latestEvent.component_branches
      : [];
    if (recordedComponents.join('\n') !== prioritizedBranches.join('\n')) {
      staleReasons.push({
        code: 'component_set_changed',
        summary: 'The pipeline now resolves to a different set of component branches.',
      });
    }

    if (latestEvent.base_commit && baseCommit && latestEvent.base_commit !== baseCommit) {
      staleReasons.push({
        code: 'base_branch_moved',
        summary: `${baseBranch} moved from ${latestEvent.base_commit.slice(0, 12)} to ${baseCommit.slice(0, 12)}.`,
      });
    }

    const recordedCommits = latestEvent.component_commits || {};
    for (const branch of prioritizedBranches) {
      const previousCommit = recordedCommits[branch] || null;
      const currentCommit = componentCommits[branch] || null;
      if (previousCommit && currentCommit && previousCommit !== currentCommit) {
        staleReasons.push({
          code: 'component_branch_moved',
          branch,
          summary: `${branch} moved from ${previousCommit.slice(0, 12)} to ${currentCommit.slice(0, 12)}.`,
        });
      }
    }

    if (
      latestEvent.head_commit &&
      branchHeadCommit &&
      latestEvent.head_commit !== branchHeadCommit
    ) {
      staleReasons.push({
        code: 'landing_branch_drifted',
        summary: `Landing branch head changed from ${latestEvent.head_commit.slice(0, 12)} to ${branchHeadCommit.slice(0, 12)} outside Switchman.`,
      });
    }
  }

  return {
    pipeline_id: pipelineId,
    branch: resolvedLandingBranch,
    base_branch: baseBranch,
    synthetic: true,
    branch_exists: branchExists,
    branch_head_commit: branchHeadCommit,
    component_branches: prioritizedBranches,
    component_commits: componentCommits,
    strategy: 'synthetic_integration_branch',
    stale: staleReasons.some((reason) => reason.code !== 'not_materialized'),
    stale_reasons: staleReasons.filter((reason) => reason.code !== 'not_materialized'),
    last_failure: latestFailure ? {
      audit_id: latestFailure.audit_id,
      created_at: latestFailure.created_at,
      reason_code: latestFailure.reason_code || null,
      failed_branch: latestFailure.failed_branch || null,
      conflicting_files: Array.isArray(latestFailure.conflicting_files) ? latestFailure.conflicting_files : [],
      output: latestFailure.output || null,
      command: latestFailure.command || null,
      next_action: latestFailure.next_action || null,
    } : null,
    last_recovery: latestRecoveryPrepared ? {
      audit_id: latestRecoveryPrepared.audit_id,
      created_at: latestRecoveryPrepared.created_at,
      recovery_path: latestRecoveryPrepared.recovery_path || null,
      failed_branch: latestRecoveryPrepared.failed_branch || null,
      conflicting_files: Array.isArray(latestRecoveryPrepared.conflicting_files) ? latestRecoveryPrepared.conflicting_files : [],
      inspect_command: latestRecoveryPrepared.inspect_command || null,
      resume_command: latestRecoveryPrepared.resume_command || null,
      state: recoveryState,
    } : null,
    last_materialized: latestEvent ? {
      audit_id: latestEvent.audit_id,
      created_at: latestEvent.created_at,
      head_commit: latestEvent.head_commit || null,
      base_commit: latestEvent.base_commit || null,
      component_branches: Array.isArray(latestEvent.component_branches) ? latestEvent.component_branches : [],
      component_commits: latestEvent.component_commits || {},
    } : null,
  };
}

export function resolvePipelineLandingTarget(
  db,
  repoRoot,
  pipelineStatus,
  {
    explicitHeadBranch = null,
    requireCompleted = false,
    allowCurrentBranchFallback = true,
  } = {},
) {
  if (explicitHeadBranch) {
    return {
      branch: explicitHeadBranch,
      worktree: null,
      strategy: 'explicit',
    };
  }

  if (requireCompleted) {
    const unfinishedTasks = pipelineStatus.tasks.filter((task) => task.status !== 'done');
    if (unfinishedTasks.length > 0) {
      throw new Error(`Pipeline ${pipelineStatus.pipeline_id} is not ready to queue. Complete remaining tasks first: ${unfinishedTasks.map((task) => task.id).join(', ')}.`);
    }
  }

  const { implementationBranches, candidateBranches, branchToWorktree } = collectPipelineLandingCandidates(db, pipelineStatus);
  if (implementationBranches.length === 1) {
    const branch = implementationBranches[0];
    const worktree = branchToWorktree.get(branch) || null;
    return { branch, worktree, strategy: 'implementation_branch' };
  }

  if (candidateBranches.length === 1) {
    const branch = candidateBranches[0];
    const worktree = branchToWorktree.get(branch) || null;
    return { branch, worktree, strategy: 'single_branch' };
  }

  if (allowCurrentBranchFallback) {
    const currentBranch = getWorktreeBranch(repoRoot);
    if (currentBranch && currentBranch !== 'main') {
      return { branch: currentBranch, worktree: null, strategy: 'current_branch' };
    }
  }

  throw new Error(`Pipeline ${pipelineStatus.pipeline_id} spans multiple branches (${candidateBranches.join(', ') || 'none inferred'}). Queue a branch or worktree explicitly.`);
}

export function materializePipelineLandingBranch(
  db,
  repoRoot,
  pipelineId,
  {
    baseBranch = 'main',
    landingBranch = null,
    requireCompleted = true,
    refresh = false,
  } = {},
) {
  const pipelineStatus = getPipelineStatus(db, pipelineId);
  const { candidateBranches, prioritizedBranches, branchToWorktree } = collectPipelineLandingCandidates(db, pipelineStatus);
  const landingStatus = getPipelineLandingBranchStatus(db, repoRoot, pipelineId, {
    baseBranch,
    landingBranch,
    requireCompleted,
  });

  if (candidateBranches.length === 1) {
    const branch = candidateBranches[0];
    return {
      pipeline_id: pipelineId,
      branch,
      base_branch: baseBranch,
      worktree: branchToWorktree.get(branch) || null,
      synthetic: false,
      component_branches: [branch],
      strategy: 'single_branch',
      head_commit: null,
    };
  }

  if (landingStatus.last_materialized && !landingStatus.stale) {
    return {
      pipeline_id: pipelineId,
      branch: landingStatus.branch,
      base_branch: baseBranch,
      worktree: null,
      synthetic: true,
      component_branches: landingStatus.component_branches,
      component_commits: landingStatus.component_commits,
      strategy: 'synthetic_integration_branch',
      head_commit: landingStatus.branch_head_commit,
      refreshed: false,
      reused_existing: true,
      stale: false,
      stale_reasons: [],
      last_materialized: landingStatus.last_materialized,
    };
  }

  if (landingStatus.stale && !refresh) {
    const summaries = landingStatus.stale_reasons.map((reason) => reason.summary).join(' ');
    throw new Error(`Landing branch ${landingStatus.branch} is stale. ${summaries} Run \`switchman pipeline land ${pipelineId} --refresh${landingBranch ? ` --branch ${landingBranch}` : ''}\` to rebuild it.`);
  }

  const resolvedLandingBranch = getPipelineLandingBranchName(pipelineId, landingBranch);
  let materialized;
  try {
    materialized = gitMaterializeIntegrationBranch(repoRoot, {
      branch: resolvedLandingBranch,
      baseBranch,
      mergeBranches: prioritizedBranches,
    });
  } catch (err) {
    const reasonCode = err?.code || 'landing_branch_materialization_failed';
    const nextAction = reasonCode === 'landing_branch_merge_conflict'
      ? `open a recovery worktree with switchman pipeline land ${pipelineId} --recover`
      : reasonCode === 'landing_branch_missing_component'
        ? `restore the missing branch and rerun switchman pipeline land ${pipelineId} --refresh`
        : reasonCode === 'landing_branch_missing_base'
          ? `restore ${baseBranch} and rerun switchman pipeline land ${pipelineId} --refresh`
          : `inspect the landing failure and rerun switchman pipeline land ${pipelineId} --refresh`;
    logAuditEvent(db, {
      eventType: 'pipeline_landing_branch_materialized',
      status: 'denied',
      reasonCode,
      details: JSON.stringify({
        pipeline_id: pipelineId,
        branch: resolvedLandingBranch,
        base_branch: baseBranch,
        component_branches: prioritizedBranches,
        failed_branch: err?.details?.failed_branch || null,
        conflicting_files: err?.details?.conflicting_files || [],
        output: err?.details?.output || String(err.message || '').slice(0, 1000),
        command: reasonCode === 'landing_branch_merge_conflict'
          ? `switchman pipeline land ${pipelineId} --recover`
          : `switchman pipeline land ${pipelineId} --refresh`,
        next_action: nextAction,
      }),
    });
    const wrapped = new Error(`${String(err.message || 'Landing branch materialization failed.')}\nnext: switchman explain landing ${pipelineId}`);
    wrapped.code = reasonCode;
    throw wrapped;
  }
  const baseCommit = gitRevParse(repoRoot, baseBranch);
  const componentCommits = collectBranchHeadCommits(repoRoot, prioritizedBranches);

  logAuditEvent(db, {
    eventType: 'pipeline_landing_branch_materialized',
    status: 'allowed',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      branch: resolvedLandingBranch,
      base_branch: baseBranch,
      base_commit: baseCommit,
      component_branches: prioritizedBranches,
      component_commits: componentCommits,
      head_commit: materialized.head_commit,
    }),
  });

  return {
    pipeline_id: pipelineId,
    branch: resolvedLandingBranch,
    base_branch: baseBranch,
    worktree: null,
    synthetic: true,
    component_branches: prioritizedBranches,
    component_commits: componentCommits,
    strategy: 'synthetic_integration_branch',
    head_commit: materialized.head_commit,
    refreshed: refresh || Boolean(landingStatus.last_materialized),
    reused_existing: false,
    stale: false,
    stale_reasons: [],
    last_materialized: {
      head_commit: materialized.head_commit,
      base_commit: baseCommit,
      component_branches: prioritizedBranches,
      component_commits: componentCommits,
    },
  };
}

export function getPipelineLandingExplainReport(
  db,
  repoRoot,
  pipelineId,
  options = {},
) {
  const landing = getPipelineLandingBranchStatus(db, repoRoot, pipelineId, {
    requireCompleted: false,
    ...options,
  });
  const nextAction = landing.last_failure?.next_action
    || (landing.stale
      ? `switchman pipeline land ${pipelineId} --refresh`
      : landing.synthetic
        ? `switchman queue add --pipeline ${pipelineId}`
        : `switchman queue add ${landing.branch}`);
  return {
    pipeline_id: pipelineId,
    landing,
    next_action: nextAction,
  };
}

export function preparePipelineLandingRecovery(
  db,
  repoRoot,
  pipelineId,
  {
    baseBranch = 'main',
    landingBranch = null,
    recoveryPath = null,
    replaceExisting = false,
  } = {},
) {
  const landing = getPipelineLandingBranchStatus(db, repoRoot, pipelineId, {
    baseBranch,
    landingBranch,
    requireCompleted: true,
  });
  if (!landing.synthetic) {
    throw new Error(`Pipeline ${pipelineId} does not need a synthetic landing recovery worktree.`);
  }
  if (landing.last_failure?.reason_code !== 'landing_branch_merge_conflict') {
    throw new Error(`Pipeline ${pipelineId} does not have a merge-conflict landing failure to recover.`);
  }
  if (landing.last_recovery?.state?.status && !replaceExisting) {
    throw new Error(`Recovery worktree already exists for ${pipelineId} at ${landing.last_recovery.recovery_path}. Reuse it or rerun with \`switchman pipeline land ${pipelineId} --recover --replace-recovery\`.`);
  }
  if (landing.last_recovery?.state?.path && replaceExisting) {
    cleanupPipelineLandingRecovery(db, repoRoot, pipelineId, {
      baseBranch,
      landingBranch,
      recoveryPath: landing.last_recovery.state.path,
      reason: 'replaced',
    });
  }

  const resolvedRecoveryPath = recoveryPath || join(
    tmpdir(),
    `${basename(repoRoot)}-landing-recover-${pipelineId}-${Date.now()}`,
  );
  const prepared = gitPrepareIntegrationRecoveryWorktree(repoRoot, {
    branch: landing.branch,
    baseBranch,
    mergeBranches: landing.component_branches,
    recoveryPath: resolvedRecoveryPath,
  });
  if (prepared.ok) {
    throw new Error(`Pipeline ${pipelineId} no longer has an unresolved landing merge conflict to recover.`);
  }

  const inspectCommand = `git -C ${JSON.stringify(prepared.recovery_path)} status`;
  const resumeCommand = `switchman queue add --pipeline ${pipelineId}`;

  logAuditEvent(db, {
    eventType: 'pipeline_landing_recovery_prepared',
    status: 'allowed',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      branch: landing.branch,
      base_branch: baseBranch,
      recovery_path: prepared.recovery_path,
      failed_branch: prepared.failed_branch,
      conflicting_files: prepared.conflicting_files,
      inspect_command: inspectCommand,
      resume_command: resumeCommand,
    }),
  });

  return {
    pipeline_id: pipelineId,
    branch: landing.branch,
    base_branch: baseBranch,
    recovery_path: prepared.recovery_path,
    failed_branch: prepared.failed_branch,
    conflicting_files: prepared.conflicting_files,
    inspect_command: inspectCommand,
    resume_command: resumeCommand,
  };
}

export function resumePipelineLandingRecovery(
  db,
  repoRoot,
  pipelineId,
  {
    baseBranch = 'main',
    landingBranch = null,
    recoveryPath = null,
  } = {},
) {
  const landing = getPipelineLandingBranchStatus(db, repoRoot, pipelineId, {
    baseBranch,
    landingBranch,
    requireCompleted: true,
  });
  if (!landing.synthetic) {
    throw new Error(`Pipeline ${pipelineId} does not need a synthetic landing recovery worktree.`);
  }

  const resolvedRecoveryPath = recoveryPath || landing.last_recovery?.recovery_path || null;
  if (!resolvedRecoveryPath) {
    throw new Error(`No recovery worktree is recorded for ${pipelineId}. Run \`switchman pipeline land ${pipelineId} --recover\` first.`);
  }

  const currentBranch = getWorktreeBranch(resolvedRecoveryPath);
  if (currentBranch !== landing.branch) {
    throw new Error(`Recovery worktree must be on ${landing.branch}, but is on ${currentBranch || 'no branch'}.`);
  }

  const statusResult = spawnSync('git', ['status', '--porcelain'], {
    cwd: resolvedRecoveryPath,
    encoding: 'utf8',
  });
  if (statusResult.status !== 0) {
    throw new Error(`Could not inspect recovery worktree ${resolvedRecoveryPath}.`);
  }
  const pendingChanges = String(statusResult.stdout || '').trim();
  if (pendingChanges) {
    throw new Error(`Recovery worktree ${resolvedRecoveryPath} still has unresolved or uncommitted changes. Commit the resolved landing branch first.`);
  }

  const recoveredHead = gitRevParse(resolvedRecoveryPath, 'HEAD');
  const branchHead = gitRevParse(repoRoot, landing.branch);
  if (!recoveredHead || !branchHead || recoveredHead !== branchHead) {
    throw new Error(`Recovery worktree ${resolvedRecoveryPath} is not aligned with ${landing.branch}. Push or commit the resolved landing branch there first.`);
  }

  const componentCommits = collectBranchHeadCommits(repoRoot, landing.component_branches);
  logAuditEvent(db, {
    eventType: 'pipeline_landing_recovery_resumed',
    status: 'allowed',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      branch: landing.branch,
      base_branch: baseBranch,
      base_commit: gitRevParse(repoRoot, baseBranch),
      head_commit: branchHead,
      component_branches: landing.component_branches,
      component_commits: componentCommits,
      recovery_path: resolvedRecoveryPath,
      resume_command: `switchman queue add --pipeline ${pipelineId}`,
    }),
  });

  return {
    pipeline_id: pipelineId,
    branch: landing.branch,
    base_branch: baseBranch,
    recovery_path: resolvedRecoveryPath,
    head_commit: branchHead,
    resume_command: `switchman queue add --pipeline ${pipelineId}`,
  };
}

export function cleanupPipelineLandingRecovery(
  db,
  repoRoot,
  pipelineId,
  {
    baseBranch = 'main',
    landingBranch = null,
    recoveryPath = null,
    reason = 'manual_cleanup',
  } = {},
) {
  const landing = getPipelineLandingBranchStatus(db, repoRoot, pipelineId, {
    baseBranch,
    landingBranch,
    requireCompleted: true,
  });
  const targetPath = recoveryPath || landing.last_recovery?.recovery_path || null;
  if (!targetPath) {
    throw new Error(`No recovery worktree is recorded for ${pipelineId}.`);
  }

  const exists = existsSync(targetPath);
  const normalizedTargetPath = exists ? realpathSync(targetPath) : targetPath;
  const tracked = listGitWorktrees(repoRoot).some((worktree) =>
    worktree.path === targetPath || worktree.path === normalizedTargetPath,
  );
  if (tracked && exists) {
    gitRemoveWorktree(repoRoot, targetPath);
  }

  logAuditEvent(db, {
    eventType: 'pipeline_landing_recovery_cleared',
    status: 'allowed',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      branch: landing.branch,
      recovery_path: targetPath,
      existed: exists,
      tracked,
      reason,
    }),
  });

  return {
    pipeline_id: pipelineId,
    branch: landing.branch,
    recovery_path: targetPath,
    existed: exists,
    tracked,
    removed: tracked && exists,
    reason,
  };
}

export function preparePipelineLandingTarget(
  db,
  repoRoot,
  pipelineId,
  {
    baseBranch = 'main',
    explicitHeadBranch = null,
    requireCompleted = false,
    allowCurrentBranchFallback = true,
    landingBranch = null,
  } = {},
) {
  const pipelineStatus = getPipelineStatus(db, pipelineId);
  const completedPipeline = pipelineStatus.tasks.length > 0 && pipelineStatus.tasks.every((task) => task.status === 'done');
  const { candidateBranches } = collectPipelineLandingCandidates(db, pipelineStatus);

  if (!explicitHeadBranch && completedPipeline && candidateBranches.length > 1) {
    return materializePipelineLandingBranch(db, repoRoot, pipelineId, {
      baseBranch,
      landingBranch,
      requireCompleted: true,
      refresh: true,
    });
  }

  try {
    const resolved = resolvePipelineLandingTarget(db, repoRoot, pipelineStatus, {
      explicitHeadBranch,
      requireCompleted,
      allowCurrentBranchFallback,
    });
    return {
      pipeline_id: pipelineId,
      ...resolved,
      synthetic: false,
      component_branches: [resolved.branch],
      head_commit: null,
    };
  } catch (err) {
    if (!String(err.message || '').includes('spans multiple branches')) {
      throw err;
    }
    return materializePipelineLandingBranch(db, repoRoot, pipelineId, {
      baseBranch,
      landingBranch,
      requireCompleted: true,
      refresh: true,
    });
  }
}

export async function publishPipelinePr(
  db,
  repoRoot,
  pipelineId,
  {
    baseBranch = 'main',
    headBranch = null,
    draft = false,
    ghCommand = 'gh',
    outputDir = null,
  } = {},
) {
  const policyGate = await evaluatePipelinePolicyGate(db, repoRoot, pipelineId);
  if (!policyGate.ok) {
    logAuditEvent(db, {
      eventType: 'pipeline_pr_published',
      status: 'denied',
      reasonCode: policyGate.reason_code,
      details: JSON.stringify({
        pipeline_id: pipelineId,
        base_branch: baseBranch,
        head_branch: headBranch,
        policy_state: policyGate.policy_state,
        next_action: policyGate.next_action,
      }),
    });
    throw new Error(`${policyGate.summary} Next: ${policyGate.next_action}`);
  }

  const bundle = await exportPipelinePrBundle(db, repoRoot, pipelineId, outputDir);
  const resolvedLandingTarget = preparePipelineLandingTarget(db, repoRoot, pipelineId, {
    baseBranch,
    explicitHeadBranch: headBranch,
    requireCompleted: false,
    allowCurrentBranchFallback: true,
  });
  const resolvedHeadBranch = resolvedLandingTarget.branch;

  const args = [
    'pr',
    'create',
    '--base',
    baseBranch,
    '--head',
    resolvedHeadBranch,
    '--title',
    bundle.summary.pr_artifact.title,
    '--body-file',
    bundle.files.pr_body_markdown,
  ];

  if (draft) {
    args.push('--draft');
  }

  const result = spawnSync(ghCommand, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  const ok = !result.error && result.status === 0;
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();

  logAuditEvent(db, {
    eventType: 'pipeline_pr_published',
    status: ok ? 'allowed' : 'denied',
    reasonCode: ok ? null : 'pr_publish_failed',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      base_branch: baseBranch,
      head_branch: resolvedHeadBranch,
      gh_command: ghCommand,
      draft,
      exit_code: result.status,
      output: output.slice(0, 500),
    }),
  });

  if (!ok) {
    throw new Error(result.error?.message || output || `gh pr create failed with status ${result.status}`);
  }

  return {
    pipeline_id: pipelineId,
    base_branch: baseBranch,
    head_branch: resolvedHeadBranch,
    landing_strategy: resolvedLandingTarget.strategy,
    draft,
    bundle,
    output,
  };
}

export async function commentPipelinePr(
  db,
  repoRoot,
  pipelineId,
  {
    prNumber,
    ghCommand = 'gh',
    outputDir = null,
    updateExisting = false,
  } = {},
) {
  if (!prNumber) {
    throw new Error('A pull request number is required.');
  }

  const bundle = await exportPipelinePrBundle(db, repoRoot, pipelineId, outputDir);
  const args = [
    'pr',
    'comment',
    String(prNumber),
    '--body-file',
    bundle.files.landing_summary_markdown,
  ];

  if (updateExisting) {
    args.push('--edit-last', '--create-if-none');
  }

  const result = spawnSync(ghCommand, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  const ok = !result.error && result.status === 0;
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();

  logAuditEvent(db, {
    eventType: 'pipeline_pr_commented',
    status: ok ? 'allowed' : 'denied',
    reasonCode: ok ? null : 'pr_comment_failed',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      pr_number: String(prNumber),
      gh_command: ghCommand,
      update_existing: updateExisting,
      body_file: bundle.files.landing_summary_markdown,
      exit_code: result.status,
      output: output.slice(0, 500),
    }),
  });

  if (!ok) {
    throw new Error(result.error?.message || output || `gh pr comment failed with status ${result.status}`);
  }

  return {
    pipeline_id: pipelineId,
    pr_number: String(prNumber),
    bundle,
    output,
    updated_existing: updateExisting,
  };
}

export async function syncPipelinePr(
  db,
  repoRoot,
  pipelineId,
  {
    prNumber,
    ghCommand = 'gh',
    outputDir = null,
    updateExisting = true,
  } = {},
) {
  const bundle = await exportPipelinePrBundle(db, repoRoot, pipelineId, outputDir);
  let comment = null;

  if (prNumber) {
    const args = [
      'pr',
      'comment',
      String(prNumber),
      '--body-file',
      bundle.files.landing_summary_markdown,
    ];

    if (updateExisting) {
      args.push('--edit-last', '--create-if-none');
    }

    const result = spawnSync(ghCommand, args, {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const ok = !result.error && result.status === 0;
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();

    logAuditEvent(db, {
      eventType: 'pipeline_pr_synced',
      status: ok ? 'allowed' : 'denied',
      reasonCode: ok ? null : 'pr_sync_failed',
      details: JSON.stringify({
        pipeline_id: pipelineId,
        pr_number: String(prNumber),
        gh_command: ghCommand,
        update_existing: updateExisting,
        body_file: bundle.files.landing_summary_markdown,
        exit_code: result.status,
        output: output.slice(0, 500),
      }),
    });

    if (!ok) {
      throw new Error(result.error?.message || output || `gh pr comment failed with status ${result.status}`);
    }

    comment = {
      pr_number: String(prNumber),
      output,
      updated_existing: updateExisting,
    };
  }

  return {
    pipeline_id: pipelineId,
    bundle,
    comment,
  };
}

export async function createPipelineFollowupTasks(db, repoRoot, pipelineId) {
  const status = getPipelineStatus(db, pipelineId);
  const report = await scanAllWorktrees(db, repoRoot);
  const aiGate = await runAiMergeGate(db, repoRoot);
  const changePolicy = loadChangePolicy(repoRoot);
  const existingTitles = new Set(status.tasks.map((task) => task.title));
  const hasPlannedTestsTask = status.tasks.some((task) =>
    task.task_spec?.task_type === 'tests' && !task.title.startsWith('Add missing tests'),
  );
  const hasGovernanceTask = status.tasks.some((task) => task.task_spec?.task_type === 'governance');
  const created = [];
  const pipelineTasks = [...status.tasks];

  function maybeCreateTask(title, description) {
    if (existingTitles.has(title)) return;
    const taskId = nextPipelineTaskId(pipelineTasks, pipelineId);
    const taskSpec = buildTaskSpec({
      pipelineId,
      taskId,
      title,
      issueTitle: status.title,
      issueDescription: status.description,
      dependencies: [],
    });
    createTask(db, {
      id: taskId,
      title,
      description: [
        `[Pipeline ${pipelineId}]`,
        description,
      ].filter(Boolean).join('\n'),
      priority: status.priority,
    });
    upsertTaskSpec(db, taskId, taskSpec);
    pipelineTasks.push({ id: taskId, title, task_spec: taskSpec });
    existingTitles.add(title);
    created.push({ id: taskId, title, description, task_spec: taskSpec });
  }

  for (const entry of report.unclaimedChanges) {
    maybeCreateTask(
      `Govern unmanaged changes in ${entry.worktree}`,
      `Files: ${entry.files.join(', ')}\nReasons: ${entry.reasons.map((reason) => `${reason.file}:${reason.reason_code}`).join(', ')}`,
    );
  }

  for (const conflict of report.conflicts) {
    maybeCreateTask(
      `Resolve merge conflict between ${conflict.worktreeA} and ${conflict.worktreeB}`,
      `Conflicting files: ${conflict.conflictingFiles.join(', ')}`,
    );
  }

  if (!hasGovernanceTask && aiGate.status === 'blocked') {
    const blockedPairs = aiGate.pairs.filter((item) => item.status !== 'pass');
    if (blockedPairs.length > 0) {
      maybeCreateTask(
        'Review blocked AI merge findings',
        blockedPairs
          .map((pair) => `${pair.worktree_a} <-> ${pair.worktree_b}\n${pair.reasons.join('\n')}`)
          .join('\n\n'),
      );
    }
  }

  for (const worktree of aiGate.worktrees) {
    if (!hasPlannedTestsTask && worktree.findings.includes('source changes without corresponding test updates')) {
      maybeCreateTask(
        `Add missing tests for ${worktree.worktree}`,
        `Source files without test updates: ${worktree.source_files.join(', ')}`,
      );
    }
  }

  const implementationTasks = status.tasks.filter((task) => task.task_spec?.task_type === 'implementation');
  for (const task of implementationTasks) {
    const taskDomains = task.task_spec?.subsystem_tags || [];
    const requiredTaskTypes = new Set(task.task_spec?.validation_rules?.required_completed_task_types || []);
    for (const domain of taskDomains) {
      const rule = changePolicy.domain_rules?.[domain];
      for (const taskType of rule?.required_completed_task_types || []) {
        requiredTaskTypes.add(taskType);
      }
    }

    const completedTypes = new Set(
      status.tasks
        .filter((candidate) => candidate.status === 'done')
        .map((candidate) => candidate.task_spec?.task_type)
        .filter(Boolean),
    );

    if (requiredTaskTypes.has('tests') && !completedTypes.has('tests')) {
      maybeCreateTask(
        `Add policy-required tests for ${task.title}`,
        `Policy-triggered follow-up for ${task.id}. Domains: ${taskDomains.join(', ')}.`,
      );
    }

    if (requiredTaskTypes.has('docs') && !completedTypes.has('docs')) {
      maybeCreateTask(
        `Add policy-required docs for ${task.title}`,
        `Policy-triggered follow-up for ${task.id}. Domains: ${taskDomains.join(', ')}.`,
      );
    }

    if (requiredTaskTypes.has('governance') && !completedTypes.has('governance')) {
      maybeCreateTask(
        `Add policy review for ${task.title}`,
        `Policy-triggered governance follow-up for ${task.id}. Domains: ${taskDomains.join(', ')}.`,
      );
    }
  }

  logAuditEvent(db, {
    eventType: 'pipeline_followups_created',
    status: created.length > 0 ? 'allowed' : 'info',
    reasonCode: created.length > 0 ? null : 'no_followups_needed',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      created_count: created.length,
      ai_gate_status: aiGate.status,
    }),
  });

  return {
    pipeline_id: pipelineId,
    created,
    created_count: created.length,
    ai_gate_status: aiGate.status,
    ci_gate_ok: report.conflicts.length === 0
      && report.fileConflicts.length === 0
      && report.unclaimedChanges.length === 0
      && report.complianceSummary.non_compliant === 0
      && report.complianceSummary.stale === 0,
  };
}

export async function executePipeline(
  db,
  repoRoot,
  {
    pipelineId,
    agentCommand = [],
    agentName = 'pipeline-runner',
    maxIterations = 3,
    maxRetries = 1,
    retryBackoffMs = 0,
    timeoutMs = 0,
  },
) {
  const iterations = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const resumed = resumeRetryablePipelineTasks(db, pipelineId, {
      maxRetries,
      retryBackoffMs,
      timeoutMs,
    });
    const before = getPipelineStatus(db, pipelineId);
    const run = before.counts.pending > 0
      ? runPipelineIteration(db, repoRoot, {
        pipelineId,
        agentCommand,
        agentName,
        maxRetries,
        retryBackoffMs,
        timeoutMs,
      })
      : {
        pipeline_id: pipelineId,
        assigned: [],
        launched: [],
        executed: [],
        remaining_pending: 0,
      };
    const followups = await createPipelineFollowupTasks(db, repoRoot, pipelineId);
    const pr = await buildPipelinePrSummary(db, repoRoot, pipelineId);
    const after = getPipelineStatus(db, pipelineId);

    const record = {
      iteration,
      before: before.counts,
      resumed_retries: resumed.length,
      dispatched: run.assigned.length,
      executed: run.executed.length,
      executed_failures: run.executed.filter((item) => !item.ok).length,
      retries_scheduled: run.executed.filter((item) => item.retried).length,
      followups_created: followups.created_count,
      ready: pr.ready,
      ai_gate_status: pr.ai_gate.status,
      after: after.counts,
    };
    iterations.push(record);

    if (pr.ready) {
      logAuditEvent(db, {
        eventType: 'pipeline_exec',
        status: 'allowed',
        details: JSON.stringify({
          pipeline_id: pipelineId,
          outcome: 'ready',
          iteration,
        }),
      });
      return {
        pipeline_id: pipelineId,
        status: 'ready',
        iterations,
        pr,
      };
    }

    if (run.assigned.length === 0 && resumed.length === 0 && followups.created_count === 0) {
      logAuditEvent(db, {
        eventType: 'pipeline_exec',
        status: 'warn',
        reasonCode: 'pipeline_blocked',
        details: JSON.stringify({
          pipeline_id: pipelineId,
          outcome: 'blocked',
          iteration,
        }),
      });
      return {
        pipeline_id: pipelineId,
        status: 'blocked',
        iterations,
        pr,
      };
    }
  }

  const pr = await buildPipelinePrSummary(db, repoRoot, pipelineId);
  logAuditEvent(db, {
    eventType: 'pipeline_exec',
    status: 'warn',
    reasonCode: 'max_iterations_reached',
    details: JSON.stringify({
      pipeline_id: pipelineId,
      outcome: 'max_iterations',
      iterations: maxIterations,
    }),
  });

  return {
    pipeline_id: pipelineId,
    status: 'max_iterations',
    iterations,
    pr,
  };
}
