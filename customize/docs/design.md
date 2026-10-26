# Thiết kế: tính năng Agency cho Octop (tham khảo orchester)

Ngày: 2026-10-24

## 1. Mục đích & lý do

Octop hiện có "Expert" (agent AI) và "Team" (nhóm expert để chat chung,
thực chất là 1 agent `kind='team'` + roster trong `manifest.json`). Không
có khái niệm **tổ chức/phòng ban** để nhóm các Expert theo cấu trúc quản
lý, và không có cách nào trực quan hoá quan hệ đó.

orchester đã giải quyết bài toán tương tự cho Agent của họ: mỗi Agent
thuộc 1 Team (`teamId`, chọn qua dropdown lúc tạo agent), và có trang
org-chart trực quan hoá Workspace → Team → Agent.

Mục tiêu: mang đúng trải nghiệm đó sang Octop, dưới một tên **mới và tách
biệt** — **Agency** (phòng ban) — để không xung đột với "Team" (Expert
Team) đã có sẵn và đang dùng cho mục đích khác (chat nhóm).

Ràng buộc do người dùng đặt ra: không sửa trực tiếp source của `Octop/`
hay `orchester/`. Mọi phần bổ sung nằm trong `customize/`; nếu thực sự cần
đổi 1 dòng trong file đã có của Octop, việc đó được ghi lại dưới dạng file
`.patch`, không tự áp dụng vào repo.

**Lưu ý quan trọng về cách áp dụng ràng buộc này (đã rà soát lại sau
builder-check):** `migrate.py` của Octop quét migration bằng đường dẫn
cứng (`_MIGRATIONS_DIR = Path(__file__).parent / "migrations"`) và không
có cơ chế tự nạp router — nên file migration/router *mới* vẫn phải nằm
đúng chỗ trong cây `Octop/` để Octop nhận ra, không có cách nào chạy được
từ bên ngoài mà không patch thêm `migrate.py`/`app.py` (tốn patch surface
hơn, trái mục tiêu "patch tối thiểu"). Cách diễn giải đúng của ràng buộc:
**`customize/` là nơi duy nhất tôi (assistant) viết/sửa file.** Mọi file
mới cho Octop được soạn tại `customize/backend/...` và
`customize/dashboard/...`; một script `customize/install.sh` (cũng chỉ
nằm trong `customize/`, do người dùng tự chạy, tôi không tự chạy) sẽ copy
các file mới đó vào đúng vị trí trong `Octop/` và nhắc áp dụng các patch.
Tôi không bao giờ tự tay sửa/thêm file vào `Octop/` hay `orchester/` —
việc đó chỉ xảy ra khi người dùng chủ động chạy `install.sh`, giống hệt
cách họ tự `git apply` patch.

## 2. Goals

- Menu "Agency" trong sidebar Octop, ngang cấp "Experts".
- Trang Agency: list phòng ban (card: tên, màu, số lượng expert), tạo/sửa/
  xoá phòng ban, trang chi tiết xem/gán/bỏ expert.
- Trong form tạo/sửa Expert (`EditAgentDrawer.tsx`), có ô chọn Agency —
  1 expert thuộc tối đa 1 Agency, giống `teamId` của orchester.
- 1 trang/tab sơ đồ tổ chức: Agency → Experts, vẽ bằng kỹ thuật SVG bezier
  của `OrgChart.tsx` (orchester), không thêm dependency mới.
- Toàn bộ phần Octop bị đụng tới phải ở dạng patch nhỏ, liệt kê đầy đủ,
  không tự merge vào repo gốc.

## 3. Non-goals

- Không đổi hành vi/schema của "Team" (Expert Team) hiện có.
- Không làm multi-tenant/Workspace như orchester — Octop vẫn single-tenant
  theo user, Agency scope theo `user_id` giống Expert/Team hiện tại.
- ~~Không port `OrgCanvas.tsx` (bản `@xyflow/react`, có zoom/pan/kéo-thả) —
  chỉ port bản tĩnh `OrgChart.tsx` để tránh thêm dependency.~~ **Đảo ngược
  2026-10-25**: người dùng yêu cầu trực tiếp org chart phải kéo-thả + nối
  dây như orchester — đã thêm `@xyflow/react` và viết lại
  `AgencyOrgChart.tsx` bằng `ReactFlow` (xem `ARCHITECTURE.md` mục 8.2 và
  patch `11-dashboard-package-xyflow-dependency.patch`). Quyết định này
  không được hỏi xác nhận riêng trước khi làm như quy trình đáng lẽ yêu
  cầu — ghi lại ở đây để minh bạch, không phải vì đã hỏi.
