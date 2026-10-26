# customize/backend/tests/test_flow_engine.py
import pytest
from octop.infra.flows.engine import FlowEdge, FlowNode, run_flow

async def _echo_agent(agent_id: str, prompt: str) -> str:
    return f"reply-from-{agent_id}:{prompt}"

async def test_linear_flow_trigger_agent_end():
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="a", type="agent", config={"agent_id": "bot1", "prompt": "hi {{topic}}", "output_var": "a_out"}),
        FlowNode(id="e", type="end"),
    ]
    edges = [FlowEdge(id="e1", source="t", target="a"), FlowEdge(id="e2", source="a", target="e")]
    result = await run_flow(nodes, edges, input={"topic": "octop"}, call_agent=_echo_agent)
    assert result.status == "succeeded"
    assert result.output["a_out"] == "reply-from-bot1:hi octop"
    assert [s.node_id for s in result.steps] == ["t", "a", "e"]

async def test_condition_true_and_false_branches():
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="c", type="condition", config={"left": "{{score}}", "op": "gte", "right": "50"}),
        FlowNode(id="hi", type="end"),
        FlowNode(id="lo", type="end"),
    ]
    edges = [
        FlowEdge(id="e1", source="t", target="c"),
        FlowEdge(id="e2", source="c", target="hi", source_handle="true"),
        FlowEdge(id="e3", source="c", target="lo", source_handle="false"),
    ]
    high = await run_flow(nodes, edges, input={"score": "90"}, call_agent=_echo_agent)
    assert [s.node_id for s in high.steps][-1] == "hi"
    low = await run_flow(nodes, edges, input={"score": "10"}, call_agent=_echo_agent)
    assert [s.node_id for s in low.steps][-1] == "lo"

async def test_condition_non_numeric_comparison_fails_step_not_request():
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="c", type="condition", config={"left": "abc", "op": "gt", "right": "1"}),
    ]
    edges = [FlowEdge(id="e1", source="t", target="c")]
    result = await run_flow(nodes, edges, input={}, call_agent=_echo_agent)
    assert result.status == "failed"
    assert result.steps[-1].status == "failed"
    assert result.steps[-1].error

async def test_cyclic_graph_stops_at_max_steps_instead_of_hanging():
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="a", type="agent", config={"agent_id": "bot1", "prompt": "x"}),
    ]
    edges = [FlowEdge(id="e1", source="t", target="a"), FlowEdge(id="e2", source="a", target="a")]
    result = await run_flow(nodes, edges, input={}, call_agent=_echo_agent, max_steps=5)
    assert result.status == "failed"
    assert "max steps" in (result.error or "").lower()
    assert len(result.steps) == 5

async def test_empty_graph_or_dangling_trigger_returns_clean_no_op_result():
    nodes = [FlowNode(id="t", type="trigger")]
    result = await run_flow(nodes, [], input={}, call_agent=_echo_agent)
    assert result.status == "succeeded"
    assert result.steps == []
