# Flow Status Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `flows.status` ("draft" | "active") actually gate `POST /flows/{flow_id}/run` — a draft flow currently runs identically to an active one (roadmap item #1 of the Flow feature's post-V1 gap analysis) — and give the dashboard a way to flip a flow's status, since no UI path to do that exists yet.

**Architecture:** A single new precondition check in the existing `run_flow_endpoint` (`backend/routers/flow.py`), raising a new `OctopError(ErrorCode.FLOW_NOT_ACTIVE, ...)` (409) before any graph parsing happens, so the check is cheap and fails fast. `ErrorCode.FLOW_NOT_ACTIVE` does not exist in `Octop/src/octop/infra/errors.py` yet — it ships as a new small patch (`docs/patches/17-...patch`), the same mechanism already used for the 4 existing Flow patches (app.py mount, route, sidebar key, preferences key). On the frontend, `FlowCanvas.tsx` gains a status display + an Activate/Deactivate toggle button that PATCHes `{status}`, and `RunResultDrawer.tsx`'s run-error path switches from showing the raw thrown-`Error` string to `apiErrorMessage()` (an existing dashboard utility already used by other pages) so the new 409's clean server message actually reaches the user instead of a raw JSON blob.

**Tech Stack:** FastAPI + sqlite3/psycopg (existing `flow.py` router), pytest for backend; React + antd + vitest for the dashboard — no new dependency either side.

**Spec:** `/workspaces/codespaces-blank/octop-orgchester/customize/docs/design-flow.md` (§7 Backend API, §11 patch list) — this plan is a small addendum to that spec, not a rewrite; §7/§11 get updated as part of Task 1.

## Global Constraints

