"""Test settings and botocore Stubbers for the Lambda functions.

The functions read their settings from the environment at import, so set it
before any test module imports them. No test calls AWS: every client is
stubbed, and Stubber fails on a call that wasn't expected.
"""

from __future__ import annotations

import os
from collections.abc import Iterator

import pytest
from botocore.stub import Stubber

os.environ.update(
    {
        "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_ACCESS_KEY_ID": "testing",
        "AWS_SECRET_ACCESS_KEY": "testing",
        "TABLE_NAME": "claims",
        "STATE_MACHINE_ARN": "arn:aws:states:us-east-1:111122223333:stateMachine:poller",
        "EVENT_BUS_NAME": "default",
        "EVENT_SOURCE": "custom.bedrock.kb-ingestion",
        "CLAIM_LEASE_SECONDS": "300",
        "TRACKED_KNOWLEDGE_BASE_IDS": "EXAMPLEKB1,EXAMPLEKB2",
        "SWEEP_EPOCH": "2026-11-15T12:00:00.000Z",
        # High enough that the rate limiter doesn't slow the tests.
        "SWEEP_RPS": "1000",
        "KNOWLEDGE_BASE_ARN_PREFIX": "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/",
    }
)

import claim
import sweep


class Stubs:
    def __init__(self) -> None:
        self.dynamodb = Stubber(claim.dynamodb)
        self.sfn = Stubber(claim.sfn)
        self.events = Stubber(claim.events)
        self.bedrock_agent = Stubber(sweep.bedrock_agent)
        self.all = [self.dynamodb, self.sfn, self.events, self.bedrock_agent]


@pytest.fixture
def stubs() -> Iterator[Stubs]:
    created = Stubs()
    for stub in created.all:
        stub.activate()
    yield created
    for stub in created.all:
        stub.assert_no_pending_responses()
        stub.deactivate()
