# Changelog

All notable changes to Switchman will be documented in this file.

The format is based on Keep a Changelog, adapted for the project’s current stage.

## [Unreleased]

## [0.1.7] - 2026-03-13

### Added
- plan-aware merge queue execution with merge budgets
- clearer first-run guidance in `switchman setup`, `switchman demo`, and `switchman status`
- richer queue planning, stale-wave handling, policy evidence, and governed landing documentation
- CI workflow for running the test suite on pushes and pull requests

### Changed
- `switchman status` now leads with a simpler summary, top attention item, and one exact next command
- `switchman queue status` no longer crashes on an empty queue summary shape
- `switchman setup` now re-registers existing worktrees cleanly without leaking raw git branch-exists noise
- CLI output now suppresses the noisy Node SQLite experimental warning on normal happy-path runs

### Fixed
- broken install docs that pointed at the org name instead of the package name
- queue status regression found in manual smoke testing before publish

## [0.1.6] - 2026-03-12

### Added
- stronger governed landing flows, recovery loops, and PR/CI handoff
- policy-aware planning, policy evidence, and landing enforcement
- stale cluster grouping, stale-wave reasoning, and richer operator explainability
- synthetic landing branches, refresh, recover, resume, and cleanup

### Changed
- the core product moved from basic coordination toward governed parallel delivery
