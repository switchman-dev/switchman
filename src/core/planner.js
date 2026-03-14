import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';

import { loadChangePolicy } from './policy.js';

const DOMAIN_RULES = [
  { key: 'auth', regex: /\b(auth|login|session|oauth|permission|rbac|token)\b/i, source: ['src/auth/**', 'app/auth/**', 'lib/auth/**', 'server/auth/**', 'client/auth/**'] },
  { key: 'api', regex: /\b(api|endpoint|route|graphql|rest|handler)\b/i, source: ['src/api/**', 'app/api/**', 'server/api/**', 'routes/**'] },
  { key: 'schema', regex: /\b(schema|migration|database|db|sql|prisma)\b/i, source: ['db/**', 'database/**', 'migrations/**', 'prisma/**', 'schema/**', 'src/db/**'] },
  { key: 'config', regex: /\b(config|configuration|env|feature flag|settings?)\b/i, source: ['config/**', '.github/**', '.switchman/**', 'src/config/**'] },
  { key: 'payments', regex: /\b(payments?|billing|invoice|checkout|subscription|stripe)\b/i, source: ['src/payments/**', 'app/payments/**', 'lib/payments/**', 'server/payments/**'] },
  { key: 'ui', regex: /\b(ui|ux|frontend|component|screen|page|layout)\b/i, source: ['src/components/**', 'src/ui/**', 'app/**', 'client/**'] },
  { key: 'infra', regex: /\b(deploy|infra|infrastructure|build|pipeline|docker|kubernetes|terraform)\b/i, source: ['infra/**', '.github/**', 'docker/**', 'scripts/**'] },
  { key: 'docs', regex: /\b(docs?|readme|documentation|integration notes)\b/i, source: ['docs/**', 'README.md'] },
];

function uniq(values) {
  return [...new Set(values)];
}

function isTestPath(filePath) {
  return /(^|\/)(__tests__|tests?|spec|specs)(\/|$)|\.(test|spec)\.[^.]+$/i.test(filePath);
}

function isDocsPath(filePath) {
  return /(^|\/)(docs?|readme)(\/|$)|(^|\/)README(\.[^.]+)?$/i.test(filePath);
}

function isSourcePath(filePath) {
  return !isTestPath(filePath) && !isDocsPath(filePath);
}

function stripGlobSuffix(pathPattern) {
  return String(pathPattern || '').replace(/\/\*\*$/, '');
}

function extractChecklistItems(description) {
  if (!description) return [];
  return description
    .split('\n')
    .map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.*\S)\s*$/)?.[1] || null)
    .filter(Boolean);
}

function detectDomains(text) {
  const matches = DOMAIN_RULES
    .filter((rule) => rule.regex.test(text))
    .map((rule) => rule.key);
  return matches.length > 0 ? matches : ['general'];
}

function safeReadDir(rootPath) {
  try {
    return readdirSync(rootPath);
  } catch {
    return [];
  }
}

