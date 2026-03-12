# Pipelines And PRs

Switchman can take a backlog item through planning, governed execution, review, and PR handoff.

## Happy-path flow

```bash
switchman pipeline start "Harden auth API permissions" \
  --description "Update login permissions for the public API and add migration checks"

switchman pipeline exec pipe-123 "/path/to/your-agent-command"
switchman pipeline status pipe-123
switchman pipeline pr pipe-123
switchman pipeline publish pipe-123 --base main --draft
```

## Operator loop

1. start the pipeline
2. run it
3. inspect `pipeline status` if anything blocks
4. review the PR artifact or publish the PR

## Export a PR bundle

```bash
switchman pipeline bundle pipe-123 .switchman/pr-bundles/auth-hardening
```

This writes:
- `pr-summary.json`
- `pr-summary.md`
- `pr-body.md`
