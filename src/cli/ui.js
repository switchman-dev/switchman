import chalk from 'chalk';

export function statusBadge(status) {
  const colors = {
    pending: chalk.yellow,
    in_progress: chalk.blue,
    active: chalk.blue,
    completed: chalk.green,
    done: chalk.green,
    failed: chalk.red,
    expired: chalk.red,
    idle: chalk.gray,
    busy: chalk.blue,
    managed: chalk.green,
    observed: chalk.yellow,
    non_compliant: chalk.red,
    stale: chalk.red,
    queued: chalk.yellow,
    validating: chalk.blue,
    rebasing: chalk.blue,
    retrying: chalk.yellow,
    blocked: chalk.red,
    merging: chalk.blue,
    merged: chalk.green,
    canceled: chalk.gray,
  };
  return (colors[status] || chalk.white)(status.toUpperCase().padEnd(11));
}

export function printTable(rows, columns) {
  if (!rows.length) return;
  const widths = columns.map((col) =>
    Math.max(col.label.length, ...rows.map((row) => String(row[col.key] || '').length))
  );
  const header = columns.map((col, i) => col.label.padEnd(widths[i])).join('  ');
  console.log(chalk.dim(header));
  console.log(chalk.dim('─'.repeat(header.length)));
  for (const row of rows) {
    console.log(columns.map((col, i) => {
      const val = String(row[col.key] || '');
      return col.format ? col.format(val) : val.padEnd(widths[i]);
    }).join('  '));
  }
}

function padRight(value, width) {
  return String(value).padEnd(width);
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-9;]*m/g, '');
}

export function colorForHealth(health) {
  if (health === 'healthy') return chalk.green;
  if (health === 'warn') return chalk.yellow;
  return chalk.red;
}

export function healthLabel(health) {
  if (health === 'healthy') return 'HEALTHY';
  if (health === 'warn') return 'ATTENTION';
  return 'BLOCKED';
}

export function renderPanel(title, lines, color = chalk.cyan) {
  const content = lines.length > 0 ? lines : [chalk.dim('No items.')];
  const width = Math.max(
    stripAnsi(title).length + 2,
    ...content.map((line) => stripAnsi(line).length),
  );
  const top = color(`+${'-'.repeat(width + 2)}+`);
  const titleLine = color(`| ${padRight(title, width)} |`);
  const body = content.map((line) => `| ${padRight(line, width)} |`);
  const bottom = color(`+${'-'.repeat(width + 2)}+`);
  return [top, titleLine, top, ...body, bottom];
}

export function renderMetricRow(metrics) {
  return metrics.map(({ label, value, color = chalk.white }) => `${chalk.dim(label)} ${color(String(value))}`).join(chalk.dim('   |   '));
}

export function renderMiniBar(items) {
  if (!items.length) return chalk.dim('none');
  return items.map(({ label, value, color = chalk.white }) => `${color('■')} ${label}:${value}`).join(chalk.dim('  '));
}

export function renderChip(label, value, color = chalk.white) {
  return color(`[${label}:${value}]`);
}

export function renderSignalStrip(signals) {
  return signals.join(chalk.dim('  '));
}

export function formatClockTime(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function buildWatchSignature(report) {
  return JSON.stringify({
    health: report.health,
    summary: report.summary,
    counts: report.counts,
    active_work: report.active_work,
    attention: report.attention,
    queue_summary: report.queue?.summary || null,
    next_up: report.next_up || null,
    next_steps: report.next_steps,
    suggested_commands: report.suggested_commands,
  });
}

export function formatRelativePolicy(policy) {
  return `stale ${policy.stale_after_minutes}m • heartbeat ${policy.heartbeat_interval_seconds}s • auto-reap ${policy.reap_on_status_check ? 'on' : 'off'}`;
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function boolBadge(ok) {
  return ok ? chalk.green('OK   ') : chalk.yellow('CHECK');
}

export function printErrorWithNext(message, nextCommand = null) {
  console.error(chalk.red(message));
  if (nextCommand) {
    console.error(`${chalk.yellow('next:')} ${nextCommand}`);
  }
}
