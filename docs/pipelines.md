# Pipelines And PRs

Switchman can take one backlog item through planning, execution, review, and PR handoff.

## Happy-path flow

```bash
switchman pipeline start "Harden auth API permissions" \
  --description "Update login permissions for the public API and add migration checks"

switchman pipeline exec pipe-123 "/path/to/your-agent-command"
switchman pipeline status pipe-123
switchman pipeline land pipe-123
switchman pipeline pr pipe-123
switchman pipeline publish pipe-123 --base main --draft
```

## Operator loop

1. start the pipeline
2. run it
3. inspect `pipeline status` if anything blocks
4. if completed work spans multiple branches, run `pipeline land`
5. review the PR output or publish the PR

## Land a multi-branch pipeline safely

If completed pipeline work lives on more than one branch, Switchman can create one synthetic landing branch for you:

```bash
switchman pipeline land pipe-123
switchman queue add --pipeline pipe-123
```

By default this creates `switchman/pipeline-landing/<pipelineId>` from `main`, merges the completed pipeline branches into it in a stable order, and gives you one governed branch to queue or publish.

If one of the component branches moves later, Switchman marks the synthetic branch as stale in `switchman pipeline status` and asks you to rebuild it explicitly:

```bash
switchman pipeline land pipe-123 --refresh
```

## Export a PR bundle

```bash
switchman pipeline bundle pipe-123 .switchman/pr-bundles/auth-hardening
```

This writes:
- `pr-summary.json`
- `pr-summary.md`
- `pr-body.md`
