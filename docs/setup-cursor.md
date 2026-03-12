# Cursor Setup

Cursor has native MCP support, and Switchman now writes project-local Cursor config automatically.

## 1. Create your agent workspaces

```bash
cd my-project
switchman setup --agents 5
```

This writes `.cursor/mcp.json` into the repo root and each generated workspace.

## 2. Add your tasks

```bash
switchman task add "Fix the login bug" --priority 8
switchman task add "Add rate limiting" --priority 6
switchman task add "Update README" --priority 2
```

## 3. Open Cursor in each workspace

Open a separate Cursor window in each workspace folder that `switchman setup` created. Cursor should discover the local MCP config automatically.

## 4. Check the run from the repo root

```bash
switchman status
switchman status --watch
switchman gate ci
```

## Notes

- Switchman also writes `.mcp.json` for Claude Code in the same repo and workspaces.
- Cursor config is project-local, so it travels with the repo and does not require a global install step.
