# Switchman Agent Instructions

This repository uses **Switchman** to coordinate parallel AI coding agents.
You MUST follow these instructions every session to avoid conflicting with other agents.

---

## Your worktree

Find your worktree name by running:
```bash
git worktree list
```
The path that matches your current directory is your worktree. Use the last path segment as your worktree name (e.g. `/projects/myapp-feature-auth` → `feature-auth`). The main repo root is always named `main`.

---

## Required workflow — follow this every session

### 1. Start of session — get your task

Call the `switchman_task_next` MCP tool with your worktree name:
```
switchman_task_next({ worktree: "<your-worktree-name>", agent: "claude-code" })
```

- If `task` is `null` — the queue is empty. Ask the user what to work on, or stop.
- If you receive a task — note the `task.id`. You'll need it in the next steps.

### 2. Before editing any files — claim them

Call `switchman_task_claim` with every file you plan to edit **before you edit them**:
```
switchman_task_claim({
  task_id: "<task-id>",
  worktree: "<your-worktree-name>",
  files: ["src/auth/login.js", "tests/auth.test.js"]
})
```

- If `safe_to_proceed` is `false` — there are conflicts. Do NOT edit those files.
  Read the `conflicts` array to see which worktrees own them, then either:
  - Choose different files that accomplish the same goal
  - Ask the user how to proceed

- If `safe_to_proceed` is `true` — you are clear to edit.

### 3. Do the work

Implement the task. Make commits as normal. Other agents will avoid your claimed files.

If you discover mid-task that you need to edit additional files, call `switchman_task_claim` again for those files before editing them.

### 4. End of session — mark complete or failed

**On success:**
```
switchman_task_done({ task_id: "<task-id>", release_files: true })
```

**On failure (can't complete the task):**
```
switchman_task_fail({ task_id: "<task-id>", reason: "Brief explanation of what blocked you" })
```

Always call one of these before ending your session. Released file claims allow other agents to proceed.

---

## Checking for conflicts

At any time you can scan for conflicts across all worktrees:
```
switchman_scan()
```

Run this before merging your branch. If `safe_to_proceed` is `false`, do not merge until conflicts are resolved.

---

## Checking system state

To see what other agents are doing:
```
switchman_status()
```

This shows all pending and in-progress tasks, file claims per worktree, and worktree list.

---

## Rules

1. **Always claim files before editing them** — not after.
2. **Always call `switchman_task_done` or `switchman_task_fail` at end of session** — never leave tasks as `in_progress` when you stop.
3. **If `safe_to_proceed` is false, do not edit the conflicting files** — coordinate first.
4. **Do not claim files you don't need** — over-claiming blocks other agents unnecessarily.
5. **One task per session** — complete or fail your current task before taking another.
