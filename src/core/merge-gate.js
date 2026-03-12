import { getTaskSpec, listTasks, logAuditEvent } from './db.js';
import { scanAllWorktrees } from './detector.js';

const RISK_PATTERNS = [
  { key: 'auth', regex: /(^|\/)(auth|login|session|permissions?|rbac|acl)(\/|$)/i, label: 'authentication or permissions' },
  { key: 'schema', regex: /(^|\/)(schema|migrations?|db|database|sql)(\/|$)|schema\./i, label: 'schema or database' },
  { key: 'config', regex: /(^|\/)(config|configs|settings)(\/|$)|(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig.*|vite\.config.*|webpack\.config.*|dockerfile|docker-compose.*)$/i, label: 'shared configuration' },
  { key: 'api', regex: /(^|\/)(api|routes?|controllers?)(\/|$)/i, label: 'API surface' },
];

function isTestPath(filePath) {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/i.test(filePath);
}

function isSourcePath(filePath) {
  return /(^|\/)(src|app|lib|server|client)(\/|$)/i.test(filePath) && !isTestPath(filePath);
}

function classifyRiskTags(filePath) {
  return RISK_PATTERNS.filter((pattern) => pattern.regex.test(filePath)).map((pattern) => pattern.key);
}

function describeRiskTag(tag) {
  return RISK_PATTERNS.find((pattern) => pattern.key === tag)?.label || tag;
}

function pathAreas(filePath) {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length === 0) return [];
  if (parts.length === 1) return [parts[0]];
  if (['src', 'app', 'lib', 'tests', 'test', 'spec'].includes(parts[0])) {
    return [`${parts[0]}/${parts[1]}`];
  }
  return [parts[0]];
}

function intersection(a, b) {
  const setB = new Set(b);
  return [...new Set(a)].filter((item) => setB.has(item));
}

function summarizeWorktree(worktree, changedFiles, complianceState) {
  const sourceFiles = changedFiles.filter(isSourcePath);
  const testFiles = changedFiles.filter(isTestPath);
  const riskTags = [...new Set(changedFiles.flatMap(classifyRiskTags))];
  const areas = [...new Set(changedFiles.flatMap(pathAreas))];
  const findings = [];
  let score = 0;

  if (sourceFiles.length > 0 && testFiles.length === 0) {
    findings.push('source changes without corresponding test updates');
    score += 15;
  }

  if (riskTags.length > 0) {
    findings.push(`touches ${riskTags.map(describeRiskTag).join(', ')}`);
    score += Math.min(25, riskTags.length * 10);
  }

  if (complianceState === 'non_compliant' || complianceState === 'stale') {
    findings.push(`worktree is ${complianceState}`);
    score += 60;
  }

  return {
    worktree: worktree.name,
    branch: worktree.branch ?? 'unknown',
    changed_files: changedFiles,
    source_files: sourceFiles,
    test_files: testFiles,
    risk_tags: riskTags,
    areas,
    findings,
    score,
  };
}

function buildPairAnalysis(left, right, report) {
  const directFileConflict = report.fileConflicts.filter((conflict) =>
    conflict.worktrees.includes(left.worktree) && conflict.worktrees.includes(right.worktree),
  );
  const branchConflict = report.conflicts.find((conflict) =>
    (conflict.worktreeA === left.worktree && conflict.worktreeB === right.worktree)
    || (conflict.worktreeA === right.worktree && conflict.worktreeB === left.worktree),
  ) || null;
  const ownershipConflicts = (report.ownershipConflicts || []).filter((conflict) =>
    (conflict.worktreeA === left.worktree && conflict.worktreeB === right.worktree)
    || (conflict.worktreeA === right.worktree && conflict.worktreeB === left.worktree),
  );
  const sharedAreas = intersection(left.areas, right.areas);
  const sharedRiskTags = intersection(left.risk_tags, right.risk_tags);

  const reasons = [];
  let score = 0;

  if (branchConflict) {
    reasons.push(`git merge conflict predicted between ${left.branch} and ${right.branch}`);
    score = 100;
  }

  if (directFileConflict.length > 0) {
    reasons.push(`direct file overlap in ${directFileConflict.map((item) => item.file).join(', ')}`);
    score = Math.max(score, 95);
  }

  if (ownershipConflicts.length > 0) {
    for (const conflict of ownershipConflicts) {
      if (conflict.type === 'subsystem_overlap') {
        reasons.push(`both worktrees reserve the ${conflict.subsystemTag} subsystem`);
        score = Math.max(score, 85);
      } else if (conflict.type === 'scope_overlap') {
        reasons.push(`both worktrees reserve overlapping scopes (${conflict.scopeA} vs ${conflict.scopeB})`);
        score = Math.max(score, 90);
      }
    }
  }

  if (sharedAreas.length > 0) {
    reasons.push(`both worktrees touch ${sharedAreas.join(', ')}`);
    score += 35;
  }

  if (sharedRiskTags.length > 0) {
    reasons.push(`both worktrees change ${sharedRiskTags.map(describeRiskTag).join(', ')}`);
    score += 25;
  }

  if (left.source_files.length > 0 && left.test_files.length === 0 && sharedAreas.length > 0) {
    reasons.push(`${left.worktree} changes shared source areas without tests`);
    score += 10;
  }

  if (right.source_files.length > 0 && right.test_files.length === 0 && sharedAreas.length > 0) {
    reasons.push(`${right.worktree} changes shared source areas without tests`);
    score += 10;
  }

  if (left.changed_files.length >= 5 && right.changed_files.length >= 5) {
    reasons.push('both worktrees are large enough to raise integration risk');
    score += 10;
  }

  const status = score >= 80 ? 'blocked' : score >= 40 ? 'warn' : 'pass';

  return {
    worktree_a: left.worktree,
    worktree_b: right.worktree,
    branch_a: left.branch,
    branch_b: right.branch,
    status,
    score: Math.min(score, 100),
    reasons,
    shared_areas: sharedAreas,
    shared_risk_tags: sharedRiskTags,
    ownership_conflicts: ownershipConflicts,
    conflicting_files: branchConflict?.conflictingFiles || directFileConflict.map((item) => item.file),
  };
}

