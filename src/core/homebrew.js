import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

function defaultPackageRoot() {
  return resolve(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

function getPackageVersion(repoRoot) {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return packageJson.version;
}

function defaultTarballUrl(version) {
  return `https://github.com/switchman-dev/switchman/archive/refs/tags/v${version}.tar.gz`;
}

export function renderHomebrewFormula({
  className = 'SwitchmanDev',
  desc = 'Conflict-aware task coordinator for parallel AI coding agents',
  homepage = 'https://switchman.dev',
  url,
  sha256,
  license = 'Apache-2.0',
  nodeFormula = 'node@22',
} = {}) {
  return `class ${className} < Formula
  desc ${JSON.stringify(desc)}
  homepage ${JSON.stringify(homepage)}
  url ${JSON.stringify(url)}
  sha256 ${JSON.stringify(sha256)}
  license ${JSON.stringify(license)}

  depends_on ${JSON.stringify(nodeFormula)}

  def install
    system Formula[${JSON.stringify(nodeFormula)}].opt_bin/"npm", "install", *std_npm_args(libexec)
    bin.install_symlink libexec/"bin/switchman"
    bin.install_symlink libexec/"bin/switchman-mcp"
  end

  test do
    assert_match "switchman", shell_output("#{bin}/switchman --help")
  end
end
`;
}

export function buildHomebrewFormula(repoRoot = defaultPackageRoot(), {
  version = null,
  url = null,
  sha256 = null,
} = {}) {
  const resolvedVersion = version || getPackageVersion(repoRoot);
  const resolvedUrl = url || defaultTarballUrl(resolvedVersion);
  if (!sha256) {
    throw new Error('Homebrew formula generation requires --sha256 for the release tarball.');
  }

  return {
    version: resolvedVersion,
    url: resolvedUrl,
    sha256,
    formula: renderHomebrewFormula({
      url: resolvedUrl,
      sha256,
    }),
  };
}

export function writeHomebrewFormula(outputPath, formula) {
  const resolvedPath = resolve(outputPath);
  mkdirSync(resolve(resolvedPath, '..'), { recursive: true });
  writeFileSync(resolvedPath, formula);
  return resolvedPath;
}
