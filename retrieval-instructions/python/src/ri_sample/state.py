"""sample-state.json: the instructions this sample created and each tenant's release configuration.

Both the Python and the TypeScript programs read and write this file, so its format is fixed: schema
version 1, `json.dumps(obj, indent=2, ensure_ascii=False)` plus a newline, written atomically.
It holds instruction IDs and ARNs and the account ID, never credentials. It is gitignored.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ri_sample.errors import UsageError
from ri_sample.paths import STATE_FILE
from ri_sample.release import VERSION_RE, Canary, ReleaseConfig
from ri_sample.specs import KEY_RE, instruction_name, spec_order

SCHEMA_VERSION = 1
WRITERS = ("python", "typescript")
WRITER = "python"
ACCOUNT_RE = re.compile(r"^[0-9]{12}$")
ID_RE = re.compile(r"^[a-z0-9]{10}$")
ARN_RE = re.compile(r"^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:[0-9]{12}:retrieval-instruction/([a-z0-9]{10})$")
INVALID = (
    "sample-state.json isn't a valid state file ({problem}). It holds no secrets: fix or delete it; "
    "teardown still finds sample instructions by name and tag"
)


@dataclass
class InstructionEntry:
    name: str
    id: str
    arn: str
    versions: list[str] = field(default_factory=list)
    created_by: str = WRITER

    @property
    def latest(self) -> str | None:
        return self.versions[-1] if self.versions else None


@dataclass
class State:
    account: str
    region: str
    instructions: dict[str, InstructionEntry] = field(default_factory=dict)
    release: dict[str, ReleaseConfig] = field(default_factory=dict)
    updated_by: str = WRITER


def _invalid(problem: str) -> UsageError:
    return UsageError(INVALID.format(problem=problem))


def _version_list(value: Any, key: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) and VERSION_RE.match(v) for v in value):
        raise _invalid(f"{key}: versions must be a list of version strings")
    if [int(v) for v in value] != sorted({int(v) for v in value}):
        raise _invalid(f"{key}: versions must be unique and ascending")
    return list(value)


def _entry(key: str, raw: Any) -> InstructionEntry:
    fields = {"name", "id", "arn", "versions", "createdBy"}
    if not isinstance(raw, dict) or set(raw) != fields:
        raise _invalid(f"{key}: an instruction has exactly {', '.join(sorted(fields))}")
    if raw["name"] != instruction_name(key):
        raise _invalid(f"{key}: name must be {instruction_name(key)}")
    if not isinstance(raw["id"], str) or not ID_RE.match(raw["id"]):
        raise _invalid(f"{key}: id must be 10 lowercase letters or digits")
    match = ARN_RE.match(raw["arn"]) if isinstance(raw["arn"], str) else None
    if not match or match.group(1) != raw["id"]:
        raise _invalid(f"{key}: arn must be the instruction's ARN")
    if raw["createdBy"] not in WRITERS:
        raise _invalid(f"{key}: createdBy must be python or typescript")
    return InstructionEntry(raw["name"], raw["id"], raw["arn"], _version_list(raw["versions"], key), raw["createdBy"])


def _release(key: str, raw: Any, entry: InstructionEntry | None) -> ReleaseConfig:
    if entry is None:
        raise _invalid(f"release {key}: no instruction recorded for this key")
    if not isinstance(raw, dict) or "live" not in raw or not set(raw) <= {"live", "canary"}:
        raise _invalid(f"release {key}: expected live and an optional canary")
    if raw["live"] not in entry.versions:
        raise _invalid(f"release {key}: live must be one of the recorded versions")
    if "canary" not in raw:
        return ReleaseConfig(live=raw["live"])
    canary = raw["canary"]
    if not isinstance(canary, dict) or set(canary) != {"version", "every"}:
        raise _invalid(f"release {key}: canary has exactly version and every")
    if canary["version"] not in entry.versions:
        raise _invalid(f"release {key}: canary version must be one of the recorded versions")
    every = canary["every"]
    if not isinstance(every, int) or isinstance(every, bool) or every < 1:
        raise _invalid(f"release {key}: canary every must be an integer of 1 or more")
    return ReleaseConfig(live=raw["live"], canary=Canary(version=canary["version"], every=every))


def parse(raw: Any) -> State:
    """Validate a decoded state file. Raises UsageError (exit 2) for anything outside schema version 1."""
    top = {"schemaVersion", "account", "region", "instructions", "release", "updatedBy"}
    if not isinstance(raw, dict) or set(raw) != top:
        raise _invalid(f"expected exactly {', '.join(sorted(top))}")
    if raw["schemaVersion"] != SCHEMA_VERSION or isinstance(raw["schemaVersion"], bool):
        raise _invalid("schemaVersion must be 1")
    if not isinstance(raw["account"], str) or not ACCOUNT_RE.match(raw["account"]):
        raise _invalid("account must be 12 digits")
    if not isinstance(raw["region"], str) or not raw["region"]:
        raise _invalid("region must be a non-empty string")
    if raw["updatedBy"] not in WRITERS:
        raise _invalid("updatedBy must be python or typescript")
    if not isinstance(raw["instructions"], dict) or not isinstance(raw["release"], dict):
        raise _invalid("instructions and release must be objects")
    instructions: dict[str, InstructionEntry] = {}
    for key, value in raw["instructions"].items():
        if not KEY_RE.match(key):
            raise _invalid(f"instruction key {key!r} isn't a spec key")
        instructions[key] = _entry(key, value)
    release = {key: _release(key, value, instructions.get(key)) for key, value in raw["release"].items()}
    return State(raw["account"], raw["region"], instructions, release, raw["updatedBy"])


def to_json(state: State) -> dict[str, Any]:
    release: dict[str, Any] = {}
    for key, cfg in state.release.items():
        release[key] = {"live": cfg.live}
        if cfg.canary is not None:
            release[key]["canary"] = {"version": cfg.canary.version, "every": cfg.canary.every}
    return {
        "schemaVersion": SCHEMA_VERSION,
        "account": state.account,
        "region": state.region,
        "instructions": {
            key: {"name": e.name, "id": e.id, "arn": e.arn, "versions": list(e.versions), "createdBy": e.created_by}
            for key, e in state.instructions.items()
        },
        "release": release,
        "updatedBy": state.updated_by,
    }


def dumps(state: State) -> str:
    return json.dumps(to_json(state), indent=2, ensure_ascii=False) + "\n"


def load(path: Path = STATE_FILE) -> State | None:
    """The state file, or None when it doesn't exist."""
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except OSError as err:
        raise _invalid(str(err)) from err
    try:
        raw = json.loads(text)
    except ValueError as err:
        raise _invalid("not JSON") from err
    return parse(raw)


