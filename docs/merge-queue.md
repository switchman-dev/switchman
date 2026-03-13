# Merge Queue

Switchman can land finished work back onto `main` one change at a time.

This is useful when several agent workspaces finish around the same time and you want safe, governed landing instead of manual merge juggling.

## Happy-path flow

```bash
switchman queue add --worktree agent1
switchman queue add --worktree agent2

switchman queue status
switchman queue run --watch
```

## What the merge queue does

Before landing work it:
- rebases the queued branch onto the latest target branch
- runs the same repo-level safety checks behind `switchman gate ci`
- fast-forwards the target branch when the item is safe to land
- retries retryable merge failures up to the configured retry budget
- blocks with an exact next action when human attention is needed

## Queue a branch, workspace, or pipeline

```bash
switchman queue add feature/auth-hardening
switchman queue add --worktree agent3
switchman queue add --pipeline pipe-123
```

When you queue a pipeline, Switchman resolves one landing branch for that pipeline.

- If the pipeline has exactly one implementation branch, that branch is used.
- Otherwise, if all completed pipeline work points at one non-`main` branch, that branch is used.
- If the pipeline is complete and spans multiple branches, Switchman creates `switchman/pipeline-landing/<pipelineId>` and queues that synthetic integration branch.
- If that synthetic branch becomes stale because `main` or one of the component branches moved, refresh it first with `switchman pipeline land <pipelineId> --refresh`.
- If that refresh fails with merge conflicts, open a guided recovery worktree with `switchman pipeline land <pipelineId> --recover`, resolve the conflicts there, commit, mark the resolved landing branch ready with `switchman pipeline land <pipelineId> --resume`, and then queue the pipeline again.
- If the pipeline still has unfinished tasks, Switchman stops and tells you to finish the remaining work first.

Useful options:
- `--target <branch>` — target branch to land into (default: `main`)
- `--max-retries <n>` — automatic retry budget for retryable merge failures

## Inspect queue state

```bash
switchman queue list
switchman queue status
switchman queue status --json
```

## Run once or continuously

```bash
switchman queue run
switchman queue run --watch
switchman queue run --watch --watch-interval-ms 1000
```

Useful watch-mode options:
- `--watch`
- `--watch-interval-ms <n>`
- `--max-cycles <n>`

## Retry or remove blocked items

```bash
switchman queue retry <itemId>
switchman queue remove <itemId>
```
