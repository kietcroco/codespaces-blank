#!/usr/bin/env python3
"""Seed sample data (model provider, agencies, experts, flows) into a running
Octop container through its own REST API — never touches the DB file.

Models a small software company: departments = Agencies, staff = Experts,
plus two ready-to-run Flows that chain those experts.

Idempotent per resource (matched by name): safe to re-run, creates only
what is missing. Stdlib only (no jq/requests) so it runs on Windows, Linux
and inside the compose `seed` service.

Config (env vars; `.env.seed` next to docker-compose.yml is read too):
  OCTOP_BASE        API base, default http://localhost:<OCTOP_PORT|8088>/api
  OCTOP_CRED_FILE   credential.txt path, default data/credential.txt
  SEED_PROVIDER_BASE_URL / SEED_PROVIDER_API_KEY / SEED_PROVIDER_MODELS
                    OpenAI-compatible provider; without an API key a
                    placeholder provider is created (UI only, no real chat).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


load_env_file(HERE / ".env.seed")
load_env_file(HERE / ".env")

PORT = os.environ.get("OCTOP_PORT", "8088")
BASE = os.environ.get("OCTOP_BASE", f"http://localhost:{PORT}/api").rstrip("/")
CRED_FILE = Path(os.environ.get("OCTOP_CRED_FILE", HERE / "data" / "credential.txt"))
ADMIN_USER = os.environ.get("OCTOP_ADMIN_USERNAME", "admin")

PROVIDER_NAME = "vietapi"
PROVIDER_BASE_URL = os.environ.get("SEED_PROVIDER_BASE_URL", "https://api.vietapi.tech/v1")
PROVIDER_API_KEY = os.environ.get("SEED_PROVIDER_API_KEY", "")
PROVIDER_MODELS = [
    m.strip()
    for m in os.environ.get("SEED_PROVIDER_MODELS", "gpt-5.6-luna,deepseek-v4-flash").split(",")
    if m.strip()
]
STRONG = f"{PROVIDER_NAME}/{PROVIDER_MODELS[0]}"
FAST = f"{PROVIDER_NAME}/{PROVIDER_MODELS[-1]}"

TOKEN = ""


def api(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise SystemExit(f"error: {method} {path} -> {exc.code} {detail}") from exc
    return json.loads(raw) if raw else None


def wait_healthy() -> None:
    print(f"==> Waiting for {BASE}/health...")
    for _ in range(60):
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=5):
                return
        except Exception:  # noqa: BLE001 - any failure just means "not yet"
            time.sleep(2)
    raise SystemExit(f"error: {BASE}/health never became healthy")


def login() -> None:
    global TOKEN
    password = ""
    for _ in range(30):  # credential.txt appears a moment after first boot
        if CRED_FILE.is_file():
            for line in CRED_FILE.read_text(encoding="utf-8").splitlines():
                if line.startswith("Password: "):
                    password = line[len("Password: "):].strip()
        if password:
            break
        time.sleep(2)
    if not password:
        raise SystemExit(f"error: no password found in {CRED_FILE}")
    print(f"==> Logging in as {ADMIN_USER}...")
    TOKEN = api("POST", "/auth/login", {"username": ADMIN_USER, "password": password})["access_token"]


# ── Data ─────────────────────────────────────────────────────────────────
AGENCIES = [
    ("Product", "Định hướng sản phẩm, phân tích nghiệp vụ", "#8B5CF6"),
    ("Engineering", "Thiết kế và xây dựng sản phẩm", "#3B82F6"),
    ("Design", "Thiết kế trải nghiệm và giao diện", "#EC4899"),
    ("QA", "Kiểm thử và đảm bảo chất lượng", "#10B981"),
    ("DevOps", "CI/CD, hạ tầng, phát hành", "#EF4444"),
    ("Support", "Chăm sóc khách hàng, tiếp nhận lỗi", "#F59E0B"),
]

# key -> (agency, name, description, model, system_prompt)
EXPERTS = {
    "pm": ("Product", "Product Manager", "Viết đặc tả yêu cầu, ưu tiên tính năng", STRONG,
           "Bạn là Product Manager của một công ty phần mềm. Trả lời ngắn gọn, có cấu trúc, bằng tiếng Việt."),
    "ba": ("Product", "Business Analyst", "Phân tích nghiệp vụ, viết user story", FAST,
           "Bạn là Business Analyst. Viết user story và tiêu chí chấp nhận rõ ràng, bằng tiếng Việt."),
    "lead": ("Engineering", "Tech Lead", "Thiết kế giải pháp kỹ thuật, review kiến trúc", STRONG,
             "Bạn là Tech Lead. Đề xuất giải pháp kỹ thuật thực tế, nêu rủi ro, bằng tiếng Việt."),
    "backend": ("Engineering", "Backend Developer", "Xây dựng API và dịch vụ phía server", FAST,
                "Bạn là Backend Developer. Trả lời ngắn gọn, thực dụng, bằng tiếng Việt."),
    "frontend": ("Engineering", "Frontend Developer", "Xây dựng giao diện web", FAST,
                 "Bạn là Frontend Developer. Trả lời ngắn gọn, thực dụng, bằng tiếng Việt."),
    "designer": ("Design", "UI/UX Designer", "Thiết kế luồng người dùng và giao diện", FAST,
                 "Bạn là UI/UX Designer. Đề xuất luồng và bố cục rõ ràng, bằng tiếng Việt."),
    "qa": ("QA", "QA Engineer", "Viết test case, đánh giá chất lượng", STRONG,
           "Bạn là QA Engineer. Khi được yêu cầu kết luận, kết thúc câu trả lời bằng đúng một từ: APPROVED hoặc REJECTED. Trả lời bằng tiếng Việt."),
    "release": ("QA", "Release Manager", "Điều phối phát hành, viết release note", FAST,
                "Bạn là Release Manager. Viết release note ngắn gọn, bằng tiếng Việt."),
    "devops": ("DevOps", "DevOps Engineer", "Quản lý hạ tầng và pipeline CI/CD", FAST,
               "Bạn là DevOps Engineer. Đề xuất bước triển khai/rollback cụ thể, bằng tiếng Việt."),
    "support": ("Support", "Customer Support", "Tiếp nhận và phân loại phản hồi khách hàng", FAST,
                "Bạn là nhân viên Customer Support. Tóm tắt vấn đề của khách ngắn gọn, bằng tiếng Việt."),
}


def agent_node(node_id, label, expert_key, prompt, out, x, y):
    return {
        "id": node_id, "type": "agent", "position": {"x": x, "y": y},
        "data": {"label": label, "config": {
            "agentId": expert_key, "prompt": prompt, "outputVar": out,
            "maxRetries": 2, "retryDelay": 2,
        }},
    }


def simple_node(node_id, node_type, label, x, y, config=None):
    return {"id": node_id, "type": node_type, "position": {"x": x, "y": y},
            "data": {"label": label, "config": config or {}}}


def edge(eid, source, target, handle=None):
    e = {"id": eid, "source": source, "target": target}
    if handle:
        e["sourceHandle"] = handle
    return e


FLOWS = [
    {
        "name": "Giao tính năng mới (Feature Delivery)",
        "description": "PM viết đặc tả → Tech Lead lập kế hoạch → QA review → phát hành hoặc yêu cầu sửa.",
        "nodes": [
            simple_node("t", "trigger", "Bắt đầu", 300, 0),
            agent_node("spec", "PM viết đặc tả", "pm",
                       "Yêu cầu: thêm đăng nhập bằng Google cho website bán hàng. "
                       "Viết đặc tả ngắn (mục tiêu, phạm vi, tiêu chí chấp nhận).", "spec", 300, 100),
            agent_node("plan", "Tech Lead lập kế hoạch", "lead",
                       "Dựa trên đặc tả sau, đề xuất kế hoạch kỹ thuật (các bước, rủi ro):\n{{spec}}", "plan", 300, 220),
            agent_node("review", "QA review", "qa",
                       "Review đặc tả và kế hoạch dưới đây. Nêu vấn đề chính, "
                       "rồi kết luận bằng một từ APPROVED hoặc REJECTED.\nĐặc tả:\n{{spec}}\nKế hoạch:\n{{plan}}",
                       "review", 300, 340),
            simple_node("gate", "condition", "QA duyệt?", 300, 460,
                        {"left": "{{review}}", "op": "contains", "right": "APPROVED"}),
            agent_node("release", "Release Manager viết release note", "release",
                       "Viết release note ngắn cho tính năng sau:\n{{spec}}", "notes", 100, 580),
            agent_node("fix", "Backend sửa theo góp ý", "backend",
                       "QA từ chối. Liệt kê các việc cần sửa dựa trên góp ý:\n{{review}}", "fixes", 500, 580),
            simple_node("end_ok", "end", "Hoàn tất (đã duyệt)", 100, 700),
            simple_node("end_fix", "end", "Hoàn tất (cần sửa)", 500, 700),
        ],
        "edges": [
            edge("e1", "t", "spec"), edge("e2", "spec", "plan"), edge("e3", "plan", "review"),
            edge("e4", "review", "gate"),
            edge("e5", "gate", "release", "true"), edge("e6", "gate", "fix", "false"),
            edge("e7", "release", "end_ok"), edge("e8", "fix", "end_fix"),
        ],
    },
    {
        "name": "Xử lý lỗi khẩn (Bug Triage)",
        "description": "Support tóm tắt lỗi → QA đánh giá mức độ → nếu CRITICAL thì DevOps lập kế hoạch khắc phục.",
        "nodes": [
            simple_node("t", "trigger", "Bắt đầu", 300, 0),
            agent_node("report", "Support tóm tắt lỗi", "support",
                       "Khách báo: 'Thanh toán bị treo, trừ tiền nhưng đơn không tạo'. Tóm tắt lỗi thành 3 dòng.",
                       "report", 300, 100),
            agent_node("severity", "QA đánh giá mức độ", "qa",
                       "Đánh giá mức độ nghiêm trọng của lỗi sau, chỉ kết luận bằng một từ CRITICAL hoặc NORMAL "
                       "ở cuối câu trả lời:\n{{report}}", "severity", 300, 220),
            simple_node("gate", "condition", "Có phải CRITICAL?", 300, 340,
                        {"left": "{{severity}}", "op": "contains", "right": "CRITICAL"}),
            agent_node("hotfix", "DevOps lập kế hoạch hotfix", "devops",
                       "Lập kế hoạch hotfix và rollback cho lỗi:\n{{report}}", "hotfix", 100, 460),
            simple_node("end_hot", "end", "Đã lập kế hoạch hotfix", 100, 580),
            simple_node("end_norm", "end", "Đưa vào backlog", 500, 460),
        ],
        "edges": [
            edge("e1", "t", "report"), edge("e2", "report", "severity"), edge("e3", "severity", "gate"),
            edge("e4", "gate", "hotfix", "true"), edge("e5", "gate", "end_norm", "false"),
            edge("e6", "hotfix", "end_hot"),
        ],
    },
]


def seed_provider() -> None:
    existing = {p["name"] for p in api("GET", "/admin/providers") or []}
    if PROVIDER_NAME in existing:
        print(f"==> Provider '{PROVIDER_NAME}' already exists — skipping.")
        return
    real = bool(PROVIDER_API_KEY)
    print(f"==> Creating model provider '{PROVIDER_NAME}' ({'real key' if real else 'PLACEHOLDER key — set SEED_PROVIDER_API_KEY in .env.seed'})...")
    api("POST", "/admin/providers", {
        "name": PROVIDER_NAME, "kind": "openai", "base_url": PROVIDER_BASE_URL,
        "api_key": PROVIDER_API_KEY or "sk-placeholder-not-a-real-key",
        "models": [{"id": m, "name": m, "enabled": True} for m in PROVIDER_MODELS],
        "note": "Seed (scripts/seed-sample-data.py)",
    })
    api("PUT", "/providers/active-model", {"provider_name": PROVIDER_NAME, "model": PROVIDER_MODELS[0]})


def seed_agencies() -> dict[str, str]:
    have = {a["name"]: a["agency_id"] for a in api("GET", "/agencies") or []}
    for name, desc, color in AGENCIES:
        if name in have:
            continue
        have[name] = api("POST", "/agencies", {"name": name, "description": desc, "color": color})["agency_id"]
        print(f"    + agency {name}")
    return have


def seed_experts(agency_ids: dict[str, str]) -> dict[str, str]:
    have = {a["name"]: a["agent_id"] for a in api("GET", "/agents") or []}
    ids: dict[str, str] = {}
    for key, (agency, name, desc, model, prompt) in EXPERTS.items():
        if name not in have:
            have[name] = api("POST", "/agents", {
                "name": name, "description": desc, "default_model": model, "system_prompt": prompt,
            })["agent_id"]
            api("PUT", f"/agencies/members/{have[name]}", {"agency_id": agency_ids[agency]})
            print(f"    + expert {name} -> {agency}")
        ids[key] = have[name]
    return ids


def seed_flows(expert_ids: dict[str, str]) -> None:
    have = {f["name"] for f in api("GET", "/flows") or []}
    for spec in FLOWS:
        if spec["name"] in have:
            continue
        nodes = json.loads(json.dumps(spec["nodes"]))
        for n in nodes:
            cfg = n["data"]["config"]
            if "agentId" in cfg:
                cfg["agentId"] = expert_ids[cfg["agentId"]]
        flow_id = api("POST", "/flows", {"name": spec["name"], "description": spec["description"]})["flow_id"]
        api("PATCH", f"/flows/{flow_id}", {"nodes": nodes, "edges": spec["edges"], "status": "active"})
        print(f"    + flow {spec['name']}")


def main() -> None:
    wait_healthy()
    login()
    seed_provider()
    print("==> Seeding agencies, experts, flows...")
    agencies = seed_agencies()
    experts = seed_experts(agencies)
    seed_flows(experts)
    print(f"==> Done: {len(AGENCIES)} agencies, {len(EXPERTS)} experts, {len(FLOWS)} flows (active).")


if __name__ == "__main__":
    sys.exit(main())
