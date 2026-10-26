# Agency Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new, independent "Agency" (department) concept to Octop — menu entry level with "Experts", CRUD for Agencies, an Expert↔Agency picker on both the create and edit Expert forms, and a static SVG org-chart (Agency → Experts) — delivered entirely as new files plus 6 small patches, all authored under `customize/`, never written directly into `Octop/` or `orchester/`.

**Architecture:** Two new SQLite/Postgres tables (`agencies`, `agency_members`) read/written through a new FastAPI router (`agency.py`) that reuses Octop's existing `server.services.db` pool and `agent_registry` for expert lookups. A new React page tree under `dashboard/src/pages/Agency/` consumes that router. Six existing Octop files each get a few lines of patch (nav entry, route, router mount, two drawers). Everything is authored in `customize/backend/` and `customize/dashboard/`; a user-run `customize/install.sh` is the only thing that ever copies files into `Octop/` or applies the patches.

**Tech Stack:** FastAPI + the existing `DatabasePool` (sqlite3/psycopg) for backend; React + antd + lucide-react (no new npm dependency) for frontend; pytest for backend tests, vitest for frontend tests.

**Spec:** `/workspaces/codespaces-blank/octop-orgchester/customize/docs/design.md` (goal/current-state summary in the sibling `README.md`)

## Global Constraints

- Every new file is authored under `customize/backend/` or `customize/dashboard/`; none is ever written by the implementer directly into `Octop/` or `orchester/` (spec §1).
- Exactly 6 patches, each a few lines, targeting: `src/octop/api/app.py`, `dashboard/src/routes/index.tsx`, `dashboard/src/layouts/sidebarNav.tsx`, `src/octop/infra/users/preferences.py`, `dashboard/src/pages/Experts/components/EditAgentDrawer.tsx`, `dashboard/src/pages/Experts/components/CreateFromExpertDrawer.tsx` (spec §9).
- No column/table added to `agents`; `agency_members.expert_agent_id` is `UNIQUE` — one expert belongs to at most one Agency at a time (spec §4, §6).
- No new npm dependency — the org-chart view is plain SVG + CSS transitions, no `framer-motion`/`@xyflow/react` (spec §3, §8).
- No edits to Octop's shared i18n files — all labels are inline strings in the new components (spec §8).
- Reuse `ErrorCode.NOT_FOUND` / `ErrorCode.FORBIDDEN` from `src/octop/infra/errors.py`; no new error code added (spec §7).
- Agency rows are scoped by `user_id`, same ownership model as Expert/Team today — no workspace/multi-tenant concept introduced (spec §3).
- Deleting an Agency must cascade-delete only `agency_members` rows, never the referenced Expert (spec §4).

## Review Focus

