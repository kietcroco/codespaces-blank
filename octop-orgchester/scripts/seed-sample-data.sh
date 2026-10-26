#!/usr/bin/env bash
# =============================================================================
# Seed sample Agency/Expert data into a running Octop container, via its
# own REST API (never touches the DB file directly).
#
# Idempotent: if any agency already exists for the admin user, does nothing.
# Safe to re-run — it will not create duplicates.
#
# Requires: the octop container running and healthy (see rebuild.sh), curl,
# jq. Reads the admin password from data/credential.txt (the source of
# truth for the running container — see ../ARCHITECTURE.md §4), not from
# .env (.env's OCTOP_DEFAULT_PASSWORD may have changed since first boot).
#
# Usage: bash scripts/seed-sample-data.sh
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

PORT="$(grep -E '^OCTOP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'"'"'')"
PORT="${PORT:-8088}"
BASE="http://localhost:${PORT}/api"

ADMIN_USER="$(grep -E '^OCTOP_ADMIN_USERNAME=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'"'"'')"
ADMIN_USER="${ADMIN_USER:-admin}"

CRED_FILE="data/credential.txt"
if [ ! -f "$CRED_FILE" ]; then
    echo "error: $CRED_FILE not found. Is the container initialized and running? (see rebuild.sh)" >&2
    exit 1
fi

# credential.txt is root-owned (the container writes as root) — read with
# sudo if needed, fall back to plain cat for setups where it's readable.
read_cred_file() {
    cat "$CRED_FILE" 2>/dev/null || sudo cat "$CRED_FILE"
}

PASSWORD="$(read_cred_file | sed -n 's/^Password: //p' | head -1)"
if [ -z "$PASSWORD" ]; then
    echo "error: could not parse a password out of $CRED_FILE" >&2
    exit 1
fi

echo "==> Waiting for $BASE/health..."
for _ in $(seq 1 30); do
    if curl -sf "$BASE/health" >/dev/null 2>&1; then
        break
    fi
    sleep 2
done
if ! curl -sf "$BASE/health" >/dev/null 2>&1; then
    echo "error: $BASE/health never became healthy" >&2
    exit 1
fi

echo "==> Logging in as $ADMIN_USER..."
LOGIN_BODY="$(jq -n --arg u "$ADMIN_USER" --arg p "$PASSWORD" '{username:$u,password:$p}')"
TOKEN="$(curl -sf -X POST "$BASE/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$LOGIN_BODY" | jq -r '.access_token // empty')"
if [ -z "$TOKEN" ]; then
    echo "error: login failed — check $CRED_FILE / OCTOP_ADMIN_USERNAME" >&2
    exit 1
fi

api() {
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        curl -sf -X "$method" "$BASE$path" \
            -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
            -d "$body"
    else
        curl -sf -X "$method" "$BASE$path" -H "Authorization: Bearer $TOKEN"
    fi
}

# ── Default model provider ───────────────────────────────────────────────
# A placeholder OpenAI-compatible provider so the Models UI and each
# seeded expert's "default_model" aren't empty. This container has no
# outbound internet in this sandbox (see ../ARCHITECTURE.md "Container
# không có internet ra ngoài") so this CANNOT actually serve chat
# completions — it only satisfies the UI (provider.enabled requires a
# non-empty api_key to show up in model pickers, see
# src/octop/infra/agents/providers/resolved.py). Swap in a real
# OpenAI-compatible base_url/api_key later via the dashboard (Settings →
# Models) or the admin API in ARCHITECTURE.md §5 — same provider name,
# so existing experts keep pointing at it.
PROVIDER_NAME="octop-test-provider"
MODEL_ID="gpt-4o-mini"
MODEL_REF="${PROVIDER_NAME}/${MODEL_ID}"

EXISTING_PROVIDERS="$(api GET /admin/providers | jq 'length')"
if [ "${EXISTING_PROVIDERS:-0}" -gt 0 ]; then
    echo "==> ${EXISTING_PROVIDERS} provider(s) already configured — skipping placeholder provider (idempotent)."
