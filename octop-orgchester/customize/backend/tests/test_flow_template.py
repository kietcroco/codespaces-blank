# customize/backend/tests/test_flow_template.py
import time

import pytest

from octop.infra.flows.template import FILTER_NAMES, TemplateError, check, render


def test_filter_names():
    assert FILTER_NAMES == (
        "upper", "lower", "trim", "default", "truncate", "length", "json",
    )


def test_plain_keys_and_non_tokens_render_as_before():
    assert render("hi {{name}}", {"name": "bo"}) == "hi bo"
    assert render("n={{n}}", {"n": 5}) == "n=5"
    assert render("x{{nope}}y", {}) == "xy"
    for lit in ['{{"a":1}}', "{{}}", "{{ a b }}", "{{", "{{a"]:
        assert render(lit, {"a": "A", "b": "B"}) == lit


def test_whitespace_in_tokens():
    assert render("{{ name | upper }}", {"name": "bo"}) == "BO"
    assert render("{{  name  }}", {"name": "bo"}) == "bo"


def test_dotted_paths_and_list_index():
    v = {"user": {"name": "An"}, "items": ["a", "b"], "s": "str", "z": None}
    assert render("{{user.name}}", v) == "An"
    assert render("{{items.0}}{{items.1}}", v) == "ab"
    assert render("[{{items.5}}]", v) == "[]"
    assert render("[{{s.x}}]", v) == "[]"
    assert render("[{{s.0}}]", v) == "[]"
    assert render("[{{z.x}}]", v) == "[]"
    assert render("[{{user.age}}]", v) == "[]"


def test_filter_upper_lower_trim():
    assert render("{{a|upper}}", {"a": "xY"}) == "XY"
    assert render("{{a|lower}}", {"a": "xY"}) == "xy"
    assert render("[{{a|trim}}]", {"a": "  x "}) == "[x]"
    assert render("[{{a|upper}}]", {}) == "[]"


def test_filter_default():
    assert render("{{a|default:fb}}", {}) == "fb"
    assert render("{{a|default:fb}}", {"a": None}) == "fb"
    assert render("{{a|default:fb}}", {"a": ""}) == "fb"
    assert render("{{a|default:fb}}", {"a": 0}) == "0"
    assert render("{{a|default:fb}}", {"a": "x"}) == "x"


def test_filter_truncate():
    assert render("{{a|truncate:5}}", {"a": "hello"}) == "hello"
    assert render("{{a|truncate:4}}", {"a": "hello"}) == "hell..."
    assert render("{{a|truncate:0}}", {"a": "hello"}) == "..."
    assert render("{{a|truncate:3}}", {}) == ""


def test_filter_length():
    assert render("{{a|length}}", {"a": "abc"}) == "3"
    assert render("{{a|length}}", {"a": [1, 2]}) == "2"
    assert render("{{a|length}}", {"a": {"k": 1}}) == "1"
    assert render("{{a|length}}", {"a": None}) == "0"
    assert render("{{a|length}}", {}) == "0"
    assert render("{{a|length}}", {"a": 12345}) == "5"


def test_filter_json():
    assert render("{{a|json}}", {"a": {"k": "é"}}) == '{"k": "é"}'
    assert render("{{a|json}}", {}) == "null"

    class Odd:
        def __str__(self):
            return "odd"

    assert render("{{a|json}}", {"a": {"o": Odd()}}) == '{"o": "odd"}'


def test_filter_chain_left_to_right():
    assert render("{{name|trim|upper|truncate:3}}", {"name": "  hello "}) == "HEL..."
    assert render("{{n|truncate:1|upper}}", {"n": "abc"}) == "A..."


def test_default_arg_with_colon_and_quoted_spaces():
    assert render("{{a|default:a:b}}", {}) == "a:b"
    assert render('[{{a|default:"  hi "}}]', {}) == "[  hi ]"
    assert render("[{{a|default:'x y'}}]", {}) == "[x y]"
    assert render("[{{a|default: z }}]", {}) == "[z]"
    assert render("[{{a|default:}}]", {}) == "[]"


