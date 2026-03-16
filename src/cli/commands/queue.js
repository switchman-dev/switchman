export function registerQueueCommands(program, {
  buildQueueStatusSummary,
  chalk,
  colorForHealth,
  escalateMergeQueueItem,
  enqueueMergeItem,
  evaluatePipelinePolicyGate,
  getDb,
  getRepo,
  healthLabel,
  listMergeQueue,
  listMergeQueueEvents,
  listWorktrees,
  maybeCaptureTelemetry,
  preparePipelineLandingTarget,
  printErrorWithNext,
  pushSyncEvent,
  renderChip,
  renderMetricRow,
  renderPanel,
  renderSignalStrip,
  removeMergeQueueItem,
  retryMergeQueueItem,
  runMergeQueue,
  sleepSync,
  statusBadge,
}) {
  const queueCmd = program.command('queue').alias('land').description('Land finished work safely back onto main, one item at a time');
  queueCmd.addHelpText('after', `
Examples:
  switchman queue add --worktree agent1
  switchman queue status
  switchman queue run --watch
`);

  queueCmd
    .command('add [branch]')
    .description('Add a branch, workspace, or pipeline to the landing queue')
    .option('--worktree <name>', 'Queue a registered workspace by name')
    .option('--pipeline <pipelineId>', 'Queue a pipeline by id')
    .option('--target <branch>', 'Target branch to merge into', 'main')
    .option('--max-retries <n>', 'Maximum automatic retries', '1')
    .option('--submitted-by <name>', 'Operator or automation name')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Examples:
  switchman queue add feature/auth-hardening
  switchman queue add --worktree agent2
  switchman queue add --pipeline pipe-123

Pipeline landing rule:
  switchman queue add --pipeline <id>
  lands the pipeline's inferred landing branch.
  If completed work spans multiple branches, Switchman creates one synthetic landing branch first.
`)
    .action(async (branch, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        let payload;
        if (opts.worktree) {
          const worktree = listWorktrees(db).find((entry) => entry.name === opts.worktree);
          if (!worktree) {
            throw new Error(`Workspace ${opts.worktree} is not registered.`);
          }
          payload = {
            sourceType: 'worktree',
            sourceRef: worktree.branch,
            sourceWorktree: worktree.name,
            targetBranch: opts.target,
            maxRetries: opts.maxRetries,
            submittedBy: opts.submittedBy || null,
          };
        } else if (opts.pipeline) {
          const policyGate = await evaluatePipelinePolicyGate(db, repoRoot, opts.pipeline);
          if (!policyGate.ok) {
            throw new Error(`${policyGate.summary} Next: ${policyGate.next_action}`);
          }
          const landingTarget = preparePipelineLandingTarget(db, repoRoot, opts.pipeline, {
            baseBranch: opts.target || 'main',
            requireCompleted: true,
            allowCurrentBranchFallback: false,
          });
          payload = {
            sourceType: 'pipeline',
            sourceRef: landingTarget.branch,
            sourcePipelineId: opts.pipeline,
            sourceWorktree: landingTarget.worktree || null,
            targetBranch: opts.target,
            maxRetries: opts.maxRetries,
            submittedBy: opts.submittedBy || null,
            eventDetails: policyGate.override_applied
              ? {
                policy_override_summary: policyGate.override_summary,
                overridden_task_types: policyGate.policy_state?.overridden_task_types || [],
              }
              : null,
          };
        } else if (branch) {
          payload = {
            sourceType: 'branch',
            sourceRef: branch,
            targetBranch: opts.target,
            maxRetries: opts.maxRetries,
            submittedBy: opts.submittedBy || null,
          };
        } else {
          throw new Error('Choose one source to land: a branch name, `--worktree`, or `--pipeline`.');
        }

        const result = enqueueMergeItem(db, payload);
        db.close();
        pushSyncEvent('queue_added', {
          item_id: result.id,
          source_type: result.source_type,
          source_ref: result.source_ref,
          source_worktree: result.source_worktree || null,
          target_branch: result.target_branch,
        }, { worktree: result.source_worktree || null }).catch(() => {});

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(`${chalk.green('✓')} Queued ${chalk.cyan(result.id)} for ${chalk.bold(result.target_branch)}`);
        console.log(`  ${chalk.dim('source:')} ${result.source_type} ${result.source_ref}`);
        if (result.source_worktree) console.log(`  ${chalk.dim('worktree:')} ${result.source_worktree}`);
        if (payload.eventDetails?.policy_override_summary) {
          console.log(`  ${chalk.dim('policy override:')} ${payload.eventDetails.policy_override_summary}`);
        }
      } catch (err) {
        db.close();
        printErrorWithNext(err.message, 'switchman queue add --help');
        process.exitCode = 1;
      }
    });

  queueCmd
    .command('list')
    .description('List merge queue items')
    .option('--status <status>', 'Filter by queue status')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const items = listMergeQueue(db, { status: opts.status || null });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }

      if (items.length === 0) {
        console.log(chalk.dim('Merge queue is empty.'));
        return;
      }

      for (const item of items) {
        const retryInfo = chalk.dim(`retries:${item.retry_count}/${item.max_retries}`);
        const attemptInfo = item.last_attempt_at ? ` ${chalk.dim(`last-attempt:${item.last_attempt_at}`)}` : '';
        const backoffInfo = item.backoff_until ? ` ${chalk.dim(`backoff-until:${item.backoff_until}`)}` : '';
        const escalationInfo = item.escalated_at ? ` ${chalk.dim(`escalated:${item.escalated_at}`)}` : '';
        console.log(`  ${statusBadge(item.status)} ${item.id} ${item.source_type}:${item.source_ref} ${chalk.dim(`→ ${item.target_branch}`)} ${retryInfo}${attemptInfo}${backoffInfo}${escalationInfo}`);
        if (item.last_error_summary) {
          console.log(`    ${chalk.red('why:')} ${item.last_error_summary}`);
        }
        if (item.next_action) {
          console.log(`    ${chalk.yellow('next:')} ${item.next_action}`);
        }
      }
    });

  queueCmd
    .command('status')
    .description('Show an operator-friendly merge queue summary')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Plain English:
  Use this when finished branches are waiting to land and you want one safe queue view.

Examples:
  switchman queue status
  switchman queue status --json

What it helps you answer:
  - what lands next
  - what is blocked
  - what command should I run now
`)
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const items = listMergeQueue(db);
      const summary = buildQueueStatusSummary(items, { db, repoRoot });
      const recentEvents = items.slice(0, 5).flatMap((item) =>
        listMergeQueueEvents(db, item.id, { limit: 3 }).map((event) => ({ ...event, queue_item_id: item.id })),
      ).sort((a, b) => b.id - a.id).slice(0, 8);
      db.close();

      if (opts.json) {
        console.log(JSON.stringify({ items, summary, recent_events: recentEvents }, null, 2));
        return;
      }

      if (items.length === 0) {
        console.log('');
        console.log(chalk.bold('switchman queue status'));
        console.log('');
        console.log('Queue is empty.');
        console.log(`Add finished work with: ${chalk.cyan('switchman queue add --worktree agent1')}`);
        return;
      }

      const queueHealth = summary.counts.blocked > 0
        ? 'block'
        : summary.counts.retrying > 0 || summary.counts.held > 0 || summary.counts.wave_blocked > 0 || summary.counts.escalated > 0
          ? 'warn'
          : 'healthy';
      const queueHealthColor = colorForHealth(queueHealth);
      const retryingItems = items.filter((item) => item.status === 'retrying');
      const focus = summary.blocked[0] || retryingItems[0] || summary.next || null;
      const focusLine = focus
        ? `${focus.id} ${focus.source_type}:${focus.source_ref}${focus.last_error_summary ? ` ${chalk.dim(`• ${focus.last_error_summary}`)}` : ''}`
        : 'Nothing waiting. Landing queue is clear.';

      console.log('');
      console.log(queueHealthColor('='.repeat(72)));
      console.log(`${queueHealthColor(healthLabel(queueHealth))} ${chalk.bold('switchman queue status')} ${chalk.dim('• landing mission control')}`);
      console.log(queueHealthColor('='.repeat(72)));
      console.log(renderSignalStrip([
        renderChip('queued', summary.counts.queued, summary.counts.queued > 0 ? chalk.yellow : chalk.green),
        renderChip('retrying', summary.counts.retrying, summary.counts.retrying > 0 ? chalk.yellow : chalk.green),
        renderChip('held', summary.counts.held, summary.counts.held > 0 ? chalk.yellow : chalk.green),
        renderChip('wave blocked', summary.counts.wave_blocked, summary.counts.wave_blocked > 0 ? chalk.yellow : chalk.green),
        renderChip('escalated', summary.counts.escalated, summary.counts.escalated > 0 ? chalk.red : chalk.green),
        renderChip('blocked', summary.counts.blocked, summary.counts.blocked > 0 ? chalk.red : chalk.green),
        renderChip('merging', summary.counts.merging, summary.counts.merging > 0 ? chalk.blue : chalk.green),
        renderChip('merged', summary.counts.merged, summary.counts.merged > 0 ? chalk.green : chalk.white),
      ]));
      console.log(renderMetricRow([
        { label: 'items', value: items.length, color: chalk.white },
        { label: 'validating', value: summary.counts.validating, color: chalk.blue },
        { label: 'rebasing', value: summary.counts.rebasing, color: chalk.blue },
        { label: 'target', value: summary.next?.target_branch || 'main', color: chalk.cyan },
      ]));
      console.log(`${chalk.bold('Focus now:')} ${focusLine}`);

      const queueFocusLines = summary.next
        ? [
          `${renderChip(summary.next.recommendation?.action === 'retry' ? 'RETRY' : summary.next.recommendation?.action === 'escalate' ? 'ESCALATE' : 'NEXT', summary.next.id, summary.next.recommendation?.action === 'retry' ? chalk.yellow : summary.next.recommendation?.action === 'escalate' ? chalk.red : chalk.green)} ${summary.next.source_type}:${summary.next.source_ref} ${chalk.dim(`retries:${summary.next.retry_count}/${summary.next.max_retries}`)}${summary.next.queue_assessment?.goal_priority ? ` ${chalk.dim(`priority:${summary.next.queue_assessment.goal_priority}`)}` : ''}${summary.next.queue_assessment?.integration_risk && summary.next.queue_assessment.integration_risk !== 'normal' ? ` ${chalk.dim(`risk:${summary.next.queue_assessment.integration_risk}`)}` : ''}${summary.next.queue_assessment?.freshness ? ` ${chalk.dim(`freshness:${summary.next.queue_assessment.freshness}`)}` : ''}${summary.next.queue_assessment?.stale_invalidation_count ? ` ${chalk.dim(`stale:${summary.next.queue_assessment.stale_invalidation_count}`)}` : ''}`,
          ...(summary.next.queue_assessment?.reason ? [`  ${chalk.dim('why next:')} ${summary.next.queue_assessment.reason}`] : []),
          ...(summary.next.recommendation?.summary ? [`  ${chalk.dim('decision:')} ${summary.next.recommendation.summary}`] : []),
          `  ${chalk.yellow('run:')} ${summary.next.recommendation?.command || 'switchman queue run'}`,
        ]
        : [chalk.dim('No queued landing work right now.')];

      const queueHeldBackLines = summary.held_back.length > 0
        ? summary.held_back.flatMap((item) => {
          const lines = [`${renderChip(item.recommendation?.action === 'escalate' ? 'ESCALATE' : 'HOLD', item.id, item.recommendation?.action === 'escalate' ? chalk.red : chalk.yellow)} ${item.source_type}:${item.source_ref}${item.queue_assessment?.goal_priority ? ` ${chalk.dim(`priority:${item.queue_assessment.goal_priority}`)}` : ''} ${chalk.dim(`freshness:${item.queue_assessment?.freshness || 'unknown'}`)}${item.queue_assessment?.integration_risk && item.queue_assessment.integration_risk !== 'normal' ? ` ${chalk.dim(`risk:${item.queue_assessment.integration_risk}`)}` : ''}${item.queue_assessment?.stale_invalidation_count ? ` ${chalk.dim(`stale:${item.queue_assessment.stale_invalidation_count}`)}` : ''}`];
          if (item.queue_assessment?.reason) lines.push(`  ${chalk.dim('why later:')} ${item.queue_assessment.reason}`);
          if (item.recommendation?.summary) lines.push(`  ${chalk.dim('decision:')} ${item.recommendation.summary}`);
          if (item.queue_assessment?.next_action) lines.push(`  ${chalk.yellow('next:')} ${item.queue_assessment.next_action}`);
          return lines;
        })
        : [chalk.green('Nothing significant is being held back.')];

      const queueBlockedLines = summary.blocked.length > 0
        ? summary.blocked.slice(0, 4).flatMap((item) => {
          const lines = [`${renderChip('BLOCKED', item.id, chalk.red)} ${item.source_type}:${item.source_ref} ${chalk.dim(`retries:${item.retry_count}/${item.max_retries}`)}`];
          if (item.last_error_summary) lines.push(`  ${chalk.red('why:')} ${item.last_error_summary}`);
          if (item.next_action) lines.push(`  ${chalk.yellow('next:')} ${item.next_action}`);
          return lines;
        })
        : [chalk.green('Nothing blocked.')];

      const queueWatchLines = items.filter((item) => ['retrying', 'held', 'wave_blocked', 'escalated', 'merging', 'rebasing', 'validating'].includes(item.status)).length > 0
        ? items
          .filter((item) => ['retrying', 'held', 'wave_blocked', 'escalated', 'merging', 'rebasing', 'validating'].includes(item.status))
          .slice(0, 4)
          .flatMap((item) => {
            const lines = [`${renderChip(item.status.toUpperCase(), item.id, item.status === 'retrying' || item.status === 'held' || item.status === 'wave_blocked' ? chalk.yellow : item.status === 'escalated' ? chalk.red : chalk.blue)} ${item.source_type}:${item.source_ref}`];
            if (item.last_error_summary) lines.push(`  ${chalk.dim(item.last_error_summary)}`);
            if (item.next_action) lines.push(`  ${chalk.yellow('next:')} ${item.next_action}`);
            return lines;
          })
        : [chalk.green('No in-flight queue items right now.')];

      const queueCommandLines = [
        `${chalk.cyan('$')} switchman queue run`,
        `${chalk.cyan('$')} switchman queue status --json`,
        ...(summary.blocked[0] ? [`${chalk.cyan('$')} switchman queue retry ${summary.blocked[0].id}`] : []),
      ];

      const queuePlanLines = [
        ...(summary.plan?.land_now?.slice(0, 2).map((item) => `${renderChip('LAND NOW', item.item_id, chalk.green)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
        ...(summary.plan?.prepare_next?.slice(0, 2).map((item) => `${renderChip('PREP NEXT', item.item_id, chalk.cyan)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
        ...(summary.plan?.unblock_first?.slice(0, 2).map((item) => `${renderChip('UNBLOCK', item.item_id, chalk.yellow)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
        ...(summary.plan?.escalate?.slice(0, 2).map((item) => `${renderChip('ESCALATE', item.item_id, chalk.red)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
        ...(summary.plan?.defer?.slice(0, 2).map((item) => `${renderChip('DEFER', item.item_id, chalk.white)} ${item.source_type}:${item.source_ref} ${chalk.dim(item.summary)}`) || []),
      ];
      const queueSequenceLines = summary.recommended_sequence?.length > 0
        ? summary.recommended_sequence.map((item) => `${chalk.bold(`${item.stage}.`)} ${item.source_type}:${item.source_ref} ${chalk.dim(`[${item.lane}]`)} ${item.summary}`)
        : [chalk.green('No recommended sequence beyond the current landing focus.')];

      console.log('');
      for (const block of [
        renderPanel('Landing focus', queueFocusLines, chalk.green),
        renderPanel('Recommended sequence', queueSequenceLines, summary.recommended_sequence?.length > 0 ? chalk.cyan : chalk.green),
        renderPanel('Queue plan', queuePlanLines.length > 0 ? queuePlanLines : [chalk.green('Nothing else needs planning right now.')], queuePlanLines.length > 0 ? chalk.cyan : chalk.green),
        renderPanel('Held back', queueHeldBackLines, summary.held_back.length > 0 ? chalk.yellow : chalk.green),
        renderPanel('Blocked', queueBlockedLines, summary.counts.blocked > 0 ? chalk.red : chalk.green),
        renderPanel('In flight', queueWatchLines, queueWatchLines[0] === 'No in-flight queue items right now.' ? chalk.green : chalk.blue),
        renderPanel('Next commands', queueCommandLines, chalk.cyan),
      ]) {
        for (const line of block) console.log(line);
        console.log('');
      }

      if (recentEvents.length > 0) {
        console.log(chalk.bold('Recent Queue Events:'));
        for (const event of recentEvents) {
          console.log(`  ${chalk.cyan(event.queue_item_id)} ${chalk.dim(event.event_type)} ${chalk.dim(event.status || '')} ${chalk.dim(event.created_at)}`.trim());
        }
      }
    });

  queueCmd
    .command('retry <itemId>')
    .description('Retry a blocked merge queue item')
    .option('--json', 'Output raw JSON')
    .action((itemId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const item = retryMergeQueueItem(db, itemId);
      db.close();

      if (!item) {
        printErrorWithNext(`Queue item ${itemId} is not retryable.`, 'switchman queue status');
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(item, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Queue item ${chalk.cyan(item.id)} reset to retrying`);
    });

  queueCmd
    .command('escalate <itemId>')
    .description('Mark a queue item as needing explicit operator review before landing')
    .option('--reason <text>', 'Why this item is being escalated')
    .option('--json', 'Output raw JSON')
    .action((itemId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const item = escalateMergeQueueItem(db, itemId, {
        summary: opts.reason || null,
        nextAction: `Run \`switchman explain queue ${itemId}\` to review the landing risk, then \`switchman queue retry ${itemId}\` when it is ready again.`,
      });
      db.close();

      if (!item) {
        printErrorWithNext(`Queue item ${itemId} cannot be escalated.`, 'switchman queue status');
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(item, null, 2));
        return;
      }

      console.log(`${chalk.yellow('!')} Queue item ${chalk.cyan(item.id)} marked escalated for operator review`);
      if (item.last_error_summary) {
        console.log(`  ${chalk.red('why:')} ${item.last_error_summary}`);
      }
      if (item.next_action) {
        console.log(`  ${chalk.yellow('next:')} ${item.next_action}`);
      }
    });

  queueCmd
    .command('remove <itemId>')
    .description('Remove a merge queue item')
    .action((itemId) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const item = removeMergeQueueItem(db, itemId);
      db.close();

      if (!item) {
        printErrorWithNext(`Queue item ${itemId} does not exist.`, 'switchman queue status');
        process.exitCode = 1;
        return;
      }

      console.log(`${chalk.green('✓')} Removed ${chalk.cyan(item.id)} from the merge queue`);
    });

  queueCmd
    .command('run')
    .description('Process landing-queue items one at a time')
    .option('--max-items <n>', 'Maximum queue items to process', '1')
    .option('--follow-plan', 'Only run queue items that are currently in the land_now lane')
    .option('--merge-budget <n>', 'Maximum successful merges to allow in this run')
    .option('--target <branch>', 'Default target branch', 'main')
    .option('--watch', 'Keep polling for new queue items')
    .option('--watch-interval-ms <n>', 'Polling interval for --watch mode', '1000')
    .option('--max-cycles <n>', 'Maximum watch cycles before exiting (mainly for tests)')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Examples:
  switchman queue run
  switchman queue run --follow-plan --merge-budget 2
  switchman queue run --watch
  switchman queue run --watch --watch-interval-ms 1000
`)
    .action(async (opts) => {
      const repoRoot = getRepo();

      try {
        const watch = Boolean(opts.watch);
        const followPlan = Boolean(opts.followPlan);
        const watchIntervalMs = Math.max(0, Number.parseInt(opts.watchIntervalMs, 10) || 1000);
        const maxCycles = opts.maxCycles ? Math.max(1, Number.parseInt(opts.maxCycles, 10) || 1) : null;
        const mergeBudget = opts.mergeBudget !== undefined
          ? Math.max(0, Number.parseInt(opts.mergeBudget, 10) || 0)
          : null;
        const aggregate = {
          processed: [],
          cycles: 0,
          watch,
          execution_policy: {
            follow_plan: followPlan,
            merge_budget: mergeBudget,
            merged_count: 0,
          },
        };

        while (true) {
          const db = getDb(repoRoot);
          const result = await runMergeQueue(db, repoRoot, {
            maxItems: Number.parseInt(opts.maxItems, 10) || 1,
            targetBranch: opts.target || 'main',
            followPlan,
            mergeBudget,
          });
          db.close();

          aggregate.processed.push(...result.processed);
          aggregate.summary = result.summary;
          aggregate.deferred = result.deferred || aggregate.deferred || null;
          aggregate.execution_policy = result.execution_policy || aggregate.execution_policy;
          aggregate.cycles += 1;

          if (!watch) break;
          if (maxCycles && aggregate.cycles >= maxCycles) break;
          if (mergeBudget !== null && aggregate.execution_policy.merged_count >= mergeBudget) break;
          if (result.processed.length === 0) {
            sleepSync(watchIntervalMs);
          }
        }

        if (opts.json) {
          console.log(JSON.stringify(aggregate, null, 2));
          return;
        }

        if (aggregate.processed.length === 0) {
          const deferredFocus = aggregate.deferred || aggregate.summary?.next || null;
          if (deferredFocus?.recommendation?.action) {
            console.log(chalk.yellow('No landing candidate is ready to run right now.'));
            console.log(`  ${chalk.dim('focus:')} ${deferredFocus.id} ${deferredFocus.source_type}:${deferredFocus.source_ref}`);
            if (followPlan) {
              console.log(`  ${chalk.dim('policy:')} following the queue plan, so only land_now items will run automatically`);
            }
            if (deferredFocus.recommendation?.summary) {
              console.log(`  ${chalk.dim('decision:')} ${deferredFocus.recommendation.summary}`);
            }
            if (deferredFocus.recommendation?.command) {
              console.log(`  ${chalk.yellow('next:')} ${deferredFocus.recommendation.command}`);
            }
          } else {
            console.log(chalk.dim('No queued merge items.'));
          }
          await maybeCaptureTelemetry('queue_used', {
            watch,
            cycles: aggregate.cycles,
            processed_count: 0,
            merged_count: 0,
            blocked_count: 0,
          });
          return;
        }

        for (const entry of aggregate.processed) {
          const item = entry.item;
          if (entry.status === 'merged') {
            pushSyncEvent('queue_merged', {
              item_id: item.id,
              source_type: item.source_type,
              source_ref: item.source_ref,
              source_worktree: item.source_worktree || null,
              target_branch: item.target_branch,
              merged_commit: item.merged_commit || null,
            }, { worktree: item.source_worktree || null }).catch(() => {});
            console.log(`${chalk.green('✓')} Merged ${chalk.cyan(item.id)} into ${chalk.bold(item.target_branch)}`);
            console.log(`  ${chalk.dim('commit:')} ${item.merged_commit}`);
          } else {
            pushSyncEvent('queue_blocked', {
              item_id: item.id,
              source_type: item.source_type,
              source_ref: item.source_ref,
              source_worktree: item.source_worktree || null,
              target_branch: item.target_branch,
              error_code: item.last_error_code || null,
              error_summary: item.last_error_summary || null,
            }, { worktree: item.source_worktree || null }).catch(() => {});
            console.log(`${chalk.red('✗')} Blocked ${chalk.cyan(item.id)}`);
            console.log(`  ${chalk.red('why:')} ${item.last_error_summary}`);
            if (item.next_action) console.log(`  ${chalk.yellow('next:')} ${item.next_action}`);
          }
        }

        if (aggregate.execution_policy.follow_plan) {
          console.log(`${chalk.dim('plan-aware run:')} merged ${aggregate.execution_policy.merged_count}${aggregate.execution_policy.merge_budget !== null ? ` of ${aggregate.execution_policy.merge_budget}` : ''} budgeted item(s)`);
        }

        await maybeCaptureTelemetry('queue_used', {
          watch,
          cycles: aggregate.cycles,
          processed_count: aggregate.processed.length,
          merged_count: aggregate.processed.filter((entry) => entry.status === 'merged').length,
          blocked_count: aggregate.processed.filter((entry) => entry.status !== 'merged').length,
        });
      } catch (err) {
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  return queueCmd;
}
