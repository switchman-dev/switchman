export function registerAuditCommands(program, {
  buildPipelineHistoryReport,
  chalk,
  getDb,
  getRepo,
  printErrorWithNext,
  statusBadge,
  verifyAuditTrail,
}) {
  const auditCmd = program.command('audit').description('Inspect and verify the tamper-evident audit trail');
  auditCmd._switchmanAdvanced = true;

  auditCmd
    .command('change <pipelineId>')
    .description('Show a signed, operator-friendly history for one pipeline')
    .option('--json', 'Output raw JSON')
    .action((pipelineId, options) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);

      try {
        const report = buildPipelineHistoryReport(db, repoRoot, pipelineId);
        db.close();

        if (options.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        console.log(chalk.bold(`Audit history for pipeline ${report.pipeline_id}`));
        console.log(`  ${chalk.dim('title:')} ${report.title}`);
        console.log(`  ${chalk.dim('events:')} ${report.events.length}`);
        console.log(`  ${chalk.yellow('next:')} ${report.next_action}`);
        for (const event of report.events.slice(-20)) {
          const status = event.status ? ` ${statusBadge(event.status).trim()}` : '';
          console.log(`  ${chalk.dim(event.created_at)} ${chalk.cyan(event.label)}${status}`);
          console.log(`    ${event.summary}`);
        }
      } catch (err) {
        db.close();
        printErrorWithNext(err.message, `switchman pipeline status ${pipelineId}`);
        process.exitCode = 1;
      }
    });

  auditCmd
    .command('verify')
    .description('Verify the audit log hash chain and project signatures')
    .option('--json', 'Output verification details as JSON')
    .action((options) => {
      const repo = getRepo();
      const db = getDb(repo);
      const result = verifyAuditTrail(db);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 1);
      }

      if (result.ok) {
        console.log(chalk.green(`Audit trail verified: ${result.count} signed events in order.`));
        return;
      }

      console.log(chalk.red(`Audit trail verification failed: ${result.failures.length} problem(s) across ${result.count} events.`));
      for (const failure of result.failures.slice(0, 10)) {
        const prefix = failure.sequence ? `#${failure.sequence}` : `event ${failure.id}`;
        console.log(`  ${chalk.red(prefix)} ${failure.reason_code}: ${failure.message}`);
      }
      if (result.failures.length > 10) {
        console.log(chalk.dim(`  ...and ${result.failures.length - 10} more`));
      }
      process.exit(1);
    });

  return auditCmd;
}
