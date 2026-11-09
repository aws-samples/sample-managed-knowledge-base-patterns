"""CloudTrail event history: service-invoked GetRetrievalInstruction calls for the sample's instructions."""

from __future__ import annotations

from datetime import timedelta

from ri_sample.cloudtrail import PAGE_INTERVAL_S, CallRow, Lookup, lookup
from support import NOW, FakeCloudTrail

ID_TO_KEY = {"abcde12345": "sales-region-north", "fghij67890": "team-support"}


def test_keeps_only_service_invoked_calls_for_sample_ids_with_draft_for_no_version() -> None:
    rows, streams = lookup(Lookup(FakeCloudTrail(), lambda _: None), ID_TO_KEY, 60, NOW)
    assert rows == [
        CallRow("2026-10-01T12:02:00Z", "team-support", "2", "ExampleApplierRole", "AccessDenied"),
        CallRow("2026-10-01T12:05:00Z", "sales-region-north", "1", "ExampleOperatorRole", "none"),
        CallRow("2026-10-01T12:20:00Z", "team-support", "DRAFT", "ExampleOperatorRole", "none"),
    ]
    assert streams == 2


def test_paginates_with_a_pause_between_requests() -> None:
    sleeps: list[float] = []
    trail = FakeCloudTrail()
    lookup(Lookup(trail, sleeps.append), ID_TO_KEY, 30, NOW)
    assert len(trail.calls) == 4  # two pages for each event name
    assert sleeps == [PAGE_INTERVAL_S] * 3
    first = trail.calls[0]
    assert first["LookupAttributes"] == [{"AttributeKey": "EventName", "AttributeValue": "GetRetrievalInstruction"}]
    assert first["StartTime"] == NOW - timedelta(minutes=30) and first["EndTime"] == NOW
    assert first["MaxResults"] == 50
    assert trail.calls[1]["NextToken"] == "example-next-token"
