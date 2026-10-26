# Flow AI Copilot — thiết kế (roadmap #10)

Ngày: 2026-10-26 · Trạng thái: chờ duyệt · Phase 10/38

## 1. Mục tiêu

Người dùng mô tả flow bằng ngôn ngữ tự nhiên; copilot dùng **model provider đã
cài trong Octop** để:

- **Tạo mới** một flow nháp từ mô tả (trang Flows).
- **Sửa flow đang mở** (canvas) theo yêu cầu, giữ nguyên các node không đổi.

Kết quả luôn là bản **đề xuất** (nodes + edges) để người dùng xem rồi mới áp.
Copilot không kích hoạt, không chạy flow, không chọn agent thay người dùng khi
không chắc.

Tham chiếu: copilot của orchester (`orchester/apps/web/app/api/flows/[id]/copilot/route.ts`,
`lib/flows/copilot-tools.ts`, `components/flows/CopilotPanel.tsx`): model gọi tool
`set_flow` trả toàn bộ flow, server dựng graph, panel hiện đề xuất để Replace/Discard.

## 2. Backend

### 2.1 Endpoint

`POST /flows/copilot` (mọi route flow hiện nằm dưới `/flows`).

Body:

| Trường | Ý nghĩa |
|---|---|
| `prompt` | Bắt buộc, không rỗng. |
| `history` | Tùy chọn, `[{role, content}]`; server chỉ giữ 8 tin cuối. |
| `current_graph` | Tùy chọn `{nodes, edges}`; có và có node thì là chế độ **sửa**. |
| `flow_id` | Tùy chọn; có thì kiểm tra quyền sở hữu flow (`_require_owned_flow`). |
| `model` | Tùy chọn; ref `provider/model`. Xem 2.3. |

Phản hồi: `{message, graph, issues, model_ref}`.

- `graph` là `{nodes, edges}` dạng xyflow đã lưu (có `position`, `data.config`),
  hoặc `null` khi model chỉ trả lời/hỏi lại hoặc khi output bị cắt.
- `issues` là kết quả `validate_graph` trên graph trả về (rỗng nếu `graph` null).
- `model_ref` là model thực sự được dùng.
- Endpoint **không ghi DB**.

### 2.2 Module `flows/copilot.py`

1. **Tool `set_flow`**: `nodes[{id, type, label, config}]`,
   `edges[{source, target, sourceHandle}]`. `type` thuộc
   `trigger | agent | condition | end` (engine hiện có). Condition dùng handle
   `true`/`false`.
