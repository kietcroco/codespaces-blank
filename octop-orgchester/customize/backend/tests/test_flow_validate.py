# customize/backend/tests/test_flow_validate.py
from octop.infra.flows.engine import FlowEdge, FlowNode
from octop.infra.flows.validate import FlowIssue, has_errors, validate_graph


def n(id, type, **config):
    return FlowNode(id=id, type=type, config=config)


def e(src, dst, handle=None):
    return FlowEdge(id=f"{src}->{dst}:{handle}", source=src, target=dst, source_handle=handle)


def valid_graph():
    nodes = [n("t", "trigger"), n("a", "agent", agent_id="a1", prompt="hi"), n("z", "end")]
    return nodes, [e("t", "a"), e("a", "z")]


def codes(issues):
    return {i.code for i in issues}


def by_code(issues, code):
    return [i for i in issues if i.code == code]


def test_valid_graph_has_no_issues():
    assert validate_graph(*valid_graph()) == []


def test_empty_graph_reports_no_trigger():
    issues = validate_graph([], [])
    assert [i.code for i in issues] == ["no_trigger"]
    assert issues[0].node_id is None
    assert issues[0].level == "error"
    assert has_errors(issues)


def test_issue_to_dict():
    issue = FlowIssue(level="error", code="x", message="m", node_id="n1")
    assert issue.to_dict() == {"level": "error", "code": "x", "message": "m", "node_id": "n1"}


def test_multiple_triggers():
    issues = validate_graph([n("t1", "trigger"), n("t2", "trigger")], [])
    found = by_code(issues, "multiple_triggers")
    assert len(found) == 1 and found[0].node_id == "t2"


def test_duplicate_ids_and_unknown_type():
    nodes = [n("t", "trigger"), n("x", "end"), n("x", "end"), n("u1", None), n("u2", "http")]
    issues = validate_graph(nodes, [])
    assert "duplicate_node_id" in codes(issues)
    assert len(by_code(issues, "unknown_node_type")) == 2


def test_agent_rules():
    issues = validate_graph([n("t", "trigger"), n("a", "agent")], [e("t", "a")])
    assert {"agent_missing_agent", "agent_missing_prompt"} <= codes(issues)
    nodes, edges = valid_graph()
    nodes[1].config["max_retries"] = "abc"
    found = by_code(validate_graph(nodes, edges), "agent_bad_retry")
    assert len(found) == 1 and "max_retries must be a number" in found[0].message


def test_whitespace_only_fields_are_blank():
    nodes = [
        n("t", "trigger"),
        n("a", "agent", agent_id="  ", prompt="\n"),
        n("c", "condition", left=" ", op="eq", right="1"),
    ]
    issues = validate_graph(nodes, [e("t", "a"), e("a", "c")])
    assert {"agent_missing_agent", "agent_missing_prompt", "condition_missing_left"} <= codes(issues)


def test_condition_rules():
    def graph(edges, **cfg):
        return [n("t", "trigger"), n("c", "condition", **cfg), n("z", "end")], [e("t", "c"), *edges]

    good = {"left": "{{x}}", "op": "eq", "right": ""}
    both = [e("c", "z", "true"), e("c", "z", "false")]
    assert validate_graph(*graph(both, **good)) == []
    assert "condition_bad_op" in codes(validate_graph(*graph(both, left="a", op="regex", right="b")))
    assert "condition_missing_left" in codes(validate_graph(*graph(both, left="", op="eq", right="b")))
    for handle in (None, "maybe"):
        issues = validate_graph(*graph([e("c", "z", handle), *both], **good))
        assert len(by_code(issues, "condition_bad_handle")) == 1
    issues = validate_graph(*graph([e("c", "z", "true")], **good))
    missing = by_code(issues, "condition_branch_missing")
    assert len(missing) == 1 and missing[0].level == "warning" and missing[0].node_id == "c"
    assert not has_errors(issues)


def test_edge_dangling():
    nodes, edges = valid_graph()
    edges += [e("a", "ghost"), e("phantom", "z")]
    found = by_code(validate_graph(nodes, edges), "edge_dangling")
    assert len(found) == 2 and all(i.level == "error" for i in found)


