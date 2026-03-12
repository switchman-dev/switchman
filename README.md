# Switchman

**Run 10+ agents on one codebase. Safely.**

Switchman acts like a project manager for your AI coding assistants. It hands out tasks, stops agents from editing the same file at the same time, and double-checks their work before saving.

When you run multiple agents on the same repo, they need shared coordination or they collide, duplicate work, and create risky merges. Switchman gives them leases, scoped ownership, merge gates, and landing workflows so they can move in parallel without stepping on each other.

In the docs, `workspace` means the folder each agent works in. Some commands still use the Git term `worktree`, because that is the underlying Git feature.

Questions, feedback, or testing Switchman with your team? Join the [Discord](https://discord.gg/pnT8BEC4D)

## Install

Requirements:
- Node.js 22.5+
- Git 2.5+

```bash
npm install -g @switchman-dev
```

## 2 minute proof

If you want the fastest possible “does this actually work?” run:

```bash
switchman demo
```

That creates a throwaway repo and shows:
- one agent claiming `src/auth.js`
- another agent getting blocked from claiming the same file
- that second agent rerouting to a safe docs file instead
- both branches landing back through the queue cleanly

Typical proof output looks like:

```text
$ switchman demo
✓ Created Switchman demo repo
  /tmp/switchman-demo-1234567890
  proof: agent2 was blocked from src/auth.js
  safe reroute: agent2 claimed docs/auth-flow.md instead
  landing: 2 queue item(s) merged safely

Try these next:
  cd /tmp/switchman-demo-1234567890
  switchman status
  switchman queue status
```

Then inspect it:

```bash
cd /tmp/switchman-demo-...
switchman status
switchman queue status
```

## Why Switchman?

Git worktrees, branches, and raw coding agents are useful, but they do not coordinate themselves.

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
- editor: Claude Code
- goal: feel safe parallel agent work in under 10 minutes
- proof: status stays clear, agents stay separated, and the repo gate passes

```bash
cd my-project
switchman setup --agents 5
switchman verify-setup

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
1. Use Claude Code for the first run.
2. Run `switchman verify-setup` once so editor wiring is confirmed before you start.
3. Open one Claude Code window per generated workspace.
4. Let each agent pick up one clearly separate task.
5. Keep `switchman status --watch` open in another terminal.
6. Run `switchman gate ci` when the tasks finish.

If you want the recommended editor setup guide, start here:
- [Claude Code setup](docs/setup-claude-code.md)

If you want a guided demo, see [examples/README.md](examples/README.md).

## What good looks like

You know the first run is working when:
- agents claim different files instead of stepping on each other
- `switchman status` stays calm and readable instead of filling with blocked work
- the landing queue moves finished work safely back toward `main`
- `switchman gate ci` passes cleanly

That is the moment Switchman should feel different from “just using a few branches.”

## Why not just use branches or worktrees?

Because branches and worktrees solve isolation, not coordination.

They do not tell you:
- which task each agent should take next
- who already owns a file
- whether a session is stale
- whether finished work is still safe to land

Switchman is for the point where “we can manage this by hand” stops being true.

## Choose your setup

Pick the guide that matches how you work:

| Setup | Guide |
|------|------|
| Claude Code | [Claude Code setup](docs/setup-claude-code.md) |
| Cursor | [Cursor setup](docs/setup-cursor.md) |
| Windsurf | [Windsurf setup](docs/setup-windsurf.md) |
| Any CLI-driven agent | [CLI agent setup](docs/setup-cli-agents.md) |

## If something feels stuck

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
- [Status and recovery](docs/status-and-recovery.md)
- [Merge queue](docs/merge-queue.md)
- [Stale lease policy](docs/stale-lease-policy.md)
- [Telemetry](docs/telemetry.md)

## Turn On PR Checks

If you want GitHub to block risky changes the same way your local terminal does:

```bash
switchman gate install-ci
```

That installs `.github/workflows/switchman-gate.yml`, which:
- runs `switchman gate ci --github` on pushes and pull requests
- publishes a readable Switchman summary into the GitHub job output
- fails the PR check when Switchman detects unmanaged changes, stale work, or risky overlap

For pipeline-specific landing state in GitHub job summaries or PR checks, use:

```bash
switchman pipeline bundle pipe-123 --github
```

## More docs

- [Merge queue](docs/merge-queue.md)
- [Pipelines and PRs](docs/pipelines.md)
- [Stale lease policy](docs/stale-lease-policy.md)
- [MCP tools](docs/mcp-tools.md)
- [Telemetry](docs/telemetry.md)
- [Command reference](docs/command-reference.md)

## Feedback

Building this in public. If you're running parallel agents and hit something broken or missing, I’d love to hear about it.

- GitHub Issues: [github.com/switchman-dev/switchman/issues](https://github.com/switchman-dev/switchman/issues)
- Email: [hello@switchman.dev](mailto:hello@switchman.dev)

## License

MIT
