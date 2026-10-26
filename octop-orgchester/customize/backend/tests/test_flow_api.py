"""Flow API — CRUD + synchronous run execution.

NOTE on ``create_user``'s return shape: the plan's own skeleton had
``_, other_auth = await create_user(...)`` in two tests below. That is
wrong — ``tests.support.auth.create_user(client, admin_auth, *, username,
...)`` returns a single ``dict[str, str]`` of auth headers, not a
``(user, auth)`` tuple (confirmed by reading ``tests/support/auth.py``
directly, and by how ``test_agency_api.py`` already calls it:
``other_auth = await create_user(c, admin_auth, username="agency_other")``,
no tuple unpacking). Both occurrences below use the plain return value.

NOTE on agent invocation: ``flow.py``'s ``call_agent`` uses
``agent_registry.call()`` (production-correct — see the comment on that
closure). ``tests.support.fakes.FakeHarnessAgent`` (shared, pre-existing
Octop test infra) implements ``.stream()`` but not ``.call()``, so any test
that runs a flow through a real ``agent`` node needs the
``_patch_fake_agent_call`` fixture below, which monkeypatches a working
``.call()`` onto the fake for the duration of that test only.
"""

from __future__ import annotations

import pytest

from tests.support.auth import create_user


@pytest.fixture
async def env(env_with_provider):
    yield env_with_provider


@pytest.fixture
def _patch_fake_agent_call(monkeypatch):
    """Give the shared test double a working ``.call()``.

    ``tests.support.fakes.FakeHarnessAgent`` (pre-existing Octop test
    infrastructure, used by every integration test that creates an agent)
    implements ``.stream()`` but not ``.call()``. Production code's
    ``AgentManager.call`` bottoms out in ``entry.agent.call(prepared)`` —
    the real ``HarnessAgent.call`` (``octop_harness/agent.py``) returns a
    ``{"messages": [...]}``-shaped dict, which
    ``octop_harness.messages.extract_call_response`` parses by scanning in
    reverse for the last assistant/ai message with non-empty text. This
    fixture gives the fake an equivalent ``.call()`` returning that exact
    shape, scoped to this test module only (via ``monkeypatch``) — it does
    not edit ``tests/support/fakes.py`` itself.
    """
    from tests.support.fakes import FakeHarnessAgent

    async def _fake_call(self: FakeHarnessAgent, request: dict) -> dict:
        return {"messages": [{"role": "assistant", "content": "fake reply"}]}

    monkeypatch.setattr(FakeHarnessAgent, "call", _fake_call, raising=False)


async def test_create_list_get_patch_delete_flow(env, _patch_fake_agent_call):
    c, srv, auth = env
    r = await c.post("/api/flows", headers=auth, json={"name": "My Flow", "description": "d"})
    assert r.status_code == 201, r.text
    flow_id = r.json()["flow_id"]
    assert r.json()["status"] == "draft"

    r = await c.get("/api/flows", headers=auth)
    assert any(f["flow_id"] == flow_id for f in r.json())

    nodes = [{"id": "t", "type": "trigger", "config": {}}]
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"nodes": nodes, "edges": []})
    assert r.json()["nodes"] == nodes

    # --- Cascade-delete coverage (required by the plan's Global Constraints /
    # Review Focus, which the plan's own Self-Review admits this sketch didn't
    # exercise): deleting a flow must cascade-delete its flow_runs and
    # flow_run_steps, not just the flows row. Build a real agent-step graph so
    # the run leaves behind both a flow_runs row AND flow_run_steps rows
    # (not an empty/trigger-only run), then delete and confirm the run
    # history is gone along with the flow itself.
    agent_id = (
        await c.post("/api/agents", headers=auth, json={"name": "cascade-bot"})
    ).json()["agent_id"]
    cascade_nodes = [
        {"id": "t", "type": "trigger", "config": {}},
        {"id": "a", "type": "agent", "config": {"agent_id": agent_id, "prompt": "hi"}},
        {"id": "e", "type": "end", "config": {}},
    ]
    cascade_edges = [
        {"id": "e1", "source": "t", "target": "a"},
        {"id": "e2", "source": "a", "target": "e"},
    ]
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": cascade_nodes, "edges": cascade_edges, "status": "active"},
    )
    run_resp = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert run_resp.status_code == 200, run_resp.text
    assert len(run_resp.json()["steps"]) == 3  # trigger, agent, end all recorded
    run_id = run_resp.json()["run_id"]

    runs_before = await c.get(f"/api/flows/{flow_id}/runs", headers=auth)
    assert len(runs_before.json()) == 1

    r = await c.delete(f"/api/flows/{flow_id}", headers=auth)
    assert r.status_code == 204
    r = await c.get(f"/api/flows/{flow_id}", headers=auth)
    assert r.status_code == 404

    # Cascade: run history must not survive flow deletion either. The
    # GET .../runs -> 404 only proves the *parent* flows row is gone
    # (_require_owned_flow 404s before ever querying flow_runs/
    # flow_run_steps) — it would pass identically even if delete_flow left
    # orphaned child rows behind. Query the DB directly, by the specific
    # run_id captured above, to actually prove the child rows are gone too.
    r = await c.get(f"/api/flows/{flow_id}/runs", headers=auth)
    assert r.status_code == 404

    with srv.services.db.connect() as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) AS c FROM flow_runs WHERE run_id = ?", (run_id,)
            ).fetchone()["c"]
            == 0
        )
        assert (
            conn.execute(
                "SELECT COUNT(*) AS c FROM flow_run_steps WHERE run_id = ?", (run_id,)
            ).fetchone()["c"]
            == 0
        )


