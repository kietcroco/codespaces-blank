# Flow Starter Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user start a new flow from a ready-made template (ask an agent, branch on a reply, two-step pipeline) instead of an empty canvas — roadmap item #8 of the Flow gap analysis (`ARCHITECTURE.md` §9.2).

**Architecture:** A pure data module `flowTemplates.ts` defines the templates and a builder that returns xyflow-shaped `nodes`/`edges`. The flows list page keeps its existing "New Flow" button (blank flow, unchanged) and gains a "From template" button that opens a modal listing the templates; choosing one does `POST /flows` (name + markdown description from the template) then `PATCH /flows/{id}` with the template's `nodes`/`edges`, then navigates to the canvas. Frontend only: no backend, DB, patch or dependency change. Templates leave every agent node's agent unselected, so the user must pick agents before activating (Phase #3 validation says so).

**Tech Stack:** React + antd + vitest.

**Spec:** `ARCHITECTURE.md` §9.2 item 8; `customize/docs/design-flow.md` §9 (one sentence added).

## Global Constraints

- **Never edit or test in the real `Octop/` checkout.** Tests run through the Docker sandbox wrapper in the main checkout `D:/Sources/RandD/codespaces-blank/octop-orgchester/scripts/sandbox/sb.sh` (do not edit it; its globs already copy `pages/Flows/*.ts*` — verify that a new `.ts` file in `pages/Flows/` is copied, else report instead of editing). Work only in worktree `D:\Sources\RandD\flow-templates-wt` (branch `flow-templates`), authoring under `octop-orgchester/customize/`. `CUSTOMIZE=/d/Sources/RandD/flow-templates-wt/octop-orgchester/customize`; `sb.sh sync` before `sb.sh ui src/pages/Flows`; never two `sb.sh` runs at once.
- Baseline: `ui src/pages/Flows` = 46 passed.
- Module `customize/dashboard/pages/Flows/flowTemplates.ts` exports (exact):
  - `interface FlowTemplate { id: string; name: string; summary: string; description: string; build: () => { nodes: Node[]; edges: Edge[] } }` (`Node`/`Edge` from `@xyflow/react`).
  - `export const FLOW_TEMPLATES: FlowTemplate[]` with exactly these three, in this order, ids and names exact:
    1. `ask-agent` / "Ask an agent": trigger → agent → end. Agent prompt `{{question}}`, `outputVar` `answer`.
    2. `branch-on-reply` / "Branch on a reply": trigger → agent (prompt `Answer only yes or no: {{question}}`, `outputVar` `verdict`) → condition (`left` `{{verdict|trim|lower}}`, `op` `contains`, `right` `yes`) → `true` handle to agent "Yes handler" (prompt `The answer was yes. Continue with: {{question}}`, `outputVar` `yes_result`), `false` handle to agent "No handler" (prompt `The answer was no. Explain why for: {{question}}`, `outputVar` `no_result`); both handlers → one end node.
    3. `two-step-pipeline` / "Two-step pipeline": trigger → agent "Summarize" (prompt `Summarize in 3 bullets: {{text}}`, `outputVar` `summary`) → agent "Rewrite" (prompt `Rewrite for a customer email: {{summary|truncate:500}}`, `outputVar` `email`) → end.
  - Each template's `description` is markdown (<= 600 chars) with `## Purpose`, `## Trigger` (names the input variable(s) to pass, e.g. `question`), `## Steps`, and `## Failure handling` sections; `summary` is one plain sentence <= 100 chars.
- Node shape (exact, matches what `FlowCanvas` saves): `{ id, type, position: {x, y}, data: { label, config } }`. Node ids are `<type>_<n>` unique within the template (`trigger_1`, `agent_1`, …). Agent `config` uses the canvas's camelCase keys `{ agentId: undefined/absent, prompt, outputVar }` — **`agentId` is omitted**, never an empty string. Condition `config`: `{ left, op, right }`. Edge shape: `{ id: "e_<source>_<target>[_<handle>]", source, target, sourceHandle?: "true"|"false" }` (only condition edges carry `sourceHandle`). Positions: x column 80 (branch handlers at x 0 and x 260), y step 120.
- `build()` returns fresh objects on every call (mutating one result must not affect the next).
- Creation sequence in the page: `POST /flows` body exactly `{"name": <template name>, "description": <template description>}` then `PATCH /flows/{id}` body exactly `{"nodes": [...], "edges": [...]}`, then `navigate("/flows/" + id)`. If the PATCH fails: show `message.error(apiErrorMessage(err, "Created the flow but could not add the template nodes"))` and still navigate to the (blank) flow. If the POST fails: error message, no navigation, no PATCH. The existing "New Flow" button behaviour (single `POST /flows` with `{"name": "Untitled flow"}`) is unchanged.
- Keep LF endings and strict UTF-8 in every file (no `\r`; ASCII-only in new comments; the templates' text is ASCII); do not commit `__pycache__`/`.pyc`.
- Git: commit with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not merge; do not touch `Octop/`, `ARCHITECTURE.md`, `scripts/sandbox/`.

## Review Focus

- Every template is a valid graph by the Phase #3 rules except for the unselected agents: exactly one trigger, unique node ids, every edge endpoint exists, condition edges carry `true`/`false`, no cycles, no unreachable node, agent prompts non-blank, and the only static errors a validator would report are `agent_missing_agent` (one per agent node). Task 1 `flowTemplates.test.ts` checks these rules with a small in-test validator.
- Template templates use only filters that exist (`trim`, `lower`, `truncate`) with valid args. Test.
- The blank "New Flow" path still sends exactly one request. Task 1 test.
- A failed PATCH after a successful POST still lands the user on the flow (no orphan hidden flow). Task 1 test.
- Opening the modal twice, closing it, or double-clicking "Use" creates one flow only (button shows loading / modal disabled during creation). Task 1 test.

## File Structure

| File | Responsibility |
|---|---|
| `customize/dashboard/pages/Flows/flowTemplates.ts` | New: template data + `build()` |
| `customize/dashboard/pages/Flows/flowTemplates.test.ts` | New: structural tests |
| `customize/dashboard/pages/Flows/index.tsx` | "From template" button, modal, creation sequence |
| `customize/dashboard/pages/Flows/index.test.tsx` | page tests |
| `customize/docs/design-flow.md` | one sentence in §9 |

---

### Task 1: Templates module and "From template" on the flows list

**Files:** Create `flowTemplates.ts`, `flowTemplates.test.ts`; modify `pages/Flows/index.tsx`, `index.test.tsx`, `customize/docs/design-flow.md` (§9).

**Interfaces:** Produces `FlowTemplate`, `FLOW_TEMPLATES` (Global Constraints). Consumes `POST /flows`, `PATCH /flows/{id}` (existing; PATCH accepts `nodes`/`edges`).

- [ ] **Step 1: Write failing tests.**
  - `flowTemplates.test.ts`: ids/names/order exact; per-template structure rules from Review Focus (write a ~30-line in-test validator: one trigger, unique ids, edge endpoints exist, condition outgoing handles `true`/`false`, no cycle via DFS, all nodes reachable from the trigger, prompts non-blank; expect exactly one "agent has no agentId" per agent node and nothing else); the exact prompts/config values listed in Global Constraints (spot-check each template's agent prompts, outputVars, the condition triple and the handle routing); `agentId` key absent from every agent config; `description` has the four `##` sections and length <= 600; `summary` <= 100; `build()` twice yields deep-equal but distinct objects; filter names used in prompts/conditions are only `trim`, `lower`, `truncate`.
  - `index.test.tsx` (mock `request`/`useNavigate` as the existing tests do): "New Flow" still makes exactly one `POST /flows` with body `{"name":"Untitled flow"}` and navigates; "From template" opens a modal listing the three template names and summaries; clicking "Use" on one makes `POST /flows` with `{name, description}` then `PATCH /flows/<id>` with `{nodes, edges}` (exact key set) then navigates to `/flows/<id>`; PATCH failure shows the error and still navigates; POST failure shows the error, no PATCH, no navigation; a second click on "Use" while creating makes no second POST.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: new tests FAIL (module missing / button missing).
- [ ] **Step 3: Implement** `flowTemplates.ts` per Global Constraints and the page changes (antd `Modal`, one `List`/`Card` row per template with a "Use" button, loading state per creation; use `apiErrorMessage` from `../../utils/apiError`). Add one sentence to design-flow §9 describing starter templates.
- [ ] **Step 4: Run to verify pass, whole Flows suite** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: all pass, baseline 46 not regressed.
- [ ] **Step 5: Commit** — `git add octop-orgchester/customize`; `git commit -m "feat(flow): starter templates for new flows"`.
