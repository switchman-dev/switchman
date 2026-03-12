# Command Reference

## Setup

### `switchman demo`
- creates a self-contained demo repo
- proves an overlapping claim gets blocked
- lands the demo work safely through the queue

### `switchman setup`
- creates agent workspaces
- initialises the database
- writes `.mcp.json` and `.cursor/mcp.json` to the repo root and each generated workspace

Useful options:
- `--agents 3`
- `--prefix switchman`

### `switchman init`
- initialise in the current git repo without creating extra workspaces

## Tasks and leases

Plain-English note:
- `lease` means “this task is currently checked out by an agent”
- `worktree` in command names means the agent workspace folder

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

### `switchman claim <taskId> <worktree> [files...]`
### `switchman release <taskId>`
### `switchman scan`
### `switchman status`
### `switchman worktree list`
### `switchman worktree sync`

## Merge and pipelines

### `switchman queue add`
### `switchman queue list`
### `switchman queue status`
### `switchman queue run`
### `switchman queue retry`
### `switchman queue remove`
### `switchman pipeline start`
### `switchman pipeline exec`
### `switchman pipeline status`
### `switchman pipeline pr`
### `switchman pipeline bundle`
- writes reviewer-ready bundle artifacts for a pipeline
- adds GitHub-friendly step summary and output keys with `--github`
### `switchman pipeline comment`
- posts or updates the landing summary on a PR
- can read the PR number from GitHub Actions with `--pr-from-env`
### `switchman pipeline publish`

## MCP and CI

### `switchman mcp install --windsurf`
### `switchman gate ci`
### `switchman gate install-ci`
- installs a GitHub Actions workflow with a named Switchman PR check
- keeps the Switchman summary visible before the workflow fails the check
### `switchman audit verify`
