from __future__ import annotations

import datetime
from typing import Any

import pytest

import claim
import sweep
from conftest import Stubs

KB = "EXAMPLEKB1"
DS = "EXAMPLEDS1"
UTC = datetime.timezone.utc
WATERMARK = datetime.datetime(2026, 11, 15, 17, 0, 0, tzinfo=UTC)
WATERMARK_KEY = {"pk": {"S": f"ds#{KB}#{DS}"}}


class Context:
    def __init__(self, remaining_millis: int = 240_000) -> None:
        self.remaining_millis = remaining_millis

    def get_remaining_time_in_millis(self) -> int:
        return self.remaining_millis


def at(minute: int) -> datetime.datetime:
    return datetime.datetime(2026, 11, 15, 17, minute, 0, tzinfo=UTC)


def summary(job_id: str, started_at: datetime.datetime) -> dict[str, Any]:
    return {
        "knowledgeBaseId": KB,
        "dataSourceId": DS,
        "ingestionJobId": job_id,
        "status": "COMPLETE",
        "startedAt": started_at,
        "updatedAt": started_at,
    }


@pytest.fixture(autouse=True)
def one_knowledge_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(claim, "TRACKED_KNOWLEDGE_BASE_IDS", frozenset({KB}))


@pytest.fixture
def outcomes(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Job ID -> outcome (or exception) of the claim step; records the calls."""
    table: dict[str, Any] = {"calls": []}

    def fake_claim(job: claim.Job, detected_by: str, **kwargs: Any) -> str:
        table["calls"].append({"job": job, "detectedBy": detected_by, **kwargs})
        outcome = table.get(job["ingestionJobId"], claim.ANNOUNCED)
        if isinstance(outcome, Exception):
            raise outcome
        return str(outcome)

    monkeypatch.setattr(claim, "claim_and_announce", fake_claim)
    return table


def expect_data_sources(stubs: Stubs, ids: list[str]) -> None:
    stubs.bedrock_agent.add_response(
        "list_data_sources",
        {
            "dataSourceSummaries": [
                {
                    "knowledgeBaseId": KB,
                    "dataSourceId": ds,
                    "name": ds,
                    "status": "AVAILABLE",
                    "updatedAt": WATERMARK,
                }
                for ds in ids
            ]
        },
        {"knowledgeBaseId": KB},
    )


def expect_watermark(stubs: Stubs, value: str | None) -> None:
    stubs.dynamodb.add_response(
        "get_item",
        {"Item": {**WATERMARK_KEY, "watermark": {"S": value}}} if value else {},
        {"TableName": "claims", "Key": WATERMARK_KEY, "ConsistentRead": True},
    )


def expect_jobs(
    stubs: Stubs,
    jobs: list[dict[str, Any]],
    token: str | None = None,
    next_token: str | None = None,
) -> None:
    params: dict[str, Any] = {
        "knowledgeBaseId": KB,
        "dataSourceId": DS,
        "sortBy": {"attribute": "STARTED_AT", "order": "DESCENDING"},
        "maxResults": 10,
    }
    if token:
        params["nextToken"] = token
    response: dict[str, Any] = {"ingestionJobSummaries": jobs}
    if next_token:
        response["nextToken"] = next_token
    stubs.bedrock_agent.add_response("list_ingestion_jobs", response, params)


def expect_write_watermark(stubs: Stubs, value: datetime.datetime) -> None:
    stubs.dynamodb.add_response(
        "put_item",
        {},
        {
            "TableName": "claims",
            "Item": {**WATERMARK_KEY, "watermark": {"S": value.isoformat()}},
        },
    )


def test_claims_new_jobs_and_stops_paging_at_the_watermark(
    stubs: Stubs, outcomes: dict[str, Any]
) -> None:
    expect_data_sources(stubs, [DS])
    expect_watermark(stubs, WATERMARK.isoformat())
    expect_jobs(
        stubs,
        [summary("JOB0000003", at(30)), summary("JOB0000002", at(20))],
        next_token="page2",
    )
    # The second page reaches the watermark, so there is no third call.
    expect_jobs(
        stubs,
        [summary("JOB0000001", at(10)), summary("OLDJOB0000", at(0))],
        token="page2",
        next_token="page3",
    )
    expect_write_watermark(stubs, at(30))

    result = sweep.handler({}, Context())

    assert [call["job"]["ingestionJobId"] for call in outcomes["calls"]] == [
        "JOB0000003",
        "JOB0000002",
        "JOB0000001",
    ]
    first = outcomes["calls"][0]
    assert first["detectedBy"] == "RECONCILIATION"
    assert first["started_at"] == "2026-11-15T17:30:00.000Z"
    assert (
        first["job"]["knowledgeBaseArn"]
        == f"arn:aws:bedrock:us-east-1:111122223333:knowledge-base/{KB}"
    )
    assert result["claimed"] == 3
    assert result["knowledgeBases"] == 1
    assert result["dataSources"] == 1


def test_already_announced_jobs_are_skipped_and_still_advance_the_watermark(
    stubs: Stubs, outcomes: dict[str, Any]
) -> None:
    outcomes["JOB0000001"] = claim.ALREADY_ANNOUNCED
    expect_data_sources(stubs, [DS])
    expect_watermark(stubs, WATERMARK.isoformat())
    expect_jobs(stubs, [summary("JOB0000001", at(10))])
    expect_write_watermark(stubs, at(10))

    result = sweep.handler({}, Context())

    assert result["skipped"] == 1
    assert result["claimed"] == 0


def test_the_watermark_does_not_pass_a_held_job(
    stubs: Stubs, outcomes: dict[str, Any]
) -> None:
    outcomes["JOB0000002"] = claim.HELD
    expect_data_sources(stubs, [DS])
    expect_watermark(stubs, WATERMARK.isoformat())
    expect_jobs(
        stubs,
        [
            summary("JOB0000003", at(30)),
            summary("JOB0000002", at(20)),
            summary("JOB0000001", at(10)),
        ],
    )
    # Just before the held job, so the next run lists it again.
    expect_write_watermark(stubs, at(20) - datetime.timedelta(microseconds=1))

    result = sweep.handler({}, Context())

    assert result["held"] == 1
    assert result["claimed"] == 2


def test_a_claim_that_raised_is_held(stubs: Stubs, outcomes: dict[str, Any]) -> None:
    outcomes["JOB0000001"] = RuntimeError("PutEvents failed")
    expect_data_sources(stubs, [DS])
    expect_watermark(stubs, WATERMARK.isoformat())
    expect_jobs(stubs, [summary("JOB0000001", at(10))])
    # The watermark would move back to just before the job, which is still
    # after the old watermark, so it is written.
    expect_write_watermark(stubs, at(10) - datetime.timedelta(microseconds=1))

    result = sweep.handler({}, Context())

    assert result["failed"] == 1
    assert result["claimed"] == 0


def test_a_missing_watermark_uses_the_sweep_epoch(
    stubs: Stubs, outcomes: dict[str, Any]
) -> None:
    # SWEEP_EPOCH is 12:00 in conftest: the 11:59 job predates the deployment.
    expect_data_sources(stubs, [DS])
    expect_watermark(stubs, None)
    expect_jobs(
        stubs,
        [
            summary("JOB0000001", datetime.datetime(2026, 11, 15, 12, 1, tzinfo=UTC)),
            summary("OLDJOB0000", datetime.datetime(2026, 11, 15, 11, 59, tzinfo=UTC)),
        ],
    )
    expect_write_watermark(stubs, datetime.datetime(2026, 11, 15, 12, 1, tzinfo=UTC))

    sweep.handler({}, Context())

    assert [call["job"]["ingestionJobId"] for call in outcomes["calls"]] == [
        "JOB0000001"
    ]


def test_no_new_jobs_writes_nothing(stubs: Stubs, outcomes: dict[str, Any]) -> None:
    expect_data_sources(stubs, [DS])
    expect_watermark(stubs, WATERMARK.isoformat())
    expect_jobs(stubs, [summary("OLDJOB0000", WATERMARK)])

    result = sweep.handler({}, Context())

    assert outcomes["calls"] == []
    assert result["dataSources"] == 1


def test_stops_starting_knowledge_bases_when_time_runs_out(
    stubs: Stubs, outcomes: dict[str, Any]
) -> None:
    result = sweep.handler({}, Context(remaining_millis=29_999))

    assert result["incomplete"] == 1
    assert result["knowledgeBases"] == 0
    assert outcomes["calls"] == []


def test_a_failing_knowledge_base_is_counted_and_does_not_raise(
    stubs: Stubs, outcomes: dict[str, Any]
) -> None:
    stubs.bedrock_agent.add_client_error(
        "list_data_sources", service_error_code="ResourceNotFoundException"
    )

    result = sweep.handler({}, Context())

    assert result["errors"] == 1
    assert result["knowledgeBases"] == 0


def test_rate_limiter_spaces_calls() -> None:
    clock = [100.0]
    sleeps: list[float] = []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    limiter = sweep.RateLimiter(2, clock=lambda: clock[0], sleep=sleep)
    for _ in range(3):
        limiter.acquire()

    assert sleeps == [0.5, 0.5]


def test_parse_time_accepts_a_trailing_z() -> None:
    assert sweep.parse_time("2026-11-15T12:00:00.000Z") == datetime.datetime(
        2026, 11, 15, 12, tzinfo=UTC
    )
