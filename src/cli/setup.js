import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { listWorktrees, openDb } from '../core/db.js';
import { getWindsurfMcpConfigPath } from '../core/mcp.js';
import { formatHumanList } from './planning.js';
import { boolBadge } from './ui.js';

export function collectSetupVerification(repoRoot, { homeDir = null } = {}) {
  const dbPath = join(repoRoot, '.switchman', 'switchman.db');
  const rootMcpPath = join(repoRoot, '.mcp.json');
  const cursorMcpPath = join(repoRoot, '.cursor', 'mcp.json');
  const claudeGuidePath = join(repoRoot, 'CLAUDE.md');
  const checks = [];
  const nextSteps = [];
  let workspaces = [];
  let db = null;

  const dbExists = existsSync(dbPath);
  checks.push({
    key: 'database',
    ok: dbExists,
    label: 'Project database',
    detail: dbExists ? '.switchman/switchman.db is ready' : 'Switchman database is missing',
  });
  if (!dbExists) {
    nextSteps.push('Run `switchman start "Add authentication"` for the fastest setup, or `switchman setup --agents 3` for the manual path.');
  }

  if (dbExists) {
    try {
      db = openDb(repoRoot);
      workspaces = listWorktrees(db);
    } catch {
      checks.push({
        key: 'database_open',
        ok: false,
        label: 'Database access',
        detail: 'Switchman could not open the project database',
      });
      nextSteps.push('Re-run `switchman init` if the project database looks corrupted.');
    } finally {
      try { db?.close(); } catch { /* no-op */ }
    }
  }

  const agentWorkspaces = workspaces.filter((entry) => entry.name !== 'main');
  const workspaceReady = agentWorkspaces.length > 0;
  checks.push({
    key: 'workspaces',
    ok: workspaceReady,
    label: 'Agent workspaces',
    detail: workspaceReady
      ? `${agentWorkspaces.length} agent workspace(s) registered`
      : 'No agent workspaces are registered yet',
  });
  if (!workspaceReady) {
    nextSteps.push('Run `switchman start "Add authentication"` to create agent workspaces automatically, or `switchman setup --agents 3` for manual setup.');
  }

  const rootMcpExists = existsSync(rootMcpPath);
  checks.push({
    key: 'claude_mcp',
    ok: rootMcpExists,
    label: 'Claude Code MCP',
    detail: rootMcpExists ? '.mcp.json is present in the repo root' : '.mcp.json is missing from the repo root',
  });
  if (!rootMcpExists) {
    nextSteps.push('Run `switchman start "Add authentication"` to self-heal the repo-local MCP config, or re-run `switchman setup --agents 3`.');
  }

  const cursorMcpExists = existsSync(cursorMcpPath);
  checks.push({
    key: 'cursor_mcp',
    ok: cursorMcpExists,
    label: 'Cursor MCP',
    detail: cursorMcpExists ? '.cursor/mcp.json is present in the repo root' : '.cursor/mcp.json is missing from the repo root',
  });
  if (!cursorMcpExists) {
    nextSteps.push('Run `switchman start "Add authentication"` to self-heal local editor wiring, or re-run `switchman setup --agents 3` if you want Cursor to attach automatically.');
  }

  const claudeGuideExists = existsSync(claudeGuidePath);
  checks.push({
    key: 'claude_md',
    ok: claudeGuideExists,
    label: 'Claude guide',
    detail: claudeGuideExists ? 'CLAUDE.md is present' : 'CLAUDE.md is optional but recommended for Claude Code',
  });
  if (!claudeGuideExists) {
    nextSteps.push('If you use Claude Code, run `switchman claude refresh` to generate a repo-aware `CLAUDE.md`.');
  }

  const windsurfConfigExists = existsSync(getWindsurfMcpConfigPath(homeDir || undefined));
  checks.push({
    key: 'windsurf_mcp',
    ok: windsurfConfigExists,
    label: 'Windsurf MCP',
    detail: windsurfConfigExists
      ? 'Windsurf shared MCP config is installed'
      : 'Windsurf shared MCP config is optional and not installed',
  });
  if (!windsurfConfigExists) {
    nextSteps.push('If you use Windsurf, run `switchman mcp install --windsurf` once.');
  }

  const ok = checks.every((item) => item.ok || ['claude_md', 'windsurf_mcp'].includes(item.key));
  return {
    ok,
    repo_root: repoRoot,
    checks,
    workspaces: workspaces.map((entry) => ({
      name: entry.name,
      path: entry.path,
      branch: entry.branch,
    })),
    suggested_commands: [
      'switchman status --watch',
      'switchman task add "Your first task" --priority 8',
      'switchman gate ci',
      ...nextSteps.some((step) => step.includes('Windsurf')) ? ['switchman mcp install --windsurf'] : [],
    ],
    next_steps: [...new Set(nextSteps)].slice(0, 6),
  };
}

function readJsonFileIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function detectClaudeGuideContext(repoRoot) {
  const packageJson = readJsonFileIfExists(join(repoRoot, 'package.json'));
  const hasTsconfig = existsSync(join(repoRoot, 'tsconfig.json'));
  const hasPyproject = existsSync(join(repoRoot, 'pyproject.toml'));
  const hasRequirements = existsSync(join(repoRoot, 'requirements.txt'));
  const hasGoMod = existsSync(join(repoRoot, 'go.mod'));
  const hasCargo = existsSync(join(repoRoot, 'Cargo.toml'));
  const hasGemfile = existsSync(join(repoRoot, 'Gemfile'));

  const stack = [];
  if (packageJson) stack.push(hasTsconfig ? 'Node.js + TypeScript' : 'Node.js');
  if (!packageJson && hasTsconfig) stack.push('TypeScript');
  if (hasPyproject || hasRequirements) stack.push('Python');
  if (hasGoMod) stack.push('Go');
  if (hasCargo) stack.push('Rust');
  if (hasGemfile) stack.push('Ruby');
  if (stack.length === 0) stack.push('general-purpose codebase');

  const packageManager = existsSync(join(repoRoot, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(repoRoot, 'yarn.lock'))
      ? 'yarn'
      : 'npm';

  const scripts = packageJson?.scripts || {};
  const packageRunner = packageManager === 'pnpm'
    ? 'pnpm'
    : packageManager === 'yarn'
      ? 'yarn'
      : 'npm run';
  const testCommand = typeof scripts.test === 'string' && scripts.test.trim() && !scripts.test.includes('no test specified')
    ? `${packageRunner}${packageManager === 'yarn' ? ' test' : ' test'}`
    : hasPyproject || hasRequirements
      ? 'pytest'
      : hasGoMod
        ? 'go test ./...'
        : hasCargo
          ? 'cargo test'
          : null;
  const buildCommand = typeof scripts.build === 'string' && scripts.build.trim()
    ? `${packageRunner}${packageManager === 'yarn' ? ' build' : ' build'}`
    : hasGoMod
      ? 'go build ./...'
      : hasCargo
        ? 'cargo build'
        : null;
  const lintCommand = typeof scripts.lint === 'string' && scripts.lint.trim()
    ? `${packageRunner}${packageManager === 'yarn' ? ' lint' : ' lint'}`
    : null;

  const importantPaths = [
    existsSync(join(repoRoot, 'src')) ? 'src/' : null,
    existsSync(join(repoRoot, 'app')) ? 'app/' : null,
    existsSync(join(repoRoot, 'lib')) ? 'lib/' : null,
    existsSync(join(repoRoot, 'tests')) ? 'tests/' : null,
    existsSync(join(repoRoot, 'test')) ? 'test/' : null,
    existsSync(join(repoRoot, 'docs')) ? 'docs/' : null,
    existsSync(join(repoRoot, 'packages')) ? 'packages/' : null,
  ].filter(Boolean);

  const conventions = [];
  if (existsSync(join(repoRoot, '.mcp.json'))) conventions.push('project-local MCP config is already wired');
  if (existsSync(join(repoRoot, '.cursor', 'mcp.json'))) conventions.push('Cursor MCP config is present');
  if (existsSync(join(repoRoot, '.git', 'info', 'exclude'))) conventions.push('repo-local git excludes can hide MCP noise from merges');

  return {
    stack,
    packageManager,
    testCommand,
    buildCommand,
    lintCommand,
    importantPaths: importantPaths.slice(0, 5),
    conventions,
  };
}

export function renderClaudeGuide(repoRoot) {
  const context = detectClaudeGuideContext(repoRoot);
  const stackSummary = formatHumanList(context.stack);
  const importantPaths = context.importantPaths.length > 0
    ? context.importantPaths.join(', ')
    : 'the repo root';
  const preferredCommands = [
    context.testCommand ? `- Tests: \`${context.testCommand}\`` : null,
    context.buildCommand ? `- Build: \`${context.buildCommand}\`` : null,
    context.lintCommand ? `- Lint: \`${context.lintCommand}\`` : null,
  ].filter(Boolean);
  const conventions = context.conventions.length > 0
    ? context.conventions.map((item) => `- ${item}`)
    : ['- follow the existing file layout and naming conventions already in the repo'];

  return `# Switchman Agent Instructions

This repository uses **Switchman** to coordinate parallel AI coding agents.
You MUST follow these instructions every session to avoid conflicting with other agents.

You must use the Switchman MCP tools for coordination. Do not read from or write to \`.switchman/switchman.db\` directly, and do not bypass Switchman by issuing raw SQLite queries.

---

## Repo profile

- Stack: ${stackSummary}
- Important paths: ${importantPaths}
${preferredCommands.length > 0 ? preferredCommands.join('\n') : '- Commands: follow the repo-specific test/build scripts before marking work complete'}

## Existing conventions

${conventions.join('\n')}

When you make changes, preserve the current code style, folder structure, and script usage that already exist in this repo.

---

## Your worktree

Find your worktree name by running:
\`\`\`bash
git worktree list
\`\`\`
The path that matches your current directory is your worktree. Use the last path segment as your worktree name (e.g. \`/projects/myapp-feature-auth\` → \`feature-auth\`). The main repo root is always named \`main\`.

---

## Required workflow — follow this every session

### 1. Start of session — get your task

Call the \`switchman_task_next\` MCP tool with your worktree name:
\`\`\`
switchman_task_next({ worktree: "<your-worktree-name>", agent: "claude-code" })
\`\`\`

- If \`task\` is \`null\` — the queue is empty. Ask the user what to work on, or stop.
- If you receive a task — note the \`task.id\`. You'll need it in the next steps.
- If the \`switchman_*\` tools are unavailable, stop and tell the user the MCP server is not connected. Do not fall back to direct SQLite access.

### 2. Before editing any files — claim them

Call \`switchman_task_claim\` with every file you plan to edit **before you edit them**:
\`\`\`
switchman_task_claim({
  task_id: "<task-id>",
  worktree: "<your-worktree-name>",
  files: ["src/auth/login.js", "tests/auth.test.js"]
})
\`\`\`

- If \`safe_to_proceed\` is \`false\` — there are conflicts. Do NOT edit those files.
  Read the \`conflicts\` array to see which worktrees own them, then either:
  - Choose different files that accomplish the same goal
  - Ask the user how to proceed

- If \`safe_to_proceed\` is \`true\` — you are clear to edit.

### 3. Do the work

Implement the task. Make commits as normal. Other agents will avoid your claimed files.

If you discover mid-task that you need to edit additional files, call \`switchman_task_claim\` again for those files before editing them.

When MCP write tools are available, prefer the Switchman enforcement gateway over native file writes:
\`\`\`text
switchman_write_file(...)
switchman_append_file(...)
switchman_make_directory(...)
switchman_move_path(...)
switchman_remove_path(...)
\`\`\`

These tools validate your active lease and claimed paths before changing the filesystem. Use native file writes only when the Switchman write tools are unavailable and you have already claimed the path.

### 4. Before marking work complete

Run the repo's most relevant verification commands for the files you changed.
${context.testCommand ? `At minimum, prefer \`${context.testCommand}\` when the task changes behavior or tests.\n` : ''}${context.lintCommand ? `Use \`${context.lintCommand}\` when the repo relies on linting before merge.\n` : ''}${context.buildCommand ? `Use \`${context.buildCommand}\` when the repo has a meaningful build step.\n` : ''}If the correct command is unclear, inspect the existing scripts and match the repo's normal workflow.

### 5. End of session — mark complete or failed

**On success:**
\`\`\`
switchman_task_done({ task_id: "<task-id>" })
\`\`\`

**On failure (can't complete the task):**
\`\`\`
switchman_task_fail({ task_id: "<task-id>", reason: "Brief explanation of what blocked you" })
\`\`\`

Always call one of these before ending your session. Released file claims allow other agents to proceed.

---

## Checking system state

To see what other agents are doing:
\`\`\`
switchman_status()
\`\`\`

To recover abandoned work or stale sessions:
\`\`\`
switchman_recover()
\`\`\`

To scan for conflicts before merge:
\`\`\`
switchman_scan()
\`\`\`

---

## Rules

1. **Always claim files before editing them** — not after.
2. **Always call \`switchman_task_done\` or \`switchman_task_fail\` at end of session** — never leave tasks as \`in_progress\` when you stop.
3. **If \`safe_to_proceed\` is false, do not edit the conflicting files** — coordinate first.
4. **Do not claim files you don't need** — over-claiming blocks other agents unnecessarily.
5. **One task per session** — complete or fail your current task before taking another.
6. **Never query or mutate the Switchman SQLite database directly** — use MCP tools only.
`;
}

