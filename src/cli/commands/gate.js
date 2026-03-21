export function registerGateCommands(program, {
  chalk,
  getDb,
  getRepo,
  installGateHooks,
  installGitHubActionsWorkflow,
  maybeCaptureTelemetry,
  resolveGitHubOutputTargets,
  runAiMergeGate,
  runCommitGate,
  scanAllWorktrees,
  writeGitHubCiStatus,
}) {
  const gateCmd = program.command('gate').description('Safety checks for edits, merges, and CI');
  gateCmd.addHelpText('after', `
Examples:
  switchman gate ci
  switchman gate ai
  switchman gate install-ci
`);

  gateCmd
    .command('commit')
    .description('Validate current worktree changes against the active lease and claims')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const result = runCommitGate(db, repoRoot);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.ok) {
        console.log(`${chalk.green('✓')} ${result.summary}`);
      } else {
        console.log(chalk.red(`✗ ${result.summary}`));
        for (const violation of result.violations) {
          const label = violation.file || '(worktree)';
          console.log(`  ${chalk.yellow(label)} ${chalk.dim(violation.reason_code)}`);
        }
      }

      if (!result.ok) process.exitCode = 1;
    });

  gateCmd
    .command('merge')
    .description('Validate current worktree changes before recording a merge commit')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const result = runCommitGate(db, repoRoot);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.ok) {
        console.log(`${chalk.green('✓')} Merge gate passed for ${chalk.cyan(result.worktree || 'current worktree')}.`);
      } else {
        console.log(chalk.red(`✗ Merge gate rejected changes in ${chalk.cyan(result.worktree || 'current worktree')}.`));
        for (const violation of result.violations) {
          const label = violation.file || '(worktree)';
          console.log(`  ${chalk.yellow(label)} ${chalk.dim(violation.reason_code)}`);
        }
      }

      if (!result.ok) process.exitCode = 1;
    });

  gateCmd
    .command('install')
    .description('Install git hooks that run the Switchman commit and merge gates')
    .action(() => {
      const repoRoot = getRepo();
      const hookPaths = installGateHooks(repoRoot);
      console.log(`${chalk.green('✓')} Installed pre-commit hook at ${chalk.cyan(hookPaths.pre_commit)}`);
      console.log(`${chalk.green('✓')} Installed pre-merge-commit hook at ${chalk.cyan(hookPaths.pre_merge_commit)}`);
    });

  gateCmd
    .command('ci')
    .description('Run a repo-level enforcement gate suitable for CI, merges, or PR validation')
    .option('--github', 'Write GitHub Actions step summary/output when GITHUB_* env vars are present')
    .option('--github-step-summary <path>', 'Path to write GitHub Actions step summary markdown')
    .option('--github-output <path>', 'Path to write GitHub Actions outputs')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const report = await scanAllWorktrees(db, repoRoot);
      const aiGate = await runAiMergeGate(db, repoRoot);
      db.close();

      const ok = report.conflicts.length === 0
        && report.fileConflicts.length === 0
        && (report.ownershipConflicts?.length || 0) === 0
        && (report.semanticConflicts?.length || 0) === 0
        && report.unclaimedChanges.length === 0
        && report.complianceSummary.non_compliant === 0
        && report.complianceSummary.stale === 0
        && aiGate.status !== 'blocked'
        && aiGate.status !== 'uncertain'
        && (aiGate.dependency_invalidations?.filter((item) => item.severity === 'blocked').length || 0) === 0;

      const result = {
        ok,
        summary: ok
          ? `Repo gate passed for ${report.worktrees.length} worktree(s).`
          : 'Repo gate rejected unmanaged changes, stale leases, ownership conflicts, stale dependency invalidations, or boundary validation failures.',
        compliance: report.complianceSummary,
        unclaimed_changes: report.unclaimedChanges,
        file_conflicts: report.fileConflicts,
        ownership_conflicts: report.ownershipConflicts || [],
        semantic_conflicts: report.semanticConflicts || [],
        branch_conflicts: report.conflicts,
        ai_gate_status: aiGate.status,
        boundary_validations: aiGate.boundary_validations || [],
        dependency_invalidations: aiGate.dependency_invalidations || [],
      };

      const githubTargets = resolveGitHubOutputTargets(opts);
      if (githubTargets.stepSummaryPath || githubTargets.outputPath) {
        writeGitHubCiStatus({
          result,
          stepSummaryPath: githubTargets.stepSummaryPath,
          outputPath: githubTargets.outputPath,
        });
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (ok) {
        console.log(`${chalk.green('✓')} ${result.summary}`);
      } else {
        console.log(chalk.red(`✗ ${result.summary}`));
        if (result.unclaimed_changes.length > 0) {
          console.log(chalk.bold('  Unclaimed changes:'));
          for (const entry of result.unclaimed_changes) {
            console.log(`    ${chalk.cyan(entry.worktree)}: ${entry.files.join(', ')}`);
          }
        }
        if (result.file_conflicts.length > 0) {
          console.log(chalk.bold('  File conflicts:'));
          for (const conflict of result.file_conflicts) {
            console.log(`    ${chalk.yellow(conflict.file)} ${chalk.dim(conflict.worktrees.join(', '))}`);
          }
        }
        if (result.ownership_conflicts.length > 0) {
          console.log(chalk.bold('  Ownership conflicts:'));
          for (const conflict of result.ownership_conflicts) {
            if (conflict.type === 'subsystem_overlap') {
              console.log(`    ${chalk.yellow(conflict.worktreeA)} ${chalk.dim('vs')} ${chalk.yellow(conflict.worktreeB)} ${chalk.dim(`subsystem:${conflict.subsystemTag}`)}`);
            } else {
              console.log(`    ${chalk.yellow(conflict.worktreeA)} ${chalk.dim('vs')} ${chalk.yellow(conflict.worktreeB)} ${chalk.dim(`${conflict.scopeA} ↔ ${conflict.scopeB}`)}`);
            }
          }
        }
        if (result.semantic_conflicts.length > 0) {
          console.log(chalk.bold('  Semantic conflicts:'));
          for (const conflict of result.semantic_conflicts) {
            console.log(`    ${chalk.yellow(conflict.object_name)} ${chalk.dim(`${conflict.worktreeA} vs ${conflict.worktreeB}`)}`);
          }
        }
        if (result.branch_conflicts.length > 0) {
          console.log(chalk.bold('  Branch conflicts:'));
          for (const conflict of result.branch_conflicts) {
            console.log(`    ${chalk.yellow(conflict.worktreeA)} ${chalk.dim('vs')} ${chalk.yellow(conflict.worktreeB)}`);
          }
        }
        if (result.boundary_validations.length > 0) {
          console.log(chalk.bold('  Boundary validations:'));
          for (const validation of result.boundary_validations) {
            console.log(`    ${chalk.yellow(validation.task_id)} ${chalk.dim(validation.missing_task_types.join(', '))}`);
          }
        }
        if (result.dependency_invalidations.length > 0) {
          console.log(chalk.bold('  Stale dependency invalidations:'));
          for (const invalidation of result.dependency_invalidations) {
            console.log(`    ${chalk.yellow(invalidation.affected_task_id)} ${chalk.dim(invalidation.stale_area)}`);
          }
        }
      }

      await maybeCaptureTelemetry(ok ? 'gate_ci_passed' : 'gate_ci_failed', {
        worktree_count: report.worktrees.length,
        unclaimed_change_count: result.unclaimed_changes.length,
        file_conflict_count: result.file_conflicts.length,
        ownership_conflict_count: result.ownership_conflicts.length,
        semantic_conflict_count: result.semantic_conflicts.length,
        branch_conflict_count: result.branch_conflicts.length,
      });

      if (!ok) process.exitCode = 1;
    });

  gateCmd
    .command('install-ci')
    .description('Install a GitHub Actions workflow that runs the Switchman CI gate on PRs and pushes')
    .option('--workflow-name <name>', 'Workflow file name', 'switchman-gate.yml')
    .action((opts) => {
      const repoRoot = getRepo();
      const workflowPath = installGitHubActionsWorkflow(repoRoot, opts.workflowName);
      console.log(`${chalk.green('✓')} Installed GitHub Actions workflow at ${chalk.cyan(workflowPath)}`);
    });

  gateCmd
    .command('ai')
    .description('Run the AI-style merge check to assess risky overlap across workspaces')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const result = await runAiMergeGate(db, repoRoot);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const badge = result.status === 'pass'
          ? chalk.green('PASS')
          : result.status === 'warn'
            ? chalk.yellow('WARN')
            : result.status === 'uncertain'
              ? chalk.yellow('UNCERTAIN')
            : chalk.red('BLOCK');
        console.log(`${badge} ${result.summary}`);

        const riskyPairs = result.pairs.filter((pair) => pair.status !== 'pass');
        if (riskyPairs.length > 0) {
          console.log(chalk.bold('  Risky pairs:'));
          for (const pair of riskyPairs) {
            console.log(`    ${chalk.cyan(pair.worktree_a)} ${chalk.dim('vs')} ${chalk.cyan(pair.worktree_b)} ${chalk.dim(pair.status)} ${chalk.dim(`score=${pair.score}`)}`);
            for (const reason of pair.reasons.slice(0, 3)) {
              console.log(`      ${chalk.yellow(reason)}`);
            }
          }
        }

        if ((result.boundary_validations?.length || 0) > 0) {
          console.log(chalk.bold('  Boundary validations:'));
          for (const validation of result.boundary_validations.slice(0, 5)) {
            console.log(`    ${chalk.cyan(validation.task_id)} ${chalk.dim(validation.severity)} ${chalk.dim(validation.missing_task_types.join(', '))}`);
            if (validation.rationale?.[0]) {
              console.log(`      ${chalk.yellow(validation.rationale[0])}`);
            }
          }
        }

        if ((result.dependency_invalidations?.length || 0) > 0) {
          console.log(chalk.bold('  Stale dependency invalidations:'));
          for (const invalidation of result.dependency_invalidations.slice(0, 5)) {
            console.log(`    ${chalk.cyan(invalidation.affected_task_id)} ${chalk.dim(invalidation.severity)} ${chalk.dim(invalidation.stale_area)}`);
          }
        }

        if ((result.semantic_conflicts?.length || 0) > 0) {
          console.log(chalk.bold('  Semantic conflicts:'));
          for (const conflict of result.semantic_conflicts.slice(0, 5)) {
            console.log(`    ${chalk.cyan(conflict.object_name)} ${chalk.dim(conflict.type)} ${chalk.dim(`${conflict.worktreeA} vs ${conflict.worktreeB}`)}`);
          }
        }

        const riskyWorktrees = result.worktrees.filter((worktree) => worktree.findings.length > 0);
        if (riskyWorktrees.length > 0) {
          console.log(chalk.bold('  Worktree signals:'));
          for (const worktree of riskyWorktrees) {
            console.log(`    ${chalk.cyan(worktree.worktree)} ${chalk.dim(`score=${worktree.score}`)}`);
            for (const finding of worktree.findings.slice(0, 2)) {
              console.log(`      ${chalk.yellow(finding)}`);
            }
          }
        }
      }

      if (result.status !== 'pass') process.exitCode = 1;
    });

  return gateCmd;
}
