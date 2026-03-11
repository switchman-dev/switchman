# Switchman

**Stop your AI agents from overwriting each other.**

When you run multiple Claude Code instances on the same repo, they have no idea what each other is doing. One agent edits a file while another rewrites it. Hours of work disappear at merge time.

Switchman gives them a shared task queue and file locking so they stay on separate tracks — and you stay in control.

---

## Requirements

- Node.js 22.5+
- Git 2.5+

---

## Install

```bash
npm install -g @switchman-dev
```

---

## Pick your setup

### Option A — Claude Code (recommended)

Claude Code has a native Switchman integration via MCP. Your agents coordinate automatically — no manual CLI calls, no extra prompting.

**Step 1 — Create your agent workspaces**

```bash
cd my-project
switchman setup --agents 3
```

That's it. Switchman creates three isolated workspaces, one per agent, and initialises the database. You'll see the folder paths printed — you'll need them in step 4.

**Step 2 — Add Switchman to Claude Code**

`switchman setup` now writes a project-local `.mcp.json` into the repo root and each generated worktree, so Claude Code can discover Switchman automatically when you open those folders.

If you prefer a global fallback, add this to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "switchman": {
      "command": "switchman-mcp",
      "args": []
    }
  }
}
```

Then restart Claude Code. The project-local `.mcp.json` is the preferred path because it travels with the repo and the generated worktrees.

**Step 3 — Copy CLAUDE.md into your repo root**

```bash
curl -O https://raw.githubusercontent.com/switchman-dev/switchman/main/CLAUDE.md
```

This tells your agents how to use Switchman. Without it they may bypass Switchman entirely, so keep it in the repo root and do not let agents talk to `.switchman/switchman.db` directly.

**Step 4 — Add your tasks**

```bash
switchman task add "Fix the login bug" --priority 8
switchman task add "Add rate limiting" --priority 6
switchman task add "Update README" --priority 2
```

**Step 5 — Open Claude Code in each workspace**

Open a separate Claude Code window in each folder that `switchman setup` created. Each agent should automatically see the local MCP config, pick up a task, lock the files it needs, and release them when it's done.

**Step 6 — Check before merging**

```bash
switchman scan
```

---

### Option B — Any other agent (Cursor, Windsurf, Aider, etc.)

Switchman works as a CLI tool with any agent that can run terminal commands. The coordination isn't automatic — you'll need to prompt your agents to use Switchman commands.

**Step 1 — Create your agent workspaces**

```bash
cd my-project
switchman setup --agents 3
```

**Step 2 — Add your tasks**

```bash
switchman task add "Fix the login bug" --priority 8
switchman task add "Add rate limiting" --priority 6
```

**Step 3 — Give each agent this prompt**

Paste this into your agent at the start of each session:

```
Before starting any work:
1. Run `switchman lease next --json` to get your assigned task and lease
2. Run `switchman claim <taskId> <worktreeName> <files...>` to lock the files you'll edit
   - If a file is already claimed, pick a different approach or different files
3. If the task runs for a while, refresh the lease with `switchman lease heartbeat <leaseId>`
4. When finished, run `switchman task done <taskId>`

Never edit a file you haven't claimed. If a claim fails, do not use --force.
```

**Step 4 — Check before merging**

```bash
switchman scan
```

---

## What your agents will see

Here's what a normal session looks like with Switchman running:

```
# Agent 1 picks up a task
switchman lease next
✓  Lease acquired: "Add rate limiting to all routes"  [task-abc-123 / lease-xyz-123]

# Agent 1 locks its files
switchman claim task-abc-123 agent1 src/middleware/auth.js src/server.js
✓  2 files locked — no conflicts

# Agent 2 picks up a different task
switchman lease next
✓  Lease acquired: "Add validation to POST /tasks"  [task-def-456 / lease-xyz-456]

# Agent 2 tries to claim a file already locked by Agent 1
switchman claim task-def-456 agent2 src/middleware/auth.js
⚠  Conflict: auth.js is locked by agent1