function walkRepoFiles(rootPath, currentPath = '', depth = 0, maxDepth = 4) {
  if (!rootPath || depth > maxDepth) return [];
  const absolutePath = currentPath ? join(rootPath, currentPath) : rootPath;
  let entries;
  try {
    entries = readdirSync(absolutePath);
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry === '.git' || entry === '.switchman' || entry === 'node_modules') continue;
    const relativePath = currentPath ? join(currentPath, entry) : entry;
    const entryPath = join(rootPath, relativePath);
    let stats;
    try {
      stats = statSync(entryPath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      files.push(...walkRepoFiles(rootPath, relativePath, depth + 1, maxDepth));
    } else if (stats.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

function listRepoFiles(repoRoot) {
  if (!repoRoot) return [];
  try {
    const output = execSync('git ls-files', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const trackedFiles = output.split('\n').filter(Boolean);
    if (trackedFiles.length > 0) return trackedFiles;
  } catch {
    // Fall back to a shallow filesystem walk for non-git fixtures.
  }
  return walkRepoFiles(repoRoot);
}

function buildRepoContext(repoRoot) {
  if (!repoRoot) {
    return {
      repo_root: null,
      files: [],
      lower_files: [],
      test_roots: [],
      docs_roots: [],
      domain_roots: {},
      package_roots: [],
    };
  }

  const files = listRepoFiles(repoRoot);
  const lowerFiles = files.map((filePath) => filePath.toLowerCase());
  const testRoots = ['tests', '__tests__', 'test', 'spec', 'specs'].filter((root) => existsSync(join(repoRoot, root)));
  const docsRoots = uniq([
    ...(existsSync(join(repoRoot, 'docs')) ? ['docs'] : []),
    ...(existsSync(join(repoRoot, 'README.md')) ? ['README.md'] : []),
  ]);
  const domainRoots = Object.fromEntries(DOMAIN_RULES.map((rule) => {
    const existingRoots = uniq(rule.source
      .map(stripGlobSuffix)
      .filter((root) => existsSync(join(repoRoot, root))));
    return [rule.key, existingRoots];
  }));
  const packageRoots = safeReadDir(join(repoRoot, 'packages'))
    .map((name) => `packages/${name}`)
    .filter((packagePath) => existsSync(join(repoRoot, packagePath)));

  return {
    repo_root: repoRoot,
    files,
    lower_files: lowerFiles,
    test_roots: testRoots,
    docs_roots: docsRoots,
    domain_roots: domainRoots,
    package_roots: packageRoots,
  };
}

function deriveSubtaskTitles(title, description) {
  const checklistItems = extractChecklistItems(description);
  if (checklistItems.length > 0) return checklistItems;

  const text = `${title}\n${description || ''}`.toLowerCase();
  const subtasks = [];
  const domains = detectDomains(text);
  const highRisk = /\b(auth|payments?|schema|migration|security|permission|billing)\b/.test(text);

  const docsOnly = /\b(docs?|readme|documentation)\b/.test(text)
    && !/\b(auth|bug|feature|fix|refactor|schema|migration|config|build|test|implement|route|handler|endpoint|model)\b/.test(text);

  if (docsOnly) {
    return [`Update docs for: ${title}`];
  }

  subtasks.push(`Implement: ${title}`);

  if (!/\b(test|spec)\b/.test(text)) {
    subtasks.push(`Add or update tests for: ${title}`);
  }

  if (/\b(api|public|config|migration|schema|docs?|readme)\b/.test(text)) {
    subtasks.push(`Update integration notes for: ${title}`);
  }

  if (highRisk && domains.some((domain) => ['auth', 'payments', 'schema', 'config'].includes(domain))) {
    subtasks.push(`Review safety constraints for: ${title}`);
  }

  return subtasks;
}

function inferRiskLevel(text) {
  if (/\b(auth|payments?|schema|migration|security|permission|billing)\b/.test(text)) return 'high';
  if (/\b(api|config|deploy|build|infra)\b/.test(text)) return 'medium';
  return 'low';
}

function summarizeRelevantPaths(filePaths = []) {
  const summarized = [];
  for (const filePath of filePaths) {
    const segments = filePath.split('/');
    if (segments.length >= 2) {
      summarized.push(`${segments[0]}/${segments[1]}/**`);
    } else {
      summarized.push(filePath);
    }
  }
  return uniq(summarized);
}

function inferRelevantRepoFiles(repoContext, objectiveKeywords = [], domains = [], taskType = 'implementation') {
  if (!repoContext || objectiveKeywords.length === 0) return [];

  const candidates = repoContext.files
    .filter((filePath) => {
      if (taskType === 'tests') return isTestPath(filePath);
      if (taskType === 'docs') return isDocsPath(filePath);
      if (taskType === 'governance') return isDocsPath(filePath) || /^\.github\//.test(filePath) || /^\.switchman\//.test(filePath);
      return isSourcePath(filePath);
    })
    .map((filePath) => {
      const lower = filePath.toLowerCase();
      const basenameLower = basename(filePath).toLowerCase();
      const keywordHits = objectiveKeywords.filter((keyword) => lower.includes(keyword) || basenameLower.includes(keyword));
      const domainHits = domains.filter((domain) => domain !== 'general' && lower.includes(domain));
      return {
        filePath,
        score: (keywordHits.length * 3) + (domainHits.length * 2),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
    .slice(0, 8);

  return candidates.map((entry) => entry.filePath);
}

function inferAllowedPaths(taskType, domains = ['general'], repoContext = null, objectiveKeywords = []) {
  const sourceRoots = uniq(domains.flatMap((domain) =>
    repoContext?.domain_roots?.[domain]?.length > 0
      ? repoContext.domain_roots[domain].map((root) => `${root}/**`)
      : (DOMAIN_RULES.find((rule) => rule.key === domain)?.source || []),
  ));
  const relevantPaths = summarizeRelevantPaths(inferRelevantRepoFiles(repoContext, objectiveKeywords, domains, taskType));

  if (taskType === 'tests') {
    return uniq([
      ...(repoContext?.test_roots?.length > 0 ? repoContext.test_roots.map((root) => `${root}/**`) : ['tests/**', '__tests__/**', 'spec/**', 'specs/**', 'test/**']),
      ...domains.filter((domain) => domain !== 'general').flatMap((domain) => [
        `tests/${domain}/**`,
        `__tests__/${domain}/**`,
        `spec/${domain}/**`,
      ]),
      ...relevantPaths,
    ]);
  }
  if (taskType === 'docs') {
    return uniq([
      ...(repoContext?.docs_roots?.length > 0
        ? repoContext.docs_roots.flatMap((root) => root === 'README.md' ? ['README.md'] : [`${root}/**`])
        : ['docs/**', 'README.md', 'README/**']),
      ...domains.map((domain) => `docs/${domain}/**`),
      ...relevantPaths,
    ]);
  }
  if (taskType === 'governance') {
    return uniq([
      '.switchman/**',
      '.github/**',
      'docs/**',
      'README.md',
      ...sourceRoots,
      ...(repoContext?.test_roots?.length > 0 ? repoContext.test_roots.map((root) => `${root}/**`) : ['tests/**']),
    ]);
  }
  if (relevantPaths.length > 0) {
    return uniq([...relevantPaths, ...sourceRoots]);
  }
  return sourceRoots.length > 0
    ? sourceRoots
    : [
      'src/**',
      'app/**',
      'lib/**',
      'server/**',
      'client/**',
      ...(repoContext?.package_roots?.length > 0 ? repoContext.package_roots.map((root) => `${root}/**`) : ['packages/**']),
    ];
}

function inferExpectedOutputTypes(taskType) {
  if (taskType === 'tests') return ['tests'];
  if (taskType === 'docs') return ['docs'];
  if (taskType === 'governance') return ['config', 'docs'];
  return ['source'];
}

function buildPrimaryOutputPath({ taskType, pipelineId, taskId }) {
  if (taskType === 'governance') {
    return `docs/reviews/${pipelineId}/${taskId}.md`;
  }
  return null;
}

function inferTaskType(title) {
  if (/^Add or update tests/.test(title) || /\btests?\b/i.test(title)) return 'tests';
  if (/^Update integration notes/.test(title) || /\bdocs?|readme|integration notes\b/i.test(title)) return 'docs';
  if (/^Review |^Govern /.test(title)) return 'governance';
  return 'implementation';
}

function buildExecutionPolicy({ taskType, riskLevel }) {
  const policy = {
    timeout_ms: 45000,
    max_retries: 1,
    retry_backoff_ms: 500,
  };

  if (taskType === 'docs') {
    policy.timeout_ms = 15000;
    policy.max_retries = 0;
    policy.retry_backoff_ms = 0;
  } else if (taskType === 'tests') {
    policy.timeout_ms = 30000;
    policy.max_retries = 1;
    policy.retry_backoff_ms = 250;
  } else if (taskType === 'governance') {
    policy.timeout_ms = 20000;
    policy.max_retries = 0;
    policy.retry_backoff_ms = 0;
  }

  if (riskLevel === 'medium') {
    policy.timeout_ms = Math.max(policy.timeout_ms, 60000);
    policy.retry_backoff_ms = Math.max(policy.retry_backoff_ms, 1000);
  }

  if (riskLevel === 'high') {
    policy.timeout_ms = Math.max(policy.timeout_ms, 90000);
    policy.max_retries = Math.min(policy.max_retries, 1);
    policy.retry_backoff_ms = Math.max(policy.retry_backoff_ms, 1500);
  }

  return policy;
}

function buildSuccessCriteria({ taskType, allowedPaths, dependencies }) {
  const criteria = [`stay within task scope: ${allowedPaths.join(', ')}`];
  if (dependencies.length > 0) {
    criteria.push(`wait for dependencies: ${dependencies.join(', ')}`);
  }
  if (taskType === 'tests') criteria.push('change at least one test file');
  if (taskType === 'docs') criteria.push('change at least one docs or README file');
  if (taskType === 'implementation') criteria.push('change at least one source file');
  if (taskType === 'governance') criteria.push('produce a governed follow-up or policy change');
  return criteria;
}

function buildRequiredDeliverables({ taskType, riskLevel, domains }) {
  const deliverables = [];

  if (taskType === 'implementation') {
    deliverables.push('source');
  } else if (taskType === 'tests') {
    deliverables.push('tests');
  } else if (taskType === 'docs') {
    deliverables.push('docs');
  } else if (taskType === 'governance') {
    deliverables.push('docs');
  }

  return uniq(deliverables);
}

function buildFollowupDeliverables({ taskType, riskLevel, domains }) {
  const deliverables = [];

  if (taskType === 'implementation') {
    if (riskLevel === 'high') {
      deliverables.push('tests');
    }
    if (domains.some((domain) => ['api', 'schema', 'config'].includes(domain))) {
      deliverables.push('docs');
    }
  }

  return uniq(deliverables);
}

function buildValidationRules({ taskType, riskLevel, domains, changePolicy = null }) {
  if (taskType !== 'implementation') {
    return {
      enforcement: 'none',
      required_completed_task_types: [],
      rationale: [],
    };
  }

  const requiredCompletedTaskTypes = [];
  const rationale = [];

  if (riskLevel === 'high') {
    requiredCompletedTaskTypes.push('tests');
    rationale.push('high-risk implementation must be backed by completed test work');
  }

  if (domains.some((domain) => ['auth', 'payments', 'schema', 'config'].includes(domain))) {
    requiredCompletedTaskTypes.push('governance');
    rationale.push('sensitive ownership boundaries require completed governance review');
  }

  if (domains.some((domain) => ['api', 'schema', 'config'].includes(domain))) {
    requiredCompletedTaskTypes.push('docs');
    rationale.push('public or shared boundaries require updated docs or integration notes');
  }

  const matchedPolicyRules = domains
    .map((domain) => changePolicy?.domain_rules?.[domain] || null)
    .filter(Boolean);
  for (const rule of matchedPolicyRules) {
    requiredCompletedTaskTypes.push(...(rule.required_completed_task_types || []));
    rationale.push(...(rule.rationale || []));
  }

  const enforcementRank = { none: 0, warn: 1, blocked: 2 };
  const defaultEnforcement = domains.some((domain) => ['auth', 'payments', 'schema'].includes(domain))
    ? 'blocked'
    : (requiredCompletedTaskTypes.length > 0 ? 'warn' : 'none');
  const policyEnforcement = matchedPolicyRules
    .map((rule) => rule.enforcement || 'none')
    .reduce((highest, current) =>
      enforcementRank[current] > enforcementRank[highest] ? current : highest, 'none');
  const enforcement = enforcementRank[policyEnforcement] > enforcementRank[defaultEnforcement]
    ? policyEnforcement
    : defaultEnforcement;

  return {
    enforcement,
    required_completed_task_types: uniq(requiredCompletedTaskTypes),
    rationale: uniq(rationale),
  };
}

function extractObjectiveKeywords(title, domains = []) {
  const rawWords = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const stopWords = new Set([
    'add', 'and', 'for', 'from', 'the', 'with', 'into', 'onto', 'update', 'implement', 'review',
    'safety', 'constraints', 'notes', 'docs', 'documentation', 'tests', 'test', 'or', 'of', 'to',
  ]);
  return uniq([
    ...domains,
    ...rawWords.filter((word) => word.length >= 4 && !stopWords.has(word)),
  ]).slice(0, 8);
}

export function buildTaskSpec({ pipelineId, taskId, title, issueTitle, issueDescription = null, suggestedWorktree = null, dependencies = [], repoContext = null, changePolicy = null }) {
  const taskType = inferTaskType(title);
  const text = `${issueTitle}\n${issueDescription || ''}\n${title}`.toLowerCase();
  const domains = detectDomains(text);
  const objectiveKeywords = extractObjectiveKeywords(title, domains);
  const riskLevel = inferRiskLevel(text);
  const primaryOutputPath = buildPrimaryOutputPath({ taskType, pipelineId, taskId });
  const allowedPaths = uniq([
    ...inferAllowedPaths(taskType, domains, repoContext, objectiveKeywords),
    ...(primaryOutputPath ? [primaryOutputPath] : []),
  ]);
  const expectedOutputTypes = inferExpectedOutputTypes(taskType);

  return {
    pipeline_id: pipelineId,
    task_id: taskId,
    task_type: taskType,
    objective: title,
    issue_title: issueTitle,
    suggested_worktree: suggestedWorktree,
    dependencies,
    subsystem_tags: domains,
    objective_keywords: objectiveKeywords,
    primary_output_path: primaryOutputPath,
    allowed_paths: allowedPaths,
    expected_output_types: expectedOutputTypes,
    required_deliverables: buildRequiredDeliverables({ taskType, riskLevel, domains }),
    followup_deliverables: buildFollowupDeliverables({ taskType, riskLevel, domains }),
    validation_rules: buildValidationRules({ taskType, riskLevel, domains, changePolicy }),
    success_criteria: buildSuccessCriteria({ taskType, allowedPaths, dependencies }),
    risk_level: riskLevel,
    execution_policy: buildExecutionPolicy({ taskType, riskLevel }),
  };
}

export function planPipelineTasks({ pipelineId, title, description = null, worktrees = [], maxTasks = 5, repoRoot = null }) {
  const subtaskTitles = deriveSubtaskTitles(title, description).slice(0, maxTasks);
  const repoContext = buildRepoContext(repoRoot);
  const changePolicy = loadChangePolicy(repoRoot);
  let implementationTaskId = null;

  return subtaskTitles.map((subtaskTitle, index) => {
    const suggestedWorktree = worktrees.length > 0 ? worktrees[index % worktrees.length].name : null;
    const taskId = `${pipelineId}-${String(index + 1).padStart(2, '0')}`;
    const dependencies = [];
    const taskType = inferTaskType(subtaskTitle);

    if (implementationTaskId && (taskType === 'tests' || taskType === 'docs')) {
      dependencies.push(implementationTaskId);
    }

    const taskSpec = buildTaskSpec({
      pipelineId,
      taskId,
      title: subtaskTitle,
      issueTitle: title,
      issueDescription: description,
      suggestedWorktree,
      dependencies,
      repoContext,
      changePolicy,
    });

    const task = {
      id: taskId,
      title: subtaskTitle,
      suggested_worktree: suggestedWorktree,
      dependencies,
      task_spec: taskSpec,
    };

    if (taskSpec.task_type === 'implementation' && !implementationTaskId) {
      implementationTaskId = taskId;
    }

    return task;
  });
}