- Deleting an Agency that still has members must leave those Experts intact and merely unassigned — not covered by a basic "create then delete" happy-path test.
- Re-assigning an Expert already in Agency A to Agency B must silently drop the A membership (the `UNIQUE` constraint enforces storage, but the API must not 500/409 on this — it's the normal "move department" flow).
- An Expert owned by a different user must never be assignable into the current user's Agency (cross-tenant leak via a guessed `expert_agent_id`).
- An Agency with zero members must render cleanly in the list, detail, and org-chart views (no divide-by-zero in a "N experts" label, no crash in the SVG layout effect with an empty `teams` array).
- A patch file that no longer applies cleanly (target file changed) must fail loudly at `git apply --check` time during packaging, not be silently skipped.

## File Structure

**New files (authored in `customize/`, copied by `install.sh` — never modify anything existing):**

| Authored at | Installed at |
|---|---|
| `customize/backend/migrations/0NN_agency.sql` + `.pg.sql` | `Octop/src/octop/infra/db/migrations/0NN_agency.sql` + `.pg.sql` |
| `customize/backend/routers/agency.py` | `Octop/src/octop/api/routers/agency.py` |
| `customize/backend/tests/test_agency_api.py` | `Octop/tests/integration/test_agency_api.py` |
| `customize/dashboard/pages/Agency/index.tsx` | `Octop/dashboard/src/pages/Agency/index.tsx` |
| `customize/dashboard/pages/Agency/components/AgencyFormModal.tsx` | `.../pages/Agency/components/AgencyFormModal.tsx` |
| `customize/dashboard/pages/Agency/components/AgencyDetail.tsx` | `.../pages/Agency/components/AgencyDetail.tsx` |
| `customize/dashboard/pages/Agency/components/AgencyOrgChart.tsx` | `.../pages/Agency/components/AgencyOrgChart.tsx` |
| `customize/dashboard/pages/Agency/*.test.tsx` (vitest, one per component) | same path under `Octop/dashboard/src/pages/Agency/` |

**Patches (authored as `.patch` files in `customize/docs/patches/`):** the 6 files listed in Global Constraints.

**Tooling (this plan, not product code):** `customize/install.sh` (copies new files + prints `git apply` instructions); a disposable sandbox copy of `Octop/` used only for running tests during development, never the real `Octop/` directory.

### Verification sandbox (used by every task below)

Because the migration runner and router mounting only work inside a real Octop checkout, tests for the Octop-side code run against a **throwaway copy**, not the real `Octop/`:

```bash
rm -rf /tmp/octop-agency-sandbox
cp -r /workspaces/codespaces-blank/Octop /tmp/octop-agency-sandbox
```

The sandbox persists on disk across tasks (it is not recreated per task) — but each task is implemented by a fresh worker with no memory of earlier tasks, so **every task must re-sync it before running any test in it**, regardless of whether the sandbox already has earlier tasks' files:

```bash
# 1. Copy every new file produced so far (this task's and all earlier tasks'),
#    per the "Authored at / Installed at" table above, e.g.:
cp customize/backend/migrations/*.sql /tmp/octop-agency-sandbox/src/octop/infra/db/migrations/ 2>/dev/null || true
cp customize/backend/routers/agency.py /tmp/octop-agency-sandbox/src/octop/api/routers/ 2>/dev/null || true
mkdir -p /tmp/octop-agency-sandbox/dashboard/src/pages/Agency/components
cp customize/dashboard/pages/Agency/*.tsx /tmp/octop-agency-sandbox/dashboard/src/pages/Agency/ 2>/dev/null || true
cp customize/dashboard/pages/Agency/components/*.tsx /tmp/octop-agency-sandbox/dashboard/src/pages/Agency/components/ 2>/dev/null || true
# 2. Re-apply every patch already captured so far, in order:
for p in customize/docs/patches/*.patch; do git -C /tmp/octop-agency-sandbox apply --check "$p" 2>/dev/null && git -C /tmp/octop-agency-sandbox apply "$p"; done
```

The `--check` + conditional apply makes this idempotent: a patch already applied in a still-fresh sandbox is silently skipped instead of erroring. The real `Octop/` is never touched by any of this.

---

### Task 1: Sandbox baseline + customize/ repo

**Files:**
- Create: `/tmp/octop-agency-sandbox` (disposable copy of `Octop/`, not tracked anywhere)
- Modify: none in `customize/` yet beyond a `git init`

**Interfaces:**
- Produces: a known-good sandbox path (`/tmp/octop-agency-sandbox`) that Tasks 2–7 copy files into and run tests in.

- [ ] **Step 1: Create the sandbox**

Run: `rm -rf /tmp/octop-agency-sandbox && cp -r /workspaces/codespaces-blank/Octop /tmp/octop-agency-sandbox`
Expected: directory exists, `/tmp/octop-agency-sandbox/.git` present (copy, not a fresh repo).

- [ ] **Step 2: Confirm backend baseline is green**

Run: `cd /tmp/octop-agency-sandbox && uv run pytest tests/integration/test_agents_api.py -q`
Expected: PASS (proves the sandbox is a working Octop checkout before any Agency code exists).

- [ ] **Step 3: Confirm frontend baseline is green**

Run: `cd /tmp/octop-agency-sandbox/dashboard && npm ci --no-audit --no-fund && npx vitest run src/pages/Experts/components/TeamMemberPicker.test.tsx`
Expected: PASS.

- [ ] **Step 4: Initialize the customize/ repo**

Run: `cd /workspaces/codespaces-blank/octop-orgchester/customize && git init && git add README.md docs/design.md && git commit -m "docs: agency feature design"`
Expected: a new repo with one commit; this is the repo every later "Commit" step in this plan refers to (never `Octop/`'s or `orchester/`'s own git history).

---

### Task 2: Agency migration (backend)

**Files:**
- Create: `customize/backend/migrations/0NN_agency.sql`, `customize/backend/migrations/0NN_agency.pg.sql`
- Test: manual verification via sqlite3 in the sandbox (migrations have no dedicated per-file unit test in Octop today — `migrate.py` is exercised end-to-end by every integration test's `env` fixture instead)

**Interfaces:**
- Produces: tables `agencies(id, agency_id UNIQUE, user_id, name, description, color, created_at, updated_at)` and `agency_members(agency_id, expert_agent_id UNIQUE, assigned_at)`, both FK'd to existing tables, consumed by Task 3's router.

- [ ] **Step 1: Determine the real next migration number**

Run: `ls /workspaces/codespaces-blank/Octop/src/octop/infra/db/migrations/ | sort | tail -3`
Expected: shows the current highest `NNN_*.sql`; use the next integer for `0NN` in this task's filenames (the design doc estimated `022`, confirm it's still unused).

- [ ] **Step 2: Write `customize/backend/migrations/0NN_agency.sql`**

```sql
CREATE TABLE agencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id     TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE agency_members (
  agency_id       TEXT NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
  expert_agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
  assigned_at     INTEGER NOT NULL
);

UPDATE _schema_version SET version = <0NN>;
```

- [ ] **Step 3: Write the `.pg.sql` twin**

Same two `CREATE TABLE` statements, with `id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` for `agencies.id` — copy the exact style difference from `src/octop/infra/db/migrations/016_agent_teams.sql` vs `016_agent_teams.pg.sql`'s neighbors (e.g. `015_*`) since `016` itself has no PK column to compare.

- [ ] **Step 4: Verify the migration runs in the sandbox**

```bash
cp customize/backend/migrations/0NN_agency.* /tmp/octop-agency-sandbox/src/octop/infra/db/migrations/
cd /tmp/octop-agency-sandbox && uv run pytest tests/integration/test_agents_api.py -q
```
Expected: still PASS (the `env` fixture runs every migration on a fresh DB; a syntax error here fails every test, not just a new one — that's the signal).

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add backend/migrations/
git commit -m "feat: add agencies/agency_members migration"
```

---

### Task 3: Agency router (backend)

**Files:**
- Create: `customize/backend/routers/agency.py`
- Create: `customize/backend/tests/test_agency_api.py`
- Modify (patch, not direct edit): `Octop/src/octop/api/app.py` → write `customize/docs/patches/01-app-py-mount-agency-router.patch`

**Interfaces:**
- Consumes: `Depends(current_user)` → object with `.id: int`, `.is_admin: bool` (per `src/octop/api/deps.py`, used as-is); `Depends(get_server)` → `server.services.db` (`DatabasePool`: `.connect()` / `.transaction()` context managers, `?`-placeholder SQL, per `src/octop/infra/db/pool.py`); `server.app_runtime.agent_registry.get_row(agent_id) -> AgentRow | None` and `.list_rows() -> list[AgentRow]` for expert name/description/status lookups; `octop.api.common.agent.assert_agent_owner(row, user) -> None` (raises `OctopError(FORBIDDEN)`); `octop.infra.utils.ulid.new_short_id(length=6) -> str` for id generation; `octop.infra.errors.ErrorCode.NOT_FOUND` / `.FORBIDDEN`.
- Produces: `router: APIRouter` with the 7 endpoints below, for Task 1's `app.py` patch to mount at prefix `/api` and for the frontend tasks to call.

Endpoints (all under `/api/agencies`, all `Depends(current_user)`, scoped by `user_id`):

| Method & path | Request body | Response |
|---|---|---|
| `GET /api/agencies` | — | `list[{agency_id, name, description, color, member_count}]` |
| `POST /api/agencies` | `{name: str, description: str \| None, color: str \| None}` | `201` + the created row |
| `GET /api/agencies/{agency_id}` | — | `{agency_id, name, description, color, experts: [{agent_id, name, description, status}]}` |
| `PATCH /api/agencies/{agency_id}` | any subset of `{name, description, color}` | updated row |
| `DELETE /api/agencies/{agency_id}` | — | `204`, deletes `agency_members` rows for it, never touches `agents` |
| `PUT /api/agencies/members/{expert_agent_id}` | `{agency_id: str \| None}` | `200`; `null` clears membership; non-null upserts (delete any existing row for that `expert_agent_id` first, since it's `UNIQUE`) |
| `GET /api/agencies/org-chart` | — | `{agencies: [{agency_id, name, color, experts: [{agent_id, name, description, status}]}]}` |

- [ ] **Step 1: Write the failing tests**

```python
# customize/backend/tests/test_agency_api.py
import pytest

@pytest.fixture
async def env(env_with_provider):
    yield env_with_provider

async def test_create_list_get_agency(env):
    c, _, auth = env
    r = await c.post("/api/agencies", headers=auth, json={"name": "Sales", "color": "#3B3BFF"})
    assert r.status_code == 201, r.text
    agency_id = r.json()["agency_id"]

    r = await c.get("/api/agencies", headers=auth)
    assert any(a["agency_id"] == agency_id and a["member_count"] == 0 for a in r.json())

    r = await c.get(f"/api/agencies/{agency_id}", headers=auth)
    assert r.json()["experts"] == []

async def test_patch_and_delete_agency(env):
    c, _, auth = env
    agency_id = (await c.post("/api/agencies", headers=auth, json={"name": "Ops"})).json()["agency_id"]
    r = await c.patch(f"/api/agencies/{agency_id}", headers=auth, json={"name": "Ops Renamed"})
    assert r.json()["name"] == "Ops Renamed"
    r = await c.delete(f"/api/agencies/{agency_id}", headers=auth)
    assert r.status_code == 204
    r = await c.get(f"/api/agencies/{agency_id}", headers=auth)
    assert r.status_code == 404

async def test_assign_member_and_delete_agency_keeps_expert(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "bot"})).json()["agent_id"]
    agency_id = (await c.post("/api/agencies", headers=auth, json={"name": "Ops"})).json()["agency_id"]
    r = await c.put(f"/api/agencies/members/{agent_id}", headers=auth, json={"agency_id": agency_id})
    assert r.status_code == 200

    await c.delete(f"/api/agencies/{agency_id}", headers=auth)
    r = await c.get("/api/agents", headers=auth)
    assert any(a["agent_id"] == agent_id for a in r.json())  # expert survives agency deletion

