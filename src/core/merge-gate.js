import { getTask, listBoundaryValidationStates, listDependencyInvalidations, logAuditEvent } from './db.js';
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
  const semanticConflicts = (report.semanticConflicts || []).filter((conflict) =>
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

  if (semanticConflicts.length > 0) {
    for (const conflict of semanticConflicts) {
      if (conflict.type === 'semantic_object_overlap') {
        reasons.push(`both worktrees changed exported ${conflict.object_kind} ${conflict.object_name}`);
        score = Math.max(score, 92);
      } else if (conflict.type === 'semantic_name_overlap') {
        reasons.push(`both worktrees changed semantically similar object ${conflict.object_name}`);
        score = Math.max(score, 65);
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
    semantic_conflicts: semanticConflicts,
    conflicting_files: branchConflict?.conflictingFiles || directFileConflict.map((item) => item.file),
  };
}

function summarizeOverall(pairAnalyses, worktreeAnalyses, boundaryValidations, dependencyInvalidations) {
  const blockedPairs = pairAnalyses.filter((item) => item.status === 'blocked');
  const warnedPairs = pairAnalyses.filter((item) => item.status === 'warn');
  const riskyWorktrees = worktreeAnalyses.filter((item) => item.score >= 40);
  const blockedValidations = boundaryValidations.filter((item) => item.severity === 'blocked');
  const warnedValidations = boundaryValidations.filter((item) => item.severity === 'warn');
  const blockedInvalidations = dependencyInvalidations.filter((item) => item.severity === 'blocked');
  const warnedInvalidations = dependencyInvalidations.filter((item) => item.severity === 'warn');
  const activeWorktrees = worktreeAnalyses.filter((item) => item.changed_files.length > 0);
  const totalChangedFiles = activeWorktrees.reduce((sum, item) => sum + item.changed_files.length, 0);
  const largeWorktrees = activeWorktrees.filter((item) => item.changed_files.length >= 8).length;
  const broadAreas = new Set(activeWorktrees.flatMap((item) => item.areas)).size;
  const ambiguityReasons = [];

  if (blockedPairs.length > 0 || blockedValidations.length > 0 || blockedInvalidations.length > 0) {
    return {
      status: 'blocked',
      summary: `AI merge gate blocked: ${blockedPairs.length} risky pair(s), ${blockedValidations.length} boundary validation issue(s), and ${blockedInvalidations.length} stale dependency issue(s) need resolution.`,
      uncertain_reasons: [],
    };
  }
  if (warnedPairs.length > 0 || warnedValidations.length > 0 || warnedInvalidations.length > 0) {
    return {
      status: 'warn',
      summary: `AI merge gate warns: ${warnedPairs.length} pair(s), ${warnedValidations.length} boundary validation issue(s), or ${warnedInvalidations.length} stale dependency issue(s) need review.`,
      uncertain_reasons: [],
    };
  }
  if (activeWorktrees.length >= 3 && totalChangedFiles >= 18) {
    ambiguityReasons.push(`significant changes span ${activeWorktrees.length} worktrees and ${totalChangedFiles} files`);
  }
  if (largeWorktrees >= 2 && broadAreas >= 3) {
    ambiguityReasons.push(`large worktrees fan out across ${broadAreas} shared code areas`);
  }
  if (ambiguityReasons.length > 0) {
    return {
      status: 'uncertain',
      summary: `AI merge gate is uncertain: ${ambiguityReasons.join('; ')}. Manual review recommended.`,
      uncertain_reasons: ambiguityReasons,
    };
  }
  return {
    status: 'pass',
    summary: riskyWorktrees.length > 0
      ? `AI merge gate passed: no cross-worktree merge risks detected. ${riskyWorktrees.length} worktree(s) still have local risk signals worth reviewing if you are about to merge them.`
      : 'AI merge gate passed: no elevated semantic merge risks detected.',
    uncertain_reasons: [],
  };
}

function summarizeHotspots(pairAnalyses = [], worktreeAnalyses = []) {
  const areaCounts = new Map();
  const riskTagCounts = new Map();
  const riskyPairs = pairAnalyses.filter((item) => item.status !== 'pass');
  const riskyWorktrees = worktreeAnalyses.filter((item) => item.findings.length > 0);

  const bump = (map, values = []) => {
    for (const value of values) {
      if (!value) continue;
      map.set(value, (map.get(value) || 0) + 1);
    }
  };

  for (const pair of riskyPairs) {
    bump(areaCounts, pair.shared_areas || []);
    bump(riskTagCounts, pair.shared_risk_tags || []);
  }
  for (const worktree of riskyWorktrees) {
    bump(areaCounts, worktree.areas || []);
    bump(riskTagCounts, worktree.risk_tags || []);
  }

  const sortCounts = (map) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([name, count]) => ({ name, count }));

  return {
    shared_areas: sortCounts(areaCounts),
    shared_risk_tags: sortCounts(riskTagCounts),
  };
}

function evaluateBoundaryValidations(db) {
  return listBoundaryValidationStates(db)
    .filter((state) => state.status === 'blocked' || state.status === 'pending_validation')
    .map((state) => {
      const task = getTask(db, state.task_id);
      return {
        pipeline_id: state.pipeline_id,
        task_id: state.task_id,
        worktree: task?.worktree || null,
        severity: state.status === 'blocked' ? 'blocked' : 'warn',
        missing_task_types: state.missing_task_types || [],
        rationale: state.details?.rationale || [],
        subsystem_tags: state.details?.subsystem_tags || [],
        summary: `${task?.title || state.task_id} is missing completed ${(state.missing_task_types || []).join(', ')} validation work`,
        touched_at: state.touched_at,
        validation_status: state.status,
      };
    });
}

function evaluateDependencyInvalidations(db) {
  return listDependencyInvalidations(db, { status: 'stale' })
    .map((state) => {
      const affectedTask = getTask(db, state.affected_task_id);
      const details = state.details || {};
      const severity = details.severity || (affectedTask?.status === 'done' ? 'blocked' : 'warn');
      const staleArea = state.reason_type === 'subsystem_overlap'
        ? `subsystem:${state.subsystem_tag}`
        : state.reason_type === 'semantic_contract_drift'
          ? `contract:${(details.contract_names || []).join('|') || 'unknown'}`
        : state.reason_type === 'semantic_object_overlap'
          ? `object:${(details.object_names || []).join('|') || 'unknown'}`
        : state.reason_type === 'shared_module_drift'
          ? `module:${(details.module_paths || []).join('|') || 'unknown'}`
        : `${state.source_scope_pattern} ↔ ${state.affected_scope_pattern}`;
      const summary = state.reason_type === 'semantic_contract_drift'
        ? `${details.source_task_title || state.source_task_id} changed shared contract ${(details.contract_names || []).join(', ') || 'unknown'}`
        : state.reason_type === 'semantic_object_overlap'
          ? `${details.source_task_title || state.source_task_id} changed shared exported object ${(details.object_names || []).join(', ') || 'unknown'}`
          : state.reason_type === 'shared_module_drift'
            ? `${details.source_task_title || state.source_task_id} changed shared module ${(details.module_paths || []).join(', ') || 'unknown'} used by ${(details.dependent_files || []).join(', ') || state.affected_task_id}`
          : `${affectedTask?.title || state.affected_task_id} is stale because ${details?.source_task_title || state.source_task_id} changed shared ${staleArea}`;
      return {
        source_lease_id: state.source_lease_id,
        source_task_id: state.source_task_id,
        source_pipeline_id: state.source_pipeline_id,
        source_worktree: state.source_worktree,
        affected_task_id: state.affected_task_id,
        affected_pipeline_id: state.affected_pipeline_id,
        affected_worktree: state.affected_worktree,
        affected_task_status: affectedTask?.status || null,
        severity,
        reason_type: state.reason_type,
        subsystem_tag: state.subsystem_tag,
        source_scope_pattern: state.source_scope_pattern,
        affected_scope_pattern: state.affected_scope_pattern,
        summary,
        stale_area: staleArea,
        created_at: state.created_at,
        details,
      };
    });
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
  const dependencyInvalidations = evaluateDependencyInvalidations(db);
  const overall = summarizeOverall(pairAnalyses, worktreeAnalyses, boundaryValidations, dependencyInvalidations);
  const hotspots = summarizeHotspots(pairAnalyses, worktreeAnalyses);
  const result = {
    ok: overall.status === 'pass',
    status: overall.status,
    summary: overall.summary,
    uncertain_reasons: overall.uncertain_reasons || [],
    shared_areas: hotspots.shared_areas,
    shared_risk_tags: hotspots.shared_risk_tags,
    worktrees: worktreeAnalyses,
    pairs: pairAnalyses,
    boundary_validations: boundaryValidations,
    dependency_invalidations: dependencyInvalidations,
    compliance: report.complianceSummary,
    unclaimed_changes: report.unclaimedChanges,
    branch_conflicts: report.conflicts,
    file_conflicts: report.fileConflicts,
    ownership_conflicts: report.ownershipConflicts || [],
    semantic_conflicts: report.semanticConflicts || [],
  };

  logAuditEvent(db, {
    eventType: 'ai_merge_gate',
    status: overall.status === 'blocked' ? 'denied' : (overall.status === 'warn' || overall.status === 'uncertain' ? 'warn' : 'allowed'),
    reasonCode: overall.status === 'blocked' ? 'semantic_merge_risk' : (overall.status === 'uncertain' ? 'semantic_merge_uncertain' : null),
    details: JSON.stringify({
      status: result.status,
      uncertain_reasons: result.uncertain_reasons,
      shared_areas: result.shared_areas,
      shared_risk_tags: result.shared_risk_tags,
      blocked_pairs: pairAnalyses.filter((item) => item.status === 'blocked').length,
      warned_pairs: pairAnalyses.filter((item) => item.status === 'warn').length,
      blocked_boundary_validations: boundaryValidations.filter((item) => item.severity === 'blocked').length,
      warned_boundary_validations: boundaryValidations.filter((item) => item.severity === 'warn').length,
      blocked_dependency_invalidations: dependencyInvalidations.filter((item) => item.severity === 'blocked').length,
      warned_dependency_invalidations: dependencyInvalidations.filter((item) => item.severity === 'warn').length,
    }),
  });

  return result;
}
