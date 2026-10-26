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


async def test_run_retries_flaky_agent_from_xyflow_config(env, monkeypatch):
    from tests.support.fakes import FakeHarnessAgent

    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "flaky"})).json()["agent_id"]
    flow_id = (await c.post("/api/flows", headers=auth, json={"name": "Retry"})).json()["flow_id"]
    calls = {"n": 0}

    async def _flaky_call(self: FakeHarnessAgent, request: dict) -> dict:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return {"messages": [{"role": "assistant", "content": "fake reply"}]}

    monkeypatch.setattr(FakeHarnessAgent, "call", _flaky_call, raising=False)
    nodes = [
        {"id": "t", "type": "trigger", "position": {"x": 0, "y": 0}, "data": {"config": {}}},
        {
            "id": "a",
            "type": "agent",
            "position": {"x": 0, "y": 100},
            "data": {
                "config": {"agentId": agent_id, "prompt": "hi", "maxRetries": 2, "retryDelay": 0}
            },
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
    assert calls["n"] == 2


async def test_run_unowned_agent_is_not_retried(env):
    import time

    c, _, auth = env
    my_agent_id = (await c.post("/api/agents", headers=auth, json={"name": "mine"})).json()["agent_id"]
    other_auth = await create_user(c, auth, username="flowowner3")
    flow_id = (await c.post("/api/flows", headers=other_auth, json={"name": "F3"})).json()["flow_id"]
    nodes = [
        {"id": "t", "type": "trigger", "config": {}},
        {
            "id": "a",
            "type": "agent",
            "config": {"agent_id": my_agent_id, "prompt": "hi", "max_retries": 3, "retry_delay": 30},
        },
    ]
    edges = [{"id": "e1", "source": "t", "target": "a"}]
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=other_auth,
        json={"nodes": nodes, "edges": edges, "status": "active"},
    )
    start = time.monotonic()
    r = await c.post(f"/api/flows/{flow_id}/run", headers=other_auth, json={"input": {}})
    # A retried run would sleep 3 x 30s; a non-retryable failure returns at once.
    assert time.monotonic() - start < 10
    body = r.json()
    assert body["status"] == "failed"
    step = next(s for s in body["steps"] if s["node_id"] == "a")
    assert step["error"].startswith("agent call failed: ")
    assert "attempts" not in step["error"]


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
    # Activation is now gated, so activate a valid graph first, then save the
    # malformed one (saving is never blocked) and run.
    good = [{"id": "t", "type": "trigger", "config": {}}]
    r = await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": good, "edges": [], "status": "active"},
    )
    assert r.status_code == 200, r.text
    await c.patch(
        f"/api/flows/{flow_id}", headers=auth, json={"nodes": bad_nodes, "edges": []}
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


# --- Static validation: endpoint + activate/run gates -----------------------

_VALID_EDGES = [
    {"id": "e1", "source": "t", "target": "a"},
    {"id": "e2", "source": "a", "target": "e"},
]


def _valid_nodes(agent_id: str) -> list[dict]:
    return [
        {"id": "t", "type": "trigger", "config": {}},
        {"id": "a", "type": "agent", "config": {"agent_id": agent_id, "prompt": "hi"}},
        {"id": "e", "type": "end", "config": {}},
    ]


_INVALID_NODES = [
    {"id": "t", "type": "trigger", "config": {}},
    {"id": "a", "type": "agent", "config": {}},
]
_INVALID_EDGES = [{"id": "e1", "source": "t", "target": "a"}]


async def _new_flow(c, auth, name="V"):
    return (await c.post("/api/flows", headers=auth, json={"name": name})).json()["flow_id"]


async def test_validate_endpoint_reports_issues_for_stored_graph(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _INVALID_NODES, "edges": _INVALID_EDGES},
    )
    r = await c.post(f"/api/flows/{flow_id}/validate", headers=auth, json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["valid"] is False
    assert "agent_missing_agent" in [i["code"] for i in body["issues"]]
    assert set(body["issues"][0]) == {"level", "code", "message", "node_id"}


async def test_validate_endpoint_uses_body_graph_when_given(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "vb"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _INVALID_NODES, "edges": _INVALID_EDGES},
    )
    r = await c.post(
        f"/api/flows/{flow_id}/validate",
        headers=auth,
        json={"nodes": _valid_nodes(agent_id), "edges": _VALID_EDGES},
    )
    assert r.status_code == 200, r.text
    assert r.json()["valid"] is True


