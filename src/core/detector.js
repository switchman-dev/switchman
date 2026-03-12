/**
 * switchman - Conflict Detector
 * Scans all registered worktrees for file-level and branch-level conflicts
 */

import { listScopeReservations, listWorktrees } from './db.js';
import {
  listGitWorktrees,
  getWorktreeChangedFiles,
  checkMergeConflicts,
} from './git.js';
import { filterIgnoredPaths } from './ignore.js';
import { evaluateRepoCompliance } from './enforcement.js';
import { buildSemanticIndexForPath, detectSemanticConflicts } from './semantic.js';

/**
 * Scan all worktrees for conflicts.
 * Returns a full conflict report.
 */
export async function scanAllWorktrees(db, repoRoot) {
  const dbWorktrees = listWorktrees(db);
  const gitWorktrees = listGitWorktrees(repoRoot);

  // Build a unified list, merging db metadata with git reality
  const worktrees = mergeWorktreeInfo(dbWorktrees, gitWorktrees);
  const enforcement = evaluateRepoCompliance(db, repoRoot, worktrees);

  if (worktrees.length < 2) {
    return {
      worktrees,
      fileMap: {},
      conflicts: [],
      fileConflicts: [],
      ownershipConflicts: detectOwnershipOverlaps(db),
      semanticConflicts: [],
      unclaimedChanges: enforcement.unclaimedChanges,
      worktreeCompliance: enforcement.worktreeCompliance,
      complianceSummary: enforcement.complianceSummary,
      deniedWrites: enforcement.deniedWrites,
      commitGateFailures: enforcement.commitGateFailures,
      scannedAt: new Date().toISOString(),
      summary: 'Less than 2 worktrees. Nothing to compare.',
    };
  }

  // Step 1: Get changed files per worktree
  const fileMap = {}; // worktree name -> [files]
  for (const wt of worktrees) {
    if (wt.path) {
      fileMap[wt.name] = getWorktreeChangedFiles(wt.path, repoRoot);
    }
  }

  // Step 2: Detect file-level overlaps (fast, always available)
  const fileConflicts = detectFileOverlaps(fileMap, worktrees);
  const ownershipConflicts = detectOwnershipOverlaps(db);
  const semanticIndexes = worktrees.map((wt) => ({
    worktree: wt.name,
    branch: wt.branch || 'unknown',
    objects: buildSemanticIndexForPath(wt.path, fileMap[wt.name] || []).objects,
  }));
  const semanticConflicts = detectSemanticConflicts(semanticIndexes);

  // Step 3: Detect branch-level merge conflicts (slower, uses git merge-tree)
  const branchConflicts = [];
  const pairs = getPairs(worktrees.filter(w => w.branch && !w.isMain));

  for (const [wtA, wtB] of pairs) {
    if (!wtA.branch || !wtB.branch) continue;
    const result = checkMergeConflicts(repoRoot, wtA.branch, wtB.branch);
    const conflictingFiles = filterIgnoredPaths(result.conflictingFiles || []);
    if (result.hasConflicts && conflictingFiles.length > 0) {
      branchConflicts.push({
        type: result.isOverlapOnly ? 'file_overlap' : 'merge_conflict',
        worktreeA: wtA.name,
        worktreeB: wtB.name,
        branchA: wtA.branch,
        branchB: wtB.branch,
        conflictingFiles,
        details: result.details,
      });
    }
  }

  const allConflicts = [...branchConflicts];
  return {
    worktrees,
    fileMap,
    conflicts: allConflicts,
    fileConflicts,
    ownershipConflicts,
    semanticConflicts,
    unclaimedChanges: enforcement.unclaimedChanges,
    worktreeCompliance: enforcement.worktreeCompliance,
    complianceSummary: enforcement.complianceSummary,
    deniedWrites: enforcement.deniedWrites,
    commitGateFailures: enforcement.commitGateFailures,
    summary: buildSummary(worktrees, allConflicts, fileConflicts, ownershipConflicts, semanticConflicts, enforcement.unclaimedChanges),
    scannedAt: new Date().toISOString(),
  };
}

/**
 * Detect which worktrees are touching the same files right now (uncommitted)
 */
function detectFileOverlaps(fileMap, worktrees) {
  const fileToWorktrees = {}; // file -> [worktree names]

  for (const [wtName, files] of Object.entries(fileMap)) {
    for (const file of files) {
      if (!fileToWorktrees[file]) fileToWorktrees[file] = [];
      fileToWorktrees[file].push(wtName);
    }
  }

  const conflicts = [];
  for (const [file, wts] of Object.entries(fileToWorktrees)) {
    if (wts.length > 1) {
      conflicts.push({ file, worktrees: wts });
    }
  }

  return conflicts;
}