BAD = [
    ("{{name|xyz}}", "unknown filter 'xyz' in {{name|xyz}}"),
    ("{{name|default}}", "filter 'default' needs an argument in {{name|default}}"),
    ("{{x|upper:1}}", "filter 'upper' takes no argument in {{x|upper:1}}"),
    (
        "{{x|truncate:abc}}",
        "filter 'truncate' needs an integer between 0 and 100000, got 'abc' in {{x|truncate:abc}}",
    ),
    (
        "{{x|truncate:100001}}",
        "filter 'truncate' needs an integer between 0 and 100000, got '100001' in {{x|truncate:100001}}",
    ),
    ("{{ x | nope }}", "unknown filter 'nope' in {{ x | nope }}"),
    ("{{x|}}", "unknown filter '' in {{x|}}"),
]


def test_errors_have_exact_messages():
    for tpl, msg in BAD[:4]:
        with pytest.raises(TemplateError) as ei:
            render(tpl, {"name": "a", "x": "b"})
        assert str(ei.value) == msg
        assert isinstance(ei.value, ValueError)


def test_check_matches_render_errors():
    for tpl, msg in BAD:
        assert check(tpl) == [msg]
        with pytest.raises(TemplateError) as ei:
            render(tpl, {})
        assert str(ei.value) == msg
    for good in ["plain", "{{a}}", "{{a.b|upper|default:x}}", '{{"a":1}}', "{{ a b }}"]:
        assert check(good) == []
    assert check("{{a|nope}} and {{b|upper:1}}") == [
        "unknown filter 'nope' in {{a|nope}}",
        "filter 'upper' takes no argument in {{b|upper:1}}",
    ]


def _fast(fn):
    t = time.monotonic()
    out = fn()
    assert time.monotonic() - t < 2
    return out


def test_no_crash_on_huge_inputs():
    big = "{{a}} x " * (1024 * 1024 // 8)
    out = _fast(lambda: render(big, {"a": "1"}))
    assert isinstance(out, str)
    _fast(lambda: check(big))
    spaces = "{{" + " " * (1024 * 1024)
    assert _fast(lambda: render(spaces, {})) == spaces
    chain = "{{a" + "|upper" * 5000 + "}}"
    assert _fast(lambda: render(chain, {"a": "x"})) == "X"
    assert _fast(lambda: check(chain)) == []
    val = "y" * 100_000
    assert _fast(lambda: render("{{a|upper|truncate:10|json}}", {"a": val})) == '"YYYYYYYYYY..."'
    assert len(_fast(lambda: render("{{a|json}}", {"a": val}))) == 100_002


def test_huge_digit_strings_do_not_crash():
    tpl = "{{x|truncate:" + "1" * 5000 + "}}"
    msg = (
        "filter 'truncate' needs an integer between 0 and 100000, got '"
        + "1" * 5000 + "' in " + tpl
    )
    assert check(tpl) == [msg]
    with pytest.raises(TemplateError) as ei:
        render(tpl, {})
    assert str(ei.value) == msg
    assert render("{{i." + "1" * 5000 + "}}", {"i": [1]}) == ""
    assert render("{{x|truncate:" + "0" * 5000 + "2}}", {"x": "abc"}) == "ab..."


def test_json_filter_circular_values():
    a: list = []
    a.append(a)
    d: dict = {}
    d["self"] = d
    assert render("{{a|json}}", {"a": a}) == '"[[...]]"'
    assert render("{{a|json}}", {"a": d}) == "\"{'self': {...}}\""


def test_truncate_missing_and_empty_arg():
    assert check("{{x|truncate}}") == [
        "filter 'truncate' needs an argument in {{x|truncate}}"
    ]
    assert check("{{x|truncate:}}") == [
        "filter 'truncate' needs an integer between 0 and 100000, got '' in {{x|truncate:}}"
    ]


def test_mismatched_quotes_kept_and_tuple_index():
    assert render("{{a|default:'x\"}}", {}) == "'x\""
    assert render("{{t.1}}{{t.2}}", {"t": ("a", "b")}) == "b"
