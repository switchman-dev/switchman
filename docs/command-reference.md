# Command Reference

## Setup

### `switchman setup`
- creates agent workspaces
- initialises the database
- writes `.mcp.json` and `.cursor/mcp.json` to the repo root and each generated worktree

Useful options:
- `--agents 3`
- `--prefix switchman`

### `switchman init`
- initialise in the current git repo without creating worktrees

## Tasks and leases

### `switchman task add <title>`
### `switchman task list`
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
### `switchman pipeline publish`

## MCP and CI

### `switchman mcp install --windsurf`
### `switchman gate ci`
### `switchman gate install-ci`
### `switchman audit verify`