async def test_run_flow_persists_history_and_steps(env, _patch_fake_agent_call):
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
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": nodes, "edges": edges, "status": "active"},
    )

    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "run_id" in body and len(body["steps"]) == 3
    # Proves the real extract_call_response path actually ran end-to-end
    # (not a lucky empty-string coincidence): the agent step's output must
    # carry the fake call's assistant text through call_agent -> run_flow.
    agent_step = next(s for s in body["steps"] if s["node_type"] == "agent")
    assert agent_step["status"] == "succeeded"
    assert agent_step["output"] == {"a": "fake reply"}

    r = await c.get(f"/api/flows/{flow_id}/runs", headers=auth)
    assert len(r.json()) == 1
    run_id = r.json()[0]["run_id"]
    r = await c.get(f"/api/flows/{flow_id}/runs/{run_id}", headers=auth)
    assert len(r.json()["steps"]) == 3


async def test_run_flow_with_unowned_agent_fails_step_not_500(env):
    c, _, auth = env
    my_agent_id = (await c.post("/api/agents", headers=auth, json={"name": "mine"})).json()["agent_id"]
    other_auth = await create_user(c, auth, username="flowowner2")
    flow_id = (await c.post("/api/flows", headers=other_auth, json={"name": "F2"})).json()["flow_id"]
    nodes = [
        {"id": "t", "type": "trigger", "config": {}},
        {"id": "a", "type": "agent", "config": {"agent_id": my_agent_id, "prompt": "hi"}},
    ]
    edges = [{"id": "e1", "source": "t", "target": "a"}]
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=other_auth,
        json={"nodes": nodes, "edges": edges, "status": "active"},
    )
    r = await c.post(f"/api/flows/{flow_id}/run", headers=other_auth, json={"input": {}})
    assert r.status_code == 200
    assert r.json()["status"] == "failed"


