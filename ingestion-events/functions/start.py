"""Start function: CloudWatch Logs subscription filter -> claim step.

The subscription filter on the ingestion log group delivers only records with
``event.ingestion_job_status = INGESTION_JOB_STARTED``. Each record carries the
knowledge base ARN, data source ID, and job ID, which is all the claim step
needs.
"""

from __future__ import annotations

import base64
import datetime
import gzip
import json
from typing import Any

import claim

STARTED_STATUS = "INGESTION_JOB_STARTED"


def _decode(event: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads(
        gzip.decompress(base64.b64decode(event["awslogs"]["data"]))
    )
    return payload


def _observed_at(event_timestamp: int) -> str:
    moment = datetime.datetime.fromtimestamp(
        event_timestamp / 1000, tz=datetime.timezone.utc
    )
    return claim.iso(moment)


def handler(event: dict[str, Any], _context: Any) -> dict[str, int]:
    payload = _decode(event)
    # CloudWatch Logs sends a CONTROL_MESSAGE when the filter is created.
    if payload.get("messageType") != "DATA_MESSAGE":
        claim.log(message="ignored", messageType=payload.get("messageType"))
        return {"records": 0, "announced": 0, "failed": 0}

    counts = {"records": 0, "announced": 0, "failed": 0}
    errors: list[str] = []
    for log_event in payload.get("logEvents", []):
        record = json.loads(log_event["message"])
        body = record.get("event", {})
        if body.get("ingestion_job_status") != STARTED_STATUS:
            continue
        counts["records"] += 1
        kb_arn: str = body["knowledge_base_arn"]
        kb_id = kb_arn.rsplit("/", 1)[-1]
        # An existing log group can hold records of knowledge bases that this
        # deployment doesn't track, and the poller couldn't read their jobs.
        if kb_id not in claim.TRACKED_KNOWLEDGE_BASE_IDS:
            claim.log(
                message="untracked knowledge base",
                knowledgeBaseId=kb_id,
                ingestionJobId=body.get("ingestion_job_id"),
            )
            continue
        job: claim.Job = {
            "knowledgeBaseId": kb_id,
            "knowledgeBaseArn": kb_arn,
            "dataSourceId": body["data_source_id"],
            "ingestionJobId": body["ingestion_job_id"],
        }
        try:
            outcome = claim.claim_and_announce(
                job,
                claim.LOG_SUBSCRIPTION,
                observed_at=_observed_at(record["event_timestamp"]),
            )
        # Any error: claim the rest of the batch, then fail the invocation.
        except Exception as error:  # noqa: BLE001
            counts["failed"] += 1
            errors.append(f"{job['ingestionJobId']}: {error}")
            claim.log(
                message="claim failed",
                ingestionJobId=job["ingestionJobId"],
                error=str(error),
            )
            continue
        if outcome == claim.ANNOUNCED:
            counts["announced"] += 1

    claim.log(message="batch done", **counts)
    if errors:
        # Fail the invocation so Lambda retries the batch. Jobs that were
        # announced in this batch are skipped on the retry by the claim.
        raise RuntimeError(f"{len(errors)} claims failed: {'; '.join(errors)}")
    return counts
