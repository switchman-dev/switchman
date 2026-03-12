# Switchman

**Run 10+ agents on one codebase. Safely.**

Switchman acts like a project manager for your AI coding assistants. It hands out tasks, stops agents from editing the same file at the same time, and double-checks their work before saving.

When you run multiple agents on the same repo, they need shared coordination or they collide, duplicate work, and create risky merges. Switchman gives them leases, scoped ownership, merge gates, and landing workflows so they can move in parallel without stepping on each other.

Plain-English note:
- `workspace` means the folder each agent works in
- some commands still use the Git term `worktree`, because that is the underlying Git feature

Questions, feedback, or testing Switchman with your team? Join the [Discord](https://discord.gg/pnT8BEC4D)

## Install

Requirements:
- Node.js 22.5+
- Git 2.5+

```bash
npm install -g @switchman-dev
```

## Quickstart

```bash
cd my-project
switchman setup --agents 5

switchman task add "Implement auth helper" --priority 9
switchman task add "Add auth tests" --priority 8
switchman task add "Update auth docs" --priority 7

switchman status
switchman status --watch
switchman gate ci
```

What `switchman setup` gives you:
- one shared Switchman database in `.switchman/`
- linked workspaces for each agent
- local MCP config for Claude Code and Cursor

If you want a guided demo, see [examples/README.md](/Users/ned/Documents/GitHub/switchman/examples/README.md).

## Choose your setup

Pick the guide that matches how you work:

| Setup | Guide |
|------|------|
| Claude Code | [docs/setup-claude-code.md](/Users/ned/Documents/GitHub/switchman/docs/setup-claude-code.md) |
| Cursor | [docs/setup-cursor.md](/Users/ned/Documents/GitHub/switchman/docs/setup-cursor.md) |
| Windsurf | [docs/setup-windsurf.md](/Users/ned/Documents/GitHub/switchman/docs/setup-windsurf.md) |
| Any CLI-driven agent | [docs/setup-cli-agents.md](/Users/ned/Documents/GitHub/switchman/docs/setup-cli-agents.md) |

## What Switchman does

- hands out work so agents stay on separate tracks
- prevents overlapping edits with file claims and scoped ownership
- keeps long-running work alive with leases and heartbeats
- flags stale or risky work before merge
- lands finished work back onto `main` through a governed merge queue
- checks the repo with safety gates, review checks, and CI output

## Start here when something feels stuck

Use `switchman status` first.

It is the main terminal dashboard for the repo:
- top health banner and compact counts
- boxed sections for `Running`, `Blocked`, `Warnings`, `Queue`, and `Next action`
- exact follow-up commands when something needs attention
- `--watch` mode for a live terminal view

Useful commands:

```bash
switchman status
switchman status --watch
switchman status --json
switchman scan
switchman gate ci
```

More help:
- [docs/status-and-recovery.md](/Users/ned/Documents/GitHub/switchman/docs/status-and-recovery.md)
- [docs/merge-queue.md](/Users/ned/Documents/GitHub/switchman/docs/merge-queue.md)
- [docs/stale-lease-policy.md](/Users/ned/Documents/GitHub/switchman/docs/stale-lease-policy.md)

## Core workflows

- Merge queue: [docs/merge-queue.md](/Users/ned/Documents/GitHub/switchman/docs/merge-queue.md)
- Pipelines and PRs: [docs/pipelines.md](/Users/ned/Documents/GitHub/switchman/docs/pipelines.md)
- Stale lease policy: [docs/stale-lease-policy.md](/Users/ned/Documents/GitHub/switchman/docs/stale-lease-policy.md)
- MCP tools: [docs/mcp-tools.md](/Users/ned/Documents/GitHub/switchman/docs/mcp-tools.md)

## Command reference

The full command guide lives here:
- [docs/command-reference.md](/Users/ned/Documents/GitHub/switchman/docs/command-reference.md)

## Feedback

Building this in public. If you're running parallel agents and hit something broken or missing, I’d love to hear about it.

- GitHub Issues: [github.com/switchman-dev/switchman/issues](https://github.com/switchman-dev/switchman/issues)
- Email: [hello@switchman.dev](mailto:hello@switchman.dev)

## License

MIT
