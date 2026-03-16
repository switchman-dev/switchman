export function registerClaudeCommands(program, {
  chalk,
  existsSync,
  getRepo,
  join,
  renderClaudeGuide,
  writeFileSync,
}) {
  const claudeCmd = program.command('claude').description('Generate or refresh Claude Code instructions for this repo');

  claudeCmd
    .command('refresh')
    .description('Generate a repo-aware CLAUDE.md for this repository')
    .option('--print', 'Print the generated guide instead of writing CLAUDE.md')
    .addHelpText('after', `
Examples:
  switchman claude refresh
  switchman claude refresh --print
`)
    .action((opts) => {
      const repoRoot = getRepo();
      const claudeGuidePath = join(repoRoot, 'CLAUDE.md');
      const content = renderClaudeGuide(repoRoot);

      if (opts.print) {
        process.stdout.write(content);
        return;
      }

      const existed = existsSync(claudeGuidePath);
      writeFileSync(claudeGuidePath, content, 'utf8');
      console.log(`${chalk.green('✓')} ${existed ? 'Refreshed' : 'Created'} ${chalk.cyan(claudeGuidePath)}`);
      console.log(`  ${chalk.dim('next:')} ${chalk.cyan('switchman verify-setup')}`);
    });

  return claudeCmd;
}