async def test_reassigning_member_moves_not_duplicates(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "bot"})).json()["agent_id"]
    a1 = (await c.post("/api/agencies", headers=auth, json={"name": "A"})).json()["agency_id"]
    a2 = (await c.post("/api/agencies", headers=auth, json={"name": "B"})).json()["agency_id"]

    await c.put(f"/api/agencies/members/{agent_id}", headers=auth, json={"agency_id": a1})
    r = await c.put(f"/api/agencies/members/{agent_id}", headers=auth, json={"agency_id": a2})
    assert r.status_code == 200

    detail_a1 = (await c.get(f"/api/agencies/{a1}", headers=auth)).json()
    detail_a2 = (await c.get(f"/api/agencies/{a2}", headers=auth)).json()
    assert detail_a1["experts"] == []
    assert len(detail_a2["experts"]) == 1

async def test_cannot_assign_other_users_expert(env, env_with_provider_second_user):
    c, _, auth = env
    c2, _, auth2 = env_with_provider_second_user  # second authenticated client, same server
    other_agent_id = (await c2.post("/api/agents", headers=auth2, json={"name": "theirs"})).json()["agent_id"]
    agency_id = (await c.post("/api/agencies", headers=auth, json={"name": "Mine"})).json()["agency_id"]
    r = await c.put(f"/api/agencies/members/{other_agent_id}", headers=auth, json={"agency_id": agency_id})
    assert r.status_code == 403

