---
name: octop-test-sandbox
description: Cách chạy pytest/vitest cho customize/ trên máy Windows bằng sandbox Docker (commit nền 6797d0e4)
metadata:
  type: project
---

Máy Windows không có `.venv`/`node_modules` trong `Octop/`, và `Octop/` HEAD (890111b7) mới hơn commit mà patch nhắm tới (upstream đã có migration 022–024, patch 01/05/06/12/13/17 không áp được). Vì vậy test chạy trong sandbox Docker: `bash octop-orgchester/scripts/sandbox/setup.sh` một lần, sau đó `scripts/sandbox/sb.sh sync` rồi `sb.sh py <pytest args>` hoặc `sb.sh ui <vitest args>`. Sandbox mặc định ở `<repo>/../octop-sandbox` (trên máy này `D:\Sources\RandD\octop-sandbox`). Làm trong git worktree thì đặt `CUSTOMIZE=<đường dẫn customize/ của worktree>`.

**Why:** plan cũ giả định sandbox Linux `/tmp/...`; người dùng đã chọn Docker Desktop làm nơi test (2026-10-26).

**How to apply:** luôn `sync` trước khi chạy test; baseline backend 33 test, dashboard Flows 16 test; `setup.sh` chưa được thử từ trạng thái trống. Container demo build từ chính sandbox này (`docker build -f docker/Dockerfile -t octop:latest .` trong `octop-sandbox/octop`), không phải từ `Octop/`. Xem [[octop-orgchester-flow-status]].
