# Switchman

**You ran three AI agents. Is the combined work safe to merge?**

[![CI](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml/badge.svg)](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/switchman-dev.svg)](https://www.npmjs.com/package/switchman-dev)
[![800+ installs](https://img.shields.io/badge/installs-800%2B-5CF2C7)](https://www.npmjs.com/package/switchman-dev)

<img src="docs/demo.png" width="600" alt="Switchman demo — agent2 blocked from src/auth.js, rerouted safely, both branches landed cleanly">

---

## Is this for you?

✓ You run Claude Code, Cursor, or Codex in parallel worktrees  
✓ You want to know agents built compatible code before merging  
✓ You've had a "compiled fine, broke in prod" moment from parallel agents  

If that's you, read on. If you're running a single agent on a single branch, you don't need this yet.

---

## What it does

```bash
switchman review --pr-ready --all-worktrees
switchman review --pr-ready --from feature-auth feature-api
```

Switchman is a merge-confidence layer for parallel AI coding sessions. It reads existing branches and worktrees, turns a messy multi-agent run into a PR-ready report, flags semantic overlap and interface mismatches, and gives an honest merge confidence outcome: `green`, `amber`, `red`, or `uncertain`.

When Switchman cannot make a trustworthy call, it says `uncertain` instead of pretending everything is fine.

Built for developers using Claude Code, Cursor, Windsurf, Aider, and other CLI-first coding agents on real repos.

Questions or feedback? [Discord](https://discord.gg/pnT8BEC4D) · [hello@switchman.dev](mailto:hello@switchman.dev)

---

## Install

Requirements: Node.js 22.5+ · Git 2.5+

```bash
npm install -g switchman-dev
```

Homebrew:

```bash
brew install switchman-dev/tap/switchman-dev
```

> Switchman uses the built-in `node:sqlite` runtime — no extra database to install or manage.

---

## Try it in 2 minutes

```bash
switchman demo
```

Creates a throwaway repo and shows:

- agent1 claiming `src/auth.js`
- agent2 getting blocked from the same file and rerouting safely
- a final merge-confidence review

Then inspect it:

```bash
cd /tmp/switchman-demo-...
switchman status
switchman review --pr-ready
```

---

## Quickstart

```bash
cd my-project
switchman review --pr-ready --all-worktrees
switchman review --pr-ready --from branch-a branch-b
switchman review --pr-ready --from branch-a branch-b --out switchman-review.md
```

When the review looks good:

```bash
switchman gate ci
```

When you also want Switchman to coordinate the run:

- `switchman start "your goal"` — plan work, create workspaces, and wire MCP
- `switchman status --watch` — live view while agents run
- `switchman merge` — queue finished worktrees and land safe work
- `switchman advanced --help` — task queues, leases, scheduler, Guard, telemetry, and governance tools

---

## The problem in detail

Three agents finish. You have three worktrees full of diffs and no trustworthy answer to the question that matters: can this be merged?

Git tells you what changed. It does not tell you whether parallel agent work is coherent.

The three things developers consistently hit:

- **Review tax** — 20 minutes manually reading diffs after every parallel session to piece together what actually happened
- **Agentic drift** — two agents independently solve the same problem in incompatible ways. No conflict. No CI failure. Just divergence that compiles, passes, and breaks later.
- **No trustworthy answer** — "is this safe to merge?" has been yours to answer alone until `switchman review`

Git branches and worktrees solve isolation. They do not tell you whether AI-generated branches fit together, whether one agent drifted across an interface, or what a reviewer should inspect first. That is what Switchman adds.

---

## How it works

### 1. Review existing AI branches

Run your agents however you already work: Claude Code worktrees, Codex branches, Cursor sessions, or hand-made git branches. Then point Switchman at the resulting branches or worktrees.

### 2. Generate the merge-confidence report

`switchman review --pr-ready` produces four things:

- A plain-English narrative of what each agent built — not a file list, a description
- Semantic flags — places where agents produced contradictory interfaces, duplicate implementations, or overlapping solutions
- A merge confidence outcome: `green`, `amber`, `red`, or `uncertain`
- A PR-ready Markdown handoff with the safest next step

Use `--all-worktrees` for local worktree sessions, or `--from <branches...>` when you know the branches you want reviewed together.

### 3. Ship with evidence

When the review looks good, run your repo tests or `switchman gate ci`, then paste the PR-ready report into the review.

---

## Open source

Switchman is now one open source product. No login is required for the local merge-confidence workflow.

```bash
agents run   →   switchman review --pr-ready --all-worktrees   →   merge with evidence
```

What you get:

- `switchman review --pr-ready --all-worktrees` — review existing git worktrees without adopting Switchman coordination
- `switchman review --pr-ready --from branch-a branch-b` — review existing branches together
- `switchman review --pr-ready` — PR-ready merge-confidence report, semantic overlap detection, interface mismatch flagging, safest next step
- `switchman review` — terminal session summary for recent parallel-agent work
- `switchman gate ci` — local repo gate before merge
- `switchman demo` — proves the flow in a throwaway repo
- Managed coordination, leases, scheduler, Guard, telemetry, and governance tools — `switchman advanced --help`

---

## Troubleshooting

```bash
switchman status          # main dashboard
switchman review --pr-ready --all-worktrees
switchman gate ci         # repo gate check
switchman advanced --help # deeper coordination tools
```

Explain commands for when something is blocked:

```bash
switchman explain claim src/auth/login.js
switchman explain queue <item-id>
```

More help:

- [Status and recovery](docs/status-and-recovery.md)
- [Merge queue](docs/merge-queue.md)
- [Pipelines and PRs](docs/pipelines.md)
- [Command reference](docs/command-reference.md)

---

## PR gate

Block risky changes in GitHub the same way your local terminal does:

```bash
switchman gate install-ci
```

Installs `.github/workflows/switchman-gate.yml` — runs the repo gate on every push and PR.

---

## What's next

- Zero-argument `switchman plan` — reads full repo context automatically
- Broader install and release distribution

---

## Feedback

Building this in public. If you hit something broken or missing, I'd love to hear about it.

- [GitHub Issues](https://github.com/switchman-dev/switchman/issues)
- [hello@switchman.dev](mailto:hello@switchman.dev)
- [Discord](https://discord.gg/pnT8BEC4D)

## License

MIT
