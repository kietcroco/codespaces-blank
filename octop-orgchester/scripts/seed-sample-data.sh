#!/usr/bin/env bash
# Seed sample data (provider, agencies, experts, flows) into the running
# container. Thin wrapper over seed-sample-data.py (stdlib only, no jq).
# Idempotent. Config: .env.seed (see .env.seed.example).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$(command -v python3 || command -v python)"
exec "$PY" "$HERE/seed-sample-data.py" "$@"
