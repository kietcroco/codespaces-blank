# customize/backend/tests/test_flow_engine.py
import pytest
from octop.infra.flows.engine import FlowEdge, FlowNode, NonRetryableError, run_flow

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


def _flaky(fail_times: int, exc=RuntimeError):
    """call_agent that raises exc("boom") for the first fail_times calls, then returns "ok"."""
    calls = {"n": 0}

    async def call(agent_id: str, prompt: str) -> str:
        calls["n"] += 1
        if calls["n"] <= fail_times:
            raise exc("boom")
        return "ok"

    call.calls = calls
    return call

def _sleeps():
    delays: list[float] = []

    async def sleep(delay: float) -> None:
        delays.append(delay)

    return delays, sleep

def _retry_graph(**retry_keys):
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="a", type="agent", config={"agent_id": "bot1", "prompt": "x", "output_var": "a", **retry_keys}),
        FlowNode(id="e", type="end"),
    ]
    edges = [FlowEdge(id="e1", source="t", target="a"), FlowEdge(id="e2", source="a", target="e")]
    return nodes, edges

async def _run_retry(fail_times, exc=RuntimeError, **retry_keys):
    nodes, edges = _retry_graph(**retry_keys)
    call = _flaky(fail_times, exc)
    delays, sleep = _sleeps()
    result = await run_flow(nodes, edges, input={}, call_agent=call, sleep=sleep)
    return result, call.calls["n"], delays

async def test_agent_default_makes_single_call_and_old_error_text():
    result, calls, delays = await _run_retry(5)
    assert result.status == "failed"
    assert result.error == "agent call failed: boom"
    assert calls == 1
    assert delays == []

async def test_agent_retries_until_success():
    result, calls, delays = await _run_retry(2, max_retries=3, retry_delay=0.5)
    assert result.status == "succeeded"
    assert result.output["a"] == "ok"
    assert calls == 3
    assert delays == [0.5, 0.5]
    agent_steps = [s for s in result.steps if s.node_type == "agent"]
    assert len(agent_steps) == 1
    assert agent_steps[0].status == "succeeded"

async def test_agent_exhausts_retries():
    result, calls, _ = await _run_retry(9, max_retries=2)
    assert result.status == "failed"
    assert result.error == "agent call failed after 3 attempts: boom"
    assert calls == 3
    assert result.steps[-1].status == "failed"
    assert result.steps[-1].error == result.error

async def test_non_retryable_error_fails_immediately():
    result, calls, delays = await _run_retry(9, exc=NonRetryableError, max_retries=3)
    assert result.status == "failed"
    assert calls == 1
    assert delays == []
    assert result.error == "agent call failed: boom"

async def test_retry_values_are_clamped():
    _, calls, delays = await _run_retry(99, max_retries=99, retry_delay=999)
    assert calls == 6
    assert delays == [30.0] * 5
    _, calls, _ = await _run_retry(99, max_retries=-3)
    assert calls == 1

async def test_retry_config_accepts_numeric_strings_and_blank():
    _, calls, _ = await _run_retry(9, max_retries="2", retry_delay="0")
    assert calls == 3
    _, calls, _ = await _run_retry(9, max_retries="", retry_delay=None)
    assert calls == 1

@pytest.mark.parametrize("key,value", [("max_retries", "abc"), ("retry_delay", "abc"), ("max_retries", True)])
async def test_invalid_retry_config_fails_step_without_calling_agent(key, value):
    result, calls, _ = await _run_retry(0, **{key: value})
    assert result.status == "failed"
    assert calls == 0
    assert (result.error or "").startswith("invalid retry config: ")


def _agent_flow(prompt, **extra):
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="a", type="agent", config={"agent_id": "bot1", "prompt": prompt, **extra}),
    ]
    return nodes, [FlowEdge(id="e1", source="t", target="a")]


async def test_filter_in_agent_prompt_is_applied():
    seen = []

    async def call(agent_id, prompt):
        seen.append(prompt)
        return "ok"

    nodes, edges = _agent_flow("hi {{name|upper}}")
    result = await run_flow(nodes, edges, input={"name": "bo"}, call_agent=call)
    assert result.status == "succeeded"
    assert seen == ["hi BO"]


async def test_unknown_filter_in_prompt_fails_step_without_calling_or_retrying():
    calls = []
    delays = []

    async def call(agent_id, prompt):
        calls.append(prompt)
        return "ok"

    async def sleep(delay):
        delays.append(delay)

    nodes, edges = _agent_flow("hi {{name|xyz}}", max_retries=3)
    result = await run_flow(nodes, edges, input={"name": "bo"}, call_agent=call, sleep=sleep)
    assert result.status == "failed"
    assert result.steps[-1].status == "failed"
    assert result.steps[-1].error == "template error: unknown filter 'xyz' in {{name|xyz}}"
    assert result.steps[-1].agent_id == "bot1"
    assert result.error == result.steps[-1].error
    assert calls == [] and delays == []


def _cond_flow(left, right, op="gt"):
    nodes = [
        FlowNode(id="t", type="trigger"),
        FlowNode(id="c", type="condition", config={"left": left, "op": op, "right": right}),
        FlowNode(id="hi", type="end"),
        FlowNode(id="lo", type="end"),
    ]
    edges = [
        FlowEdge(id="e1", source="t", target="c"),
        FlowEdge(id="e2", source="c", target="hi", source_handle="true"),
        FlowEdge(id="e3", source="c", target="lo", source_handle="false"),
    ]
    return nodes, edges


async def test_condition_operand_can_use_length_filter_numerically():
    nodes, edges = _cond_flow("{{a|length}}", "2")
    big = await run_flow(nodes, edges, input={"a": "hello"}, call_agent=_echo_agent)
    assert big.steps[-1].node_id == "hi"
    small = await run_flow(nodes, edges, input={"a": "x"}, call_agent=_echo_agent)
    assert small.steps[-1].node_id == "lo"


async def test_bad_filter_in_condition_right_fails_step_without_raising():
    nodes, edges = _cond_flow("1", "{{b|nope}}")
    result = await run_flow(nodes, edges, input={}, call_agent=_echo_agent)
    assert result.status == "failed"
    assert result.steps[-1].node_id == "c"
    assert result.steps[-1].status == "failed"
    assert result.steps[-1].error == "template error: unknown filter 'nope' in {{b|nope}}"


async def test_bad_filter_in_condition_left_fails_step_without_raising():
    nodes, edges = _cond_flow("{{b|nope}}", "1")
    result = await run_flow(nodes, edges, input={}, call_agent=_echo_agent)
    assert result.status == "failed"
    assert result.steps[-1].error.startswith("template error: unknown filter 'nope'")


async def test_variable_set_to_none_renders_empty_and_missing_renders_empty():
    seen = []

    async def call(agent_id, prompt):
        seen.append(prompt)
        return "ok"

    nodes, edges = _agent_flow("[{{a}}][{{b}}]")
    await run_flow(nodes, edges, input={"a": None}, call_agent=call)
    assert seen == ["[][]"]
