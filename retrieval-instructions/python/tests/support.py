"""Shared helpers: the test-fixtures directory, stream fakes, and stubbed clients. No test calls AWS."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import ClientError, EventStreamError
from botocore.stub import Stubber

from ri_sample.paths import PATTERN_ROOT

FIXTURES = PATTERN_ROOT / "test-fixtures"
ACCOUNT = "123456789012"
NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


def fixture(*parts: str) -> Any:
    return json.loads((FIXTURES.joinpath(*parts)).read_text(encoding="utf-8"))


def stream_events(events: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """Yield the events; a {"raise": {code, message}} marker raises botocore's EventStreamError."""
    for event in events:
        if "raise" in event:
            error = {"Error": {"Code": event["raise"]["code"], "Message": event["raise"]["message"]}}
            raise EventStreamError(error, "AgenticRetrieveStream")
        yield event


def stream_response(name: str) -> dict[str, Any]:
    """An agentic_retrieve_stream response whose stream replays test-fixtures/streams/<name>."""
    return {"stream": stream_events(fixture("streams", name))}


def client_error(code: str, message: str = "message", operation: str = "Operation") -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": message}, "ResponseMetadata": {"RequestId": "req"}}, operation
    )


class FakeRuntime:
    """Records each agentic_retrieve_stream call and replays a stream fixture (or raises)."""

    def __init__(self, *streams: str | Exception) -> None:
        self.streams = list(streams)
        self.calls: list[dict[str, Any]] = []

    def agentic_retrieve_stream(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        item = self.streams.pop(0)
        if isinstance(item, Exception):
            raise item
        return stream_response(item)


def stubbed(service: str) -> tuple[Any, Stubber]:
    client = boto3.client(
        service, region_name="us-east-1", aws_access_key_id="testing", aws_secret_access_key="testing"
    )
    return client, Stubber(client)


def no_sleep(_: float) -> None:
    return None


class Clock:
    """A clock that advances by `step` seconds on each read."""

    def __init__(self, step: float = 1.0) -> None:
        self.t = 0.0
        self.step = step

    def __call__(self) -> float:
        self.t += self.step
        return self.t


class FakeCloudTrail:
    """lookup_events over the fixture pages, filtered by the EventName lookup attribute."""

    def __init__(self, pages: list[str] | None = None) -> None:
        self.pages = [fixture("cloudtrail", p) for p in (pages or ["page-1.json", "page-2.json"])]
        self.calls: list[dict[str, Any]] = []

    def lookup_events(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        index = int(kwargs.get("NextToken") is not None)
        page = self.pages[index]
        name = kwargs["LookupAttributes"][0]["AttributeValue"]
        out: dict[str, Any] = {"Events": [e for e in page["Events"] if e["EventName"] == name]}
        if page.get("NextToken"):
            out["NextToken"] = page["NextToken"]
        return out


def write_state(path: Path, name: str = "state.json") -> Path:
    path.write_text((FIXTURES / name).read_text(encoding="utf-8"), encoding="utf-8")
    return path
