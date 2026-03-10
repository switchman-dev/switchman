#!/usr/bin/env bash
# examples/teardown.sh — resets the example so you can run setup.sh again

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASKAPI_DIR="$SCRIPT_DIR/taskapi"
WORKTREES_DIR="$SCRIPT_DIR/worktrees"

echo ""
echo "→ Removing worktrees..."

cd "$TASKAPI_DIR"

if [ -d ".git" ]; then
  git worktree remove "$WORKTREES_DIR/agent-rate-limiting" --force 2>/dev/null && echo "  ✓ agent-rate-limiting removed" || true
  git worktree remove "$WORKTREES_DIR/agent-validation"    --force 2>/dev/null && echo "  ✓ agent-validation removed"    || true
  git worktree remove "$WORKTREES_DIR/agent-tests"         --force 2>/dev/null && echo "  ✓ agent-tests removed"         || true

  git branch -D "feature/rate-limiting"  2>/dev/null || true
  git branch -D "feature/input-validation" 2>/dev/null || true
  git branch -D "feature/write-tests"    2>/dev/null || true
fi

echo "→ Removing .switchman database..."
rm -rf "$TASKAPI_DIR/.switchman"

echo "→ Removing worktrees directory..."
rm -rf "$WORKTREES_DIR"

echo "→ Removing git repo from taskapi..."
rm -rf "$TASKAPI_DIR/.git"
rm -rf "$TASKAPI_DIR/node_modules"

echo ""
echo "✓ Teardown complete. Run 'bash examples/setup.sh' to start fresh."
echo ""
