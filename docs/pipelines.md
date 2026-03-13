# Pipelines And PRs

Pipelines are the Switchman workflow for taking one larger engineering goal through planning, execution, review, landing, and PR handoff.

Use a pipeline when:
- the work is too broad for one safe task
- several follow-up tasks need to happen in parallel
- the end result may span more than one branch or workspace
- you want one governed record for planning, stale-work recovery, and landing

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

## What a pipeline actually creates

`switchman pipeline start` does more than create one tracking record.

It generates structured subtasks with task specs such as:
- `implementation`
- `tests`
- `docs`
- `governance` or safety review work when policy requires it

Those tasks keep:
- allowed paths
- subsystem tags
- required follow-up work
- pipeline membership
- execution policy

That means a pipeline is not just a list. It is the dependency-aware container Switchman uses to decide:
- what is still missing
- what became stale
- what policy evidence exists
- whether work can be landed safely

## Operator loop

The normal operator loop is:

1. start the pipeline
2. run it
3. inspect `pipeline status` if anything blocks
4. if completed work spans multiple branches, run `pipeline land`
5. review the PR output or publish the PR

In practice, that usually looks like:

```bash
switchman pipeline start "Ship auth hardening"
switchman pipeline exec pipe-123 "/path/to/agent-command"
switchman pipeline status pipe-123
switchman pipeline bundle pipe-123 .switchman/pr-bundles/auth-hardening
switchman pipeline sync-pr pipe-123 --pr-from-env --github
```

## What `pipeline exec` does

`switchman pipeline exec` runs one agent command against the pipeline and records the resulting task outcomes.

What that means operationally:
- Switchman still tracks task state and ownership underneath
- completed work feeds policy evidence, stale-work detection, and landing readiness
- if a task changes a shared boundary, related completed work can become stale immediately
- if required follow-up work is missing, the pipeline stays visibly incomplete instead of silently drifting toward merge

The important mental model is:
- `pipeline exec` drives work forward
- `pipeline status` explains what happened
- `pipeline land` assembles the merge path when branches diverge

## Failure model

Pipelines are powerful because the failure paths are explicit.

If something goes wrong mid-pipeline, `switchman pipeline status <id>` is the first place to look.

It should tell you:
- `why:` what failed
- `next:` the next operator step
- whether policy is still missing evidence
- whether stale work has invalidated completed tasks
- whether a synthetic landing branch is stale, failed, or ready

Common mid-pipeline cases:

### A task failed

```bash
switchman pipeline status pipe-123
```

Then either retry the task directly or reset stale work:

```bash
switchman task retry <taskId>
switchman task retry-stale --pipeline pipe-123
```

### A shared change made other work stale

```bash
switchman explain stale --pipeline pipe-123
switchman task retry-stale --pipeline pipe-123
```

### Policy still blocks landing

```bash
switchman pipeline review pipe-123
switchman policy show-change
```

### The PR / CI surface needs refreshing

```bash
switchman pipeline sync-pr pipe-123 --pr-from-env --github
```

## Land a multi-branch pipeline safely

If completed pipeline work lives on more than one branch, Switchman can create one synthetic landing branch for you:

```bash
switchman pipeline land pipe-123
switchman queue add --pipeline pipe-123
```

By default this creates `switchman/pipeline-landing/<pipelineId>` from `main`, merges the completed pipeline branches into it in a stable order, and gives you one governed branch to queue or publish.

That matters because the product problem is not just "can these tasks run?" It is "what is the single trusted path back to merge?"

## What happens when the landing branch drifts

If one of the component branches moves later, Switchman marks the synthetic branch as stale in `switchman pipeline status` and asks you to rebuild it explicitly:

```bash
switchman pipeline land pipe-123 --refresh
```

This is the normal path after further work lands on a component branch or the pipeline’s assembled branch set changes.

## Merge conflicts during landing

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

If an abandoned recovery workspace lingers, clean it up explicitly:

```bash
switchman pipeline land pipe-123 --cleanup
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

Those files are the handoff surface for reviewers and CI. They carry:
- task completion state
- lease provenance
- policy evidence
- stale clusters and stale waves
- landing status
- queue status
- next exact operator commands

## GitHub Actions and hosted handoff

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
- `switchman_stale_cluster_count`
- `switchman_trust_audit_count`

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

## PR comments and one-command sync

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

If you want GitHub Actions to infer the pipeline from the current pull request branch instead, Switchman also supports:

```bash
switchman pipeline sync-pr --pipeline-from-env --skip-missing-pipeline --pr-from-env --github
```

That lets a hosted workflow refresh PR state automatically on every PR update without hard-coding a pipeline id. When the branch does not map to a single Switchman pipeline, the command exits cleanly in skip mode instead of failing the workflow.

## Practical guidance

Use pipelines when the work needs governance and coordination, not just execution.

A good rule of thumb:
- one small isolated change -> one task
- one larger initiative with follow-ups, review steps, or multi-branch output -> one pipeline
