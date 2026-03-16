# Claude Code Setup

Claude Code has a native Switchman integration via MCP, so your agents can coordinate automatically instead of relying on copy-pasted shell rituals.

## 1. Create your agent workspaces

```bash
cd my-project
switchman setup --agents 5
switchman verify-setup
```

This creates:
- isolated workspaces, one per agent
- a shared Switchman database
- project-local `.mcp.json` files so Claude Code can discover Switchman automatically
- a quick readiness check so you can confirm the setup before opening Claude Code

## 2. Optional global fallback

If you prefer a global fallback, add this to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "switchman": {
      "command": "switchman-mcp",
      "args": []
    }
  }
}
```

Project-local MCP config is still the preferred path because it travels with the repo and generated workspaces.

## 3. Generate a repo-aware `CLAUDE.md`

```bash
switchman claude refresh
```

This generates a repo-aware guide in the repo root so your agents know how to use Switchman, which commands to prefer, and which repo conventions to follow. Keep it in the repo root and do not let agents talk to `.switchman/switchman.db` directly.

## 4. Add your tasks

```bash
switchman task add "Fix the login bug" --priority 8
switchman task add "Add rate limiting" --priority 6
switchman task add "Update README" --priority 2
```

## 5. Open Claude Code in each workspace

Open a separate Claude Code window in each workspace folder that `switchman setup` created. Each agent should automatically see the local MCP config, pick up a task, lock the files it needs, and release them when it's done.

## 6. Check before merging

```bash
switchman status
switchman gate ci
```
