export function registerMcpCommands(program, {
  chalk,
  getWindsurfMcpConfigPath,
  upsertWindsurfMcpConfig,
}) {
  const mcpCmd = program.command('mcp').description('Manage editor connections for Switchman');

  mcpCmd
    .command('install')
    .description('Install editor-specific MCP config for Switchman')
    .option('--windsurf', 'Write Windsurf MCP config to ~/.codeium/mcp_config.json')
    .option('--home <path>', 'Override the home directory for config writes (useful for testing)')
    .option('--json', 'Output raw JSON')
    .addHelpText('after', `
Examples:
  switchman mcp install --windsurf
  switchman mcp install --windsurf --json
`)
    .action((opts) => {
      if (!opts.windsurf) {
        console.error(chalk.red('Choose an editor install target, for example `switchman mcp install --windsurf`.'));
        process.exitCode = 1;
        return;
      }

      const result = upsertWindsurfMcpConfig(opts.home);

      if (opts.json) {
        console.log(JSON.stringify({
          editor: 'windsurf',
          path: result.path,
          created: result.created,
          changed: result.changed,
        }, null, 2));
        return;
      }

      console.log(`${chalk.green('✓')} Windsurf MCP config ${result.changed ? 'written' : 'already up to date'}`);
      console.log(`  ${chalk.dim('path:')} ${chalk.cyan(result.path)}`);
      console.log(`  ${chalk.dim('open:')} Windsurf -> Settings -> Cascade -> MCP Servers`);
      console.log(`  ${chalk.dim('note:')} Windsurf reads the shared config from ${getWindsurfMcpConfigPath(opts.home)}`);
    });

  return mcpCmd;
}
