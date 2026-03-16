export function registerWorktreeCommands(program, {
  chalk,
  evaluateRepoCompliance,
  getDb,
  getRepo,
  installMcpConfig,
  listGitWorktrees,
  listWorktrees,
  registerWorktree,
  statusBadge,
}) {
  const wtCmd = program.command('worktree').alias('workspace').description('Manage registered workspaces (Git worktrees)');
  wtCmd.addHelpText('after', `
Plain English:
  worktree = the Git feature behind each agent workspace

Examples:
  switchman worktree list
  switchman workspace list
  switchman worktree sync
`);

  wtCmd
    .command('add <name> <path> <branch>')
    .description('Register a workspace with Switchman')
    .option('--agent <name>', 'Agent assigned to this worktree')
    .action((name, path, branch, opts) => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      registerWorktree(db, { name, path, branch, agent: opts.agent });
      db.close();
      console.log(`${chalk.green('✓')} Registered worktree: ${chalk.cyan(name)}`);
    });

  wtCmd
    .command('list')
    .description('List all registered workspaces')
    .action(() => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const worktrees = listWorktrees(db);
      const gitWorktrees = listGitWorktrees(repoRoot);

      if (!worktrees.length && !gitWorktrees.length) {
        db.close();
        console.log(chalk.dim('No workspaces found. Run `switchman setup --agents 3` or `switchman worktree sync`.'));
        return;
      }

      const complianceReport = evaluateRepoCompliance(db, repoRoot, gitWorktrees);
      console.log('');
      console.log(chalk.bold('Git Worktrees:'));
      for (const wt of gitWorktrees) {
        const dbInfo = worktrees.find((d) => d.path === wt.path);
        const complianceInfo = complianceReport.worktreeCompliance.find((entry) => entry.worktree === wt.name) || null;
        const agent = dbInfo?.agent ? chalk.cyan(dbInfo.agent) : chalk.dim('no agent');
        const status = dbInfo?.status ? statusBadge(dbInfo.status) : chalk.dim('unregistered');
        const compliance = complianceInfo?.compliance_state ? statusBadge(complianceInfo.compliance_state) : dbInfo?.compliance_state ? statusBadge(dbInfo.compliance_state) : chalk.dim('unknown');
        console.log(`  ${chalk.bold(wt.name.padEnd(20))} ${status} ${compliance} branch: ${chalk.cyan(wt.branch || 'unknown')}  agent: ${agent}`);
        console.log(`    ${chalk.dim(wt.path)}`);
        if ((complianceInfo?.unclaimed_changed_files || []).length > 0) {
          console.log(`    ${chalk.red('files:')} ${complianceInfo.unclaimed_changed_files.slice(0, 5).join(', ')}${complianceInfo.unclaimed_changed_files.length > 5 ? ` ${chalk.dim(`+${complianceInfo.unclaimed_changed_files.length - 5} more`)}` : ''}`);
        }
      }
      console.log('');
      db.close();
    });

  wtCmd
    .command('sync')
    .description('Sync Git workspaces into the Switchman database')
    .action(() => {
      const repoRoot = getRepo();
      const db = getDb(repoRoot);
      const gitWorktrees = listGitWorktrees(repoRoot);
      for (const wt of gitWorktrees) {
        registerWorktree(db, { name: wt.name, path: wt.path, branch: wt.branch || 'unknown' });
      }
      db.close();
      installMcpConfig([...new Set([repoRoot, ...gitWorktrees.map((wt) => wt.path)])]);
      console.log(`${chalk.green('✓')} Synced ${gitWorktrees.length} worktree(s) from git`);
    });

  return wtCmd;
}
