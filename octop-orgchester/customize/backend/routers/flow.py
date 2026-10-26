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
from pydantic import BaseModel, Field

from octop.api.common.agent import assert_agent_owner
from octop.api.deps import current_user, get_server
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.flows.engine import (
    FlowEdge,
    FlowNode,
    NonRetryableError,
    StepResult,
    run_flow,
)
from octop.infra.flows.validate import FlowIssue, has_errors, validate_graph
from octop.infra.utils.ulid import new_short_id

router = APIRouter()

DESCRIPTION_MAX_LENGTH = 20000
MAX_VERSIONS_PER_FLOW = 50
LABEL_MAX_LENGTH = 100


class FlowCreateBody(BaseModel):
    name: str
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX_LENGTH)


class FlowPatchBody(BaseModel):
    name: str | None = None
    description: str | None = Field(default=None, max_length=DESCRIPTION_MAX_LENGTH)
    nodes: list[dict[str, Any]] | None = None
    edges: list[dict[str, Any]] | None = None
    status: str | None = None


class FlowValidateBody(BaseModel):
    nodes: list[dict[str, Any]] | None = None
    edges: list[dict[str, Any]] | None = None


class FlowVersionCreateBody(BaseModel):
    label: str | None = Field(default=None, max_length=LABEL_MAX_LENGTH)


class FlowRunBody(BaseModel):
    input: dict[str, Any] = {}
    dry_run: bool = False


async def _dry_run_call_agent(agent_id: str, prompt: str) -> str:
    """Stand-in for the real agent call during a dry run: no registry lookup,
    no model call: just echoes what the agent would have received."""
    return f"[dry-run] agent {agent_id} would receive: {prompt}"


def _flow_payload(row: Any) -> dict[str, Any]:
    return {
        "flow_id": row["flow_id"],
        "name": row["name"],
        "description": row["description"],
        "nodes": json.loads(row["nodes_json"]),
        "edges": json.loads(row["edges_json"]),
        "status": row["status"],
    }


def _version_summary(row: Any) -> dict[str, Any]:
    return {
        "version_no": row["version_no"],
        "label": row["label"],
        "kind": row["kind"],
        "created_at": row["created_at"],
        "node_count": len(json.loads(row["nodes_json"])),
        "edge_count": len(json.loads(row["edges_json"])),
    }


