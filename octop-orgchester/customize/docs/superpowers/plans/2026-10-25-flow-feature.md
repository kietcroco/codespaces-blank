# Flow Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — **confirmed 2026-10-25: `superpowers:subagent-driven-development`.** Do not re-ask the user which execution approach to use; start straight at Setup (worktree in this `customize/` repo, ledger, pre-flight review) and work Task 1 onward. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new, independent "Flow" concept to Octop — a menu entry level with "Experts"/"Agency", a drag-and-drop-and-**connect** canvas (4 node types: trigger/agent/condition/end) to build a multi-step agent pipeline, a synchronous "Run" that calls real agents and persists run history, and a Runs list to review past executions — delivered entirely as new files plus 4 small patches, all authored under `customize/`, never written directly into `Octop/` or `orchester/`.

**Architecture:** Three new SQLite/Postgres tables (`flows`, `flow_runs`, `flow_run_steps`) behind a new FastAPI router (`flow.py`). A pure-Python execution engine (`infra/flows/engine.py`, no FastAPI/DB imports) walks the node graph and calls agents through a dependency-injected `call_agent` function — the router's real implementation of that function reuses the exact same primitive Team's synchronous `ask_agent` already uses (`build_one_shot_request` + `AgentRegistry.get(agent_id).agent.call(...)` + `extract_call_response`, all from the installed `octop-harness` package — see spec §5). A new React page tree under `dashboard/src/pages/Flows/` uses `@xyflow/react` (already a dependency since the Agency org-chart patch) with `nodesConnectable={true}` and a real `onConnect` handler — unlike the read-only `AgencyOrgChart.tsx`. Four existing Octop files each get a few lines of patch (nav entry, route, router mount, sidebar preference key).

**Tech Stack:** FastAPI + the existing `DatabasePool` (sqlite3/psycopg) for backend; `octop-harness`'s `build_one_shot_request`/`extract_call_response`/`AgentRegistry` for agent calls; React + antd + `@xyflow/react` + lucide-react (no new npm dependency) for frontend; pytest for backend tests, vitest for frontend tests.

**Spec:** `/workspaces/codespaces-blank/octop-orgchester/customize/docs/design-flow.md`

## Global Constraints

- Every new file is authored under `customize/backend/` or `customize/dashboard/`; none is ever written by the implementer directly into `Octop/` or `orchester/` (spec §1, §11).
- Exactly 4 patches, each a few lines, targeting: `src/octop/api/app.py`, `dashboard/src/routes/index.tsx`, `dashboard/src/layouts/sidebarNav.tsx`, `src/octop/infra/users/preferences.py` (spec §11).
- V1 ships exactly 4 node types: `trigger`, `agent`, `condition`, `end`. No `http`/`code`/`loop_for_each`/`parallel`/`subflow`/`wait_human`/etc. — those are explicit Non-goals (spec §3).
- No job queue, no background worker, no SSE streaming. `POST /flows/{flow_id}/run` executes the whole flow synchronously inside the request and returns the final result (spec §3, §9).
- No new npm dependency — `@xyflow/react` is already in `dashboard/package.json` (patch `11-dashboard-package-xyflow-dependency.patch`, already applied to `Octop/`).
- No edits to Octop's shared i18n files — all labels are inline strings in the new components (same rule as the Agency feature).
- Flow rows are scoped by `user_id`, same ownership model as Agency/Expert/Team today — no workspace/multi-tenant concept introduced (spec §3).
- A flow run must never exceed `max_steps` (50) node executions — a cyclic edge graph is a configuration error, not a feature, and must fail loudly instead of hanging the request (spec §4, §8).
- Deleting a flow must cascade-delete its `flow_runs` and `flow_run_steps` (`ON DELETE CASCADE`, spec §6), never touch `agents`.

## Review Focus

