from __future__ import annotations

import datetime
import json
from typing import Any

import pytest
from botocore.exceptions import ClientError
from botocore.stub import ANY

import claim
from conftest import Stubs

NOW = datetime.datetime(2026, 11, 15, 20, 30, 19, 214000, tzinfo=datetime.timezone.utc)
NOW_MS = int(NOW.timestamp() * 1000)
JOB: claim.Job = {
    "knowledgeBaseId": "EXAMPLEKB2",
    "knowledgeBaseArn": "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/EXAMPLEKB2",
    "dataSourceId": "EXAMPLEDS2",
    "ingestionJobId": "EXAMPLEJB2",
}
PK = {"pk": {"S": "job#EXAMPLEKB2#EXAMPLEDS2#EXAMPLEJB2"}}
EXECUTION_NAME = "EXAMPLEKB2-EXAMPLEDS2-EXAMPLEJB2"
# The same job ID on another data source of the same knowledge base.
OTHER_DS_JOB: claim.Job = {**JOB, "dataSourceId": "EXAMPLEDS3"}
OTHER_DS_PK = {"pk": {"S": "job#EXAMPLEKB2#EXAMPLEDS3#EXAMPLEJB2"}}
OTHER_DS_EXECUTION_NAME = "EXAMPLEKB2-EXAMPLEDS3-EXAMPLEJB2"
OBSERVED_AT = "2026-11-15T20:30:19.214Z"


def expect_put_claim(
    stubs: Stubs,
    detected_by: str = claim.LOG_SUBSCRIPTION,
    error: str | None = None,
    job: claim.Job = JOB,
    key: dict[str, Any] = PK,
) -> None:
    params = {
        "TableName": "claims",
        "Item": {
            **key,
            "state": {"S": "CLAIMED"},
            "claimedAt": {"N": str(NOW_MS)},
            "detectedBy": {"S": detected_by},
            "knowledgeBaseId": {"S": job["knowledgeBaseId"]},
            "dataSourceId": {"S": job["dataSourceId"]},
            "ttl": {"N": str(int(NOW.timestamp()) + 7 * 24 * 3600)},
        },
        "ConditionExpression": "attribute_not_exists(pk) OR (#state = :claimed AND claimedAt < :leaseCutoff)",
        "ExpressionAttributeNames": {"#state": "state"},
        "ExpressionAttributeValues": {
            ":claimed": {"S": "CLAIMED"},
            ":leaseCutoff": {"N": str(NOW_MS - 300 * 1000)},
        },
    }
    if error:
        stubs.dynamodb.add_client_error(
            "put_item", service_error_code=error, expected_params=params
        )
    else:
        stubs.dynamodb.add_response("put_item", {}, params)


def expect_get_claim(stubs: Stubs, state: str | None) -> None:
    item = {"Item": {"state": {"S": state}}} if state else {}
    stubs.dynamodb.add_response(
        "get_item",
        item,
        {
            "TableName": "claims",
            "Key": PK,
            "ConsistentRead": True,
            "ProjectionExpression": "#state",
            "ExpressionAttributeNames": {"#state": "state"},
        },
    )


def execution_input(detected_by: str, job: claim.Job = JOB) -> str:
    return json.dumps(
        {
            "dataSourceId": job["dataSourceId"],
            "detectedBy": detected_by,
            "ingestionJobId": job["ingestionJobId"],
            "knowledgeBaseArn": job["knowledgeBaseArn"],
            "knowledgeBaseId": job["knowledgeBaseId"],
            "trigger": "UNKNOWN",
        },
        sort_keys=True,
    )


def expect_start_execution(
    stubs: Stubs,
    detected_by: str = claim.LOG_SUBSCRIPTION,
    error: str | None = None,
    job: claim.Job = JOB,
    name: str = EXECUTION_NAME,
) -> None:
    params = {
        "stateMachineArn": "arn:aws:states:us-east-1:111122223333:stateMachine:poller",
        "name": name,
        "input": execution_input(detected_by, job),
    }
    if error:
        stubs.sfn.add_client_error(
            "start_execution",
            service_error_code=error,
            http_status_code=400,
            expected_params=params,
        )
    else:
        stubs.sfn.add_response(
            "start_execution",
            {
                "executionArn": f"arn:aws:states:us-east-1:111122223333:execution:poller:{name}",
                "startDate": NOW,
            },
            params,
        )


