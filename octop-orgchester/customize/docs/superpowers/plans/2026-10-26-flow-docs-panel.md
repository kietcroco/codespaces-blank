# Flow Docs Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each flow a documentation panel (markdown: purpose, trigger, steps, failure handling) editable from the canvas, with a preview — roadmap item #6 of the Flow gap analysis (`ARCHITECTURE.md` §9.2), modelled on orchester's `FlowDocsPanel.tsx` (edit / preview toggle, "use template" button when empty).

**Architecture:** The doc text is stored in the flow's existing `description` column (`flows.description`, already read and written by `GET`/`PATCH /flows/{id}`), so there is no migration or new endpoint. The backend only gains a length cap. The dashboard gets a new `FlowDocsDrawer` (antd `Drawer`) opened from a "Docs" toolbar button; preview uses Octop's existing `LazyMarkdown` component (never renders raw HTML). The flows list card shows a one-line plain-text summary instead of raw markdown.

**Tech Stack:** Python 3.12 / FastAPI / pytest (backend); React + antd + vitest (dashboard).

**Spec:** `ARCHITECTURE.md` §9.2 item 6; `customize/docs/design-flow.md` §7/§9 (Task 1 and Task 2 add a sentence each).

## Global Constraints

- **Never edit or test in the real `Octop/` checkout.** Tests run through the Docker sandbox wrapper in the main checkout `D:/Sources/RandD/codespaces-blank/octop-orgchester/scripts/sandbox/sb.sh` (do not edit it). Work only in worktree `D:\Sources\RandD\flow-docs-panel-wt` (branch `flow-docs-panel`), authoring under `octop-orgchester/customize/`. `CUSTOMIZE=/d/Sources/RandD/flow-docs-panel-wt/octop-orgchester/customize`; `sb.sh sync` before each `py`/`ui`; never two `sb.sh` runs at once.
- Baselines: backend `tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py` = 64 passed; `ui src/pages/Flows` = 31 passed.
- `DESCRIPTION_MAX_LENGTH = 20000` characters. Backend: `description` longer than that on `POST /flows` or `PATCH /flows/{id}` ⇒ HTTP 422 (pydantic validation, no new ErrorCode). `null` still clears the description; empty string is allowed and stored as-is.
- Docs template text (exact, used by "Use template"): `"## Purpose\n\n## Trigger\n\n## Steps\n\n## Failure handling\n"`.
- Saving the docs sends `PATCH /flows/{id}` with body exactly `{"description": <string>}`; an all-whitespace text is sent as `{"description": null}`. It never includes `nodes`, `edges` or `status`.
- `descriptionSummary(text: string | null | undefined, max = 140): string` (exported from `pages/Flows/index.tsx`): strips leading markdown markers (`#`, `-`, `*`, `>` and numbering like `1.`) from each non-empty line, joins lines with a single space, collapses whitespace, truncates to `max` characters adding `…` when cut; `null`/`undefined`/blank ⇒ `""`.
- Keep LF endings and strict UTF-8 in every file (check: no `\r`; decode with utf-8). New comments ASCII only.
- Git: commit per task with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not merge; do not touch `Octop/`, `ARCHITECTURE.md`, `scripts/sandbox/`.

## Review Focus

- A 20000-char description saves; 20001 returns 422 on both create and patch, and the stored value is unchanged after the rejected patch. Task 1 tests.
- Clearing the docs (`null`) really clears; `PATCH {"description": "x"}` does not touch nodes/edges/status (existing flow stays active, graph intact). Task 1 `test_patch_description_only_leaves_graph_and_status`.
- Markdown with raw HTML / script tags in the doc text never renders as HTML in the preview (uses `LazyMarkdown`, not `dangerouslySetInnerHTML`). Task 2 test asserts no `<script>` / injected element appears in the DOM.
- Closing the drawer with unsaved edits discards them (re-opening shows the saved text), and a failed save keeps the draft and shows an error without closing. Task 2 tests.
- A flow whose `description` is null or very long renders on the list page without breaking the card (summary only). Task 2 `descriptionSummary` tests.

## File Structure

