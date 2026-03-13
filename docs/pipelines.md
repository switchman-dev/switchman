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

If the refresh hits a merge conflict, open a recovery worktree on the landing branch:

```bash
switchman pipeline land pipe-123 --recover
```

That worktree keeps the landing merge in progress so you can resolve the conflicts there and commit the result.

Then tell Switchman to adopt that resolved landing commit:

```bash
switchman pipeline land pipe-123 --resume
switchman queue add --pipeline pipe-123
```

## Export a PR bundle

```bash
switchman pipeline bundle pipe-123 .switchman/pr-bundles/auth-hardening
```

This writes:
- `pr-summary.json`
- `pr-summary.md`
- `pr-body.md`
- `pipeline-landing-summary.json`
- `pipeline-landing-summary.md`

If you want the landing summary to show up in GitHub Actions too:

```bash
switchman pipeline bundle pipe-123 --github
```

That writes both a human-readable step summary and reusable GitHub output keys such as:
- `switchman_check_name`
- `switchman_check_status`
- `switchman_check_title`
- `switchman_check_summary`
- `switchman_queue_status`
- `switchman_queue_item_id`
- `switchman_queue_target_branch`

The step summary now includes dedicated `Check Summary`, `Recovery State`, and `Queue State` sections so GitHub Actions can surface the same landing state cleanly in PR checks and workflow summaries.

A simple GitHub Actions pattern is:

```yaml
- name: Build Switchman pipeline bundle
  id: switchman
  run: switchman pipeline bundle pipe-123 --github

- name: Fail when Switchman needs action
  if: ${{ steps.switchman.outputs.switchman_check_status == 'action_required' }}
  run: |
    echo "${{ steps.switchman.outputs.switchman_check_title }}"
    echo "${{ steps.switchman.outputs.switchman_check_summary }}"
    exit 1
```

That lets one job or PR check show whether the pipeline is ready, already queued, retrying, blocked, or fully merged, plus the next exact operator command.

If you want reviewers to see the current landing state directly on the PR:

```bash
switchman pipeline comment pipe-123 --pr 42
switchman pipeline comment pipe-123 --pr 42 --update-existing
```

In GitHub Actions you can let Switchman resolve the PR number from `GITHUB_EVENT_PATH` instead:

```bash
switchman pipeline comment pipe-123 --pr-from-env --update-existing
```

If you want one command to refresh the bundle, update the PR comment, and emit GitHub step summary/output data together:

```bash
switchman pipeline sync-pr pipe-123 --pr-from-env --github
```

If you want GitHub Actions to infer the pipeline from the current pull request branch instead, Switchman now supports:

```bash
switchman pipeline sync-pr --pipeline-from-env --skip-missing-pipeline --pr-from-env --github
```

That lets a hosted workflow refresh PR state automatically on every PR update without hard-coding a pipeline id. When the branch does not map to a single Switchman pipeline, the command exits cleanly in skip mode instead of failing the workflow.
