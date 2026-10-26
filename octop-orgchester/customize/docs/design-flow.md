# Thiết kế: tính năng Flow cho Octop (tham khảo orchester)

> **Trạng thái (2026-10-25): V1 đã triển khai xong và merge vào `main`
> (commit `47275a8`)**, qua plan
> `docs/superpowers/plans/2026-10-25-flow-feature.md` và skill
> `superpowers:subagent-driven-development`. **Roadmap item #1 (gate
> `flows.status` trên `/run`) cũng đã xong và merge** (commit `1d5a86b`,
> plan `docs/superpowers/plans/2026-10-25-flow-status-gate.md`). Cả 2
> **đã cài vào `Octop/` thật, rebuild container, và xác nhận qua
> browser thật** (commit `67a88deb` + `9874f0f8` trong lịch sử git của
> `Octop/`). Chi tiết đầy đủ, bài học từ final review, và roadmap còn
> lại so với Flow đầy đủ bên orchester: xem `ARCHITECTURE.md` §7,
> §9.1, §9.1b, §9.2.

## 1. Mục đích & lý do

Orchester có "Flow": người dùng kéo-thả-nối node trên canvas để dựng 1
quy trình nhiều bước (agent gọi agent, rẽ nhánh theo điều kiện, gọi API
ngoài, v.v.), lưu lại, rồi chạy — có lịch sử chạy riêng (run history).
Đây là tính năng **điều phối tĩnh, do người dùng định nghĩa trước**
("đồ thị cố định"), khác hẳn 2 cơ chế điều phối Octop đã có:

- **Team** (`src/octop/infra/agents/teams/team_manager.py`): 1 host-agent
  tự *suy luận bằng LLM* sẽ gọi member nào, lúc nào — **không có đồ thị
  cố định**, không lưu lịch sử dispatch (in-memory, mất khi restart).
- **CronJobs** (`src/octop/infra/cron/`): lập lịch chạy **1 agent duy
  nhất**, không phải nhiều bước.

→ Octop **chưa có** khái niệm "đồ thị nhiều bước, người dùng tự vẽ,
chạy lại được, có lịch sử" — đây là khoảng trống thật sự, không phải
làm lại thứ đã có.

## 2. Goals (V1)

- 1 trang "Flows" mới (ngang hàng Agency/Experts trong menu): danh sách
  flow của user, tạo/sửa/xoá.
- 1 canvas kéo-thả-**nối** (khác hẳn AgencyOrgChart — ở đây
  `nodesConnectable={true}`, người dùng tự vẽ cạnh mới) để dựng flow:
  4 loại node (xem mục 6) đủ để biểu diễn "gọi agent A → nếu kết quả
  thoả điều kiện thì gọi agent B, không thì kết thúc".
- Panel cấu hình node đã chọn (chọn agent nào, viết prompt, viết điều
  kiện rẽ nhánh).
- Nút "Run": chạy đồng bộ trong 1 request, trả kết quả + từng bước đã
  chạy; lưu lại thành lịch sử (`flow_runs`/`flow_run_steps`), xem lại
  được sau.

## 3. Non-goals (V1) — cố tình bỏ, ghi rõ để không bị hiểu nhầm là quên

So với orchester (~16.500 dòng, xem báo cáo research), V1 này **chỉ**
lấy phần lõi tối thiểu có giá trị ngay, bỏ hẳn phần hạ tầng nặng:

- **Chỉ 4 loại node**: `trigger` (điểm bắt đầu), `agent` (gọi 1 agent
  thật), `condition` (rẽ nhánh true/false theo so sánh đơn giản),
  `end` (điểm kết thúc). Orchester có 28 loại (http, code, loop,
  parallel, kb_search, generate_image, …) — **không port**, để lượt
  sau nếu cần loại nào cụ thể.
- **Không hàng đợi/worker riêng** (orchester dùng pg-boss + worker
  process tách biệt). Octop chưa có hạ tầng queue nào — V1 chạy
  **đồng bộ trong chính request** `POST .../run` (giống cách orchester
  tự cũng có lựa chọn `run-stream` chạy đồng bộ, và giống cách Team
  dispatch hiện tại của Octop vốn đã chạy đồng bộ trong 1 turn chat).
  Giới hạn đã biết: 1 flow dài (nhiều bước, agent trả lời chậm) sẽ giữ
  request mở lâu — chấp nhận ở V1, có hướng nâng cấp ở mục 10.