async def test_run_persisted_xyflow_shaped_graph_with_condition_branching(
    env, _patch_fake_agent_call
):
    """The boundary C1 fixes: PATCH genuinely xyflow-shaped nodes/edges (the
    exact shape ``FlowCanvas.tsx`` saves — ``position``, ``data.config``
    with camelCase ``agentId``/``outputVar``, edge ``sourceHandle``), not
    the engine's flat shape every other test in this file uses, then POST
    /run and confirm it succeeds end-to-end — including a condition node's
    true/false branch resolved via ``sourceHandle``.

    Before the router's ``_to_engine_graph`` normalizer, this exact PATCH
    body 500'd on ``FlowNode(**n)`` ("unexpected keyword argument
    'position'"). Neither of the other tests above would have caught that:
    they all PATCH already-flat/engine-shaped JSON directly.
    """
    c, _, auth = env
    agent_id = (
        await c.post("/api/agents", headers=auth, json={"name": "xyflow-bot"})
    ).json()["agent_id"]
    flow_id = (
        await c.post("/api/flows", headers=auth, json={"name": "XYFlow shaped"})
    ).json()["flow_id"]

    xyflow_nodes = [
        {
            "id": "t1",
            "type": "trigger",
            "position": {"x": 0, "y": 0},
            "data": {"label": "Trigger", "config": {}},
            "measured": {"width": 180, "height": 60},
            "selected": False,
        },
        {
            "id": "c1",
            "type": "condition",
            "position": {"x": 0, "y": 100},
            "data": {"label": "Condition", "config": {"left": "1", "op": "eq", "right": "1"}},
        },
        {
            "id": "a1",
            "type": "agent",
            "position": {"x": -100, "y": 200},
            "data": {
                "label": "Agent",
                "config": {"agentId": agent_id, "prompt": "hi", "outputVar": "reply"},
            },
        },
        {
            "id": "e_true",
            "type": "end",
            "position": {"x": -100, "y": 300},
            "data": {"label": "End (true)", "config": {}},
        },
        {
            "id": "e_false",
            "type": "end",
            "position": {"x": 100, "y": 200},
            "data": {"label": "End (false)", "config": {}},
        },
    ]
    xyflow_edges = [
        {"id": "e1", "source": "t1", "target": "c1"},
        {"id": "e2", "source": "c1", "target": "a1", "sourceHandle": "true"},
        {"id": "e3", "source": "c1", "target": "e_false", "sourceHandle": "false"},
        {"id": "e4", "source": "a1", "target": "e_true"},
    ]
    r = await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": xyflow_nodes, "edges": xyflow_edges, "status": "active"},
    )
    assert r.status_code == 200, r.text

    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "succeeded", body
    # trigger -> condition (true) -> agent -> end: the "false" branch's
    # end node is never reached, so only 4 steps are recorded.
    assert [s["node_id"] for s in body["steps"]] == ["t1", "c1", "a1", "e_true"]
    condition_step = next(s for s in body["steps"] if s["node_id"] == "c1")
    assert condition_step["output"] == {"result": True}
    agent_step = next(s for s in body["steps"] if s["node_id"] == "a1")
    assert agent_step["status"] == "succeeded"
    assert agent_step["output"] == {"reply": "fake reply"}

    # Flip the condition to the false branch and confirm sourceHandle
    # normalization works for "false" too — the agent node is skipped
    # entirely this time, landing straight on e_false.
    xyflow_nodes[1]["data"]["config"] = {"left": "1", "op": "eq", "right": "2"}
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": xyflow_nodes, "edges": xyflow_edges},
    )
    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "succeeded", body
    assert [s["node_id"] for s in body["steps"]] == ["t1", "c1", "e_false"]


async def test_run_with_malformed_node_is_clean_422_not_500(env):
    """A node missing its ``id`` is structurally unusable (nothing to key
    a step by) — the normalizer must raise a clean 422, never let an
    unhandled exception 500 the request."""
    c, _, auth = env
    flow_id = (
        await c.post("/api/flows", headers=auth, json={"name": "Malformed"})
    ).json()["flow_id"]
    bad_nodes = [{"type": "trigger", "position": {"x": 0, "y": 0}, "data": {"config": {}}}]
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": bad_nodes, "edges": [], "status": "active"},
    )
    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 422, r.text


async def test_run_with_non_string_config_field_fails_step_not_500(
    env, _patch_fake_agent_call
):
    """A non-string ``prompt`` (e.g. stray number in saved JSON) must be
    coerced to a string by the normalizer, not reach ``engine.py``'s
    ``_render()`` and raise an unhandled ``TypeError``."""
    c, _, auth = env
    agent_id = (
        await c.post("/api/agents", headers=auth, json={"name": "bot2"})
    ).json()["agent_id"]
    flow_id = (
        await c.post("/api/flows", headers=auth, json={"name": "NonString"})
    ).json()["flow_id"]
    nodes = [
        {"id": "t", "type": "trigger", "position": {"x": 0, "y": 0}, "data": {"config": {}}},
        {
            "id": "a",
            "type": "agent",
            "position": {"x": 0, "y": 100},
            "data": {"config": {"agentId": agent_id, "prompt": 12345}},
        },
    ]
    edges = [{"id": "e1", "source": "t", "target": "a"}]
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": nodes, "edges": edges, "status": "active"},
    )
    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "succeeded", r.json()


async def test_run_rejects_draft_flow(env):
    c, _, auth = env
    flow_id = (await c.post("/api/flows", headers=auth, json={"name": "Still draft"})).json()["flow_id"]
    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "FLOW_NOT_ACTIVE"


async def test_cannot_access_another_users_flow(env):
    c, _, auth = env
    flow_id = (await c.post("/api/flows", headers=auth, json={"name": "Private"})).json()["flow_id"]
    other_auth = await create_user(c, auth, username="flowintruder")
    r = await c.get(f"/api/flows/{flow_id}", headers=other_auth)
    assert r.status_code in (403, 404)
