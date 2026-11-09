"""Release instruction changes one tenant at a time.

Each tenant's release configuration lives in sample-state.json: the live version and an optional canary.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from ri_sample.errors import UsageError

VERSION_RE = re.compile(r"^[1-9][0-9]{0,8}$")


# The application owns routing. Amazon Bedrock serves the version you pin on each request.
@dataclass(frozen=True)
class Canary:
    version: str  # version that gets the canary share, for example "2"
    every: int  # one request in `every` goes to `version`


@dataclass(frozen=True)
class ReleaseConfig:
    live: str  # version for normal traffic, for example "1"
    canary: Canary | None = None


def version_for(cfg: ReleaseConfig, request_index: int) -> str:
    if cfg.canary and request_index % cfg.canary.every == 0:
        return cfg.canary.version
    return cfg.live


# Promote: ReleaseConfig(live="2"). Roll back: ReleaseConfig(live="1").


def canary_text(cfg: ReleaseConfig | None) -> str:
    """`2 (1 in 5)`, or `none`."""
    if cfg is None or cfg.canary is None:
        return "none"
    return f"{cfg.canary.version} (1 in {cfg.canary.every})"


def describe_release(cfg: ReleaseConfig) -> str:
    """`live 1, canary 2 (1 in 5)` or `live 1, no canary`."""
    if cfg.canary is None:
        return f"live {cfg.live}, no canary"
    return f"live {cfg.live}, canary {canary_text(cfg)}"


def checked_release(
    name: str, versions: Sequence[str], live: str, canary: str | None, every: int | None
) -> ReleaseConfig:
    """Validate `release set` options against the versions this sample recorded for the instruction."""
    for value in (live, canary):
        if value is None:
            continue
        if not VERSION_RE.match(value):
            raise UsageError(f"version {value!r} isn't a version number such as 1 or 2")
        if value not in versions:
            raise UsageError(f"version {value} isn't recorded for {name}; release show lists the versions")
    if canary is None:
        if every is not None:
            raise UsageError("--every needs --canary")
        return ReleaseConfig(live=live)
    if every is None:
        raise UsageError("--canary needs --every")
    if every < 1:
        raise UsageError("--every must be 1 or more")
    return ReleaseConfig(live=live, canary=Canary(version=canary, every=every))
