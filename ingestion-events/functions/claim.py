"""Claim step shared by the Start and Sweep functions.

For each ingestion job, at most one path announces it:

1. DynamoDB conditional PutItem of
   ``job#<knowledgeBaseId>#<dataSourceId>#<ingestionJobId>`` (new item, or a
   CLAIMED item whose lease has expired).
2. ``states:StartExecution`` of the per-job poller, named
   ``<knowledgeBaseId>-<dataSourceId>-<ingestionJobId>``.
3. ``events:PutEvents`` of the Started event.
4. UpdateItem to ANNOUNCED.

If step 2 or 3 raises, the claim is deleted (only if it is still ours) so a
retry or the next sweep can claim the job at once.
"""

from __future__ import annotations

import datetime
import json
import os
from typing import TYPE_CHECKING, Any, TypedDict

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from mypy_boto3_dynamodb import DynamoDBClient
    from mypy_boto3_events import EventBridgeClient
    from mypy_boto3_stepfunctions import SFNClient

# Standard mode retries throttling and transient errors with backoff.
BOTO_CONFIG = Config(retries={"mode": "standard", "max_attempts": 5})

dynamodb: DynamoDBClient = boto3.client("dynamodb", config=BOTO_CONFIG)
sfn: SFNClient = boto3.client("stepfunctions", config=BOTO_CONFIG)
events: EventBridgeClient = boto3.client("events", config=BOTO_CONFIG)

TABLE_NAME = os.environ["TABLE_NAME"]
STATE_MACHINE_ARN = os.environ["STATE_MACHINE_ARN"]
EVENT_BUS_NAME = os.environ["EVENT_BUS_NAME"]
EVENT_SOURCE = os.environ["EVENT_SOURCE"]
CLAIM_LEASE_SECONDS = int(os.environ["CLAIM_LEASE_SECONDS"])
TRACKED_KNOWLEDGE_BASE_IDS = frozenset(
    kb_id.strip()
    for kb_id in os.environ["TRACKED_KNOWLEDGE_BASE_IDS"].split(",")
    if kb_id.strip()
)

STARTED_DETAIL_TYPE = "Knowledge Base Ingestion Job Started"
CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60

# Outcomes of claim_and_announce.
ANNOUNCED = "ANNOUNCED"
ALREADY_ANNOUNCED = "ALREADY_ANNOUNCED"
HELD = "HELD"

# Detection paths (detail.detectedBy).
LOG_SUBSCRIPTION = "LOG_SUBSCRIPTION"
RECONCILIATION = "RECONCILIATION"

# Reserved for telling manual jobs from scheduled ones; version 1 always
# sends UNKNOWN.
TRIGGER = "UNKNOWN"


class Job(TypedDict):
    knowledgeBaseId: str
    knowledgeBaseArn: str
    dataSourceId: str
    ingestionJobId: str


def log(**fields: Any) -> None:
    """Write one JSON line to the function's log."""
    print(json.dumps(fields, default=str, sort_keys=True))


def iso(moment: datetime.datetime) -> str:
    """ISO 8601 in UTC with milliseconds, such as 2026-11-15T20:30:19.214Z."""
    utc = moment.astimezone(datetime.timezone.utc)
    return utc.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _millis(moment: datetime.datetime) -> int:
    return int(moment.timestamp() * 1000)


def claim_key(job: Job) -> str:
    """The claim item's key. Every job API takes the knowledge base and data
    source IDs along with the job ID, so the key holds all three."""
    return f"job#{job['knowledgeBaseId']}#{job['dataSourceId']}#{job['ingestionJobId']}"


def execution_name(job: Job) -> str:
    """The poller execution's name, scoped like the claim key.

    Each ID is 10 characters of [0-9a-zA-Z], so the name is 32 characters of
    letters, digits, and hyphens, within the 80-character StartExecution limit.
    """
    return f"{job['knowledgeBaseId']}-{job['dataSourceId']}-{job['ingestionJobId']}"


def _execution_input(job: Job, detected_by: str) -> str:
    # Sorted keys and no optional fields, so a retry by the same path sends
    # byte-identical input and StartExecution returns the running execution.
    return json.dumps(
        {
            "dataSourceId": job["dataSourceId"],
            "detectedBy": detected_by,
            "ingestionJobId": job["ingestionJobId"],
            "knowledgeBaseArn": job["knowledgeBaseArn"],
            "knowledgeBaseId": job["knowledgeBaseId"],
            "trigger": TRIGGER,
        },
        sort_keys=True,
    )


