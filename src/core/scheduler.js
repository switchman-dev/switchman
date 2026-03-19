import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { getTaskSpec, listLeases, listTasks, listWorktrees, logAuditEvent, startTaskLease } from './db.js';

function parseDependencies(description) {
  const match = String(description || '').match(/Depends on:\s*(.+)$/m);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSuggestedWorktree(description) {
  const match = String(description || '').match(/Suggested worktree:\s*(.+)$/m);
  return match?.[1] || null;
}

function withTaskSpec(db, task) {
  return {
    ...task,
    task_spec: getTaskSpec(db, task.id),
  };
}

function chooseWorktree(task, availableWorktrees) {
  if (availableWorktrees.length === 0) return null;
  const preferredName = task.task_spec?.suggested_worktree || parseSuggestedWorktree(task.description);
  if (preferredName) {
    const preferred = availableWorktrees.find((worktree) => worktree.name === preferredName);
    if (preferred) return preferred;
  }
  return availableWorktrees[0];
}

export function collectSchedulerSnapshot(db) {
  const allTasks = listTasks(db);
  const taskStatusById = new Map(allTasks.map((task) => [task.id, task.status]));
  const activeLeases = listLeases(db, 'active');
  const activeLeaseWorktrees = new Set(activeLeases.map((lease) => lease.worktree));
  const registeredWorktrees = listWorktrees(db)
    .filter((worktree) => worktree.name !== 'main' && worktree.status !== 'missing')
    .sort((a, b) => a.name.localeCompare(b.name));

  const availableWorktrees = registeredWorktrees
    .filter((worktree) => !activeLeaseWorktrees.has(worktree.name));

  const pendingTasks = allTasks
    .filter((task) => task.status === 'pending')
    .map((task) => withTaskSpec(db, task));

  const readyTasks = pendingTasks.filter((task) =>
    parseDependencies(task.description).every((dependencyId) => taskStatusById.get(dependencyId) === 'done'));
  const blockedTasks = pendingTasks.filter((task) =>
    parseDependencies(task.description).some((dependencyId) => taskStatusById.get(dependencyId) !== 'done'));

  return {
    active_leases: activeLeases,
    available_worktrees: availableWorktrees,
    registered_worktrees: registeredWorktrees,
    ready_tasks: readyTasks,
    blocked_tasks: blockedTasks,
  };
}

export function dispatchReadyTasks(db, { agentName = 'switchman-scheduler', limit = null } = {}) {
  const snapshot = collectSchedulerSnapshot(db);
  const remainingWorktrees = [...snapshot.available_worktrees];
  const assignments = [];
  const maxAssignments = limit == null ? Number.POSITIVE_INFINITY : Math.max(0, Number.parseInt(limit, 10) || 0);

  for (const task of snapshot.ready_tasks) {
    if (assignments.length >= maxAssignments) break;
    const worktree = chooseWorktree(task, remainingWorktrees);
    if (!worktree) break;

    const lease = startTaskLease(db, task.id, worktree.name, agentName);
    if (!lease) continue;

    const assignment = {
      task_id: task.id,
      title: task.title,
      worktree: worktree.name,
      worktree_path: worktree.path,
      lease_id: lease.id,
      priority: task.priority,
      suggested_worktree: task.task_spec?.suggested_worktree || null,
    };
    assignments.push(assignment);

    logAuditEvent(db, {
      eventType: 'scheduler_task_dispatched',
      status: 'allowed',
      worktree: worktree.name,
      taskId: task.id,
      leaseId: lease.id,
      details: JSON.stringify({
        worktree_path: worktree.path,
        suggested_worktree: task.task_spec?.suggested_worktree || null,
      }),
    });

    const index = remainingWorktrees.findIndex((entry) => entry.name === worktree.name);
    if (index >= 0) remainingWorktrees.splice(index, 1);
  }

  return {
    assignments,
    available_worktree_count: snapshot.available_worktrees.length,
    idle_worktree_count: remainingWorktrees.length,
    ready_task_count: snapshot.ready_tasks.length,
    blocked_task_count: snapshot.blocked_tasks.length,
    active_lease_count: snapshot.active_leases.length,
    unassigned_ready_task_count: Math.max(0, snapshot.ready_tasks.length - assignments.length),
  };
}

export function getSchedulerStatePath(repoRoot) {
  return join(repoRoot, '.switchman', 'scheduler.json');
}

export function readSchedulerState(repoRoot) {
  const statePath = getSchedulerStatePath(repoRoot);
  if (!existsSync(statePath)) return null;

  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeSchedulerState(repoRoot, state) {
  const statePath = getSchedulerStatePath(repoRoot);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return statePath;
}

export function clearSchedulerState(repoRoot) {
  rmSync(getSchedulerStatePath(repoRoot), { force: true });
}
