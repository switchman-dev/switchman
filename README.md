# Switchman

**The operating system for parallel AI development.**

[![CI](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml/badge.svg)](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/switchman-dev.svg)](https://www.npmjs.com/package/switchman-dev)

When you run multiple AI agents on the same repo, they collide, duplicate work, and create risky merges. Switchman gives them leases, scoped ownership, policy gates, queue planning, and governed landing workflows so they can move in parallel without stepping on each other.

Questions or feedback? Join the [Discord](https://discord.gg/pnT8BEC4D) · [hello@switchman.dev](mailto:hello@switchman.dev)

---

## Install

Requirements: Node.js 22.5+ · Git 2.5+

```bash
npm install -g switchman-dev
```

> Switchman uses the built-in `node:sqlite` runtime — no extra database to install or manage.

---

## 2 minute proof

```bash
switchman demo
```

Creates a throwaway repo and shows:
- agent1 claiming `src/auth.js`
- agent2 getting blocked from the same file
- agent2 rerouting safely to `docs/auth-flow.md`
- both branches landing cleanly through the queue

Then inspect it:

```bash
cd /tmp/switchman-demo-...
switchman status
switchman queue status
```

---

## Switchman Pro

> **Unlimited agents · Team coordination · AI planning · $25/month**  
> [switchman.dev/pro](https://switchman.dev/pro) · or run `switchman upgrade`

Pro removes the 3-agent limit, adds cloud-synced team coordination, AI task planning, and 90-day history. Free tier stays fully featured and MIT licensed forever.

```bash
switchman upgrade        # open switchman.dev/pro
switchman login          # activate after subscribing
switchman login --status # check your plan
```

**What's in Pro:**
- Unlimited concurrent agents (free: up to 3)
- Cloud-synced team activity across machines
- Team invites — `switchman team invite alice@example.com`
- AI task planning — `switchman plan "Add authentication" --apply` or `switchman plan --issue 47`
- 90-day audit trail (free: 7 days)
- Email support within 48 hours

**$25/month or $250/year per seat** · [switchman.dev/pro](https://switchman.dev/pro)

---

## Quickstart

```bash
cd my-project
switchman setup --agents 3
switchman task add "Implement auth helper" --priority 9
switchman status --watch
switchman gate ci
switchman queue run
```

What `switchman setup` gives you:
- a shared Switchman database in `.switchman/`
- linked agent workspaces
- MCP config for Claude Code and Cursor

Fastest path to success:
1. Use Claude Code for the first run
2. Run `switchman verify-setup` to confirm editor wiring
3. Open one Claude Code window per generated workspace
4. Add tasks before agents start
5. Keep `switchman status --watch` open in a separate terminal
6. Run `switchman gate ci && switchman queue run` when tasks finish

Editor setup guides:
- [Claude Code](docs/setup-claude-code.md)
- [Cursor](docs/setup-cursor.md)
- [Windsurf](docs/setup-windsurf.md)

---

## Why Switchman?

Git gives you branches. Switchman gives you coordination.

Branches and worktrees solve isolation — they do not tell you:
- which task each agent should take next
- who already owns a file
- whether a session is stale
- whether finished work is safe to land

Switchman adds:
- **Task planning** — break goals into governed parallel work
- **File locking** — parallel edits don't quietly collide
- **Live status** — see what's running, blocked, or stale
- **Stale recovery** — abandoned work gets detected and requeued
- **Governed landing** — finished work reaches `main` one item at a time with retries and policy checks

Switchman is for the point where "we can manage this by hand" stops being true.

---

## Real-World Walkthrough

Three goals arrive at once: harden auth, ship a schema update, refresh docs.

```bash
switchman setup --agents 5
switchman task add "Harden auth middleware" --priority 9
switchman task add "Ship schema migration" --priority 8
switchman task add "Update auth and schema docs" --priority 6
switchman status --watch
```

Agents pick up work in separate workspaces. If two reach for the same file, Switchman blocks the second claim early. When branches finish:

```bash
switchman queue add agent1
switchman queue add agent2
switchman queue add agent3
switchman queue run --follow-plan --merge-budget 2
```

Before merge:

```bash
switchman gate ci
```

What good looks like:
- each agent stayed in its own lane
- overlap was blocked before wasted work spread
- the queue made it obvious what should land now and what should wait
- the repo reached `main` through a governed path

---

## Enforcement Gateway

Switchman is strongest when agents write through the governed gateway instead of editing files directly.

- MCP agents should prefer `switchman_write_file`, `switchman_append_file`, `switchman_make_directory`, `switchman_move_path`, and `switchman_remove_path`
- CLI operators can use `switchman write` and `switchman wrap`
- `switchman monitor` runs automatically in the background to catch rogue edits

---

## If something feels stuck

```bash
switchman status          # main dashboard
switchman status --watch  # live view
switchman scan            # conflict scan
switchman gate ci         # repo gate check
```

Explain commands:

```bash
switchman explain claim src/auth/login.js
switchman explain queue <item-id>
switchman explain stale --pipeline <pipeline-id>
switchman explain landing <pipeline-id>
```

More help:
- [Status and recovery](docs/status-and-recovery.md)
- [Merge queue](docs/merge-queue.md)
- [Pipelines and PRs](docs/pipelines.md)
- [Telemetry](docs/telemetry.md)
- [Command reference](docs/command-reference.md)

---

## PR Checks

Block risky changes in GitHub the same way your local terminal does:

```bash
switchman gate install-ci
```

Installs `.github/workflows/switchman-gate.yml` — runs the repo gate on every push and PR.

---

## Change Policy

Enforce review or validation for high-risk areas like auth, schema, or payments:

```bash
switchman policy init-change
switchman policy show-change
```

---

## What's next

- Zero-argument `switchman plan` — reads full repo context automatically
- Live web dashboard for repo and agent visibility
- Homebrew install path

---

## What's included today

- Agent worktree setup and repo verification
- Lease, claim, heartbeat, and stale-reap coordination
- Governed write gateways and rogue-edit monitor
- Repo status, repair, queue planning, and safe landing
- Pipeline planning, execution, PR bundles, and GitHub sync
- Audit trail, change policy enforcement, and CI integration
- MCP support for Claude Code, Cursor, and Windsurf

---

## Feedback

Building this in public. If you hit something broken or missing, I'd love to hear about it.

- [GitHub Issues](https://github.com/switchman-dev/switchman/issues)
- [hello@switchman.dev](mailto:hello@switchman.dev)

## License

MIT
