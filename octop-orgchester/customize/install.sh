#!/usr/bin/env bash
set -euo pipefail
OCTOP_DIR="${1:?usage: install.sh <path-to-Octop-checkout>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$OCTOP_DIR/.git" ]; then
  echo "error: $OCTOP_DIR is not a git checkout (no .git) — the patches need \`git apply\`" >&2
  exit 1
fi

# Migration numbering hazard: this add-on's migration reuses Octop's own
# numbering sequence (022_agency.sql). If upstream ships its own 022_*
# later, migrate.py's _discover() raises "Duplicate migration version"
# and the server refuses to start. Refuse here, loudly, before copying
# anything — see README "Upgrading" for the full hazard and the fix
# (renumber this add-on's migration files to the next free number).
for f in "$HERE"/backend/migrations/*.sql; do
  base="$(basename "$f")"
  num="${base%%_*}"
  if ls "$OCTOP_DIR"/src/octop/infra/db/migrations/"${num}"_*.sql >/dev/null 2>&1; then
    echo "error: $OCTOP_DIR already has a migration numbered ${num} (not this add-on's — nothing has been copied yet)." >&2
    echo "       Rename customize/backend/migrations/${num}_agency.sql and .pg.sql to the next free number and re-run." >&2
    exit 1
  fi
done

# Check every patch applies BEFORE copying or applying anything — a
# patch that fails loudly only after other files already landed leaves
# the checkout half-installed (Review Focus: a patch that no longer
# applies cleanly must fail loudly at packaging time, not be discovered
# midway through an otherwise-successful install).
for p in "$HERE"/docs/patches/*.patch; do
  if ! git -C "$OCTOP_DIR" apply --check "$p" 2>/dev/null; then
    echo "error: $p does not apply cleanly to $OCTOP_DIR — Octop has likely changed since this patch was written." >&2
    echo "       Nothing was copied or applied; fix the patch (or the target file) and re-run." >&2
    exit 1
  fi
done

cp "$HERE"/backend/migrations/*.sql "$OCTOP_DIR/src/octop/infra/db/migrations/"
cp "$HERE"/backend/routers/agency.py "$OCTOP_DIR/src/octop/api/routers/agency.py"
cp "$HERE"/backend/tests/test_agency_api.py "$OCTOP_DIR/tests/integration/test_agency_api.py"
mkdir -p "$OCTOP_DIR/dashboard/src/pages/Agency/components"
cp "$HERE"/dashboard/pages/Agency/*.tsx "$OCTOP_DIR/dashboard/src/pages/Agency/"
cp "$HERE"/dashboard/pages/Agency/components/*.tsx "$OCTOP_DIR/dashboard/src/pages/Agency/components/"
mkdir -p "$OCTOP_DIR/dashboard/src/pages/Experts/components"
cp "$HERE"/dashboard/pages/Experts/components/*.test.tsx "$OCTOP_DIR/dashboard/src/pages/Experts/components/"

mkdir -p "$OCTOP_DIR/src/octop/infra/flows"
touch "$OCTOP_DIR/src/octop/infra/flows/__init__.py"
cp "$HERE"/backend/flows/engine.py "$OCTOP_DIR/src/octop/infra/flows/"
cp "$HERE"/backend/flows/validate.py "$OCTOP_DIR/src/octop/infra/flows/"
cp "$HERE"/backend/tests/test_flow_validate.py "$OCTOP_DIR/tests/unit/test_flow_validate.py"
cp "$HERE"/backend/routers/flow.py "$OCTOP_DIR/src/octop/api/routers/flow.py"
cp "$HERE"/backend/tests/test_flow_engine.py "$OCTOP_DIR/tests/unit/test_flow_engine.py"
cp "$HERE"/backend/tests/test_flow_api.py "$OCTOP_DIR/tests/integration/test_flow_api.py"
mkdir -p "$OCTOP_DIR/dashboard/src/pages/Flows/components"
cp "$HERE"/dashboard/pages/Flows/*.tsx "$OCTOP_DIR/dashboard/src/pages/Flows/"
cp "$HERE"/dashboard/pages/Flows/components/*.tsx "$OCTOP_DIR/dashboard/src/pages/Flows/components/"

patch_count=$(ls "$HERE"/docs/patches/*.patch 2>/dev/null | wc -l | tr -d ' ')
echo "All $patch_count patches checked clean. Copied new files. Now apply the patches from inside $OCTOP_DIR:"
for p in "$HERE"/docs/patches/*.patch; do
  echo "  git -C \"$OCTOP_DIR\" apply \"$p\""
done
