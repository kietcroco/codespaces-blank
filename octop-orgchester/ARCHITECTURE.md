# Kiến trúc & quy trình làm việc — Octop deployment

Tài liệu này mô tả cách 4 phần của hệ thống liên hệ với nhau, và là
**mẫu quy trình** để lần sau yêu cầu sửa/thêm tính năng mới mà không
cần giải thích lại từ đầu. Viết dựa trên kinh nghiệm thực tế xây dựng
tính năng **Agency** (phòng ban) — xem đó như ví dụ tham khảo xuyên
suốt tài liệu này.

Ngày viết: 2026-10-25.

## 1. Bốn phần, bốn vai trò

```
/workspaces/codespaces-blank/
├── Octop/                     upstream app thật (KHÔNG bao giờ sửa trực tiếp)
├── orchester/                 app tham khảo, CHỈ đọc để lấy ý tưởng/pattern
├── octop-orgchester/           <- bạn đang ở đây
│   ├── docker-compose.yml      cách CHẠY Octop (build từ ../Octop)
│   ├── .env                    biến môi trường cho container
│   ├── data/                   dữ liệu runtime (SQLite, config, log) — gitignored
│   ├── ARCHITECTURE.md         <- chính là file này
│   ├── scripts/                 rebuild.sh (reset+build+run+seed), seed-sample-data.sh
│   └── customize/               <- MỌI tính năng mới được soạn ở đây (git repo riêng)
│       ├── docs/design.md       thiết kế tính năng (1 file / tính năng, hoặc gộp)
│       ├── docs/superpowers/plans/   plan chi tiết (xem mục 4)
│       ├── backend/             file Python MỚI cho Octop (router, migration, test)
│       ├── dashboard/           file TSX MỚI cho dashboard Octop
│       ├── docs/patches/        patch cho file ĐÃ CÓ của Octop
│       ├── install.sh           script DUY NHẤT được phép ghi vào Octop/ thật
│       └── .claude/skills/run-octop/   skill chạy + test app bằng browser headless
└── graphify-out/, scripts/     tooling phụ, không liên quan kiến trúc này
```

- **`Octop/`**: source thật của app, build image Docker từ đây
  (`docker/Dockerfile`). Tôi (assistant) không bao giờ tự tay sửa file
  trong này — chỉ đọc để biết cấu trúc, và chỉ có **người dùng tự chạy**
  `customize/install.sh` mới được phép ghi vào đây.
- **`orchester/`**: app khác, kiến trúc tương tự nhưng có sẵn những thứ
  Octop chưa có (ví dụ: Team/Agent, org-chart). Dùng làm **tham khảo
  thiết kế** — copy *ý tưởng và kỹ thuật* (ví dụ hàm `bezier()` vẽ
  org-chart), không copy nguyên code vì 2 app khác framework UI.
- **`octop-orgchester/`**: nơi *chạy* Octop bằng Docker Compose, và nơi
  chứa `customize/` — lớp mở rộng cho Octop.
- **`customize/`**: git repo riêng (branch `main`), là **toàn bộ** nơi
  tôi được phép viết code. Có 2 loại nội dung:
  - **File mới hoàn toàn** (router, trang dashboard, test, migration) —
    nằm trực tiếp trong `backend/` / `dashboard/`, copy vào Octop bởi
    `install.sh`.
  - **Patch cho file đã có của Octop** (vd: mount router mới vào
    `app.py`, thêm 1 dòng route) — nằm trong `docs/patches/*.patch`,
    áp dụng bằng `git apply`, không bao giờ sửa trực tiếp.

## 2. Ràng buộc cốt lõi (không đổi giữa các tính năng)

1. **Không bao giờ ghi trực tiếp vào `Octop/` hay `orchester/`.** Mọi
   thứ soạn trong `customize/`. Chỉ `install.sh` (người dùng tự chạy)
   mới copy file/áp patch vào Octop thật.
2. **Patch càng ít càng tốt**, mỗi patch nhỏ, một mục đích rõ ràng, đặt
   tên theo số thứ tự (`01-...`, `02-...`, ...). Patch là diff thật
   (`git diff` trong 1 bản Octop sandbox đã sửa tay), không viết tay.
3. **Không thêm dependency JS/Python mới** nếu tránh được — ưu tiên kỹ
   thuật/pattern có sẵn trong `orchester/` nhưng viết lại bằng
   công nghệ của Octop (antd, không `framer-motion`/`@xyflow/react` nếu
   Octop chưa có).
4. **Không sửa file i18n chung** (`en.json`/`zh.json`) *trừ khi* không
   làm vậy sẽ để lộ literal key hoặc chữ tiếng Anh cứng giữa 1 form/menu
   đã dịch toàn bộ — khi đó thêm patch riêng cho locale, có lý do rõ
   ràng (xem `customize/.../progress.md` cũ, Ruling R4/R7 nếu cần tham
   khảo cách lập luận).
5. **Mọi migration SQL mới đọc trước** `ls Octop/src/octop/infra/db/migrations/`
   để lấy đúng số kế tiếp — và `install.sh` phải **từ chối cài** nếu số
   đó đã bị Octop phiên bản mới chiếm (xem mục "Upgrading" trong
   `customize/README.md` — bài học rút ra từ review tính năng Agency).
6. **Test thật, không mock hành vi cần kiểm chứng.** Backend: pytest
   tích hợp qua HTTP thật (`tests/integration/`). Frontend: vitest +
   Testing Library, chỉ mock `request`/API module, không mock component
   đang test hành vi.

## 3. Quy trình thêm 1 tính năng mới (mẫu, dựa trên Agency)

1. **Thiết kế** (`customize/docs/design.md`): mục đích, so sánh với
   pattern tương ứng trong `orchester/` nếu có, data model, API, danh
   sách file mới + patch cần thiết. Giữ ngắn, thực dụng — xem
   `docs/design.md` hiện tại làm mẫu văn phong.
2. **Viết plan chi tiết** (`customize/docs/superpowers/plans/`,
   dùng skill `superpowers:writing-plans`): chia theo task, mỗi task có
   bước TDD cụ thể (RED → implement → GREEN), **Review Focus** — liệt
   kê rõ các input/trường hợp mà code dễ sai (ownership, cascade-delete,
   empty-state, v.v.) để review sau này kiểm tra đúng chỗ.
3. **Thực thi plan** (skill `superpowers:executing-plans`): mỗi task
   build & test trong **sandbox Octop tạm** (`/tmp/octop-<tên>-sandbox`
   = `cp -r Octop/` + đã copy file mới/áp patch) — **không bao giờ**
   chạy trực tiếp trong `Octop/` thật. Mỗi patch capture bằng
   `git diff <file> > customize/docs/patches/NN-....patch` từ sandbox.
