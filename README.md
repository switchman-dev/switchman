# Switchman

**Run 10+ agents on one codebase. Safely.**

[![CI](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml/badge.svg)](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/switchman-dev.svg)](https://www.npmjs.com/package/switchman-dev)

Switchman is the coordination and governance layer for AI-native software teams. It helps you plan work, route tasks across agents, prevent overlap, and land changes safely instead of stitching parallel output back together by hand.

When you run multiple agents on the same repo, they need shared coordination or they collide, duplicate work, and create risky merges. Switchman gives them leases, scoped ownership, policy gates, queue planning, and governed landing workflows so they can move in parallel without stepping on each other.

In the docs, `workspace` means the folder each agent works in. Some commands still use the Git term `worktree`, because that is the underlying Git feature.

Questions, feedback, or testing Switchman with your team? Join the [Discord](https://discord.gg/pnT8BEC4D)

## Install

Requirements:
- Node.js 22.5+
- Git 2.5+

Why Node 22.5+?
- Switchman uses the built-in `node:sqlite` runtime support for its repo-local coordination database.
- Keeping that dependency in the Node runtime makes install and recovery simpler, but it currently means targeting newer Node releases on purpose.

TypeScript and API surface
- Switchman is CLI-first today. The supported interface is the `switchman` command and the MCP integration, not a stable embeddable library API yet.
- That means there are no published TypeScript types right now by design. We plan to add typed surfaces once the programmatic API is stable enough to support cleanly.

```bash
npm install -g switchman-dev
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
- task planning, so incoming goals can be broken into governed parallel work
- task assignment, so agents do not duplicate work
- file locking, so parallel edits do not quietly collide
- live status, so you can see what is running, blocked, or stale
- stale-work recovery, so abandoned work does not clog the repo
- queue intelligence, so the clearest work lands first across competing goals
- governed landing, so finished work reaches `main` one item at a time with retries, checks, and policy enforcement

In short:
- Git gives you branches
- Switchman gives you coordination, governance, and a safe path to land

## Quickstart

Recommended first run:
- editor: Claude Code
- goal: feel safe parallel agent work in under 10 minutes
- proof: status stays clear, agents stay separated, and the repo gate passes

```bash
cd my-project
switchman demo
switchman setup --agents 3
switchman task add "Implement auth helper" --priority 9
switchman status --watch
switchman gate ci
switchman queue run
```

If you only do five things on the first run, do these:
1. `switchman demo`
2. `switchman setup --agents 3`
3. `switchman task add "Implement auth helper" --priority 9`
4. `switchman status --watch`
5. `switchman gate ci && switchman queue run`

What `switchman setup` gives you:
- one shared Switchman database in `.switchman/`
- linked workspaces for each agent
- local MCP config for Claude Code and Cursor

Current limit:
- `switchman setup --agents` currently supports up to `10` agent workspaces in one command

Fastest path to success:
1. Use Claude Code for the first run.
2. Run `switchman verify-setup` once so editor wiring is confirmed before you start.
3. Open one Claude Code window per generated workspace.
4. Add clear tasks before the agents start.
5. Let each agent pick up one clearly separate task.
6. Keep `switchman status --watch` open in another terminal.
7. Run `switchman gate ci`, then `switchman queue run`, when the tasks finish.

If you want the recommended editor setup guide, start here:
- [Claude Code setup](docs/setup-claude-code.md)

If you want a guided demo, see [examples/README.md](examples/README.md).
If you want the deeper multi-task planning and PR workflow, see [docs/pipelines.md](docs/pipelines.md).

> Free tier supports up to 3 agents. Run `switchman upgrade` for unlimited.

## What good looks like

You know the first run is working when:
- agents claim different files instead of stepping on each other
- `switchman status` stays calm and readable instead of filling with blocked work
- the landing queue moves finished work safely back toward `main`
- `switchman gate ci` passes cleanly

That is the moment Switchman should feel different from “just using a few branches.”

## Start Here

If you are trying to decide where to start:
- want the fastest proof: run `switchman demo`
- want to wire up a real repo: run `switchman setup --agents 3`
- want to add real work: run `switchman task add "Your task" --priority 8`
- want to understand blocked or stale work: run `switchman status`
- want a longer hands-on walkthrough: open [examples/README.md](examples/README.md)

## Enforcement Gateway

Switchman is strongest when agents write through the governed gateway instead of editing files directly.

- MCP agents should prefer `switchman_write_file`, `switchman_append_file`, `switchman_make_directory`, `switchman_move_path`, and `switchman_remove_path`
- CLI operators can use `switchman write` and `switchman wrap` for governed writes and wrapped commands
- `switchman monitor` is started automatically by `switchman setup` unless you opt out, so rogue edits are detected in the background

That closes the gap between "please follow the claiming protocol" and "Switchman can actually catch ungoverned writes when something goes wrong."

## The Workflow

Switchman is built for the workflow of turning multiple competing engineering goals into coordinated parallel execution and a trusted, dependency-aware path to merge.

In practice, that means it helps teams:
- break work into parallel tasks
- assign work across agents and humans
- stop overlapping edits early
- detect stale or drifted work before merge chaos
- route validation and governance follow-ups
- decide what should land next
- leave an audit trail of what happened and why

## Real-World Walkthrough

Here is what a real first team workflow can look like across several goals in one shared repo:

1. Product work arrives:
   - harden auth flows
   - ship a schema update
   - refresh related docs
2. You create parallel work:

```bash
switchman setup --agents 5
switchman task add "Harden auth middleware" --priority 9
switchman task add "Ship schema migration" --priority 8
switchman task add "Update auth and schema docs" --priority 6
switchman status --watch
```

3. Agents pick up work in separate workspaces:
   - agent1 takes auth
   - agent2 takes the migration
   - agent3 takes docs
4. If two agents reach for the same file, Switchman blocks the second claim early instead of letting the overlap turn into merge cleanup later.
5. While work is running, `switchman status` shows:
   - what is active
   - what is blocked
   - what has gone stale
   - what should land next
6. When branches finish, queue them:

```bash
switchman queue add agent1
switchman queue add agent2
switchman queue add agent3
switchman queue status
switchman queue run --follow-plan --merge-budget 2
```

7. If a shared change invalidates another task, Switchman marks it stale and points at the exact recovery command instead of leaving the team to guess.
8. Before merge, run the repo gate:

```bash
switchman gate ci
```

What good looks like:
- each agent stayed in its own lane
- overlap was blocked before wasted work spread
- stale work was visible instead of silently wrong
- the queue made it obvious what should land now and what should wait
- the repo reached `main` through a governed path instead of manual merge babysitting

## Why not just use branches or worktrees?

Because branches and worktrees solve isolation, not coordination.

They do not tell you:
- which task each agent should take next
- who already owns a file
- whether a session is stale
- whether finished work is still safe to land

Switchman is for the point where “we can manage this by hand” stops being true.

## Safety note on `--force`

`switchman claim --force` exists for manual recovery, not normal operation.

Legitimate use:
- you have already confirmed the conflicting claim is stale, abandoned, or otherwise incorrect
- you are performing operator-led cleanup and need to unblock the repo deliberately

Not a legitimate use:
- "the other agent is probably done"
- "I just want to keep moving"
- "we'll clean it up in the PR later"

Normal path:
1. run `switchman status`
2. run `switchman explain claim <path>`
3. reap or retry the stale work if needed
4. only then use `--force` if you intentionally want to override a known-bad claim

If that feels too risky, that is the point. It is meant to be an escape hatch, not a convenience flag.

## Releases and changelog

If you want to track what changed between versions:
- [CHANGELOG.md](CHANGELOG.md)
- [GitHub releases](https://github.com/switchman-dev/switchman/releases)

## What's included today

Today Switchman already includes:
- agent worktree setup and repo verification
- lease, claim, heartbeat, and stale-reap coordination
- governed write gateways and a rogue-edit monitor
- repo status, repair, queue planning, and safe landing
- pipeline planning, execution, PR bundles, and GitHub sync
- audit trail, change policy enforcement, and CI integration
- MCP support for Claude Code, Cursor, and Windsurf

## Switchman Pro

Pro gives you unlimited agents, cloud-synced team coordination, and 90-day history.

```bash
switchman upgrade       # open switchman.dev/pro in your browser
switchman login         # activate Pro after subscribing
switchman login --status  # check your current plan
```

**What's included in Pro:**
- Unlimited concurrent agents (free tier: up to 3)
- Cloud-synced task queues and lease state across your team
- Team invites — `switchman team invite alice@example.com`
- AI task planning — `switchman plan "Add authentication"` proposes parallel tasks from an explicit goal
- 90-day audit trail (free tier: 7 days)
- Email support within 48 hours

**Pricing:** $25/month or $250/year per seat · [switchman.dev/pro](https://switchman.dev/pro)

After subscribing, activate in your terminal:
```bash
switchman login
# Opens GitHub sign-in, saves credentials locally
# Credentials cached 24h · works offline for 7 days

switchman setup --agents 10
# Pro removes the 3-agent limit
```

### Pro planning launch order

Switchman Pro planning ships in this order:
- `switchman plan "goal"` first
- `switchman plan --issue 47` next
- zero-argument `switchman plan` later, once real usage data makes that inference trustworthy

Today, the supported Pro planning flow is:

```bash
switchman plan "Add authentication"
switchman plan "Add authentication" --apply
```

## What's next

The next product steps are:
- `switchman plan --issue 47`
- a more magical zero-argument planning flow that can read richer repo and issue context
- a web dashboard for repo and landing visibility
- a Homebrew install path for faster first-run setup

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

The most useful explain commands when something is unclear:

```bash
switchman explain claim src/auth/login.js
switchman explain queue <item-id>
switchman explain stale --pipeline <pipeline-id>
switchman explain landing <pipeline-id>
```

## Turn On PR Checks

If you want GitHub to block risky changes the same way your local terminal does:

```bash
switchman gate install-ci
```

That installs `.github/workflows/switchman-gate.yml`, which:
- runs `switchman gate ci --github` on pushes and pull requests
- auto-runs `switchman pipeline sync-pr --pipeline-from-env --skip-missing-pipeline --pr-from-env --github` on pull request updates
- publishes a readable Switchman summary into the GitHub job output
- fails the PR check when Switchman detects unmanaged changes, stale work, or risky overlap

For pipeline-specific landing state in GitHub job summaries or PR checks, use:

```bash
switchman pipeline bundle pipe-123 --github
```

If you want one command that bundles artifacts, updates the PR comment, and emits GitHub outputs together:

```bash
switchman pipeline sync-pr pipe-123 --pr-from-env --github
```

## Add Change Policy

If you want Switchman to enforce extra review or validation for high-risk areas like auth, schema, or payments:

```bash
switchman policy init-change
switchman policy show-change
```

That writes `.switchman/change-policy.json`, which planning and follow-up generation use to require the right tests, docs, and governance work before landing.

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