- Không thêm quan hệ cấp bậc nhiều tầng (manager/report-to) trong Agency —
  Agency phẳng (Agency → Experts), giống Team phẳng của orchester.
- Không yêu cầu 1 expert thuộc nhiều Agency (1-1 cho đơn giản, giống
  `teamId` đơn của orchester).

## 4. Anti-goals

- Không để patch nào thay đổi hành vi hiện có khi không áp dụng — mọi
  patch phải là bổ sung (additive): nếu người dùng không `git apply`, Octop
  chạy y như trước.
- Không thêm bảng/cột vào `agents` — Agency luôn là bảng phụ, map tới
  `agents.agent_id` bằng khoá ngoài, xoá Agency không bao giờ xoá Expert.

## 5. Các hướng đã xét (Approaches)

| Hướng | Mô tả | Đánh giá |
|---|---|---|
| A. App độc lập | Backend+DB+frontend riêng, gọi `GET /agents` read-only | Không patch, nhưng không thể có menu ngang cấp + ô chọn trong form Expert → không đạt yêu cầu UX đã chốt |
| B. App độc lập + 1 patch link sidebar | Như A, thêm 1 link mở tab/app riêng | Vẫn không cho chọn Agency ngay trong form Expert một cách mượt — vẫn phải rời trang |
| C. Octop tool-plugin (`octop_ui`) | Dùng đúng cơ chế plugin có sẵn | Chỉ hiện card trong chat, không có trang quản lý/menu riêng |
| **D. Native, patch tối thiểu (chọn)** | Bảng + router + trang mới (file mới, không đụng code cũ) + 5 điểm patch nhỏ (mount router, 1 route, nav key, nav key backend, 1 field trong form Expert) | Đáp ứng đúng yêu cầu (menu ngang cấp, chọn Agency lúc tạo Expert); patch surface nhỏ, rõ ràng, liệt kê được hết; không cần CORS/auth riêng vì chạy trong cùng process Octop |

Quyết định: **D**. Lý do chính: yêu cầu "menu ngang cấp + chọn Agency khi
tạo Expert" chỉ có thể làm mượt khi sống trong chính dashboard/backend của
Octop; A/B/C đều không đáp ứng được mà vẫn phải thêm độ phức tạp (app
riêng, auth riêng) nên chọn D vẫn đơn giản hơn tổng thể.

## 6. Data model

2 bảng mới, không sửa bảng nào hiện có. Theo đúng style migration của
Octop (file `NNN_description.sql` cho SQLite + `NNN_description.pg.sql`
cho Postgres, xem `src/octop/infra/db/migrations/016_agent_teams.sql` làm
mẫu).

```sql
-- Soạn tại: customize/backend/migrations/022_agency.sql
-- install.sh copy vào: Octop/src/octop/infra/db/migrations/022_agency.sql
CREATE TABLE agencies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agency_id     TEXT NOT NULL UNIQUE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE agency_members (
  agency_id       TEXT NOT NULL REFERENCES agencies(agency_id) ON DELETE CASCADE,
  expert_agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
  assigned_at     INTEGER NOT NULL
);

UPDATE _schema_version SET version = 22;
```

`expert_agent_id UNIQUE` ⇒ 1 expert chỉ thuộc 1 agency tại một thời điểm
(set lại = xoá dòng cũ, insert dòng mới). Bản `.pg.sql` tương ứng dùng
`GENERATED BY DEFAULT AS IDENTITY` cho `id` như các migration `.pg.sql`
khác.

Số thứ tự migration (`022_...`) cần đối chiếu lại với số migration mới
nhất tại thời điểm áp dụng patch (hiện tại repo đang ở `021_...`) —
builder cần `ls` lại trước khi đặt tên file.

## 7. Backend API (router mới, không sửa router nào hiện có)

File mới `src/octop/api/routers/agency.py`, mount vào `app.py` qua patch
(1 import + 1 `_RouterMount(agency.router, "/api", ["agency"])`, theo
đúng mẫu dòng `teams.router` hiện có).

