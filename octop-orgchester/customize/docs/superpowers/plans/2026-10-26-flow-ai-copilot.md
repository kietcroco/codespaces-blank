# Flow AI Copilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user describe a flow in natural language and have an LLM (via Octop's configured model providers) create a new draft flow or modify the open one — roadmap item #10 (`ARCHITECTURE.md` §9.2).

**Architecture:** A pure module `flows/copilot.py` defines the `set_flow` tool, builds the system prompt, and turns the model's tool call into an xyflow graph (new ids, kept ids for edits, auto layout, config normalised). A new route `POST /flows/copilot` resolves the model with Octop's own precedence, calls `access.chat_model.bind_tools([set_flow])`, builds the graph, runs `validate_graph`, and returns a proposal without writing to the DB. The dashboard adds an "AI Copilot" drawer on the canvas (Apply snapshots a version first, then replaces the canvas) and a "Create with AI" modal on the Flows page.

**Tech Stack:** Python 3.12 / FastAPI / LangChain `BaseChatModel.bind_tools` / pytest (backend); React + antd + vitest (dashboard).

**Spec:** `customize/docs/superpowers/specs/2026-10-26-flow-ai-copilot-design.md`. Reference implementation (read-only): `orchester/apps/web/app/api/flows/[id]/copilot/route.ts`, `lib/flows/copilot-tools.ts`, `components/flows/CopilotPanel.tsx`.

## Global Constraints

- **Never edit or test in the real `Octop/` checkout.** Work in a git worktree `D:\Sources\RandD\flow-copilot-wt` (branch `flow-copilot`, created from `main`), authoring under `octop-orgchester/customize/`. Tests run through the Docker sandbox wrapper in the main checkout, `D:/Sources/RandD/codespaces-blank/octop-orgchester/scripts/sandbox/sb.sh`, with `CUSTOMIZE=/d/Sources/RandD/flow-copilot-wt/octop-orgchester/customize`; run `sb.sh sync` before every `py`/`ui`; never two `sb.sh` runs at once. **Task 1 must add these lines to `scripts/sandbox/sb.sh` in place in the main checkout** (untracked, never committed), inside the `sync)` branch: `cp "$C"/backend/flows/copilot.py "$O/src/octop/infra/flows/"` and `cp "$C"/backend/tests/test_flow_copilot.py "$O/tests/unit/test_flow_copilot.py"`. **Do not rebuild or restart the running Docker container `octop`**; only the `octop-sb-*` test containers.
- Run the baselines once before Task 1 and record them in the Task 1 commit message body: backend `tests/unit/test_flow_template.py tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py`; dashboard `ui src/pages/Flows`.
- **Route (exact):** `POST /flows/copilot` in `routers/flow.py`, declared with the other `/flows` routes. Body model `FlowCopilotBody`: `prompt: str` (stripped, `min_length=1`, `max_length=4000`), `history: list[CopilotMessage] = []` (`CopilotMessage{role: Literal["user","assistant"], content: str}`; the server keeps only the last 8), `current_graph: {nodes: list, edges: list} | None`, `flow_id: str | None`, `model: str | None`. Response `{message: str, graph: {nodes, edges} | None, issues: [FlowIssue dicts], model_ref: str | None}`. The route writes nothing to the DB.
- **Node vocabulary (exact):** `trigger | agent | condition | end` (`engine.NodeType`). Condition edges use `sourceHandle` `"true"` / `"false"`. Stored-config keys (what `_coerce_node_config` accepts): `prompt`, `agentId`, `outputVar`, `maxRetries`, `retryDelay`, `left`, `op`, `right`. Template syntax `{{path|filter:arg}}` (see `flows/template.py` for the filter list). Take the `op` values and node semantics from `engine.py`/`validate.py`; do not invent any.
- **Model resolution (exact; mirrors `gateway/process/processor.py:559-610` without agent/thread steps).** With `registry = server.app_runtime.agent_registry`, define `allowed(ref) = registry.model_ref_allowed_for_user(user.id, ref)`. First match wins: (1) the request `model` if `registry.providers.is_model_ref_usable(model) and allowed(model)`; (2) the user's preferred model — `get_preferred_model_from_json(user_row.preferences_json)` from `octop.infra.users.preferences`, with `user_row = server.services.user_repo.get(user.id)` — if `registry.is_auto_route_model_available(ref) and allowed(ref)`; (3) `registry.resolve_fallback_model_ref()` if truthy and `allowed(...)`; (4) `None`, which means `host_models.get(None)` (harness auto routing). An unusable or disallowed request `model` silently falls through, it is not an error. The agent's `default_model` is never consulted.
- **Model call (exact):** `access = server.app_runtime.agent_registry.host_models.get(ref)` (via `octop.infra.text_assist.require_host_models(server)`); then `access.chat_model.bind_tools([<set_flow tool dict>])` and `await asyncio.wait_for(bound.ainvoke(messages), timeout=60.0)`. Do not use `access.ainvoke`/`ainvoke_text` (they stringify away `tool_calls`). Messages are LangChain `SystemMessage`/`HumanMessage`/`AIMessage`. Response `model_ref` is `access.model_ref`.
- **Error mapping (exact):** `bind_tools` raising `NotImplementedError` ⇒ HTTP 422 `OctopError(ErrorCode.SLASH_BAD_ARGS, "model <model_ref> does not support tool calling; choose another model")`; `asyncio.TimeoutError` ⇒ `OctopError(ErrorCode.INTERNAL_ERROR, "copilot timed out")`; any other exception from the call ⇒ `OctopError(ErrorCode.INTERNAL_ERROR, "copilot model call failed")` (log with `logger.exception`, never echo provider text); no usable model ⇒ whatever `host_models.get` raises (`no usable model for text assist`). `flow_id` given ⇒ `_require_owned_flow` first.
- **Truncation:** treat the reply as truncated when `response_metadata.get("finish_reason") == "length"` or `response_metadata.get("stop_reason") == "max_tokens"`; then `graph: null` and a message that says the reply was cut off and asks for a smaller change. No `set_flow` call ⇒ `graph: null`, `message` = the model's text.
- Dashboard: plain English strings like the neighbouring Flows components (this dashboard has no i18n layer); `request` from `../../api/request`, errors via `apiErrorMessage`; model list from `GET /providers/resolved` (items `{provider_name, model, ...}`, ref = `${provider_name}/${model}`); "Auto" is the empty value.
- Keep LF endings and UTF-8; ASCII-only in new code comments; no `__pycache__`/`.pyc` tracked.
- Git: commit per task with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not merge; do not touch `Octop/`.

