"""The Region rule: AWS_REGION when set, else us-east-1. Creating a client needs no credentials."""

from __future__ import annotations

import importlib

import pytest

from ri_sample import config


def reload(monkeypatch: pytest.MonkeyPatch, **env: str) -> str:
    for name in ("AWS_REGION", "AWS_DEFAULT_REGION"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    importlib.reload(config)
    assert config.agent.meta.region_name == config.region
    assert config.runtime.meta.region_name == config.region
    assert config.cloudtrail.meta.region_name == config.region
    return config.region


def test_default_is_us_east_1(monkeypatch: pytest.MonkeyPatch) -> None:
    assert reload(monkeypatch) == "us-east-1"


def test_aws_region_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    assert reload(monkeypatch, AWS_REGION="eu-west-1") == "eu-west-1"


def test_aws_default_region_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    assert reload(monkeypatch, AWS_DEFAULT_REGION="eu-west-1") == "us-east-1"


def test_runtime_client_has_the_stream_timeout_and_retries() -> None:
    assert config.RUNTIME_CONFIG.read_timeout == 120
    # botocore counts max_attempts as retries and stores the total, including the first attempt.
    assert config.RUNTIME_CONFIG.retries == {"mode": "standard", "total_max_attempts": 6}
