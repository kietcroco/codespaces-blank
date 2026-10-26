"""Flows — graph CRUD and synchronous run execution.

Mirrors the shape of ``src/octop/api/routers/agency.py``: Pydantic request
bodies, a ``_require_owned_flow`` ownership guard, and route handlers using
``server.services.db.connect()`` / ``.transaction()`` with ``?``-placeholder
SQL for the three Task 1 tables (``flows``, ``flow_runs``,
``flow_run_steps``). ``POST /flows/{flow_id}/run`` loads the flow's graph,
executes it with Task 3's pure ``run_flow`` engine (``octop.infra.flows.engine``),
and persists one ``flow_runs`` row plus one ``flow_run_steps`` row per step —
all inside a single transaction, same pattern as ``agency.py``'s
``create_agency``.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from octop.api.common.agent import assert_agent_owner
from octop.api.deps import current_user, get_server
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.flows.engine import FlowEdge, FlowNode, StepResult, run_flow
from octop.infra.utils.ulid import new_short_id

router = APIRouter()


class FlowCreateBody(BaseModel):
    name: str
    description: str | None = None


class FlowPatchBody(BaseModel):
    name: str | None = None
    description: str | None = None
    nodes: list[dict[str, Any]] | None = None
    edges: list[dict[str, Any]] | None = None
    status: str | None = None


class FlowRunBody(BaseModel):
    input: dict[str, Any] = {}


def _flow_payload(row: Any) -> dict[str, Any]:
    return {
        "flow_id": row["flow_id"],
        "name": row["name"],
        "description": row["description"],
        "nodes": json.loads(row["nodes_json"]),
        "edges": json.loads(row["edges_json"]),
        "status": row["status"],
    }


def _step_result_payload(step: StepResult) -> dict[str, Any]:
    return {
        "node_id": step.node_id,
        "node_type": step.node_type,
        "status": step.status,
        "input": step.input,
        "output": step.output,
        "error": step.error,
        "agent_id": step.agent_id,
    }


def _run_row_payload(row: Any) -> dict[str, Any]:
    return {
        "run_id": row["run_id"],
        "flow_id": row["flow_id"],
        "status": row["status"],
        "input": json.loads(row["input_json"]) if row["input_json"] else {},
        "output": json.loads(row["output_json"]) if row["output_json"] else {},
        "error": row["error"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


def _step_row_payload(row: Any) -> dict[str, Any]:
    return {
        "node_id": row["node_id"],
        "node_type": row["node_type"],
        "status": row["status"],
        "input": json.loads(row["input_json"]) if row["input_json"] else {},
        "output": json.loads(row["output_json"]) if row["output_json"] else None,
        "error": row["error"],
        "agent_id": row["agent_id"],
    }


def _coerce_node_config(raw: Any) -> dict[str, Any]:
    """Normalize one xyflow node's ``data.config`` (or a flat ``config``)
    into the engine's expected shape.

    Two jobs, both defensive (never raises):

    1. Rename the two camelCase keys the dashboard's ``NodeInspectorDrawer``
       writes (``agentId``, ``outputVar``) to the snake_case keys
       ``engine.py`` reads (``agent_id``, ``output_var``). ``prompt``,
       ``left``, ``op``, ``right`` are already lowercase on both sides, so
       they pass through unrenamed.
    2. Coerce ``prompt``/``left``/``right``/``op`` to ``str`` when present
       but not already a string. ``engine.py``'s ``_render()`` calls
       ``_TEMPLATE_RE.sub()`` on these *outside* of any try/except, so a
       non-string value (e.g. saved JSON with a stray number) would raise
       an unhandled ``TypeError`` and 500 the request instead of failing
       just that node's step (the deferred Task-3 finding this closes).
    """
    config = dict(raw) if isinstance(raw, dict) else {}
    if "agentId" in config:
        config["agent_id"] = config.pop("agentId")
    if "outputVar" in config:
        config["output_var"] = config.pop("outputVar")
    for key in ("prompt", "left", "right", "op"):
        value = config.get(key)
        if value is not None and not isinstance(value, str):
            config[key] = str(value)
    return config


def _to_engine_node(raw: Any) -> FlowNode:
    """Translate one stored node (xyflow shape: ``id``/``type``/``position``/
    ``data: {label, config}``/``measured``/``selected``/...) into the
    engine's flat ``FlowNode(id, type, config)``. A structurally missing
    ``id`` can't be turned into a step (there's nothing to key it by), so
    that raises a clean 422 rather than reaching ``run_flow`` at all.
    """
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="flow node must be an object")
    node_id = raw.get("id")
    if not isinstance(node_id, str) or not node_id:
        raise HTTPException(status_code=422, detail="flow node is missing a string 'id'")
    data = raw.get("data")
    config = data.get("config") if isinstance(data, dict) else None
    if config is None:
        config = raw.get("config")
    return FlowNode(id=node_id, type=raw.get("type"), config=_coerce_node_config(config))


def _to_engine_edge(raw: Any) -> FlowEdge:
    """Translate one stored edge (xyflow shape: ``id``/``source``/``target``/
    ``sourceHandle``/``targetHandle``/...) into the engine's flat
    ``FlowEdge(id, source, target, source_handle)``.
    """
    if not isinstance(raw, dict):
        raise HTTPException(status_code=422, detail="flow edge must be an object")
    edge_id, source, target = raw.get("id"), raw.get("source"), raw.get("target")
    if not all(isinstance(v, str) and v for v in (edge_id, source, target)):
        raise HTTPException(
            status_code=422,
            detail="flow edge is missing a string 'id'/'source'/'target'",
        )
    source_handle = raw.get("sourceHandle")
    if source_handle is None:
        source_handle = raw.get("source_handle")
    return FlowEdge(id=edge_id, source=source, target=target, source_handle=source_handle)


def _to_engine_graph(
    nodes: list[dict[str, Any]], edges: list[dict[str, Any]]
) -> tuple[list[FlowNode], list[FlowEdge]]:
    """The single place that bridges the two naming conventions (xyflow's
    camelCase UI shape vs. the engine's flat snake_case dataclasses) — per
    the plan's own stated design (plan line 745), this translation belongs
    in the router, not in ``engine.py`` and not in the frontend.

    ``nodes_json``/``edges_json`` is whatever ``FlowCanvas.tsx`` PATCHed —
    real ``@xyflow/react`` node/edge objects, not the engine's flat shape —
    so constructing ``FlowNode(**n)``/``FlowEdge(**e)`` directly from that
    JSON raises ``TypeError: unexpected keyword argument 'position'`` (the
    bug this function fixes). Structurally missing id/source/target raises
    a clean 422; everything else (bad config values, an unknown node type,
    a dangling edge) is left for ``run_flow`` to turn into a failed step.
    """
    return (
        [_to_engine_node(n) for n in nodes],
        [_to_engine_edge(e) for e in edges],
    )


def _require_owned_flow(server: Any, user: Any, flow_id: str) -> Any:
    """Load a flow row, raising NOT_FOUND / FORBIDDEN like ``_require_owned_agency``."""
    with server.services.db.connect() as conn:
        row = conn.execute("SELECT * FROM flows WHERE flow_id = ?", (flow_id,)).fetchone()
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, f"flow {flow_id!r} not found")
    if row["user_id"] != user.id and not user.is_admin:
        raise OctopError(ErrorCode.FORBIDDEN, "flow not owned by user")
    return row


@router.get("/flows", summary="List my flows")
async def list_flows(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> list[dict[str, Any]]:
    with server.services.db.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM flows WHERE user_id = ? ORDER BY created_at ASC, id ASC",
            (user.id,),
        ).fetchall()
        return [_flow_payload(row) for row in rows]


@router.post("/flows", status_code=201, summary="Create a flow")
async def create_flow(
    body: FlowCreateBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    flow_id = f"fl_{new_short_id(6)}"
    ts = int(time.time())
    name = body.name.strip()
    with server.services.db.transaction() as conn:
        conn.execute(
            "INSERT INTO flows(flow_id, user_id, name, description, nodes_json, "
            "edges_json, status, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (flow_id, user.id, name, body.description, "[]", "[]", "draft", ts, ts),
        )
    return _flow_payload(
        {
            "flow_id": flow_id,
            "name": name,
            "description": body.description,
            "nodes_json": "[]",
            "edges_json": "[]",
            "status": "draft",
        }
    )


@router.get("/flows/{flow_id}", summary="Get a flow")
async def get_flow(
    flow_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    row = _require_owned_flow(server, user, flow_id)
    return _flow_payload(row)


@router.patch("/flows/{flow_id}", summary="Update a flow")
async def patch_flow(
    flow_id: str,
    body: FlowPatchBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    _require_owned_flow(server, user, flow_id)
    updates: dict[str, Any] = {}
    if body.name is not None:
        updates["name"] = body.name.strip()
    # description/nodes/edges/status use model_fields_set, not "is not None":
    # a client can explicitly send ``null`` to CLEAR description, and an
    # empty ``nodes``/``edges`` list or falsy ``status`` must still write —
    # both are indistinguishable from "omitted" under an `is not None` check.
    if "description" in body.model_fields_set:
        updates["description"] = body.description
    if "nodes" in body.model_fields_set:
        updates["nodes_json"] = json.dumps(body.nodes)
    if "edges" in body.model_fields_set:
        updates["edges_json"] = json.dumps(body.edges)
    if "status" in body.model_fields_set:
        updates["status"] = body.status
    if updates:
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        params = [*updates.values(), int(time.time()), flow_id]
        with server.services.db.transaction() as conn:
            conn.execute(
                f"UPDATE flows SET {set_clause}, updated_at = ? WHERE flow_id = ?",
                params,
            )
    with server.services.db.connect() as conn:
        row = conn.execute("SELECT * FROM flows WHERE flow_id = ?", (flow_id,)).fetchone()
    assert row is not None
    return _flow_payload(row)


@router.delete("/flows/{flow_id}", status_code=204, summary="Delete a flow")
async def delete_flow(
    flow_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> None:
    _require_owned_flow(server, user, flow_id)
    with server.services.db.transaction() as conn:
        # Explicit, not relied-upon-FK-cascade (same discipline as agency.py's
        # delete_agency): walk flow_runs -> flow_run_steps -> flows so no
        # run-history row is ever orphaned regardless of PRAGMA foreign_keys.
        run_rows = conn.execute(
            "SELECT run_id FROM flow_runs WHERE flow_id = ?", (flow_id,)
        ).fetchall()
        for run_row in run_rows:
            conn.execute("DELETE FROM flow_run_steps WHERE run_id = ?", (run_row["run_id"],))
        conn.execute("DELETE FROM flow_runs WHERE flow_id = ?", (flow_id,))
        conn.execute("DELETE FROM flows WHERE flow_id = ?", (flow_id,))


@router.post("/flows/{flow_id}/run", summary="Run a flow synchronously")
async def run_flow_endpoint(
    flow_id: str,
    body: FlowRunBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    row = _require_owned_flow(server, user, flow_id)
    if row["status"] != "active":
        raise OctopError(
            ErrorCode.FLOW_NOT_ACTIVE, "flow must be active to run — activate it first"
        )
    nodes, edges = _to_engine_graph(
        json.loads(row["nodes_json"]), json.loads(row["edges_json"])
    )

    async def call_agent(agent_id: str, prompt: str) -> str:
        # Production-correct path: ``AgentManager.call`` (this module's
        # ``server.app_runtime.agent_registry``) bottoms out in exactly
        # ``entry.agent.call(prepared)`` — traced through
        # ``octop_harness/manager.py``'s ``HarnessAgentManager.call`` into
        # ``octop_harness/agent.py``'s ``HarnessAgent.call``, which returns a
        # real ``{"messages": [...]}``-shaped dict that ``extract_call_response``
        # is built to parse. (An earlier version of this closure used
        # ``agent_registry.stream()`` and looked for a ``"state_snapshot"``
        # chunk, reasoning that the test fake only implements ``.stream()`` —
        # but that chunk type is only guaranteed from LangGraph's "values"
        # stream mode, not from a normal token/tool-call stream, so that
        # path was not reliably correct for a real run. ``.call()`` is the
        # right primitive; the test fixes the fake instead — see
        # ``test_flow_api.py``'s ``_patch_fake_agent_call`` fixture.)
        #
        # ``AgentManager.call``'s own signature is ``request: dict[str, Any]``
        # and it does ``dict(request)`` internally, so the ``ChatRequest``
        # dataclass from ``build_one_shot_request`` must be converted to a
        # plain dict first (``octop_harness``'s own ``HarnessAgentManager.call``
        # then coerces that dict back into a ``ChatRequest`` via
        # ``ChatRequest.coerce``, so nothing is lost in the round trip).
        from octop_harness.messages import extract_call_response
        from octop_harness.teams.util import build_one_shot_request

        assert server.app_runtime is not None
        agent_row = server.app_runtime.agent_registry.get_row(agent_id)
        if agent_row is None:
            raise OctopError(ErrorCode.NOT_FOUND, f"agent {agent_id!r} not found")
        assert_agent_owner(agent_row, user)
        req = build_one_shot_request(
            user_id=user.id, agent_id=agent_id, text=prompt, source="flow"
        )
        result = await server.app_runtime.agent_registry.call(agent_id, asdict(req))
        return extract_call_response(result) if isinstance(result, dict) else ""

    result = await run_flow(nodes, edges, input=body.input, call_agent=call_agent)

    run_id = f"run_{new_short_id(6)}"
    ts = int(time.time())
    with server.services.db.transaction() as conn:
        conn.execute(
            "INSERT INTO flow_runs(run_id, flow_id, status, input_json, output_json, "
            "error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                flow_id,
                result.status,
                json.dumps(body.input),
                json.dumps(result.output),
                result.error,
                ts,
                ts,
            ),
        )
        for step in result.steps:
            conn.execute(
                "INSERT INTO flow_run_steps(run_id, node_id, node_type, status, "
                "input_json, output_json, error, agent_id, started_at, finished_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    step.node_id,
                    step.node_type,
                    step.status,
                    json.dumps(step.input),
                    json.dumps(step.output) if step.output is not None else None,
                    step.error,
                    step.agent_id,
                    ts,
                    ts,
                ),
            )

    return {
        "run_id": run_id,
        "status": result.status,
        "output": result.output,
        "error": result.error,
        "steps": [_step_result_payload(step) for step in result.steps],
    }


@router.get("/flows/{flow_id}/runs", summary="List a flow's run history")
async def list_flow_runs(
    flow_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> list[dict[str, Any]]:
    _require_owned_flow(server, user, flow_id)
    with server.services.db.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM flow_runs WHERE flow_id = ? ORDER BY started_at ASC, id ASC",
            (flow_id,),
        ).fetchall()
        return [_run_row_payload(row) for row in rows]


@router.get("/flows/{flow_id}/runs/{run_id}", summary="Get one flow run with its steps")
async def get_flow_run(
    flow_id: str,
    run_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    _require_owned_flow(server, user, flow_id)
    with server.services.db.connect() as conn:
        run_row = conn.execute(
            "SELECT * FROM flow_runs WHERE run_id = ? AND flow_id = ?",
            (run_id, flow_id),
        ).fetchone()
        if run_row is None:
            raise OctopError(ErrorCode.NOT_FOUND, f"run {run_id!r} not found")
        step_rows = conn.execute(
            "SELECT * FROM flow_run_steps WHERE run_id = ? ORDER BY id ASC",
            (run_id,),
        ).fetchall()
    payload = _run_row_payload(run_row)
    payload["steps"] = [_step_row_payload(step_row) for step_row in step_rows]
    return payload
