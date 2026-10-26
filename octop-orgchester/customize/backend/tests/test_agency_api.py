"""Agency (department) API — CRUD + expert membership.

NOTE on fixtures: the brief's skeleton referenced a hypothetical
``env_with_provider_second_user`` fixture for the cross-user test. That
fixture does not exist anywhere in this codebase (checked
tests/integration/conftest.py and tests/fixtures/). The project's real,
existing pattern for a second authenticated user is
``tests.support.auth.create_user(client, admin_auth, username=...)`` on the
*same* shared ``httpx.AsyncClient`` — see
tests/integration/test_agents_list_scope.py
(test_non_admin_cannot_get_other_users_agent and friends). That pattern is
used below instead of inventing a new fixture.
"""

from __future__ import annotations

import pytest

from tests.support.auth import create_user


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
    agency_id = (await c.post("/api/agencies", headers=auth, json={"name": "Ops"})).json()[
        "agency_id"
    ]
    r = await c.patch(f"/api/agencies/{agency_id}", headers=auth, json={"name": "Ops Renamed"})
    assert r.json()["name"] == "Ops Renamed"
    r = await c.delete(f"/api/agencies/{agency_id}", headers=auth)
    assert r.status_code == 204
    r = await c.get(f"/api/agencies/{agency_id}", headers=auth)
    assert r.status_code == 404


async def test_assign_member_and_delete_agency_keeps_expert(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "bot"})).json()[
        "agent_id"
    ]
    agency_id = (await c.post("/api/agencies", headers=auth, json={"name": "Ops"})).json()[
        "agency_id"
    ]
    r = await c.put(
        f"/api/agencies/members/{agent_id}", headers=auth, json={"agency_id": agency_id}
    )
    assert r.status_code == 200

    await c.delete(f"/api/agencies/{agency_id}", headers=auth)
    r = await c.get("/api/agents", headers=auth)
    assert any(a["agent_id"] == agent_id for a in r.json())  # expert survives agency deletion


async def test_reassigning_member_moves_not_duplicates(env):
    c, _, auth = env
    agent_id = (await c.post("/api/agents", headers=auth, json={"name": "bot"})).json()[
        "agent_id"
    ]
    a1 = (await c.post("/api/agencies", headers=auth, json={"name": "A"})).json()["agency_id"]
    a2 = (await c.post("/api/agencies", headers=auth, json={"name": "B"})).json()["agency_id"]

    await c.put(f"/api/agencies/members/{agent_id}", headers=auth, json={"agency_id": a1})
    r = await c.put(f"/api/agencies/members/{agent_id}", headers=auth, json={"agency_id": a2})
    assert r.status_code == 200

    detail_a1 = (await c.get(f"/api/agencies/{a1}", headers=auth)).json()
    detail_a2 = (await c.get(f"/api/agencies/{a2}", headers=auth)).json()
    assert detail_a1["experts"] == []
    assert len(detail_a2["experts"]) == 1


async def test_cannot_assign_other_users_expert(env):
    c, _srv, admin_auth = env
    owner_auth = await create_user(c, admin_auth, username="agency_owner")
    other_auth = await create_user(c, admin_auth, username="agency_other")

    other_agent_id = (
        await c.post("/api/agents", headers=other_auth, json={"name": "theirs"})
    ).json()["agent_id"]
    agency_id = (
        await c.post("/api/agencies", headers=owner_auth, json={"name": "Mine"})
    ).json()["agency_id"]

    r = await c.put(
        f"/api/agencies/members/{other_agent_id}",
        headers=owner_auth,
        json={"agency_id": agency_id},
    )
    assert r.status_code == 403


async def test_patch_can_clear_description_and_color(env):
    c, _, auth = env
    agency_id = (
        await c.post(
            "/api/agencies",
            headers=auth,
            json={"name": "Ops", "description": "Keeps the lights on", "color": "#3B3BFF"},
        )
    ).json()["agency_id"]

    r = await c.patch(
        f"/api/agencies/{agency_id}",
        headers=auth,
        json={"name": "Ops", "description": None, "color": None},
    )
    assert r.status_code == 200, r.text
    assert r.json()["description"] is None
    assert r.json()["color"] is None


async def test_cannot_assign_own_expert_into_other_users_agency(env):
    c, _srv, admin_auth = env
    owner_auth = await create_user(c, admin_auth, username="agency_owner2")
    other_auth = await create_user(c, admin_auth, username="agency_other2")

    own_agent_id = (
        await c.post("/api/agents", headers=other_auth, json={"name": "mine"})
    ).json()["agent_id"]
    other_agency_id = (
        await c.post("/api/agencies", headers=owner_auth, json={"name": "Theirs"})
    ).json()["agency_id"]

    r = await c.put(
        f"/api/agencies/members/{own_agent_id}",
        headers=other_auth,
        json={"agency_id": other_agency_id},
    )
    assert r.status_code == 403


async def test_admin_cannot_mix_other_users_expert_into_an_agency(env):
    c, _srv, admin_auth = env
    owner_auth = await create_user(c, admin_auth, username="agency_owner3")
    other_auth = await create_user(c, admin_auth, username="agency_other3")

    other_agent_id = (
        await c.post("/api/agents", headers=other_auth, json={"name": "theirs"})
    ).json()["agent_id"]
    agency_id = (
        await c.post("/api/agencies", headers=owner_auth, json={"name": "Mine"})
    ).json()["agency_id"]

    r = await c.put(
        f"/api/agencies/members/{other_agent_id}",
        headers=admin_auth,
        json={"agency_id": agency_id},
    )
    assert r.status_code == 403


async def test_org_chart_empty_agency_has_no_experts_key_error(env):
    c, _, auth = env
    await c.post("/api/agencies", headers=auth, json={"name": "Empty"})
    r = await c.get("/api/agencies/org-chart", headers=auth)
    assert r.status_code == 200
    assert all("experts" in a for a in r.json()["agencies"])
