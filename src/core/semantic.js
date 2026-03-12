import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

const SUBSYSTEM_PATTERNS = [
  { key: 'auth', regex: /(^|\/)(auth|login|session|permissions?|rbac|acl)(\/|$)/i },
  { key: 'schema', regex: /(^|\/)(schema|migrations?|db|database|sql)(\/|$)|schema\./i },
  { key: 'config', regex: /(^|\/)(config|configs|settings)(\/|$)|(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig.*|vite\.config.*|webpack\.config.*)$/i },
  { key: 'api', regex: /(^|\/)(api|routes?|controllers?)(\/|$)/i },
  { key: 'payments', regex: /(^|\/)(payments?|billing|invoice|checkout|subscription)(\/|$)/i },
  { key: 'ui', regex: /(^|\/)(components?|ui|pages?)(\/|$)/i },
];

function uniq(values) {
  return [...new Set(values)];
}

function isSourceLikePath(filePath) {
  return [...SOURCE_EXTENSIONS].some((ext) => filePath.endsWith(ext));
}

function classifySubsystems(filePath) {
  const tags = SUBSYSTEM_PATTERNS.filter((pattern) => pattern.regex.test(filePath)).map((pattern) => pattern.key);
  return tags.length > 0 ? tags : ['general'];
}

function areaForPath(filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean);
  if (parts.length === 0) return 'repo';
  if (parts.length === 1) return parts[0];
  if (['src', 'app', 'lib', 'server', 'client', 'tests', 'test', 'spec', 'specs'].includes(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

function extractExports(content) {
  const objects = [];
  const patterns = [
    { kind: 'function', regex: /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'class', regex: /export\s+class\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'const', regex: /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'type', regex: /export\s+type\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'interface', regex: /export\s+interface\s+([A-Za-z_$][\w$]*)/g },
    { kind: 'enum', regex: /export\s+enum\s+([A-Za-z_$][\w$]*)/g },
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern.regex)) {
      objects.push({ kind: pattern.kind, name: match[1] });
    }
  }

  if (/export\s+default\s+/.test(content)) {
    objects.push({ kind: 'default', name: 'default' });
  }

  return uniq(objects.map((item) => `${item.kind}:${item.name}`)).map((key) => {
    const [kind, name] = key.split(':');
    return { kind, name };
  });
}

function extractExportBlocks(content) {
  const lines = String(content || '').split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('export ')) continue;

    const blockLines = [line];
    let braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
    let needsTerminator = !/[;}]$/.test(line.trim());

    while (i + 1 < lines.length && (braceDepth > 0 || needsTerminator)) {
      i += 1;
      const nextLine = lines[i];
      blockLines.push(nextLine);
      braceDepth += (nextLine.match(/{/g) || []).length - (nextLine.match(/}/g) || []).length;
      if (braceDepth <= 0 && /[;}]$/.test(nextLine.trim())) {
        needsTerminator = false;
      }
    }

    blocks.push(blockLines.join('\n').trim());
  }

  return blocks.filter(Boolean);
}

function parseFileObjects(repoPath, filePath) {
  const absolutePath = join(repoPath, filePath);
  if (!existsSync(absolutePath) || !isSourceLikePath(filePath)) return [];

  const content = readFileSync(absolutePath, 'utf8');
  const exports = extractExports(content);
  const exportBlocks = extractExportBlocks(content);
  const subsystemTags = classifySubsystems(filePath);
  const area = areaForPath(filePath);

  return exports.map((entry, index) => ({
    object_id: `${filePath}#${entry.kind}:${entry.name}`,
    file_path: filePath,
    kind: entry.kind,
    name: entry.name,
    area,
    subsystem_tags: subsystemTags,
    source_text: exportBlocks[index] || `export ${entry.kind} ${entry.name}`,
  }));
}

