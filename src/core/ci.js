import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

function summarizeUnclaimedChanges(result) {
  if (!result.unclaimed_changes?.length) return ['- None'];
  return result.unclaimed_changes.map((entry) => `- ${entry.worktree}: ${entry.files.join(', ')}`);
}

function summarizeFileConflicts(result) {
  if (!result.file_conflicts?.length) return ['- None'];
  return result.file_conflicts.map((entry) => `- ${entry.file}: ${entry.worktrees.join(', ')}`);
}

function summarizeBranchConflicts(result) {
  if (!result.branch_conflicts?.length) return ['- None'];
  return result.branch_conflicts.map((entry) => `- ${entry.worktreeA} vs ${entry.worktreeB}`);
}

export function formatCiGateMarkdown(result) {
  const mergeConfidence = result.merge_confidence || (result.ok ? 'green' : 'red');
  return [
    '# Switchman CI Gate',
    '',
    `- Merge confidence: ${mergeConfidence}`,
    `- Status: ${result.ok ? 'pass' : 'blocked'}`,
    `- Summary: ${result.summary}`,
    '',
    '## Compliance',
    `- Managed: ${result.compliance?.managed ?? 0}`,
    `- Observed: ${result.compliance?.observed ?? 0}`,
    `- Non-compliant: ${result.compliance?.non_compliant ?? 0}`,
    `- Stale: ${result.compliance?.stale ?? 0}`,
    '',
    '## Unclaimed Changes',
    ...summarizeUnclaimedChanges(result),
    '',
    '## File Conflicts',
    ...summarizeFileConflicts(result),
    '',
    '## Branch Conflicts',
    ...summarizeBranchConflicts(result),
  ].join('\n');
}

function confidenceTitle(confidence) {
  if (confidence === 'green') return 'Green';
  if (confidence === 'amber') return 'Amber';
  return 'Red';
}

export function formatCiGatePrComment(result) {
  const confidence = result.merge_confidence || (result.ok ? 'green' : 'red');
  const check = result.ok ? 'pass' : 'blocked';
  const issueLines = [];
  const starPromptLines = ['amber', 'red'].includes(confidence)
    ? [
      '',
      '---',
      '',
      '⭐ Switchman caught something useful? Star us on GitHub: https://github.com/switchman-dev/switchman',
    ]
    : [];

  if ((result.unclaimed_changes?.length || 0) > 0) {
    issueLines.push(`- Unclaimed changes: ${result.unclaimed_changes.length}`);
  }
  if ((result.file_conflicts?.length || 0) > 0) {
    issueLines.push(`- File conflicts: ${result.file_conflicts.length}`);
  }
  if ((result.ownership_conflicts?.length || 0) > 0) {
    issueLines.push(`- Ownership conflicts: ${result.ownership_conflicts.length}`);
  }
  if ((result.semantic_conflicts?.length || 0) > 0) {
    issueLines.push(`- Semantic conflicts: ${result.semantic_conflicts.length}`);
  }
  if ((result.branch_conflicts?.length || 0) > 0) {
    issueLines.push(`- Branch conflicts: ${result.branch_conflicts.length}`);
  }
  if ((result.boundary_validations?.length || 0) > 0) {
    issueLines.push(`- Boundary validations: ${result.boundary_validations.length}`);
  }
  if ((result.dependency_invalidations?.length || 0) > 0) {
    issueLines.push(`- Stale dependency invalidations: ${result.dependency_invalidations.length}`);
  }

  return [
    '<!-- switchman-ci-gate-comment -->',
    '# Switchman Merge Confidence',
    '',
    `**${confidenceTitle(confidence)}** - ${result.summary}`,
    '',
    '| Signal | Value |',
    '| --- | --- |',
    `| Merge confidence | ${confidence} |`,
    `| Gate status | ${check} |`,
    `| AI gate | ${result.ai_gate_status || 'unknown'} |`,
    `| Non-compliant worktrees | ${result.compliance?.non_compliant ?? 0} |`,
    `| Stale worktrees | ${result.compliance?.stale ?? 0} |`,
    '',
    '## Review Signals',
    ...(issueLines.length ? issueLines : ['- No blocking review signals found.']),
    '',
    '## Next Step',
    result.ok
      ? '- Continue with normal PR review. Switchman found no blocking merge-confidence issues.'
      : '- Review the flagged worktrees locally with `switchman review --pr-ready --all-worktrees` before merging.',
    ...starPromptLines,
  ].join('\n');
}

