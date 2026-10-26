#!/usr/bin/env bash
# =============================================================================
# Full reset + build + run for the Octop dev container.
#
# This is the ONE command to use whenever Octop/ source has changed and you
# want a clean container to test against: it wipes the container, its
# network, and ALL persisted data (SQLite db, credentials, config — the
# bind-mounted data/ directory), then builds a fresh image and starts a
# fresh container, waits for it to become healthy, and re-seeds the sample
# Agency/Expert dataset (scripts/seed-sample-data.sh) so the dashboard has
# something to test against immediately.
#
# Use scripts/seed-sample-data.sh alone (no reset) if you just want to
# re-populate sample data on an already-running container without rebuilding.
#
# Usage: bash scripts/rebuild.sh
#        NODE_MAX_OLD_SPACE_SIZE=1024 bash scripts/rebuild.sh   (low-memory host)
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

PORT="$(grep -E '^OCTOP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'"'"'')"
PORT="${PORT:-8088}"

echo "==> Stopping and removing the container + network..."
docker compose down -v --remove-orphans

echo "==> Wiping data/ (SQLite db, credentials, config — full re-init on next boot)..."
if [ -d data ]; then
    rm -rf data 2>/dev/null || sudo rm -rf data
fi
mkdir -p data

echo "==> Removing the old image (forces a clean rebuild, frees disk/RAM for the build)..."
docker rmi octop:latest >/dev/null 2>&1 || true

echo "==> Building the image..."
BUILD_ARGS=()
if [ -n "${NODE_MAX_OLD_SPACE_SIZE:-}" ]; then
    BUILD_ARGS+=(--build-arg "NODE_MAX_OLD_SPACE_SIZE=${NODE_MAX_OLD_SPACE_SIZE}")
fi
docker compose build "${BUILD_ARGS[@]}" octop

echo "==> Starting the container..."
docker compose up -d

echo "==> Waiting for http://localhost:${PORT}/api/health..."
for _ in $(seq 1 60); do
    if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
        echo "==> Healthy."
        break
    fi
    sleep 2
done
if ! curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    echo "error: container did not become healthy in time — check: docker compose logs octop" >&2
    exit 1
fi

echo "==> Seeding sample data..."
bash scripts/seed-sample-data.sh

echo ""
echo "Done. Open http://localhost:${PORT}"
echo "Admin credential: data/credential.txt"
