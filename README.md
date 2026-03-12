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

## First successful run: 3 agents on one repo

If you only try one thing, try this.

### 1. Create a test repo and three agent worktrees

```bash
cd my-project
switchman setup --agents 3
```

This gives you:
- one shared Switchman database in `.switchman/`
- three linked worktrees
- local `.mcp.json` files so Claude Code can discover Switchman automatically

### 2. Add three small, separate tasks

```bash
switchman task add "Implement auth helper" --priority 9
switchman task add "Add auth tests" --priority 8
switchman task add "Update auth docs" --priority 7
```

Use real tasks from your repo. If a task looks broad enough to fan out across many files or shared areas, Switchman will warn and suggest using `switchman pipeline start` instead.

### 3. Open one Claude Code window per worktree

Open each generated worktree folder in its own Claude Code window.

If Claude Code sees the local `.mcp.json`, each agent can use Switchman without extra setup.

### 4. Tell each agent to work through Switchman

Use this exact instruction:

```text
Use Switchman for all task coordination in this repo.

1. Run `switchman lease next --json` to get your task and lease.
2. Before editing anything, run `switchman claim <taskId> <worktree> <files...>`.
3. Only edit files you have claimed.
4. If a claim is blocked, do not use --force. Pick a different file or different approach.
5. When finished, run `switchman task done <taskId>`.

Do not read or write `.switchman/switchman.db` directly.
Do not bypass Switchman for file coordination.
```

### 5. Watch the run

In the repo root:

```bash
switchman status
switchman scan
```

What a good first run looks like:
- all three tasks end in `done`
- `switchman scan` reports no conflicts
- `switchman gate ci` passes

### 6. If you want a built-in local demo instead

```bash
bash examples/setup.sh
bash examples/walkthrough.sh
```

That runs the included 3-agent demo against the example API in [examples/README.md](/Users/ned/Documents/GitHub/switchman/examples/README.md).

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

## If something goes wrong

Start here before digging into the internals.

### `switchman status`

Use this first when a run feels stuck.

It answers:
- what is running
- what is blocked
- what failed
- what needs attention next

### `switchman scan`

Use this before merge, or any time you suspect agents overlapped.

It tells you:
- changed files per worktree
- unclaimed or unmanaged changes
- conflict signals across worktrees

### `switchman gate ci`

Use this as the final repo-level check.

```bash
switchman gate ci
```

If it fails, Switchman has detected unmanaged changes, stale state, or merge-governance problems.

### Common recovery cases

`A file claim is blocked`
- another task already owns that file
- do not use `--force`
- choose a different file or let the other task finish first

`A task is still in progress but the agent is gone`
- inspect with `switchman status`
- if the lease is stale, run:

```bash
switchman lease reap
```

`A pipeline task failed`
- run:

```bash
switchman pipeline status <pipelineId>
```

Switchman now prints:
- `why:` what failed
- `next:` what to do next

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
When the task has an active lease, Switchman finalises the execution through that lease so provenance stays tied to the live session.

### `switchman task fail <taskId>`
Mark a task failed and automatically release all file claims.
When the task has an active lease, Switchman records the failure against that lease so execution history stays lease-first.

### `switchman claim <taskId> <worktree> [files...]`
Lock files before editing. Warns immediately if any file is already claimed by another agent.

### `switchman release <taskId>`
Release all file claims for a task.

### `switchman scan`
Check all worktrees for conflicts — both uncommitted file overlaps and branch-level merge conflicts. Run this before merging.
By default, common generated paths such as `node_modules/`, `dist/`, `build/`, and `coverage/` are ignored.

### `switchman status`
Full overview: task counts, active leases, stale leases, locked files, a quick conflict scan, and readable failure explanations.

### `switchman worktree list`
List all git worktrees with their registered agents and status.

### `switchman worktree sync`
Re-sync git worktrees into the Switchman database (useful if you add worktrees after init).

---

## Pipelines and PRs