def expect_put_events(stubs: Stubs, failed: int = 0) -> None:
    # The entry shape PutEvents returns for a failed entry.
    entries: list[dict[str, Any]] = (
        [{"ErrorCode": "MalformedDetail", "ErrorMessage": "Detail is malformed."}]
        if failed
        else [{"EventId": "1"}]
    )
    stubs.events.add_response(
        "put_events",
        {"FailedEntryCount": failed, "Entries": entries},
        {
            "Entries": [
                {
                    "Source": "custom.bedrock.kb-ingestion",
                    "DetailType": "Knowledge Base Ingestion Job Started",
                    "Detail": ANY,
                    "EventBusName": "default",
                    "Resources": [JOB["knowledgeBaseArn"]],
                }
            ]
        },
    )


def expect_mark_announced(stubs: Stubs, key: dict[str, Any] = PK) -> None:
    stubs.dynamodb.add_response(
        "update_item",
        {},
        {
            "TableName": "claims",
            "Key": key,
            "UpdateExpression": "SET #state = :announced",
            "ExpressionAttributeNames": {"#state": "state"},
            "ExpressionAttributeValues": {":announced": {"S": "ANNOUNCED"}},
        },
    )


def expect_release(stubs: Stubs) -> None:
    stubs.dynamodb.add_response(
        "delete_item",
        {},
        {
            "TableName": "claims",
            "Key": PK,
            "ConditionExpression": "#state = :claimed AND claimedAt = :mine",
            "ExpressionAttributeNames": {"#state": "state"},
            "ExpressionAttributeValues": {
                ":claimed": {"S": "CLAIMED"},
                ":mine": {"N": str(NOW_MS)},
            },
        },
    )


def test_new_claim_announces(stubs: Stubs, capsys: pytest.CaptureFixture[str]) -> None:
    expect_put_claim(stubs)
    expect_start_execution(stubs)
    expect_put_events(stubs)
    expect_mark_announced(stubs)

    outcome = claim.claim_and_announce(
        JOB, claim.LOG_SUBSCRIPTION, observed_at=OBSERVED_AT, now=NOW
    )

    assert outcome == claim.ANNOUNCED
    announced = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert announced == {
        "message": "announced",
        "version": "1",
        "knowledgeBaseId": "EXAMPLEKB2",
        "knowledgeBaseArn": JOB["knowledgeBaseArn"],
        "dataSourceId": "EXAMPLEDS2",
        "ingestionJobId": "EXAMPLEJB2",
        "status": "STARTED",
        "observedAt": OBSERVED_AT,
        "trigger": "UNKNOWN",
        "detectedBy": "LOG_SUBSCRIPTION",
    }


def test_same_job_id_on_two_data_sources_gets_two_claims_and_two_executions(
    stubs: Stubs,
) -> None:
    # Each claim is a new item under its own key, and each poller has its own
    # name, so neither job is skipped as already announced.
    expect_put_claim(stubs)
    expect_start_execution(stubs)
    expect_put_events(stubs)
    expect_mark_announced(stubs)
    expect_put_claim(stubs, job=OTHER_DS_JOB, key=OTHER_DS_PK)
    expect_start_execution(stubs, job=OTHER_DS_JOB, name=OTHER_DS_EXECUTION_NAME)
    expect_put_events(stubs)
    expect_mark_announced(stubs, key=OTHER_DS_PK)

    outcomes = [
        claim.claim_and_announce(
            job, claim.LOG_SUBSCRIPTION, observed_at=OBSERVED_AT, now=NOW
        )
        for job in (JOB, OTHER_DS_JOB)
    ]

    assert outcomes == [claim.ANNOUNCED, claim.ANNOUNCED]


def test_claim_key_and_execution_name_fit_step_functions_rules() -> None:
    # StartExecution names: 1 to 80 characters; 0-9, A-Z, a-z, - and _ keep
    # CloudWatch Logs logging available.
    name = claim.execution_name(JOB)
    assert name == EXECUTION_NAME
    assert len(name) <= 80
    assert all(char.isascii() and (char.isalnum() or char in "-_") for char in name)
    assert claim.claim_key(JOB) == PK["pk"]["S"]


def test_started_detail_from_the_log_path_has_no_started_at() -> None:
    detail = claim._started_detail(JOB, claim.LOG_SUBSCRIPTION, OBSERVED_AT, None)
    assert "startedAt" not in detail
    assert detail["observedAt"] == OBSERVED_AT


