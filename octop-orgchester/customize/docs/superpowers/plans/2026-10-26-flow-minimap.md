# Flow MiniMap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a MiniMap on the Flow canvas so large graphs can be navigated — roadmap item #5 of the Flow gap analysis (`ARCHITECTURE.md` §9.2).

**Architecture:** One extra child of `<ReactFlow>` in `FlowCanvas.tsx`, copying the `<MiniMap>` usage that `Agency/components/AgencyOrgChart.tsx` already ships (same props, pannable/zoomable, node colors per type). Frontend only; `@xyflow/react` already exports `MiniMap`. No backend, DB, patch or dependency change.

**Tech Stack:** React + `@xyflow/react` + vitest.

**Spec:** `ARCHITECTURE.md` §9.2 item 5; `customize/docs/design-flow.md` §9 (canvas description gets one sentence).

## Global Constraints

- **Never edit or test in the real `Octop/` checkout.** Tests run through the Docker sandbox wrapper in the main checkout: `D:/Sources/RandD/codespaces-blank/octop-orgchester/scripts/sandbox/sb.sh` (do not edit it). Work only in worktree `D:\Sources\RandD\flow-minimap-wt` (branch `flow-minimap`), authoring under `octop-orgchester/customize/`. Set `CUSTOMIZE=/d/Sources/RandD/flow-minimap-wt/octop-orgchester/customize`; run `sb.sh sync` before `sb.sh ui src/pages/Flows`. Never run two `sb.sh` invocations at once.
- Baseline: `ui src/pages/Flows` = 28 passed.
- Node colours in the minimap (exact): `trigger` `#60a5fa`, `agent` `#a78bfa`, `condition` `#fbbf24`, `end` `#9ca3af`; unknown types fall back to `#9ca3af`. Error/warning outlines from the validation feature do not change minimap colours.
- Keep LF line endings and strict UTF-8 in every file touched (check: `git show HEAD:<path> | grep -c "$(printf '\r')"` = 0; no non-ASCII bytes in new comments unless proper UTF-8).
- Git: commit with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not merge; do not touch `Octop/`, `ARCHITECTURE.md`, `scripts/sandbox/`.

## Review Focus

- The MiniMap must not break existing canvas behaviour: Save payload still has no extra keys (colours come from a function over the node `type`, not stored data). Test: Save PATCH body nodes unchanged.
- A node with an unknown/undefined `type` must not throw in the colour function. Test on the exported helper.
- In jsdom (no layout) the canvas still mounts and the minimap element renders without console errors. Test: rendered container contains the minimap (`.react-flow__minimap`) or its test id.

## File Structure

| File | Responsibility |
|---|---|
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` | import `MiniMap`; export `minimapNodeColor(node: Node): string`; render `<MiniMap>` |
| `customize/dashboard/pages/Flows/components/FlowCanvas.test.tsx` | minimap tests |
| `customize/docs/design-flow.md` | one sentence in §9 |

---

### Task 1: MiniMap on the canvas

**Files:** Modify the three files above.

**Interfaces:** Produces `export function minimapNodeColor(node: Node): string` in `FlowCanvas.tsx` (pure; uses the colours in Global Constraints).

- [ ] **Step 1: Write failing tests** in `FlowCanvas.test.tsx`: (a) `minimapNodeColor` returns the four exact colours for the four types and `#9ca3af` for `undefined` and `"http"`; (b) canvas with one node renders a `.react-flow__minimap` element; (c) clicking Save after rendering sends nodes with no `style`/colour keys beyond what was loaded (compare PATCH body nodes to the loaded nodes).
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh ui src/pages/Flows/components/FlowCanvas.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** — import `MiniMap` from `@xyflow/react`; add `minimapNodeColor`; render `<MiniMap pannable zoomable nodeColor={minimapNodeColor} />` after `<Controls />`, matching how `AgencyOrgChart.tsx` places and styles its MiniMap (copy its position/size/mask props). Add one sentence to design-flow §9 stating the canvas has a pannable/zoomable minimap.
- [ ] **Step 4: Run to verify pass, whole Flows suite** — `sb.sh sync`; `sb.sh ui src/pages/Flows`. Expected: all pass, baseline 28 not regressed.
- [ ] **Step 5: Commit** — `git add octop-orgchester/customize`; `git commit -m "feat(flow): add minimap to the canvas"`.
