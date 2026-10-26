## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

## Kiểm tra tài liệu và plan (octop-orgchester)

Khi người dùng nói "kiểm tra tài liệu và plan" (hoặc tương tự) trong repo này, **chỉ xem trong `octop-orgchester/`**, không tìm `.worktree/` hay `octop/workspaces/` (đó là hệ thống PM/BA khác, không liên quan).

Đọc theo thứ tự:
1. `octop-orgchester/ARCHITECTURE.md` — §7 trạng thái hiện tại, §9.1/9.1b lịch sử các phase Flow, **§9.2 roadmap còn lại** (nguồn chính để biết việc kế tiếp).
2. `octop-orgchester/customize/docs/design.md` (Agency) và `design-flow.md` (Flow) — spec thiết kế.
3. `octop-orgchester/customize/docs/superpowers/plans/*.md` — plan từng phase (agency-feature, flow-feature, flow-status-gate…).
4. `octop-orgchester/customize/docs/patches/*.patch` — patch áp vào `Octop/`.
5. `octop-orgchester/customize/README.md` — cách cài/nâng cấp.

Lưu ý khi đánh giá tiến độ:
- Checkbox `- [ ]` trong file plan **không được tick lại** sau khi làm xong. Đừng coi là chưa làm; đối chiếu với `ARCHITECTURE.md` §9 và code thật trong `customize/backend`, `customize/dashboard`.
- Mọi thứ tác giả viết nằm trong `customize/`; không sửa trực tiếp `Octop/` hay `orchester/` (chỉ cài khi người dùng yêu cầu rõ).
- Plan cũ dùng sandbox Linux (`/tmp/octop-<phase>-sandbox`) — không chạy được trên Windows. Trên máy Windows dùng sandbox Docker `octop-orgchester/scripts/sandbox/` (xem memory `octop-test-sandbox`); người dùng đã chọn Docker làm nơi test.
- Luôn trả lời tiếng Việt và luôn báo "Phase X/N, Task Y/M" (xem memory `feedback-vietnamese-and-progress-report`).
- Phase mới: viết plan riêng (`superpowers:writing-plans`), thực thi qua `superpowers:subagent-driven-development`; không viết lại `engine.py`/`flow.py`.

### Ghi nhớ đi kèm repo (dùng được trên máy khác)

@.claude/memory/octop-orgchester-plan-location.md
@.claude/memory/octop-orgchester-flow-status.md
@.claude/memory/feedback-vietnamese-and-progress-report.md
@.claude/memory/octop-test-sandbox.md

Bản gốc nằm ở `.claude/memory/`. Khi cập nhật tiến độ Flow, sửa file ở đó (không chỉ memory cục bộ của máy) rồi commit để máy khác nhận được.
