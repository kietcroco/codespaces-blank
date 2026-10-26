# Flow Agent-Node Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an `agent` node retry a failed agent call a configurable number of times before the step (and the run) fails — roadmap item #2 of the Flow gap analysis (`ARCHITECTURE.md` §9.2).

**Architecture:** `engine.py`'s agent-node branch wraps `call_agent` in a bounded retry loop driven by two new per-node config keys (`max_retries`, `retry_delay`). The sleep between attempts is injected into `run_flow` (like `call_agent`) so tests never really wait. The router renames the two new camelCase keys the dashboard writes, and marks deterministic failures (agent not found / not owned) as non-retryable. The dashboard's node inspector gets two number inputs. Default is `max_retries = 0`, so every existing flow behaves exactly as before. No DB change, no new patch, no new dependency.

**Tech Stack:** Python 3.12 / FastAPI / pytest (backend); React + antd + vitest (dashboard).

**Spec:** `customize/docs/design-flow.md` (§8 engine, §9 frontend) and `ARCHITECTURE.md` §9.2 item 2. This plan adds a short "Retry" paragraph to design-flow §8 (Task 2).

## Global Constraints

- **Never edit or test in the real `Octop/` checkout.** All test runs go through the Docker sandbox wrapper `D:\Sources\RandD\octop-sandbox\sb.sh` (bash; Octop base commit `6797d0e4` + Agency/Flow already installed + patches 01-17 applied). Author files only under `customize/`; the wrapper copies them to their installed paths.
- Wrapper commands (run from Git Bash; set `CUSTOMIZE` to the `customize/` dir of the worktree you are working in):
  - `CUSTOMIZE=<abs path to customize> bash /d/Sources/RandD/octop-sandbox/sb.sh sync` — copy authored Flow files into the sandbox.
  - `... sb.sh py <pytest args>` — e.g. `sb.sh py tests/unit/test_flow_engine.py -q` (first call after a long idle may take ~1 min).
  - `... sb.sh ui <vitest args>` — e.g. `sb.sh ui src/pages/Flows/components/NodeInspectorDrawer.test.tsx`.
  - Always run `sync` after editing and before `py`/`ui`.
- Baseline before this plan: backend `tests/unit/test_flow_engine.py` + `tests/integration/test_flow_api.py` = 13 passed.
- Retry semantics (exact values):
  - `max_retries`: integer extra attempts after the first; default `0`; clamped to `0..5` (`MAX_RETRIES_CAP = 5`). Total calls ≤ `max_retries + 1`.
  - `retry_delay`: seconds slept between attempts, fixed (no backoff); default `1.0`; clamped to `0..30` (`MAX_RETRY_DELAY = 30.0`).
  - Absent / `None` / `""` ⇒ default. Numeric strings (`"2"`, `"0.5"`) accepted. A non-numeric value (`"abc"`) or a bool ⇒ the step fails with error `invalid retry config: <key> must be a number, got <repr>` and `call_agent` is never invoked.
  - Every `Exception` from `call_agent` is retried, **except** `NonRetryableError` (new, defined in `engine.py`), which fails the step immediately.
  - Retries do not count toward `max_steps` (a step is one node visit).
  - Error text: with `max_retries == 0` or a `NonRetryableError`, unchanged: `agent call failed: <exc>`. With retries exhausted: `agent call failed after <N> attempts: <exc>` where N = attempts made.
- Config keys in saved JSON: dashboard writes `maxRetries` / `retryDelay`; router renames to `max_retries` / `retry_delay` (same pattern as `agentId`→`agent_id`).
- Git: work in a worktree branch `flow-agent-retry`; commit per task with the `Co-Authored-By` trailer; do not merge or touch `Octop/`.

## Review Focus

