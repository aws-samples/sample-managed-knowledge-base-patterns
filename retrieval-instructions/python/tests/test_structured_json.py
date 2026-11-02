"""The strict validator for the five-key JSON reply."""

from __future__ import annotations

import json
from typing import Any

import pytest

from ri_sample.structured_json import validate_reply

VALID: dict[str, Any] = {
    "answer": "You can return an opened unit within 30 days.",
    "sources": ["global-returns-policy-v2-0.md"],
    "confidence": "high",
    "followUpQuestion": None,
    "outOfScope": False,
}


def test_valid_object_is_strict_valid() -> None:
    check = validate_reply(json.dumps(VALID))
    assert (check.parse_class, check.strict_valid, check.lenient_valid, check.errors) == ("strict", True, True, [])
    assert check.value == VALID


def test_extra_and_missing_keys_fail() -> None:
    assert validate_reply(json.dumps({**VALID, "notes": "x"})).errors == ["extra key notes"]
    missing = {k: v for k, v in VALID.items() if k != "outOfScope"}
    check = validate_reply(json.dumps(missing))
    assert not check.strict_valid and check.errors == ["missing key outOfScope"] and check.value is None


def test_fenced_reply_is_readable_but_not_strict() -> None:
    check = validate_reply("```json\n" + json.dumps(VALID) + "\n```")
    assert (check.parse_class, check.strict_valid, check.lenient_valid) == ("fenced", False, True)
    assert check.errors == ["wrapped in a markdown code fence"]


@pytest.mark.parametrize(
    ("reply", "parse_class"),
    [
        ("The return window is 30 days.", "unparseable"),
        ("Here you go: " + json.dumps(VALID), "prose-wrapped"),
        ("   ", "empty"),
        (None, "empty"),
    ],
)
def test_non_json_replies_fail(reply: str | None, parse_class: str) -> None:
    check = validate_reply(reply)
    assert check.parse_class == parse_class
    assert not check.strict_valid and not check.lenient_valid and check.value is None


@pytest.mark.parametrize(
    ("patch", "error"),
    [
        ({"answer": " "}, "answer must be a non-empty string"),
        ({"sources": "a.md"}, "sources must be an array"),
        ({"sources": ["a.md", 1]}, "sources must contain only strings"),
        ({"confidence": "certain"}, 'confidence "certain" is not one of high, medium, low'),
        ({"followUpQuestion": 3}, "followUpQuestion must be a string or null"),
        ({"outOfScope": "false"}, "outOfScope must be a boolean"),
    ],
)
def test_wrong_value_types_fail(patch: dict[str, Any], error: str) -> None:
    assert validate_reply(json.dumps({**VALID, **patch})).errors == [error]


def test_top_level_array_fails() -> None:
    assert validate_reply(json.dumps([VALID])).errors == ["top level is array, expected object"]
