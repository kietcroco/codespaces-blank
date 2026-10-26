# customize/backend/flows/template.py
"""Flow template rendering: {{path|filter:arg|filter2}}.

Pure module (no I/O). `render` substitutes tokens; `check` statically
validates the filters of every token without needing variables. Both share
`_parse_filters` so their errors cannot diverge.
"""
from __future__ import annotations

import json
import re
from typing import Any, Callable

FILTER_NAMES: tuple[str, ...] = (
    "upper", "lower", "trim", "default", "truncate", "length", "json",
)

_TOKEN_RE = re.compile(r"\{\{\s*(\w+(?:\.\w+)*)\s*((?:\|[^{}|]*)*)\}\}")
_MAX_TRUNCATE = 100000


class TemplateError(ValueError):
    """A template token uses an unknown filter or a bad filter argument."""


def _to_text(value: Any) -> str:
    return "" if value is None else str(value)


def _f_default(value: Any, arg: str) -> Any:
    return arg if value is None or value == "" else value


def _f_truncate(value: Any, arg: str) -> str:
    text = _to_text(value)
    n = int(arg)
    return text[:n] + "..." if len(text) > n else text


def _f_length(value: Any, arg: str) -> str:
    if isinstance(value, (str, list, tuple, dict)):
        return str(len(value))
    return str(len(_to_text(value)))


def _f_json(value: Any, arg: str) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (ValueError, TypeError, RecursionError):
        return json.dumps(_to_text(value), ensure_ascii=False)


# name -> (needs_arg, implementation)
_FILTERS: dict[str, tuple[bool, Callable[[Any, str], Any]]] = {
    "upper": (False, lambda v, a: _to_text(v).upper()),
    "lower": (False, lambda v, a: _to_text(v).lower()),
    "trim": (False, lambda v, a: _to_text(v).strip()),
    "default": (True, _f_default),
    "truncate": (True, _f_truncate),
    "length": (False, _f_length),
    "json": (False, _f_json),
}


def _clean_arg(raw: str) -> str:
    arg = raw.strip()
    if len(arg) >= 2 and arg[0] == arg[-1] and arg[0] in "'\"":
        arg = arg[1:-1]
    return arg


def _parse_filters(token: str, raw: str) -> list[tuple[str, str]]:
    """Parse the `|a|b:arg` tail of a token into [(name, arg)]; arg is ''
    for filters written without one. Raises TemplateError."""
    out: list[tuple[str, str]] = []
    if not raw:
        return out
    for part in raw.split("|")[1:]:
        name, sep, rest = part.partition(":")
        name = name.strip()
        spec = _FILTERS.get(name)
        if spec is None:
            raise TemplateError(f"unknown filter '{name}' in {token}")
        needs_arg = spec[0]
        arg = _clean_arg(rest) if sep else ""
        if needs_arg and not sep:
            raise TemplateError(f"filter '{name}' needs an argument in {token}")
        if not needs_arg and sep:
            raise TemplateError(f"filter '{name}' takes no argument in {token}")
        if name == "truncate" and not (
            arg.isascii() and arg.isdigit() and int(arg) <= _MAX_TRUNCATE
        ):
            raise TemplateError(
                "filter 'truncate' needs an integer between 0 and "
                f"{_MAX_TRUNCATE}, got '{arg}' in {token}"
            )
        out.append((name, arg))
    return out


def _resolve(path: str, variables: dict[str, Any]) -> Any:
    cur: Any = variables
    for seg in path.split("."):
        if isinstance(cur, dict):
            if seg not in cur:
                return None
            cur = cur[seg]
        elif isinstance(cur, (list, tuple)):
            if not (seg.isascii() and seg.isdigit()) or int(seg) >= len(cur):
                return None
            cur = cur[int(seg)]
        else:
            return None
    return cur


def render(template: str, variables: dict[str, Any]) -> str:
    """Render every token in template. Raises TemplateError on a bad filter."""

    def _sub(match: re.Match[str]) -> str:
        filters = _parse_filters(match.group(0), match.group(2))
        value = _resolve(match.group(1), variables)
        for name, arg in filters:
            value = _FILTERS[name][1](value, arg)
        return _to_text(value)

    return _TOKEN_RE.sub(_sub, template)


def check(template: str) -> list[str]:
    """Statically validate filters; one message per bad token, in order."""
    errors: list[str] = []
    for match in _TOKEN_RE.finditer(template):
        try:
            _parse_filters(match.group(0), match.group(2))
        except TemplateError as exc:
            errors.append(str(exc))
    return errors
