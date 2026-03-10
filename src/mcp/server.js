#!/usr/bin/env node
/**
 * switchman-mcp-server
 *
 * MCP server exposing Switchman's coordination primitives to AI coding agents.
 * Transport: stdio (local subprocess, one session per agent process).
 *
 * Tools:
 *   switchman_task_next    — get the next pending task (agents poll this)
 *   switchman_task_add     — add a new task to the queue
 *   switchman_task_claim   — claim files for a task (conflict-safe)
 *   switchman_task_done    — mark a task complete + release file claims
 *   switchman_task_fail    — mark a task failed + release file claims
 *   switchman_lease_heartbeat — refresh a lease heartbeat
 *   switchman_scan         — scan all worktrees for conflicts right now
 *   switchman_status       — full system overview (tasks, claims, worktrees)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { findRepoRoot } from '../core/git.js';
import {
  openDb,
  createTask,
  startTaskLease,
  completeTask,
  failTask,
  listTasks,
  getNextPendingTask,
  listLeases,
  getActiveLeaseForTask,
  heartbeatLease,
  getStaleLeases,
  claimFiles,
  releaseFileClaims,
  getActiveFileClaims,
  checkFileConflicts,
  listWorktrees,
} from '../core/db.js';
import { scanAllWorktrees } from '../core/detector.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Get the repo root and open the database.
 * Throws a structured error if not inside a git repo or not initialised.
 */
function getContext() {
  const repoRoot = findRepoRoot();
  const db = openDb(repoRoot);
  return { repoRoot, db };
}

/** Return a tool error response with a clear, actionable message. */
function toolError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

/** Return a successful tool response. */
function toolOk(text, structured = undefined) {
  const response = {
    content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }],
  };
  if (structured !== undefined) response.structuredContent = structured;
  return response;
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'switchman-mcp-server',
  version: '0.1.0',
});

// ── switchman_task_next ────────────────────────────────────────────────────────

