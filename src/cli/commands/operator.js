export function registerOperatorCommands(program, deps) {
  const {
    buildSessionSummary,
    buildDoctorReport,
    buildRecoverReport,
    chalk,
    collectStatusSnapshot,
    colorForHealth,
    formatClockTime,
    getDb,
    getRepo,
    getStaleLeases,
    healthLabel,
    humanizeReasonCode,
    listLeases,
    listTasks,
    maybeCaptureTelemetry,
    printErrorWithNext,
    printRecoverSummary,
    printRepairSummary,
    pullActiveTeamMembers,
    pullTeamState,
    readCredentials,
    renderChip,
    renderMetricRow,
    renderPanel,
    renderSignalStrip,
    renderUnifiedStatusReport,
    repairRepoState,
    runAiMergeGate,
    scanAllWorktrees,
    sleepSync,
    statusBadge,
    summarizeTeamCoordinationState,
    buildWatchSignature,
  } = deps;

  program
    .command('session-summary')
    .description('Show what Switchman prevented, recovered, and landed in this recent session')
    .option('--hours <n>', 'How many recent hours to summarize', '8')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Examples:
  switchman session-summary
  switchman session-summary --hours 24
  switchman session-summary --json
`)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const report = await buildSessionSummary(repoRoot, {
        hours: Math.max(1, Number.parseInt(opts.hours, 10) || 8),
      });

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log('');
      console.log(chalk.bold('Session summary'));
      console.log(chalk.dim(`Last ${report.hours} hour(s)`));
      console.log(`  ${chalk.green('✓')} ${report.metrics.rogue_writes_blocked} rogue write${report.metrics.rogue_writes_blocked === 1 ? '' : 's'} blocked`);
      console.log(`  ${chalk.green('✓')} ${report.metrics.retries_scheduled} retry / recovery handoff${report.metrics.retries_scheduled === 1 ? '' : 's'} recorded`);
      console.log(`  ${chalk.green('✓')} ${report.metrics.queue_blocks_avoided} risky landing issue${report.metrics.queue_blocks_avoided === 1 ? '' : 's'} caught`);
      console.log(`  ${chalk.green('✓')} ${report.metrics.queue_merges_completed} safe merge${report.metrics.queue_merges_completed === 1 ? '' : 's'} completed`);
      if (report.estimated_minutes_saved > 0) {
        console.log('');
        console.log(chalk.dim(`Estimated coordination time saved: ~${report.estimated_minutes_saved} minute${report.estimated_minutes_saved === 1 ? '' : 's'}`));
      }
      if (report.upgrade_cta) {
        console.log('');
        console.log(chalk.yellow(report.upgrade_cta.title));
        console.log(`  ${chalk.dim(report.upgrade_cta.detail)}`);
        console.log(`  ${chalk.cyan(report.upgrade_cta.command)}`);
      }
      console.log('');
    });

  program
    .command('scan')
    .description('Scan all workspaces for conflicts')
    .option('--json', 'Output raw JSON')
    .option('--quiet', 'Only show conflicts')
    .addHelpText('after', `
Examples:
  switchman scan
  switchman scan --quiet
  switchman scan --json
`)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const { default: ora } = await import('ora');
      const spinner = ora('Scanning workspaces for conflicts...').start();

      try {
        const report = await scanAllWorktrees(db, repoRoot);
        db.close();
        spinner.stop();

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        console.log('');
        console.log(chalk.bold('Conflict Scan Report'));
        console.log(chalk.dim(`${report.scannedAt}`));
        console.log('');

        if (!opts.quiet) {
          console.log(chalk.bold('Worktrees:'));
          for (const wt of report.worktrees) {
            const files = report.fileMap?.[wt.name] || [];
            const compliance = report.worktreeCompliance?.find((entry) => entry.worktree === wt.name)?.compliance_state || wt.compliance_state || 'observed';
            console.log(`  ${chalk.cyan(wt.name.padEnd(20))} ${statusBadge(compliance)} branch: ${(wt.branch || 'unknown').padEnd(30)} ${chalk.dim(`${files.length} changed file(s)`)}`);
          }
          console.log('');
        }

        if (report.fileConflicts.length > 0) {
          console.log(chalk.yellow('⚠ Files being edited in multiple worktrees (uncommitted):'));
          for (const fc of report.fileConflicts) {
            console.log(`  ${chalk.yellow(fc.file)}`);
            console.log(`    ${chalk.dim('edited in:')} ${fc.worktrees.join(', ')}`);
          }
          console.log('');
        }

        if ((report.ownershipConflicts?.length || 0) > 0) {
          console.log(chalk.yellow('⚠ Ownership boundary overlaps detected:'));
          for (const conflict of report.ownershipConflicts) {
            if (conflict.type === 'subsystem_overlap') {
              console.log(`  ${chalk.yellow(`subsystem:${conflict.subsystemTag}`)}`);
              console.log(`    ${chalk.dim('reserved by:')} ${conflict.worktreeA}, ${conflict.worktreeB}`);
            } else {
              console.log(`  ${chalk.yellow(conflict.scopeA)}`);
              console.log(`    ${chalk.dim('overlaps with:')} ${conflict.scopeB}`);
              console.log(`    ${chalk.dim('reserved by:')} ${conflict.worktreeA}, ${conflict.worktreeB}`);
            }
          }
          console.log('');
        }

        if ((report.semanticConflicts?.length || 0) > 0) {
          console.log(chalk.yellow('⚠ Semantic overlaps detected:'));
          for (const conflict of report.semanticConflicts) {
            console.log(`  ${chalk.yellow(conflict.object_name)}`);
            console.log(`    ${chalk.dim('changed by:')} ${conflict.worktreeA}, ${conflict.worktreeB}`);
            console.log(`    ${chalk.dim('files:')} ${conflict.fileA} ↔ ${conflict.fileB}`);
          }
          console.log('');
        }

        if (report.conflicts.length > 0) {
          console.log(chalk.red('✗ Branch conflicts detected:'));
          for (const c of report.conflicts) {
            const icon = c.type === 'merge_conflict' ? chalk.red('MERGE CONFLICT') : chalk.yellow('FILE OVERLAP');
            console.log(`  ${icon}`);
            console.log(`    ${chalk.cyan(c.worktreeA)} (${c.branchA}) ↔ ${chalk.cyan(c.worktreeB)} (${c.branchB})`);
            if (c.conflictingFiles.length) {
              console.log('    Conflicting files:');
              c.conflictingFiles.forEach((f) => console.log(`      ${chalk.yellow(f)}`));
            }
          }
          console.log('');
        }

        if (report.unclaimedChanges.length > 0) {
          console.log(chalk.red('✗ Unclaimed or unmanaged changed files detected:'));
          for (const entry of report.unclaimedChanges) {
            console.log(`  ${chalk.cyan(entry.worktree)} ${chalk.dim(entry.lease_id || 'no active lease')}`);
            entry.files.forEach((file) => {
              const reason = entry.reasons.find((item) => item.file === file)?.reason_code || 'path_not_claimed';
              const nextStep = deps.nextStepForReason(reason);
              console.log(`    ${chalk.yellow(file)} ${chalk.dim(humanizeReasonCode(reason))}${nextStep ? ` ${chalk.dim(`— ${nextStep}`)}` : ''}`);
            });
          }
          console.log('');
        }

        if (report.conflicts.length === 0
          && report.fileConflicts.length === 0
          && (report.ownershipConflicts?.length || 0) === 0
          && (report.semanticConflicts?.length || 0) === 0
          && report.unclaimedChanges.length === 0) {
          console.log(chalk.green(`✓ No conflicts detected across ${report.worktrees.length} workspace(s)`));
        }
      } catch (err) {
        spinner.fail(err.message);
        db.close();
        process.exit(1);
      }
    });

  program
    .command('status')
    .description('Show one dashboard view of what is running, blocked, and ready next')
    .option('--json', 'Output raw JSON')
    .option('--watch', 'Keep refreshing status in the terminal')
    .option('--repair', 'Repair safe interrupted queue and pipeline state before rendering status')
    .option('--watch-interval-ms <n>', 'Polling interval for --watch mode', '2000')
    .option('--max-cycles <n>', 'Maximum refresh cycles before exiting', '0')
    .addHelpText('after', `
Examples:
  switchman status
  switchman status --watch
  switchman status --repair
  switchman status --json

Use this first when the repo feels stuck.
`)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const watch = Boolean(opts.watch);
      const watchIntervalMs = Math.max(100, Number.parseInt(opts.watchIntervalMs, 10) || 2000);
      const maxCycles = Math.max(0, Number.parseInt(opts.maxCycles, 10) || 0);
      let cycles = 0;
      let lastSignature = null;

      while (true) {
        if (watch && process.stdout.isTTY && !opts.json) {
          console.clear();
        }

        let repairResult = null;
        if (opts.repair) {
          const repairDb = getDb(repoRoot);
          try {
            repairResult = repairRepoState(repairDb, repoRoot);
          } finally {
            repairDb.close();
          }
        }

        const report = await collectStatusSnapshot(repoRoot);
        const [teamActivity, teamState] = await Promise.all([
          pullActiveTeamMembers(),
          pullTeamState(),
        ]);
        const myUserId = readCredentials()?.user_id;
        const otherMembers = teamActivity.filter((e) => e.user_id !== myUserId);
        const teamSummary = summarizeTeamCoordinationState(teamState, myUserId);
        cycles += 1;

        if (opts.json) {
          const payload = watch ? { ...report, watch: true, cycles } : report;
          const withTeam = {
            ...payload,
            team_sync: {
              summary: teamSummary,
              recent_events: teamState.filter((event) => event.user_id !== myUserId).slice(0, 25),
              pending_buffer: report.sync_state || null,
            },
          };
          console.log(JSON.stringify(opts.repair ? { ...withTeam, repair: repairResult } : withTeam, null, 2));
        } else {
          if (opts.repair && repairResult) {
            printRepairSummary(repairResult, {
              repairedHeading: `${chalk.green('✓')} Repaired safe interrupted repo state before rendering status`,
              noRepairHeading: `${chalk.green('✓')} No repo repair action needed before rendering status`,
              limit: 6,
            });
            console.log('');
          }
          renderUnifiedStatusReport(report, { teamActivity: otherMembers, teamSummary });
          if (watch) {
            const signature = buildWatchSignature(report);
            const watchState = lastSignature === null
              ? chalk.cyan('baseline snapshot')
              : signature === lastSignature
                ? chalk.dim('no repo changes since last refresh')
                : chalk.green('change detected');
            const updatedAt = formatClockTime(report.generated_at);
            lastSignature = signature;
            console.log('');
            console.log(chalk.dim(`Live watch • updated ${updatedAt || 'just now'} • ${watchState}${maxCycles > 0 ? ` • cycle ${cycles}/${maxCycles}` : ''} • refresh ${watchIntervalMs}ms`));
          }
        }

        if (!watch) break;
        if (maxCycles > 0 && cycles >= maxCycles) break;
        if (opts.json) break;
        sleepSync(watchIntervalMs);
      }

      if (watch) {
        await maybeCaptureTelemetry('status_watch_used', {
          cycles,
          interval_ms: watchIntervalMs,
        });
      }
    });

  program
    .command('recover')
    .description('Recover abandoned agent work, repair safe interrupted state, and point at the right checkpoint')
    .option('--stale-after-minutes <minutes>', 'Age threshold for stale lease recovery')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Examples:
  switchman recover
  switchman recover --stale-after-minutes 20
  switchman recover --json

Use this when an agent crashed, a worktree was abandoned mid-task, or the repo feels stuck after interrupted work.
`)
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const report = buildRecoverReport(db, repoRoot, {
          staleAfterMinutes: opts.staleAfterMinutes || null,
        });
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        printRecoverSummary(report);
      } catch (err) {
        db.close();
        printErrorWithNext(err.message, 'switchman status');
        process.exitCode = 1;
      }
    });

  program
    .command('repair')
    .description('Repair safe interrupted queue and pipeline state across the repo')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const result = repairRepoState(db, repoRoot);
        db.close();

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        printRepairSummary(result, {
          repairedHeading: `${chalk.green('✓')} Repaired safe interrupted repo state`,
          noRepairHeading: `${chalk.green('✓')} No repo repair action needed`,
        });
        console.log(`  ${chalk.yellow('next:')} ${result.next_action}`);
      } catch (err) {
        db.close();
        console.error(chalk.red(err.message));
        process.exitCode = 1;
      }
    });

  const doctorCmd = program
    .command('doctor')
    .description('Show one operator-focused health view: what is running, what is blocked, and what to do next');
  doctorCmd._switchmanAdvanced = true;
  doctorCmd
    .option('--repair', 'Repair safe interrupted queue and pipeline state before reporting health')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Plain English:
  Use this when the repo feels risky, noisy, or stuck and you want the health summary plus exact next moves.

