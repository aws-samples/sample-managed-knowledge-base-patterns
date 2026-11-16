from __future__ import annotations

import base64
import gzip
import json
from typing import Any

import pytest

import claim
import start

# A start record as the knowledge base writes it to the ingestion log group.
STARTED_RECORD = {
    "event_timestamp": 1794762136050,
    "event_version": "1.0",
    "event_type": "StartIngestionJob.StatusChanged",
    "level": "INFO",
    "event": {
        "ingestion_job_id": "EXAMPLEJB1",
        "data_source_id": "EXAMPLEDS1",
        "ingestion_job_status": "INGESTION_JOB_STARTED",
        "knowledge_base_arn": "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/EXAMPLEKB1",
    },
}


def record_for(kb_id: str, job_id: str) -> dict[str, Any]:
    record: dict[str, Any] = json.loads(json.dumps(STARTED_RECORD))
    record["event"]["knowledge_base_arn"] = (
        f"arn:aws:bedrock:us-east-1:111122223333:knowledge-base/{kb_id}"
    )
    record["event"]["ingestion_job_id"] = job_id
    return record


def subscription_event(
    records: list[dict[str, Any]], message_type: str = "DATA_MESSAGE"
) -> dict[str, Any]:
    payload = {
        "messageType": message_type,
        "owner": "111122223333",
        "logGroup": "/aws/vendedlogs/bedrock/demo",
        "logStream": "bedrock/knowledgebaseslogs",
        "subscriptionFilters": ["demo-ingestion-started"],
        "logEvents": [
            {
                "id": str(index),
                "timestamp": record["event_timestamp"],
                "message": json.dumps(record),
            }
            for index, record in enumerate(records)
        ],
    }
    data = base64.b64encode(gzip.compress(json.dumps(payload).encode())).decode()
    return {"awslogs": {"data": data}}


@pytest.fixture
def claims(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    def fake_claim(job: claim.Job, detected_by: str, **kwargs: Any) -> str:
        calls.append({"job": job, "detectedBy": detected_by, **kwargs})
        if job["ingestionJobId"] == "BROKEN0000":
            raise RuntimeError("PutEvents failed")
        return claim.ANNOUNCED

    monkeypatch.setattr(claim, "claim_and_announce", fake_claim)
    return calls


def test_decodes_a_start_record_and_claims_it(
    claims: list[dict[str, Any]],
) -> None:
    result = start.handler(subscription_event([STARTED_RECORD]), None)

    assert result == {"records": 1, "announced": 1, "failed": 0}
    assert claims == [
        {
            "job": {
                "knowledgeBaseId": "EXAMPLEKB1",
                "knowledgeBaseArn": "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/EXAMPLEKB1",
                "dataSourceId": "EXAMPLEDS1",
                "ingestionJobId": "EXAMPLEJB1",
            },
            "detectedBy": "LOG_SUBSCRIPTION",
            # event_timestamp 1794762136050 is 17:02:16.050 UTC.
            "observed_at": "2026-11-15T17:02:16.050Z",
        }
    ]


def test_skips_an_untracked_knowledge_base(claims: list[dict[str, Any]]) -> None:
    result = start.handler(
        subscription_event([record_for("ZZZZZZZZZZ", "AAAAAAAAAA"), STARTED_RECORD]),
        None,
    )

    assert result["records"] == 2
    assert [call["job"]["ingestionJobId"] for call in claims] == ["EXAMPLEJB1"]


def test_ignores_records_that_are_not_start_records(
    claims: list[dict[str, Any]],
) -> None:
    crawling = {
        **STARTED_RECORD,
        "event": {"message": "Crawling started", "ingestion_job_id": "EXAMPLEJB1"},
    }
    result = start.handler(subscription_event([crawling]), None)

    assert result == {"records": 0, "announced": 0, "failed": 0}
    assert claims == []


def test_ignores_a_control_message(claims: list[dict[str, Any]]) -> None:
    result = start.handler(subscription_event([], message_type="CONTROL_MESSAGE"), None)

    assert result == {"records": 0, "announced": 0, "failed": 0}
    assert claims == []


def test_claims_the_rest_of_the_batch_then_raises_for_a_failed_claim(
    claims: list[dict[str, Any]],
) -> None:
    event = subscription_event([record_for("EXAMPLEKB1", "BROKEN0000"), STARTED_RECORD])

    with pytest.raises(RuntimeError, match="1 claims failed"):
        start.handler(event, None)
    assert [call["job"]["ingestionJobId"] for call in claims] == [
        "BROKEN0000",
        "EXAMPLEJB1",
    ]
