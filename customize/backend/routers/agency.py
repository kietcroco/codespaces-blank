"""Agencies (departments) — CRUD and expert membership.

Mirrors the shape of ``src/octop/api/routers/teams.py``: Pydantic request
bodies, a ``_require_owned_agency`` ownership guard, and route handlers using
``server.services.db.connect()`` / ``.transaction()`` with ``?``-placeholder
SQL for the two new tables (``agencies``, ``agency_members``). Expert
name/description/status for the detail and org-chart endpoints come from
``server.app_runtime.agent_registry.get_row(...)`` — never a raw join against
``agents`` — per Task 3's interface contract.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from octop.api.common.agent import assert_agent_owner
from octop.api.deps import current_user, get_server
from octop.infra.errors import ErrorCode, OctopError
from octop.infra.utils.ulid import new_short_id

router = APIRouter()


class AgencyCreateBody(BaseModel):
    name: str
    description: str | None = None
    color: str | None = None


class AgencyPatchBody(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None


class AgencyMemberBody(BaseModel):
    agency_id: str | None = None


def _count_members(conn: Any, agency_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM agency_members WHERE agency_id = ?",
        (agency_id,),
    ).fetchone()
    return int(row["c"]) if row is not None else 0


def _agency_payload(row: Any, member_count: int) -> dict[str, Any]:
    return {
        "agency_id": row["agency_id"],
        "name": row["name"],
        "description": row["description"],
        "color": row["color"],
        "member_count": member_count,
    }


def _require_owned_agency(server: Any, user: Any, agency_id: str) -> Any:
    """Load an agency row, raising NOT_FOUND / FORBIDDEN like teams.py's helper."""
    with server.services.db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM agencies WHERE agency_id = ?", (agency_id,)
        ).fetchone()
    if row is None:
        raise OctopError(ErrorCode.NOT_FOUND, f"agency {agency_id!r} not found")
    if row["user_id"] != user.id and not user.is_admin:
        raise OctopError(ErrorCode.FORBIDDEN, "agency not owned by user")
    return row


def _expert_payload(server: Any, expert_agent_id: str) -> dict[str, Any] | None:
    """Look up an expert's display fields via the agent registry (not raw SQL)."""
    assert server.app_runtime is not None
    row = server.app_runtime.agent_registry.get_row(expert_agent_id)
    if row is None:
        return None
    return {
        "agent_id": row.agent_id,
        "name": row.name,
        "description": row.description,
        "status": row.last_state or "unknown",
    }


def _experts_for_agency(server: Any, conn: Any, agency_id: str) -> list[dict[str, Any]]:
    member_rows = conn.execute(
        "SELECT expert_agent_id FROM agency_members WHERE agency_id = ?",
        (agency_id,),
    ).fetchall()
    experts: list[dict[str, Any]] = []
    for member_row in member_rows:
        payload = _expert_payload(server, member_row["expert_agent_id"])
        if payload is not None:
            experts.append(payload)
    return experts


