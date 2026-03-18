import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { execSync, spawnSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

import { listWorktrees } from '../core/db.js';
import { getWorktreeBranch, listGitWorktrees } from '../core/git.js';

export function slugifyValue(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'plan';
}

export function capitalizeSentence(value) {
  const text = String(value || '').trim();
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatHumanList(values = []) {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function readPlanningFile(repoRoot, fileName, maxChars = 1200) {
  const filePath = join(repoRoot, fileName);
  if (!existsSync(filePath)) return null;
  try {
    const text = readFileSync(filePath, 'utf8').trim();
    if (!text) return null;
    return {
      file: fileName,
      text: text.slice(0, maxChars),
    };
  } catch {
    return null;
  }
}

function extractMarkdownSignal(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const normalized = line.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').trim();
    if (!normalized) continue;
    if (/^switchman\b/i.test(normalized)) continue;
    return normalized;
  }
  return null;
}

function deriveGoalFromBranch(branchName) {
  const raw = String(branchName || '').replace(/^refs\/heads\//, '').trim();
  if (!raw || ['main', 'master', 'trunk', 'develop', 'development'].includes(raw)) return null;
  const tail = raw.split('/').pop() || raw;
  const tokens = tail
    .replace(/^\d+[-_]?/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .filter((token) => !['feature', 'feat', 'fix', 'bugfix', 'chore', 'task', 'issue', 'story', 'work'].includes(token.toLowerCase()));
  if (tokens.length === 0) return null;
  return capitalizeSentence(tokens.join(' '));
}

function getRecentCommitSubjects(repoRoot, limit = 6) {
  try {
    return execSync(`git log --pretty=%s -n ${limit}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function summarizeRecentCommitContext(branchGoal, subjects) {
  if (!subjects.length) return null;
  const topicWords = String(branchGoal || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 4);
  const relatedCount = topicWords.length > 0
    ? subjects.filter((subject) => {
      const lower = subject.toLowerCase();
      return topicWords.some((word) => lower.includes(word));
    }).length
    : 0;
  const effectiveCount = relatedCount > 0 ? relatedCount : Math.min(subjects.length, 3);
  const topicLabel = relatedCount > 0 && topicWords.length > 0 ? `${topicWords[0]}-related ` : '';
  return `${effectiveCount} recent ${topicLabel}commit${effectiveCount === 1 ? '' : 's'}`;
}

export function collectPlanContext(repoRoot, explicitGoal = null, issueContext = null) {
  const planningFiles = ['CLAUDE.md', 'ROADMAP.md', 'tasks.md', 'TASKS.md', 'TODO.md', 'README.md']
    .map((fileName) => readPlanningFile(repoRoot, fileName))
    .filter(Boolean);
  const planningByName = new Map(planningFiles.map((entry) => [entry.file, entry]));
  const branch = getWorktreeBranch(process.cwd()) || null;
  const branchGoal = deriveGoalFromBranch(branch);
  const recentCommitSubjects = getRecentCommitSubjects(repoRoot, 6);
  const recentCommitSummary = summarizeRecentCommitContext(branchGoal, recentCommitSubjects);
  const preferredPlanningFile = planningByName.get('CLAUDE.md')
    || planningByName.get('tasks.md')
    || planningByName.get('TASKS.md')
    || planningByName.get('ROADMAP.md')
    || planningByName.get('TODO.md')
    || planningByName.get('README.md')
    || null;
  const planningSignal = preferredPlanningFile ? extractMarkdownSignal(preferredPlanningFile.text) : null;
  const title = capitalizeSentence(issueContext?.title || explicitGoal || branchGoal || planningSignal || 'Plan the next coordinated change');
  const descriptionParts = [];
  if (issueContext?.description) descriptionParts.push(issueContext.description);
  if (preferredPlanningFile?.text) descriptionParts.push(preferredPlanningFile.text);
  if (recentCommitSubjects.length > 0) descriptionParts.push(`Recent git history summary: ${recentCommitSubjects.slice(0, 3).join('; ')}.`);
  const description = descriptionParts.join('\n\n').trim() || null;

  const found = [];
  const used = [];
  if (issueContext?.number) {
    found.push(`issue #${issueContext.number} "${issueContext.title}"`);
    used.push(`GitHub issue #${issueContext.number}`);
  }
  if (explicitGoal) {
    used.push('explicit goal');
  }
  if (branch) {
    found.push(`branch ${branch}`);
    if (branchGoal) used.push('branch name');
  }
  if (preferredPlanningFile?.file) {
    found.push(preferredPlanningFile.file);
    used.push(preferredPlanningFile.file);
  }
  if (recentCommitSummary) {
    found.push(recentCommitSummary);
    used.push('recent git history');
  }

  return {
    branch,
    title,
    description,
    found,
    used: [...new Set(used)],
  };
}

export function fetchGitHubIssueContext(repoRoot, issueNumber, ghCommand = 'gh') {
  const normalizedIssueNumber = String(issueNumber || '').trim();
  if (!normalizedIssueNumber) {
    throw new Error('A GitHub issue number is required.');
  }

  const result = spawnSync(ghCommand, [
    'issue',
    'view',
    normalizedIssueNumber,
    '--json',
    'title,body,comments',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.error) {
    throw new Error(`Could not run ${ghCommand} to read issue #${normalizedIssueNumber}. ${result.error.message}`);
  }

  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(output || `gh issue view failed for issue #${normalizedIssueNumber}. Make sure gh is installed and authenticated.`);
  }

  let issue;
  try {
    issue = JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error(`Could not parse GitHub issue #${normalizedIssueNumber}.`);
  }

  const comments = Array.isArray(issue.comments)
    ? issue.comments.map((entry) => entry?.body || '').filter(Boolean)
    : [];
  const descriptionParts = [
    `GitHub issue #${normalizedIssueNumber}: ${issue.title || 'Untitled issue'}`,
    issue.body || '',
    comments.length > 0 ? `Comments:\n${comments.join('\n---\n')}` : '',
  ].filter(Boolean);

  return {
    number: normalizedIssueNumber,
    title: issue.title || `Issue #${normalizedIssueNumber}`,
    description: descriptionParts.join('\n\n'),
    comment_count: comments.length,
  };
}

export function buildPlanningCommentBody(context, plannedTasks) {
  const lines = [
    '## Switchman plan summary',
    '',
    `Planned from: **${context.title}**`,
  ];

  if (context.used.length > 0) {
    lines.push(`Context used: ${context.used.join(', ')}`);
  }

  lines.push('');
  lines.push('Proposed parallel tasks:');
  lines.push('');

  plannedTasks.forEach((task, index) => {
    const worktreeLabel = task.suggested_worktree || 'unassigned';
    lines.push(`${index + 1}. ${task.title} (${worktreeLabel})`);
  });

  lines.push('');
  lines.push('_Generated by Switchman._');
  return `${lines.join('\n')}\n`;
}

export function postPlanningSummaryComment(repoRoot, {
  ghCommand = 'gh',
  issueNumber = null,
  prNumber = null,
  body,
}) {
  const targetNumber = prNumber || issueNumber;
  if (!targetNumber) {
    throw new Error('A GitHub issue or pull request number is required to post a planning summary.');
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'switchman-plan-comment-'));
  const bodyPath = join(tempDir, 'plan-summary.md');
  writeFileSync(bodyPath, body, 'utf8');

  try {
    const args = prNumber
      ? ['pr', 'comment', String(prNumber), '--body-file', bodyPath]
      : ['issue', 'comment', String(issueNumber), '--body-file', bodyPath];
    const result = spawnSync(ghCommand, args, {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    if (result.error) {
      throw new Error(`Could not run ${ghCommand} to post the planning summary. ${result.error.message}`);
    }

    if (result.status !== 0) {
      const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
      throw new Error(output || `gh ${prNumber ? 'pr' : 'issue'} comment failed.`);
    }

    return {
      target_type: prNumber ? 'pr' : 'issue',
      target_number: String(targetNumber),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function resolvePlanningWorktrees(repoRoot, db = null) {
  if (db) {
    const registered = listWorktrees(db)
      .filter((worktree) => worktree.name !== 'main' && worktree.status !== 'missing')
      .map((worktree) => ({ name: worktree.name, path: worktree.path, branch: worktree.branch }));
    if (registered.length > 0) return registered;
  }
  return listGitWorktrees(repoRoot)
    .filter((worktree) => !worktree.isMain)
    .map((worktree) => ({ name: worktree.name, path: worktree.path, branch: worktree.branch || null }));
}

export function planTaskPriority(taskSpec = null) {
  const taskType = taskSpec?.task_type || 'implementation';
  if (taskType === 'implementation') return 8;
  if (taskType === 'tests') return 7;
  if (taskType === 'docs') return 6;
  if (taskType === 'governance') return 6;
  return 5;
}

export function resolvePrNumberFromEnv(env = process.env) {
  if (env.SWITCHMAN_PR_NUMBER) return String(env.SWITCHMAN_PR_NUMBER);
  if (env.GITHUB_PR_NUMBER) return String(env.GITHUB_PR_NUMBER);

  if (env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)) {
    try {
      const payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
      const prNumber = payload.pull_request?.number || payload.issue?.number || null;
      if (prNumber) return String(prNumber);
    } catch {
      // Ignore malformed GitHub event payloads.
    }
  }

  return null;
}

export function resolveBranchFromEnv(env = process.env) {
  return env.SWITCHMAN_BRANCH
    || env.GITHUB_HEAD_REF
    || env.GITHUB_REF_NAME
    || null;
}