| Method & path | Việc làm |
|---|---|
| `GET /api/agencies` | List agency của `current_user`, kèm số lượng expert mỗi agency |
| `POST /api/agencies` | Tạo agency `{name, description?, color?}` |
| `GET /api/agencies/{agency_id}` | Chi tiết + danh sách expert đã gán (join qua `agency_members`, lấy tên/mô tả/model/trạng thái của expert từ `agent_registry` hiện có — không query thẳng bảng `agents`, tái dùng registry như `agents.py` đang làm) |
| `PATCH /api/agencies/{agency_id}` | Sửa name/description/color |
| `DELETE /api/agencies/{agency_id}` | Xoá agency (cascade xoá membership, không đụng expert) |
| `PUT /api/agencies/members/{expert_agent_id}` | Body `{agency_id: string \| null}` — set hoặc gỡ agency của 1 expert. Kiểm tra `expert_agent_id` thuộc `current_user` (dùng `assert_agent_owner` có sẵn) trước khi ghi |
| `GET /api/agencies/org-chart` | Trả `{agencies: [{id, name, color, experts: [{id, name, description, status}]}]}` cho trang sơ đồ |

**Sửa sau builder-check:** thiết kế ban đầu ghi `role` cho mỗi expert, mô
phỏng `Agent.role` của orchester. Nhưng `AgentRow` của Octop
(`src/octop/infra/db/repos/agents.py`) không có cột `role` (chỉ có
`name/description/persona_mbti/default_model/...`) và Anti-goal §4 cấm
thêm cột vào `agents`. Quyết định của tôi: dùng `description` (mô tả có
sẵn của expert) làm phụ đề hiển thị trong card/org-chart, bỏ hẳn tên field
`role` khỏi API — không cần giữ nguyên hình thức giống orchester ở điểm
này.

Mọi endpoint dùng `Depends(current_user)` + scope theo `user_id`, cùng
pattern với `teams.py`/`agents.py` hiện có (xem `_require_owned_team` làm
mẫu cho việc tự viết `_require_owned_agency`).

**Truy cập DB cho 2 bảng mới (đã xác định, không còn để ngỏ):**
`agency.py` lấy `server.services.db` (`Depends(get_server)`), dùng
`server.services.db.connect()` (đọc) / `server.services.db.transaction()`
(viết) — context manager y hệt cách `update.py` dùng
(`server.services.db.connect() as conn: conn.execute(...)`), đặt sẵn
trong `src/octop/infra/db/pool.py` (`DatabasePool` protocol, hỗ trợ cả
SQLite và Postgres qua `?` placeholder tự convert). Không cần thêm
abstraction mới.

**Mã lỗi:** dùng lại `ErrorCode.NOT_FOUND` (404) và `ErrorCode.FORBIDDEN`
(403) đã có trong `src/octop/infra/errors.py` — không cần thêm
`AGENCY_NOT_FOUND` riêng (tránh phải patch `errors.py`).

## 8. Frontend

File mới trong `dashboard/src/pages/Agency/`:
- `index.tsx` — list phòng ban dạng card (tên, màu, số expert), nút tạo mới.
- `components/AgencyFormModal.tsx` — modal tạo/sửa (name, description, color) — tái dùng pattern của `TeamFormModal.tsx` (orchester) làm tham khảo bố cục, không copy code.
- `components/AgencyDetail.tsx` — chi tiết 1 agency: danh sách expert đã gán, chọn thêm/bỏ expert (dùng lại component chọn dạng list có sẵn trong Octop nếu có, ví dụ kiểu `TeamMemberPicker.tsx` của Octop đã có — builder kiểm tra có tái dùng được UI đó không trước khi viết mới).
- `components/AgencyOrgChart.tsx` — port kỹ thuật vẽ của `orchester/apps/web/components/org/OrgChart.tsx`: giữ nguyên hàm `bezier()` và `layoutRect()`, bỏ phần dùng `framer-motion` (đổi `motion.div`/`motion.path` thành `div`/`path` thường + CSS transition, vì dashboard Octop chưa có dependency này). Phụ đề mỗi expert hiển thị `description` (xem mục 7), không phải `role`.