def _insert_version(
    conn: Any,
    flow_id: str,
    user_id: int | None,
    label: str | None,
    kind: str,
    nodes_json: str,
    edges_json: str,
) -> int:
    """Insert one snapshot inside the caller's transaction and return its number.

    Numbers are MAX+1 per flow and never reused; afterwards only the newest
    ``MAX_VERSIONS_PER_FLOW`` rows of the flow are kept.
    """
    version_no = (
        conn.execute(
            "SELECT COALESCE(MAX(version_no), 0) AS m FROM flow_versions WHERE flow_id = ?",
            (flow_id,),
        ).fetchone()["m"]
        + 1
    )
    conn.execute(
        "INSERT INTO flow_versions(version_id, flow_id, version_no, label, kind, "
        "nodes_json, edges_json, created_by, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            f"fv_{new_short_id(6)}",
            flow_id,
            version_no,
            label,
            kind,
            nodes_json,
            edges_json,
            user_id,
            int(time.time()),
        ),
    )
    conn.execute(
        "DELETE FROM flow_versions WHERE flow_id = ? AND version_no <= ?",
        (flow_id, version_no - MAX_VERSIONS_PER_FLOW),
    )
    return version_no


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
       but not already a string (an explicit ``None`` becomes ``""``).
       ``engine.py`` calls ``template.render`` on these *outside* of any
       try/except for non-template errors, so a non-string value (e.g.
       saved JSON with a stray number or null) would raise
       an unhandled ``TypeError`` and 500 the request instead of failing
       just that node's step (the deferred Task-3 finding this closes).
    """
    config = dict(raw) if isinstance(raw, dict) else {}
    if "agentId" in config:
        config["agent_id"] = config.pop("agentId")
    if "outputVar" in config:
        config["output_var"] = config.pop("outputVar")
    # Retry knobs: renamed only; the engine validates/clamps the values.
    if "maxRetries" in config:
        config["max_retries"] = config.pop("maxRetries")
    if "retryDelay" in config:
        config["retry_delay"] = config.pop("retryDelay")
    for key in ("prompt", "left", "right", "op"):
        value = config.get(key)
        if key in config and not isinstance(value, str):
            config[key] = "" if value is None else str(value)
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


def _validation_error(issues: list[FlowIssue]) -> HTTPException:
    errors = [i for i in issues if i.level == "error"]
    return HTTPException(
        status_code=422,
        detail=f"flow has {len(errors)} validation error(s): {errors[0].message}",
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
    row = _require_owned_flow(server, user, flow_id)
    if body.status == "active":
        # Any PATCH carrying status "active" is gated; validate before writing
        # anything. Graph = nodes/edges sent in this request, else the stored one
        # (null counts as omitted, same as the /validate route).
        raw_nodes = body.nodes if body.nodes is not None else json.loads(row["nodes_json"])
        raw_edges = body.edges if body.edges is not None else json.loads(row["edges_json"])
        issues = validate_graph(*_to_engine_graph(raw_nodes, raw_edges))
        if has_errors(issues):
            raise _validation_error(issues)
    updates: dict[str, Any] = {}
    if body.name is not None:
        updates["name"] = body.name.strip()
    # description/status use model_fields_set, not "is not None": a client can
    # explicitly send ``null`` to CLEAR description. nodes/edges use
    # "is not None": null is treated as omitted (writing "null" would corrupt
    # the stored graph), while an empty list still writes.
    if "description" in body.model_fields_set:
        updates["description"] = body.description
    if body.nodes is not None:
        updates["nodes_json"] = json.dumps(body.nodes)
    if body.edges is not None:
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
        conn.execute("DELETE FROM flow_versions WHERE flow_id = ?", (flow_id,))
        conn.execute("DELETE FROM flows WHERE flow_id = ?", (flow_id,))


@router.post("/flows/{flow_id}/versions", status_code=201, summary="Save a flow version")
async def create_flow_version(
    flow_id: str,
    body: FlowVersionCreateBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    _require_owned_flow(server, user, flow_id)
    label = (body.label or "").strip() or None
    with server.services.db.transaction() as conn:
        # Snapshot the stored graph, read inside the same transaction.
        flow_row = conn.execute(
            "SELECT nodes_json, edges_json FROM flows WHERE flow_id = ?", (flow_id,)
        ).fetchone()
        if flow_row is None:
            raise OctopError(ErrorCode.NOT_FOUND, f"flow {flow_id!r} not found")
        version_no = _insert_version(
            conn,
            flow_id,
            user.id,
            label,
            "manual",
            flow_row["nodes_json"],
            flow_row["edges_json"],
        )
        row = conn.execute(
            "SELECT * FROM flow_versions WHERE flow_id = ? AND version_no = ?",
            (flow_id, version_no),
        ).fetchone()
    return _version_summary(row)


@router.get("/flows/{flow_id}/versions", summary="List a flow's versions")
async def list_flow_versions(
    flow_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> list[dict[str, Any]]:
    _require_owned_flow(server, user, flow_id)
    with server.services.db.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM flow_versions WHERE flow_id = ? ORDER BY version_no DESC",
            (flow_id,),
        ).fetchall()
        return [_version_summary(row) for row in rows]


@router.get("/flows/{flow_id}/versions/{version_no}", summary="Get one flow version")
async def get_flow_version(
    flow_id: str,
    version_no: int,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    _require_owned_flow(server, user, flow_id)
    with server.services.db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM flow_versions WHERE flow_id = ? AND version_no = ?",
            (flow_id, version_no),
        ).fetchone()
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, f"version {version_no} not found")
    payload = _version_summary(row)
    payload["nodes"] = json.loads(row["nodes_json"])
    payload["edges"] = json.loads(row["edges_json"])
    return payload


@router.post(
    "/flows/{flow_id}/versions/{version_no}/restore",
    summary="Restore a flow version (backs up the current graph first)",
)
async def restore_flow_version(
    flow_id: str,
    version_no: int,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    _require_owned_flow(server, user, flow_id)
    with server.services.db.transaction() as conn:
        flow_row = conn.execute("SELECT * FROM flows WHERE flow_id = ?", (flow_id,)).fetchone()
        if flow_row is None:
            raise OctopError(ErrorCode.NOT_FOUND, f"flow {flow_id!r} not found")
        version_row = conn.execute(
            "SELECT * FROM flow_versions WHERE flow_id = ? AND version_no = ?",
            (flow_id, version_no),
        ).fetchone()
        if version_row is None:
            raise OctopError(ErrorCode.NOT_FOUND, f"version {version_no} not found")
        if flow_row["status"] == "active":
            issues = validate_graph(
                *_to_engine_graph(
                    json.loads(version_row["nodes_json"]),
                    json.loads(version_row["edges_json"]),
                )
            )
            if has_errors(issues):
                errors = [i for i in issues if i.level == "error"]
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"restored version has {len(errors)} validation error(s): "
                        f"{errors[0].message}; deactivate the flow first or pick "
                        "another version"
                    ),
                )
        backup_no = _insert_version(
            conn,
            flow_id,
            user.id,
            f"Before restore to v{version_no}",
            "auto",
            flow_row["nodes_json"],
            flow_row["edges_json"],
        )
        conn.execute(
            "UPDATE flows SET nodes_json = ?, edges_json = ?, updated_at = ? WHERE flow_id = ?",
            (version_row["nodes_json"], version_row["edges_json"], int(time.time()), flow_id),
        )
        new_row = conn.execute("SELECT * FROM flows WHERE flow_id = ?", (flow_id,)).fetchone()
    return {
        "flow": _flow_payload(new_row),
        "restored_from": version_no,
        "backup_version_no": backup_no,
    }


@router.post("/flows/{flow_id}/validate", summary="Statically validate a flow graph")
async def validate_flow(
    flow_id: str,
    body: FlowValidateBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    row = _require_owned_flow(server, user, flow_id)
    raw_nodes = body.nodes if body.nodes is not None else json.loads(row["nodes_json"])
    raw_edges = body.edges if body.edges is not None else json.loads(row["edges_json"])
    issues = validate_graph(*_to_engine_graph(raw_nodes, raw_edges))
    return {"valid": not has_errors(issues), "issues": [i.to_dict() for i in issues]}


@router.post("/flows/{flow_id}/run", summary="Run a flow synchronously")
async def run_flow_endpoint(
    flow_id: str,
    body: FlowRunBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    row = _require_owned_flow(server, user, flow_id)
    if not body.dry_run and row["status"] != "active":
        raise OctopError(
            ErrorCode.FLOW_NOT_ACTIVE, "flow must be active to run — activate it first"
        )
    nodes, edges = _to_engine_graph(
        json.loads(row["nodes_json"]), json.loads(row["edges_json"])
    )
    issues = validate_graph(nodes, edges)
    if has_errors(issues):
        raise _validation_error(issues)

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
        # Missing / not-owned agent never heals on retry: fail the step at once.
        try:
            agent_row = server.app_runtime.agent_registry.get_row(agent_id)
            if agent_row is None:
                raise OctopError(ErrorCode.NOT_FOUND, f"agent {agent_id!r} not found")
            assert_agent_owner(agent_row, user)
        except OctopError as exc:
            raise NonRetryableError(str(exc)) from exc
        req = build_one_shot_request(
            user_id=user.id, agent_id=agent_id, text=prompt, source="flow"
        )
        result = await server.app_runtime.agent_registry.call(agent_id, asdict(req))
        return extract_call_response(result) if isinstance(result, dict) else ""

    if body.dry_run:
        result = await run_flow(
            nodes, edges, input=body.input, call_agent=_dry_run_call_agent
        )
        return {
            "run_id": None,
            "dry_run": True,
            "status": result.status,
            "output": result.output,
            "error": result.error,
            "steps": [_step_result_payload(step) for step in result.steps],
        }

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
        "dry_run": False,
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
