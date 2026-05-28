import { existsSync } from 'fs';

import {
  getAuditSummary,
  getGuardAuditPath,
  getGuardConfigPath,
  guardConfigExists,
  readAuditEntries,
  removeGuardConfig,
  writeDefaultGuardConfig,
} from '../../guard/index.js';

function formatGuardResult(entry) {
  if (entry.result === 'blocked') return 'blocked';
  if (entry.result === 'anomaly') return 'anomaly';
  return 'success';
}

export function registerGuardCommands(program, {
  chalk,
  getRepo,
}) {
  const guardCmd = program.command('guard').description('Control Guard MCP scope checks and audit logging');

  guardCmd
    .command('enable')
    .description('Enable Guard by writing the default guard config')
    .action(() => {
      const repoRoot = getRepo();
      const configPath = writeDefaultGuardConfig(repoRoot);
      console.log(`${chalk.green('✓')} Guard enabled`);
      console.log(`  ${chalk.dim(configPath)}`);
    });

  guardCmd
    .command('disable')
    .description('Disable Guard by removing the guard config')
    .action(() => {
      const repoRoot = getRepo();
      const configPath = removeGuardConfig(repoRoot);
      console.log(`${chalk.green('✓')} Guard disabled`);
      console.log(`  ${chalk.dim(configPath)}`);
    });

  guardCmd
    .command('status')
    .description('Show Guard state and audit counts')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const configPath = getGuardConfigPath(repoRoot);
      const auditPath = getGuardAuditPath(repoRoot);
      const enabled = guardConfigExists(repoRoot);
      const summary = getAuditSummary(repoRoot);
      const payload = {
        enabled,
        config_path: configPath,
        audit_log_path: auditPath,
        total_calls_logged: summary.total_calls,
        blocked_calls: summary.blocked_calls,
        anomalies_detected: summary.anomalies,
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(`Guard: ${enabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
      console.log(`Config: ${existsSync(configPath) ? chalk.dim(configPath) : chalk.dim('not installed')}`);
      console.log(`Audit log: ${existsSync(auditPath) ? chalk.dim(auditPath) : chalk.dim('not created yet')}`);
      console.log(`Calls logged: ${chalk.cyan(payload.total_calls_logged)}`);
      console.log(`Blocked calls: ${payload.blocked_calls ? chalk.red(payload.blocked_calls) : chalk.green('0')}`);
      console.log(`Anomalies: ${payload.anomalies_detected ? chalk.yellow(payload.anomalies_detected) : chalk.green('0')}`);
    });

  guardCmd
    .command('logs')
    .description('Show Guard audit log entries')
    .option('--json', 'Output raw JSON log entries')
    .option('-n, --lines <count>', 'Number of log entries to show', '50')
    .action((opts) => {
      const repoRoot = getRepo();
      const count = Math.max(1, Number.parseInt(opts.lines, 10) || 50);
      const entries = readAuditEntries(repoRoot).slice(-count);

      if (opts.json) {
        for (const entry of entries) {
          console.log(JSON.stringify(entry));
        }
        return;
      }

      if (entries.length === 0) {
        console.log(chalk.dim('No Guard audit entries yet.'));
        return;
      }

      for (const entry of entries) {
        const result = formatGuardResult(entry);
        const color = result === 'blocked' ? chalk.red : result === 'anomaly' ? chalk.yellow : chalk.green;
        console.log(`${chalk.dim(entry.timestamp)} ${color(result)} ${chalk.cyan(entry.tool)} ${chalk.dim(`agent=${entry.agentId || 'unknown'}`)} ${chalk.dim(`task=${entry.taskId || '-'}`)}`);
        if (entry.reason) {
          console.log(`  ${chalk.dim(entry.reason)}`);
        }
      }
    });

  return guardCmd;
}
