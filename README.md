# Switchman

**You ran the agents. Did they build the right thing?**

[![CI](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml/badge.svg)](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/switchman-dev.svg)](https://www.npmjs.com/package/switchman-dev)

<img src="docs/demo.png" width="600" alt="Switchman demo — agent2 blocked from src/auth.js, rerouted safely, both branches landed cleanly">

Switchman coordinates multi-agent coding sessions and gives you one clear answer at the end: what each agent changed, what does not fit together, and whether this looks safe to ship.

Run 10+ AI coding agents on one codebase safely. Switchman acts like mission control for parallel agents: it hands out tasks, stops overlapping edits early, keeps work visible, and double-checks the session before anything lands on `main`.

The core flow is simple:

```bash
switchman start "your goal"
# agents run
switchman review
```

`switchman review` is the payoff. It reads every worktree, turns a parallel session into a plain-English summary, flags semantic overlap and interface mismatches, and gives an honest merge confidence outcome: `green`, `amber`, `red`, or `uncertain`.

The problem it solves is simple: launching more agents is easy. Knowing what they actually built is not.

Built for teams using Claude Code, Cursor, Windsurf, Aider, and other CLI-first coding agents on real repos.

Questions or feedback? Join the [Discord](https://discord.gg/pnT8BEC4D) · [hello@switchman.dev](mailto:hello@switchman.dev)

---

## Install

Requirements: Node.js 22.5+ · Git 2.5+

```bash
npm install -g switchman-dev
```

Homebrew release path:

```bash
brew install switchman-dev/tap/switchman-dev
```

> Switchman uses the built-in `node:sqlite` runtime — no extra database to install or manage.

---

## Try It In 2 Minutes

```bash
switchman demo
```

Creates a throwaway repo and shows:

- agent1 claiming `src/auth.js`
- agent2 getting blocked from the same file
- agent2 rerouting safely to `docs/auth-flow.md`
- both branches landing cleanly through the queue
- a final `switchman review` session summary

Then inspect it:

```bash
cd /tmp/switchman-demo-...
switchman status
switchman review
switchman queue status
```

---

## Quickstart

```bash
cd my-project
switchman quickcheck
switchman start "Implement auth helper"
switchman status --watch
switchman review
```

Then, when the session looks good:

```bash
switchman gate ci
switchman queue run
```

What `switchman start` gives you:

- repo context-aware task planning
- linked agent workspaces
- a shared Switchman database in `.switchman/`
- a repo-aware `CLAUDE.md` when one does not exist
- automatic MCP coordination wiring where supported

If your shell is running non-interactively, `switchman start` will ask you to rerun with `--yes` instead of hanging for confirmation. In a normal terminal, Switchman now falls back to the controlling TTY when stdin/stdout were piped.

Prefer the older explicit flow when you want full manual control:

```bash
switchman setup --agents 3
switchman task add "Implement auth helper" --priority 9
```

Fastest path to value:

1. Run `switchman quickcheck` if you want one clear readiness check and one exact next command
2. Use `switchman start` for the shortest path
3. Open one agent/editor window per generated workspace
4. Keep `switchman status --watch` open in a separate terminal
5. Run `switchman review` to see what each agent built, where work overlapped, and whether Switchman is confident in the merge
6. Run `switchman gate ci && switchman queue run` when the review looks good and tasks are finished

If editor wiring feels off later, run `switchman verify-setup`. If you want to regenerate the repo-aware guide, run `switchman claude refresh`.

Editor setup guides:

- [Claude Code](docs/setup-claude-code.md)
- [Cursor](docs/setup-cursor.md)
- [Windsurf](docs/setup-windsurf.md)
- [CLI agents like Aider and Cline](docs/setup-cli-agents.md)

---

## Pricing

### Free

> **The complete individual experience**  
> Same two-command flow: `switchman start "goal"` -> agents run -> `switchman review`

Free is fully functional with no lobotomy. You can run unlimited local agents, coordinate a complex session, and get a merge recommendation forever without paying.

**What's in Free:**

- `switchman start` reads the repo, creates workspaces, writes MCP config, and generates `CLAUDE.md`
- `switchman review` gives the full session summary, semantic overlap and interface mismatch detection, and a merge confidence outcome
- `switchman status --watch` gives the live dashboard during a session
- `switchman scan` gives a lightweight pre-merge conflict check
- `switchman demo` proves the flow in a throwaway repo
- Session history for 14 days

### Pro

> **90-day searchable history · cross-session insights · sharing · planning · $19/month**  
> [switchman.dev/pro](https://switchman.dev/pro) · or run `switchman upgrade`

Pro starts where the buying moment starts: you want the session summary back after the free window is gone, and you want Switchman to learn from how your repo behaves over time.

```bash
switchman upgrade        # open switchman.dev/pro
switchman login          # activate after subscribing
switchman login --status # check your plan
```

**What's in Pro:**

- 90-day searchable session history
  - `switchman review --history`
  - `switchman review --history --search auth`
- Cross-session pattern detection and repo insights
  - `switchman insights`
- Team session sharing — `switchman review --share` to publish a review, `switchman review --team` to read teammate reviews before the PR
- AI task planning — `switchman plan "Add authentication" --apply`, `switchman plan --issue 47`, and optionally `--comment` back to the issue or PR
- Cost and token tracking over time — `switchman usage`, `switchman usage --days 30`, and `switchman usage record --session <id> ...`
- Progressive codebase intelligence on the roadmap
- Full team coordination beyond the free shared-project limit
- Email support within 48 hours

**$19/month per seat** · [switchman.dev/pro](https://switchman.dev/pro)

---

## What Developers Hit At The End Of Every Session

Three agents finish. You have three worktrees full of diffs and no coherent picture of what was built.

- A 20-minute review tax at the end of every parallel run
- Agentic drift where two agents solve the same problem in incompatible ways
- No merge conflict, no CI failure, but still no trustworthy answer to “is this safe to merge?”

Git tells you what changed. It does not tell you whether parallel agent work is coherent. That question has been yours to answer until `switchman review`.

---

## How It Works

Start a session. Review the output. Ship with confidence.

### 1. Start with one goal

Run `switchman start "Add user authentication"`. Switchman reads the repo, creates agent workspaces, and keeps work aligned as agents run.

### 2. Agents coordinate automatically

File claims, task ownership, stale recovery, and MCP coordination happen automatically. You do not need to prompt agents to coordinate manually.

### 3. Review what was built

Run `switchman review`. Get a plain-English summary of what each agent produced, semantic mismatch flags, interface mismatch detection, and a merge confidence outcome.

### 4. Ship through gates

When the review looks good, run the CI gate and merge queue. Finished work lands cleanly instead of turning into last-minute merge cleanup.

---

## Why Developers Use It

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
- **Session review** — get a plain-English explanation of what happened before you merge
- **Stale recovery** — abandoned work gets detected and requeued
- **Governed landing** — finished work reaches `main` one item at a time with retries and policy checks
- **Honest merge confidence** — green, amber, red, or uncertain when Switchman cannot make a trustworthy call

Switchman is for the point where "we can manage this by hand" stops being true, and where a false green would be worse than no signal at all.

## The Review Moment

Most tools stop at "the agents finished." Switchman keeps going.

`switchman review` is the moment where the session becomes understandable:

- what each agent built, in plain English
- where the work overlapped semantically
- where interfaces or boundaries may not line up
- whether the session looks `green`, `amber`, `red`, or `uncertain`

When Switchman cannot make a trustworthy call, it says `uncertain` instead of pretending everything is fine. That honesty is what makes the confident reviews useful.

## Why This Matters

The real risk is not just merge conflicts. It is agentic drift.

Parallel agents can independently solve the same problem in incompatible ways. No conflict. No CI failure. Just divergence that compiles, passes, and breaks later. Switchman is built to detect that kind of mismatch before it reaches `main`.

## Cross-Tool By Default

Mix Claude Code, Cursor, and Codex in the same session. Native MCP support lets agents pick up tasks and coordinate automatically, and `switchman review` gives you one place to review the combined output.

Also supported today:

- Claude Code
- Cursor
- OpenAI Codex
- Windsurf
- Aider
- Cline

---

## Real-World Walkthrough

Three goals arrive at once: harden auth, ship a schema update, refresh docs.

```bash
switchman start "Harden auth middleware, ship the schema migration, and update the related docs" --agents 5
switchman status --watch
```

`switchman start` reads repo context, proposes the initial work split, and boots the session. If you prefer to drive the queue by hand, you can still fall back to explicit task adds:

```bash
switchman setup --agents 5
switchman task add "Harden auth middleware" --priority 9
switchman task add "Ship schema migration" --priority 8
switchman task add "Update auth and schema docs" --priority 6
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
- Broader install and release distribution

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
