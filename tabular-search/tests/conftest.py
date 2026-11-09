"""Shared fixtures. Every test runs offline: clients use fake credentials and a Stubber."""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest

HERE = Path(__file__).resolve().parent.parent


def load_script(file_name: str) -> ModuleType:
    """Import a numbered script, such as 01_check_file_types.py, which import can't name."""
    spec = importlib.util.spec_from_file_location(
        file_name.removesuffix(".py"), HERE / file_name
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def offline_aws(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Fake credentials and a Region, so no test can reach a real account."""
    for name in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.delenv("AWS_REGION", raising=False)
    monkeypatch.setenv("AWS_DEFAULT_REGION", "us-east-1")
    monkeypatch.setenv("AWS_CONFIG_FILE", "/dev/null")
    monkeypatch.setenv("AWS_SHARED_CREDENTIALS_FILE", "/dev/null")
    # Wide help output, so argparse doesn't wrap values such as the stack name.
    monkeypatch.setenv("COLUMNS", "200")
    yield


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("time.sleep", lambda _: None)
