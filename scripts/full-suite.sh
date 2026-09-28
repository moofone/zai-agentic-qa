#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/Dev/git/rust_bot_v2}"
MAX_AGENTS="${2:-4}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== zai-agentic-qa: full suite ==="
echo "Repo:    $REPO"
echo "Agents:  $MAX_AGENTS (saga: 1)"
echo "Model:   glm-5-turbo"
echo "Steps:   12 (11 tasks + dashboard)"
echo ""

cd "$PROJECT_DIR"

FAILED_TASKS=""

run_task() {
  local label="$1"
  local npm_script="$2"
  shift 2

  echo "--- $label ---"
  if npm run "$npm_script" -- "$@"; then
    echo ""
    return 0
  else
    echo ""
    FAILED_TASKS="${FAILED_TASKS}  - ${label}\n"
    return 0
  fi
}

run_task "[1/12] docs-alignment"              docs:alignment                --repo "$REPO" --docs-folders docs/architecture,docs/guides --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[2/12] fixture-alignment"            fixture:alignment             --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[3/12] shared-ws-alignment"          shared-ws:alignment           --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[4/12] actor-messaging-conformance"  actor-messaging:conformance   --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[5/12] actor-schema-conformance"     actor-schema:conformance      --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[6/12] fixture-e2e-coverage"         fixture-e2e:coverage          --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[7/12] json-parsing-hygiene"         json-parsing:hygiene          --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[8/12] inbox-direct-processing"      inbox:direct                  --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[9/12] saga-workflow-e2e"            saga:e2e                      --repo "$REPO" --max-agents 1 --model glm-5-turbo --apply
run_task "[10/12] persistence-audit"           persistence:audit             --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo
run_task "[11/12] test-green"                  test:green                    --repo "$REPO" --max-agents "$MAX_AGENTS" --model glm-5-turbo --apply
run_task "[12/12] dashboard"                   dashboard                     --artifacts ./artifacts --output ./artifacts/dashboard.html

echo ""
echo "=== Done ==="

if [ -n "$FAILED_TASKS" ]; then
  echo ""
  echo "Failed tasks:"
  echo -e "$FAILED_TASKS"
  exit 1
fi
