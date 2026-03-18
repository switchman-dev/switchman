export function registerPolicyCommands(program, {
  chalk,
  createPolicyOverride,
  DEFAULT_CHANGE_POLICY,
  getChangePolicyPath,
  getDb,
  getRepo,
  listPolicyOverrides,
  loadChangePolicy,
  printErrorWithNext,
  revokePolicyOverride,
  writeChangePolicy,
  writeEnforcementPolicy,
}) {
  const policyCmd = program.command('policy').description('Manage enforcement and change-governance policy');
  policyCmd._switchmanAdvanced = true;

  policyCmd
    .command('init')
    .description('Write a starter enforcement policy file for generated-path exceptions')
    .action(() => {
      const repoRoot = getRepo();
      const policyPath = writeEnforcementPolicy(repoRoot, {
        allowed_generated_paths: [
          'dist/**',
          'build/**',
          'coverage/**',
        ],
      });
      console.log(`${chalk.green('✓')} Wrote enforcement policy to ${chalk.cyan(policyPath)}`);
    });

  policyCmd
    .command('init-change')
    .description('Write a starter change policy file for governed domains like auth, payments, and schema')
    .action(() => {
      const repoRoot = getRepo();
      const policyPath = writeChangePolicy(repoRoot, DEFAULT_CHANGE_POLICY);
      console.log(`${chalk.green('✓')} Wrote change policy to ${chalk.cyan(policyPath)}`);
    });

  policyCmd
    .command('show-change')
    .description('Show the active change policy for this repo')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const repoRoot = getRepo();
      const policy = loadChangePolicy(repoRoot);
      const policyPath = getChangePolicyPath(repoRoot);

      if (opts.json) {
        console.log(JSON.stringify({ path: policyPath, policy }, null, 2));
        return;
      }

      console.log(chalk.bold('Change policy'));
      console.log(`  ${chalk.dim('path:')} ${policyPath}`);
      for (const [domain, rule] of Object.entries(policy.domain_rules || {})) {
        console.log(`  ${chalk.cyan(domain)} ${chalk.dim(rule.enforcement)}`);
        console.log(`    ${chalk.dim('requires:')} ${(rule.required_completed_task_types || []).join(', ') || 'none'}`);
      }
    });

  policyCmd
    .command('override <pipelineId>')
    .description('Record a policy override for one pipeline requirement or task type')
    .requiredOption('--task-types <types>', 'Comma-separated task types to override, e.g. tests,governance')
    .requiredOption('--reason <text>', 'Why this override is being granted')
    .option('--by <actor>', 'Who approved the override', 'operator')
    .option('--json', 'Output raw JSON')
    .action((pipelineId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const taskTypes = String(opts.taskTypes || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (taskTypes.length === 0) {
        db.close();
        printErrorWithNext('At least one task type is required for a policy override.', 'switchman policy override <pipelineId> --task-types tests --reason "why"');
        process.exit(1);
      }

      const override = createPolicyOverride(db, {
        pipelineId,
        taskTypes,
        requirementKeys: taskTypes.map((taskType) => `completed_task_type:${taskType}`),
        reason: opts.reason,
        approvedBy: opts.by || null,
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify({ override }, null, 2));
        return;
      }

      console.log(`${chalk.yellow('!')} Policy override ${chalk.cyan(override.id)} recorded for ${chalk.cyan(pipelineId)}`);
      console.log(`  ${chalk.dim('task types:')} ${taskTypes.join(', ')}`);
      console.log(`  ${chalk.dim('approved by:')} ${opts.by || 'operator'}`);
      console.log(`  ${chalk.dim('reason:')} ${opts.reason}`);
      console.log(`  ${chalk.dim('next:')} switchman pipeline status ${pipelineId}`);
    });

  policyCmd
    .command('revoke <overrideId>')
    .description('Revoke a previously recorded policy override')
    .option('--reason <text>', 'Why the override is being revoked')
    .option('--by <actor>', 'Who revoked the override', 'operator')
    .option('--json', 'Output raw JSON')
    .action((overrideId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const override = revokePolicyOverride(db, overrideId, {
        revokedBy: opts.by || null,
        reason: opts.reason || null,
      });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify({ override }, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Policy override ${chalk.cyan(override.id)} revoked`);
      console.log(`  ${chalk.dim('pipeline:')} ${override.pipeline_id}`);
      console.log(`  ${chalk.dim('revoked by:')} ${opts.by || 'operator'}`);
      if (opts.reason) {
        console.log(`  ${chalk.dim('reason:')} ${opts.reason}`);
      }
    });

  policyCmd
    .command('list-overrides <pipelineId>')
    .description('Show policy overrides recorded for a pipeline')
    .option('--json', 'Output raw JSON')
    .action((pipelineId, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const overrides = listPolicyOverrides(db, { pipelineId, limit: 100 });
      db.close();

      if (opts.json) {
        console.log(JSON.stringify({ pipeline_id: pipelineId, overrides }, null, 2));
        return;
      }

      console.log(chalk.bold(`Policy overrides for ${pipelineId}`));
      if (overrides.length === 0) {
        console.log(`  ${chalk.green('No overrides recorded.')}`);
        return;
      }
      for (const entry of overrides) {
        console.log(`  ${chalk.cyan(entry.id)} ${chalk.dim(entry.status)}`);
        console.log(`    ${chalk.dim('task types:')} ${(entry.task_types || []).join(', ') || 'none'}`);
        console.log(`    ${chalk.dim('approved by:')} ${entry.approved_by || 'unknown'}`);
        console.log(`    ${chalk.dim('reason:')} ${entry.reason}`);
      }
    });

  return policyCmd;
}
