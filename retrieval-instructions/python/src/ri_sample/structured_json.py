"""Strict validation of the structured JSON reply that instructions/structured-json.json asks for.

The reply must be exactly one JSON object with the keys answer, sources, confidence, followUpQuestion, and
outOfScope. A reply wrapped in one markdown code fence is reported as `fenced`: readable, but not strict.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

ANSWER_KEYS = ("answer", "sources", "confidence", "followUpQuestion", "outOfScope")
CONFIDENCE_VALUES = ("high", "medium", "low")
_FENCE = re.compile(r"^\s*```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```\s*$")


@dataclass
class Validation:
    parse_class: str  # strict, fenced, prose-wrapped, unparseable, or empty
    strict_valid: bool  # the whole reply is the JSON object and every schema rule holds
    lenient_valid: bool  # as strict, but one code fence around the object is tolerated
    errors: list[str] = field(default_factory=list)
    value: dict[str, Any] | None = None  # the parsed object when lenient_valid


def _kind(value: Any) -> str:
    if value is None:
        return "null"
    names = {bool: "boolean", str: "string", list: "array", dict: "object", int: "number", float: "number"}
    return names.get(type(value), type(value).__name__)


def schema_errors(value: Any) -> list[str]:
    """Everything wrong with a parsed reply. An empty list means it matches the schema."""
    if not isinstance(value, dict):
        return [f"top level is {_kind(value)}, expected object"]
    errors = [f"missing key {key}" for key in ANSWER_KEYS if key not in value]
    errors += [f"extra key {key}" for key in value if key not in ANSWER_KEYS]
    answer = value.get("answer")
    if "answer" in value and not (isinstance(answer, str) and answer.strip()):
        errors.append("answer must be a non-empty string")
    sources = value.get("sources")
    if "sources" in value:
        if not isinstance(sources, list):
            errors.append("sources must be an array")
        elif not all(isinstance(source, str) for source in sources):
            errors.append("sources must contain only strings")
    if "confidence" in value and value["confidence"] not in CONFIDENCE_VALUES:
        errors.append(f"confidence {json.dumps(value['confidence'])} is not one of high, medium, low")
    if "followUpQuestion" in value and not (
        value["followUpQuestion"] is None or isinstance(value["followUpQuestion"], str)
    ):
        errors.append("followUpQuestion must be a string or null")
    if "outOfScope" in value and not isinstance(value["outOfScope"], bool):
        errors.append("outOfScope must be a boolean")
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
