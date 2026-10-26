# customize/backend/flows/engine.py
"""Pure-logic execution engine for Flow graphs.

No FastAPI, no database — this module only walks a graph of FlowNode /
FlowEdge objects, applying a tiny set of node behaviors (trigger, agent,
condition, end) and threading a `variables` dict through the run. The
caller supplies `call_agent` so this module never talks to the outside
world directly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

NodeType = Literal["trigger", "agent", "condition", "end"]
StepStatus = Literal["succeeded", "failed"]

_TEMPLATE_RE = re.compile(r"\{\{(\w+)\}\}")


@dataclass
class FlowNode:
    id: str
    type: NodeType
    config: dict[str, Any] = field(default_factory=dict)


@dataclass
class FlowEdge:
    id: str
    source: str
    target: str
    source_handle: str | None = None


@dataclass
class StepResult:
    node_id: str
    node_type: str
    status: StepStatus
    input: dict[str, Any]
    output: dict[str, Any] | None
    error: str | None
    agent_id: str | None = None


@dataclass
class FlowRunResult:
    status: Literal["succeeded", "failed"]
    output: dict[str, Any]
    error: str | None
    steps: list[StepResult]


# (agent_id, prompt_text) -> reply text
AgentCaller = Callable[[str, str], Awaitable[str]]


def _render(template: str, variables: dict[str, Any]) -> str:
    """Replace every {{key}} in template with str(variables.get(key, ""))."""

    def _sub(match: re.Match[str]) -> str:
        return str(variables.get(match.group(1), ""))

    return _TEMPLATE_RE.sub(_sub, template)


def _evaluate_condition(op: str, left: str, right: str) -> bool:
    """Evaluate a condition's comparison. Raises ValueError on bad input."""
    if op == "eq":
        return left == right
    if op == "neq":
        return left != right
    if op == "contains":
        return right in left
    if op in ("gt", "lt", "gte", "lte"):
        try:
            left_num = float(left)
            right_num = float(right)
        except ValueError as exc:
            raise ValueError(
                f"cannot compare non-numeric values for op '{op}': "
                f"{left!r} vs {right!r}"
            ) from exc
        if op == "gt":
            return left_num > right_num
        if op == "lt":
            return left_num < right_num
        if op == "gte":
            return left_num >= right_num
        return left_num <= right_num
    raise ValueError(f"unknown condition op: {op!r}")


async def run_flow(
    nodes: list[FlowNode],
    edges: list[FlowEdge],
    *,
    input: dict[str, Any],
    call_agent: AgentCaller,
    max_steps: int = 50,
) -> FlowRunResult:
    nodes_by_id = {node.id: node for node in nodes}
    edges_by_source: dict[str, list[FlowEdge]] = {}
    for edge in edges:
        edges_by_source.setdefault(edge.source, []).append(edge)

    variables: dict[str, Any] = dict(input)
    steps: list[StepResult] = []

    trigger = next((n for n in nodes if n.type == "trigger"), None)
    if trigger is None:
        return FlowRunResult(
            status="failed",
            output=variables,
            error="malformed graph: no trigger node",
            steps=steps,
        )

    current: FlowNode | None = trigger

    while current is not None:
        if len(steps) >= max_steps:
            return FlowRunResult(
                status="failed",
                output=variables,
                error="exceeded max steps (cycle in the graph?)",
                steps=steps,
            )

        node = current
        outgoing = edges_by_source.get(node.id, [])

        if node.type == "trigger":
            # The trigger does no work of its own; it only hands off to the
            # next node. A trigger with no outgoing edge never produces a
            # StepResult — there's nothing to report, it's a clean no-op.
            if not outgoing:
                current = None
                break
            steps.append(
                StepResult(
                    node_id=node.id,
                    node_type=node.type,
                    status="succeeded",
                    input=dict(variables),
                    output=None,
                    error=None,
                )
            )
            current = nodes_by_id.get(outgoing[0].target)
            continue

        if node.type == "agent":
            step_input = dict(variables)
            prompt_template = node.config.get("prompt", "")
            rendered_prompt = _render(prompt_template, variables)
            agent_id = node.config.get("agent_id")
            try:
                reply = await call_agent(agent_id, rendered_prompt)
            except Exception as exc:  # noqa: BLE001 - must not crash run_flow
                error_message = f"agent call failed: {exc}"
                steps.append(
                    StepResult(
                        node_id=node.id,
                        node_type=node.type,
                        status="failed",
                        input=step_input,
                        output=None,
                        error=error_message,
                        agent_id=agent_id,
                    )
                )
                return FlowRunResult(
                    status="failed",
                    output=variables,
                    error=error_message,
                    steps=steps,
                )

            output_var = node.config.get("output_var") or node.id
            variables[output_var] = reply
            steps.append(
                StepResult(
                    node_id=node.id,
                    node_type=node.type,
                    status="succeeded",
                    input=step_input,
                    output={output_var: reply},
                    error=None,
                    agent_id=agent_id,
                )
            )

            if not outgoing:
                current = None
                break
            current = nodes_by_id.get(outgoing[0].target)
            continue

        if node.type == "condition":
            step_input = dict(variables)
            left_raw = node.config.get("left", "")
            right_raw = node.config.get("right", "")
            op = node.config.get("op", "")
            left = _render(left_raw, variables)
            right = _render(right_raw, variables)
            try:
                branch = _evaluate_condition(op, left, right)
            except ValueError as exc:
                error_message = str(exc)
                steps.append(
                    StepResult(
                        node_id=node.id,
                        node_type=node.type,
                        status="failed",
                        input=step_input,
                        output=None,
                        error=error_message,
                    )
                )
                return FlowRunResult(
                    status="failed",
                    output=variables,
                    error=error_message,
                    steps=steps,
                )

            handle = "true" if branch else "false"
            steps.append(
                StepResult(
                    node_id=node.id,
                    node_type=node.type,
                    status="succeeded",
                    input=step_input,
                    output={"result": branch},
                    error=None,
                )
            )

            matching = [e for e in outgoing if e.source_handle == handle]
            if not matching:
                current = None
                break
            current = nodes_by_id.get(matching[0].target)
            continue

        if node.type == "end":
            steps.append(
                StepResult(
                    node_id=node.id,
                    node_type=node.type,
                    status="succeeded",
                    input=dict(variables),
                    output=None,
                    error=None,
                )
            )
            current = None
            break

        # Unknown node type: treat as a clean stop rather than crashing.
        current = None
        break

    return FlowRunResult(status="succeeded", output=variables, error=None, steps=steps)
