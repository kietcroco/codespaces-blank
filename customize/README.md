# Customize: tính năng "Agency" cho Octop

Thư mục này chứa phần bổ sung **không nằm trong** source của `Octop/` hay
`orchester/`. Hai repo đó không bị sửa trực tiếp bởi tôi (assistant) —
mọi file mới và mọi patch cho Octop đều được soạn và nằm trong
`customize/`. Việc đưa chúng vào `Octop/` (copy file mới + `git apply`
patch) chỉ xảy ra khi **người dùng tự chạy** `customize/install.sh` —
không phải điều tôi tự làm. `orchester/` chỉ được **đọc để tham khảo**,
không có patch hay file nào nhắm vào nó.

Thiết kế đầy đủ: [`docs/design.md`](docs/design.md). Kiến trúc tổng thể
(4 phần của hệ thống, quy trình thêm tính năng mới, vận hành container,
test UI, cấu hình provider): [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

## Mục tiêu

Thêm một khái niệm tổ chức mới cho Octop gọi là **Agency** (phòng ban) —
độc lập với "Team" (Expert Team) đang có sẵn:

- Agency là một nhóm/phòng ban, tương tự cách **Team** trong orchester gom
  nhiều **Agent**. Ở Octop, "Agent" tương đương **Expert**.
- Agency có **menu riêng ngang cấp với "Experts"** trong sidebar, có trang
  quản lý (tạo/sửa/xoá phòng ban, xem thành viên).
- Khi tạo/sửa một Expert, có thể **chọn Agency** cho expert đó — đúng cách
  orchester cho chọn `teamId` khi tạo Agent (`AgentFormModal.tsx`).
- Có một trang sơ đồ tổ chức (org-chart) trực quan hoá Agency → Experts,
  theo đúng kỹ thuật vẽ (SVG bezier + đo layout) của
  `apps/web/components/org/OrgChart.tsx` bên orchester.

## Hiện trạng

**Octop** (`Octop/`):
- Đã có "Team" (Expert Team) — nhưng đây là **agent có `kind='team'`**, roster
  thành viên lưu trong `manifest.json` của workspace, không phải bảng DB
  riêng (`src/octop/infra/db/migrations/016_agent_teams.sql`). Dùng cho chat
  nhóm nhiều expert, không phải khái niệm phòng ban/tổ chức.
- Không có bảng, API, hay trang nào cho "phòng ban"/"Agency".
- Sidebar là danh sách cố định `SIDEBAR_NAV_KEYS`
  (`dashboard/src/layouts/sidebarNav.tsx`, đồng bộ với
  `src/octop/infra/users/preferences.py`) — không có cơ chế plugin để tự
  thêm mục menu mới; phải thêm key bằng patch.
- Có hệ thống plugin (`plugins/`) nhưng chỉ render card trong khung chat
  (`octop_ui`), không cho thêm trang/route mới — không dùng được cho Agency.
- Dashboard dùng `antd` + `lucide-react`, **không có** `framer-motion` hay
  `@xyflow/react`.

**orchester** (`orchester/`, chỉ tham khảo):
- `Workspace → Teams → Agents`: Team có `name/description/avatarColor`,
  chứa nhiều Agent. Agent có `teamId` chọn qua `<select>` trong
  `AgentFormModal.tsx`.
- Trang org-chart chính dùng `OrgCanvas.tsx` (`@xyflow/react`, dữ liệu từ
  `GET /api/org-graph`); bản visual đơn giản hơn là `OrgChart.tsx` (SVG
  bezier tự vẽ, dùng cho trang login) — **đây là bản được port sang Octop**
  vì không cần thêm dependency nặng.

## Cần bổ sung / điều chỉnh

Chi tiết đầy đủ (schema, API, danh sách file) nằm trong
[`docs/design.md`](docs/design.md). Tóm tắt:

**File mới (không đụng code cũ):**
- 2 bảng DB mới `agencies`, `agency_members` (migration mới, không sửa
  bảng `agents`).
- Router backend mới `agency.py` (CRUD Agency + gán/bỏ Expert).
- Trang dashboard mới cho Agency: danh sách phòng ban, chi tiết phòng ban,
  sơ đồ tổ chức (org-chart) SVG.

**Patch (trong `docs/patches/`, người dùng tự áp dụng — xem `install.sh`
để có danh sách và lệnh `git apply` đầy đủ, số lượng patch có thể tăng khi
tính năng mở rộng):**
1. `app.py` — mount router Agency (2 dòng).
2. `routes/index.tsx` — thêm route `/agency` (1 dòng).
3. `sidebarNav.tsx` + `preferences.py` — thêm key `"agency"` vào menu.
4. `en.json`/`zh.json` — nhãn menu `"agency"` (để không hiện literal key
   trong sidebar).
5. `EditAgentDrawer.tsx` — thêm ô chọn Agency khi **sửa** Expert.
6. `CreateFromExpertDrawer.tsx` — thêm ô chọn Agency khi **tạo** Expert
   (đây mới là form tạo thật; `EditAgentDrawer.tsx` chỉ sửa expert đã có).
7. `en.json`/`zh.json` — nhãn + placeholder cho ô chọn Agency trên 2 form
   trên (cùng lý do: form còn lại dùng `t()` toàn bộ).

Cả 2 form gọi thêm API Agency sau khi lưu/tạo expert thành công, không
đổi payload/API tạo-sửa expert hiện có. Không patch hay file nào đụng tới
`orchester/`.

## Cài đặt vào một checkout `Octop/` thật

```bash
customize/install.sh /path/to/Octop
```

Script copy các file mới (migration, router, trang Agency, test) vào
checkout đó và in ra đúng các lệnh `git apply` cho từng patch trong
`docs/patches/` — tự chạy từng lệnh đó bên trong checkout `Octop/` của
bạn. Đây là **script duy nhất** được phép ghi vào một checkout `Octop/`
thật; mọi thứ khác trong `customize/` chỉ soạn file, không tự áp dụng.

Trước khi copy bất kỳ file nào, script tự kiểm tra (và dừng ngay, không
đụng gì, nếu một trong hai điều sau xảy ra):
- `$OCTOP_DIR` không phải git checkout (patch cần `git apply`).
- Toàn bộ patch trong `docs/patches/` không `git apply --check` sạch
  trên checkout đó — ví dụ Octop đã đổi khác với lúc patch được viết.
- Checkout đã có sẵn một migration đánh số trùng (`022_*.sql`) — xem
  mục "Upgrading" bên dưới.

## Upgrading (rủi ro đánh số migration)

Migration của Agency (`022_agency.sql` / `.pg.sql`) dùng chung dãy số
migration của chính Octop, thay vì một namespace riêng. Nếu một phiên
bản Octop sau này tự có migration `022_*` của chính nó:
- `octop init`/khởi động sẽ báo lỗi `Duplicate migration version 022`
  và server không chạy được — `install.sh` đã chặn trường hợp này từ
  trước khi copy file (xem trên).
- Nếu người dùng tự đổi file `022_agency.sql`/`.pg.sql` của add-on này
  thành một số khác (ví dụ `023`) để né xung đột, **migration `022`
  thật của Octop sẽ bị bỏ qua vĩnh viễn** — vì DB đã ghi nhận "đã chạy
  tới version 22" từ lần cài Agency trước đó, nên `022_*` thật của
  Octop không bao giờ được áp dụng nữa, kể cả sau khi đổi số.

Cách an toàn khi gặp xung đột: đổi số file migration của **Agency**
(không phải của Octop) sang số **lớn hơn** toàn bộ migration hiện có
của Octop tại thời điểm đó (không phải số nhỏ hơn số đang xung đột),
rồi chạy lại `install.sh`.

### Thêm patch 17 (flow-status-gate) vào checkout đã cài sẵn patch 01-16

Nếu checkout `Octop/` của bạn đã cài Agency/Flow V1 từ trước (đã áp
patch 01-16), **đừng chạy lại `install.sh`** cho lần nâng cấp này —
script kiểm tra `git apply --check` trên **toàn bộ** patch trong
`docs/patches/` trước khi làm gì cả, nên patch 01-16 sẽ báo "already
applied" và script dừng ngay, không copy được gì (kể cả patch 17 hay
`flow.py`/`FlowCanvas.tsx`/`RunResultDrawer.tsx` mới). Thay vào đó, áp
trực tiếp patch mới rồi copy tay:

