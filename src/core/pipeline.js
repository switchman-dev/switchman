import { spawn, spawnSync } from 'child_process';

import { completeTask, createTask, failTask, listAuditEvents, listLeases, listTasks, listWorktrees, logAuditEvent, retryTask, startTaskLease } from './db.js';
import { scanAllWorktrees } from './detector.js';
import { runAiMergeGate } from './merge-gate.js';
import { evaluateTaskOutcome } from './outcome.js';

function sleepSync(ms) {
  if (ms > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

function makePipelineId() {
  return `pipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extractChecklistItems(description) {
  if (!description) return [];
  return description
    .split('\n')
    .map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.*\S)\s*$/)?.[1] || null)
    .filter(Boolean);
}

function deriveSubtaskTitles(title, description) {
  const checklistItems = extractChecklistItems(description);
  if (checklistItems.length > 0) return checklistItems;

  const text = `${title}\n${description || ''}`.toLowerCase();
  const subtasks = [];

  const docsOnly = /\b(docs?|readme|documentation)\b/.test(text)
    && !/\b(api|auth|bug|feature|fix|refactor|schema|migration|config|build|test)\b/.test(text);

  if (docsOnly) {
    return [`Update docs for: ${title}`];
  }

  subtasks.push(`Implement: ${title}`);

  if (!/\b(test|spec)\b/.test(text)) {
    subtasks.push(`Add or update tests for: ${title}`);
  }

  if (/\b(api|public|config|migration|schema|docs?|readme)\b/.test(text)) {
    subtasks.push(`Update integration notes for: ${title}`);
  }

  return subtasks;
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

function nextPipelineTaskId(tasks, pipelineId) {
  const nextNumber = tasks
    .map((task) => Number.parseInt(task.id.slice(`${pipelineId}-`.length), 10))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0) + 1;
  return `${pipelineId}-${String(nextNumber).padStart(2, '0')}`;
}

export function startPipeline(db, { title, description = null, priority = 5, pipelineId = null, maxTasks = 5 }) {
  const resolvedPipelineId = pipelineId || makePipelineId();
  const subtaskTitles = deriveSubtaskTitles(title, description).slice(0, maxTasks);
  const suggestedWorktrees = listWorktrees(db).filter((worktree) => worktree.name !== 'main');
  let implementationTaskId = null;

  const tasks = subtaskTitles.map((subtaskTitle, index) => {
    const suggestedWorktree = suggestedWorktrees.length > 0
      ? suggestedWorktrees[index % suggestedWorktrees.length].name
      : null;
    const taskId = `${resolvedPipelineId}-${String(index + 1).padStart(2, '0')}`;
    const dependencyIds = [];
    if (implementationTaskId && /^(Add or update tests|Update integration notes)/.test(subtaskTitle)) {
      dependencyIds.push(implementationTaskId);
    }
    const taskDescription = [
      `[Pipeline ${resolvedPipelineId}]`,
      suggestedWorktree ? `Suggested worktree: ${suggestedWorktree}` : null,
      dependencyIds.length > 0 ? `Depends on: ${dependencyIds.join(', ')}` : null,
      index === 0 && description ? description : null,
    ].filter(Boolean).join('\n');

    createTask(db, {
      id: taskId,
      title: subtaskTitle,
      description: taskDescription,
      priority,
    });

    const taskRecord = {
      id: taskId,
      title: subtaskTitle,
      priority,
      suggested_worktree: suggestedWorktree,
      dependencies: dependencyIds,
      status: 'pending',
    };

    if (subtaskTitle.startsWith('Implement:')) {
      implementationTaskId = taskId;
    }

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
      return {
        ...task,
        suggested_worktree: parseSuggestedWorktree(task.description),
        dependencies,
        blocked_by: blockedBy,
        ready_to_run: task.status === 'pending' && blockedBy.length === 0,
      };
    }),
  };
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
  return {
    ...process.env,
    SWITCHMAN_PIPELINE_ID: task.id.split('-').slice(0, -1).join('-'),
    SWITCHMAN_TASK_ID: task.id,
    SWITCHMAN_TASK_TITLE: task.title,
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

function resumeRetryablePipelineTasks(db, pipelineId, maxRetries) {
  if (maxRetries <= 0) return [];

  const tasks = listTasks(db)
    .filter((task) => task.id.startsWith(`${pipelineId}-`) && task.status === 'failed')
    .sort((a, b) => a.id.localeCompare(b.id));
  const resumed = [];

  for (const task of tasks) {
    const retriesUsed = getTaskRetryCount(db, task.id);
    if (retriesUsed >= maxRetries) continue;

    const nextAttempt = retriesUsed + 1;
    const resumedTask = retryTask(db, task.id, `resume retry attempt ${nextAttempt} of ${maxRetries}`);
    if (!resumedTask) continue;

    logAuditEvent(db, {
      eventType: 'pipeline_task_retry_scheduled',
      status: 'warn',
      taskId: task.id,
      reasonCode: 'retry_resumed',
      details: JSON.stringify({
        pipeline_id: pipelineId,
        retry_attempt: nextAttempt,
        max_retries: maxRetries,
        resumed: true,
      }),
    });

    resumed.push({
      task_id: task.id,
      retry_attempt: nextAttempt,
      retries_remaining: Math.max(0, maxRetries - nextAttempt),
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
      const beforeHead = getHeadRevision(assignment.worktree_path);
      const result = spawnSync(command, args, {
        cwd: assignment.worktree_path,
        env: {
          ...process.env,
          SWITCHMAN_PIPELINE_ID: pipelineId,
          SWITCHMAN_TASK_ID: assignment.task_id,
          SWITCHMAN_TASK_TITLE: assignment.title,
          SWITCHMAN_LEASE_ID: assignment.lease_id,
          SWITCHMAN_WORKTREE: assignment.worktree,
          SWITCHMAN_WORKTREE_PATH: assignment.worktree_path,
          SWITCHMAN_REPO_ROOT: repoRoot,
        },
        encoding: 'utf8',
      });
      const afterHead = getHeadRevision(assignment.worktree_path);

      const commandOk = !result.error && result.status === 0;
      let evaluation = commandOk
        ? evaluateTaskOutcome(db, repoRoot, { taskId: assignment.task_id })
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
        retries_remaining: Math.max(0, maxRetries - getTaskRetryCount(db, assignment.task_id)),
        retry_delay_ms: 0,
      };
      if (ok) {
        completeTask(db, assignment.task_id);
      } else {
        const failureReason = !commandOk
          ? (result.error?.message || `agent command exited with status ${result.status}`)
          : `${evaluation.reason_code}: ${evaluation.findings.join('; ')}`;
        failTask(db, assignment.task_id, failureReason);
        retry = scheduleTaskRetry(db, {
          pipelineId,
          taskId: assignment.task_id,
          maxRetries,
          retryBackoffMs,
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
        exit_code: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
      });

      logAuditEvent(db, {
        eventType: 'pipeline_task_executed',
        status: ok ? 'allowed' : 'denied',
        reasonCode: ok ? null : 'agent_command_failed',
        worktree: assignment.worktree,
        taskId: assignment.task_id,
        leaseId: assignment.lease_id,
        details: JSON.stringify({
          pipeline_id: pipelineId,
          command,
          args,
          exit_code: result.status,
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
  const ciGateOk = report.conflicts.length === 0
    && report.fileConflicts.length === 0
    && report.unclaimedChanges.length === 0
    && report.complianceSummary.non_compliant === 0
    && report.complianceSummary.stale === 0;

  const involvedWorktrees = [...new Set(status.tasks.map((task) => task.worktree).filter(Boolean))];
  const worktreeChanges = involvedWorktrees.map((worktree) => ({
    worktree,
    files: report.fileMap?.[worktree] ?? [],
  }));
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
    ...status.tasks
      .filter((task) => task.status === 'done')
      .map((task) => `- ${task.title}`),
    ...(status.tasks.filter((task) => task.status === 'done').length === 0 ? ['- None yet'] : []),
    '',
    '## Remaining Tasks',
    ...status.tasks
      .filter((task) => task.status !== 'done')
      .map((task) => `- [${task.status}] ${task.title}`),
    ...(status.tasks.filter((task) => task.status !== 'done').length === 0 ? ['- None'] : []),
    '',
    '## Worktree Changes',
    ...worktreeChanges.map((entry) => `- ${entry.worktree}: ${entry.files.length ? entry.files.join(', ') : 'no active changes'}`),
    ...(worktreeChanges.length === 0 ? ['- No active worktree assignments yet'] : []),
    '',
    '## Gate Notes',
    `- Repo gate summary: ${ciGateOk ? 'clear' : 'blocked by conflicts or unmanaged changes'}`,
    `- AI merge summary: ${aiGate.summary}`,
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
    worktree_changes: worktreeChanges,
    markdown,
  };
}

export async function createPipelineFollowupTasks(db, repoRoot, pipelineId) {
  const status = getPipelineStatus(db, pipelineId);
  const report = await scanAllWorktrees(db, repoRoot);
  const aiGate = await runAiMergeGate(db, repoRoot);
  const existingTitles = new Set(status.tasks.map((task) => task.title));
  const created = [];
  const pipelineTasks = [...status.tasks];

  function maybeCreateTask(title, description) {
    if (existingTitles.has(title)) return;
    const taskId = nextPipelineTaskId(pipelineTasks, pipelineId);
    createTask(db, {
      id: taskId,
      title,
      description: [
        `[Pipeline ${pipelineId}]`,
        description,
      ].filter(Boolean).join('\n'),
      priority: status.priority,
    });
    pipelineTasks.push({ id: taskId, title });
    existingTitles.add(title);
    created.push({ id: taskId, title, description });
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

  for (const pair of aiGate.pairs.filter((item) => item.status !== 'pass')) {
    maybeCreateTask(
      `Review integration risk between ${pair.worktree_a} and ${pair.worktree_b}`,
      pair.reasons.join('\n'),
    );
  }

  for (const worktree of aiGate.worktrees) {
    if (worktree.findings.includes('source changes without corresponding test updates')) {
      maybeCreateTask(
        `Add missing tests for ${worktree.worktree}`,
        `Source files without test updates: ${worktree.source_files.join(', ')}`,
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
  },
) {
  const iterations = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const resumed = resumeRetryablePipelineTasks(db, pipelineId, maxRetries);
    const before = getPipelineStatus(db, pipelineId);
    const run = before.counts.pending > 0
      ? runPipelineIteration(db, repoRoot, {
        pipelineId,
        agentCommand,
        agentName,
        maxRetries,
        retryBackoffMs,
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