async def test_org_chart_empty_agency_has_no_experts_key_error(env):
    c, _, auth = env
    await c.post("/api/agencies", headers=auth, json={"name": "Empty"})
    r = await c.get("/api/agencies/org-chart", headers=auth)
    assert r.status_code == 200
    assert all("experts" in a for a in r.json()["agencies"])
```

If `env_with_provider_second_user` doesn't already exist as a fixture, check `tests/integration/conftest.py` / `tests/fixtures/` in the sandbox for the project's existing two-user test pattern (e.g. how `test_subagents_api.py` or sharing tests create a second authenticated client) and reuse that instead of inventing a new fixture name.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cp customize/backend/tests/test_agency_api.py /tmp/octop-agency-sandbox/tests/integration/
cd /tmp/octop-agency-sandbox && uv run pytest tests/integration/test_agency_api.py -q
```
Expected: FAIL — `404 Not Found` on every request (no router mounted yet).

- [ ] **Step 3: Implement `customize/backend/routers/agency.py`**

Mirror `src/octop/api/routers/teams.py`'s shape: Pydantic `AgencyCreateBody`/`AgencyPatchBody`/`AgencyMemberBody`, a `_require_owned_agency(server, user, agency_id) -> sqlite3.Row` helper (raises `OctopError(ErrorCode.NOT_FOUND)` if missing, `OctopError(ErrorCode.FORBIDDEN)` if `row["user_id"] != user.id and not user.is_admin`), and the 7 route handlers using `server.services.db.connect()`/`.transaction()` with `?`-placeholder SQL. For expert name/description/status in the detail and org-chart endpoints, look each `expert_agent_id` up via `server.app_runtime.agent_registry.get_row(...)` rather than a raw join against `agents`. Generate new ids as `f"ag_{new_short_id(6)}"`.