server.registerTool(
  'switchman_task_next',
  {
    title: 'Get Next Pending Task',
    description: `Returns the highest-priority pending task from the Switchman queue, then assigns it to the specified worktree so no other agent picks it up.

Call this at the start of each agent session to claim your work. Returns null if the queue is empty.

Args:
  - worktree (string): The git worktree name this agent is running in (e.g. "feature-auth"). Run 'git worktree list' to find yours.
  - agent (string, optional): Human-readable agent identifier for logging (e.g. "claude-code", "cursor").

Returns JSON:
  {
    "task": {
      "id": string,          // Task ID to use in subsequent calls
      "title": string,
      "description": string | null,
      "priority": number,    // 1-10, higher = more urgent
      "worktree": string,
      "status": "in_progress",
      "lease_id": string,    // Active lease/session ID for the task
      "lease_status": "active",
      "heartbeat_at": string
    } | null                 // null when queue is empty
  }

Examples:
  - Agent starts up: call switchman_task_next with your worktree name
  - Queue is empty: returns { "task": null } — agent should wait or stop
  - After receiving a task: call switchman_task_claim to declare which files you'll edit`,
    inputSchema: z.object({
      worktree: z.string().min(1).describe("Your git worktree name. Run 'git worktree list' to find it."),
      agent: z.string().optional().describe('Agent identifier for logging (e.g. "claude-code")'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ worktree, agent }) => {
    try {
      const { db } = getContext();
      const task = getNextPendingTask(db);

      if (!task) {
        db.close();
        return toolOk(JSON.stringify({ task: null }), { task: null });
      }

      const lease = startTaskLease(db, task.id, worktree, agent ?? null);

      if (!lease) {
        db.close();
        // Race condition: another agent grabbed it first — try again
        return toolOk(
          JSON.stringify({ task: null, message: 'Task was claimed by another agent. Call switchman_task_next again.' }),
        );
      }

      db.close();
      const result = {
        task: {
          ...task,
          worktree,
          status: 'in_progress',
          lease_id: lease.id,
          lease_status: lease.status,
          heartbeat_at: lease.heartbeat_at,
        },
      };
      return toolOk(JSON.stringify(result, null, 2), result);
    } catch (err) {
      return toolError(`${err.message}. Make sure switchman is initialised in this repo (run 'switchman init').`);
    }
  },
);

// ── switchman_task_add ─────────────────────────────────────────────────────────

server.registerTool(
  'switchman_task_add',
  {
    title: 'Add Task to Queue',
    description: `Adds a new task to the Switchman task queue.

Use this to break down a large feature into parallelisable subtasks before spinning up worker agents.

Args:
  - title (string): Short description of the work (e.g. "Implement OAuth login flow")
  - description (string, optional): Detailed implementation notes
  - priority (number, optional): 1-10, default 5. Higher = picked up first.
  - id (string, optional): Custom task ID. Auto-generated if omitted.

Returns JSON:
  {
    "task_id": string,   // ID to reference in assign/claim/done calls
    "title": string,
    "priority": number
  }

Examples:
  - Add high-priority security task: { title: "Fix SQL injection in login", priority: 9 }
  - Add background task: { title: "Update README", priority: 2 }`,
    inputSchema: z.object({
      title: z.string().min(1).max(200).describe('Short description of the work'),
      description: z.string().max(2000).optional().describe('Detailed implementation notes'),
      priority: z.number().int().min(1).max(10).default(5).describe('Priority 1-10, higher = picked up first'),
      id: z.string().max(100).optional().describe('Custom task ID (auto-generated if omitted)'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ title, description, priority, id }) => {
    try {
      const { db } = getContext();
      const taskId = createTask(db, { id, title, description, priority });
      db.close();

      const result = { task_id: taskId, title, priority };
      return toolOk(JSON.stringify(result, null, 2), result);
    } catch (err) {
      return toolError(err.message);
    }
  },
);

// ── switchman_task_claim ───────────────────────────────────────────────────────

server.registerTool(
  'switchman_task_claim',
  {
    title: 'Claim Files for a Task',
    description: `Declares which files this agent intends to edit for a task.

Call this immediately after receiving a task, before making any edits. Switchman checks whether any of the files are already claimed by another active task in a different worktree and warns you before a conflict can occur.

Args:
  - task_id (string): The task ID returned by switchman_task_next or switchman_task_add
  - worktree (string): Your git worktree name
  - files (array of strings): File paths you plan to edit, relative to repo root (e.g. ["src/auth/login.js", "tests/auth.test.js"])
  - agent (string, optional): Agent identifier for logging
  - lease_id (string, optional): Active lease ID returned by switchman_task_next
  - force (boolean, optional): If true, claim even if conflicts exist (default: false)

Returns JSON:
  {
    "lease_id": string,
    "claimed": string[],     // Files successfully claimed
    "conflicts": [           // Files already claimed by other worktrees
      {
        "file": string,
        "claimed_by_task_id": string,
        "claimed_by_worktree": string,
        "claimed_by_task": string,
        "claimed_by_lease_id": string | null
      }
    ],
    "safe_to_proceed": boolean   // true if no conflicts (or force=true)
  }

Examples:
  - Before editing auth files: files: ["src/auth/login.js", "src/auth/token.js"]
  - If conflicts returned: coordinate with other agents or choose different files
  - Do NOT use force=true unless you've confirmed the conflict is safe to override`,
    inputSchema: z.object({
      task_id: z.string().min(1).describe('Task ID from switchman_task_next'),
      worktree: z.string().min(1).describe('Your git worktree name'),
      files: z.array(z.string().min(1)).min(1).max(500).describe('File paths to claim, relative to repo root'),
      agent: z.string().optional().describe('Agent identifier for logging'),
      lease_id: z.string().optional().describe('Optional lease ID returned by switchman_task_next'),
      force: z.boolean().default(false).describe('Claim even if conflicts exist (use with caution)'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ task_id, worktree, files, agent, lease_id, force }) => {
    let db;
    try {
      ({ db } = getContext());

      // Check for conflicts first
      const conflicts = checkFileConflicts(db, files, worktree);

      if (conflicts.length > 0 && !force) {
        db.close();
        const result = {
          claimed: [],
          conflicts: conflicts.map((c) => ({
            file: c.file,
            claimed_by_task_id: c.claimedBy.task_id,
            claimed_by_worktree: c.claimedBy.worktree,
            claimed_by_task: c.claimedBy.task_title,
            claimed_by_lease_id: c.claimedBy.lease_id ?? null,
          })),
          safe_to_proceed: false,
        };
        return toolOk(
          `Conflicts detected — ${conflicts.length} file(s) already claimed by other worktrees.\n` +
            JSON.stringify(result, null, 2),
          result,
        );
      }

      const lease = claimFiles(db, task_id, worktree, files, agent ?? null);
      if (lease_id && lease.id !== lease_id) {
        return toolError(`Task ${task_id} is active under lease ${lease.id}, not ${lease_id}.`);
      }

      const result = {
        lease_id: lease.id,
        claimed: files,
        conflicts: conflicts.map((c) => ({
          file: c.file,
          claimed_by_task_id: c.claimedBy.task_id,
          claimed_by_worktree: c.claimedBy.worktree,
          claimed_by_task: c.claimedBy.task_title,
          claimed_by_lease_id: c.claimedBy.lease_id ?? null,
        })),
        safe_to_proceed: true,
      };
      return toolOk(
        `Claimed ${files.length} file(s) for task ${task_id}.\n` + JSON.stringify(result, null, 2),
        result,
      );
    } catch (err) {
      return toolError(err.message);
    } finally {
      db?.close();
    }
  },
);

// ── switchman_task_done ────────────────────────────────────────────────────────

server.registerTool(
  'switchman_task_done',
  {
    title: 'Mark Task Complete',
    description: `Marks a task as done and always releases all file claims so other agents can pick up those files.

Call this when you have finished your implementation and committed your changes.

Args:
  - task_id (string): The task ID to complete
  - lease_id (string, optional): Active lease ID returned by switchman_task_next

Returns JSON:
  {
    "task_id": string,
    "lease_id": string | null,
    "status": "done",
    "files_released": true
  }`,
    inputSchema: z.object({
      task_id: z.string().min(1).describe('The task ID to mark complete'),
      lease_id: z.string().optional().describe('Optional lease ID returned by switchman_task_next'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ task_id, lease_id }) => {
    try {
      const { db } = getContext();
      const activeLease = getActiveLeaseForTask(db, task_id);
      if (lease_id && activeLease && activeLease.id !== lease_id) {
        db.close();
        return toolError(`Task ${task_id} is active under lease ${activeLease.id}, not ${lease_id}.`);
      }
      completeTask(db, task_id);
      releaseFileClaims(db, task_id);
      db.close();

      const result = { task_id, lease_id: activeLease?.id ?? lease_id ?? null, status: 'done', files_released: true };
      return toolOk(JSON.stringify(result, null, 2), result);
    } catch (err) {
      return toolError(err.message);
    }
  },
);

// ── switchman_task_fail ────────────────────────────────────────────────────────

server.registerTool(
  'switchman_task_fail',
  {
    title: 'Mark Task Failed',
    description: `Marks a task as failed, records the reason, and releases all file claims.

Call this if you cannot complete the task — the task will be visible in the queue as failed so a human can review it. File claims are always released on failure so other agents aren't blocked.

Args:
  - task_id (string): The task ID to mark as failed
  - lease_id (string, optional): Active lease ID returned by switchman_task_next
  - reason (string): Brief explanation of why the task failed

Returns JSON:
  {
    "task_id": string,
    "lease_id": string | null,
    "status": "failed",
    "reason": string,
    "files_released": true
  }`,
    inputSchema: z.object({
      task_id: z.string().min(1).describe('The task ID to mark as failed'),
      lease_id: z.string().optional().describe('Optional lease ID returned by switchman_task_next'),
      reason: z.string().min(1).max(500).describe('Brief explanation of why the task failed'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ task_id, lease_id, reason }) => {
    try {
      const { db } = getContext();
      const activeLease = getActiveLeaseForTask(db, task_id);
      if (lease_id && activeLease && activeLease.id !== lease_id) {
        db.close();
        return toolError(`Task ${task_id} is active under lease ${activeLease.id}, not ${lease_id}.`);
      }
      failTask(db, task_id, reason);
      releaseFileClaims(db, task_id);
      db.close();

      const result = { task_id, lease_id: activeLease?.id ?? lease_id ?? null, status: 'failed', reason, files_released: true };
      return toolOk(JSON.stringify(result, null, 2), result);
    } catch (err) {
      return toolError(err.message);
    }
  },
);

// ── switchman_lease_heartbeat ─────────────────────────────────────────────────

server.registerTool(
  'switchman_lease_heartbeat',
  {
    title: 'Refresh Lease Heartbeat',
    description: `Refreshes the heartbeat timestamp for an active lease.

Call this periodically while an agent is still working on a task so stale-session reaping does not recycle the task prematurely.

Args:
  - lease_id (string): Active lease ID returned by switchman_task_next
  - agent (string, optional): Agent identifier to attach to the refreshed lease

Returns JSON:
  {
    "lease_id": string,
    "task_id": string,
    "worktree": string,
    "heartbeat_at": string
  }`,
    inputSchema: z.object({
      lease_id: z.string().min(1).describe('Active lease ID returned by switchman_task_next'),
      agent: z.string().optional().describe('Agent identifier for logging'),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ lease_id, agent }) => {
    try {
      const { db } = getContext();
      const lease = heartbeatLease(db, lease_id, agent ?? null);
      db.close();

      if (!lease) {
        return toolError(`Lease ${lease_id} was not found or is no longer active.`);
      }

      const result = {
        lease_id: lease.id,
        task_id: lease.task_id,
        worktree: lease.worktree,
        heartbeat_at: lease.heartbeat_at,
      };
      return toolOk(JSON.stringify(result, null, 2), result);
    } catch (err) {
      return toolError(err.message);
    }
  },
);

// ── switchman_scan ─────────────────────────────────────────────────────────────

server.registerTool(
  'switchman_scan',
  {
    title: 'Scan for Conflicts',
    description: `Scans all git worktrees for conflicts — both uncommitted file overlaps and branch-level merge conflicts.

Run this before starting work on a task, before merging a branch, or any time you want to verify the workspace is clean. This is a read-only operation that never modifies any files.

Two detection layers:
  1. Uncommitted file overlaps — files being edited in multiple worktrees right now
  2. Branch-level merge conflicts — branches that would conflict when merged (uses git merge-tree)

Args:
  - (none required)

Returns JSON:
  {
    "worktrees": [{ "name": string, "branch": string, "changed_files": number }],
    "file_conflicts": [           // Files touched in multiple worktrees
      { "file": string, "worktrees": string[] }
    ],
    "branch_conflicts": [         // Branches with merge conflicts
      {
        "type": "merge_conflict" | "file_overlap",
        "worktree_a": string, "branch_a": string,
        "worktree_b": string, "branch_b": string,
        "conflicting_files": string[]
      }
    ],
    "safe_to_proceed": boolean,   // true when no conflicts found
    "summary": string
  }

Examples:
  - Before editing files: ensure safe_to_proceed is true
  - If file_conflicts found: coordinate with agents in other worktrees
  - If branch_conflicts found: resolve before merging to main`,
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const { repoRoot, db } = getContext();
      const report = await scanAllWorktrees(db, repoRoot);
      db.close();

      const result = {
        worktrees: report.worktrees.map((wt) => ({
          name: wt.name,
          branch: wt.branch ?? 'unknown',
          changed_files: (report.fileMap?.[wt.name] ?? []).length,
        })),
        file_conflicts: report.fileConflicts,
        branch_conflicts: report.conflicts.map((c) => ({
          type: c.type,
          worktree_a: c.worktreeA,
          branch_a: c.branchA,
          worktree_b: c.worktreeB,
          branch_b: c.branchB,
          conflicting_files: c.conflictingFiles,
        })),
        safe_to_proceed: report.conflicts.length === 0 && report.fileConflicts.length === 0,
        summary: report.summary,
      };
      return toolOk(JSON.stringify(result, null, 2), result);
    } catch (err) {
      return toolError(`Scan failed: ${err.message}. Ensure switchman is initialised ('switchman init').`);
    }
  },
);

// ── switchman_status ───────────────────────────────────────────────────────────

server.registerTool(
  'switchman_status',
  {
    title: 'Get System Status',
    description: `Returns a full overview of the Switchman coordination state: task queue counts, active tasks, file claims, and worktree list.

Use this to understand the current state before starting work, or to check what other agents are doing.

Args:
  - (none required)

Returns JSON:
  {
    "tasks": {
      "pending": number,
      "in_progress": number,
      "done": number,
      "failed": number,
      "active": [{ "id": string, "title": string, "worktree": string, "priority": number, "lease_id": string | null }]
    },
    "file_claims": {
      "total_active": number,
      "by_worktree": { [worktree: string]: { "file_path": string, "task_id": string, "lease_id": string | null }[] }
    },
    "leases": {
      "active": [{ "id": string, "task_id": string, "worktree": string, "agent": string | null, "heartbeat_at": string }],
      "stale": [{ "id": string, "task_id": string, "worktree": string, "heartbeat_at": string }]
    },
    "worktrees": [{ "name": string, "branch": string, "agent": string | null, "status": string, "active_lease_id": string | null }],
    "repo_root": string
  }`,
    inputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const { repoRoot, db } = getContext();

      const tasks = listTasks(db);
      const claims = getActiveFileClaims(db);
      const worktrees = listWorktrees(db);
      const leases = listLeases(db);
      const staleLeases = getStaleLeases(db);
      db.close();

      const byWorktree = {};
      for (const c of claims) {
        if (!byWorktree[c.worktree]) byWorktree[c.worktree] = [];
        byWorktree[c.worktree].push({
          file_path: c.file_path,
          task_id: c.task_id,
          lease_id: c.lease_id ?? null,
        });
      }

      const activeLeaseByTask = new Map(
        leases.filter((lease) => lease.status === 'active').map((lease) => [lease.task_id, lease]),
      );
      const activeLeaseByWorktree = new Map(
        leases.filter((lease) => lease.status === 'active').map((lease) => [lease.worktree, lease]),
      );

      const result = {
        tasks: {
          pending: tasks.filter((t) => t.status === 'pending').length,
          in_progress: tasks.filter((t) => t.status === 'in_progress').length,
          done: tasks.filter((t) => t.status === 'done').length,
          failed: tasks.filter((t) => t.status === 'failed').length,
          active: tasks
            .filter((t) => t.status === 'in_progress')
            .map((t) => ({
              id: t.id,
              title: t.title,
              worktree: t.worktree,
              priority: t.priority,
              lease_id: activeLeaseByTask.get(t.id)?.id ?? null,
            })),
        },
        file_claims: {
          total_active: claims.length,
          by_worktree: byWorktree,
          claims: claims.map((claim) => ({
            file_path: claim.file_path,
            worktree: claim.worktree,
            task_id: claim.task_id,
            lease_id: claim.lease_id ?? null,
          })),
        },
        leases: {
          active: leases.filter((lease) => lease.status === 'active').map((lease) => ({
            id: lease.id,
            task_id: lease.task_id,
            worktree: lease.worktree,
            agent: lease.agent ?? null,
            heartbeat_at: lease.heartbeat_at,
          })),
          stale: staleLeases.map((lease) => ({
            id: lease.id,
            task_id: lease.task_id,
            worktree: lease.worktree,
            heartbeat_at: lease.heartbeat_at,
          })),
        },
        worktrees: worktrees.map((wt) => ({
          name: wt.name,
          branch: wt.branch,
          agent: wt.agent ?? null,
          status: wt.status,
          active_lease_id: activeLeaseByWorktree.get(wt.name)?.id ?? null,
        })),
        repo_root: repoRoot,
      };
      return toolOk(JSON.stringify(result, null, 2), result);
    } catch (err) {
      return toolError(err.message);
    }
  },
);

// ─── Transport ────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio servers must not write to stdout — all logging goes to stderr
  process.stderr.write('switchman MCP server running (stdio)\n');
}

main().catch((err) => {
  process.stderr.write(`switchman MCP server fatal error: ${err.message}\n`);
  process.exit(1);
});
