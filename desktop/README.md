# Switchman Desktop

Phase 1 prototype for Switchman's lane conflict-awareness board.

## Run

Install dependencies once:

```sh
cd desktop
npm install
```

Open the board (from a clone of the Switchman repo):

```sh
switchman board
```

Start a lane from your project repo:

```sh
switchman board start "refactor cart total" --agent claude-code
switchman board list
switchman board merge <session-id>
```

For a browser-only UI check, use `npm run dev:web`.

The CLI writes sessions to `~/.switchman/sessions.json`; the desktop app reads that registry and polls for file overlaps.

## Built So Far

- Main board with Planning, In progress, Review, and Done columns.
- Seeded Phase 1 lane/card data from the handover.
- Live elapsed timers for running lanes.
- Predictive overlap check when starting a planning lane.
- Active/stale card conflict signals.
- Conflict detail side panel.
- Merge-time separation conflict interrupt with two-step override.
- Tauri command scaffold for a real board snapshot.
- Empty board state when no CLI sessions are registered.

## Architecture Note

Task, agent, and worktree mapping should come from the Switchman CLI wrapper,
not manual card entry. The core path is:

```sh
switchman board start "refactor cart total" --agent claude-code
```

That command creates the worktree, launches the agent, and registers the session
as part of the action the user was already taking. The desktop app then renders
registered sessions and detected overlaps. MCP integration can be added later as
an optional input path, but the CLI wrapper is the required baseline.

See [docs/cli-wrapper-contract.md](docs/cli-wrapper-contract.md).

## Next Build Step

Replace the seeded card data with a background engine that reads CLI-registered
sessions, uses Switchman's existing worktree discovery and git diff polling, and
then exposes the live board snapshot to the UI through Tauri commands/events.

The first registry reader is now in place. The next layer is for
`switchman board start` is the production CLI entry point for lane registration.
wrapper that handles more agent-specific launch details and lifecycle updates.
The backend already refreshes touched files from each registered worktree using
git diff polling, and the desktop now polls the snapshot live. Merge attempts
are routed through the backend merge gate, which blocks active file overlaps
unless explicitly overridden, then commits and merges the registered worktree
branch back into the base ref.

Registry reads and writes are protected with a lock directory and atomic
temp-file rename, so concurrent CLI/Desktop access does not leave partial JSON.

Phase 1 product guardrails live in
[docs/phase-1-product-guardrails.md](docs/phase-1-product-guardrails.md), with
flag-copy candidates in [docs/flag-copy-review.md](docs/flag-copy-review.md).

The desktop app no longer shows design-handoff demo cards by default. If no
sessions are registered, the board stays empty and prompts you to start work
through the CLI wrapper.
