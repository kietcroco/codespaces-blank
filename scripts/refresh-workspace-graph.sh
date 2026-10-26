#!/bin/sh
# Rebuilds the workspace-level graph (graphify-out/graph.json at the codespace root)
# by merging the per-repo graphs. Called from the graphify git hooks of each repo,
# after graphify's own detached rebuild, so it waits for that rebuild to finish first.
set -eu

ROOT=/workspaces/codespaces-blank
REPOS="Octop orchester"
LOG="${HOME}/.cache/workspace-graph.log"
LOCK="${HOME}/.cache/workspace-graph.lock"
GRAPHIFY=$(command -v graphify || echo /usr/local/py-utils/bin/graphify)

mkdir -p "$(dirname "$LOG")" "$ROOT/graphify-out"

# One refresh at a time: hooks from several repos can fire close together.
exec 9>"$LOCK"
flock 9

{
    echo "[$(date -Is)] refresh start"

    # graphify's hook starts its rebuild a moment before this script runs.
    sleep 5
    waited=0
    while pgrep -f "from graphify.watch import _rebuild_code" >/dev/null 2>&1; do
        [ "$waited" -ge 900 ] && { echo "rebuild still running after 900s, merging anyway"; break; }
        sleep 5
        waited=$((waited + 5))
    done

    inputs=""
    for r in $REPOS; do
        g="$ROOT/$r/graphify-out/graph.json"
        [ -f "$g" ] && inputs="$inputs $g"
    done

    # Merge to a temp file first so a failed run never leaves a broken graph.json.
    tmp="$ROOT/graphify-out/graph.json.tmp"
    # shellcheck disable=SC2086
    "$GRAPHIFY" merge-graphs $inputs --out "$tmp"
    mv "$tmp" "$ROOT/graphify-out/graph.json"

    echo "[$(date -Is)] refresh done"
} >>"$LOG" 2>&1