Switchman can now take a backlog item through planning, governed execution, review, and PR handoff.

### Happy-path pipeline flow

```bash
switchman pipeline start "Harden auth API permissions" \
  --description "Update login permissions for the public API and add migration checks"

switchman pipeline exec pipe-123 "/path/to/your-agent-command"
switchman pipeline status pipe-123
switchman pipeline pr pipe-123
switchman pipeline publish pipe-123 --base main --draft
```

The intended operator loop is:
1. start the pipeline
2. run it
3. inspect `pipeline status` if anything blocks
4. review the PR artifact or publish the PR

### Create a pipeline from one issue

```bash
switchman pipeline start "Harden auth API permissions" \
  --description "Update login permissions for the public API and add migration checks"
```

This creates structured subtasks with task specs, dependencies, and suggested worktrees.

### Run the pipeline

```bash
switchman pipeline exec pipe-123 "/path/to/your-agent-command"
```

This dispatches dependency-ready tasks, launches agents with `SWITCHMAN_*` task context, applies retries/timeouts from the task spec, and runs review follow-ups until the pipeline is ready or blocked.

### Generate a reviewer-facing PR summary

```bash
switchman pipeline pr pipe-123
switchman pipeline pr pipe-123 --json
```

Use this to inspect the current PR-ready summary, gate results, risk notes, and provenance.
Completed work provenance now includes the lease that executed the work, not just the task and worktree.

### Export a PR bundle

```bash
switchman pipeline bundle pipe-123 .switchman/pr-bundles/auth-hardening
```

This writes:

- `pr-summary.json`
- `pr-summary.md`
- `pr-body.md`

The exported reviewer bundle includes lease-aware provenance, so a reviewer can see which execution session produced each completed task.

### Publish a GitHub PR

```bash
switchman pipeline publish pipe-123 --base main --draft
```

This uses `gh pr create` with the generated PR title and body. Requirements:

- GitHub CLI (`gh`) installed
- `gh auth login` already completed
- the pipeline worktree branch pushed or otherwise available as the PR head branch

---

## CI and GitHub Actions

Switchman can publish CI-friendly gate output and install a ready-to-run GitHub Actions workflow.

### Run the repo gate in CI

```bash
switchman gate ci
switchman gate ci --json
switchman gate ci --github
```

`switchman gate ci` fails non-zero when the repo contains unmanaged changes, stale compliance problems, or merge-governance issues.

When run under GitHub Actions with `--github`, Switchman writes:

- a step summary markdown report
- `GITHUB_OUTPUT` values such as `switchman_ok=true|false`

You can also point these explicitly:

```bash
switchman gate ci \
  --github-step-summary /path/to/summary.md \
  --github-output /path/to/output.txt
```

### Install the GitHub Actions workflow

```bash
switchman gate install-ci
```

This writes `.github/workflows/switchman-gate.yml`, which runs the Switchman CI gate on pushes and pull requests.

---

## Tamper-evident audit trail

Switchman now keeps a signed audit trail for governed work.

Every audit event is:
- appended with a monotonic sequence number
- chained to the previous event with `prev_hash`
- hashed into its own `entry_hash`
- signed with a per-project audit key stored at `.switchman/audit.key`

That means Switchman can detect if someone edits stored audit history after the fact.

### Verify the audit trail

```bash
switchman audit verify
switchman audit verify --json
```

Use this when you want proof that the recorded history still matches the project audit key and the stored event chain.

What a successful verification means:
- every event is still in the expected sequence
- every `prev_hash` still matches the prior event
- every event payload still matches its stored `entry_hash`
- every signature still matches the project audit key

If verification fails, Switchman exits non-zero and reports the reason, for example:
- `sequence_gap`
- `prev_hash_mismatch`
- `entry_hash_mismatch`
- `signature_mismatch`

This is different from normal CI:
- `switchman gate ci` answers whether the repo is safe and governed right now
- `switchman audit verify` answers whether the recorded audit history has been tampered with

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
