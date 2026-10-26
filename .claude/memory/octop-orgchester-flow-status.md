---
name: octop-orgchester-flow-status
description: Flow feature progress snapshot (as of 2026-10-26) and next roadmap items
metadata:
  type: project
---

Agency, Flow V1, roadmap #1 (gate `flows.status`, patch 17), #3 (validate tĩnh), #4 (dry-run), #5 (MiniMap), #6 (panel tài liệu), #7 (filter template), #8 (template mẫu), #9 (versioning) và #2 (retry node agent, `max_retries`/`retry_delay`, merge vào main 2026-10-26, CHƯA cài vào `Octop/`) đã xong. Roadmap §9.2 giờ có **38 mục** (10 xong, #10 AI copilot làm xong 2026-10-26 trên nhánh `flow-copilot`, CHƯA merge vào main và CHƯA cài vào `Octop/`; trước đó 9 xong; #11–38 bổ sung 2026-10-26 sau khi so sánh với orchester: node http/switch/transform/try_catch/loop/subflow, chạy nền+SSE, trigger webhook/lịch, wait_human, undo/redo...). Việc kế tiếp: **nhóm A #11–18** (sau khi duyệt/merge #10) (#3–#9 đã xong 2026-10-26, merge main, CHƯA cài vào `Octop/`), #5 MiniMap...; nhóm A (#11–18) nên làm sớm.

**Test env (Windows):** xem [[octop-test-sandbox]]. Container demo + seeder dữ liệu mẫu (`docker compose up -d`, service `seed`, key ở `.env.seed`) mô tả ở ARCHITECTURE.md §7/§5. Thay đổi seeder/sandbox/docs chưa commit.

**Why:** Mỗi mục làm ở một phase riêng, có plan riêng.

**How to apply:** Snapshot có thể cũ; kiểm tra lại ARCHITECTURE.md §9 trước khi nói. Xem [[octop-orgchester-plan-location]].

**Container đang chạy (2026-10-26):** image `octop:latest` build từ sandbox (đã gồm #1–#8, trừ khi ghi khác), recreate bằng `docker compose up -d --no-build --force-recreate octop` (giữ nguyên `data/`, KHÔNG dùng `rebuild.sh` vì nó xoá data và build từ `Octop/`). Đã smoke-test qua API: validate, dry-run, filter template, gate activate/run.

**Lưu ý 2026-10-26:** #9 versioning thêm migration 024 (bảng `flow_versions`) và đã merge vào main nhưng container đang chạy CHƯA có (build ở phase #8). Muốn có: build lại image từ sandbox + `docker compose up -d --no-build --force-recreate octop` (migration tự áp lên DB hiện có).
