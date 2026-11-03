"""Validation of the structured JSON reply that instructions/structured-json.json asks for.

The answerFormat asks for exactly one JSON object and nothing else, with exactly the keys answer, sources,
confidence, followUpQuestion, and outOfScope. It doesn't specify their values, so neither does this check. A reply
wrapped in one markdown code fence is reported as `fenced`: readable, but not strict.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

ANSWER_KEYS = ("answer", "sources", "confidence", "followUpQuestion", "outOfScope")
_FENCE = re.compile(r"^\s*```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$")


@dataclass
class Validation:
    parse_class: str  # strict, fenced, prose-wrapped, unparseable, or empty
    strict_valid: bool  # the whole reply is one JSON object with exactly the five keys
    lenient_valid: bool  # as strict, but one code fence around the object is tolerated
    errors: list[str] = field(default_factory=list)
    value: dict[str, Any] | None = None  # the parsed object when lenient_valid


def _kind(value: Any) -> str:
    if value is None:
        return "null"
    names = {bool: "boolean", str: "string", list: "array", dict: "object", int: "number", float: "number"}
    return names.get(type(value), type(value).__name__)


def schema_errors(value: Any) -> list[str]:
    """Everything wrong with a parsed reply. An empty list means an object with exactly the five keys."""
    if not isinstance(value, dict):
        return [f"top level is {_kind(value)}, expected object"]
    errors = [f"missing key {key}" for key in ANSWER_KEYS if key not in value]
    errors += [f"extra key {key}" for key in value if key not in ANSWER_KEYS]
    return errors


def _parse(text: str) -> tuple[bool, Any]:
    try:
        return True, json.loads(text)
    except ValueError:
        return False, None


def validate_reply(raw: str | None) -> Validation:
    """Classify and check one reply. Never raises."""
    text = raw or ""
    if not text.strip():
        return Validation("empty", False, False, ["empty reply"])
    ok, value = _parse(text)
    if ok:
        errors = schema_errors(value)
        return Validation("strict", not errors, not errors, errors, None if errors else value)
    fence = _FENCE.match(text)
    if fence:
        ok, value = _parse(fence.group(1))
        if ok:
            errors = schema_errors(value)
            return Validation(
                "fenced", False, not errors, ["wrapped in a markdown code fence", *errors], None if errors else value
            )
    first, last = text.find("{"), text.rfind("}")
    if 0 <= first < last:
        ok, value = _parse(text[first : last + 1])
        if ok:
            return Validation(
                "prose-wrapped", False, False, ["JSON object found inside other text", *schema_errors(value)]
            )
    return Validation("unparseable", False, False, ["reply is not JSON"])
