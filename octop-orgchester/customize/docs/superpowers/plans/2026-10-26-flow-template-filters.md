# Flow Template Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let flow templates use dotted paths and filters — `{{path|filter:arg|filter2}}` — in agent prompts and condition operands, with clean errors instead of crashes — roadmap item #7 of the Flow gap analysis (`ARCHITECTURE.md` §9.2).

**Architecture:** A new pure module `flows/template.py` owns the template grammar, path resolution and the filter set (`render` + a static `check`). The engine's `_render` is replaced by it; a bad template fails that node's step (never crashes the run). `validate.py` (Phase #3) gains a `bad_template` error using `check`, so activation and `/run` reject bad filters up front. Backend only: no DB change, no new patch, no dependency, no dashboard change.

**Tech Stack:** Python 3.12 / pytest.

**Spec:** `customize/docs/design-flow.md` §8 (template paragraph is added/updated in Task 2) and `ARCHITECTURE.md` §9.2 item 7.

## Global Constraints

- **Never edit or test in the real `Octop/` checkout.** Tests run through the Docker sandbox wrapper in the main checkout `D:/Sources/RandD/codespaces-blank/octop-orgchester/scripts/sandbox/sb.sh`. Work only in worktree `D:\Sources\RandD\flow-template-filters-wt` (branch `flow-template-filters`), authoring under `octop-orgchester/customize/`. `CUSTOMIZE=/d/Sources/RandD/flow-template-filters-wt/octop-orgchester/customize`; `sb.sh sync` before each `py`; never two `sb.sh` runs at once. **Task 1 must edit `scripts/sandbox/sb.sh` in place in the main checkout** (untracked file, never committed) to copy `template.py` to `src/octop/infra/flows/` and `test_flow_template.py` to `tests/unit/test_flow_template.py`; and add the same two copies to `customize/install.sh` (committed).
- Baseline: backend `tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py` = 68 passed.
- **Grammar (exact).** A template token matches `\{\{\s*(\w+(?:\.\w+)*)\s*((?:\|[^{}|]*)*)\}\}`. Group 1 is the path; group 2 is zero or more `|`-separated filters. Text that does not match (e.g. `{{"a":1}}`, `{{ a b }}`, `{{}}`) is left literally, exactly as before. Whitespace around path and around filters is ignored (`{{ name | upper }}` works). A filter is `name` or `name:arg`; `arg` is the text after the first `:` with surrounding whitespace removed, and one pair of matching surrounding `'…'` or `"…"` quotes removed. An arg cannot contain `|`, `{` or `}`.
- **Path resolution:** split on `.`; walk `variables`: dict → key lookup, list/tuple → index when the segment is all digits and in range; anything else (missing key, bad index, walking into a str/int/None) → missing. Missing renders as `""` (same as the old `variables.get(key, "")`). Non-string values render with `str()` (unchanged behaviour for plain `{{key}}`).
- **Filters (exact names and semantics)**, applied left to right to the resolved value (missing = `None`):
  - `upper`, `lower`, `trim` — no arg allowed; operate on `str(value)` (`None` → `""`).
  - `default:<text>` — arg required; returns `<text>` when the value is `None` or `""`, else the value unchanged.
  - `truncate:<n>` — arg required, must be an integer `0 <= n <= 100000`; if `len(str(value)) > n` return the first `n` characters followed by `...`, else `str(value)`.
  - `length` — no arg; returns `str(len(x))` where `x` is the value if it is a `str`/`list`/`tuple`/`dict`, `str(value)` otherwise (`None` → `0`).
  - `json` — no arg; `json.dumps(value, ensure_ascii=False, default=str)` (`None` → `null`).
  - Any other filter name, a missing required arg, an arg on a no-arg filter, or a bad `truncate` arg ⇒ `TemplateError`.
- **Error text (exact):** `unknown filter 'xyz' in {{...}}`; `filter 'default' needs an argument in {{...}}`; `filter 'upper' takes no argument in {{...}}`; `filter 'truncate' needs an integer between 0 and 100000, got 'abc' in {{...}}` — where `{{...}}` is the token text as written (stripped of nothing).
- **Engine behaviour:** a `TemplateError` while rendering an agent prompt fails that step with error `template error: <message>` (agent_id set, `call_agent` never invoked, no retry); while rendering a condition `left`/`right` it fails the condition step the same way. It never raises out of `run_flow`.
- **Validation (Phase #3):** new error code `bad_template` — one issue per node per bad token field, message `Node '<id>' has a bad template in <field>: <TemplateError message>`, `node_id` = the node; fields checked: agent `prompt`, condition `left` and `right`. Blank fields are skipped (other rules cover them). It counts as an error-level issue, so activation and `/run` reject it with the existing 422 gate.
- Keep LF endings and strict UTF-8 in every file (no `\r`, decode as UTF-8; ASCII-only in new comments).
- Git: commit per task with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; do not merge; do not touch `Octop/` or `ARCHITECTURE.md`.

## Review Focus

- Existing flows: plain `{{key}}` renders exactly as before for strings, numbers and missing keys; text like `{{"a":1}}`, `{{}}`, `{{ a b }}`, a lone `{{` stay literal; no existing test changes meaning. Task 1 `test_plain_keys_and_non_tokens_render_as_before`.
- No crash paths: unknown filter, bad `truncate` arg, filter on a missing value, dotted path through a string, list index out of range, a 1 MB template, a 5000-filter chain — all return a string or `TemplateError`, never any other exception. Task 1 tests.
- `default:` args containing a colon (`default:a:b` → `a:b`) and quoted args with spaces (`default:"  hi "` keeps the inner spaces) work. Task 1.
- An unknown filter in a prompt: the activation PATCH and `/run` return the validation 422 (never 500), a dry-run of a draft is also rejected with the same 422, and the engine alone (no validation) fails the step cleanly. Task 2 tests.
- Condition operands can use filters: `{{a|length}}` with `gt` compares numerically. Task 2.
- A dry-run shows the rendered, filtered prompt in the stub reply (`{{name|upper}}` → upper-cased name). Task 2.

## File Structure

| File | Responsibility |
|---|---|
| `customize/backend/flows/template.py` | New: `TemplateError`, `FILTER_NAMES`, `render`, `check` |
| `customize/backend/tests/test_flow_template.py` | New: unit tests |
| `customize/install.sh`, `scripts/sandbox/sb.sh` | copy the two new files |
| `customize/backend/flows/engine.py` | use `template.render`; fail steps on `TemplateError` |
| `customize/backend/flows/validate.py` | `bad_template` rule |
| `customize/backend/tests/test_flow_engine.py`, `test_flow_validate.py`, `test_flow_api.py` | engine/validate/API tests |
| `customize/docs/design-flow.md`, `customize/README.md` | §8 template paragraph; upgrade note |

---

### Task 1: Pure template module

**Files:** Create `customize/backend/flows/template.py`, `customize/backend/tests/test_flow_template.py`; modify `customize/install.sh`, `scripts/sandbox/sb.sh` (main checkout, in place, uncommitted).

**Interfaces — Produces (Task 2 relies on these exact names):**
- `class TemplateError(ValueError)`
- `FILTER_NAMES: tuple[str, ...] = ("upper","lower","trim","default","truncate","length","json")`
- `def render(template: str, variables: dict[str, Any]) -> str` — raises `TemplateError`
- `def check(template: str) -> list[str]` — static check without variables; returns one message per bad token, in order (exact messages above); `[]` when fine.

- [ ] **Step 1: Write failing tests** in `test_flow_template.py`: `test_plain_keys_and_non_tokens_render_as_before` (string, int, missing → `""`; literals `{{"a":1}}`, `{{}}`, `{{ a b }}`, `{{`, `{{a`); `test_whitespace_in_tokens` (`{{ name | upper }}`); `test_dotted_paths_and_list_index` (`{{user.name}}`, `{{items.0}}`, out-of-range, through a str, through None → `""`); one test per filter with the semantics above (including `default` for `None` and `""` but not for `0`/`"x"`, `truncate` boundary n == len and n == len-1, `length` of str/list/dict/None, `json` of dict with non-ASCII and of a non-serialisable object via `default=str`); `test_filter_chain_left_to_right` (`{{name|trim|upper|truncate:3}}`); `test_default_arg_with_colon_and_quoted_spaces`; `test_errors_have_exact_messages` (all four message forms); `test_check_matches_render_errors` (for each bad template `check` returns `[msg]` and `render` raises `TemplateError` with the same `msg`; for good templates `check == []`); `test_no_crash_on_huge_inputs` (1 MB template, 5000-filter chain, 100k-char value — each under 2 seconds).
- [ ] **Step 2: Run to verify failure** — edit `sb.sh` and `install.sh` first, then `sb.sh sync`; `sb.sh py tests/unit/test_flow_template.py -q`. Expected: collection error (module missing).
- [ ] **Step 3: Implement** `template.py` per Global Constraints (single compiled regex for tokens; `check` and `render` share one filter-parsing helper so their errors cannot diverge; filters implemented as a small dispatch dict).
- [ ] **Step 4: Run to verify pass** — `sb.sh sync`; `sb.sh py tests/unit/test_flow_template.py tests/unit/test_flow_engine.py -q`. Expected: all pass (engine still on its old `_render`).
- [ ] **Step 5: Commit** — `git add octop-orgchester/customize`; `git commit -m "feat(flow): add template module with paths and filters"` (do not add `scripts/sandbox/`).

---

### Task 2: Wire into engine and validation; docs

**Files:** Modify `customize/backend/flows/engine.py` (remove `_TEMPLATE_RE`/`_render`, import `render`/`TemplateError`; prompt render ~L208, condition render ~L280-281), `customize/backend/flows/validate.py`, `customize/backend/tests/test_flow_engine.py`, `test_flow_validate.py`, `test_flow_api.py`, `customize/docs/design-flow.md`, `customize/README.md`.

**Interfaces — Consumes:** `render`, `check`, `TemplateError` from Task 1 (`from octop.infra.flows.template import ...`, same import style `flow.py` uses for the engine). **Produces:** error code `bad_template`; engine step error text `template error: <message>`.

- [ ] **Step 1: Write failing tests.**
  - `test_flow_engine.py`: agent prompt `"hi {{name|upper}}"` with `input={"name":"bo"}` ⇒ `call_agent` receives `"hi BO"`; unknown filter in the prompt ⇒ failed step, error `template error: unknown filter 'xyz' in {{name|xyz}}`, `call_agent` never called, `max_retries=3` does not retry or sleep; condition `left="{{a|length}}"`, `op="gt"`, `right="2"` branches correctly (numeric compare on the string `"5"`); bad filter in condition `right` ⇒ failed condition step, run returns (no exception); all existing engine tests unchanged and passing.
  - `test_flow_validate.py`: agent with `prompt="{{x|nope}}"` ⇒ `bad_template` for that node with the message form above; condition `left="{{a|truncate:abc}}"` ⇒ `bad_template`; blank field ⇒ no `bad_template`; a node with two bad fields ⇒ two issues; valid filtered templates ⇒ no issue; `bad_template` makes `has_errors` true.
  - `test_flow_api.py` (reuse `env`, `_new_flow`, `_valid_nodes`, fake agent helpers): `test_activate_rejects_unknown_filter` ⇒ 422 with detail starting `flow has 1 validation error(s)`; `test_run_with_filter_renders_prompt_to_agent` (fake agent records the prompt it gets: `{{name|upper}}` ⇒ upper-cased); `test_dry_run_shows_filtered_prompt` (stub reply contains the upper-cased text); `test_dry_run_of_bad_template_is_rejected_422`.
- [ ] **Step 2: Run to verify failure** — `sb.sh sync`; `sb.sh py tests/unit/test_flow_engine.py tests/unit/test_flow_validate.py tests/integration/test_flow_api.py -q -k "filter or template"`. Expected: new tests FAIL.
- [ ] **Step 3: Implement** the engine wiring (a `TemplateError` becomes a failed step with `template error: <msg>`; agent step records `agent_id`; condition failure follows the existing condition-failure path) and the `bad_template` rule in `validate.py` (one issue per bad token, in field order prompt → left → right; message form in Global Constraints). Update `design-flow.md` §8: replace the single-sentence description of `{{key}}` substitution with the grammar, path rules, the seven filters, the error behaviour, and the validation rule; add a `bad_template` line to the §8 Validate paragraph. Add a README upgrade note: copy `template.py`, `test_flow_template.py` and the updated `engine.py`, `validate.py`, tests; no patch, no migration.
- [ ] **Step 4: Run full backend** — `sb.sh sync`; `sb.sh py tests/unit/test_flow_template.py tests/unit/test_flow_validate.py tests/unit/test_flow_engine.py tests/integration/test_flow_api.py tests/integration/test_agency_api.py -q`. Expected: all pass (baseline 68 not regressed).
- [ ] **Step 5: Commit** — `git add octop-orgchester/customize`; `git commit -m "feat(flow): template filters in engine and validation"`.