Patch nhỏ (trong `docs/patches/`):
- `routes/index.tsx`: thêm `{ path: "/agency", element: <AgencyPage /> }` cạnh dòng `/experts`.
- `layouts/sidebarNav.tsx`: thêm `"agency"` vào `SIDEBAR_NAV_KEYS`, thêm 1 `NavItem` (icon gợi ý: `Building2` từ `lucide-react`, đã là dependency sẵn có) ngay sau item `"experts"`.
- `src/octop/infra/users/preferences.py`: thêm `"agency"` vào `SIDEBAR_NAV_KEYS` backend (dòng ghi chú ngay trong file nói 2 nơi này phải đồng bộ).
- `dashboard/src/pages/Experts/components/EditAgentDrawer.tsx`: thêm 1 `Form.Item` + `Select` chọn Agency (load list qua `GET /api/agencies`), đặt cạnh field `default_model`. Trong hàm submit, sau khi lưu expert thành công, gọi thêm `PUT /api/agencies/members/{agent_id}` — không đổi payload/API lưu expert hiện có.
- `dashboard/src/pages/Experts/components/CreateFromExpertDrawer.tsx`: **bổ sung sau builder-check** — đây mới là drawer tạo expert thật (`POST /agents/from-expert/{id}`); `EditAgentDrawer.tsx` chỉ `PATCH` expert đã tồn tại. Goal "chọn Agency lúc **tạo** Expert, giống orchester" chỉ đạt được nếu patch luôn cả drawer tạo này: cùng 1 `Select` chọn Agency, cùng gọi `PUT /api/agencies/members/{agent_id}` sau khi `POST` tạo expert thành công (dùng `agent_id` trả về từ response tạo).

Nhãn chữ (label) viết thẳng tiếng Việt/Anh trong component mới (không
đụng file i18n chung của Octop) để không phải patch thêm file locale.

## 9. Danh sách file (tổng kết)

Cột "Soạn tại" là nơi duy nhất tôi viết file. Cột "Đích khi cài" là nơi
`install.sh` (người dùng tự chạy) copy/patch vào — tôi không tự chạy
script này.

**Mới, không patch (install.sh chỉ copy, không đổi file nào có sẵn):**

| Soạn tại (`customize/`) | Đích khi cài (`Octop/`) |
|---|---|
| `backend/migrations/022_agency.sql` + `.pg.sql` | `src/octop/infra/db/migrations/022_agency.sql` + `.pg.sql` |
| `backend/routers/agency.py` | `src/octop/api/routers/agency.py` |
| `dashboard/pages/Agency/index.tsx` + `components/*.tsx` | `dashboard/src/pages/Agency/index.tsx` + `components/*.tsx` |

**Patch (6 file, mỗi patch tối đa vài dòng, giữ dưới `docs/patches/*.patch`):**
1. `src/octop/api/app.py` — mount router Agency.
2. `dashboard/src/routes/index.tsx` — thêm route `/agency`.
3. `dashboard/src/layouts/sidebarNav.tsx` — thêm nav key `"agency"`.
4. `src/octop/infra/users/preferences.py` — thêm `"agency"` vào `SIDEBAR_NAV_KEYS` backend.
5. `dashboard/src/pages/Experts/components/EditAgentDrawer.tsx` — thêm ô chọn Agency lúc sửa expert.
6. `dashboard/src/pages/Experts/components/CreateFromExpertDrawer.tsx` — thêm ô chọn Agency lúc tạo expert (bổ sung sau builder-check, xem mục 8).

`customize/install.sh`: script duy nhất được phép ghi vào `Octop/`, do
người dùng tự chạy. Nó copy 3 nhóm file "mới" ở trên vào đúng đường dẫn,
rồi in ra danh sách 6 patch cần `git apply` thủ công kèm lệnh mẫu. Script
này không tự chạy trong quá trình tôi làm việc.

## 10. Việc để lại cho người triển khai (builder)

- Số thứ tự migration thật (`022` chỉ là ước tính tại thời điểm viết tài
  liệu này) — kiểm tra lại `ls src/octop/infra/db/migrations/ | sort | tail`
  ngay trước khi đặt tên file, vì Octop vẫn đang phát triển và số mới nhất
  có thể đã tăng.
- Icon cụ thể cho menu Agency (gợi ý `Building2`, có thể đổi).
- Có tái dùng được component chọn expert có sẵn (`TeamMemberPicker.tsx`)
  cho `AgencyDetail.tsx` hay viết mới — quyết định khi code, không ảnh
  hưởng thiết kế tổng thể.
- Permission: Agency có cần permission riêng (như `userCan`/`navAllowed`)
  hay dùng chung quyền của "experts" — mặc định dùng chung quyền
  `experts` trừ khi người dùng yêu cầu khác lúc triển khai.
