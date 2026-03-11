import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

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
  return [
    '# Switchman CI Gate',
    '',
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

export function writeGitHubCiStatus({ result, stepSummaryPath = null, outputPath = null }) {
  const markdown = formatCiGateMarkdown(result);

  if (stepSummaryPath) {
    writeFileSync(stepSummaryPath, `${markdown}\n`);
  }

  if (outputPath) {
    const lines = [
      `switchman_ok=${result.ok ? 'true' : 'false'}`,
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
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Switchman
        run: npm install -g switchman-dev

      - name: Run Switchman CI gate
        run: switchman gate ci --github
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