async def test_validate_unowned_flow_is_forbidden(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    other_auth = await create_user(c, auth, username="validateintruder")
    r = await c.post(f"/api/flows/{flow_id}/validate", headers=other_auth, json={})
    assert r.status_code in (403, 404)


async def test_activate_empty_flow_is_rejected(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"status": "active"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"].startswith("flow has 1 validation error(s)")
    r = await c.get(f"/api/flows/{flow_id}", headers=auth)
    assert r.json()["status"] == "draft"


async def test_activate_valid_flow_succeeds(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "av"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _valid_nodes(agent_id), "edges": _VALID_EDGES},
    )
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"status": "active"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"


async def test_activate_uses_nodes_sent_in_same_patch(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "as"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    r = await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _valid_nodes(agent_id), "edges": _VALID_EDGES, "status": "active"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"


async def test_patch_nodes_and_name_not_blocked_when_invalid(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    r = await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _INVALID_NODES, "edges": _INVALID_EDGES},
    )
    assert r.status_code == 200, r.text
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"name": "Renamed"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Renamed"


async def test_deactivate_never_blocked(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "dv"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _valid_nodes(agent_id), "edges": _VALID_EDGES, "status": "active"},
    )
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _INVALID_NODES, "edges": _INVALID_EDGES},
    )
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"status": "draft"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "draft"


async def test_run_invalid_active_flow_is_rejected_before_any_agent_call(env, monkeypatch):
    from tests.support.fakes import FakeHarnessAgent

    c, srv, auth = env
    calls = {"n": 0}

    async def _counting_call(self: FakeHarnessAgent, request: dict) -> dict:
        calls["n"] += 1
        return {"messages": [{"role": "assistant", "content": "fake reply"}]}

    monkeypatch.setattr(FakeHarnessAgent, "call", _counting_call, raising=False)
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "rv"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    r = await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _valid_nodes(agent_id), "edges": _VALID_EDGES, "status": "active"},
    )
    assert r.status_code == 200, r.text
    # Saved after activation: now invalid but still active.
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _INVALID_NODES, "edges": _INVALID_EDGES},
    )
    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 422, r.text
    assert r.json()["detail"].startswith("flow has ")
    assert calls["n"] == 0
    with srv.services.db.connect() as conn:
        n = conn.execute(
            "SELECT COUNT(*) AS c FROM flow_runs WHERE flow_id = ?", (flow_id,)
        ).fetchone()["c"]
    assert n == 0