## Review Focus

- Model precedence: bad/disallowed explicit ref falls to the user's preferred model; unusable preferred falls to fallback; nothing usable ⇒ `get(None)`. Task 2 `test_copilot_model_precedence_*`.
- A model without tool calling (`bind_tools` raises) gives 422 naming the model, not a 500. Task 2.
- Truncated reply and "no tool call" reply never produce a graph. Tasks 1–2.
- Editing keeps ids of surviving nodes and positions of kept nodes; unknown node types and edges to missing nodes are dropped and reported in `message`, not 500. Task 1.
- The model returning a condition node with edges lacking `sourceHandle`, duplicate node ids, or zero nodes: no crash; zero nodes ⇒ `graph: null`. Task 1.
- Another user's `flow_id` is refused; copilot never writes to the DB. Task 2.
- Apply when the pre-apply save or snapshot fails leaves the canvas untouched; double-clicking Apply or Create sends one request. Tasks 3–4.

## File Structure

| File | Responsibility |
|---|---|
| `customize/backend/flows/copilot.py` | `set_flow` tool dict, `build_system_prompt`, `build_graph_from_spec`, `is_truncated` (pure, no I/O) |
| `customize/backend/tests/test_flow_copilot.py` | Unit tests for the module above |
| `customize/backend/routers/flow.py` | `FlowCopilotBody`, model resolution, `POST /flows/copilot` |
| `customize/backend/tests/test_flow_api.py` | Route tests with a fake `HostModelFactory.get` |
| `customize/dashboard/pages/Flows/components/FlowCopilotDrawer.tsx` (+ `.test.tsx`) | Chat drawer, model select, proposal card with Apply/Discard |
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` (+ `.test.tsx`) | "AI Copilot" button, Apply handler |
| `customize/dashboard/pages/Flows/index.tsx` (+ `.test.tsx`) | "Create with AI" modal |
| `customize/docs/design-flow.md`, `customize/README.md`, `ARCHITECTURE.md` §9.2, `.claude/memory/octop-orgchester-flow-status.md` | Docs and roadmap (Task 5) |

---

### Task 1: Copilot module (pure logic)

**Files:** Create `customize/backend/flows/copilot.py`, `customize/backend/tests/test_flow_copilot.py`; edit `scripts/sandbox/sb.sh` in the main checkout (untracked) as in Global Constraints.

**Interfaces — Produces (Task 2 relies on these exact names):**
- `SET_FLOW_TOOL: dict[str, Any]` — LangChain-style tool dict `{"type": "function", "function": {"name": "set_flow", "description": ..., "parameters": <JSON schema>}}` with `nodes[{id, type(enum of 4), label, config}]` and `edges[{source, target, sourceHandle, label}]`, both required.
- `build_system_prompt(agents: list[dict[str, str]], editing: bool) -> str` — `agents` items are `{"id", "name"}`; `editing` adds the "return the complete updated flow and keep the ids" rule.
- `build_graph_from_spec(spec: dict[str, Any], current_nodes: list[dict[str, Any]], new_id: Callable[[], str]) -> BuiltGraph`, where `BuiltGraph` is a dataclass `{nodes: list[dict], edges: list[dict], notes: list[str]}`; nodes/edges are xyflow-shaped (`id`, `type`, `position{x,y}`, `data{label, config}`; edge `id`, `source`, `target`, optional `sourceHandle`, optional `label`).
- `is_truncated(response_metadata: dict[str, Any] | None) -> bool`.

- [ ] **Step 1: Write failing tests** in `test_flow_copilot.py` (call `build_graph_from_spec` with a counter `new_id`): `test_builds_nodes_edges_with_layout_columns_by_depth` (trigger→agent→end: x strictly increasing, all positions set); `test_keeps_ids_and_positions_of_existing_nodes_when_editing` (spec node id equal to a `current_nodes` id keeps that id and its `position`; a new spec id gets `new_id()`); `test_config_keys_are_normalised_to_stored_camel_case` (`agent_id`→`agentId`, `output_var`→`outputVar`, `max_retries`→`maxRetries`, `retry_delay`→`retryDelay`; other keys untouched; non-string `prompt` coerced like `_coerce_node_config`); `test_unknown_type_node_and_dangling_edges_are_dropped_with_notes`; `test_duplicate_spec_ids_keep_first_and_note`; `test_empty_or_non_dict_spec_returns_no_nodes`; `test_condition_edge_without_handle_is_kept_unchanged` (no invention of a handle); `test_system_prompt_lists_agents_and_editing_rule` (agent id and name appear; "keep" rule only when `editing=True`; every node type and filter name from `template.py` appears); `test_is_truncated_for_length_and_max_tokens_only`; `test_set_flow_tool_schema` (name `set_flow`, type enum equals the four types, `nodes` and `edges` required).
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh py tests/unit/test_flow_copilot.py -q`. Expected: FAIL (`ModuleNotFoundError`).
- [ ] **Step 3: Implement the four names above in `copilot.py`.** Layout: depth = longest path from nodes with no incoming edge (cycle-safe, bounded iterations), `x = 80 + depth*260`, `y = 80 + index_in_column*140`; keep existing positions for ids present in `current_nodes`. Import the filter names from `flows.template` rather than hard-coding them (read how the module exposes them); import node types from `flows.engine`.
- [ ] **Step 4: Run to verify pass** — `sb.sh py tests/unit/test_flow_copilot.py -q`. Expected: all pass.
- [ ] **Step 5: Commit** `git add customize/backend/flows/copilot.py customize/backend/tests/test_flow_copilot.py` and commit `feat(flow): copilot spec-to-graph module`.

