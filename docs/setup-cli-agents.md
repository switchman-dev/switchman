# CLI Agent Setup

Switchman also works with agents that can run terminal commands even without native project-local MCP discovery.

Examples:
- Aider
- custom scripts
- other CLI-driven agent tools

## 1. Create your agent workspaces

```bash
cd my-project
switchman setup --agents 5
```

## 2. Add your tasks

```bash
switchman task add "Fix the login bug" --priority 8
switchman task add "Add rate limiting" --priority 6
```

## 3. Give each agent this prompt

```text
Before starting any work:
1. Run `switchman lease next --json` to get your assigned task and lease
2. Run `switchman claim <taskId> <worktreeName> <files...>` to lock the files you'll edit
3. If a file is already claimed, pick a different approach or different files
4. If the task runs for a while, refresh the lease with `switchman lease heartbeat <leaseId>`
5. When finished, run `switchman task done <taskId>`

Never edit a file you haven't claimed. If a claim fails, do not use --force.
```

Plain-English note:
- Switchman commands may say `worktree`
- in practice, that just means the agent workspace folder

## 4. Check before merging

```bash
switchman status
switchman scan
switchman gate ci
```

## 5. See one realistic multi-goal flow

If you want to understand how a team uses Switchman across several goals at once, read the short walkthrough in the main README:

- [Real-world walkthrough](../README.md#real-world-walkthrough)