function trackedFiles(repoPath) {
  try {
    const output = execSync('git ls-files', {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function buildSemanticIndexForPath(repoPath, filePaths = null) {
  const files = filePaths || trackedFiles(repoPath);
  const objects = files
    .filter(isSourceLikePath)
    .flatMap((filePath) => parseFileObjects(repoPath, filePath))
    .sort((left, right) =>
      left.file_path.localeCompare(right.file_path)
      || left.kind.localeCompare(right.kind)
      || left.name.localeCompare(right.name)
    );

  return {
    generated_at: new Date().toISOString(),
    object_count: objects.length,
    objects: objects.map(({ source_text, ...object }) => object),
  };
}

export function detectSemanticConflicts(semanticIndexes = []) {
  const conflicts = [];

  for (let i = 0; i < semanticIndexes.length; i++) {
    for (let j = i + 1; j < semanticIndexes.length; j++) {
      const left = semanticIndexes[i];
      const right = semanticIndexes[j];
      const rightByName = new Map();
      for (const object of right.objects) {
        if (!rightByName.has(object.name)) rightByName.set(object.name, []);
        rightByName.get(object.name).push(object);
      }

      for (const leftObject of left.objects) {
        const matching = rightByName.get(leftObject.name) || [];
        for (const rightObject of matching) {
          if (leftObject.object_id === rightObject.object_id) {
            conflicts.push({
              type: 'semantic_object_overlap',
              severity: 'blocked',
              worktreeA: left.worktree,
              worktreeB: right.worktree,
              object_name: leftObject.name,
              object_kind: leftObject.kind,
              fileA: leftObject.file_path,
              fileB: rightObject.file_path,
              area: leftObject.area,
            });
            continue;
          }

          const sharedSubsystems = leftObject.subsystem_tags.filter((tag) => rightObject.subsystem_tags.includes(tag));
          if (sharedSubsystems.length > 0 || leftObject.area === rightObject.area) {
            conflicts.push({
              type: 'semantic_name_overlap',
              severity: 'warn',
              worktreeA: left.worktree,
              worktreeB: right.worktree,
              object_name: leftObject.name,
              object_kind_a: leftObject.kind,
              object_kind_b: rightObject.kind,
              fileA: leftObject.file_path,
              fileB: rightObject.file_path,
              shared_subsystems: sharedSubsystems,
              area: leftObject.area === rightObject.area ? leftObject.area : null,
            });
          }
        }
      }
    }
  }

  return uniq(conflicts.map((item) => JSON.stringify(item))).map((item) => JSON.parse(item));
}

export function materializeSemanticIndex(repoRoot, { worktrees = [] } = {}) {
  const semanticIndex = {
    generated_at: new Date().toISOString(),
    worktrees: worktrees
      .map((worktree) => ({
        worktree: worktree.name,
        branch: worktree.branch || 'unknown',
        index: buildSemanticIndexForPath(worktree.path),
      }))
      .sort((left, right) => left.worktree.localeCompare(right.worktree)),
  };

  const switchmanDir = join(repoRoot, '.switchman');
  if (!existsSync(switchmanDir)) mkdirSync(switchmanDir, { recursive: true });
  const outputPath = join(switchmanDir, 'semantic-index.json');
  writeFileSync(outputPath, `${JSON.stringify(semanticIndex, null, 2)}\n`);
  return {
    output_path: outputPath,
    semantic_index: semanticIndex,
  };
}

function normalizeObjectRow(row) {
  return {
    ...row,
    subsystem_tags: JSON.parse(row.subsystem_tags || '[]'),
  };
}

export function importCodeObjectsToStore(db, repoRoot, { filePaths = null } = {}) {
  const files = filePaths || trackedFiles(repoRoot);
  const objects = files
    .filter(isSourceLikePath)
    .flatMap((filePath) => parseFileObjects(repoRoot, filePath));

  const upsert = db.prepare(`
    INSERT INTO code_objects (object_id, file_path, kind, name, source_text, subsystem_tags, area, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(object_id) DO UPDATE SET
      file_path=excluded.file_path,
      kind=excluded.kind,
      name=excluded.name,
      source_text=excluded.source_text,
      subsystem_tags=excluded.subsystem_tags,
      area=excluded.area,
      updated_at=datetime('now')
  `);

  for (const object of objects) {
    upsert.run(
      object.object_id,
      object.file_path,
      object.kind,
      object.name,
      object.source_text,
      JSON.stringify(object.subsystem_tags || []),
      object.area || null,
    );
  }

  return listCodeObjects(db);
}

export function listCodeObjects(db, { filePath = null } = {}) {
  const where = filePath ? 'WHERE file_path=?' : '';
  const params = filePath ? [filePath] : [];
  return db.prepare(`
    SELECT *
    FROM code_objects
    ${where}
    ORDER BY file_path ASC, kind ASC, name ASC
  `).all(...params).map(normalizeObjectRow);
}

export function updateCodeObjectSource(db, objectId, sourceText) {
  db.prepare(`
    UPDATE code_objects
    SET source_text=?,
        updated_at=datetime('now')
    WHERE object_id=?
  `).run(sourceText, objectId);
  const row = db.prepare(`SELECT * FROM code_objects WHERE object_id=?`).get(objectId);
  return row ? normalizeObjectRow(row) : null;
}

export function materializeCodeObjects(db, repoRoot, { outputRoot = repoRoot } = {}) {
  const objects = listCodeObjects(db);
  const byFile = new Map();
  for (const object of objects) {
    if (!byFile.has(object.file_path)) byFile.set(object.file_path, []);
    byFile.get(object.file_path).push(object);
  }

  const files = [];
  for (const [filePath, entries] of byFile.entries()) {
    const absolutePath = join(outputRoot, filePath);
    const dirPath = absolutePath.split('/').slice(0, -1).join('/');
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
    const ordered = entries
      .slice()
      .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
    const content = `${ordered.map((entry) => entry.source_text.trim()).join('\n\n')}\n`;
    writeFileSync(absolutePath, content);
    files.push(filePath);
  }

  return {
    output_root: outputRoot,
    file_count: files.length,
    files: files.sort(),
  };
}
