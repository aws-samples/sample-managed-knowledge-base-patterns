"""Sweep function: announce jobs that the log path didn't announce.

Runs on a schedule with reserved concurrency 1. For each tracked knowledge
base it lists the data sources, then lists each data source's jobs newest
first and claims every job that started after the data source's watermark.
The claim step dedupes against the log path, so seeing a job twice is
harmless; the watermark only bounds the cost.
"""

from __future__ import annotations

import datetime
import os
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any

import boto3

import claim

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agent import AgentsforBedrockClient

bedrock_agent: AgentsforBedrockClient = boto3.client(
    "bedrock-agent", config=claim.BOTO_CONFIG
)

SWEEP_EPOCH = os.environ["SWEEP_EPOCH"]
SWEEP_RPS = float(os.environ["SWEEP_RPS"])
KNOWLEDGE_BASE_ARN_PREFIX = os.environ["KNOWLEDGE_BASE_ARN_PREFIX"]

MAX_WORKERS = 4
PAGE_SIZE = 10
# Stop starting new knowledge bases when less time than this is left.
MIN_REMAINING_MILLIS = 30_000


class RateLimiter:
    """Allow at most `rps` calls per second across threads."""

    def __init__(
        self,
        rps: float,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._interval = 1.0 / rps
        self._next = 0.0
        self._lock = threading.Lock()
        self._clock = clock
        self._sleep = sleep

    def acquire(self) -> None:
        with self._lock:
            now = self._clock()
            start = max(now, self._next)
            self._next = start + self._interval
        if start > now:
            self._sleep(start - now)


# ListDataSources and ListIngestionJobs each have their own request rate
# quota, so each gets its own limiter.
list_data_sources_limiter = RateLimiter(SWEEP_RPS)
list_ingestion_jobs_limiter = RateLimiter(SWEEP_RPS)


def parse_time(value: str) -> datetime.datetime:
    """Parse an ISO 8601 timestamp, including a trailing Z (Python 3.10)."""
    moment = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment


def _watermark_key(kb_id: str, ds_id: str) -> dict[str, Any]:
    return {"pk": {"S": f"ds#{kb_id}#{ds_id}"}}


def read_watermark(kb_id: str, ds_id: str) -> datetime.datetime:
    item = claim.dynamodb.get_item(
        TableName=claim.TABLE_NAME,
        Key=_watermark_key(kb_id, ds_id),
        ConsistentRead=True,
    ).get("Item")
    # A data source without a watermark starts at the deploy-time epoch, so
    # jobs from before the deployment are never announced.
    return parse_time(item["watermark"]["S"] if item else SWEEP_EPOCH)


def write_watermark(kb_id: str, ds_id: str, watermark: datetime.datetime) -> None:
    claim.dynamodb.put_item(
        TableName=claim.TABLE_NAME,
        Item={
            **_watermark_key(kb_id, ds_id),
            "watermark": {"S": watermark.isoformat()},
        },
    )


def list_data_sources(kb_id: str) -> list[str]:
    ids: list[str] = []
    token: str | None = None
    while True:
        list_data_sources_limiter.acquire()
        kwargs: dict[str, Any] = {"knowledgeBaseId": kb_id}
        if token:
            kwargs["nextToken"] = token
        page = bedrock_agent.list_data_sources(**kwargs)
        ids.extend(summary["dataSourceId"] for summary in page["dataSourceSummaries"])
        token = page.get("nextToken")
        if not token:
            return ids


def jobs_after(
    kb_id: str, ds_id: str, watermark: datetime.datetime
) -> list[dict[str, Any]]:
    """Jobs that started after the watermark, newest first.

    Every job needs a Started event, so the request lists all statuses,
    sorted by start time.
    """
    jobs: list[dict[str, Any]] = []
    token: str | None = None
    while True:
        list_ingestion_jobs_limiter.acquire()
        kwargs: dict[str, Any] = {
            "knowledgeBaseId": kb_id,
            "dataSourceId": ds_id,
            "sortBy": {"attribute": "STARTED_AT", "order": "DESCENDING"},
            "maxResults": PAGE_SIZE,
        }
        if token:
            kwargs["nextToken"] = token
        page = bedrock_agent.list_ingestion_jobs(**kwargs)
        for summary in page["ingestionJobSummaries"]:
            if summary["startedAt"] <= watermark:
                return jobs
            jobs.append(dict(summary))
        token = page.get("nextToken")
        if not token:
            return jobs


def sweep_data_source(
    kb_id: str, ds_id: str, counts: dict[str, int], lock: threading.Lock
) -> None:
    watermark = read_watermark(kb_id, ds_id)
    jobs = jobs_after(kb_id, ds_id, watermark)
    held: list[datetime.datetime] = []
    tallies = {"claimed": 0, "skipped": 0, "held": 0, "failed": 0}
    for summary in jobs:
        job: claim.Job = {
            "knowledgeBaseId": kb_id,
            "knowledgeBaseArn": KNOWLEDGE_BASE_ARN_PREFIX + kb_id,
            "dataSourceId": ds_id,
            "ingestionJobId": summary["ingestionJobId"],
        }
        try:
            outcome = claim.claim_and_announce(
                job,
                claim.RECONCILIATION,
                observed_at=claim.iso(datetime.datetime.now(datetime.timezone.utc)),
                started_at=claim.iso(summary["startedAt"]),
            )
        except Exception as error:  # noqa: BLE001
            # Treated like a held job: the watermark stays before it, so
            # the next run tries again.
            claim.log(
                message="claim failed",
                ingestionJobId=job["ingestionJobId"],
                error=str(error),
            )
            tallies["failed"] += 1
            held.append(summary["startedAt"])
            continue
        if outcome == claim.ANNOUNCED:
            tallies["claimed"] += 1
        elif outcome == claim.HELD:
            tallies["held"] += 1
            held.append(summary["startedAt"])
        else:
            tallies["skipped"] += 1

    if jobs:
        newest: datetime.datetime = jobs[0]["startedAt"]
        # Never move to or past a held job, so the next run lists it again
        # and takes it over once its lease has expired.
        if held:
            newest = max(watermark, min(held) - datetime.timedelta(microseconds=1))
        if newest > watermark:
            write_watermark(kb_id, ds_id, newest)

    with lock:
        counts["dataSources"] += 1
        for key, value in tallies.items():
            counts[key] += value


def sweep_knowledge_base(
    kb_id: str, context: Any, counts: dict[str, int], lock: threading.Lock
) -> None:
    if context.get_remaining_time_in_millis() < MIN_REMAINING_MILLIS:
        with lock:
            counts["incomplete"] += 1
        claim.log(
            message="out of time, knowledge base not swept", knowledgeBaseId=kb_id
        )
        return
    try:
        for ds_id in list_data_sources(kb_id):
            sweep_data_source(kb_id, ds_id, counts, lock)
    except Exception as error:  # noqa: BLE001
        # One knowledge base (deleted, access denied) must not stop the rest.
        with lock:
            counts["errors"] += 1
        claim.log(message="sweep failed", knowledgeBaseId=kb_id, error=str(error))
        return
    with lock:
        counts["knowledgeBases"] += 1


def handler(_event: dict[str, Any], context: Any) -> dict[str, int]:
    counts = {
        "knowledgeBases": 0,
        "dataSources": 0,
        "claimed": 0,
        "skipped": 0,
        "held": 0,
        "failed": 0,
        "incomplete": 0,
        "errors": 0,
    }
    lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = [
            pool.submit(sweep_knowledge_base, kb_id, context, counts, lock)
            for kb_id in sorted(claim.TRACKED_KNOWLEDGE_BASE_IDS)
        ]
        for future in futures:
            future.result()
    claim.log(message="sweep done", **counts)
    return counts
