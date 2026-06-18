# CLI Wrapper Contract

Switchman Phase 1 treats the CLI wrapper as the source of truth for task,
agent, and worktree mapping.

Users do not manually create board cards in the desktop app. They start work
through Switchman:

```sh
switchman board start "refactor cart total" --agent claude-code
```

That command is responsible for:

- Capturing the task name.
- Capturing the selected agent.
- Creating the git worktree and branch.
- Launching the requested agent inside that worktree.
- Registering the session so the desktop app can render it.

The production CLI command is:

```sh
switchman board start "refactor cart total" --agent claude-code
```

Or without linking when running from a clone:

```sh
node ./bin/switchman.js board start "refactor cart total" --agent claude-code
```

## Why This Matters

Predictive overlap only works if "start a task" and "register the task with
Switchman" are the same action. The user should not have to fill in a board
card after starting an agent.

MCP can later become an optional parallel input for agents that support it, but
the CLI wrapper must work regardless.

## Desktop Responsibility

The desktop app should read sessions produced by the CLI wrapper and render:

- Session cards.
- File-level overlaps.
- Predictive start checks.
- Merge-time interrupts.

It should not be the primary task-entry surface for Phase 1.

## Backend Shape

The Tauri shell now exposes a placeholder `get_board_snapshot` command with the
shape the UI should eventually consume:

- `sessions`: CLI-created worktree sessions.
- `overlaps`: relationships between sessions that share touched files.

The next implementation step is replacing the empty placeholder with a reader
for the CLI session registry plus git diff polling per registered worktree.

## Registry File

The desktop app currently reads:

```text
~/.switchman/sessions.json
```

For local testing or alternate installs, override it with:

```sh
SWITCHMAN_SESSION_REGISTRY=/path/to/sessions.json npm run dev
```

The file can be either a raw array:

```json
[
  {
    "id": "cart-total",
    "taskName": "refactor cart total",
    "agent": "claude-code",
    "worktreePath": "/repo/.worktrees/cart-total",
    "branchName": "switchman/cart-total",
    "status": "in-progress",
    "filesTouched": ["src/cart/total.ts", "src/cart/taxes.ts"]
  }
]
```

Or an object wrapper:

```json
{
  "sessions": [
    {
      "id": "cart-total",
      "taskName": "refactor cart total",
      "agent": "claude-code",
      "worktreePath": "/repo/.worktrees/cart-total",
      "branchName": "switchman/cart-total",
      "status": "in-progress",
      "filesTouched": ["src/cart/total.ts"]
    }
  ]
}
```

Accepted agents:

- `claude-code`
- `codex`
- `gemini`
- `aider`

Accepted statuses:

- `planning`
- `in-progress`
- `review`
- `done`

Snake case field names are also accepted for CLI ergonomics, such as
`task_name`, `worktree_path`, `branch_name`, and `files_touched`.

The desktop backend computes `overlaps` from shared `filesTouched` values. If
either side is `in-progress`, the overlap is `active`; otherwise it is `stale`.
Overlap detection is deliberately conservative: paths must match exactly after
normalization, and generated/noisy paths such as lockfiles, `dist`, `build`,
`target`, `node_modules`, sourcemaps, logs, temp files, and `.git` internals are
ignored. If a future detector is unsure, it should not flag by default.

Registry access is guarded by a sibling lock directory:

```text
~/.switchman/sessions.json.lock
```

Both the CLI and desktop backend wait for that lock before reading/writing.
Writes are atomic: Switchman writes a temporary JSON file in the registry
directory, then renames it over `sessions.json`. The default lock timeout is
5000ms and can be changed with:

```sh
SWITCHMAN_LOCK_TIMEOUT_MS=10000 switchman board start "task" --agent codex
```

When a registered worktree exists locally, the desktop backend refreshes
`filesTouched` from git on each board snapshot using:

```sh
git diff --name-only HEAD
git ls-files --others --exclude-standard
```

That means the CLI only needs to register the session at start time; the desktop
can derive live file-level overlap from the worktree while the agent edits.

## Agent Launch

The wrapper launches the selected agent command from inside the created
worktree, passing the task name as the first argument.

Default commands:

- `claude-code` -> `claude`
- `codex` -> `codex`
- `gemini` -> `gemini`
- `aider` -> `aider`

Override command names with environment variables:

```sh
SWITCHMAN_AGENT_CLAUDE_CODE=claude-code switchman board start "task" --agent claude-code
SWITCHMAN_AGENT_CODEX=codex switchman board start "task" --agent codex
```

For registry/worktree tests without launching an agent:

```sh
switchman board start "refactor cart total" --agent codex --no-launch
```

## Merge Gate

The scaffold also includes:

```sh
switchman board merge <session-id>
```

Merge behavior in this slice is intentionally conservative:

- It refreshes touched files from registered worktrees.
- It blocks if the target session shares a touched file with another
  `in-progress` session.
- It commits dirty worktree changes with `Switchman: <task>`.
- It checks out the registered base ref in the target repo.
- It merges the session branch with `Switchman merge: <task>`.
- It marks the session `done` after the git merge succeeds.
- `--force` overrides a separation conflict, then follows the same merge path.

The desktop merge interrupt calls the same backend policy through Tauri. The
merge path refuses to run if the target repository has uncommitted changes, so
the separation override does not also override local repository safety.

Useful options:

- `--repo <path>`: repository to create the worktree from.
- `--base <ref>`: base ref for the new branch.
- `--branch <name>`: explicit branch name.
- `--registry <path>`: alternate session registry.
- `--worktrees-dir <path>`: alternate worktree parent directory.
- `--force`: override a merge separation conflict.