Examples:
  switchman doctor
  switchman doctor --json
`)
    .action(async (opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const repairResult = opts.repair ? repairRepoState(db, repoRoot) : null;
      const tasks = listTasks(db);
      const activeLeases = listLeases(db, 'active');
      const staleLeases = getStaleLeases(db);
      const scanReport = await scanAllWorktrees(db, repoRoot);
      const aiGate = await runAiMergeGate(db, repoRoot);
      const report = buildDoctorReport({
        db,
        repoRoot,
        tasks,
        activeLeases,
        staleLeases,
        scanReport,
        aiGate,
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify(opts.repair ? { ...report, repair: repairResult } : report, null, 2));
        return;
      }

      if (opts.repair) {
        printRepairSummary(repairResult, {
          repairedHeading: `${chalk.green('✓')} Repaired safe interrupted repo state before running doctor`,
          noRepairHeading: `${chalk.green('✓')} No repo repair action needed before doctor`,
          limit: 6,
        });
        console.log('');
      }

      const doctorColor = colorForHealth(report.health);
      const blockedCount = report.attention.filter((item) => item.severity === 'block').length;
      const warningCount = report.attention.filter((item) => item.severity !== 'block').length;
      const focusItem = report.attention[0] || report.active_work[0] || null;
      const focusLine = focusItem
        ? `${focusItem.title || focusItem.task_title}${focusItem.detail ? ` ${chalk.dim(`• ${focusItem.detail}`)}` : ''}`
        : 'Nothing urgent. Repo health looks steady.';

      console.log('');
      console.log(doctorColor('='.repeat(72)));
      console.log(`${doctorColor(healthLabel(report.health))} ${chalk.bold('switchman doctor')} ${chalk.dim('• repo health mission control')}`);
      console.log(chalk.dim(repoRoot));
      console.log(chalk.dim(report.summary));
      console.log(doctorColor('='.repeat(72)));
      console.log(renderSignalStrip([
        renderChip('blocked', blockedCount, blockedCount > 0 ? chalk.red : chalk.green),
        renderChip('watch', warningCount, warningCount > 0 ? chalk.yellow : chalk.green),
        renderChip('leases', report.counts.active_leases, report.counts.active_leases > 0 ? chalk.blue : chalk.green),
        renderChip('stale', report.counts.stale_leases, report.counts.stale_leases > 0 ? chalk.red : chalk.green),
        renderChip('merge', report.merge_readiness.ci_gate_ok ? 'clear' : 'hold', report.merge_readiness.ci_gate_ok ? chalk.green : chalk.red),
      ]));
      console.log(renderMetricRow([
        { label: 'tasks', value: `${report.counts.pending}/${report.counts.in_progress}/${report.counts.done}/${report.counts.failed}`, color: chalk.white },
        { label: 'AI gate', value: report.merge_readiness.ai_gate_status, color: report.merge_readiness.ai_gate_status === 'blocked' ? chalk.red : report.merge_readiness.ai_gate_status === 'warn' ? chalk.yellow : chalk.green },
      ]));
      console.log(`${chalk.bold('Focus now:')} ${focusLine}`);

      const runningLines = report.active_work.length > 0
        ? report.active_work.slice(0, 5).map((item) => {
          const leaseId = activeLeases.find((lease) => lease.task_id === item.task_id && lease.worktree === item.worktree)?.id || null;
          const boundary = item.boundary_validation
            ? ` ${renderChip('validation', item.boundary_validation.status, item.boundary_validation.status === 'accepted' ? chalk.green : chalk.yellow)}`
            : '';
          const stale = (item.dependency_invalidations?.length || 0) > 0
            ? ` ${renderChip('stale', item.dependency_invalidations.length, chalk.yellow)}`
            : '';
          return `${chalk.cyan(item.worktree)} -> ${item.task_title} ${chalk.dim(item.task_id)}${leaseId ? ` ${chalk.dim(`lease:${leaseId}`)}` : ''}${item.scope_summary ? ` ${chalk.dim(item.scope_summary)}` : ''}${boundary}${stale}`;
        })
        : [chalk.dim('Nothing active right now.')];

      const attentionLines = report.attention.length > 0
        ? report.attention.slice(0, 6).flatMap((item) => {
          const lines = [`${item.severity === 'block' ? renderChip('BLOCKED', item.kind || 'item', chalk.red) : renderChip('WATCH', item.kind || 'item', chalk.yellow)} ${item.title}`];
          if (item.detail) lines.push(`  ${chalk.dim(item.detail)}`);
          lines.push(`  ${chalk.yellow('next:')} ${item.next_step}`);
          if (item.command) lines.push(`  ${chalk.cyan('run:')} ${item.command}`);
          return lines;
        })
        : [chalk.green('Nothing urgent.')];

      const staleClusterLines = report.merge_readiness.stale_clusters?.length > 0
        ? report.merge_readiness.stale_clusters.slice(0, 5).flatMap((cluster) => {
          const lines = [`${cluster.severity === 'block' ? renderChip('STALE', cluster.affected_pipeline_id || cluster.affected_task_ids[0], chalk.red) : renderChip('WATCH', cluster.affected_pipeline_id || cluster.affected_task_ids[0], chalk.yellow)} ${cluster.title}`];
          lines.push(`  ${chalk.dim(cluster.detail)}`);
          if (cluster.causal_group_size > 1) lines.push(`  ${chalk.dim('cause:')} ${cluster.causal_group_summary} ${chalk.dim(`(${cluster.causal_group_rank}/${cluster.causal_group_size} in same stale wave)`)}${cluster.related_affected_pipelines?.length ? ` ${chalk.dim(`related:${cluster.related_affected_pipelines.join(', ')}`)}` : ''}`);
          lines.push(`  ${chalk.dim('areas:')} ${cluster.stale_areas.join(', ')}`);
          lines.push(`  ${chalk.dim('rerun priority:')} ${cluster.rerun_priority} ${chalk.dim(`score:${cluster.rerun_priority_score}`)}${cluster.highest_affected_priority ? ` ${chalk.dim(`affected-priority:${cluster.highest_affected_priority}`)}` : ''}${cluster.rerun_breadth_score ? ` ${chalk.dim(`breadth:${cluster.rerun_breadth_score}`)}` : ''}`);
          lines.push(`  ${chalk.yellow('next:')} ${cluster.next_step}`);
          lines.push(`  ${chalk.cyan('run:')} ${cluster.command}`);
          return lines;
        })
        : [chalk.green('No stale dependency clusters.')];

      const nextStepLines = [
        ...report.next_steps.slice(0, 4).map((step) => `- ${step}`),
        '',
        ...report.suggested_commands.slice(0, 4).map((command) => `${chalk.cyan('$')} ${command}`),
      ];

      console.log('');
      console.log(chalk.bold('Attention now:'));
      for (const block of [
        renderPanel('Running now', runningLines, chalk.cyan),
        renderPanel('Attention now', attentionLines, report.attention.some((item) => item.severity === 'block') ? chalk.red : report.attention.length > 0 ? chalk.yellow : chalk.green),
        renderPanel('Stale clusters', staleClusterLines, report.merge_readiness.stale_clusters?.some((cluster) => cluster.severity === 'block') ? chalk.red : (report.merge_readiness.stale_clusters?.length || 0) > 0 ? chalk.yellow : chalk.green),
        renderPanel('Recommended next steps', nextStepLines, chalk.green),
      ]) {
        for (const line of block) console.log(line);
        console.log('');
      }
    });
}