- **Never edit or test directly in the real `/workspaces/codespaces-blank/Octop` checkout.** Per this repo's own documented process (`octop-orgchester/ARCHITECTURE.md` §3 step 3: "mỗi task build & test trong sandbox Octop tạm... không bao giờ chạy trực tiếp trong Octop/ thật") and its README ("Octop/ không bị sửa trực tiếp bởi tôi... patch... chỉ xảy ra khi người dùng tự chạy `install.sh`"), every edit, patch-generation, and test run for this plan happens in a **disposable sandbox copy**, never the real checkout. Reason it must be a full copy, not a quicker trick: `customize/` has no Python venv or `node_modules` of its own — the real `Octop/.venv` (~811M) and `Octop/dashboard/node_modules` (~848M) are the only installed environments that can run these tests, and copying just the venv/node_modules onto `customize/`'s own tree would still need the rest of `Octop/`'s source (`tests/support/*` fixtures the backend tests import, the built dashboard config vitest needs, etc.).
- **Sandbox setup (once per task that needs it):** `cp -r /workspaces/codespaces-blank/Octop /tmp/octop-flow-status-gate-sandbox` (~1.9GB — use `/tmp`, which has ~30GB free; `/workspaces` is at 85% capacity and must not be used for this copy). If the sandbox already exists from an earlier task in this same plan, reuse it as-is (don't re-copy). Inside the sandbox, edit/copy files at their **installed path**, never their `customize/` authored path — tests and patches are only meaningful against the installed layout:

  | Authored at (`customize/...`) | Installed at (inside the sandbox) |
  |---|---|
  | `backend/routers/flow.py` | `src/octop/api/routers/flow.py` |
  | `backend/tests/test_flow_api.py` | `tests/integration/test_flow_api.py` |
  | `dashboard/pages/Flows/components/FlowCanvas.tsx` | `dashboard/src/pages/Flows/components/FlowCanvas.tsx` |
  | `dashboard/pages/Flows/components/FlowCanvas.test.tsx` | `dashboard/src/pages/Flows/components/FlowCanvas.test.tsx` |
  | `dashboard/pages/Flows/components/RunResultDrawer.tsx` | `dashboard/src/pages/Flows/components/RunResultDrawer.tsx` |
  | `dashboard/pages/Flows/components/RunResultDrawer.test.tsx` | `dashboard/src/pages/Flows/components/RunResultDrawer.test.tsx` |
  | (new patch target) | `src/octop/infra/errors.py` |

  Backend tests run via `/tmp/octop-flow-status-gate-sandbox/.venv/bin/pytest tests/integration/test_flow_api.py -v` (from inside the sandbox dir). Frontend tests run via `cd /tmp/octop-flow-status-gate-sandbox/dashboard && npx vitest run src/pages/Flows/components/<File>.test.tsx` (its `node_modules` is already installed from the copy — no `npm install` needed). The workflow per edit: make the change in the `customize/`-authored file (the one this task's commit actually tracks) → copy that same content into its installed sandbox path → run the test there → once green, the `customize/` file is already correct (it's the source you just copied from) — nothing about the real `Octop/` checkout ever changes, and the sandbox itself is disposable scratch (leave it for the next task to reuse; it is not part of this plan's git history either way).
- A new `ErrorCode` can't be authored as a `customize/`-side file at all (it must become a real enum member inside `Octop/src/octop/infra/errors.py`), so it ships as a **patch**: edit `errors.py` inside the sandbox, then `git -C /tmp/octop-flow-status-gate-sandbox diff -- src/octop/infra/errors.py > customize/docs/patches/17-errors-add-flow-not-active.patch` (redirect straight into the real `customize/` worktree path — that redirect target is the only thing this step writes outside the sandbox).
- No new npm or pip dependency on either side.
- Follow the existing `AGENT_NOT_RUNNING` precedent exactly for the new error code: add one `ErrorCode` enum member and one `_DEFAULT_STATUS` entry mapped to `409`, in the same two places `AGENT_NOT_RUNNING` already lives in `src/octop/infra/errors.py`. No backend i18n (`src/octop/i18n/*.json`) or dashboard locale (`dashboard/src/locales/*.json`) entries — Flow's existing UI strings ("Run", "Save", "History", etc.) are already hardcoded English with no `t()` calls anywhere in `FlowCanvas.tsx`/`RunResultDrawer.tsx`/`index.tsx`; adding translation for just this one message would be inconsistent with that established (deliberate, V1) choice. The error's English message, set at raise time, is what reaches every locale via `OctopError.to_envelope`'s fallback when no i18n key exists.
- The status check must run *before* `_to_engine_graph(...)` in `run_flow_endpoint`, not after — it is the cheapest possible precondition and must not be masked by (or mask) the existing 422/step-level-failure checks that already exist further down that function.
- Ownership (`_require_owned_flow`) is still checked first, unchanged — a user hitting another user's flow still gets 404/403, never a 409 that would leak whether the flow exists.

## Review Focus

- Five existing `test_flow_api.py` tests call `POST /run` without ever setting `status`, relying on the pre-existing "draft runs exactly like active" behavior this plan removes — each needs `"status": "active"` added to a PATCH it already sends, or it starts failing (or — worse — starts asserting the *wrong* thing: `test_run_with_malformed_node_is_clean_422_not_500` and `test_run_with_non_string_config_field_fails_step_not_500` would get a 409/200 instead of the 422/step-failure they're actually testing for, silently testing nothing). Covered in Task 1 Step 6.
- A draft flow reached through an automated caller (e.g. a cron job hitting `POST /run` directly, per spec §10's documented future trigger path) must get the same clean 409 as a manual click — not a silent 200 that fakes a successful automated run. Covered by Task 1's new `test_run_rejects_draft_flow`.
- Toggling Activate on an already-active flow (or Deactivate on an already-draft one) must be a harmless no-op PATCH, not a 500 or a confusing error. Covered by Task 2's button test asserting the PATCH body and resulting label on both directions.
- A failed Activate/Deactivate PATCH (network/API error) must not optimistically flip the toolbar's displayed status label — the label must only change after the PATCH actually resolves. Covered by only updating `flowStatus` state inside the PATCH's success path in Task 2.
- The 409 reaching the user through `RunResultDrawer`'s auto-run effect must render the server's actual message text ("flow must be active to run — activate it first"), not the raw `Error: Request failed: 409 Conflict - {"error":...}` string the component shows today for every run failure. Covered by Task 2's switch to `apiErrorMessage()` + its new test.

## File Structure

| File | Responsibility |
|---|---|
| `customize/docs/patches/17-errors-add-flow-not-active.patch` | New patch: adds `ErrorCode.FLOW_NOT_ACTIVE` + its 409 mapping to `Octop/src/octop/infra/errors.py` |
| `customize/backend/routers/flow.py` | Modify `run_flow_endpoint` to reject a non-"active" flow before parsing its graph |
| `customize/backend/tests/test_flow_api.py` | Activate flows before running in 5 existing tests; add `test_run_rejects_draft_flow` |
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` | Track `flowStatus`; add a status Tag + Activate/Deactivate toggle button to the toolbar |
| `customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx` | New test for the toggle button (both directions) |
| `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx` | Use `apiErrorMessage()` instead of the raw thrown-error string for the run-failure message |
| `customize/dashboard/pages/Flows/components/RunResultDrawer.test.tsx` | New test proving a failed run shows the parsed server message |
| `customize/docs/design-flow.md` | §7 row for `POST /run` gets a one-line note on the 409 gate; §11's patch table gets patch 17 added |

---

### Task 1: Backend — gate `POST /run` on `flows.status`, new `FLOW_NOT_ACTIVE` error

**Files:**
- Create: `customize/docs/patches/17-errors-add-flow-not-active.patch`
- Modify: `customize/backend/routers/flow.py:307-317` (`run_flow_endpoint`)
- Modify: `customize/backend/tests/test_flow_api.py`
- Modify: `customize/docs/design-flow.md:195` (§7 table) and `:259-` (§11 patch table)

**Interfaces:**
- Produces: `ErrorCode.FLOW_NOT_ACTIVE` (new member, patched into the real `Octop/src/octop/infra/errors.py`'s `ErrorCode` enum and `_DEFAULT_STATUS` dict, mapped to HTTP `409`) — Task 2 and any future caller reference it by this exact name.
- Consumes: `OctopError`, `ErrorCode` (already imported in `flow.py:26`); `_require_owned_flow` (already defined, returns the flow row with a `status` key, `flow.py:188-196`).

- [ ] **Step 1: Create the sandbox**

```bash
cp -r /workspaces/codespaces-blank/Octop /tmp/octop-flow-status-gate-sandbox
```
(Skip this if it already exists.) This is scratch — it is never committed and the real `Octop/` is never touched by anything in this task.

- [ ] **Step 2: Generate patch 17 inside the sandbox**

Edit `/tmp/octop-flow-status-gate-sandbox/src/octop/infra/errors.py`:
- Add `FLOW_NOT_ACTIVE = "FLOW_NOT_ACTIVE"` to the `ErrorCode` enum, next to the existing `AGENT_NOT_RUNNING = "AGENT_NOT_RUNNING"` line.
- Add `ErrorCode.FLOW_NOT_ACTIVE: 409,` to the `_DEFAULT_STATUS` dict, next to the existing `ErrorCode.AGENT_NOT_RUNNING: 409,` line.

Then, from this task's actual working directory (the `customize/` worktree, where the patch file belongs):
```bash
git -C /tmp/octop-flow-status-gate-sandbox diff -- src/octop/infra/errors.py \
  > docs/patches/17-errors-add-flow-not-active.patch
```
Confirm the new patch file has non-empty content. Leave the sandbox's `errors.py` edited (don't revert it) — Step 5 onward needs it in place to run tests.

- [ ] **Step 3: Write the failing test**

```python
async def test_run_rejects_draft_flow(env):
    c, _, auth = env
    flow_id = (await c.post("/api/flows", headers=auth, json={"name": "Still draft"})).json()["flow_id"]
    r = await c.post(f"/api/flows/{flow_id}/run", headers=auth, json={"input": {}})
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "FLOW_NOT_ACTIVE"
```
Add it to `customize/backend/tests/test_flow_api.py` (the file this task's commit tracks), then copy the whole file into the sandbox's installed path: `cp backend/tests/test_flow_api.py /tmp/octop-flow-status-gate-sandbox/tests/integration/test_flow_api.py`.

- [ ] **Step 4: Run it to verify it fails**

Run: `cd /tmp/octop-flow-status-gate-sandbox && PYTHONPATH=/tmp/octop-flow-status-gate-sandbox/src .venv/bin/pytest tests/integration/test_flow_api.py::test_run_rejects_draft_flow -v`

**Note:** the `PYTHONPATH=.../src` prefix is required on every pytest invocation against this sandbox — it is NOT optional and NOT just this one command. The sandbox's `.venv` is a copied editable install whose `.pth` metadata hardcodes the real checkout's absolute path (`/workspaces/codespaces-blank/Octop/src`), so without this prefix, `pytest` silently imports the real checkout's unmodified `octop.*` modules instead of the sandbox's own edited copies — it will appear to run but never actually exercise your changes. Confirmed by the first implementer who hit this; ruled on and added here by the controller.

Expected: FAIL — current code returns 200 (a draft flow with no nodes runs trivially and "succeeds").

- [ ] **Step 5: Implement the gate in `run_flow_endpoint`**

In `customize/backend/routers/flow.py`, immediately after `row = _require_owned_flow(server, user, flow_id)` inside `run_flow_endpoint` (before the `nodes, edges = _to_engine_graph(...)` line), add:

```python
if row["status"] != "active":
    raise OctopError(
        ErrorCode.FLOW_NOT_ACTIVE, "flow must be active to run — activate it first"
    )
```
Copy it into the sandbox: `cp backend/routers/flow.py /tmp/octop-flow-status-gate-sandbox/src/octop/api/routers/flow.py`.

- [ ] **Step 6: Run the new test to verify it passes**

Run: `cd /tmp/octop-flow-status-gate-sandbox && PYTHONPATH=/tmp/octop-flow-status-gate-sandbox/src .venv/bin/pytest tests/integration/test_flow_api.py::test_run_rejects_draft_flow -v`
Expected: PASS

- [ ] **Step 7: Activate flows in the 5 existing tests that call `/run`**

In `customize/backend/tests/test_flow_api.py`, add `"status": "active"` to the JSON body of the PATCH each of these tests already sends right before its first `POST .../run` call:
- `test_create_list_get_patch_delete_flow` — the PATCH with `cascade_nodes`/`cascade_edges`.
- `test_run_flow_persists_history_and_steps` — the PATCH with `nodes`/`edges`.
- `test_run_flow_with_unowned_agent_fails_step_not_500` — the PATCH with `nodes`/`edges` (sent via `other_auth`).
- `test_run_persisted_xyflow_shaped_graph_with_condition_branching` — the first PATCH with `xyflow_nodes`/`xyflow_edges` (the second PATCH, flipping the condition, doesn't need it again — status already set).
- `test_run_with_malformed_node_is_clean_422_not_500` — the PATCH with `bad_nodes`.
- `test_run_with_non_string_config_field_fails_step_not_500` — the PATCH with `nodes`/`edges`.

(`test_cannot_access_another_users_flow` never calls `/run` — leave it unchanged.) Re-copy the file into the sandbox: `cp backend/tests/test_flow_api.py /tmp/octop-flow-status-gate-sandbox/tests/integration/test_flow_api.py`.

- [ ] **Step 8: Run the whole file and verify everything passes**

Run: `cd /tmp/octop-flow-status-gate-sandbox && PYTHONPATH=/tmp/octop-flow-status-gate-sandbox/src .venv/bin/pytest tests/integration/test_flow_api.py -v`
Expected: all PASS, including the 6 tests just touched and the new `test_run_rejects_draft_flow`.

- [ ] **Step 9: Update the spec doc**

In `customize/docs/design-flow.md`:
- §7's `POST /api/flows/{flow_id}/run` row: append a short note that it now requires `status == "active"`, returning `409 FLOW_NOT_ACTIVE` otherwise.
- §11's patch table: add a row for `customize/docs/patches/17-errors-add-flow-not-active.patch` → `Octop/src/octop/infra/errors.py`, same shape as the existing 4 patch rows.

- [ ] **Step 10: Commit**

```bash
git add backend/routers/flow.py backend/tests/test_flow_api.py \
  docs/patches/17-errors-add-flow-not-active.patch docs/design-flow.md
git commit -m "feat(flow): reject /run on a non-active flow (FLOW_NOT_ACTIVE, 409)"
```

---

### Task 2: Frontend — Activate/Deactivate toggle + clean run-error message

**Files:**
- Modify: `customize/dashboard/pages/Flows/components/FlowCanvas.tsx`
- Modify: `customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx`
- Modify: `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx`
- Modify: `customize/dashboard/pages/Flows/components/RunResultDrawer.test.tsx`

**Interfaces:**
- Consumes: `request()` (`../../../api/request`, existing); `apiErrorMessage()` from `Octop/dashboard/src/utils/apiError.ts` (existing dashboard utility, imported the same way other pages already do, e.g. `dashboard/src/pages/Admin/Storage/StorageBackendCard.tsx`); `FlowDetail.status: string` (already present on the type at `FlowCanvas.tsx:53`, just not read into state yet).
- Produces: nothing new consumed elsewhere — this task is UI-only.

- [ ] **Step 1: Write the failing test for the toggle button**

Add to `FlowCanvas.test.tsx`:

```tsx
it("toggles flow status via an Activate/Deactivate button in the toolbar", async () => {
  api.mockResolvedValueOnce({
    flow_id: "fl_1", name: "F", status: "draft",
    nodes: [], edges: [],
  }); // initial GET
  api.mockResolvedValueOnce({}); // PATCH {status: "active"}

  render(<FlowCanvas flowId="fl_1" />);
  await screen.findByText("Draft");

  await userEvent.click(screen.getByRole("button", { name: "Activate" }));

  expect(api).toHaveBeenNthCalledWith(
    2,
    "/flows/fl_1",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ status: "active" }) }),
  );
  expect(await screen.findByRole("button", { name: "Deactivate" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

If `/tmp/octop-flow-status-gate-sandbox` doesn't exist yet (Task 1's copy may no longer be present), recreate it: `cp -r /workspaces/codespaces-blank/Octop /tmp/octop-flow-status-gate-sandbox`. Copy the test file into the sandbox: `cp dashboard/pages/Flows/components/FlowCanvas.test.tsx /tmp/octop-flow-status-gate-sandbox/dashboard/src/pages/Flows/components/FlowCanvas.test.tsx`.
Run: `cd /tmp/octop-flow-status-gate-sandbox/dashboard && npx vitest run src/pages/Flows/components/FlowCanvas.test.tsx -t "toggles flow status"`
Expected: FAIL — no "Activate" button exists yet.

- [ ] **Step 3: Implement the status state + toggle button in `FlowCanvas.tsx`**

- Add `const [flowStatus, setFlowStatus] = useState<string>("draft");` near the other `useState` calls.
- In the initial load effect (where `data.name`/`data.nodes`/`data.edges` are read), also do `setFlowStatus(data.status ?? "draft");`.
- Add a handler:
  ```ts
  const handleToggleStatus = async () => {
    const next = flowStatus === "active" ? "draft" : "active";
    try {
      await request(`/flows/${flowId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      setFlowStatus(next);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to update flow status");
    }
  };
  ```
- In the toolbar `<div>` (alongside the existing Save/Run/History buttons), add a status `<Tag>` (antd, already imported elsewhere in this dashboard — import it here) showing `flowStatus === "active" ? "Active" : "Draft"`, and a `<Button onClick={() => void handleToggleStatus()}>` whose label is `flowStatus === "active" ? "Deactivate" : "Activate"`.

- [ ] **Step 4: Run the new test and the full `FlowCanvas.test.tsx` suite**

Copy the updated component into the sandbox: `cp dashboard/pages/Flows/components/FlowCanvas.tsx /tmp/octop-flow-status-gate-sandbox/dashboard/src/pages/Flows/components/FlowCanvas.tsx`.
Run: `cd /tmp/octop-flow-status-gate-sandbox/dashboard && npx vitest run src/pages/Flows/components/FlowCanvas.test.tsx`
Expected: all PASS (the 5 pre-existing tests are unaffected — they mock `request()` wholesale and never assert the toolbar's exact button set).

- [ ] **Step 5: Write the failing test for the clean run-error message**

Add to `RunResultDrawer.test.tsx`:

```tsx
it("shows the server's error message, not the raw request() error string, when a run fails", async () => {
  api.mockRejectedValueOnce(
    new Error('Request failed: 409 Conflict - {"error":{"code":"FLOW_NOT_ACTIVE","message":"flow must be active to run — activate it first","details":{}}}'),
  );
  render(<RunResultDrawer flowId="fl_1" open onClose={() => {}} />);
  expect(await screen.findByText("flow must be active to run — activate it first")).toBeInTheDocument();
});
```
(Match whatever existing test in this file renders the error via `message.error` — if `antd`'s `message` isn't captured by `screen` in this suite already, mock `@/utils/antdMessage` the same way the rest of this file does and assert the mock was called with that exact string instead of a `screen.findByText`.)

- [ ] **Step 6: Run it to verify it fails**

Copy the test file into the sandbox: `cp dashboard/pages/Flows/components/RunResultDrawer.test.tsx /tmp/octop-flow-status-gate-sandbox/dashboard/src/pages/Flows/components/RunResultDrawer.test.tsx`.
Run: `cd /tmp/octop-flow-status-gate-sandbox/dashboard && npx vitest run src/pages/Flows/components/RunResultDrawer.test.tsx -t "shows the server's error message"`
Expected: FAIL — today's code shows the raw `err.message` (the whole string above), not the parsed message.

- [ ] **Step 7: Implement in `RunResultDrawer.tsx`**

- Import `apiErrorMessage` from `../../../utils/apiError` (adjust the relative path to match this file's existing imports, e.g. `../../../api/request`'s pattern).
- In the auto-run effect's `catch` block (currently `message.error(err instanceof Error ? err.message : "Failed to run flow")`), replace with:
  ```ts
  message.error(apiErrorMessage(err, "Failed to run flow"));
  ```

- [ ] **Step 8: Run the new test and the full `RunResultDrawer.test.tsx` suite**

Copy the updated component into the sandbox: `cp dashboard/pages/Flows/components/RunResultDrawer.tsx /tmp/octop-flow-status-gate-sandbox/dashboard/src/pages/Flows/components/RunResultDrawer.tsx`.
Run: `cd /tmp/octop-flow-status-gate-sandbox/dashboard && npx vitest run src/pages/Flows/components/RunResultDrawer.test.tsx`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add dashboard/pages/Flows/components/FlowCanvas.tsx \
  dashboard/pages/Flows/components/FlowCanvas.test.tsx \
  dashboard/pages/Flows/components/RunResultDrawer.tsx \
  dashboard/pages/Flows/components/RunResultDrawer.test.tsx
git commit -m "feat(flow): add Activate/Deactivate toggle, show clean run-error messages"
```