- [ ] **Step 4: Write the `app.py` mount patch**

In the sandbox, add the import and one `_RouterMount(agency.router, "/api", ["agency"])` line next to the existing `teams.router` line in `src/octop/api/app.py`, then:

```bash
cd /tmp/octop-agency-sandbox && git diff src/octop/api/app.py > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/01-app-py-mount-agency-router.patch
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cp customize/backend/routers/agency.py /tmp/octop-agency-sandbox/src/octop/api/routers/
cd /tmp/octop-agency-sandbox && uv run pytest tests/integration/test_agency_api.py -v
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add backend/routers/agency.py backend/tests/test_agency_api.py docs/patches/01-app-py-mount-agency-router.patch
git commit -m "feat: add agency CRUD + membership API"
```

---

### Task 4: Agency list/detail/form pages (frontend)

**Files:**
- Create: `customize/dashboard/pages/Agency/index.tsx`
- Create: `customize/dashboard/pages/Agency/components/AgencyFormModal.tsx`
- Create: `customize/dashboard/pages/Agency/components/AgencyDetail.tsx`
- Create: `customize/dashboard/pages/Agency/index.test.tsx`, `components/AgencyFormModal.test.tsx`, `components/AgencyDetail.test.tsx`

**Interfaces:**
- Consumes: Task 3's API (`GET/POST /api/agencies`, `GET/PATCH/DELETE /api/agencies/{id}`, `PUT /api/agencies/members/{expert_agent_id}`); the project's existing HTTP client helper used by other dashboard API modules (check `dashboard/src/api/modules/teams.ts` for the exact fetch wrapper/base URL convention and reuse it verbatim — do not invent a new one).
- Produces: `export default function AgencyPage(): JSX.Element` from `index.tsx` (consumed by Task 5's route patch); `AgencyDetail` takes `{ agencyId: string }` and lists/add/removes experts.

- [ ] **Step 1: Write the failing tests**

```tsx
// index.test.tsx
test("renders agency cards with member counts", async () => { /* mock fetch GET /api/agencies, assert card text */ });
test("shows empty state with 0 agencies, no crash", async () => { /* mock [] response */ });

// AgencyFormModal.test.tsx
test("submits name/description/color on save", async () => { /* fill form, click save, assert POST body */ });

// AgencyDetail.test.tsx
test("renders zero-member agency without dividing by zero or crashing", async () => { /* mock detail with experts: [] */ });
test("removing a member calls PUT .../members/{id} with agency_id: null", async () => { /* */ });
```
Follow the existing mocking style in `dashboard/src/pages/Experts/components/TeamMemberPicker.test.tsx` (same `vitest` + `@testing-library/react` conventions) rather than introducing a new test-setup pattern.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /tmp/octop-agency-sandbox/dashboard && npx vitest run src/pages/Agency` (after copying the test files in)
Expected: FAIL — module not found (components don't exist yet).

- [ ] **Step 3: Implement the three components**

`index.tsx`: fetches `GET /api/agencies`, renders a card grid (name, color swatch, `${member_count} expert(s)`), a "New Agency" button opening `AgencyFormModal`, each card linking to `AgencyDetail`.
`AgencyFormModal.tsx`: antd `Modal` + `Form` with `name`/`description`/`color` fields, calling `POST`/`PATCH` depending on whether an `agencyId` prop is passed — reference `TeamFormModal.tsx`'s layout from `orchester` for field arrangement only, write fresh code (no copy-paste, different framework: antd vs this app's own UI kit).
`AgencyDetail.tsx`: fetches `GET /api/agencies/{id}`, lists assigned experts with a "remove" action (`PUT members/{id}` with `agency_id: null`) and an "add expert" picker; check whether `dashboard/src/pages/Experts/components/TeamMemberPicker.tsx`'s props/shape can be reused as-is for "pick an expert from a list" before writing a new picker.

- [ ] **Step 4: Run tests to verify they pass**

Re-sync the sandbox (copy `index.tsx` + `components/*.tsx` into `/tmp/octop-agency-sandbox/dashboard/src/pages/Agency/`, per "Verification sandbox" above), then run: `cd /tmp/octop-agency-sandbox/dashboard && npx vitest run src/pages/Agency`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add dashboard/pages/Agency/index.tsx dashboard/pages/Agency/components/AgencyFormModal.tsx dashboard/pages/Agency/components/AgencyDetail.tsx dashboard/pages/Agency/*.test.tsx dashboard/pages/Agency/components/*.test.tsx
git commit -m "feat: add agency list/detail/form pages"
```

---

### Task 5: Org-chart view + nav/route wiring (frontend)

**Files:**
- Create: `customize/dashboard/pages/Agency/components/AgencyOrgChart.tsx`, `AgencyOrgChart.test.tsx`
- Modify: `customize/dashboard/pages/Agency/index.tsx` (created in Task 4 — add a second tab/pane so the org-chart is reachable; this is a same-repo edit to a file this plan's own Task 4 created, not an Octop patch)
- Modify (patch): `dashboard/src/routes/index.tsx` → `customize/docs/patches/02-routes-index-add-agency-route.patch`
- Modify (patch): `dashboard/src/layouts/sidebarNav.tsx` → `customize/docs/patches/03-sidebarnav-add-agency-key.patch`
- Modify (patch): `src/octop/infra/users/preferences.py` → `customize/docs/patches/04-preferences-add-agency-key.patch`

**Interfaces:**
- Consumes: Task 3's `GET /api/agencies/org-chart`; Task 4's `AgencyPage` (mounted by the route patch) and its existing card-grid markup, which this task wraps in a second tab rather than replacing.
- Produces: route `/agency` rendering `AgencyPage`, which now has two antd `Tabs` panes — "Departments" (Task 4's existing card grid, unchanged) and "Org Chart" (this task's `AgencyOrgChart`) — reachable from a sidebar item.

**Ruling (pre-flight scan, recorded before dispatch — see ledger):** Task 4's `index.tsx` only renders the card grid; nothing in Task 4 adds a chart tab. Without this task also editing `index.tsx`, `AgencyOrgChart.tsx` would be dead code with no caller. Task 4's implementer is not told about this — the edit belongs here, in the task that creates `AgencyOrgChart`.

- [ ] **Step 1: Write the failing test**

```tsx
// AgencyOrgChart.test.tsx
test("lays out agencies and experts without framer-motion, no crash on empty agencies array", async () => {
  // mock GET /api/agencies/org-chart -> { agencies: [] }
  // assert it renders without throwing
});
test("draws one connector per agency-expert pair", async () => {
  // mock one agency with 2 experts, assert 2 path-ish elements (or count via a stable test id)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/pages/Agency/components/AgencyOrgChart.test.tsx` (in sandbox)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `AgencyOrgChart.tsx`**

Port `orchester/apps/web/components/org/OrgChart.tsx`'s `bezier()` and `layoutRect()` functions verbatim (pure functions, no dependency). Replace every `motion.div`/`motion.path` with a plain `div`/`path` plus a CSS `transition` (e.g. `transition-opacity duration-300`) instead of `framer-motion`'s `initial`/`animate`/`transition` props. Replace the two-tier `teams.agents` loop with one tier: `agencies[].experts[]`. Each expert card shows `description` (not `role` — `AgentRow` has no `role` field per spec §7).

- [ ] **Step 4: Run test to verify it passes**

Re-sync the sandbox (copy `AgencyOrgChart.tsx` into `/tmp/octop-agency-sandbox/dashboard/src/pages/Agency/components/` — Task 4's files should already be there from Task 4's own Step 4, but re-copy them too if in doubt, per "Verification sandbox" above), then run: `npx vitest run src/pages/Agency/components/AgencyOrgChart.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire `AgencyOrgChart` into `customize/dashboard/pages/Agency/index.tsx`**

Edit the `index.tsx` Task 4 created: wrap the existing card-grid markup and a new `<AgencyOrgChart />` in an antd `Tabs` with two panes, `"Departments"` (existing content, unchanged) and `"Org Chart"` (new). Re-sync the sandbox (see "Verification sandbox") and run `npx vitest run src/pages/Agency` — Task 4's existing `index.test.tsx` must still pass unchanged (it tests the card grid, now inside a tab pane).

- [ ] **Step 6: Wire the route and nav in the sandbox, capture patches**

```bash
# in /tmp/octop-agency-sandbox, hand-edit the 3 files:
#  - dashboard/src/routes/index.tsx: add { path: "/agency", element: <AgencyPage /> } next to "/experts"
#  - dashboard/src/layouts/sidebarNav.tsx: add "agency" to SIDEBAR_NAV_KEYS + one NavItem (icon: Building2) after the "experts" item
#  - src/octop/infra/users/preferences.py: add "agency" to its SIDEBAR_NAV_KEYS frozenset
git diff dashboard/src/routes/index.tsx > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/02-routes-index-add-agency-route.patch
git diff dashboard/src/layouts/sidebarNav.tsx > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/03-sidebarnav-add-agency-key.patch
git diff src/octop/infra/users/preferences.py > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/04-preferences-add-agency-key.patch
```

- [ ] **Step 7: Verify the patched sandbox still builds/tests**

Run: `cd /tmp/octop-agency-sandbox/dashboard && npx vitest run && npx tsc -b`
Expected: PASS / no type errors (confirms the hand-written patches are syntactically consistent with the rest of the file).

- [ ] **Step 8: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add dashboard/pages/Agency/index.tsx dashboard/pages/Agency/components/AgencyOrgChart.tsx dashboard/pages/Agency/components/AgencyOrgChart.test.tsx docs/patches/02-*.patch docs/patches/03-*.patch docs/patches/04-*.patch
git commit -m "feat: add agency org-chart view and nav/route patches"
```

---

### Task 6: Agency picker on the Expert create/edit forms

**Files:**
- Modify (patch): `dashboard/src/pages/Experts/components/EditAgentDrawer.tsx` → `customize/docs/patches/05-editagentdrawer-agency-select.patch`
- Modify (patch): `dashboard/src/pages/Experts/components/CreateFromExpertDrawer.tsx` → `customize/docs/patches/06-createfromexpertdrawer-agency-select.patch`

**Interfaces:**
- Consumes: Task 3's `GET /api/agencies` (to populate the `Select` options) and `PUT /api/agencies/members/{expert_agent_id}`.

- [ ] **Step 1: Write the failing tests**

In the sandbox copies of the existing test files for these two drawers (or new ones if none exist — check first):

```tsx
test("EditAgentDrawer: changing the Agency select calls PUT /api/agencies/members/{id} after a successful save", async () => { /* ... */ });
test("CreateFromExpertDrawer: picking an Agency before create calls PUT /api/agencies/members/{id} with the new agent_id after a successful POST", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pages/Experts/components/EditAgentDrawer src/pages/Experts/components/CreateFromExpertDrawer` (in sandbox, after copying tests in)
Expected: FAIL — no such call made yet.

- [ ] **Step 3: Patch `EditAgentDrawer.tsx`**

Add one `Form.Item` + antd `Select` (options from `GET /api/agencies`) next to the existing `default_model` field (around the `name="default_model"` `Form.Item`, per the component's current layout). In the existing save-success path, after the expert `PATCH` succeeds, fire `PUT /api/agencies/members/{agent_id}` with the selected `agency_id` (or `null` if cleared). Do not change the expert `PATCH` payload itself.

- [ ] **Step 4: Patch `CreateFromExpertDrawer.tsx`**

Same `Select`, placed in this drawer's own field layout. After the `POST /agents/from-expert/{id}` call succeeds and returns the new `agent_id`, fire the same `PUT /api/agencies/members/{agent_id}` call.

- [ ] **Step 5: Run tests to verify they pass**

The edits to `EditAgentDrawer.tsx`/`CreateFromExpertDrawer.tsx` are made directly in the sandbox's own checkout (Steps 3–4 above already hand-edit the sandbox copy, same as Task 5's route/nav patches) — re-run from there: `cd /tmp/octop-agency-sandbox/dashboard && npx vitest run src/pages/Experts/components/EditAgentDrawer src/pages/Experts/components/CreateFromExpertDrawer`
Expected: PASS.

- [ ] **Step 6: Capture the two patches**

```bash
cd /tmp/octop-agency-sandbox
git diff dashboard/src/pages/Experts/components/EditAgentDrawer.tsx > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/05-editagentdrawer-agency-select.patch
git diff dashboard/src/pages/Experts/components/CreateFromExpertDrawer.tsx > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/06-createfromexpertdrawer-agency-select.patch
```

- [ ] **Step 7: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add docs/patches/05-*.patch docs/patches/06-*.patch
git commit -m "feat: add agency picker to expert create/edit drawers"
```

---

### Task 7: install.sh + end-to-end dry run

**Files:**
- Create: `customize/install.sh`
- Modify: `customize/README.md` (point at `install.sh`, already drafted in prior session — just confirm it matches the final file list)

**Interfaces:**
- Consumes: every file under `customize/backend/` and `customize/dashboard/`, every `customize/docs/patches/*.patch`.
- Produces: the only script allowed to write into a real `Octop/` checkout; takes one positional arg, the path to that checkout.

- [ ] **Step 1: Write `install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
OCTOP_DIR="${1:?usage: install.sh <path-to-Octop-checkout>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cp "$HERE"/backend/migrations/*.sql "$OCTOP_DIR/src/octop/infra/db/migrations/"
cp "$HERE"/backend/routers/agency.py "$OCTOP_DIR/src/octop/api/routers/agency.py"
cp "$HERE"/backend/tests/test_agency_api.py "$OCTOP_DIR/tests/integration/test_agency_api.py"
mkdir -p "$OCTOP_DIR/dashboard/src/pages/Agency/components"
cp "$HERE"/dashboard/pages/Agency/*.tsx "$OCTOP_DIR/dashboard/src/pages/Agency/"
cp "$HERE"/dashboard/pages/Agency/components/*.tsx "$OCTOP_DIR/dashboard/src/pages/Agency/components/"

echo "Copied new files. Now apply the 6 patches from inside $OCTOP_DIR:"
for p in "$HERE"/docs/patches/*.patch; do
  echo "  git -C \"$OCTOP_DIR\" apply \"$p\""
done
```

- [ ] **Step 2: Fresh-sandbox dry run**

```bash
rm -rf /tmp/octop-agency-install-check
cp -r /workspaces/codespaces-blank/Octop /tmp/octop-agency-install-check
bash /workspaces/codespaces-blank/octop-orgchester/customize/install.sh /tmp/octop-agency-install-check
for p in /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/*.patch; do
  git -C /tmp/octop-agency-install-check apply --check "$p"
done
```
Expected: every `git apply --check` succeeds with no output (this is the Review Focus item on patches that no longer apply cleanly).

- [ ] **Step 3: Apply for real and run the full suite once, end to end**

```bash
for p in /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/*.patch; do
  git -C /tmp/octop-agency-install-check apply "$p"
done
cd /tmp/octop-agency-install-check && uv run pytest tests/integration/test_agency_api.py tests/integration/test_agents_api.py -q
cd /tmp/octop-agency-install-check/dashboard && npm ci --no-audit --no-fund && npx vitest run && npx tsc -b
```
Expected: all green — this is the one point where the whole feature is proven to work together, in a disposable copy.

- [ ] **Step 4: Tear down both sandboxes**

Run: `rm -rf /tmp/octop-agency-sandbox /tmp/octop-agency-install-check`
Expected: the real `/workspaces/codespaces-blank/Octop` and `/workspaces/codespaces-blank/orchester` show no `git status` changes — confirm with `git -C /workspaces/codespaces-blank/Octop status --porcelain` (expect empty output).

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add install.sh README.md
git commit -m "feat: add install.sh and finish agency feature"
```

---

## Self-Review

**Spec coverage:** §2 Goals (menu entry, CRUD, create/edit picker, org-chart, patch-only footprint) → Tasks 4–6. §6 data model → Task 2. §7 API → Task 3. §8 frontend + patches → Tasks 4–6. §9 file/patch inventory and install mechanism → Task 7. §10 "left to builder" items (real migration number, icon choice, `TeamMemberPicker` reuse, permission scoping) are called out explicitly in Tasks 2–4 rather than pre-decided.

**Step scan:** every code step names an exact file and either an exact signature/endpoint table (Task 3) or an exact function to port and what to replace (Task 5's `bezier()`/`layoutRect()` port); no step says "handle edge cases" without a named case.

**Type consistency:** `expert_agent_id` is used consistently as the key name across Task 2's schema, Task 3's endpoint path and tests, and Task 6's `PUT` call — not renamed to `agent_id` partway through.

**Review Focus:** all 5 items map to a task's own tests — cascade-delete keeps experts (Task 3, `test_assign_member_and_delete_agency_keeps_expert`), reassignment moves not duplicates (Task 3, `test_reassigning_member_moves_not_duplicates`), cross-user assignment forbidden (Task 3, `test_cannot_assign_other_users_expert`), empty-agency rendering (Task 4 & 5's empty-state tests), patch-apply failure surfaced loudly (Task 7, `git apply --check`).

**Proportion:** this plan is longer than the ~230-line spec mainly because of the 6 patch-capture steps and the sandbox mechanics needed to honor the "never touch Octop/ directly" constraint with real, runnable tests — not because task bodies transcribe implementation; most code blocks are test assertions, SQL, or shell commands, not application logic bodies.