async def test_activate_with_null_nodes_does_not_bypass_gate(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    r = await c.patch(
        f"/api/flows/{flow_id}", headers=auth, json={"nodes": None, "status": "active"}
    )
    assert r.status_code == 422, r.text
    r = await c.get(f"/api/flows/{flow_id}", headers=auth)
    assert r.json()["nodes"] == []
    assert r.json()["status"] == "draft"


async def test_null_nodes_and_edges_leave_stored_graph_unchanged(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "nn"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    nodes = _valid_nodes(agent_id)
    await c.patch(
        f"/api/flows/{flow_id}", headers=auth, json={"nodes": nodes, "edges": _VALID_EDGES}
    )
    r = await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": None, "edges": None, "status": "active"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["nodes"] == nodes
    assert r.json()["edges"] == _VALID_EDGES


# --- Dry-run mode -----------------------------------------------------------


def _xy_node(node_id: str, node_type: str, config: dict) -> dict:
    return {
        "id": node_id,
        "type": node_type,
        "position": {"x": 0, "y": 0},
        "data": {"config": config},
    }


def _dry_run_nodes(agent_id: str, **agent_extra) -> list[dict]:
    return [
        _xy_node("t", "trigger", {}),
        _xy_node(
            "a",
            "agent",
            {"agentId": agent_id, "prompt": "hi {{name}}", "outputVar": "a", **agent_extra},
        ),
        _xy_node("e", "end", {}),
    ]


def _count_agent_calls(monkeypatch) -> dict:
    from tests.support.fakes import FakeHarnessAgent

    calls = {"n": 0}

    async def _counting_call(self: FakeHarnessAgent, request: dict) -> dict:
        calls["n"] += 1
        return {"messages": [{"role": "assistant", "content": "fake reply"}]}

    monkeypatch.setattr(FakeHarnessAgent, "call", _counting_call, raising=False)
    return calls


def _row_counts(srv) -> tuple[int, int]:
    with srv.services.db.connect() as conn:
        runs = conn.execute("SELECT COUNT(*) AS c FROM flow_runs").fetchone()["c"]
        steps = conn.execute("SELECT COUNT(*) AS c FROM flow_run_steps").fetchone()["c"]
    return runs, steps


async def test_dry_run_returns_stub_replies_without_calling_agent(env, monkeypatch):
    c, _, auth = env
    calls = _count_agent_calls(monkeypatch)
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "dr"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={
            "nodes": _dry_run_nodes(agent_id),
            "edges": _VALID_EDGES,
            "status": "active",
        },
    )
    r = await c.post(
        f"/api/flows/{flow_id}/run",
        headers=auth,
        json={"input": {"name": "x"}, "dry_run": True},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "succeeded", body
    assert body["dry_run"] is True
    assert body["run_id"] is None
    step = next(s for s in body["steps"] if s["node_id"] == "a")
    assert step["output"] == {"a": f"[dry-run] agent {agent_id} would receive: hi x"}
    assert calls["n"] == 0


async def test_dry_run_persists_nothing(env):
    c, srv, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "dp"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _dry_run_nodes(agent_id), "edges": _VALID_EDGES, "status": "active"},
    )
    before = _row_counts(srv)
    r = await c.post(
        f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}, "dry_run": True}
    )
    assert r.status_code == 200, r.text
    assert _row_counts(srv) == before
    r = await c.get(f"/api/flows/{flow_id}/runs", headers=auth)
    assert r.json() == []


async def test_dry_run_allowed_on_draft_but_normal_run_still_rejected(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "dd"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _dry_run_nodes(agent_id), "edges": _VALID_EDGES},
    )
    r = await c.post(
        f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}, "dry_run": True}
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "succeeded"
    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "FLOW_NOT_ACTIVE"


async def test_dry_run_never_calls_or_looks_up_agents(env, monkeypatch):
    from octop.api.routers import flow as flow_router

    c, srv, auth = env
    calls = _count_agent_calls(monkeypatch)
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={
            "nodes": _dry_run_nodes("does-not-exist", maxRetries=3, retryDelay=5),
            "edges": _VALID_EDGES,
        },
    )

    def _boom(*_a, **_k):
        raise AssertionError("agent_registry.get_row must not be called in a dry run")

    monkeypatch.setattr(srv.app_runtime.agent_registry, "get_row", _boom)

    sleeps = {"n": 0}
    real_run_flow = flow_router.run_flow

    async def _no_sleep(_delay):
        sleeps["n"] += 1

    async def _run_flow_spy(*args, **kwargs):
        kwargs["sleep"] = _no_sleep
        return await real_run_flow(*args, **kwargs)

    monkeypatch.setattr(flow_router, "run_flow", _run_flow_spy)

    r = await c.post(
        f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}, "dry_run": True}
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "succeeded", r.json()
    assert sleeps["n"] == 0
    assert calls["n"] == 0