def _started_detail(
    job: Job, detected_by: str, observed_at: str, started_at: str | None
) -> dict[str, str]:
    detail = {
        "version": "1",
        "knowledgeBaseId": job["knowledgeBaseId"],
        "knowledgeBaseArn": job["knowledgeBaseArn"],
        "dataSourceId": job["dataSourceId"],
        "ingestionJobId": job["ingestionJobId"],
        "status": "STARTED",
        "observedAt": observed_at,
        "trigger": TRIGGER,
        "detectedBy": detected_by,
    }
    # startedAt comes only from the API (the sweep's ListIngestionJobs
    # summary), never from the log record's timestamp.
    if started_at is not None:
        detail["startedAt"] = started_at
    return detail


def _claim_state(pk: str) -> str | None:
    item = dynamodb.get_item(
        TableName=TABLE_NAME,
        Key={"pk": {"S": pk}},
        ConsistentRead=True,
        ProjectionExpression="#state",
        ExpressionAttributeNames={"#state": "state"},
    ).get("Item")
    return item["state"]["S"] if item else None


def _release(pk: str, claimed_at: int) -> None:
    """Delete our claim, unless another path has taken it over since."""
    try:
        dynamodb.delete_item(
            TableName=TABLE_NAME,
            Key={"pk": {"S": pk}},
            ConditionExpression="#state = :claimed AND claimedAt = :mine",
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues={
                ":claimed": {"S": "CLAIMED"},
                ":mine": {"N": str(claimed_at)},
            },
        )
    except ClientError as error:
        # Not ours any more, or DynamoDB failed: either way the lease
        # releases the claim later, so keep the original error.
        log(message="claim not released", pk=pk, error=str(error))


def claim_and_announce(
    job: Job,
    detected_by: str,
    *,
    observed_at: str,
    started_at: str | None = None,
    now: datetime.datetime | None = None,
) -> str:
    """Announce the job once. Returns ANNOUNCED, ALREADY_ANNOUNCED, or HELD.

    HELD means another path holds a live claim on the job, so this caller
    must not announce it now.
    """
    moment = now or _now()
    claimed_at = _millis(moment)
    pk = claim_key(job)

    # 1. Claim.
    try:
        dynamodb.put_item(
            TableName=TABLE_NAME,
            Item={
                "pk": {"S": pk},
                "state": {"S": "CLAIMED"},
                "claimedAt": {"N": str(claimed_at)},
                "detectedBy": {"S": detected_by},
                "knowledgeBaseId": {"S": job["knowledgeBaseId"]},
                "dataSourceId": {"S": job["dataSourceId"]},
                "ttl": {"N": str(int(moment.timestamp()) + CLAIM_TTL_SECONDS)},
            },
            ConditionExpression=(
                "attribute_not_exists(pk) OR (#state = :claimed AND claimedAt < :leaseCutoff)"
            ),
            ExpressionAttributeNames={"#state": "state"},
            ExpressionAttributeValues={
                ":claimed": {"S": "CLAIMED"},
                ":leaseCutoff": {"N": str(claimed_at - CLAIM_LEASE_SECONDS * 1000)},
            },
        )
    except ClientError as error:
        if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        state = _claim_state(pk)
        outcome = ALREADY_ANNOUNCED if state == ANNOUNCED else HELD
        log(
            message="already claimed",
            pk=pk,
            ingestionJobId=job["ingestionJobId"],
            state=state,
            outcome=outcome,
        )
        return outcome

    name = execution_name(job)
    try:
        # 2. Start the poller. The name is a backstop: a repeat with the same
        # input returns the running execution, and every other repeat raises
        # ExecutionAlreadyExists.
        try:
            sfn.start_execution(
                stateMachineArn=STATE_MACHINE_ARN,
                name=name,
                input=_execution_input(job, detected_by),
            )
        except ClientError as error:
            if error.response["Error"]["Code"] != "ExecutionAlreadyExists":
                raise
            log(
                message="poller already started",
                ingestionJobId=job["ingestionJobId"],
                executionName=name,
            )

        # 3. Announce. PutEvents reports failed entries in its response, so
        # check FailedEntryCount.
        detail = _started_detail(job, detected_by, observed_at, started_at)
        response = events.put_events(
            Entries=[
                {
                    "Source": EVENT_SOURCE,
                    "DetailType": STARTED_DETAIL_TYPE,
                    "Detail": json.dumps(detail),
                    "EventBusName": EVENT_BUS_NAME,
                    "Resources": [job["knowledgeBaseArn"]],
                }
            ]
        )
        if response["FailedEntryCount"]:
            raise RuntimeError(f"PutEvents failed: {json.dumps(response['Entries'])}")
    except Exception:
        _release(pk, claimed_at)
        raise

    # 4. Mark announced. From now on step 1 fails for this job.
    dynamodb.update_item(
        TableName=TABLE_NAME,
        Key={"pk": {"S": pk}},
        UpdateExpression="SET #state = :announced",
        ExpressionAttributeNames={"#state": "state"},
        ExpressionAttributeValues={":announced": {"S": ANNOUNCED}},
    )
    log(message="announced", **detail)
    return ANNOUNCED