export function renderSetupVerification(report, { compact = false } = {}) {
  console.log(chalk.bold(compact ? 'First-run check:' : 'Ready check:'));
  for (const check of report.checks) {
    const badge = boolBadge(check.ok);
    console.log(`  ${badge} ${check.label} ${chalk.dim(`— ${check.detail}`)}`);
  }
  if (report.next_steps.length > 0) {
    console.log('');
    console.log(chalk.bold('Needs attention:'));
    for (const step of report.next_steps) {
      console.log(`  - ${step}`);
    }
  }
  console.log('');
  console.log(chalk.bold('Run next:'));
  for (const command of report.suggested_commands.slice(0, 4)) {
    console.log(`  ${chalk.cyan(command)}`);
  }
}

export function renderQuickcheck(report) {
  console.log(chalk.bold('Quickcheck:'));
  for (const check of report.checks) {
    const badge = boolBadge(check.ok);
    console.log(`  ${badge} ${check.label} ${chalk.dim(`— ${check.detail}`)}`);
  }
  console.log('');
  console.log(chalk.bold('Run this next:'));
  console.log(`  ${chalk.cyan(report.next_command)}`);
  if (report.follow_up) {
    console.log('');
    console.log(chalk.bold('Then:'));
    for (const command of report.follow_up) {
      console.log(`  ${chalk.cyan(command)}`);
    }
  }
}