- `max_retries` omitted on an existing flow ⇒ exactly one call, exactly the old error text (backward compat). Task 1 `test_agent_default_makes_single_call_and_old_error_text`.
- Agent not found / not owned must not burn retries and sleeps. Task 2 `test_run_unowned_agent_is_not_retried`.
- Out-of-range / garbage values (`-3`, `99`, `"abc"`, `True`) must not 500 or loop forever. Task 1 clamp and invalid-config tests.
- Delay of 30s × 5 retries per node could hold a request ~150s; this is the documented ceiling (cap constants), not an unbounded wait. Task 1 `test_retry_values_are_clamped`.
- A flaky agent that succeeds on attempt N must record only the successful step (no duplicate/failed step rows) and the reply must reach `variables`. Task 1 `test_agent_retries_until_success`.

## File Structure

| File | Responsibility |
|---|---|
| `customize/backend/flows/engine.py` | `NonRetryableError`, retry policy parsing, retry loop in agent branch, `sleep` kwarg on `run_flow` |
| `customize/backend/tests/test_flow_engine.py` | Engine retry tests |
| `customize/backend/routers/flow.py` | Rename `maxRetries`/`retryDelay`; raise `NonRetryableError` for agent not found / not owned |
| `customize/backend/tests/test_flow_api.py` | End-to-end retry + non-retry tests |
| `customize/docs/design-flow.md` | §8 "Retry" paragraph |
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` | `FlowNodeConfig` gains `maxRetries?`, `retryDelay?` |
| `customize/dashboard/pages/Flows/components/NodeInspectorDrawer.tsx` | Two `InputNumber` fields for agent nodes |
| `customize/dashboard/pages/Flows/components/NodeInspectorDrawer.test.tsx` | New: drawer test for the two fields |

---

### Task 1: Engine — bounded retry loop for agent nodes

**Files:**
- Modify: `customize/backend/flows/engine.py`
- Test: `customize/backend/tests/test_flow_engine.py`

**Interfaces:**
- Produces (Task 2 relies on these exact names):
  - `class NonRetryableError(Exception)` in `engine.py`.
  - `run_flow(nodes, edges, *, input, call_agent, max_steps=50, sleep=asyncio.sleep)`; `Sleeper = Callable[[float], Awaitable[None]]`.
  - Config keys read by the agent branch: `max_retries`, `retry_delay`.
  - Constants `MAX_RETRIES_CAP = 5`, `MAX_RETRY_DELAY = 30.0`, `DEFAULT_RETRY_DELAY = 1.0`.

- [ ] **Step 1: Write the failing tests** in `test_flow_engine.py` (helper `_flaky(fail_times, exc=RuntimeError)` returning an async `call_agent` that raises `exc("boom")` for the first `fail_times` calls then returns `"ok"`, and counts calls; helper `_sleeps()` returning `(list, async_sleep)` that records requested delays). Graph for all tests: trigger → agent(`agent_id="bot1"`, `output_var="a"`, plus retry keys) → end. Tests, with these assertions:
  - `test_agent_default_makes_single_call_and_old_error_text`: `fail_times=5`, no retry keys ⇒ `status=="failed"`, `error=="agent call failed: boom"`, calls == 1, sleeps == [].
  - `test_agent_retries_until_success`: `max_retries=3, retry_delay=0.5`, `fail_times=2` ⇒ `status=="succeeded"`, `output["a"]=="ok"`, calls == 3, sleeps == [0.5, 0.5], the agent step list has exactly one agent step with `status=="succeeded"`.
  - `test_agent_exhausts_retries`: `max_retries=2`, `fail_times=9` ⇒ failed, `error=="agent call failed after 3 attempts: boom"`, calls == 3, last step `status=="failed"` with the same error.
  - `test_non_retryable_error_fails_immediately`: `max_retries=3`, caller raises `NonRetryableError("nope")` ⇒ calls == 1, sleeps == [], `error=="agent call failed: nope"`.
  - `test_retry_values_are_clamped`: `max_retries=99, retry_delay=999`, `fail_times=99` ⇒ calls == 6, sleeps == [30.0]*5. Also `max_retries=-3` ⇒ calls == 1.
  - `test_retry_config_accepts_numeric_strings_and_blank`: `{"max_retries": "2", "retry_delay": "0"}` ⇒ calls == 3 on `fail_times=9`; `{"max_retries": "", "retry_delay": None}` ⇒ calls == 1.
  - `test_invalid_retry_config_fails_step_without_calling_agent`: parametrize `("max_retries","abc")`, `("retry_delay","abc")`, `("max_retries", True)` ⇒ failed, calls == 0, `error` starts with `"invalid retry config: "`.

- [ ] **Step 2: Run to verify failure** — `sb.sh sync` then `sb.sh py tests/unit/test_flow_engine.py -q`. Expected: new tests FAIL (`NonRetryableError` import error / unexpected kwarg).

- [ ] **Step 3: Implement in `engine.py`**
  - Add `import asyncio`, `Sleeper` type, the three constants, `class NonRetryableError(Exception)` (docstring: raised by a caller to say retrying is pointless).
  - Add `_retry_policy(config: dict[str, Any]) -> tuple[int, float]`: reads `max_retries` / `retry_delay`; `None` or `""` ⇒ default; bool or non-numeric ⇒ `ValueError(f"invalid retry config: {key} must be a number, got {value!r}")`; otherwise `int(float(v))` / `float(v)` clamped to the ranges above.
  - Agent branch: call `_retry_policy` first (on `ValueError` produce the failed-step + failed-run path used today, `agent_id` set, `call_agent` untouched). Then loop `attempt in range(max_retries + 1)`: try `call_agent`; on `NonRetryableError` stop immediately; on other `Exception`, if attempts remain `await sleep(delay)` and continue. Failure message: `agent call failed: <exc>` when `max_retries == 0` or the error was non-retryable, else `agent call failed after <attempts> attempts: <exc>`. Success path unchanged.
  - `run_flow` gains `sleep: Sleeper = asyncio.sleep`.

- [ ] **Step 4: Run to verify pass** — `sb.sh sync` then `sb.sh py tests/unit/test_flow_engine.py -q`. Expected: all pass (5 old + 7 new, parametrized count may differ).

- [ ] **Step 5: Commit** — `git add backend/flows/engine.py backend/tests/test_flow_engine.py` ; `git commit -m "feat(flow): retry agent-node calls (max_retries, retry_delay)"`.

---

### Task 2: Router — key mapping, non-retryable errors, docs

**Files:**
- Modify: `customize/backend/routers/flow.py` (`_coerce_node_config` ~L98-125, `call_agent` ~L349-352)
- Modify: `customize/backend/tests/test_flow_api.py`
- Modify: `customize/docs/design-flow.md` (§8)

**Interfaces:**
- Consumes: `NonRetryableError`, `run_flow(..., sleep=...)` from Task 1 (`from octop.infra.flows.engine import ... NonRetryableError`).
- Produces: nothing new for Task 3 beyond the saved-config key names `maxRetries` / `retryDelay` (camelCase in stored JSON).

- [ ] **Step 1: Write the failing tests** in `test_flow_api.py` (use the existing `env` and `_patch_fake_agent_call` style; monkeypatch `FakeHarnessAgent.call` for a flaky agent and monkeypatch `asyncio.sleep` in `octop.infra.flows.engine` — or set `retryDelay: 0` — so tests do not wait):
  - `test_run_retries_flaky_agent_from_xyflow_config`: persisted xyflow-shaped graph whose agent node `data.config` is `{"agentId": <real agent>, "prompt": "hi", "maxRetries": 2, "retryDelay": 0}`; fake `call` fails once then returns `"fake reply"` ⇒ run `status=="succeeded"`, fake call count == 2.
  - `test_run_unowned_agent_is_not_retried`: reuse the setup of `test_run_flow_with_unowned_agent_fails_step_not_500` with `maxRetries: 3` added ⇒ step failed, the lookup/ownership error message is unchanged from that existing test, and the run took no retry delay (assert via call count of a monkeypatched `engine.asyncio.sleep` == 0).
- [ ] **Step 2: Run to verify failure** — `sb.sh sync` then `sb.sh py tests/integration/test_flow_api.py -q -k "retries_flaky or not_retried"`. Expected: FAIL.
- [ ] **Step 3: Implement** — in `_coerce_node_config` rename `maxRetries`→`max_retries`, `retryDelay`→`retry_delay` (same `pop` pattern; do not stringify them). In `call_agent`, wrap the `get_row` None-check and `assert_agent_owner` so an `OctopError` raised there is re-raised as `NonRetryableError(str(exc)) from exc` (keep the exact message text so the existing unowned-agent test still passes). Add `NonRetryableError` to the engine import.
- [ ] **Step 4: Update `design-flow.md` §8** — add a short "Retry (agent node)" paragraph stating the config keys, defaults, clamps, `NonRetryableError`, and that retries do not count toward `max_steps`.
- [ ] **Step 5: Run full backend Flow suite** — `sb.sh sync` then `sb.sh py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py -q`. Expected: all pass, none of the 13 baseline tests regressed.
- [ ] **Step 6: Commit** — `git add backend/routers/flow.py backend/tests/test_flow_api.py docs/design-flow.md` ; `git commit -m "feat(flow): wire agent retry through the router"`.

---

### Task 3: Dashboard — retry fields in the node inspector

**Files:**
- Modify: `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` (`FlowNodeConfig`, ~L32-39)
- Modify: `customize/dashboard/pages/Flows/components/NodeInspectorDrawer.tsx`
- Create: `customize/dashboard/pages/Flows/components/NodeInspectorDrawer.test.tsx`

**Interfaces:**
- Consumes: stored-config key names `maxRetries`, `retryDelay` (Task 2).
- Produces: `FlowNodeConfig.maxRetries?: number`, `FlowNodeConfig.retryDelay?: number`.

- [ ] **Step 1: Write the failing test** `NodeInspectorDrawer.test.tsx` (follow the mocking style of `FlowCanvas.test.tsx` / `RunResultDrawer.test.tsx` for `request`; render an `agent` node with `config: {maxRetries: 2, retryDelay: 1.5}`). Tests:
  - `shows retry fields for agent nodes with saved values`: `getByLabelText("Max retries")` has value `2`, `getByLabelText("Retry delay (seconds)")` has value `1.5`.
  - `submits retry values in the saved config`: change Max retries to `3`, click Apply ⇒ `onSave` called with `("n1", expect.objectContaining({ maxRetries: 3, retryDelay: 1.5 }))`.
  - `does not render retry fields for condition nodes`.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync` then `sb.sh ui src/pages/Flows/components/NodeInspectorDrawer.test.tsx`. Expected: FAIL (fields missing).
- [ ] **Step 3: Implement** — add `maxRetries?: number; retryDelay?: number;` to `FlowNodeConfig`. In the agent block of `NodeInspectorDrawer.tsx` add two antd `InputNumber` `Form.Item`s after "Output variable": `name="maxRetries"` label "Max retries" (`min={0}`, `max={5}`, `precision={0}`, `placeholder="0"`), `name="retryDelay"` label "Retry delay (seconds)" (`min={0}`, `max={30}`, `step={0.5}`, `placeholder="1"`). Leaving them empty must submit `undefined`/`null` (engine treats as default).
- [ ] **Step 4: Run to verify pass, then whole Flows UI suite** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: all pass (baseline Flows suite must not regress).
- [ ] **Step 5: Commit** — `git add dashboard/pages/Flows/components/` ; `git commit -m "feat(flow): add retry fields to the agent node inspector"`.
