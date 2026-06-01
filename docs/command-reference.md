# Command Reference

Use this page when you already know what kind of action you need.

If you are brand new to Switchman, start with:
- `switchman review` for a zero-config first read of local git worktrees
- `switchman review --pr-ready` when you need to know whether parallel AI work is safe to merge
- `switchman review --pr-ready --all-worktrees` when agents already ran in local git worktrees
- `switchman review --pr-ready --from branch-a branch-b` when agents already ran on branches
- `switchman review --pr-ready --from branch-a branch-b --out switchman-review.md` when you want a PR handoff file
- `switchman gate ci` when the review looks good and you want a local merge gate
- `switchman demo` for the shortest proof before trying it on a real repo

## Review and merge confidence

### `switchman review`
- works without `switchman init`; if no Switchman database exists, it reviews local git worktrees from git evidence
- `--pr-ready` prints a PR-ready Markdown merge confidence report
- `--all-worktrees` reviews all non-main git worktrees from git evidence, even if Switchman did not manage them
- `--from <refs...>` reviews existing branches, refs, or worktree names from git evidence
- `--base <branch>` chooses the base branch for unmanaged review mode
- `--out <path>` writes the PR-ready Markdown report to a file
- `--history` shows retained session history
- `--search <query>` filters retained history to matching sessions

### `switchman gate ci`
- runs the repo-level merge gate locally or in CI
- checks file conflicts, semantic conflicts, stale leases, unclaimed changes, and boundary validation state
- `--github-comment --pr-from-env` posts or updates the PR comment with the green/amber/red merge-confidence summary

### `switchman gate install-ci`
- installs a GitHub Actions workflow with a named Switchman PR check
- keeps the Switchman summary visible before the workflow fails the check
- grants `pull-requests: write` so GitHub Actions can post the Switchman PR comment

### `switchman status`
- use this when Switchman managed the run and you are not sure what needs attention next

### `switchman demo`
- creates a self-contained demo repo
- proves an overlapping claim gets blocked
- lands the demo work safely through the queue
- best first command if you want to see the product work before wiring a real repo

## Advanced managed coordination

Use these when you want Switchman to create workspaces, assign tasks, manage leases, or govern agents through MCP.

### `switchman quickcheck`
- checks whether the current repo is ready for a managed Switchman run

### `switchman start "Add authentication"`
- plans work, creates agent workspaces, writes MCP config, and starts the managed run

### `switchman setup`
- creates agent workspaces
- initialises the database
- writes `.mcp.json` and `.cursor/mcp.json` to the repo root and each generated workspace
- current agent workspace cap: `10`

Useful options:
- `--agents 3`
- `--prefix switchman`

### `switchman init`
- initialise in the current git repo without creating extra workspaces
- useful when you want full coordination mode; for existing agent worktrees, start with `switchman review --all-worktrees`

### `switchman task add <title>`
### `switchman task list`
### `switchman task retry <taskId>`
### `switchman task retry-stale`
- resets all stale tasks, or all stale tasks for one pipeline, back to `pending`
- useful after shared-boundary changes invalidate several completed tasks at once
### `switchman task done <taskId>`
### `switchman task fail <taskId>`
### `switchman lease next`
### `switchman lease list`
### `switchman lease heartbeat <leaseId>`
### `switchman lease reap`
### `switchman lease policy`
### `switchman lease policy set`
### `switchman claim <taskId> <worktree> [files...]`
- use this before editing shared files in a managed run
- `--force` is for operator-led recovery only, not normal agent flow
### `switchman release <taskId>`
### `switchman scan`

## Reports and history

### `switchman insights`
- cross-session hotspot reporting for recurring amber-or-worse areas and validation gaps
- useful filters: `--days 30`, `--json`
### `switchman usage`
- reporting for token and cost usage by session, agent, and time window
- useful filters: `--days 30`, `--session <id>`, `--agent <name>`, `--task <id>`
### `switchman usage record`
- manual write path for agent/token/cost events when you want to backfill or integrate a custom runner
### `switchman worktree list`
### `switchman worktree sync`

## Merge and pipelines

Use this group when work is already running and you need to decide what lands, what waits, or what needs recovery.

### `switchman queue add`
### `switchman queue list`
### `switchman queue status`
### `switchman queue run`
- supports `--follow-plan` to only auto-run current `land_now` candidates
- supports `--merge-budget <n>` to cap how many successful merges one run is allowed to consume
### `switchman queue retry`
### `switchman queue remove`
### `switchman pipeline start`
- creates one tracked pipeline with structured subtasks
- use this when the work is too broad for one safe task
### `switchman pipeline exec`
- runs the pipeline through one agent command and records structured outcomes per task
### `switchman pipeline status`
- use this when you need to understand what is blocked, stale, policy-gated, or ready to land
### `switchman pipeline pr`
### `switchman pipeline bundle`
- writes reviewer-ready bundle artifacts for a pipeline
- adds GitHub-friendly step summary and output keys with `--github`
### `switchman pipeline comment`
- posts or updates the landing summary on a PR
- can read the PR number from GitHub Actions with `--pr-from-env`
### `switchman pipeline sync-pr`
- bundles pipeline artifacts, updates the PR comment, and writes GitHub outputs together
- useful as the single CI handoff command for pipeline reviews
### `switchman pipeline publish`
- creates the hosted PR from the generated bundle once the governed landing state is ready

Useful explain and recovery commands in this area:
- `switchman explain queue <itemId>`
- `switchman explain landing <pipelineId>`
- `switchman pipeline land <pipelineId> --refresh`
- `switchman pipeline land <pipelineId> --recover`
- `switchman pipeline land <pipelineId> --resume`

## MCP, policy, and audit

### `switchman mcp install --windsurf`
### `switchman policy init-change`
### `switchman policy show-change`
### `switchman audit verify`
