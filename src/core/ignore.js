export const DEFAULT_SCAN_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  '.mcp.json',
  '.switchman/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.next/**',
  '.nuxt/**',
  '.svelte-kit/**',
  '.turbo/**',
  '.cache/**',
  '.parcel-cache/**',
  'target/**',
  'out/**',
  'tmp/**',
  'temp/**',
];

function normalizePath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function patternPrefix(pattern) {
  return normalizePath(pattern).replace(/\/\*\*$/, '');
}

export function matchesPathPatterns(filePath, patterns = DEFAULT_SCAN_IGNORE_PATTERNS) {
  const normalized = normalizePath(filePath);
  if (!normalized) return false;

  return patterns.some((pattern) => {
    const prefix = patternPrefix(pattern);
    return normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized.includes(`/${prefix}/`);
  });
}

export function isIgnoredPath(filePath, patterns = DEFAULT_SCAN_IGNORE_PATTERNS) {
  return matchesPathPatterns(filePath, patterns);
}

export function filterIgnoredPaths(filePaths, patterns = DEFAULT_SCAN_IGNORE_PATTERNS) {
  return filePaths.filter((filePath) => !isIgnoredPath(filePath, patterns));
}