| File | Responsibility |
|---|---|
| `customize/backend/routers/flow.py` | `DESCRIPTION_MAX_LENGTH`, `Field(max_length=...)` on both bodies |
| `customize/backend/tests/test_flow_api.py` | length-cap and description-only-patch tests |
| `customize/dashboard/pages/Flows/components/FlowDocsDrawer.tsx` | New: edit / preview drawer |
| `customize/dashboard/pages/Flows/components/FlowDocsDrawer.test.tsx` | New |
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` | load `description`, "Docs" button, save handler |
| `customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx` | Docs button tests |
| `customize/dashboard/pages/Flows/index.tsx`, `index.test.tsx` | `descriptionSummary` + card text |
| `customize/docs/design-flow.md` | one sentence each in §7 and §9 |

---

### Task 1: Backend — cap the description length

**Files:** Modify `customize/backend/routers/flow.py` (`FlowCreateBody`, `FlowPatchBody`), `customize/backend/tests/test_flow_api.py`, `customize/docs/design-flow.md` (§7).

**Interfaces:** Produces `DESCRIPTION_MAX_LENGTH = 20000` (module constant in `flow.py`) and the 422 behaviour in Global Constraints.

- [ ] **Step 1: Write failing tests** in `test_flow_api.py` (reuse `env`, `_new_flow` and helpers): `test_description_at_limit_is_saved` (20000 chars via PATCH, GET returns it); `test_description_over_limit_rejected_on_patch_and_create` (20001 ⇒ 422 on both; the PATCH case leaves the stored description unchanged); `test_description_null_clears`; `test_patch_description_only_leaves_graph_and_status` (active flow with valid graph, PATCH only description ⇒ status still `active`, nodes/edges unchanged).
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh py tests/integration/test_flow_api.py -q -k description`. Expected: the over-limit test FAILS (200/201 returned).
- [ ] **Step 3: Implement** `DESCRIPTION_MAX_LENGTH` and `description: str | None = Field(default=None, max_length=DESCRIPTION_MAX_LENGTH)` on both bodies (import `Field` from pydantic). Add one sentence to design-flow §7 stating `description` holds the flow's markdown documentation, max 20000 characters.
- [ ] **Step 4: Run full backend** — `sb.sh sync`; `sb.sh py tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py -q`. Expected: all pass (64 + new).
- [ ] **Step 5: Commit** — `git add octop-orgchester/customize`; `git commit -m "feat(flow): cap flow description length"`.

---

### Task 2: Dashboard — Docs drawer, toolbar button, list summary

**Files:** Create `FlowDocsDrawer.tsx`, `FlowDocsDrawer.test.tsx`; modify `FlowCanvas.tsx`, `FlowCanvas.test.tsx`, `pages/Flows/index.tsx`, `pages/Flows/index.test.tsx`, `customize/docs/design-flow.md` (§9).

**Interfaces:**
- Produces: `FlowDocsDrawer` default export with props `{ open: boolean; description: string; onClose: () => void; onSave: (next: string) => Promise<void> }`; `export const DOCS_TEMPLATE: string` (the exact template in Global Constraints); `descriptionSummary` in `pages/Flows/index.tsx` (signature in Global Constraints).
- Consumes: `PATCH /flows/{id}` contract from Global Constraints; `LazyMarkdown` from `@/components/Markdown/LazyMarkdown` with prop `content: string`.

- [ ] **Step 1: Write failing tests.**
  - `FlowDocsDrawer.test.tsx` (mock `LazyMarkdown` the way other Octop tests mock heavy components, or render it for real if vitest handles it): shows the saved text in a textarea; "Use template" button only when the text is blank and it fills `DOCS_TEMPLATE`; Preview tab renders the text through `LazyMarkdown` and with text `<script>alert(1)</script><b>x</b>` no `script` element exists in the DOM; Save button disabled until the draft differs, calls `onSave(draft)` once; when `onSave` rejects the drawer stays open, keeps the draft and an error is shown; closing then re-opening shows the saved `description`, not the discarded draft; textarea has `maxLength` 20000.
  - `FlowCanvas.test.tsx`: GET returns `description: "# Hi"`; clicking "Docs" opens the drawer with that text; saving sends exactly one PATCH with body `{"description": "..."}` (no nodes/edges/status), whitespace-only sends `{"description": null}`; the Save-nodes PATCH body is unchanged by this feature.
  - `pages/Flows/index.test.tsx`: `descriptionSummary` cases from Global Constraints (null, blank, headings and bullets stripped, numbering stripped, long text truncated with `…`, multi-line joined); a card with a long markdown description renders only the summary.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `FlowDocsDrawer` (antd `Drawer`, `destroyOnClose`, width 480, title "Flow docs"): antd `Segmented` Edit / Preview, `Input.TextArea` (monospace, `maxLength={20000}`, `autoSize` min 16 rows), "Use template", Save and Cancel buttons; local draft state reset from `description` whenever `open` becomes true; save errors surfaced with `message.error(apiErrorMessage(err, "Failed to save docs"))` (same helper `RunResultDrawer` uses). `FlowCanvas`: add `description?: string | null` to `FlowDetail`; state initialised from GET; "Docs" toolbar button (icon `BookText` from lucide-react); `handleDocsSave` does the PATCH and on success updates local `description` and closes the drawer. `pages/Flows/index.tsx`: export `descriptionSummary`, render `<p>{descriptionSummary(flow.description)}</p>` only when non-empty. Add one sentence to design-flow §9 describing the docs drawer.
- [ ] **Step 4: Run to verify pass, whole Flows suite** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: all pass, baseline 31 not regressed.
- [ ] **Step 5: Commit** — `git add octop-orgchester/customize`; `git commit -m "feat(flow): add docs drawer to the canvas"`.