async def test_dry_run_of_invalid_graph_is_rejected(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _INVALID_NODES, "edges": _INVALID_EDGES},
    )
    r = await c.post(
        f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}, "dry_run": True}
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"].startswith("flow has ")


async def test_dry_run_condition_branches_on_stub_reply(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "dc"})).json()["agent_id"]

    def _graph(op: str, right: str):
        nodes = [
            _xy_node("t", "trigger", {}),
            _xy_node("a", "agent", {"agentId": agent_id, "prompt": "hi", "outputVar": "a"}),
            _xy_node("c", "condition", {"left": "{{a}}", "op": op, "right": right}),
            _xy_node("yes", "end", {}),
            _xy_node("no", "end", {}),
        ]
        edges = [
            {"id": "e1", "source": "t", "target": "a"},
            {"id": "e2", "source": "a", "target": "c"},
            {"id": "e3", "source": "c", "target": "yes", "sourceHandle": "true"},
            {"id": "e4", "source": "c", "target": "no", "sourceHandle": "false"},
        ]
        return nodes, edges

    flow_id = await _new_flow(c, auth)
    nodes, edges = _graph("contains", "[dry-run]")
    await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"nodes": nodes, "edges": edges})
    r = await c.post(
        f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}, "dry_run": True}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "succeeded", body
    assert body["steps"][-1]["node_id"] == "yes"

    nodes, edges = _graph("gt", "1")
    await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"nodes": nodes, "edges": edges})
    r = await c.post(
        f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}, "dry_run": True}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "failed", body
    assert body["error"]
    assert body["steps"][-1]["node_id"] == "c"
    assert body["steps"][-1]["status"] == "failed"


async def test_normal_run_response_has_dry_run_false(env, _patch_fake_agent_call):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "nr"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": _valid_nodes(agent_id), "edges": _VALID_EDGES, "status": "active"},
    )
    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["dry_run"] is False
    assert isinstance(body["run_id"], str)


async def test_description_at_limit_is_saved(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    text = "a" * 20000
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"description": text})
    assert r.status_code == 200, r.text
    got = await c.get(f"/api/flows/{flow_id}", headers=auth)
    assert got.json()["description"] == text


async def test_description_over_limit_rejected_on_patch_and_create(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"description": "keep me"})
    too_long = "a" * 20001
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"description": too_long})
    assert r.status_code == 422, r.text
    got = await c.get(f"/api/flows/{flow_id}", headers=auth)
    assert got.json()["description"] == "keep me"
    r = await c.post("/api/flows", headers=auth, json={"name": "X", "description": too_long})
    assert r.status_code == 422, r.text


async def test_description_null_clears(env):
    c, _, auth = env
    flow_id = await _new_flow(c, auth)
    await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"description": "doc"})
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"description": None})
    assert r.status_code == 200, r.text
    got = await c.get(f"/api/flows/{flow_id}", headers=auth)
    assert got.json()["description"] is None


async def test_patch_description_only_leaves_graph_and_status(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "dd"})).json()["agent_id"]
    flow_id = await _new_flow(c, auth)
    nodes = _valid_nodes(agent_id)
    r = await c.patch(
        f"/api/flows/{flow_id}",
        headers=auth,
        json={"nodes": nodes, "edges": _VALID_EDGES, "status": "active"},
    )
    assert r.status_code == 200, r.text
    before = (await c.get(f"/api/flows/{flow_id}", headers=auth)).json()
    r = await c.patch(f"/api/flows/{flow_id}", headers=auth, json={"description": "# Docs"})
    assert r.status_code == 200, r.text
    after = (await c.get(f"/api/flows/{flow_id}", headers=auth)).json()
    assert after["description"] == "# Docs"
    assert after["status"] == "active"
    assert after["nodes"] == before["nodes"]
    assert after["edges"] == before["edges"]
