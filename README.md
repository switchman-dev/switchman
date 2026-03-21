# Switchman

**You ran the agents. Did they build the right thing?**

[![CI](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml/badge.svg)](https://github.com/switchman-dev/switchman/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/switchman-dev.svg)](https://www.npmjs.com/package/switchman-dev)

<img src="docs/demo.png" width="600" alt="Switchman demo — agent2 blocked from src/auth.js, rerouted safely, both branches landed cleanly">

Launching more agents is easy. Knowing what they actually built is not.

Switchman coordinates multi-agent coding sessions and gives you one clear answer at the end: what each agent changed, what does not fit together, and whether this looks safe to ship.

```bash
switchman start "your goal"
# agents run
switchman review
```

`switchman review` reads every worktree, turns a parallel session into a plain-English summary, flags semantic overlap and interface mismatches, and gives an honest merge confidence outcome: `green`, `amber`, `red`, or `uncertain`. When it cannot make a trustworthy call, it says `uncertain` instead of pretending everything is fine.

Built for developers using Claude Code, Cursor, Windsurf, Aider, and other CLI-first coding agents on real repos.

Questions or feedback? Join the [Discord](https://discord.gg/pnT8BEC4D) · [hello@switchman.dev](mailto:hello@switchman.dev)

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
- both branches landing cleanly through the queue
- a final `switchman review` session summary

Then inspect it:

```bash
cd /tmp/switchman-demo-...
switchman status
switchman review
```

---

## Quickstart

```bash
cd my-project
switchman quickcheck          # readiness check — prints one exact next command
switchman start "your goal"   # plans the work, creates workspaces, wires MCP
switchman status --watch      # live view while agents run
switchman review              # what was built, what doesn't fit, safe to ship?
```

When the review looks good:

```bash
switchman gate ci
switchman queue run
```

What `switchman start` sets up:

- repo context-aware task planning
- linked agent workspaces, one per agent
- shared Switchman database in `.switchman/`
- repo-aware `CLAUDE.md` when one does not exist
- automatic MCP coordination wiring where supported

If you want full manual control instead:

```bash
switchman setup --agents 3
switchman task add "Implement auth helper" --priority 9
```

Editor setup guides:

- [Claude Code](docs/setup-claude-code.md)
- [Cursor](docs/setup-cursor.md)
- [Windsurf](docs/setup-windsurf.md)
- [Aider and Cline](docs/setup-cli-agents.md)

---

## Pricing

### Free — the complete individual experience

Free is fully functional with no artificial limits. Run unlimited local agents, coordinate a complex session, and get a confident merge recommendation — forever, no card needed.

```bash
switchman start "goal"   →   agents run   →   switchman review
```

**What's in Free:**

- `switchman start` — reads the repo, creates workspaces, writes MCP config, generates `CLAUDE.md`
- `switchman review` — full session summary, semantic overlap detection, interface mismatch flagging, merge confidence outcome
- `switchman status --watch` — live dashboard during a session
- `switchman scan` — lightweight pre-merge conflict check
- `switchman demo` — proves the flow in a throwaway repo
- 14-day session history

### Pro — $19/month

> 90-day history · cross-session pattern detection · team sharing · AI planning
> [switchman.dev/pro](https://switchman.dev/pro) · or run `switchman upgrade`

Pro adds the over-time layer: searchable history, cross-session pattern detection (which parts of your repo consistently flag amber), team session sharing, and AI planning informed by your conflict history.

```bash
switchman upgrade        # open switchman.dev/pro
switchman login          # activate after subscribing
switchman login --status # check your plan
```

**What's in Pro:**

- 90-day searchable session history — `switchman review --history`, `switchman review --history --search auth`
- Cross-session pattern detection — `switchman insights`
- Team session sharing — `switchman review --share` to publish, `switchman review --team` to read teammate reviews before the PR
- AI task planning — `switchman plan "Add authentication" --apply`, `switchman plan --issue 47`
- Cost and token tracking — `switchman usage`, `switchman usage --days 30`
- Email support within 48 hours

---

## The problem in detail

Three agents finish. You have three worktrees full of diffs and no coherent picture of what was built.

Git tells you what changed. It does not tell you whether parallel agent work is coherent.

The three things developers consistently hit:

- **Review tax** — 20 minutes manually reading diffs after every parallel session to piece together what actually happened
- **Agentic drift** — two agents independently solve the same problem in incompatible ways. No conflict. No CI failure. Just divergence that compiles, passes, and breaks later.
- **No trustworthy answer** — "is this safe to merge?" has been yours to answer alone until `switchman review`

Git branches and worktrees solve isolation. They do not solve coordination, ownership, visibility, or the question of whether a session produced something coherent. That is what Switchman adds.

---

## How it works

### 1. Start with one goal

`switchman start "Add user authentication"` reads the repo, creates agent workspaces, and keeps work aligned as agents run. File claims, task ownership, and stale recovery happen automatically through MCP — you do not need to prompt agents to coordinate manually.

### 2. Review what was built

`switchman review` produces three things:

- A plain-English narrative of what each agent built — not a file list, a description
- Semantic flags — places where agents produced contradictory interfaces, duplicate implementations, or overlapping solutions
- A merge confidence outcome: `green`, `amber`, `red`, or `uncertain`

### 3. Ship through gates

When the review looks good, `switchman gate ci` and `switchman queue run` land finished work cleanly onto main.

---

## Troubleshooting

```bash
switchman status          # main dashboard
switchman status --watch  # live view
switchman scan            # conflict scan across worktrees
switchman gate ci         # repo gate check
switchman verify-setup    # check MCP wiring
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