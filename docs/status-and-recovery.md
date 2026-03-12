# Status And Recovery

Start here when a run feels stuck.

## `switchman status`

Use this first.

It is the main terminal dashboard for the repo:
- health banner and compact counts
- boxed panels for `Running`, `Blocked`, `Warnings`, `Queue`, and `Next action`
- exact follow-up commands when something needs attention
- `--watch` mode for a live terminal view

Useful modes:

```bash
switchman status
switchman status --watch
switchman status --json
switchman status --watch --watch-interval-ms 2000
```

## `switchman scan`

Use this before merge, or whenever you suspect overlapping work.

It surfaces:
- changed files per workspace
- unmanaged changes
- conflict signals across workspaces

## `switchman gate ci`

Use this as the final repo-level safety check.

```bash
switchman gate ci
```

## Common recovery cases

### A file claim is blocked

- another task already owns that file
- do not use `--force`
- choose a different file or let the other task finish first

### A task is still in progress but the agent is gone

Inspect with:

```bash
switchman status
```

If the lease is stale:

```bash
switchman lease reap
```

If you want this to happen automatically on status checks:

```bash
switchman lease policy set --reap-on-status-check true
```

### A pipeline task failed

```bash
switchman pipeline status <pipelineId>
```

Switchman prints:
- `why:` what failed
- `next:` what to do next