2. **System prompt**: catalog node và các trường config (`prompt`, `agent_id`,
   `output_var`, `max_retries`, `retry_delay`, `left/op/right`), cú pháp template
   `{{path|filter:arg}}` (#7), danh sách agent của user (id, tên) để điền
   `agent_id` — không chắc thì để trống. Ở chế độ sửa: yêu cầu trả **toàn bộ flow
   đã cập nhật** và **giữ nguyên id** node cũ.
3. **Gọi model**: `access = host_models.get(ref)` rồi
   `access.chat_model.bind_tools([set_flow])` và `ainvoke` (không dùng
   `access.ainvoke` vì nó ép kết quả về chuỗi, mất `tool_calls`). Đọc
   `AIMessage.tool_calls`. Timeout 60 giây.
4. **Dựng graph**: node mới nhận id mới, node có id trùng `current_graph` giữ id;
   `position` tự bố trí theo cột (độ sâu từ trigger), node cũ giữ vị trí cũ nếu
   có; gộp config mặc định; đổi sang dạng lưu hiện tại (`agentId`, `outputVar`,
   `maxRetries`, `retryDelay`) mà `_coerce_node_config` đã chấp nhận; bỏ node có
   `type` lạ và edge trỏ node không tồn tại, mỗi trường hợp ghi vào `message`
   như một lưu ý. Cuối cùng chạy `validate_graph`.

Không tự sửa lặp bằng validate: `issues` được trả về, người dùng thấy trên canvas
và có thể nhờ copilot sửa tiếp.

### 2.3 Chọn model (theo quy tắc của Octop)

Copilot không tự chọn provider/model; dùng cùng cổng với text-assist
(`require_host_models(server).get(...)`):

- `model` được truyền và `server.app_runtime.agent_registry.providers.is_model_ref_usable(model)`
  đúng → dùng ref đó.
- Ngược lại (không truyền, `auto`, hoặc ref không dùng được) → `auto`: harness
  định tuyến trên các provider đang bật, model đầu tiên đủ điều kiện chat —
  đúng cơ chế mặc định của Octop khi có nhiều provider.
- Không đọc `default_model` của agent trong flow (đó là cấu hình của agent).

(Chi tiết đường truy cập `providers` từ `server` sẽ được xác nhận khi viết plan;
nguyên tắc ở trên là cố định.)

### 2.4 Lỗi

| Tình huống | Kết quả |
|---|---|
| Không có provider/model dùng được | Lỗi `no usable model` (như text-assist), UI hiện hướng dẫn cấu hình provider. |
| Model không hỗ trợ tool-calling | 422, nêu tên `model_ref`, gợi ý chọn model khác. Không chạy ngầm kiểu khác. |
| Output bị cắt (hết token) | `graph: null`, `message` giải thích, yêu cầu thay đổi nhỏ hơn. |
| Model không gọi `set_flow` | `graph: null`, `message` = nội dung model trả lời. |
| `flow_id` không thuộc user | 404/403 như các route flow khác. |
| Timeout | 504 hoặc lỗi tương đương, thông báo rõ ràng. |

## 3. Frontend (`customize/dashboard`)

- **Panel "AI Copilot" trên canvas**: nút ✨ trên thanh công cụ, panel bên phải.
  Lịch sử chat chỉ ở client. Có ô chọn model, mặc định "Auto". Khi có đề xuất:
  thẻ tóm tắt (danh sách node, số lỗi validate nếu còn) với **Apply** / **Discard**.
- **Apply** = thay toàn bộ flow trên canvas. Trước khi thay, tự tạo một version
  nhãn "Before AI copilot" qua API versioning (#9) để hoàn tác bằng drawer
  Versions. Không có Merge.
- **Nút "Create with AI" ở trang Flows**: modal có ô mô tả + ô chọn model; gọi
  copilot không kèm graph, tạo flow `draft` qua route hiện có, chuyển sang canvas.
  Nếu không có graph thì hiện `message` ngay trong modal.
- Lỗi validate hiển thị bằng panel lỗi và viền đỏ node đã có (#3).
- Chuỗi giao diện đi qua i18n sẵn có.

## 4. Kiểm thử

- **Backend** (model giả trả `tool_calls` cố định, không gọi model thật): flow
  hợp lệ; `type` lạ; edge trỏ node không tồn tại; output bị cắt; không có tool
  call; chế độ sửa giữ id; model không hỗ trợ tool-calling; chọn model: ref hợp
  lệ, ref không hợp lệ rơi về auto, không có provider; quyền sở hữu `flow_id`.
- **Frontend** (vitest): panel gửi đúng body, hiện đề xuất, Apply tạo version rồi
  thay graph, Discard; modal tạo mới.
- Kiểm thử với model thật trên container demo chỉ làm khi người dùng yêu cầu.

## 5. Phạm vi

Chỉ trong `customize/`; không migration, không patch DB. Không cài vào `Octop/`,
không rebuild container (chỉ khi người dùng yêu cầu rõ).

**Ngoài phạm vi**: streaming từng token, lưu lịch sử chat phía server, tự sửa lặp
bằng validate, merge vào flow hiện có, copilot gọi dry-run, các node mới
(#11 trở đi).

## 6. Rủi ro cần theo dõi

- Model do `auto` chọn có thể không hỗ trợ tool-calling → thông báo 422 và ô chọn
  model là lối thoát.
- Flow lớn có thể bị cắt → đã có đường từ chối bản cắt.
- Cách truy cập `providers` từ `server` và cách lấy danh sách agent của user
  trong `flow.py` cần xác nhận bằng đọc code khi viết plan.
