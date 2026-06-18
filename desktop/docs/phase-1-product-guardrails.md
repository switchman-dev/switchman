# Phase 1 Product Guardrails

These are Phase 1 constraints, not later polish.

## Flag Copy Is Critical Path

Every conflict flag must plainly state:

- The current task.
- The other task.
- The other agent.
- The exact shared file or area.
- Why the warning matters now.

Avoid placeholder text such as "other lane" or "conflict detected" in shipped
surfaces.

## Conservative Overlap Policy

Phase 1 intentionally under-flags rather than over-flags.

The engine only flags exact file-path matches after normalization. It ignores
noisy/generated files such as lockfiles, build output, sourcemaps, logs,
temporary files, `node_modules`, `dist`, `build`, `target`, and `.git` content.

This policy should stay easy to tune, but the default must protect trust: a
wrong flag is worse than a missed one.

## CLI Golden Path

The common path must remain:

```sh
switchman start "task name" --agent codex
```

Additional flags are escape hatches, not the normal workflow. Do not add
required prompts, sign-in, or setup steps to Phase 1.

## Fully Local

Phase 1 must not require sign-in, accounts, servers, or network calls. The app
uses local system fonts and local registry/worktree state.

## Quiet Clear State

Clear cards should stay visually quiet. Spend implementation effort on overlap
accuracy and flag copy, not making the idle board more visually interesting.
