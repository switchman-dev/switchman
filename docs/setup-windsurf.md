# Windsurf Setup

Windsurf uses a shared MCP config file rather than the project-local `.cursor/mcp.json` approach that Cursor supports.

## 1. Install Switchman into Windsurf once

```bash
switchman mcp install --windsurf
```

This writes or updates:

```text
~/.codeium/mcp_config.json
```

It preserves any existing Windsurf MCP servers and adds the `switchman-mcp` server entry.

If you want to verify it:

```bash
switchman mcp install --windsurf --json
```

## 2. Create your agent workspaces

```bash
cd my-project
switchman setup --agents 5
```

## 3. Add your tasks

```bash
switchman task add "Fix the login bug" --priority 8
switchman task add "Add rate limiting" --priority 6
```

## 4. Open Windsurf

In Windsurf, check:
- `Settings`
- `Cascade`
- `MCP Servers`

Then open the repo or generated worktrees and let each agent use Switchman through MCP.

## 5. Check the run

```bash
switchman status
switchman gate ci
```