function summarizeOverall(pairAnalyses, worktreeAnalyses, boundaryValidations) {
  const blockedPairs = pairAnalyses.filter((item) => item.status === 'blocked');
  const warnedPairs = pairAnalyses.filter((item) => item.status === 'warn');
  const riskyWorktrees = worktreeAnalyses.filter((item) => item.score >= 40);
  const blockedValidations = boundaryValidations.filter((item) => item.severity === 'blocked');
  const warnedValidations = boundaryValidations.filter((item) => item.severity === 'warn');

  if (blockedPairs.length > 0 || blockedValidations.length > 0) {
    return {
      status: 'blocked',
      summary: `AI merge gate blocked: ${blockedPairs.length} risky pair(s) and ${blockedValidations.length} boundary validation issue(s) need resolution.`,
    };
  }
  if (warnedPairs.length > 0 || riskyWorktrees.length > 0 || warnedValidations.length > 0) {
    return {
      status: 'warn',
      summary: `AI merge gate warns: ${warnedPairs.length} pair(s), ${riskyWorktrees.length} worktree(s), or ${warnedValidations.length} boundary validation issue(s) need review.`,
    };
  }
  return {
    status: 'pass',
    summary: 'AI merge gate passed: no elevated semantic merge risks detected.',
  };
}

function evaluateBoundaryValidations(db) {
  const tasks = listTasks(db);
  const specsByTaskId = new Map(tasks.map((task) => [task.id, getTaskSpec(db, task.id)]));
  const tasksByPipeline = new Map();

  for (const task of tasks) {
    const spec = specsByTaskId.get(task.id);
    const pipelineId = spec?.pipeline_id;
    if (!pipelineId) continue;
    if (!tasksByPipeline.has(pipelineId)) tasksByPipeline.set(pipelineId, []);
    tasksByPipeline.get(pipelineId).push({ task, task_spec: spec });
  }

  const findings = [];
  for (const [pipelineId, pipelineTasks] of tasksByPipeline.entries()) {
    const completedTaskTypes = new Set(
      pipelineTasks
        .filter(({ task }) => task.status === 'done')
        .map(({ task_spec }) => task_spec?.task_type)
        .filter(Boolean),
    );

    for (const { task, task_spec: spec } of pipelineTasks) {
      if (!spec?.validation_rules || spec.task_type !== 'implementation') continue;
      if (!['in_progress', 'done'].includes(task.status)) continue;

      const requiredTypes = spec.validation_rules.required_completed_task_types || [];
      const missingTaskTypes = requiredTypes.filter((taskType) => !completedTaskTypes.has(taskType));
      if (missingTaskTypes.length === 0) continue;

      findings.push({
        pipeline_id: pipelineId,
        task_id: task.id,
        worktree: task.worktree || null,
        subsystem_tags: spec.subsystem_tags || [],
        severity: spec.validation_rules.enforcement === 'blocked' ? 'blocked' : 'warn',
        missing_task_types: missingTaskTypes,
        rationale: spec.validation_rules.rationale || [],
        summary: `${task.title} is missing completed ${missingTaskTypes.join(', ')} validation work`,
      });
    }
  }

  return findings;
}

export async function runAiMergeGate(db, repoRoot) {
  const report = await scanAllWorktrees(db, repoRoot);
  const worktreeAnalyses = report.worktrees.map((worktree) => {
    const changedFiles = report.fileMap?.[worktree.name] ?? [];
    const complianceState = report.worktreeCompliance?.find((entry) => entry.worktree === worktree.name)?.compliance_state
      ?? worktree.compliance_state
      ?? 'observed';
    return summarizeWorktree(worktree, changedFiles, complianceState);
  });

  const pairAnalyses = [];
  for (let i = 0; i < worktreeAnalyses.length; i++) {
    for (let j = i + 1; j < worktreeAnalyses.length; j++) {
      pairAnalyses.push(buildPairAnalysis(worktreeAnalyses[i], worktreeAnalyses[j], report));
    }
  }

  const boundaryValidations = evaluateBoundaryValidations(db);
  const overall = summarizeOverall(pairAnalyses, worktreeAnalyses, boundaryValidations);
  const result = {
    ok: overall.status === 'pass',
    status: overall.status,
    summary: overall.summary,
    worktrees: worktreeAnalyses,
    pairs: pairAnalyses,
    boundary_validations: boundaryValidations,
    compliance: report.complianceSummary,
    unclaimed_changes: report.unclaimedChanges,
    branch_conflicts: report.conflicts,
    file_conflicts: report.fileConflicts,
    ownership_conflicts: report.ownershipConflicts || [],
  };

  logAuditEvent(db, {
    eventType: 'ai_merge_gate',
    status: overall.status === 'blocked' ? 'denied' : (overall.status === 'warn' ? 'warn' : 'allowed'),
    reasonCode: overall.status === 'blocked' ? 'semantic_merge_risk' : null,
    details: JSON.stringify({
      status: result.status,
      blocked_pairs: pairAnalyses.filter((item) => item.status === 'blocked').length,
      warned_pairs: pairAnalyses.filter((item) => item.status === 'warn').length,
      blocked_boundary_validations: boundaryValidations.filter((item) => item.severity === 'blocked').length,
      warned_boundary_validations: boundaryValidations.filter((item) => item.severity === 'warn').length,
    }),
  });

  return result;
}
