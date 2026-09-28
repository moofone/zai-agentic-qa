#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-$HOME/Dev/git/rust_bot_v2}"
MAX_AGENTS="${2:-3}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== zai-agentic-qa: full rust_bot_v2 alignment ==="
echo "Repo:    $REPO"
echo "Agents:  $MAX_AGENTS"
echo "Steps:   10"
echo ""

cd "$PROJECT_DIR"

echo "--- [1/9] docs-alignment ---"
npm run docs:alignment -- \
    --repo "$REPO" \
    --docs-folders docs/architecture,docs/guides \
    --max-agents "$MAX_AGENTS" \
    --apply
echo ""

echo "--- [2/9] fixture-alignment ---"
npm run fixture:alignment -- \
    --repo "$REPO" \
    --max-agents "$MAX_AGENTS" \
    --apply
echo ""

echo "--- [3/9] shared-ws-alignment ---"
npm run shared-ws:alignment -- \
    --repo "$REPO" \
    --max-agents "$MAX_AGENTS" \
    --apply
echo ""

echo "--- [4/9] actor-messaging-conformance ---"
npm run actor-messaging:conformance -- \
    --repo "$REPO" \
    --max-agents "$MAX_AGENTS" \
    --apply
echo ""

echo "--- [5/9] actor-schema-conformance ---"
npm run actor-schema:conformance -- \
    --repo "$REPO" \
    --max-agents "$MAX_AGENTS" \
    --apply
echo ""

echo "--- [6/9] fixture-e2e-coverage ---"
npm run fixture-e2e:coverage -- \
    --repo "$REPO" \
    --max-agents 2 \
    --apply
echo ""

echo "--- [7/9] json-parsing-hygiene ---"
npm run json-parsing:hygiene -- \
    --repo "$REPO" \
    --max-agents "$MAX_AGENTS" \
    --apply
echo ""

echo "--- [8/9] persistence-audit ---"
npm run persistence:audit -- \
    --repo "$REPO" \
    --max-agents "$MAX_AGENTS"
echo ""

echo "--- [9/9] test-green ---"
npm run test:green -- \
    --repo "$REPO" \
    --max-agents "$MAX_AGENTS" \
    --apply
echo ""

echo "--- [10/10] saga-workflow-e2e ---"
npm run saga:e2e -- \
    --repo "$REPO" \
    --max-agents 1 \
    --apply
echo ""

echo "=== Done ==="
