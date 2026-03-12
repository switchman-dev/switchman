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

## Why Switchman?

Git worktrees, branches, and raw coding agents are useful, but they do not coordinate themselves.

That leaves teams doing a lot of manual work:
- deciding who should work on what
- making sure two agents do not edit the same files
- noticing when an agent stopped halfway through
- figuring out whether finished work is still safe to merge
- rebasing and landing several finished branches back onto `main`

Switchman removes that coordination tax.

What it adds that plain Git does not:
- task assignment, so agents do not duplicate work
- file locking, so parallel edits do not quietly collide
- live status, so you can see what is running, blocked, or stale
- stale-work recovery, so abandoned work does not clog the repo
- governed landing, so finished work reaches `main` one item at a time with retries and checks

In short:
- Git gives you branches
- Switchman gives you coordination

## Quickstart

Recommended first run:
- editor: Cursor
- goal: feel safe parallel agent work in under 10 minutes
- proof: status stays clear, agents stay separated, and the repo gate passes

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

Fastest path to success:
1. Use Cursor for the first run.
2. Open one Cursor window per generated workspace.
3. Let each agent pick up one clearly separate task.
4. Keep `switchman status --watch` open in another terminal.
5. Run `switchman gate ci` when the tasks finish.

If you want the recommended editor setup guide, start here:
- [docs/setup-cursor.md](/Users/ned/Documents/GitHub/switchman/docs/setup-cursor.md)

If you want a guided demo, see [examples/README.md](/Users/ned/Documents/GitHub/switchman/examples/README.md).

## What good looks like

You know the first run is working when:
- agents claim different files instead of stepping on each other
- `switchman status` stays calm and readable instead of filling with blocked work
- the landing queue moves finished work safely back toward `main`
- `switchman gate ci` passes cleanly

That is the moment Switchman should feel different from “just using a few branches.”

## Why not just use branches or worktrees?

Because branches and worktrees solve isolation, not coordination.

They help you create separate places to work, but they do not answer:
- which task should each agent take next
- who already owns a file
- whether two agents are overlapping in risky ways
- whether an abandoned session should be cleaned up
- whether a finished branch is still safe to land

Experienced developers can absolutely manage this by hand for a while.

The pain shows up when you run several agents at once:
- duplicated work
- overlapping edits
- stale half-finished branches
- merge cleanup at the end instead of coordination at the start

Switchman is for that moment.

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