export function postGitHubPrComment({
  repoRoot,
  prNumber,
  markdown,
  ghCommand = 'gh',
  updateExisting = true,
}) {
  if (!prNumber) {
    throw new Error('A pull request number is required.');
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'switchman-pr-comment-'));
  const bodyPath = join(tmpDir, 'body.md');
  writeFileSync(bodyPath, `${markdown}\n`, 'utf8');

  try {
    const args = [
      'pr',
      'comment',
      String(prNumber),
      '--body-file',
      bodyPath,
    ];
    if (updateExisting) {
      args.push('--edit-last', '--create-if-none');
    }

    const result = spawnSync(ghCommand, args, {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const ok = !result.error && result.status === 0;
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();

    if (!ok) {
      throw new Error(result.error?.message || output || `gh pr comment failed with status ${result.status}`);
    }

    return {
      pr_number: String(prNumber),
      updated_existing: updateExisting,
      output,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function getPipelineLandingCheckInfo(result) {
  if (result.queue_state?.status === 'merged') {
    return {
      status: 'success',
      title: 'Pipeline merged to target branch',
      summary: result.queue_state.merged_commit
        ? `Merged as ${result.queue_state.merged_commit}.`
        : 'Merged successfully.',
    };
  }

  if (['queued', 'validating', 'rebasing', 'merging', 'retrying'].includes(result.queue_state?.status)) {
    return {
      status: result.queue_state.status === 'retrying' ? 'action_required' : 'pending',
      title: result.queue_state.status === 'retrying'
        ? 'Pipeline is retrying in the landing queue'
        : 'Pipeline is in the landing queue',
      summary: result.queue_state.next_action || result.next_action,
    };
  }

  if (result.ready_to_queue) {
    return {
      status: 'success',
      title: 'Pipeline ready to queue',
      summary: result.queue_state?.next_action || result.next_action,
    };
  }

  if ((result.stale_clusters?.length || 0) > 0) {
    return {
      status: 'action_required',
      title: 'Pipeline has stale work to revalidate',
      summary: result.stale_clusters[0]?.next_action || result.queue_state?.next_action || result.next_action,
    };
  }

  if (result.landing_error || result.landing?.last_failure) {
    return {
      status: 'action_required',
      title: 'Pipeline landing needs attention',
      summary: result.queue_state?.next_action || result.next_action,
    };
  }

  if (result.landing?.stale) {
    return {
      status: 'action_required',
      title: 'Pipeline landing is stale',
      summary: result.queue_state?.next_action || result.next_action,
    };
  }

  return {
    status: 'action_required',
    title: 'Pipeline not ready to queue',
    summary: result.queue_state?.next_action || result.next_action,
  };
}

export function writeGitHubCiStatus({ result, stepSummaryPath = null, outputPath = null }) {
  const markdown = formatCiGateMarkdown(result);

  if (stepSummaryPath) {
    writeFileSync(stepSummaryPath, `${markdown}\n`);
  }

  if (outputPath) {
    const lines = [
      `switchman_ok=${result.ok ? 'true' : 'false'}`,
      `switchman_merge_confidence=${result.merge_confidence || (result.ok ? 'green' : 'red')}`,
      `switchman_summary=${JSON.stringify(result.summary)}`,
      `switchman_non_compliant=${result.compliance?.non_compliant ?? 0}`,
      `switchman_stale=${result.compliance?.stale ?? 0}`,
      `switchman_unclaimed_changes=${result.unclaimed_changes?.length ?? 0}`,
      `switchman_file_conflicts=${result.file_conflicts?.length ?? 0}`,
      `switchman_branch_conflicts=${result.branch_conflicts?.length ?? 0}`,
    ];
    writeFileSync(outputPath, `${lines.join('\n')}\n`);
  }

  return {
    markdown,
    wrote_step_summary: Boolean(stepSummaryPath),
    wrote_output: Boolean(outputPath),
  };
}

export function formatPipelineLandingMarkdown(result) {
  const checkInfo = getPipelineLandingCheckInfo(result);
  const landingStateLines = result.landing_error
    ? [`- ${result.landing_error}`]
    : result.landing?.last_failure
      ? [
        `- Failure: ${result.landing.last_failure.reason_code || 'landing_branch_materialization_failed'}`,
        ...(result.landing.last_failure.failed_branch ? [`- Failed branch: ${result.landing.last_failure.failed_branch}`] : []),
        ...(result.landing.last_failure.conflicting_files?.length
          ? [`- Conflicts: ${result.landing.last_failure.conflicting_files.join(', ')}`]
          : []),
      ]
      : result.landing?.stale
        ? (result.landing.stale_reasons?.length
          ? result.landing.stale_reasons.map((reason) => `- Stale: ${reason.summary}`)
          : ['- Landing branch is stale and needs refresh'])
        : ['- Current and ready for queueing'];
  return [
    '# Switchman Pipeline Landing',
    '',
    '## Check Summary',
    `- Name: Switchman Pipeline Landing`,
    `- Status: ${checkInfo.status}`,
    `- Title: ${checkInfo.title}`,
    `- Summary: ${checkInfo.summary}`,
    '',
    '## Pipeline',
    `- Pipeline: ${result.pipeline_id}`,
    `- Ready to queue: ${result.ready_to_queue ? 'yes' : 'no'}`,
    `- Landing branch: ${result.landing.branch}`,
    `- Strategy: ${result.landing.strategy}`,
    `- Synthetic: ${result.landing.synthetic ? 'yes' : 'no'}`,
    '',
    '## Component Branches',
    ...(result.landing.component_branches?.length
      ? result.landing.component_branches.map((branch) => `- ${branch}`)
      : ['- None']),
    '',
    '## Landing State',
    ...landingStateLines,
    '',
    '## Recovery State',
    ...(result.recovery_state
      ? [
        `- Status: ${result.recovery_state.status}`,
        ...(result.recovery_state.recovery_path ? [`- Path: ${result.recovery_state.recovery_path}`] : []),
        ...(result.recovery_state.resume_command ? [`- Resume: ${result.recovery_state.resume_command}`] : []),
      ]
      : ['- No active recovery worktree']),
    '',
    '## Stale Clusters',
    ...(result.stale_clusters?.length
      ? result.stale_clusters.map((cluster) => `- ${cluster.title}: ${cluster.detail} -> ${cluster.next_action}`)
      : ['- None']),
    '',
    '## Stale Waves',
    ...(result.stale_causal_waves?.length
      ? result.stale_causal_waves.map((wave) => `- ${wave.summary}: affects ${wave.affected_pipeline_ids.join(', ') || 'unknown'} -> ${wave.cluster_count} cluster(s), ${wave.invalidation_count} invalidation(s)`)
      : ['- None']),
    '',
    '## Policy & Stale Audit',
    ...(result.trust_audit?.length
      ? result.trust_audit.map((entry) => `- ${entry.created_at}: [${entry.category}] ${entry.summary} -> ${entry.next_action}`)
      : ['- No recent policy or stale-wave audit entries']),
    '',
    '## Queue State',
    `- Status: ${result.queue_state?.status || 'not_queued'}`,
    ...(result.queue_state?.item_id ? [`- Item: ${result.queue_state.item_id}`] : []),
    `- Target branch: ${result.queue_state?.target_branch || 'main'}`,
    ...(result.queue_state?.merged_commit ? [`- Merged commit: ${result.queue_state.merged_commit}`] : []),
    ...(result.queue_state?.last_error_summary ? [`- Queue error: ${result.queue_state.last_error_summary}`] : []),
    ...(result.queue_state?.policy_override_summary ? [`- Policy override: ${result.queue_state.policy_override_summary}`] : []),
    '',
    '## Next Action',
    `- ${result.next_action}`,
  ].join('\n');
}

export function writeGitHubPipelineLandingStatus({ result, stepSummaryPath = null, outputPath = null }) {
  const markdown = formatPipelineLandingMarkdown(result);
  const checkInfo = getPipelineLandingCheckInfo(result);

  if (stepSummaryPath) {
    writeFileSync(stepSummaryPath, `${markdown}\n`);
  }

  if (outputPath) {
    const lines = [
      `switchman_pipeline_id=${result.pipeline_id}`,
      `switchman_pipeline_ready=${result.ready_to_queue ? 'true' : 'false'}`,
      `switchman_landing_branch=${result.landing.branch}`,
      `switchman_landing_strategy=${result.landing.strategy}`,
      `switchman_landing_synthetic=${result.landing.synthetic ? 'true' : 'false'}`,
      `switchman_queue_status=${result.queue_state?.status || 'not_queued'}`,
      `switchman_queue_item_id=${result.queue_state?.item_id || ''}`,
      `switchman_queue_target_branch=${result.queue_state?.target_branch || 'main'}`,
      `switchman_queue_merged_commit=${result.queue_state?.merged_commit || ''}`,
      `switchman_stale_cluster_count=${result.stale_clusters?.length || 0}`,
      `switchman_stale_cluster_summary=${JSON.stringify((result.stale_clusters || []).map((cluster) => `${cluster.affected_pipeline_id || cluster.affected_task_ids[0]}:${cluster.invalidation_count}`).join(' | '))}`,
      `switchman_stale_wave_count=${result.stale_causal_waves?.length || 0}`,
      `switchman_stale_wave_summary=${JSON.stringify((result.stale_causal_waves || []).map((wave) => `${wave.summary}:${wave.affected_pipeline_ids.join(',')}`).join(' | '))}`,
      `switchman_trust_audit_count=${result.trust_audit?.length || 0}`,
      `switchman_trust_audit_summary=${JSON.stringify((result.trust_audit || []).slice(0, 3).map((entry) => `${entry.category}:${entry.summary}`).join(' | '))}`,
      `switchman_policy_override_summary=${JSON.stringify(result.policy_override_summary || '')}`,
      `switchman_landing_next_action=${JSON.stringify(result.next_action)}`,
      `switchman_check_name=${JSON.stringify('Switchman Pipeline Landing')}`,
      `switchman_check_status=${checkInfo.status}`,
      `switchman_check_title=${JSON.stringify(checkInfo.title)}`,
      `switchman_check_summary=${JSON.stringify(checkInfo.summary)}`,
    ];
    writeFileSync(outputPath, `${lines.join('\n')}\n`);
  }

  return {
    markdown,
    wrote_step_summary: Boolean(stepSummaryPath),
    wrote_output: Boolean(outputPath),
  };
}

export function installGitHubActionsWorkflow(repoRoot, workflowName = 'switchman-gate.yml') {
  const workflowsDir = join(repoRoot, '.github', 'workflows');
  if (!existsSync(workflowsDir)) {
    mkdirSync(workflowsDir, { recursive: true });
  }

  const workflowPath = join(workflowsDir, workflowName);
  const workflow = `name: Switchman Gate

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  switchman-gate:
    name: Switchman Gate
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install Switchman
        run: npm install -g switchman-dev

      - name: Run Switchman CI gate
        id: switchman_gate
        continue-on-error: true
        run: switchman gate ci --github --github-comment --pr-from-env

      - name: Summarize Switchman result
        if: always()
        run: |
          echo "Switchman status: \${{ steps.switchman_gate.outputs.switchman_ok }}"
          echo "Switchman summary: \${{ steps.switchman_gate.outputs.switchman_summary }}"

      - name: Enforce Switchman gate
        if: always()
        run: |
          if [ "\${{ steps.switchman_gate.outputs.switchman_ok }}" != "true" ]; then
            echo "Switchman blocked this change."
            echo "\${{ steps.switchman_gate.outputs.switchman_summary }}"
            exit 1
          fi

      - name: Sync Switchman PR state
        if: github.event_name == 'pull_request'
        continue-on-error: true
        run: |
          switchman pipeline sync-pr --pipeline-from-env --skip-missing-pipeline --pr-from-env --github
`;

  writeFileSync(workflowPath, workflow);
  return workflowPath;
}

export function resolveGitHubOutputTargets(opts = {}, env = process.env) {
  const githubMode = Boolean(opts.github);
  return {
    stepSummaryPath: opts.githubStepSummary || (githubMode ? env.GITHUB_STEP_SUMMARY || null : null),
    outputPath: opts.githubOutput || (githubMode ? env.GITHUB_OUTPUT || null : null),
  };
}
