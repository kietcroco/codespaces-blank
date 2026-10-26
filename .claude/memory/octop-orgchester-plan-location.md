---
name: octop-orgchester-plan-location
description: Where to look when the user says "kiểm tra tài liệu và plan" — octop-orgchester/customize/docs, not .worktree
metadata:
  type: reference
---

"Kiểm tra tài liệu và plan" = đọc `codespaces-blank/octop-orgchester/`: `ARCHITECTURE.md` (§9.2 roadmap), `customize/docs/design*.md`, `customize/docs/superpowers/plans/*.md`, `customize/docs/patches/`.

**Why:** Lần đầu mình tìm nhầm ở `.worktree/` và `octop/workspaces/test-crud` (hệ thống PM/BA khác), người dùng phải chỉnh lại.

**How to apply:** Đọc thẳng các đường dẫn trên; checkbox trong plan không được tick nên đối chiếu với ARCHITECTURE.md §9 và code thật. Chi tiết đã ghi trong `codespaces-blank/CLAUDE.md`. Test của plan cần môi trường Linux, máy này là Windows nên hỏi người dùng. Xem [[octop-orgchester-flow-status]].
