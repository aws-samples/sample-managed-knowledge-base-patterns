"""Which tenant instruction and version Amazon Bedrock read, from CloudTrail event history.

When a request applies a retrieval instruction, Amazon Bedrock calls GetRetrievalInstruction on the caller's
behalf. Event history records that management event with `invokedBy: bedrock.amazonaws.com`, the
instruction ID, and the version (none for DRAFT). AgenticRetrieveStream is a data event, which event
history doesn't hold; a trail records it only after you enable data events.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

PAGE_INTERVAL_S = 0.6  # LookupEvents allows 2 requests per second per account and Region
BEDROCK = "bedrock.amazonaws.com"


@dataclass(frozen=True)
class CallRow:
    time: str
    tenant: str
    version: str
    role: str
    error: str


class Lookup:
    """LookupEvents by event name, paginated, with a pause before every request after the first."""

    def __init__(self, cloudtrail: Any, sleep: Callable[[float], None] = time.sleep) -> None:
        self.cloudtrail = cloudtrail
        self.sleep = sleep
        self.requests = 0

    def events(self, event_name: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        kwargs: dict[str, Any] = {
            "LookupAttributes": [{"AttributeKey": "EventName", "AttributeValue": event_name}],
            "StartTime": start,
            "EndTime": end,
            "MaxResults": 50,
        }
        while True:
            if self.requests:
                self.sleep(PAGE_INTERVAL_S)
            self.requests += 1
            page = self.cloudtrail.lookup_events(**kwargs)
            records.extend(json.loads(e["CloudTrailEvent"]) for e in page.get("Events", []))
            if not page.get("NextToken"):
                return records
            kwargs["NextToken"] = page["NextToken"]


def call_rows(records: list[dict[str, Any]], id_to_key: Mapping[str, str]) -> list[CallRow]:
    """Service-invoked GetRetrievalInstruction calls for the sample's instructions, oldest first."""
    rows = []
    for record in records:
        identity = record.get("userIdentity") or {}
        params = record.get("requestParameters") or {}
        key = id_to_key.get(str(params.get("retrievalInstructionId")))
        if record.get("eventName") != "GetRetrievalInstruction" or identity.get("invokedBy") != BEDROCK or not key:
            continue
        issuer = (identity.get("sessionContext") or {}).get("sessionIssuer") or {}
        rows.append(
            CallRow(
                time=str(record.get("eventTime")),
                tenant=key,
                version=str(params.get("retrievalInstructionVersion") or "DRAFT"),
                role=str(issuer.get("userName") or "-"),
                error=str(record.get("errorCode") or "none"),
            )
        )
    return sorted(rows, key=lambda row: row.time)


def lookup(
    lookup_client: Lookup, id_to_key: Mapping[str, str], since_minutes: int, now: datetime
) -> tuple[list[CallRow], int]:
    """The matching GetRetrievalInstruction rows and the AgenticRetrieveStream event count for the window."""
    start = now - timedelta(minutes=since_minutes)
    rows = call_rows(lookup_client.events("GetRetrievalInstruction", start, now), id_to_key)
    streams = [
        r
        for r in lookup_client.events("AgenticRetrieveStream", start, now)
        if r.get("eventName") == "AgenticRetrieveStream"
    ]
    return rows, len(streams)