### Task 2: `POST /flows/copilot` route

**Files:** Modify `customize/backend/routers/flow.py` (add imports from `flows.copilot`, `FlowCopilotBody`, helper `_resolve_copilot_model_ref(server, user, requested) -> str | None`, the route; use the existing `_to_engine_graph`/`validate_graph`/`_require_owned_flow`/`new_short_id`); Modify `customize/backend/tests/test_flow_api.py`.

**Interfaces — Consumes:** Task 1 names. **Produces:** the route and response shape in Global Constraints (Task 3 and 4 call it).

- [ ] **Step 1: Write failing tests** in `test_flow_api.py`. Add a fixture `fake_model` that monkeypatches `octop.infra.agents.providers.HostModelFactory.get` to record the ref it was called with and return an object with `model_ref` and `chat_model.bind_tools(tools)` → an object whose `async ainvoke(messages)` returns a configurable `langchain_core.messages.AIMessage` (`content`, `tool_calls=[{"name": "set_flow", "args": {...}, "id": "1"}]`, `response_metadata`); also let the fixture make `bind_tools` raise `NotImplementedError`, and capture the `messages`. Tests: `test_copilot_creates_valid_graph_and_validates` (spec trigger→agent(agent id of a real agent from the `env`)→end ⇒ 200, `graph.nodes` have positions, `issues == []`, `model_ref` echoed; DB unchanged: `GET /flows` count same); `test_copilot_reports_validation_issues` (agent without agent id ⇒ `issues` contains `agent_missing_agent`); `test_copilot_edit_mode_sends_current_graph_and_keeps_ids` (messages contain the current node ids; result keeps them); `test_copilot_prompt_lists_only_users_agents` (another user's agent id is absent from the system message); `test_copilot_no_tool_call_returns_message_only`; `test_copilot_truncated_reply_returns_no_graph`; `test_copilot_model_without_tool_calling_is_422_naming_model`; `test_copilot_model_call_failure_is_500_without_provider_text`; `test_copilot_timeout_maps_to_internal_error` (patch `asyncio.wait_for` timeout via a model whose `ainvoke` raises `asyncio.TimeoutError`); `test_copilot_other_users_flow_id_is_refused`; `test_copilot_rejects_empty_prompt` (422); `test_copilot_history_is_capped_to_last_8`; `test_copilot_model_precedence_*` — three tests that monkeypatch `registry.providers.is_model_ref_usable`, `registry.model_ref_allowed_for_user`, `registry.is_auto_route_model_available`, `registry.resolve_fallback_model_ref` and the user's `preferences_json` to assert the ref passed to `HostModelFactory.get`: explicit usable ref wins; explicit unusable ⇒ preferred; preferred unavailable ⇒ fallback; nothing ⇒ `None`; explicit disallowed-for-user ⇒ falls through.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh py tests/integration/test_flow_api.py -q -k copilot`. Expected: FAIL (404).
- [ ] **Step 3: Implement `_resolve_copilot_model_ref` and the route** exactly per Global Constraints. Build the agent list from `registry.list_agents(user.id)` as `[{"id": row.agent_id, "name": row.name}]`. Dedicated IDs: new node/edge ids via `new_short_id()`. Response `graph` is `None` unless the built graph has at least one node. Confirm no existing `POST /flows/{flow_id}` route shadows `/flows/copilot` (only suffixed POST routes exist today).
- [ ] **Step 4: Run to verify pass** — `sb.sh py tests/unit/test_flow_copilot.py tests/unit/test_flow_template.py tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py -q`. Expected: all pass (baseline plus the new tests).
- [ ] **Step 5: Commit** `feat(flow): AI copilot endpoint`.

### Task 3: Canvas copilot drawer

**Files:** Create `components/FlowCopilotDrawer.tsx` and `.test.tsx`; modify `components/FlowCanvas.tsx` and its test (all under `customize/dashboard/pages/Flows/`).

**Interfaces — Produces:** `FlowCopilotDrawer` props `{open: boolean; flowId: string; onClose: () => void; getGraph: () => {nodes: Node[]; edges: Edge[]}; onApply: (proposal: {nodes: Node[]; edges: Edge[]; issues: FlowIssue[]}) => Promise<boolean>}`; exports `CopilotProposal`. `FlowIssue` is the type `FlowCanvas.tsx` already uses.

- [ ] **Step 1: Write failing tests.** Drawer: `sends prompt, last-8 history, current graph, flow_id and model to POST /flows/copilot`; `shows the assistant message and a proposal card with node labels and issue count`; `Apply calls onApply once even when clicked twice, then clears the proposal; Discard clears without calling onApply`; `a null graph shows only the message`; `an API error shows an inline alert and keeps the input`; `model select lists Auto plus GET /providers/resolved entries and sends the chosen ref (Auto sends none)`; `empty or whitespace prompt does not send`. Canvas: `AI Copilot button opens the drawer`; `Apply saves first, creates a version labelled "Before AI copilot", then replaces nodes/edges and shows the proposal's issues`; `if save or version creation fails the canvas is unchanged and an error is shown`.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh ui src/pages/Flows -t Copilot`. Expected: FAIL.
- [ ] **Step 3: Implement the drawer** (antd `Drawer`, placement right, `mask={false}`, chat list, `Input.TextArea` Enter-to-send, `Select` for model, proposal card) following `FlowVersionsDrawer.tsx` conventions (busy ref, `apiErrorMessage`). **Canvas:** add an "AI Copilot" toolbar button (lucide `Sparkles`) and `handleCopilotApply`: `await handleSave(false)` (abort if false) → `POST /flows/${flowId}/versions {label: "Before AI copilot"}` (abort with `message.error` on failure) → `setNodes/setEdges` from the proposal, `setInspectorNode(null)`, `setIssues(proposal.issues)`; return true. The canvas is left unsaved after Apply (the user presses Save).
- [ ] **Step 4: Run to verify pass** — `sb.sh ui src/pages/Flows`. Expected: all pass (baseline plus new).
- [ ] **Step 5: Commit** `feat(flow): AI copilot drawer on the canvas`.

### Task 4: "Create with AI" on the Flows page

**Files:** Modify `customize/dashboard/pages/Flows/index.tsx` and `index.test.tsx`.

- [ ] **Step 1: Write failing tests:** `Create with AI button opens a modal with a description box and the model select`; `Generate calls POST /flows/copilot (no current_graph, no flow_id), then POST /flows with a name taken from the first 40 characters of the prompt, then PATCH nodes/edges, then navigates to /flows/<id>`; `a null graph shows the assistant message in the modal and creates nothing`; `a failing copilot call shows an error and creates nothing`; `if PATCH fails the flow is still created, an error is shown and navigation still happens` (same pattern as templates); `double-clicking Generate sends one copilot request`; `empty description disables Generate`.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh ui src/pages/Flows/index.test.tsx -t "Create with AI"`. Expected: FAIL.
- [ ] **Step 3: Implement** the button (lucide `Sparkles`), modal, and handler in `index.tsx`, reusing the `usingRef` guard pattern from `handleUseTemplate`. Share the model-select loading with the drawer by extracting a small hook `useResolvedModels()` into `components/useResolvedModels.ts` (and use it in Task 3's drawer; if Task 3 is already done, refactor it here and keep its tests green).
- [ ] **Step 4: Run to verify pass** — `sb.sh ui src/pages/Flows`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(flow): create a flow with the AI copilot`.

### Task 5: Docs, roadmap, whole-phase verification

**Files:** `customize/docs/design-flow.md` (§7 add the route row, §9 one sentence on the drawer/modal), `customize/README.md` (upgrade note: new file `flows/copilot.py`, changed `routers/flow.py`, new dashboard files; no migration), `ARCHITECTURE.md` §9.2 (mark #10 done with a one-paragraph summary like #9's, note "not installed into `Octop/`"; update the §7/§9 counts if they list the number done), `.claude/memory/octop-orgchester-flow-status.md` (progress: #10 done, next = group A #11–18), and `customize/install.sh` if it enumerates backend files (check; add `flows/copilot.py`).

- [ ] **Step 1: Make the doc edits above.**
- [ ] **Step 2: Whole-phase run** — `sb.sh sync`; the full backend command from Global Constraints and `sb.sh ui src/pages/Flows`. Expected: all pass; record the counts.
- [ ] **Step 3: Commit** `docs(flow): AI copilot (roadmap #10)`. Report to the user: phase 10/38 complete on branch `flow-copilot`, test counts, not merged, not installed.

## Self-Review notes

- Spec coverage: §2.1 endpoint → Task 2; §2.2 module → Task 1; §2.3 model rule → Task 2 (extended to the user's `preferred_model` and fallback, found in `processor.py` after the spec was written — the spec's "explicit → auto" is a subset); §2.4 errors → Task 2; §3 frontend → Tasks 3–4; §4 tests → inline; §5 scope → Global Constraints.
- Spec deviations to keep in the docs: dashboard has no i18n (plain strings); the spec's "provider access path" and "agent list" open items are resolved above (`registry.providers`, `registry.list_agents(user.id)`).
