#!/usr/bin/env bash
# examples/walkthrough.sh
#
# Walks through the Switchman workflow step by step.
# Simulates 3 agents working in parallel, including a real file-claim conflict.
#
# Run AFTER setup.sh:
#   bash examples/walkthrough.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TASKAPI_DIR="$SCRIPT_DIR/taskapi"
WT_RATE="$SCRIPT_DIR/worktrees/agent-rate-limiting"
WT_VALID="$SCRIPT_DIR/worktrees/agent-validation"
WT_TESTS="$SCRIPT_DIR/worktrees/agent-tests"

if [ -f "$REPO_ROOT/src/cli/index.js" ]; then
  SWITCHMAN=(node "$REPO_ROOT/src/cli/index.js")
else
  SWITCHMAN=(switchman)
fi

# Colours
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

step() { echo ""; echo -e "${BOLD}── $1 ──────────────────────────────────────${RESET}"; echo ""; }
agent() { echo -e "${CYAN}[Agent: $1]${RESET} $2"; }
info()  { echo -e "  ${YELLOW}→${RESET} $1"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }

cd "$TASKAPI_DIR"

echo ""
echo -e "${BOLD}━━━ Switchman Walkthrough ━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo "This walkthrough simulates 3 parallel Claude Code agents"
echo "coordinating through Switchman on the taskapi project."
echo ""
echo "Press ENTER to step through each action."
read -r

# ── Step 1: Show the starting state ──────────────────────────────────────────

step "1. Starting state"
info "4 tasks waiting in the queue, 3 worktrees ready"
echo ""
"${SWITCHMAN[@]}" status

read -r

# ── Step 2: Agent 1 picks up a task ──────────────────────────────────────────

step "2. Agent 1 picks up the highest-priority task"
agent "agent-rate-limiting" "calling: switchman lease next --json"
echo ""

TASK1=$("${SWITCHMAN[@]}" lease next --json --worktree agent-rate-limiting --agent claude-code 2>/dev/null || echo "null")
TASK1_ID=$(echo "$TASK1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['task']['id'])" 2>/dev/null || echo "")

if [ -z "$TASK1_ID" ]; then
  echo "  No pending tasks found. Run setup.sh first."
  exit 1
fi

echo "$TASK1" | python3 -m json.tool 2>/dev/null || echo "$TASK1"
ok "Task + lease assigned to agent-rate-limiting"

read -r

# ── Step 3: Agent 1 claims its files ─────────────────────────────────────────

step "3. Agent 1 claims the files it needs"
agent "agent-rate-limiting" "I'll be editing the middleware and server files"
echo ""

"${SWITCHMAN[@]}" claim "$TASK1_ID" agent-rate-limiting \
  src/middleware/auth.js \
  src/server.js

ok "Files claimed — no conflicts"

read -r

# ── Step 4: Agent 2 picks up a task ──────────────────────────────────────────

step "4. Agent 2 picks up the next task"
agent "agent-validation" "calling: switchman lease next --json"
echo ""

TASK2=$("${SWITCHMAN[@]}" lease next --json --worktree agent-validation --agent claude-code 2>/dev/null || echo "null")
TASK2_ID=$(echo "$TASK2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['task']['id'])" 2>/dev/null || echo "")
ok "Task + lease assigned to agent-validation"

read -r

# ── Step 5: Agent 2 tries to claim a file already owned by Agent 1 ───────────

step "5. Agent 2 tries to claim src/middleware/auth.js — CONFLICT"
agent "agent-validation" "Input validation also touches auth.js..."
echo ""

# This should warn about the conflict
"${SWITCHMAN[@]}" claim "$TASK2_ID" agent-validation \
  src/middleware/auth.js \
  src/middleware/validate.js \
  src/routes/tasks.js || true

echo ""
info "Switchman blocked the conflicting claim."
info "Agent 2 should pick different files or coordinate with Agent 1."

read -r

# ── Step 6: Agent 2 claims only the safe files ───────────────────────────────

step "6. Agent 2 claims only the files that aren't taken"
agent "agent-validation" "Claiming only validate.js and routes/tasks.js instead"
echo ""

"${SWITCHMAN[@]}" claim "$TASK2_ID" agent-validation \
  src/middleware/validate.js \
  src/routes/tasks.js

ok "Clean claim — no conflicts"

read -r

# ── Step 7: Run a full conflict scan ─────────────────────────────────────────

step "7. Full conflict scan across all worktrees"
info "This is what you'd run before any merge"
echo ""

"${SWITCHMAN[@]}" scan

read -r

# ── Step 8: Agent 1 finishes its task ────────────────────────────────────────

step "8. Agent 1 finishes — marks task done and releases files"
agent "agent-rate-limiting" "Rate limiting implemented and committed."
echo ""

"${SWITCHMAN[@]}" task done "$TASK1_ID"
ok "Task done. src/middleware/auth.js and src/server.js are now free."

read -r

# ── Step 9: Final status ──────────────────────────────────────────────────────

step "9. Final status"
"${SWITCHMAN[@]}" status

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "${GREEN}✓ Walkthrough complete.${RESET}"
echo ""
echo "What you saw:"
echo "  • 2 agents picked up tasks from the shared queue with real leases"
echo "  • Agent 2 was blocked from claiming a file already owned by Agent 1"
echo "  • Agent 2 adapted by claiming different files"
echo "  • Agent 1 completed and released its claims"
echo "  • switchman status and switchman scan stayed readable throughout"
echo ""
echo "To reset and run again:"
echo "  bash examples/teardown.sh && bash examples/setup.sh"
echo ""
