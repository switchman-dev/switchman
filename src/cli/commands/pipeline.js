export function registerPipelineCommands(program, {
  buildLandingStateLabel,
  buildPipelinePrSummary,
  chalk,
  cleanupPipelineLandingRecovery,
  colorForHealth,
  commentPipelinePr,
  createPipelineFollowupTasks,
  executePipeline,
  exportPipelinePrBundle,
  getDb,
  getRepo,
  getPipelineLandingBranchStatus,
  getPipelineStatus,
  healthLabel,
  humanizeReasonCode,
  inferPipelineIdFromBranch,
  loadChangePolicy,
  materializePipelineLandingBranch,
  preparePipelineLandingRecovery,
  printErrorWithNext,
  publishPipelinePr,
  renderChip,
  renderMetricRow,
  renderPanel,
  renderSignalStrip,
  repairPipelineState,
  resolveBranchFromEnv,
  resolveGitHubOutputTargets,
  resolvePrNumberFromEnv,
  resumePipelineLandingRecovery,
  runPipeline,
  startPipeline,
  summarizePipelinePolicyState,
  syncPipelinePr,
  writeGitHubPipelineLandingStatus,
}) {
  const pipelineCmd = program.command('pipeline').description('Create and summarize issue-to-PR execution pipelines');
  pipelineCmd._switchmanAdvanced = true;
  pipelineCmd.addHelpText('after', `
Examples:
  switchman pipeline start "Harden auth API permissions"
  switchman pipeline exec pipe-123 "/path/to/agent-command"
  switchman pipeline status pipe-123
  switchman pipeline land pipe-123
`);

  pipelineCmd
    .command('start <title>')
    .description('Create a pipeline from one issue title and split it into execution subtasks')
    .option('-d, --description <desc>', 'Issue description or markdown checklist')
    .option('-p, --priority <n>', 'Priority 1-10 (default 5)', '5')
    .option('--id <id>', 'Custom pipeline ID')
    .option('--json', 'Output raw JSON')
    .action((title, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const result = startPipeline(db, {
        title,
        description: opts.description || null,
        priority: Number.parseInt(opts.priority, 10),
        pipelineId: opts.id || null,
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Pipeline created ${chalk.cyan(result.pipeline_id)}`);
      console.log(`  ${chalk.bold(result.title)}`);
      for (const task of result.tasks) {
        const suggested = task.suggested_worktree ? ` ${chalk.dim(`→ ${task.suggested_worktree}`)}` : '';
        const type = task.task_spec?.task_type ? ` ${chalk.dim(`[${task.task_spec.task_type}]`)}` : '';
        console.log(`  ${chalk.cyan(task.id)} ${task.title}${type}${suggested}`);
      }
    });

  pipelineCmd
    .command('status <pipelineId>')
    .description('Show task status for a pipeline')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Plain English:
  Use this when one goal has been split into several tasks and you want to see what is running, stuck, or next.

Examples:
  switchman pipeline status pipe-123
  switchman pipeline status pipe-123 --json
`)
    .action((pipelineId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = getPipelineStatus(db, pipelineId);
        let landing;
        let landingError = null;
        try {
          landing = getPipelineLandingBranchStatus(db, repoRoot, pipelineId, {
            requireCompleted: false,
          });
        } catch (err) {
          landingError = String(err.message || 'Landing branch is not ready yet.');
          landing = {
            branch: null,
            synthetic: false,
            stale: false,
            stale_reasons: [],
            last_failure: null,
            last_recovery: null,
          };
        }
        const policyState = summarizePipelinePolicyState(db, result, loadChangePolicy(repoRoot), []);
        db.close();

        if (opts.json) {
          console.log(JSON.stringify({
            ...result,
            landing_branch: landing,
            landing_error: landingError,
            policy_state: policyState,
          }, null, 2));
          return;
        }

        const pipelineHealth = result.status === 'blocked'
          ? 'block'
          : result.counts.failed > 0
            ? 'warn'
            : result.counts.in_progress > 0
              ? 'warn'
              : 'healthy';
        const pipelineHealthColor = colorForHealth(pipelineHealth);
        const failedTask = result.tasks.find((task) => task.status === 'failed');
        const runningTask = result.tasks.find((task) => task.status === 'in_progress');
        const nextPendingTask = result.tasks.find((task) => task.status === 'pending');
        const focusTask = failedTask || runningTask || nextPendingTask || result.tasks[0] || null;
        const focusLine = focusTask
          ? `${focusTask.title} ${chalk.dim(focusTask.id)}`
          : 'No pipeline tasks found.';
        const landingLabel = buildLandingStateLabel(landing);

        console.log('');
        console.log(pipelineHealthColor('='.repeat(72)));
        console.log(`${pipelineHealthColor(healthLabel(pipelineHealth))} ${chalk.bold('switchman pipeline status')} ${chalk.dim('• pipeline mission control')}`);
        console.log(`${chalk.bold(result.title)} ${chalk.dim(result.pipeline_id)}`);
        console.log(pipelineHealthColor('='.repeat(72)));
        console.log(renderSignalStrip([
          renderChip('done', result.counts.done, result.counts.done > 0 ? chalk.green : chalk.white),
          renderChip('running', result.counts.in_progress, result.counts.in_progress > 0 ? chalk.blue : chalk.green),
          renderChip('pending', result.counts.pending, result.counts.pending > 0 ? chalk.yellow : chalk.green),
          renderChip('failed', result.counts.failed, result.counts.failed > 0 ? chalk.red : chalk.green),
        ]));
        console.log(`${chalk.bold('Focus now:')} ${focusLine}`);
        if (landingLabel) {
          console.log(`${chalk.bold('Landing:')} ${landingLabel}`);
        } else if (landingError) {
          console.log(`${chalk.bold('Landing:')} ${chalk.yellow('not ready yet')} ${chalk.dim(landingError)}`);
        }

        const runningLines = result.tasks.filter((task) => task.status === 'in_progress').slice(0, 4).map((task) => {
          const worktree = task.worktree || task.suggested_worktree || 'unassigned';
          const blocked = task.blocked_by?.length ? ` ${chalk.dim(`blocked by ${task.blocked_by.join(', ')}`)}` : '';
          const type = task.task_spec?.task_type ? ` ${chalk.dim(`[${task.task_spec.task_type}]`)}` : '';
          return `${chalk.cyan(worktree)} -> ${task.title}${type} ${chalk.dim(task.id)}${blocked}`;
        });

        const blockedLines = result.tasks.filter((task) => task.status === 'failed').slice(0, 4).flatMap((task) => {
          const type = task.task_spec?.task_type ? ` ${chalk.dim(`[${task.task_spec.task_type}]`)}` : '';
          const lines = [`${renderChip('BLOCKED', task.id, chalk.red)} ${task.title}${type}`];
          if (task.failure?.summary) {
            const reasonLabel = humanizeReasonCode(task.failure.reason_code);
            lines.push(`  ${chalk.red('why:')} ${task.failure.summary} ${chalk.dim(`(${reasonLabel})`)}`);
          }
          if (task.next_action) lines.push(`  ${chalk.yellow('next:')} ${task.next_action}`);
          return lines;
        });

        const nextLines = result.tasks.filter((task) => task.status === 'pending').slice(0, 4).map((task) => {
          const worktree = task.suggested_worktree || task.worktree || 'unassigned';
          const blocked = task.blocked_by?.length ? ` ${chalk.dim(`blocked by ${task.blocked_by.join(', ')}`)}` : '';
          return `${renderChip('NEXT', task.id, chalk.green)} ${task.title} ${chalk.dim(worktree)}${blocked}`;
        });

        const landingLines = landing.synthetic
          ? [
            `${renderChip(landing.stale ? 'STALE' : 'LAND', landing.branch, landing.stale ? chalk.red : chalk.green)} ${chalk.dim(`base ${landing.base_branch}`)}`,
            ...(landing.last_failure
              ? [
                `  ${chalk.red('failure:')} ${humanizeReasonCode(landing.last_failure.reason_code || 'landing_branch_materialization_failed')}`,
                ...(landing.last_failure.failed_branch ? [`  ${chalk.dim('failed branch:')} ${landing.last_failure.failed_branch}`] : []),
              ]
              : []),
            ...(landing.last_recovery?.state?.status
              ? [
                `  ${chalk.dim('recovery:')} ${landing.last_recovery.state.status} ${landing.last_recovery.recovery_path}`,
              ]
              : []),
            ...(landing.stale_reasons.length > 0
              ? landing.stale_reasons.slice(0, 3).map((reason) => `  ${chalk.red('why:')} ${reason.summary}`)
              : [landing.last_materialized
                ? `  ${chalk.green('state:')} ready to queue`
                : `  ${chalk.yellow('next:')} switchman pipeline land ${result.pipeline_id}`]),
            (landing.last_failure?.command
              ? `  ${chalk.yellow('next:')} ${landing.last_failure.command}`
              : landing.stale
                ? `  ${chalk.yellow('next:')} switchman pipeline land ${result.pipeline_id} --refresh`
                : `  ${chalk.yellow('next:')} switchman queue add --pipeline ${result.pipeline_id}`),
          ]
          : [];

        const policyLines = policyState.active
          ? [
            `${renderChip(policyState.enforcement.toUpperCase(), policyState.domains.join(','), policyState.enforcement === 'blocked' ? chalk.red : chalk.yellow)} ${policyState.summary}`,
            `  ${chalk.dim('required:')} ${policyState.required_task_types.join(', ') || 'none'}`,
            `  ${chalk.dim('satisfied:')} ${policyState.satisfied_task_types.join(', ') || 'none'}`,
            `  ${chalk.dim('missing:')} ${policyState.missing_task_types.join(', ') || 'none'}`,
            `  ${chalk.dim('overridden:')} ${policyState.overridden_task_types.join(', ') || 'none'}`,
            ...policyState.requirement_status
              .filter((requirement) => requirement.evidence.length > 0)
              .slice(0, 4)
              .map((requirement) => `  ${chalk.dim(`${requirement.task_type}:`)} ${requirement.evidence.map((entry) => entry.artifact_path ? `${entry.task_id} (${entry.artifact_path})` : entry.task_id).join(', ')}`),
            ...policyState.overrides
              .slice(0, 3)
              .map((entry) => `  ${chalk.dim(`override ${entry.id}:`)} ${(entry.task_types || []).join(', ') || 'all'} by ${entry.approved_by || 'unknown'}`),
          ]
          : [chalk.green('No explicit change policy requirements are active for this pipeline.')];

        const commandLines = [
          `${chalk.cyan('$')} switchman pipeline exec ${result.pipeline_id} "/path/to/agent-command"`,
          `${chalk.cyan('$')} switchman pipeline pr ${result.pipeline_id}`,
          ...(landing.last_failure?.command ? [`${chalk.cyan('$')} ${landing.last_failure.command}`] : []),
          ...(landing.synthetic && landing.stale ? [`${chalk.cyan('$')} switchman pipeline land ${result.pipeline_id} --refresh`] : []),
          ...(result.counts.failed > 0 ? [`${chalk.cyan('$')} switchman pipeline status ${result.pipeline_id}`] : []),
        ];

        console.log('');
        for (const block of [
          renderPanel('Running now', runningLines.length > 0 ? runningLines : [chalk.dim('No tasks are actively running.')], runningLines.length > 0 ? chalk.cyan : chalk.green),
          renderPanel('Blocked', blockedLines.length > 0 ? blockedLines : [chalk.green('Nothing blocked.')], blockedLines.length > 0 ? chalk.red : chalk.green),
          renderPanel('Next up', nextLines.length > 0 ? nextLines : [chalk.dim('No pending tasks left.')], chalk.green),
          renderPanel('Policy', policyLines, policyState.active ? (policyState.missing_task_types.length > 0 ? chalk.red : chalk.green) : chalk.green),
          ...(landing.synthetic ? [renderPanel('Landing branch', landingLines, landing.stale ? chalk.red : chalk.cyan)] : []),
          renderPanel('Next commands', commandLines, chalk.cyan),
        ]) {
          for (const line of block) console.log(line);
          console.log('');
        }
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('pr <pipelineId>')
    .description('Generate a PR-ready summary for a pipeline using the repo and AI gates')
    .option('--json', 'Output raw JSON')
    .action(async (pipelineId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = await buildPipelinePrSummary(db, repoRoot, pipelineId);
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(result.markdown);
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('bundle <pipelineId> [outputDir]')
    .description('Export a reviewer-ready PR bundle for a pipeline to disk')
    .option('--github', 'Write GitHub Actions step summary/output when GITHUB_* env vars are present')
    .option('--github-step-summary <path>', 'Path to write GitHub Actions step summary markdown')
    .option('--github-output <path>', 'Path to write GitHub Actions outputs')
    .option('--json', 'Output raw JSON')
    .action(async (pipelineId, outputDir, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = await exportPipelinePrBundle(db, repoRoot, pipelineId, outputDir || null);
        db.close();

        const githubTargets = resolveGitHubOutputTargets(opts);
        if (githubTargets.stepSummaryPath || githubTargets.outputPath) {
          writeGitHubPipelineLandingStatus({
            result: result.landing_summary,
            stepSummaryPath: githubTargets.stepSummaryPath,
            outputPath: githubTargets.outputPath,
          });
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} Exported PR bundle for ${chalk.cyan(result.pipeline_id)}`);
        console.log(`  ${chalk.dim(result.output_dir)}`);
        console.log(`  ${chalk.dim('json:')} ${result.files.summary_json}`);
        console.log(`  ${chalk.dim('summary:')} ${result.files.summary_markdown}`);
        console.log(`  ${chalk.dim('body:')} ${result.files.pr_body_markdown}`);
        console.log(`  ${chalk.dim('landing json:')} ${result.files.landing_summary_json}`);
        console.log(`  ${chalk.dim('landing md:')} ${result.files.landing_summary_markdown}`);
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('land <pipelineId>')
    .description('Create or refresh one landing branch for a completed pipeline')
    .option('--base <branch>', 'Base branch for the landing branch', 'main')
    .option('--branch <branch>', 'Custom landing branch name')
    .option('--refresh', 'Rebuild the landing branch when a source branch or base branch has moved')
    .option('--recover', 'Create a recovery worktree for an unresolved landing merge conflict')
    .option('--replace-recovery', 'Replace an existing recovery worktree when creating a new one')
    .option('--resume [path]', 'Validate a resolved recovery worktree and mark the landing branch ready again')
    .option('--cleanup [path]', 'Remove a recorded recovery worktree after it is resolved or abandoned')
    .option('--json', 'Output raw JSON')
    .action((pipelineId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const selectedModes = [opts.refresh, opts.recover, Boolean(opts.resume), Boolean(opts.cleanup)].filter(Boolean).length;
        if (selectedModes > 1) {
          throw new Error('Choose only one of --refresh, --recover, --resume, or --cleanup.');
        }
        if (opts.recover) {
          const result = preparePipelineLandingRecovery(db, repoRoot, pipelineId, {
            baseBranch: opts.base,
            landingBranch: opts.branch || null,
            replaceExisting: Boolean(opts.replaceRecovery),
          });
          db.close();

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(`${chalk.green('✓')} ${result.reused_existing ? 'Recovery worktree already ready for' : 'Recovery worktree ready for'} ${chalk.cyan(result.pipeline_id)}`);
          console.log(`  ${chalk.dim('branch:')} ${chalk.cyan(result.branch)}`);
          console.log(`  ${chalk.dim('path:')} ${result.recovery_path}`);
          if (result.reused_existing) {
            console.log(`  ${chalk.dim('state:')} reusing existing recovery worktree`);
          }
          console.log(`  ${chalk.dim('blocked by:')} ${result.failed_branch}`);
          if (result.conflicting_files.length > 0) {
            console.log(`  ${chalk.dim('conflicts:')} ${result.conflicting_files.join(', ')}`);
          }
          console.log(`  ${chalk.yellow('inspect:')} ${result.inspect_command}`);
          console.log(`  ${chalk.yellow('after resolving + commit:')} ${result.resume_command}`);
          return;
        }
        if (opts.cleanup) {
          const result = cleanupPipelineLandingRecovery(db, repoRoot, pipelineId, {
            baseBranch: opts.base,
            landingBranch: opts.branch || null,
            recoveryPath: typeof opts.cleanup === 'string' ? opts.cleanup : null,
          });
          db.close();

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(`${chalk.green('✓')} Recovery worktree cleared for ${chalk.cyan(result.pipeline_id)}`);
          console.log(`  ${chalk.dim('path:')} ${result.recovery_path}`);
          console.log(`  ${chalk.dim('removed:')} ${result.removed ? 'yes' : 'no'}`);
          console.log(`  ${chalk.yellow('next:')} switchman explain landing ${result.pipeline_id}`);
          return;
        }
        if (opts.resume) {
          const result = resumePipelineLandingRecovery(db, repoRoot, pipelineId, {
            baseBranch: opts.base,
            landingBranch: opts.branch || null,
            recoveryPath: typeof opts.resume === 'string' ? opts.resume : null,
          });
          db.close();

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(`${chalk.green('✓')} ${result.already_resumed ? 'Landing recovery already resumed for' : 'Landing recovery resumed for'} ${chalk.cyan(result.pipeline_id)}`);
          console.log(`  ${chalk.dim('branch:')} ${chalk.cyan(result.branch)}`);
          console.log(`  ${chalk.dim('head:')} ${result.head_commit}`);
          if (result.recovery_path) {
            console.log(`  ${chalk.dim('recovery path:')} ${result.recovery_path}`);
          }
          if (result.already_resumed) {
            console.log(`  ${chalk.dim('state:')} already aligned and ready to queue`);
          }
          console.log(`  ${chalk.yellow('next:')} ${result.resume_command}`);
          return;
        }

        const result = materializePipelineLandingBranch(db, repoRoot, pipelineId, {
          baseBranch: opts.base,
          landingBranch: opts.branch || null,
          requireCompleted: true,
          refresh: Boolean(opts.refresh),
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} Landing branch ready for ${chalk.cyan(result.pipeline_id)}`);
        console.log(`  ${chalk.dim('branch:')} ${chalk.cyan(result.branch)}`);
        console.log(`  ${chalk.dim('base:')} ${result.base_branch}`);
        console.log(`  ${chalk.dim('strategy:')} ${result.strategy}`);
        console.log(`  ${chalk.dim('components:')} ${result.component_branches.join(', ')}`);
        if (result.reused_existing) {
          console.log(`  ${chalk.dim('state:')} already current`);
        } else if (result.refreshed) {
          console.log(`  ${chalk.dim('state:')} refreshed`);
        }
        console.log(`  ${chalk.yellow('next:')} switchman queue add ${result.branch}`);
      } catch (err) {
        db.close();
        printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('publish <pipelineId> [outputDir]')
    .description('Create a hosted GitHub pull request for a pipeline using gh')
    .option('--base <branch>', 'Base branch for the pull request', 'main')
    .option('--head <branch>', 'Head branch for the pull request (defaults to inferred pipeline branch)')
    .option('--draft', 'Create the pull request as a draft')
    .option('--gh-command <command>', 'Executable to use for GitHub CLI', 'gh')
    .option('--json', 'Output raw JSON')
    .action(async (pipelineId, outputDir, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = await publishPipelinePr(db, repoRoot, pipelineId, {
          baseBranch: opts.base,
          headBranch: opts.head || null,
          draft: Boolean(opts.draft),
          ghCommand: opts.ghCommand,
          outputDir: outputDir || null,
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} Published PR for ${chalk.cyan(result.pipeline_id)}`);
        console.log(`  ${chalk.dim('base:')} ${result.base_branch}`);
        console.log(`  ${chalk.dim('head:')} ${result.head_branch}`);
        if (result.output) {
          console.log(`  ${chalk.dim(result.output)}`);
        }
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('comment <pipelineId> [outputDir]')
    .description('Post or update a GitHub PR comment with the pipeline landing summary')
    .option('--pr <number>', 'Pull request number to comment on')
    .option('--pr-from-env', 'Read the pull request number from GitHub Actions environment variables')
    .option('--gh-command <command>', 'Executable to use for GitHub CLI', 'gh')
    .option('--update-existing', 'Edit the last comment from this user instead of creating a new one')
    .option('--json', 'Output raw JSON')
    .action(async (pipelineId, outputDir, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const prNumber = opts.pr || (opts.prFromEnv ? resolvePrNumberFromEnv() : null);

      try {
        if (!prNumber) {
          throw new Error('A pull request number is required. Pass `--pr <number>` or `--pr-from-env`.');
        }
        const result = await commentPipelinePr(db, repoRoot, pipelineId, {
          prNumber,
          ghCommand: opts.ghCommand,
          outputDir: outputDir || null,
          updateExisting: Boolean(opts.updateExisting),
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} Posted pipeline comment for ${chalk.cyan(result.pipeline_id)}`);
        console.log(`  ${chalk.dim('pr:')} #${result.pr_number}`);
        console.log(`  ${chalk.dim('body:')} ${result.bundle.files.landing_summary_markdown}`);
        if (result.updated_existing) {
          console.log(`  ${chalk.dim('mode:')} update existing comment`);
        }
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('sync-pr [pipelineId] [outputDir]')
    .description('Build PR artifacts, emit GitHub outputs, and update the PR comment in one command')
    .option('--pr <number>', 'Pull request number to comment on')
    .option('--pr-from-env', 'Read the pull request number from GitHub Actions environment variables')
    .option('--pipeline-from-env', 'Infer the pipeline id from the current GitHub branch context')
    .option('--skip-missing-pipeline', 'Exit successfully when no matching pipeline can be inferred')
    .option('--gh-command <command>', 'Executable to use for GitHub CLI', 'gh')
    .option('--github', 'Write GitHub Actions step summary/output when GITHUB_* env vars are present')
    .option('--github-step-summary <path>', 'Path to write GitHub Actions step summary markdown')
    .option('--github-output <path>', 'Path to write GitHub Actions outputs')
    .option('--no-comment', 'Skip updating the PR comment')
    .option('--json', 'Output raw JSON')
    .action(async (pipelineId, outputDir, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const branchFromEnv = opts.pipelineFromEnv ? resolveBranchFromEnv() : null;
      const resolvedPipelineId = pipelineId || (branchFromEnv ? inferPipelineIdFromBranch(db, branchFromEnv) : null);
      const prNumber = opts.pr || (opts.prFromEnv ? resolvePrNumberFromEnv() : null);

      try {
        if (!resolvedPipelineId) {
          if (!opts.skipMissingPipeline) {
            throw new Error(opts.pipelineFromEnv
              ? `Could not infer a pipeline from branch ${branchFromEnv || 'unknown'}. Pass a pipeline id explicitly or use a branch that maps to one Switchman pipeline.`
              : 'A pipeline id is required. Pass one explicitly or use `--pipeline-from-env`.');
          }
          const skipped = {
            skipped: true,
            reason: 'no_pipeline_inferred',
            branch: branchFromEnv,
            next_action: 'Run `switchman pipeline status <pipelineId>` locally to confirm the pipeline id, then rerun sync-pr with that id.',
          };
          db.close();
          if (opts.json) {
            console.log(JSON.stringify(skipped, null, 2));
            return;
          }
          console.log(`${chalk.green('✓')} No pipeline sync needed`);
          if (branchFromEnv) {
            console.log(`  ${chalk.dim('branch:')} ${branchFromEnv}`);
          }
          console.log(`  ${chalk.dim('reason:')} no matching Switchman pipeline was inferred`);
          console.log(`  ${chalk.yellow('next:')} ${skipped.next_action}`);
          return;
        }

        if (opts.comment !== false && !prNumber) {
          throw new Error('A pull request number is required for comment sync. Pass `--pr <number>`, `--pr-from-env`, or `--no-comment`.');
        }

        const result = await syncPipelinePr(db, repoRoot, resolvedPipelineId, {
          prNumber: opts.comment === false ? null : prNumber,
          ghCommand: opts.ghCommand,
          outputDir: outputDir || null,
          updateExisting: true,
        });
        db.close();

        const githubTargets = resolveGitHubOutputTargets(opts);
        if (githubTargets.stepSummaryPath || githubTargets.outputPath) {
          writeGitHubPipelineLandingStatus({
            result: result.bundle.landing_summary,
            stepSummaryPath: githubTargets.stepSummaryPath,
            outputPath: githubTargets.outputPath,
          });
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} Synced PR artifacts for ${chalk.cyan(result.pipeline_id)}`);
        console.log(`  ${chalk.dim('bundle:')} ${result.bundle.output_dir}`);
        if (result.comment) {
          console.log(`  ${chalk.dim('pr:')} #${result.comment.pr_number}`);
          console.log(`  ${chalk.dim('comment:')} updated existing`);
        }
        if (githubTargets.stepSummaryPath || githubTargets.outputPath) {
          console.log(`  ${chalk.dim('github:')} wrote PR check artifacts`);
        }
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('run <pipelineId> [agentCommand...]')
    .description('Dispatch pending pipeline tasks onto available worktrees and optionally launch an agent command in each one')
    .option('--agent <name>', 'Agent name to record on acquired leases', 'pipeline-runner')
    .option('--detached', 'Launch agent commands as detached background processes')
    .option('--json', 'Output raw JSON')
    .action((pipelineId, agentCommand, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = runPipeline(db, repoRoot, {
          pipelineId,
          agentCommand,
          agentName: opts.agent,
          detached: Boolean(opts.detached),
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.assigned.length === 0) {
          console.log(chalk.dim('No pending pipeline tasks were assigned. All worktrees may already be busy.'));
          return;
        }

        console.log(`${chalk.green('✓')} Dispatched ${result.assigned.length} pipeline task(s)`);
        for (const assignment of result.assigned) {
          const launch = result.launched.find((item) => item.task_id === assignment.task_id);
          const launchInfo = launch ? ` ${chalk.dim(`pid=${launch.pid}`)}` : '';
          console.log(`  ${chalk.cyan(assignment.task_id)} → ${chalk.cyan(assignment.worktree)} ${chalk.dim(assignment.lease_id)}${launchInfo}`);
        }
        if (result.remaining_pending > 0) {
          console.log(chalk.dim(`${result.remaining_pending} pipeline task(s) remain pending due to unavailable worktrees.`));
        }
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('repair <pipelineId>')
    .description('Safely repair interrupted landing state for one pipeline')
    .option('--base <branch>', 'Base branch for landing repair checks', 'main')
    .option('--branch <branch>', 'Custom landing branch name')
    .option('--json', 'Output raw JSON')
    .action((pipelineId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = repairPipelineState(db, repoRoot, pipelineId, {
          baseBranch: opts.base,
          landingBranch: opts.branch || null,
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (!result.repaired) {
          console.log(`${chalk.green('✓')} No repair action needed for ${chalk.cyan(result.pipeline_id)}`);
          for (const note of result.notes) {
            console.log(`  ${chalk.dim(note)}`);
          }
          console.log(`  ${chalk.yellow('next:')} ${result.next_action}`);
          return;
        }

        console.log(`${chalk.green('✓')} Repaired ${chalk.cyan(result.pipeline_id)}`);
        for (const action of result.actions) {
          if (action.kind === 'recovery_state_cleared') {
            console.log(`  ${chalk.dim('cleared recovery record:')} ${action.recovery_path}`);
          } else if (action.kind === 'landing_branch_refreshed') {
            console.log(`  ${chalk.dim('refreshed landing branch:')} ${action.branch}${action.head_commit ? ` ${chalk.dim(action.head_commit.slice(0, 12))}` : ''}`);
          }
        }
        console.log(`  ${chalk.yellow('next:')} ${result.next_action}`);
      } catch (err) {
        db.close();
        printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('review <pipelineId>')
    .description('Inspect repo and AI gate failures for a pipeline and create follow-up fix tasks')
    .option('--json', 'Output raw JSON')
    .action(async (pipelineId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = await createPipelineFollowupTasks(db, repoRoot, pipelineId);
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.created_count === 0) {
          console.log(chalk.dim('No follow-up tasks were created. The pipeline gates did not surface new actionable items.'));
          return;
        }

        console.log(`${chalk.green('✓')} Created ${result.created_count} follow-up task(s)`);
        for (const task of result.created) {
          console.log(`  ${chalk.cyan(task.id)} ${task.title}`);
        }
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  pipelineCmd
    .command('exec <pipelineId> [agentCommand...]')
    .description('Run a bounded autonomous loop: dispatch, execute, review, and stop when ready or blocked')
    .option('--agent <name>', 'Agent name to record on acquired leases', 'pipeline-runner')
    .option('--max-iterations <n>', 'Maximum execution/review iterations', '3')
    .option('--max-retries <n>', 'Retry a failed pipeline task up to this many times', '1')
    .option('--retry-backoff-ms <ms>', 'Base backoff in milliseconds between retry attempts', '0')
    .option('--timeout-ms <ms>', 'Default command timeout in milliseconds when a task spec does not provide one', '0')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Plain English:
  pipeline = one goal, broken into smaller safe tasks

Examples:
  switchman pipeline exec pipe-123 "/path/to/agent-command"
  switchman pipeline exec pipe-123 "npm test"
`)
    .action(async (pipelineId, agentCommand, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = await executePipeline(db, repoRoot, {
          pipelineId,
          agentCommand,
          agentName: opts.agent,
          maxIterations: Number.parseInt(opts.maxIterations, 10),
          maxRetries: Number.parseInt(opts.maxRetries, 10),
          retryBackoffMs: Number.parseInt(opts.retryBackoffMs, 10),
          timeoutMs: Number.parseInt(opts.timeoutMs, 10),
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const badge = result.status === 'ready'
          ? chalk.green('READY')
          : result.status === 'blocked'
            ? chalk.red('BLOCKED')
            : chalk.yellow('MAX');
        console.log(`${badge} Pipeline ${chalk.cyan(result.pipeline_id)} ${chalk.dim(result.status)}`);
        for (const iteration of result.iterations) {
          console.log(`  iter ${iteration.iteration}: resumed=${iteration.resumed_retries} dispatched=${iteration.dispatched} executed=${iteration.executed} retries=${iteration.retries_scheduled} followups=${iteration.followups_created} ai=${iteration.ai_gate_status} ready=${iteration.ready}`);
        }
        console.log(chalk.dim(result.pr.markdown.split('\n')[0]));
      } catch (err) {
        db.close();
        printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
        process.exitCode = 1;
      }
    });

  return pipelineCmd;
}
