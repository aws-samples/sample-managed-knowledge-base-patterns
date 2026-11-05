"""The instruction spec files under instructions/: load, validate, and derive names and tags."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from ri_sample.errors import UsageError
from ri_sample.paths import INSTRUCTIONS_DIR

SAMPLE_APP = "retrieval-instructions-sample"  # value of the `app` tag on everything the sample creates
SAMPLE_TAG_KEY = "app"
TENANT_TAG_KEY = "tenant"
STRUCTURED_JSON_KEY = "structured-json"

FIELDS = ("persona", "answerFormat", "retrievalGuidance", "answerPolicy")
KINDS = ("region", "team", "combined", "json")
KEY_RE = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)?$")
NAME_RE = re.compile(r"^([0-9a-zA-Z][_-]?){1,100}$")
MAX_INSTRUCTION_CHARS = 24_000


@dataclass(frozen=True)
class Spec:
    key: str
    kind: str
    description: str
    instruction: dict[str, str]

    @property
    def name(self) -> str:
        return instruction_name(self.key)

    @property
    def tags(self) -> dict[str, str]:
        return {TENANT_TAG_KEY: self.key, SAMPLE_TAG_KEY: SAMPLE_APP}


@dataclass(frozen=True)
class SupportV2:
    key: str
    change: str
    answer_format: str


def instruction_name(key: str) -> str:
    """`assistant-<key>`, with the dot of a combined key replaced, because names allow no dots."""
    return "assistant-" + key.replace(".", "-")


def _invalid(path: Path, problem: str) -> UsageError:
    return UsageError(f"instructions/{path.name} is invalid: {problem}. Restore it from the repository")


def _read(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        raise _invalid(path, str(err)) from err


def validate_spec(raw: Any, path: Path) -> Spec:
    if not isinstance(raw, dict) or set(raw) != {"key", "kind", "description", "instruction"}:
        raise _invalid(path, "each spec has exactly key, kind, description, and instruction")
    key, kind, description, instruction = raw["key"], raw["kind"], raw["description"], raw["instruction"]
    if not isinstance(key, str) or not KEY_RE.match(key):
        raise _invalid(path, f"key {key!r} doesn't match {KEY_RE.pattern}")
    if not NAME_RE.match(instruction_name(key)):
        raise _invalid(path, f"name {instruction_name(key)!r} doesn't match the API name pattern")
    if kind not in KINDS:
        raise _invalid(path, f"{key}: kind must be one of {', '.join(KINDS)}")
    if not isinstance(description, str) or not 1 <= len(description) <= 200:
        raise _invalid(path, f"{key}: description must be 1 to 200 characters")
    if not isinstance(instruction, dict) or not instruction or not set(instruction) <= set(FIELDS):
        raise _invalid(path, f"{key}: instruction needs at least one of {', '.join(FIELDS)} and nothing else")
    for field, text in instruction.items():
        if not isinstance(text, str) or not text.strip():
            raise _invalid(path, f"{key}: {field} is empty")
    if sum(len(text) for text in instruction.values()) > MAX_INSTRUCTION_CHARS:
        raise _invalid(path, f"{key}: the instruction is over {MAX_INSTRUCTION_CHARS} characters")
    return Spec(key, kind, description, dict(instruction))


def load_specs(path: Path) -> list[Spec]:
    raw = _read(path)
    if not isinstance(raw, list) or not raw:
        raise _invalid(path, "expected a non-empty JSON array of specs")
    specs = [validate_spec(item, path) for item in raw]
    keys = [spec.key for spec in specs]
    if len(set(keys)) != len(keys):
        raise _invalid(path, "duplicate keys")
    return specs


@cache
def tenant_specs() -> tuple[Spec, ...]:
    return tuple(load_specs(INSTRUCTIONS_DIR / "tenants.json"))


@cache
def structured_json_specs() -> tuple[Spec, ...]:
    return tuple(load_specs(INSTRUCTIONS_DIR / "structured-json.json"))


@cache
def combined_specs() -> tuple[Spec, ...]:
    return tuple(load_specs(INSTRUCTIONS_DIR / "combined.json"))


def default_specs() -> tuple[Spec, ...]:
    """The six tenants and the structured JSON instruction, in spec-file order."""
    return tenant_specs() + structured_json_specs()


def all_specs() -> tuple[Spec, ...]:
    """Every spec in spec-file order: the default set, then the four combined cells."""
    specs = default_specs() + combined_specs()
    keys = [spec.key for spec in specs]
    if len(set(keys)) != len(keys):
        raise _invalid(INSTRUCTIONS_DIR / "combined.json", "a key repeats across spec files")
    return specs


def spec_for(key: str) -> Spec | None:
    return next((spec for spec in all_specs() if spec.key == key), None)


def known_names() -> list[str]:
    """The 11 instruction names this sample can create. Teardown deletes only these."""
    return [spec.name for spec in all_specs()]


def spec_order() -> list[str]:
    return [spec.key for spec in all_specs()]


@cache
def support_v2() -> SupportV2:
    path = INSTRUCTIONS_DIR / "support-v2.json"
    raw = _read(path)
    if not isinstance(raw, dict) or set(raw) != {"key", "change", "answerFormat"}:
        raise _invalid(path, "expected an object with key, change, and answerFormat")
    if not all(isinstance(raw[field], str) and raw[field].strip() for field in raw):
        raise _invalid(path, "key, change, and answerFormat must be non-empty strings")
    return SupportV2(raw["key"], raw["change"], raw["answerFormat"])