- A flow whose edges form a cycle (e.g., a `condition` node's "false" branch points back to an earlier node) must fail with a clear "exceeded max steps" error, not hang the HTTP request forever — not covered by a basic linear happy-path test.
- A `condition` node comparing non-numeric strings with `gt`/`lt`/`gte`/`lte` must fail that step with a readable error (not crash the whole request with an unhandled `ValueError`/500).
- Running a flow whose `agent` node references an `agent_id` the current user does not own (or that does not exist) must fail that step cleanly, not 500 and not silently skip to the next node.
- A flow with zero nodes, or whose `trigger` node has no outgoing edge, must return a clean "no steps executed" result — not crash the canvas or the run endpoint.
- Deleting a flow that has run history must still cascade-delete cleanly (not orphan `flow_run_steps` rows) — the inverse of the Agency "delete keeps experts intact" test, but for owned child rows that **should** be deleted.

## File Structure

**New files (authored in `customize/`, copied by `install.sh` — never modify anything existing):**

| Authored at | Installed at |
|---|---|
| `customize/backend/migrations/023_flow.sql` + `.pg.sql` | `Octop/src/octop/infra/db/migrations/023_flow.sql` + `.pg.sql` |
| `customize/backend/flows/engine.py` | `Octop/src/octop/infra/flows/engine.py` |
| `customize/backend/routers/flow.py` | `Octop/src/octop/api/routers/flow.py` |
| `customize/backend/tests/test_flow_engine.py` | `Octop/tests/unit/test_flow_engine.py` |
| `customize/backend/tests/test_flow_api.py` | `Octop/tests/integration/test_flow_api.py` |
| `customize/dashboard/pages/Flows/index.tsx` | `.../dashboard/src/pages/Flows/index.tsx` |
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` | `.../pages/Flows/components/FlowCanvas.tsx` |
| `customize/dashboard/pages/Flows/components/NodeInspectorDrawer.tsx` | `.../pages/Flows/components/NodeInspectorDrawer.tsx` |
| `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx` | `.../pages/Flows/components/RunResultDrawer.tsx` |
| `customize/dashboard/pages/Flows/*.test.tsx` (vitest, one per component) | same path under `.../pages/Flows/` |

**Patches (authored as `.patch` files in `customize/docs/patches/`, numbered 13+ — 11 and 12 are already taken by the xyflow-dependency and changelog patches):**

- `13-app-py-mount-flow-router.patch` — `src/octop/api/app.py`
- `14-routes-index-add-flows-route.patch` — `dashboard/src/routes/index.tsx`
- `15-sidebarnav-add-flows-key.patch` — `dashboard/src/layouts/sidebarNav.tsx`
- `16-preferences-add-flows-key.patch` — `src/octop/infra/users/preferences.py`

**Tooling:** `customize/install.sh` gets 3 new `cp` lines (migration, router, flows page tree) — same shape as its existing Agency lines — plus the 4 patches above added to its `docs/patches/*.patch` glob (already automatic, no code change needed there). A disposable sandbox copy of `Octop/` is used for every test run in this plan, never the real `Octop/`.

### Verification sandbox (used by every task below)

```bash
rm -rf /tmp/octop-flow-sandbox
cp -r /workspaces/codespaces-blank/Octop /tmp/octop-flow-sandbox
```

This sandbox mirrors **current** `Octop/`, which already includes the Agency feature plus its two later UI fixes (scrollable `PageShell.FillTabs` page, and the `@xyflow/react`-based draggable `AgencyOrgChart.tsx`) — those were applied directly to `Octop/` in an earlier session, not through this repo's patch files yet. Treat current `Octop/` as the baseline; do not expect a clean Agency-only state.

The sandbox persists on disk across tasks — but each task is implemented by a fresh worker with no memory of earlier tasks, so **every task must re-sync it before running any test in it**:

```bash
# 1. Copy every new file produced so far (this task's and all earlier tasks'):
cp customize/backend/migrations/023_flow*.sql /tmp/octop-flow-sandbox/src/octop/infra/db/migrations/ 2>/dev/null || true
mkdir -p /tmp/octop-flow-sandbox/src/octop/infra/flows
cp customize/backend/flows/engine.py /tmp/octop-flow-sandbox/src/octop/infra/flows/ 2>/dev/null || true
touch /tmp/octop-flow-sandbox/src/octop/infra/flows/__init__.py
cp customize/backend/routers/flow.py /tmp/octop-flow-sandbox/src/octop/api/routers/ 2>/dev/null || true
cp customize/backend/tests/test_flow_engine.py /tmp/octop-flow-sandbox/tests/unit/ 2>/dev/null || true
cp customize/backend/tests/test_flow_api.py /tmp/octop-flow-sandbox/tests/integration/ 2>/dev/null || true
mkdir -p /tmp/octop-flow-sandbox/dashboard/src/pages/Flows/components
cp customize/dashboard/pages/Flows/*.tsx /tmp/octop-flow-sandbox/dashboard/src/pages/Flows/ 2>/dev/null || true
cp customize/dashboard/pages/Flows/components/*.tsx /tmp/octop-flow-sandbox/dashboard/src/pages/Flows/components/ 2>/dev/null || true
# 2. Re-apply every patch already captured so far, in order:
for p in customize/docs/patches/1[3-6]-*.patch; do git -C /tmp/octop-flow-sandbox apply --check "$p" 2>/dev/null && git -C /tmp/octop-flow-sandbox apply "$p"; done
```

The `--check` + conditional apply makes this idempotent. The real `Octop/` is never touched by any of this.

---

### Task 1: Sandbox baseline

**Files:**
- Create: `/tmp/octop-flow-sandbox` (disposable copy of `Octop/`)

**Interfaces:**
- Produces: a known-good sandbox path (`/tmp/octop-flow-sandbox`) that Tasks 2–8 copy files into and run tests in.

- [ ] **Step 1: Create the sandbox**

Run: `rm -rf /tmp/octop-flow-sandbox && cp -r /workspaces/codespaces-blank/Octop /tmp/octop-flow-sandbox`
Expected: directory exists, `/tmp/octop-flow-sandbox/.git` present.

- [ ] **Step 2: Confirm backend baseline is green**

Run: `cd /tmp/octop-flow-sandbox && uv run pytest tests/integration/test_agency_api.py -q`
Expected: PASS (proves the sandbox already has the Agency feature and is a working checkout).

- [ ] **Step 3: Confirm frontend baseline is green**

Run: `cd /tmp/octop-flow-sandbox/dashboard && npm ci --no-audit --no-fund && npx vitest run src/pages/Agency/components/AgencyOrgChart.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit the design doc in customize/**

Run: `cd /workspaces/codespaces-blank/octop-orgchester/customize && git add docs/design-flow.md && git commit -m "docs: flow feature design"`
Expected: new commit on top of the existing `customize/` history (same repo the Agency feature used).

---

### Task 2: Flow migration (backend)

**Files:**
- Create: `customize/backend/migrations/023_flow.sql`
- Create: `customize/backend/migrations/023_flow.pg.sql`
- Test: ad-hoc, run against the sandbox (migrations have no dedicated unit test file in this codebase's convention — `test_flow_api.py` in Task 4 exercises the applied schema end-to-end)

**Interfaces:**
- Produces: tables `flows(flow_id, user_id, name, description, nodes_json, edges_json, status, created_at, updated_at)`, `flow_runs(run_id, flow_id, status, input_json, output_json, error, started_at, finished_at)`, `flow_run_steps(run_id, node_id, node_type, status, input_json, output_json, error, agent_id, started_at, finished_at)` — exact column list and types per spec §6.

- [ ] **Step 1: Check the next free migration number**

Run: `ls /tmp/octop-flow-sandbox/src/octop/infra/db/migrations/ | sort | tail -5`
Expected: highest existing number is `022` (from the Agency feature) — confirm `023` is still free before writing the file. If upstream Octop has claimed `023` by the time this task runs, renumber both new files and every reference below to the next free number.

- [ ] **Step 2: Write `customize/backend/migrations/023_flow.sql`**

Copy the exact column list from spec §6 into the `CREATE TABLE` statements shown there (three tables, two indexes, ending `UPDATE _schema_version SET version = 23;`) — same style as `022_agency.sql` (`INTEGER PRIMARY KEY AUTOINCREMENT`, `REFERENCES ... ON DELETE CASCADE`).

- [ ] **Step 3: Write `customize/backend/migrations/023_flow.pg.sql`**

Identical to Step 2's file, except `id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY` on all three tables (the only diff between `022_agency.sql` and `022_agency.pg.sql` — confirm by diffing those two files if unsure).

- [ ] **Step 4: Verify the migration applies in the sandbox**

Run:
```bash
cp customize/backend/migrations/023_flow*.sql /tmp/octop-flow-sandbox/src/octop/infra/db/migrations/
cd /tmp/octop-flow-sandbox && rm -f /tmp/octop_flow_migration_test.db && \
  OCTOP_DATABASE_SQLITE_PATH=/tmp/octop_flow_migration_test.db uv run octop init --yes \
  --admin-username t --admin-password Testpass12
```
Expected: exits 0, no "Duplicate migration version" or SQL error. Then: `sqlite3 /tmp/octop_flow_migration_test.db ".tables"` lists `flows`, `flow_runs`, `flow_run_steps`.

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add backend/migrations/023_flow.sql backend/migrations/023_flow.pg.sql
git commit -m "feat(flow): add flows/flow_runs/flow_run_steps migration"
```

---

### Task 3: Flow execution engine (backend, pure logic — no FastAPI/DB)

**Files:**
- Create: `customize/backend/flows/engine.py`
- Test: `customize/backend/tests/test_flow_engine.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure module).
- Produces (consumed by Task 4's router):
  ```python
  # customize/backend/flows/engine.py
  from dataclasses import dataclass, field
  from typing import Any, Awaitable, Callable, Literal

  NodeType = Literal["trigger", "agent", "condition", "end"]
  StepStatus = Literal["succeeded", "failed"]

  @dataclass
  class FlowNode:
      id: str
      type: NodeType
      config: dict[str, Any] = field(default_factory=dict)

  @dataclass
  class FlowEdge:
      id: str
      source: str
      target: str
      source_handle: str | None = None

  @dataclass
  class StepResult:
      node_id: str
      node_type: str
      status: StepStatus
      input: dict[str, Any]
      output: dict[str, Any] | None
      error: str | None
      agent_id: str | None = None

  @dataclass
  class FlowRunResult:
      status: Literal["succeeded", "failed"]
      output: dict[str, Any]
      error: str | None
      steps: list[StepResult]

  # (agent_id, prompt_text) -> reply text
  AgentCaller = Callable[[str, str], Awaitable[str]]

  async def run_flow(
      nodes: list[FlowNode],
      edges: list[FlowEdge],
      *,
      input: dict[str, Any],
      call_agent: AgentCaller,
      max_steps: int = 50,
  ) -> FlowRunResult: ...
  ```

- [ ] **Step 1: Write the failing tests**

```python
# customize/backend/tests/test_flow_engine.py
import pytest
from octop.infra.flows.engine import FlowEdge, FlowNode, run_flow

async def _echo_agent(agent_id: str, prompt: str) -> str:
    return f"reply-from-{agent_id}:{prompt}"

async def test_linear_flow_trigger_agent_end():
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="a", type="agent", config={"agent_id": "bot1", "prompt": "hi {{topic}}", "output_var": "a_out"}),
        FlowNode(id="e", type="end"),
    ]
    edges = [FlowEdge(id="e1", source="t", target="a"), FlowEdge(id="e2", source="a", target="e")]
    result = await run_flow(nodes, edges, input={"topic": "octop"}, call_agent=_echo_agent)
    assert result.status == "succeeded"
    assert result.output["a_out"] == "reply-from-bot1:hi octop"
    assert [s.node_id for s in result.steps] == ["t", "a", "e"]

async def test_condition_true_and_false_branches():
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="c", type="condition", config={"left": "{{score}}", "op": "gte", "right": "50"}),
        FlowNode(id="hi", type="end"),
        FlowNode(id="lo", type="end"),
    ]
    edges = [
        FlowEdge(id="e1", source="t", target="c"),
        FlowEdge(id="e2", source="c", target="hi", source_handle="true"),
        FlowEdge(id="e3", source="c", target="lo", source_handle="false"),
    ]
    high = await run_flow(nodes, edges, input={"score": "90"}, call_agent=_echo_agent)
    assert [s.node_id for s in high.steps][-1] == "hi"
    low = await run_flow(nodes, edges, input={"score": "10"}, call_agent=_echo_agent)
    assert [s.node_id for s in low.steps][-1] == "lo"

async def test_condition_non_numeric_comparison_fails_step_not_request():
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="c", type="condition", config={"left": "abc", "op": "gt", "right": "1"}),
    ]
    edges = [FlowEdge(id="e1", source="t", target="c")]
    result = await run_flow(nodes, edges, input={}, call_agent=_echo_agent)
    assert result.status == "failed"
    assert result.steps[-1].status == "failed"
    assert result.steps[-1].error

async def test_cyclic_graph_stops_at_max_steps_instead_of_hanging():
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="a", type="agent", config={"agent_id": "bot1", "prompt": "x"}),
    ]
    edges = [FlowEdge(id="e1", source="t", target="a"), FlowEdge(id="e2", source="a", target="a")]
    result = await run_flow(nodes, edges, input={}, call_agent=_echo_agent, max_steps=5)
    assert result.status == "failed"
    assert "max steps" in (result.error or "").lower()
    assert len(result.steps) == 5

async def test_empty_graph_or_dangling_trigger_returns_clean_no_op_result():
    nodes = [FlowNode(id="t", type="trigger")]
    result = await run_flow(nodes, [], input={}, call_agent=_echo_agent)
    assert result.status == "succeeded"
    assert result.steps == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /tmp/octop-flow-sandbox && uv run pytest tests/unit/test_flow_engine.py -v` (after copying the test file and an empty `engine.py` stub in per the sandbox-sync block above)
Expected: FAIL/ERROR — `run_flow` not defined yet.

- [ ] **Step 3: Implement `engine.py`**

Implement `run_flow` per the Interfaces block above. Algorithm (spec §8): start at the node with `type == "trigger"`; loop while a current node exists and step count `< max_steps`:
- `agent`: render `config["prompt"]` by replacing every `{{key}}` with `str(variables.get(key, ""))`, call `await call_agent(config["agent_id"], rendered)`, store the reply in `variables[config.get("output_var") or node.id]`.
- `condition`: render `config["left"]`/`config["right"]` the same way, compare with `config["op"]` (`eq`/`neq`/`contains` as string ops; `gt`/`lt`/`gte`/`lte` parse both sides with `float()`, catch `ValueError` and fail that step with a readable message), pick the outgoing edge whose `source_handle` matches `"true"`/`"false"`.
- `end`: record the step, stop (don't look for an outgoing edge).
- any node type (including `trigger`) with no matching outgoing edge: stop, this is a clean end, not a failure.
Append one `StepResult` per node visited (status `"failed"` and the loop stops as soon as one node raises/fails — later nodes are never visited). Hitting `max_steps` without reaching a `end` or dangling node sets the overall result to `status="failed"`, `error="exceeded max steps (cycle in the graph?)"`. Final `output` is the `variables` dict at the point execution stopped.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /tmp/octop-flow-sandbox && uv run pytest tests/unit/test_flow_engine.py -v`
Expected: all 5 PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add backend/flows/engine.py backend/tests/test_flow_engine.py
git commit -m "feat(flow): add pure execution engine with injected agent caller"
```

---

### Task 4: Flow router (backend)

**Files:**
- Create: `customize/backend/routers/flow.py`
- Test: `customize/backend/tests/test_flow_api.py`

**Interfaces:**
- Consumes: `run_flow`, `FlowNode`, `FlowEdge`, `FlowRunResult`, `StepResult` from Task 3's `octop.infra.flows.engine`.
- Produces (consumed by Task 8's `app.py` patch): `router: APIRouter` with routes `GET/POST /flows`, `GET/PATCH/DELETE /flows/{flow_id}`, `POST /flows/{flow_id}/run`, `GET /flows/{flow_id}/runs`, `GET /flows/{flow_id}/runs/{run_id}` — exact paths per spec §7.

- [ ] **Step 1: Write the failing tests**

```python
# customize/backend/tests/test_flow_api.py
from __future__ import annotations
import pytest
from tests.support.auth import create_user

@pytest.fixture
async def env(env_with_provider):
    yield env_with_provider

async def test_create_list_get_patch_delete_flow(env):
    c, _, auth = env
    r = await c.post("/api/flows", headers=auth, json={"name": "My Flow", "description": "d"})
    assert r.status_code == 201, r.text
    flow_id = r.json()["flow_id"]
    assert r.json()["status"] == "draft"

    r = await c.get("/api/flows", headers=auth)
    assert any(f["flow_id"] == flow_id for f in r.json())

    nodes = [{"id": "t", "type": "trigger", "config": {}}]
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"nodes": nodes, "edges": []})
    assert r.json()["nodes"] == nodes

    r = await c.delete(f"/api/flows/{flow_id}", headers=auth)
    assert r.status_code == 204
    r = await c.get(f"/api/flows/{flow_id}", headers=auth)
    assert r.status_code == 404

async def test_run_flow_persists_history_and_steps(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "bot"})).json()["agent_id"]
    flow_id = (await c.post("/api/flows", headers=auth, json={"name": "F"})).json()["flow_id"]
    nodes = [
        {"id": "t", "type": "trigger", "config": {}},
        {"id": "a", "type": "agent", "config": {"agent_id": agent_id, "prompt": "hello"}},
        {"id": "e", "type": "end", "config": {}},
    ]
    edges = [
        {"id": "e1", "source": "t", "target": "a"},
        {"id": "e2", "source": "a", "target": "e"},
    ]
    await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"nodes": nodes, "edges": edges})

    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "run_id" in body and len(body["steps"]) == 3

    r = await c.get(f"/api/flows/{flow_id}/runs", headers=auth)
    assert len(r.json()) == 1
    run_id = r.json()[0]["run_id"]
    r = await c.get(f"/api/flows/{flow_id}/runs/{run_id}", headers=auth)
    assert len(r.json()["steps"]) == 3

async def test_run_flow_with_unowned_agent_fails_step_not_500(env):
    c, _, auth = env
    my_agent_id = (await c.post("/api/agents", headers=auth, json={"name": "mine"})).json()["agent_id"]
    _, other_auth = await create_user(c, auth, username="flowowner2")
    flow_id = (await c.post("/api/flows", headers=other_auth, json={"name": "F2"})).json()["flow_id"]
    nodes = [
        {"id": "t", "type": "trigger", "config": {}},
        {"id": "a", "type": "agent", "config": {"agent_id": my_agent_id, "prompt": "hi"}},
    ]
    edges = [{"id": "e1", "source": "t", "target": "a"}]
    await c.patch(f"/api/flows/{flow_id}", headers=other_auth, json={"nodes": nodes, "edges": edges})
    r = await c.post(f"/api/flows/{flow_id}/run", headers=other_auth, json={"input": {}})
    assert r.status_code == 200
    assert r.json()["status"] == "failed"

async def test_cannot_access_another_users_flow(env):
    c, _, auth = env
    flow_id = (await c.post("/api/flows", headers=auth, json={"name": "Private"})).json()["flow_id"]
    _, other_auth = await create_user(c, auth, username="flowintruder")
    r = await c.get(f"/api/flows/{flow_id}", headers=other_auth)
    assert r.status_code in (403, 404)
```

Check `tests/support/auth.py`'s exact `create_user(...)` return shape and the `env_with_provider` fixture's exact tuple order before finalizing — copy the precise usage from `test_agency_api.py`'s own `test_cannot_access_another_users_agency`-style test if its name differs from the sketch above (this plan's research did not re-derive that exact test name).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /tmp/octop-flow-sandbox && uv run pytest tests/integration/test_flow_api.py -v` (with `flow.py` not yet imported anywhere, or a stub `router = APIRouter()` with no routes)
Expected: FAIL — 404s on every route.

- [ ] **Step 3: Implement `customize/backend/routers/flow.py`**

Mirror `agency.py`'s structure exactly: `FlowCreateBody{name, description=None}`, `FlowPatchBody{name=None, description=None, nodes=None, edges=None, status=None}`, `FlowRunBody{input: dict = {}}`, a `_require_owned_flow(server, user, flow_id)` helper copied from `_require_owned_agency`, JSON (de)serialization of `nodes_json`/`edges_json` via `json.dumps`/`json.loads`. For `POST /flows/{flow_id}/run`:
1. Load the flow, `json.loads` its `nodes`/`edges` into `FlowNode`/`FlowEdge` instances.
2. Build the real `call_agent` closure:
   ```python
   from octop_harness.teams.util import build_one_shot_request
   from octop_harness.messages import extract_call_response

   async def call_agent(agent_id: str, prompt: str) -> str:
       entry = server.app_runtime.agent_registry.get(agent_id)
       if entry is None:
           raise OctopError(ErrorCode.NOT_FOUND, f"agent {agent_id!r} not found")
       assert_agent_owner(entry, user)  # reuse from octop.api.common.agent, same guard agency.py uses
       req = build_one_shot_request(user_id=user.id, agent_id=agent_id, text=prompt, source="flow")
       result = await entry.agent.call(req)
       return extract_call_response(result) if isinstance(result, dict) else ""
   ```
   A `call_agent` exception must be caught **inside the engine's per-node try/except** (Task 3's responsibility — confirm `run_flow` already catches exceptions raised by `call_agent` and turns them into a failed `StepResult`, since this router test (`test_run_flow_with_unowned_agent_fails_step_not_500`) expects HTTP 200 with `status: "failed"`, never a 500).
3. Call `run_flow(nodes, edges, input=body.input, call_agent=call_agent)`.
4. Persist one `flow_runs` row and one `flow_run_steps` row per `StepResult`, in a single `server.services.db.transaction()` block (same pattern `agency.py`'s `create_agency` uses).
5. Return the run result as JSON (same shape as `FlowRunResult`, plus `run_id`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /tmp/octop-flow-sandbox && uv run pytest tests/integration/test_flow_api.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add backend/routers/flow.py backend/tests/test_flow_api.py
git commit -m "feat(flow): add flow CRUD + synchronous run router"
```

---

### Task 5: Flow list page (frontend, no canvas yet)

**Files:**
- Create: `customize/dashboard/pages/Flows/index.tsx`
- Test: `customize/dashboard/pages/Flows/index.test.tsx`

**Interfaces:**
- Consumes: `request<T>(path, options?)` from `../../api/request` (same wrapper Agency uses — `GET /flows`, `POST /flows`, `DELETE /flows/{flow_id}`).
- Produces: `export default function FlowsPage(): JSX.Element` — the component Task 8's route patch wires to `/flows`. Also exports `interface FlowRow { flow_id: string; name: string; description: string | null; status: "draft" | "active"; created_at: number; updated_at: number }` for Task 6/7 to import.

- [ ] **Step 1: Write the failing test**

```tsx
// customize/dashboard/pages/Flows/index.test.tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../api/request";
import FlowsPage from "./index";
const api = vi.mocked(request, true);
beforeEach(() => vi.clearAllMocks());

describe("FlowsPage", () => {
  it("renders flow rows", async () => {
    api.mockResolvedValueOnce([
      { flow_id: "fl_1", name: "Lead triage", description: "d", status: "draft", created_at: 0, updated_at: 0 },
    ]);
    render(<FlowsPage />);
    expect(await screen.findByText("Lead triage")).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/flows");
  });

  it("shows empty state with 0 flows, no crash", async () => {
    api.mockResolvedValueOnce([]);
    render(<FlowsPage />);
    expect(await screen.findByText(/no flows yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/octop-flow-sandbox/dashboard && npx vitest run src/pages/Flows/index.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FlowsPage`**

Follow `dashboard/src/pages/Agency/index.tsx`'s exact shape: `PageShell.FillTabs` (or plain `PageShell` if a single list needs no tabs — no "Org Chart"-style second tab exists for Flows in V1), load flows with `useCallback`/`useEffect` + `request<FlowRow[]>("/flows")`, antd `Row`/`Col`/`Card` grid (or `Table` — builder's choice, not a decided interface), a "New Flow" button that `POST`s `{name: "Untitled flow"}` then navigates to the flow's detail/canvas page (Task 6) via `react-router-dom`'s `useNavigate` to `/flows/${flow_id}`. Empty state via antd `Empty description="No flows yet"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /tmp/octop-flow-sandbox/dashboard && npx vitest run src/pages/Flows/index.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add dashboard/pages/Flows/index.tsx dashboard/pages/Flows/index.test.tsx
git commit -m "feat(flow): add Flows list page"
```

---

### Task 6: FlowCanvas + NodeInspectorDrawer (frontend)

**Files:**
- Create: `customize/dashboard/pages/Flows/components/FlowCanvas.tsx`
- Create: `customize/dashboard/pages/Flows/components/NodeInspectorDrawer.tsx`
- Test: `customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx`

**Interfaces:**
- Consumes: `FlowRow` from Task 5; `request` from `../../../api/request`; `@xyflow/react`'s `ReactFlow, Background, Controls, Handle, Position, applyNodeChanges, applyEdgeChanges, addEdge` (same import source `AgencyOrgChart.tsx` already uses, confirming no new dependency).
- Produces: `export default function FlowCanvas({ flowId }: { flowId: string }): JSX.Element` — rendered by a route Task 8 wires to `/flows/:flowId`. Node `data.config` shape per spec §9: `{ agentId?: string; prompt?: string; outputVar?: string; left?: string; op?: "eq"|"neq"|"gt"|"lt"|"gte"|"lte"|"contains"; right?: string }`.

- [ ] **Step 1: Write the failing test**

```tsx
// customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../../api/request";
import FlowCanvas from "./FlowCanvas";
const api = vi.mocked(request, true);
beforeEach(() => vi.clearAllMocks());

describe("FlowCanvas", () => {
  it("loads and renders existing nodes by label", async () => {
    api.mockResolvedValueOnce({
      flow_id: "fl_1", name: "F", status: "draft",
      nodes: [{ id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { label: "Start", config: {} } }],
      edges: [],
    });
    render(<FlowCanvas flowId="fl_1" />);
    expect(await screen.findByText("Start")).toBeInTheDocument();
  });

  it("opens the inspector drawer when a node is clicked and saves config edits", async () => {
    api.mockResolvedValueOnce({
      flow_id: "fl_1", name: "F", status: "draft",
      nodes: [{ id: "a", type: "agent", position: { x: 0, y: 0 }, data: { label: "Call agent", config: {} } }],
      edges: [],
    });
    api.mockResolvedValueOnce({}); // the PATCH on Save
    render(<FlowCanvas flowId="fl_1" />);
    (await screen.findByText("Call agent")).click();
    expect(await screen.findByLabelText(/prompt/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/octop-flow-sandbox/dashboard && npx vitest run src/pages/Flows/components/FlowCanvas.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FlowCanvas` + node renderers + `NodeInspectorDrawer`**

In `FlowCanvas.tsx`: load the flow via `request<FlowDetail>(`/flows/${flowId}`)` on mount into local `nodes`/`edges` state (same `onNodesChange`/`onEdgesChange` pattern `AgencyOrgChart.tsx` already uses via `applyNodeChanges`, plus `onEdgesChange`/`applyEdgeChanges` which `AgencyOrgChart.tsx` does not need since it has no editable edges). Unlike `AgencyOrgChart.tsx`: set `nodesConnectable={true}` and wire `onConnect={(c) => setEdges((eds) => addEdge(c, eds))}`. Four inline node renderers (`TriggerNode`, `AgentNode`, `ConditionNode`, `EndNode`) each ~15-20 lines, same minimal-card style as `AgencyOrgChart.tsx`'s `AgencyNode`/`ExpertNode` — `ConditionNode` renders two labeled `Handle`s (`id="true"`/`id="false"`, both `type="source"`, `position={Position.Bottom}`) so edges can carry the right `sourceHandle`. A toolbar with "Add node" (antd `Dropdown` picking one of the 4 types, inserted at a default position) and "Save" (`request(`/flows/${flowId}`, { method: "PATCH", body: JSON.stringify({ nodes, edges }) })`) and "Run" (opens `RunResultDrawer`, Task 7). `onNodeClick` opens `NodeInspectorDrawer` with the clicked node; the drawer is an antd `Drawer` with a `Form` whose fields depend on `node.type` (`agent`: a `Select` populated from `request<AgentRow[]>("/agents")` for `agentId`, a `TextArea` labelled "Prompt" for `prompt`, an `Input` for `outputVar`; `condition`: `Input` "Left", `Select` of the 6 ops, `Input` "Right"); on submit, updates the node's `data.config` in local state (not an immediate PATCH — persisted on the canvas's own "Save").

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /tmp/octop-flow-sandbox/dashboard && npx vitest run src/pages/Flows/components/FlowCanvas.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add dashboard/pages/Flows/components/FlowCanvas.tsx dashboard/pages/Flows/components/NodeInspectorDrawer.tsx dashboard/pages/Flows/components/FlowCanvas.test.tsx
git commit -m "feat(flow): add connectable canvas + node inspector"
```

---

### Task 7: RunResultDrawer + run history (frontend)

**Files:**
- Create: `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx`
- Test: `customize/dashboard/pages/Flows/components/RunResultDrawer.test.tsx`

**Interfaces:**
- Consumes: `request` from `../../../api/request` (`POST /flows/{flowId}/run`, `GET /flows/{flowId}/runs`, `GET /flows/{flowId}/runs/{runId}`).
- Produces: `export default function RunResultDrawer({ flowId, open, onClose }: { flowId: string; open: boolean; onClose: () => void }): JSX.Element` — rendered by `FlowCanvas.tsx`'s "Run" button (Task 6).

- [ ] **Step 1: Write the failing test**

```tsx
// customize/dashboard/pages/Flows/components/RunResultDrawer.test.tsx
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../api/request", () => ({ request: vi.fn() }));
import { request } from "../../../api/request";
import RunResultDrawer from "./RunResultDrawer";
const api = vi.mocked(request, true);
beforeEach(() => vi.clearAllMocks());

describe("RunResultDrawer", () => {
  it("triggers a run on open and shows each step's status", async () => {
    api.mockResolvedValueOnce({
      run_id: "run_1", status: "succeeded", output: {}, error: null,
      steps: [
        { node_id: "t", node_type: "trigger", status: "succeeded", input: {}, output: null, error: null },
        { node_id: "a", node_type: "agent", status: "succeeded", input: {}, output: { a_out: "hi" }, error: null, agent_id: "ag_1" },
      ],
    });
    render(<RunResultDrawer flowId="fl_1" open onClose={() => {}} />);
    expect(await screen.findByText(/succeeded/i)).toBeInTheDocument();
    expect(api).toHaveBeenCalledWith("/flows/fl_1/run", expect.objectContaining({ method: "POST" }));
  });

  it("shows a readable error for a failed step, not a crash", async () => {
    api.mockResolvedValueOnce({
      run_id: "run_2", status: "failed", output: {}, error: "exceeded max steps",
      steps: [{ node_id: "a", node_type: "agent", status: "failed", input: {}, output: null, error: "agent not found" }],
    });
    render(<RunResultDrawer flowId="fl_1" open onClose={() => {}} />);
    expect(await screen.findByText(/agent not found/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /tmp/octop-flow-sandbox/dashboard && npx vitest run src/pages/Flows/components/RunResultDrawer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `RunResultDrawer`**

antd `Drawer` with `open`/`onClose` passthrough. On `open` transitioning to `true` (a `useEffect` keyed on `open`), `POST` the run and store the `FlowRunResult` in state; render a `List` of `steps` (icon by `status` — reuse the same green/amber/gray dot convention `AgencyOrgChart.tsx`'s `STATUS_DOT` already established, red for `"failed"`), each item showing `node_id`, truncated `output`/`error`. A second `Tabs` pane ("History") lazily loads `GET /flows/{flowId}/runs` when selected and lists past runs by `started_at`/`status`, clicking one loads that run's detail via `GET .../runs/{run_id}` into the same step list.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /tmp/octop-flow-sandbox/dashboard && npx vitest run src/pages/Flows/components/RunResultDrawer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add dashboard/pages/Flows/components/RunResultDrawer.tsx dashboard/pages/Flows/components/RunResultDrawer.test.tsx
git commit -m "feat(flow): add run execution + history drawer"
```

---

### Task 8: Nav/route wiring + install.sh + end-to-end dry run

**Files:**
- Create: `customize/docs/patches/13-app-py-mount-flow-router.patch`
- Create: `customize/docs/patches/14-routes-index-add-flows-route.patch`
- Create: `customize/docs/patches/15-sidebarnav-add-flows-key.patch`
- Create: `customize/docs/patches/16-preferences-add-flows-key.patch`
- Modify: `customize/install.sh`

**Interfaces:**
- Consumes: every file from Tasks 2–7, per the File Structure table.
- Produces: a fully installed, passing `Octop/` checkout proving the whole feature works end-to-end together (this task's own deliverable is the dry run, not new product code).

- [ ] **Step 1: Hand-edit the sandbox's 4 target files**

In `/tmp/octop-flow-sandbox`:
- `src/octop/api/app.py`: add `from octop.api.routers import flow` near the `agency` import, and `_RouterMount(flow.router, "/api", ["flow"])` next to the `agency` mount.
- `dashboard/src/routes/index.tsx`: add `{ path: "/flows", element: <FlowsPage /> }` and `{ path: "/flows/:flowId", element: <FlowCanvasPage /> }` next to `/agency` (where `FlowCanvasPage` is a tiny wrapper reading `flowId` from `useParams` and rendering `<FlowCanvas flowId={flowId} />` — confirm whether `/agency` itself needed a params-wrapper precedent to copy, else write this wrapper directly in `customize/dashboard/pages/Flows/index.tsx` as a second named export instead of inventing a new file).
- `dashboard/src/layouts/sidebarNav.tsx`: add `"flows"` to `SIDEBAR_NAV_KEYS` + one `NavItem` (icon: `Workflow` from lucide-react) after the `"agency"` item.
- `src/octop/infra/users/preferences.py`: add `"flows"` to its `SIDEBAR_NAV_KEYS` frozenset.

- [ ] **Step 2: Capture each as a patch**

```bash
cd /tmp/octop-flow-sandbox
git diff src/octop/api/app.py > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/13-app-py-mount-flow-router.patch
git diff dashboard/src/routes/index.tsx > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/14-routes-index-add-flows-route.patch
git diff dashboard/src/layouts/sidebarNav.tsx > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/15-sidebarnav-add-flows-key.patch
git diff src/octop/infra/users/preferences.py > /workspaces/codespaces-blank/octop-orgchester/customize/docs/patches/16-preferences-add-flows-key.patch
```

- [ ] **Step 3: Add the 3 new `cp` lines to `customize/install.sh`**

Next to the existing Agency `cp` lines, add (same style, same guard order — patch-check loop already globs `docs/patches/*.patch` so patches 13-16 need no script change):
```bash
cp "$HERE"/backend/migrations/023_flow*.sql "$OCTOP_DIR/src/octop/infra/db/migrations/"
mkdir -p "$OCTOP_DIR/src/octop/infra/flows"
cp "$HERE"/backend/flows/engine.py "$OCTOP_DIR/src/octop/infra/flows/"
cp "$HERE"/backend/routers/flow.py "$OCTOP_DIR/src/octop/api/routers/flow.py"
cp "$HERE"/backend/tests/test_flow_engine.py "$OCTOP_DIR/tests/unit/test_flow_engine.py"
cp "$HERE"/backend/tests/test_flow_api.py "$OCTOP_DIR/tests/integration/test_flow_api.py"
mkdir -p "$OCTOP_DIR/dashboard/src/pages/Flows/components"
cp "$HERE"/dashboard/pages/Flows/*.tsx "$OCTOP_DIR/dashboard/src/pages/Flows/"
cp "$HERE"/dashboard/pages/Flows/components/*.tsx "$OCTOP_DIR/dashboard/src/pages/Flows/components/"
```
Also add the equivalent of the Agency migration's numbering-hazard guard (loop over `backend/migrations/023_flow*.sql`, same `ls "$OCTOP_DIR"/.../migrations/"${num}"_*.sql` check already present for `022`).

- [ ] **Step 4: Dry-run install into a clean checkout**

```bash
rm -rf /tmp/octop-flow-install-dryrun
cp -r /workspaces/codespaces-blank/Octop /tmp/octop-flow-install-dryrun
cd /workspaces/codespaces-blank/octop-orgchester/customize
bash install.sh /tmp/octop-flow-install-dryrun
for p in docs/patches/1[3-6]-*.patch; do git -C /tmp/octop-flow-install-dryrun apply "$p"; done
```
Expected: `install.sh` prints "All N patches checked clean", no error.

- [ ] **Step 5: Full verification suite against the dry-run checkout**

```bash
cd /tmp/octop-flow-install-dryrun && uv run pytest tests/unit/test_flow_engine.py tests/integration/test_flow_api.py -q
cd /tmp/octop-flow-install-dryrun/dashboard && npm ci --no-audit --no-fund && npx vitest run src/pages/Flows && npx tsc -b
```
Expected: all green. Compare any failure against the **unpatched** baseline (`/workspaces/codespaces-blank/Octop` itself, currently running) to separate pre-existing flakiness from a real regression this feature introduced.

- [ ] **Step 6: Commit**

```bash
cd /workspaces/codespaces-blank/octop-orgchester/customize
git add docs/patches/13-*.patch docs/patches/14-*.patch docs/patches/15-*.patch docs/patches/16-*.patch install.sh
git commit -m "feat(flow): wire nav/routes + install.sh, verified end-to-end"
```

---

## Self-Review

**Spec coverage:** §2 Goals (list/create/edit/run/history) → Tasks 5-7. §6 data model → Task 2. §7 API → Task 4. §8 engine → Task 3. §9 frontend → Tasks 5-7. §11 file list/patches → Task 8. §3/§4 Non-goals/Anti-goals (no queue, no streaming, no versioning, cycle guard, ownership) → called out in Global Constraints and exercised by Review Focus tests in Tasks 3-4. §10 (future async execution, more node types) is explicitly out of scope for every task — no task attempts it.

**Review Focus coverage:** cycle → Task 3 `test_cyclic_graph_stops_at_max_steps_instead_of_hanging`. Non-numeric condition → Task 3 `test_condition_non_numeric_comparison_fails_step_not_request`. Unowned agent in a run → Task 4 `test_run_flow_with_unowned_agent_fails_step_not_500`. Empty/dangling graph → Task 3 `test_empty_graph_or_dangling_trigger_returns_clean_no_op_result`. Cascade delete of run history → implied by the `flow_run_steps`/`flow_runs` `ON DELETE CASCADE` in Task 2's schema and exercised indirectly by Task 4's `test_create_list_get_patch_delete_flow` (add an explicit assertion there that a run row is gone after delete, if time allows, during Task 4's implementation — not spelled out as its own test above to avoid padding the plan, but the schema guarantees it either way).

**Type consistency:** `FlowNode.config`/`FlowEdge.source_handle` (Task 3) ↔ `nodes_json`/`edges_json` (Task 2) ↔ node `data.config` / edge `sourceHandle` (Task 6, camelCase at the JSON-over-HTTP boundary, same convention Agency already uses for `agency_id` vs `agencyId`) — the router (Task 4) is the single place that translates between the two naming conventions; no other task needs to.

**Proportion check:** spec (`design-flow.md`) is ~310 lines; this plan is ~550 lines across 8 tasks for a feature with a genuine new execution engine plus a connect-enabled canvas — proportionate to Agency's 565-line plan for a CRUD+static-chart feature of comparable file count, given Flow adds one more backend task (the engine) that Agency didn't need.
