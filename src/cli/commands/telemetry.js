export function registerTelemetryCommands(program, {
  chalk,
  disableTelemetry,
  enableTelemetry,
  getTelemetryConfigPath,
  getTelemetryRuntimeConfig,
  loadTelemetryConfig,
  printErrorWithNext,
  sendTelemetryEvent,
}) {
  const telemetryCmd = program.command('telemetry').description('Control anonymous opt-in telemetry for Switchman');

  telemetryCmd
    .command('status')
    .description('Show whether telemetry is enabled and where events would be sent')
    .option('--home <path>', 'Override the home directory for telemetry config')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const config = loadTelemetryConfig(opts.home || undefined);
      const runtime = getTelemetryRuntimeConfig();
      const payload = {
        enabled: config.telemetry_enabled === true,
        configured: Boolean(runtime.apiKey) && !runtime.disabled,
        install_id: config.telemetry_install_id,
        destination: runtime.apiKey && !runtime.disabled ? runtime.host : null,
        config_path: getTelemetryConfigPath(opts.home || undefined),
      };

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(`Telemetry: ${payload.enabled ? chalk.green('enabled') : chalk.yellow('disabled')}`);
      console.log(`Configured destination: ${payload.configured ? chalk.cyan(payload.destination) : chalk.dim('not configured')}`);
      console.log(`Config file: ${chalk.dim(payload.config_path)}`);
      if (payload.install_id) {
        console.log(`Install ID: ${chalk.dim(payload.install_id)}`);
      }
    });

  telemetryCmd
    .command('enable')
    .description('Enable anonymous telemetry for setup and operator workflows')
    .option('--home <path>', 'Override the home directory for telemetry config')
    .action((opts) => {
      const runtime = getTelemetryRuntimeConfig();
      if (!runtime.apiKey || runtime.disabled) {
        printErrorWithNext('Telemetry destination is not configured. Set SWITCHMAN_TELEMETRY_API_KEY first.', 'switchman telemetry status');
        process.exitCode = 1;
        return;
      }
      const result = enableTelemetry(opts.home || undefined);
      console.log(`${chalk.green('✓')} Telemetry enabled`);
      console.log(`  ${chalk.dim(result.path)}`);
    });

  telemetryCmd
    .command('disable')
    .description('Disable anonymous telemetry')
    .option('--home <path>', 'Override the home directory for telemetry config')
    .action((opts) => {
      const result = disableTelemetry(opts.home || undefined);
      console.log(`${chalk.green('✓')} Telemetry disabled`);
      console.log(`  ${chalk.dim(result.path)}`);
    });

  telemetryCmd
    .command('test')
    .description('Send one test telemetry event and report whether delivery succeeded')
    .option('--home <path>', 'Override the home directory for telemetry config')
    .option('--json', 'Output raw JSON')
    .action(async (opts) => {
      const result = await sendTelemetryEvent('telemetry_test', {
        app_version: program.version(),
        os: process.platform,
        node_version: process.version,
        source: 'switchman-cli-test',
      }, { homeDir: opts.home || undefined });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) process.exitCode = 1;
        return;
      }

      if (result.ok) {
        console.log(`${chalk.green('✓')} Telemetry test event delivered`);
        console.log(`  ${chalk.dim('destination:')} ${chalk.cyan(result.destination)}`);
        if (result.status) {
          console.log(`  ${chalk.dim('status:')} ${result.status}`);
        }
        return;
      }

      printErrorWithNext(`Telemetry test failed (${result.reason || 'unknown_error'}).`, 'switchman telemetry status');
      console.log(`  ${chalk.dim('destination:')} ${result.destination || 'unknown'}`);
      if (result.status) {
        console.log(`  ${chalk.dim('status:')} ${result.status}`);
      }
      if (result.error) {
        console.log(`  ${chalk.dim('error:')} ${result.error}`);
      }
      process.exitCode = 1;
    });

  return telemetryCmd;
}