```bash
git -C /path/to/Octop apply /path/to/customize/docs/patches/17-errors-add-flow-not-active.patch
```

(`git -C <dir> apply <path>` resolves `<path>` against `<dir>`, không
phải cwd — giống đúng cách `install.sh` tự in lệnh `git apply` của nó,
luôn dùng đường dẫn tuyệt đối cho patch.)

rồi copy tay 3 file đã sửa:
- `customize/backend/routers/flow.py` → `Octop/src/octop/api/routers/flow.py`
- `customize/dashboard/pages/Flows/components/FlowCanvas.tsx` → `Octop/dashboard/src/pages/Flows/components/FlowCanvas.tsx`
- `customize/dashboard/pages/Flows/components/RunResultDrawer.tsx` → `Octop/dashboard/src/pages/Flows/components/RunResultDrawer.tsx`

**Patch 17 và `flow.py` mới phải đi cùng nhau.** Chỉ copy `flow.py` mà
quên áp patch 17 thì `ErrorCode.FLOW_NOT_ACTIVE` chưa tồn tại trong
`errors.py` — lần đầu ai đó bấm "Run" một flow draft sẽ bị
`AttributeError` (lỗi 500), thay vì lỗi 409 sạch như thiết kế.

Sau khi nâng cấp xong, **mọi flow cũ đã có trong DB** đều đang ở
status `draft` (giá trị mặc định từ trước) — nên sẽ bắt đầu trả về
409 `FLOW_NOT_ACTIVE` khi bấm "Run", cho đến khi có người chủ động vào
từng flow và bấm nút "Activate" (toggle mới trong `FlowCanvas.tsx`) để
chuyển sang `active`. Đây là hành vi đã thiết kế (toggle + thông báo
lỗi rõ ràng xử lý được), không phải lỗi — nhưng cần báo trước cho
người dùng, nếu không họ sẽ nghĩ bản nâng cấp làm hỏng flow của họ.
