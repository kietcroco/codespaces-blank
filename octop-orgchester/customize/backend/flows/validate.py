# customize/backend/flows/validate.py
"""Pure static validation of a Flow graph (no FastAPI, no database).

Turns the engine's FlowNode / FlowEdge lists into a list of FlowIssue so a
broken graph can be reported before it runs. Never raises on malformed shapes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from octop.infra.flows.engine import CONDITION_OPS, FlowEdge, FlowNode, _retry_policy
from octop.infra.flows.template import check as check_template

NODE_TYPES = ("trigger", "agent", "condition", "end")


@dataclass(frozen=True)
class FlowIssue:
    level: Literal["error", "warning"]
    code: str
    message: str
    node_id: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "level": self.level,
            "code": self.code,
            "message": self.message,
            "node_id": self.node_id,
        }


def has_errors(issues: list[FlowIssue]) -> bool:
    return any(i.level == "error" for i in issues)


def _blank(value: Any) -> bool:
    return value is None or str(value).strip() == ""


def validate_graph(nodes: list[FlowNode], edges: list[FlowEdge]) -> list[FlowIssue]:
    errors: list[FlowIssue] = []
    warnings: list[FlowIssue] = []

    def err(code: str, message: str, node_id: str | None) -> None:
        errors.append(FlowIssue("error", code, message, node_id))

    def warn(code: str, message: str, node_id: str | None) -> None:
        warnings.append(FlowIssue("warning", code, message, node_id))

    def check_fields(node_id: str, config: dict[str, Any], fields: tuple[str, ...]) -> None:
        for field in fields:
            value = config.get(field)
            if _blank(value):
                continue
            for message in check_template(str(value)):
                err(
                    "bad_template",
                    f"Node '{node_id}' has a bad template in {field}: {message}",
                    node_id,
                )

    ids: set[str] = set()
    triggers: list[FlowNode] = []
    for node in nodes:
        if node.id in ids:
            err("duplicate_node_id", f"Node id '{node.id}' is used more than once.", node.id)
        ids.add(node.id)
        config = node.config if isinstance(node.config, dict) else {}
        if node.type not in NODE_TYPES:
            err("unknown_node_type", f"Node '{node.id}' has unknown type {node.type!r}.", node.id)
        elif node.type == "trigger":
            triggers.append(node)
        elif node.type == "agent":
            if _blank(config.get("agent_id")):
                err("agent_missing_agent", f"Agent node '{node.id}' has no agent selected.", node.id)
            if _blank(config.get("prompt")):
                err("agent_missing_prompt", f"Agent node '{node.id}' has an empty prompt.", node.id)
            try:
                _retry_policy(config)
            except ValueError as exc:
                err("agent_bad_retry", str(exc), node.id)
            check_fields(node.id, config, ("prompt",))
        elif node.type == "condition":
            if config.get("op") not in CONDITION_OPS:
                err(
                    "condition_bad_op",
                    f"Condition node '{node.id}' has invalid op {config.get('op')!r}.",
                    node.id,
                )
            if _blank(config.get("left")):
                err(
                    "condition_missing_left",
                    f"Condition node '{node.id}' has an empty left value.",
                    node.id,
                )
            check_fields(node.id, config, ("left", "right"))

    if not triggers:
        err("no_trigger", "Flow has no trigger node.", None)
    for extra in triggers[1:]:
        err("multiple_triggers", f"Node '{extra.id}' is an extra trigger; only one is allowed.", extra.id)

    types = {}
    for node in nodes:
        types.setdefault(node.id, node.type)

    adjacency: dict[str, list[str]] = {}
    outgoing_count: dict[str, int] = {}
    handles: dict[str, set[str]] = {}
    for edge in edges:
        missing = [x for x in (edge.source, edge.target) if x not in types]
        if missing:
            err(
                "edge_dangling",
                f"Edge '{edge.id}' references missing node '{missing[0]}'.",
                edge.source,
            )
            continue
        adjacency.setdefault(edge.source, []).append(edge.target)
        outgoing_count[edge.source] = outgoing_count.get(edge.source, 0) + 1
        if types[edge.source] == "condition":
            if edge.source_handle in ("true", "false"):
                handles.setdefault(edge.source, set()).add(edge.source_handle)
            else:
                err(
                    "condition_bad_handle",
                    f"Edge '{edge.id}' leaving condition '{edge.source}' must use the 'true' or 'false' handle.",
                    edge.source,
                )

    # Cycles: iterative DFS, one issue per back edge.
    state: dict[str, int] = {}  # 1 = on stack, 2 = done
    for start in types:
        if start in state:
            continue
        state[start] = 1
        stack: list[tuple[str, int]] = [(start, 0)]
        while stack:
            current, idx = stack.pop()
            targets = adjacency.get(current, [])
            if idx >= len(targets):
                state[current] = 2
                continue
            stack.append((current, idx + 1))
            nxt = targets[idx]
            if state.get(nxt) == 1:
                err("cycle", f"Node '{nxt}' is part of a cycle.", nxt)
            elif nxt not in state:
                state[nxt] = 1
                stack.append((nxt, 0))

    # Warnings
    if triggers:
        seen = {triggers[0].id}
        queue = [triggers[0].id]
        while queue:
            for nxt in adjacency.get(queue.pop(), []):
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        reported: set[str] = set()
        for node in nodes:
            if node.id not in seen and node.id not in reported:
                reported.add(node.id)
                warn("unreachable_node", f"Node '{node.id}' is not reachable from the trigger.", node.id)

    warned: set[str] = set()
    for node in nodes:
        if node.id in warned:
            continue
        warned.add(node.id)
        if node.type == "condition":
            for branch in ("true", "false"):
                if branch not in handles.get(node.id, set()):
                    warn(
                        "condition_branch_missing",
                        f"Condition node '{node.id}' has no edge for the '{branch}' branch.",
                        node.id,
                    )
        elif node.type in NODE_TYPES and outgoing_count.get(node.id, 0) > 1:
            warn(
                "multiple_outgoing",
                f"Node '{node.id}' has several outgoing edges; only the first is followed.",
                node.id,
            )

    return errors + warnings