# Agent 2 claims different files instead
switchman claim task-def-456 agent2 src/middleware/validate.js src/routes/tasks.js
✓  2 files locked — no conflicts

# Both agents working, zero collisions
switchman status
  agent1  →  "Add rate limiting"      editing auth.js, server.js
  agent2  →  "Add validation"         editing validate.js, tasks.js
```

---

## Commands

### `switchman setup`
One-command setup — creates agent workspaces and initialises the database.
- `--agents 3` — number of workspaces to create (default: 3, max: 10)
- `--prefix switchman` — branch name prefix (default: switchman)
- Writes `.mcp.json` to the repo root and each generated worktree so Claude Code can attach the Switchman MCP server automatically

### `switchman init`
Initialise in the current git repo without creating worktrees. Creates `.switchman/switchman.db` and auto-detects existing worktrees.

### `switchman task add <title>`
Add a task to the queue.
- `--priority 1-10` (default: 5)
- `--description "..."`

### `switchman task list`
List all tasks. Filter with `--status pending|in_progress|done|failed`.

### `switchman task next`
Get and assign the next pending task. This is a compatibility shim over the lease workflow. Use `--json` for agent automation.
- `--worktree <name>` — worktree to assign to (defaults to current folder name)
- `--agent <name>` — agent identifier for logging

### `switchman lease next`
Acquire the next pending task as a first-class lease. Use `--json` for agent automation.
- `--worktree <name>` — worktree to assign to (defaults to current folder name)
- `--agent <name>` — agent identifier for logging

### `switchman lease list`
List active and historical leases. Filter with `--status active|completed|failed|expired`.

### `switchman lease heartbeat <leaseId>`
Refresh the heartbeat timestamp for a long-running lease so it does not get treated as stale.

### `switchman lease reap`
Expire stale leases, release their claims, and return their tasks to `pending`.
- `--stale-after-minutes <n>` — staleness threshold (default: 15)

### `switchman task done <taskId>`
Mark a task complete and automatically release all file claims.

### `switchman task fail <taskId>`
Mark a task failed and automatically release all file claims.

### `switchman claim <taskId> <worktree> [files...]`
Lock files before editing. Warns immediately if any file is already claimed by another agent.

### `switchman release <taskId>`
Release all file claims for a task.

### `switchman scan`
Check all worktrees for conflicts — both uncommitted file overlaps and branch-level merge conflicts. Run this before merging.
By default, common generated paths such as `node_modules/`, `dist/`, `build/`, and `coverage/` are ignored.

### `switchman status`
Full overview: task counts, active leases, stale leases, locked files, and a quick conflict scan.

### `switchman worktree list`
List all git worktrees with their registered agents and status.

### `switchman worktree sync`
Re-sync git worktrees into the Switchman database (useful if you add worktrees after init).

---

## MCP tools (Claude Code)

| Tool | What it does |
|------|-------------|
| `switchman_task_next` | Get + assign the next pending task |
| `switchman_task_add` | Add a new task to the queue |
| `switchman_task_claim` | Claim files before editing (conflict check) |
| `switchman_task_done` | Mark task complete, release file claims |
| `switchman_task_fail` | Mark task failed, release file claims |
| `switchman_lease_heartbeat` | Refresh a long-running lease heartbeat |
| `switchman_scan` | Scan all worktrees for conflicts |
| `switchman_status` | Full system overview |

---

## Roadmap

- [ ] Merge queue — serialize worktree→main merges with auto-retry
- [ ] Automatic stale-lease policies — configurable heartbeat/reap behaviour
- [ ] Cursor and Windsurf native MCP integration
- [ ] Web dashboard
- [ ] `brew install switchman`

---

## Feedback & contact

Building this in public — if you're running parallel agents and hit something broken or missing, I'd love to hear about it.

- **GitHub Issues** — [github.com/switchman-dev/switchman/issues](https://github.com/switchman-dev/switchman/issues)
- **Email** — [hello@switchman.dev](mailto:hello@switchman.dev)

---

## License

MIT — free to use, modify, and distribute.
