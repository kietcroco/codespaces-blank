#!/usr/bin/env bash
# Docker test sandbox for customize/. Usage: sb.sh sync | py <pytest args> | ui <vitest args>
# Run setup.sh once first. Env: OCTOP_SANDBOX (sandbox dir), CUSTOMIZE (customize/ to sync from, e.g. a worktree).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SB="${OCTOP_SANDBOX:-$(cd "$HERE/../../.." && pwd)/../octop-sandbox}"
C="${CUSTOMIZE:-$(cd "$HERE/../../customize" && pwd)}"
O="$SB/octop"
WIN() { cygpath -w "$1"; }
case "${1:-}" in
sync)
  mkdir -p "$O/src/octop/infra/flows" "$O/dashboard/src/pages/Flows/components"
  cp "$C"/backend/flows/engine.py "$O/src/octop/infra/flows/"
  cp "$C"/backend/flows/validate.py "$O/src/octop/infra/flows/"
  cp "$C"/backend/tests/test_flow_validate.py "$O/tests/unit/test_flow_validate.py"
  cp "$C"/backend/flows/template.py "$O/src/octop/infra/flows/"
  cp "$C"/backend/tests/test_flow_template.py "$O/tests/unit/test_flow_template.py"
  cp "$C"/backend/routers/flow.py "$O/src/octop/api/routers/flow.py"
  cp "$C"/backend/migrations/*.sql "$O/src/octop/infra/db/migrations/"
  cp "$C"/backend/tests/test_flow_engine.py "$O/tests/unit/test_flow_engine.py"
  cp "$C"/backend/tests/test_flow_api.py "$O/tests/integration/test_flow_api.py"
  cp "$C"/dashboard/pages/Flows/*.tsx "$O/dashboard/src/pages/Flows/"
  cp "$C"/dashboard/pages/Flows/*.ts "$O/dashboard/src/pages/Flows/"
  cp "$C"/dashboard/pages/Flows/components/*.tsx "$O/dashboard/src/pages/Flows/components/"
  [ -f "$C"/backend/flows/copilot.py ] && cp "$C"/backend/flows/copilot.py "$O/src/octop/infra/flows/"
  [ -f "$C"/backend/tests/test_flow_copilot.py ] && cp "$C"/backend/tests/test_flow_copilot.py "$O/tests/unit/test_flow_copilot.py"
  echo synced ;;
py) shift
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(WIN "$O")":/work -v octop-sb-venv:/work/.venv -v octop-sb-uvcache:/root/.cache/uv -w /work -e PYTHONPATH=/work/src -e UV_PROJECT_ENVIRONMENT=/work/.venv octop-sb-py bash -c 'if [ ! -f .venv/.ready ]; then uv sync --frozen --extra dev 2>&1 | tail -3 || uv sync --extra dev; touch .venv/.ready; fi; .venv/bin/python -m pytest "$@"' _ "$@" ;;
ui) shift
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(WIN "$O")/dashboard":/work -v octop-sb-nm:/work/node_modules -w /work octop-sb-node bash -c 'if [ ! -f node_modules/.ready ]; then npm ci --no-audit --no-fund 2>&1 | tail -3; touch node_modules/.ready; fi; npx vitest run "$@"' _ "$@" ;;
*) echo "usage: sb.sh sync|py|ui"; exit 2 ;;
esac
