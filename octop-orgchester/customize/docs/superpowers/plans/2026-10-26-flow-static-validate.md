# Flow Static Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect broken flow graphs (no trigger, unselected agent, empty prompt, bad condition, dangling edge, cycle…) before they run, show the problems on the canvas, and refuse to activate or run a flow that has errors — roadmap item #3 of the Flow gap analysis (`ARCHITECTURE.md` §9.2).

**Architecture:** A new pure module `flows/validate.py` turns the engine's `FlowNode`/`FlowEdge` lists into a list of `FlowIssue` (level `error` | `warning`). The router exposes it as `POST /flows/{id}/validate` and uses it as a gate on `PATCH status → "active"` and on `POST /run`. Saving a draft is never blocked (users build graphs incrementally). The dashboard calls the endpoint on Save / Run / Activate and via a "Validate" button, lists issues in a panel and outlines offending nodes. No DB change, no new patch, no new dependency, no new `ErrorCode`.

**Tech Stack:** Python 3.12 / FastAPI / pytest (backend); React + antd + vitest (dashboard).

**Spec:** `customize/docs/design-flow.md` (§7 API, §8 engine) and `ARCHITECTURE.md` §9.2 item 3. Task 2 adds a "Validate" paragraph to design-flow §7/§8.

## Global Constraints

- **Never edit or test in the real `Octop/` checkout.** Tests run through the Docker sandbox wrapper `octop-orgchester/scripts/sandbox/sb.sh` (bash). Author files only under `customize/`. When working in the worktree, set `CUSTOMIZE=<abs path to the worktree's octop-orgchester/customize>`:
  - `CUSTOMIZE=... bash <repo>/octop-orgchester/scripts/sandbox/sb.sh sync` — copy authored files into the sandbox (always run before `py`/`ui`).
  - `... sb.sh py <pytest args>` e.g. `sb.sh py tests/unit/test_flow_validate.py -q`.
  - `... sb.sh ui <vitest args>` e.g. `sb.sh ui src/pages/Flows`.
  - `scripts/sandbox/` is untracked in the main checkout and absent from the worktree: call the main checkout's copy, edit it in place there (Task 1 adds one `cp` line), and do not commit it.