@router.get("/agencies", summary="List my agencies")
async def list_agencies(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> list[dict[str, Any]]:
    with server.services.db.connect() as conn:
        rows = conn.execute(
            "SELECT * FROM agencies WHERE user_id = ? ORDER BY created_at ASC, id ASC",
            (user.id,),
        ).fetchall()
        return [_agency_payload(row, _count_members(conn, row["agency_id"])) for row in rows]


@router.post("/agencies", status_code=201, summary="Create an agency")
async def create_agency(
    body: AgencyCreateBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    agency_id = f"ag_{new_short_id(6)}"
    ts = int(time.time())
    name = body.name.strip()
    with server.services.db.transaction() as conn:
        conn.execute(
            "INSERT INTO agencies(agency_id, user_id, name, description, color, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (agency_id, user.id, name, body.description, body.color, ts, ts),
        )
    return _agency_payload(
        {
            "agency_id": agency_id,
            "name": name,
            "description": body.description,
            "color": body.color,
        },
        0,
    )


@router.get("/agencies/org-chart", summary="Org chart grouped by agency")
async def org_chart(
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    with server.services.db.connect() as conn:
        agency_rows = conn.execute(
            "SELECT * FROM agencies WHERE user_id = ? ORDER BY created_at ASC, id ASC",
            (user.id,),
        ).fetchall()
        agencies = [
            {
                "agency_id": row["agency_id"],
                "name": row["name"],
                "color": row["color"],
                "experts": _experts_for_agency(server, conn, row["agency_id"]),
            }
            for row in agency_rows
        ]
    return {"agencies": agencies}


@router.get("/agencies/{agency_id}", summary="Get an agency")
async def get_agency(
    agency_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    row = _require_owned_agency(server, user, agency_id)
    with server.services.db.connect() as conn:
        experts = _experts_for_agency(server, conn, agency_id)
    return {
        "agency_id": row["agency_id"],
        "name": row["name"],
        "description": row["description"],
        "color": row["color"],
        "experts": experts,
    }


@router.patch("/agencies/{agency_id}", summary="Update an agency")
async def patch_agency(
    agency_id: str,
    body: AgencyPatchBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    _require_owned_agency(server, user, agency_id)
    updates: dict[str, Any] = {}
    if body.name is not None:
        updates["name"] = body.name.strip()
    # description/color use model_fields_set, not "is not None": the body
    # explicitly sends ``null`` to CLEAR a field, which is indistinguishable
    # from "omitted" under an `is not None` check.
    if "description" in body.model_fields_set:
        updates["description"] = body.description
    if "color" in body.model_fields_set:
        updates["color"] = body.color
    if updates:
        set_clause = ", ".join(f"{col} = ?" for col in updates)
        params = [*updates.values(), int(time.time()), agency_id]
        with server.services.db.transaction() as conn:
            conn.execute(
                f"UPDATE agencies SET {set_clause}, updated_at = ? WHERE agency_id = ?",
                params,
            )
    with server.services.db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM agencies WHERE agency_id = ?", (agency_id,)
        ).fetchone()
        member_count = _count_members(conn, agency_id)
    assert row is not None
    return _agency_payload(row, member_count)


@router.delete("/agencies/{agency_id}", status_code=204, summary="Delete an agency")
async def delete_agency(
    agency_id: str,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> None:
    _require_owned_agency(server, user, agency_id)
    with server.services.db.transaction() as conn:
        # Explicit, not relied-upon-FK-cascade: never touches ``agents``.
        conn.execute("DELETE FROM agency_members WHERE agency_id = ?", (agency_id,))
        conn.execute("DELETE FROM agencies WHERE agency_id = ?", (agency_id,))


@router.put("/agencies/members/{expert_agent_id}", summary="Assign or clear an expert's agency")
async def set_member_agency(
    expert_agent_id: str,
    body: AgencyMemberBody,
    user: Any = Depends(current_user),
    server: Any = Depends(get_server),
) -> dict[str, Any]:
    assert server.app_runtime is not None
    agent_row = server.app_runtime.agent_registry.get_row(expert_agent_id)
    if agent_row is None:
        raise OctopError(ErrorCode.NOT_FOUND, f"agent {expert_agent_id!r} not found")
    assert_agent_owner(agent_row, user)
    if body.agency_id is not None:
        agency_row = _require_owned_agency(server, user, body.agency_id)
        # An Agency is scoped to one user's own org structure (spec §3) —
        # that invariant holds regardless of admin status, which both
        # checks above bypass. Without this, an admin could mix another
        # user's expert into an agency neither of them can jointly manage.
        if agency_row["user_id"] != agent_row.user_id:
            raise OctopError(
                ErrorCode.FORBIDDEN, "agency and expert belong to different users"
            )
    ts = int(time.time())
    with server.services.db.transaction() as conn:
        # expert_agent_id is UNIQUE on agency_members — drop any prior row first.
        conn.execute(
            "DELETE FROM agency_members WHERE expert_agent_id = ?",
            (expert_agent_id,),
        )
        if body.agency_id is not None:
            conn.execute(
                "INSERT INTO agency_members(agency_id, expert_agent_id, assigned_at) "
                "VALUES (?, ?, ?)",
                (body.agency_id, expert_agent_id, ts),
            )
    return {"expert_agent_id": expert_agent_id, "agency_id": body.agency_id}
