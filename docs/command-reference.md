# Command Reference

Use this page when you already know what kind of action you need.

If you are brand new to Switchman, start with:
- `switchman demo` for the shortest proof
- `switchman setup --agents 5` for a real repo
- `switchman status` when you are not sure what to do next

## Setup

### `switchman demo`
- creates a self-contained demo repo
- proves an overlapping claim gets blocked
- lands the demo work safely through the queue
- best first command if you want to see the product work before wiring a real repo

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

## Tasks and leases

Plain-English note:
- `lease` means “this task is currently checked out by an agent”
- `worktree` in command names means the agent workspace folder

Most-used first-run commands:
- `switchman task add <title>`
- `switchman task next --worktree <name>`
- `switchman task done <taskId>`
- `switchman task retry-stale --pipeline <pipelineId>`

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

## Coordination

When work feels unclear, these are the front doors:
- `switchman status`
- `switchman explain claim <path>`
- `switchman explain queue <itemId>`
- `switchman explain stale --pipeline <pipelineId>`

### `switchman claim <taskId> <worktree> [files...]`
- use this before editing shared files
- `--force` is for operator-led recovery only, not normal agent flow
- only use `--force` after checking `switchman status` or `switchman explain claim <path>` and confirming the existing claim is stale or wrong
### `switchman release <taskId>`
### `switchman scan`
### `switchman status`
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

## MCP and CI

### `switchman mcp install --windsurf`
### `switchman gate ci`
### `switchman gate install-ci`
- installs a GitHub Actions workflow with a named Switchman PR check
- keeps the Switchman summary visible before the workflow fails the check
### `switchman policy init-change`
### `switchman policy show-change`
### `switchman audit verify`