4. **Review toàn nhánh** trước khi merge: dispatch 1 subagent review
   độc lập (model mạnh nhất sẵn có), đối chiếu plan + Review Focus,
   phân loại Critical/Important/Minor. **Important trở lên phải sửa**
   (mỗi fix có test RED→GREEN riêng), Minor được phép hoãn nhưng phải
   ghi lại lý do.
5. **Dry-run cài đặt thật**: `cp -r Octop/` sạch → `install.sh` →
   `git apply --check` toàn bộ patch → áp thật → chạy full suite
   (`pytest` + `vitest run` + `tsc -b`) — đây là lần duy nhất cả tính
   năng được chứng minh hoạt động cùng nhau. So sánh test fail với
   **baseline Octop chưa patch** để tách lỗi có-sẵn khỏi lỗi mới gây ra.
6. **Merge** nhánh `customize/` vào `main` (hỏi người dùng: merge local
   / tạo PR / giữ nguyên — không tự quyết).
7. **Chưa xong ở bước 6** — patch mới chỉ nằm trong `customize/main`,
   **chưa** được cài vào `Octop/` thật hay vào image container đang
   chạy. Muốn thấy tính năng chạy thật, phải chạy
   `customize/install.sh <path-to-Octop>` rồi `docker compose up -d --build`
   — đây là hành động ghi vào `Octop/` thật nên **luôn hỏi xác nhận
   người dùng trước khi làm**, không tự ý chạy.

## 4. Vận hành container

**Dùng `scripts/rebuild.sh` cho mọi yêu cầu "build lại"/"chạy lại container"
từ đây về sau** (thêm 2026-10-25) — đây là quy trình chuẩn, không tự ý
chạy tay `docker compose up -d --build` nữa:

```bash
cd octop-orgchester/
bash scripts/rebuild.sh
```

`rebuild.sh` làm đúng thứ tự: `docker compose down -v --remove-orphans` →
xoá sạch `data/` (`rm -rf`, fallback `sudo rm -rf` nếu container ghi file
bằng root) → xoá image cũ (`docker rmi octop:latest`, giải phóng RAM/disk
cho bước build) → `docker compose build octop` → `docker compose up -d` →
chờ `/api/health` → tự chạy `scripts/seed-sample-data.sh` để có ngay dữ
liệu mẫu (xem mục 4.2). Nói cách khác: **mỗi lần chạy là một lần cài đặt
sạch hoàn toàn** — không có dữ liệu cũ sót lại, không cần nhớ thứ tự lệnh.

Chỉ cần re-seed mà không rebuild (container đang chạy, chỉ muốn làm mới
dữ liệu mẫu): `bash scripts/seed-sample-data.sh` (script này tự kiểm tra
idempotent — nếu đã có agency thì bỏ qua, không tạo trùng).

Các lệnh tay vẫn hữu ích khi debug từng bước riêng lẻ:

```bash
docker compose logs -f octop      # xem log
docker compose down -v --remove-orphans   # dừng, xoá container + network
sudo rm -rf ./data                # xoá sạch dữ liệu (SQLite, config, credential)
```

- `data/` mount vào `/data/.octop` trong container, **không phải** named
  volume — `docker compose down -v` không xoá được nó, phải `rm -rf`
  tay (cần `sudo` vì container ghi bằng root).
- Lần đầu khởi động (hoặc sau khi xoá `data/.initialized`), entrypoint
  tự chạy `octop init` và tạo admin:
  - Nếu `.env`'s `OCTOP_DEFAULT_PASSWORD` hợp lệ (≥8 ký tự, có chữ+số):
    tạo thẳng tài khoản `admin`, mật khẩu ghi vào
    `data/credential.txt`.
  - **`data/credential.txt` luôn là nguồn thật** cho mật khẩu đang chạy
    — `.env` có thể bị đổi *sau* lần init đầu mà container không biết
    (vì `.initialized` khiến lần khởi động lại bỏ qua `octop init`).
    Luôn đọc `credential.txt`, đừng tin `.env` nếu container đã chạy
    được một thời gian.
- `curl -sf http://localhost:8088/api/health` → `200` là dấu hiệu init
  thành công tối thiểu; log sạch (`docker compose logs octop`) không có
  gì ngoài 1 warning vô hại của onnxruntime (PCI bus id, do chạy trong
  máy ảo) là xác nhận đầy đủ.

### 4.1. Build hết RAM (OOM) khi bundle frontend — gặp 2026-10-25

Sandbox này **không có swap** (`free -h` → `Swap: 0B`) và phần lớn RAM
(~5.5/7.8GB) đã bị IDE/Claude Code chiếm thường trực, nên bước
`vite build` (stage `frontend-builder`) có thể bị kernel OOM-kill giữa
chừng ở "transforming..." — dấu hiệu: log chỉ in `Terminated`, không có
thông báo lỗi rõ ràng, exit code `143`. Đã thử đổi
`NODE_MAX_OLD_SPACE_SIZE` (1024/2048/3072) — **không giải quyết được**,
vì đây là OOM ở tầng hệ điều hành (tiến trình bị kill từ ngoài), không
phải V8 tự hết heap (trường hợp đó sẽ có log `FATAL ERROR: ... heap out
of memory` rõ ràng, xảy ra ở cap 1024 nhưng không xảy ra ở cap mặc định
2048 — tức giới hạn thật nằm ở RAM hệ thống, không phải ở cap Node).

