---
name: feedback-vietnamese-and-progress-report
description: Luôn trả lời tiếng Việt; luôn báo phase X/N, task Y/M; review+test sau mỗi task; merge và báo trước khi sang phase mới
metadata:
  type: feedback
---

Luôn trả lời bằng **tiếng Việt**. Trong mọi báo cáo tiến độ luôn nêu rõ **đang ở phase nào / tổng bao nhiêu phase** (roadmap Flow hiện 38 mục, xem [[octop-orgchester-flow-status]]) và **đang làm task nào / bao nhiêu task của phase đó**.

Quy trình điều phối agent: mỗi task do agent con làm, rồi agent khác review + test lại; xong cả phase thì chạy lại toàn bộ test, merge code về `main` và **báo người dùng trước khi bắt đầu phase khác**. Chỉ cài vào `Octop/` hoặc rebuild container khi người dùng yêu cầu rõ.

**Why:** người dùng điều phối nhiều phiên và cần biết ngay mình đang ở đâu; muốn duyệt kết quả giữa các phase.

**How to apply:** mở đầu/ cuối báo cáo ghi "Phase X/N, Task Y/M"; không tự sang phase kế tiếp sau khi merge; nhắc cả các quy ước giao tiếp trong `.claude/rules` (nói theo kết quả công việc, không đọc tên skill/script nội bộ khi nói chuyện với người dùng). Test cần Docker: xem [[octop-test-sandbox]].
