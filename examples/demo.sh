#!/usr/bin/env bash
# examples/demo.sh
#
# Short, recordable Switchman demo for terminal capture.
# Run AFTER setup.sh:
#   bash examples/demo.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TASKAPI_DIR="$SCRIPT_DIR/taskapi"
WT_RATE="$SCRIPT_DIR/worktrees/agent-rate-limiting"
WT_VALID="$SCRIPT_DIR/worktrees/agent-validation"

if [ -f "$REPO_ROOT/src/cli/index.js" ]; then
  SWITCHMAN=(node "$REPO_ROOT/src/cli/index.js")
else
  SWITCHMAN=(switchman)
fi

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

step() { echo ""; echo -e "${BOLD}── $1 ──────────────────────────────────────${RESET}"; }
info() { echo -e "${YELLOW}→${RESET} $1"; }
ok() { echo -e "${GREEN}✓${RESET} $1"; }

json_field() {
  local payload="$1"
  local expression="$2"
  node -e "const data = JSON.parse(process.argv[1]); console.log(${expression});" "$payload"
}

ensure_setup() {
  if [ ! -d "$TASKAPI_DIR/.switchman" ]; then
    echo "Switchman example is not set up yet."
    echo "Run: bash examples/setup.sh"
    exit 1
  fi
}

append_demo_change() {
  local file_path="$1"
  local message="$2"
  printf "\n// %s\n" "$message" >> "$file_path"
}

git_commit_files() {
  local repo_dir="$1"
  local message="$2"
  shift 2
  if [ "$#" -gt 0 ]; then
    git -C "$repo_dir" add "$@"
    git -C "$repo_dir" commit -m "$message" -q
  fi
}

ensure_setup
cd "$TASKAPI_DIR"

MAIN_BRANCH="$(git branch --show-current)"

echo ""
echo -e "${BOLD}━━━ Switchman Demo ━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo "This is the short version: two agents, one blocked overlap, safe landing, clean gate."

step "1. Repo dashboard"
"${SWITCHMAN[@]}" status

step "2. Agent 1 starts work and locks files"
TASK1="$("${SWITCHMAN[@]}" lease next --json --worktree agent-rate-limiting --agent cursor)"
TASK1_ID="$(json_field "$TASK1" "data.task.id")"
"${SWITCHMAN[@]}" claim "$TASK1_ID" agent-rate-limiting src/middleware/auth.js src/server.js
append_demo_change "$WT_RATE/src/middleware/auth.js" "demo: rate-limiting agent touched auth middleware"
append_demo_change "$WT_RATE/src/server.js" "demo: rate-limiting agent touched server"
git_commit_files "$WT_RATE" "Demo: rate-limiting change" src/middleware/auth.js src/server.js
ok "Agent 1 has its own files and a committed branch"

step "3. Agent 2 tries to overlap and gets blocked"
TASK2="$("${SWITCHMAN[@]}" lease next --json --worktree agent-validation --agent cursor)"
TASK2_ID="$(json_field "$TASK2" "data.task.id")"
"${SWITCHMAN[@]}" claim "$TASK2_ID" agent-validation src/middleware/auth.js src/middleware/validate.js src/routes/tasks.js || true
info "Switchman blocks the overlapping claim before merge-time pain."

step "4. Agent 2 switches to safe files"
"${SWITCHMAN[@]}" claim "$TASK2_ID" agent-validation src/middleware/validate.js src/routes/tasks.js
append_demo_change "$WT_VALID/src/middleware/validate.js" "demo: validation agent touched validation middleware"
append_demo_change "$WT_VALID/src/routes/tasks.js" "demo: validation agent touched tasks route"
git_commit_files "$WT_VALID" "Demo: validation change" src/middleware/validate.js src/routes/tasks.js
ok "Agent 2 adapts instead of colliding"

step "5. Finish work and watch the repo stay readable"
"${SWITCHMAN[@]}" task done "$TASK1_ID"
"${SWITCHMAN[@]}" task done "$TASK2_ID"
"${SWITCHMAN[@]}" status --watch --max-cycles 1

step "6. Queue both finished branches for safe landing"
"${SWITCHMAN[@]}" queue add --worktree agent-rate-limiting --target "$MAIN_BRANCH"
"${SWITCHMAN[@]}" queue add --worktree agent-validation --target "$MAIN_BRANCH"
"${SWITCHMAN[@]}" queue status

step "7. Land the work safely"
"${SWITCHMAN[@]}" queue run --max-items 2 --target "$MAIN_BRANCH"

step "8. Final safety check"
"${SWITCHMAN[@]}" gate ci

echo ""
echo -e "${GREEN}✓ Demo complete.${RESET}"
echo ""
echo "What just happened:"
echo "  • agents took different tasks"
echo "  • Switchman blocked an overlapping file claim early"
echo "  • finished branches landed through the queue"
echo "  • the repo safety gate passed"
echo ""
echo "Reset and run again:"
echo "  bash examples/teardown.sh && bash examples/setup.sh"
echo ""