def test_cycle_detected():
    nodes = [
        n("t", "trigger"),
        n("a", "agent", agent_id="a1", prompt="p"),
        n("b", "agent", agent_id="a1", prompt="p"),
    ]
    issues = validate_graph(nodes, [e("t", "a"), e("a", "b"), e("b", "a")])
    found = by_code(issues, "cycle")
    assert len(found) == 1 and found[0].node_id in ("a", "b")


def test_self_loop_and_long_chain_do_not_crash():
    nodes, edges = valid_graph()
    edges.append(e("a", "a"))
    assert "cycle" in codes(validate_graph(nodes, edges))

    chain = [n("t", "trigger")] + [n(f"a{i}", "agent", agent_id="a1", prompt="p") for i in range(998)] + [n("z", "end")]
    ids = [x.id for x in chain]
    chain_edges = [e(ids[i], ids[i + 1]) for i in range(len(ids) - 1)]
    assert len(chain) == 1000
    assert validate_graph(chain, chain_edges) == []


def test_unreachable_and_multiple_outgoing_warnings():
    nodes, edges = valid_graph()
    nodes.append(n("orphan", "agent", agent_id="a1", prompt="p"))
    issues = validate_graph(nodes, edges)
    found = by_code(issues, "unreachable_node")
    assert [i.node_id for i in found] == ["orphan"] and found[0].level == "warning"
    assert not has_errors(issues)

    nodes, edges = valid_graph()
    nodes.append(n("z2", "end"))
    edges.append(e("a", "z2"))
    issues = validate_graph(nodes, edges)
    assert [i.node_id for i in by_code(issues, "multiple_outgoing")] == ["a"]
    assert not has_errors(issues)

    issues = validate_graph([n("a", "agent", agent_id="a1", prompt="p")], [])
    assert "unreachable_node" not in codes(issues)


def test_errors_sorted_before_warnings():
    nodes = [n("o", "agent", agent_id="a1", prompt="p"), n("t", "trigger"), n("b", "agent")]
    issues = validate_graph(nodes, [e("t", "b")])
    levels = [i.level for i in issues]
    assert "warning" in levels and "error" in levels
    assert levels == sorted(levels, key=lambda lv: lv != "error")


def test_bad_template_in_agent_prompt():
    nodes, edges = valid_graph()
    nodes[1].config["prompt"] = "{{x|nope}}"
    found = by_code(validate_graph(nodes, edges), "bad_template")
    assert len(found) == 1
    assert found[0].level == "error"
    assert found[0].node_id == nodes[1].id
    assert found[0].message == (
        f"Node '{nodes[1].id}' has a bad template in prompt: "
        "unknown filter 'nope' in {{x|nope}}"
    )


def test_bad_template_in_condition_left_and_right():
    nodes = [n("t", "trigger"), n("c", "condition", left="{{a|truncate:abc}}", op="eq", right="{{b|zzz}}")]
    found = by_code(validate_graph(nodes, [e("t", "c")]), "bad_template")
    assert len(found) == 2
    assert "in left:" in found[0].message and "in right:" in found[1].message
    assert all(i.node_id == "c" for i in found)


def test_bad_template_two_tokens_in_one_field_give_two_issues():
    nodes = [n("t", "trigger"), n("a", "agent", agent_id="x", prompt="{{a|q}} {{b|r}}")]
    found = by_code(validate_graph(nodes, [e("t", "a")]), "bad_template")
    assert len(found) == 2


def test_blank_template_fields_do_not_report_bad_template():
    nodes = [n("t", "trigger"), n("a", "agent", agent_id="x", prompt=" "), n("c", "condition", left="", op="eq")]
    issues = validate_graph(nodes, [e("t", "a"), e("a", "c")])
    assert "bad_template" not in codes(issues)


def test_valid_filtered_templates_have_no_bad_template():
    nodes = [
        n("t", "trigger"),
        n("a", "agent", agent_id="x", prompt="{{ a | upper }} {{b|default:x|truncate:5}} {{c.d|json}}"),
        n("c", "condition", left="{{a|length}}", op="gt", right="2"),
    ]
    issues = validate_graph(nodes, [e("t", "a"), e("a", "c")])
    assert "bad_template" not in codes(issues)


def test_bad_template_counts_as_error():
    nodes, edges = valid_graph()
    nodes[1].config["prompt"] = "{{x|nope}}"
    assert has_errors(validate_graph(nodes, edges))
