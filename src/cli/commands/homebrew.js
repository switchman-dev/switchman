export function registerHomebrewCommands(parentCommand, {
  buildHomebrewFormula,
  chalk,
  writeHomebrewFormula,
}) {
  const brewCmd = parentCommand
    .command('brew-formula')
    .description('Generate a Homebrew formula for the current Switchman release');

  brewCmd
    .option('--version <version>', 'Version to embed in the formula')
    .option('--url <url>', 'Release tarball URL to embed in the formula')
    .requiredOption('--sha256 <sha>', 'SHA256 for the release tarball')
    .option('--output <path>', 'Write the formula to a file instead of stdout')
    .action((opts) => {
      const result = buildHomebrewFormula(undefined, {
        version: opts.version || null,
        url: opts.url || null,
        sha256: opts.sha256,
      });

      if (opts.output) {
        const path = writeHomebrewFormula(opts.output, result.formula);
        console.log(`${chalk.green('✓')} Wrote Homebrew formula for v${result.version}`);
        console.log(`  ${chalk.dim('path:')} ${chalk.cyan(path)}`);
        return;
      }

      console.log(result.formula.trimEnd());
    });
}
