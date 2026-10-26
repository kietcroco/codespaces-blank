# Flow Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user simulate a flow end to end without calling any real agent and without writing run history — roadmap item #4 of the Flow gap analysis (`ARCHITECTURE.md` §9.2).

**Architecture:** `POST /flows/{id}/run` accepts `dry_run: bool` (default `false`). When true the router swaps the injected `call_agent` for a stub that returns a deterministic placeholder reply, skips the `status == "active"` gate (so drafts can be tried), still enforces ownership and the static-validation gate (Phase #3), and returns the result without inserting `flow_runs`/`flow_run_steps` rows. The dashboard adds a "Dry run" toolbar button that reuses `RunResultDrawer`. No DB change, no new patch, no new dependency, no new `ErrorCode`.

**Tech Stack:** Python 3.12 / FastAPI / pytest (backend); React + antd + vitest (dashboard).

**Spec:** `customize/docs/design-flow.md` (§7 API, §8 engine) and `ARCHITECTURE.md` §9.2 item 4. Task 1 adds a "Dry-run" paragraph to design-flow §8 and an updated §7 row.

## Global Constraints

- **Never edit or test in the real `Octop/` checkout.** Tests run through the Docker sandbox wrapper in the main checkout, `D:/Sources/RandD/codespaces-blank/octop-orgchester/scripts/sandbox/sb.sh` (it already copies `validate.py`; do not edit it). Author files only under `customize/` of the worktree `D:\Sources\RandD\flow-dry-run-wt`; set `CUSTOMIZE=/d/Sources/RandD/flow-dry-run-wt/octop-orgchester/customize`:
  - `... sb.sh sync` before every `py`/`ui`; `... sb.sh py <pytest args>`; `... sb.sh ui <vitest args>`.
- Baseline: backend `tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py` = 57 passed; dashboard `ui src/pages/Flows` = 23 passed.
- Request/response contract (exact):
  - Body: `FlowRunBody` gains `dry_run: bool = False`.
  - Stub reply text (exact): `"[dry-run] agent <agent_id> would receive: <prompt>"` where `<prompt>` is the rendered prompt as passed to `call_agent`.
  - Dry-run response: `{"run_id": null, "dry_run": true, "status", "output", "error", "steps"}`; a normal run response gains `"dry_run": false` and keeps its string `run_id`.
  - Dry-run never calls `server.app_runtime.agent_registry` (not even `get_row`), never calls `asyncio.sleep`, never inserts into `flow_runs` / `flow_run_steps`.
  - Gates for dry-run: ownership guard and the static-validation gate (422 with the existing "flow has N validation error(s): …" format) still apply; the `FLOW_NOT_ACTIVE` gate does not. Normal runs are unchanged.
- Git: work in worktree branch `flow-dry-run`; commit per task with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; keep LF line endings in every file (check committed blobs with `git show HEAD:<path> | grep -c "$(printf '\r')"` = 0); do not merge, do not touch `Octop/`, `ARCHITECTURE.md`, or `scripts/sandbox/`.

## Review Focus

- A dry run of a **draft** flow succeeds (no 409) while a normal run of the same draft still returns 409 `FLOW_NOT_ACTIVE`. Task 1 `test_dry_run_allowed_on_draft_but_normal_run_still_rejected`.
- A dry run leaves `flow_runs` and `flow_run_steps` row counts unchanged and the run-history endpoint empty. Task 1 `test_dry_run_persists_nothing`.
- The real agent path is never touched: with an agent id that does not exist / belongs to someone else, a dry run still succeeds (no ownership lookup) and the fake `call` counter stays 0. Task 1 `test_dry_run_never_calls_or_looks_up_agents`.
- An invalid graph (e.g. agent node with no agent) is rejected with the validation 422 even for dry-run — never a 500. Task 1 `test_dry_run_of_invalid_graph_is_rejected`.
- A condition node downstream of an agent evaluates against the stub text and branching works (e.g. `contains` on the placeholder); a condition on a numeric op gets a clean failed step, not a crash. Task 1 `test_dry_run_condition_branches_on_stub_reply`.
- Dashboard: "Dry run" never POSTs `dry_run: false`, never adds a history entry, and a normal Run still POSTs without `dry_run: true`. Task 2 tests.

## File Structure

| File | Responsibility |
|---|---|
| `customize/backend/routers/flow.py` | `dry_run` body field, stub `call_agent`, skip active gate and persistence |
| `customize/backend/tests/test_flow_api.py` | dry-run API tests |
| `customize/docs/design-flow.md` | §7 row update, §8 "Dry-run" paragraph |
| `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx` | `dryRun` prop, title/tag, POST body |
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` | "Dry run" button + handler |
| `customize/dashboard/pages/Flows/components/RunResultDrawer.test.tsx`, `FlowCanvas.test.tsx` | dashboard tests |

---

### Task 1: Backend — `dry_run` on `/run`, docs

**Files:**
- Modify: `customize/backend/routers/flow.py` (`FlowRunBody`, `run_flow_endpoint` ~L318-420), `customize/backend/tests/test_flow_api.py`, `customize/docs/design-flow.md`

**Interfaces:**
- Produces (Task 2 relies on): `POST /flows/{id}/run` body `{input?: dict, dry_run?: bool}`; response fields as in Global Constraints (`run_id: string | null`, `dry_run: boolean`).

- [ ] **Step 1: Write failing tests** in `test_flow_api.py` (reuse `env`, `_new_flow`, `_valid_nodes`, `_patch_fake_agent_call` helpers and xyflow-shaped graphs as the neighbouring tests do). Tests:
  - `test_dry_run_returns_stub_replies_without_calling_agent`: active flow trigger→agent(prompt `"hi {{name}}"`, `outputVar` `"a"`)→end, input `{"name":"x"}`, `dry_run: true` ⇒ 200, `status=="succeeded"`, `dry_run is True`, `run_id is None`, agent step output `{"a": "[dry-run] agent <id> would receive: hi x"}`, fake agent `call` counter == 0.
  - `test_dry_run_persists_nothing`: row counts of `flow_runs` / `flow_run_steps` unchanged and `GET /flows/{id}/runs` == `[]`.
  - `test_dry_run_allowed_on_draft_but_normal_run_still_rejected`: draft flow, valid graph ⇒ dry-run 200; same flow normal run ⇒ 409 (existing `FLOW_NOT_ACTIVE` behaviour).
  - `test_dry_run_never_calls_or_looks_up_agents`: agent node with `agentId` `"does-not-exist"` ⇒ dry-run 200 succeeded; `agent_registry.get_row` not called (monkeypatch to raise) and `asyncio.sleep` in the engine module not called even with `maxRetries: 3`.
  - `test_dry_run_of_invalid_graph_is_rejected`: agent node without agent ⇒ 422, detail starts `"flow has "`.
  - `test_dry_run_condition_branches_on_stub_reply`: agent → condition(`left="{{a}}"`, `op="contains"`, `right="[dry-run]"`) with true/false edges to two end nodes ⇒ the true branch's end node is the last step; second case `op="gt"` on the stub text ⇒ `status=="failed"` with the existing numeric-compare error, still 200.
  - `test_normal_run_response_has_dry_run_false`: normal run ⇒ `dry_run is False` and a string `run_id`.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh py tests/integration/test_flow_api.py -q -k dry_run`. Expected: FAIL.
- [ ] **Step 3: Implement** in `flow.py`: `FlowRunBody.dry_run: bool = False`; in `run_flow_endpoint` apply the `FLOW_NOT_ACTIVE` check only when not `body.dry_run`; keep `_to_engine_graph` + validation gate for both; when `body.dry_run` define a module-level `async def _dry_run_call_agent(agent_id: str, prompt: str) -> str` returning the exact stub text and pass it instead of the real closure; after `run_flow`, if dry-run return the payload (`run_id: None`, `dry_run: True`, same steps shape) before any DB write; add `"dry_run": False` to the normal response.
- [ ] **Step 4: Docs** — `design-flow.md`: §7 `/run` row mentions `dry_run`; add a "Dry-run" paragraph at the end of §8 (stub text, no persistence, draft allowed, validation still applies, the stub reply is what conditions see).
- [ ] **Step 5: Run full backend** — `sb.sh sync`; `sb.sh py tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py -q`. Expected: all pass, baseline 57 not regressed.
- [ ] **Step 6: Commit** — `git add octop-orgchester/customize`; `git commit -m "feat(flow): dry-run mode for /run"`.

---

### Task 2: Dashboard — "Dry run" button

**Files:**
- Modify: `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx`, `FlowCanvas.tsx`, `RunResultDrawer.test.tsx`, `FlowCanvas.test.tsx`

**Interfaces:**
- Consumes: `/run` body/response from Task 1.
- Produces: `RunResultDrawerProps.dryRun?: boolean` (default `false`); `FlowRunResult.run_id: string | null`, `FlowRunResult.dry_run?: boolean`.

- [ ] **Step 1: Write failing tests.**
  - `RunResultDrawer.test.tsx`: with `dryRun` the drawer POSTs `/flows/f1/run` with body `{ input: {}, dry_run: true }`, shows the title `Dry run` and a "dry run" tag; without `dryRun` the POST body has no `dry_run: true` (`{ input: {} }` exactly as today).
  - `FlowCanvas.test.tsx`: clicking "Dry run" saves the canvas first (PATCH nodes/edges), runs validation, and with no errors opens the drawer in dry-run mode (a `/run` request with `dry_run: true`); with validation errors it does not POST `/run`; clicking normal "Run" still POSTs `/run` without `dry_run: true`; "Dry run" works on a draft flow (status not required).
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `RunResultDrawer`: `dryRun` prop sent as `dry_run: true` in the POST body only when set; title `"Dry run"` vs `"Run flow"`; result tag shows `dry run` for `result.dry_run`; update the `FlowRunResult` type. `FlowCanvas`: `drawerMode` gains `"dry-run"`; `handleDryRun` mirrors `handleRun` (save → validate → bail on errors → open); a "Dry run" toolbar button (icon `FlaskConical` from lucide-react if available in the installed version, else `Play`) with `aria-pressed`; pass `dryRun={drawerMode === "dry-run"}` and `initialTab="run"` to the drawer.
- [ ] **Step 4: Run to verify pass, whole Flows UI suite** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: all pass (baseline 23 not regressed).
- [ ] **Step 5: Commit** — `git add octop-orgchester/customize/dashboard`; `git commit -m "feat(flow): add Dry run button to the canvas"`.