def save(state: State, path: Path = STATE_FILE) -> None:
    """Write the state atomically: a .tmp file in the same directory, then a rename over the target."""
    state.updated_by = WRITER
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(dumps(state), encoding="utf-8")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def delete(path: Path = STATE_FILE) -> None:
    if path.exists():
        path.unlink()


def check_environment(state: State, account: str, region: str) -> None:
    """Refuse to use instruction IDs recorded for another account or Region."""
    if state.account != account or state.region != region:
        raise UsageError(
            f"sample-state.json was written for account {state.account} in {state.region}, but the current "
            f"credentials and Region are account {account} in {region}. Switch credentials or set AWS_REGION, "
            f"or run teardown where the state was written"
        )


def _ordered(keys: list[str]) -> list[str]:
    order = {key: i for i, key in enumerate(spec_order())}
    return sorted(keys, key=lambda k: order.get(k, len(order)))


def put_instruction(state: State, key: str, entry: InstructionEntry) -> None:
    """Record an instruction, keeping the keys in spec-file order."""
    merged = {**state.instructions, key: entry}
    state.instructions = {k: merged[k] for k in _ordered(list(merged))}


def add_version(state: State, key: str, version: str) -> None:
    entry = state.instructions[key]
    if version not in entry.versions:
        entry.versions = sorted({*entry.versions, version}, key=int)


def set_release(state: State, key: str, cfg: ReleaseConfig) -> None:
    merged = {**state.release, key: cfg}
    state.release = {k: merged[k] for k in _ordered(list(merged))}


def remove_instruction(state: State, key: str) -> None:
    """Drop an instruction and its release entry together, so the file stays valid."""
    state.instructions.pop(key, None)
    state.release.pop(key, None)