**Cách đã sửa được:** tạo swap tạm trên `/tmp` (ext4 thật — swapfile
**không** tạo được trên overlay root fs, `swapon` báo "Invalid
argument"):

```bash
sudo fallocate -l 4G /tmp/swapfile && sudo chmod 600 /tmp/swapfile
sudo mkswap /tmp/swapfile && sudo swapon /tmp/swapfile
```

Sau khi bật swap, build qua được bình thường với cap mặc định (2048).
Swap này tồn tại tới khi host reboot hoặc `sudo swapoff /tmp/swapfile`;
không ảnh hưởng dữ liệu/container. Nếu gặp lại lỗi này ở máy/server
khác có swap sẵn thì bỏ qua mục này.

### 4.2. Dữ liệu mẫu (seed) — `scripts/seed-sample-data.sh`

`rebuild.sh` tự gọi script này ở bước cuối, nhưng cũng chạy được riêng
trên container đang sống (`bash scripts/seed-sample-data.sh`, không
build/restart gì cả):

- Đăng nhập bằng API (`/api/auth/login`), đọc mật khẩu từ
  `data/credential.txt` (nguồn thật — xem mục 4), **không** phải qua
  trình duyệt — vì vậy không đụng tới captcha kéo-thả (server bỏ qua
  captcha khi không có token, do caption mặc định `requires_token=False`,
  xem `src/octop/infra/auth/captcha/verify.py`).
- Idempotent, theo 2 bước độc lập:
  - `GET /api/admin/providers` trước — nếu đã có ≥1 provider thì bỏ qua
    bước tạo provider placeholder (xem dưới và mục 5).
  - `GET /api/agencies` trước — nếu user admin đã có ≥1 agency thì bỏ
    qua toàn bộ phần agency/expert, không tạo trùng.
  - Muốn seed lại từ đầu: chạy `rebuild.sh` (xoá data trước) hoặc tự xoá
    agency/provider qua dashboard/API rồi chạy lại.
  - **Không chạy song song 2 lần** (vd: 1 lần tay + 1 lần từ tiến trình
    nền/loop khác) — 2 lệnh `GET /api/agencies` gần như đồng thời có
    thể đều thấy "0 agency" trước khi lệnh kia kịp tạo xong, dẫn tới
    agency bị tạo trùng tên (gặp thật ngày 2026-10-25 khi 1 lượt chạy
    tay trùng với 1 wakeup nền đang cài đặt — dọn bằng cách
    `rebuild.sh` lại từ đầu, không sửa tay từng bản ghi trùng).
- Trước khi tạo agency: tạo 1 provider placeholder
  (`octop-test-provider`, kind `openai`, model `gpt-4o-mini`,
  `api_key` giả) và đặt làm active-model toàn hệ thống — xem mục 5 để
  biết giới hạn (không chat được) và cách thay bằng key thật.
- Dữ liệu tạo ra: 6 agency kiểu công ty phần mềm — **Sales để trống**
  (test case "agency chưa có expert nào"), **Engineering/Product/
  Design/QA/DevOps & Infra** mỗi phòng 2 expert (10 expert tổng, đủ để
  org chart có nhiều node/nhiều hàng, test được cả kéo-thả lẫn
  wrap-row). Mỗi expert được gán `default_model` trỏ về provider
  placeholder ở trên — đủ để test UI Agency/Org Chart/Experts (Models
  UI không còn trống), **không đủ để test chat thật** (xem mục 5).

### Container không có internet ra ngoài

Trong môi trường sandbox hiện tại, container `octop` **không resolve
được DNS lẫn không kết nối TCP thẳng ra ngoài** — đã xác minh bằng
`docker exec octop curl ...` (timeout) trong khi host gọi cùng URL bình
thường. Bất kỳ provider LLM nào gọi ra ngoài (OpenAI-compatible, v.v.)
sẽ **cấu hình đúng nhưng không chat được** khi test từ container này.
Không phải lỗi cấu hình — là giới hạn mạng của container trong sandbox
này, chỉ hết khi chạy ở máy/server thật có internet.

## 5. Cấu hình Provider LLM

> **Cập nhật 2026-10-26:** seeder mới `scripts/seed-sample-data.py` (stdlib, không cần `jq`) thay phần seed cũ; `docker compose up` tự chạy qua service `seed` (idempotent). Tạo provider `vietapi` (OpenAI-compatible) + 6 agency + 10 expert + 2 flow mẫu (Feature Delivery, Bug Triage). Key đọc từ `.env.seed` (gitignore; mẫu: `.env.seed.example`) — không commit key. Đã chạy thử flow Bug Triage với model thật: `succeeded`.

**Từ 2026-10-25, `scripts/seed-sample-data.sh` tự tạo sẵn 1 provider
placeholder** (`octop-test-provider`, kind `openai`, model `gpt-4o-mini`)
và đặt làm active-model toàn hệ thống, để Models UI và `default_model`
của mỗi expert mẫu không còn trống — xem mục 4.2. **Đây KHÔNG phải key
thật** (`api_key: "sk-placeholder-not-a-real-key"`) và container không
có internet ra ngoài trong sandbox này (xem phần dưới) nên **không chat
được** bằng provider này — nó chỉ giải quyết phần hiển thị UI khi test
Agency/Org Chart/Experts. Muốn chat thật: thay provider này bằng key
thật qua chính quy trình thủ công bên dưới (cùng `name` để expert khỏi
phải gán lại `default_model`), hoặc tạo provider khác rồi đổi
`default_model` qua dashboard/API.

**`.env`'s `OPENAI_API_KEY` / `DASHSCOPE_API_KEY` KHÔNG được code Octop
đọc** (đã grep toàn bộ `src/` — không chỗ nào dùng 2 biến này). Đừng để
`.env` đánh lừa — chúng là biến mẫu chưa nối với code, không phải cơ chế
cấu hình provider thật.

Cách thật để thêm 1 provider (OpenAI-compatible hoặc khác) là gọi admin
API của Octop đang chạy:

```python
# 1. Login lấy token (đọc mật khẩu từ data/credential.txt, không phải .env)
POST /api/auth/login {"username": "admin", "password": "<từ credential.txt>"}

# 2. (tuỳ chọn) Lấy danh sách model — nếu container không ra internet được,
#    gọi GET <base_url>/models trực tiếp từ HOST (không qua container) rồi
#    điền tay vào bước 3.
POST /api/admin/providers/fetch-models {"kind": "openai", "base_url": ..., "api_key": ...}

# 3. Tạo provider
POST /api/admin/providers {"name": ..., "kind": "openai", "base_url": ..., "api_key": ..., "models": [...]}

# 4. Đặt làm model mặc định toàn hệ thống (không bắt buộc)
PUT /api/providers/active-model {"provider_name": ..., "model": ...}
```

Provider tạo bằng API này lưu trong `octop.db` (SQLite) — **mất khi
`rm -rf data/`**, phải tạo lại sau mỗi lần reset container.

## 6. Kiểm thử / Test UI bằng trình duyệt headless

`customize/.claude/skills/run-octop/` — Playwright (Chromium headless)
+ driver REPL (`driver.mjs`) điều khiển dashboard thật qua trình duyệt.
Dùng khi cần xác nhận UI chạy đúng (không chỉ unit test), ví dụ: login,
chụp màn hình, kiểm tra 1 tính năng mới có hiện đúng không.

Lưu ý quan trọng đã rút ra khi xây driver này (xem
`run-octop/SKILL.md` để biết đầy đủ):
- `chromium-cli` (gợi ý trong skill `run` gốc) **không tồn tại thật** —
  tên package giả, dùng thẳng `playwright`'s `chromium` launcher.
- Trang login có **slide-to-verify captcha** (kéo chuột, xác minh phía
  client, không round-trip server) — phải kéo bằng `page.mouse`
  (driver có sẵn lệnh `slide-captcha`), không click DOM thường.
- UI mặc định tiếng Trung — chọn selector theo nhãn tiếng Trung
  (`模型` = Models, v.v.) nếu không set `Accept-Language`.

```bash
cd octop-orgchester/.claude/skills/run-octop
node driver.mjs
# hoặc wrap trong tmux để lặp lệnh — xem SKILL.md
```

## 7. Trạng thái hiện tại (snapshot 2026-10-25, cập nhật sau khi cài thật)

- **Tính năng Agency**: đã **cài vào `Octop/` thật** (10 patch áp bằng
  `git apply`, commit riêng `ae3df30a "feat: add Agency (department)
  feature"` trong lịch sử git của `Octop/`) và đã **rebuild image +
  chạy container** — menu "Agency" hiện có thật trên dashboard đang
  chạy, đã xác nhận bằng browser thật (login, tạo agency, xem
  Org Chart — không lỗi console).
- **Tính năng Flow**: đã **cài vào `Octop/` thật** ngày 2026-10-25
  (patch 13-16 + file mới áp trực tiếp — `install.sh` wrapper tự chặn
  ở bước kiểm tra migration 022 do nợ kỹ thuật cũ của Agency, xem
  mục 9.1 — nên cài tay đúng những gì `install.sh` lẽ ra làm, đã verify
  bằng `pytest` 12/12 ngay trong `Octop/` trước khi commit riêng
  `67a88deb "feat: add Flow (pipeline builder) feature"`) và đã
  **rebuild image + chạy container**. Xác nhận bằng browser thật qua
  skill `run-octop`: menu "流程" hiện đúng, tạo flow mới → canvas load
  (4 loại node Trigger/Agent/Condition/End), đổi tên flow, Save, Run
  (status `succeeded`, đúng case "trigger không có outgoing edge thì
  dừng sạch"), nút History riêng mở đúng tab lịch sử **không tạo thêm
  run mới** dù bấm lại nhiều lần (đúng fix I2 của final review, xem
  mục 9.1), Delete có confirm và xoá sạch — không lỗi console ở bất kỳ
  bước nào.
- **Phase roadmap #1 (status gate)**: đã **cài vào `Octop/` thật** ngày
  2026-10-25, cùng ngày merge (xem mục 9.1b) — áp patch 17 bằng `git
  apply` + copy tay 3 file (`flow.py`, `FlowCanvas.tsx`,
  `RunResultDrawer.tsx`), verify `pytest`/`vitest` ngay trong `Octop/`
  (8/8 + 10/10) trước khi commit riêng `9874f0f8` trong lịch sử git của
  `Octop/`, rồi **rebuild image + chạy container** (cần tạo swap tạm
  trước, xem mục 4.1 — RAM trống lúc đó chỉ ~200Mi). Xác nhận bằng
  browser thật qua skill `run-octop`: tạo flow mới (mặc định "Draft"),
  thêm node Trigger, bấm Run lúc còn Draft → toast lỗi sạch "flow must
  be active to run — activate it first" (không phải JSON thô, không
  crash) — chứng minh cả chuỗi 409 backend → `apiErrorMessage()` →
  toast hoạt động đúng trên container thật, không chỉ trong test. Bấm
  nút Activate mới → tag "Draft"→"Active", nút "Activate"→"Deactivate".
  Run lại → `succeeded` ("No steps", đúng case trigger không có cạnh
  ra). Không lỗi console mới ở bước nào.
- **Dữ liệu mẫu**: tự động seed bằng `scripts/seed-sample-data.sh` (gọi
  từ `scripts/rebuild.sh`, xem mục 4.2) — 6 agency kiểu công ty phần
  mềm (Sales rỗng + Engineering/Product/Design/QA/DevOps & Infra mỗi
  phòng 2 expert, 10 expert tổng) và 1 provider placeholder
  (`octop-test-provider`) đặt làm active-model, xem mục 5.
- **Container**: healthy, rebuild bằng `scripts/rebuild.sh` — **đã gồm
  cả 2 fix ở mục 8** (scroll Agency list + kéo-thả Org Chart), Flow
  (mục 9.1-9.2), và `@xyflow/react` dependency; đã xác nhận qua API
  thật (6 agency đúng member_count, provider + active-model đúng) và
  qua browser thật (Flow CRUD + run, mục này) ngày 2026-10-25.
- **Provider LLM**: có 1 provider placeholder (không chat được thật,
  xem mục 5) — thay bằng key thật khi cần test chat. Lưu ý: node
  `agent` của Flow gọi qua cùng cơ chế agent thật của Octop, nên cũng
  **không chat được thật** với provider placeholder này, cùng lý do.

- **Cập nhật 2026-10-26 (phiên làm phase #2):**
  - **Roadmap Flow: 38 mục (§9.2), xong 2 — #1 (gate `flows.status`) và #2
    (retry node agent: `max_retries` 0–5, `retry_delay` 0–30s).** #2 đã
    merge vào `main` (commit `0710927`), **chưa cài vào `Octop/` thật**
    (hướng dẫn copy tay: `customize/README.md`). **Cập nhật cuối phiên: #3 (validate tĩnh), #4 (dry-run), #5 (MiniMap), #6 (panel tài liệu) và #7 (filter template) và #8 (template mẫu) và #9 (versioning) đã xong và merge vào `main`**
    (chưa cài vào `Octop/`). Việc kế tiếp: **#10 AI copilot tạo flow từ mô tả** (effort lớn nhất, cần bàn kỹ trước), rồi nhóm A (#11–18)… Mục #11–38 là phần bổ sung sau khi so sánh với orchester.
  - **Cách test trên Windows (Docker):** `bash scripts/sandbox/setup.sh`
    (1 lần: clone Octop ở commit nền `6797d0e4` — vì `Octop/` HEAD đã mới
    hơn, trùng migration 022–024 và patch không áp được — rồi cài Agency +
    Flow, build 2 image test) → `scripts/sandbox/sb.sh sync|py|ui`. Đặt
    `CUSTOMIZE=<customize/ của worktree>` khi làm trong worktree. Baseline:
    backend 33 test (engine + flow API + agency API), dashboard Flows 16 test.
    `setup.sh` chưa được chạy end-to-end từ trạng thái trống (mới chạy
    `sb.sh` trên sandbox có sẵn).
  - **Container đang chạy** từ image `octop:latest` build từ sandbox (không
    phải từ `Octop/` thật): `docker compose up -d` trong `octop-orgchester/`,
    http://localhost:8088, mật khẩu admin ở `data/credential.txt`. Service
    `seed` tự nạp dữ liệu mẫu (xem §5): provider `vietapi`, 6 agency, 10
    expert, 2 flow (Feature Delivery, Bug Triage). API key để trong
    `.env.seed` (gitignore, mẫu `.env.seed.example`).
  - Chưa commit: `ARCHITECTURE.md`, `docker-compose.yml`, `.gitignore`,
    `scripts/seed-sample-data.{py,sh}`, `scripts/sandbox/`, `.env.seed.example`.

## 8. Backlog — việc cần làm lượt sau (phát hiện khi test dữ liệu mẫu)

Hai vấn đề UI phát hiện khi test tính năng Agency với dữ liệu mẫu
(6 agency, 10 expert). **Cả 2 đã sửa ngày 2026-10-25** (xem ghi chú "Đã
sửa" ở cuối mỗi mục) — **lưu ý quy trình:** lần sửa này được yêu cầu
trực tiếp giữa 1 phiên chat khác, assistant đã sửa **thẳng vào
`Octop/dashboard/`** thay vì soạn trong `customize/` trước rồi mới cài
như quy trình mục 3 quy định. Đã backfill lại cho đúng kiến trúc sau đó:
bản copy trong `customize/dashboard/pages/Agency/` đã đồng bộ lại cho
khớp, và phần sửa `dashboard/package.json`/`package-lock.json` (thêm
`@xyflow/react`) đã được đóng gói thành
`customize/docs/patches/11-dashboard-package-xyflow-dependency.patch`
(patch cho file đã có, đúng quy ước). CHANGELOG.md cũng sửa trực tiếp,
đóng gói thành patch `12-changelog-agency-fixes.patch`. Image container
tại thời điểm snapshot cũ (mục 7) **chưa có 2 fix này** — cần
`docker compose up -d --build` lại để phản ánh.

### 8.1. (Đã sửa) Trang "Departments" (danh sách Agency) không scroll được

**Triệu chứng:** khi số lượng Agency đủ nhiều (vượt 1 màn hình), không
cuộn được để xem hết danh sách.

**File:** `customize/dashboard/pages/Agency/index.tsx` — nghi vấn chính
(chưa xác nhận bằng cách fix thử):
- Trang tự vẽ `<div style={{ padding: 24 }}>` bọc `<Tabs>` trực tiếp,
  **không dùng `PageShell`** — trong khi các trang list tương tự của
  Octop (ví dụ `src/pages/Experts/index.tsx`) đều bọc bằng
  `PageShell.FillTabs` (`src/layouts/PageShell.tsx`).
- `PageShell` có cơ chế `pinBody` (`Boolean(fill || ...)`) quyết định
  `overflowY: pinBody ? "hidden" : "auto"` cho vùng nội dung — đây là
  cách chuẩn của Octop để 1 trang có scroll riêng bên trong khung app
  cố định. Agency page bỏ qua cơ chế này hoàn toàn nên không có gì đảm
  bảo scroll hoạt động đúng trong mọi kích thước màn hình/số lượng item.
- **Hướng sửa gợi ý:** đổi `AgencyPage` sang bọc bằng
  `PageShell.FillTabs` (hoặc biến thể phù hợp) giống `Experts/index.tsx`
  thay vì tự vẽ `<Tabs>` trần — cần đọc kỹ API của `PageShell.FillTabs`
  (props `fill`, cách truyền `items` cho Tabs) trước khi đổi, vì đây là
  thay đổi cấu trúc component, không phải patch 1 dòng.
- Đây là file **mới hoàn toàn** của Agency (không phải patch lên file
  có sẵn của Octop) nên sửa trực tiếp trong `customize/dashboard/pages/Agency/index.tsx`
  rồi cập nhật lại bản copy trong `Octop/dashboard/src/pages/Agency/index.tsx`
  (hoặc chạy lại `install.sh` + copy tay, xem mục 3 bước 3).

**Đã sửa:** đổi `AgencyPage` sang bọc bằng `PageShell.FillTabs` đúng
hướng gợi ý ở trên — tiêu đề "Agencies" + nút "New Agency" chuyển vào
slot `actions` của title row, bỏ `<h2>` + hàng nút tự vẽ cũ. Xác nhận
bằng `vitest run src/pages/Agency` (12/12 pass, không sửa test nào) và
`tsc --noEmit` sạch.

### 8.2. (Đã sửa) Org Chart không kéo-thả (drag) được node, khác với orchester

**Triệu chứng:** `customize/dashboard/pages/Agency/components/AgencyOrgChart.tsx`
chỉ vẽ sơ đồ **tĩnh** bằng SVG (bezier path tự tính layout, port 1-1 từ
`orchester/apps/web/components/org/OrgChart.tsx`) — không kéo/di
chuyển node, không zoom/pan.

**Đây là quyết định thiết kế có chủ đích từ đầu**, ghi rõ trong
`customize/docs/design.md` mục Non-goals: *"Không port `OrgCanvas.tsx`
(bản `@xyflow/react`, có zoom/pan/kéo-thả) — chỉ port bản tĩnh
`OrgChart.tsx` để tránh thêm dependency"* — lúc đó ưu tiên "không thêm
dependency JS mới" (ràng buộc mục 2 ở trên) cao hơn tính năng kéo-thả.

Bên orchester, bản **có** kéo-thả là
`orchester/apps/web/components/org/OrgCanvas.tsx`, dùng
`@xyflow/react` (`^12.11.2`, xem `orchester/apps/web/package.json`),
lấy dữ liệu từ `GET /api/org-graph` (khác route với bản tĩnh).

**Nếu lượt sau quyết định đánh đổi** (chấp nhận thêm `@xyflow/react`
vào `Octop/dashboard/package.json` để có kéo-thả thật):
1. Đây là **thay đổi ràng buộc đã thống nhất** ("không thêm
   dependency") — nên **hỏi lại người dùng xác nhận** trước khi làm,
   không tự quyết.
2. Tham khảo `OrgCanvas.tsx` bên orchester cho logic node/edge + cấu
   hình `@xyflow/react`, nhưng viết lại bằng dữ liệu của Agency API
   (`GET /api/agencies/org-chart`) — không copy nguyên vì khác data
   shape (orchester dùng Workspace → Team → Agent, 3 tầng; Agency chỉ
   2 tầng Agency → Expert).
3. Cần patch thêm `Octop/dashboard/package.json` + `package-lock.json`
   (thêm dependency mới) — đây là patch lớn hơn các patch hiện có, nên
   cân nhắc tách thành 1 task riêng trong plan, có Review Focus riêng
   cho hiệu năng render khi nhiều node (vấn đề orchester's OrgCanvas đã
   phải xử lý mà bản tĩnh hiện tại không gặp).

**Đã sửa (đánh đổi ràng buộc "không thêm dependency" ở trên — xem ghi
chú ở đầu mục 8):** thêm `@xyflow/react@^12.12.0` vào
`dashboard/package.json`; viết lại `AgencyOrgChart.tsx` bằng `ReactFlow`
— 2 node type `agency`/`expert` (dựa theo `AgentNode`/`TeamNode` của
`OrgCanvas.tsx` nhưng dùng data shape 2 tầng của Agency API, không copy
nguyên), `nodesDraggable` bật, vị trí kéo-thả lưu `localStorage`
(`octop:agency-org-chart:positions`, cùng cơ chế `userMovedRef` của
orchester), edge nối agency→expert tự vẽ lại theo vị trí node sau khi
kéo. `nodesConnectable` tắt (giống orchester — orchester cũng không cho
tự nối tay, quan hệ agency↔expert vẫn đến từ backend, chỉ vị trí node
là kéo được). Review Focus về hiệu năng nhiều node **chưa làm** (dữ liệu
mẫu hiện tại chỉ 6 agency/10 expert, chưa stress-test); để lượt sau nếu
số lượng thực tế lớn hơn nhiều. Xác nhận bằng `vitest run src/pages/Agency`
(12/12 pass, không sửa logic test — chỉ cần thêm `initialWidth`/`handles`
tĩnh cho mỗi node để edge có vị trí vẽ trước khi `ResizeObserver` đo
xong, xem comment trong code) + `tsc --noEmit` sạch.

## 9. Khi được yêu cầu sửa/thêm tính năng mới

Dùng lại đúng quy trình ở mục 3, với `customize/docs/design.md` /
`customize/docs/superpowers/plans/2026-10-24-agency-feature.md` làm ví
dụ tham khảo cụ thể (cấu trúc file, cách viết Review Focus, cách tổ
chức patch). Nếu tính năng mới liên quan đến **Agency** đang có, mở
rộng trực tiếp trong `customize/` (thêm patch/file mới, không viết lại
từ đầu). Nếu là tính năng **độc lập**, tạo thư mục con tương ứng trong
`customize/backend/` và `customize/dashboard/`, giữ nguyên các ràng
buộc ở mục 2.

### 9.1. Tính năng Flow — **HOÀN TẤT, đã merge vào `customize`'s `main`** (cập nhật 2026-10-25)

Tham khảo từ orchester's Flow (đồ thị multi-node người dùng tự
kéo-thả-nối, chạy nhiều bước, có lịch sử). Thiết kế + plan đã xong từ
trước; thực thi qua skill `superpowers:subagent-driven-development`
trên 2 phiên (1 phiên làm Task 1-6 + bắt đầu Task 7, phiên sau resume
đúng từ ledger và hoàn tất Task 7-8 + final whole-branch review + 1 fix
wave + merge).

- Thiết kế: `customize/docs/design-flow.md`.
- Plan: `customize/docs/superpowers/plans/2026-10-25-flow-feature.md`
  — 8/8 task hoàn tất, mỗi task có fresh implementer subagent + task
  review riêng (Task 4, 5, 7, 8 có 1 vòng fix loop mỗi task vì review
  tìm ra lỗi thật).
- **Merge:** nhánh `worktree-flow-feature` (tách từ `main`@`b7019ba`)
  đã fast-forward merge vào `main` tại commit **`47275a8`**
  (2026-10-25). Worktree + nhánh đã xoá sau merge (theo skill
  `finishing-a-development-branch`). Ledger SDD đầy đủ (mọi ruling,
  mọi review verdict của 8 task) đã xoá theo đúng quy trình
  `final-review.md` — git history (`git log main` trong `customize/`)
  là record giờ đây, không còn file ledger riêng.
- **Final whole-branch review (sau khi cả 8 task đã pass review riêng)
  phát hiện 1 lỗi Critical thật, không task nào bắt được:** router
  (`backend/routers/flow.py`) giải mã thẳng JSON lưu từ frontend (dạng
  `@xyflow/react` thô — `position`, `data.config` camelCase
  `agentId`/`outputVar`, `sourceHandle`) vào dataclass của engine
  (dạng phẳng, snake_case) mà **không có tầng dịch** — mọi flow build
  từ UI bấm "Run" đều lỗi 500 (test backend PATCH JSON dạng engine
  trực tiếp, test frontend mock `request()`, không có test nào bắc
  cầu qua ranh giới thật). Cộng 3 lỗi Important: Run dùng graph đã lưu
  cũ, không phải canvas hiện tại; xem lịch sử lại tự kích hoạt 1 lần
  chạy mới; chưa có UI xoá/đổi tên flow (spec hứa "tạo/sửa/xoá"). Cả 4
  đã sửa trong **1 fix wave duy nhất** (commit `4d5179d` + `47275a8`)
  + 1 vòng re-review scoped xác nhận sạch, trước khi merge.
  **Bài học cho các tính năng sau:** review từng task riêng (per-task
  review) không đủ để bắt lỗi ở đúng ranh giới frontend↔backend —
  final whole-branch review là bước bắt buộc của quy trình
  `subagent-driven-development`, không phải thủ tục hình thức.
- 10 lỗi Minor (run timestamp ghi sau khi chạy xong nên vô nghĩa, hiển
  thị epoch thô trong lịch sử, key React trùng khi chạy cyclic, v.v.)
  được cố ý "park" lại, không chặn merge — xem commit message của
  `4d5179d`/`47275a8` hoặc `git log main` trong `customize/` nếu cần
  chi tiết đầy đủ (ledger gốc đã xoá theo quy trình).
- **Đã cài vào `Octop/` thật** (2026-10-25, commit `67a88deb` trong
  lịch sử git của `Octop/`) và **đã xác nhận qua browser thật** — xem
  mục 7 để biết chi tiết đầy đủ (menu, canvas, Save/Run/History/Delete
  đều test qua browser headless thật, không lỗi console).
  `install.sh`'s wrapper vẫn tự chặn khi chạy thẳng vào `Octop/` thật
  (do nợ kỹ thuật cũ của Agency — patch 1-12 chưa được "retire" trong
  `customize/`, không liên quan Flow) nên lần cài này áp trực tiếp
  đúng những gì `install.sh` lẽ ra làm (file mới + patch 13-16 qua
  `git apply`), đã verify bằng `pytest` 12/12 ngay trong `Octop/`
  trước khi commit. Dọn nợ kỹ thuật này (để `install.sh` chạy thẳng
  được, không cần cài tay) vẫn là việc riêng, chưa làm — không chặn
  Flow, chỉ là bất tiện cho lần cài tính năng tiếp theo.

### 9.1b. Phase roadmap #1 — gắn `flows.status` vào `/run` — **HOÀN TẤT, đã merge vào `customize`'s `main`** (2026-10-25)

Đóng mục 1 của roadmap ở §9.2 bên dưới: `flows.status` ("draft"/"active")
có trong DB/API từ V1 nhưng chưa được đọc ở đâu — 1 flow `draft` chạy
y hệt `active`. Phase này wire nó vào thật.

- Plan: `customize/docs/superpowers/plans/2026-10-25-flow-status-gate.md`
  — 2 task, mỗi task 1 implementer subagent + 1 task review riêng, rồi
  1 final whole-branch review (model mạnh nhất) + 1 fix wave (doc-only)
  + 1 scoped re-review, qua `superpowers:subagent-driven-development`.
- **Backend:** `POST /flows/{flow_id}/run` giờ trả `409 FLOW_NOT_ACTIVE`
  nếu `status != "active"`, kiểm tra ngay sau ownership guard và trước
  khi parse graph. Error code mới (`ErrorCode.FLOW_NOT_ACTIVE`, map
  409, theo đúng khuôn `AGENT_NOT_RUNNING`) không thể soạn trực tiếp
  trong `customize/` (phải là enum member thật trong `Octop/src/octop/
  infra/errors.py`) nên ra đời dưới dạng patch mới:
  `docs/patches/17-errors-add-flow-not-active.patch`.
- **Frontend:** `FlowCanvas.tsx` có thêm nút Activate/Deactivate
  (PATCH `{status}`) — trước phase này **không có cách nào** đổi status
  từ UI, mọi flow tạo ra đều kẹt ở `draft` vĩnh viễn.
  `RunResultDrawer.tsx`'s thông báo lỗi khi Run thất bại đổi từ hiện
  nguyên chuỗi JSON thô sang dùng `apiErrorMessage()` có sẵn của
  dashboard — quan trọng vì lỗi 409 mới này sẽ gặp thường xuyên.
- 6 test backend cũ (gọi `/run` mà chưa từng set status) được sửa để
  activate flow trước khi run; 1 test mới xác nhận flow `draft` bị
  chặn 409.
- **Final whole-branch review tìm đúng 1 lỗi Important (doc-only):**
  chưa có hướng dẫn nâng cấp cho 1 checkout đã cài sẵn V1 (patch
  01-16) — `install.sh` sẽ tự chặn vì patch cũ báo "already applied";
  copy tay thiếu patch 17 thì `flow.py` mới sẽ `AttributeError` (500)
  thay vì 409 sạch; mọi flow cũ trong DB sẽ bắt đầu trả 409 cho đến khi
  ai đó bấm Activate. Đã thêm mục hướng dẫn riêng trong
  `customize/README.md` (sau mục "Upgrading") + 1 dòng trỏ trong
  `design-flow.md` §11. Vòng re-review đầu phát hiện câu lệnh `git
  apply` mẫu dùng đường dẫn tương đối sai chỗ (`git -C` resolve theo
  thư mục đích, không theo cwd) — theo đúng `final-review.md` (không
  có fix wave thứ 2 cho final review), controller tự sửa 1 dòng này
  thay vì dispatch thêm 1 vòng subagent, ghi lại minh bạch trong ledger
  (đã xoá cùng workspace sau khi merge).
- **Merge:** nhánh `worktree-flow-status-gate` (tách từ `main` tại
  `1fc9b5a`) merge (3-way, không fast-forward được vì `main` có 2 commit
  nhiễu không liên quan — implementer Task 2 lỡ commit nhầm vào `main`
  rồi tự phát hiện + revert sạch trước khi làm lại đúng trong worktree)
  vào `main` tại commit `1d5a86b`. Test lại sau merge: 8/8 backend +
  10/10 frontend xanh. Worktree + nhánh đã xoá sau merge.
- **Đã cài vào `Octop/` thật** (cùng ngày, theo yêu cầu rõ của người
  dùng) — xem mục 7 để biết chi tiết đầy đủ (patch 17 + 3 file áp trực
  tiếp theo đúng hướng dẫn upgrade ở `customize/README.md`, commit
  `9874f0f8` trong lịch sử git của `Octop/`, rebuild + xác nhận qua
  browser thật).

### 9.2. Roadmap Flow — so sánh với orchester (gap analysis, 2026-10-25)

V1 Flow chỉ có 4 loại node, chạy đồng bộ — **chủ đích tối giản**, xem
Non-goals ở `design-flow.md` §3/§10. So với tính năng Flow đầy đủ bên
`orchester` (`orchester/apps/web/lib/flows/`,
`orchester/apps/web/components/flows/`, ~85 file: 29 loại node,
pause/resume/retry/dry-run, versioning, template, AI copilot tạo flow,
validate, docs panel, RLS theo workspace), đã làm 1 báo cáo gap đầy đủ
trong phiên chat 2026-10-25 (không lưu thành file riêng trong repo).
Top ưu tiên cho roadmap, dự kiến mỗi mục làm ở 1 phase/phiên chat mới:

1. ~~Gắn cột `flows.status` vào logic `/run`~~ — **xong, xem §9.1b.**
2. ~~Retry cho node `agent` khi gọi lỗi tạm thời~~ — **xong (2026-10-26, merge vào `main`; chưa cài vào `Octop/`)**. Config node `max_retries` (0–5, mặc định 0) + `retry_delay` (0–30s, mặc định 1s); lỗi agent không tồn tại/không thuộc user không retry. Không patch/migration mới. Plan: `customize/docs/superpowers/plans/2026-10-26-flow-agent-retry.md`; hướng dẫn nâng cấp: `customize/README.md`. Việc để dành cho #3: node agent chưa chọn agent (`agent_id=None`) hiện có thể bị retry vô ích — validate tĩnh nên chặn.
3. ~~Validate tĩnh~~ — **xong (2026-10-26, merge vào `main`; chưa cài vào `Octop/`)**. Module `flows/validate.py` (12 lỗi + 3 cảnh báo), endpoint `POST /flows/{id}/validate`; chặn kích hoạt (`PATCH status=active`) và `/run` khi còn lỗi (422), lưu nháp không bị chặn; canvas có nút Validate, panel lỗi, viền đỏ node. Không patch/migration mới. Plan: `customize/docs/superpowers/plans/2026-10-26-flow-static-validate.md`.
4. ~~Dry-run mode~~ — **xong (2026-10-26, merge vào `main`; chưa cài vào `Octop/`)**. `POST /flows/{id}/run` nhận `dry_run: true`: thay `call_agent` bằng stub `[dry-run] agent <id> would receive: <prompt>`, không gọi/tra agent, không ghi lịch sử, cho phép chạy flow nháp; vẫn kiểm tra quyền sở hữu và validate tĩnh. Canvas có nút "Dry run". Plan: `customize/docs/superpowers/plans/2026-10-26-flow-dry-run.md`.
5. ~~MiniMap trên canvas~~ — **xong (2026-10-26, merge vào `main`; chưa cài vào `Octop/`)**. `<MiniMap pannable zoomable>` tô màu theo loại node (`minimapNodeColor`). Plan: `customize/docs/superpowers/plans/2026-10-26-flow-minimap.md`.
6. ~~Panel tài liệu mô tả flow~~ — **xong (2026-10-26, merge vào `main`; chưa cài vào `Octop/`)**. Drawer "Docs" trên canvas (markdown, Edit/Preview, nút Use template), lưu vào cột `flows.description` (giới hạn 20000 ký tự, không migration); thẻ flow ở danh sách chỉ hiện bản tóm tắt một dòng. Lưu ý còn tồn: preview dùng `LazyMarkdown` của Octop, mermaid ở đó để `securityLevel: "loose"` (vấn đề có sẵn của Octop, không thuộc `customize/`). Plan: `customize/docs/superpowers/plans/2026-10-26-flow-docs-panel.md`.
7. ~~Cú pháp filter template `{{path|filter:arg}}`~~ — **xong (2026-10-26, merge vào `main`)**. Module `flows/template.py`: đường dẫn chấm (`{{user.name}}`, `{{items.0}}`), 7 filter (`upper lower trim default truncate length json`), lỗi template thành step failed `template error: ...` và bị validate tĩnh chặn (`bad_template`). Lưu ý: biến có giá trị `None` giờ render rỗng thay vì "None". Plan: `customize/docs/superpowers/plans/2026-10-26-flow-template-filters.md`.
8. ~~Template mẫu khởi tạo flow~~ — **xong (2026-10-26, merge vào `main`)**. Nút "From template" ở trang Flows (modal 3 mẫu: Ask an agent, Branch on a reply, Two-step pipeline; `flowTemplates.ts`), tạo flow + nodes/edges + mô tả markdown; agent để trống, phải chọn trước khi kích hoạt. Chỉ frontend. Plan: `customize/docs/superpowers/plans/2026-10-26-flow-templates.md`.
9. ~~Flow versioning (snapshot/restore)~~ — **xong (2026-10-26, merge vào `main`; chưa build vào container đang chạy)**. Migration mới `024_flow_versions.sql`/`.pg.sql` (bảng `flow_versions`, `_schema_version` = 24; bản pg chưa chạy thử), 4 route `/flows/{id}/versions[...]` (tạo, liệt kê, xem, restore; tối đa 50 bản/flow, restore tự sao lưu bản hiện tại, flow active + bản lỗi validate thì 422), drawer "Versions" trên canvas. Còn tồn: Postgres chạy đồng thời 2 request tạo version có thể 500 do UNIQUE (SQLite an toàn). Plan: `customize/docs/superpowers/plans/2026-10-26-flow-versions.md`.
10. AI copilot tự tạo flow từ mô tả ngôn ngữ tự nhiên — effort lớn
    nhất, nên làm sau khi có #2/#3 (retry + validate) để tránh copilot
    tạo ra flow hỏng ngay từ đầu.

**Bổ sung 2026-10-26 — các chức năng orchester có mà roadmap #1–10 chưa
có** (từ báo cáo so sánh với `orchester/apps/web/lib/flows/` và
`components/flows/`; effort S/M/L là ước lượng thô). Mỗi mục vẫn làm ở 1
phase riêng, có plan riêng. Thứ tự gợi ý: nhóm A trước (rẻ, mở khóa
nhiều thứ), rồi B–C, D–E sau cùng.

*A. Node & engine cơ bản*
11. Node `http` (SSRF guard, timeout, retry/backoff), `delay`, `note` — M.
12. Node `switch` (nhiều nhánh) + thêm toán tử so sánh (regex, in, rỗng) — S.
13. Node `transform` / gán biến (set variable) — M.
14. Node `try_catch` + chính sách lỗi theo node (dừng / bỏ qua / rẽ nhánh lỗi) — M.
15. Retry nâng cao: backoff mũ + jitter, dùng chung cho `http` và các node khác — S.
16. Node `llm_prompt` (gọi thẳng model, không qua agent) và `kb_search` — M.
17. Node `loop_for_each`, `parallel` (giới hạn số nhánh, mặc định 10) — L.
18. Node `subflow` (giới hạn độ sâu 5, chặn vòng lặp giữa các flow, ánh xạ input/output) — L.

*B. Chạy nền & an toàn vận hành*
19. Chạy nền (không giữ request) + polling trạng thái run; tiền đề cho #20, #21 — L.
20. Stream tiến trình trực tiếp (SSE), trạng thái từng node trên canvas — L.
21. Giới hạn chạy đồng thời / flow, timeout từng bước, hủy run, dọn run treo (reaper) — S–M.
22. Retention: xóa run/version cũ theo hạn — S.

*C. Trigger*
23. Trigger `webhook` (secret trong đường dẫn, HMAC tùy chọn) — M.
24. Trigger lịch (cron + múi giờ), tái dùng APScheduler của Octop — M.
25. Trigger theo tin nhắn / hội thoại; gọi flow qua API/MCP — M–L.
26. UI quản lý webhook và lịch (orchester cũng chưa có) — S.

*D. Tương tác người & thông báo*
27. Node `wait_human`: tạm dừng, lưu trạng thái, link duyệt dùng 1 lần, tiếp tục run — L.
28. Node `notify` (gửi tin tới người/kênh) — M.
29. Hộp thoại Run có ô nhập dữ liệu đầu vào + tick dry-run (đi cùng #4) — S.

*E. Trình dựng (frontend)*
30. Undo/redo (Ctrl+Z / Ctrl+Shift+Z) — S.
31. Copy / paste / nhân bản node (Ctrl+C/V/D) — S.
32. Tự động sắp xếp (auto-layout) — S.
33. Inspector theo từng loại field (cron, key-value, mã, thời lượng, picker agent/model) và badge lỗi trên node (nối với #3) — M.
34. Palette node có nhóm + tìm kiếm — S.
35. Gom nhóm node (group) và tách thành subflow (extract) — M–L.
36. Import / export flow dạng JSON — S.
37. Lịch sử chạy có trace AI từng bước (agent, model, token, chi phí) — M.
38. Panel quan hệ giữa các flow, cảnh báo tác động khi xóa, mô tả flow tự động — M.

*Không áp dụng / để sau:* workspace + RLS (Octop theo user, xem
`design-flow.md` §3); node media (ảnh/video/giọng nói/nhạc),
`integration`, `spreadsheet`, `code` (cần cơ chế sandbox) — chỉ làm khi có
nhu cầu cụ thể; flow "kind" pipeline/action.

Khi bắt đầu 1 phase mới ở phiên chat mới: đọc `design-flow.md` +
mục 9.1/9.1b/9.2 này trước, rồi dùng lại đúng quy trình mục 3 (dựa trên
Agency) / mục 9 để viết plan riêng cho phase đó qua
`superpowers:writing-plans`, thực thi qua
`superpowers:subagent-driven-development` — không bắt đầu lại từ đầu,
không viết lại `engine.py`/`flow.py` từ 0. **Mục 9.1b có 2 điều đáng
tái sử dụng trực tiếp cho mọi phase sau:** (1) cách sandbox test
(`/tmp/octop-<tên-phase>-sandbox`) + lỗi `PYTHONPATH` hay gặp với
`.venv` editable-install đã copy; (2) quy trình cài thật vào `Octop/`
(patch `git apply` + copy tay file đã sửa, verify `pytest`/`vitest`
ngay trong `Octop/`, rebuild bằng `scripts/rebuild.sh` — nhớ tạo swap
tạm nếu RAM thấp, xem mục 4.1) — **chỉ làm bước cài thật này khi người
dùng yêu cầu rõ**, không tự động làm ngay sau khi merge.
