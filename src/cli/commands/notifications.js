export function registerNotificationCommands(program, {
  chalk,
  getNotificationsConfigPath,
  readNotificationsConfig,
  sendSwitchmanNotification,
  writeNotificationsConfig,
}) {
  const notificationsCmd = program
    .command('notifications')
    .description('Configure desktop notifications for agent progress');

  notificationsCmd
    .command('status')
    .description('Show current notification settings')
    .option('--json', 'Output raw JSON')
    .action((opts) => {
      const config = readNotificationsConfig();
      const payload = {
        ...config,
        path: getNotificationsConfigPath(),
      };
      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log('');
      console.log(chalk.bold('Switchman notifications'));
      console.log(`  ${chalk.dim('config:')} ${payload.path}`);
      console.log(`  ${chalk.dim('desktop:')} ${config.desktop_enabled ? chalk.green('enabled') : chalk.dim('disabled')}`);
      console.log('');
    });

  notificationsCmd
    .command('desktop <state>')
    .description('Enable or disable local desktop notifications')
    .action((state) => {
      const enabled = ['on', 'enable', 'enabled', 'true'].includes(String(state).toLowerCase());
      const config = writeNotificationsConfig({ desktop_enabled: enabled });
      console.log(`${chalk.green('✓')} Desktop notifications ${config.desktop_enabled ? 'enabled' : 'disabled'}`);
    });

  notificationsCmd
    .command('test')
    .description('Send a test notification through the configured channels')
    .action(async () => {
      const result = await sendSwitchmanNotification({
        title: 'Switchman test notification',
        message: 'Your agents can now notify you when work finishes or gets blocked.',
      });
      if (!result.deliveries.length) {
        console.log(chalk.yellow('No notification channels are enabled yet.'));
        console.log(`${chalk.yellow('next:')} switchman notifications desktop on`);
        return;
      }
      console.log(`${chalk.green('✓')} Sent ${result.deliveries.filter((entry) => entry.ok).length} notification(s)`);
    });
}