function normalizeScopeRoot(pattern) {
  return String(pattern || '')
    .replace(/\\/g, '/')
    .replace(/\/\*\*$/, '')
    .replace(/\/\*$/, '')
    .replace(/\/+$/, '');
}

function scopeRootsOverlap(leftPattern, rightPattern) {
  const left = normalizeScopeRoot(leftPattern);
  const right = normalizeScopeRoot(rightPattern);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function detectOwnershipOverlaps(db) {
  const reservations = listScopeReservations(db);
  const conflicts = [];

  for (let i = 0; i < reservations.length; i++) {
    for (let j = i + 1; j < reservations.length; j++) {
      const left = reservations[i];
      const right = reservations[j];
      if (left.lease_id === right.lease_id) continue;
      if (left.worktree === right.worktree) continue;

      if (
        left.ownership_level === 'subsystem' &&
        right.ownership_level === 'subsystem' &&
        left.subsystem_tag &&
        left.subsystem_tag === right.subsystem_tag
      ) {
        conflicts.push({
          type: 'subsystem_overlap',
          worktreeA: left.worktree,
          worktreeB: right.worktree,
          leaseA: left.lease_id,
          leaseB: right.lease_id,
          subsystemTag: left.subsystem_tag,
        });
        continue;
      }

      if (
        left.ownership_level === 'path_scope' &&
        right.ownership_level === 'path_scope' &&
        scopeRootsOverlap(left.scope_pattern, right.scope_pattern)
      ) {
        conflicts.push({
          type: 'scope_overlap',
          worktreeA: left.worktree,
          worktreeB: right.worktree,
          leaseA: left.lease_id,
          leaseB: right.lease_id,
          scopeA: left.scope_pattern,
          scopeB: right.scope_pattern,
        });
      }
    }
  }

  return conflicts;
}

/**
 * Check if claiming a set of files from a worktree would conflict with current activity
 */
export function preflightCheck(db, repoRoot, proposedFiles, worktreeName) {
  const gitWorktrees = listGitWorktrees(repoRoot);
  const fileMap = {};

  for (const wt of gitWorktrees) {
    if (wt.name !== worktreeName) {
      fileMap[wt.name] = getWorktreeChangedFiles(wt.path, repoRoot);
    }
  }

  const conflicts = [];
  for (const file of proposedFiles) {
    for (const [wtName, files] of Object.entries(fileMap)) {
      if (files.includes(file)) {
        conflicts.push({ file, conflictsWith: wtName });
      }
    }
  }

  return {
    safe: conflicts.length === 0,
    conflicts,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mergeWorktreeInfo(dbWorktrees, gitWorktrees) {
  const gitMap = {};
  for (const wt of gitWorktrees) gitMap[wt.path] = wt;

  // Start with git worktrees as the source of truth
  const result = gitWorktrees.map(gw => {
    const dbMatch = dbWorktrees.find(d => d.path === gw.path || d.name === gw.name);
    return {
      ...gw,
      name: dbMatch?.name || gw.name,
      branch: dbMatch?.branch || gw.branch,
      agent: dbMatch?.agent || null,
      registeredInDb: !!dbMatch,
    };
  });

  return result;
}

function getPairs(arr) {
  const pairs = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      pairs.push([arr[i], arr[j]]);
    }
  }
  return pairs;
}

function buildSummary(worktrees, conflicts, fileConflicts, ownershipConflicts, semanticConflicts, unclaimedChanges) {
  const lines = [];
  lines.push(`Scanned ${worktrees.length} worktree(s)`);

  if (conflicts.length === 0 && fileConflicts.length === 0 && ownershipConflicts.length === 0 && semanticConflicts.length === 0) {
    lines.push('✓ No conflicts detected');
  } else {
    if (conflicts.length > 0) {
      lines.push(`⚠ ${conflicts.length} branch conflict(s) detected`);
    }
    if (fileConflicts.length > 0) {
      lines.push(`⚠ ${fileConflicts.length} file(s) being edited in multiple worktrees`);
    }
    if (ownershipConflicts.length > 0) {
      lines.push(`⚠ ${ownershipConflicts.length} ownership boundary overlap(s) detected`);
    }
    if (semanticConflicts.length > 0) {
      lines.push(`⚠ ${semanticConflicts.length} semantic overlap(s) detected`);
    }
    if (unclaimedChanges.length > 0) {
      lines.push(`⚠ ${unclaimedChanges.length} worktree(s) have unclaimed changed files`);
    }
  }

  return lines.join('\n');
}
