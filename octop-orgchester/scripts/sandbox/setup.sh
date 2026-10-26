#!/usr/bin/env bash
# One-time setup of the Docker test sandbox: an Octop checkout at the base
# commit the customize/ patches target (6797d0e4, 2026-10-22), with Agency +
# Flow installed, plus the two test images. Needs Docker and git; the Octop/
# checkout in this repo must contain commit 6797d0e4 (git fetch if not).
# Why not Octop/ HEAD: upstream later added its own migrations 022-024 and
# changed files the patches touch, so the patches no longer apply there.
# Usage: bash scripts/sandbox/setup.sh    (env OCTOP_SANDBOX, OCTOP_SRC optional)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
C="$REPO/octop-orgchester/customize"
SB="${OCTOP_SANDBOX:-$REPO/../octop-sandbox}"
SRC="${OCTOP_SRC:-$REPO/Octop}"
BASE=6797d0e4

mkdir -p "$SB"; SB="$(cd "$SB" && pwd)"; O="$SB/octop"
if [ ! -d "$O/.git" ]; then git clone -q --no-hardlinks "$SRC" "$O"; fi
cd "$O"
git config user.email sandbox@local; git config user.name sandbox
git checkout -q -f "$BASE"; git clean -fdq
# install.sh refuses an unpatched tree (patches 13+ depend on 01-12), so apply sequentially here.
for p in "$C"/docs/patches/*.patch; do git apply "$p"; done
cp "$C"/backend/migrations/*.sql src/octop/infra/db/migrations/
cp "$C"/backend/routers/agency.py src/octop/api/routers/
cp "$C"/backend/tests/test_agency_api.py tests/integration/
mkdir -p dashboard/src/pages/Agency/components dashboard/src/pages/Experts/components src/octop/infra/flows
cp "$C"/dashboard/pages/Agency/*.tsx dashboard/src/pages/Agency/
cp "$C"/dashboard/pages/Agency/components/*.tsx dashboard/src/pages/Agency/components/
cp "$C"/dashboard/pages/Experts/components/*.test.tsx dashboard/src/pages/Experts/components/
touch src/octop/infra/flows/__init__.py
CUSTOMIZE="$C" OCTOP_SANDBOX="$SB" bash "$HERE/sb.sh" sync
git add -A >/dev/null; git commit -qm "sandbox: customize installed" || true
MSYS_NO_PATHCONV=1 docker build -q -t octop-sb-py -f "$HERE/Dockerfile.py" "$HERE"
MSYS_NO_PATHCONV=1 docker build -q -t octop-sb-node -f "$HERE/Dockerfile.node" "$HERE"
echo "Sandbox ready at $SB. Try: bash scripts/sandbox/sb.sh py tests/unit/test_flow_engine.py -q"
