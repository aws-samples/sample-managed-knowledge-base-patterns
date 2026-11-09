"""The instruction spec files: they load, and the validator rejects what the API would."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ri_sample.errors import UsageError
from ri_sample.paths import PATTERN_ROOT
from ri_sample.specs import (
    SAMPLE_APP,
    SAMPLE_TAG_KEY,
    TENANT_TAG_KEY,
    all_specs,
    combined_specs,
    default_specs,
    instruction_name,
    known_names,
    load_specs,
    support_v2,
)
from ri_sample.structured_json import ANSWER_KEYS
from support import fixture

CONSTANTS = fixture("constants.json")
# The answerFormat text the post shows, joined into one line.
POST_ANSWER_FORMAT = (
    "Reply with exactly one JSON object and nothing else. Do not use markdown, do not use code fences, and do not "
    "write any text before or after the object. The object has exactly these five keys and no others: "
    '"answer", "sources", "confidence", "followUpQuestion", "outOfScope". '
    'If you cannot answer, set "outOfScope" to true.'
)
GOOD = {
    "key": "sales-region-north",
    "kind": "region",
    "description": "A description",
    "instruction": {"persona": "You are a demo assistant."},
}


def write(tmp_path: Path, specs: list[dict[str, Any]]) -> Path:
    path = tmp_path / "specs.json"
    path.write_text(json.dumps(specs), encoding="utf-8")
    return path


def test_spec_files_load_in_order() -> None:
    assert [s.key for s in default_specs()] == [*CONSTANTS["tenantKeys"], CONSTANTS["structuredJsonKey"]]
    assert [s.key for s in combined_specs()] == CONSTANTS["combinedKeys"]
    assert [s.kind for s in all_specs()] == ["region"] * 3 + ["team"] * 3 + ["json"] + ["combined"] * 4


def test_names_and_tags_equal_constants() -> None:
    assert known_names() == CONSTANTS["instructionNames"]
    assert len(known_names()) == 11
    assert instruction_name("sales-region-north.team-support") == "assistant-sales-region-north-team-support"
    assert (SAMPLE_TAG_KEY, SAMPLE_APP, TENANT_TAG_KEY) == (
        CONSTANTS["sampleTagKey"],
        CONSTANTS["sampleTagValue"],
        CONSTANTS["tenantTagKey"],
    )
    assert all_specs()[0].tags == {"tenant": "sales-region-north", "app": SAMPLE_APP}


def test_create_call_tag_literal_equals_the_sample_tag() -> None:
    source = (PATTERN_ROOT / "python" / "src" / "ri_sample" / "instructions.py").read_text(encoding="utf-8")
    line = next(x for x in source.splitlines() if "tags={" in x)
    assert line.strip() == (
        'tags={"tenant": tenant, "app": "retrieval-instructions-sample"},  # IAM conditions use both tags'
    )
    assert f'"{SAMPLE_TAG_KEY}": "{SAMPLE_APP}"' in line


def test_structured_json_spec_is_the_posts_answer_format() -> None:
    spec = next(s for s in default_specs() if s.kind == "json")
    assert set(spec.instruction) == {"answerFormat"}
    assert spec.instruction["answerFormat"] == POST_ANSWER_FORMAT
    assert all(f'"{key}"' in spec.instruction["answerFormat"] for key in ANSWER_KEYS)


def test_support_v2_spec() -> None:
    v2 = support_v2()
    assert v2.key == "team-support"
    assert v2.answer_format.endswith("Keep the whole note under 120 words.")
    assert "Ticket ref: pending" in v2.answer_format


@pytest.mark.parametrize(
    ("patch", "problem"),
    [
        ({"key": "Sales Region"}, "doesn't match"),
        ({"key": "a" * 100}, "API name pattern"),
        ({"kind": "other"}, "kind must be"),
        ({"description": ""}, "description must be"),
        ({"description": "x" * 201}, "description must be"),
        ({"instruction": {}}, "needs at least one"),
        ({"instruction": {"persona": "   "}}, "persona is empty"),
        ({"instruction": {"tone": "x"}}, "needs at least one"),
        ({"instruction": {"persona": "x" * 12_001, "answerPolicy": "y" * 12_000}}, "over 24000 characters"),
    ],
)
def test_invalid_specs_are_rejected(tmp_path: Path, patch: dict[str, Any], problem: str) -> None:
    with pytest.raises(UsageError) as err:
        load_specs(write(tmp_path, [{**GOOD, **patch}]))
    assert problem in err.value.message
    assert err.value.exit_code == 2


def test_duplicate_keys_and_bad_json_are_rejected(tmp_path: Path) -> None:
    with pytest.raises(UsageError):
        load_specs(write(tmp_path, [GOOD, GOOD]))
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    with pytest.raises(UsageError):
        load_specs(bad)


def test_every_spec_is_within_the_limits() -> None:
    for spec in all_specs():
        assert 1 <= len(spec.description) <= 200
        assert "Track" not in spec.description
        assert sum(len(v) for v in spec.instruction.values()) <= 24_000
