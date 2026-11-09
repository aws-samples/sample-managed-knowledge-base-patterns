"""sample-state.json: byte-identical round trip, schema errors, the account and Region check, atomic writes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ri_sample import state as state_file
from ri_sample.errors import UsageError
from ri_sample.release import ReleaseConfig
from ri_sample.state import InstructionEntry, State
from support import ACCOUNT, FIXTURES, fixture, write_state

TEXT = (FIXTURES / "state.json").read_text(encoding="utf-8")
ARN = f"arn:aws:bedrock:us-east-1:{ACCOUNT}:retrieval-instruction/"


def test_round_trip_is_byte_identical(tmp_path: Path) -> None:
    loaded = state_file.load(write_state(tmp_path / "sample-state.json"))
    assert loaded is not None
    assert state_file.dumps(loaded) == TEXT
    assert loaded.release["team-support"].canary is not None
    assert loaded.instructions["team-support"].latest == "2"


def test_save_writes_atomically_and_sets_the_writer(tmp_path: Path) -> None:
    path = write_state(tmp_path / "sample-state.json")
    loaded = state_file.load(path)
    assert loaded is not None
    state_file.save(loaded, path)
    assert json.loads(path.read_text(encoding="utf-8"))["updatedBy"] == "python"
    assert not (tmp_path / "sample-state.json.tmp").exists()


def test_a_failed_write_leaves_the_file_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = write_state(tmp_path / "sample-state.json")
    loaded = state_file.load(path)
    assert loaded is not None
    loaded.region = "eu-west-1"

    def fail(*_: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr("ri_sample.state.os.replace", fail)
    with pytest.raises(OSError):
        state_file.save(loaded, path)
    assert path.read_text(encoding="utf-8") == TEXT
    assert not (tmp_path / "sample-state.json.tmp").exists()


def test_missing_file_is_none(tmp_path: Path) -> None:
    assert state_file.load(tmp_path / "sample-state.json") is None


def mutate(change: Any) -> dict[str, Any]:
    raw: dict[str, Any] = fixture("state.json")
    change(raw)
    return raw


@pytest.mark.parametrize(
    "change",
    [
        lambda r: r.update(schemaVersion=2),
        lambda r: r.update(account="12345"),
        lambda r: r.update(updatedBy="ruby"),
        lambda r: r.update(extra=True),
        lambda r: r["instructions"]["team-support"].update(name="assistant-other"),
        lambda r: r["instructions"]["team-support"].update(id="ABCDE12345"),
        lambda r: r["instructions"]["team-support"].update(arn=ARN + "zzzzz00000"),
        lambda r: r["instructions"]["team-support"].update(versions=["2", "1"]),
        lambda r: r["instructions"]["team-support"].update(createdBy="java"),
        lambda r: r["instructions"]["team-support"].update(secret="x"),
        lambda r: r["release"]["team-support"].update(live="3"),
        lambda r: r["release"]["team-support"]["canary"].update(every=0),
        lambda r: r["release"]["team-support"]["canary"].update(every=True),
        lambda r: r["release"].update({"sales-region-south": {"live": "1"}}),
    ],
)
def test_schema_errors_are_exit_2(change: Any) -> None:
    with pytest.raises(UsageError) as err:
        state_file.parse(mutate(change))
    assert err.value.exit_code == 2
    assert "isn't a valid state file" in err.value.message


def test_not_json_is_exit_2(tmp_path: Path) -> None:
    path = tmp_path / "sample-state.json"
    path.write_text("{", encoding="utf-8")
    with pytest.raises(UsageError):
        state_file.load(path)


def test_account_and_region_mismatch() -> None:
    loaded = state_file.parse(fixture("state.json"))
    state_file.check_environment(loaded, ACCOUNT, "us-east-1")
    with pytest.raises(UsageError) as err:
        state_file.check_environment(loaded, ACCOUNT, "eu-west-1")
    assert "us-east-1" in err.value.message and "eu-west-1" in err.value.message


def test_removing_an_instruction_also_removes_its_release_entry(tmp_path: Path) -> None:
    path = write_state(tmp_path / "sample-state.json")
    loaded = state_file.load(path)
    assert loaded is not None
    state_file.remove_instruction(loaded, "team-support")
    state_file.save(loaded, path)
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert "team-support" not in raw["instructions"] and "team-support" not in raw["release"]
    assert state_file.parse(raw).instructions.keys() == {"sales-region-north"}


def test_entries_stay_in_spec_order() -> None:
    s = State(ACCOUNT, "us-east-1")
    for key in ("team-support", "structured-json", "sales-region-north"):
        state_file.put_instruction(s, key, InstructionEntry(f"assistant-{key}", "abcde12345", ARN + "abcde12345"))
        state_file.add_version(s, key, "1")
        state_file.set_release(s, key, ReleaseConfig(live="1"))
    assert list(s.instructions) == ["sales-region-north", "team-support", "structured-json"]
    assert list(s.release) == ["sales-region-north", "team-support", "structured-json"]
    state_file.add_version(s, "team-support", "10")
    state_file.add_version(s, "team-support", "2")
    assert s.instructions["team-support"].versions == ["1", "2", "10"]