else
    echo "==> Creating placeholder model provider ($PROVIDER_NAME, model $MODEL_ID)..."
    api POST /admin/providers "$(jq -n \
        --arg name "$PROVIDER_NAME" \
        --arg model "$MODEL_ID" \
        --arg note "Seed placeholder (scripts/seed-sample-data.sh) — no real internet in this sandbox, see ARCHITECTURE.md §4.3/§5. Replace with a real key to enable chat." \
        '{name:$name, kind:"openai", base_url:"https://api.openai.com/v1",
          api_key:"sk-placeholder-not-a-real-key",
          models:[{id:$model, name:"GPT-4o mini", enabled:true}],
          note:$note}')" >/dev/null
    api PUT /providers/active-model "$(jq -n --arg p "$PROVIDER_NAME" --arg m "$MODEL_ID" \
        '{provider_name:$p, model:$m}')" >/dev/null
    echo "    -> set as the global active model (still placeholder — see note above)."
fi

EXISTING_COUNT="$(api GET /agencies | jq 'length')"
if [ "${EXISTING_COUNT:-0}" -gt 0 ]; then
    echo "==> $EXISTING_COUNT agency(ies) already exist for $ADMIN_USER — skipping seed (idempotent)."
    exit 0
fi

create_agency() {
    local name="$1" desc="$2" color="$3"
    api POST /agencies "$(jq -n --arg n "$name" --arg d "$desc" --arg c "$color" \
        '{name:$n,description:$d,color:$c}')" | jq -r '.agency_id'
}

create_expert() {
    local name="$1" desc="$2"
    api POST /agents "$(jq -n --arg n "$name" --arg d "$desc" --arg m "$MODEL_REF" \
        '{name:$n,description:$d,default_model:$m}')" \
        | jq -r '.agent_id'
}

assign_expert() {
    local agent_id="$1" agency_id="$2"
    api PUT "/agencies/members/$agent_id" "$(jq -n --arg a "$agency_id" '{agency_id:$a}')" >/dev/null
}

echo "==> Creating 6 agencies (software company departments)..."
SALES_ID="$(create_agency "Sales" "Deal closing and customer outreach" "#F59E0B")"
ENG_ID="$(create_agency "Engineering" "Builds and maintains the product" "#3B82F6")"
PRODUCT_ID="$(create_agency "Product" "Roadmap and feature definition" "#8B5CF6")"
DESIGN_ID="$(create_agency "Design" "UX/UI and visual design" "#EC4899")"
QA_ID="$(create_agency "QA" "Quality assurance and release testing" "#10B981")"
DEVOPS_ID="$(create_agency "DevOps & Infra" "CI/CD, infrastructure, and reliability" "#EF4444")"
echo "    Sales=$SALES_ID (kept empty, mirrors an unstaffed department)"

echo "==> Creating 10 experts and assigning them to departments..."
# agency_id | name | description
SEED_EXPERTS=(
    "$ENG_ID|Backend Bot|Builds and maintains backend services"
    "$ENG_ID|Frontend Bot|Builds dashboard UI features"
    "$PRODUCT_ID|Roadmap Bot|Plans and prioritizes features"
    "$PRODUCT_ID|Spec Bot|Writes product specs"
    "$DESIGN_ID|UI Bot|Designs interface mockups"
    "$DESIGN_ID|UX Bot|Runs usability reviews"
    "$QA_ID|Test Bot|Writes and runs test plans"
    "$QA_ID|Release Bot|Coordinates release QA"
    "$DEVOPS_ID|Infra Bot|Manages cloud infrastructure"
    "$DEVOPS_ID|CI Bot|Maintains CI/CD pipelines"
)

for row in "${SEED_EXPERTS[@]}"; do
    IFS='|' read -r agency_id name desc <<<"$row"
    agent_id="$(create_expert "$name" "$desc")"
    assign_expert "$agent_id" "$agency_id"
    echo "    - $name -> $agency_id"
done

echo "==> Done: 6 agencies (Sales empty, 5 staffed), 10 experts assigned."