- Baseline before this plan: backend 33 tests (engine + flow API + agency API), dashboard Flows 16 tests.
- Issue shape (exact): `FlowIssue(level: Literal["error","warning"], code: str, message: str, node_id: str | None)`; JSON `{"level","code","message","node_id"}`.
- Rules (exact codes). **Errors:** `no_trigger`, `multiple_triggers` (node_id = each extra trigger), `duplicate_node_id`, `unknown_node_type`, `agent_missing_agent` (blank/whitespace/absent `agent_id`), `agent_missing_prompt` (blank/whitespace `prompt`), `agent_bad_retry` (message = the `ValueError` text from `engine._retry_policy`), `condition_bad_op` (`op` not in `CONDITION_OPS`), `condition_missing_left` (blank `left`; `right` may be blank), `edge_dangling` (source or target not a node id; node_id = the missing id's edge `source`), `condition_bad_handle` (edge leaving a condition node whose `source_handle` is not `"true"`/`"false"`), `cycle` (any directed cycle among nodes; design §4/§8.5: V1 has no loop node, so every cycle is a misconfiguration; node_id = one node on the cycle). **Warnings:** `unreachable_node` (not reachable from the first trigger; not reported when `no_trigger`), `condition_branch_missing` (condition has no edge for `"true"` or for `"false"`; one issue per missing branch), `multiple_outgoing` (non-condition node with >1 outgoing edge — engine follows only the first).
- Messages are English, one sentence, name the node by id.
- Gate failures return HTTP 422 with `detail` a plain string: `"flow has N validation error(s): <first error message>"` (no new `ErrorCode`, so no Octop patch).
- Git: work in worktree branch `flow-static-validate` (already created at `D:\Sources\RandD\flow-static-validate-wt`); commit per task with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not merge, do not touch `Octop/`, do not touch `ARCHITECTURE.md` (it has uncommitted edits in the main checkout).

## Review Focus

- Empty graph (`nodes=[]`) and a freshly created flow: validate returns `no_trigger` (no crash); activating it is refused with a readable message. Task 1 `test_empty_graph_reports_no_trigger`, Task 2 `test_activate_empty_flow_is_rejected`.
- Malformed shapes (node `type` None, `config` missing, duplicate ids, edge to a self node, 1000-node chain) yield issues or pass — never raise, never recurse deeply. Task 1 `test_duplicate_ids_and_unknown_type`, `test_self_loop_and_long_chain_do_not_crash`.
- Whitespace-only `agent_id` / `prompt` / `left` count as empty. Task 1 `test_whitespace_only_fields_are_blank`.
- Editing an existing flow's name/description/nodes must never be blocked by validation (only the `status → "active"` transition and `/run` are gated); deactivating is never blocked. Task 2 `test_patch_nodes_and_name_not_blocked_when_invalid`, `test_deactivate_never_blocked`.
- A flow that is already `active` but now invalid (saved after activation) cannot run, with the first error in the message. Task 2 `test_run_invalid_active_flow_is_rejected_before_any_agent_call`.
- If the validate request fails on the dashboard (network/500) Save/Run/Activate must still behave as before the feature (fail open on the client; the server gates remain). Task 3 `fails open when validate request errors`.

## File Structure

| File | Responsibility |
|---|---|
| `customize/backend/flows/engine.py` | export `CONDITION_OPS` tuple (single source of truth, used by `_evaluate_condition` messages and validate) |
| `customize/backend/flows/validate.py` | New: `FlowIssue`, `validate_graph`, `has_errors` |
| `customize/backend/tests/test_flow_validate.py` | New: unit tests for the module |
| `customize/install.sh`, `scripts/sandbox/sb.sh` | copy `validate.py` and `test_flow_validate.py` |
| `customize/backend/routers/flow.py` | `POST /flows/{id}/validate`, gate on activate and run |
| `customize/backend/tests/test_flow_api.py` | endpoint + gate tests; fix fixtures made invalid by the gate |
| `customize/docs/design-flow.md`, `customize/README.md` | §7 row + §8 paragraph, §11 file table; upgrade note (copy new files, no patch) |
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` | validate calls, issues panel, node outline, "Validate" button |
| `customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx` | canvas validation tests |

---

### Task 1: Pure validation module

**Files:**
- Create: `customize/backend/flows/validate.py`, `customize/backend/tests/test_flow_validate.py`
- Modify: `customize/backend/flows/engine.py` (add `CONDITION_OPS`), `customize/install.sh` (after the engine `cp`, L51-53: copy `validate.py` to `src/octop/infra/flows/` and `test_flow_validate.py` to `tests/unit/`), `scripts/sandbox/sb.sh` (same two lines next to L13/L15)

**Interfaces:**
- Produces (Task 2 relies on these exact names):
  - `engine.CONDITION_OPS: tuple[str, ...] = ("eq","neq","gt","lt","gte","lte","contains")`
  - `validate.FlowIssue` (frozen dataclass: `level`, `code`, `message`, `node_id`) with `.to_dict() -> dict[str, Any]`
  - `validate.validate_graph(nodes: list[FlowNode], edges: list[FlowEdge]) -> list[FlowIssue]` — errors first, then warnings; stable order within a level (node order, then edge order)
  - `validate.has_errors(issues: list[FlowIssue]) -> bool`
- Imports: `FlowNode`, `FlowEdge`, `CONDITION_OPS`, `_retry_policy` from `.engine` (installed as `octop.infra.flows.engine`; use the same relative-import style the sandbox accepts — `from octop.infra.flows.engine import ...` like `flow.py` does).

- [ ] **Step 1: Write failing tests** in `test_flow_validate.py` with helper builders `n(id, type, **config)` / `e(src, dst, handle=None)`; a `valid_graph()` fixture = trigger → agent(`agent_id="a1"`, `prompt="hi"`) → end. Tests (codes asserted via `{i.code for i in issues}` and `node_id`):
  - `test_valid_graph_has_no_issues`: `validate_graph(*valid_graph()) == []`.
  - `test_empty_graph_reports_no_trigger`: `[]`,`[]` ⇒ exactly `no_trigger`, `node_id is None`, `has_errors` true.
  - `test_multiple_triggers`: two triggers ⇒ one `multiple_triggers` for the second one only.
  - `test_duplicate_ids_and_unknown_type`: two nodes id `x`; a node with `type=None` and one with `"http"` ⇒ `duplicate_node_id`, two `unknown_node_type`.
  - `test_agent_rules`: agent with no config ⇒ `agent_missing_agent` + `agent_missing_prompt`; `max_retries="abc"` ⇒ `agent_bad_retry` whose message contains `"max_retries must be a number"`.
  - `test_whitespace_only_fields_are_blank`: `agent_id="  "`, `prompt="\n"`, condition `left=" "` ⇒ the three blank codes.
  - `test_condition_rules`: `op="regex"` ⇒ `condition_bad_op`; blank `left` ⇒ `condition_missing_left`; `right=""` with valid `op="eq"` and `left="{{x}}"` ⇒ no issue; edge from the condition with handle `None` and with `"maybe"` ⇒ `condition_bad_handle` each; only a `"true"` edge ⇒ warning `condition_branch_missing` once (for `false`).
  - `test_edge_dangling`: edge to a missing target and from a missing source ⇒ two `edge_dangling` errors.
  - `test_cycle_detected`: trigger → a → b → a ⇒ one `cycle` error; `test_self_loop_and_long_chain_do_not_crash`: self-edge ⇒ `cycle`; a 1000-node linear chain ⇒ no issues and no `RecursionError`.
  - `test_unreachable_and_multiple_outgoing_warnings`: orphan agent ⇒ `unreachable_node` warning for it; agent with two outgoing edges ⇒ `multiple_outgoing` warning; both `has_errors == False`; no `unreachable_node` when there is no trigger.
  - `test_errors_sorted_before_warnings`.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync` then `sb.sh py tests/unit/test_flow_validate.py -q`. Expected: collection error (module missing).
- [ ] **Step 3: Implement** `CONDITION_OPS` in `engine.py` (no behavior change) and `validate.py` per the Global Constraints rules. Cycle detection must be iterative (explicit stack / Kahn's algorithm), ignoring edges with a dangling endpoint; reachability is a BFS from the first trigger over all edges (both condition branches).
- [ ] **Step 4: Run to verify pass** — `sb.sh sync`; `sb.sh py tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py -q`. Expected: all pass.
- [ ] **Step 5: Commit** — `git add customize/backend customize/install.sh` ; `git commit -m "feat(flow): add static graph validation module"`.

---

### Task 2: Router — validate endpoint and gates, docs

**Files:**
- Modify: `customize/backend/routers/flow.py`, `customize/backend/tests/test_flow_api.py`, `customize/docs/design-flow.md`, `customize/README.md`

**Interfaces:**
- Consumes: `validate_graph`, `has_errors`, `FlowIssue.to_dict` from Task 1.
- Produces (Task 3 relies on): `POST /flows/{flow_id}/validate` body `{nodes?: list, edges?: list}` (omitted ⇒ stored graph; same ownership guard as other routes) ⇒ `200 {"valid": bool, "issues": [{level, code, message, node_id}, ...]}` where `valid` = no error-level issue. Structurally broken nodes/edges (no `id`/`source`/`target`) ⇒ the existing 422 from `_to_engine_graph`.

- [ ] **Step 1: Write failing tests** in `test_flow_api.py` (reuse the `env` fixture and helpers; build xyflow-shaped graphs as the existing tests do):
  - `test_validate_endpoint_reports_issues_for_stored_graph`: agent with empty config ⇒ `valid false`, codes include `agent_missing_agent`.
  - `test_validate_endpoint_uses_body_graph_when_given`: stored graph invalid, body graph valid ⇒ `valid true`.
  - `test_validate_unowned_flow_is_forbidden` (mirror an existing ownership test).
  - `test_activate_empty_flow_is_rejected`: fresh flow, `PATCH {"status":"active"}` ⇒ 422, detail starts `"flow has 1 validation error(s)"`, flow still `draft`.
  - `test_activate_valid_flow_succeeds`; `test_activate_uses_nodes_sent_in_same_patch` (stored empty, body nodes valid + status active ⇒ 200).
  - `test_patch_nodes_and_name_not_blocked_when_invalid`: saving an invalid graph / renaming ⇒ 200; `test_deactivate_never_blocked`.
  - `test_run_invalid_active_flow_is_rejected_before_any_agent_call`: force-activate via a valid graph, then PATCH nodes to invalid, `/run` ⇒ 422 and the fake agent call count is 0 and no `flow_runs` row is added.
  - Run the existing API tests; any that activate or run a graph the new rules call invalid (e.g. missing prompt, cycle, no trigger) must be fixed by making the fixture graph valid, **unless** the test exists precisely to check engine tolerance of a bad graph — then keep the engine-level assertion in `test_flow_engine.py` and change the API test to assert the new 422. List each changed test in the commit body.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh py tests/integration/test_flow_api.py -q`. Expected: new tests FAIL (404/200 instead of 422).
- [ ] **Step 3: Implement** in `flow.py`: pydantic `FlowValidateBody(nodes: list[dict]|None=None, edges: list[dict]|None=None)`; helper `_validation_error(issues) -> HTTPException(422, ...)` using the detail format in Global Constraints; the validate route; in `patch_flow` when `body.status == "active"` validate (graph = `body.nodes`/`body.edges` if in `model_fields_set`, else stored) **before** writing anything; in `run_flow_endpoint` after the status check and `_to_engine_graph`, validate and raise on errors before `run_flow`.
- [ ] **Step 4: Docs** — `design-flow.md`: add the endpoint row to the §7 table, a "Validate" paragraph in §8 (rule list by code, gates, drafts never blocked), the two new files to the §11 table. `README.md`: upgrade note for an installed checkout — copy `validate.py`, `test_flow_validate.py`, updated `flow.py`, `engine.py`, tests and the Flows dashboard files; no patch, no migration.
- [ ] **Step 5: Run full backend** — `sb.sh sync`; `sb.sh py tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py -q`. Expected: all pass, none of the 33 baseline tests lost (changed ones documented).
- [ ] **Step 6: Commit** — `git add customize` ; `git commit -m "feat(flow): validate endpoint and activate/run gates"`.

---

### Task 3: Dashboard — issues panel, node outline, validate on Save/Run/Activate

**Files:**
- Modify: `customize/dashboard/pages/Flows/components/FlowCanvas.tsx`, `customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx`

**Interfaces:**
- Consumes: `POST /flows/{id}/validate` response from Task 2.
- Produces: exported `interface FlowIssue { level: "error" | "warning"; code: string; message: string; node_id: string | null }`.

- [ ] **Step 1: Write failing tests** in `FlowCanvas.test.tsx` (follow its existing `request` mock style). Tests:
  - `shows issues returned by Validate`: click "Validate" ⇒ `request` called with `/flows/f1/validate` and method POST and body containing current `nodes`/`edges`; panel lists each message, errors and warnings distinguishable (`data-level` attribute).
  - `blocks Activate when validation has errors`: validate returns an error ⇒ no PATCH with `status: "active"` is sent, issues panel visible.
  - `Activate proceeds when only warnings`.
  - `Run does not open the result drawer when validation has errors` (save succeeds, validate returns error ⇒ no `/run` request).
  - `fails open when validate request errors`: validate rejects ⇒ Save/Activate behave as today (Activate PATCH is sent).
  - `clicking an issue with a node_id opens that node's inspector`.
  - Saved payload never contains the outline style: after Validate with a node error, Save's PATCH body nodes have no `style` key added by validation.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh ui src/pages/Flows/components/FlowCanvas.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** in `FlowCanvas.tsx`: `issues` state; `runValidation(): Promise<FlowIssue[] | null>` (POST current canvas; returns `null` on request failure, which callers treat as "no blocking errors"); call it after a successful `handleSave`, in `handleRun` (bail before `setDrawerMode("run")` on errors), and in `handleToggleStatus` only when activating (bail on errors); a "Validate" toolbar button; an antd `Alert`/list panel above the canvas (hidden when no issues) with clickable rows selecting the node via `setInspectorNode`; `displayNodes = useMemo(...)` adding a red outline `style` to nodes with error issues (amber for warning-only) passed to `<ReactFlow nodes={displayNodes}>` while `nodes` state stays unstyled so Save never persists it. Clear `issues` for a node when its config is saved is NOT needed — refresh happens on next validate.
- [ ] **Step 4: Run to verify pass, then whole Flows UI suite** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: all pass (baseline 16 + new).
- [ ] **Step 5: Commit** — `git add customize/dashboard` ; `git commit -m "feat(flow): show validation issues on the canvas"`.
