#!/usr/bin/env bash
# examples/setup.sh
#
# Sets up the taskapi example project for testing Switchman locally.
#
# What this does:
#   1. Inits taskapi as a git repo with an initial commit
#   2. Creates 3 git worktrees (simulating 3 parallel Claude Code instances)
#   3. Runs switchman init
#   4. Seeds 4 realistic parallel tasks
#
# Run from the switchman repo root:
#   bash examples/setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TASKAPI_DIR="$SCRIPT_DIR/taskapi"
WORKTREES_DIR="$SCRIPT_DIR/worktrees"

if [ -f "$REPO_ROOT/src/cli/index.js" ]; then
  SWITCHMAN=(node "$REPO_ROOT/src/cli/index.js")
else
  SWITCHMAN=(switchman)
fi

echo ""
echo "━━━ Switchman Example Setup ━━━━━━━━━━━━━━━━━━"
echo ""

# ── Step 1: Init the project as a git repo ────────────────────────────────────

echo "→ Initialising taskapi as a git repo..."
cd "$TASKAPI_DIR"

if [ -d ".git" ]; then
  echo "  Already a git repo — skipping init"
else
  git init -q
  git config user.email "demo@switchman.dev"
  git config user.name "Switchman Demo"
  npm install --silent
  git add -A
  git commit -m "Initial commit: taskapi Express REST API" -q
  echo "  ✓ Git repo initialised"
fi

# ── Step 2: Create 3 worktrees ────────────────────────────────────────────────

echo ""
echo "→ Creating 3 git worktrees (simulating 3 parallel agents)..."
mkdir -p "$WORKTREES_DIR"

create_worktree() {
  local name=$1
  local branch=$2
  local path="$WORKTREES_DIR/$name"
  if [ -d "$path" ]; then
    echo "  Worktree '$name' already exists — skipping"
  else
    git worktree add -b "$branch" "$path" -q
    echo "  ✓ $name  →  branch: $branch"
  fi
}

create_worktree "agent-rate-limiting"  "feature/rate-limiting"
create_worktree "agent-validation"     "feature/input-validation"
create_worktree "agent-tests"          "feature/write-tests"

echo ""
git worktree list

# ── Step 3: Switchman init ────────────────────────────────────────────────────

echo ""
echo "→ Initialising Switchman in taskapi..."
"${SWITCHMAN[@]}" init

# ── Step 4: Seed tasks ────────────────────────────────────────────────────────

echo ""
echo "→ Seeding 4 parallel tasks..."

"${SWITCHMAN[@]}" task add "Add rate limiting to all API routes" \
  --priority 8 \
  --description "Token bucket: 100 req/min per API key. Return 429 with Retry-After header."

"${SWITCHMAN[@]}" task add "Add input validation to POST /tasks and PATCH /tasks/:id" \
  --priority 7 \
  --description "Validate title length, status enum, priority enum. Return 400 with descriptive errors."

"${SWITCHMAN[@]}" task add "Write tests for the auth middleware" \
  --priority 6 \
  --description "Test requireAuth and requireAdmin: valid key, missing key, bad key, wrong role."

"${SWITCHMAN[@]}" task add "Add pagination to GET /tasks" \
  --priority 5 \
  --description "Add ?page=1&limit=20. Return { tasks, count, page, totalPages }."

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ Setup complete."
echo ""
echo "Tasks ready:"
"${SWITCHMAN[@]}" task list
echo ""
echo "→ Next: bash examples/walkthrough.sh"
echo ""
