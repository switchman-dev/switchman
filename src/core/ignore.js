export const DEFAULT_SCAN_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
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

export function isIgnoredPath(filePath, patterns = DEFAULT_SCAN_IGNORE_PATTERNS) {
  const normalized = normalizePath(filePath);
  if (!normalized) return false;

  return patterns.some((pattern) => {
    const prefix = patternPrefix(pattern);
    return normalized === prefix || normalized.startsWith(`${prefix}/`) || normalized.includes(`/${prefix}/`);
  });
}

export function filterIgnoredPaths(filePaths, patterns = DEFAULT_SCAN_IGNORE_PATTERNS) {
  return filePaths.filter((filePath) => !isIgnoredPath(filePath, patterns));
}
