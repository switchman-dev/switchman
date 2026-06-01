# Switchman

**Merge confidence for parallel AI coding sessions.**

[![CI](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml/badge.svg)](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/switchman-dev.svg)](https://www.npmjs.com/package/switchman-dev)
[![1000+ installs](https://img.shields.io/badge/installs-1000%2B-5CF2C7)](https://www.npmjs.com/package/switchman-dev)

<img src="docs/demo.png" width="600" alt="Switchman catching agentic drift — amber confidence, interface mismatch detected between agent-1 and agent-2">

You're running Claude Code, Cursor, Codex, or another coding agent across multiple worktrees. Each agent finishes clean. Git says no conflicts. You merge, and something breaks in prod.

That's agentic drift. Switchman catches it before you merge.

```text
🟢 GREEN  - Safe to merge. No agentic drift detected across 3 worktrees.
🟡 AMBER  - Review before merging. Interface mismatch on auth middleware.
🔴 RED    - Do not merge. Ownership conflicts and unclaimed changes detected.
```

When Switchman cannot make a trustworthy call, it reports `uncertain` instead of pretending the merge is safe.

Questions or feedback? [Discord](https://discord.gg/vnHgSW3RNc) · [hello@switchman.dev](mailto:hello@switchman.dev)

---

## Install

Requirements: Node.js 22.5+ · Git 2.5+

```bash
npm install -g switchman-dev
```

> Switchman uses the built-in `node:sqlite` runtime. No extra database to install or manage.

---

## Try it in 2 minutes

```bash
switchman demo
```

Creates a throwaway repo with two agents that conflict and shows Switchman catching the drift before merge — no setup required.

---

## Quickstart

```bash
cd my-project

# Zero setup: review existing worktrees
switchman review --all-worktrees

# Review specific branches together
switchman review --pr-ready --from feature-auth feature-api

# Save a PR-ready handoff
switchman review --pr-ready --all-worktrees --out switchman-review.md
```

Add CI protection when you want Switchman on every PR:

```bash
switchman gate install-ci
```

---

## How it works

When you run parallel AI agents across git worktrees, they can make changes that look safe in isolation but break each other at runtime: mismatched interfaces, conflicting ownership, stale dependencies, or duplicate implementations that drift apart.

Switchman scans across active worktrees and gives you a single merge-confidence verdict before you land anything.

`switchman review --pr-ready` produces four things:

- A plain-English narrative of what each agent built
- Semantic flags where agents produced contradictory interfaces, duplicate implementations, or overlapping solutions
- A merge-confidence outcome: `green`, `amber`, `red`, or `uncertain`
- A PR-ready Markdown handoff with the safest next step

Use `--all-worktrees` for local worktree sessions, or `--from <branches...>` when you know the branches you want reviewed together.

---

## Auto-trigger: runs without thinking about it

### Claude Code

Install the Stop hook once per repo. Switchman runs silently every time a Claude Code session ends.

```bash
switchman claude hooks install
```

This writes a hook into `.claude/settings.local.json` that fires `switchman agent-complete` automatically on session end. The first three clean runs print a short green confirmation so you know the hook is alive — after that, clean runs stay quiet and issues still print.

### Watch mode

Poll all worktrees continuously. Switchman scans automatically when they go quiet.

```bash
# Run in the foreground
switchman watch

# Or run as a background daemon
switchman monitor start
switchman monitor status
switchman monitor stop
```

The `--quiet-ms` flag controls how long worktrees must be idle before a scan fires. The default is 5000ms.

---

## PR comment integration

Add merge confidence to every pull request automatically so the report lives where review already happens.

### One-command CI setup

```bash
switchman gate install-ci
```

Drops a GitHub Actions workflow into `.github/workflows/switchman-gate.yml` that runs on every PR and push.

### Manual CI gate

```bash
switchman gate ci --github --github-comment --pr-from-env
```

Posts or updates a PR comment like this:

---

**🟡 Amber** - Review before merging. Parallel agent changes detected.

| Signal | Value |
| --- | --- |
| Merge confidence | amber |
| Gate status | blocked |
| AI gate | warn |
| Non-compliant worktrees | 1 |
| Stale worktrees | 0 |

**Review Signals**

- Semantic conflicts: 1
- Ownership conflicts: 1

**Next Step**

- Review the flagged worktrees locally with `switchman review --pr-ready --all-worktrees` before merging.

---

> ⭐ Switchman caught a risky merge? [Star us on GitHub](https://github.com/switchman-dev/switchman)

The star prompt only appears on amber and red catches, when Switchman has earned the ask.

---

## What Switchman checks

- **File conflicts** - two agents edited the same file
- **Ownership conflicts** - agents crossed into each other's declared scope
- **Semantic conflicts** - interfaces, types, or exports that diverged between worktrees
- **Unclaimed changes** - files edited outside any active task scope
- **Stale dependencies** - downstream code that depends on something an agent changed
- **Boundary validations** - task specs that were not fully satisfied before merge

---

## Gate commands

```bash
# Run the full CI gate locally
switchman gate ci

# Run the AI-powered merge check only
switchman gate ai

# Validate changes against the active lease before committing
switchman gate commit

# Install git hooks for local protection
switchman gate install

# Install the GitHub Actions workflow
switchman gate install-ci
```

---

## Badge

Add to your README to signal that your repo uses Switchman:

```markdown
[![Switchman checked](https://img.shields.io/badge/switchman-checked-green)](https://switchman.dev)
```

[![Switchman checked](https://img.shields.io/badge/switchman-checked-green)](https://switchman.dev)

---

## Advanced: full coordination mode

Want agents to coordinate *before* they conflict rather than catching drift after? Switchman ships an MCP server that lets agents claim files, pick tasks from a shared queue, and use guarded writes — so conflicts are prevented, not just detected.

```bash
# Initialise coordination mode
switchman init
switchman start "your goal"

# Start the MCP server
switchman mcp
```

More help:

- [Status and recovery](docs/status-and-recovery.md)
- [Merge queue](docs/merge-queue.md)
- [Pipelines and PRs](docs/pipelines.md)
- [Command reference](docs/command-reference.md)

---

## Feedback

Building this in public. If you hit something broken or missing, I'd love to hear about it.

- [GitHub Issues](https://github.com/switchman-dev/switchman/issues)
- [hello@switchman.dev](mailto:hello@switchman.dev)
- [Discord](https://discord.gg/vnHgSW3RNc)

---

## License

MIT - [switchman.dev](https://switchman.dev)