- **Không streaming (SSE) khi đang chạy** — trả kết quả 1 lần khi flow
  chạy xong, không cập nhật live từng bước như orchester's
  `RunInspector`. Lượt sau có thể thêm.
- **Không trigger tự động** (webhook/schedule/conversation) — V1 chỉ
  trigger thủ công (nút Run / gọi API). CronJobs của Octop có thể gọi
  `POST /api/flows/{id}/run` như 1 "trigger lịch" từ bên ngoài **không
  cần sửa gì ở CronJobs** — nhưng việc đó là 1 tính năng riêng, không
  nằm trong plan này.
- **Không versioning/template/group (khung bao node)** — orchester có
  `flowVersions`, `flowTemplates`, `groups` (thuần hiển thị, bản thân
  orchester cũng ghi rõ "nothing that runs or validates the flow reads
  this column"). Bỏ hết ở V1.
- **Không workspace/multi-tenant** — flow scope theo `user_id`, giống
  Agency/Team/Expert hiện tại của Octop (orchester dùng Postgres RLS
  theo `workspaceId`, Octop không có khái niệm workspace).
- **Không loop/parallel/subflow/wait_human (người duyệt)** — hệ quả
  trực tiếp của việc chỉ có 4 loại node. Một flow có cạnh tạo thành
  **chu trình (cycle)** vẫn phải được chặn an toàn (xem mục 8 — giới
  hạn số bước tối đa), không coi là "loop node" có chủ đích.
- **Không expression language** — template chỉ có đường dẫn biến và
  vài bộ lọc dựng sẵn (xem mục 8), không có toán tử hay hàm tự định nghĩa.

## 4. Anti-goals

- Không để 1 flow gọi agent của user khác (ownership theo `user_id`,
  giống mọi thực thể khác trong Octop).
- Không để flow với cạnh tạo vòng lặp (cycle) treo request vĩnh viễn —
  phải có giới hạn số bước cứng, trả lỗi rõ ràng khi vượt.
- Không patch nào thay đổi hành vi hiện có khi không áp dụng (giống
  nguyên tắc Agency: mọi patch additive).

## 5. Các hướng đã xét (Approaches)

**Nơi "agent" node gọi agent thật — đã xác định chính xác, không phải
đoán:** Team's `ask_agent` (đường đồng bộ, `mode="sync"`) đã có sẵn
đúng primitive cần: `TeamManager.call_peer()` →
`_invoke_peer()` → `self._call_agent(agent_id, request)` →
`self._registry.get(agent_id).agent.call(request)` (file đã cài đặt
`octop_harness.teams.team_manager` trong `.venv`, không phải code của
`Octop/` mà là dependency `octop-harness` nó build trên). Cụ thể:

```python
from octop_harness.teams.util import build_one_shot_request
from octop_harness.messages import extract_call_response

entry = server.app_runtime.agent_registry.get(agent_id)  # AgentEntry
request = build_one_shot_request(
    user_id=user_id, agent_id=agent_id, text=prompt, source="flow",
)
result = await entry.agent.call(request)          # dict[str, Any]
output_text = extract_call_response(result) if isinstance(result, dict) else ""
```

→ Flow's "agent" node **tái dùng nguyên primitive này**, không tự chế
cơ chế gọi agent mới, không cần hiểu/đụng vào `GlobalProcessor`'s
`InboundMessage` routing (tầng thấp hơn, phức tạp hơn, dành cho 1 turn
chat thật có lịch sử — "agent node" chỉ cần hỏi-đáp 1 lần, giống hệt
Team's `ask_agent` đã làm).

**Đã xét và bỏ:** gọi thẳng `GlobalProcessor` (quá low-level, phải tự
dựng `InboundMessage` đầy đủ ngữ cảnh thread — không cần cho 1 câu
hỏi-đáp rời rạc); viết 1 job queue riêng bằng APScheduler/Celery (vi
phạm "không thêm dependency mới" — Octop đã có APScheduler cho
CronJobs, nhưng dùng nó cho "chạy 1 request đồng bộ" là lạc đề, CronJobs
lập lịch, không chạy nền 1 request đang mở).

## 6. Data model

```sql
-- 023_flow.sql (mẫu patern y hệt 022_agency.sql)
CREATE TABLE flows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id       TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  nodes_json    TEXT NOT NULL DEFAULT '[]',
  edges_json    TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'draft',  -- draft | active
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE flow_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL UNIQUE,
  flow_id       TEXT NOT NULL REFERENCES flows(flow_id) ON DELETE CASCADE,
  status        TEXT NOT NULL,  -- succeeded | failed
  input_json    TEXT,
  output_json   TEXT,
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE TABLE flow_run_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES flow_runs(run_id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL,
  node_type     TEXT NOT NULL,
  status        TEXT NOT NULL,  -- succeeded | failed
  input_json    TEXT,
  output_json   TEXT,
  error         TEXT,
  agent_id      TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE INDEX idx_flow_runs_flow_id ON flow_runs(flow_id);
CREATE INDEX idx_flow_run_steps_run_id ON flow_run_steps(run_id);

UPDATE _schema_version SET version = 23;
```

`.pg.sql` song song, chỉ khác `id INTEGER GENERATED BY DEFAULT AS
IDENTITY PRIMARY KEY` (đúng khác biệt duy nhất giữa `022_agency.sql`
và `022_agency.pg.sql`). **Số `023` phải tự xác nhận lại tại thời điểm
cài** — `install.sh` đã có cơ chế từ chối nếu upstream Octop chiếm số
đó trước (xem README "Upgrading").

Phiên bản flow (snapshot bất biến của đồ thị) nằm ở bảng riêng, migration
`024_flow_versions.sql` (+ `.pg.sql`, chỉ khác kiểu cột `id`):

```sql
CREATE TABLE flow_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id    TEXT NOT NULL UNIQUE,
  flow_id       TEXT NOT NULL REFERENCES flows(flow_id) ON DELETE CASCADE,
  version_no    INTEGER NOT NULL,  -- tăng dần theo flow, không dùng lại
  label         TEXT,
  kind          TEXT NOT NULL,  -- manual | auto
  nodes_json    TEXT NOT NULL,
  edges_json    TEXT NOT NULL,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(flow_id, version_no)
);

CREATE INDEX idx_flow_versions_flow_id ON flow_versions(flow_id);

UPDATE _schema_version SET version = 24;
```

`nodes_json`/`edges_json` lưu đúng mảng `Node`/`Edge` mà
`@xyflow/react` dùng ở frontend (xem mục 8) — không có bảng con cho
từng node, giống cách orchester lưu `flows.nodes`/`flows.edges` dạng
jsonb nguyên khối, chỉ khác Octop dùng `TEXT` (SQLite không có jsonb
native) + `json.dumps`/`json.loads` ở router, đúng pattern Agency đã
dùng cho các field JSON khác trong Octop.

## 7. Backend API (router mới `flow.py`, không sửa router nào hiện có)

| Method | Path | Việc làm |
|---|---|---|
| GET | `/api/flows` | liệt kê flow của user |
| POST | `/api/flows` | tạo flow mới `{name, description?}` |
| GET | `/api/flows/{flow_id}` | lấy 1 flow (kèm `nodes`/`edges`) |
| PATCH | `/api/flows/{flow_id}` | sửa `{name?, description?, nodes?, edges?, status?}` |
| DELETE | `/api/flows/{flow_id}` | xoá (cascade `flow_runs`/`flow_run_steps`) |
| POST | `/api/flows/{flow_id}/run` | chạy đồng bộ `{input?: dict, dry_run?: bool}` → `FlowRunResult` + `run_id` (`null` khi dry-run) + `dry_run` (yêu cầu `status == "active"`, nếu không trả `409 FLOW_NOT_ACTIVE`; riêng `dry_run: true` không yêu cầu — xem §8 "Dry-run") |
| POST | `/api/flows/{flow_id}/validate` | kiểm tra tĩnh `{nodes?, edges?}` (bỏ trống ⇒ đồ thị đã lưu) → `{valid, issues:[{level, code, message, node_id}]}`; `valid` = không có issue mức `error` |
| GET | `/api/flows/{flow_id}/runs` | lịch sử chạy (tóm tắt) |
| GET | `/api/flows/{flow_id}/runs/{run_id}` | 1 run đầy đủ (từng step) |
| GET | `/api/flows/{flow_id}/versions` | liệt kê phiên bản, mới nhất trước: `[{version_no, label, kind, created_at, node_count, edge_count}]` (không kèm đồ thị) |
| POST | `/api/flows/{flow_id}/versions` | lưu phiên bản `{label?}` (cắt khoảng trắng, rỗng ⇒ `null`, dài hơn 100 ký tự ⇒ 422) của đồ thị **đã lưu**; `201` + tóm tắt; `kind = "manual"` |
| GET | `/api/flows/{flow_id}/versions/{version_no}` | 1 phiên bản: tóm tắt + `nodes`/`edges`; không có ⇒ 404 |
| POST | `/api/flows/{flow_id}/versions/{version_no}/restore` | khôi phục ⇒ `{flow, restored_from, backup_version_no}` |

Phiên bản: `version_no` = `MAX+1` theo flow (không bao giờ dùng lại số), chỉ giữ
50 phiên bản mới nhất mỗi flow (xoá cũ nhất). Restore chỉ ghi đè `nodes`/`edges`
(không đổi `name`/`description`/`status`); trong cùng một transaction nó tự lưu
đồ thị hiện tại thành phiên bản `auto` nhãn `Before restore to v<N>` (nên hoàn
tác được bằng cách restore bản backup đó). Nếu flow đang `active` mà phiên bản
có lỗi validate (cùng cổng với Phase #3) thì trả `422` và không thay đổi gì;
flow `draft` luôn restore được. Xoá flow cũng xoá các phiên bản.

Ownership guard giống hệt `_require_owned_agency()` của Agency — copy
pattern, đổi tên bảng.

`description` là tài liệu markdown của flow, tối đa 20000 ký tự (vượt quá ⇒ 422); `null` xoá tài liệu.

## 8. Flow engine (module thuần Python, không phụ thuộc FastAPI)

`customize/backend/flows/engine.py` — nhận `nodes`, `edges`, `input`
và **1 hàm gọi agent được tiêm vào** (`call_agent: (agent_id, prompt)
-> str`, async) — nhờ vậy test được bằng hàm giả, không cần agent thật
chạy trong lúc unit test. Thuật toán: bắt đầu từ node `trigger`, với
mỗi node hiện tại:

1. `agent`: dựng prompt bằng cách render template trong `config.prompt`
   (xem "Template" bên dưới), gọi `call_agent(agent_id, prompt)`, lưu
   kết quả vào `variables[config.output_var or node.id]`. Lỗi template
   làm hỏng bước với `template error: <message>`, không gọi agent và
   không retry.
2. `condition`: so `variables` theo `config.left/op/right` (toán tử:
   `eq/neq/gt/lt/gte/lte/contains`; `gt/lt/gte/lte` ép kiểu số, lỗi rõ
   ràng nếu không phải số), đi tiếp theo cạnh có
   `source_handle == "true"`/`"false"` khớp kết quả.
3. `end`: dừng, output = `variables` hiện tại.
4. Node không có cạnh ra hợp lệ (dangling) → dừng tại đó, coi là hết
   flow (không phải lỗi).
5. **Giới hạn cứng `max_steps` (mặc định 50)** — vòng lặp `while` đếm
   bước, vượt quá → trả `status="failed"`, `error="exceeded max steps
   (cycle in the graph?)"`. Đây là chốt an toàn bắt buộc (mục 4
   Anti-goals) vì V1 không có loop node nên MỌI vòng lặp trong đồ thị
   là lỗi cấu hình, không phải chủ đích.

**Retry (node `agent`).** `config.max_retries` (lưu ở JSON là
`maxRetries`): số lần gọi lại thêm sau lần đầu, mặc định `0`, kẹp
`0..5`. `config.retry_delay` (`retryDelay`): số giây chờ cố định giữa
các lần, mặc định `1.0`, kẹp `0..30`. Vắng/`None`/`""` ⇒ mặc định;
chuỗi số được chấp nhận; giá trị không phải số (hoặc bool) ⇒ step fail
với `invalid retry config: ...`, không gọi agent. Mọi `Exception` của
`call_agent` đều được thử lại, trừ `NonRetryableError` (agent không tồn
tại / không thuộc user — router bọc `OctopError` thành lỗi này) ⇒ step
fail ngay, không chờ. Lần thử lại KHÔNG tính vào `max_steps` (một step
= một lần thăm node). Lỗi: `agent call failed: <exc>` (không retry /
không-thử-lại-được) hoặc `agent call failed after <N> attempts: <exc>`. Run chạy đồng bộ trong một request HTTP, nên trường hợp xấu nhất
là `max_retries × retry_delay` (tối đa 5 × 30s) cho mỗi node agent cộng
thời gian gọi; reverse proxy có timeout ngắn hơn có thể cắt request
trong khi run vẫn tiếp tục chạy ở server.

**Template.** `customize/backend/flows/template.py` (module thuần, không
I/O) dùng cho prompt của node `agent` và `left`/`right` của node
`condition`. Cú pháp token: `{{path|filter|filter:arg}}`, khớp regex
`\{\{\s*(\w+(?:\.\w+)*)\s*((?:\|[^{}|]*)*)\}\}`. Văn bản không khớp
(`{{"a":1}}`, `{{ a b }}`, `{{}}`, `{{` đơn lẻ) được giữ nguyên. Khoảng
trắng quanh path và filter bị bỏ qua (`{{ name | upper }}`).

- *Path:* tách theo `.`, đi qua `variables`: dict -> tra key; list/tuple ->
  chỉ số khi segment toàn chữ số và nằm trong khoảng; mọi trường hợp khác
  (thiếu key, chỉ số sai, đi vào str/int/None) là "thiếu" và render ra chuỗi
  rỗng. Giá trị khác chuỗi render bằng `str()`. **Thay đổi hành vi:** biến
  được gán tường minh là `None` giờ render ra chuỗi rỗng (trước đây là
  `"None"`); key thiếu vẫn render rỗng như cũ.
- *Filter* (áp từ trái sang phải; giá trị thiếu coi là `None`): `upper`,
  `lower`, `trim` (không nhận đối số, làm việc trên `str(value)`);
  `default:<text>` (bắt buộc đối số, trả `<text>` khi giá trị là `None`
  hoặc `""`); `truncate:<n>` (số nguyên 0..100000; nếu dài hơn `n` thì cắt
  và thêm `...`); `length` (độ dài của str/list/tuple/dict, hoặc của
  `str(value)`; `None` -> `0`); `json` (`json.dumps`, `None` -> `null`).
  Đối số là phần sau dấu `:` đầu tiên, bỏ khoảng trắng và một cặp nháy
  `'..'`/`".."` bao ngoài; không được chứa `|`, `{`, `}`.
- *Lỗi:* filter lạ, thiếu đối số, đối số thừa hoặc `truncate` sai đối số
  ném `TemplateError` (ví dụ `unknown filter 'xyz' in {{name|xyz}}`). Engine
  biến nó thành bước thất bại `template error: <message>` (agent: không
  gọi agent, không retry; condition: bước condition thất bại); không bao
  giờ raise ra khỏi `run_flow`.
- *Validate:* mã lỗi `bad_template` (xem bên dưới) bắt lỗi này trước khi chạy.

**Validate (kiểm tra tĩnh).** `customize/backend/flows/validate.py` (hàm thuần,
không FastAPI/DB, không bao giờ raise với dữ liệu hỏng) trả danh sách `FlowIssue`
(`level`, `code`, `message`, `node_id`). Mức `error`: `duplicate_node_id`,
`unknown_node_type`, `no_trigger`, `multiple_triggers`, `agent_missing_agent`,
`agent_missing_prompt`, `agent_bad_retry`, `condition_bad_op`,
`condition_missing_left`, `condition_bad_handle`, `edge_dangling`, `cycle`,
`bad_template` (mỗi token sai ở `prompt`/`left`/`right` một issue, message
`Node '<id>' has a bad template in <field>: <lỗi>`; trường trống bị bỏ qua).
Mức `warning`: `unreachable_node`, `condition_branch_missing`,
`multiple_outgoing`. Chốt chặn (lỗi 422, `detail` dạng
`"flow has N validation error(s): <lỗi đầu tiên>"`): (1) `PATCH` với
`status = "active"` — validate đồ thị gửi kèm trong cùng request nếu có, nếu không
thì đồ thị đã lưu, trước khi ghi bất cứ gì; (2) `POST .../run` — validate trước
khi gọi engine, nên flow đang `active` nhưng bị sửa thành sai không chạy được.
Bản nháp không bao giờ bị chặn: lưu node/edge, đổi tên, và chuyển về `draft` luôn
được phép.

**Dry-run.** `POST .../run` với `dry_run: true` mô phỏng cả flow mà không gọi agent
thật và không ghi lịch sử. Router thay `call_agent` bằng một stub trả đúng chuỗi
`"[dry-run] agent <agent_id> would receive: <prompt>"` (prompt đã render); không
tra `agent_registry`, không retry/sleep, không insert `flow_runs`/`flow_run_steps`
(response có `run_id: null`, `dry_run: true`). Flow `draft` vẫn dry-run được (bỏ
chốt `FLOW_NOT_ACTIVE`), nhưng quyền sở hữu và chốt validate tĩnh (422) vẫn áp dụng.
Câu trả lời giả chính là giá trị mà các node phía sau (kể cả `condition`) nhìn
thấy, nên `contains` trên `[dry-run]` rẽ nhánh được còn phép so sánh số trên văn
bản đó trả step `failed` như thường.

## 9. Frontend

- `customize/dashboard/pages/Flows/index.tsx`: danh sách flow (antd
  `Card`/`Table`, giống `departmentsPane` của Agency), nút tạo mới →
  điều hướng sang trang chi tiết/canvas.
- `customize/dashboard/pages/Flows/components/FlowCanvas.tsx`: canvas
  `@xyflow/react` — **khác AgencyOrgChart ở chỗ `nodesConnectable`
  bật**, có `onConnect` thật để người dùng tự vẽ cạnh, có nút "Thêm
  node" (chọn loại trong 4 loại), click chọn node mở
  `NodeInspectorDrawer` (antd `Drawer`) để sửa `config` của node đó.
  Node renderer theo từng `type` (trigger/agent/condition/end) viết
  gọn trong 1 file như `AgencyOrgChart.tsx` đã làm (không tách
  `nodes/*.tsx` riêng như orchester — 4 node nhỏ, không cần).
  Canvas có MiniMap kéo-thả (pannable) và zoom được (zoomable), màu
  node theo `type`.
- `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx`:
  hiện kết quả sau khi bấm "Run" — danh sách step (icon trạng thái,
  input/output rút gọn), và tab "Lịch sử" gọi `GET .../runs`.
- `customize/dashboard/pages/Flows/components/FlowDocsDrawer.tsx`:
  nút "Docs" trên toolbar mở drawer soạn/xem trước (markdown qua
  `LazyMarkdown`) tài liệu của flow, lưu bằng `PATCH` chỉ gồm
  `description`; trang danh sách chỉ hiện bản tóm tắt 1 dòng.
- `customize/dashboard/pages/Flows/components/FlowVersionsDrawer.tsx`:
  nút "Versions" trên toolbar mở drawer liệt kê phiên bản (mới nhất trước), "Save version"
  lưu canvas trước rồi chụp phiên bản (nhãn tùy chọn), "Restore" (có xác nhận) khôi phục
  rồi canvas tải lại đồ thị từ server; lỗi giữ drawer mở (vd. 422 chỉ khi flow đang active **và** phiên bản được chọn có lỗi validate).
- Mẫu khởi tạo: nút "From template" trên trang danh sách mở modal với 3 mẫu
  (`flowTemplates.ts`: ask-agent, branch-on-reply, two-step-pipeline); chọn "Use"
  sẽ `POST /flows` (tên + mô tả markdown) rồi `PATCH` nodes/edges, các node agent
  để trống `agentId` để người dùng tự chọn agent trước khi kích hoạt.
- Không thêm dependency JS mới — `@xyflow/react` đã có sẵn từ lúc làm
  `AgencyOrgChart.tsx` (patch 11, `package.json`).

## 10. Hướng nâng cấp để lại cho lượt sau (không làm ở V1)

- Chạy nền thật (không block request) — khả thi **không cần thêm
  dependency**: dùng `asyncio.create_task` trong chính process Octop
  (đã là 1 process Python asyncio sẵn, xem `OctopServer`), kèm
  polling thay vì SSE trước, SSE sau nếu cần — không nhất thiết phải
  port nguyên cụm pg-boss + worker process của orchester.
- Thêm loại node theo nhu cầu thật (ví dụ `http` nếu có người cần gọi
  API ngoài) thay vì port cả 28 loại một lần.
- Trigger tự động: để CronJobs gọi `POST .../run` là đủ cho "theo
  lịch"; webhook/conversation để sau nếu có nhu cầu cụ thể.

## 11. Danh sách file (tổng kết)

**File mới (soạn trong `customize/`, `install.sh` copy — không bao giờ
sửa trực tiếp):**

| Authored at | Installed at |
|---|---|
| `customize/backend/migrations/023_flow.sql` + `.pg.sql` | `Octop/src/octop/infra/db/migrations/023_flow.sql` + `.pg.sql` |
| `customize/backend/flows/engine.py` | `Octop/src/octop/infra/flows/engine.py` |
| `customize/backend/flows/validate.py` | `Octop/src/octop/infra/flows/validate.py` |
| `customize/backend/flows/template.py` | `Octop/src/octop/infra/flows/template.py` |
| `customize/backend/tests/test_flow_template.py` | `Octop/tests/unit/test_flow_template.py` |
| `customize/backend/tests/test_flow_validate.py` | `Octop/tests/unit/test_flow_validate.py` |
| `customize/backend/routers/flow.py` | `Octop/src/octop/api/routers/flow.py` |
| `customize/backend/tests/test_flow_engine.py` | `Octop/tests/unit/test_flow_engine.py` |
| `customize/backend/tests/test_flow_api.py` | `Octop/tests/integration/test_flow_api.py` |
| `customize/dashboard/pages/Flows/index.tsx` | `.../dashboard/src/pages/Flows/index.tsx` |
| `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` | `.../pages/Flows/components/FlowCanvas.tsx` |
| `customize/dashboard/pages/Flows/components/NodeInspectorDrawer.tsx` | `.../pages/Flows/components/NodeInspectorDrawer.tsx` |
| `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx` | `.../pages/Flows/components/RunResultDrawer.tsx` |
| `customize/dashboard/pages/Flows/*.test.tsx` (vitest, 1/component) | path tương ứng |

**Patch (file đã có của Octop, patch nhỏ — 5, vẫn ít hơn Agency's 6;
mục #5 thêm sau V1, đóng roadmap item #1 — gate `status` trên
`POST .../run`):**

1. `src/octop/api/app.py` — mount `flow.router` tại `/api` (copy đúng
   dòng mount của `agency.router`).
2. `dashboard/src/routes/index.tsx` — thêm route `/flows`.
3. `dashboard/src/layouts/sidebarNav.tsx` — thêm mục nav "flows" (icon
   gợi ý: `Workflow` từ lucide-react, đúng icon orchester dùng cho
   FlowNode).
4. `src/octop/infra/users/preferences.py` — thêm `"flows"` vào
   `SIDEBAR_NAV_KEYS`.
5. `customize/docs/patches/17-errors-add-flow-not-active.patch` →
   `Octop/src/octop/infra/errors.py` — thêm `ErrorCode.FLOW_NOT_ACTIVE`
   (enum member + `_DEFAULT_STATUS` → `409`), dùng bởi gate
   `status == "active"` trên `POST /flows/{flow_id}/run`.

> Nâng cấp một checkout đã cài sẵn patch 01-16 (V1): xem README.md,
> mục "Thêm patch 17 (flow-status-gate) vào checkout đã cài sẵn
> patch 01-16" — `install.sh` không dùng lại được cho trường hợp này.

## 12. Việc để lại cho người triển khai (builder)

- Field `source` truyền vào `build_one_shot_request` dùng chuỗi
  `"flow"` (giống `"ask_agent"`/`"inbox"` Team đã dùng) — chỉ để log,
  không có ý nghĩa rẽ nhánh logic nào khác; xác nhận lại bằng cách đọc
  `octop_harness.teams.tools.ask_agent` 1 lần nữa khi code task này
  nếu `octop-harness` đã lên version khác lúc triển khai.
- Icon chính xác cho node renderer (lucide-react) chọn tự do theo gu
  thẩm mỹ, miễn khớp 4 loại node.
- Format input/output rút gọn trong `RunResultDrawer` (cắt chuỗi dài
  bao nhiêu ký tự) để builder tự quyết theo UI thực tế, không phải
  quyết định kiến trúc.
