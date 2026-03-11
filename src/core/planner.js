const DOMAIN_RULES = [
  { key: 'auth', regex: /\b(auth|login|session|oauth|permission|rbac|token)\b/i, source: ['src/auth/**', 'app/auth/**', 'lib/auth/**', 'server/auth/**', 'client/auth/**'] },
  { key: 'api', regex: /\b(api|endpoint|route|graphql|rest|handler)\b/i, source: ['src/api/**', 'app/api/**', 'server/api/**', 'routes/**'] },
  { key: 'schema', regex: /\b(schema|migration|database|db|sql|prisma)\b/i, source: ['db/**', 'database/**', 'migrations/**', 'prisma/**', 'schema/**', 'src/db/**'] },
  { key: 'config', regex: /\b(config|configuration|env|feature flag|settings?)\b/i, source: ['config/**', '.github/**', '.switchman/**', 'src/config/**'] },
  { key: 'payments', regex: /\b(payment|billing|invoice|checkout|subscription|stripe)\b/i, source: ['src/payments/**', 'app/payments/**', 'lib/payments/**', 'server/payments/**'] },
  { key: 'ui', regex: /\b(ui|ux|frontend|component|screen|page|layout)\b/i, source: ['src/components/**', 'src/ui/**', 'app/**', 'client/**'] },
  { key: 'infra', regex: /\b(deploy|infra|infrastructure|build|pipeline|docker|kubernetes|terraform)\b/i, source: ['infra/**', '.github/**', 'docker/**', 'scripts/**'] },
  { key: 'docs', regex: /\b(docs?|readme|documentation|integration notes)\b/i, source: ['docs/**', 'README.md'] },
];

function uniq(values) {
  return [...new Set(values)];
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

function deriveSubtaskTitles(title, description) {
  const checklistItems = extractChecklistItems(description);
  if (checklistItems.length > 0) return checklistItems;

  const text = `${title}\n${description || ''}`.toLowerCase();
  const subtasks = [];
  const domains = detectDomains(text);
  const highRisk = /\b(auth|payment|schema|migration|security|permission|billing)\b/.test(text);

  const docsOnly = /\b(docs?|readme|documentation)\b/.test(text)
    && !/\b(api|auth|bug|feature|fix|refactor|schema|migration|config|build|test)\b/.test(text);

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
  if (/\b(auth|payment|schema|migration|security|permission|billing)\b/.test(text)) return 'high';
  if (/\b(api|config|deploy|build|infra)\b/.test(text)) return 'medium';
  return 'low';
}

function inferAllowedPaths(taskType, domains = ['general']) {
  const sourceRoots = uniq(domains.flatMap((domain) =>
    DOMAIN_RULES.find((rule) => rule.key === domain)?.source || [],
  ));

  if (taskType === 'tests') {
    return uniq([
      'tests/**',
      '__tests__/**',
      'spec/**',
      'specs/**',
      'test/**',
      ...domains.filter((domain) => domain !== 'general').flatMap((domain) => [
        `tests/${domain}/**`,
        `__tests__/${domain}/**`,
        `spec/${domain}/**`,
      ]),
    ]);
  }
  if (taskType === 'docs') {
    return uniq(['docs/**', 'README.md', 'README/**', ...domains.map((domain) => `docs/${domain}/**`)]);
  }
  if (taskType === 'governance') {
    return uniq(['.switchman/**', '.github/**', 'docs/**', 'README.md', ...sourceRoots, 'tests/**']);
  }
  return sourceRoots.length > 0
    ? sourceRoots
    : ['src/**', 'app/**', 'lib/**', 'server/**', 'client/**', 'packages/**'];
}

function inferExpectedOutputTypes(taskType) {
  if (taskType === 'tests') return ['tests'];
  if (taskType === 'docs') return ['docs'];
  if (taskType === 'governance') return ['config', 'docs'];
  return ['source'];
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
    if (riskLevel === 'high') {
      deliverables.push('tests');
    }
    if (domains.some((domain) => ['api', 'schema', 'config'].includes(domain))) {
      deliverables.push('docs');
    }
  } else if (taskType === 'tests') {
    deliverables.push('tests');
  } else if (taskType === 'docs') {
    deliverables.push('docs');
  } else if (taskType === 'governance') {
    deliverables.push('docs');
  }

  return uniq(deliverables);
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

export function buildTaskSpec({ pipelineId, taskId, title, issueTitle, issueDescription = null, suggestedWorktree = null, dependencies = [] }) {
  const taskType = inferTaskType(title);
  const text = `${issueTitle}\n${issueDescription || ''}\n${title}`.toLowerCase();
  const domains = detectDomains(text);
  const allowedPaths = inferAllowedPaths(taskType, domains);
  const expectedOutputTypes = inferExpectedOutputTypes(taskType);
  const riskLevel = inferRiskLevel(text);

  return {
    pipeline_id: pipelineId,
    task_id: taskId,
    task_type: taskType,
    objective: title,
    issue_title: issueTitle,
    suggested_worktree: suggestedWorktree,
    dependencies,
    subsystem_tags: domains,
    objective_keywords: extractObjectiveKeywords(title, domains),
    allowed_paths: allowedPaths,
    expected_output_types: expectedOutputTypes,
    required_deliverables: buildRequiredDeliverables({ taskType, riskLevel, domains }),
    success_criteria: buildSuccessCriteria({ taskType, allowedPaths, dependencies }),
    risk_level: riskLevel,
    execution_policy: buildExecutionPolicy({ taskType, riskLevel }),
  };
}

export function planPipelineTasks({ pipelineId, title, description = null, worktrees = [], maxTasks = 5 }) {
  const subtaskTitles = deriveSubtaskTitles(title, description).slice(0, maxTasks);
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