def test_started_detail_from_the_sweep_has_started_at() -> None:
    detail = claim._started_detail(
        JOB, claim.RECONCILIATION, OBSERVED_AT, "2026-11-15T20:30:18.000Z"
    )
    assert detail["startedAt"] == "2026-11-15T20:30:18.000Z"
    assert detail["detectedBy"] == "RECONCILIATION"


def test_execution_input_is_byte_identical_for_the_same_path() -> None:
    first = claim._execution_input(JOB, claim.LOG_SUBSCRIPTION)
    reordered: claim.Job = {
        "ingestionJobId": "EXAMPLEJB2",
        "dataSourceId": "EXAMPLEDS2",
        "knowledgeBaseArn": JOB["knowledgeBaseArn"],
        "knowledgeBaseId": "EXAMPLEKB2",
    }
    assert claim._execution_input(reordered, claim.LOG_SUBSCRIPTION) == first


def test_already_announced_sends_no_event(stubs: Stubs) -> None:
    expect_put_claim(stubs, error="ConditionalCheckFailedException")
    expect_get_claim(stubs, "ANNOUNCED")

    outcome = claim.claim_and_announce(
        JOB, claim.LOG_SUBSCRIPTION, observed_at=OBSERVED_AT, now=NOW
    )

    assert outcome == claim.ALREADY_ANNOUNCED


def test_live_claim_is_held(stubs: Stubs) -> None:
    expect_put_claim(
        stubs, detected_by=claim.RECONCILIATION, error="ConditionalCheckFailedException"
    )
    expect_get_claim(stubs, "CLAIMED")

    outcome = claim.claim_and_announce(
        JOB, claim.RECONCILIATION, observed_at=OBSERVED_AT, now=NOW
    )

    assert outcome == claim.HELD


def test_expired_lease_takeover_treats_an_existing_execution_as_started(
    stubs: Stubs,
) -> None:
    # The dead claimer was the log path; the sweep takes over. The running
    # poller has the other path's input, so StartExecution raises
    # ExecutionAlreadyExists.
    expect_put_claim(stubs, detected_by=claim.RECONCILIATION)
    expect_start_execution(
        stubs, detected_by=claim.RECONCILIATION, error="ExecutionAlreadyExists"
    )
    expect_put_events(stubs)
    expect_mark_announced(stubs)

    outcome = claim.claim_and_announce(
        JOB,
        claim.RECONCILIATION,
        observed_at=OBSERVED_AT,
        started_at="2026-11-15T20:30:18.000Z",
        now=NOW,
    )

    assert outcome == claim.ANNOUNCED


def test_failed_entry_releases_the_claim_and_raises(stubs: Stubs) -> None:
    expect_put_claim(stubs)
    expect_start_execution(stubs)
    expect_put_events(stubs, failed=1)
    expect_release(stubs)

    with pytest.raises(RuntimeError, match="MalformedDetail"):
        claim.claim_and_announce(
            JOB, claim.LOG_SUBSCRIPTION, observed_at=OBSERVED_AT, now=NOW
        )


def test_other_start_execution_error_releases_the_claim_and_raises(
    stubs: Stubs,
) -> None:
    expect_put_claim(stubs)
    expect_start_execution(stubs, error="AccessDeniedException")
    expect_release(stubs)

    with pytest.raises(ClientError):
        claim.claim_and_announce(
            JOB, claim.LOG_SUBSCRIPTION, observed_at=OBSERVED_AT, now=NOW
        )


def test_release_that_lost_the_claim_keeps_the_original_error(stubs: Stubs) -> None:
    expect_put_claim(stubs)
    expect_start_execution(stubs)
    expect_put_events(stubs, failed=1)
    stubs.dynamodb.add_client_error(
        "delete_item", service_error_code="ConditionalCheckFailedException"
    )

    with pytest.raises(RuntimeError, match="PutEvents failed"):
        claim.claim_and_announce(
            JOB, claim.LOG_SUBSCRIPTION, observed_at=OBSERVED_AT, now=NOW
        )


def test_other_put_item_error_raises_without_announcing(stubs: Stubs) -> None:
    expect_put_claim(stubs, error="ProvisionedThroughputExceededException")

    with pytest.raises(ClientError):
        claim.claim_and_announce(
            JOB, claim.LOG_SUBSCRIPTION, observed_at=OBSERVED_AT, now=NOW
        )


def test_iso_uses_utc_milliseconds() -> None:
    moment = datetime.datetime(
        2026, 11, 15, 17, 2, 15, 407396, tzinfo=datetime.timezone.utc
    )
    assert claim.iso(moment) == "2026-11-15T17:02:15.407Z"
