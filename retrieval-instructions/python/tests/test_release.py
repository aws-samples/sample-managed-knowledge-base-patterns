"""The live and canary router, and `release set` validation."""

from __future__ import annotations

import pytest

from ri_sample.errors import UsageError
from ri_sample.release import Canary, ReleaseConfig, canary_text, checked_release, describe_release, version_for


def test_no_canary_always_routes_to_live() -> None:
    assert [version_for(ReleaseConfig(live="1"), i) for i in range(10)] == ["1"] * 10


def test_canary_gets_one_request_in_every() -> None:
    cfg = ReleaseConfig(live="1", canary=Canary(version="2", every=5))
    routes = [version_for(cfg, i) for i in range(10)]
    assert routes == ["2", "1", "1", "1", "1", "2", "1", "1", "1", "1"]


def test_every_one_sends_everything_to_the_canary() -> None:
    cfg = ReleaseConfig(live="1", canary=Canary(version="2", every=1))
    assert {version_for(cfg, i) for i in range(10)} == {"2"}


def test_promote_and_roll_back() -> None:
    assert version_for(ReleaseConfig(live="2"), 3) == "2"
    assert version_for(ReleaseConfig(live="1"), 3) == "1"


def test_descriptions() -> None:
    cfg = ReleaseConfig(live="1", canary=Canary(version="2", every=5))
    assert canary_text(cfg) == "2 (1 in 5)"
    assert describe_release(cfg) == "live 1, canary 2 (1 in 5)"
    assert describe_release(ReleaseConfig(live="1")) == "live 1, no canary"
    assert canary_text(None) == "none"


def test_release_set_accepts_recorded_versions() -> None:
    assert checked_release("n", ["1", "2"], "2", None, None) == ReleaseConfig(live="2")
    assert checked_release("n", ["1", "2"], "1", "2", 5) == ReleaseConfig(live="1", canary=Canary("2", 5))


@pytest.mark.parametrize(
    ("live", "canary", "every", "problem"),
    [
        ("3", None, None, "isn't recorded"),
        ("1", "3", 5, "isn't recorded"),
        ("v1", None, None, "isn't a version number"),
        ("1", "2", None, "--canary needs --every"),
        ("1", None, 5, "--every needs --canary"),
        ("1", "2", 0, "--every must be 1 or more"),
    ],
)
def test_release_set_rejects(live: str, canary: str | None, every: int | None, problem: str) -> None:
    with pytest.raises(UsageError, match=problem):
        checked_release("assistant-team-support", ["1", "2"], live, canary, every)
